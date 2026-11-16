import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkspaceEntry, createWorkspaceSessionRequest } from '../public/src/modules/workspace-entry.js';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(overrides = {}) {
  const calls = [];
  const pending = new Set();
  const state = { epoch: 0 };
  const host = {
    bumpNavigationGuard: () => { state.epoch++; }, closeContextMenu() {},
    findWorkspace: id => ({ id }), isWorkspaceHost: () => false, isWorkspaceSurface: () => false,
    preferHome: agent => calls.push(['home', agent.id]), focus: id => calls.push(['focus', id]),
    renderAgents() {}, hasDetail: () => false, showLoading: () => calls.push(['loading']),
    loadDetail: async id => calls.push(['detail', id]), markDetailLoaded: id => calls.push(['loaded', id]),
    persistEntry: id => calls.push(['persist', id]), selectWorkspace: (...args) => calls.push(['surface', ...args]),
    switchAgent: async id => calls.push(['switch', id]), isPending: id => pending.has(id),
    markPending: id => pending.add(id), clearPending: id => pending.delete(id),
    navigationEpoch: () => state.epoch, startAgent: async id => calls.push(['start', id]),
    waitRuntime: async id => ({ id: `runtime-${id}` }), requestSwitch: async (...args) => calls.push(['requestSwitch', ...args]),
    error() {}, showStartError: error => calls.push(['error', error.message]), ...overrides,
  };
  return { ...createWorkspaceEntry(host), calls, pending, state };
}

test('workspace host publishes loading then opens home without launching a runtime', async () => {
  const detail = deferred();
  const f = fixture({ isWorkspaceHost: () => true, loadDetail: () => detail.promise });
  const click = f.handlePrebuiltAgentClick('memo');
  assert.deepEqual(f.calls, [['focus', 'memo'], ['loading']]);
  detail.resolve();
  await click;
  assert.deepEqual(f.calls.slice(2), [['loaded', 'memo'], ['persist', 'memo'], ['surface', 'memo', { skipFeaturePanel: true }]]);
});

test('existing plain runtime switches without starting another instance', async () => {
  const f = fixture({ findWorkspace: id => ({ id, runtime_session_id: 'live' }) });
  await f.handlePrebuiltAgentClick('plain');
  assert.deepEqual(f.calls, [['home', 'plain'], ['switch', 'live']]);
});

test('launch remains deduplicated and cannot steal focus after another navigation', async () => {
  const start = deferred();
  const f = fixture({ startAgent: id => { f.calls.push(['start', id]); return start.promise; } });
  const first = f.handlePrebuiltAgentClick('plain');
  await f.handlePrebuiltAgentClick('plain');
  assert.equal(f.calls.filter(c => c[0] === 'start').length, 1);
  f.state.epoch++;
  start.resolve();
  await first;
  assert.equal(f.pending.size, 0);
  assert.equal(f.calls.some(c => c[0] === 'requestSwitch'), false);
});

test('launch failure clears pending so a later attempt can succeed', async () => {
  let fail = true;
  const f = fixture({ startAgent: async () => { if (fail) throw new Error('launch failed'); } });
  await f.handlePrebuiltAgentClick('plain');
  assert.equal(f.pending.size, 0);
  assert.deepEqual(f.calls.at(-1), ['error', 'launch failed']);
  fail = false;
  await f.handlePrebuiltAgentClick('plain');
  assert.deepEqual(f.calls.at(-1), ['requestSwitch', 'runtime-plain', 'prebuilt-start']);
});

test('session create preserves project, runtime and studio metadata; activation carries only its own fields', async () => {
  const requests = [];
  const api = createWorkspaceSessionRequest({ fetch: async (url, options) => {
    requests.push({ url, method: options.method, body: JSON.parse(options.body) });
    return { ok: true, json: async () => ({ session: { id: 'created' } }) };
  } });
  const result = await api.openPrebuiltWorkspaceSession('host', { type: 'create_session_from_session',
    sessionId: 'source', projectId: ' project ', runtimeMode: ' local ', workspaceAgentId: 'assistant',
    studioFeatureIds: ['feature'], operationId: 'op', openDirectory: 'D:/work' });
  assert.equal(result.session.id, 'created');
  assert.deepEqual(requests[0], { url: '/protoclaw/prebuilt_sessions', method: 'POST', body: {
    agentId: 'host', sourceSessionId: 'source', workspaceAgentId: 'assistant', featureName: '', agentName: '',
    projectName: '', openDirectory: 'D:/work', projectId: 'project', runtimeMode: 'local', studioFeatureIds: ['feature'],
    targetDir: '', operationId: 'op', responseMode: 'delta',
  } });
  await api.openPrebuiltWorkspaceSession('host', { type: 'open_session', sessionId: 'existing', projectId: 'ignored' });
  assert.deepEqual(requests[1], { url: '/protoclaw/prebuilt_sessions/activate', method: 'POST',
    body: { agentId: 'host', sessionId: 'existing', operationId: '', responseMode: 'delta' } });
});
