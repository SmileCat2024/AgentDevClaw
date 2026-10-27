import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

// thread-store.js 在模块加载时注册 2s 启动刷新 + 20s 周期刷新（未 unref），
// 若沿用 Node 全局定时器会让测试进程挂在事件循环上。注入 unref 版定时器。
function unrefTimer(handle) { if (handle && typeof handle.unref === 'function') handle.unref(); return handle; }

// 触发收集的 timer 回调后，等待沙箱内 rebind 的 async 链（多个 await）推进
// 完成。timer 回调是 void 调用不返回 promise，靠 setImmediate 让出足够多的
// 微任务 tick。
async function flushTimers(shared) {
  const due = shared.timers.splice(0);
  for (const handle of due) {
    if (!handle.cancelled) handle.fn();
  }
  await new Promise((resolve) => setImmediate(resolve));
}

/**
 * 冻结恢复场景（PH 手动接续，ADR-0032）：接续事务已提交（head 已推进、
 * 挡板已清、threads 缓存已含新事实），视图冻结在旧 head（activeConversation
 * wasHead=true、runtime 绑定旧会话）。重绑的一次性触发（SSE head-advanced、
 * 响应对账）已错过 successor runtime 快照——此后 threads 内容不再变化，
 * 周期轮询全部命中 unchanged 短路。恢复只能靠 unchanged 短路时的对账
 * （周期兜底）与 runtime 缺席时的有界重试（秒级兜底）。
 */
function createRebindRecoverySandbox({ allAgents, fetchImpl, manualTimers = false } = {}) {
  const shared = {
    bindings: [],
    loadedRuntime: '',
    loadAgentsCount: 0,
    timers: [],
  };
  const timerApi = manualTimers
    ? {
      setTimeout: (fn, ms) => {
        const handle = { fn, ms, cancelled: false };
        shared.timers.push(handle);
        return handle;
      },
      clearTimeout: (handle) => { if (handle) handle.cancelled = true; },
    }
    : {
      setTimeout: (fn, ms) => unrefTimer(globalThis.setTimeout(fn, ms)),
      clearTimeout: globalThis.clearTimeout,
    };
  const ctx = createFrontendSandbox({
    currentLanguage: 'zh',
    focusedAgentId: 'coder',
    currentRuntimeAgentId: 'runtime-old',
    allAgents,
    getCurrentHostAgentRecord: () => ({ id: 'coder' }),
    getRuntimeWorkspaceSessionId: (runtimeId) => (runtimeId === 'runtime-old' ? 'session-old' : 'session-new'),
    getRuntimeContextKey: (runtimeId) => `host:coder|session:${runtimeId === 'runtime-old' ? 'session-old' : 'session-new'}`,
    setViewerSessionBinding: (runtimeId, sessionId) => { shared.bindings.push([runtimeId, sessionId]); },
    loadAgents: async () => { shared.loadAgentsCount += 1; },
    loadAgentData: async (runtimeId) => { shared.loadedRuntime = runtimeId; },
    saveCurrentRuntimeToCache() {},
    _storeVisibleSessionInputDraft() {},
    resetRuntimeStatusForSwitch() {},
    setPendingChatScrollRestore() {},
    renderAgentList() {},
    renderCurrentMainView() {},
    _lastRenderedChatSig: '',
    readOnlyMode: false,
    updateQueueIndicator() {},
    fetch: fetchImpl,
    setInterval: (fn, ms) => unrefTimer(globalThis.setInterval(fn, ms)),
    ...timerApi,
  });
  ctx.loadSource('public/src/modules/session-view-state.js'); // thread-store 依赖会话视图提交原语
  ctx.loadSource('public/src/modules/thread-store.js');
  ctx.window.updateThreadHeaderIndicator = () => {};

  // 冻结事实：head 已推进到 session-new，缓存已含新事实；视图挂在旧 head。
  const thread = {
    threadId: 'wt-frozen', agentId: 'coder', status: 'open',
    headSessionId: 'session-new', sessionIds: ['session-old', 'session-new'],
  };
  ctx.window.ClawThreads.threads = [thread];
  ctx.window.ClawThreads.byId['wt-frozen'] = thread;
  ctx.window.ClawThreads.sessionIndex['coder::session-old'] = thread;
  ctx.window.ClawThreads.sessionIndex['coder::session-new'] = thread;
  ctx.window.ClawThreads.activeConversation = {
    agentId: 'coder', threadId: 'wt-frozen', sessionId: 'session-old',
    runtimeId: 'runtime-old', wasHead: true,
  };
  return { ctx, shared };
}

