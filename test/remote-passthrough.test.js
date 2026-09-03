import assert from 'node:assert/strict';
import test from 'node:test';

import { proxyToViewer, setProxyConnectionLookup } from '../server/shared/proxy.js';

// In-memory stand-in for the connection table: injected, no I/O (same shape
// as test/request-target.test.js).
const CONNECTIONS = [
  { id: 'server-a', name: 'Server A', enabled: true, mode: 'manual', localPort: 22101 },
  { id: 'server-b', name: 'Server B', enabled: false, mode: 'managed', localPort: 22102 },
];

function createFindConnection() {
  const byId = new Map(CONNECTIONS.map((connection) => [connection.id, connection]));
  return (connectionId) => byId.get(connectionId) || null;
}

const FIND_CONNECTION = createFindConnection();
const REMOTE_ORIGIN = 'http://127.0.0.1:22101';
const LOCAL_ORIGIN = 'http://127.0.0.1:2026';
const NAMESPACE = 'remote:server-a:agent-3-22040';
const ENCODED_NAMESPACE = encodeURIComponent(NAMESPACE);

function makeReq(originalUrl, { method = 'GET', headers = {}, params, body } = {}) {
  return {
    originalUrl,
    method,
    headers,
    params,
    async *[Symbol.asyncIterator]() {
      if (body) yield Buffer.from(body);
    },
  };
}

function makeRes() {
  return {
    statusCode: null,
    headers: new Map(),
    body: null,
    jsonPayload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader(key, value) {
      this.headers.set(key.toLowerCase(), value);
    },
    json(payload) {
      this.jsonPayload = payload;
      this.body = Buffer.from(JSON.stringify(payload));
    },
    end(payload) {
      this.body = payload;
    },
  };
}

