import test from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';
import { loadModuleOnce } from './helpers/esm-module-loader.js';

test('snapshot ESM host coalesces reads, preserves source identity, rejects stale frames and unlocks after failure', async () => {
  let release;
  let fail = false;
  let current = true;
  let calls = 0;
  const scheduled = [];
  const diagnostics = [];
  const errors = [];
  const ctx = createFrontendSandbox({
    performance,
    isRemoteNamespaceAgentId: (id) => String(id).startsWith('remote:'),
    setInterval: () => 0,
    setTimeout: (callback, delay) => { scheduled.push({ callback, delay }); return 0; },
    console: { ...console, log() {}, warn() {}, error: (...args) => errors.push(args) },
    captureSidebarSnapshotToken: () => ({}),
    isSidebarSnapshotTokenCurrent: () => current,
    queueSidebarDiagnosticEvent: (event) => diagnostics.push(event),
  });
  ctx.loadSource('public/src/app-core.js');
  ctx.loadSource('public/src/modules/session-view-state.js');
  ctx.loadSource('public/src/modules/agent-data-loader.js');
  ctx.loadSource('public/src/modules/runtime-status.js');
  ctx.loadSource('public/src/modules/sidebar-render.js');
  ctx.invoke = async () => {
    calls++;
    if (fail) throw new Error('offline');
    return new Promise((resolve) => { release = resolve; });
  };
  ctx.fetch = async () => ({ ok: true, json: async () => ({ agents: [{ id: 'rt', name: 'Viewer name', connected: true, messageCount: 4 }] }) });
  ctx.renderAgentList = () => {};
  ctx.renderFeaturePanel = () => {};
  ctx.isSseActive = () => true;
  ctx.focusedAgentId = 'host';
  const host = { id: 'host', source: 'prebuilt', runtime_session_id: 'rt', sidebar_entry_id: 'host', name: 'Authoritative name' };
  ctx.allAgents = [host];
  const previous = globalThis.window;
  globalThis.window = ctx;
  try {
    const { module } = await loadModuleOnce('public/src/modules/agent-snapshot-loader-host.js', { installGlobals: false });
    const first = module.loadAgents();
    const second = module.loadAgents();
    assert.equal(calls, 1);
    release([host]);
    await Promise.all([first, second]);
    assert.equal(ctx.allAgents[0].name, 'Authoritative name', 'Viewer data must not overwrite identity');
    assert.equal(ctx.allAgents[0].message_count, 4);
    assert.equal(ctx.loadAgentsInFlight, null);
    assert.deepEqual(errors, [], 'a successful refresh must finish its downstream call-state reconciliation');
    const confirmed = ctx.allAgents;
    current = false;
    const stale = module.loadAgents();
    release([{ id: 'obsolete', source: 'prebuilt' }]);
    assert.deepEqual(await stale, { stale: true });
    assert.strictEqual(ctx.allAgents, confirmed);
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].delay, 25);
    current = true;
    fail = true;
    await module.loadAgents();
    assert.equal(errors.length, 1, 'a rejected request keeps the original failure observable');
    assert.strictEqual(ctx.allAgents, confirmed);
    assert.equal(ctx.loadAgentsInFlight, null);
    fail = false;
    const empty = module.loadAgents();
    release([]);
    await empty;
    assert.equal(ctx.allAgents[0].source, 'prebuilt');
    assert.equal(ctx.allAgents[0].sidebar_entry_id, 'host');
    assert.equal(diagnostics[0].phase, 'empty-connected-preserved-identity');
    assert.equal(calls, 4, 'failure must leave a later read eligible to run');
  } finally {
    release?.([]);
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  }
});
