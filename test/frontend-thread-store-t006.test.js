import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

// thread-store.js 在模块加载时注册 2s 启动刷新 + 20s 周期刷新（未 unref），
// 若沿用 Node 全局定时器会让测试进程挂在事件循环上。注入 unref 版定时器，
// 使断言结束后进程可正常退出（后续 call 由桩 refreshThreads 短路）。
function unrefTimer(handle) { if (handle && typeof handle.unref === 'function') handle.unref(); return handle; }

function loadThreadStore({ refreshThreadsImpl = async () => null } = {}) {
  const ctx = createFrontendSandbox({
    currentLanguage: 'zh',
    getCurrentHostAgentRecord: () => null,
    setTimeout: (fn, ms) => unrefTimer(globalThis.setTimeout(fn, ms)),
    setInterval: (fn, ms) => unrefTimer(globalThis.setInterval(fn, ms)),
  });
  ctx.loadSource('public/src/modules/thread-store.js');
  // 模块在加载时自注册 window.refreshThreads / updateThreadHeaderIndicator；
  // 加载完成后用桩覆盖，隔离网络与 DOM 渲染（断言只针对状态机逻辑）。
  ctx.window.refreshThreads = refreshThreadsImpl;
  ctx.window.updateThreadHeaderIndicator = () => {};
  return ctx;
}

describe('thread-store: successor view rebind', () => {
  it('rebinds the viewed runtime to the successor without opening another session', async () => {
    let eventHandler;
    let loadAgentsCount = 0;
    let loadedRuntime = '';
    const ctx = createFrontendSandbox({
      currentLanguage: 'zh',
      focusedAgentId: 'coder',
      currentRuntimeAgentId: 'runtime-old',
      allAgents: [{
        id: 'runtime-new', source: 'child', parent_id: 'coder',
        active_workspace_session_id: 'session-new',
        runtime_session_id: 'runtime-new',
      }],
      getCurrentHostAgentRecord: () => ({ id: 'coder' }),
      getRuntimeWorkspaceSessionId: (runtimeId) => runtimeId === 'runtime-old' ? 'session-old' : 'session-new',
      getRuntimeContextKey: (runtimeId) => `host:coder|session:${runtimeId === 'runtime-old' ? 'session-old' : 'session-new'}`,
      setViewerSessionBinding: (runtimeId, sessionId) => { ctx.bindings.push([runtimeId, sessionId]); },
      loadAgents: async () => { loadAgentsCount += 1; },
      loadAgentData: async (runtimeId) => { loadedRuntime = runtimeId; },
      saveCurrentRuntimeToCache() {},
      _storeVisibleSessionInputDraft() {},
      resetRuntimeStatusForSwitch() {},
      setPendingChatScrollRestore() {},
      renderAgentList() {},
      renderCurrentMainView() {},
      _syncActiveThreadSubscription() {},
      _lastRenderedChatSig: '',
      readOnlyMode: false,
      subscribeThreadEvents: null,
      setTimeout: (fn, ms) => unrefTimer(globalThis.setTimeout(fn, ms)),
      setInterval: (fn, ms) => unrefTimer(globalThis.setInterval(fn, ms)),
    });
    ctx.bindings = [];
    ctx.window.ClawFW = { SseClient: { subscribeThreadEvents: (id, handler) => {
      assert.equal(id, 'wt-viewed');
      eventHandler = handler;
      return () => {};
    } } };
    ctx.loadSource('public/src/modules/thread-store.js');
    ctx.window.refreshThreads = async () => {
      const thread = {
        threadId: 'wt-viewed', agentId: 'coder',
        headSessionId: 'session-old', sessionIds: ['session-old'], lifeState: 'executing',
      };
      ctx.window.ClawThreads.threads = [thread];
      ctx.window.ClawThreads.byId['wt-viewed'] = thread;
      ctx.window.ClawThreads.sessionIndex['coder::session-old'] = thread;
    };
    ctx.window.updateThreadHeaderIndicator = () => {};
    let refreshCalls = 0;
    ctx.window.refreshThreads = async () => {
      refreshCalls += 1;
      const thread = {
        threadId: 'wt-viewed', agentId: 'coder',
        headSessionId: refreshCalls > 1 ? 'session-new' : 'session-old',
        sessionIds: refreshCalls > 1 ? ['session-old', 'session-new'] : ['session-old'],
        lifeState: 'executing',
      };
      ctx.window.ClawThreads.threads = [thread];
      ctx.window.ClawThreads.byId['wt-viewed'] = thread;
      ctx.window.ClawThreads.sessionIndex['coder::session-old'] = thread;
      ctx.window.ClawThreads.sessionIndex['coder::session-new'] = thread;
    };
    await ctx.window.refreshThreads();
    ctx.run('_syncActiveThreadSubscription()');
    await eventHandler({
      type: 'thread.head-advanced', threadId: 'wt-viewed',
      payload: { fromSessionId: 'session-old', toSessionId: 'session-new', agentId: 'coder' },
    });
    assert.equal(loadedRuntime, 'runtime-new');
    assert.deepEqual(ctx.bindings.at(-1), ['runtime-new', 'session-new']);
    assert.equal(ctx.currentRuntimeAgentId, 'runtime-new');
    assert.equal(ctx.window.ClawThreads.activeConversation.threadId, 'wt-viewed');
    assert.equal(ctx.window.ClawThreads.activeConversation.sessionId, 'session-new');
    assert.equal(ctx.window.ClawThreads.activeConversation.runtimeId, 'runtime-new');
    assert.equal(loadAgentsCount, 1);
    assert.equal(refreshCalls, 3);
  });
});

