import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

function harness(agentId = 'coder') {
  const ctx = createFrontendSandbox({
    setTimeout: () => 0,
    setInterval: () => 0,
    t: (key) => key,
    normalizeAgentIdentity: (value) => String(value || '').trim(),
    toEpochMs: (value) => Date.parse(value || '') || 0,
    pendingPrebuiltAgentIds: new Set(),
    restartingRuntimeIds: new Set(),
    _recentlyFinishedRuntimes: new Set(),
    _agentCallActive: new Map(),
    getAgentRuntimeId: (agent) => agent.runtime_session_id || '',
    getParentAgentId: (agent) => agent.parent_id,
    getActiveSessionId: (agent) => agent.active_workspace_session_id,
    isRuntimeItemActive: () => false,
    updateCurrentAgentChrome() {},
    groupConnectedAgents: () => ({ external: [] }),
    agentList: { addEventListener() {} },
    externalAgentList: {}, externalGroup: { style: {} }, externalCount: {},
    renderCurrentMainView() {},
    CSS: { escape: (value) => value },
    lastRenderedWorkspaceHtml: '',
  });
  ctx.window.setInterval = () => 0;
  ctx.loadSource('public/src/modules/project-data.js');
  ctx.loadSource('public/src/modules/session-ui.js');
  ctx.loadSource('public/src/modules/sidebar-operations.js');
  ctx.loadSource('public/src/modules/runtime-status.js');
  ctx.loadSource('public/src/modules/thread-store.js');
  ctx.loadSource('public/src/modules/sidebar-render.js');
  ctx.loadSource('public/src/modules/ctx-menu-items.js');
  const host = {
    id: agentId, source: 'prebuilt',
    workspace_sessions: { revision: 1, sessions: [{ id: 's1', title: 'Old' }] },
  };
  const child = {
    id: 'r1', runtime_session_id: 'r1', source: 'child', parent_id: agentId,
    active_workspace_session_id: 's1', active_workspace_session_title: 'Old', connected: true,
  };
  ctx.allAgents = [host, child];
  let html = '';
  let renders = 0;
  ctx.window.ClawSidebarLayout = {
    isInteracting: () => false,
    signature: () => 'fixture',
    render() {
      renders += 1;
      html = ctx.run('renderSidebarChildItems(collectRuntimeEntriesForPrebuilt(allAgents[0], allAgents), allAgents[0].id)');
    },
  };
  const handlers = new Map();
  ctx.window.ClawFW = { SseClient: { subscribeThreadEvents(ids, handler) {
    const keys = Array.isArray(ids) ? ids : [ids];
    keys.forEach((id) => handlers.set(id, handler));
    return () => keys.forEach((id) => handlers.delete(id));
  } } };
  let threads = [];
  ctx.fetch = async () => ({ ok: true, json: async () => ({ threads }) });
  return {
    ctx, host, child, handlers,
    get html() { return html; },
    get renders() { return renders; },
    async threads(value) { threads = value; host.sidebar_threads = structuredClone(value); await ctx.window.refreshThreads(true); },
    setThreads(value) { threads = value; host.sidebar_threads = structuredClone(value); },
  };
}

function thread(patch = {}) {
  return {
    agentId: 'coder', threadId: 't1', headSessionId: 's1', sessionIds: ['s1'],
    title: 'Thread', headSessionTitle: 'Old', status: 'open', lifeState: 'executing',
    headRuntimeRunning: true, ...patch,
  };
}

function delta(title = 'New', revision = 2) {
  return { ok: true, sessionDelta: { revision, upsert: [{ id: 's1', title }] } };
}

test('a failed authoritative read preserves the entire sidebar frame despite conflicting Viewer data', async () => {
  const h = harness('programming-helper');
  Object.assign(h.ctx, { loadAgentsInFlight: null, performance: { now: () => 0 }, ensurePhProjectEntitiesLoaded: async () => {} });
  h.ctx.window.ClawSidebarLayout.load = async () => {};
  const failed = [];
  Object.defineProperty(failed, '__sidebarDiagnostic', { value: { errorCode: 'connected-agents-http-409' } });
  h.ctx.invoke = async () => failed;
  h.ctx.fetch = async () => ({ ok: true, json: async () => ({ agents: [{ id: 'r1', connected: false }] }) });
  const before = h.ctx.allAgents;
  await h.ctx.run('loadAgents()');
  assert.equal(h.ctx.allAgents, before);
  assert.equal(h.ctx.allAgents[1].connected, true);
});

