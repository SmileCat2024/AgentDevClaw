import assert from 'node:assert/strict';
import { describe, it, afterEach } from 'node:test';

import { createAgentLifecycleModule } from '../server/routes/agent-lifecycle.js';
import { setupCapabilityRoutes } from '../server/routes/capability.js';
import { setProxyConnectionLookup } from '../server/shared/proxy.js';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

// R2-04：面板资源远程扩列——会话控制面板（force continuation / context guard /
// capability）。覆盖工单最低测试集：
//   1. 六端点远程命名空间分支的转发形状（隧道 origin + 裸 id + 远程响应原文）
//   2. 写端点（两个 control + capability_invoke）远程幂等闸（无键 400 不过隧道）
//   3. 契约失败三分类（target_not_found / transport_unavailable / 远程原文）
//   4. 本地分支零网络（字节级不动）
//   5. 前端身份来源（焦点收敛宿主级命名空间 id + 目录命名空间 sessionId）、
//      写操作幂等键、连接能力矩阵 write 门控降级

const CONNECTIONS = [
  { id: 'server-a', name: 'Server A', enabled: true, mode: 'manual', localPort: 22101 },
];
const FIND_CONNECTION = (() => {
  const byId = new Map(CONNECTIONS.map((connection) => [connection.id, connection]));
  return (connectionId) => byId.get(connectionId) || null;
})();
const REMOTE_ORIGIN = 'http://127.0.0.1:22101';
const NAMESPACE = 'remote:server-a:agent-9';
const NS_RUNTIME = 'remote:server-a:rt-1';
const NS_SESSION = 'remote:server-a:session-7';

function silentRes() {
  return {
    statusCode: null,
    jsonPayload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.jsonPayload = payload; },
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
    set handler(next) { state.handler = next; },
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

function captureLifecycleHandler(routePath, method = 'get') {
  let handler = null;
  const capture = (want) => (p, ...rest) => {
    if (p === routePath && want === method) handler = rest[rest.length - 1];
  };
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
    { get: capture('get'), post: capture('post'), put: () => {}, delete: () => {} },
    { json: () => (req, res, next) => next() },
  );
  return handler;
}

function captureCapabilityHandler(routePath, method = 'get') {
  let handler = null;
  const capture = (want) => (p, ...rest) => {
    if (p === routePath && want === method) handler = rest[rest.length - 1];
  };
  setupCapabilityRoutes(
    { get: capture('get'), post: capture('post'), put: () => {}, delete: () => {} },
    { json: () => (req, res, next) => next() },
  );
  return handler;
}

// ── 1. 六端点远程分支：转发形状 + 裸 id + 远程响应原文透传 ─────────────────

