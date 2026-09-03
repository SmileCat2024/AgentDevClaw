/**
 * R2-03 — ui-surfaces 面板资源远程扩列。
 *
 * 覆盖工单最低测试集：
 *   1. 五端点转发用例：转发形状 / 裸 id 展开 / 幂等闸 400 / 未知连接 404 契约 /
 *      本地分支零网络
 *   2. GET registry 的 ETag / 304 透传（PassThrough 转发变体）
 *   3. 远程 action 的 eventId 幂等键透传断言（凭证 = body.eventId）
 *   4. 前端面板：动作提交 x-idempotency-key 头 + capabilityFor('write') 门控
 *
 * 不依赖真实模型与真实远程服务器（本地 mock fetch / 沙箱）。
 */

import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import http from 'node:http';
import express from 'express';

import { setupUISurfaceRoutes } from '../server/routes/ui-surfaces.js';
import { setProxyConnectionLookup } from '../server/shared/proxy.js';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

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

function mockFetch(handler) {
  const state = { calls: [], handler };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    state.calls.push({ url: String(url), init });
    const result = state.handler ? state.handler(String(url), init, state.calls.length) : { status: 200, body: '{}' };
    return {
      status: result.status,
      headers: new Headers(result.headers || {}),
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

describe('ui-surfaces remote namespace branches (R2-03)', () => {
  let server;
  let port;
  let fetchMock;

  before(async () => {
    const app = express();
    setupUISurfaceRoutes(app, express);
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

  function request(method, path, { body, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method,
          path,
          headers: {
            ...(body ? { 'content-type': 'application/json' } : {}),
            ...headers,
          },
        },
        (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            resolve({
              status: res.statusCode,
              headers: res.headers,
              body: text,
              json: JSON.parse(text || 'null'),
            });
          });
        },
      );
      req.on('error', reject);
      req.setTimeout(2000, () => req.destroy(new Error('test request timeout')));
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  // ── 1. GET registry — forward + ETag/304 passthrough ──────────────────

  it('forwards GET registry with a bare id, forwarded query and If-None-Match, passing through the remote ETag', async () => {
    fetchMock.calls.length = 0;
    fetchMock.handler = () => ({
      status: 200,
      headers: { etag: '"r5"' },
      body: JSON.stringify({ agentId: 'agent-9', registryRevision: 5, surfaces: [{ surfaceId: 'form-1', spec: { title: 'F' } }] }),
    });
    const res = await request('GET', `/protoclaw/agents/${ENCODED_NAMESPACE}/ui-surfaces?includeSpec=true`, {
      headers: { 'if-none-match': '"r4"' },
    });
    assert.equal(res.status, 200);
    assert.equal(fetchMock.calls.length, 1);
    assert.equal(fetchMock.calls[0].url, `${REMOTE_ORIGIN}/protoclaw/agents/agent-9/ui-surfaces?includeSpec=true`);
    assert.equal(fetchMock.calls[0].init.method, 'GET');
    assert.equal(fetchMock.calls[0].init.headers['If-None-Match'], '"r4"', 'If-None-Match must travel to the remote');
    assert.deepEqual(res.json, {
      agentId: 'agent-9',
      registryRevision: 5,
      surfaces: [{ surfaceId: 'form-1', spec: { title: 'F' } }],
    });
    assert.equal(res.headers.etag, '"r5"', 'remote ETag passes through so the poll can negotiate');
    fetchMock.handler = null;
  });

  it('passes a remote 304 through with its ETag instead of misreading the empty body as unparseable', async () => {
    fetchMock.calls.length = 0;
    fetchMock.handler = () => ({ status: 304, headers: { etag: '"r5"' }, body: '' });
    const res = await request('GET', `/protoclaw/agents/${ENCODED_NAMESPACE}/ui-surfaces?includeSpec=true`, {
      headers: { 'if-none-match': '"r5"' },
    });
    assert.equal(res.status, 304, 'negotiation hit must stay 304 (a JSON-normalizing forward would 502)');
    assert.equal(res.body, '');
    assert.equal(res.headers.etag, '"r5"');
    assert.equal(fetchMock.calls.length, 1);
    assert.equal(fetchMock.calls[0].init.headers['If-None-Match'], '"r5"', 'the poll ETag must cross the tunnel');
    fetchMock.handler = null;
  });

  it('forwards GET single with the bare id in the path', async () => {
    fetchMock.calls.length = 0;
    fetchMock.handler = () => ({ status: 200, body: JSON.stringify({ ok: true, surface: { surfaceId: 'form-1', revision: 2 } }) });
    const res = await request('GET', `/protoclaw/agents/${ENCODED_NAMESPACE}/ui-surfaces/form-1`);
    assert.equal(res.status, 200);
    assert.equal(fetchMock.calls.length, 1);
    assert.equal(fetchMock.calls[0].url, `${REMOTE_ORIGIN}/protoclaw/agents/agent-9/ui-surfaces/form-1`, 'forwarded with bare id in path');
    assert.deepEqual(res.json, { ok: true, surface: { surfaceId: 'form-1', revision: 2 } });
    fetchMock.handler = null;
  });

  // ── 2. DELETE close — idempotency gate + forward ──────────────────────

  it('rejects a remote DELETE without an idempotency key locally and never crosses the tunnel', async () => {
    fetchMock.calls.length = 0;
    fetchMock.handler = () => {
      throw new Error('keyless remote writes must not cross the tunnel');
    };
    const res = await request('DELETE', `/protoclaw/agents/${ENCODED_NAMESPACE}/ui-surfaces/form-1`);
    assert.equal(res.status, 400);
    assert.equal(res.json.ok, false);
    assert.equal(res.json.code, 'idempotency_key_required');
    assert.equal(res.json.retryable, false);
    assert.equal(fetchMock.calls.length, 0);
    fetchMock.handler = null;
  });

  it('forwards DELETE close with a bare id, preserved expectedRevision query, and the key', async () => {
    fetchMock.calls.length = 0;
    fetchMock.handler = () => ({ status: 200, body: JSON.stringify({ ok: true, surfaceId: 'form-1', alreadyClosed: false }) });
    const res = await request('DELETE', `/protoclaw/agents/${ENCODED_NAMESPACE}/ui-surfaces/form-1?expectedRevision=7`, {
      headers: { 'x-idempotency-key': 'idem-close' },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { ok: true, surfaceId: 'form-1', alreadyClosed: false });
    assert.equal(fetchMock.calls.length, 1);
    assert.equal(fetchMock.calls[0].url, `${REMOTE_ORIGIN}/protoclaw/agents/agent-9/ui-surfaces/form-1?expectedRevision=7`);
    assert.equal(fetchMock.calls[0].init.method, 'DELETE');
    fetchMock.handler = null;
  });

  // ── 3. POST action — eventId is the idempotency credential ────────────

  it('rejects a remote action without eventId locally and never crosses the tunnel', async () => {
    fetchMock.calls.length = 0;
    fetchMock.handler = () => ({ status: 200, body: '{}' });
    const res = await request('POST', `/protoclaw/agents/${ENCODED_NAMESPACE}/ui-surfaces/form-1/actions/submit`, { body: { surfaceRevision: 1 } });
    assert.equal(res.status, 400);
    assert.equal(res.json.ok, false);
    assert.equal(res.json.code, 'idempotency_key_required');
    assert.equal(res.json.retryable, false);
    assert.equal(fetchMock.calls.length, 0);
    fetchMock.handler = null;
  });

  it('treats a non-string eventId as keyless for the gate', async () => {
    fetchMock.calls.length = 0;
    const res = await request('POST', `/protoclaw/agents/${ENCODED_NAMESPACE}/ui-surfaces/form-1/actions/submit`, {
      body: { eventId: 123, surfaceRevision: 1 },
    });
    assert.equal(res.status, 400);
    assert.equal(res.json.code, 'idempotency_key_required');
    assert.equal(fetchMock.calls.length, 0);
  });

  it('forwards POST action with the raw body (eventId credential travels inside) and bare ids in the path', async () => {
    fetchMock.calls.length = 0;
    fetchMock.handler = () => ({ status: 200, body: JSON.stringify({ ok: true, delivery: 'input', requestId: 'req-1' }) });
    const res = await request('POST', `/protoclaw/agents/${ENCODED_NAMESPACE}/ui-surfaces/form-1/actions/submit`, {
      body: { eventId: 'evt-1', surfaceRevision: 2, values: { value: 'x' } },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { ok: true, delivery: 'input', requestId: 'req-1' });
    assert.equal(fetchMock.calls.length, 1);
    const forwarded = fetchMock.calls[0];
    assert.equal(forwarded.url, `${REMOTE_ORIGIN}/protoclaw/agents/agent-9/ui-surfaces/form-1/actions/submit`);
    assert.equal(forwarded.init.method, 'POST');
    const forwardedBody = JSON.parse(forwarded.init.body);
    assert.equal(forwardedBody.eventId, 'evt-1', 'eventId stays in the body as the remote dedup credential');
    assert.equal(forwardedBody.surfaceRevision, 2);
    assert.deepEqual(forwardedBody.values, { value: 'x' });
    fetchMock.handler = null;
  });

  it('passes a remote surface action response through byte-shape intact (delivery + requestId)', async () => {
    fetchMock.calls.length = 0;
    fetchMock.handler = () => ({ status: 200, body: JSON.stringify({ ok: true, delivery: 'queued', queued: true, requestId: null, queueId: 'q-1' }) });
    const res = await request('POST', `/protoclaw/agents/${ENCODED_NAMESPACE}/ui-surfaces/form-1/actions/submit`, {
      body: { eventId: 'evt-passthrough', surfaceRevision: 2, values: {} },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { ok: true, delivery: 'queued', queued: true, requestId: null, queueId: 'q-1' });
    fetchMock.handler = null;
  });

  // ── 4. PUT upsert — uniform namespace discipline branch ───────────────

  it('forwards PUT upsert with a bare id when an idempotency key is present', async () => {
    fetchMock.calls.length = 0;
    fetchMock.handler = () => ({ status: 201, body: JSON.stringify({ ok: true, surface: { surfaceId: 'form-1', revision: 3 } }) });
    const res = await request('PUT', `/protoclaw/agents/${ENCODED_NAMESPACE}/ui-surfaces/form-1`, {
      body: { spec: { schemaVersion: 1 }, expectedRevision: 2, presentation: { open: 'if-empty' }, idempotencyKey: 'idem-put' },
    });
    assert.equal(res.status, 201);
    assert.deepEqual(res.json, { ok: true, surface: { surfaceId: 'form-1', revision: 3 } });
    assert.equal(fetchMock.calls.length, 1);
    assert.equal(fetchMock.calls[0].url, `${REMOTE_ORIGIN}/protoclaw/agents/agent-9/ui-surfaces/form-1`);
    assert.equal(fetchMock.calls[0].init.method, 'PUT');
    const forwardedBody = JSON.parse(fetchMock.calls[0].init.body);
    assert.equal(forwardedBody.expectedRevision, 2);
    assert.equal(forwardedBody.idempotencyKey, 'idem-put', 'body fields pass through untouched');
    fetchMock.handler = null;
  });

  it('rejects a remote PUT without an idempotency key before any local validation runs', async () => {
    fetchMock.calls.length = 0;
    const res = await request('PUT', `/protoclaw/agents/${ENCODED_NAMESPACE}/ui-surfaces/form-1`, {
      body: { spec: { bogus: true } },
    });
    assert.equal(res.status, 400);
    assert.equal(res.json.ok, false);
    assert.equal(res.json.code, 'idempotency_key_required');
    assert.equal(res.json.retryable, false);
    assert.equal(fetchMock.calls.length, 0);
  });

  // ── 4. failure contract: unknown connection / transport ───────────────

  it('maps unknown remote connections onto the operation contract (target_not_found, no tunnel crossing)', async () => {
    setProxyConnectionLookup(null);
    try {
      const res = await request('GET', `/protoclaw/agents/${encodeURIComponent('remote:ghost:agent-9')}/ui-surfaces?includeSpec=true`);
      assert.equal(res.status, 404);
      assert.equal(res.json.ok, false);
      assert.equal(res.json.code, 'target_not_found');
      assert.equal(res.json.retryable, false);
      assert.equal(fetchMock.calls.length, 0);
    } finally {
      setProxyConnectionLookup(FIND_CONNECTION);
    }
  });

  it('maps transport failure to the retryable transport_unavailable contract shape', async () => {
    fetchMock.calls.length = 0;
    fetchMock.handler = () => {
      throw new Error('tunnel down');
    };
    const res = await request('GET', `/protoclaw/agents/${ENCODED_NAMESPACE}/ui-surfaces?includeSpec=true`);
    assert.equal(res.status, 503);
    assert.equal(res.json.ok, false);
    assert.equal(res.json.code, 'transport_unavailable');
    assert.equal(res.json.retryable, true);
    fetchMock.handler = null;
  });

  // ── 5. local branches stay byte-identical and off the wire ────────────

  it('keeps local branches off the wire: no key required, local validation, ETag/304, store paths', async () => {
    fetchMock.calls.length = 0;

    // Local PUT: spec upsert works with NO idempotency key (local paths do not
    // enforce the gate) and never crosses the wire.
    const spec = {
      schemaVersion: 1,
      catalogVersion: 'v1',
      title: 'Local',
      root: 'root',
      elements: {
        root: { type: 'Stack', props: {}, children: ['text'] },
        text: { type: 'Text', props: { content: 'Hello' }, children: [] },
      },
    };
    const putRes = await request('PUT', '/protoclaw/agents/local-ui-agent/ui-surfaces/page1', { body: { spec } });
    assert.equal(putRes.status, 201);
    assert.equal(putRes.json.ok, true);
    assert.equal(putRes.json.surface.revision, 1);

    // Local GET registry: 200 + ETag, then 304 on the same ETag (unchanged
    // negotiation shape).
    const getRes = await request('GET', '/protoclaw/agents/local-ui-agent/ui-surfaces?includeSpec=true');
    assert.equal(getRes.status, 200);
    assert.equal(getRes.json.agentId, 'local-ui-agent');
    assert.ok(Array.isArray(getRes.json.surfaces));
    const etag = getRes.headers.etag;
    assert.ok(etag, 'local registry sets an ETag');
    const revalidate = await request('GET', '/protoclaw/agents/local-ui-agent/ui-surfaces?includeSpec=true', {
      headers: { 'if-none-match': etag },
    });
    assert.equal(revalidate.status, 304);

    // Local GET single unknown surface keeps the local 404 shape.
    const singleRes = await request('GET', '/protoclaw/agents/local-ui-agent/ui-surfaces/ghost');
    assert.equal(singleRes.status, 404);
    assert.equal(singleRes.json.code, 'not_found');

    // Local DELETE close stays keyless and answers from the local store.
    const delRes = await request('DELETE', '/protoclaw/agents/local-ui-agent/ui-surfaces/ghost');
    assert.equal(delRes.status, 200);
    assert.equal(delRes.json.alreadyClosed, true);

    // Local action: keyless submit still yields the local invalid_request
    // validation (NOT idempotency_key_required) — the local path never
    // enforces the key; unknown surface 404s through the store validation.
    const noEvent = await request('POST', '/protoclaw/agents/local-ui-agent/ui-surfaces/page1/actions/submit', { body: {} });
    assert.equal(noEvent.status, 400);
    assert.equal(noEvent.json.code, 'invalid_request');
    const action = await request('POST', '/protoclaw/agents/local-ui-agent/ui-surfaces/nope/actions/submit', {
      body: { eventId: 'evt-local', surfaceRevision: 1, values: {} },
    });
    assert.equal(action.status, 404);
    assert.equal(action.json.code, 'not_found');

    assert.equal(fetchMock.calls.length, 0, 'local branches must never cross the wire');
  });

  it('keeps a local identity out of the remote branch even when connections exist', async () => {
    fetchMock.calls.length = 0;
    // Plain local ids resolve { scope: 'local' } — the store path answers and
    // no fetch happens even when the connection table is mounted.
    const spec = {
      schemaVersion: 1,
      catalogVersion: 'v1',
      title: 'Local',
      root: 'root',
      elements: {
        root: { type: 'Stack', props: {}, children: ['text'] },
        text: { type: 'Text', props: { content: 'Hi' }, children: [] },
      },
    };
    const putRes = await request('PUT', '/protoclaw/agents/local-ui-agent-2/ui-surfaces/page1', { body: { spec } });
    assert.equal(putRes.status, 201);
    assert.equal(fetchMock.calls.length, 0);
  });
});

// ── frontend panel: idempotency header + write gate ─────────────────────

function loadPanelSandbox(currentRuntimeAgentId) {
  const fetchCalls = [];
  const ctx = createFrontendSandbox({
    currentRuntimeAgentId,
    // 面板模块加载即启动 3s 轮询 interval；测试沙箱内用空实现短路，
    // 避免真实定时器悬挂 node:test 进程。
    setInterval: () => 0,
    fetch: async (url, init) => {
      fetchCalls.push({ url: String(url), init });
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ delivery: 'input', requestId: 'req-1' }),
      };
    },
  });
  ctx.loadSource('public/src/modules/generative-ui-panel.js');
  return { ctx, fetchCalls };
}

describe('gen-ui panel frontend write gate (R2-03)', () => {
  it('submit POST carries the eventId as the x-idempotency-key header (same value as the body credential)', async () => {
    const { ctx, fetchCalls } = loadPanelSandbox('remote:server-a:agent-9');
    ctx.window.RemoteConnections = {
      capabilityFor: (id, action) => (id === 'remote:server-a:agent-9' && action === 'write' ? true : false),
    };
    ctx.run('window.GenUIPanel._internal._registry.set("form-1", { spec: {}, revision: 1, title: "F", closed: false })');
    await ctx.run('window.GenUIPanel._internal._submitAction("form-1", "submit", { label: "S" }, { value: "x" })');
    assert.equal(fetchCalls.length, 1);
    const { url, init } = fetchCalls[0];
    assert.equal(init.method, 'POST');
    assert.equal(url, '/protoclaw/agents/remote%3Aserver-a%3Aagent-9/ui-surfaces/form-1/actions/submit');
    const body = JSON.parse(init.body);
    assert.equal(init.headers['x-idempotency-key'], body.eventId, 'header and body carry the same eventId credential');
    assert.equal(body.surfaceRevision, 1);
  });

  it('local sessions always stay writable and submit without any capability query', async () => {
    const { ctx, fetchCalls } = loadPanelSandbox('plain-agent');
    ctx.run('window.GenUIPanel._internal._registry.set("form-1", { spec: {}, revision: 1, title: "F", closed: false })');
    assert.equal(ctx.run('window.GenUIPanel._internal.actionSubmitEnabled("plain-agent")'), true);
    await ctx.run('window.GenUIPanel._internal._submitAction("form-1", "submit", {}, {})');
    assert.equal(fetchCalls.length, 1, 'local identity submits without consulting the capability matrix');
  });

  it('remote without the write capability bit disables submission and never sends the request', async () => {
    const { ctx, fetchCalls } = loadPanelSandbox('remote:server-a:agent-9');
    ctx.window.RemoteConnections = { capabilityFor: () => false };
    ctx.run('window.GenUIPanel._internal._registry.set("form-1", { spec: {}, revision: 1, title: "F", closed: false })');
    assert.equal(ctx.run('window.GenUIPanel._internal.actionSubmitEnabled("remote:server-a:agent-9")'), false);
    await ctx.run('window.GenUIPanel._internal._submitAction("form-1", "submit", {}, {})');
    assert.equal(fetchCalls.length, 0, 'gated sessions must not issue action POSTs');
  });

  it('degrades safely when the capability matrix is not mounted: local writable, remote not', () => {
    const { ctx } = loadPanelSandbox('plain-agent');
    assert.equal(ctx.run('window.GenUIPanel._internal.actionSubmitEnabled("plain-agent")'), true);
    assert.equal(ctx.run('window.GenUIPanel._internal.actionSubmitEnabled("remote:server-a:agent-9")'), false);
    assert.equal(ctx.run('window.GenUIPanel._internal.newIdempotencyKey()').length > 0, true);
  });
});
