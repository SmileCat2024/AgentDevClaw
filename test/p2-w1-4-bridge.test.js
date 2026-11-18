/**
 * P2 W1-4（会话弹窗与精简浏览）兼容桥契约。
 *
 * 本批四个入口模块的原 classic 全局函数仍有未迁移消费方，经 kernel-state
 * 访问器桥暴露：注册键与命名导出同址、访问器不可枚举、claim 后 classic 写方
 * 经 setter 转发、分发器动作键名不变。批内已迁移消费方（trim-page → 切点核心）
 * 走命名导出，不经桥。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Marked } from 'marked';
import { installBrowserStubs, loadModuleOnce } from './helpers/esm-module-loader.js';

let cleanup = null;
const modules = {};
const registeredActions = new Map();

/* 四个模块现在直接 import 已迁宿主能力（agent-loader / agent-snapshot-loader /
 * runtime-switch / compact-resume / session-view-commit / runtime-view-cache /
 * chat-loading）；本文件只验证桥正面，宿主适配面按契约给最小桩。 */
/** classic bootstrap 状态宿主的可读写替身（真实实现是 Object.freeze 状态槽位）。 */
function stateHost(initial = {}) {
  const state = { ...initial };
  return new Proxy(state, {
    get: (target, key) => target[key],
    set: (target, key, value) => { target[key] = value; return true; },
  });
}

/** domRefs 元素替身：菜单关闭路径要 classList（出现形状与生产一致）。 */
function domRefElement() {
  return {
    innerHTML: '', style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; },
  };
}

function installHostFactories() {
  // classic P2 bootstrap 状态宿主（sidebar-operations / session-ui 装载期取用）：
  // 真实实现是 app-core/app-main/sidebar-render 的 Object.freeze 状态槽位，
  // 这里用可读写 bag 复刻其接口面。
  window.createP2BootstrapSidebarHost = () => stateHost({ restartingRuntimeIds: new Set(), suppressSidebarRerender: false });
  window.createP2BootstrapSidebarRenderHost = () => stateHost({ lastAgentListRenderSignature: '' });
  window.createP2BootstrapPhSessionHost = () => stateHost({ phSessionSortMode: 'default', phSearchQuery: '', _phSearchTimer: null, savedPhTabState: {} });
  window.createP2BootstrapDomHost = () => stateHost({
    compactContextMenu: domRefElement(),
    agentContextMenu: domRefElement(),
    projectContextMenu: domRefElement(),
    featureRepoContextMenu: domRefElement(),
    ctxMenu: domRefElement(),
    // P4 T2 尾批：sidebar-render 迁 ESM 后在模块求值期给侧栏容器装委托。
    container: domRefElement(),
    agentList: domRefElement(),
    externalAgentList: domRefElement(), externalGroup: domRefElement(),
    externalCount: domRefElement(), currentAgentTitle: domRefElement(),
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
    cache: new Map(), capacity: 20, contextKey: () => '', readView: () => ({}), signatures: () => ({}),
    todoSignature: (plan) => JSON.stringify(plan || {}), emptyTodo: () => ({}), followLatest: () => false,
    captureAnchor: () => null, scrollTop: () => 0, activeCollapseContext: () => '',
    forgetContext() {}, activateCollapse() {}, normalizeIdentity: (identity) => identity, patch() {},
    setRestoredScrollTop() {}, restoreAnchor() {}, updatePlanBadge() {},
  });
  window.createAgentCallStatesHost = () => ({
    calling: new Map(), suspended: new Set(), interrupting: new Map(), finished: new Set(),
    agents: () => [], currentRuntimeId: () => null, runtimeId: () => '', remoteEntries: () => [],
    normalize: (value) => value, resolveCalling: () => false, isSuspended: () => false,
    markStarted() {}, syncActionButton() {}, isSseActive: () => false, isRemote: () => false,
    fetch: (...args) => globalThis.fetch(...args), now: () => 0, lastRefresh: () => 0,
    setLastRefresh() {}, render() {},
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
    viewer: () => globalThis.fetch('/api/agents'),
    loadLayout: () => undefined, loadProjects: () => undefined,
    schedule: (callback, delay) => setTimeout(callback, delay), diagnostic: () => {},
    runtimeId: (agent) => agent?.id || '', agentRuntimeId: (agent) => agent?.id || '',
    logicalId: (agent) => agent?.id || '', mergeSessions: (previous) => previous,
    reconcileStops() {}, pruneCallStates() {}, renderList() {}, renderPanel() {},
    refreshCalls: async () => {}, isRemote: () => false, fallback: () => null,
    loadDetail: async () => {}, selectSurface() {}, preferHome() {}, resolveFocus: () => null,
    clickPrebuilt() {}, loadData: async () => {}, warn() {}, error() {}, log() {},
  });
  // context-menu（本批 closeCompactMenu 的 producer）装载期取该 host 面
  window.createP2BootstrapContextMenuHost = () => stateHost({
    contextMenuAgentId: '', contextMenuAgentMode: '', contextMenuCompactAction: '',
    contextMenuProjectAgentId: '', contextMenuProjectId: '', contextMenuFeatureRepoPackageId: '',
  });
  // 表面导航宿主（classic app-ui 工厂）：trim-page → project-data → assembly-actions
  // 的 import 链触达 workspace-surface-host，后者在求值期取该工厂。
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
    state: {}, switchAgent: async () => {}, setTimeout: (callback) => setTimeout(callback, 0),
  });
  window.createCompactResumeHost = () => ({
    isRemote: () => false, remote: () => null, createOperationId: () => 'op-auto', now: () => 0,
    observe: () => () => {}, checkpoint() {}, fetch: (...args) => globalThis.fetch(...args),
    idempotencyKey: () => 'test-key', refreshThreads() {},
  });
}