describe('panel endpoint remote namespace branches (R2-04)', () => {
  afterEach(() => {
    setProxyConnectionLookup(null);
  });

  it('GET force_continuation_status forwards bare query ids over the tunnel', async () => {
    setProxyConnectionLookup(FIND_CONNECTION);
    const fetchMock = mockFetch(() => ({ status: 200, body: JSON.stringify({ ok: true, via: 'remote' }) }));
    try {
      const handler = captureLifecycleHandler('/protoclaw/force_continuation_status', 'get');
      const res = silentRes();
      await handler(
        { query: { agentId: NAMESPACE, sessionId: NS_SESSION, runtimeId: NS_RUNTIME } },
        res,
        (e) => { throw e; },
      );
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.jsonPayload, { ok: true, via: 'remote' });
      assert.equal(fetchMock.calls.length, 1);
      assert.equal(fetchMock.calls[0].url,
        `${REMOTE_ORIGIN}/protoclaw/force_continuation_status?agentId=agent-9&sessionId=session-7&runtimeId=rt-1`);
    } finally {
      fetchMock.restore();
    }
  });

  it('POST force_continuation_control forwards bare ids and the control payload', async () => {
    setProxyConnectionLookup(FIND_CONNECTION);
    const fetchMock = mockFetch(() => ({ status: 200, body: JSON.stringify({ ok: true, via: 'remote' }) }));
    try {
      const handler = captureLifecycleHandler('/protoclaw/force_continuation_control', 'post');
      const res = silentRes();
      await handler(
        {
          body: {
            agentId: NAMESPACE,
            sessionId: NS_SESSION,
            runtimeId: NS_RUNTIME,
            enabled: true,
            maxConsecutiveContinuations: 3,
            idempotencyKey: 'idem-fc',
          },
          headers: {},
        },
        res,
        (e) => { throw e; },
      );
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.jsonPayload, { ok: true, via: 'remote' });
      assert.equal(fetchMock.calls.length, 1);
      assert.equal(fetchMock.calls[0].url, `${REMOTE_ORIGIN}/protoclaw/force_continuation_control`);
      assert.equal(fetchMock.calls[0].init.method, 'POST');
      const sent = JSON.parse(fetchMock.calls[0].init.body);
      assert.deepEqual(sent, {
        agentId: 'agent-9',
        sessionId: 'session-7',
        runtimeId: 'rt-1',
        enabled: true,
        maxConsecutiveContinuations: 3,
        idempotencyKey: 'idem-fc',
      });
    } finally {
      fetchMock.restore();
    }
  });

  it('GET context_guard_status forwards bare query ids', async () => {
    setProxyConnectionLookup(FIND_CONNECTION);
    const fetchMock = mockFetch(() => ({ status: 200, body: JSON.stringify({ ok: true, via: 'remote' }) }));
    try {
      const handler = captureLifecycleHandler('/protoclaw/context_guard_status', 'get');
      const res = silentRes();
      await handler(
        { query: { agentId: NAMESPACE, sessionId: NS_SESSION } },
        res,
        (e) => { throw e; },
      );
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.jsonPayload, { ok: true, via: 'remote' });
      assert.equal(fetchMock.calls.length, 1);
      assert.equal(fetchMock.calls[0].url,
        `${REMOTE_ORIGIN}/protoclaw/context_guard_status?agentId=agent-9&sessionId=session-7`);
    } finally {
      fetchMock.restore();
    }
  });

  it('POST context_guard_control forwards bare body ids and keeps a missing runtimeId null', async () => {
    setProxyConnectionLookup(FIND_CONNECTION);
    const fetchMock = mockFetch(() => ({ status: 200, body: JSON.stringify({ ok: true, via: 'remote' }) }));
    try {
      const handler = captureLifecycleHandler('/protoclaw/context_guard_control', 'post');
      const res = silentRes();
      await handler(
        {
          body: { agentId: NAMESPACE, sessionId: NS_SESSION, armed: true, idempotencyKey: 'idem-guard' },
          headers: {},
        },
        res,
        (e) => { throw e; },
      );
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.jsonPayload, { ok: true, via: 'remote' });
      const sent = JSON.parse(fetchMock.calls[0].init.body);
      assert.deepEqual(sent, {
        armed: true,
        idempotencyKey: 'idem-guard',
        agentId: 'agent-9',
        runtimeId: null,
        sessionId: 'session-7',
      });
    } finally {
      fetchMock.restore();
    }
  });

  it('GET /protoclaw/commands forwards bare query ids for the remote slash menu source', async () => {
    setProxyConnectionLookup(FIND_CONNECTION);
    const fetchMock = mockFetch(() => ({
      status: 200,
      body: JSON.stringify({ ok: true, host: [{ name: 'trim' }], commands: [{ ref: 'demo.ping', name: 'ping' }] }),
    }));
    try {
      const handler = captureCapabilityHandler('/protoclaw/commands', 'get');
      const res = silentRes();
      await handler(
        { query: { agentId: NAMESPACE, runtimeId: NS_RUNTIME, sessionId: NS_SESSION } },
        res,
        (e) => { throw e; },
      );
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.jsonPayload, { ok: true, host: [{ name: 'trim' }], commands: [{ ref: 'demo.ping', name: 'ping' }] });
      assert.equal(fetchMock.calls.length, 1);
      assert.equal(fetchMock.calls[0].url,
        `${REMOTE_ORIGIN}/protoclaw/commands?agentId=agent-9&runtimeId=rt-1&sessionId=session-7`);
    } finally {
      fetchMock.restore();
    }
  });

  it('POST capability_invoke forwards bare ids and returns the remote result verbatim', async () => {
    setProxyConnectionLookup(FIND_CONNECTION);
    const fetchMock = mockFetch(() => ({ status: 200, body: JSON.stringify({ ok: true, result: { swapped: true } }) }));
    try {
      const handler = captureCapabilityHandler('/protoclaw/capability_invoke', 'post');
      const res = silentRes();
      await handler(
        {
          body: { agentId: NAMESPACE, sessionId: NS_SESSION, runtimeId: NS_RUNTIME, ref: 'step-rotating-model.configure', args: { enabled: true }, idempotencyKey: 'idem-invoke' },
          headers: {},
        },
        res,
        (e) => { throw e; },
      );
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.jsonPayload, { ok: true, result: { swapped: true } });
      assert.equal(fetchMock.calls.length, 1);
      assert.equal(fetchMock.calls[0].url, `${REMOTE_ORIGIN}/protoclaw/capability_invoke`);
      assert.equal(fetchMock.calls[0].init.method, 'POST');
      const sent = JSON.parse(fetchMock.calls[0].init.body);
      assert.deepEqual(sent, {
        ref: 'step-rotating-model.configure',
        args: { enabled: true },
        idempotencyKey: 'idem-invoke',
        agentId: 'agent-9',
        runtimeId: 'rt-1',
        sessionId: 'session-7',
      });
    } finally {
      fetchMock.restore();
    }
  });
});

