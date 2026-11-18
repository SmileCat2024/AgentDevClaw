import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Marked } from 'marked';
import { installBrowserStubs, loadModuleOnce } from './helpers/esm-module-loader.js';

function makeElement() {
  const listeners = new Map();
  const classes = new Set();
  return {
    listeners,
    style: {},
    dataset: {},
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      toggle: (name, force) => force ? classes.add(name) : classes.delete(name),
      contains: (name) => classes.has(name),
    },
    addEventListener(type, callback) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(callback);
    },
    dispatch(type, event = {}) {
      for (const callback of listeners.get(type) || []) callback(event);
    },
    querySelectorAll() { return []; },
    querySelector() { return null; },
    closest() { return null; },
    scrollIntoView() {},
    innerHTML: '',
    textContent: '',
    value: '',
    checked: false,
    disabled: false,
  };
}

/* ── 文件级宿主桩与真实 ESM 依赖 ──────────────────────────────────────
 * trim-page.js 已迁 ESM（P2 W1-4）：切点核心 trim-ratio-core 与语言/状态
 * owner 走真实 import（本文件直接导入同一模块实例，状态经 setter 驱动）；
 * 仍为 classic 的渲染、侧栏操作与精简请求宿主面以 window 桩提供。
 * window 桩只装一次：kernel-state 的访问器绑定在首个 window 上，域模块的
 * claim 与桥键都挂在它下面。
 * ------------------------------------------------------------------ */

const actions = {
  handlers: new Map(),
  registerMany(map) {
    for (const [name, handler] of Object.entries(map)) this.handlers.set(name, handler);
  },
  invoke(name, el) {
    const handler = this.handlers.get(name);
    if (!handler) throw new Error(`no action handler registered: ${name}`);
    return handler(el);
  },
};

let cleanupGlobals = null;
let agentStore = null;
let orchestration = null;
let renderEntry = null;
let i18n = null;
let chatLoading = null;
let originalDocument = null;
let originalFetch = null;

/* 真实宿主适配器的依赖桩（审核要求：已 ESM 宿主必须直接 import）。
 * trim-page 现在 import agent-snapshot-loader / runtime-switch / compact-resume /
 * chat-loading；这些宿主在装载期经 window.createXHost() 取 classic 适配面。
 * 下面按各 host 契约提供最小实现并记录调用——被测模块的行为断言落在这些真实
 * 调用点上（切点请求、精简请求、导航目标、加载态），而不是替换被测模块的依赖。 */
const hostCalls = {
  switched: [], cacheSaves: [], compactRequests: [], operationIds: [],
  viewerRequests: 0, threadRefreshes: 0, listRenders: 0, applied: [],
  identity: null, view: {},
};
const runtimeCache = new Map();
// 真实 sidebar-operations 的 operation 阶段经 console.info('[SIDEBAR_OPERATION]') 播报
const sidebarPhases = [];
let originalConsoleInfo = null;

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

function resetHostCalls() {
  hostCalls.switched.length = 0;
  hostCalls.cacheSaves.length = 0;
  hostCalls.compactRequests.length = 0;
  hostCalls.operationIds.length = 0;
  hostCalls.applied.length = 0;
  hostCalls.viewerRequests = 0;
  hostCalls.threadRefreshes = 0;
  hostCalls.listRenders = 0;
  hostCalls.identity = null;
  hostCalls.view = {};
  runtimeCache.clear();
  sidebarPhases.length = 0;
}

/** classic bootstrap 状态宿主的可读写替身（真实实现是 Object.freeze 状态槽位）。 */
function stateHost(initial = {}) {
  const state = { ...initial };
  return new Proxy(state, {
    get: (target, key) => target[key],
    set: (target, key, value) => { target[key] = value; return true; },
  });
}

