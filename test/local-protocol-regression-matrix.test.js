import assert from 'node:assert/strict';
import test from 'node:test';

import { createFrontendSandbox } from './helpers/frontend-vm.js';
import { proxyToViewer } from '../server/shared/proxy.js';
import {
  LOCAL_OPERATION_ERROR_CODES,
  buildLocalFailureResponse,
  readOperationMetadata,
} from '../server/shared/operation-contract.js';
import {
  resolveHostTarget,
  resolveRuntimeControlTarget,
  resolveSessionTarget,
} from '../server/shared/operation-target.js';
import { submitUserTurn } from '../server/shared/user-turn.js';

function response(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => body,
    arrayBuffer: async () => Buffer.from(JSON.stringify(body)),
    headers: new Headers({ 'content-type': 'application/json' }),
  };
}

function proxyRequest(runtimeId, sessionId, resource = 'messages') {
  return {
    originalUrl: `/api/agents/${encodeURIComponent(runtimeId)}/${resource}?sessionId=${encodeURIComponent(sessionId)}`,
    method: 'GET',
    headers: {},
    params: { agentId: runtimeId },
  };
}

test('runtime request matrix keeps two explicit runtime/session targets isolated', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return response({ ok: true });
  };

  const results = [];
  const makeRes = () => ({
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    setHeader() {},
    end(body) { this.body = body; },
  });
  try {
    results.push(await proxyToViewer(proxyRequest('runtime-a', 'session-a'), makeRes()));
    results.push(await proxyToViewer(proxyRequest('runtime-b', 'session-b'), makeRes()));

    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, 'http://127.0.0.1:2026/api/agents/runtime-a/messages?sessionId=session-a');
    assert.equal(calls[1].url, 'http://127.0.0.1:2026/api/agents/runtime-b/messages?sessionId=session-b');
    assert.notEqual(calls[0].url, calls[1].url);

    const runtimeResources = ['tools', 'hooks', 'overview', 'todo', 'input-requests', 'notification', 'running', 'connection', 'queued-inputs'];
    for (const resource of runtimeResources) {
      const target = proxyRequest('runtime-b', 'session-b', resource);
      const resourceRes = makeRes();
      await proxyToViewer(target, resourceRes);
      assert.equal(calls.at(-1).url, `http://127.0.0.1:2026/api/agents/runtime-b/${resource}?sessionId=session-b`);
    }
    assert.deepEqual(results, [undefined, undefined]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('runtime controls and session mutations reject page-focus and parent fallbacks', () => {
  assert.deepEqual(resolveRuntimeControlTarget({
    agentId: 'agent-a',
    runtimeId: 'runtime-a',
    sessionId: 'session-a',
    focusedAgentId: 'agent-b',
    parentId: 'agent-b',
  }), {
    scope: 'runtime',
    agentId: 'agent-a',
    runtimeId: 'runtime-a',
    sessionId: 'session-a',
  });
  assert.throws(() => resolveRuntimeControlTarget({
    agentId: 'agent-a',
    parentId: 'agent-b',
    focusedAgentId: 'agent-b',
  }), /runtimeId or sessionId is required/);
  assert.throws(() => resolveSessionTarget({
    sessionId: 'session-a',
    focusedAgentId: 'agent-a',
  }), /agentId is required/);
});

test('host operations remain local when page focus changes', () => {
  assert.deepEqual(resolveHostTarget({ focusedAgentId: 'agent-a' }), {
    scope: 'local-host',
    agentId: null,
  });
  assert.deepEqual(resolveHostTarget({ focusedAgentId: 'agent-b', agentId: 'agent-a' }), {
    scope: 'local-host',
    agentId: 'agent-a',
  });
});

test('template loading addresses the explicit runtime rather than page focus', async () => {
  const requests = [];
  const ctx = createFrontendSandbox({
    fetch: async (url) => {
      requests.push(String(url));
      return { ok: true, json: async () => ({ read: '/tpl/mount/read.js' }) };
    },
  });
  ctx.loadSource('public/src/app-core.js');
  ctx.run('currentRuntimeAgentId = "runtime-a"; focusedAgentId = "agent-b"');

  assert.equal(await ctx.run('loadFeatureTemplateMap()'), true);
  assert.deepEqual(requests, ['/api/templates/feature?agentId=runtime-a']);
});

test('user-turn delivery keeps explicit target and operation metadata on the local result', async () => {
  const calls = [];
  const result = await submitUserTurn({
    agentId: 'runtime-b',
    text: 'hello',
    source: 'ui',
    sourceRef: 'event-2',
    operationId: 'op-2',
    requestId: 'request-2',
    idempotencyKey: 'write-2',
  }, {
    viewerOrigin: 'http://viewer.test',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return response({ success: true, delivery: 'queued', id: 'queued-2' });
    },
  });

  assert.equal(calls[0].url, 'http://viewer.test/api/agents/runtime-b/user-turn');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    text: 'hello',
    source: 'ui',
    sourceRef: 'event-2',
  });
  assert.equal(result.operationId, 'op-2');
  assert.equal(result.requestId, 'request-2');
  assert.equal(result.idempotencyKey, 'write-2');
});

test('local errors distinguish target, readiness, transport, timeout, rejection, and unknown result', () => {
  const cases = [
    [{ status: 400, code: 'invalid_target' }, 'invalid_target', false],
    [{ status: 404, code: 'agent_not_found' }, 'target_not_found', false],
    [{ status: 503, code: 'runtime_not_accepting_input' }, 'runtime_not_ready', true],
    [{ status: 503, transport: true }, 'transport_unavailable', true],
    [{ status: 408 }, 'request_timeout', true],
    [{ status: 409, code: 'input_mode_conflict' }, 'operation_rejected', false],
    [{ status: 502, resultUnknown: true }, 'operation_result_unknown', false],
  ];

  for (const [error, code, retryable] of cases) {
    const result = buildLocalFailureResponse(error, {
      operationId: 'op-matrix',
      requestId: 'request-matrix',
      sourceRef: 'source-matrix',
      idempotencyKey: 'write-matrix',
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, code);
    assert.equal(result.retryable, retryable);
    assert.equal(result.operationId, 'op-matrix');
    assert.equal(result.requestId, 'request-matrix');
    assert.equal(result.sourceRef, 'source-matrix');
    assert.equal(result.idempotencyKey, 'write-matrix');
    assert.equal(result.error, result.message);
  }

  assert.deepEqual(Object.values(LOCAL_OPERATION_ERROR_CODES).sort(), [
    'invalid_target',
    'operation_rejected',
    'operation_result_unknown',
    'request_timeout',
    'runtime_not_ready',
    'target_not_found',
    'transport_unavailable',
  ]);
});

test('operation metadata accepts body/query/header sources without importing UI focus', () => {
  assert.deepEqual(readOperationMetadata({
    body: { operationId: 'body-op', sourceRef: 'body-source' },
    query: { requestId: 'query-request' },
    headers: { 'x-idempotency-key': 'header-write', 'x-trace-id': 'header-trace' },
    focusedAgentId: 'ignored-focus',
  }), {
    operationId: 'body-op',
    requestId: 'query-request',
    sourceRef: 'body-source',
    idempotencyKey: 'header-write',
    traceId: 'header-trace',
  });
});
