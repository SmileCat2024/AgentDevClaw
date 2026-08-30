import assert from 'node:assert/strict';
import { describe, it, before, after, afterEach } from 'node:test';
import http from 'node:http';
import express from 'express';

import { proxyToViewer, setProxyConnectionLookup, setProxyRemoteAuthSessions } from '../server/shared/proxy.js';
import { submitUserTurn } from '../server/shared/user-turn.js';
import { setupModelConfigRoutes } from '../server/routes/model-config.js';
import { createAgentLifecycleModule } from '../server/routes/agent-lifecycle.js';
import { setupToolStateRoutes } from '../server/routes/tool-state.js';
import { setupSessionRoutes } from '../server/routes/session.js';
import { createConnectionHealth } from '../server/remote-connections/connection-health.js';
import { createCatalogAggregator } from '../server/remote-connections/catalog-aggregator.js';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

// ADR-0011 Phase 2：远程写端点切片。覆盖工单最低测试集：
//   1. 远程写无幂等键 → 本地闸 400，请求不过隧道
//   2. capability 矩阵（握手采集 → catalog 透传 → 前端门控）
//   3. 代理闸写放行后的转发语义（隧道 origin + 裸 id + 幂等键透传）
//   4. user-turn 远程转发基址（不再拼出 undefined URL）
//   5. swap_model / model_config 命名空间分支（本地分支字节级不变的回归）

const CONNECTIONS = [
  { id: 'server-a', name: 'Server A', enabled: true, mode: 'manual', localPort: 22101 },
];
const FIND_CONNECTION = (() => {
  const byId = new Map(CONNECTIONS.map((connection) => [connection.id, connection]));
  return (connectionId) => byId.get(connectionId) || null;
})();
const REMOTE_ORIGIN = 'http://127.0.0.1:22101';
const NAMESPACE = 'remote:server-a:agent-9';
const ENCODED_NAMESPACE = encodeURIComponent(NAMESPACE);

function makeReq(originalUrl, { method = 'GET', headers = {}, query, body } = {}) {
  return {
    originalUrl,
    method,
    headers,
    query,
    async *[Symbol.asyncIterator]() {
      if (body) yield Buffer.from(body);
    },
  };
}

function makeRes() {
  return {
    statusCode: null,
    jsonPayload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader() {},
    json(payload) {
      this.jsonPayload = payload;
    },
    end() {},
  };
}

