/**
 * ph-search-locate 前端 VM 回归测试（工单 2026-10-21 定位与返回板块）。
 *
 * 覆盖真实生产函数：加载 public/src/modules/ph-search-locate.js 全文 +
 * 从 chat-renderer.js 源码提取真实 getAssistantErrorMeta /
 * computeAssistantErrorGroups（错误组权威 plan，非复刻）。身份、滚动、
 * 浮条、返回按可控 stub 驱动。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createFrontendSandbox, sourceBetween } from './helpers/frontend-vm.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHAT_RENDERER_SRC = fs.readFileSync(
  join(__dirname, '..', 'public', 'src', 'modules', 'chat-renderer.js'),
  'utf8',
);

function makeElement(overrides = {}) {
  const classes = new Set();
  return {
    id: '',
    className: '',
    innerHTML: '',
    isConnected: true,
    dataset: {},
    scrollTop: 0,
    scrollHeight: 0,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
    },
    appendChild() {},
    closest() { return null; },
    getBoundingClientRect() { return { top: 0 }; },
    dispatchEvent() {},
    ...overrides,
  };
}

/** 可控 MutationObserver：notify() 触发全部存活实例回调。 */
class FakeMutationObserver {
  constructor(callback) {
    this.callback = callback;
    this.disconnected = false;
    FakeMutationObserver.instances.push(this);
  }
  observe() {}
  disconnect() { this.disconnected = true; }
  static notify() {
    for (const observer of FakeMutationObserver.instances) {
      if (!observer.disconnected) observer.callback([]);
    }
  }
  static reset() { FakeMutationObserver.instances = []; }
}

function createLocateSandbox() {
  FakeMutationObserver.reset();
  const phTabsEl = makeElement({
    dataset: {
      searchHostId: 'host-agent',
      searchDirectory: 'D:/proj',
      searchRemote: 'false',
      searchProjectId: 'dir:d/proj',
      searchHostIdAlias: undefined,
    },
  });
  const elementsById = new Map();
  const documentStub = {
    getElementById: (id) => elementsById.get(String(id)) || null,
    querySelector: (selector) => (selector === '.ph-session-tabs' ? phTabsEl : null),
    createElement: () => makeElement(),
    body: makeElement(),
  };
  const containerEl = makeElement({ scrollTop: 0, scrollHeight: 5000 });
  containerEl.getBoundingClientRect = () => ({ top: 0 });

  const viewState = {
    runtimeId: '',
    switchEpoch: 1,
    identity: { agentId: '', sessionId: '' },
    messages: [],
  };
  const calls = {
    manualScroll: [],
    followLatest: [],
    selectSurface: [],
    toggleErrorGroup: [],
    toggleMessage: [],
  };
  // 包装 setTimeout 记录句柄：定位成功的 flash class 定时器（2s）与等待
  // 兜底（8s）不应拖慢测试进程退出，cleanup 统一收割；flushTimers 支持用
  // 例手动推进兜底定时器（不真实等待 8s）。
  const pendingTimers = new Map();
  const wrappedSetTimeout = (callback, delay, ...args) => {
    const id = setTimeout(() => { pendingTimers.delete(id); callback(...args); }, delay, ...args);
    pendingTimers.set(id, { callback, delay: Number(delay) || 0 });
    return id;
  };
  const wrappedClearTimeout = (id) => {
    pendingTimers.delete(id);
    clearTimeout(id);
  };
  const flushTimers = (minDelay) => {
    for (const [id, entry] of [...pendingTimers]) {
      if (entry.delay <= minDelay) {
        pendingTimers.delete(id);
        clearTimeout(id);
        entry.callback();
      }
    }
  };

  const sandbox = createFrontendSandbox({
    container: containerEl,
    document: documentStub,
    readCurrentSessionViewState: () => viewState,
    registerManualScrollIntent: (options) => { calls.manualScroll.push(options); },
    requestFollowLatest: (options) => { calls.followLatest.push(options); },
    selectWorkspaceSurface: (agentId, options) => { calls.selectSurface.push({ agentId, options }); },
    requestAnimationFrame: (cb) => { cb(); return 0; },
    MutationObserver: FakeMutationObserver,
    setTimeout: wrappedSetTimeout,
    clearTimeout: wrappedClearTimeout,
  });
  sandbox.window.toggleErrorGroup = (gid) => { calls.toggleErrorGroup.push(gid); };
  sandbox.window.toggleMessage = (id) => { calls.toggleMessage.push(id); };
  sandbox.run('window.ClawFW = window.ClawFW || {}; window.ClawFW.phSearch = { homeScrollTop: 0 };');

  // 真实生产模块：错误组权威判定（chat-renderer.js 源码块）+ 定位模块全文。
  sandbox.run(sourceBetween(CHAT_RENDERER_SRC, 'function getAssistantErrorMeta(', '// 红框本体'));
  sandbox.run(sourceBetween(CHAT_RENDERER_SRC, 'function computeAssistantErrorGroups(', '// index 处的失败消息是否参与成组'));
  sandbox.loadSource('public/src/modules/ph-search-locate.js');

  return {
    sandbox,
    containerEl,
    phTabsEl,
    elementsById,
    viewState,
    calls,
    setDataset(dataset) { Object.assign(phTabsEl.dataset, dataset); },
    addRow(id, { top = 100 } = {}) {
      const rowEl = makeElement();
      rowEl.getBoundingClientRect = () => ({ top });
      const el = makeElement();
      el.closest = () => rowEl;
      elementsById.set(id, el);
      return { el, rowEl };
    },
    barVisible() {
      const bar = sandbox.run('_locateBarEl');
      return !!bar && bar.classList.contains('show');
    },
    cleanup() {
      // 清理悬挂的 abortTimer / flash 定时器 / 观察器（Back 是生产清理入口）。
      sandbox.run('window.phSearchLocateBack && window.phSearchLocateBack()');
      for (const id of pendingTimers.keys()) clearTimeout(id);
      pendingTimers.clear();
    },
    flushTimers,
  };
}

