/**
 * 接续换头重绑的接续窗口豁免（frontend-vm 沙箱）
 *
 * 真实事故时序（coder 自动接续，用户被踢出会话视图）：
 *   1. 退役旧 head runtime（remove-session flush）→ 前端 poll /responses 404
 *      → handleCoreResponsesNotFound 清 currentRuntimeAgentId 并切回
 *      workspace surface——_currentActiveSession() 从此 fallback 到宿主的
 *      main 会话，不再指向旧 head coder 会话；
 *   2. successor 上线早于 commit（advanceHead 才把 successor session 写进
 *      sessionChain）→ 侧栏锚定未命中，successor 以普通新条目蹦出；
 *   3. head-advanced SSE 到达，但 thread-store 的重绑前置要求
 *      current.sessionId === fromSessionId——被 404 清理破坏后必不满足，
 *      静默 return：重绑不发生（用户需手动点击 successor），且连
 *      refreshThreads 都不执行（threads 停留旧快照，侧栏虚条目残留）。
 *
 * 本测试锁定的语义：
 *   - R1 用户仍挂在该线程的会话视图（activeConversation.threadId 匹配）
 *     时，即使 runtime 态已被 404 清空，head-advanced 也必须完成重绑；
 *   - R2 用户已明确离开该线程（activeConversation.threadId 不匹配）时不
 *     强行拉回（守卫语义不扩大）；
 *   - R3 无论是否重绑，head-advanced 都要刷新线程事实与侧栏（虚条目收
 *     敛、successor 锚定不依赖用户选中状态）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

function unrefTimer(handle) { if (handle && typeof handle.unref === 'function') handle.unref(); return handle; }

function makeRebindSandbox({
  hostActiveSessionId = 'main-session',
  runtimeAgentIdBefore = 'runtime-old',
} = {}) {
  let eventHandler = null;
  const bindings = [];
  const loads = [];
  let renderAgentListCalls = 0;
  let refreshCalls = 0;

  const ctx = createFrontendSandbox({
    currentLanguage: 'zh',
    focusedAgentId: 'coder',
    currentRuntimeAgentId: runtimeAgentIdBefore,
    allAgents: [{
      id: 'runtime-new', source: 'child', parent_id: 'coder',
      sidebar_entry_id: 'coder', active_workspace_session_id: 'session-new',
      runtime_session_id: 'runtime-new',
    }],
    getCurrentHostAgentRecord: () => ({ id: 'coder', active_workspace_session_id: hostActiveSessionId }),
    getRuntimeWorkspaceSessionId: (runtimeId) => (runtimeId === 'runtime-old' ? 'session-old' : 'session-new'),
    getRuntimeContextKey: (runtimeId) => `host:programming-helper|session:${runtimeId === 'runtime-old' ? 'session-old' : 'session-new'}`,
    setViewerSessionBinding: (runtimeId, sessionId) => { bindings.push([runtimeId, sessionId]); },
    loadAgents: async () => {},
    loadAgentData: async (runtimeId) => { loads.push(runtimeId); },
    saveCurrentRuntimeToCache() {},
    _storeVisibleSessionInputDraft() {},
    resetRuntimeStatusForSwitch() {},
    setPendingChatScrollRestore() {},
    renderAgentList: () => { renderAgentListCalls += 1; },
    renderCurrentMainView() {},
    _lastRenderedChatSig: '',
    readOnlyMode: false,
    subscribeThreadEvents: null,
    setTimeout: (fn, ms) => unrefTimer(globalThis.setTimeout(fn, ms)),
    setInterval: (fn, ms) => unrefTimer(globalThis.setInterval(fn, ms)),
  });
  ctx.window.ClawFW = { SseClient: { subscribeThreadEvents: (id, handler) => {
    assert.equal(id, 'wt-viewed', 'subscription must target the viewed thread');
    eventHandler = handler;
    return () => {};
  } } };
  ctx.loadSource('public/src/modules/session-view-state.js'); // ADR-0026：thread-store 依赖会话视图提交原语
  ctx.loadSource('public/src/modules/thread-store.js');
  // refreshThreads 桩：第一次调用（订阅建立前）呈旧 head；此后 head 已推进。
  const installFacts = (headSessionId, sessionIds) => {
    ctx.window.refreshThreads = async () => {
      refreshCalls += 1;
      const thread = {
        threadId: 'wt-viewed', agentId: 'coder',
        headSessionId, sessionIds, lifeState: 'executing',
      };
      ctx.window.ClawThreads.threads = [thread];
      ctx.window.ClawThreads.byId['wt-viewed'] = thread;
      ctx.window.ClawThreads.sessionIndex['coder::session-old'] = thread;
      ctx.window.ClawThreads.sessionIndex['coder::session-new'] = thread;
    };
  };
  installFacts('session-old', ['session-old']);
  ctx.window.updateThreadHeaderIndicator = () => {};
  return {
    ctx, bindings, loads, get refreshCalls() { return refreshCalls; },
    get renderAgentListCalls() { return renderAgentListCalls; },
    get eventHandler() { return eventHandler; },
    installFacts,
  };
}

const HEAD_ADVANCED_EVENT = {
  type: 'thread.head-advanced', threadId: 'wt-viewed',
  payload: { fromSessionId: 'session-old', toSessionId: 'session-new', agentId: 'coder' },
};

describe('thread-store: head-advanced rebind across the succession gap', () => {
  it('rebinds to the successor even after the 404 cleanup cleared runtime state', async () => {
    const kit = makeRebindSandbox();
    // 订阅建立在正常态（用户在线程视图，runtime 绑定旧 head）。
    await kit.ctx.window.refreshThreads();
    kit.ctx.run('_syncActiveThreadSubscription()');
    assert.ok(kit.eventHandler, 'subscription should be established while viewing the thread');

    // 404 清理窗口：currentRuntimeAgentId 被清空，_currentActiveSession 落到
    // 宿主 main 会话；activeConversation 仍指向该线程（视图身份未变）。
    kit.ctx.run('currentRuntimeAgentId = null');

    kit.installFacts('session-new', ['session-old', 'session-new']);
    await kit.eventHandler(HEAD_ADVANCED_EVENT);

    assert.ok(kit.loads.includes('runtime-new'), 'successor runtime data must be loaded');
    assert.deepEqual(kit.bindings.at(-1), ['runtime-new', 'session-new']);
    assert.equal(kit.ctx.currentRuntimeAgentId, 'runtime-new');
    assert.equal(kit.ctx.window.ClawThreads.activeConversation.threadId, 'wt-viewed');
    assert.equal(kit.ctx.window.ClawThreads.activeConversation.sessionId, 'session-new');
    assert.equal(kit.ctx.window.ClawThreads.activeConversation.runtimeId, 'runtime-new');
    assert.equal(kit.ctx.focusedAgentId, 'coder');
  });

  it('keeps the thread subscription alive when runtime state is cleared by the 404 cleanup', async () => {
    const kit = makeRebindSandbox();
    await kit.ctx.window.refreshThreads();
    kit.ctx.run('_syncActiveThreadSubscription()');

    // 404 清理窗口：runtime 态被清空（_currentActiveSession 落到宿主 main
    // 会话）。activeConversation 仍指向该线程——这是「视图身份仍在、等待
    // 重绑」态，不是用户离开；订阅与线程指向必须保留，否则 handoff-started
    // 指示器延迟、head-advanced 重绑失效。
    kit.ctx.run('currentRuntimeAgentId = null');
    kit.ctx.run('_syncActiveThreadSubscription()');

    assert.equal(kit.ctx.window.ClawThreads.activeConversation.threadId, 'wt-viewed',
      'runtime 态清空不得拆除线程指向');
    assert.ok(kit.eventHandler, 'subscription must survive the 404 cleanup window');
  });

  it('does not pull the user back when they navigated to another thread', async () => {
    const kit = makeRebindSandbox();
    await kit.ctx.window.refreshThreads();
    kit.ctx.run('_syncActiveThreadSubscription()');
    assert.ok(kit.eventHandler);

    // 用户已明确离开：activeConversation 指向别的线程。
    kit.ctx.run(`window.ClawThreads.activeConversation = {
      agentId: 'coder', threadId: 'wt-other',
      sessionId: 'session-other', runtimeId: 'runtime-other',
    }`);
    kit.installFacts('session-new', ['session-old', 'session-new']);
    await kit.eventHandler(HEAD_ADVANCED_EVENT);

    assert.equal(kit.loads.length, 0, 'must not rebind when the user left this thread');
    assert.equal(kit.bindings.length, 0);
    assert.notEqual(kit.ctx.currentRuntimeAgentId, 'runtime-new');
    assert.equal(kit.ctx.window.ClawThreads.activeConversation.threadId, 'wt-other');
  });

  it('refreshes thread facts and the sidebar regardless of rebind', async () => {
    const kit = makeRebindSandbox();
    await kit.ctx.window.refreshThreads();
    kit.ctx.run('_syncActiveThreadSubscription()');
    assert.ok(kit.eventHandler);

    // 不重绑场景（用户已离开该线程）也必须刷新事实：侧栏虚条目收敛与
    // successor 锚定依赖 threads 快照推进，与用户选中状态无关。
    kit.ctx.run(`window.ClawThreads.activeConversation = {
      agentId: 'coder', threadId: 'wt-other',
      sessionId: 'session-other', runtimeId: 'runtime-other',
    }`);
    kit.installFacts('session-new', ['session-old', 'session-new']);
    const refreshBaseline = kit.refreshCalls;
    const renderBaseline = kit.renderAgentListCalls;
    await kit.eventHandler(HEAD_ADVANCED_EVENT);

    assert.ok(kit.refreshCalls > refreshBaseline, 'thread facts must refresh on head-advanced');
    assert.ok(kit.renderAgentListCalls > renderBaseline, 'sidebar must re-render on head-advanced');
  });
});
