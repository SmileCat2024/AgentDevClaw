import test from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';
import { loadModuleOnce } from './helpers/esm-module-loader.js';

test('runtime status host gates unsupported guards and rejects responses parsed after leaving a view', async () => {
  const requests = [];
  const effects = [];
  const warnings = [];
  let guardAvailable = false;
  let failConnection = false;
  let pauseBody = false;
  let release;
  const runtime = { id: 'rt', connected: true };
  const ctx = createFrontendSandbox({
    ContextGuardToggle: { isAvailable: () => guardAvailable },
    getCurrentRuntimeRecord: () => ({ agentId: 'host', sessionId: 'a' }),
    getCurrentAgentRecord: () => null,
    getLogicalAgentId: (record) => record.agentId,
    getActiveSessionId: (record) => record.sessionId,
    getRuntimeRecord: () => runtime,
    applyContextGuardStatus: (data, id) => effects.push(['guard', data, id]),
    updateNotificationStatus: (data, id) => effects.push(['notification', data, id]),
    console: { ...console, warn: (...args) => warnings.push(args) },
    fetch: async (url) => {
      requests.push(url);
      return { ok: !(failConnection && url.endsWith('/connection')), json: async () => {
        if (pauseBody && url.endsWith('/notification')) await new Promise((resolve) => { release = resolve; });
        return url.endsWith('/connection') ? { connected: false } : { state: 'idle' };
      } };
    },
  });
  ctx.loadSource('public/src/app-core.js');
  ctx.loadSource('public/src/modules/session-view-state.js');
  ctx.loadSource('public/src/modules/agent-data-loader.js');
  ctx.getCurrentRuntimeRecord = () => ({ agentId: 'host', sessionId: 'a' });
  ctx.getCurrentAgentRecord = () => null;
  ctx.getLogicalAgentId = (record) => record.agentId;
  ctx.getActiveSessionId = (record) => record.sessionId;
  ctx.getRuntimeRecord = () => runtime;
  ctx.currentRuntimeAgentId = 'rt';
  ctx.focusedAgentId = 'host';
  ctx.applySessionViewPatch({ identity: { agentId: 'host', sessionId: 'a' }, connected: true });
  const previousWindow = globalThis.window;
  globalThis.window = ctx;
  try {
    const { module } = await loadModuleOnce('public/src/modules/runtime-status-loader-host.js', { installGlobals: false });
    assert.equal(await module.refreshContextGuardStatus(), null);
    assert.equal(requests.length, 0, 'an unsupported guard issues no request');
    await module.refreshCurrentRuntimeStatus();
    assert.deepEqual(requests, ['/api/agents/rt/notification', '/api/agents/rt/connection']);
    assert.equal(runtime.connected, false);
    assert.deepEqual(effects, [['guard', null, 'rt'], ['notification', { state: 'idle' }, 'rt']]);
    effects.length = 0;
    guardAvailable = true;
    await module.refreshContextGuardStatus();
    assert.equal(requests.at(-1), '/protoclaw/context_guard_status?agentId=host&sessionId=a');
    assert.deepEqual(effects, [['guard', { state: 'idle' }, 'rt']]);
    effects.length = 0;
    failConnection = true;
    assert.equal(await module.refreshCurrentRuntimeStatus(), null);
    assert.deepEqual(effects, [], 'a failed required endpoint must not partially apply notification or guard state');
    failConnection = false;
    pauseBody = true;
    const pending = module.refreshCurrentRuntimeStatus();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(typeof release, 'function', 'the controlled body parser must have been entered');
    ctx.applySessionViewPatch({ identity: { agentId: 'host', sessionId: 'b' } });
    ctx.applySessionViewPatch({ connected: true });
    runtime.connected = true;
    release();
    assert.equal(await pending, null);
    assert.equal(runtime.connected, true);
    assert.equal(ctx.currentRuntimeConnected, true);
    assert.deepEqual(effects, [], 'an old parsed response must not update any UI domain');
    assert.deepEqual(warnings, []);
  } finally {
    release?.();
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});