test('post-close refresh rejects an old in-flight poll and fetches a post-commit snapshot', async () => {
  const h = harness('programming-helper');
  h.ctx.window.setTimeout = () => 0;
  h.ctx.getRuntimeId = agent => agent.runtime_session_id || '';
  h.ctx.performance = { now: () => 0 };
  h.ctx.suppressSidebarRerender = false;
  h.ctx.loadAgentsInFlight = null;
  h.ctx.loadedAgentDetailIds = new Set();
  h.ctx.loadSource('public/src/modules/external-runtime.js');
  h.ctx.window.ClawSidebarLayout.load = async () => {};
  h.ctx.focusedAgentId = 'programming-helper';
  h.ctx.isRemoteNamespaceAgentId = () => false;
  h.ctx.refreshAgentCallStates = async () => {};
  h.ctx.renderFeaturePanel = () => {};
  h.ctx.ensurePhProjectEntitiesLoaded = async () => {};
  h.ctx.fetch = async () => ({ ok: true, json: async () => ({ agents: [] }) });
  const oldRead = Promise.withResolvers();
  let reads = 0;
  h.ctx.invoke = () => ++reads === 1 ? oldRead.promise : Promise.resolve([h.host]);
  const before = h.ctx.run('loadAgents()');
  const after = h.ctx.run('refreshSidebarRuntimeAfterMutation()');
  oldRead.resolve([h.host, h.child]);
  await Promise.all([before, after]);
  assert.equal(reads, 2, 'joining a pre-close poll is not a post-close refresh');
  assert.equal(h.html, '', 'late pre-close data must not recreate the closed leaf');
  assert.equal(h.ctx.allAgents.length, 1);
});

test('closed runtime stays absent while the independent thread snapshot still says running', async () => {
  const h = harness('programming-helper');
  await h.threads([thread({ agentId: 'programming-helper' })]);
  h.ctx.run('renderAgentList()');
  assert.match(h.html, /data-thread-id="t1"/);
  h.ctx.run("markPendingRuntimeStop('programming-helper', 's1', 'r1'); invalidateSidebarProjection()");
  assert.equal(h.html, '');
  // The runtime poll confirms retirement before the slower thread poll arrives.
  h.ctx.allAgents = [h.host];
  h.ctx.run('reconcilePendingRuntimeStops(allAgents); renderAgentList()');
  assert.equal(h.html, '', 'a stale thread observation must not recreate a disconnected runtime');
  await h.threads([thread({ agentId: 'programming-helper', lifeState: 'idle', headRuntimeRunning: false })]);
  assert.equal(h.html, '');
});

test('thread refresh retires a ghost without a click or another render trigger', async () => {
  const h = harness();
  await h.threads([thread()]);
  h.ctx.run('renderAgentList()');
  h.ctx.allAgents = [h.host];
  h.ctx.run('renderAgentList()');
  assert.equal(h.html, '', 'missing runtimes are not reconstructed from stale thread activity');
  await h.threads([thread({ lifeState: 'archived', archivedAt: 1, headRuntimeRunning: false })]);
  assert.equal(h.html, '');
});

test('archived thread cannot reappear as a plain runtime while the agents snapshot lags', async () => {
  const h = harness();
  await h.threads([thread({ lifeState: 'archived', archivedAt: 1, headRuntimeRunning: false })]);
  h.ctx.run('renderAgentList()');
  assert.equal(h.html, '');
});

test('background thread archive and deletion events refresh facts without changing the selected view', async () => {
  const h = harness();
  await h.threads([thread()]);
  assert.ok(h.handlers.has('*'), 'all background threads must be subscribed');
  h.ctx.focusedAgentId = 'programming-helper';
  h.setThreads([thread({ lifeState: 'archived', archivedAt: 1, headRuntimeRunning: false })]);
  await h.handlers.get('*')({ type: 'thread.archived', threadId: 't1' });
  assert.equal(h.html, '');
  assert.equal(h.ctx.focusedAgentId, 'programming-helper');
  await h.threads([thread()]);
  h.ctx.allAgents = [h.host];
  h.ctx.run('renderAgentList()');
  h.setThreads([]);
  await h.handlers.get('*')({ type: 'thread.deleted', threadId: 't1' });
  assert.equal(h.html, '');
  assert.ok(h.handlers.has('*'), 'discovery survives deletion and can observe newly created threads');
});