// ── 2. 远程写幂等闸（三个写端点） ──────────────────────────────────────────

describe('remote write idempotency gate for panel controls', () => {
  afterEach(() => {
    setProxyConnectionLookup(null);
  });

  it('rejects keyless remote writes locally (400 idempotency_key_required) and never crosses the tunnel', async () => {
    setProxyConnectionLookup(FIND_CONNECTION);
    const fetchMock = mockFetch();
    try {
      const fcControl = captureLifecycleHandler('/protoclaw/force_continuation_control', 'post');
      const fcRes = silentRes();
      await fcControl(
        { body: { agentId: NAMESPACE, sessionId: NS_SESSION, enabled: true }, headers: {} },
        fcRes,
        (e) => { throw e; },
      );
      assert.equal(fcRes.statusCode, 400);
      assert.equal(fcRes.jsonPayload.ok, false);
      assert.equal(fcRes.jsonPayload.code, 'idempotency_key_required');
      assert.equal(fcRes.jsonPayload.retryable, false);

      const guardControl = captureLifecycleHandler('/protoclaw/context_guard_control', 'post');
      const guardRes = silentRes();
      await guardControl(
        { body: { agentId: NAMESPACE, sessionId: NS_SESSION, armed: true }, headers: {} },
        guardRes,
        (e) => { throw e; },
      );
      assert.equal(guardRes.statusCode, 400);
      assert.equal(guardRes.jsonPayload.code, 'idempotency_key_required');

      const invoke = captureCapabilityHandler('/protoclaw/capability_invoke', 'post');
      const invokeRes = silentRes();
      await invoke(
        { body: { agentId: NAMESPACE, sessionId: NS_SESSION, ref: 'demo.x' }, headers: {} },
        invokeRes,
        (e) => { throw e; },
      );
      assert.equal(invokeRes.statusCode, 400);
      assert.equal(invokeRes.jsonPayload.code, 'idempotency_key_required');
      assert.equal(invokeRes.jsonPayload.retryable, false);

      assert.equal(fetchMock.calls.length, 0, 'keyless remote writes must not cross the tunnel');
    } finally {
      fetchMock.restore();
    }
  });

  it('accepts the key via the x-idempotency-key header', async () => {
    setProxyConnectionLookup(FIND_CONNECTION);
    const fetchMock = mockFetch(() => ({ status: 200, body: JSON.stringify({ ok: true, via: 'remote' }) }));
    try {
      const handler = captureLifecycleHandler('/protoclaw/context_guard_control', 'post');
      const res = silentRes();
      await handler(
        { body: { agentId: NAMESPACE, sessionId: NS_SESSION, armed: true }, headers: { 'x-idempotency-key': 'idem-header' } },
        res,
        (e) => { throw e; },
      );
      assert.equal(res.statusCode, 200);
      assert.equal(fetchMock.calls.length, 1, 'header-borne key passes the local gate');
    } finally {
      fetchMock.restore();
    }
  });

  it('keeps local writes key-free: no namespace → local IPC path, no gate, no HTTP', async () => {
    setProxyConnectionLookup(FIND_CONNECTION);
    const fetchMock = mockFetch();
    try {
      const handler = captureLifecycleHandler('/protoclaw/context_guard_control', 'post');
      const res = silentRes();
      await handler(
        { body: { agentId: 'local-agent', sessionId: 'local-session', armed: true }, headers: {} },
        res,
        (e) => { throw e; },
      );
      assert.equal(res.statusCode, 503, 'local branch keeps its IPC-miss contract with no key demanded');
      assert.equal(res.jsonPayload.code, undefined, 'local 503 keeps its legacy shape (no key gate payload)');
      assert.equal(fetchMock.calls.length, 0);
    } finally {
      fetchMock.restore();
    }
  });
});