function errorMessages() {
  return [
    { role: 'user', content: 'hi' }, // 0
    { role: 'assistant', execution: { status: 'failed', error: { category: 'rate_limit' } }, content: 'err-1' }, // 1
    { role: 'assistant', execution: { status: 'failed', error: { category: 'rate_limit' } }, content: 'err-2' }, // 2
    { role: 'assistant', execution: { status: 'failed', error: { category: 'rate_limit' } }, content: 'err-3' }, // 3
    { role: 'user', content: 'go' }, // 4
  ];
}

test('prepare 在进入前捕获搜索列表滚动与 dataset 项目身份', () => {
  const ctx = createLocateSandbox();
  try {
    ctx.containerEl.scrollTop = 123;
    ctx.setDataset({ searchHostId: 'ph-host', searchRemote: 'false', searchProjectId: 'dir:a' });
    ctx.sandbox.run("window.phSearchLocatePrepare({ sessionId: 's1', messageIndex: 4 })");
    assert.equal(ctx.sandbox.run('window.ClawFW.phSearch.homeScrollTop'), 123);
  } finally { ctx.cleanup(); }
});

test('无 messageIndex 的进入不产生定位（正常列表行为不变）', () => {
  const ctx = createLocateSandbox();
  try {
    ctx.viewState.runtimeId = 'rt-1';
    ctx.viewState.identity = { agentId: 'ph-host', sessionId: 's1' };
    ctx.viewState.messages = [{ role: 'user', content: 'hi' }];
    ctx.addRow('msg-0');
    ctx.sandbox.run("window.phSearchLocateAfterOpen({ sessionId: 's1' })");
    assert.equal(ctx.containerEl.scrollTop, 0);
    assert.equal(FakeMutationObserver.instances.length, 0);
    assert.equal(ctx.calls.manualScroll.length, 0);
  } finally { ctx.cleanup(); }
});

