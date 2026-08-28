import assert from 'node:assert/strict';
import { describe, it, before, after, afterEach } from 'node:test';
import http from 'node:http';
import express from 'express';

import { proxyToViewer, setProxyConnectionLookup } from '../server/shared/proxy.js';
import { submitUserTurn } from '../server/shared/user-turn.js';
import { setupModelConfigRoutes } from '../server/routes/model-config.js';
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
  const origin = REMOTE_ORIGIN;
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