function installHostFactories() {
  // classic P2 bootstrap 状态宿主（sidebar-operations / session-ui 装载期取用）：
  // 真实实现是 app-core/app-main/sidebar-render 的 Object.freeze 状态槽位，
  // 这里用可读写 bag 复刻其接口面。
  window.createP2BootstrapSidebarHost = () => stateHost({
    restartingRuntimeIds: new Set(), pendingPrebuiltAgentIds: new Set(), suppressSidebarRerender: false,
  });
  window.createP2BootstrapSidebarRenderHost = () => stateHost({ lastAgentListRenderSignature: '' });
  window.createP2BootstrapPhSessionHost = () => stateHost({ phSessionSortMode: 'default', phSearchQuery: '', _phSearchTimer: null, savedPhTabState: {} });
  // DOM 引用面：trim-page 现在 import context-menu 的 closeCompactMenu（真实实现读
  // domRefs.compactContextMenu 与菜单状态 owner），按 app-core 工厂同形给元素替身。
  window.createP2BootstrapDomHost = () => stateHost({
    compactContextMenu: makeElement(),
    agentContextMenu: makeElement(),
    projectContextMenu: makeElement(),
    featureRepoContextMenu: makeElement(),
    ctxMenu: makeElement(),
    container: makeElement(),
    agentList: makeElement(),
    // P4 T2 收尾批次：sidebar-render 迁 ESM 后 renderAgentList 会写外部列表三件
    // （生产 app-core 的加载期 DOM 引用）。本文件不渲染侧栏，只要求装载/失效链
    // 可解析，按同一元素替身补齐。
    externalAgentList: makeElement(), externalGroup: makeElement(), externalCount: makeElement(),
    currentAgentTitle: makeElement(),
    featurePanel: makeElement(),
  });
  window.createP2BootstrapAssemblyHost = () => stateHost({});
  window.createP2BootstrapCallActivityHost = () => stateHost({
    _agentCallActive: new Map(), _recentlyFinishedRuntimes: new Set(),
    _seenChoiceAlertIds: new Set(), _autoTitleTriggered: new Set(),
    _interruptSuppression: new Map(), _lastInterruptUserActionAt: 0,
  });
  window.createP2BootstrapChatSurfaceHost = () => stateHost({});
  window.createP2BootstrapChoiceInputHost = () => stateHost({ state: {} });
  window.createP2BootstrapDebugPanelHost = () => stateHost({ logFilters: {} });
  // context-menu（closeCompactMenu 的 producer）装载期取该 host 面
  window.createP2BootstrapContextMenuHost = () => stateHost({
    contextMenuAgentId: '', contextMenuAgentMode: '', contextMenuCompactAction: '',
    contextMenuProjectAgentId: '', contextMenuProjectId: '', contextMenuFeatureRepoPackageId: '',
  });
  window.createP2BootstrapSessionSwitchHost = () => stateHost({});
  window.AgentLoaderHost = { loadedAgentDetailIds: new Set() };
  window.createCallInterruptHost = () => ({ pending: new Map(), now: () => 0 });
  window.createSessionViewCommitHost = () => ({
    identity: () => hostCalls.identity,
    read: () => hostCalls.view,
    apply: (patch) => { hostCalls.applied.push(patch); },
    normalizeModel: (value) => value || {},
  });
  window.createRuntimeViewCacheHost = () => ({
    cache: runtimeCache,
    capacity: 20,
    contextKey: (runtimeId) => `ctx:${runtimeId}`,
    readView: () => hostCalls.view,
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
    patch: (patch) => { hostCalls.applied.push(patch); },
    setRestoredScrollTop() {},
    restoreAnchor() {},
    updatePlanBadge() {},
  });
  window.createAgentCallStatesHost = () => ({
    calling: new Map(), suspended: new Set(), interrupting: new Map(), finished: new Set(),
    agents: () => agentStore.allAgents,
    currentRuntimeId: () => orchestration.currentRuntimeAgentId,
    runtimeId: (agent) => agent?.id || '',
    remoteEntries: () => [],
    normalize: (value) => value,
    resolveCalling: () => false,
    isSuspended: () => false,
    markStarted() {}, syncActionButton() {},
    isSseActive: () => false,
    isRemote: () => false,
    fetch: (...args) => globalThis.fetch(...args),
    now: () => 0,
    lastRefresh: () => 0,
    setLastRefresh() {},
    render() {},
  });
  window.createSessionDataLoaderHost = () => ({
    isUiOnly: () => false,
    setRuntime() {},
    apply: (patch) => { hostCalls.applied.push(patch); },
    capture: () => null,
    isCurrent: () => false,
    messagesCurrent: () => false,
    patch() {},
    focused: () => null,
    activePanel: () => null,
    fetch: (...args) => globalThis.fetch(...args),
    notify() {}, resetSurface() {}, render() {}, renderPanel() {},
    clearTemplates() {}, loadTemplates: async () => {}, refreshBadges() {},
    resetRuntimeStatus() {}, activateCollapse() {}, clearRecap() {}, emptyTodo: () => ({}),
    attachTimestamps: (messages) => messages, recheckTitle() {}, clearLoading() {},
    updateRollback() {}, templateNames: () => [], warmTemplates() {}, updateContext() {},
    updateModel() {}, updateThinking() {}, updatePlan() {},
    loadDetail: async () => {}, refreshStatus: async () => {}, loadLogs() {}, warn() {}, error() {},
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
    now: () => 0,
    captureToken: () => null,
    isTokenCurrent: () => true,
    ownership: () => ({}),
    connected: () => Promise.resolve([]),
    viewer: () => { hostCalls.viewerRequests += 1; return globalThis.fetch('/api/agents'); },
    loadLayout: () => undefined,
    loadProjects: () => undefined,
    schedule: (callback, delay) => setTimeout(callback, delay),
    diagnostic: () => {},
    runtimeId: (agent) => agent?.id || '',
    agentRuntimeId: (agent) => agent?.id || '',
    logicalId: (agent) => agent?.id || '',
    mergeSessions: (previous) => previous,
    reconcileStops() {},
    pruneCallStates() {},
    renderList: () => { hostCalls.listRenders += 1; },
    renderPanel() {},
    refreshCalls: async () => {},
    isRemote: () => false,
    fallback: () => null,
    loadDetail: async () => {},
    selectSurface() {},
    preferHome() {},
    resolveFocus: () => null,
    clickPrebuilt() {},
    loadData: async () => {},
    warn() {}, error() {}, log() {},
  });
  // 表面导航宿主（classic app-ui 的 createWorkspaceSurfaceHost）：trim-page 经
  // project-data → assembly-actions 的 import 链触达 workspace-surface-host，
  // 后者在求值期取该工厂。本文件的导航走 setPreferredUnitMode，工厂只按契约给面。
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
  window.createRuntimeSwitchHost = () => ({
    state: {},
    switchAgent: async (runtimeId) => { hostCalls.switched.push(runtimeId); },
    setTimeout: (callback) => setTimeout(callback, 0),
  });
  window.createCompactResumeHost = () => ({
    isRemote: () => false,
    remote: () => null,
    createOperationId: (reason) => { hostCalls.operationIds.push(reason); return 'op-auto'; },
    now: () => 0,
    observe: () => () => {},
    checkpoint() {},
    fetch: (...args) => { hostCalls.compactRequests.push(args); return globalThis.fetch(...args); },
    idempotencyKey: () => 'test-idempotency-key',
    refreshThreads: () => { hostCalls.threadRefreshes += 1; },
  });
}