// ── 3. 契约失败三分类 ─────────────────────────────────────────────────────

describe('contract failure shapes for panel forwards', () => {
  afterEach(() => {
    setProxyConnectionLookup(null);
  });

  it('maps unknown remote connections onto target_not_found for panel endpoints too', async () => {
    setProxyConnectionLookup(FIND_CONNECTION);
    const fetchMock = mockFetch();
    try {
      const statusHandler = captureLifecycleHandler('/protoclaw/context_guard_status', 'get');
      const statusRes = silentRes();
      await statusHandler(
        { query: { agentId: 'remote:ghost:agent-9', sessionId: 'remote:ghost:s1' } },
        statusRes,
        (e) => { throw e; },
      );
      assert.equal(statusRes.statusCode, 404);
      assert.equal(statusRes.jsonPayload.ok, false);
      assert.equal(statusRes.jsonPayload.code, 'target_not_found');

      const invoke = captureCapabilityHandler('/protoclaw/capability_invoke', 'post');
      const invokeRes = silentRes();
      await invoke(
        { body: { agentId: 'remote:ghost:agent-9', sessionId: 'remote:ghost:s1', ref: 'demo.x', idempotencyKey: 'idem-ghost' }, headers: {} },
        invokeRes,
        (e) => { throw e; },
      );
      assert.equal(invokeRes.statusCode, 404);
      assert.equal(invokeRes.jsonPayload.code, 'target_not_found');
      assert.equal(fetchMock.calls.length, 0);
    } finally {
      fetchMock.restore();
    }
  });

  it('surfaces tunnel failures as retryable transport_unavailable', async () => {
    setProxyConnectionLookup(FIND_CONNECTION);
    const fetchMock = mockFetch(() => { throw new Error('tunnel down'); });
    try {
      const handler = captureLifecycleHandler('/protoclaw/force_continuation_status', 'get');
      const res = silentRes();
      await handler(
        { query: { agentId: NAMESPACE, sessionId: NS_SESSION } },
        res,
        (e) => { throw e; },
      );
      assert.equal(res.statusCode, 503);
      assert.equal(res.jsonPayload.ok, false);
      assert.equal(res.jsonPayload.code, 'transport_unavailable');
      assert.equal(res.jsonPayload.retryable, true);
    } finally {
      fetchMock.restore();
    }
  });

  it('passes remote-side validation failures through verbatim', async () => {
    setProxyConnectionLookup(FIND_CONNECTION);
    const fetchMock = mockFetch(() => ({
      status: 400,
      body: JSON.stringify({ ok: false, error: 'enabled must be a boolean' }),
    }));
    try {
      const handler = captureLifecycleHandler('/protoclaw/force_continuation_control', 'post');
      const res = silentRes();
      await handler(
        { body: { agentId: NAMESPACE, sessionId: NS_SESSION, runtimeId: NS_RUNTIME, enabled: 'yes', idempotencyKey: 'idem-x' }, headers: {} },
        res,
        (e) => { throw e; },
      );
      assert.equal(res.statusCode, 400, 'remote response status and body pass through verbatim');
      assert.deepEqual(res.jsonPayload, { ok: false, error: 'enabled must be a boolean' });
      assert.equal(fetchMock.calls.length, 1);
    } finally {
      fetchMock.restore();
    }
  });

  it('reports unparseable remote responses via the operation contract', async () => {
    setProxyConnectionLookup(FIND_CONNECTION);
    const fetchMock = mockFetch(() => ({ status: 200, body: 'not json' }));
    try {
      const handler = captureCapabilityHandler('/protoclaw/capability_invoke', 'post');
      const res = silentRes();
      await handler(
        { body: { agentId: NAMESPACE, sessionId: NS_SESSION, ref: 'demo.x', idempotencyKey: 'idem-bad' }, headers: {} },
        res,
        (e) => { throw e; },
      );
      assert.equal(res.statusCode, 502);
      assert.equal(res.jsonPayload.ok, false);
      assert.equal(res.jsonPayload.code, 'operation_rejected');
    } finally {
      fetchMock.restore();
    }
  });
});