describe('thread-store: handoff-started visibility', () => {
  it('refreshes thread facts and the sidebar immediately, without rebinding the runtime', async () => {
    let eventHandler;
    let refreshCalls = 0;
    let renderCalls = 0;
    const ctx = createFrontendSandbox({
      currentLanguage: 'zh',
      focusedAgentId: 'coder',
      currentRuntimeAgentId: 'runtime-old',
      allAgents: [],
      getCurrentHostAgentRecord: () => ({ id: 'coder' }),
      getRuntimeWorkspaceSessionId: (runtimeId) => (runtimeId === 'runtime-old' ? 'session-old' : 'session-new'),
      setTimeout: (fn, ms) => unrefTimer(globalThis.setTimeout(fn, ms)),
      setInterval: (fn, ms) => unrefTimer(globalThis.setInterval(fn, ms)),
      renderAgentList() { renderCalls += 1; },
    });
    ctx.window.ClawFW = { SseClient: { subscribeThreadEvents: (id, handler) => {
      assert.equal(id, 'wt-viewed');
      eventHandler = handler;
      return () => {};
    } } };
    ctx.loadSource('public/src/modules/thread-store.js');
    const thread = {
      threadId: 'wt-viewed', agentId: 'coder',
      headSessionId: 'session-old', sessionIds: ['session-old'], lifeState: 'executing',
    };
    ctx.window.refreshThreads = async () => { refreshCalls += 1; };
    ctx.window.ClawThreads.threads = [thread];
    ctx.window.ClawThreads.byId['wt-viewed'] = thread;
    ctx.window.ClawThreads.sessionIndex['coder::session-old'] = thread;
    ctx.run('_syncActiveThreadSubscription()');

    await eventHandler({
      type: 'thread.handoff-started', threadId: 'wt-viewed',
      payload: { agentId: 'coder', fromSessionId: 'session-old', reason: 'trim' },
    });

    assert.equal(refreshCalls, 1);
    assert.equal(renderCalls, 1);
    // 只刷新状态，不触发换头重绑：runtime 绑定与活动会话保持原样
    assert.equal(ctx.currentRuntimeAgentId, 'runtime-old');
    assert.equal(ctx.window.ClawThreads.activeConversation.threadId, 'wt-viewed');
    assert.equal(ctx.window.ClawThreads.activeConversation.sessionId, 'session-old');
  });
});