before(async () => {
  cleanupGlobals = installBrowserStubs({
    window: {
      // vendor 面：index.html 的 marked UMD 标签先于 module 标签执行，markdown-utils
      // 在求值期就要 `new marked.Renderer()`。
      marked: new Marked(),
      escapeHtml: (text) => String(text).replace(/[&<>"']/g, (m) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
      }[m])),
      ClawFW: { actions },
      // 轮询协调器宿主（classic app-main 的工厂）：ESM 图经
      // agent-data-loader → input-actions 触达 poll-coordinator-host，后者在模块
      // 求值期取该工厂。本文件不驱动轮询，按同形契约给替身。
      createPollCoordinatorHost: () => ({
        run: async () => {}, fastInterval: () => 1000, setTimeout: () => 0, clearTimeout: () => {},
      }),
      // 真实宿主的计时能力（chat-loading / runtime-switch 的延迟合并）
      setTimeout: trackedSetTimeout,
      clearTimeout: trackedClearTimeout,
      requestAnimationFrame: (callback) => trackedSetTimeout(() => callback(Date.now()), 0),
    },
  });
  // localStorage 是浏览器全局（非 window 属性）：精简比例的读写只是尽力而为，
  // 给最小替身让读取路径走真实代码分支。
  globalThis.localStorage = { getItem: () => null, setItem() {} };
  originalDocument = globalThis.document;
  originalFetch = globalThis.fetch;
  originalConsoleInfo = console.info;
  console.info = (...args) => {
    if (args[0] === '[SIDEBAR_OPERATION]' && args[1] && typeof args[1] === 'object') sidebarPhases.push(args[1]);
    else originalConsoleInfo(...args);
  };
  await loadModuleOnce('public/src/modules/kernel-state.js', { installGlobals: false });
  installHostFactories();
  // 无唯一 query → 与域模块内部 import 同址，共用同一模块实例（状态唯一 owner）
  agentStore = await import('../public/src/modules/agent-store-state.js');
  orchestration = await import('../public/src/modules/orchestration-state.js');
  renderEntry = await import('../public/src/modules/render-entry-state.js');
  i18n = await import('../public/src/modules/i18n-environment-state.js');
  chatLoading = await import('../public/src/modules/chat-loading-host.js');
});

after(() => {
  clearPendingTimers();
  if (originalConsoleInfo) console.info = originalConsoleInfo;
  globalThis.document = originalDocument;
  globalThis.fetch = originalFetch;
  delete globalThis.localStorage;
  cleanupGlobals();
});

const roundFixture = [
  { userPreview: 'first', assistantPreview: 'reply 1', charPercent: 0.25, cumulativePercent: 0.25, suggestedTrim: false, turnStart: 1, msgIndexStart: 0, msgIndexEnd: 2, toolCalls: [] },
  { userPreview: 'second', assistantPreview: 'reply 2', charPercent: 0.25, cumulativePercent: 0.5, suggestedTrim: false, turnStart: 2, msgIndexStart: 3, msgIndexEnd: 4, toolCalls: [] },
];

// 比例模式切点由真实 trim-ratio-core 计算：tool 结果体量决定折叠能释放多少
// 上下文，足够大时 30% 以上比例会落在轮内（partial）区间。
function messageFixture(toolCharCount) {
  return [
    { index: 0, role: 'user', roundIndex: 0, preview: 'first', charCount: 10, contentCharCount: 10 },
    { index: 1, role: 'assistant', roundIndex: 0, preview: '', charCount: 5, contentCharCount: 0, toolCalls: [{ id: 'a', name: 'read', summary: 'read(a)' }] },
    { index: 2, role: 'tool', roundIndex: 0, charCount: toolCharCount, contentCharCount: 0, toolCallId: 'a' },
    { index: 3, role: 'assistant', roundIndex: 0, preview: 'assistant anchor', charCount: 10, contentCharCount: 10 },
    { index: 4, role: 'user', roundIndex: 1, preview: 'second', charCount: 10, contentCharCount: 10 },
    { index: 5, role: 'assistant', roundIndex: 1, preview: 'reply 2', charCount: 10, contentCharCount: 10 },
  ];
}

const payloadOf = (messages) => ({
  preamblePercent: 0.1,
  preambleCharCount: 10,
  rounds: roundFixture,
  messages,
});

const okFetch = (payload) => async () => ({ ok: true, json: async () => payload });