test('身份与数据已就绪时立即精确定位并显示浮条', () => {
  const ctx = createLocateSandbox();
  try {
    ctx.viewState.runtimeId = 'rt-1';
    ctx.viewState.identity = { agentId: 'ph-host', sessionId: 's1' };
    ctx.viewState.messages = errorMessages();
    const { rowEl } = ctx.addRow('msg-4', { top: 100 });
    ctx.sandbox.run("window.phSearchLocateAfterOpen({ sessionId: 's1', messageIndex: 4 })");
    // Reserve room above the hit for the locate actions: 100 - 72 = 28.
    assert.equal(ctx.containerEl.scrollTop, 28);
    assert.ok(ctx.calls.manualScroll.some((c) => c.interrupt === true));
    assert.ok(ctx.barVisible());
    assert.ok(rowEl.classList.contains('chat-locate-flash'));
  } finally { ctx.cleanup(); }
});

test('远程定位身份来自目录 accessor，不依赖本机 allAgents 派生的空会话身份', () => {
  const ctx = createLocateSandbox();
  try {
    ctx.sandbox.run("var isRemoteNamespaceAgentId = (id) => id.startsWith('remote:');");
    ctx.sandbox.window.RemoteConnections = { getEntryRuntimeSessionId: () => 'remote:a:s1' };
    ctx.viewState.runtimeId = 'remote:a:rt-1';
    ctx.viewState.identity.sessionId = '';
    ctx.viewState.messages = errorMessages();
    ctx.addRow('msg-4');
    ctx.sandbox.run("window.phSearchLocateAfterOpen({ sessionId: 'remote:a:s1', messageIndex: 4 })");
    assert.ok(ctx.barVisible());
    assert.ok(ctx.containerEl.scrollTop > 0);
  } finally { ctx.cleanup(); }
});

test('加载提交之前不抢位：身份/数据/DOM 落定后经 observer 定位', () => {
  const ctx = createLocateSandbox();
  try {
    // 落定后身份还没到（loadAgentData 未提交）：不滚、不显示浮条。
    ctx.sandbox.run("window.phSearchLocateAfterOpen({ sessionId: 's1', messageIndex: 4 })");
    assert.equal(ctx.containerEl.scrollTop, 0);
    assert.ok(!ctx.barVisible());

    // 数据提交（messages 到位）+ 渲染 DOM + 身份落地。
    ctx.viewState.runtimeId = 'rt-9';
    ctx.viewState.identity = { agentId: 'ph-host', sessionId: 's1' };
    ctx.viewState.messages = errorMessages();
    ctx.addRow('msg-4');
    FakeMutationObserver.notify();
    assert.ok(ctx.containerEl.scrollTop > 0);
    assert.ok(ctx.barVisible());
  } finally { ctx.cleanup(); }
});

test('消息数据长度未覆盖目标索引时等待，不猜测滚动', () => {
  const ctx = createLocateSandbox();
  try {
    ctx.viewState.runtimeId = 'rt-1';
    ctx.viewState.identity = { agentId: 'ph-host', sessionId: 's1' };
    ctx.viewState.messages = errorMessages().slice(0, 2); // 目标 index 4 未到
    ctx.addRow('msg-4');
    ctx.sandbox.run("window.phSearchLocateAfterOpen({ sessionId: 's1', messageIndex: 4 })");
    assert.equal(ctx.containerEl.scrollTop, 0);
    assert.ok(!ctx.barVisible());

    ctx.viewState.messages = errorMessages();
    FakeMutationObserver.notify();
    assert.ok(ctx.containerEl.scrollTop > 0);
  } finally { ctx.cleanup(); }
});

test('错误组非首消息：精确映射到组首行并展开组（不回扫猜下标）', () => {
  const ctx = createLocateSandbox();
  try {
    ctx.viewState.runtimeId = 'rt-1';
    ctx.viewState.identity = { agentId: 'ph-host', sessionId: 's1' };
    ctx.viewState.messages = errorMessages(); // 1..3 成组，组首 eg-1
    const { rowEl } = ctx.addRow('eg-1', { top: 200 });
    // 组内非首消息 msg-2 自身 id 在 DOM 中不存在（渲染层跳过）。
    ctx.sandbox.run("window.phSearchLocateAfterOpen({ sessionId: 's1', messageIndex: 2 })");
    assert.equal(ctx.containerEl.scrollTop, 128); // 200 - 72
    assert.ok(rowEl.classList.contains('chat-locate-flash'));
    assert.deepEqual(ctx.calls.toggleErrorGroup, ['eg-1']);
  } finally { ctx.cleanup(); }
});

