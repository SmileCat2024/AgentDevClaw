import test from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';
import { loadModuleOnce } from './helpers/esm-module-loader.js';
import { prepareClassicSandbox } from './p2-classic-hosts.js';

test('call-state host coalesces overlapping refreshes, reuses focus payload and unlocks after failure', async () => {
  let release;
  let fail = false;
  const requests = [];
  const ctx = createFrontendSandbox({
    _markAgentCallStartedForNotify() {},
    fetch: async (url) => {
      requests.push(url);
      if (fail) throw new Error('offline');
      await new Promise((resolve) => { release = resolve; });
      return { ok: true, json: async () => ({ callActive: true }) };
    },
  });
  // 真实 classic owner：app-main 的 bootstrap IIFE 创建唯一引擎实例。
  prepareClassicSandbox(ctx);
  ctx.renderAgentList = () => {};
  ctx.run(`allAgents = [{ id: 'rt', source: 'child', parent_id: 'host', connected: true }];`);
  const previous = globalThis.window;
  globalThis.window = ctx;
  try {
    const { module } = await loadModuleOnce('public/src/modules/agent-call-states-host.js', { installGlobals: false });
    assert.equal(typeof ctx.refreshAgentCallStates, 'function', 'classic accessor is the owner');
    assert.equal(typeof module.refreshAgentCallStates, 'function', 'ESM adapter is late-bound');
    const first = ctx.refreshAgentCallStates(ctx.allAgents, { force: true });
    await module.refreshAgentCallStates(ctx.allAgents, { force: true });
    assert.equal(requests.length, 1, 'classic + adapter overlapping refresh must share the in-flight lock');
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