/** 每例的宿主桩：记录调用，按需覆盖单例行为。 */
function createHostStubs(calls) {
  return {
    closeCompactMenu() {},
    // 身份/侧栏渲染面（app-core / app-ui 的全局，本裁剪链不含）：操作失效会真实
    // 走进 sidebar-render 的渲染签名，身份归一与渲染落地不在本文件断言面。
    normalizeAgentIdentity: (value) => String(value || '').trim(),
    fmtPct: (frac) => (frac * 100).toFixed(1) + '%', // app-core 全局的桩替身
    alert(message) { calls.alerts.push(String(message)); },
    isThreadHostAgentId: () => false,
    renderCurrentMainView: () => { calls.render += 1; },
    getCurrentAgentRecord: () => null,
    setPreferredUnitMode: () => {},
    markSessionLoading: () => {},
    clearSessionLoading: () => { calls.clearSessionLoading += 1; },
    getActiveSessionId: () => '',
    updateAgentRecord: (agentId, patch) => {
      agentStore.setAllAgents(agentStore.allAgents.map((agent) => (
        agent.id === agentId ? { ...agent, ...patch } : agent
      )));
    },
    waitForTargetRuntimeSession: async () => null,
    beginChatLoadingSession: () => { calls.beginChatLoading += 1; },
    clearChatLoadingSession: () => {},
    upsertConnectedAgent: (agent) => agent,
    getRuntimeId: (agent) => agent?.id || '',
    isRemoteNamespaceAgentId: () => false,
    getWorkspaceSessionById: () => null,
    getPathLeaf: () => '',
    createCompactedResumeSession: async () => ({ session: { id: 'session-B', title: 'Trimmed' }, revision: 1 }),
    loadAgents: async () => {},
    requestSwitch: async (runtimeId, source) => { calls.requestSwitch += 1; calls.switches.push([runtimeId, source]); },
    refreshThreads: async () => { calls.refreshThreads += 1; return { ok: true }; },
    bumpNavigationGuard: () => {},
    RemoteConnections: null,
  };
}

function createCallRecorder() {
  return {
    alerts: [],
    switches: [],
    beginChatLoading: 0,
    requestSwitch: 0,
    refreshThreads: 0,
    clearSessionLoading: 0,
    settled: 0,
    render: 0,
  };
}

/* 模块实例、元素表与 document 桩在文件内共享：桥键只能注册一次（桥键唯一
 * 注册制），每例通过复位元素字段与模块页面状态来隔离，而不是重新装载模块。 */
let trimPage = null;
let elements = null;

function resetElements() {
  for (const el of elements.values()) {
    el.innerHTML = '';
    el.textContent = '';
    el.value = '';
    el.checked = false;
    el.disabled = false;
    el.style = {};
    el.dataset = {};
    el.querySelector = () => null;
    el.querySelectorAll = () => [];
    el.closest = () => null;
  }
}

/**
 * 每例准备：复位共享 DOM 与模块页面状态，换上本例的宿主桩、fetch 与状态。
 */
async function createTrimPage({ fetchImpl, host = {} } = {}) {
  if (!trimPage) {
    elements = new Map();
    const documentStub = {
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, makeElement());
        return elements.get(id);
      },
      // 真实 document 形状：action-dispatcher / markdown-utils 在加载期绑监听；
      // 侧栏渲染入口在失效时读 querySelector('.agent-runtime-item.editing')。
      addEventListener() {},
      removeEventListener() {},
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: () => makeElement(),
      body: { appendChild() {}, removeChild() {} },
      activeElement: null,
    };
    globalThis.document = documentStub;
    window.document = documentStub;
    const { module } = await loadModuleOnce('public/src/modules/trim-page.js', { installGlobals: false });
    trimPage = module;
  }
  const calls = createCallRecorder();
  clearPendingTimers();
  resetHostCalls();
  chatLoading.clearChatLoadingSession();
  Object.assign(window, createHostStubs(calls), host);
  // 侧栏布局域（app-ui）与渲染落地不在本文件断言面：操作失效会真实调用
  // sidebar-render 的 renderAgentList，按布局接口给最小面。
  if (typeof window.ClawSidebarLayout !== 'object' || !window.ClawSidebarLayout) {
    window.ClawSidebarLayout = { load: async () => {}, signature: () => '', isInteracting: () => false, render() {} };
  }
  if (typeof window.groupConnectedAgents !== 'function') {
    window.groupConnectedAgents = (agents) => ({ external: Array.isArray(agents) ? agents : [] });
  }
  if (typeof window.updateCurrentAgentChrome !== 'function') window.updateCurrentAgentChrome = () => {};
  globalThis.fetch = fetchImpl || okFetch(payloadOf(messageFixture(20)));
  agentStore.setAllAgents([]);
  orchestration.setCurrentRuntimeAgentId('');
  orchestration.setNavigationGuardEpoch(1);
  orchestration.setSwitchEpoch(0);
  orchestration.setPendingSwitchSerial(0);
  orchestration.setPendingSwitchTarget(null);
  renderEntry.setLastRenderedWorkspaceHtml('stale-html');
  i18n.setCurrentLanguage('zh');
  resetElements();
  // 上一例的页面状态不跨例：关闭重置页面状态与打开序号。
  actions.invoke('trimPage.close');
  resetElements();
  return { module: trimPage, elements, calls };
}

/** 让真实 loadAgents / 侧栏刷新等 fire-and-forget 链在本用例内收尾。 */
const flush = async () => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
};

const clickEvent = (selector, target) => ({ target: { closest: (query) => query === selector ? target : null } });

/** 比例模式的确定性切点入口：点击轴上节点设切点（真实交互路径）。 */
function setCutByClick(elements, cutIndex) {
  elements.get('trim-page-list').dispatch('click', clickEvent('[data-set-cut]', { dataset: { setCut: String(cutIndex) } }));
}