test('session delta updates ordinary and threaded sidebar titles at the commit boundary', async () => {
  for (const agentId of ['programming-helper', 'coder']) {
    const h = harness(agentId);
    if (agentId === 'coder') await h.threads([thread()]);
    h.ctx.run('renderAgentList()');
    h.ctx.payload = delta();
    h.ctx.run('applySessionMutationDelta(allAgents[0].id, payload)');
    assert.match(h.html, />New<\//, agentId);
    // A later render must not restore a stale runtime or thread summary title.
    h.ctx.run('renderAgentList()');
    assert.match(h.html, />New<\//, agentId);
    h.ctx.payload = delta('Older response', 1);
    h.ctx.run('applySessionMutationDelta(allAgents[0].id, payload)');
    assert.match(h.html, />New<\//, 'older revision cannot roll the title back');
  }
});

test('Enter rename keeps the saved title after the real sidebar redraw', async () => {
  const h = harness('programming-helper');
  const listeners = {};
  h.ctx.run('renderAgentList()');
  const input = { value: '', focus() {}, select() {}, addEventListener: (name, fn) => { listeners[name] = fn; } };
  const name = { textContent: 'Old', querySelector: () => input };
  const item = { classList: { add() {}, remove() {} }, querySelector: () => name };
  h.ctx.document.querySelector = (selector) => selector.includes('data-ctx-id') ? item : null;
  h.ctx.fetch = async () => ({ ok: true, json: async () => delta() });
  h.ctx.run("ctxRenameSession({ ns: 'programming-helper', id: 'r1', sessionId: 's1' })");
  input.value = 'New';
  listeners.keydown({ key: 'Enter', preventDefault() {} });
  await listeners.blur();
  // Drain the asynchronous event handler without advancing a polling timer.
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(h.html, />New<\//);
});

test('title-only thread refresh is rendered, while identical snapshots remain deduplicated', async () => {
  const h = harness();
  h.host.workspace_sessions.sessions = [];
  await h.threads([thread()]);
  h.ctx.run('renderAgentList()');
  await h.threads([thread({ headSessionTitle: 'Renamed' })]);
  assert.match(h.html, />Renamed<\//);
  const baseline = h.renders;
  await h.threads([thread({ headSessionTitle: 'Renamed' })]);
  assert.equal(h.renders, baseline);
});

test('multiple background threads share one subscription without selecting a conversation', async () => {
  const h = harness();
  await h.threads([thread(), thread({ threadId: 't2', headSessionId: 's2', sessionIds: ['s2'] })]);
  assert.deepEqual([...h.handlers.keys()], ['*']);
  assert.equal(h.ctx.window.ClawThreads.activeConversation, null);
  h.setThreads([thread(), thread({ threadId: 't2', headSessionId: 's2', sessionIds: ['s2'], archivedAt: 1, lifeState: 'archived' })]);
  await h.handlers.get('*')({ type: 'thread.archived', threadId: 't2' });
  assert.equal(h.ctx.window.ClawThreads.byId.t2.lifeState, 'archived');
  assert.equal(h.ctx.window.ClawThreads.activeConversation, null);
  assert.match(h.html, /data-thread-id="t1"/);
});

test('archival also hides a stale host synthetic runtime', async () => {
  const h = harness();
  h.ctx.allAgents = [h.host];
  h.host.runtime_session_id = 'r1';
  h.host.active_workspace_session_id = 's1';
  await h.threads([thread({ lifeState: 'archived', archivedAt: 1, headRuntimeRunning: false })]);
  assert.equal(h.html, '');
});

test('background rendering waits for inline editing and consumes the latest facts afterwards', () => {
  const h = harness('programming-helper');
  h.ctx.run('renderAgentList()');
  h.ctx.document.querySelector = () => ({});
  h.host.workspace_sessions.sessions[0].title = 'Changed elsewhere';
  h.ctx.run('renderAgentList()');
  assert.match(h.html, />Old<\//);
  h.ctx.document.querySelector = () => null;
  h.ctx.run('renderAgentList()');
  assert.match(h.html, />Changed elsewhere<\//);
});

test('assembly runtime retains its agent display name when the session title changes', () => {
  const h = harness('agent-studio');
  h.host.workspace_sessions.sessions[0] = { id: 's1', title: 'New', formId: 'assembly-form', agentName: 'My Agent' };
  h.child.active_workspace_display_name = 'My Agent';
  h.ctx.run('renderAgentList()');
  assert.match(h.html, />My Agent<\//);
});
