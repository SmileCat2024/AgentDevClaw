import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RequestTargetError,
  resolveProxyTarget,
  resolveRuntimeTarget,
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