describe('trim page timeline interactions', () => {
  it('keeps the round action visible under the timeline node selector', async () => {
    const css = fs.readFileSync(new URL('../public/styles/components.css', import.meta.url), 'utf8');
    assert.match(css, /\.trim-tl-node\.manual \.trim-to-here-btn\s*\{[^}]*opacity:\s*1/s);
  });

  it('renders exactly one in-round cut marker immediately after a ratio slider update', async () => {
    const { module, elements } = await createTrimPage({ fetchImpl: okFetch(payloadOf(messageFixture(240))) });
    await module.openTrimPage('programming-helper', 'session-1');
    const mode = elements.get('trim-page-mode');
    const ratioButton = { dataset: { mode: 'ratio' } };
    mode.dispatch('click', clickEvent('.trim-page-mode-btn', ratioButton));
    const slider = elements.get('trim-page-ratio-slider');
    slider.value = '52';
    slider.dispatch('input');

    const html = elements.get('trim-page-list').innerHTML;
    assert.equal((html.match(/class="trim-tl-cut"/g) || []).length, 1, 'in-round cut marker must be present exactly once');
    assert.match(html, /assistant anchor/, 'cut context around the assistant message must be rendered');
    assert.match(html, /保留从这里开始/);
    assert.match(html, /第 1 轮 · 1 次调用/, 'collapsed round rows report a call count instead of tool names');
  });

  it('places the cut marker after the matching assistant anchor inside the round', async () => {
    const { module, elements } = await createTrimPage({ fetchImpl: okFetch(payloadOf(messageFixture(240))) });
    await module.openTrimPage('programming-helper', 'session-1');
    elements.get('trim-page-mode').dispatch('click', clickEvent('.trim-page-mode-btn', { dataset: { mode: 'ratio' } }));
    setCutByClick(elements, 3);

    const html = elements.get('trim-page-list').innerHTML;
    assert.equal((html.match(/class="trim-tl-cut"/g) || []).length, 1);
    assert.match(html, /class="trim-tl-chip"[^>]*>read · 240<\/button><div class="trim-tl-cut">[\s\S]*?<div class="trim-tl-dnode text">assistant anchor/);
  });

  it('adjusts the ratio with the mouse wheel over the slider', async () => {
    const { module, elements } = await createTrimPage();
    await module.openTrimPage('programming-helper', 'session-1');
    elements.get('trim-page-mode').dispatch('click', clickEvent('.trim-page-mode-btn', { dataset: { mode: 'ratio' } }));
    const slider = elements.get('trim-page-ratio-slider');
    assert.equal(slider.value, '30');

    slider.dispatch('wheel', { deltaY: -100, preventDefault() {} });
    assert.equal(slider.value, '31', 'wheel up increments the ratio');

    slider.dispatch('wheel', { deltaY: 120, preventDefault() {} });
    assert.equal(slider.value, '30', 'wheel down decrements the ratio');
    assert.equal(elements.get('trim-page-ratio-input').value, '30', 'number input stays in sync');
  });

  it('keeps the viewport still on re-render while the cut stays inside the safe zone', async () => {
    const { module, elements } = await createTrimPage({ fetchImpl: okFetch(payloadOf(messageFixture(240))) });
    await module.openTrimPage('programming-helper', 'session-1');
    elements.get('trim-page-mode').dispatch('click', clickEvent('.trim-page-mode-btn', { dataset: { mode: 'ratio' } }));
    const list = elements.get('trim-page-list');
    const scrollBody = {
      scrollTop: 80,
      getBoundingClientRect: () => ({ top: 0, bottom: 600 }),
    };
    list.closest = () => scrollBody;
    // 切点位于视口中部（安全区内）：重绘后视口纹丝不动
    list.querySelector = () => ({
      offsetTop: 40,
      getBoundingClientRect: () => ({ top: 250, bottom: 270 }),
      scrollIntoView() {},
    });

    const slider = elements.get('trim-page-ratio-slider');
    slider.value = '52';
    slider.dispatch('input');
    slider.dispatch('wheel', { deltaY: -100, preventDefault() {} });
    slider.dispatch('wheel', { deltaY: -100, preventDefault() {} });

    assert.equal(scrollBody.scrollTop, 80, 'algorithmic adjustments never pan the list while the cut is visible');
  });

  it('nudges the scroll minimally when the cut approaches the viewport edge', async () => {
    const { module, elements } = await createTrimPage({ fetchImpl: okFetch(payloadOf(messageFixture(240))) });
    await module.openTrimPage('programming-helper', 'session-1');
    elements.get('trim-page-mode').dispatch('click', clickEvent('.trim-page-mode-btn', { dataset: { mode: 'ratio' } }));
    const list = elements.get('trim-page-list');
    const scrollBody = {
      scrollTop: 80,
      getBoundingClientRect: () => ({ top: 0, bottom: 600 }),
    };
    list.closest = () => scrollBody;
    // 第一次查询（重绘前 hadCut）也返回元素，模拟切点已存在；重绘后
    // 切点被内容顶到视口上方 100px → 以最小滚动量带回上缘安全区
    let queries = 0;
    list.querySelector = () => {
      queries += 1;
      return {
        offsetTop: 40,
        getBoundingClientRect: () => queries <= 1 ? { top: 300, bottom: 320 } : { top: -100, bottom: -80 },
        scrollIntoView() {},
      };
    };

    const slider = elements.get('trim-page-ratio-slider');
    slider.value = '52';
    slider.dispatch('input');

    // margin = 600 * 0.15 = 90；cut top -100 < 90 → scrollTop 80 + (-100-90) → 钳 0
    assert.equal(scrollBody.scrollTop, 0, 'cut above the viewport scrolls back just enough to reveal it');
  });

  it('keeps the viewport still when the user clicks a node to set the cut', async () => {
    const { module, elements } = await createTrimPage();
    await module.openTrimPage('programming-helper', 'session-1');
    elements.get('trim-page-mode').dispatch('click', clickEvent('.trim-page-mode-btn', { dataset: { mode: 'ratio' } }));
    const list = elements.get('trim-page-list');
    const scrollBody = { scrollTop: 80 };
    list.closest = () => scrollBody;
    list.querySelector = () => ({ offsetTop: 40, scrollIntoView() {} });

    setCutByClick(elements, 4);

    assert.equal(scrollBody.scrollTop, 80, 'clicking to set the cut must not pan the list');
    const sliderValue = Number(elements.get('trim-page-ratio-slider').value);
    assert.ok(sliderValue >= 5 && sliderValue <= 95, 'the ratio control follows the clicked cut inside its clamp range');
    assert.equal((list.innerHTML.match(/class="trim-tl-cut"/g) || []).length, 1);
  });

  it('restores the round-level 精简到此处 operation', async () => {
    const { module, elements } = await createTrimPage();
    await module.openTrimPage('programming-helper', 'session-1');
    const list = elements.get('trim-page-list');
    assert.match(list.innerHTML, /class="trim-to-here-btn"[^>]*data-trim-to="1"/);

    const target = { dataset: { trimTo: '1' } };
    list.dispatch('click', clickEvent('.trim-to-here-btn[data-trim-to]', target));
    assert.equal((list.innerHTML.match(/ checked/g) || []).length, 2, '精简到此处 marks this round and earlier rounds');
    assert.match(list.innerHTML, /精简到此处/);
  });

  it('derives the submit label from the current toggles, not the entry point', async () => {
    const { module, elements } = await createTrimPage();
    const submit = elements.get('trim-page-submit');
    const summary = elements.get('trim-page-summary-toggle');
    const archive = elements.get('trim-page-archive-toggle');

    // 普通入口：默认两个勾选都空 → 基础文案
    await module.openTrimPage('programming-helper', 'session-1');
    assert.equal(submit.textContent, '确认精简');

    // 勾选摘要 → 文案跟随；再勾归档 → 组合文案
    summary.checked = true;
    summary.dispatch('change');
    assert.equal(submit.textContent, '精简并生成摘要');
    archive.checked = true;
    archive.dispatch('change');
    assert.equal(submit.textContent, '精简、生成摘要并归档');
    summary.checked = false;
    summary.dispatch('change');
    assert.equal(submit.textContent, '精简并归档');
    archive.checked = false;
    archive.dispatch('change');
    assert.equal(submit.textContent, '确认精简');

    // 归档入口：初始勾上归档（入口形态只决定初始勾选，不锁死按钮）
    await module.openTrimPage('programming-helper', 'session-1', true);
    assert.equal(submit.textContent, '精简并归档');
    assert.equal(archive.checked, true);
    archive.checked = false;
    archive.dispatch('change');
    assert.equal(submit.textContent, '确认精简');
  });
});