test('身份守卫：用户已切到别的会话时放弃定位', () => {
  const ctx = createLocateSandbox();
  try {
    ctx.viewState.runtimeId = 'rt-1';
    ctx.viewState.identity = { agentId: 'ph-host', sessionId: 's1' };
    ctx.viewState.messages = errorMessages();
    ctx.addRow('msg-4');
    ctx.sandbox.run("window.phSearchLocateAfterOpen({ sessionId: 's1', messageIndex: 4 })");
    assert.ok(ctx.barVisible());

    // 用户切走：身份漂移后 observer 触发 → 放弃且浮条不遗留。
    ctx.viewState.runtimeId = 'rt-2';
    ctx.viewState.identity = { agentId: 'ph-host', sessionId: 'other' };
    ctx.containerEl.scrollTop = 0;
    FakeMutationObserver.notify();
    assert.ok(!ctx.barVisible());
    assert.equal(ctx.sandbox.run('_locateActive'), null);
  } finally { ctx.cleanup(); }
});

test('防迟到抢位：新一次定位使旧 observer 回调失效', () => {
  const ctx = createLocateSandbox();
  try {
    ctx.addRow('msg-4', { top: 100 });
    // 第一次定位进入等待：身份尚未落定（loadAgentData 未提交），保持观察。
    assert.equal(ctx.viewState.identity.sessionId, '');
    ctx.sandbox.run("window.phSearchLocateAfterOpen({ sessionId: 's1', messageIndex: 4 })");
    assert.equal(ctx.containerEl.scrollTop, 0);
    const firstObservers = [...FakeMutationObserver.instances];

    // 第二次定位接管：身份立即就绪（目标换成普通行，避免错误组路径）。
    ctx.viewState.runtimeId = 'rt-1';
    ctx.viewState.identity = { agentId: 'ph-host', sessionId: 's1' };
    ctx.viewState.messages = errorMessages();
    ctx.addRow('msg-0', { top: 300 });
    ctx.sandbox.run("window.phSearchLocateAfterOpen({ sessionId: 's1', messageIndex: 0 })");
    assert.ok(ctx.containerEl.scrollTop > 0);
    assert.ok(firstObservers.every((o) => o.disconnected));
    const scrollTopAfterSecond = ctx.containerEl.scrollTop;

    // 旧 observer 实例若被人为再次触发也不应再改动滚动位置。
    for (const observer of firstObservers) {
      observer.disconnected = false;
      observer.callback([]);
    }
    assert.equal(ctx.containerEl.scrollTop, scrollTopAfterSecond);
  } finally { ctx.cleanup(); }
});

test('定位尚未锁定身份时切走：取消观察且超时后不显示失败浮条', () => {
  const ctx = createLocateSandbox();
  try {
    ctx.sandbox.run("window.phSearchLocateAfterOpen({ sessionId: 's1', messageIndex: 4 })");
    ctx.viewState.switchEpoch += 1;
    FakeMutationObserver.notify();
    ctx.flushTimers(8000);
    assert.equal(ctx.sandbox.run('_locateActive'), null);
    assert.ok(!ctx.barVisible());
  } finally { ctx.cleanup(); }
});

test('回最新：复用 follow-latest 强制跟随并收起浮条', () => {
  const ctx = createLocateSandbox();
  try {
    ctx.viewState.runtimeId = 'rt-1';
    ctx.viewState.identity = { agentId: 'ph-host', sessionId: 's1' };
    ctx.viewState.messages = errorMessages();
    ctx.addRow('msg-4');
    ctx.sandbox.run("window.phSearchLocateAfterOpen({ sessionId: 's1', messageIndex: 4 })");
    assert.ok(ctx.barVisible());
    ctx.sandbox.run('window.phSearchLocateLatest()');
    assert.equal(ctx.calls.followLatest.length, 1);
    assert.equal(ctx.calls.followLatest[0].forceEnable, true);
    assert.ok(!ctx.barVisible());
  } finally { ctx.cleanup(); }
});

