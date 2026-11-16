import test from 'node:test';
import assert from 'node:assert/strict';
import { loadModuleOnce } from './helpers/esm-module-loader.js';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function loadLoader(hostOverrides = {}) {
  const loadedAgentDetailIds = new Set();
  const agents = [{ id: 'host-a', workspace_sessions: { sessions: [{ id: 'old' }] } }];
  const host = {
    loadedAgentDetailIds,
    currentRuntimeAgentId: () => 'runtime-a',
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    setFeatureTemplateMap() {},
    allAgents: () => agents,
    getPhSessionOwnershipParams: () => ({}),
    captureSidebarSnapshotToken: () => null,
    isSidebarSnapshotTokenCurrent: () => true,
    captureSessionViewToken: () => null,
    commitSessionViewPatch: () => false,
    mergeWorkspaceSessionSnapshots: (previous, fresh) => ({ ...previous, ...fresh }),
    updateChatContextBar() {},
    renderCurrentMainView() {},
    toolRenderConfigs: () => ({}),
    collectTemplateNames: () => [],
    warmTemplatesInBackground() {},
    warn() {}, info() {}, log() {},
    ...hostOverrides,
  };
  const { module, cleanup } = await loadModuleOnce('public/src/modules/agent-loader.js');
  return { loader: module.createAgentLoader(host), host, agents, loadedAgentDetailIds, cleanup };
}

function createSessionViewHost() {
  const ctx = createFrontendSandbox();
  ctx.loadSource('public/src/app-core.js');
  ctx.loadSource('public/src/modules/session-view-state.js');
  ctx.run(`
    currentRuntimeAgentId = 'runtime-a';
    allAgents = [{ id: 'host-a', workspace_sessions: { sessions: [{ id: 'old' }] } }];
    applySessionViewPatch({ identity: { agentId: 'host-a', sessionId: 'selected' } });
  `);
  const args = (expression, values = []) => {
    ctx.__testArgs = values;
    try { return ctx.run(expression.replaceAll('$ARGS', '__testArgs')); }
    finally { delete ctx.__testArgs; }
  };
  return {
    ctx,
    loadedAgentDetailIds: ctx.run('loadedAgentDetailIds'),
    currentRuntimeAgentId: () => ctx.run('currentRuntimeAgentId'),
    fetch: (...callArgs) => ctx.fetch(...callArgs),
    setFeatureTemplateMap() {},
    allAgents: () => ctx.run('allAgents'),
    getPhSessionOwnershipParams: () => ({}),
    captureSidebarSnapshotToken: () => null,
    isSidebarSnapshotTokenCurrent: () => true,
    captureSessionViewToken: () => ctx.run('captureSessionViewToken()'),
    commitSessionViewPatch: (token, patch, after) => args(
      'commitSessionViewPatch($ARGS[0], $ARGS[1], $ARGS[2])', [token, patch, after],
    ),
    mergeWorkspaceSessionSnapshots(previous, fresh) {
      return { ...previous, ...fresh, sessions: [...(fresh.sessions || [])] };
    },
    updateChatContextBar() {},
    renderCurrentMainView: () => {},
    toolRenderConfigs: () => ({}),
    collectTemplateNames: () => [],
    warmTemplatesInBackground() {},
    warn() {}, info() {}, log() {},
  };
}

