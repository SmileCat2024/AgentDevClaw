/**
 * 接续换头重绑的接续窗口豁免（真实 ESM 图）
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
 *
 * 装载路线（P4 T3）：刷新引擎 thread-store.js 已是真实 ESM，走 withP2EsmCase
 * 的 `c.load`（每 case 一张图，模块级状态不跨用例）；引擎内部的订阅同步 /
 * 重绑等私有操作经命名导出取用，不再有 window 面。
 * 沙箱仍是最小夹具（不装整条 classic 链）：状态键按 app-core 的注册面显式
 * 上桥，引擎的 ESM 活绑定与沙箱属性因此是同一份真相。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { IDENTITY_DOMAIN, prepareEsmModules, SESSION_VIEW_DOMAIN } from './p2-classic-hosts.js';

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

function makeFixture({
  hostActiveSessionId = 'main-session',
  runtimeAgentIdBefore = 'runtime-old',
} = {}) {
  const counters = {
    loads: [],
    renderAgentListCalls: 0,
    threadFetchCalls: 0,
    migratedImages: [],
    dismissedToasts: [],
  };
  let eventHandler = null;
  return {
    counters,
    setEventHandler(handler) { eventHandler = handler; },
    getEventHandler() { return eventHandler; },
    globals: {
      currentLanguage: 'zh',
      focusedAgentId: 'coder',
      currentRuntimeAgentId: runtimeAgentIdBefore,
      allAgents: [{
        id: 'runtime-new', source: 'child', parent_id: 'coder',
        sidebar_entry_id: 'coder', active_workspace_session_id: 'session-new',
        runtime_session_id: 'runtime-new',
      }],
      getCurrentHostAgentRecord: () => ({ id: 'coder', active_workspace_session_id: hostActiveSessionId }),
      loadAgents: async () => {},
      loadAgentData: async (runtimeId) => { counters.loads.push(runtimeId); },
      saveCurrentRuntimeToCache() {},
      _storeVisibleSessionInputDraft() {},
      resetRuntimeStatusForSwitch() {},
      setPendingChatScrollRestore() {},
      renderAgentList: () => { counters.renderAgentListCalls += 1; },
      renderCurrentMainView() {},
      _lastRenderedChatSig: '',
      readOnlyMode: false,
      ClawToast: { dismiss: (id) => counters.dismissedToasts.push(id) },
      SessionReference: { activeKey: () => 'runtime-old::session-old' },
      migratePendingInputImages: (from, to) => counters.migratedImages.push([from, to]),
      ClawFW: { SseClient: { subscribeThreadEvents: (id, handler) => {
        assert.equal(id, '*', 'sidebar and viewed-thread discovery share a bounded subscription');
        eventHandler = handler;
        return () => {};
      } } },
      // 引擎是 ESM（裸 `fetch` 走主 realm）：线程事实拉取计数（R3 观察面），
      // 其余端点按「服务端不可达」回答（引擎静默保持缓存现状）。
      fetch: async (url) => {
        if (String(url).startsWith('/protoclaw/threads')) counters.threadFetchCalls += 1;
        return { ok: false, status: 0, json: async () => ({}) };
      },
    },
  };
}

/** 一个用例 = 一份最小经典夹具 + 一张真实 ESM 图（引擎为唯一被测实现）。 */
async function withRebindCase(options, probe) {
  const fixture = makeFixture(options);
  return withP2EsmCase({
    label: 'thread-succession-rebind',
    classic: (sandbox) => {
      // 生产桥键（app-core 的注册面）最小等价。
      for (const [key, domain] of Object.entries(STATE_DOMAINS)) {
        sandbox.KernelState.defineKey(domain, key, sandbox[key]);
      }
      // thread-store 的会话视图提交原语依赖（ADR-0026）。
      prepareEsmModules(sandbox, [...IDENTITY_DOMAIN, ...SESSION_VIEW_DOMAIN]);
    },
    globals: fixture.globals,
  }, async (c) => {
    const engine = await c.load(THREAD_ENGINE);
    const ctx = c.window;
    // 线程事实：直接写入引擎状态（引擎状态就是唯一的 ClawThreads 对象）。
    const installFacts = (headSessionId, sessionIds) => {
      const thread = {
        threadId: 'wt-viewed', agentId: 'coder',
        headSessionId, sessionIds, lifeState: 'executing',
      };
      const state = ctx.ClawThreads;
      state.threads = [thread];
      state.byId['wt-viewed'] = thread;
      state.sessionIndex['coder::session-old'] = thread;
      state.sessionIndex['coder::session-new'] = thread;
    };
    installFacts('session-old', ['session-old']);
    // 会话身份（P4 T1：identity 域 owner）：冻结在旧 head 上的 viewer 绑定
    fixture.identity = await c.load('public/src/modules/identity.js');
    fixture.identity.setViewerSessionBinding('runtime-old', 'session-old');
    return probe({
      c,
      ctx,
      engine,
      // 可变计数用 getter 读实时值（展开会拍成快照）。
      // 会话绑定写点（P4 T1：owner 是 identity 域）：读真实绑定而不是桩的调用记录
      get identity() { return fixture.identity; },
      get loads() { return fixture.counters.loads; },
      get migratedImages() { return fixture.counters.migratedImages; },
      get dismissedToasts() { return fixture.counters.dismissedToasts; },
      get renderAgentListCalls() { return fixture.counters.renderAgentListCalls; },
      get threadFetchCalls() { return fixture.counters.threadFetchCalls; },
      get eventHandler() { return fixture.getEventHandler(); },
      installFacts,
    });
  });
}

