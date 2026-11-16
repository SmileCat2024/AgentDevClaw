import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserStubs, loadModuleOnce } from './helpers/esm-module-loader.js';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

const DOMAIN = 'orchestration';
const MODULE = 'public/src/modules/orchestration-state.js';
const INITIAL = {
  currentRuntimeAgentId: null,
  _switchEpoch: 0,
  pendingSwitchTarget: null,
  pendingSwitchSerial: 0,
  _navigationGuardEpoch: 0,
  _pendingSessionNavigation: null,
  _chatLoadingSession: false,
  _chatLoadingTimeout: null,
  _restoredScrollTop: null,
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

test('real pending navigation survives claim and is invalidated by subsequent user navigation', async () => {
  const ctx = createFrontendSandbox();
  ctx.loadSource('public/src/modules/kernel-state.js');
  ctx.loadSource('public/src/app-core.js');
  const pending = ctx.run("beginPendingSessionNavigation('agent-a', 'session-a')");
  const previousWindow = globalThis.window;
  globalThis.window = ctx;
  try {
    const { module } = await loadModuleOnce(MODULE, { installGlobals: false });
    assert.strictEqual(module._pendingSessionNavigation, pending);
    assert.equal(ctx.run("hasPendingSessionNavigation({ id: 'agent-a' })"), true);
    ctx.run("updatePendingSessionNavigation('session-b', 'starting-runtime')");
    assert.equal(module._pendingSessionNavigation.sessionId, 'session-b');
    ctx.run('bumpNavigationGuard()');
    assert.equal(module._navigationGuardEpoch, 1);
    assert.equal(module._pendingSessionNavigation, null);
    assert.equal(ctx.run('hasPendingSessionNavigation()'), false);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test('orchestration claim absorbs runtime, epoch and navigation values without rewriting them', async () => {
  const { cleanup } = await setup();
  try {
    const navigation = { agentId: 'agent-early', sessionId: 'session-early' };
    window.currentRuntimeAgentId = 'runtime-early';
    window._switchEpoch = 4;
    window._navigationGuardEpoch = 9;
    window._pendingSessionNavigation = navigation;

    const { module } = await loadModuleOnce(MODULE, { installGlobals: false });
    assert.equal(module.currentRuntimeAgentId, 'runtime-early');
    assert.equal(module._switchEpoch, 4);
    assert.equal(module._navigationGuardEpoch, 9);
    assert.strictEqual(module._pendingSessionNavigation, navigation);
  } finally {
    cleanupKeys();
    cleanup();
  }
});

test('orchestration bridge preserves classic writes, ESM writes, increments and handle identity', async () => {
  const { cleanup } = await setup();
  try {
    const { module } = await loadModuleOnce(MODULE, { installGlobals: false });
    window._switchEpoch++;
    assert.equal(module._switchEpoch, 1);
    module.setSwitchEpoch(module._switchEpoch + 1);
    assert.equal(window._switchEpoch, 2);

    window._navigationGuardEpoch++;
    assert.equal(module._navigationGuardEpoch, 1);
    module.setNavigationGuardEpoch(module._navigationGuardEpoch + 1);
    assert.equal(window._navigationGuardEpoch, 2);

    const target = { runtimeId: 'runtime-a', serial: 3 };
    module.setPendingSwitchTarget(target);
    assert.strictEqual(window.pendingSwitchTarget, target);
    const navigation = { agentId: 'agent-a', phase: 'committing' };
    window._pendingSessionNavigation = navigation;
    assert.strictEqual(module._pendingSessionNavigation, navigation);
    const nextNavigation = { agentId: 'agent-b', phase: 'awaiting' };
    module.setPendingSessionNavigation(nextNavigation);
    assert.strictEqual(window._pendingSessionNavigation, nextNavigation);

    const timer = setTimeout(() => {}, 10000);
    const promise = Promise.resolve('switch');
    try {
      window._chatLoadingTimeout = timer;
      assert.strictEqual(module._chatLoadingTimeout, timer);
      module.setPendingSwitchTarget(promise);
      assert.strictEqual(window.pendingSwitchTarget, promise);
      window._restoredScrollTop = 37;
      assert.equal(module._restoredScrollTop, 37);
    } finally {
      clearTimeout(timer);
    }
  } finally {
    cleanupKeys();
    cleanup();
  }
});
