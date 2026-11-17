/**
 * session-dialogs.js 真实行为（P2 W1-4）。
 *
 * 该模块已迁 ESM：分支对话框状态是模块私有状态，语言/转义与已迁宿主能力
 * （agent-snapshot-loader / runtime-switch / chat-loading）走真实依赖；仍为
 * classic 的渲染与侧栏操作以 window 桩观察。覆盖 ADR-0032 的分支语义
 * （线程宿主钳制「归档原会话」）、ADR-0011 的幂等写与 side-bar operation，
 * 以及重命名对话框的保存链路。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Marked } from 'marked';
import { installBrowserStubs, loadModuleOnce } from './helpers/esm-module-loader.js';

let cleanupGlobals = null;
let dialogs = null;
let agentStore = null;
let orchestration = null;
let i18n = null;
let chatLoading = null;
let sidebarOps = null;
let calls = null;
const elements = new Map();
let created = [];

/* 真实宿主适配器的依赖桩：session-dialogs 现在 import 运行时切换、列表快照
 * 加载与 chat-loading；这些宿主装载期经 window.createXHost() 取 classic 适配面。
 * 桩记录真实调用点（导航目标、加载态、列表快照请求），不替换被测模块依赖。 */
const hostCalls = { switched: [], viewerRequests: 0 };
const runtimeCache = new Map();
// 真实 sidebar-operations 的 operation 收尾经 console.info('[SIDEBAR_OPERATION]') 播报
// （settled 后记录即从存储删除，事后 getSidebarOperation 已查不到）。
const sidebarPhases = [];
let originalConsoleInfo = null;

/** classic bootstrap 状态宿主的可读写替身（真实实现是 Object.freeze 状态槽位）。 */
function stateHost(initial = {}) {
  const state = { ...initial };
  return new Proxy(state, {
    get: (target, key) => target[key],
    set: (target, key, value) => { target[key] = value; return true; },
  });
}

const pendingTimers = new Set();
function trackedSetTimeout(callback, delay) {
  const id = setTimeout(() => { pendingTimers.delete(id); callback(); }, delay);
  pendingTimers.add(id);
  return id;
}
function trackedClearTimeout(id) {
  pendingTimers.delete(id);
  clearTimeout(id);
}
function clearPendingTimers() {
  for (const id of pendingTimers) clearTimeout(id);
  pendingTimers.clear();
}

