/**
 * P2 批次 W2-7 剩余两文件（上下文菜单开关与动作）交付钉子。
 *
 * 钉什么：
 *   1. 桥键与命名导出同源：classic 裸标识符 / window.* 取到的就是 ESM 实现，
 *      私有 helper 不上桥；6 个待执行目标仍是 app-core 的同一份状态（classic
 *      词法 ↔ ESM 适配面双向读写同一值，不重跑初始化）；
 *   2. R4 时序事实：模块装载前 window 上没有这些键，装载后才有——监听与桥键
 *      都在 ESM 求值相一次登记，每个 (目标, 事件) 恰好一个 handler；
 *   3. 真实菜单开关：agent 条目入口（classic 桥调用）→ 三态可见性 + 菜单几何；
 *   4. 真实菜单动作：restart / stop 的 invoke 载荷与收尾（菜单关闭、侧栏抑制
 *      复位、切换请求拿到新 runtime）、精简三分支（summary / trim 走
 *      runWorkspaceAction，branch 走 ESM openBranchDialog）、删除 agent /
 *      project / feature 的请求载荷与确认文案；
 *   5. 真实事件：文档 outside click、#ctx-menu 条目 click / keydown、window
 *      resize / scroll(capture)、container contextmenu（声明式条目 / feature
 *      仓库卡片 / 项目卡片）。
 *
 * 装载路线（配方第三节）：withP2EsmCase 的真实整图。classic 侧按真实加载序跑
 * action-dispatcher / i18n / app-core / session-view-state（app-core 拥有 6 个
 * 待执行目标、DOM 引用与侧栏交互态）；不在链上的 classic owner（app-main /
 * app-ui / sidebar-render / chat-viewport）以最小宿主替身注入——本批只消费其
 * 调用契约，不重写实现。菜单元素走自建 DOM 夹具（真实 classList / style /
 * getBoundingClientRect），事件派发由夹具记录的监听器驱动。
 *
 * 不整链 prepareClassicSandbox 的原因：app-main 顶层的 newIdempotencyKey 是
 * non-configurable 全局，而它正是本文件 H1 回归用例的构造前提（在 classic 相
 * 自建同名属性验证模块不再对它 defineKey）；真实装载会与用例构造冲突。
 * app-main 的轮询宿主工厂（createPollCoordinatorHost）按生产契约同形提供
 * （run / fastInterval / setTimeout / clearTimeout）——本批不驱动轮询。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { prepareEsmModules, SESSION_VIEW_DOMAIN } from './p2-classic-hosts.js';

const ENTRY = 'public/src/modules/p2-w2-7-context-menu-bootstrap.js';
const CONTEXT_MENU = 'public/src/modules/context-menu.js';
const HANDLERS = 'public/src/modules/ctx-menu-handlers.js';
const STORE = 'public/src/modules/agent-store-state.js';
const ORCH = 'public/src/modules/orchestration-state.js';
const LAYOUT = 'public/src/modules/panel-layout-state.js';
const CONTEXT_HOST = 'public/src/modules/p2-bootstrap-context-menu.js';
const SIDEBAR_HOST = 'public/src/modules/p2-bootstrap-sidebar.js';

/* ── DOM 夹具：稳定 id 元素 + 监听器记录 + 事件派发 ─────────────────── */

function addListener(map, type, fn) {
  if (!map.has(type)) map.set(type, []);
  const list = map.get(type);
  if (!list.includes(fn)) list.push(fn);
}

function removeListener(map, type, fn) {
  const list = map.get(type) || [];
  const index = list.indexOf(fn);
  if (index >= 0) list.splice(index, 1);
}

function makeClassList() {
  const classes = new Set();
  return {
    classes,
    add: (name) => { classes.add(name); },
    remove: (name) => { classes.delete(name); },
    toggle: (name) => { classes.has(name) ? classes.delete(name) : classes.add(name); },
    contains: (name) => classes.has(name),
  };
}

