import assert from 'node:assert/strict';
import test from 'node:test';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

function createIdentitySandbox() {
  const context = createFrontendSandbox();
  context.loadSource('public/src/app-core.js');
  return context;
}

test('logical agent identity belongs to the host and never guesses a child parent', () => {
  const ctx = createIdentitySandbox();

  assert.equal(ctx.run('getLogicalAgentId({ id: "programming-helper", source: "prebuilt" })'), 'programming-helper');
  assert.equal(ctx.run('getLogicalAgentId({ id: "runtime-1", source: "child", parent_id: "programming-helper" })'), 'programming-helper');
  assert.equal(ctx.run('getLogicalAgentId({ id: "runtime-1", source: "child" })'), null);
  assert.equal(ctx.run('getParentAgentId({ id: "runtime-1", source: "child" })'), null);
});

test('runtime identity uses explicit runtime fields and treats a stopped host as having no runtime', () => {
  const ctx = createIdentitySandbox();

  assert.equal(ctx.run('getRuntimeId({ id: "runtime-1", source: "child", parent_id: "host" })'), 'runtime-1');
  assert.equal(ctx.run('getRuntimeId({ id: "host", source: "prebuilt" })'), null);
  assert.equal(ctx.run('getRuntimeId({ id: "host", source: "prebuilt", runtime_session_id: "runtime-2" })'), 'runtime-2');
  assert.equal(ctx.run('getRuntimeId({ id: "runtime-1", runtime_session_id: "runtime-2", runtimeSessionId: "runtime-3" })'), null);
});

test('active session identity requires consistent session fields and does not require a runtime', () => {
  const ctx = createIdentitySandbox();

  assert.equal(ctx.run('getActiveSessionId({ active_workspace_session_id: "session-a" })'), 'session-a');
  assert.equal(ctx.run('getActiveSessionId({ workspace_sessions: { activeSessionId: "session-b" } })'), 'session-b');
  assert.equal(ctx.run('getActiveSessionId({ sessionId: "session-a", active_workspace_session_id: "session-b" })'), null);
  assert.equal(ctx.run('getActiveSessionId({ id: "host", source: "prebuilt" })'), null);
});

test('local resource references expose only explicit local identities', () => {
  const ctx = createIdentitySandbox();

  assert.deepEqual(
    JSON.parse(JSON.stringify(ctx.run('buildLocalResourceRef({ id: "runtime-1", source: "child", parent_id: "host", active_workspace_session_id: "session-a" })'))),
    {
      scope: 'local',
      agentId: 'host',
      parentId: 'host',
      sessionId: 'session-a',
      runtimeId: 'runtime-1',
    },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(ctx.run('buildLocalResourceRef({ id: "host", source: "prebuilt" })'))),
    {
      scope: 'local',
      agentId: 'host',
      parentId: null,
      sessionId: null,
      runtimeId: null,
    },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(ctx.run('buildLocalResourceRef({ agentId: "host", runtimeId: "runtime-1", sessionId: "session-a", parentId: "wrong" })'))),
    {
      scope: 'local',
      agentId: 'host',
      parentId: 'wrong',
      sessionId: 'session-a',
      runtimeId: 'runtime-1',
    },
  );
});