/** domRefs 元素替身：菜单关闭路径要 classList（出现形状与生产一致）。 */
function domRefElement() {
  return {
    innerHTML: '',
    style: {},
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
}

function installHostFactories() {
  // classic P2 bootstrap 状态宿主（sidebar-operations / session-ui 装载期取用）：
  // 真实实现是 app-core/app-main/sidebar-render 的 Object.freeze 状态槽位，
  // 这里用可读写 bag 复刻其接口面。
  window.createP2BootstrapSidebarHost = () => stateHost({ restartingRuntimeIds: new Set(), suppressSidebarRerender: false });
  window.createP2BootstrapSidebarRenderHost = () => stateHost({ lastAgentListRenderSignature: '' });
  window.createP2BootstrapPhSessionHost = () => stateHost({ phSessionSortMode: 'default', phSearchQuery: '', _phSearchTimer: null, savedPhTabState: {} });
  // DOM 引用面：session-dialogs 现在 import context-menu 的 closeCompactMenu（真实
  // 实现读 domRefs.compactContextMenu 与菜单状态 owner），按 app-core 工厂同形给替身。
  window.createP2BootstrapDomHost = () => stateHost({
    compactContextMenu: domRefElement(),
    agentContextMenu: domRefElement(),
    projectContextMenu: domRefElement(),
    featureRepoContextMenu: domRefElement(),
    ctxMenu: domRefElement(),
    container: makeElement(),
    agentList: makeElement(),
    featurePanel: makeElement(),
  });
  window.createP2BootstrapAssemblyHost = () => stateHost({});
  window.createP2BootstrapCallActivityHost = () => stateHost({
    _agentCallActive: new Map(), _recentlyFinishedRuntimes: new Set(),
    _seenChoiceAlertIds: new Set(), _autoTitleTriggered: new Set(), _lastInterruptUserActionAt: 0,
  });
  window.createP2BootstrapChatSurfaceHost = () => stateHost({});
  window.createP2BootstrapChoiceInputHost = () => stateHost({ state: {} });
  window.createP2BootstrapDebugPanelHost = () => stateHost({ logFilters: {} });
  window.createP2BootstrapSessionSwitchHost = () => stateHost({});
  window.AgentLoaderHost = { loadedAgentDetailIds: new Set() };
  window.createCallInterruptHost = () => ({ pending: new Map(), now: () => 0 });
  window.createSessionViewCommitHost = () => ({
    identity: () => null, read: () => ({}), apply() {}, normalizeModel: (value) => value || {},
  });
  window.createRuntimeViewCacheHost = () => ({
    cache: runtimeCache, capacity: 20, contextKey: (runtimeId) => `ctx:${runtimeId}`,
    readView: () => ({}), signatures: () => ({}), todoSignature: (plan) => JSON.stringify(plan || {}),
    emptyTodo: () => ({}), followLatest: () => false, captureAnchor: () => null, scrollTop: () => 0,
    activeCollapseContext: () => '', forgetContext() {}, activateCollapse() {},
    normalizeIdentity: (identity) => identity, patch() {}, setRestoredScrollTop() {},
    restoreAnchor() {}, updatePlanBadge() {},
  });
  window.createAgentCallStatesHost = () => ({
    calling: new Map(), suspended: new Set(), interrupting: new Map(), finished: new Set(),
    agents: () => agentStore.allAgents, currentRuntimeId: () => orchestration.currentRuntimeAgentId,
    runtimeId: (agent) => agent?.id || '', remoteEntries: () => [], normalize: (value) => value,
    resolveCalling: () => false, isSuspended: () => false, markStarted() {}, syncActionButton() {},
    isSseActive: () => false, isRemote: () => false, fetch: (...args) => globalThis.fetch(...args),
    now: () => 0, lastRefresh: () => 0, setLastRefresh() {}, render() {},
  });
  window.createSessionDataLoaderHost = () => ({
    isUiOnly: () => false, setRuntime() {}, apply() {}, capture: () => null, isCurrent: () => false,
    messagesCurrent: () => false, patch() {}, focused: () => null, activePanel: () => null,
    fetch: (...args) => globalThis.fetch(...args), notify() {}, resetSurface() {}, render() {},
    renderPanel() {}, clearTemplates() {}, loadTemplates: async () => {}, refreshBadges() {},
    resetRuntimeStatus() {}, activateCollapse() {}, clearRecap() {}, emptyTodo: () => ({}),
    attachTimestamps: (messages) => messages, recheckTitle() {}, clearLoading() {},
    updateRollback() {}, templateNames: () => [], warmTemplates() {}, updateContext() {},
    updateModel() {}, updateThinking() {}, updatePlan() {}, loadDetail: async () => {},
    refreshStatus: async () => {}, loadLogs() {}, warn() {}, error() {},
  });
  window.createRuntimeStatusLoaderHost = () => ({
    runtimeId: () => null, capture: () => null, isCurrent: () => false, commit() {}, patch() {},
    fetch: (...args) => globalThis.fetch(...args), guardAvailable: () => false,
    ownerRecord: () => null, logicalId: (record) => record?.id || '', sessionId: () => '',
    runtimeRecord: () => null, applyGuard() {}, notify() {}, warn() {},
  });
  window.createAgentSnapshotLoaderHost = () => ({
    state: { suppressRender: true },
    get detailIds() { return window.AgentLoaderHost.loadedAgentDetailIds; },
    now: () => 0, captureToken: () => null, isTokenCurrent: () => true, ownership: () => ({}),
    connected: () => Promise.resolve([]),
    viewer: () => { hostCalls.viewerRequests += 1; return globalThis.fetch('/api/agents'); },
    loadLayout: () => undefined, loadProjects: () => undefined,
    schedule: (callback, delay) => setTimeout(callback, delay), diagnostic: () => {},
    runtimeId: (agent) => agent?.id || '', agentRuntimeId: (agent) => agent?.id || '',
    logicalId: (agent) => agent?.id || '', mergeSessions: (previous) => previous,
    reconcileStops() {}, pruneCallStates() {}, renderList() {}, renderPanel() {},
    refreshCalls: async () => {}, isRemote: () => false, fallback: () => null,
    loadDetail: async () => {}, selectSurface() {}, preferHome() {}, resolveFocus: () => null,
    clickPrebuilt() {}, loadData: async () => {}, warn() {}, error() {}, log() {},
  });
  // context-menu（closeCompactMenu 的 producer）装载期取该 host 面
  window.createP2BootstrapContextMenuHost = () => stateHost({
    contextMenuAgentId: '', contextMenuAgentMode: '', contextMenuCompactAction: '',
    contextMenuProjectAgentId: '', contextMenuProjectId: '', contextMenuFeatureRepoPackageId: '',
  });
  // 表面导航宿主（classic app-ui 工厂）：project-data → assembly-actions 的 import 链
  // 触达 workspace-surface-host，后者在求值期取该工厂。
  window.createWorkspaceSurfaceHost = () => {
    const noop = () => {};
    return {
      bumpNavigationGuard: noop, closeReadOnlySession: noop, hasDetail: () => false,
      loadDetail: async () => {}, findAgent: () => null, currentAgent: () => null,
      preferenceKey: () => '', tabs: () => [], surfacePreference: () => null,
      defaultMode: () => 'home', ui: () => null, focusedAgentId: () => null,
      runtimeId: () => null, contextKey: () => '', saveScroll: noop,
      readOnlyMode: () => false, saveCache: noop, bindWorkspace: noop,
      setFollowLatest: noop, resetRuntimeState: noop, beginPending: noop,
      setTab: noop, beginLoading: noop, clearPending: noop,
      render: noop, renderAgents: noop, renderPanel: noop, refreshPanels: noop,
    };
  };
  // 轮询协调器宿主（classic app-main 工厂）：ESM 图经 agent-data-loader → input-actions
  // 触达 poll-coordinator-host，后者在模块求值期取该工厂。本文件不驱动轮询。
  window.createPollCoordinatorHost = () => ({
    run: async () => {}, fastInterval: () => 1000, setTimeout: () => 0, clearTimeout: () => {},
  });
  window.createRuntimeSwitchHost = () => ({
    state: {},
    switchAgent: async (runtimeId) => { hostCalls.switched.push(runtimeId); },
    setTimeout: (callback) => setTimeout(callback, 0),
  });
  window.createCompactResumeHost = () => ({
    isRemote: () => false, remote: () => null,
    createOperationId: () => 'op-auto', now: () => 0, observe: () => () => {}, checkpoint() {},
    fetch: (...args) => globalThis.fetch(...args), idempotencyKey: () => 'test-key',
    refreshThreads() {},
  });
}

function makeElement() {
  const listeners = new Map();
  return {
    className: '',
    innerHTML: '',
    textContent: '',
    value: '',
    disabled: false,
    style: {},
    dataset: {},
    parentNode: null,
    focus() {},
    select() {},
    addEventListener(type, callback) { listeners.set(type, callback); },
    dispatch(type, event = {}) { listeners.get(type)?.(event); },
    querySelectorAll() { return []; },
    querySelector() { return null; },
    appendChild(el) { el.parentNode = this; created.push(el); return el; },
    removeChild(el) { el.parentNode = null; return el; },
  };
}

function overlayElement() {
  const input = makeElement();
  const save = makeElement();
  const overlay = makeElement();
  overlay.querySelector = (selector) => {
    if (selector === '[data-rename-input]') return input;
    if (selector === '[data-rename-save]') return save;
    return null;
  };
  return { overlay, input, save };
}

const branchTitle = makeElement();
const body = {
  appendChild(el) { el.parentNode = body; created.push(el); return el; },
  removeChild(el) { el.parentNode = null; return el; },
};

before(async () => {
  cleanupGlobals = installBrowserStubs({
    window: {
      // vendor 面：index.html 的 marked UMD 标签先于 module 标签执行，markdown-utils
      // 在求值期就要 `new marked.Renderer()`。
      marked: new Marked(),
      escapeHtml: (text) => String(text).replace(/[&<>"']/g, (m) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
      }[m])),
      ClawFW: {
        actions: {
          handlers: new Map(),
          registerMany(map) { for (const [name, handler] of Object.entries(map)) this.handlers.set(name, handler); },
          invoke(name, el) { return this.handlers.get(name)(el); },
        },
      },
      setTimeout: trackedSetTimeout,
      clearTimeout: trackedClearTimeout,
      requestAnimationFrame: (callback) => trackedSetTimeout(() => callback(Date.now()), 0),
    },
    document: {
      getElementById(id) { return elements.get(id) || null; },
      createElement: () => overlayElement().overlay,
      addEventListener() {},
      body,
      activeElement: null,
    },
  });
  originalConsoleInfo = console.info;
  console.info = (...args) => {
    if (args[0] === '[SIDEBAR_OPERATION]' && args[1] && typeof args[1] === 'object') sidebarPhases.push(args[1]);
    else originalConsoleInfo(...args);
  };
  await loadModuleOnce('public/src/modules/kernel-state.js', { installGlobals: false });
  installHostFactories();
  agentStore = await import('../public/src/modules/agent-store-state.js');
  orchestration = await import('../public/src/modules/orchestration-state.js');
  i18n = await import('../public/src/modules/i18n-environment-state.js');
  chatLoading = await import('../public/src/modules/chat-loading-host.js');
  const { ClawToast } = await import('../public/src/modules/toast-notify.js');
  ClawToast.show = (payload) => calls?.toasts.push(payload);
  sidebarOps = await import('../public/src/modules/sidebar-operations.js');
  // 分支对话框的 DOM 引用在装载时取得：元素表必须先就绪，且跨例复用同一批元素。
  elements.set('branch-dialog', Object.assign(makeElement(), {
    querySelector: (selector) => (selector === '.trim-title' ? branchTitle : null),
  }));
  elements.set('branch-submit', makeElement());
  elements.set('branch-round-list', makeElement());
  elements.set('branch-footer-info', makeElement());
  dialogs = (await loadModuleOnce('public/src/modules/session-dialogs.js', { installGlobals: false })).module;
});

