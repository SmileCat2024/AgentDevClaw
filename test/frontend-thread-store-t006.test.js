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
