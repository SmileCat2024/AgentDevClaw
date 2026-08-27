import assert from 'node:assert/strict';
import test from 'node:test';
import {
  REMOTE_NAMESPACE_PREFIX,
  RequestTargetError,
  resolveHostTarget,
  resolveProxyTarget,
  resolveRuntimeTarget,
  rewriteProxyUrl,
} from '../server/shared/request-target.js';

function assertInvalidTarget(input, message) {
  assert.throws(
    () => resolveRuntimeTarget(input),
    (error) => {
      assert.ok(error instanceof RequestTargetError, message);
      assert.equal(error.code, 'invalid_target', message);
      assert.equal(error.status, 400, message);
      assert.equal(error.retryable, false, message);
      return true;
    },
  );
}

function assertTargetError(run, expected, message) {
  assert.throws(
    () => run(),
    (error) => {
      assert.ok(error instanceof RequestTargetError, message);
      assert.equal(error.code, expected.code, message);
      assert.equal(error.status, expected.status, message);
      assert.equal(error.retryable, expected.retryable, message);
      return true;
    },
  );
}

// In-memory stand-in for the connection table: injected, no I/O.
const CONNECTIONS = [
  { id: 'server-a', name: 'Server A', enabled: true, mode: 'manual', localPort: 22101, ssh: null, remote: { appPort: 1420 } },
  { id: 'server-b', name: 'Server B', enabled: false, mode: 'managed', localPort: 22102, ssh: { host: 'b.example' }, remote: { appPort: 1420 } },
  { id: 'server-c', name: 'Server C', enabled: true, mode: 'manual', localPort: 22103, ssh: null, remote: { appPort: 1420 } },
];

function createFindConnection() {
  const byId = new Map(CONNECTIONS.map((connection) => [connection.id, connection]));
  return (connectionId) => byId.get(connectionId) || null;
}

test('leaves collection Viewer requests without a runtime target', () => {
  assert.equal(resolveProxyTarget({ originalUrl: '/api/agents' }), null);
});

test('rejects conflicting route and parameter identities', () => {
  assertInvalidTarget({ agentId: 'agent-a', agent_id: 'agent-b' }, 'conflicting aliases');
  assert.throws(
    () => resolveProxyTarget({
      originalUrl: '/api/agents/agent-a/input',
      params: { agentId: 'agent-b' },
    }),
    (error) => error.code === 'invalid_target',
  );
});

test('resolves an explicit local runtime target without consulting UI state', () => {
  assert.deepEqual(
    resolveRuntimeTarget({ agentId: 'agent/a', sessionId: 'session-1', runtimeId: 'runtime-1' }, {
      viewerOrigin: 'http://viewer.test',
    }),
    {
      scope: 'local',
      agentId: 'agent/a',
      sessionId: 'session-1',
      runtimeId: 'runtime-1',
      viewerOrigin: 'http://viewer.test',
    },
  );
});

test('decodes explicitly encoded identities and rejects malformed encoding', () => {
  assert.equal(resolveRuntimeTarget({ agentId: 'agent%2Fa' }).agentId, 'agent/a');
  assertInvalidTarget({ agentId: 'agent%2' }, 'malformed percent escape');
  assertInvalidTarget({ agentId: '%E0%A4%A' }, 'malformed UTF-8 escape');
});

test('rejects missing, empty, conflicting, and fallback-only targets', () => {
  assertInvalidTarget({}, 'missing agent id');
  assertInvalidTarget({ agentId: '' }, 'empty agent id');
  assertInvalidTarget({ agentId: 'a', agent_id: 'b' }, 'conflicting aliases');
  assertInvalidTarget({ runtimeId: 'runtime-1' }, 'runtime id cannot replace required agent id');
  assertInvalidTarget({ parentId: 'host' }, 'parent id cannot select a target');
});