const successorRuntime = () => ({
  id: 'runtime-new', source: 'child', parent_id: 'coder',
  active_workspace_session_id: 'session-new',
  runtime_session_id: 'runtime-new',
});

describe('thread-store: rebind freeze recovery (PH thread succession)', () => {
  it('unchanged threads poll still reconciles the frozen view onto the new head', async () => {
    // successor runtime 已在 allAgents；fetch 返回 unchanged（threads 内容不再变化）。
    const { ctx, shared } = createRebindRecoverySandbox({
      allAgents: [successorRuntime()],
      fetchImpl: async () => ({ ok: true, json: async () => ({ unchanged: true }) }),
    });

    await ctx.window.refreshThreads(true);

    // 冻结恢复：重绑必须发生，否则用户只能手点「前往当前会话」跳转。
    assert.equal(shared.loadedRuntime, 'runtime-new', 'rebind must load the successor runtime');
    assert.deepEqual(shared.bindings.at(-1), ['runtime-new', 'session-new']);
    assert.equal(ctx.currentRuntimeAgentId, 'runtime-new');
    assert.equal(ctx.window.ClawThreads.activeConversation.sessionId, 'session-new');
    assert.equal(ctx.window.ClawThreads.activeConversation.runtimeId, 'runtime-new');
  });

  it('schedules a bounded retry when the successor runtime is missing from the snapshot', async () => {
    const agents = [];
    const { ctx, shared } = createRebindRecoverySandbox({
      allAgents: agents,
      fetchImpl: async () => ({ ok: true, json: async () => ({ unchanged: true }) }),
      manualTimers: true,
    });
    // 丢弃模块加载时的启动刷新 timer（2s 首拉），保持断言确定性。
    shared.timers.splice(0);

    await ctx.window.refreshThreads(true);
    assert.equal(shared.loadedRuntime, '', 'first rebind attempt must not find the successor yet');
    assert.ok(shared.timers.length >= 1, 'a rebind retry must be scheduled');

    // successor 进入快照后重试触发（秒级恢复，不等 20s 周期轮询）。
    agents.push(successorRuntime());
    await flushTimers(shared);
    assert.equal(shared.loadedRuntime, 'runtime-new', 'retry must complete the rebind');
    assert.equal(ctx.currentRuntimeAgentId, 'runtime-new');
    assert.equal(shared.bindings.at(-1)[0], 'runtime-new');
  });

  it('stops retrying after the bounded attempts when the successor never appears', async () => {
    const { ctx, shared } = createRebindRecoverySandbox({
      allAgents: [],
      fetchImpl: async () => ({ ok: true, json: async () => ({ unchanged: true }) }),
      manualTimers: true,
    });
    shared.timers.splice(0);

    await ctx.window.refreshThreads(true);
    // 逐次触发重试，直到上限（首次缺席 + 5 次重试）。
    for (let round = 0; round < 8; round += 1) {
      await flushTimers(shared);
    }
    assert.equal(shared.loadAgentsCount, 6, 'exactly 1 initial attempt + 5 bounded retries');
    assert.equal(shared.timers.length, 0, 'no further retries after the bound');
    assert.equal(shared.loadedRuntime, '', 'no successor existed; view stays frozen until poll/manual recovery');
  });
});