describe('trim page keep-zone dialogue guard', () => {
  // 打断/任务提醒注入形态：末轮工具结果之后跟一条 system 注入消息。
  // 其后的切点保留区不含任何对话消息——提交后末轮对话全部被折叠
  // （实测事故：handoff preservedMsgRanges=[[277,277]]）。
  const payloadWithMessages = (messages) => ({
    preamblePercent: 0.1,
    preambleCharCount: 10,
    rounds: [{ userPreview: 'task', assistantPreview: '', charPercent: 0.8, cumulativePercent: 0.8, suggestedTrim: false, turnStart: 1, msgIndexStart: 0, msgIndexEnd: messages.length - 1, toolCalls: [] }],
    messages,
  });

  it('renders the tail tool chip as a plain span when the keep zone holds only the injected system message', async () => {
    const messages = [
      { index: 0, role: 'user', roundIndex: 0, preview: 'task', charCount: 10, contentCharCount: 10 },
      { index: 1, role: 'assistant', roundIndex: 0, preview: '', charCount: 5, contentCharCount: 0, toolCalls: [{ id: 'a', name: 'edit', summary: 'edit(a)' }] },
      { index: 2, role: 'tool', roundIndex: 0, charCount: 20, contentCharCount: 0, toolCallId: 'a' },
      { index: 3, role: 'assistant', roundIndex: 0, preview: '', charCount: 5, contentCharCount: 0, toolCalls: [{ id: 'b', name: 'write', summary: 'write(b)' }] },
      { index: 4, role: 'tool', roundIndex: 0, charCount: 20, contentCharCount: 0, toolCallId: 'b' },
      { index: 5, role: 'system', roundIndex: 0, charCount: 15, contentCharCount: 15 },
    ];
    const { module, elements } = await createTrimPage({ fetchImpl: okFetch(payloadWithMessages(messages)) });
    await module.openTrimPage('programming-helper', 'session-1');
    elements.get('trim-page-mode').dispatch('click', clickEvent('.trim-page-mode-btn', { dataset: { mode: 'ratio' } }));
    // 切点 3 入轮内：detail 展开，唯一工具段 chip cutIndex=5——保留区 [5,6) 仅 system
    setCutByClick(elements, 3);
    const html = elements.get('trim-page-list').innerHTML;
    assert.doesNotMatch(html, /data-set-cut="5"/, 'chip after the last dialogue message must not be clickable');
    assert.match(html, /<span class="trim-tl-chip">/, 'the guarded chip falls back to a plain span');
  });

  it('keeps the chip clickable when dialogue text follows in the keep zone', async () => {
    const messages = [
      { index: 0, role: 'user', roundIndex: 0, preview: 'task', charCount: 10, contentCharCount: 10 },
      { index: 1, role: 'assistant', roundIndex: 0, preview: '', charCount: 5, contentCharCount: 0, toolCalls: [{ id: 'a', name: 'edit', summary: 'edit(a)' }] },
      { index: 2, role: 'tool', roundIndex: 0, charCount: 20, contentCharCount: 0, toolCallId: 'a' },
      { index: 3, role: 'assistant', roundIndex: 0, preview: '', charCount: 5, contentCharCount: 0, toolCalls: [{ id: 'b', name: 'write', summary: 'write(b)' }] },
      { index: 4, role: 'tool', roundIndex: 0, charCount: 20, contentCharCount: 0, toolCallId: 'b' },
      { index: 5, role: 'assistant', roundIndex: 0, preview: 'done', charCount: 10, contentCharCount: 10 },
      { index: 6, role: 'system', roundIndex: 0, charCount: 15, contentCharCount: 15 },
    ];
    const { module, elements } = await createTrimPage({ fetchImpl: okFetch(payloadWithMessages(messages)) });
    await module.openTrimPage('programming-helper', 'session-1');
    elements.get('trim-page-mode').dispatch('click', clickEvent('.trim-page-mode-btn', { dataset: { mode: 'ratio' } }));
    // 同一切点下工具段 chip cutIndex=5 保留区含 assistant[5] → 可点击
    setCutByClick(elements, 3);
    assert.match(elements.get('trim-page-list').innerHTML, /data-set-cut="5"/);
  });

  it('blocks submission when the keep zone holds no dialogue message', async () => {
    let fetchCalls = 0;
    const fetchImpl = async () => {
      fetchCalls += 1;
      return { ok: true, json: async () => payloadWithMessages([
        { index: 0, role: 'user', roundIndex: 0, preview: 'task', charCount: 10, contentCharCount: 10 },
        { index: 1, role: 'assistant', roundIndex: 0, preview: 'reply', charCount: 10, contentCharCount: 10 },
        { index: 2, role: 'tool', roundIndex: 0, charCount: 20, contentCharCount: 0, toolCallId: 'a' },
        { index: 3, role: 'system', roundIndex: 0, charCount: 15, contentCharCount: 15 },
      ]) };
    };
    const { module, elements, calls } = await createTrimPage({ fetchImpl });
    await module.openTrimPage('programming-helper', 'session-1');
    elements.get('trim-page-mode').dispatch('click', clickEvent('.trim-page-mode-btn', { dataset: { mode: 'ratio' } }));
    setCutByClick(elements, 3);
    const callsAfterOpen = fetchCalls;
    await actions.invoke('trimPage.submit');
    assert.ok(calls.alerts.some((m) => m.includes('对话')), `expected a dialogue-guard alert, got: ${calls.alerts.join(' | ')}`);
    assert.equal(fetchCalls, callsAfterOpen, 'submission must not fire any request past the guard');
  });
});

