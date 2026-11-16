import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkspaceSurface } from '../public/src/modules/workspace-surface.js';

function fixture(overrides = {}) {
  const calls = [];
  const state = { runtime: 'old-runtime', focus: 'old', tab: 'chat' };
  const agent = { id: 'next' };
  const host = {
    bumpNavigationGuard: () => calls.push(['guard']), closeReadOnlySession: () => calls.push(['closeReadonly']),
    hasDetail: () => true, loadDetail: async () => {}, findAgent: () => agent, currentAgent: () => agent,
    preferenceKey: item => item.id, tabs: () => [{ id: 'home' }, { id: 'chat' }, { id: 'notes' }],
    surfacePreference: () => 'notes', defaultMode: () => 'chat', ui: () => ({ entry: 'home' }),
    focusedAgentId: () => state.focus, runtimeId: () => state.runtime, contextKey: id => `ctx:${id}`,
    saveScroll: () => calls.push(['scroll']), readOnlyMode: () => false,
    saveCache: (...args) => calls.push(['cache', ...args]),
    bindWorkspace: (id, tab) => { state.focus = id; state.runtime = null; state.tab = tab; calls.push(['bind', id, tab]); },
    setFollowLatest: value => calls.push(['follow', value]), resetRuntimeState: () => calls.push(['reset']),
    beginPending: (...args) => calls.push(['pending', ...args]), setTab: tab => { state.tab = tab; },
    beginLoading: () => calls.push(['loading']), clearPending: () => calls.push(['clearPending']),
    renderAgents: () => calls.push(['agents']), render: () => calls.push(['render', state.tab]),
    renderPanel: () => calls.push(['panel']), refreshPanels: item => calls.push(['refresh', item.id]),
    ...overrides,
  };
  return { ...createWorkspaceSurface(host), state, calls };
}

test('returning home preserves outgoing cache and selects an available non-chat preference synchronously', () => {
  const f = fixture();
  assert.equal(f.selectWorkspaceSurface('next'), undefined, 'navigation remains synchronous');
  assert.deepEqual(f.state, { runtime: null, focus: 'next', tab: 'notes' });
  assert.deepEqual(f.calls.slice(0, 5), [['guard'], ['closeReadonly'], ['scroll'],
    ['cache', 'old-runtime', 'ctx:old-runtime'], ['bind', 'next', 'notes']]);
  assert.deepEqual(f.calls.slice(-4), [['agents'], ['render', 'notes'], ['panel'], ['refresh', 'next']]);
});

test('waiting-session navigation binds chat intent before rendering and honors skipFeaturePanel', () => {
  const f = fixture();
  f.selectWorkspaceSurface('next', { awaitSession: 'successor', skipFeaturePanel: true });
  assert.equal(f.state.tab, 'chat');
  assert.deepEqual(f.calls.filter(c => ['pending', 'loading', 'render', 'panel', 'clearPending'].includes(c[0])),
    [['pending', 'next', 'successor', 'committing'], ['loading'], ['render', 'chat']]);
});

test('missing preferred tab falls back to first non-chat tab and read-only views are not cached', () => {
  const f = fixture({ surfacePreference: () => 'removed', readOnlyMode: () => true });
  f.selectWorkspaceSurface('next');
  assert.equal(f.state.tab, 'home');
  assert.equal(f.calls.some(c => c[0] === 'cache'), false);
});
