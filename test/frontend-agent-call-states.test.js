/**
 * agent-call-states 引擎的并发/复用/失败解锁契约。
 *
 * 装载路线（P4 T2 收尾批次后）：引擎实例是 ESM 模块
 * `modules/agent-call-states-engine.js`（原 app-main 顶层 IIFE 逐字搬出），
 * 由真实 classic 先行链 + 侧栏域模块相装载（withP2EsmCase 一份 window + 一张图）。
 * classic 侧经 `agent-call-states` 桥键取用同一实现，ESM 适配器
 * （agent-call-states-host）只做 late-bound 转发。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { prepareClassicSandbox } from './p2-classic-hosts.js';

test('call-state host coalesces overlapping refreshes, reuses focus payload and unlocks after failure', async () => {
  let release;
  let fail = false;
  const requests = [];

  await withP2EsmCase({
    globals: {
      _markAgentCallStartedForNotify() {},
      fetch: async (url) => {
        requests.push(url);
        if (fail) throw new Error('offline');
        await new Promise((resolve) => { release = resolve; });
        return { ok: true, json: async () => ({ callActive: true }) };
      },
    },
    classic: (sandbox) => {
      // 真实 classic 先行链（app-core 的容器 + app-main 的宿主面）；
      // 引擎实例由侧栏域在模块相装载。
      prepareClassicSandbox(sandbox);
    },
  }, async (c) => {
    const ctx = c.window;
    const renderStub = () => {};
    // 侧栏渲染不在本用例断言面（引擎只要求 render 是可调用 sink）。
    ctx.renderAgentList = renderStub;
    ctx.run(`allAgents = [{ id: 'rt', source: 'child', parent_id: 'host', connected: true }];`);

    const module = await c.load('public/src/modules/agent-call-states-host.js');
    assert.equal(typeof ctx.refreshAgentCallStates, 'function', 'classic 桥键是引擎实现');
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
  });
});