describe('trim page stale response guard', () => {
  const roundOf = (preview) => ({
    userPreview: preview, assistantPreview: '', charPercent: 0.2, cumulativePercent: 0.2,
    suggestedTrim: false, turnStart: 1, msgIndexStart: 0, msgIndexEnd: 0, toolCalls: [],
  });
  const stalePayload = (preview) => ({
    preamblePercent: 0.1, preambleCharCount: 10,
    rounds: [roundOf(preview)],
    messages: [{ index: 0, role: 'user', roundIndex: 0, preview, charCount: 10, contentCharCount: 10 }],
  });

  /** 可控 fetch：按 URL 分桶，响应经 deferred 手动放行（复刻 A 慢 B 快）。 */
  function deferredFetch() {
    const pending = [];
    return {
      pending,
      impl: (url) => {
        const forA = String(url).includes('session-A');
        let settle;
        const response = new Promise((resolve) => { settle = resolve; });
        pending.push({ forA, settle });
        return response;
      },
      respond: (forA, payload) => {
        const d = pending.find((item) => item.forA === forA);
        assert.ok(d, 'no pending fetch for this bucket');
        d.settle({ ok: true, json: async () => payload });
      },
    };
  }

  it('drops the slow session-A response after the page reopened for session B', async () => {
    const { impl, respond } = deferredFetch();
    const { module, elements } = await createTrimPage({ fetchImpl: impl });
    const openA = module.openTrimPage('programming-helper', 'session-A');
    const openB = module.openTrimPage('programming-helper', 'session-B');
    respond(false, stalePayload('B-round'));
    await openB;
    respond(true, stalePayload('A-round')); // A 的慢响应最后落地
    await openA;

    const html = elements.get('trim-page-list').innerHTML;
    assert.match(html, /B-round/);
    assert.doesNotMatch(html, /A-round/, '过期会话的数据不允许覆盖当前页面');
  });

  it('drops the late response after the page is closed', async () => {
    const { impl, respond } = deferredFetch();
    const { module, elements } = await createTrimPage({ fetchImpl: impl });
    const openA = module.openTrimPage('programming-helper', 'session-A');
    actions.invoke('trimPage.close');
    respond(true, stalePayload('A-round'));
    await openA;

    const html = elements.get('trim-page-list').innerHTML;
    assert.doesNotMatch(html, /A-round/, '关闭后迟到的响应不渲染');
    assert.doesNotMatch(html, /加载失败/, '过期响应的报错不落到页面上');
  });
});

