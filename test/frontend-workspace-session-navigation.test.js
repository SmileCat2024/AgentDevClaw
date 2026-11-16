import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkspaceSessionNavigation } from '../public/src/modules/workspace-session-navigation.js';

function fixture(overrides = {}) {
  const state = { epoch: 0, focus: 'old', runtime: 'old-runtime', readonly: false };
  const calls = [];
  const host = {
    bumpNavigationGuard: () => { state.epoch++; }, navigationEpoch: () => state.epoch,
    focusedAgentId: () => state.focus, runtimeId: () => state.runtime, readOnlyMode: () => state.readonly,
    runAction: async raw => calls.push(['action', JSON.parse(raw)]),
    findWorkspace: id => ({ id, source: 'prebuilt' }), saveWorkspaceScroll: () => calls.push(['scroll']),
    saveCache: (...args) => calls.push(['cache', ...args]), contextKey: id => `context:${id}`,
    selectLoading: id => { state.focus = id; state.runtime = null; calls.push(['loading', id]); },
    loadDetail: async id => calls.push(['detail', id]),
    preferHome: agent => calls.push(['home', agent.id]), render: () => calls.push(['render']),
    ...overrides,
  };
  return { ...createWorkspaceSessionNavigation(host), state, calls };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('cross-workspace action waits for detail but publishes loading and saves the outgoing view synchronously', async () => {
  const detail = deferred();
  const f = fixture({ loadDetail: () => detail.promise });
  const nav = f.navigateToWorkspaceSession('next', 'session');
  assert.deepEqual(f.calls, [['scroll'], ['cache', 'old-runtime', 'context:old-runtime'], ['loading', 'next']]);
  assert.equal(f.state.focus, 'next');
  assert.equal(f.state.runtime, null);
  detail.resolve();
  await nav;
  assert.deepEqual(f.calls.at(-1), ['action', { type: 'open_session', sessionId: 'session' }]);
  assert.equal(f.calls.some(c => c[0] === 'home'), false, 'no intermediate home surface');
});

test('later navigation prevents stale detail completion from dispatching an action', async () => {
  const detail = deferred();
  const f = fixture({ loadDetail: () => detail.promise });
  const nav = f.navigateToWorkspaceSession('next', 'session');
  f.state.epoch++;
  detail.resolve();
  await nav;
  assert.equal(f.calls.some(c => c[0] === 'action'), false);
  assert.equal(f.calls.some(c => c[0] === 'home'), false);
});

test('same workspace directly dispatches the override without cache or detail requests', async () => {
  const f = fixture();
  const action = { type: 'view_session_record', sessionId: 'archived', readonly: true };
  await f.navigateToWorkspaceSession('old', 'ignored', { actionOverride: action });
  assert.deepEqual(f.calls, [['action', action]]);
});

test('workspace-only navigation renders home after detail and never dispatches an action', async () => {
  const f = fixture();
  f.state.readonly = true;
  await f.navigateToWorkspaceSession('next', '');
  assert.deepEqual(f.calls, [['scroll'], ['loading', 'next'], ['detail', 'next'], ['home', 'next'], ['render']]);
});

test('unknown workspace is inert and detail failure remains visible to the caller', async () => {
  const missing = fixture({ findWorkspace: () => null });
  await missing.navigateToWorkspaceSession('unknown', 'session');
  assert.deepEqual(missing.calls, []);
  const broken = fixture({ loadDetail: async () => { throw new Error('detail failed'); } });
  await assert.rejects(broken.navigateToWorkspaceSession('next', 'session'), /detail failed/);
  assert.equal(broken.calls.some(c => c[0] === 'action' || c[0] === 'home'), false);
});