// ── 4. 本地分支零网络（ADR-0011 #1：本地路径字节级不动） ──────────────────

describe('local panel branches stay off the wire', () => {
  afterEach(() => {
    setProxyConnectionLookup(null);
  });

  it('all six endpoints answer via the local IPC path with zero HTTP forwards', async () => {
    setProxyConnectionLookup(FIND_CONNECTION);
    const fetchMock = mockFetch();
    try {
      const fcStatus = captureLifecycleHandler('/protoclaw/force_continuation_status', 'get');
      const fcStatusRes = silentRes();
      await fcStatus({ query: { agentId: 'local-agent', sessionId: 'local-session' } }, fcStatusRes, (e) => { throw e; });
      assert.equal(fcStatusRes.statusCode, 503);
      assert.equal(fcStatusRes.jsonPayload.error, 'session runtime not connected');

      const fcControl = captureLifecycleHandler('/protoclaw/force_continuation_control', 'post');
      const fcControlRes = silentRes();
      await fcControl(
        { body: { agentId: 'local-agent', sessionId: 'local-session', enabled: true }, headers: {} },
        fcControlRes,
        (e) => { throw e; },
      );
      assert.equal(fcControlRes.statusCode, 503);

      const guardStatus = captureLifecycleHandler('/protoclaw/context_guard_status', 'get');
      const guardStatusRes = silentRes();
      await guardStatus({ query: { agentId: 'local-agent', sessionId: 'local-session' } }, guardStatusRes, (e) => { throw e; });
      assert.equal(guardStatusRes.statusCode, 503);

      const guardControl = captureLifecycleHandler('/protoclaw/context_guard_control', 'post');
      const guardControlRes = silentRes();
      await guardControl(
        { body: { agentId: 'local-agent', sessionId: 'local-session', armed: true }, headers: {} },
        guardControlRes,
        (e) => { throw e; },
      );
      assert.equal(guardControlRes.statusCode, 503);

      const commands = captureCapabilityHandler('/protoclaw/commands', 'get');
      const commandsRes = silentRes();
      await commands({ query: { agentId: 'local-agent', sessionId: 'local-session' } }, commandsRes, (e) => { throw e; });
      assert.equal(commandsRes.statusCode, null, 'local success responds via plain res.json');
      assert.equal(commandsRes.jsonPayload.ok, true);
      assert.deepEqual(commandsRes.jsonPayload.commands, []);
      assert.ok(commandsRes.jsonPayload.warning, 'runtime miss degrades to the host subset with a warning');

      const invoke = captureCapabilityHandler('/protoclaw/capability_invoke', 'post');
      const invokeRes = silentRes();
      await invoke(
        { body: { agentId: 'local-agent', sessionId: 'local-session', ref: 'demo.x' }, headers: {} },
        invokeRes,
        (e) => { throw e; },
      );
      assert.equal(invokeRes.statusCode, 503);

      assert.equal(fetchMock.calls.length, 0, 'local panel branches must never produce an HTTP forward');
    } finally {
      fetchMock.restore();
    }
  });
});