function mockFetch(handler) {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const result = handler ? handler(String(url), init, calls.length) : { status: 200, body: '{}' };
    return {
      status: result.status,
      headers: new Headers(result.headers || { 'content-type': 'application/json; charset=utf-8' }),
      arrayBuffer: async () => Buffer.from(result.body ?? ''),
    };
  };
  return {
    calls,
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

test('forwards whitelisted runtime reads to the remote origin with restored ids', async () => {
  const fetchMock = mockFetch();
  try {
    const resources = ['messages', 'tools', 'hooks', 'overview', 'todo', 'notification', 'input-requests', 'running', 'connection'];
    for (const resource of resources) {
      const res = makeRes();
      await proxyToViewer(
        makeReq(`/api/agents/${ENCODED_NAMESPACE}/${resource}`),
        res,
        { findConnection: FIND_CONNECTION },
      );
      assert.equal(res.statusCode, 200, `${resource} response status`);
      assert.equal(
        fetchMock.calls.at(-1).url,
        `${REMOTE_ORIGIN}/api/agents/agent-3-22040/${resource}`,
        `${resource} forwarded url`,
      );
    }
    assert.equal(fetchMock.calls.length, resources.length);
  } finally {
    fetchMock.restore();
  }
});

test('forwards the whitelisted agent_detail query read to the remote origin', async () => {
  const fetchMock = mockFetch();
  try {
    const res = makeRes();
    await proxyToViewer(
      makeReq(`/protoclaw/agent_detail?agentId=${ENCODED_NAMESPACE}`),
      res,
      { findConnection: FIND_CONNECTION },
    );
    assert.equal(res.statusCode, 200);
    assert.equal(
      fetchMock.calls.at(-1).url,
      `${REMOTE_ORIGIN}/protoclaw/agent_detail?agentId=agent-3-22040`,
      'agent_detail forwarded with restored id',
    );

    // The whitelisting is GET-only: a write to the same path is still rejected.
    const postRes = makeRes();
    await proxyToViewer(
      makeReq(`/protoclaw/agent_detail?agentId=${ENCODED_NAMESPACE}`, { method: 'POST' }),
      postRes,
      { findConnection: FIND_CONNECTION },
    );
    assert.equal(postRes.statusCode, 403);
    assert.equal(fetchMock.calls.length, 1);
  } finally {
    fetchMock.restore();
  }
});

test('forwards whitelisted static assets and restores the namespaced agent param', async () => {
  const fetchMock = mockFetch(({ url }) => ({
    status: 200,
    headers: { 'content-type': 'application/javascript; charset=utf-8' },
    body: `/* ${url} */`,
  }));
  try {
    const cases = [
      {
        requestUrl: `/tpl/0123456789ab/dist/features/foo/templates/tool.render.js?agentId=${ENCODED_NAMESPACE}`,
        forwarded: `${REMOTE_ORIGIN}/tpl/0123456789ab/dist/features/foo/templates/tool.render.js?agentId=agent-3-22040`,
      },
      {
        requestUrl: `/npm/qqbot-feature/features/im/render.js?agent=${NAMESPACE}`,
        forwarded: `${REMOTE_ORIGIN}/npm/qqbot-feature/features/im/render.js?agent=agent-3-22040`,
      },
      {
        requestUrl: `/chunk-ABC123.js?agentId=${ENCODED_NAMESPACE}`,
        forwarded: `${REMOTE_ORIGIN}/chunk-ABC123.js?agentId=agent-3-22040`,
      },
    ];
    for (const { requestUrl, forwarded } of cases) {
      const res = makeRes();
      await proxyToViewer(makeReq(requestUrl), res, { findConnection: FIND_CONNECTION });
      assert.equal(res.statusCode, 200);
      assert.equal(fetchMock.calls.at(-1).url, forwarded);
    }
  } finally {
    fetchMock.restore();
  }
});

test('passes operation metadata headers through on remote forwards', async () => {
  const fetchMock = mockFetch();
  try {
    await proxyToViewer(
      makeReq(`/api/agents/${ENCODED_NAMESPACE}/messages`, {
        headers: { 'x-operation-id': 'op-9', 'x-trace-id': 'trace-9' },
      }),
      makeRes(),
      { findConnection: FIND_CONNECTION },
    );
    assert.equal(fetchMock.calls[0].init.headers.get('x-operation-id'), 'op-9');
    assert.equal(fetchMock.calls[0].init.headers.get('x-trace-id'), 'trace-9');
  } finally {
    fetchMock.restore();
  }
});

test('rewrites the remote template map so follow-up urls route back through the proxy', async () => {
  const remoteBody = JSON.stringify({
    'tool.render': '/tpl/0123456789ab/dist/features/foo/templates/tool.render.js',
    'other.render': '/npm/shell-feature/features/shell/render.js',
  });
  const fetchMock = mockFetch(() => ({
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'content-length': String(Buffer.byteLength(remoteBody)) },
    body: remoteBody,
  }));
  try {
    const res = makeRes();
    await proxyToViewer(
      makeReq(`/api/templates/feature?agentId=${ENCODED_NAMESPACE}`),
      res,
      { findConnection: FIND_CONNECTION },
    );

    assert.equal(fetchMock.calls[0].url, `${REMOTE_ORIGIN}/api/templates/feature?agentId=agent-3-22040`);
    assert.equal(res.statusCode, 200);
    // The stale remote content-length must not survive a rewritten body.
    assert.equal(res.headers.has('content-length'), false);
    assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.deepEqual(JSON.parse(res.body.toString('utf8')), {
      'tool.render': `/tpl/0123456789ab/dist/features/foo/templates/tool.render.js?agentId=${ENCODED_NAMESPACE}`,
      'other.render': `/npm/shell-feature/features/shell/render.js?agentId=${ENCODED_NAMESPACE}`,
    });
  } finally {
    fetchMock.restore();
  }
});

test('template url rewrite round-trips: namespaced request restores the remote form', async () => {
  const fetchMock = mockFetch();
  try {
    // Remote answers the map request with plain urls.
    const remoteMap = JSON.stringify({ 'tool.render': '/tpl/0123456789ab/tpl/tool.render.js' });
    globalThis.fetch = async (url, init) => {
      fetchMock.calls.push({ url: String(url), init });
      return {
        status: 200,
        headers: new Headers({ 'content-type': 'application/json; charset=utf-8' }),
        arrayBuffer: async () => Buffer.from(remoteMap),
      };
    };

    const mapRes = makeRes();
    await proxyToViewer(
      makeReq(`/api/templates/feature?agentId=${ENCODED_NAMESPACE}`),
      mapRes,
      { findConnection: FIND_CONNECTION },
    );
    const frontendUrl = JSON.parse(mapRes.body.toString('utf8'))['tool.render'];
    assert.equal(frontendUrl, `/tpl/0123456789ab/tpl/tool.render.js?agentId=${ENCODED_NAMESPACE}`);

    // The frontend then fetches that url; the proxy restores the remote form.
    const assetRes = makeRes();
    await proxyToViewer(makeReq(frontendUrl), assetRes, { findConnection: FIND_CONNECTION });
    assert.equal(
      fetchMock.calls[1].url,
      `${REMOTE_ORIGIN}/tpl/0123456789ab/tpl/tool.render.js?agentId=agent-3-22040`,
    );
  } finally {
    fetchMock.restore();
  }
});