function makeElement(id = '') {
  const el = {
    id,
    tagName: 'DIV',
    style: { _props: {}, setProperty(name, value) { this._props[name] = value; } },
    dataset: {},
    disabled: false,
    children: [],
    _listeners: new Map(),
    addEventListener(type, fn) { addListener(this._listeners, type, fn); },
    removeEventListener(type, fn) { removeListener(this._listeners, type, fn); },
    contains(node) { return node === this || this.children.includes(node); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
    focus() {},
    appendChild(child) { this.children.push(child); return child; },
    getBoundingClientRect() { return { width: 200, height: 120, left: 0, top: 0, right: 200, bottom: 120 }; },
    classList: makeClassList(),
  };
  return el;
}

function createDomHarness() {
  const elements = new Map();
  const byId = (id) => {
    if (!elements.has(id)) elements.set(id, makeElement(id));
    return elements.get(id);
  };
  const queryResults = new Map();
  const document = {
    _listeners: new Map(),
    elements,
    queryResults,
    getElementById: (id) => byId(id),
    querySelector: (selector) => queryResults.get(selector) || null,
    querySelectorAll: () => [],
    createElement: () => makeElement(''),
    createTextNode: (text) => ({ textContent: String(text) }),
    addEventListener(type, fn) { addListener(this._listeners, type, fn); },
    removeEventListener(type, fn) { removeListener(this._listeners, type, fn); },
    body: makeElement(),
    head: makeElement(),
    documentElement: makeElement(),
    readyState: 'complete',
    execCommand: () => true,
    get listenerCount() {
      let n = 0;
      for (const list of this._listeners.values()) n += list.length;
      return n;
    },
  };
  return { document, byId, queryResults };
}

/** 派发记录器 target 上的全部 type 监听器（夹具内的真实回调链）。 */
function fire(target, type, event) {
  const list = (target._listeners.get(type) || []).slice();
  for (const fn of list) fn(event);
  return list.length;
}

function listenerTotal(target) {
  let n = 0;
  for (const list of target._listeners.values()) n += list.length;
  return n;
}

/* ── 夹具数据 / classic 宿主面 ──────────────────────────────────────── */

function makeAgent(overrides = {}) {
  return {
    id: 'programming-helper',
    name: 'PH',
    source: 'prebuilt',
    connected: true,
    sessionOps: true,
    runtime_session_id: 'rt-ph',
    active_workspace_session_id: 'sess-1',
    workspace_sessions: {
      activeSessionId: 'sess-1',
      sessions: [{ id: 'sess-1', title: 'one', archived: false }],
    },
    workspace_data: { projects: [] },
    ...overrides,
  };
}

function fillMissingGlobals(sandbox, stubs) {
  for (const [name, value] of Object.entries(stubs)) {
    if (sandbox.run(`typeof ${name} !== 'undefined'`)) continue;
    sandbox[name] = value;
  }
}

/**
 * classic 侧最小宿主面：本批 ESM 图在模块顶层读取的 factory，以及调用时点
 * 才用到的 classic owner 函数（app-main / app-ui / sidebar-render /
 * chat-viewport）。调用记录进 `calls` 供断言真实载荷。
 */
function installClassicHosts(sandbox, calls) {
  sandbox.AgentLoaderHost = { loadedAgentDetailIds: new Set() };
  // call 状态引擎的两个桥键（生产由 modules/agent-call-states-engine.js 注册）与
  // 侧栏渲染的协作面：本夹具的裁剪链不装引擎。
  sandbox.collectActiveCallRuntimeIds = () => [];
  sandbox.refreshAgentCallStates = async () => {};
  sandbox.normalizeAgentIdentity = (value) => String(value || '').trim();
  sandbox.getVisibleRemoteEntries = () => [];
  sandbox.getParentAgentId = (agent) => agent?.parent_id || null;
  sandbox.getActiveSessionId = (agent) => agent?.active_workspace_session_id || null;
  sandbox.getLogicalAgentId = (agent) => agent?.parent_id || agent?.id || null;
  sandbox.getWorkspaceSessions = (agent) => agent?.workspace_sessions?.sessions || [];
  sandbox.getPathLeaf = (value) => String(value || '').split('/').pop();
  sandbox.groupConnectedAgents = (agents) => ({ external: Array.isArray(agents) ? agents : [], groups: [] });
  sandbox.updateCurrentAgentChrome = () => {};
  sandbox.isAgentActive = () => false;
  sandbox.isRuntimeItemActive = () => false;
  sandbox.ClawSidebarLayout = { load: async () => {}, signature: () => '', isInteracting: () => false, render() {} };
  sandbox.renderFeaturePanel = () => {};
  sandbox.createAgentCallStatesHost = () => ({
    calling: new Map(), suspended: new Set(), interrupting: new Set(),
  });
  // 快照装载宿主：loadAgents 在动作收尾被真实调用（restart / delete 路径），
  // 这里只提供一条确定性空快照链，行为由侧栏批次自己的测试钉住。
  sandbox.createAgentSnapshotLoaderHost = () => ({
    state: {},
    now: () => 0,
    captureToken: () => null,
    ownership: () => ({}),
    connected: async () => [],
    viewer: async () => ({ ok: false, json: async () => ({ agents: [] }) }),
    loadLayout: async () => ({}),
    loadProjects: async () => {},
    isTokenCurrent: () => true,
    runtimeId: (agent) => agent?.runtime_session_id || agent?.id || '',
    agentRuntimeId: (agent) => agent?.runtime_session_id || agent?.id || '',
    detailIds: new Set(),
    mergeSessions: (previous) => previous,
    reconcileStops: () => {},
    pruneCallStates: () => {},
    diagnostic: () => {},
    warn: () => {},
    error: () => {},
    log: () => {},
    schedule: () => {},
    renderList: () => { calls.push({ fn: 'renderAgentList' }); },
    renderPanel: () => {},
    refreshCalls: async () => {},
    isRemote: (id) => String(id || '').startsWith('remote:'),
    fallback: () => null,
    loadDetail: async () => {},
    selectSurface: () => {},
    preferHome: () => {},
    resolveFocus: () => null,
    clickPrebuilt: () => {},
    logicalId: (agent) => agent?.id || null,
    loadData: async () => {},
  });
  sandbox.createSessionDataLoaderHost = () => ({});
  sandbox.createRuntimeStatusLoaderHost = () => ({});
  sandbox.createRuntimeSwitchHost = () => ({
    state: {},
    switchAgent: (runtimeId) => { calls.push({ fn: 'switchAgent', runtimeId }); return Promise.resolve(); },
    setTimeout: (callback, delay) => sandbox.setTimeout(callback, delay),
    hasPendingNavigation: () => false,
    bumpNavigationGuard: () => {},
    closeContextMenu: () => {},
    findAgent: (id) => (sandbox.allAgents || []).find((agent) => agent.id === id) || null,
    isWorkspaceHost: () => false,
    runtimeId: (agent) => agent?.runtime_session_id || '',
    agentRuntimeId: (agent) => agent?.runtime_session_id || '',
    isRemote: (id) => String(id || '').startsWith('remote:'),
    remote: () => sandbox.window.RemoteConnections,
    closeReadOnlySession: () => {},
    isWorkspaceSurface: () => false,
    selectWorkspace: () => {},
    storeDraft: () => {},
    saveWorkspaceScroll: () => {},
    saveCache: () => {},
    logicalId: (agent) => agent?.id || null,
    normalize: (id) => String(id || '').trim(),
    clearFinished: () => {},
    deriveSession: () => null,
    bindSession: () => {},
    updateThreadIndicators: () => {},
    browseOnly: () => false,
    resetSurface: () => {},
    resetScroll: () => {},
    resetStatus: () => {},
    activateCollapse: () => {},
    contextKey: () => '',
    restoreCache: () => null,
    setPendingScroll: () => {},
    render: () => {},
    renderPanel: () => {},
    patch: () => {},
    emptyOverview: () => ({}),
    emptyTodo: () => ({}),
    setFollowLatest: () => {},
    beginFollowWindows: () => {},
    renderAgents: () => {},
  });
  // 轮询协调器宿主（真实定义在 app-main）：workspace-actions → input-actions →
  // poll-coordinator-host 的静态链在 ESM 求值期取用。本批不驱动轮询，按生产
  // 契约（run / fastInterval / setTimeout / clearTimeout）提供同形实现。
  sandbox.createPollCoordinatorHost = () => ({
    run: async () => {},
    fastInterval: () => 1000,
    setTimeout: (callback, delay) => sandbox.setTimeout(callback, delay),
    clearTimeout: (id) => sandbox.clearTimeout(id),
  });
  sandbox.createWorkspaceSurfaceHost = () => ({});
  sandbox.createCompactResumeHost = () => ({ state: {}, now: () => Date.now() });
  sandbox.createP2BootstrapSidebarRenderHost = () => ({ lastAgentListRenderSignature: '' });
  sandbox.isRemoteNamespaceAgentId = (id) => String(id || '').startsWith('remote:');
  fillMissingGlobals(sandbox, {
    renderAgentList: () => { calls.push({ fn: 'renderAgentList' }); },
    renderCurrentMainView: () => { calls.push({ fn: 'renderCurrentMainView' }); },
    updateAssemblySideRailPosition: () => { calls.push({ fn: 'updateAssemblySideRailPosition' }); },
    setPreferredUnitMode: (mode, agent) => { calls.push({ fn: 'setPreferredUnitMode', mode, agentId: agent?.id || null }); },
    resolveWorkspaceFallbackAgentId: (agent) => agent?.id || null,
    getCurrentAgentRecord: () => (sandbox.allAgents || [])[0] || null,
    getRuntimeId: (agent) => agent?.runtime_session_id || agent?.id || null,
    runWorkspaceAction: (action) => { calls.push({ fn: 'runWorkspaceAction', action }); },
    closeCtxMenu: () => { calls.push({ fn: 'closeCtxMenu' }); },
    showCtxMenu: (x, y, items, target) => { calls.push({ fn: 'showCtxMenu', x, y, items, target }); },
    fwOpenConfirmDialog: undefined,
    alert: (message) => { calls.push({ fn: 'alert', message }); },
    confirm: () => true,
    NavigationCore: {
      resolveHostAgentId: (_agent, id) => id,
      extractRuntimeId: (result) => result?.runtime_session_id || null,
      resolveStoppedRuntimeFallback: () => null,
    },
    performance: { now: () => 0 },
  });
  // invoke 传输层替身：app-core 的真实 invoke 走 __PROTOCLAW_TAURI_BRIDGE__ / HTTP，
  // 这里只记录命令与载荷并回一个带新 runtime 的结果——被测的是 handler 的编排。
  const realInvoke = sandbox.invoke;
  sandbox.invoke = async (command, payload) => {
    calls.push({ fn: 'invoke', command, payload });
    // 连线快照查询：真实 loadAgents（P4 T2 起由 ESM 装载器宿主驱动）要求数组形态。
    if (command === 'get_connected_agents') return [];
    return { runtime_session_id: 'rt-next', realInvokeUsed: typeof realInvoke === 'function' };
  };
  // window.* 记录器（ESM 侧以 window.X 晚绑定取用）
  for (const [name, value] of Object.entries({
    renderAgentList: sandbox.renderAgentList,
    renderCurrentMainView: sandbox.renderCurrentMainView,
    updateAssemblySideRailPosition: sandbox.updateAssemblySideRailPosition,
    setPreferredUnitMode: sandbox.setPreferredUnitMode,
    resolveWorkspaceFallbackAgentId: sandbox.resolveWorkspaceFallbackAgentId,
    getCurrentAgentRecord: sandbox.getCurrentAgentRecord,
    getRuntimeId: sandbox.getRuntimeId,
    runWorkspaceAction: sandbox.runWorkspaceAction,
    closeCtxMenu: sandbox.closeCtxMenu,
    showCtxMenu: sandbox.showCtxMenu,
    invoke: sandbox.invoke,
    alert: sandbox.alert,
    confirm: sandbox.confirm,
    NavigationCore: sandbox.NavigationCore,
  })) {
    if (sandbox[name] === undefined) sandbox[name] = value;
  }
}

/** 建立一个用例：DOM 夹具 + classic 加载序 + 可选 window 监听记录。 */
async function withMenuCase(fn, { classicExtra } = {}) {
  const dom = createDomHarness();
  const calls = [];
  const windowListeners = new Map();
  const fetchCalls = [];
  const fetchStub = async (url, init = {}) => {
    fetchCalls.push({
      url: String(url),
      method: init.method || 'GET',
      body: init.body ? JSON.parse(init.body) : null,
      headers: init.headers || null,
    });
    return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => '' };
  };
  return withP2EsmCase({
    classic: (sandbox) => {
      sandbox.__windowListeners = windowListeners;
      sandbox.addEventListener = (type, handler) => addListener(windowListeners, type, handler);
      sandbox.removeEventListener = (type, handler) => removeListener(windowListeners, type, handler);
      sandbox.loadSource('public/src/modules/action-dispatcher.js');
      // i18n 已迁 ESM（P4）：t 桥键由 createFrontendSandbox 自动装载，见 test/helpers/install-i18n.js
      sandbox.loadSource('public/src/app-core.js');
      prepareEsmModules(sandbox, SESSION_VIEW_DOMAIN);
      installClassicHosts(sandbox, calls);
      if (typeof classicExtra === 'function') classicExtra(sandbox, { calls, dom });
    },
    globals: {
      document: dom.document,
      fetch: fetchStub,
      CSS: { escape: (value) => String(value) },
    },
  }, async (c) => {
    await fn(c, { calls, dom, windowListeners, fetchCalls, fetchStub });
  });
}