test('返回搜索：回宿主 home surface、恢复远程项目视图与列表滚动', () => {
  const ctx = createLocateSandbox();
  try {
    ctx.containerEl.scrollTop = 321;
    ctx.setDataset({ searchHostId: 'ph-host', searchRemote: 'true', searchProjectId: 'dir:remote-p' });
    ctx.sandbox.run("window.phSearchLocatePrepare({ sessionId: 's1', messageIndex: 4 })");
    ctx.viewState.runtimeId = 'rt-1';
    ctx.viewState.identity = { agentId: 'ph-host', sessionId: 's1' };
    ctx.viewState.messages = errorMessages();
    ctx.addRow('msg-4');
    ctx.sandbox.run("window.phSearchLocateAfterOpen({ sessionId: 's1', messageIndex: 4 })");
    assert.ok(ctx.barVisible());

    ctx.containerEl.scrollTop = 0;
    ctx.sandbox.run('window.phSearchLocateBack()');
    // selectWorkspaceSurface(agentId, options) 真实签名：agentId 位置参数。
    assert.equal(ctx.calls.selectSurface.length, 1);
    assert.equal(ctx.calls.selectSurface[0].agentId, 'ph-host');
    // 远程视图恢复（session-list-render 消费 phSurfaceViewProjectId）。
    assert.equal(ctx.sandbox.run('window.ClawFW.phSurfaceViewProjectId'), 'dir:remote-p');
    assert.ok(!ctx.barVisible());
    // home 骨架重渲染（rAF）后恢复搜索列表滚动位置。
    assert.equal(ctx.containerEl.scrollTop, 321);
  } finally { ctx.cleanup(); }
});

test('用户折叠的消息定位时经真实 toggle 展开以可见命中原文', () => {
  const ctx = createLocateSandbox();
  try {
    ctx.viewState.runtimeId = 'rt-1';
    ctx.viewState.identity = { agentId: 'ph-host', sessionId: 's1' };
    ctx.viewState.messages = errorMessages();
    const { el } = ctx.addRow('msg-4');
    el.classList.add('collapsed');
    ctx.sandbox.run("window.phSearchLocateAfterOpen({ sessionId: 's1', messageIndex: 4 })");
    assert.deepEqual(ctx.calls.toggleMessage, ['msg-4']);
    assert.ok(ctx.containerEl.scrollTop > 0);
    // 未折叠的消息不触发多余 toggle。
    ctx.sandbox.run("window.phSearchLocateAfterOpen({ sessionId: 's1', messageIndex: 0 })");
    assert.equal(ctx.calls.toggleMessage.length, 1);
  } finally { ctx.cleanup(); }
});

test('定位超时/索引失效不静默：显示可关闭失败说明并支持返回搜索', () => {
  const ctx = createLocateSandbox();
  try {
    // 身份永远不落位（目标会话从未成为当前视图）→ 等待至兜底超时。
    ctx.viewState.runtimeId = 'rt-other';
    ctx.viewState.identity = { agentId: 'ph-host', sessionId: 'other' };
    ctx.viewState.messages = errorMessages();
    ctx.addRow('msg-4');
    ctx.sandbox.run("window.phSearchLocateAfterOpen({ sessionId: 's1', messageIndex: 4 })");
    assert.ok(!ctx.barVisible());
    ctx.flushTimers(8000); // 推进 8s 兜底（不真实等待）
    const bar = ctx.sandbox.run('_locateBarEl');
    assert.ok(bar.classList.contains('show'));
    assert.ok(String(bar.innerHTML).includes('phSearchLocateBack()'));
    assert.ok(String(bar.innerHTML).includes('phSearchLocateDismiss()'));
    // 返回搜索可用且收起失败说明。
    ctx.sandbox.run('window.phSearchLocateBack()');
    assert.ok(!bar.classList.contains('show'));
  } finally { ctx.cleanup(); }
});