// ── 4. 前端沙箱：面板身份来源 / 幂等键 / 能力门控 ─────────────────────────

const REMOTE_CATALOG = {
  connections: [{
    connectionId: 'server-a',
    name: 'Lab-B',
    status: 'connected',
    capabilities: { write: true, sessionOps: true, workspaceCreate: true },
    workspaces: [{
      projectKey: 'k1',
      entries: [{
        id: 'remote:server-a:rt-1',
        runtimeId: 'remote:server-a:rt-1',
        agentId: 'remote:server-a:programming-helper',
        sessionId: 'remote:server-a:session-1',
        source: 'remote',
      }],
    }],
  }],
};

async function panelSandbox({ catalog = REMOTE_CATALOG, currentRuntimeAgentId = 'remote:server-a:rt-1', focusedAgentId = 'remote:server-a:programming-helper', viewerSessionId = '' } = {}) {
  const calls = [];
  const fetchStub = async (url, init = {}) => {
    calls.push({ url: String(url), init: init || {} });
    const path = String(url).split('?')[0];
    if (path === '/protoclaw/remote_catalog') {
      return { ok: true, status: 200, json: async () => catalog };
    }
    if (path === '/protoclaw/model_config') {
      return { ok: true, status: 200, json: async () => ({ presets: [{ name: 'gpt', protocol: 'openai' }] }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, status: { enabled: false } }) };
  };
  const ctx = createFrontendSandbox({
    currentRuntimeAgentId,
    focusedAgentId,
    currentHookInspector: {
      features: [{ name: 'force-continuation' }, { name: 'context-guard' }, { name: 'step-rotating-model' }],
    },
    featurePanelBody: { addEventListener() {} },
    activeFeaturePanel: '',
    renderFeaturePanel: () => {},
    renderAgentList: () => {},
    getRuntimeWorkspaceSessionId: (runtimeId) => (
      viewerSessionId && !String(runtimeId || '').startsWith('remote:') ? viewerSessionId : ''
    ),
    setInterval: () => ({ unref() {} }),
    clearInterval: () => {},
    // 面板 fetch 参数用 new URLSearchParams 构造；沙箱默认全局面没有它。
    URLSearchParams,
    fetch: fetchStub,
  });
  ctx.loadSource('public/src/modules/remote-connections.js');
  ctx.loadSource('public/src/modules/session-controls-panel.js');
  // 目录条目先入位：面板身份解析依赖 catalog（getEntryRuntimeSessionId /
  // getEntryHostNamespaceId / capabilityFor 均消费 ingest 后的可见分区）。
  await ctx.window.RemoteConnections.refresh();
  return { ctx, calls };
}

