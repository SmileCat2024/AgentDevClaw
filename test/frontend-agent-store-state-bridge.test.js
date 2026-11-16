import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserStubs, loadModuleOnce } from './helpers/esm-module-loader.js';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

const DOMAIN = 'agent-store';
const MODULE = 'public/src/modules/agent-store-state.js';
const INITIAL = {
  allAgents: [],
  focusedAgentId: null,
  readOnlyMode: false,
  loadAgentsInFlight: null,
  lastAgentListRefreshAt: 0,
  lastCallStateRefreshAt: 0,
  expandedProjectIds: new Set(),
};

async function setup() {
  const cleanup = installBrowserStubs();
  await loadModuleOnce('public/src/modules/kernel-state.js', { installGlobals: false });
  for (const [key, value] of Object.entries(INITIAL)) window.KernelState.defineKey(DOMAIN, key, value);
  return { cleanup };
}

function cleanupKeys() {
  for (const key of Object.keys(INITIAL)) delete window[key];
  delete window.KernelState;
}

test('real loadAgents reuses an in-flight request across owner claim and releases it after failure', async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const ctx = createFrontendSandbox({
    performance,
    console: { ...console, error() {}, warn() {} },
  });
  ctx.loadSource('public/src/modules/kernel-state.js');
  ctx.loadSource('public/src/app-core.js');
  ctx.loadSource('public/src/modules/sidebar-render.js');
  ctx.invoke = async () => { calls += 1; await pending; throw new Error('controlled read failure'); };
  const previousWindow = globalThis.window;
  globalThis.window = ctx;
  try {
    const first = ctx.run('loadAgents()');
    const { module } = await loadModuleOnce(MODULE, { installGlobals: false });
    const second = ctx.run('loadAgents()');
    assert.equal(calls, 1, 'concurrent reads must share the existing request');
    assert.ok(module.loadAgentsInFlight);
    release();
    await Promise.all([first, second]);
    assert.equal(module.loadAgentsInFlight, null, 'a failed read must release the mutex');
    await ctx.run('loadAgents()');
    assert.equal(calls, 2, 'a later request must not remain stuck behind the settled promise');
  } finally {
    release();
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test('agent-store claim absorbs early bridge values without copying list or Set references', async () => {
  const { cleanup } = await setup();
  try {
    const agents = [{ id: 'early-agent' }];
    const expanded = new Set(['project-early']);
    window.allAgents = agents;
    window.expandedProjectIds = expanded;
    window.focusedAgentId = 'early-agent';

    const { module } = await loadModuleOnce(MODULE, { installGlobals: false });
    assert.strictEqual(module.allAgents, agents);
    assert.strictEqual(module.expandedProjectIds, expanded);
    assert.equal(module.focusedAgentId, 'early-agent');
  } finally {
    cleanupKeys();
    cleanup();
  }
});

test('agent-store bridge preserves classic writes, ESM setters, live bindings and object handles', async () => {
  const { cleanup } = await setup();
  try {
    const { module } = await loadModuleOnce(MODULE, { installGlobals: false });
    const replacement = [{ id: 'classic-agent' }];
    window.allAgents = replacement;
    assert.strictEqual(module.allAgents, replacement);

    const promise = Promise.resolve('in-flight');
    window.loadAgentsInFlight = promise;
    assert.strictEqual(module.loadAgentsInFlight, promise);

    const expanded = new Set(['p1']);
    module.setExpandedProjectIds(expanded);
    assert.strictEqual(window.expandedProjectIds, expanded);
    assert.strictEqual(module.expandedProjectIds, expanded);

    module.setLastAgentListRefreshAt(123);
    assert.equal(window.lastAgentListRefreshAt, 123);
    window.readOnlyMode = true;
    assert.equal(module.readOnlyMode, true);
    window.focusedAgentId = 'focus-2';
    assert.equal(module.focusedAgentId, 'focus-2');
  } finally {
    cleanupKeys();
    cleanup();
  }
});