after(() => {
  clearPendingTimers();
  if (originalConsoleInfo) console.info = originalConsoleInfo;
  cleanupGlobals();
});

const previewPayload = {
  snapshotRevision: 4,
  preamblePercent: 0.2,
  rounds: [
    { userPreview: 'q1', assistantPreview: 'a1', charPercent: 0.3, cumulativePercent: 0.3, msgIndexEnd: 2, messageCount: 3, toolCalls: [{ name: 'read' }] },
    { userPreview: 'q2', assistantPreview: 'a2', charPercent: 0.2, cumulativePercent: 0.5, msgIndexEnd: 5, messageCount: 2, toolCalls: [] },
  ],
};

function reset(overrides = {}) {
  calls = {
    alerts: [], switches: [], toasts: [],
    markSessionLoading: 0, clearSessionLoading: 0, beginLoading: 0,
    renders: 0, listRenders: 0, preferredModes: [],
  };
  for (const el of elements.values()) {
    el.innerHTML = '';
    el.textContent = '';
    el.value = '';
    el.disabled = false;
    el.style = {};
    el.dataset = {};
  }
  branchTitle.textContent = '';
  created = [];
  i18n.setCurrentLanguage('zh');
  orchestration.setCurrentRuntimeAgentId('');
  orchestration.setNavigationGuardEpoch(3);
  orchestration.setSwitchEpoch(0);
  orchestration.setPendingSwitchSerial(0);
  orchestration.setPendingSwitchTarget(null);
  clearPendingTimers();
  chatLoading.clearChatLoadingSession();
  hostCalls.switched.length = 0;
  hostCalls.viewerRequests = 0;
  runtimeCache.clear();
  sidebarPhases.length = 0;
  agentStore.setAllAgents([{
    id: 'programming-helper',
    workspace_sessions: { sessions: [{ id: 'session-1', title: 'Old title' }] },
  }]);
  Object.assign(window, {
    bumpNavigationGuard: () => { calls.navGuard = (calls.navGuard || 0) + 1; },
    fmtPct: (frac) => (frac * 100).toFixed(1) + '%',
    closeCompactMenu: () => {},
    alert: (message) => calls.alerts.push(String(message)),
    isThreadHostAgentId: () => false,
    isRemoteNamespaceAgentId: () => false,
    markSessionLoading: () => { calls.markSessionLoading += 1; },
    clearSessionLoading: () => { calls.clearSessionLoading += 1; },
    // 会话变更乐观归档仍经 classic project-data / app-core 的适配面
    getActiveSessionId: () => '',
    getParentAgentId: () => '',
    updateAgentRecord: (agentId, patch) => {
      agentStore.setAllAgents(agentStore.allAgents.map((agent) => (
        agent.id === agentId ? { ...agent, ...patch } : agent
      )));
    },
    waitForTargetRuntimeSession: async () => null,
    upsertConnectedAgent: (agent) => agent,
    getRuntimeId: (agent) => agent?.id || '',
    getWorkspaceSessionById: () => null,
    getPathLeaf: () => '',
    setPreferredUnitMode: (mode) => calls.preferredModes.push(mode),
    beginChatLoadingSession: () => { calls.beginLoading += 1; },
    clearChatLoadingSession: () => {},
    requestSwitch: async (runtimeId, source) => { calls.switches.push([runtimeId, source]); },
    getCurrentAgentRecord: () => null,
    renderCurrentMainView: () => { calls.renders += 1; },
    renderAgentList: () => { calls.listRenders += 1; },
    refreshThreads: async () => ({ ok: true }),
    RemoteConnections: null,
    ClawToast: { show: (payload) => calls.toasts.push(payload) },
  });
  Object.assign(window, overrides);
}