async function loadMenu(c) {
  await c.load(ENTRY);
  return {
    menu: await c.load(CONTEXT_MENU),
    handlers: await c.load(HANDLERS),
    store: await c.load(STORE),
    orch: await c.load(ORCH),
    layout: await c.load(LAYOUT),
    contextUi: (await c.load(CONTEXT_HOST)).contextMenuUi,
    sidebarUi: (await c.load(SIDEBAR_HOST)).sidebarUi,
  };
}

const menuEl = (dom, id) => dom.byId(id);
const isOpen = (dom, id) => menuEl(dom, id).classList.contains('open');

/* ── 1. 桥键 / 导出同源 / 状态同一 owner / R4 时相 ────────────────── */

test('桥键与命名导出同源、私有 helper 不上桥、6 个待执行目标同一 owner', async () => {
  await withMenuCase(async (c) => {
    // 装载前（classic 相）：桥键还不存在——它们只在 ESM 求值相登记。
    assert.equal(c.read('typeof closeCompactMenu'), 'undefined');
    assert.equal(c.read('typeof openAgentActions'), 'undefined');
    assert.equal(Object.prototype.hasOwnProperty.call(c.window, 'closeAgentContextMenu'), false);

    const { contextUi } = await loadMenu(c);
    const mod = await c.load(CONTEXT_MENU);
    const handlers = await c.load(HANDLERS);

    // 1) 桥访问器：get/set 成对、不可枚举、可配置（终局撤桥）
    for (const key of ['closeAgentContextMenu', 'closeProjectContextMenu', 'closeCompactMenu', 'openCompactMenu', 'openAgentActions']) {
      const descriptor = Object.getOwnPropertyDescriptor(c.window, key);
      assert.equal(typeof descriptor?.get, 'function', `${key} 应是桥访问器`);
      assert.equal(typeof descriptor?.set, 'function', `${key} 应成对提供 setter`);
      assert.equal(descriptor.enumerable, false, `${key} 不应进入 for-in`);
      assert.equal(descriptor.configurable, true, `${key} 终局可撤桥`);
    }
    assert.equal(c.read('closeAgentContextMenu'), mod.closeAgentContextMenu);
    assert.equal(c.read('closeProjectContextMenu'), mod.closeProjectContextMenu);
    assert.equal(c.read('closeCompactMenu'), mod.closeCompactMenu);
    assert.equal(c.read('openCompactMenu'), mod.openCompactMenu);
    assert.equal(c.read('openAgentActions'), handlers.openAgentActions);
    // 幂等键**不建桥**：classic 全局赢家是 app-main 的顶层 function（浏览器里
    // non-configurable），对它 defineKey 会在真实 Chromium 抛
    // `Cannot redefine property`。本文件只保留私有副本自用，外部消费方继续用
    // app-main 的 classic 实现（真实 Chromium 回归见
    // test/p2-w2-7-context-menu-chromium-browser-check.mjs）。
    assert.equal(Object.prototype.hasOwnProperty.call(c.window, 'newIdempotencyKey'), false,
      '没有 classic 提供者时，本模块不得自行发布 newIdempotencyKey');
    assert.equal('newIdempotencyKey' in handlers, false, 'newIdempotencyKey 保持模块私有');
    // window.* 取用（session-dialogs / trim-page 的晚绑定形态）同样是同一实现
    assert.equal(c.window.openCompactMenu, mod.openCompactMenu);

    // 2) 零生产消费面的导出不造桥；私有 helper 既不导出也不上桥
    for (const key of [
      'openAgentContextMenu', 'openProjectContextMenu', 'openFeatureRepoContextMenu',
      'closeFeatureRepoContextMenu',
    ]) {
      assert.equal(typeof mod[key], 'function', `${key} 是 ctx-menu-handlers 的命名导依赖`);
      assert.equal(Object.prototype.hasOwnProperty.call(c.window, key), false, `${key} 不应出现在 window 上`);
    }
    assert.equal(Object.prototype.hasOwnProperty.call(c.window, 'isDeletedAgentFocused'), false);
    assert.equal('isDeletedAgentFocused' in handlers, false, 'isDeletedAgentFocused 应保持模块私有');

    // 3) 6 个待执行目标：classic 词法 ↔ ESM 适配面是同一份状态
    c.read('contextMenuAgentId = "agent-boot"');
    c.read('contextMenuAgentMode = "child-runtime"');
    c.read('contextMenuCompactAction = { sessionId: "sess-boot" }');
    c.read('contextMenuProjectAgentId = "agent-proj"');
    c.read('contextMenuProjectId = "proj-boot"');
    c.read('contextMenuFeatureRepoPackageId = "pkg-boot"');
    assert.equal(contextUi.contextMenuAgentId, 'agent-boot');
    assert.equal(contextUi.contextMenuAgentMode, 'child-runtime');
    assert.equal(contextUi.contextMenuCompactAction.sessionId, 'sess-boot');
    assert.equal(contextUi.contextMenuProjectAgentId, 'agent-proj');
    assert.equal(contextUi.contextMenuProjectId, 'proj-boot');
    assert.equal(contextUi.contextMenuFeatureRepoPackageId, 'pkg-boot');
    // 反向：ESM 写入落到 classic 词法（菜单动作收尾清空的那条路径）
    contextUi.contextMenuAgentId = 'agent-esm';
    assert.equal(c.read('contextMenuAgentId'), 'agent-esm');

    // 4) claim 语义：classic 侧对桥键赋值经 setter 落进域模块实现（覆盖生效）
    c.read('closeCompactMenu = function overriddenForTest() { return "overridden"; }');
    assert.equal(c.read('closeCompactMenu()'), 'overridden');
    assert.equal(c.window.closeCompactMenu.name, 'overriddenForTest');
  });
});

