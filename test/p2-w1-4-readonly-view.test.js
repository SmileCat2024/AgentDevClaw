/**
 * session-readonly-view.js 真实行为（P2 W1-4）。
 *
 * 该模块已迁 ESM：状态经 agent-store / orchestration / render-entry 的
 * setter 落定，已迁宿主能力（session-view-commit / runtime-view-cache /
 * chat-loading）走真实依赖，仍为 classic 的同步视图事务与渲染以 window 桩
 * 观察。覆盖 ADR-0026 的
 * 只读视图不变量：身份冻结在目标 Session 上、runtime 置空、只读标记、
 * 导航代次过期丢弃、关闭释放。
 *
 * 原 vm 沙箱文件（frontend-session-readonly-view.test.js）不在本批授权范围，
 * 由本文件以真实 import 路线接管其核心断言。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserStubs, loadModuleOnce } from './helpers/esm-module-loader.js';

let cleanupGlobals = null;
let readonlyView = null;
let agentStore = null;
let orchestration = null;
let renderEntry = null;
let i18n = null;
let identityState = null;
let chatLoading = null;
let calls = null;
const elements = new Map();
const runtimeCache = new Map();

/* 真实宿主适配器的依赖桩：只读视图 import 会话提交、视图缓存与 chat-loading
 * 三个已迁宿主，它们在装载期经 window.createXHost() 取 classic 适配面。 */
function installHostFactories() {
  window.createSessionViewCommitHost = () => ({
    identity: () => calls.identity,
    read: () => calls.view,
    apply: (patch) => { calls.applied.push(patch); },
    normalizeModel: (value) => value || {},
  });
  window.createRuntimeViewCacheHost = () => ({
    cache: runtimeCache,
    capacity: 20,
    contextKey: (runtimeId) => `ctx:${runtimeId}`,
    readView: () => calls.view,
    signatures: () => ({}),
    todoSignature: (plan) => JSON.stringify(plan || {}),
    emptyTodo: () => ({}),
    followLatest: () => false,
    captureAnchor: () => null,
    scrollTop: () => 0,
    activeCollapseContext: () => '',
    forgetContext() {},
    activateCollapse() {},
    normalizeIdentity: (identity) => identity,
    patch: (patch) => { calls.applied.push(patch); },
    setRestoredScrollTop() {},
    restoreAnchor() {},
    updatePlanBadge() {},
  });
}
const threads = { browseOnly: true, browseOnlyThreadId: 'wt-stale', activeConversation: { stale: true } };

function makeElement() {
  return {
    id: '',
    className: '',
    title: '',
    textContent: '',
    parentNode: null,
    remove() { this.parentNode = null; calls.indicatorRemoved += 1; },
  };
}

before(async () => {
  cleanupGlobals = installBrowserStubs({
    window: {
      escapeHtml: (text) => String(text),
      ClawFW: { actions: { registerMany() {} } },
      setTimeout: (callback, delay) => setTimeout(callback, delay),
      clearTimeout: (id) => clearTimeout(id),
    },
    document: {
      getElementById(id) {
        if (id === 'chat-context-bar') return { parentElement: { insertBefore(el) { calls.indicatorInserted = el; } } };
        return elements.get(id) || null;
      },
      createElement: () => makeElement(),
    },
  });
  await loadModuleOnce('public/src/modules/kernel-state.js', { installGlobals: false });
  installHostFactories();
  agentStore = await import('../public/src/modules/agent-store-state.js');
  orchestration = await import('../public/src/modules/orchestration-state.js');
  renderEntry = await import('../public/src/modules/render-entry-state.js');
  i18n = await import('../public/src/modules/i18n-environment-state.js');
  identityState = await import('../public/src/modules/session-view-identity-state.js');
  chatLoading = await import('../public/src/modules/chat-loading-host.js');
  // toast 已是 ESM 依赖：替换真实 ClawToast 的 show 接口观察通知（同一实例）
  const { ClawToast } = await import('../public/src/modules/toast-notify.js');
  ClawToast.show = (payload) => calls?.toasts.push(payload);
  const loaded = await loadModuleOnce('public/src/modules/session-readonly-view.js', { installGlobals: false });
  readonlyView = loaded.module;
});