describe('frontend session-controls-panel identity (R2-04)', () => {
  it('addresses a remote session with the host-level namespace id and the catalog session id', async () => {
    const { ctx, calls } = await panelSandbox();
    await ctx.window.SessionControlsPanel.refreshStatus();
    const statusCall = calls.find((c) => c.url.startsWith('/protoclaw/force_continuation_status'));
    assert.ok(statusCall, 'status refresh must fire for a remote session');
    assert.equal(statusCall.url,
      '/protoclaw/force_continuation_status?agentId=remote%3Aserver-a%3Aprogramming-helper&sessionId=remote%3Aserver-a%3Asession-1');
  });

  it('keeps local identity plain: agentId is the focused logical id and sessionId the viewer binding', async () => {
    const { ctx, calls } = await panelSandbox({
      currentRuntimeAgentId: 'rt-local-1',
      focusedAgentId: 'programming-helper',
      viewerSessionId: 'local-session-1',
    });
    await ctx.window.SessionControlsPanel.refreshStatus();
    const statusCall = calls.find((c) => c.url.startsWith('/protoclaw/force_continuation_status'));
    assert.ok(statusCall);
    assert.equal(statusCall.url,
      '/protoclaw/force_continuation_status?agentId=programming-helper&sessionId=local-session-1');
  });

  it('carries the idempotency key on all three panel write paths with namespaced ids', async () => {
    const { ctx, calls } = await panelSandbox();
    await ctx.window.SessionControlsPanel.updateEnabled(true);
    await ctx.window.SessionControlsPanel.updateGuardArmed(true);
    await ctx.window.SessionControlsPanel.updateRotationConfig({ enabled: true });

    const writes = calls.filter((c) => c.init.method === 'POST');
    assert.equal(writes.length, 3, 'fc control + guard control + capability invoke');
    for (const write of writes) {
      assert.ok(write.init.headers['x-idempotency-key'], `${write.url} carries an idempotency key`);
      const body = JSON.parse(write.init.body);
      assert.equal(body.agentId, 'remote:server-a:programming-helper');
      assert.equal(body.sessionId, 'remote:server-a:session-1');
    }
    const invoke = writes.find((c) => c.url === '/protoclaw/capability_invoke');
    assert.equal(JSON.parse(invoke.init.body).runtimeId, 'remote:server-a:rt-1', 'invoke forwards the runtime ref for bare-id rewrite');
    assert.equal(JSON.parse(invoke.init.body).ref, 'step-rotating-model.configure');
  });
});

describe('frontend session-controls-panel capability gating (ADR-0011 #5)', () => {
  it('degrades to a read-only panel when the connection lacks the write bit, without a remote marker', async () => {
    const legacyCatalog = JSON.parse(JSON.stringify(REMOTE_CATALOG));
    delete legacyCatalog.connections[0].capabilities;
    const { ctx, calls } = await panelSandbox({ catalog: legacyCatalog });
    await ctx.window.SessionControlsPanel.updateGuardArmed(true);
    assert.equal(calls.filter((c) => c.url === '/protoclaw/context_guard_control').length, 0,
      'no-write remote must not dispatch panel writes');
    const html = ctx.window.SessionControlsPanel.render();
    assert.match(html, / disabled/, 'switches render disabled (read-only degradation, no remote marker)');
    assert.ok(!html.includes('remote:'), 'no remote namespace id leaks into the panel markup');
  });

  it('keeps the panel writable for capable remotes and for local sessions', async () => {
    const remote = await panelSandbox();
    const remoteHtml = remote.ctx.window.SessionControlsPanel.render();
    assert.ok(!remoteHtml.includes(' disabled'), 'write-capable remote keeps switches enabled');

    const local = await panelSandbox({
      currentRuntimeAgentId: 'rt-local-1',
      focusedAgentId: 'programming-helper',
      viewerSessionId: 'local-session-1',
    });
    const localHtml = local.ctx.window.SessionControlsPanel.render();
    assert.ok(!localHtml.includes(' disabled'), 'local sessions always stay writable');
    await local.ctx.window.SessionControlsPanel.updateGuardArmed(true);
    assert.ok(local.calls.filter((c) => c.url === '/protoclaw/context_guard_control').length === 1,
      'local writes go through the local path (no gate)');
  });
});