test('监听与桥键只在 ESM 求值相登记一次：每个 (目标, 事件) 恰一个 handler', async () => {
  await withMenuCase(async (c, { dom, windowListeners }) => {
    await loadMenu(c);

    // 元素级：菜单动作 8 个入口（每个恰一个 click 监听）
    const actionIds = [
      'restart-agent-action', 'stop-agent-action', 'delete-agent-action',
      'compact-summary-action', 'compact-trim-action', 'compact-branch-action',
      'delete-project-action', 'delete-feature-action',
    ];
    for (const id of actionIds) {
      assert.equal(listenerTotal(dom.byId(id)), 1, `${id} 应恰好注册一个监听`);
      assert.equal(dom.byId(id)._listeners.get('click').length, 1, `${id} 只监听 click`);
    }
    // 文档级：keydown + click（图内其他模块也挂文档监听，唯一性由 6 号用例的
    // 单次副作用断言钉住）；窗口级：resize + scroll(capture)；容器级：contextmenu
    assert.ok(dom.document._listeners.get('keydown')?.length >= 1);
    assert.ok(dom.document._listeners.get('click')?.length >= 1);
    // 图内两个模块各挂一次 resize：ctx-menu-handlers 自身 + 其依赖的
    // ph-project-actions（目录子菜单关闭）；数量固定为 2，重复求值会 +1 变红。
    assert.equal(windowListeners.get('resize').length, 2);
    assert.equal(windowListeners.get('scroll').length, 1);
    assert.equal(dom.byId('chat-container')._listeners.get('contextmenu').length, 1);
  });
});

test('classic 同名 non-configurable 全局在位时模块仍能求值：幂等键不进桥', async () => {
  // H1 回归（Node 侧守卫；浏览器语义的权威证据是 Chromium 隔离回归）：
  // 真实页面里 app-main.js 的顶层 `function newIdempotencyKey()` 已经存在且是
  // non-configurable 的 window 属性。这里在 classic 相造出同样的属性，模块必须
  // 仍能求值——说明本模块确实没有再对这个名字 defineKey。
  const classicIdem = function newIdempotencyKey() { return 'classic-winner'; };
  await withMenuCase(async (c) => {
    const { handlers } = await loadMenu(c);
    const descriptor = Object.getOwnPropertyDescriptor(c.window, 'newIdempotencyKey');
    assert.equal(descriptor.configurable, false, 'classic 提供的属性保持不可配置');
    assert.equal(c.read('newIdempotencyKey()'), 'classic-winner', '外部消费方仍取到 classic 实现');
    assert.equal(c.read('newIdempotencyKey'), classicIdem);
    // 桥只装 openAgentActions；幂等键不进桥、也不是命名导出
    assert.equal(c.window.openAgentActions, handlers.openAgentActions);
    assert.equal('newIdempotencyKey' in handlers, false);
  }, {
    classicExtra: (sandbox) => {
      Object.defineProperty(sandbox, 'newIdempotencyKey', {
        value: classicIdem, writable: true, enumerable: false, configurable: false,
      });
    },
  });
});

/* ── 2. 真实菜单开关：agent 条目入口 + 三态可见性 + 几何 ──────────── */