test('leaves remote message bodies byte-identical, including internal references', async () => {
  const remoteBody = JSON.stringify({
    agentId: 'agent-3-22040',
    messages: [
      { role: 'assistant', content: 'rendered via /tpl/0123456789ab/tpl/tool.render.js on agent-3-22040' },
    ],
  });
  const fetchMock = mockFetch(() => ({
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: remoteBody,
  }));
  try {
    const res = makeRes();
    await proxyToViewer(
      makeReq(`/api/agents/${ENCODED_NAMESPACE}/messages?sessionId=session-9`),
      res,
      { findConnection: FIND_CONNECTION },
    );
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.toString('utf8'), remoteBody);
  } finally {
    fetchMock.restore();
  }
});

test('Phase 2: keyless writes to pass-through resources hit the idempotency gate locally', async () => {
  const fetchMock = mockFetch();
  try {
    const writes = [
      { method: 'POST', url: `/api/agents/${ENCODED_NAMESPACE}/input`, body: '{"text":"hello"}' },
      { method: 'POST', url: `/api/agents/${ENCODED_NAMESPACE}/interrupt`, body: '{}' },
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
    assert.equal(fetchMock.calls.length, 0, 'keyless writes must not reach the remote');
  } finally {
    fetchMock.restore();
  }
});

test('rejects remote write methods locally with remote_write_disabled and never forwards', async () => {
  const fetchMock = mockFetch();
  try {
    const writes = [
      // Not a pass-through resource (and a typo'd one at that).
      { method: 'POST', url: `/api/agents/${ENCODED_NAMESPACE}/queue-input`, body: '{"text":"hi"}' },
      { method: 'DELETE', url: `/api/agents/${ENCODED_NAMESPACE}` },
      { method: 'PUT', url: `/api/agents/${ENCODED_NAMESPACE}/todo`, body: '{}' },
    ];
    for (const { method, url, body } of writes) {
      const res = makeRes();
      await proxyToViewer(
        makeReq(url, { method, body, headers: { 'x-operation-id': 'op-write', 'x-idempotency-key': 'idem-x' } }),
        res,
        { findConnection: FIND_CONNECTION },
      );
      assert.equal(res.statusCode, 403, `${method} ${url} status`);
      assert.equal(res.jsonPayload.ok, false);
      assert.equal(res.jsonPayload.code, 'remote_write_disabled');
      assert.equal(res.jsonPayload.retryable, false);
      assert.equal(res.jsonPayload.operationId, 'op-write');
      assert.equal(res.jsonPayload.error, res.jsonPayload.message);
    }
    assert.equal(fetchMock.calls.length, 0, 'writes must never reach the remote');
  } finally {
    fetchMock.restore();
  }
});

test('rejects remote reads outside the whitelist locally without forwarding', async () => {
  const fetchMock = mockFetch();
  try {
    // queued-inputs moved to the Phase 2 pass-through surface; /api/logs and
    // /api/mcp-info joined the whitelist in R2-05, so a viewer read that is
    // still outside it fails here.
    for (const url of [`/api/agents/${ENCODED_NAMESPACE}/unknown-resource`]) {
      const res = makeRes();
      await proxyToViewer(makeReq(url), res, { findConnection: FIND_CONNECTION });
      assert.equal(res.statusCode, 403);
      assert.equal(res.jsonPayload.ok, false);
      assert.equal(res.jsonPayload.code, 'operation_rejected');
      assert.equal(res.jsonPayload.retryable, false);
    }
    // HEAD is not part of the Phase 1 read surface either.
    const headRes = makeRes();
    await proxyToViewer(
      makeReq(`/api/agents/${ENCODED_NAMESPACE}/messages`, { method: 'HEAD' }),
      headRes,
      { findConnection: FIND_CONNECTION },
    );
    assert.equal(headRes.statusCode, 403);
    assert.equal(fetchMock.calls.length, 0);
  } finally {
    fetchMock.restore();
  }
});

test('maps remote routing failures onto the operation error contract', async () => {
  await assert.rejects(
    proxyToViewer(
      makeReq(`/api/agents/${encodeURIComponent('remote:server-b:agent-3')}/messages`),
      makeRes(),
      { findConnection: FIND_CONNECTION },
    ),
    (error) => error.code === 'transport_unavailable' && error.status === 503 && error.retryable === true,
    'disabled connection',
  );
  await assert.rejects(
    proxyToViewer(
      makeReq(`/api/agents/${encodeURIComponent('remote:ghost:agent-3')}/messages`),
      makeRes(),
      { findConnection: FIND_CONNECTION },
    ),
    (error) => error.code === 'target_not_found' && error.status === 404,
    'unknown connection',
  );
  await assert.rejects(
    proxyToViewer(makeReq(`/api/agents/${ENCODED_NAMESPACE}/messages`), makeRes()),
    (error) => error.code === 'target_not_found',
    'unwired lookup fails explicitly instead of falling back to local',
  );
});

test('reports remote transport failures through the failure contract', async () => {
  const fetchMock = mockFetch(() => {
    throw new Error('tunnel reset');
  });
  try {
    const res = makeRes();
    await proxyToViewer(
      makeReq(`/api/agents/${ENCODED_NAMESPACE}/messages`),
      res,
      { findConnection: FIND_CONNECTION },
    );
    assert.equal(res.statusCode, 503);
    assert.equal(res.jsonPayload.code, 'transport_unavailable');
    assert.equal(res.jsonPayload.retryable, true);
    assert.equal(res.jsonPayload.message, 'Remote connection transport is unavailable');
  } finally {
    fetchMock.restore();
  }
});

test('uses the injected module-level connection lookup as the default', async () => {
  setProxyConnectionLookup(FIND_CONNECTION);
  const fetchMock = mockFetch();
  try {
    const res = makeRes();
    await proxyToViewer(makeReq(`/api/agents/${ENCODED_NAMESPACE}/messages`), res);
    assert.equal(fetchMock.calls[0].url, `${REMOTE_ORIGIN}/api/agents/agent-3-22040/messages`);
  } finally {
    fetchMock.restore();
    setProxyConnectionLookup(null);
  }
});

test('keeps local reads and writes byte-identical when remote wiring is injected', async () => {
  const fetchMock = mockFetch();
  try {
    const options = { findConnection: FIND_CONNECTION };

    // Route-parameter addressing.
    const readRes = makeRes();
    await proxyToViewer(
      makeReq('/api/agents/agent-1/messages?sessionId=session-1', { params: { agentId: 'agent-1' } }),
      readRes,
      options,
    );
    assert.equal(fetchMock.calls[0].url, `${LOCAL_ORIGIN}/api/agents/agent-1/messages?sessionId=session-1`);

    // Query addressing resolves local scope and forwards the raw url.
    const templateRes = makeRes();
    await proxyToViewer(makeReq('/api/templates/feature?agentId=agent-1'), templateRes, options);
    assert.equal(fetchMock.calls[1].url, `${LOCAL_ORIGIN}/api/templates/feature?agentId=agent-1`);

    // Local template maps pass through unrewritten.
    const mapBody = JSON.stringify({ 'tool.render': '/tpl/0123456789ab/tpl/tool.render.js' });
    globalThis.fetch = async (url, init) => {
      fetchMock.calls.push({ url: String(url), init });
      return {
        status: 200,
        headers: new Headers({ 'content-type': 'application/json; charset=utf-8' }),
        arrayBuffer: async () => Buffer.from(mapBody),
      };
    };
    const localMapRes = makeRes();
    await proxyToViewer(makeReq('/api/templates/feature?agentId=agent-1'), localMapRes, options);
    assert.equal(localMapRes.body.toString('utf8'), mapBody);

    // Static assets without an agent param stay local.
    const assetRes = makeRes();
    await proxyToViewer(makeReq('/tpl/0123456789ab/tpl/tool.render.js'), assetRes, options);
    assert.equal(fetchMock.calls.at(-1).url, `${LOCAL_ORIGIN}/tpl/0123456789ab/tpl/tool.render.js`);

    // Local writes forward with body and metadata intact.
    const writeRes = makeRes();
    await proxyToViewer(
      makeReq('/api/agents/agent-1/input', {
        method: 'POST',
        body: '{"text":"hello"}',
        headers: { 'content-type': 'application/json', 'x-operation-id': 'op-local' },
      }),
      writeRes,
      options,
    );
    assert.equal(fetchMock.calls.at(-1).url, `${LOCAL_ORIGIN}/api/agents/agent-1/input`);
    assert.equal(fetchMock.calls.at(-1).init.method, 'POST');
    assert.equal(fetchMock.calls.at(-1).init.body.toString('utf8'), '{"text":"hello"}');
    assert.equal(fetchMock.calls.at(-1).init.headers.get('x-operation-id'), 'op-local');
  } finally {
    fetchMock.restore();
  }
});

test('conflicting agent query identities fail as invalid targets', async () => {
  await assert.rejects(
    proxyToViewer(
      makeReq(`/tpl/0123456789ab/t.js?agentId=${ENCODED_NAMESPACE}&agent=remote%3Aserver-a%3Aagent-4`),
      makeRes(),
      { findConnection: FIND_CONNECTION },
    ),
    (error) => error.code === 'invalid_target' && error.status === 400,
  );
});