const previewFetch = async () => ({ ok: true, json: async () => previewPayload });
const clickEvent = (selector, target) => ({ target: { closest: (query) => query === selector ? target : null } });
const flush = async () => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
};

test('thread-hosted sessions clamp the archive intent and render the branch preview', async () => {
  reset({ isThreadHostAgentId: () => true });
  globalThis.fetch = previewFetch;

  await dialogs.openBranchDialog('programming-helper', 'session-1', true);

  assert.equal(branchTitle.textContent, '分支', '线程会话不展示「分支并归档」');
  assert.equal(elements.get('branch-submit').textContent, '创建分支');
  assert.equal(elements.get('branch-submit').disabled, true, '未选切点前不可提交');
  const html = elements.get('branch-round-list').innerHTML;
  assert.match(html, /第 1 轮 · 3 条消息 · 1 次调用/);
  assert.match(html, /q1/);
  assert.match(html, /系统上下文/);
  assert.equal(elements.get('branch-footer-info').textContent, '共 2 轮，点击选择分支点');
});

test('submitting a branch posts one idempotent delta request and switches to the new runtime', async () => {
  reset();
  globalThis.fetch = previewFetch;
  await dialogs.openBranchDialog('programming-helper', 'session-1', true);

  elements.get('branch-round-list').dispatch('click', clickEvent('.trim-round-item[data-branch-index]', { dataset: { branchIndex: '1' } }));
  assert.equal(elements.get('branch-submit').disabled, false, '选中轮次后可提交');

  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    return {
      ok: true,
      json: async () => ({
        newSessionId: 'session-9',
        agent: { id: 'rt-9' },
        revision: 7,
        archive: { succeeded: true },
      }),
    };
  };
  await window.ClawFW.actions.invoke('sessionDialogs.submitBranch');
  await flush();

  const branchRequests = requests.filter((entry) => entry.url === '/protoclaw/sessions/branch');
  assert.equal(branchRequests.length, 1, '分支提交只发一次请求');
  const idempotencyKey = branchRequests[0].options.headers['x-idempotency-key'];
  assert.equal(typeof idempotencyKey, 'string');
  assert.ok(idempotencyKey.length > 0, 'ADR-0011：写类提交必须携带幂等键');
  const body = JSON.parse(branchRequests[0].options.body);
  assert.deepEqual({ ...body, operationId: '<generated>' }, {
    agentId: 'programming-helper',
    sourceSessionId: 'session-1',
    cutMsgIndexEnd: 5,
    snapshotRevision: 4,
    archiveOriginal: true,
    responseMode: 'delta',
    operationId: '<generated>',
  });
  assert.equal(typeof body.operationId, 'string');
  assert.ok(body.operationId.length > 0, '分支请求携带真实 sidebar operation id');
  assert.equal(calls.markSessionLoading, 1);
  assert.deepEqual(hostCalls.switched, ['rt-9'], '真实运行时切换请求指向新 runtime');
  assert.deepEqual(calls.preferredModes, ['chat']);
  assert.equal(orchestration._chatLoadingSession, true, '切换前挂载 chat 加载态');
  // 真实 sidebar-operations：分支操作以 settled 收尾
  assert.ok(
    sidebarPhases.some((event) => event.operationId === body.operationId && event.phase === 'settled'),
    '侧栏 operation 以 settled 收尾（真实 sidebar-operations 播报）',
  );
  // 真实 session-mutation：乐观归档落在 agent 记录上
  const archivedSession = agentStore.allAgents
    .find((agent) => agent.id === 'programming-helper')
    ?.workspace_sessions.sessions.find((session) => session.id === 'session-1');
  assert.equal(archivedSession?.archived, true, '源会话先被乐观标记为已归档');
  assert.ok(hostCalls.viewerRequests >= 1, '提交后经真实 loadAgents 刷新列表快照');
});