test('classic 桥调用打开 agent 菜单：三态可见性与几何落在真实元素上', async () => {
  await withMenuCase(async (c, { dom }) => {
    const { store, contextUi } = await loadMenu(c);
    store.setAllAgents([makeAgent()]);

    const event = { defaultPrevented: false, clientX: 120, clientY: 90, preventDefault() { this.defaultPrevented = true; } };
    c.window.__menuEvent = event;
    // classic 消费方（sidebar-render 条目点击）的取用形态：桥访问器裸标识符
    c.read('openAgentActions(__menuEvent, "programming-helper")');

    assert.equal(event.defaultPrevented, true, '条目右键/点击必须阻止默认行为');
    assert.equal(isOpen(dom, 'agent-context-menu'), true);
    assert.equal(contextUi.contextMenuAgentId, 'programming-helper');
    assert.equal(contextUi.contextMenuAgentMode, 'prebuilt-runtime');
    // 几何：8px 边距内定位
    assert.equal(menuEl(dom, 'agent-context-menu').style.left, '120px');
    assert.equal(menuEl(dom, 'agent-context-menu').style.top, '90px');
    // runtime 动作可见、删除不可见
    assert.equal(menuEl(dom, 'restart-agent-action').style.display, '');
    assert.equal(menuEl(dom, 'restart-agent-action').disabled, false);
    assert.equal(menuEl(dom, 'stop-agent-action').style.display, '');
    assert.equal(menuEl(dom, 'delete-agent-action').style.display, 'none');
    assert.equal(menuEl(dom, 'delete-agent-action').disabled, true);

    // delete-only（断连的外部条目）：删除可见、runtime 动作隐藏
    c.window.__menuEvent2 = { defaultPrevented: false, clientX: 900, clientY: 400, preventDefault() { this.defaultPrevented = true; } };
    store.setAllAgents([makeAgent({ id: 'orphan', source: 'external', connected: false })]);
    c.read('openAgentActions(__menuEvent2, "orphan")');
    assert.equal(contextUi.contextMenuAgentMode, 'delete-only');
    assert.equal(menuEl(dom, 'delete-agent-action').style.display, '');
    assert.equal(menuEl(dom, 'delete-agent-action').disabled, false);
    assert.equal(menuEl(dom, 'restart-agent-action').style.display, 'none');
    assert.equal(menuEl(dom, 'stop-agent-action').style.display, 'none');
    // 打开另一类菜单时只关 agent 菜单、保留对方依赖：打开 project 菜单会关 agent
    c.read('openCompactMenu({ sessionId: "sess-1" }, 10, 20)');
    assert.equal(isOpen(dom, 'compact-context-menu'), true);
    assert.equal(isOpen(dom, 'agent-context-menu'), false, '打开精简菜单必须关掉 agent 菜单');
    assert.equal(contextUi.contextMenuCompactAction.sessionId, 'sess-1');
    assert.equal(contextUi.contextMenuAgentId, null);

    // 清理夹具监听（用例结束前不留悬空 handler）
    for (const id of ['agent-context-menu', 'compact-context-menu']) {
      menuEl(dom, id)._listeners.clear();
    }
    dom.document._listeners.clear();
  });
});

/* ── 3. 真实动作：restart / stop ─────────────────────────────────── */