describe('thread-store: stable thread conversation input', () => {
  it('opens a thread by its stable identity and current head runtime', async () => {
    let ctx;
    ctx = createFrontendSandbox({
      focusedAgentId: 'coder',
      currentRuntimeAgentId: 'runtime-old',
      getCurrentHostAgentRecord: () => ({ id: 'coder' }),
      getRuntimeWorkspaceSessionId: (runtimeId) => runtimeId === 'runtime-new' ? 'session-new' : 'session-old',
      setViewerSessionBinding: (runtimeId, sessionId) => { ctx.bindings.push([runtimeId, sessionId]); },
      allAgents: [{
        id: 'runtime-new', source: 'child', parent_id: 'coder',
        active_workspace_session_id: 'session-new', runtime_session_id: 'runtime-new',
      }],
      setTimeout: (fn, ms) => unrefTimer(globalThis.setTimeout(fn, ms)),
      setInterval: (fn, ms) => unrefTimer(globalThis.setInterval(fn, ms)),
    });
    ctx.bindings = [];
    ctx.window.switchAgent = async (runtimeId) => { ctx.currentRuntimeAgentId = runtimeId; };
    ctx.loadSource('public/src/modules/thread-store.js');
    const thread = {
      threadId: 'wt-open', agentId: 'coder', headSessionId: 'session-new',
      sessionIds: ['session-old', 'session-new'],
    };
    ctx.window.ClawThreads.threads = [thread];
    ctx.window.ClawThreads.byId[thread.threadId] = thread;
    ctx.window.ClawThreads.sessionIndex['coder::session-new'] = thread;
    const result = await ctx.window.openConversationTarget({ agentId: thread.agentId, threadId: thread.threadId });
    assert.equal(result.ok, true);
    assert.deepEqual(ctx.bindings.at(-1), ['runtime-new', 'session-new']);
    assert.equal(ctx.window.ClawThreads.activeConversation.threadId, 'wt-open');
    assert.equal(ctx.window.ClawThreads.activeConversation.sessionId, 'session-new');
  });

  it('posts to the thread input endpoint without resolving a session or runtime target', async () => {
    const requests = [];
    const ctx = createFrontendSandbox({
      fetch: async (url, init) => {
        requests.push({ url, init });
        return { ok: true, json: async () => ({ ok: true, threadId: 'wt-input', delivery: 'delivered' }) };
      },
      setTimeout: (fn, ms) => unrefTimer(globalThis.setTimeout(fn, ms)),
      setInterval: (fn, ms) => unrefTimer(globalThis.setInterval(fn, ms)),
    });
    ctx.loadSource('public/src/modules/thread-store.js');
    const result = await ctx.window.submitThreadInput('wt-input', {
      text: 'continue', images: [{ id: 'img-1' }], source: 'chat-composer',
      capabilityActivations: ['skill-x'], metadata: { note: 1 },
    });
    assert.equal(result.delivery, 'delivered');
    assert.equal(requests[0].url, '/protoclaw/threads/wt-input/input');
    const body = JSON.parse(requests[0].init.body);
    assert.equal(body.text, 'continue');
    assert.deepEqual(body.images, [{ id: 'img-1' }]);
    assert.deepEqual(body.capabilityActivations, ['skill-x']);
    assert.deepEqual(body.metadata, { note: 1 });
  });
});

describe('T006 thread-store: Session→Thread 目标登记与只读事实', () => {
  it('历史成员 activate（browseOnly:true + target 为 thread）置位只读事实', () => {
    const ctx = loadThreadStore();
    ctx.run(`window.registerSessionActivateTarget({
      browseOnly: true,
      target: { type: 'thread', threadId: 'wt-9', headSessionId: 's-2' },
    })`);
    assert.equal(ctx.run(`window.ClawThreads.browseOnly`), true);
    assert.equal(ctx.run(`window.ClawThreads.browseOnlyThreadId`), 'wt-9');
  });

  it('打开/创建 head（browseOnly 缺失）清除历史残留只读事实', () => {
    const ctx = loadThreadStore();
    ctx.run(`window.ClawThreads.browseOnly = true; window.ClawThreads.browseOnlyThreadId = 'wt-9';`);
    ctx.run(`window.registerSessionActivateTarget({ target: { type: 'thread', threadId: 'wt-9', headSessionId: 's-3' } })`);
    assert.equal(ctx.run(`window.ClawThreads.browseOnly`), false);
    assert.equal(ctx.run(`window.ClawThreads.browseOnlyThreadId`), '');
  });

  it('Session 入口返回 Thread 时刷新 Thread（而非只刷 Session）', () => {
    let refreshes = 0;
    const ctx = loadThreadStore({ refreshThreadsImpl: async () => { refreshes += 1; return null; } });
    ctx.run(`window.registerSessionActivateTarget({ target: { type: 'thread', threadId: 'wt-1', headSessionId: 's-2' } })`);
    // refreshThreads 是异步触发；同步返回后此处已调用
    assert.equal(refreshes, 1);
  });

  it('非 Thread 的普通 Session activate 不触发线程刷新', () => {
    let refreshes = 0;
    const ctx = loadThreadStore({ refreshThreadsImpl: async () => { refreshes += 1; return null; } });
    ctx.run(`window.registerSessionActivateTarget({ session: { id: 's-1' } })`);
    assert.equal(refreshes, 0);
  });
});