test('template-map loads are explicit-runtime scoped, retain the prior map on empty/failure, and qualify retry', async () => {
  const requests = [];
  const values = [];
  let hMap = { previous: true };
  const h = await loadLoader({
    currentRuntimeAgentId: () => 'runtime / one',
    fetch: async (url) => {
      requests.push(url);
      const next = values.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    setFeatureTemplateMap(value) { hMap = value; },
  });
  try {
    values.push({ ok: true, json: async () => ({ read: '/template.js' }) });
    assert.equal(await h.loader.loadFeatureTemplateMap(), true);
    assert.deepEqual(hMap, { read: '/template.js' });
    values.push({ ok: false });
    assert.equal(await h.loader.loadFeatureTemplateMap(), false);
    assert.deepEqual(hMap, { read: '/template.js' });
    values.push(new Error('network'));
    assert.equal(await h.loader.loadFeatureTemplateMap(), false);
    values.push({ ok: true, json: async () => ({ write: '/write.js' }) });
    assert.equal(await h.loader.loadFeatureTemplateMap(), true);
    assert.deepEqual(hMap, { write: '/write.js' });
    assert.deepEqual(requests, Array(4).fill('/api/templates/feature?agentId=runtime%20%2F%20one'));
  } finally { h.cleanup(); }
});

test('agent detail uses the real SessionView commit to reject metadata from a prior visit', async () => {
  const gate = deferred();
  const requests = [];
  const host = createSessionViewHost();
  host.fetch = async (url) => {
    requests.push(url);
    await gate.promise;
    return { ok: true, json: async () => ({ workspace_sessions: { sessions: [
      { id: 'selected', sessionType: 'thread', workspaceAgentId: 'coder', openDirectory: '/picked', messageCount: 7 },
      { id: 'another', openDirectory: '/wrong' },
    ] } }) };
  };
  const { module, cleanup } = await loadModuleOnce('public/src/modules/agent-loader.js');
  const loader = module.createAgentLoader(host);
  try {
    const first = loader.loadAgentDetail('host-a');
    await loader.loadAgentDetail('host-a');
    assert.equal(requests.length, 1, 'the in-flight request is deduplicated');
    host.ctx.run(`
      applySessionViewPatch({ identity: { agentId: 'host-a', sessionId: 'another' } });
      applySessionViewPatch({ sessionMeta: { sessionId: 'another', openDirectory: '/newer' } });
    `);
    gate.resolve();
    await first;
    assert.equal(host.loadedAgentDetailIds.has('host-a'), true);
    assert.equal(host.ctx.run('readCurrentSessionViewState().sessionMeta.openDirectory'), '/newer');
    assert.equal(loader.getAgentDetailPayload('host-a').workspace_sessions.sessions.length, 2);
    assert.equal(host.allAgents()[0].workspace_sessions.sessions[0].id, 'selected');

    const late = host.captureSessionViewToken();
    assert.equal(host.commitSessionViewPatch(late, { sessionMeta: { sessionId: 'another', openDirectory: '/committed' } }), true);
    assert.equal(host.ctx.run('readCurrentSessionViewState().sessionMeta.openDirectory'), '/committed');
  } finally { cleanup(); }
});

test('detail failure permits retry and never replaces the previous successful payload', async () => {
  let fail = false;
  let calls = 0;
  const h = await loadLoader({ fetch: async () => {
    calls += 1;
    if (fail) throw new Error('offline');
    return { ok: true, json: async () => ({ name: 'confirmed' }) };
  } });
  try {
    await h.loader.loadAgentDetail('host-a');
    const confirmed = h.loader.getAgentDetailPayload('host-a');
    h.loadedAgentDetailIds.delete('host-a');
    fail = true;
    await h.loader.loadAgentDetail('host-a');
    assert.equal(h.loadedAgentDetailIds.has('host-a'), false);
    assert.strictEqual(h.loader.getAgentDetailPayload('host-a'), confirmed);
    fail = false;
    await h.loader.loadAgentDetail('host-a');
    assert.equal(calls, 3);
    assert.equal(h.loadedAgentDetailIds.has('host-a'), true);
  } finally { h.cleanup(); }
});

test('detail metadata commits only to the selected session through real SessionView state', async () => {
  const host = createSessionViewHost();
  host.fetch = async () => ({ ok: true, json: async () => ({ workspace_sessions: { sessions: [
    { id: 'selected', sessionType: 'thread', workspaceAgentId: 'coder', openDirectory: '/picked', messageCount: 7 },
    { id: 'active-but-not-selected', openDirectory: '/wrong' },
  ] } }) });
  const { module, cleanup } = await loadModuleOnce('public/src/modules/agent-loader.js');
  const loader = module.createAgentLoader(host);
  try {
    await loader.loadAgentDetail('host-a');
    const state = host.ctx.run('readCurrentSessionViewState()');
    assert.equal(state.sessionMeta.sessionId, 'selected');
    assert.equal(state.sessionMeta.openDirectory, '/picked');
    assert.equal(state.sessionMeta.messageCount, 7);
  } finally { cleanup(); }
});