// ── 远程 open_session 完整链路（workspace-actions 远程分支）────────────────

/**
 * 真实加载 remote-connections.js（splitRemoteNamespaceId /
 * getEntryHostNamespaceId 真实行为）+ workspace-actions.js（激活分支）。
 * catalog 不含目标会话：宿主只能来自显式 action.agentId（搜索召回场景）。
 */
function createRemoteActionsSandbox({ bumpEpochDuringWait = false } = {}) {
  const requests = [];
  const events = { switchAgent: [], locate: [], prepare: [], alerts: [] };
  const ctx = createFrontendSandbox({
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      const path = String(url).split('?')[0];
      if (path === '/protoclaw/prebuilt_sessions/activate') {
        return { ok: true, status: 200, json: async () => ({ ok: true, session: { id: 'session-x', title: 'T' } }), text: async () => '' };
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    },
    isRemoteNamespaceAgentId: undefined,
    renderAgentList: () => {},
    t: (key) => key,
    escapeHtml: (value) => String(value ?? ''),
    currentRuntimeAgentId: null,
    allAgents: [],
    markActionLoading: () => {},
    loadAgents: async () => {},
    renderCurrentMainView: () => {},
    newIdempotencyKeyDummy: null,
  });
  ctx.window.alert = (msg) => { events.alerts.push(String(msg)); };
  ctx.loadSource('public/src/modules/remote-connections.js');
  // 远程分支其余全局依赖：最小替身（本地分支不触达）。
  ctx.run(`
    var bumpNavigationGuard = function () {};
    var _navigationGuardEpoch = 0;
    var saveCurrentWorkspaceSurfaceScroll = function () {};
    var hasWorkspaceSessions = function () { return true; };
    var getWorkspaceSessions = function () { return []; };
    var getWorkspaceSessionById = function () { return null; };
    var requestSwitch = async function () { return { switched: true }; };
    var markSessionLoading = function () {};
    var clearSessionLoading = function () {};
    var beginChatLoadingSession = function () {};
    var clearChatLoadingSession = function () {};
    var beginFollowLatestCooldown = function () {};
    var beginFollowLatestEntryWindow = function () {};
    var normalizeAgentIdentity = function (v) { return v || ''; };
    var saveCurrentRuntimeToCache = function () {};
    var getRuntimeContextKey = function () { return ''; };
    var _storeVisibleSessionInputDraft = function () {};
    var openPrebuiltWorkspaceSession = async function () {};
    var applyOptimisticWorkspaceSession = function () {};
    var upsertConnectedAgent = function () {};
    var createCompactedResumeSession = async function () {};
    var applyManagedPrebuiltAgent = function () {};
    var getWorkspaceFormDraft = function () { return {}; };
    var saveWorkspaceFormDraft = function () {};
    var setPreferredUnitMode = function () {};
    var getFeatureCreatorProjects = function () { return []; };
    var getAgentCreatorProjects = function () { return []; };
    var isAssemblySession = function () { return false; };
    var getAgentWorkspaceState = function () { return {}; };
    var updateAgentRecord = function () {};
    var beginSidebarOperation = function (o) { return { operationId: 'op-test' }; };
    var finishSidebarOperation = function () {};
    var updateSidebarOperation = function () {};
    var beginSidebarOperationMainThreadObservation = function () { return function () {}; };
    var recordSidebarOperationCheckpoint = function () {};
    var navigateToSessionMutationTarget = async function () {};
    var lastRenderedWorkspaceHtml = '';
    var prebuiltSessionSwitchInFlight = false;
    var shouldAnimateWorkspaceSurface = false;
  `);
  ctx.loadSource('public/src/modules/workspace-actions.js');
  // 就绪观察与落定替身：不真实轮询；等待期间可选模拟用户切走（bump 代次）。
  ctx.window.RemoteConnections.waitForRuntimeForSession = async () => {
    if (bumpEpochDuringWait) ctx.run('_navigationGuardEpoch += 1;');
    return 'remote:server-a:rt-x';
  };
  ctx.window.switchAgent = async (runtimeRef) => { events.switchAgent.push(String(runtimeRef)); };
  ctx.window.phSearchLocateAfterOpen = (action) => { events.locate.push(action); };
  ctx.window.phSearchLocatePrepare = (action) => { events.prepare.push(action); };
  return { ctx, requests, events };
}