/** 轮询等待条件成立（CPU 竞争下的确定性收敛；超时仍按失败处理）。 */
async function waitFor(predicate, { timeout = 1000, interval = 2 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  return predicate();
}

test('restart / stop 动作：invoke 载荷、菜单收尾、侧栏抑制复位与切换请求', async () => {
  await withMenuCase(async (c, { dom, calls }) => {
    const { store, contextUi, sidebarUi, orch } = await loadMenu(c);
    const agent = makeAgent({ id: 'rt-child', source: 'child', active_workspace_session_id: 'sess-9', runtime_session_id: 'rt-child' });
    store.setAllAgents([agent]);
    // 侧栏条目在重启中标记（document.querySelector 命中被标记的 runtime 条目）
    const runtimeItem = makeElement('rt-child-item');
    dom.queryResults.set('[data-agent-id="rt-child"]', runtimeItem);

    contextUi.contextMenuAgentId = 'rt-child';
    contextUi.contextMenuAgentMode = 'child-runtime';
    const epochBefore = orch._navigationGuardEpoch;

    fire(menuEl(dom, 'restart-agent-action'), 'click', {});
    await waitFor(() => calls.some((call) => call.fn === 'switchAgent'));

    const invokeCall = calls.find((call) => call.fn === 'invoke');
    assert.deepEqual(invokeCall.payload, { agentId: 'rt-child', sessionId: 'sess-9' }, 'child-runtime 重启必须带宿主寻址与会话');
    assert.equal(invokeCall.command, 'restart_agent');
    // 真实 bumpNavigationGuard（classic app-core）递增导航代次
    assert.equal(orch._navigationGuardEpoch, epochBefore + 1);
    // 收尾：菜单关闭、状态清空、侧栏抑制复位
    assert.equal(isOpen(dom, 'agent-context-menu'), false);
    assert.equal(contextUi.contextMenuAgentId, null);
    assert.equal(sidebarUi.suppressSidebarRerender, false);
    // 重启中标记在真实条目元素上
    assert.equal(runtimeItem.classList.contains('restarting'), true);
    assert.equal(runtimeItem.classList.contains('active'), false);
    // 新 runtime 拿到后请求切换（host.switchAgent 记录）
    assert.deepEqual(calls.filter((call) => call.fn === 'switchAgent'), [{ fn: 'switchAgent', runtimeId: 'rt-next' }]);

    // stop：prebuilt-runtime 只按 agentId 停止
    calls.length = 0;
    contextUi.contextMenuAgentId = 'rt-child';
    contextUi.contextMenuAgentMode = 'prebuilt-runtime';
    fire(menuEl(dom, 'stop-agent-action'), 'click', {});
    await waitFor(() => calls.some((call) => call.fn === 'invoke'));
    const stopCall = calls.find((call) => call.fn === 'invoke');
    assert.equal(stopCall.command, 'stop_agent');
    assert.deepEqual(stopCall.payload, { agentId: 'rt-child' });
    assert.equal(contextUi.contextMenuAgentId, null);
    assert.equal(isOpen(dom, 'agent-context-menu'), false);
  });
});

/* ── 4. 真实动作：精简三分支 ─────────────────────────────────────── */

test('精简菜单三分支：summary / trim 走工作空间动作，branch 走 ESM 分支对话框', async () => {
  await withMenuCase(async (c, { dom, calls }) => {
    const { contextUi } = await loadMenu(c);
    contextUi.contextMenuCompactAction = { sessionId: 'sess-7', agentId: 'programming-helper' };
    menuEl(dom, 'compact-context-menu').classList.add('open');

    fire(menuEl(dom, 'compact-summary-action'), 'click', {});
    await Promise.resolve();
    const summary = calls.find((call) => call.fn === 'runWorkspaceAction');
    assert.deepEqual(summary.action, {
      sessionId: 'sess-7', agentId: 'programming-helper', compactType: 'summary',
    });
    assert.equal(contextUi.contextMenuCompactAction, null, '执行后清空待执行动作');
    assert.equal(isOpen(dom, 'compact-context-menu'), false);

    contextUi.contextMenuCompactAction = { sessionId: 'sess-8' };
    fire(menuEl(dom, 'compact-trim-action'), 'click', {});
    await Promise.resolve();
    assert.equal(calls.filter((call) => call.fn === 'runWorkspaceAction').at(-1).action.compactType, 'trim');

    // branch：无当前 agent → 直接放弃（不清空待执行动作、不发动作）
    contextUi.contextMenuCompactAction = { sessionId: 'sess-9' };
    const before = calls.length;
    fire(menuEl(dom, 'compact-branch-action'), 'click', {});
    assert.equal(contextUi.contextMenuCompactAction.sessionId, 'sess-9');
    assert.equal(calls.length, before);
    // branch：有当前 agent → 收尾清空并进入 ESM 分支对话框（session-dialogs）
    const store = (await c.load(STORE));
    store.setAllAgents([makeAgent()]);
    fire(menuEl(dom, 'compact-branch-action'), 'click', {});
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(contextUi.contextMenuCompactAction, null);
    assert.equal(isOpen(dom, 'compact-context-menu'), false);
    // 真实 openBranchDialog（session-dialogs）已把对话框上屏并写入轮次区
    assert.equal(dom.byId('branch-dialog').style.display, '');
    assert.match(dom.byId('branch-round-list').innerHTML, /trim-loading/);
  });
});

test('app-ui 的 5 个 fw 对话框渲染器：裸取同源、确认对话框 DOM → 按动作提交 / 取消零提交', async () => {
  await withMenuCase(async (c, { dom, calls, fetchCalls }) => {
    const { store, contextUi } = await loadMenu(c);
    const fw = await c.load('public/src/modules/fw-config-panel.js');
    const RENDERERS = [
      'renderFWCreateDialog', 'renderFWConfirmDialog', 'renderFWPromptDialog',
      'renderFWSwitchProjectDialog', 'renderFWFeatureImportDialog',
    ];

    // 1) app-ui 的取用形态是裸标识符（classic 相）→ 桥访问器与具名导出同源
    for (const name of RENDERERS) {
      const descriptor = Object.getOwnPropertyDescriptor(c.window, name);
      assert.equal(typeof descriptor?.get, 'function', `${name} 应装成桥访问器（app-ui 裸取）`);
      assert.equal(descriptor.enumerable, false, `${name} 不应进入 for-in`);
      assert.equal(c.read(name), fw[name], `${name} 桥与命名导出必须同一实现`);
    }
    // 五个渲染函数都能以 app-ui 的调用形态执行（关闭态返回空串，不抛错）
    for (const expression of [
      'renderFWCreateDialog()', 'renderFWConfirmDialog()', 'renderFWFeatureImportDialog()',
      'renderFWSwitchProjectDialog({}, "x")', 'renderFWPromptDialog({}, "assembly-form", {})',
    ]) {
      assert.equal(typeof c.read(expression), 'string', `${expression} 应返回 HTML 字符串`);
    }

    // 2) 非 PH 项目删除：真实确认对话框 DOM 可见（app-ui 拼 HTML 的那两个调用）
    store.setAllAgents([makeAgent({ id: 'memo', source: 'prebuilt', runtime_session_id: 'rt-memo' })]);
    contextUi.contextMenuProjectAgentId = 'memo';
    contextUi.contextMenuProjectId = 'proj-x';
    fire(menuEl(dom, 'delete-project-action'), 'click', {});
    await new Promise((resolve) => setTimeout(resolve, 5));
    const dialogHtml = c.read('renderFWConfirmDialog()');
    assert.match(dialogHtml, /feature-detail-overlay/, '确认对话框必须真的渲染出 DOM 结构');
    assert.match(dialogHtml, /proj-x/, '对话框文案必须带被删项目 id');
    assert.match(dialogHtml, /data-action="fw\.handleConfirm"/, '确认按钮必须是真实注册动作');
    assert.match(dialogHtml, /data-action="fw\.closeConfirmDialog"/, '取消按钮必须是真实注册动作');
    // app-ui 的 renderFWList 拼串时包含同一个对话框（真实调用点，不另造 DOM）
    assert.equal(c.read('renderFWConfirmDialog()'), dialogHtml, '重复渲染必须幂等（同一状态同一 DOM）');

    // 3) 取消：零提交，且对话框状态被真实关闭动作清空
    await c.window.ClawFW.actions.invoke('fw.closeConfirmDialog');
    assert.deepEqual(fetchCalls, [], '取消后不得提交任何删除请求');
    assert.equal(c.read('renderFWConfirmDialog()'), '', '取消后对话框不再渲染');
    assert.equal(calls.some((call) => call.fn === 'renderCurrentMainView'), true, '关闭走真实 fwRerender');

    // 4) 确认：真实动作触发后才提交
    contextUi.contextMenuProjectAgentId = 'memo';
    contextUi.contextMenuProjectId = 'proj-x';
    fire(menuEl(dom, 'delete-project-action'), 'click', {});
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(fetchCalls, [], '仅打开对话框不得提交');
    await c.window.ClawFW.actions.invoke('fw.handleConfirm');
    await new Promise((resolve) => setTimeout(resolve, 10));
    const submitted = fetchCalls.filter((call) => call.url === '/protoclaw/prebuilt_project/delete');
    assert.equal(submitted.length, 1, '确认动作后必须恰好一次提交');
    assert.equal(submitted[0].body.agentId, 'memo');
    assert.equal(submitted[0].body.projectId, 'proj-x');
    assert.equal(c.read('renderFWConfirmDialog()'), '', '提交后对话框关闭');
  });
});

/* ── 5. 真实动作：删除 agent / project / feature ──────────────────── */

test('删除动作：agent 只删断连条目、feature 走仓库端点、project 带 operationId', async () => {
  await withMenuCase(async (c, { dom, calls, fetchCalls }) => {
    const { store, contextUi } = await loadMenu(c);

    // agent：非 delete-only / 仍连接 → 只关菜单、不发请求
    store.setAllAgents([makeAgent({ id: 'rt-ph' })]);
    contextUi.contextMenuAgentId = 'rt-ph';
    contextUi.contextMenuAgentMode = 'delete-only';
    fire(menuEl(dom, 'delete-agent-action'), 'click', {});
    await new Promise((resolve) => setTimeout(resolve, 2));
    assert.deepEqual(fetchCalls, [], '仍连接的 agent 不允许删除');
    assert.equal(contextUi.contextMenuAgentId, null);

    // agent：断连条目 → DELETE /api/agents/<id>
    store.setAllAgents([makeAgent({ id: 'orphan', source: 'external', connected: false })]);
    contextUi.contextMenuAgentId = 'orphan';
    contextUi.contextMenuAgentMode = 'delete-only';
    fire(menuEl(dom, 'delete-agent-action'), 'click', {});
    await new Promise((resolve) => setTimeout(resolve, 5));
    // 删除后走真实 loadAgents 重投影侧栏（P4 T2 起由 ESM 装载器宿主驱动）：
    // DELETE 之外只允许 viewer 快照刷新，别的请求一律不该出现。
    assert.deepEqual(
      fetchCalls.map((call) => ({ method: call.method, url: call.url })),
      [
        { method: 'DELETE', url: '/api/agents/orphan' },
        { method: 'GET', url: '/api/agents' },
      ],
    );

    // feature：确认 → POST feature_repository/delete，收尾关菜单并重渲主视图
    fetchCalls.length = 0;
    calls.length = 0;
    contextUi.contextMenuFeatureRepoPackageId = 'pkg-1';
    menuEl(dom, 'feature-repo-context-menu').classList.add('open');
    fire(menuEl(dom, 'delete-feature-action'), 'click', {});
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(fetchCalls.map((call) => ({ url: call.url, body: call.body })), [
      { url: '/protoclaw/feature_repository/delete', body: { packageId: 'pkg-1' } },
    ]);
    assert.equal(contextUi.contextMenuFeatureRepoPackageId, null);
    assert.equal(isOpen(dom, 'feature-repo-context-menu'), false);
    assert.equal(calls.some((call) => call.fn === 'renderCurrentMainView'), true);

    // project（编程小助手）：POST prebuilt_project/delete 携带 operationId 前缀
    fetchCalls.length = 0;
    calls.length = 0;
    store.setAllAgents([makeAgent()]);
    contextUi.contextMenuProjectAgentId = 'programming-helper';
    contextUi.contextMenuProjectId = 'proj-9';
    menuEl(dom, 'project-context-menu').classList.add('open');
    fire(menuEl(dom, 'delete-project-action'), 'click', {});
    await new Promise((resolve) => setTimeout(resolve, 10));
    const projectDelete = fetchCalls.find((call) => call.url === '/protoclaw/prebuilt_project/delete');
    assert.equal(projectDelete.method, 'POST');
    assert.equal(projectDelete.body.agentId, 'programming-helper');
    assert.equal(projectDelete.body.projectId, 'proj-9');
    assert.match(projectDelete.body.operationId, /^delete-project/);
    assert.equal(projectDelete.body.responseMode, 'delta');
    // 私有幂等键副本仍服务于本模块自己的写请求（不建桥 ≠ 不用）：flow-workspace
    // 分支先按运行记录删会话，每条写请求带本模块私有副本生成的幂等键。
    fetchCalls.length = 0;
    store.setAllAgents([{
      id: 'flow-workspace', source: 'prebuilt', connected: true, runtime_session_id: 'rt-flow',
      workspace_state: { assemblyConfigs: [{ id: 'cfg-1', name: 'demo-flow' }] },
      workspace_sessions: { activeSessionId: 's1', sessions: [{ id: 's1', agentName: 'demo-flow' }] },
    }]);
    contextUi.contextMenuProjectAgentId = 'flow-workspace';
    contextUi.contextMenuProjectId = 'cfg-1';
    fire(menuEl(dom, 'delete-project-action'), 'click', {});
    await new Promise((resolve) => setTimeout(resolve, 5));
    await c.window.ClawFW.actions.invoke('fw.handleConfirm');
    await new Promise((resolve) => setTimeout(resolve, 10));
    const sessionDelete = fetchCalls.find((call) => call.url === '/protoclaw/prebuilt_sessions/delete');
    assert.ok(sessionDelete, 'flow-workspace 分支必须先删运行记录会话');
    assert.equal(sessionDelete.body.sessionId, 's1');
    assert.match(String(sessionDelete.headers?.['x-idempotency-key'] || ''), /^[0-9a-f-]{16,}$|^key-/,
      '私有幂等键副本仍用于本模块写请求');

    // 3) 非 PH 分支（flow-workspace）：真实 fwOpenConfirmDialog 打开确认对话框，
    //    真实注册的确认动作（dialog 按钮的 data-action="fw.handleConfirm"）触发后
    //    才提交；取消则不提交。
    fetchCalls.length = 0;
    calls.length = 0;
    store.setAllAgents([makeAgent({ id: 'memo', source: 'prebuilt', runtime_session_id: 'rt-memo' })]);
    contextUi.contextMenuProjectAgentId = 'memo';
    contextUi.contextMenuProjectId = 'proj-x';
    menuEl(dom, 'project-context-menu').classList.add('open');
    fire(menuEl(dom, 'delete-project-action'), 'click', {});
    await new Promise((resolve) => setTimeout(resolve, 5));
    // 打开确认：真实 fwOpenConfirmDialog 只登记对话框状态并请求重渲，不提交
    assert.deepEqual(fetchCalls, [], '确认对话框打开阶段不得发出删除请求');
    assert.equal(calls.some((call) => call.fn === 'renderCurrentMainView'), true, '打开确认必须走真实 fwRerender');
    assert.equal(c.window.ClawFW.actions.has('fw.handleConfirm'), true, '确认按钮动作由 fw-config-panel 真实注册');
    assert.equal(contextUi.contextMenuProjectId, null, '菜单在打开确认时已收尾');
    // 取消：真实 close 动作清空对话框状态，仍不提交
    await c.window.ClawFW.actions.invoke('fw.closeConfirmDialog');
    assert.deepEqual(fetchCalls, [], '取消后不得提交');
    // 重新打开并确认 → 真实提交后果
    contextUi.contextMenuProjectAgentId = 'memo';
    contextUi.contextMenuProjectId = 'proj-x';
    fire(menuEl(dom, 'delete-project-action'), 'click', {});
    await new Promise((resolve) => setTimeout(resolve, 5));
    await c.window.ClawFW.actions.invoke('fw.handleConfirm');
    await new Promise((resolve) => setTimeout(resolve, 10));
    const nonPhDelete = fetchCalls.find((call) => call.url === '/protoclaw/prebuilt_project/delete');
    assert.ok(nonPhDelete, '确认后必须发出项目删除请求');
    assert.equal(nonPhDelete.method, 'POST');
    assert.equal(nonPhDelete.body.agentId, 'memo');
    assert.equal(nonPhDelete.body.projectId, 'proj-x');
    assert.match(nonPhDelete.body.operationId, /^delete-project/);
    assert.equal(nonPhDelete.body.responseMode, 'delta');
    assert.equal(contextUi.contextMenuProjectId, null);
    assert.equal(isOpen(dom, 'project-context-menu'), false);
  });
});

/* ── 6. 真实事件：文档 / 窗口 / 容器级监听 ───────────────────────── */

test('文档级事件：outside click 关闭四类菜单，#ctx-menu 条目 click / Enter 走真实分发', async () => {
  await withMenuCase(async (c, { dom, calls }) => {
    const { store, contextUi } = await loadMenu(c);
    store.setAllAgents([makeAgent()]);

    const openAll = () => {
      for (const id of ['agent-context-menu', 'compact-context-menu', 'project-context-menu', 'feature-repo-context-menu']) {
        menuEl(dom, id).classList.add('open');
      }
      contextUi.contextMenuAgentId = 'a';
      contextUi.contextMenuCompactAction = { sessionId: 's' };
      contextUi.contextMenuProjectAgentId = 'p';
      contextUi.contextMenuProjectId = 'p1';
      contextUi.contextMenuFeatureRepoPackageId = 'pkg';
      menuEl(dom, 'ctx-menu').classList.remove('open');
    };

    // 1) outside click：全部关闭且状态清空
    openAll();
    fire(dom.document, 'click', { target: makeElement('outside') });
    for (const id of ['agent-context-menu', 'compact-context-menu', 'project-context-menu', 'feature-repo-context-menu']) {
      assert.equal(isOpen(dom, id), false, `${id} 应在外部点击后关闭`);
    }
    assert.equal(contextUi.contextMenuAgentId, null);
    assert.equal(contextUi.contextMenuCompactAction, null);
    assert.equal(contextUi.contextMenuProjectId, null);
    assert.equal(contextUi.contextMenuFeatureRepoPackageId, null);
    assert.ok(calls.some((call) => call.fn === 'closeCtxMenu'));

    // 2) #ctx-menu 条目 click → 真实 dispatchCtxAction（ctx-menu-items）
    const ctxItem = makeElement('ctx-item');
    ctxItem.dataset.ctxAction = 'summary';
    const target = { role: 'runtime', ns: 'programming-helper', id: 'rt-ph', sessionId: 'sess-1', variant: 'child' };
    c.window._ctxTarget = target;
    menuEl(dom, 'ctx-menu').classList.add('open');
    fire(dom.document, 'click', {
      target: { closest: (selector) => (selector === '#ctx-menu [data-ctx-action]' ? ctxItem : null) },
    });
    const action = calls.find((call) => call.fn === 'runWorkspaceAction');
    assert.deepEqual(JSON.parse(action.action), {
      type: 'compact_session_menu', agentId: 'programming-helper', sessionId: 'sess-1', compactType: 'summary',
    });
    assert.equal(calls.filter((call) => call.fn === 'runWorkspaceAction').length, 1, '一次条目点击只分发一次动作');
    assert.ok(calls.some((call) => call.fn === 'closeCtxMenu'), '条目点击后必须关菜单');

    // 3) Enter 键：同一条目走键盘分发路径
    calls.length = 0;
    menuEl(dom, 'ctx-menu').classList.add('open');
    const keyItem = makeElement('ctx-item-key');
    keyItem.dataset.ctxAction = 'delete-session-runtime';
    fire(dom.document, 'keydown', {
      key: 'Enter',
      preventDefault() {},
      target: { closest: (selector) => (selector === '#ctx-menu [data-ctx-action][role="menuitem"]' ? keyItem : null) },
    });
    const keyActions = calls.filter((call) => call.fn === 'runWorkspaceAction');
    assert.equal(keyActions.length, 1, '一次 Enter 只分发一次动作');
    assert.deepEqual(JSON.parse(keyActions[0].action), { type: 'delete_session', sessionId: 'sess-1' });
    assert.ok(calls.some((call) => call.fn === 'closeCtxMenu'));
    delete c.window._ctxTarget;
  });
});

test('窗口级事件：resize 钳制右栏宽度并重定位 rail、scroll(capture) 关闭菜单', async () => {
  await withMenuCase(async (c, { dom, calls, windowListeners }) => {
    const { layout } = await loadMenu(c);
    // 模块相的环境计时器（runtime-status 的 200ms 通知时钟在求值时启动，与 classic
    // 加载期同义）不属于本用例的异步尾巴：只断言本用例动作没有新增残留。
    const ambientTimers = c.timerCount();
    layout.setFeaturePanelWidth(900);
    menuEl(dom, 'feature-panel').classList.add('open');

    fire({ _listeners: windowListeners }, 'resize', {});
    // 1280 宽 → 最小 400；900 未超上限，保持 900?（真实钳制：min(750, 900) = 750）
    assert.equal(layout.getFeaturePanelWidth(), 750);
    assert.equal(menuEl(dom, 'feature-panel').style._props['--feature-panel-width'], '750px');
    await new Promise((resolve) => setTimeout(resolve, 2));
    assert.equal(calls.some((call) => call.fn === 'updateAssemblySideRailPosition'), true);

    // 下限：宽屏 400、1100 及以下 300（低于下限才看得到钳制分支）
    layout.setFeaturePanelWidth(100);
    fire({ _listeners: windowListeners }, 'resize', {});
    assert.equal(layout.getFeaturePanelWidth(), 400);
    layout.setFeaturePanelWidth(100);
    c.window.innerWidth = 1000;
    fire({ _listeners: windowListeners }, 'resize', {});
    assert.equal(layout.getFeaturePanelWidth(), 300);

    // scroll（capture 注册）关闭 agent / 精简 / 项目菜单
    for (const id of ['agent-context-menu', 'compact-context-menu', 'project-context-menu']) {
      menuEl(dom, id).classList.add('open');
    }
    layout.setFeaturePanelWidth(500);
    fire({ _listeners: windowListeners }, 'scroll', {});
    for (const id of ['agent-context-menu', 'compact-context-menu', 'project-context-menu']) {
      assert.equal(isOpen(dom, id), false, `${id} 应在滚动时关闭`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
    assert.equal(c.timerCount(), ambientTimers, 'RAF 由用例记账，收尾不得残留计时器');
  });
});

test('容器级 contextmenu：声明式条目走 showCtxMenu、仓库卡片与项目卡片走各自菜单', async () => {
  await withMenuCase(async (c, { dom, calls }) => {
    const { store, contextUi } = await loadMenu(c);
    store.setAllAgents([makeAgent()]);
    const container = menuEl(dom, 'chat-container');

    // 1) data-ctx-role 声明式条目（ADR-0049）：合成菜单并交给 app-ui showCtxMenu
    const ctxEl = { dataset: { ctxRole: 'session', ctxNs: 'programming-helper', ctxId: 'sess-1', ctxVariant: 'default' } };
    const event = {
      clientX: 40, clientY: 60,
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
      target: { closest: (selector) => (selector === '[data-ctx-role]' ? ctxEl : null) },
    };
    fire(container, 'contextmenu', event);
    const shown = calls.find((call) => call.fn === 'showCtxMenu');
    assert.equal(event.defaultPrevented, true);
    assert.equal(shown.x, 40);
    assert.equal(shown.y, 60);
    assert.equal(shown.target.role, 'session');
    assert.equal(shown.target.sessionId, 'sess-1');
    assert.ok(shown.items.length > 0, '声明式会话条目必须合成出菜单项');

    // 2) feature 仓库卡片 → 专用菜单 + 待删包 id
    const repoCard = { dataset: { featureRepoPackageId: 'pkg-42' } };
    fire(container, 'contextmenu', {
      clientX: 10, clientY: 20,
      preventDefault() {},
      target: { closest: (selector) => (selector === '.workspace-repo-card[data-feature-repo-package-id]' ? repoCard : null) },
    });
    assert.equal(isOpen(dom, 'feature-repo-context-menu'), true);
    assert.equal(contextUi.contextMenuFeatureRepoPackageId, 'pkg-42');

    // 3) 项目卡片 → 项目菜单 + (agentId, projectId)
    const projectCard = { dataset: { prebuiltProjectAgentId: 'programming-helper', prebuiltProjectId: 'proj-3' } };
    fire(container, 'contextmenu', {
      clientX: 30, clientY: 50,
      preventDefault() {},
      target: { closest: (selector) => (selector === '[data-prebuilt-project-id]' ? projectCard : null) },
    });
    assert.equal(isOpen(dom, 'project-context-menu'), true);
    assert.equal(contextUi.contextMenuProjectAgentId, 'programming-helper');
    assert.equal(contextUi.contextMenuProjectId, 'proj-3');
  });
});