after(() => { cleanupGlobals(); });

function reset() {
  calls = {
    patches: [], applied: [], tokens: [], toasts: [], cacheSaves: [], identity: null, view: {},
    navGuard: 0, renders: 0, listRenders: 0, beginLoading: 0, clearLoading: 0,
    scrollSaves: 0, draftStores: 0, statusResets: 0, threadSyncs: 0, headerUpdates: 0,
    indicatorInserted: null, indicatorRemoved: 0,
  };
  Object.assign(window, {
    bumpNavigationGuard: () => {
      calls.navGuard += 1;
      orchestration.setNavigationGuardEpoch(orchestration._navigationGuardEpoch + 1);
    },
    applySessionViewPatch: (patch) => {
      calls.patches.push(patch);
      if (patch?.identity) calls.identity = patch.identity;
    },
    // classic 适配器语义的最小复刻：token 取自实时身份与版本计数。
    captureSessionViewToken: (runtimeId, identity) => {
      calls.tokens.push(identity);
      return {
        runtimeId: runtimeId ?? '',
        identity,
        switchEpoch: orchestration._switchEpoch,
        generation: identityState._sessionViewGeneration,
        inputRequestsRevision: identityState._sessionViewInputRequestsRevision,
        messagesRevision: identityState._sessionViewMessagesRevision,
      };
    },
    getRuntimeContextKey: (runtimeId) => `ctx:${runtimeId}`,
    saveCurrentWorkspaceSurfaceScroll: () => { calls.scrollSaves += 1; },
    _storeVisibleSessionInputDraft: () => { calls.draftStores += 1; },
    beginChatLoadingSession: () => { calls.beginLoading += 1; },
    clearChatLoadingSession: () => { calls.clearLoading += 1; },
    resetRuntimeStatusForSwitch: () => { calls.statusResets += 1; },
    renderAgentList: () => { calls.listRenders += 1; },
    renderCurrentMainView: () => { calls.renders += 1; },
    _syncActiveThreadSubscription: () => { calls.threadSyncs += 1; },
    updateThreadHeaderIndicator: () => { calls.headerUpdates += 1; },
    isChatSurfaceActive: () => true,
    getThreadForSession: (agentId, sessionId) => ({ threadId: `wt-${sessionId}` }),
    ClawThreads: threads,
  });
  i18n.setCurrentLanguage('zh');
  orchestration.setNavigationGuardEpoch(0);
  orchestration.setSwitchEpoch(0);
  chatLoading.clearChatLoadingSession();
  runtimeCache.clear();
  agentStore.setFocusedAgentId(null);
  orchestration.setCurrentRuntimeAgentId(null);
  agentStore.setReadOnlyMode(false);
  renderEntry.setCurrentWorkspaceTab('home');
  // 模块级只读状态与指示器元素跨例共享：先关闭，再落本例的线程事实。
  readonlyView.closeReadOnlySession();
  calls.indicatorRemoved = 0;
  calls.indicatorInserted = null;
  threads.activeConversation = { stale: true };
  threads.browseOnly = true;
  threads.browseOnlyThreadId = 'wt-stale';
}

const recordFetch = (payload) => async () => ({ ok: true, json: async () => payload });