const HEAD_ADVANCED_EVENT = {
  type: 'thread.head-advanced', threadId: 'wt-viewed',
  payload: { fromSessionId: 'session-old', toSessionId: 'session-new', agentId: 'coder' },
};

describe('thread-store: head-advanced rebind across the succession gap', () => {
  it('rebinds to the successor even after the 404 cleanup cleared runtime state', () => withRebindCase({}, async (kit) => {
    // 订阅建立在正常态（用户在线程视图，runtime 绑定旧 head）。
    await kit.ctx.window.refreshThreads();
    kit.engine._syncActiveThreadSubscription();
    assert.ok(kit.eventHandler, 'subscription should be established while viewing the thread');

    // 404 清理窗口：currentRuntimeAgentId 被清空，_currentActiveSession 落到
    // 宿主 main 会话；activeConversation 仍指向该线程（视图身份未变）。
    kit.ctx.run('currentRuntimeAgentId = null');

    kit.installFacts('session-new', ['session-old', 'session-new']);
    await kit.eventHandler(HEAD_ADVANCED_EVENT);

    assert.ok(kit.loads.includes('runtime-new'), 'successor runtime data must be loaded');
    assert.equal(kit.identity.getViewerSessionBinding('runtime-new'), 'session-new',
      'successor runtime 的 viewer 绑定已建立');
    assert.equal(kit.ctx.currentRuntimeAgentId, 'runtime-new');
    assert.equal(kit.ctx.window.ClawThreads.activeConversation.threadId, 'wt-viewed');
    assert.equal(kit.ctx.window.ClawThreads.activeConversation.sessionId, 'session-new');
    assert.equal(kit.ctx.window.ClawThreads.activeConversation.runtimeId, 'runtime-new');
    assert.equal(kit.ctx.focusedAgentId, 'coder');
    assert.deepEqual(kit.migratedImages, [['runtime-old::session-old', 'runtime-new::session-new']],
      'unsent attachments must follow the viewed thread to its successor session');
    assert.deepEqual(kit.dismissedToasts, ['thread-staged-input-wt-viewed', 'thread-staged-gw-runtime-old'],
      'a pending-input notice must close when the successor becomes the active conversation');
  }));

  it('keeps the thread subscription alive when runtime state is cleared by the 404 cleanup', () => withRebindCase({}, async (kit) => {
    await kit.ctx.window.refreshThreads();
    kit.engine._syncActiveThreadSubscription();

    // 404 清理窗口：runtime 态被清空（_currentActiveSession 落到宿主 main
    // 会话）。activeConversation 仍指向该线程——这是「视图身份仍在、等待
    // 重绑」态，不是用户离开；订阅与线程指向必须保留，否则 handoff-started
    // 指示器延迟、head-advanced 重绑失效。
    kit.ctx.run('currentRuntimeAgentId = null');
    kit.engine._syncActiveThreadSubscription();

    assert.equal(kit.ctx.window.ClawThreads.activeConversation.threadId, 'wt-viewed',
      'runtime 态清空不得拆除线程指向');
    assert.ok(kit.eventHandler, 'subscription must survive the 404 cleanup window');
  }));

  it('does not pull the user back when they navigated to another thread', () => withRebindCase({}, async (kit) => {
    await kit.ctx.window.refreshThreads();
    kit.engine._syncActiveThreadSubscription();
    assert.ok(kit.eventHandler);

    // 用户已明确离开：activeConversation 指向别的线程。
    kit.ctx.run(`window.ClawThreads.activeConversation = {
      agentId: 'coder', threadId: 'wt-other',
      sessionId: 'session-other', runtimeId: 'runtime-other',
    }`);
    kit.installFacts('session-new', ['session-old', 'session-new']);
    await kit.eventHandler(HEAD_ADVANCED_EVENT);

    assert.equal(kit.loads.length, 0, 'must not rebind when the user left this thread');
    assert.equal(kit.identity.getViewerSessionBinding('runtime-new'), '',
      '用户已离开该线程：不得建立 successor 绑定');
    assert.notEqual(kit.ctx.currentRuntimeAgentId, 'runtime-new');
    assert.equal(kit.ctx.window.ClawThreads.activeConversation.threadId, 'wt-other');
  }));

  it('refreshes thread facts and the sidebar regardless of rebind', () => withRebindCase({}, async (kit) => {
    await kit.ctx.window.refreshThreads();
    kit.engine._syncActiveThreadSubscription();
    assert.ok(kit.eventHandler);

    // 不重绑场景（用户已离开该线程）也必须刷新事实：侧栏虚条目收敛与
    // successor 锚定依赖 threads 快照推进，与用户选中状态无关。
    kit.ctx.run(`window.ClawThreads.activeConversation = {
      agentId: 'coder', threadId: 'wt-other',
      sessionId: 'session-other', runtimeId: 'runtime-other',
    }`);
    kit.installFacts('session-new', ['session-old', 'session-new']);
    const refreshBaseline = kit.threadFetchCalls;
    const renderBaseline = kit.renderAgentListCalls;
    await kit.eventHandler(HEAD_ADVANCED_EVENT);

    assert.ok(kit.threadFetchCalls > refreshBaseline, 'thread facts must refresh on head-advanced');
    assert.ok(kit.renderAgentListCalls > renderBaseline, 'sidebar must re-render on head-advanced');
  }));
});
