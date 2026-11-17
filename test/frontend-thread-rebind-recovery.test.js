/**
 * 冻结恢复场景（PH 手动接续，ADR-0032）：接续事务已提交（head 已推进、挡板已清、
 * threads 缓存已含新事实），视图冻结在旧 head（activeConversation wasHead=true、
 * runtime 绑定旧会话）。重绑的一次性触发（SSE head-advanced、响应对账）已错过
 * successor runtime 快照——此后 threads 内容不再变化，周期轮询全部命中 unchanged
 * 短路。恢复只能靠 unchanged 短路时的对账（周期兜底）与 runtime 缺席时的有界
 * 重试（秒级兜底）。
 *
 * 装载路线（P4 T3）：刷新引擎 thread-store.js 已是真实 ESM，走 withP2EsmCase 的
 * `c.load`（每 case 一张图）。引擎运行期的重绑重试计时器按用例需要捕获到
 * shared.timers（显式触发），因此全局 `setTimeout` / `clearTimeout` 由夹具接管。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withP2EsmCase } from './helpers/p2-esm-case.js';

const THREAD_ENGINE = 'public/src/modules/thread-store.js';

/** app-core 的桥键注册面（本夹具只取引擎关心的 6 个状态键）。 */
const STATE_DOMAINS = {
  allAgents: 'agent-store',
  focusedAgentId: 'agent-store',
  readOnlyMode: 'agent-store',
  currentRuntimeAgentId: 'orchestration',
  _lastRenderedChatSig: 'render-entry',
  lastRenderedWorkspaceHtml: 'render-entry',
};

// 触发收集的 timer 回调后，等待重绑的 async 链（多个 await）推进完成。
// timer 回调是 void 调用不返回 promise，靠 setImmediate 让出足够多的微任务 tick。
async function flushTimers(shared) {
  const due = shared.timers.splice(0);
  for (const handle of due) {
    if (!handle.cancelled) handle.fn();
  }
  await new Promise((resolve) => setImmediate(resolve));
}

/**
 * 一个用例 = 一份最小经典夹具 + 一张真实 ESM 图。
 * `allAgents` 传引用：用例中途 push successor 时，引擎读到的活绑定同样可见。
 */
async function withRebindRecoveryCase({ allAgents, fetchImpl }, probe) {
  const shared = {
    bindings: [],
    loadedRuntime: '',
    loadAgentsCount: 0,
    timers: [],
  };
  return withP2EsmCase({
    label: 'thread-rebind-recovery',
    classic: (sandbox) => {
      for (const [key, domain] of Object.entries(STATE_DOMAINS)) {
        sandbox.KernelState.defineKey(domain, key, sandbox[key]);
      }
      sandbox.loadSource('public/src/modules/session-view-state.js'); // 会话视图提交原语
    },
    globals: {
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
      // 运行期计时器（重绑重试）捕获到 shared.timers，用例显式触发。
      setTimeout: (fn, ms) => {
        const handle = { fn, ms, cancelled: false };
        shared.timers.push(handle);
        return handle;
      },
      clearTimeout: (handle) => { if (handle) handle.cancelled = true; },
    },
  }, async (c) => {
    const engine = await c.load(THREAD_ENGINE);
    const ctx = c.window;
    // 冻结事实：head 已推进到 session-new，缓存已含新事实；视图挂在旧 head。
    const thread = {
      threadId: 'wt-frozen', agentId: 'coder', status: 'open',
      headSessionId: 'session-new', sessionIds: ['session-old', 'session-new'],
    };
    const state = ctx.ClawThreads;
    state.threads = [thread];
    state.byId['wt-frozen'] = thread;
    state.sessionIndex['coder::session-old'] = thread;
    state.sessionIndex['coder::session-new'] = thread;
    state.activeConversation = {
      agentId: 'coder', threadId: 'wt-frozen', sessionId: 'session-old',
      runtimeId: 'runtime-old', wasHead: true,
    };
    return probe({ c, ctx, engine, shared });
  });
}

const successorRuntime = () => ({
  id: 'runtime-new', source: 'child', parent_id: 'coder',
  active_workspace_session_id: 'session-new',
  runtime_session_id: 'runtime-new',
});

describe('thread-store: rebind freeze recovery (PH thread succession)', () => {
  it('unchanged threads poll still reconciles the frozen view onto the new head', async () => {
    // successor runtime 已在 allAgents；fetch 返回 unchanged（threads 内容不再变化）。
    await withRebindRecoveryCase({
      allAgents: [successorRuntime()],
      fetchImpl: async () => ({ ok: true, json: async () => ({ unchanged: true }) }),
    }, async ({ ctx, shared }) => {
      await ctx.window.refreshThreads(true);

      // 冻结恢复：重绑必须发生，否则用户只能手点「前往当前会话」跳转。
      assert.equal(shared.loadedRuntime, 'runtime-new', 'rebind must load the successor runtime');
      assert.deepEqual(shared.bindings.at(-1), ['runtime-new', 'session-new']);
      assert.equal(ctx.currentRuntimeAgentId, 'runtime-new');
      assert.equal(ctx.window.ClawThreads.activeConversation.sessionId, 'session-new');
      assert.equal(ctx.window.ClawThreads.activeConversation.runtimeId, 'runtime-new');
    });
  });

  it('schedules a bounded retry when the successor runtime is missing from the snapshot', async () => {
    const agents = [];
    await withRebindRecoveryCase({
      allAgents: agents,
      fetchImpl: async () => ({ ok: true, json: async () => ({ unchanged: true }) }),
    }, async ({ ctx, shared }) => {
      // 丢弃模块加载时的启动刷新 timer（2s 首拉），保持断言确定性。
      shared.timers.splice(0);

      await ctx.window.refreshThreads(true);
      // 对账入口是 fire-and-forget（`void _rebindConversationToThreadHead`）：让重绑
      // 链推进到「successor 缺席 → 排重试」再断言。
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(shared.loadedRuntime, '', 'first rebind attempt must not find the successor yet');
      assert.ok(shared.timers.length >= 1, 'a rebind retry must be scheduled');

      // successor 进入快照后重试触发（秒级恢复，不等 20s 周期轮询）。
      agents.push(successorRuntime());
      await flushTimers(shared);
      assert.equal(shared.loadedRuntime, 'runtime-new', 'retry must complete the rebind');
      assert.equal(ctx.currentRuntimeAgentId, 'runtime-new');
      assert.equal(shared.bindings.at(-1)[0], 'runtime-new');
    });
  });

  it('stops retrying after the bounded attempts when the successor never appears', async () => {
    await withRebindRecoveryCase({
      allAgents: [],
      fetchImpl: async () => ({ ok: true, json: async () => ({ unchanged: true }) }),
    }, async ({ ctx, shared }) => {
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
});