test('resolves percent-encoded and bare remote namespaces against the injected connection table', () => {
  const options = { findConnection: createFindConnection() };
  const expected = {
    scope: 'remote',
    connectionId: 'server-a',
    agentId: 'agent-3-22040',
    sessionId: null,
    runtimeId: null,
    origin: 'http://127.0.0.1:22101',
  };
  assert.deepEqual(
    resolveRuntimeTarget({ agentId: 'remote%3Aserver-a%3Aagent-3-22040' }, options),
    expected,
    'percent-encoded namespace',
  );
  assert.deepEqual(
    resolveRuntimeTarget({ agentId: 'remote:server-a:agent-3-22040' }, options),
    expected,
    'bare-colon namespace',
  );
  assert.deepEqual(
    resolveRuntimeTarget({ agentId: 'remote:server-a:agent-3', sessionId: 'session-9', runtimeId: 'runtime-2' }, options),
    { ...expected, agentId: 'agent-3', sessionId: 'session-9', runtimeId: 'runtime-2' },
    'session and runtime identities pass through un-namespaced',
  );
});

test('accepts a store-like connection lookup exposing getConnection', () => {
  const findConnection = {
    getConnection(id) {
      return id === 'server-a' ? { id, enabled: true, localPort: 22101 } : null;
    },
  };
  const target = resolveRuntimeTarget({ agentId: 'remote:server-a:agent-1' }, { findConnection });
  assert.equal(target.scope, 'remote');
  assert.equal(target.connectionId, 'server-a');
  assert.equal(target.origin, 'http://127.0.0.1:22101');
});

test('maps remote routing failures onto the operation error contract', () => {
  const options = { findConnection: createFindConnection() };
  assertTargetError(
    () => resolveRuntimeTarget({ agentId: 'remote:ghost:agent-1' }, options),
    { code: 'target_not_found', status: 404, retryable: false },
    'unknown connection id',
  );
  assertTargetError(
    () => resolveRuntimeTarget({ agentId: 'remote:server-b:agent-1' }, options),
    { code: 'transport_unavailable', status: 503, retryable: true },
    'disabled connection',
  );
  assertTargetError(
    () => resolveRuntimeTarget({ agentId: 'remote:server-a:agent-1' }),
    { code: 'target_not_found', status: 404, retryable: false },
    'unwired lookup fails explicitly instead of falling back to local',
  );
});

test('rejects malformed remote namespaces as invalid targets', () => {
  const options = { findConnection: createFindConnection() };
  for (const agentId of ['remote:server-a', 'remote:server-a:', 'remote::agent-1', 'remote:']) {
    assertTargetError(
      () => resolveRuntimeTarget({ agentId }, options),
      { code: 'invalid_target', status: 400, retryable: false },
      `namespace ${agentId} must be rejected`,
    );
  }
});

test('resolves remote namespaces from the proxied agent route', () => {
  const target = resolveProxyTarget(
    { originalUrl: '/api/agents/remote%3Aserver-a%3Aagent-3-22040/messages?limit=10' },
    { findConnection: createFindConnection() },
  );
  assert.deepEqual(target, {
    scope: 'remote',
    connectionId: 'server-a',
    agentId: 'agent-3-22040',
    sessionId: null,
    runtimeId: null,
    origin: 'http://127.0.0.1:22101',
  });
});

test('accepts equivalent namespace encodings across route and parameter', () => {
  const target = resolveProxyTarget({
    originalUrl: '/api/agents/remote%3Aserver-a%3Aagent-3/input',
    params: { agentId: 'remote:server-a:agent-3' },
  }, { findConnection: createFindConnection() });
  assert.equal(target.scope, 'remote');
  assert.equal(target.agentId, 'agent-3');
});

test('rejects proxy identities that disagree about the destination', () => {
  const options = { findConnection: createFindConnection() };
  assertTargetError(
    () => resolveProxyTarget({
      originalUrl: '/api/agents/remote:server-a:agent-3/input',
      params: { agentId: 'remote:server-c:agent-3' },
    }, options),
    { code: 'invalid_target', status: 400, retryable: false },
    'conflicting connection namespaces',
  );
  assertTargetError(
    () => resolveProxyTarget({
      originalUrl: '/api/agents/remote:server-a:agent-3/input',
      params: { agentId: 'agent-3' },
    }, options),
    { code: 'invalid_target', status: 400, retryable: false },
    'remote route cannot be downgraded to a local parameter identity',
  );
});