describe('trim page submit: thread succession vs session navigation', () => {
  // ADR-0032：线程会话的手动精简是同一对话内的上下文接力——响应
  // threadSuccession.applied=true 时视图不导航，refreshThreads 事实对账经
  // thread-store 唯一重绑原地换头；非线程会话（存量未迁移）维持导航切换
  // （Session 语义，行为不变）。精简请求经真实 compact-resume 宿主发出。
  const compactFetch = (payload) => async (url) => {
    const target = String(url);
    if (target.includes('/context_handoffs/compact_and_resume')) {
      return { ok: true, headers: { get: () => '0' }, json: async () => payload };
    }
    if (target.includes('/session_trim_preview')) {
      return { ok: true, json: async () => payloadOf(messageFixture(20)) };
    }
    return { ok: true, json: async () => ({ agents: [] }) };
  };

  const openAndSubmit = async (module) => {
    await module.openTrimPage('programming-helper', 'session-A');
    await actions.invoke('trimPage.submit');
    await flush();
  };

  it('thread succession: stays on the view, reconciles via refreshThreads, never navigates', async () => {
    const { module, calls } = await createTrimPage({
      fetchImpl: compactFetch({
        session: { id: 'session-B', title: 'Trimmed' },
        threadSuccession: { applied: true },
        revision: 3,
      }),
    });
    await openAndSubmit(module);

    assert.deepEqual(hostCalls.switched, [], 'thread succession must not navigate');
    assert.notEqual(orchestration._chatLoadingSession, true, 'no chat-loading navigation shell');
    assert.ok(calls.refreshThreads >= 1, 'refreshThreads reconciliation must run');
    assert.ok(calls.clearSessionLoading >= 1, 'session loading flag must be cleared');
    const [url, options] = hostCalls.compactRequests[0];
    assert.equal(url, '/protoclaw/context_handoffs/compact_and_resume');
    assert.equal(options.headers['x-idempotency-key'], 'test-idempotency-key');
    const trimBody = JSON.parse(options.body);
    assert.equal(trimBody.reason, 'trim');
    assert.ok(
      sidebarPhases.some((event) => event.operationId === trimBody.operationId && event.phase === 'settled'),
      'sidebar operation settles（真实 sidebar-operations 播报）',
    );
  });

  it('non-thread session: keeps the navigation switch (unchanged legacy path)', async () => {
    const { module, calls } = await createTrimPage({
      fetchImpl: compactFetch({
        session: { id: 'session-B', title: 'Trimmed' },
        agent: { id: 'rt-B' },
        threadSuccession: { applied: false, reason: 'no_thread_for_session' },
        revision: 3,
      }),
    });
    await openAndSubmit(module);

    assert.deepEqual(hostCalls.switched, ['rt-B'], 'legacy sessions keep the navigation switch');
    assert.equal(calls.refreshThreads, 0, 'thread reconciliation must not run for plain sessions');
    assert.equal(orchestration._chatLoadingSession, true, 'navigation shell is shown before the switch');
  });
});

describe('trim page archive option vs thread-carried sessions (ADR-0032)', () => {
  // 契约：线程会话的精简是同对话内上下文接力，「归档原会话」是 Session
  // 时代的列表语义（归档链中旧快照无可见效果）——选项不得出现，提交也
  // 不得携带归档；非线程/索引未就绪会话保持原行为。
  const compactFetch = (payload) => async (url) => {
    const target = String(url);
    if (target.includes('/context_handoffs/compact_and_resume')) {
      return { ok: true, headers: { get: () => '0' }, json: async () => payload };
    }
    if (target.includes('/session_trim_preview')) {
      return { ok: true, json: async () => payloadOf(messageFixture(20)) };
    }
    return { ok: true, json: async () => ({ agents: [] }) };
  };

  it('thread session: hides the archive row and never submits archiveOriginal', async () => {
    const { module, elements } = await createTrimPage({
      fetchImpl: compactFetch({ session: { id: 'session-B' }, threadSuccession: { applied: true }, revision: 1 }),
    });
    // thread-store 挂载形态：window.isThreadHostAgentId（真实前端全局）
    window.isThreadHostAgentId = () => true;

    // 入口带归档意图（archiveAfter=true）也被钳制：初始不勾选
    await module.openTrimPage('programming-helper', 'session-A', true);
    assert.equal(elements.get('trim-page-archive-row').style.display, 'none', 'archive row must be hidden for thread sessions');
    assert.equal(elements.get('trim-page-archive-toggle').checked, false, 'archive toggle starts unchecked');

    // 线程索引在打开后才就绪的竞态：强行勾上，提交仍不得归档
    elements.get('trim-page-archive-toggle').checked = true;
    await actions.invoke('trimPage.submit');
    await flush();
    const body = JSON.parse(hostCalls.compactRequests[0][1].body);
    assert.equal(body.archiveOriginal, undefined, 'submit clamps archiveOriginal for thread sessions');
  });

  it('non-thread session: keeps the archive row, entry-provided state and the archive flag', async () => {
    const { module, elements } = await createTrimPage({
      fetchImpl: compactFetch({ session: { id: 'session-B' }, revision: 1 }),
    });
    window.isThreadHostAgentId = () => false;

    await module.openTrimPage('agent-studio', 'session-S');
    assert.notEqual(elements.get('trim-page-archive-row').style.display, 'none', 'archive row stays visible for plain sessions');

    await module.openTrimPage('agent-studio', 'session-S', true);
    assert.equal(elements.get('trim-page-archive-toggle').checked, true, 'entry archive intent is honored for plain sessions');

    await actions.invoke('trimPage.submit');
    await flush();
    assert.equal(JSON.parse(hostCalls.compactRequests[0][1].body).archiveOriginal, true, 'plain sessions still archive on submit');
  });
});
