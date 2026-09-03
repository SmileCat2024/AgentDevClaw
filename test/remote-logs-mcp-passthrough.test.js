import assert from 'node:assert/strict';
import test from 'node:test';

import { proxyToViewer, setProxyConnectionLookup } from '../server/shared/proxy.js';

// R2-05 面板资源远程扩列：/api/logs 与 /api/mcp-info 加入远程读白名单。
// 两个端点都是 viewer 平面读端点（viewer-worker GET），query/无参寻址，无幂等闸。

const CONNECTIONS = [
  { id: 'server-a', name: 'Server A', enabled: true, mode: 'manual', localPort: 22101 },
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

test('forwards whitelisted /api/logs reads with the query namespace restored to a bare id', async () => {
  const fetchMock = mockFetch();
  try {
    const res = makeRes();
    await proxyToViewer(
      makeReq(`/api/logs?scope=current&agentId=${ENCODED_NAMESPACE}`),
      res,
      { findConnection: FIND_CONNECTION },
    );
    assert.equal(res.statusCode, 200);
    assert.equal(
      fetchMock.calls[0].url,
      `${REMOTE_ORIGIN}/api/logs?scope=current&agentId=agent-3-22040`,
      'namespaced agentId restored to the bare id on forward',
    );
    assert.equal(fetchMock.calls[0].init.method, 'GET');
    // 非寻址 query 参数原样保留（转发形状）。
    assert.ok(
      fetchMock.calls[0].url.includes('scope=current'),
      'non-addressing query params survive the rewrite',
    );
  } finally {
    fetchMock.restore();
  }
});

test('forwards whitelisted /api/mcp-info reads to the remote origin', async () => {
  const fetchMock = mockFetch();
  try {
    // 命名空间 query 形态：身份还原后转发。
    const res = makeRes();
    await proxyToViewer(
      makeReq(`/api/mcp-info?agentId=${ENCODED_NAMESPACE}`),
      res,
      { findConnection: FIND_CONNECTION },
    );
    assert.equal(res.statusCode, 200);
    assert.equal(
      fetchMock.calls[0].url,
      `${REMOTE_ORIGIN}/api/mcp-info?agentId=agent-3-22040`,
      'namespaced agentId restored on forward',
    );

    // 无参形态：resolveProxyTarget 为 null 走本地（viewer 全局端点），属预期。
    const localRes = makeRes();
    await proxyToViewer(makeReq('/api/mcp-info'), localRes, { findConnection: FIND_CONNECTION });
    assert.equal(localRes.statusCode, 200);
    assert.equal(fetchMock.calls[1].url, `${LOCAL_ORIGIN}/api/mcp-info`);

    // 白名单条目是 GET-only：写形态维持本地拒绝。
    const postRes = makeRes();
    await proxyToViewer(
      makeReq(`/api/mcp-info?agentId=${ENCODED_NAMESPACE}`, { method: 'POST' }),
      postRes,
      { findConnection: FIND_CONNECTION },
    );
    assert.equal(postRes.statusCode, 403);
    assert.equal(fetchMock.calls.length, 2, 'writes must never reach the remote');
  } finally {
    fetchMock.restore();
  }
});

test('logs filters ride along while the namespaced agentId is restored', async () => {
  const fetchMock = mockFetch();
  try {
    const res = makeRes();
    await proxyToViewer(
      makeReq(`/api/logs?scope=current&agentId=${ENCODED_NAMESPACE}&level=warn&limit=50`),
      res,
      { findConnection: FIND_CONNECTION },
    );
    assert.equal(
      fetchMock.calls[0].url,
      `${REMOTE_ORIGIN}/api/logs?scope=current&agentId=agent-3-22040&level=warn&limit=50`,
      'only agent-addressing values are rewritten; filters pass through',
    );
  } finally {
    fetchMock.restore();
  }
});

test('rejects remote reads outside the whitelist locally without forwarding', async () => {
  const fetchMock = mockFetch();
  try {
    // /api/agents/:id/<resource> 资源表外的读仍 403（R2-05 未扩资源表）。
    const res = makeRes();
    await proxyToViewer(
      makeReq(`/api/agents/${ENCODED_NAMESPACE}/unknown-resource`),
      res,
      { findConnection: FIND_CONNECTION },
    );
    assert.equal(res.statusCode, 403);
    assert.equal(res.jsonPayload.ok, false);
    assert.equal(res.jsonPayload.code, 'operation_rejected');
    assert.equal(res.jsonPayload.retryable, false);
    assert.equal(fetchMock.calls.length, 0, 'non-whitelisted reads must not be forwarded');
  } finally {
    fetchMock.restore();
  }
});

test('keeps the whitelisted viewer endpoints local for plain identities', async () => {
  const fetchMock = mockFetch();
  try {
    // 本地身份（无 remote: 命名空间）永不进入远程分支（ADR-0008 #1），
    // 白名单只由远程 scope 请求触发（isRemoteReadWhitelisted 前置 target 校验）。
    const options = { findConnection: FIND_CONNECTION };
    const logsRes = makeRes();
    await proxyToViewer(makeReq('/api/logs?scope=current&agentId=agent-1'), logsRes, options);
    assert.equal(fetchMock.calls[0].url, `${LOCAL_ORIGIN}/api/logs?scope=current&agentId=agent-1`);

    const mcpRes = makeRes();
    await proxyToViewer(makeReq('/api/mcp-info?agentId=agent-1'), mcpRes, options);
    assert.equal(fetchMock.calls[1].url, `${LOCAL_ORIGIN}/api/mcp-info?agentId=agent-1`);
  } finally {
    fetchMock.restore();
  }
});

test('module-level lookup wiring serves the whitelisted reads as the default', async () => {
  setProxyConnectionLookup(FIND_CONNECTION);
  const fetchMock = mockFetch();
  try {
    const res = makeRes();
    await proxyToViewer(makeReq(`/api/logs?agentId=${ENCODED_NAMESPACE}`), res);
    assert.equal(res.statusCode, 200);
    assert.equal(fetchMock.calls[0].url, `${REMOTE_ORIGIN}/api/logs?agentId=agent-3-22040`);
  } finally {
    fetchMock.restore();
    setProxyConnectionLookup(null);
  }
});
