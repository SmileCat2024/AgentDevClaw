import test from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';
import { loadModuleOnce } from './helpers/esm-module-loader.js';

test('call-state host coalesces overlapping refreshes, reuses focus payload and unlocks after failure', async () => {
  let release;
  let fail = false;
  const requests = [];
  const ctx = createFrontendSandbox({
    // Runtime-status clock is unrelated to reconciliation; do not leave an interval.
    setInterval: () => 0,
    _markAgentCallStartedForNotify() {},
    fetch: async (url) => {
      requests.push(url);
      if (fail) throw new Error('offline');
      await new Promise((resolve) => { release = resolve; });
      return { ok: true, json: async () => ({ callActive: true }) };
    },
  });
  ctx.loadSource('public/src/app-core.js');
  ctx.loadSource('public/src/modules/runtime-status.js');
  ctx.loadSource('public/src/modules/sidebar-render.js');
  ctx.renderAgentList = () => {};
  ctx.run(`allAgents = [{ id: 'rt', source: 'child', parent_id: 'host', connected: true }];`);
  const previous = globalThis.window;
  globalThis.window = ctx;
  try {
    const { module } = await loadModuleOnce('public/src/modules/agent-call-states-host.js', { installGlobals: false });
    assert.strictEqual(ctx.refreshAgentCallStates, module.refreshAgentCallStates);
    const first = ctx.refreshAgentCallStates(ctx.allAgents, { force: true });
    await ctx.refreshAgentCallStates(ctx.allAgents, { force: true });
    assert.equal(requests.length, 1, 'overlapping refresh must not issue duplicate requests');
    release();
    await first;
    assert.equal(ctx.allAgents[0].callActive, true);
    assert.equal(ctx.run('isRuntimeCalling("rt")'), true);
    await ctx.refreshAgentCallStates(ctx.allAgents, { force: true,
      reuseNotification: { runtimeId: 'rt', payload: { callActive: false } } });
    assert.equal(requests.length, 1, 'same-cycle focus observation avoids another request');
    assert.equal(ctx.allAgents[0].callActive, false);
    fail = true;
    await ctx.refreshAgentCallStates(ctx.allAgents, { force: true });
    fail = false;
    const next = ctx.refreshAgentCallStates(ctx.allAgents, { force: true });
    assert.equal(requests.length, 3, 'failed refresh must release the in-flight lock');
    release();
    await next;
    assert.equal(ctx.allAgents[0].callActive, true);
  } finally {
    release?.();
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  }
});