before(async () => {
  cleanup = installBrowserStubs({
    window: {
      // vendor 面：index.html 的 marked UMD 标签先于 module 标签执行，markdown-utils
      // 在求值期就要 `new marked.Renderer()`。
      marked: new Marked(),
      escapeHtml: (text) => String(text),
      ClawFW: { actions: { registerMany(map) { for (const [name, handler] of Object.entries(map)) registeredActions.set(name, handler); } } },
      setTimeout: (callback, delay) => setTimeout(callback, delay),
      clearTimeout: (id) => clearTimeout(id),
    },
  });
  await loadModuleOnce('public/src/modules/kernel-state.js', { installGlobals: false });
  installHostFactories();
  for (const [name, path] of Object.entries({
    trimPage: 'public/src/modules/trim-page.js',
    sessionDialogs: 'public/src/modules/session-dialogs.js',
    sessionReadonlyView: 'public/src/modules/session-readonly-view.js',
    threadHistory: 'public/src/modules/ph-thread-history.js',
  })) {
    modules[name] = (await loadModuleOnce(path, { installGlobals: false })).module;
  }
});

after(() => { cleanup(); });

test('classic 入口键经桥暴露，且与命名导出同址', () => {
  // openTrimPage 的桥已注销：消费方（workspace-actions 管理菜单 / ctx-menu-items
  // 右键）都已验收为 ESM 直接 import，classic 消费面归零
  assert.equal(typeof modules.trimPage.openTrimPage, 'function');
  assert.equal(window.openTrimPage, undefined, 'openTrimPage 的桥已注销');
  assert.equal(window.openReadOnlySession, modules.sessionReadonlyView.openReadOnlySession);
  assert.equal(window.closeReadOnlySession, modules.sessionReadonlyView.closeReadOnlySession);
  assert.equal(window.getReadOnlySessionTarget, modules.sessionReadonlyView.getReadOnlySessionTarget);
  assert.equal(window.updateReadOnlySessionIndicator, modules.sessionReadonlyView.updateReadOnlySessionIndicator);
});

test('消费方改 import 后桥已注销（入口仍是命名导出）', () => {
  // ctx-menu-handlers / ctx-menu-items / session-list-render 已直接 import。
  assert.equal(window.openBranchDialog, undefined);
  assert.equal(window.phOpenRenameDialog, undefined);
  assert.equal(window.phOpenThreadHistory, undefined);
  assert.equal(typeof modules.sessionDialogs.openBranchDialog, 'function');
  assert.equal(typeof modules.sessionDialogs.phOpenRenameDialog, 'function');
  assert.equal(typeof modules.threadHistory.openThreadHistory, 'function');
});

test('桥键不进枚举面（与原顶层函数挂 global 的 for-in 语义一致）', () => {
  for (const key of ['openReadOnlySession']) {
    assert.equal(Object.prototype.propertyIsEnumerable.call(window, key), false, `${key} must not be enumerable`);
    assert.equal(Object.keys(window).includes(key), false, `${key} must not leak into Object.keys`);
  }
});

test('claim 之后 classic 写方经 setter 转发进模块桥值', () => {
  for (const key of ['openReadOnlySession']) {
    const original = window[key];
    const sentinel = async () => ({ ok: false, reason: 'sentinel' });
    window[key] = sentinel; // classic 写方（测试 / 宿主覆盖）
    assert.equal(window[key], sentinel, `claim 后的 setter 必须保留写值：${key}`);
    window[key] = original;
    assert.equal(window[key], original, `恢复后读回原实现：${key}`);
  }
  // 仍装配桥键的域经 claim 认领（本批只剩 session-readonly-view 的 4 个入口；
  // trim-page / session-dialogs / ph-thread-history 已零桥键，不再注册该域认领）。
  // 计数是整张 ESM 图的全局量（含传递依赖注册的桥），故按下限断言。
  const stats = window.KernelState.stats();
  assert.ok(stats.registeredKeys >= 5, `expected >= 5 registered bridge keys, got ${stats.registeredKeys}`);
  assert.ok(stats.claimedKeys >= 2, `expected >= 2 claimed keys, got ${stats.claimedKeys}`);
  // trim-page 域不再认领：它的入口只剩命名导出（无 window 访问器 = 无键可认领）
  assert.equal(window.openTrimPage, undefined);
});

test('分发器动作键名保持不变（index.html 与卡片按钮依赖）', () => {
  for (const name of [
    'trimPage.close', 'trimPage.submit',
    'sessionDialogs.closeBranch', 'sessionDialogs.submitBranch', 'sessionDialogs.closeRename',
    'phHistory.close', 'phHistory.viewOriginal', 'phHistory.continueFrom',
  ]) {
    assert.equal(typeof registeredActions.get(name), 'function', `missing action handler: ${name}`);
  }
});
