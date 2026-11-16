import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntimeSwitch } from '../public/src/modules/runtime-switch.js';

function fixture(overrides = {}) {
  const timers = [];
  const calls = [];
  const state = { pendingSwitchTarget: null, pendingSwitchSerial: 0, navigationEpoch: 0,
    switchEpoch: 0, runtimeId: 'old', focusedAgentId: 'old', readOnlyMode: false,
    followLatest: false, restoredScrollTop: 120 };
  const host = {
    state, setTimeout: fn => { timers.push(fn); }, switchAgent: async id => calls.push(['switch', id]),
    hasPendingNavigation: () => true, bumpNavigationGuard: () => { state.navigationEpoch++; },
    closeContextMenu() {}, findAgent: () => null, isWorkspaceHost: () => false,
    runtimeId: agent => agent.id, agentRuntimeId: agent => agent.id, isRemote: () => false,
    remote: () => null, closeReadOnlySession() {}, isWorkspaceSurface: () => false,
    selectWorkspace: (...args) => calls.push(['workspace', ...args]),
    storeDraft() {}, saveWorkspaceScroll() {}, saveCache: id => calls.push(['save', id]),
    logicalId: agent => agent.id, normalize: id => String(id || '').trim(), clearFinished() {},
    deriveSession: id => `session-${id}`, bindSession: (...args) => calls.push(['bind', ...args]),
    updateThreadIndicators() {}, browseOnly: () => false, resetSurface() {}, resetScroll() {},
    resetStatus() {}, activateCollapse() {}, contextKey: id => id,
    restoreCache: () => true, setPendingScroll: top => calls.push(['scroll', top]),
    render: () => calls.push(['render', state.runtimeId]), renderPanel() {}, patch() {},
    emptyOverview: () => ({}), emptyTodo: () => ({}), setFollowLatest() {}, beginFollowWindows() {},
    renderAgents() {}, fetch: async () => ({ ok: false }), isCalling: () => false,
    applyCalling: (...args) => calls.push(['calling', ...args]), syncActionButton() {},
    warn: error => { throw error; }, error: (...args) => calls.push(['error', ...args]),
    persistFocus: id => calls.push(['persist', id]), loadData: async () => {},
    loadAgents: async () => calls.push(['loadAgents']), clearLoading: () => calls.push(['clearLoading']),
    alert: message => calls.push(['alert', message]), ...overrides,
  };
  return { ...createRuntimeSwitch(host), state, calls, timers };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('deferred switches coalesce to the newest request and preserve caller results', async () => {
  const f = fixture();
  const first = f.requestSwitch('a', 'launch');
  const second = f.requestSwitch('b', 'restart');
  f.timers.splice(0).forEach(fn => fn());
  assert.deepEqual(await first, { switched: false, reason: 'superseded' });
  assert.deepEqual(await second, { switched: true });
  assert.deepEqual(f.calls, [['switch', 'b']]);
});

test('navigation between request and flush rejects a deferred focus steal', async () => {
  const f = fixture();
  const pending = f.requestSwitch('a', 'launch');
  f.state.navigationEpoch++;
  f.timers[0]();
  assert.deepEqual(await pending, { switched: false, reason: 'nav-guard-stale' });
  assert.deepEqual(f.calls, []);
});

test('direct switching binds and renders synchronously, cancels pending work and preserves reading scroll', async () => {
  const data = deferred();
  const f = fixture({ loadData: () => data.promise });
  const pending = f.requestSwitch('superseded', 'launch');
  const switching = f.switchAgent('selected');
  assert.equal(f.state.runtimeId, 'selected');
  assert.deepEqual(f.calls.slice(0, 5), [['save', 'old'], ['bind', 'selected', 'session-selected'],
    ['scroll', 120], ['render', 'selected'], ['persist', 'selected']]);
  assert.equal(f.calls.some(c => c[0] === 'clearLoading'), false, 'loading remains until data lands');
  f.timers[0]();
  assert.deepEqual(await pending, { switched: false, reason: 'superseded' });
  data.resolve();
  await switching;
  assert.equal(f.calls.filter(c => c[0] === 'clearLoading').length, 1);
  assert.equal(f.calls.filter(c => c[0] === 'loadAgents').length, 1);
});

test('late completion of an older switch cannot refresh lists or clear a newer loading surface', async () => {
  const old = deferred();
  const f = fixture({ loadData: id => id === 'a' ? old.promise : Promise.resolve() });
  const a = f.switchAgent('a');
  await f.switchAgent('b');
  const afterB = f.calls.length;
  old.resolve();
  await a;
  assert.equal(f.state.runtimeId, 'b');
  assert.equal(f.calls.length, afterB);
  assert.equal(f.calls.filter(c => c[0] === 'clearLoading').length, 1);
});

test('late notification cannot change calling state after another runtime is selected', async () => {
  const notification = deferred();
  const f = fixture({ fetch: () => notification.promise });
  await f.switchAgent('a');
  f.state.runtimeId = 'b';
  notification.resolve({ ok: true, json: async () => ({ calling: true }) });
  await notification.promise;
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(f.calls.filter(c => c[0] === 'calling'), []);
});

test('notification prewarm updates calling state for the still-selected runtime', async () => {
  const f = fixture({ fetch: async () => ({ ok: true, json: async () => ({ calling: true }) }), isCalling: () => true });
  await f.switchAgent('a');
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(f.calls.filter(c => c[0] === 'calling'), [['calling', 'a', true]]);
});