// T014b：wasHead 冻结事实（ADR-0024 接续零感知）。app-main 的 404 等待重绑
// 豁免以 activeConversation.wasHead 为前提——冻结时视图挂在 head 上，此后
// head 被 successor 接管才进入豁免窗口；历史成员浏览冻结时即非 head，不占
// 用接续语义（保持原 404 踢出）。
describe('T014b thread-store: wasHead 冻结事实写入', () => {
  function baseSandbox(overrides = {}) {
    const ctx = createFrontendSandbox({
      currentLanguage: 'zh',
      focusedAgentId: 'coder',
      currentRuntimeAgentId: 'runtime-old',
      getCurrentHostAgentRecord: () => ({ id: 'coder' }),
      getRuntimeWorkspaceSessionId: (runtimeId) => (runtimeId === 'runtime-old' ? 'session-old' : 'session-other'),
      setTimeout: (fn, ms) => unrefTimer(globalThis.setTimeout(fn, ms)),
      setInterval: (fn, ms) => unrefTimer(globalThis.setInterval(fn, ms)),
      ...overrides,
    });
    ctx.loadSource('public/src/modules/thread-store.js');
    ctx.window.refreshThreads = async () => {};
    ctx.window.updateThreadHeaderIndicator = () => {};
    return ctx;
  }

  function installThread(ctx, { headSessionId = 'session-old', sessionIds = ['session-old'] } = {}) {
    const thread = { threadId: 'wt-was', agentId: 'coder', headSessionId, sessionIds };
    ctx.window.ClawThreads.threads = [thread];
    ctx.window.ClawThreads.byId[thread.threadId] = thread;
    for (const sid of sessionIds) ctx.window.ClawThreads.sessionIndex[`coder::${sid}`] = thread;
    return thread;
  }

  it('视图冻结在 head 上（runtime 绑定 = headSessionId）→ wasHead=true', () => {
    const ctx = baseSandbox();
    installThread(ctx);
    ctx.run('_syncActiveThreadSubscription()');
    const conversation = ctx.window.ClawThreads.activeConversation;
    assert.equal(conversation.threadId, 'wt-was');
    assert.equal(conversation.sessionId, 'session-old');
    assert.equal(conversation.wasHead, true);
  });

  it('浏览历史成员（runtime 绑定 ≠ headSessionId）→ wasHead=false', () => {
    const ctx = baseSandbox();
    installThread(ctx, { headSessionId: 'session-new', sessionIds: ['session-old', 'session-new'] });
    ctx.run('_syncActiveThreadSubscription()');
    const conversation = ctx.window.ClawThreads.activeConversation;
    assert.equal(conversation.sessionId, 'session-old');
    assert.equal(conversation.wasHead, false, '历史成员冻结不得占用等待重绑豁免资格');
  });

  it('handoff 窗口本地挂线程等待视图（openConversationTarget）→ wasHead=true', async () => {
    const ctx = baseSandbox({ currentRuntimeAgentId: '' });
    const thread = installThread(ctx);
    thread.handoffStartedAt = Date.now();
    ctx.window.switchAgent = async () => {};
    const result = await ctx.window.openConversationTarget({ agentId: 'coder', threadId: 'wt-was' });
    assert.equal(result.ok, true);
    assert.equal(ctx.window.ClawThreads.activeConversation.wasHead, true,
      '接续中点击条目的本地等待视图必须保住等待重绑资格');
  });

  it('head-advanced 重绑落定后 → wasHead=true（新 head 冻结）', async () => {
    let eventHandler;
    const ctx = createFrontendSandbox({
      currentLanguage: 'zh',
      focusedAgentId: 'coder',
      currentRuntimeAgentId: 'runtime-old',
      allAgents: [{
        id: 'runtime-new', source: 'child', parent_id: 'coder',
        active_workspace_session_id: 'session-new', runtime_session_id: 'runtime-new',
      }],
      getCurrentHostAgentRecord: () => ({ id: 'coder' }),
      getRuntimeWorkspaceSessionId: (runtimeId) => (runtimeId === 'runtime-old' ? 'session-old' : 'session-new'),
      getRuntimeContextKey: (runtimeId) => `host:coder|session:${runtimeId === 'runtime-old' ? 'session-old' : 'session-new'}`,
      setViewerSessionBinding: () => {},
      loadAgents: async () => {},
      loadAgentData: async () => {},
      saveCurrentRuntimeToCache() {},
      _storeVisibleSessionInputDraft() {},
      resetRuntimeStatusForSwitch() {},
      setPendingChatScrollRestore() {},
      renderAgentList() {},
      _syncActiveThreadSubscription() {},
      _lastRenderedChatSig: '',
      readOnlyMode: false,
      setTimeout: (fn, ms) => unrefTimer(globalThis.setTimeout(fn, ms)),
      setInterval: (fn, ms) => unrefTimer(globalThis.setInterval(fn, ms)),
    });
    ctx.window.ClawFW = { SseClient: { subscribeThreadEvents: (id, handler) => {
      eventHandler = handler;
      return () => {};
    } } };
    ctx.loadSource('public/src/modules/thread-store.js');
    ctx.window.refreshThreads = async () => {
      const thread = {
        threadId: 'wt-was', agentId: 'coder',
        headSessionId: 'session-new', sessionIds: ['session-old', 'session-new'],
      };
      ctx.window.ClawThreads.threads = [thread];
      ctx.window.ClawThreads.byId['wt-was'] = thread;
      ctx.window.ClawThreads.sessionIndex['coder::session-old'] = thread;
      ctx.window.ClawThreads.sessionIndex['coder::session-new'] = thread;
    };
    ctx.window.updateThreadHeaderIndicator = () => {};
    await ctx.window.refreshThreads();
    ctx.run('_syncActiveThreadSubscription()');
    await eventHandler({
      type: 'thread.head-advanced', threadId: 'wt-was',
      payload: { fromSessionId: 'session-old', toSessionId: 'session-new', agentId: 'coder' },
    });
    const conversation = ctx.window.ClawThreads.activeConversation;
    assert.equal(conversation.sessionId, 'session-new');
    assert.equal(conversation.runtimeId, 'runtime-new');
    assert.equal(conversation.wasHead, true, '重绑目标是新 head，冻结资格延续');
  });
});