test('keeps local targets byte-identical when remote wiring is injected', () => {
  const options = { viewerOrigin: 'http://viewer.test', findConnection: createFindConnection() };
  assert.deepEqual(
    resolveRuntimeTarget({ agentId: 'agent-1', sessionId: 'session-1' }, options),
    {
      scope: 'local',
      agentId: 'agent-1',
      sessionId: 'session-1',
      runtimeId: null,
      viewerOrigin: 'http://viewer.test',
    },
  );
  assert.equal(resolveProxyTarget({ originalUrl: '/api/agents' }, options), null);
});

const REMOTE_TARGET = {
  scope: 'remote',
  connectionId: 'server-a',
  agentId: 'agent-3-22040',
  sessionId: null,
  runtimeId: null,
  origin: 'http://127.0.0.1:22101',
};

test('rewrites namespace identities in path and query back to plain ids', () => {
  assert.equal(
    rewriteProxyUrl(
      '/api/agents/remote%3Aserver-a%3Aagent-3-22040/messages?agentId=remote%3Aserver-a%3Aagent-3-22040&limit=5',
      REMOTE_TARGET,
    ),
    '/api/agents/agent-3-22040/messages?agentId=agent-3-22040&limit=5',
  );
  assert.equal(
    rewriteProxyUrl(
      '/api/agents/remote:server-a:agent-3-22040/messages?agent=remote:server-a:agent-3-22040',
      REMOTE_TARGET,
    ),
    '/api/agents/agent-3-22040/messages?agent=agent-3-22040',
  );
});

test('round-trips a frontend-namespaced url to the direct remote form', () => {
  const directUrl = '/api/agents/agent-3-22040/messages?agentId=agent-3-22040&since=1';
  const encoded = encodeURIComponent(`${REMOTE_NAMESPACE_PREFIX}server-a:agent-3-22040`);
  const proxiedUrl = `/api/agents/${encoded}/messages?agentId=${encoded}&since=1`;
  assert.equal(rewriteProxyUrl(proxiedUrl, REMOTE_TARGET), directUrl);
});

test('only rewrites addressing parameters, leaving other values intact', () => {
  const namespace = `${REMOTE_NAMESPACE_PREFIX}server-a:agent-3-22040`;
  const url = `/api/search?q=${encodeURIComponent(namespace)}`;
  assert.equal(rewriteProxyUrl(url, REMOTE_TARGET), url);
});

test('percent-encodes restored ids that contain reserved characters', () => {
  const target = { scope: 'remote', connectionId: 'server-a', agentId: 'agent/a' };
  assert.equal(
    rewriteProxyUrl('/api/agents/remote%3Aserver-a%3Aagent%2Fa/input?agentId=remote%3Aserver-a%3Aagent%2Fa', target),
    '/api/agents/agent%2Fa/input?agentId=agent%2Fa',
  );
});

test('leaves urls untouched for local and missing targets', () => {
  const url = '/api/agents/agent-1/messages?agentId=agent-1';
  assert.equal(rewriteProxyUrl(url, { scope: 'local', agentId: 'agent-1' }), url);
  assert.equal(rewriteProxyUrl(url, null), url);
});

test('keeps host targets local unless a connection is named explicitly', () => {
  assert.deepEqual(resolveHostTarget({}), { scope: 'local' });
  assert.deepEqual(resolveHostTarget({ connectionId: null }), { scope: 'local' });
  assert.deepEqual(
    resolveHostTarget({ connectionId: 'server-a' }, { findConnection: createFindConnection() }),
    { scope: 'remote', connectionId: 'server-a', origin: 'http://127.0.0.1:22101' },
  );
});

test('maps host connection failures onto the same error contract', () => {
  const options = { findConnection: createFindConnection() };
  assertTargetError(
    () => resolveHostTarget({ connectionId: 'ghost' }, options),
    { code: 'target_not_found', status: 404, retryable: false },
    'unknown host connection',
  );
  assertTargetError(
    () => resolveHostTarget({ connectionId: 'server-b' }, options),
    { code: 'transport_unavailable', status: 503, retryable: true },
    'disabled host connection',
  );
  assertTargetError(
    () => resolveHostTarget({ connectionId: '' }),
    { code: 'invalid_target', status: 400, retryable: false },
    'empty connection id',
  );
  assertTargetError(
    () => resolveHostTarget({ connectionId: 42 }),
    { code: 'invalid_target', status: 400, retryable: false },
    'non-string connection id',
  );
});