function mockFetch(handler) {
  const state = { calls: [], handler };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    state.calls.push({ url: String(url), init });
    const result = state.handler ? state.handler(String(url), init, state.calls.length) : { status: 200, body: '{}' };
    return {
      status: result.status,
      headers: new Headers(result.headers || { 'content-type': 'application/json; charset=utf-8' }),
      arrayBuffer: async () => Buffer.from(result.body ?? ''),
      json: async () => JSON.parse(result.body ?? 'null'),
    };
  };
  return {
    calls: state.calls,
    set handler(next) {
      state.handler = next;
    },
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

// ── 1. Proxy gate: idempotency + write pass-through ──────────────────────

describe('proxy gate for remote writes', () => {
  it('rejects remote writes without an idempotency key locally and never forwards', async () => {
    const fetchMock = mockFetch();
    try {
      const writes = [
        { method: 'POST', url: `/api/agents/${ENCODED_NAMESPACE}/input`, body: '{"text":"hello"}' },
        { method: 'POST', url: `/api/agents/${ENCODED_NAMESPACE}/queued-inputs`, body: '{"text":"queued"}' },
        { method: 'POST', url: `/api/agents/${ENCODED_NAMESPACE}/interrupt`, body: '{}' },
        { method: 'POST', url: `/api/agents/${ENCODED_NAMESPACE}/user-turn`, body: '{"text":"turn"}' },
      ];
      for (const { method, url, body } of writes) {
        const res = makeRes();
        await proxyToViewer(
          makeReq(url, { method, body, headers: { 'x-operation-id': 'op-write' } }),
          res,
          { findConnection: FIND_CONNECTION },
        );
        assert.equal(res.statusCode, 400, `${method} ${url} status`);
        assert.equal(res.jsonPayload.ok, false);
        assert.equal(res.jsonPayload.code, 'idempotency_key_required');
        assert.equal(res.jsonPayload.retryable, false);
        assert.equal(res.jsonPayload.operationId, 'op-write');
      }
      assert.equal(fetchMock.calls.length, 0, 'keyless writes must not cross the tunnel');
    } finally {
      fetchMock.restore();
    }
  });

  it('accepts the idempotency key via query so body-less writes can pass', async () => {
    const fetchMock = mockFetch();
    try {
      const res = makeRes();
      await proxyToViewer(
        makeReq(`/api/agents/${ENCODED_NAMESPACE}/interrupt`, {
          method: 'POST',
          body: '{}',
          query: { idempotencyKey: 'idem-query' },
        }),
        res,
        { findConnection: FIND_CONNECTION },
      );
      assert.equal(res.statusCode, 200);
      assert.equal(fetchMock.calls.length, 1);
    } finally {
      fetchMock.restore();
    }
  });

  it('forwards whitelisted remote writes with tunnel origin, bare id, and the idempotency key', async () => {
    const fetchMock = mockFetch();
    try {
      const writes = [
        { url: `/api/agents/${ENCODED_NAMESPACE}/input`, body: '{"text":"hello"}' },
        { url: `/api/agents/${ENCODED_NAMESPACE}/queued-inputs`, body: '{"text":"queued"}' },
        { url: `/api/agents/${ENCODED_NAMESPACE}/interrupt`, body: '{}' },
        { url: `/api/agents/${ENCODED_NAMESPACE}/user-turn`, body: '{"text":"turn"}' },
      ];
      for (const { url, body } of writes) {
        const res = makeRes();
        await proxyToViewer(
          makeReq(url, {
            method: 'POST',
            body,
            headers: { 'content-type': 'application/json', 'x-idempotency-key': 'idem-1' },
          }),
          res,
          { findConnection: FIND_CONNECTION },
        );
        assert.equal(res.statusCode, 200, `${url} status`);
        const forwarded = fetchMock.calls.at(-1);
        const resource = url.split('/').pop();
        assert.equal(forwarded.url, `${REMOTE_ORIGIN}/api/agents/agent-9/${resource}`, `${url} forwarded url`);
        assert.equal(forwarded.init.method, 'POST');
        assert.equal(forwarded.init.body.toString('utf8'), body);
        assert.equal(forwarded.init.headers.get('x-idempotency-key'), 'idem-1', `${url} idempotency key forwarded`);
      }
      assert.equal(fetchMock.calls.length, writes.length);
    } finally {
      fetchMock.restore();
    }
  });

  it('keeps non-whitelisted remote writes on remote_write_disabled', async () => {
    const fetchMock = mockFetch();
    try {
      for (const { method, url } of [
        { method: 'PUT', url: `/api/agents/${ENCODED_NAMESPACE}/todo` },
        { method: 'DELETE', url: `/api/agents/${ENCODED_NAMESPACE}` },
      ]) {
        const res = makeRes();
        await proxyToViewer(
          makeReq(url, { method, body: '{}', headers: { 'x-idempotency-key': 'idem-2' } }),
          res,
          { findConnection: FIND_CONNECTION },
        );
        assert.equal(res.statusCode, 403, `${method} ${url} status`);
        assert.equal(res.jsonPayload.code, 'remote_write_disabled');
      }
      assert.equal(fetchMock.calls.length, 0);
    } finally {
      fetchMock.restore();
    }
  });

  it('whitelists GET queued-inputs as the read half of the write endpoint', async () => {
    const fetchMock = mockFetch();
    try {
      const res = makeRes();
      await proxyToViewer(
        makeReq(`/api/agents/${ENCODED_NAMESPACE}/queued-inputs`),
        res,
        { findConnection: FIND_CONNECTION },
      );
      assert.equal(res.statusCode, 200);
      assert.equal(fetchMock.calls[0].url, `${REMOTE_ORIGIN}/api/agents/agent-9/queued-inputs`);
    } finally {
      fetchMock.restore();
    }
  });

  it('keeps local writes byte-identical: no key required, no id rewrite', async () => {
    const fetchMock = mockFetch();
    try {
      const res = makeRes();
      await proxyToViewer(
        makeReq('/api/agents/agent-1/input', {
          method: 'POST',
          body: '{"text":"hello"}',
          headers: { 'content-type': 'application/json', 'x-operation-id': 'op-local' },
        }),
        res,
        { findConnection: FIND_CONNECTION },
      );
      assert.equal(res.statusCode, 200);
      assert.equal(fetchMock.calls.length, 1);
      assert.equal(fetchMock.calls[0].url, 'http://127.0.0.1:2026/api/agents/agent-1/input');
      assert.equal(fetchMock.calls[0].init.body.toString('utf8'), '{"text":"hello"}');
      assert.equal(fetchMock.calls[0].init.headers.get('x-operation-id'), 'op-local');
    } finally {
      fetchMock.restore();
    }
  });
});

// ── 2. user-turn forward base ────────────────────────────────────────────

describe('user-turn remote forward base', () => {
  it('resolves a remote namespace via the connection table and forwards to the tunnel origin', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url: String(url), init });
      return { ok: true, status: 200, json: async () => ({ success: true, delivery: 'delivered' }) };
    };
    const result = await submitUserTurn(
      { agentId: NAMESPACE, text: 'hi', idempotencyKey: 'idem-7' },
      { findConnection: FIND_CONNECTION, fetchImpl },
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${REMOTE_ORIGIN}/api/agents/agent-9/user-turn`);
    assert.equal(calls[0].init.headers['x-idempotency-key'], 'idem-7');
    assert.equal(result.delivery, 'delivered');
  });

  it('keeps the local viewer origin for plain ids and omits the key header when absent', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url: String(url), init });
      return { ok: true, status: 200, json: async () => ({ success: true, delivery: 'delivered' }) };
    };
    await submitUserTurn(
      { agentId: 'agent-9', text: 'hi' },
      { viewerOrigin: 'http://127.0.0.1:2026', fetchImpl },
    );
    assert.equal(calls[0].url, 'http://127.0.0.1:2026/api/agents/agent-9/user-turn');
    assert.equal(calls[0].init.headers['x-idempotency-key'], undefined);
  });

  it('maps unknown remote connections onto the request-target contract', async () => {
    const fetchImpl = async () => {
      throw new Error('must not be called');
    };
    await assert.rejects(
      submitUserTurn(
        { agentId: 'remote:ghost:agent-9', text: 'hi' },
        { findConnection: FIND_CONNECTION, fetchImpl },
      ),
      (error) => error.code === 'target_not_found' && error.status === 404,
    );
  });

  it('sends remote turns through the host auth sessions so protected remotes accept them', async () => {
    // 回归：裸 fetch 转发不带远程会话凭据，远程开启访问保护时被 401 拒绝
    // （前端表现为发消息报 Authentication required）。远程 target 必须经
    // fetchWithAuth 附加会话 cookie 与 same-origin Origin。
    const forwarded = [];
    setProxyRemoteAuthSessions({
      async fetchWithAuth(connection, url, init) {
        forwarded.push({ connection, url: String(url), init });
        return { ok: true, status: 200, json: async () => ({ success: true, delivery: 'delivered' }) };
      },
    });
    try {
      const fetchImpl = async () => {
        throw new Error('remote turns must not bypass the auth sessions');
      };
      const result = await submitUserTurn(
        { agentId: NAMESPACE, text: 'hi', idempotencyKey: 'idem-auth' },
        { findConnection: FIND_CONNECTION, fetchImpl },
      );
      assert.equal(result.delivery, 'delivered');
      assert.equal(forwarded.length, 1);
      assert.equal(forwarded[0].connection.id, 'server-a');
      assert.equal(forwarded[0].url, `${REMOTE_ORIGIN}/api/agents/agent-9/user-turn`);
      assert.equal(forwarded[0].init.method, 'POST');
      assert.equal(forwarded[0].init.headers['x-idempotency-key'], 'idem-auth');
    } finally {
      setProxyRemoteAuthSessions(null);
    }
  });

  it('keeps local turns on the injected fetch even when auth sessions are mounted', async () => {
    const calls = [];
    setProxyRemoteAuthSessions({
      async fetchWithAuth() {
        throw new Error('local turns must not consult the auth sessions');
      },
    });
    try {
      const fetchImpl = async (url, init) => {
        calls.push({ url: String(url), init });
        return { ok: true, status: 200, json: async () => ({ success: true, delivery: 'delivered' }) };
      };
      await submitUserTurn(
        { agentId: 'agent-9', text: 'hi' },
        { viewerOrigin: 'http://127.0.0.1:2026', fetchImpl },
      );
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, 'http://127.0.0.1:2026/api/agents/agent-9/user-turn');
    } finally {
      setProxyRemoteAuthSessions(null);
    }
  });
});

// ── 3. capability matrix: handshake → catalog → frontend gate ───────────

const HEALTH_CONNECTION = {
  id: 'server-a',
  name: 'Server A',
  enabled: true,
  mode: 'manual',
  localPort: 22101,
  ssh: null,
  remote: { appPort: 1420 },
};
const silentLogger = { trace() {}, debug() {}, info() {}, warn() {}, error() {} };
const healthInstances = [];
afterEach(() => {
  for (const health of healthInstances) health.stop();
  healthInstances.length = 0;
});

function healthHarness(appInfoExtra = {}) {
  const health = createConnectionHealth({
    fetch: async (url) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname === '/protoclaw/health') {
        return { ok: true, status: 200, json: async () => ({ ok: true, appPort: 1420, viewerPort: 2026 }) };
      }
      if (pathname === '/protoclaw/app_info') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            name: 'AgentDevClaw',
            version: '0.2.0',
            framework: { name: '@agentdevjs/core', version: '0.1.0' },
            ...appInfoExtra,
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ agents: [] }) };
    },
    tunnelManager: null,
    localAppInfo: { clawVersion: '0.2.0', frameworkVersion: '0.1.0' },
    intervalMs: 60000,
    timeoutMs: 200,
    logger: silentLogger,
  });
  health.syncConnections([HEALTH_CONNECTION]);
  healthInstances.push(health);
  return health;
}

describe('handshake capability capture', () => {
  it('captures capabilities.write=true from app_info', async () => {
    const health = healthHarness({ capabilities: { write: true } });
    const status = await health.runHandshake('server-a');
    assert.equal(status.state, 'connected');
    assert.equal(status.appInfo.capabilities.write, true);
  });

  it('defaults capabilities.write to false for legacy remotes without the field', async () => {
    const health = healthHarness();
    const status = await health.runHandshake('server-a');
    assert.equal(status.state, 'connected');
    assert.equal(status.appInfo.capabilities.write, false);
  });
});

function aggregatorHarness(getStatus) {
  return createCatalogAggregator({
    fetch: async (url) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname === '/protoclaw/get_connected_agents') {
        return { ok: true, status: 200, json: async () => [] };
      }
      if (pathname === '/api/agents') {
        return { ok: true, status: 200, json: async () => ({ agents: [] }) };
      }
      throw new Error(`unexpected path: ${pathname}`);
    },
    listConnections: async () => [{ id: 'server-a', name: 'Lab-B', enabled: true, localPort: 22101 }],
    getStatus,
    logger: silentLogger,
  });
}

describe('catalog capability pass-through', () => {
  it('carries capabilities on connected sections', async () => {
    const aggregator = aggregatorHarness(() => ({ state: 'connected', appInfo: { capabilities: { write: true } } }));
    const catalog = await aggregator.aggregate();
    assert.equal(catalog.connections[0].capabilities.write, true);
  });

  it('omits capabilities when the health snapshot has none (legacy remote)', async () => {
    const aggregator = aggregatorHarness(() => ({ state: 'connected' }));
    const catalog = await aggregator.aggregate();
    assert.equal(catalog.connections[0].capabilities, undefined);
  });
});

// ── 4. frontend gate ─────────────────────────────────────────────────────

function loadRemoteModule(catalogPayload) {
  const ctx = createFrontendSandbox({
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => catalogPayload,
    }),
    renderAgentList: () => {},
    t: (key) => key,
    escapeHtml: (value) => String(value ?? ''),
    isRemoteNamespaceAgentId: (value) => String(value || '').startsWith('remote:'),
    currentRuntimeAgentId: null,
    allAgents: [],
  });
  ctx.loadSource('public/src/modules/remote-connections.js');
  return ctx;
}

function connectedCatalog(capabilities) {
  const section = {
    connectionId: 'server-a',
    name: 'Lab-B',
    status: 'connected',
    workspaces: [],
    ...(capabilities ? { capabilities } : {}),
  };
  return { connections: [section] };
}

describe('frontend write gate', () => {
  it('remote+write=true is writable, local ids are always writable, unknown connections are not', async () => {
    const ctx = loadRemoteModule(connectedCatalog({ write: true }));
    await ctx.window.RemoteConnections.refresh();
    assert.equal(ctx.window.RemoteConnections.isRemoteWriteEnabled('remote:server-a:runtime-main'), true);
    assert.equal(ctx.window.RemoteConnections.isRemoteWriteEnabled('plain-agent'), true);
    assert.equal(ctx.window.RemoteConnections.isRemoteWriteEnabled('remote:ghost:runtime-1'), false);
  });

  it('remote without the capability field (legacy) or disconnected stays read-only', async () => {
    const legacy = loadRemoteModule(connectedCatalog());
    await legacy.window.RemoteConnections.refresh();
    assert.equal(legacy.window.RemoteConnections.isRemoteWriteEnabled('remote:server-a:runtime-main'), false);

    const disconnected = loadRemoteModule({
      connections: [{ connectionId: 'server-a', name: 'Lab-B', status: 'error', workspaces: [] }],
    });
    await disconnected.window.RemoteConnections.refresh();
    assert.equal(disconnected.window.RemoteConnections.isRemoteWriteEnabled('remote:server-a:runtime-main'), false);
  });
});

// ── 5. connection manager toggle upsert payload ──────────────────────────

describe('connection manager toggle upsert payload', () => {
  // 回归：列表 record.auth 是服务端脱敏形态（{configured:true}，无密码明文），
  // toggle 曾把整个 record 原样回传，被服务端未知字段校验拒绝（400），导致
  // 启用开关切换失败。契约：省略 auth = 服务端保持现有凭据。
  it('strips the redacted auth marker and applies the new enabled state', () => {
    const ctx = loadRemoteModule(connectedCatalog({ write: true }));
    const record = {
      id: 'wxyteam',
      name: 'wxyteam',
      enabled: false,
      mode: 'url',
      localPort: null,
      baseUrl: 'https://claw.example.com',
      ssh: null,
      remote: null,
      auth: { configured: true },
    };
    // JSON 往返规避 VM realm 与测试 realm 的原型差异。
    const payload = JSON.parse(ctx.run(
      `JSON.stringify(buildToggleUpsertPayload(${JSON.stringify(record)}, true))`,
    ));
    const { auth: _redacted, ...expected } = record;
    expected.enabled = true;
    assert.deepStrictEqual(payload, expected);
  });
});

// ── 6. thinking effort switcher refetches by session namespace ──────────

describe('thinking effort switcher preset refetch', () => {
  // 生产前提：app-core.js 先于本模块加载，window.ClawFW 恒存在。
  function switcherSandbox(currentRuntimeAgentId, fetchImpl) {
    const nameEl = { textContent: '', style: {} };
    const ctx = createFrontendSandbox({
      currentRuntimeAgentId,
      document: {
        getElementById: () => ({ classList: { add() {}, remove() {} }, title: '' }),
        querySelector: () => nameEl,
      },
      fetch: fetchImpl,
    });
    ctx.run('window.ClawFW = {}');
    ctx.loadSource('public/src/modules/input-model-switcher.js');
    return { ctx, nameEl };
  }

  it('refetches presets with the current session namespace and tags the cache', async () => {
    const fetchCalls = [];
    const { ctx } = switcherSandbox('remote:server-a:rt-1', async (url) => {
      fetchCalls.push(String(url));
      return { ok: true, json: async () => ({ config: {}, presets: [{ name: 'remote-preset' }] }) };
    });
    ctx.run('updateThinkingEffortSwitcher()');
    // fire-and-forget refetch chain needs one tick to settle
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(
      fetchCalls,
      ['/protoclaw/model_config?agentId=remote%3Aserver-a%3Art-1'],
      'refetch must carry the current session namespace',
    );
    assert.equal(
      ctx.run('JSON.stringify(window.ClawFW._modelPresets)'),
      JSON.stringify([{ name: 'remote-preset' }]),
    );
    assert.equal(ctx.run('window.ClawFW._modelPresetsRuntimeId'), 'remote:server-a:rt-1');
  });

  it('keeps a cache written without a session tag from masking the current session', async () => {
    const fetchCalls = [];
    const { ctx, nameEl } = switcherSandbox('remote:server-a:rt-1', async (url) => {
      fetchCalls.push(String(url));
      return { ok: true, json: async () => ({ config: {}, presets: [{ name: 'remote-preset' }] }) };
    });
    // Stale local-shaped cache without a session tag must not be trusted.
    ctx.run('window.ClawFW._modelPresets = [{ name: "stale-local" }]');
    ctx.run('updateThinkingEffortSwitcher()');
    await new Promise((resolve) => setTimeout(resolve, 0));
    // After the session-scoped refetch the stale local shape is gone from the
    // cache; with no runtime snapshot the switcher renders its no-thinking state.
    assert.equal(nameEl.textContent, '不支持思考', 'stale local preset data must not render for a remote session');
    assert.equal(ctx.run('window.ClawFW._modelPresetsRuntimeId'), 'remote:server-a:rt-1');
  });

  it('stops refetching when the preset list stays empty instead of looping forever', async () => {
    const fetchCalls = [];
    const { ctx } = switcherSandbox('remote:server-a:rt-1', async (url) => {
      fetchCalls.push(String(url));
      return { ok: true, json: async () => ({ config: {}, presets: [] }) };
    });
    ctx.run('updateThinkingEffortSwitcher()');
    await new Promise((resolve) => setTimeout(resolve, 20));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(fetchCalls.length, 1, 'empty preset list must not trigger an infinite refetch loop');
  });
});

// ── 5. model-config namespace branches (real HTTP) ──────────────────────

describe('model-config remote namespace branches', () => {
  let server;
  let port;
  let fetchMock;

  before(async () => {
    const app = express();
    setupModelConfigRoutes(app, express);
    await new Promise((resolve) => {
      server = app.listen(0, resolve);
    });
    port = server.address().port;
    setProxyConnectionLookup(FIND_CONNECTION);
    fetchMock = mockFetch();
  });

  after(() => {
    fetchMock.restore();
    setProxyConnectionLookup(null);
    server.close();
  });

  function request(method, path, body) {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method,
          path,
          headers: body ? { 'content-type': 'application/json' } : {},
        },
        (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            resolve({ status: res.statusCode, body: JSON.parse(text || 'null') });
          });
        },
      );
      req.on('error', reject);
      req.setTimeout(2000, () => req.destroy(new Error('test request timeout')));
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  it('forwards swap_model with a remote runtimeId to the remote route with bare ids', async () => {
    fetchMock.calls.length = 0;
    fetchMock.handler = () => ({ status: 200, body: JSON.stringify({ ok: true, source: 'remote' }) });
    const res = await request('POST', '/protoclaw/swap_model', {
      agentId: NAMESPACE,
      runtimeId: 'remote:server-a:rt-1',
      presetName: 'gpt',
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true, source: 'remote' });
    assert.equal(fetchMock.calls.length, 1);
    assert.equal(fetchMock.calls[0].url, `${REMOTE_ORIGIN}/protoclaw/swap_model`);
    const forwardedBody = JSON.parse(fetchMock.calls[0].init.body);
    assert.equal(forwardedBody.runtimeId, 'rt-1');
    assert.equal(forwardedBody.agentId, 'agent-9');
    assert.equal(forwardedBody.presetName, 'gpt');
    fetchMock.handler = null;
  });

  it('forwards swap_thinking_effort the same way', async () => {
    fetchMock.calls.length = 0;
    const res = await request('POST', '/protoclaw/swap_thinking_effort', {
      agentId: NAMESPACE,
      runtimeId: 'remote:server-a:rt-1',
      thinkingEffort: 'high',
    });
    assert.equal(res.status, 200);
    assert.equal(fetchMock.calls.length, 1);
    assert.equal(fetchMock.calls[0].url, `${REMOTE_ORIGIN}/protoclaw/swap_thinking_effort`);
    const forwardedBody = JSON.parse(fetchMock.calls[0].init.body);
    assert.equal(forwardedBody.runtimeId, 'rt-1');
    assert.equal(forwardedBody.agentId, 'agent-9');
    assert.equal(forwardedBody.thinkingEffort, 'high');
  });

  it('fetches the remote preset list for a namespaced model_config GET', async () => {
    fetchMock.calls.length = 0;
    fetchMock.handler = () => ({ status: 200, body: JSON.stringify({ config: {}, presets: [{ name: 'remote-preset' }] }) });
    const res = await request('GET', `/protoclaw/model_config?agentId=${ENCODED_NAMESPACE}`);
    assert.equal(res.status, 200);
    assert.equal(fetchMock.calls.length, 1);
    assert.equal(fetchMock.calls[0].url, `${REMOTE_ORIGIN}/protoclaw/model_config`);
    assert.deepEqual(res.body.presets, [{ name: 'remote-preset' }]);
    fetchMock.handler = null;
  });

  it('keeps local branches byte-identical: local swap uses the runtime table and model_config reads local files', async () => {
    fetchMock.calls.length = 0;

    // Local swap: runtime table is empty in the test process → 502 via the
    // existing IPC path, never via HTTP forward.
    const swapRes = await request('POST', '/protoclaw/swap_model', {
      agentId: 'local-agent-1',
      runtimeId: 'local-agent-1',
      presetName: 'gpt',
    });
    assert.equal(swapRes.status, 502);
    assert.equal(swapRes.body.ok, false);
    assert.equal(swapRes.body.error, 'no reachable runtime for this target');
    assert.equal(fetchMock.calls.length, 0);

    // Local model_config: served from the local config files, no remote call.
    const configRes = await request('GET', '/protoclaw/model_config');
    assert.equal(configRes.status, 200);
    assert.equal(typeof configRes.body.config, 'object');
    assert.equal(fetchMock.calls.length, 0);
  });

  it('maps unknown remote connections onto the operation contract', async () => {
    setProxyConnectionLookup(null);
    try {
      const res = await request('POST', '/protoclaw/swap_model', {
        agentId: 'remote:ghost:agent-9',
        runtimeId: 'remote:ghost:rt-1',
        presetName: 'gpt',
      });
      assert.equal(res.status, 404);
      assert.equal(res.body.ok, false);
      assert.equal(res.body.code, 'target_not_found');
    } finally {
      setProxyConnectionLookup(FIND_CONNECTION);
    }
  });
});

// ── 7. state-control remote branches (todo_control / tool_state) ────────

describe('state-control remote namespace branches', () => {
  const silentRes = () => ({
    statusCode: null,
    jsonPayload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.jsonPayload = payload; },
  });

  function captureLifecycleHandler(path) {
    let handler = null;
    const mod = createAgentLifecycleModule({
      sessionApi: {},
      getAgents: async () => [],
      getAgentsLight: async () => [],
      enrichAgent: async (agent) => agent,
      requireAgentLight: async (id) => ({ id, relativeDir: 'test', name: id }),
      resolveRuntimeDisplayName: async (agent) => agent?.name || 'test-agent',
      readViewerJson: async () => ({ agents: [], currentAgentId: null }),
      getPendingInputCount: async () => 0,
      resolveAgentModelPresets: async () => null,
    });
    mod.setupRoutes(
      { get: () => {}, post: (routePath, ...rest) => { if (routePath === path) handler = rest[rest.length - 1]; }, put: () => {}, delete: () => {} },
      { json: () => (req, res, next) => next() },
    );
    return handler;
  }

  it('forwards todo_control with a remote runtimeId to the remote route with bare ids', async () => {
    setProxyConnectionLookup(FIND_CONNECTION);
    const fetchMock = mockFetch(() => ({ status: 200, body: JSON.stringify({ ok: true, via: 'remote' }) }));
    try {
      const handler = captureLifecycleHandler('/protoclaw/todo_control');
      const res = silentRes();
      await handler(
        { body: { agentId: NAMESPACE, runtimeId: 'remote:server-a:rt-1', taskId: '3', forceContinue: true } },
        res,
        (error) => { throw error; },
      );
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.jsonPayload, { ok: true, via: 'remote' });
      assert.equal(fetchMock.calls.length, 1);
      assert.equal(fetchMock.calls[0].url, `${REMOTE_ORIGIN}/protoclaw/todo_control`);
      const forwarded = JSON.parse(fetchMock.calls[0].init.body);
      assert.equal(forwarded.runtimeId, 'rt-1');
      assert.equal(forwarded.agentId, 'agent-9');
      assert.equal(forwarded.taskId, '3');
      assert.equal(forwarded.forceContinue, true);
    } finally {
      fetchMock.restore();
      setProxyConnectionLookup(null);
    }
  });

  it('forwards tool_state with a remote runtimeId and passes the control payload through', async () => {
    setProxyConnectionLookup(FIND_CONNECTION);
    let handler = null;
    setupToolStateRoutes({
      post: (path, ...rest) => { if (path === '/protoclaw/agent/tool_state') handler = rest[rest.length - 1]; },
    });
    const fetchMock = mockFetch(() => ({ status: 200, body: JSON.stringify({ ok: true, delivered: 1 }) }));
    try {
      const res = silentRes();
      await handler(
        { body: { agentId: NAMESPACE, runtimeId: 'remote:server-a:rt-1', scope: 'tool', name: 'shell', action: 'disable' } },
        res,
        (error) => { throw error; },
      );
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.jsonPayload, { ok: true, delivered: 1 });
      assert.equal(fetchMock.calls.length, 1);
      assert.equal(fetchMock.calls[0].url, `${REMOTE_ORIGIN}/protoclaw/agent/tool_state`);
      const forwarded = JSON.parse(fetchMock.calls[0].init.body);
      assert.equal(forwarded.runtimeId, 'rt-1');
      assert.equal(forwarded.agentId, 'agent-9');
      assert.equal(forwarded.scope, 'tool');
      assert.equal(forwarded.name, 'shell');
      assert.equal(forwarded.action, 'disable');
    } finally {
      fetchMock.restore();
      setProxyConnectionLookup(null);
    }
  });

  it('maps unknown remote connections onto the operation contract for state controls too', async () => {
    setProxyConnectionLookup(FIND_CONNECTION);
    let handler = null;
    setupToolStateRoutes({
      post: (path, ...rest) => { if (path === '/protoclaw/agent/tool_state') handler = rest[rest.length - 1]; },
    });
    const fetchMock = mockFetch();
    try {
      const res = silentRes();
      await handler(
        { body: { agentId: 'remote:ghost:agent-9', runtimeId: 'remote:ghost:rt-1', scope: 'tool', name: 'shell', action: 'disable' } },
        res,
        (error) => { throw error; },
      );
      assert.equal(res.statusCode, 404);
      assert.equal(res.jsonPayload.ok, false);
      assert.equal(res.jsonPayload.code, 'target_not_found');
      assert.equal(fetchMock.calls.length, 0);
    } finally {
      fetchMock.restore();
      setProxyConnectionLookup(null);
    }
  });

  it('keeps local state-control branches off the wire: no namespace → local IPC lookup, no fetch', async () => {
    setProxyConnectionLookup(FIND_CONNECTION);
    const fetchMock = mockFetch();
    try {
      // todo_control local: runtime table empty in the test process → { ok:false }, no HTTP.
      const todoHandler = captureLifecycleHandler('/protoclaw/todo_control');
      const todoRes = silentRes();
      await todoHandler(
        { body: { agentId: 'local-agent', runtimeId: 'local-agent', taskId: '1' } },
        todoRes,
        (error) => { throw error; },
      );
      assert.deepEqual(todoRes.jsonPayload, { ok: false });

      // tool_state local: no running runtime → 503, no HTTP.
      let toolHandler = null;
      setupToolStateRoutes({
        post: (path, ...rest) => { if (path === '/protoclaw/agent/tool_state') toolHandler = rest[rest.length - 1]; },
      });
      const toolRes = silentRes();
      await toolHandler(
        { body: { agentId: 'local-agent', runtimeId: 'local-agent', scope: 'tool', name: 'shell', action: 'enable' } },
        toolRes,
        (error) => { throw error; },
      );
      assert.equal(toolRes.statusCode, 503);

      assert.equal(fetchMock.calls.length, 0, 'local state controls must never produce an HTTP forward');
    } finally {
      fetchMock.restore();
      setProxyConnectionLookup(null);
    }
  });
});

// ── 8. agent_detail remote forward (read path) ──────────────────────────

describe('agent_detail remote namespace branch', () => {
  const silentRes = () => ({
    statusCode: null,
    jsonPayload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.jsonPayload = payload; },
  });

  it('forwards a namespaced agentId to the remote route with a bare id in the query', async () => {
    setProxyConnectionLookup(FIND_CONNECTION);
    const handler = (() => {
      let captured = null;
      const mod = createAgentLifecycleModule({
        sessionApi: {},
        getAgents: async () => [],
        getAgentsLight: async () => [],
        enrichAgent: async (agent) => agent,
        requireAgentLight: async (id) => ({ id, relativeDir: 'test', name: id }),
        resolveRuntimeDisplayName: async (agent) => agent?.name || 'test-agent',
        readViewerJson: async () => ({ agents: [], currentAgentId: null }),
        getPendingInputCount: async () => 0,
        resolveAgentModelPresets: async () => null,
      });
      mod.setupRoutes(
        { get: (routePath, ...rest) => { if (routePath === '/protoclaw/agent_detail') captured = rest[rest.length - 1]; }, post: () => {}, put: () => {}, delete: () => {} },
        { json: () => (req, res, next) => next() },
      );
      return captured;
    })();
    const fetchMock = mockFetch(() => ({
      status: 200,
      body: JSON.stringify({ workspace_sessions: { activeSessionId: 's1', sessions: [] }, workspace_data: {}, workspace_state: { openDirectory: 'D:/remote' } }),
    }));
    try {
      const res = silentRes();
      await handler(
        { query: { agentId: NAMESPACE } },
        res,
        (error) => { throw error; },
      );
      assert.equal(res.statusCode, 200);
      assert.equal(res.jsonPayload.workspace_state.openDirectory, 'D:/remote');
      assert.equal(fetchMock.calls.length, 1);
      assert.equal(fetchMock.calls[0].url, `${REMOTE_ORIGIN}/protoclaw/agent_detail?agentId=agent-9`);
    } finally {
      fetchMock.restore();
      setProxyConnectionLookup(null);
    }
  });

  it('keeps the local branch off the wire: local agentId stays a local table lookup', async () => {
    let handler = null;
    const mod = createAgentLifecycleModule({
      sessionApi: {},
      getAgents: async () => [],
      getAgentsLight: async () => [{ id: 'local-agent', name: 'local' }],
      enrichAgent: async (agent) => agent,
      requireAgentLight: async (id) => ({ id, relativeDir: 'test', name: id }),
      resolveRuntimeDisplayName: async (agent) => agent?.name || 'test-agent',
      readViewerJson: async () => ({ agents: [], currentAgentId: null }),
      getPendingInputCount: async () => 0,
      resolveAgentModelPresets: async () => null,
    });
    mod.setupRoutes(
      { get: (routePath, ...rest) => { if (routePath === '/protoclaw/agent_detail') handler = rest[rest.length - 1]; }, post: () => {}, put: () => {}, delete: () => {} },
      { json: () => (req, res, next) => next() },
    );
    setProxyConnectionLookup(FIND_CONNECTION);
    const fetchMock = mockFetch();
    try {
      const res = silentRes();
      await handler(
        { query: { agentId: 'local-agent' } },
        res,
        (error) => { throw error; },
      );
      assert.equal(res.statusCode, null, 'local success responds via plain res.json');
      assert.equal(res.jsonPayload.workspace_sessions.activeSessionId, null, 'empty light fixture still yields the local payload shape');
      assert.equal(typeof res.jsonPayload.workspace_data, 'object');
      assert.equal(fetchMock.calls.length, 0, 'local agent_detail must never produce an HTTP forward');
    } finally {
      fetchMock.restore();
      setProxyConnectionLookup(null);
    }
  });
});

// ── 9. frontend host identity from the catalog (tool_state 400 fix) ─────

describe('frontend getEntryHostAgentId', () => {
  function catalogWithEntry() {
    return {
      connections: [{
        connectionId: 'server-a',
        name: 'Lab-B',
        status: 'connected',
        workspaces: [{
          projectKey: 'k1',
          entries: [{
            id: 'remote:server-a:rt-1',
            runtimeId: 'remote:server-a:rt-1',
            agentId: 'remote:server-a:programming-helper',
            source: 'child',
          }],
        }],
      }],
    };
  }

  it('resolves the owning host logical id from a namespaced runtime reference', async () => {
    const ctx = loadRemoteModule(catalogWithEntry());
    await ctx.window.RemoteConnections.refresh();
    assert.equal(ctx.window.RemoteConnections.getEntryHostAgentId('remote:server-a:rt-1'), 'programming-helper');
  });

  it('returns null for unknown references and non-namespaced ids instead of guessing', async () => {
    const ctx = loadRemoteModule(catalogWithEntry());
    await ctx.window.RemoteConnections.refresh();
    assert.equal(ctx.window.RemoteConnections.getEntryHostAgentId('remote:ghost:rt-9'), null);
    assert.equal(ctx.window.RemoteConnections.getEntryHostAgentId('plain-agent'), null);
    assert.equal(ctx.window.RemoteConnections.getEntryHostAgentId(''), null);
  });
});

// ── 10. session history remote branches (R2-01) ──────────────────────────

// setupSessionRoutes 的 ctx 依赖面很大，但远程分支全部在本地 helper 之前短路；
// 本地路径不触发（远程用例被转发 mock 拦截），依赖以最小替身注入。
// 同一 path 存在 GET/POST 双路由（如 /protoclaw/prebuilt_sessions），按 method
// 分别捕获，避免后注册者覆盖先注册者。
function captureSessionHandler(path, method = 'get') {
  let handler = null;
  const noop = () => {};
  const capture = (wantMethod) => (routePath, ...rest) => {
    if (routePath === path && wantMethod === method) handler = rest[rest.length - 1];
  };
  setupSessionRoutes(
    {
      get: capture('get'),
      post: capture('post'),
      put: capture('put'),
      delete: noop,
    },
    { json: () => (req, res, next) => next() },
    {
      listPrebuiltSessions: async () => { throw new Error('local list must not run for remote ids'); },
      searchSessionsContent: async () => { throw new Error('local search must not run for remote ids'); },
      getPrebuiltSessionFilePath: () => { throw new Error('local file access must not run for remote ids'); },
      resolvePrebuiltSessionType: async () => null,
      resolvePrebuiltSessionOwner: async () => null,
      requirePrebuiltSessionRecord: async () => { throw new Error('local record lookup must not run for remote ids'); },
      // requireAgentLight 替身模拟生产查找语义：查无此 agent 抛 404
      // Unknown agent（本地分支回归用），命中则返回 light 形态。
      requireAgentLight: async (id) => {
        if (id === 'local-agent') {
          const error = new Error(`Unknown agent: ${id}`);
          error.statusCode = 404;
          throw error;
        }
        return { id, relativeDir: 'test', name: id };
      },
      requirePrebuiltAgentForRuntime: async (id) => ({ id, relativeDir: 'test' }),
      activatePrebuiltSession: async () => { throw new Error('local activate must not run for remote ids'); },
      deletePrebuiltSession: async () => { throw new Error('local delete must not run for remote ids'); },
      archivePrebuiltSession: async () => { throw new Error('local archive must not run for remote ids'); },
      tagPrebuiltSessionTodo: async () => { throw new Error('local todo must not run for remote ids'); },
      startManagedAgent: async () => { throw new Error('startManagedAgent must not run for remote ids'); },
      readSessionIndex: async () => ({ revision: 0, activeSessionId: null, sessions: [] }),
      updateSessionIndex: async () => { throw new Error('local index update must not run for remote ids'); },
    },
  );
  return handler;
}

describe('session routes remote namespace branches (R2-01)', () => {
  const silentRes = () => ({
    statusCode: null,
    jsonPayload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.jsonPayload = payload; },
  });
  // 十端点转发形状矩阵：{ name, method, path, handler, body, assertForwarded }
  const remoteCases = [
    {
      name: 'GET /protoclaw/prebuilt_sessions',
      path: '/protoclaw/prebuilt_sessions',
      handler: () => captureSessionHandler('/protoclaw/prebuilt_sessions', 'get'),
      run: (handler, res) => handler({ query: { agentId: NAMESPACE } }, res, (e) => { throw e; }),
      expectUrl: `${REMOTE_ORIGIN}/protoclaw/prebuilt_sessions?agentId=agent-9`,
    },
    {
      name: 'GET /protoclaw/search_sessions',
      path: '/protoclaw/search_sessions',
      handler: () => captureSessionHandler('/protoclaw/search_sessions'),
      run: (handler, res) => handler({ query: { agentId: NAMESPACE, q: 'fix bug', openDirectory: 'D:/remote' } }, res, (e) => { throw e; }),
      expectUrl: `${REMOTE_ORIGIN}/protoclaw/search_sessions?agentId=agent-9&q=fix+bug&openDirectory=D%3A%2Fremote`,
    },
    {
      name: 'GET /protoclaw/session_record',
      path: '/protoclaw/session_record',
      handler: () => captureSessionHandler('/protoclaw/session_record'),
      run: (handler, res) => handler({ query: { agentId: NAMESPACE, sessionId: 'remote:server-a:session-1' } }, res, (e) => { throw e; }),
      expectUrl: `${REMOTE_ORIGIN}/protoclaw/session_record?agentId=agent-9&sessionId=session-1`,
    },
    {
      name: 'POST /protoclaw/prebuilt_sessions/activate',
      path: '/protoclaw/prebuilt_sessions/activate',
      method: 'post',
      body: { agentId: NAMESPACE, sessionId: 'remote:server-a:session-7', idempotencyKey: 'idem-activate' },
      expectUrl: `${REMOTE_ORIGIN}/protoclaw/prebuilt_sessions/activate`,
      expectForwarded: { agentId: 'agent-9', sessionId: 'session-7', idempotencyKey: 'idem-activate' },
    },
    {
      name: 'POST /protoclaw/prebuilt_sessions/delete',
      path: '/protoclaw/prebuilt_sessions/delete',
      method: 'post',
      body: { agentId: NAMESPACE, sessionId: 'remote:server-a:session-7', idempotencyKey: 'idem-del' },
      expectUrl: `${REMOTE_ORIGIN}/protoclaw/prebuilt_sessions/delete`,
      expectForwarded: { agentId: 'agent-9', sessionId: 'session-7', idempotencyKey: 'idem-del' },
    },
    {
      name: 'POST /protoclaw/prebuilt_sessions/archive',
      path: '/protoclaw/prebuilt_sessions/archive',
      method: 'post',
      body: { agentId: NAMESPACE, sessionId: 'remote:server-a:session-7', archived: false, idempotencyKey: 'idem-arch' },
      expectUrl: `${REMOTE_ORIGIN}/protoclaw/prebuilt_sessions/archive`,
      expectForwarded: { agentId: 'agent-9', sessionId: 'session-7', archived: false, idempotencyKey: 'idem-arch' },
    },
    {
      name: 'POST /protoclaw/prebuilt_sessions/todo',
      path: '/protoclaw/prebuilt_sessions/todo',
      method: 'post',
      body: { agentId: NAMESPACE, sessionId: 'remote:server-a:session-7', todo: true, idempotencyKey: 'idem-todo' },
      expectUrl: `${REMOTE_ORIGIN}/protoclaw/prebuilt_sessions/todo`,
      expectForwarded: { agentId: 'agent-9', sessionId: 'session-7', todo: true, idempotencyKey: 'idem-todo' },
    },
    {
      name: 'POST /protoclaw/generate_session_title',
      path: '/protoclaw/generate_session_title',
      method: 'post',
      body: { agentId: NAMESPACE, sessionId: 'remote:server-a:session-7', idempotencyKey: 'idem-title' },
      expectUrl: `${REMOTE_ORIGIN}/protoclaw/generate_session_title`,
      expectForwarded: { agentId: 'agent-9', sessionId: 'session-7', idempotencyKey: 'idem-title' },
    },
    {
      name: 'POST /protoclaw/generate_recap',
      path: '/protoclaw/generate_recap',
      method: 'post',
      body: { agentId: NAMESPACE, sessionId: 'remote:server-a:session-7', idempotencyKey: 'idem-recap' },
      expectUrl: `${REMOTE_ORIGIN}/protoclaw/generate_recap`,
      expectForwarded: { agentId: 'agent-9', sessionId: 'session-7', idempotencyKey: 'idem-recap' },
    },
    {
      name: 'GET /protoclaw/session_trim_preview',
      path: '/protoclaw/session_trim_preview',
      handler: () => captureSessionHandler('/protoclaw/session_trim_preview', 'get'),
      run: (handler, res) => handler({ query: { agentId: NAMESPACE, sessionId: 'remote:server-a:session-7' } }, res, (e) => { throw e; }),
      expectUrl: `${REMOTE_ORIGIN}/protoclaw/session_trim_preview?agentId=agent-9&sessionId=session-7`,
    },
    {
      name: 'GET /protoclaw/session_summary',
      path: '/protoclaw/session_summary',
      handler: () => captureSessionHandler('/protoclaw/session_summary', 'get'),
      run: (handler, res) => handler({ query: { agentId: NAMESPACE, sessionId: 'remote:server-a:session-7' } }, res, (e) => { throw e; }),
      expectUrl: `${REMOTE_ORIGIN}/protoclaw/session_summary?agentId=agent-9&sessionId=session-7`,
    },
    {
      name: 'POST /protoclaw/session_generate_summary',
      path: '/protoclaw/session_generate_summary',
      method: 'post',
      body: { agentId: NAMESPACE, sessionId: 'remote:server-a:session-7', force: true, idempotencyKey: 'idem-gen-summary' },
      expectUrl: `${REMOTE_ORIGIN}/protoclaw/session_generate_summary`,
      expectForwarded: { agentId: 'agent-9', sessionId: 'session-7', force: true, idempotencyKey: 'idem-gen-summary' },
    },
    {
      name: 'POST /protoclaw/sessions/branch',
      path: '/protoclaw/sessions/branch',
      method: 'post',
      body: {
        agentId: NAMESPACE,
        sourceSessionId: 'remote:server-a:session-7',
        cutMsgIndexEnd: 5,
        archiveOriginal: true,
        responseMode: 'delta',
        idempotencyKey: 'idem-branch',
      },
      expectUrl: `${REMOTE_ORIGIN}/protoclaw/sessions/branch`,
      expectForwarded: {
        agentId: 'agent-9',
        sourceSessionId: 'session-7',
        cutMsgIndexEnd: 5,
        archiveOriginal: true,
        responseMode: 'delta',
        idempotencyKey: 'idem-branch',
      },
    },
    {
      name: 'POST /protoclaw/context_handoffs/compact_and_resume',
      path: '/protoclaw/context_handoffs/compact_and_resume',
      method: 'post',
      body: {
        agentId: NAMESPACE,
        sessionId: 'remote:server-a:session-7',
        detached: false,
        policy: { strategy: 'summarized-nine-section' },
        reason: 'trim',
        idempotencyKey: 'idem-compact',
      },
      expectUrl: `${REMOTE_ORIGIN}/protoclaw/context_handoffs/compact_and_resume`,
      expectForwarded: {
        agentId: 'agent-9',
        sessionId: 'session-7',
        detached: false,
        policy: { strategy: 'summarized-nine-section' },
        reason: 'trim',
        idempotencyKey: 'idem-compact',
      },
    },
    {
      name: 'POST /protoclaw/context_handoffs/compacted_resume',
      path: '/protoclaw/context_handoffs/compacted_resume',
      method: 'post',
      body: { agentId: NAMESPACE, handoffId: 'remote:server-a:handoff-9', goal: 'continue', idempotencyKey: 'idem-resume' },
      expectUrl: `${REMOTE_ORIGIN}/protoclaw/context_handoffs/compacted_resume`,
      expectForwarded: { agentId: 'agent-9', handoffId: 'handoff-9', goal: 'continue', idempotencyKey: 'idem-resume' },
    },
    {
      name: 'POST /protoclaw/prebuilt_sessions (create)',
      path: '/protoclaw/prebuilt_sessions',
      method: 'post',
      handler: () => captureSessionHandler('/protoclaw/prebuilt_sessions', 'post'),
      body: { agentId: NAMESPACE, title: 'New remote session', idempotencyKey: 'idem-create' },
      expectUrl: `${REMOTE_ORIGIN}/protoclaw/prebuilt_sessions`,
      expectForwarded: { agentId: 'agent-9', title: 'New remote session', idempotencyKey: 'idem-create' },
    },
    {
      name: 'PUT /protoclaw/prebuilt_sessions/:sessionId/title',
      path: '/protoclaw/prebuilt_sessions/session-7/title',
      handler: () => captureSessionHandler('/protoclaw/prebuilt_sessions/:sessionId/title', 'put'),
      run: (handler, res) => handler(
        { params: { sessionId: 'remote:server-a:session-7' }, body: { agentId: NAMESPACE, title: '  Renamed  ' }, headers: { 'x-idempotency-key': 'idem-title-put' } },
        res,
        (e) => { throw e; },
      ),
      expectForwarded: { agentId: 'agent-9', title: 'Renamed' },
      expectUrl: `${REMOTE_ORIGIN}/protoclaw/prebuilt_sessions/session-7/title`,
      expectMethod: 'PUT',
    },
  ];

  for (const spec of remoteCases) {
    it(`forwards ${spec.name} with bare ids over the tunnel`, async () => {
      setProxyConnectionLookup(FIND_CONNECTION);
      const fetchMock = mockFetch(() => ({ status: 200, body: JSON.stringify({ ok: true, via: 'remote' }) }));
      try {
        const handler = spec.handler
          ? spec.handler()
          : captureSessionHandler(spec.path, spec.name.startsWith('GET') ? 'get' : 'post');
        const res = silentRes();
        const body = spec.body ? { ...spec.body, idempotencyKey: spec.body.idempotencyKey || 'idem-forward' } : undefined;
        if (spec.run) {
          await spec.run(handler, res, body);
        } else {
          await handler({ body, headers: {} }, res, (e) => { throw e; });
        }
        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.jsonPayload, { ok: true, via: 'remote' });
        assert.equal(fetchMock.calls.length, 1, `${spec.name} must produce exactly one forward`);
        const forwarded = fetchMock.calls[0];
        assert.equal(forwarded.url, spec.expectUrl, `${spec.name} forwarded url`);
        if (spec.expectMethod) assert.equal(forwarded.init.method, spec.expectMethod);
        if (spec.expectForwarded) {
          assert.deepEqual(JSON.parse(forwarded.init.body), spec.expectForwarded, `${spec.name} forwarded body`);
        }
      } finally {
        fetchMock.restore();
        setProxyConnectionLookup(null);
      }
    });
  }

  it('requires an idempotency key for every remote session write and never crosses the tunnel', async () => {
    const fetchMock = mockFetch();
    try {
      setProxyConnectionLookup(FIND_CONNECTION);
      const writes = [
        { path: '/protoclaw/prebuilt_sessions', body: { agentId: NAMESPACE } },
        { path: '/protoclaw/prebuilt_sessions/activate', body: { agentId: NAMESPACE, sessionId: 'remote:server-a:s1' } },
        { path: '/protoclaw/prebuilt_sessions/delete', body: { agentId: NAMESPACE, sessionId: 'remote:server-a:s1' } },
        { path: '/protoclaw/prebuilt_sessions/archive', body: { agentId: NAMESPACE, sessionId: 'remote:server-a:s1' } },
        { path: '/protoclaw/prebuilt_sessions/todo', body: { agentId: NAMESPACE, sessionId: 'remote:server-a:s1' } },
        { path: '/protoclaw/generate_session_title', body: { agentId: NAMESPACE, sessionId: 'remote:server-a:s1' } },
        { path: '/protoclaw/generate_recap', body: { agentId: NAMESPACE, sessionId: 'remote:server-a:s1' } },
        // R2-02 写端点：branch / compact_and_resume / session_generate_summary
        { path: '/protoclaw/sessions/branch', body: { agentId: NAMESPACE, sourceSessionId: 'remote:server-a:s1', cutMsgIndexEnd: 3 } },
        { path: '/protoclaw/context_handoffs/compact_and_resume', body: { agentId: NAMESPACE, sessionId: 'remote:server-a:s1' } },
        { path: '/protoclaw/context_handoffs/compacted_resume', body: { agentId: NAMESPACE, handoffId: 'remote:server-a:h1' } },
        { path: '/protoclaw/session_generate_summary', body: { agentId: NAMESPACE, sessionId: 'remote:server-a:s1' } },
      ];
      for (const { path, body } of writes) {
        const handler = captureSessionHandler(path, 'post');
        const res = silentRes();
        await handler({ body, headers: {} }, res, (e) => { throw e; });
        assert.equal(res.statusCode, 400, `POST ${path} status`);
        assert.equal(res.jsonPayload.ok, false);
        assert.equal(res.jsonPayload.code, 'idempotency_key_required');
        assert.equal(res.jsonPayload.retryable, false);
      }
      // PUT title 同一闸（键在 header 而非 body 也识别）。
      const titleHandler = captureSessionHandler('/protoclaw/prebuilt_sessions/:sessionId/title', 'put');
      const titleRes = silentRes();
      await titleHandler(
        { params: { sessionId: 'remote:server-a:s1' }, body: { agentId: NAMESPACE, title: 'x' } },
        titleRes,
        (e) => { throw e; },
      );
      assert.equal(titleRes.statusCode, 400);
      assert.equal(titleRes.jsonPayload.code, 'idempotency_key_required');

      assert.equal(fetchMock.calls.length, 0, 'keyless remote writes must not cross the tunnel');
    } finally {
      fetchMock.restore();
      setProxyConnectionLookup(null);
    }
  });

  it('still enforces basic body validation before forwarding remote writes', async () => {
    setProxyConnectionLookup(FIND_CONNECTION);
    const fetchMock = mockFetch();
    try {
      // 缺 sessionId 的 activate：身份校验先于转发分支抛出（next(error)），
      // 无网络副作用。
      const handler = captureSessionHandler('/protoclaw/prebuilt_sessions/activate', 'post');
      const res = silentRes();
      let nextError = null;
      await handler({ body: { agentId: NAMESPACE } }, res, (e) => { nextError = e; });
      assert.equal(res.statusCode, null, 'identity validation must short-circuit before the forward branch');
      assert.equal(nextError.status, 400);
      assert.equal(nextError.message, 'sessionId is required');
      assert.equal(fetchMock.calls.length, 0);
    } finally {
      fetchMock.restore();
      setProxyConnectionLookup(null);
    }
  });

  it('maps unknown remote connections onto the operation contract for session routes too', async () => {
    setProxyConnectionLookup(FIND_CONNECTION);
    const fetchMock = mockFetch();
    try {
      const handler = captureSessionHandler('/protoclaw/prebuilt_sessions/activate', 'post');
      const res = silentRes();
      await handler(
        { body: { agentId: 'remote:ghost:agent-9', sessionId: 'remote:ghost:s1', idempotencyKey: 'idem-ghost' } },
        res,
        (error) => { throw error; },
      );
      assert.equal(res.statusCode, 404);
      assert.equal(res.jsonPayload.ok, false);
      assert.equal(res.jsonPayload.code, 'target_not_found');
      assert.equal(fetchMock.calls.length, 0);
    } finally {
      fetchMock.restore();
      setProxyConnectionLookup(null);
    }
  });

  it('keeps local session branches off the wire: plain ids run the local lookup path', async () => {
    const fetchMock = mockFetch();
    try {
      setProxyConnectionLookup(FIND_CONNECTION);
      // activate 本地：requireAgentLight 查无此 agent → next(error)，绝不发 HTTP。
      const activateHandler = captureSessionHandler('/protoclaw/prebuilt_sessions/activate', 'post');
      const activateRes = silentRes();
      await assert.rejects(
        activateHandler(
          { body: { agentId: 'local-agent', sessionId: 'session-1' }, headers: {} },
          activateRes,
          (error) => { throw error; },
        ),
        /Unknown agent/,
      );
      assert.equal(fetchMock.calls.length, 0, 'local session operations must never produce an HTTP forward');

      // title 本地：agentId 缺失走本地 400。
      const titleHandler = captureSessionHandler('/protoclaw/prebuilt_sessions/:sessionId/title', 'put');
      const titleRes = silentRes();
      await titleHandler({ params: { sessionId: 's1' }, body: {} }, titleRes, (e) => { throw e; });
      assert.equal(titleRes.statusCode, 400);
      assert.equal(fetchMock.calls.length, 0);
    } finally {
      fetchMock.restore();
      setProxyConnectionLookup(null);
    }
  });
});

// ── 10. stop_agent / restart_agent remote forward (runtime lifecycle) ────

describe('stop_agent / restart_agent remote namespace branch', () => {
  const silentRes = () => ({
    statusCode: null,
    jsonPayload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.jsonPayload = payload; },
  });

  function capturePostHandler(routePath) {
    let captured = null;
    const mod = createAgentLifecycleModule({
      sessionApi: {},
      getAgents: async () => [],
      getAgentsLight: async () => [],
      enrichAgent: async (agent) => agent,
      requireAgentLight: async (id) => ({ id, relativeDir: 'test', name: id }),
      resolveRuntimeDisplayName: async (agent) => agent?.name || 'test-agent',
      readViewerJson: async () => ({ agents: [], currentAgentId: null }),
      getPendingInputCount: async () => 0,
      resolveAgentModelPresets: async () => null,
    });
    mod.setupRoutes(
      { get: () => {}, post: (p, ...rest) => { if (p === routePath) captured = rest[rest.length - 1]; }, put: () => {}, delete: () => {} },
      { json: () => (req, res, next) => next() },
    );
    return captured;
  }

  it('stop_agent forwards namespaced agentId and sessionId as bare ids', async () => {
    setProxyConnectionLookup(FIND_CONNECTION);
    const handler = capturePostHandler('/protoclaw/stop_agent');
    const fetchMock = mockFetch(() => ({ status: 200, body: JSON.stringify({ agentId: 'agent-9', status: 'stopped' }) }));
    try {
      const res = silentRes();
      await handler(
        { body: { agentId: NAMESPACE, sessionId: 'remote:server-a:sess-9' } },
        res,
        (error) => { throw error; },
      );
      assert.equal(res.statusCode, 200);
      assert.equal(res.jsonPayload.status, 'stopped');
      assert.equal(fetchMock.calls.length, 1);
      assert.equal(fetchMock.calls[0].url, `${REMOTE_ORIGIN}/protoclaw/stop_agent`);
      assert.equal(fetchMock.calls[0].init.method, 'POST');
      const sentBody = JSON.parse(fetchMock.calls[0].init.body);
      assert.equal(sentBody.agentId, 'agent-9');
      assert.equal(sentBody.sessionId, 'sess-9');
    } finally {
      fetchMock.restore();
      setProxyConnectionLookup(null);
    }
  });

  it('stop_agent keeps a null sessionId null across the forward', async () => {
    setProxyConnectionLookup(FIND_CONNECTION);
    const handler = capturePostHandler('/protoclaw/stop_agent');
    const fetchMock = mockFetch(() => ({ status: 200, body: JSON.stringify({ agentId: 'agent-9', status: 'stopped' }) }));
    try {
      const res = silentRes();
      await handler({ body: { agentId: NAMESPACE } }, res, (error) => { throw error; });
      assert.equal(res.statusCode, 200);
      const sentBody = JSON.parse(fetchMock.calls[0].init.body);
      assert.equal(sentBody.agentId, 'agent-9');
      assert.equal(sentBody.sessionId, null);
    } finally {
      fetchMock.restore();
      setProxyConnectionLookup(null);
    }
  });

  it('restart_agent forwards namespaced identities and the remote route owns host-side checks', async () => {
    setProxyConnectionLookup(FIND_CONNECTION);
    const handler = capturePostHandler('/protoclaw/restart_agent');
    const fetchMock = mockFetch(() => ({ status: 200, body: JSON.stringify({ status: 'running', agent: { runtime_session_id: 'rt-new' } }) }));
    try {
      const res = silentRes();
      await handler(
        { body: { agentId: NAMESPACE, sessionId: 'remote:server-a:sess-9' } },
        res,
        (error) => { throw error; },
      );
      assert.equal(res.statusCode, 200);
      assert.equal(res.jsonPayload.agent.runtime_session_id, 'rt-new');
      const sentBody = JSON.parse(fetchMock.calls[0].init.body);
      assert.equal(sentBody.agentId, 'agent-9');
      assert.equal(sentBody.sessionId, 'sess-9');
    } finally {
      fetchMock.restore();
      setProxyConnectionLookup(null);
    }
  });

  it('local stop_agent never touches the wire and answers via the local status path', async () => {
    let handler = null;
    const mod = createAgentLifecycleModule({
      sessionApi: {},
      getAgents: async () => [],
      getAgentsLight: async () => [],
      enrichAgent: async (agent) => agent,
      requireAgentLight: async (id) => ({ id, relativeDir: 'test', name: id }),
      resolveRuntimeDisplayName: async (agent) => agent?.name || 'test-agent',
      readViewerJson: async () => ({ agents: [], currentAgentId: null }),
      getPendingInputCount: async () => 0,
      resolveAgentModelPresets: async () => null,
    });
    mod.setupRoutes(
      { get: () => {}, post: (p, ...rest) => { if (p === '/protoclaw/stop_agent') handler = rest[rest.length - 1]; }, put: () => {}, delete: () => {} },
      { json: () => (req, res, next) => next() },
    );
    setProxyConnectionLookup(FIND_CONNECTION);
    const fetchMock = mockFetch();
    try {
      const res = silentRes();
      await handler({ body: { agentId: 'local-agent' } }, res, (error) => { throw error; });
      assert.equal(res.statusCode, null, 'local success responds via plain res.json');
      assert.equal(res.jsonPayload.id, 'local-agent', 'buildStatus payload shape');
      assert.equal(res.jsonPayload.status, 'stopped');
      assert.equal(fetchMock.calls.length, 0, 'local stop must never produce an HTTP forward');
    } finally {
      fetchMock.restore();
      setProxyConnectionLookup(null);
    }
  });

  it('unknown remote connection surfaces the contract failure shape', async () => {
    setProxyConnectionLookup(() => null);
    const handler = capturePostHandler('/protoclaw/stop_agent');
    const fetchMock = mockFetch();
    try {
      const res = silentRes();
      await handler({ body: { agentId: NAMESPACE } }, res, () => {});
      assert.equal(res.statusCode, 404, 'unknown connection maps to 404 per the request-target contract');
      assert.ok(res.jsonPayload && res.jsonPayload.error, 'failure payload carries an error field');
      assert.equal(fetchMock.calls.length, 0);
    } finally {
      fetchMock.restore();
      setProxyConnectionLookup(null);
    }
  });
});