test('openReadOnlySession freezes the view on the archived Session record', async () => {
  reset();
  globalThis.fetch = recordFetch({
    messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }],
    timestamps: [11, 12],
    archived: true,
  });

  orchestration.setCurrentRuntimeAgentId('rt-old');
  const result = await readonlyView.openReadOnlySession({ agentId: 'programming-helper', sessionId: 's1' });

  assert.deepEqual(result, { ok: true });
  assert.equal(runtimeCache.has('ctx:rt-old'), true, '离开存活 runtime 前先把视图写入缓存');
  assert.equal(agentStore.focusedAgentId, 'programming-helper');
  assert.equal(orchestration.currentRuntimeAgentId, null, '只读视图不持有 runtime');
  assert.equal(agentStore.readOnlyMode, true);
  assert.equal(renderEntry.currentWorkspaceTab, 'chat');
  assert.deepEqual(calls.patches[0], { identity: { agentId: 'programming-helper', sessionId: 's1' } });
  assert.deepEqual(threads.activeConversation, {
    agentId: 'programming-helper',
    threadId: 'wt-s1',
    sessionId: 's1',
    runtimeId: '',
    wasHead: false,
    readOnly: true,
  });
  assert.equal(threads.browseOnly, false);
  assert.equal(threads.browseOnlyThreadId, '');
  assert.equal(calls.applied.length, 1, 'record 经真实 token 事务提交');
  assert.deepEqual(calls.applied[0].messages, [
    { role: 'user', content: 'hi', _ts: 11 },
    { role: 'assistant', content: 'hello', _ts: 12 },
  ], '真实 attachMessagesTimestamps 把时间锚并入消息副本');
  assert.equal(orchestration._chatLoadingSession, false, '原子提交后解除加载态');
  assert.ok(calls.renders >= 2, '进入只读视图与记录落地各渲染一次');
  assert.deepEqual(readonlyView.getReadOnlySessionTarget(), {
    agentId: 'programming-helper',
    sessionId: 's1',
    threadId: 'wt-s1',
    title: '',
    archived: true,
  });
});

test('the indicator is a no-op when no read-only target is frozen', () => {
  // 首屏同步渲染链（app-ui 的 renderCurrentMainView）在 ESM 相之前调用一次；
  // 原实现此时 _state 与 _indicatorEl 均为 null，等价于只走清理分支。
  reset();
  readonlyView.updateReadOnlySessionIndicator();
  assert.equal(calls.indicatorInserted, null, '没有冻结目标时不插入指示器');
  assert.equal(calls.indicatorRemoved, 0, '没有旧指示器时也不移除任何节点');
});

test('a navigation started during the record request drops the late response', async () => {
  reset();
  let release = null;
  globalThis.fetch = () => new Promise((resolve) => {
    release = () => resolve({ ok: true, json: async () => ({ messages: [{ role: 'user', content: 'late' }] }) });
  });

  const pending = readonlyView.openReadOnlySession({ agentId: 'programming-helper', sessionId: 's2' });
  assert.equal(orchestration._chatLoadingSession, true, '记录请求期间挂载 chat 加载态');
  window.bumpNavigationGuard();
  release();

  assert.deepEqual(await pending, { ok: false, reason: 'superseded' });
  assert.equal(calls.applied.length, 0, '过期响应不得提交');
});

test('the read-only indicator follows the frozen target and disappears on close', async () => {
  reset();
  globalThis.fetch = recordFetch({ messages: [], timestamps: [], archived: true });
  await readonlyView.openReadOnlySession({ agentId: 'programming-helper', sessionId: 's3' });

  readonlyView.updateReadOnlySessionIndicator();
  assert.equal(calls.indicatorInserted.className, 'thread-header-indicator historical readonly');
  assert.equal(calls.indicatorInserted.textContent, '只读 · 已归档');
  assert.match(calls.indicatorInserted.title, /已归档/);

  readonlyView.closeReadOnlySession();
  assert.equal(agentStore.readOnlyMode, false, '关闭后离开只读态');
  assert.equal(threads.activeConversation, null, '只读会话目标被释放');
  assert.equal(readonlyView.getReadOnlySessionTarget(), null);
  assert.equal(calls.indicatorRemoved, 1, '指示器随之移除');
});

test('a failed record response reports through the toast and keeps the view mounted', async () => {
  reset();
  globalThis.fetch = async () => ({ ok: false, text: async () => 'session_record 500' });

  const result = await readonlyView.openReadOnlySession({ agentId: 'programming-helper', sessionId: 's4' });

  assert.deepEqual(result, { ok: false, reason: 'load_failed' });
  assert.equal(calls.toasts.length, 1);
  assert.equal(calls.toasts[0].status, 'error');
  assert.equal(orchestration._chatLoadingSession, false, '失败也要解除加载态');
  assert.equal(calls.applied.length, 0);
});