test('远程搜索结果进入：action.agentId 优先（同连接校验）→ activate → 落定接定位', async () => {
  const { ctx, requests, events } = createRemoteActionsSandbox();
  await ctx.run(`window.runWorkspaceAction(${JSON.stringify({
    type: 'open_session',
    sessionId: 'remote:server-a:session-x',
    agentId: 'remote:server-a:programming-helper',
    messageIndex: 3,
  })}, null)`);
  // 进入前捕获先于远程分支。
  assert.equal(events.prepare.length, 1);
  // activate 以显式宿主命名空间寻址（目录未含该会话，查找本会落空）。
  const activate = requests.find((r) => r.url.includes('/protoclaw/prebuilt_sessions/activate'));
  assert.ok(activate, 'activate requested');
  assert.equal(JSON.parse(activate.init.body).agentId, 'remote:server-a:programming-helper');
  // 落定：switchAgent 后接定位，action 原样传递。
  assert.deepEqual(events.switchAgent, ['remote:server-a:rt-x']);
  assert.equal(events.locate.length, 1);
  assert.equal(events.locate[0].messageIndex, 3);
});

test('远程等待期间用户已切走：导航代次守卫放弃切换，不抢焦点', async () => {
  const { ctx, events } = createRemoteActionsSandbox({ bumpEpochDuringWait: true });
  await ctx.run(`window.runWorkspaceAction(${JSON.stringify({
    type: 'open_session',
    sessionId: 'remote:server-a:session-x',
    agentId: 'remote:server-a:programming-helper',
    messageIndex: 3,
  })}, null)`);
  assert.equal(events.switchAgent.length, 0, 'must not steal focus after user navigated away');
  assert.equal(events.locate.length, 0);
});

test('跨连接的显式宿主不被采用，目录也无该会话时显式失败', async () => {
  const { ctx, requests, events } = createRemoteActionsSandbox();
  await ctx.run(`window.runWorkspaceAction(${JSON.stringify({
    type: 'open_session',
    sessionId: 'remote:server-a:session-x',
    agentId: 'remote:server-b:programming-helper',
    messageIndex: 1,
  })}, null)`);
  assert.equal(requests.filter((r) => r.url.includes('/activate')).length, 0, 'no activate for cross-connection host');
  assert.equal(events.switchAgent.length, 0);
  assert.equal(events.alerts.length, 1);
});

test('返回搜索的滚动恢复有防迟到守卫：已离开搜索面不再写滚动', () => {
  const ctx = createLocateSandbox();
  try {
    ctx.containerEl.scrollTop = 321;
    ctx.sandbox.run("window.phSearchLocatePrepare({ sessionId: 's1', messageIndex: 4 })");
    ctx.viewState.runtimeId = 'rt-1';
    ctx.viewState.identity = { agentId: 'ph-host', sessionId: 's1' };
    ctx.viewState.messages = errorMessages();
    ctx.addRow('msg-4');
    ctx.sandbox.run("window.phSearchLocateAfterOpen({ sessionId: 's1', messageIndex: 4 })");

    // 恢复 rAF 回调执行时用户已不在搜索面（.ph-session-tabs 缺席）。
    ctx.sandbox.querySelector = ctx.sandbox.document.querySelector;
    ctx.sandbox.document.querySelector = () => null;
    ctx.containerEl.scrollTop = 0;
    try {
      ctx.sandbox.run('window.phSearchLocateBack()');
      assert.equal(ctx.containerEl.scrollTop, 0);
    } finally {
      ctx.sandbox.document.querySelector = ctx.sandbox.querySelector;
    }
  } finally { ctx.cleanup(); }
});
