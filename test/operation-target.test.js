import assert from 'node:assert/strict';
import test from 'node:test';
import {
  OperationTargetError,
  resolveAgentTarget,
  resolveHostTarget,
  resolveRuntimeControlTarget,
  resolveRuntimeObservationTarget,
  resolveSessionTarget,
} from '../server/shared/operation-target.js';

test('Host targets stay local and do not use page focus as a target', () => {
  assert.deepEqual(resolveHostTarget({ focusedAgentId: 'focused-agent' }), {
    scope: 'local-host',
    agentId: null,
  });
  assert.deepEqual(resolveHostTarget({ agentId: 'explicit-agent', focusedAgentId: 'other-agent' }), {
    scope: 'local-host',
    agentId: 'explicit-agent',
  });
});

test('Agent targets require an explicit logical agent identity', () => {
  assert.deepEqual(resolveAgentTarget({ agentId: 'agent-a', focusedAgentId: 'other-agent' }), {
    scope: 'agent',
    agentId: 'agent-a',
  });
  assert.throws(() => resolveAgentTarget({ focusedAgentId: 'focused-agent' }), /agentId is required/);
});

test('Session targets require explicit agentId and sessionId', () => {
  assert.deepEqual(resolveSessionTarget({ agentId: 'agent-a', sessionId: 'session-a' }), {
    scope: 'session',
    agentId: 'agent-a',
    sessionId: 'session-a',
  });
  for (const input of [{}, { agentId: 'agent-a' }, { sessionId: 'session-a' }, { agentId: '  ', sessionId: 'session-a' }]) {
    assert.throws(() => resolveSessionTarget(input), (error) => {
      assert.ok(error instanceof OperationTargetError);
      assert.equal(error.code, 'invalid_target');
      assert.equal(error.status, 400);
      return true;
    });
  }
});

test('Runtime control targets require explicit runtime or session identity', () => {
  assert.deepEqual(resolveRuntimeControlTarget({ agentId: 'agent-a', runtimeId: 'runtime-a' }), {
    scope: 'runtime',
    agentId: 'agent-a',
    runtimeId: 'runtime-a',
    sessionId: null,
  });
  assert.deepEqual(resolveRuntimeControlTarget({ agentId: 'agent-a', sessionId: 'session-a' }), {
    scope: 'runtime',
    agentId: 'agent-a',
    runtimeId: null,
    sessionId: 'session-a',
  });
  assert.throws(() => resolveRuntimeControlTarget({ agentId: 'agent-a' }), /runtimeId or sessionId is required/);
});

test('Runtime observation targets require explicit session identity', () => {
  assert.deepEqual(resolveRuntimeObservationTarget({ agentId: 'agent-a', sessionId: 'session-a' }), {
    scope: 'runtime',
    agentId: 'agent-a',
    sessionId: 'session-a',
  });
  assert.throws(() => resolveRuntimeObservationTarget({ agentId: 'agent-a' }), /sessionId is required/);
});