test('the rename dialog prefills the current title and saves through the PUT endpoint', async () => {
  reset();
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    return { ok: true, json: async () => ({ ok: true, sessionDelta: { upsert: [{ id: 'session-1', title: 'New title' }] } }) };
  };

  await dialogs.phOpenRenameDialog('programming-helper', 'session-1');
  const overlay = created.at(-1);
  const input = overlay.querySelector('[data-rename-input]');
  assert.match(overlay.innerHTML, /data-rename-input value="Old title"/, '当前标题从列表缓存预填');
  assert.equal(overlay.querySelector('[data-rename-save]').disabled, false);

  input.value = 'New title';
  input.dispatch('keydown', { key: 'Enter', preventDefault() {} });
  await flush();

  assert.equal(requests[0].url, '/protoclaw/prebuilt_sessions/session-1/title');
  assert.equal(requests[0].options.method, 'PUT');
  assert.ok(requests[0].options.headers['x-idempotency-key'].length > 0);
  assert.deepEqual(JSON.parse(requests[0].options.body), { agentId: 'programming-helper', title: 'New title' });
  const renamed = agentStore.allAgents
    .find((agent) => agent.id === 'programming-helper')
    ?.workspace_sessions.sessions.find((session) => session.id === 'session-1');
  assert.equal(renamed?.title, 'New title', '标题变更经真实会话 delta 落盘');
  assert.ok(calls.renders >= 1, '主视图刷新');
  assert.ok(calls.listRenders >= 1, '侧栏列表刷新');
});