// T014c：事实对账重绑（ADR-0024 接续零感知）。SSE head-advanced 只是加速
// 信号；事件丢失（断连 / 后台标签）时 threads 轮询拉到 head 已推进的快照即
// 是重绑的正当时刻——refreshThreads 收尾对账驱动 _rebindConversationToThreadHead
// 唯一实现原地换绑。不依赖任何事件或独立触发器。
describe('T014c thread-store: 事实对账重绑（SSE 丢帧自愈）', () => {
  it('不发事件，threads 轮询推进快照后原地重绑到新 head', async () => {
    let loadedRuntime = '';
    let threadsFetchCount = 0;
    const ctx = createFrontendSandbox({
      currentLanguage: 'zh',
      focusedAgentId: 'coder',
      currentRuntimeAgentId: 'runtime-old',
      getCurrentHostAgentRecord: () => ({ id: 'coder' }),
      getRuntimeWorkspaceSessionId: (runtimeId) => (runtimeId === 'runtime-old' ? 'session-old' : 'session-new'),
      getRuntimeContextKey: (runtimeId) => `host:coder|session:${runtimeId === 'runtime-old' ? 'session-old' : 'session-new'}`,
      setViewerSessionBinding: (runtimeId, sessionId) => { ctx.bindings.push([runtimeId, sessionId]); },
      loadAgents: async () => {},
      loadAgentData: async (runtimeId) => { loadedRuntime = runtimeId; },
      saveCurrentRuntimeToCache() {},
      _storeVisibleSessionInputDraft() {},
      resetRuntimeStatusForSwitch() {},
      setPendingChatScrollRestore() {},
      renderAgentList() {},
      _lastRenderedChatSig: '',
      readOnlyMode: false,
      fetch: async () => {
        threadsFetchCount += 1;
        // 第一次拉取：旧 head 稳态（建立视图冻结）；此后拉取：head 已推进
        // （模拟服务端 advanceHead 落定后、SSE 事件丢失的轮询发现）。
        const advanced = threadsFetchCount > 1;
        const thread = {
          threadId: 'wt-recon', agentId: 'coder',
          headSessionId: advanced ? 'session-new' : 'session-old',
          sessionIds: ['session-old', 'session-new'],
          status: 'open',
        };
        return { ok: true, json: async () => ({ threads: [thread], contentHash: `h${threadsFetchCount}` }) };
      },
      setTimeout: (fn, ms) => unrefTimer(globalThis.setTimeout(fn, ms)),
      setInterval: (fn, ms) => unrefTimer(globalThis.setInterval(fn, ms)),
    });
    ctx.bindings = [];
    ctx.allAgents = [{
      id: 'runtime-new', source: 'child', parent_id: 'coder',
      active_workspace_session_id: 'session-new', runtime_session_id: 'runtime-new',
    }];
    ctx.loadSource('public/src/modules/thread-store.js');
    ctx.window.updateThreadHeaderIndicator = () => {};

    // 第一拍：稳态快照，视图冻结在旧 head（wasHead=true）
    await ctx.window.refreshThreads(true);
    ctx.run('_syncActiveThreadSubscription()');
    let conversation = ctx.window.ClawThreads.activeConversation;
    assert.equal(conversation.sessionId, 'session-old');
    assert.equal(conversation.wasHead, true);

    // 第二拍：无任何 SSE 事件，轮询推进快照 → 收尾对账原地重绑
    await ctx.window.refreshThreads(true);
    conversation = ctx.window.ClawThreads.activeConversation;
    assert.equal(conversation.sessionId, 'session-new', '对账后视图身份应换到新 head');
    assert.equal(conversation.runtimeId, 'runtime-new');
    assert.equal(conversation.wasHead, true);
    assert.equal(ctx.currentRuntimeAgentId, 'runtime-new');
    assert.equal(loadedRuntime, 'runtime-new', '重绑后应加载新 runtime 数据');
    assert.deepEqual(ctx.bindings.at(-1), ['runtime-new', 'session-new']);
  });

  it('wasHead=false（历史成员浏览）时快照推进不触发重绑（不静默跳转）', async () => {
    let threadsFetchCount = 0;
    let loadedRuntime = '';
    const ctx = createFrontendSandbox({
      currentLanguage: 'zh',
      focusedAgentId: 'coder',
      currentRuntimeAgentId: 'runtime-old',
      getCurrentHostAgentRecord: () => ({ id: 'coder' }),
      getRuntimeWorkspaceSessionId: () => 'session-history',
      setViewerSessionBinding: () => {},
      loadAgents: async () => {},
      loadAgentData: async (runtimeId) => { loadedRuntime = runtimeId; },
      resetRuntimeStatusForSwitch() {},
      setPendingChatScrollRestore() {},
      renderAgentList() {},
      setTimeout: (fn, ms) => unrefTimer(globalThis.setTimeout(fn, ms)),
      setInterval: (fn, ms) => unrefTimer(globalThis.setInterval(fn, ms)),
      fetch: async () => {
        threadsFetchCount += 1;
        const thread = {
          threadId: 'wt-hist', agentId: 'coder',
          headSessionId: threadsFetchCount > 1 ? 'session-new' : 'session-old',
          sessionIds: ['session-history', 'session-old', 'session-new'],
          status: 'open',
        };
        return { ok: true, json: async () => ({ threads: [thread], contentHash: `h${threadsFetchCount}` }) };
      },
    });
    ctx.loadSource('public/src/modules/thread-store.js');
    ctx.window.updateThreadHeaderIndicator = () => {};

    // 注意：_syncActiveThreadSubscription 的既有行为会把挂在本线程的记账
    // sessionId 对齐 head（不动视图）。判断「是否被拉走」看 runtime 态与
    // 数据加载，不看记账字段漂移。
    await ctx.window.refreshThreads(true);
    ctx.run('_syncActiveThreadSubscription()');
    assert.equal(ctx.window.ClawThreads.activeConversation.threadId, 'wt-hist');

    await ctx.window.refreshThreads(true);
    assert.equal(ctx.currentRuntimeAgentId, 'runtime-old', '历史成员浏览不得被对账拉走');
    assert.equal(loadedRuntime, '', '不得加载新 runtime 数据（无静默跳转）');
    assert.equal(threadsFetchCount, 2);
  });
});
