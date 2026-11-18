/**
 * P2 批次 W2-8（编程小助手项目域）交付钉子。
 *
 * 钉什么：
 *   1. 时序证据（R1/R2/R4）：classic 相（脚本解析/执行期）本批零触达——模块执行前
 *      `window.getPathLeaf` 等公开键不存在；模块执行后经 kernel-state 访问器桥取到
 *      与命名导出同源的实现，且只桥「仍有 classic / 跨批消费方」的键；
 *   2. project-data 数据层语义与负例：目录桶 / 项目实体桶、浏览目标（typed target
 *      优先级、归档项目回退）、会话归属参数、记录与 workspace state 写入口（经
 *      agent-store live binding 落地）；切片请求失败不改 membership、不重绘；
 *   3. ph-session-list：搜索状态机（含 stale 响应拒绝）与动作分发；会话 ⋯ 菜单的
 *      三个菜单关闭入口走 **真实 context-menu 模块**（清 app-core 的 contextMenu*
 *      待执行目标与 DOM open 态），不是 classic 桩；
 *   4. ph-project-actions：按浏览目标归属拉取会话切片即 membership 替换、渲染缓存
 *      失效与主视图重绘；设置面板身份写入；
 *   5. ph-session-move：多选状态与 scope 漂移作废；移动弹窗提交走**真实**流水线
 *      ——成功时重拉切片后由真实 agent-snapshot-loader 的 `loadAgents` 重投影侧栏，
 *      409 busy 时显式失败、零刷新；
 *   6. ph-search-locate：返回搜索经**真实** workspace-surface 的 `selectWorkspaceSurface`
 *      落到宿主 seam（bindWorkspace / setTab / render），不是 classic 桩。
 *
 * 装载路线（配方第三节）：真实 import 整图（withP2EsmCase 的 case 级图隔离）；classic
 * 侧按真实加载序执行 action-dispatcher / i18n / app-core，其余 classic owner（app-main /
 * app-ui / sidebar-render / remote-connections / chat-renderer / chat-viewport 等）的
 * 函数用最小替身注入；**已 ESM 的能力（context-menu / agent-snapshot-loader-host /
 * workspace-surface-host / project-data / ph-*）不注入替身**，只给它们各自的宿主工厂
 * seam（createAgentSnapshotLoaderHost / createWorkspaceSurfaceHost —— 生产里由
 * sidebar-render / app-ui 提供的同形契约）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Renderer } from 'marked';
import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { APP_CORE_DOMAIN, prepareEsmModules } from './p2-classic-hosts.js';

const BOOTSTRAP = 'public/src/modules/p2-w2-8-project-domain-bootstrap.js';

const MODULES = {
  data: 'public/src/modules/project-data.js',
  list: 'public/src/modules/ph-session-list.js',
  settings: 'public/src/modules/ph-settings.js',
  actions: 'public/src/modules/ph-project-actions.js',
  move: 'public/src/modules/ph-session-move.js',
  locate: 'public/src/modules/ph-search-locate.js',
};

/** 真实元素形状桩：querySelector/All 返回可挂监听的替身元素，handler 可被测试驱动。 */
function makeElement(id = '') {
  const el = {
    id,
    innerHTML: '', textContent: '', value: '', className: '', hidden: false,
    disabled: false, checked: false,
    style: {}, dataset: {}, children: [], offsetHeight: 0,
    scrollTop: 0, scrollHeight: 0, clientHeight: 0,
    _q: new Map(), _qa: new Map(), handlers: {},
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); }, remove(c) { this._set.delete(c); },
      toggle(c, on) { if (on === undefined) { this._set.has(c) ? this._set.delete(c) : this._set.add(c); } else if (on) this._set.add(c); else this._set.delete(c); },
      contains(c) { return this._set.has(c); },
    },
    addEventListener(type, fn) { (el.handlers[type] = el.handlers[type] || []).push(fn); },
    removeEventListener(type, fn) {
      const list = el.handlers[type] || [];
      const at = list.indexOf(fn);
      if (at >= 0) list.splice(at, 1);
    },
    dispatch(type, event) { for (const fn of el.handlers[type] || []) return fn(event); return undefined; },
    appendChild(child) { el.children.push(child); return child; },
    insertBefore(child) { el.children.push(child); return child; },
    append() {}, removeChild() {}, replaceWith() {},
    remove() { el.isConnected = false; },
    focus() {}, blur() {}, click() {}, select() {}, setSelectionRange() {}, scrollIntoView() {},
    getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0, x: 0, y: 0 }; },
    closest() { return null; }, matches() { return false; }, contains() { return false; },
    insertAdjacentHTML() {},
    querySelector(sel) {
      if (!el._q.has(sel)) el._q.set(sel, makeElement(sel));
      return el._q.get(sel);
    },
    querySelectorAll(sel) {
      if (!el._qa.has(sel)) el._qa.set(sel, [makeElement(sel)]);
      return el._qa.get(sel);
    },
    getAttribute(name) { return el.dataset?.[name] ?? null; },
    setAttribute(name, value) { el.dataset[name] = String(value); },
    removeAttribute() {}, hasAttribute() { return false; },
    getElementsByTagName() { return []; }, getElementsByClassName() { return []; },
    isConnected: true,
  };
  return el;
}

/** 按 id 缓存元素 + 可编排的 querySelector（.ph-session-tabs 等单例面）。 */
function createDocumentStub() {
  const byId = new Map();
  const byQuery = new Map();
  return {
    getElementById(id) {
      if (!byId.has(id)) byId.set(id, makeElement(id));
      return byId.get(id);
    },
    createElement() { return makeElement(); },
    createTextNode(text) { return { textContent: text }; },
    querySelector(sel) { return byQuery.get(sel) || null; },
    querySelectorAll() { return []; },
    /** 测试编排：为某个选择器挂单例元素。 */
    setQuery(sel, el) { byQuery.set(sel, el); },
    addEventListener() {}, removeEventListener() {},
    getElementsByTagName() { return []; },
    getElementsByClassName() { return []; },
    body: makeElement('body'), head: makeElement('head'), documentElement: makeElement('html'),
    readyState: 'complete',
    activeElement: null,
    hasFocus: () => true,
    contains: () => true,
  };
}

/**
 * 网络面桩：按路径查表返回 JSON；表项可以是对象、函数或（stale 用例里的）受控 Promise。
 * `{ __mock: { status, ok }, body }` 用于 409 一类非 2xx 响应。
 */
function createFetchStub(table = {}) {
  const calls = [];
  const stub = async (url, init = {}) => {
    const target = String(url);
    calls.push({ url: target, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
    const path = target.split('?')[0];
    const handler = table[path];
    let payload = typeof handler === 'function' ? await handler(target, init) : handler;
    let status = 200;
    let ok = true;
    if (payload && typeof payload === 'object' && payload.__mock) {
      status = payload.__mock.status ?? 200;
      ok = payload.__mock.ok ?? (status >= 200 && status < 300);
      payload = payload.body;
    }
    return { ok, status, json: async () => payload, text: async () => JSON.stringify(payload) };
  };
  stub.calls = calls;
  return stub;
}

function makePhAgent(overrides = {}) {
  return {
    id: 'programming-helper',
    name: 'Programming Helper',
    source: 'prebuilt',
    connected: true,
    sessionOps: true,
    workspace_state: {
      openDirectory: '/w/alpha',
      phProjects: [{ openDirectory: '/w/alpha' }],
      updatedAt: '2026-11-10T00:00:00Z',
      forms: {},
    },
    workspace_sessions: {
      activeSessionId: 's-dir-1',
      sessionProjectId: '',
      sessions: [
        { id: 's-dir-1', title: 'dir one', openDirectory: '/w/alpha', createdAt: '2026-11-10T00:00:00Z', updatedAt: '2026-11-17T00:00:00Z' },
        { id: 's-prj-1', title: 'prj one', projectId: 'prj_1', openDirectory: '/w/alpha', createdAt: '2026-11-10T00:00:00Z', updatedAt: '2026-11-16T00:00:00Z' },
      ],
      phActivity: { directories: { 'dir:/w/alpha': '2026-11-17T00:00:00Z' } },
    },
    ...overrides,
  };
}

/**
 * classic 侧宿主面：本批 ESM 图在模块顶层读取的工厂与调用时点晚绑定的 classic 函数。
 * 已 ESM 的能力（context-menu / loadAgents / selectWorkspaceSurface）刻意不在此列。
 */
const CLASSIC_HOSTS = `
  window.__calls = [];
  getCurrentAgentRecord = () => window.__testAgent || null;
  renderCurrentMainView = () => { window.__calls.push('renderCurrentMainView'); };
  renderWorkspaceSurface = () => '';
  renderAgentList = () => { window.__calls.push('renderAgentList'); };
  refreshThreads = async () => { window.__calls.push('refreshThreads'); };
  isRemoteNamespaceAgentId = (id) => String(id || '').startsWith('remote:');
  readCurrentSessionViewState = () => ({ runtimeId: 'r1', identity: { sessionId: 's1' }, messages: [], switchEpoch: 1 });
  computeAssistantErrorGroups = () => ({ plan: [] });
  registerManualScrollIntent = () => { window.__calls.push('registerManualScrollIntent'); };
  requestFollowLatest = () => { window.__calls.push('requestFollowLatest'); };
  toggleErrorGroup = () => {};
  toggleMessage = () => {};
  closeCtxMenu = () => { window.__calls.push('closeCtxMenu'); };
  showCtxMenu = (x, y, items) => { window.__calls.push('showCtxMenu:' + items.length); };
  getRemoteHistoryProjectBuckets = () => [];
  // workspace-surface 的宿主 seam（生产由 app-ui 的 createWorkspaceSurfaceHost 提供）：
  createWorkspaceSurfaceHost = () => ({
    bumpNavigationGuard: () => { window.__calls.push('surface.bumpNavigationGuard'); },
    closeReadOnlySession: () => {},
    hasDetail: () => true,
    loadDetail: async () => {},
    render: () => { window.__calls.push('surface.render'); },
    refreshPanels: () => { window.__calls.push('surface.refreshPanels'); },
    findAgent: (id) => (window.__testAgent && window.__testAgent.id === id ? window.__testAgent : null),
    currentAgent: () => window.__testAgent || null,
    preferenceKey: () => null,
    tabs: () => [{ id: 'home' }, { id: 'chat' }],
    surfacePreference: () => null,
    defaultMode: () => 'chat',
    ui: () => ({ entry: 'home' }),
    focusedAgentId: () => null,
    runtimeId: () => '',
    contextKey: () => '',
    saveScroll: () => {},
    readOnlyMode: () => false,
    saveCache: () => {},
    bindWorkspace: (agentId, tab, previousAgent, runtime) => {
      window.__calls.push('surface.bindWorkspace:' + agentId + ':' + tab);
    },
    setFollowLatest: () => {},
    resetRuntimeState: () => {},
    clearPending: () => { window.__calls.push('surface.clearPending'); },
    beginPending: () => {},
    setTab: (tab) => { window.__calls.push('surface.setTab:' + tab); },
    beginLoading: () => {},
    renderAgents: () => { window.__calls.push('surface.renderAgents'); },
    renderPanel: () => { window.__calls.push('surface.renderPanel'); },
  });
  createRuntimeStatusLoaderHost = () => ({});
  createSessionDataLoaderHost = () => ({});
  createRuntimeSwitchHost = () => ({ state: {} });
  // 轮询协调器宿主（classic app-main 工厂）：ESM 图经 agent-data-loader → input-actions
  // 触达 poll-coordinator-host，后者在模块求值期取该工厂。本文件不驱动轮询。
  createPollCoordinatorHost = () => ({
    run: async () => {}, fastInterval: () => 1000, setTimeout: () => 0, clearTimeout: () => {},
  });
  createCompactResumeHost = () => ({ state: {}, now: () => Date.now() });
  createAgentCallStatesHost = () => ({ state: {} });
  createCallInterruptHost = () => ({ state: {} });
  createSessionViewCommitHost = () => ({ state: {} });
  createRuntimeViewCacheHost = () => ({ state: {} });
  createP2BootstrapSidebarRenderHost = () => ({ lastAgentListRenderSignature: '' });
  // 侧栏渲染自 P4 T2 起在模块相：真实 renderAgentList 的 classic 协作面。本条
  // 用例断言「重投影后侧栏被重绘」，观测点就是渲染入口每次都会调用的顶栏 chrome。
  groupConnectedAgents = (agents) => ({ external: Array.isArray(agents) ? agents : [], groups: [] });
  updateCurrentAgentChrome = () => { window.__calls.push('renderAgentList'); };
  // call 状态引擎的两个桥键（生产由 modules/agent-call-states-engine.js 注册；
  // 本文件的裁剪链不装引擎，按「无存活轮次」的语义给替身）。
  collectActiveCallRuntimeIds = () => [];
  refreshAgentCallStates = async () => {};
  ClawSidebarLayout = { load: async () => {}, signature: () => '', isInteracting: () => false, render: () => {} };
  AgentLoaderHost = { loadedAgentDetailIds: new Set() };
`;

function caseOptions({ agent = makePhAgent(), projects = null, fetchTable = {}, document: doc = null } = {}) {
  const document = doc || createDocumentStub();
  const fetchStub = createFetchStub(fetchTable);
  const options = {
    classic: (sandbox) => {
      sandbox.loadSource('public/src/modules/action-dispatcher.js');
      // i18n 已迁 ESM（P4）：t 桥键由 createFrontendSandbox 自动装载，见 test/helpers/install-i18n.js
      prepareEsmModules(sandbox, APP_CORE_DOMAIN);
      sandbox.run(CLASSIC_HOSTS);
      sandbox.__testAgent = agent;
      sandbox.allAgents = [agent];
      if (projects) {
        sandbox.ClawFW = sandbox.ClawFW || {};
        sandbox.ClawFW.phProjectEntities = { loaded: true, loading: null, projects };
      }
    },
    globals: {
      document,
      fetch: fetchStub,
      matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
      ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
      IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
      URLSearchParams,
      CSS: { escape: (value) => value },
      // vendor 面（index.html 的 marked UMD 先于 module 标签）：markdown-utils 在求值期
      // new Renderer() 并 setOptions；本文件只用到 lexer 的分块面。
      marked: { lexer: () => [], Renderer, setOptions() {} },
    },
  };
  return { options, fetchStub, document, agent };
}

const projectEntity = (overrides = {}) => ({
  id: 'prj_1',
  type: 'project',
  name: 'Alpha project',
  openDirectory: '/w/alpha',
  directorySource: 'external',
  archived: false,
  createdAt: '2026-11-10T00:00:00Z',
  updatedAt: '2026-11-12T00:00:00Z',
  lastActivityAt: '2026-11-16T00:00:00Z',
  ...overrides,
});

const callsOf = (c) => Array.from(c.read('window.__calls'));

test('时序证据与兼容桥面：classic 相零触达，模块执行后逐键同源', async () => {
  const { options, agent } = caseOptions();
  await withP2EsmCase(options, async (c) => {
    // classic 相：模块尚未执行 → 公开键不存在（首屏同步链不需要它们）
    assert.equal(c.read('typeof window.getPathLeaf'), 'undefined');
    assert.equal(c.read('typeof window.canEnterWorkspaceChat'), 'undefined');
    assert.equal(c.read('typeof window.phOpenSettings'), 'undefined');
    assert.equal(c.read('typeof window.renderPhSettingsOverlay'), 'undefined');

    await c.load(BOOTSTRAP);
    const data = await c.load(MODULES.data);
    const list = await c.load(MODULES.list);
    const settings = await c.load(MODULES.settings);
    const actions = await c.load(MODULES.actions);
    const move = await c.load(MODULES.move);
    const locate = await c.load(MODULES.locate);

    // 桥键与命名导出同源、不可枚举（与顶层 let 语义一致）
    const bridged = [
      [data, 'getPathLeaf'], [data, 'getAgentWorkspaceState'], [data, 'updateAgentRecord'],
      [data, 'canEnterWorkspaceChat'], [data, 'resolveSidebarChildProjectGroup'],
      [actions, 'phSwitchProject'],
      [actions, 'phLoadProjectSessions'], [actions, 'phSetupLoadMoreAutoScroll'],
    ];
    for (const [mod, key] of bridged) {
      assert.equal(typeof mod[key], 'function', `${key} 是命名导出`);
      assert.equal(c.read(`typeof window.${key}`), 'function', `${key} 经兼容桥可达`);
      assert.equal(c.read(`window.${key}`), mod[key], `${key} 桥与导出同源`);
      assert.equal(c.read(`Object.getOwnPropertyDescriptor(window, '${key}').enumerable`), false,
        `${key} 访问器不可枚举`);
    }

    // 命名导出但无本批外消费者 → 不上桥（renderPhSettingsOverlay 唯一调用方已 import）
    assert.equal(typeof settings.renderPhSettingsOverlay, 'function');
    assert.equal(c.read('typeof window.renderPhSettingsOverlay'), 'undefined');

    // P2 兼容债收敛：ESM 消费方改直接 import 的入口桥已注销（命名导出仍在）
    const withdrawn = [
      // workspace-actions 验收为 ESM（直接 import）后 classic 消费面归零的键
      [data, 'getFeatureCreatorProjects'], [data, 'getAgentCreatorProjects'],
      [data, 'hasWorkspaceSessions'], [data, 'applyManagedPrebuiltAgent'],
      [locate, 'phSearchLocatePrepare'], [locate, 'phSearchLocateAfterOpen'],
      [data, 'getProgrammingHelperProjects'], [data, 'getPhCurrentDirectoryContext'],
      [data, 'getPhDirectoryNavigationList'], [data, 'getPhProjectsInDirectory'],
      [data, 'getPhProjectBoundDirectoryBucket'], [data, 'getFeatureSessionDisplayName'],
      [data, 'getFeatureProjectDisplayName'], [data, 'getAgentProjectDisplayName'],
      [data, 'updateAgentWorkspaceState'], [list, 'phOnSearchInput'],
      [list, 'phShowSessionCtxMenu'], [list, 'phTopicPanelInnerHtml'],
      [actions, 'phOpenSettings'], [actions, 'phOpenProject'],
      [actions, 'phLoadMoreSessions'], [actions, 'phToggleModelSlot'],
      [move, 'phSessionMoveReset'], [move, 'phToggleSessionSelection'],
      [move, 'phOpenSessionMoveDialog'], [move, 'phSessionMoveSyncScope'],
    ];
    for (const [mod, key] of withdrawn) {
      assert.equal(typeof mod[key], 'function', `${key} 仍是命名导出`);
      assert.equal(c.read(`typeof window.${key}`), 'undefined', `${key} 的桥已注销`);
    }

    // 非导出 / 模块私有：零生产消费的入口收敛为模块作用域
    for (const key of ['setPhBrowsingTarget', 'clearPhBrowsingTarget', 'getProjectLocalHostAgentId',
      'phSearchResetState', 'phRebindProject', 'phDeleteProject', 'phOpenInExplorer',
      'phOpenDirectorySubmenu', 'phScheduleDirectorySubmenuClose',
      'phSearchLocateBack', 'phSearchLocateDismiss', 'phSettingsAgentId',
      '_phCurrentProject', 'phDirIdOf', 'normalizePhProjectEntity']) {
      assert.equal(c.read(`typeof window.${key}`), 'undefined', `${key} 不上桥`);
    }
    for (const key of ['phOpenDirectorySubmenu', 'phScheduleDirectorySubmenuClose', 'phSearchLocateDismiss']) {
      assert.equal(actions[key] ?? locate[key], undefined, `${key} 不导出（模块私有）`);
    }

    // 数据层：目录桶来自 workspace phProjects + 会话目录；项目实体未加载时无项目桶
    const buckets = data.getProgrammingHelperProjects(agent);
    const dirBucket = buckets.find((bucket) => bucket.id === 'dir:/w/alpha');
    assert.ok(dirBucket, '目录桶存在');
    assert.equal(dirBucket.type, 'directory');
    assert.deepEqual(dirBucket.sessions.map((s) => s.id), ['s-dir-1', 's-prj-1']);
    assert.equal(dirBucket.conversationCount, 2);
    assert.equal(buckets.some((bucket) => bucket.id === 'prj_1'), false, '实体未加载无项目桶');
  });
});

test('project-data：浏览目标、目录导航、归属参数与记录写入口', async () => {
  const { options, agent } = caseOptions({ projects: [projectEntity()] });
  await withP2EsmCase(options, async (c) => {
    await c.load(BOOTSTRAP);
    const data = await c.load(MODULES.data);

    // 无持久化目标 → 目录回退（workspace_state.openDirectory）
    assert.deepEqual(data.getPhBrowsingTarget(agent), { type: 'dir', id: 'dir:/w/alpha', openDirectory: '/w/alpha' });
    assert.deepEqual(data.getPhSessionOwnershipParams(agent), { projectDir: '/w/alpha' });

    // 显式项目目标优先；目录上下文随之切到项目绑定目录
    data.setPhBrowsingTarget(agent.id, { type: 'project', id: 'prj_1' });
    const target = data.getPhBrowsingTarget(agent);
    assert.equal(target.type, 'project');
    assert.equal(target.project.name, 'Alpha project');
    assert.deepEqual(data.getPhSessionOwnershipParams(agent), { projectId: 'prj_1' });
    assert.deepEqual(data.getPhCurrentDirectoryContext(agent), {
      dirId: 'dir:/w/alpha', openDirectory: '/w/alpha', org: 'project', projectId: 'prj_1',
    });

    // 归档项目不再是有效目标：过期目标被清除并回退目录模式
    c.window.ClawFW.phProjectEntities.projects = [projectEntity({ archived: true })];
    assert.deepEqual(data.getPhBrowsingTarget(agent), { type: 'dir', id: 'dir:/w/alpha', openDirectory: '/w/alpha' });
    c.window.ClawFW.phProjectEntities.projects = [projectEntity()];

    // 目录导航：注册目录与项目绑定目录并存，项目作为二级条目挂在同目录桶上
    const navEntries = data.getPhDirectoryNavigationList(agent);
    assert.deepEqual(navEntries.map((entry) => entry.id), ['dir:/w/alpha']);
    assert.equal(navEntries[0].projects.length, 1);
    assert.equal(navEntries[0].projects[0].id, 'prj_1');

    // 侧栏子条目分组身份：项目会话按 prj:<id> 分组，目录会话按目录分组
    assert.deepEqual(data.resolveSidebarChildProjectGroup({ projectId: 'prj_1' }, new Map()),
      { projectKey: 'prj:prj_1', projectName: 'Alpha project', projectDir: '', projectId: 'prj_1' });
    assert.deepEqual(data.resolveSidebarChildProjectGroup({ sessionId: 's1', openDirectory: '/w/gamma' }, new Map()),
      { projectKey: '', projectName: 'gamma', projectDir: '/w/gamma' });

    // 记录写入口落 agent-store live binding：classic 裸标识符与 import 同源
    assert.equal(c.read("updateAgentRecord('programming-helper', { status: 'running' }).status"), 'running');
    assert.equal(c.read('allAgents[0].status'), 'running');
    assert.equal(data.getAgentWorkspaceState(c.read('allAgents[0]')).openDirectory, '/w/alpha');
    // updateAgentWorkspaceState 的桥已注销（ESM 消费方改 import）：直接经命名导出写
    data.updateAgentWorkspaceState('programming-helper', { openDirectory: '/w/delta', forms: {}, updatedAt: null });
    assert.equal(c.read('allAgents[0].workspace_state.openDirectory'), '/w/delta');
    assert.equal(data.getPhBrowsingTarget(c.read('allAgents[0]')).openDirectory, '/w/delta');
  });
});

test('ph-project-actions：按归属拉取切片即 membership 替换；失败不改状态（负例）', async () => {
  let failNext = false;
  const { options, fetchStub, document } = caseOptions({
    projects: [projectEntity()],
    fetchTable: {
      '/protoclaw/prebuilt_sessions': () => (failNext
        ? { __mock: { status: 500, ok: false }, body: { error: 'boom' } }
        : {
          sessions: [{ id: 's-new', title: 'fresh', createdAt: '2026-11-17T00:00:00Z', updatedAt: '2026-11-17T01:00:00Z' }],
          activeSessionId: 's-new',
          sessionTotal: 1,
        }),
      '/protoclaw/model_config': { presets: [] },
    },
  });
  await withP2EsmCase(options, async (c) => {
    await c.load(BOOTSTRAP);
    const data = await c.load(MODULES.data);
    const actions = await c.load(MODULES.actions);
    const settings = await c.load(MODULES.settings);
    const entry = await c.load('public/src/modules/render-entry-state.js');

    data.setPhBrowsingTarget('programming-helper', { type: 'project', id: 'prj_1' });
    entry.setLastRenderedWorkspaceHtml('<stale/>');
    const loaded = await actions.phLoadProjectSessions({ projectId: 'prj_1' });
    assert.equal(loaded, true);

    const request = fetchStub.calls.find((call) => call.url.startsWith('/protoclaw/prebuilt_sessions?'));
    const query = new URLSearchParams(request.url.split('?')[1]);
    assert.equal(query.get('projectId'), 'prj_1');
    assert.equal(query.get('projectDir'), null, '项目目标不带目录参数');
    assert.equal(query.get('offset'), '0');
    assert.equal(query.get('limit'), '60');

    // membership 全量替换（不是合并）：切片即新工作区会话事实
    const host = c.read('allAgents').find((item) => item.id === 'programming-helper');
    assert.deepEqual(host.workspace_sessions.sessions.map((s) => s.id), ['s-new']);
    assert.equal(host.active_workspace_session_id, 's-new');
    assert.equal(entry.lastRenderedWorkspaceHtml, '', '渲染缓存失效');
    assert.ok(callsOf(c).includes('renderCurrentMainView'));

    // 负例：切片请求失败 → 返回 false，记录与渲染缓存都不动
    const before = c.read('allAgents').find((item) => item.id === 'programming-helper').workspace_sessions;
    const callsBefore = callsOf(c).length;
    entry.setLastRenderedWorkspaceHtml('<kept/>');
    failNext = true;
    const failed = await actions.phLoadProjectSessions({ projectId: 'prj_1' });
    assert.equal(failed, false);
    assert.equal(c.read('allAgents').find((item) => item.id === 'programming-helper').workspace_sessions, before,
      '失败不替换 membership');
    assert.equal(entry.lastRenderedWorkspaceHtml, '<kept/>', '失败不失效渲染缓存');
    assert.equal(callsOf(c).length, callsBefore, '失败不触发主视图重绘');

    // 设置面板身份：getLogicalAgentId 归一后由 ph-settings 持有
    await actions.phOpenSettings({ initialTab: 'model' });
    assert.equal(settings.getPhSettingsAgentId(), 'programming-helper');
    assert.match(document.getElementById('ph-settings-host').innerHTML, /工作空间设置/);
  });
});

test('ph-session-list：搜索状态机、stale 拒绝与真实 context-menu 关闭后果', async () => {
  const doc = createDocumentStub();
  const searchCalls = [];
  const { options } = caseOptions({
    document: doc,
    fetchTable: {
      '/protoclaw/search_sessions': (url) => new Promise((resolve) => {
        searchCalls.push({ url, resolve });
      }),
    },
  });
  await withP2EsmCase(options, async (c) => {
    await c.load(BOOTSTRAP);
    const list = await c.load(MODULES.list);
    const phSession = await c.load('public/src/modules/p2-bootstrap-ph-session.js');

    // 搜索结果落地需要视图身份（DOM dataset 是身份来源）
    doc.setQuery('.ph-session-tabs', Object.assign(makeElement(), {
      dataset: { searchAgentId: 'programming-helper', searchDirectory: '/w/alpha' },
    }));

    // classic 写方（app-core 词法状态）与模块读方同源
    c.read("phSearchQuery = 'seeded'");
    assert.equal(phSession.phSessionUi.phSearchQuery, 'seeded');

    // 输入经 phSessionUi 转发 + 防抖句柄落在 classic 状态上
    list.phOnSearchInput('needle');
    assert.equal(phSession.phSessionUi.phSearchQuery, 'needle');
    assert.ok(phSession.phSessionUi._phSearchTimer, '防抖句柄交给 app-core owner');
    list.phClearSearch();
    assert.equal(phSession.phSessionUi.phSearchQuery, '');
    assert.equal(phSession.phSessionUi._phSearchTimer, null);

    // 搜索状态机：范围 / 排序 / 展开
    list.phSetSearchScopeByValue('archived');
    assert.equal(list._phSearch.scope, 'archived');
    list.phToggleSearchSort();
    assert.equal(list._phSearch.sort, 'recency');
    list.phSearchToggleExpand('s1');
    assert.equal(list._phSearch.expanded.has('s1'), true);
    list.phSearchToggleExpand('s1');
    assert.equal(list._phSearch.expanded.has('s1'), false);

    // 动作分发注册：data-action="phSessions.*" → 本模块导出
    assert.equal(c.read("ClawFW.actions.invoke('phSessions.searchToggleExpand', { dataset: { sessionId: 's2' } })"), true);
    assert.equal(list._phSearch.expanded.has('s2'), true);

    // stale 负例：两次请求，先发的旧响应回来后不得覆盖新结果
    c.read("phSearchQuery = 'alpha'");
    list.phSearchRetry();
    c.read("phSearchQuery = 'beta'");
    list.phSearchRetry();
    assert.equal(searchCalls.length, 2, '两次真实检索请求');
    assert.match(searchCalls[1].url, /q=beta/);
    searchCalls[1].resolve({ results: [{ sessionId: 'newer', title: 'b', matches: [] }], total: 1 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(list._phSearch.results.map((r) => r.sessionId), ['newer']);
    searchCalls[0].resolve({ results: [{ sessionId: 'older', title: 'a', matches: [] }], total: 1 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(list._phSearch.results.map((r) => r.sessionId), ['newer'], '旧查询响应被拒绝');

    // 真实 context-menu：⋯ 菜单关闭入口清空 app-core 待执行目标与 DOM open 态。
    // DOM 引用已迁 dom-refs（P4 T1）：菜单元素取该域的同一批引用（context-menu
    // 模块内的 import 与这里同一个模块实例）。
    const dom = await c.load('public/src/modules/dom-refs.js');
    c.read("contextMenuAgentId = 'programming-helper'; contextMenuCompactAction = 'archive'; contextMenuProjectAgentId = 'programming-helper';");
    dom.domRefs.agentContextMenu.classList.add('open');
    dom.domRefs.compactContextMenu.classList.add('open');
    dom.domRefs.projectContextMenu.classList.add('open');
    list.phShowSessionCtxMenu({ stopPropagation() {} }, makeElement('more'), 'programming-helper', 's-dir-1', 'main');
    assert.equal(c.read('contextMenuAgentId'), null);
    assert.equal(c.read('contextMenuCompactAction'), null);
    assert.equal(c.read('contextMenuProjectAgentId'), null);
    assert.equal(dom.domRefs.agentContextMenu.classList.contains('open'), false);
    assert.equal(dom.domRefs.compactContextMenu.classList.contains('open'), false);
    assert.equal(dom.domRefs.projectContextMenu.classList.contains('open'), false);
    assert.ok(callsOf(c).some((call) => call.startsWith('showCtxMenu:')), '菜单经 app-ui 几何入口打开');
  });
});

test('ph-search-locate：prepare 捕获后 back 走真实 workspace-surface 宿主', async () => {
  const { options } = caseOptions();
  await withP2EsmCase(options, async (c) => {
    await c.load(BOOTSTRAP);
    const locate = await c.load(MODULES.locate);
    const list = await c.load(MODULES.list);

    // prepare：搜索列表滚动位置写进共享的 _phSearch
    c.read('container.scrollTop = 42');
    locate.phSearchLocatePrepare({ sessionId: 's1', messageIndex: 3 });
    assert.equal(list._phSearch.homeScrollTop, 42);

    // back：真实 selectWorkspaceSurface 落宿主 seam（首页 surface）
    locate.phSearchLocateBack();
    const calls = callsOf(c);
    assert.ok(calls.includes('surface.bumpNavigationGuard'), '进入真实 selectWorkspaceSurface');
    assert.ok(calls.includes('surface.bindWorkspace:programming-helper:home'),
      `绑定到工作区首页：${calls.join('|')}`);
    assert.ok(calls.includes('surface.renderAgents'));
    assert.ok(calls.includes('surface.render'));
    assert.ok(calls.includes('surface.refreshPanels'));
  });
});

test('ph-session-move：多选状态与真实移动提交流水线（成功 + 409 负例）', async () => {
  let moveResponse = null;
  const { options, fetchStub } = caseOptions({
    projects: [projectEntity()],
    fetchTable: {
      '/protoclaw/ph_project/sessions_move': () => moveResponse,
      '/protoclaw/prebuilt_sessions': {
        sessions: [{ id: 's-dir-1', title: 'moved', openDirectory: '/w/alpha', createdAt: '2026-11-10T00:00:00Z', updatedAt: '2026-11-17T02:00:00Z' }],
        activeSessionId: 's-dir-1',
        sessionTotal: 1,
      },
      '/protoclaw/get_connected_agents': [],
      '/api/agents': { agents: [] },
    },
  });
  await withP2EsmCase(options, async (c) => {
    await c.load(BOOTSTRAP);
    const data = await c.load(MODULES.data);
    const move = await c.load(MODULES.move);
    const entry = await c.load('public/src/modules/render-entry-state.js');

    data.setPhBrowsingTarget('programming-helper', { type: 'dir', id: 'dir:/w/alpha', openDirectory: '/w/alpha' });
    entry.setLastRenderedWorkspaceHtml('<stale/>');
    move.phToggleSessionSelectMode();
    const state = move.phSessionMove; // 状态 owner：ph-session-move 命名导出（ClawFW 窗面已撤）
    assert.equal(state.selectMode, true);
    assert.equal(state.scopeKey, 'programming-helper||dir:/w/alpha');
    assert.equal(entry.lastRenderedWorkspaceHtml, '');
    assert.ok(callsOf(c).includes('renderCurrentMainView'));

    move.phToggleSessionSelection('s-dir-1', true);
    assert.equal(state.selected.has('s-dir-1'), true);
    move.phToggleSessionSelection('s-dir-1', false);
    assert.equal(state.selected.has('s-dir-1'), false);

    // 渲染期和解 + scope 漂移整体作废
    move.phToggleSessionSelection('s-stale', true);
    move.phSessionMoveSyncScope('programming-helper', 'dir:/w/alpha', ['s-dir-1']);
    assert.equal(state.selected.has('s-stale'), false);
    move.phSessionMoveSyncScope('programming-helper', 'prj_1', ['s-dir-1']);
    assert.equal(state.selectMode, false);

    // 成功路径：打开弹窗 → 选同目录项目 → 提交
    move.phToggleSessionSelectMode();
    move.phToggleSessionSelection('s-dir-1', true);
    await move.phOpenSessionMoveDialog(['s-dir-1']);
    const hostEl = c.document.getElementById('ph-move-dialog-host');
    const overlay = hostEl.children[0];
    assert.ok(overlay, '移动弹窗已挂载');
    // 目标清单：第 0 项是默认目录（当前归属，禁用），第 1 项是同目录项目
    overlay.querySelector('input[name="ph-move-target"]:checked').value = '1';
    moveResponse = { ok: true, movedSessionIds: ['s-dir-1'], target: { type: 'project', id: 'prj_1' } };
    const callsBeforeSubmit = callsOf(c).length;
    await overlay.querySelector('form').dispatch('submit', { preventDefault() {} });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const post = fetchStub.calls.find((call) => call.url === '/protoclaw/ph_project/sessions_move');
    assert.deepEqual(post.body, {
      agentId: 'programming-helper',
      sessionIds: ['s-dir-1'],
      target: { type: 'project', id: 'prj_1' },
    });
    assert.equal(overlay.isConnected, false, '成功后弹窗关闭');
    assert.equal(move.phSessionMove.selectMode, false, '多选状态复位');
    const after = callsOf(c).slice(callsBeforeSubmit);
    assert.ok(after.includes('refreshThreads'), '线程视图随移动事实刷新');
    // 侧栏重绘的观测点：真实 renderAgentList 入口（每次调用都经顶栏 chrome），
    // 既覆盖 loadAgents 的重投影，也覆盖移动链路随后的显式重渲。
    assert.ok(after.includes('renderAgentList'), '重投影后侧栏重绘（真实 renderAgentList 入口）');
    assert.ok(fetchStub.calls.some((call) => call.url.startsWith('/protoclaw/get_connected_agents')),
      '真实 loadAgents 发起连线查询');
    assert.ok(fetchStub.calls.some((call) => call.url === '/api/agents'), '真实 loadAgents 发起 viewer 查询');
    assert.equal(fetchStub.calls.filter((call) => call.url.startsWith('/protoclaw/prebuilt_sessions')).length, 1,
      '移动成功后按归属重拉切片');

    // 负例：409 busy → 显式失败、弹窗保留、零刷新副作用
    moveResponse = { __mock: { status: 409, ok: false }, body: { ok: false, legacyCode: 'ph_sessions_busy' } };
    move.phToggleSessionSelection('s-dir-1', true);
    await move.phOpenSessionMoveDialog(['s-dir-1']);
    const overlay2 = c.document.getElementById('ph-move-dialog-host').children.at(-1);
    overlay2.querySelector('input[name="ph-move-target"]:checked').value = '1';
    const callsBeforeBusy = fetchStub.calls.length;
    await overlay2.querySelector('form').dispatch('submit', { preventDefault() {} });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(overlay2.isConnected, true, 'busy 时弹窗保留');
    assert.match(overlay2.querySelector('.ph-move-error').textContent, /有对话正在执行/);
    assert.equal(overlay2.querySelector('.ph-move-error').hidden, false);
    assert.equal(overlay2.querySelector('button[type="submit"]').disabled, false, 'busy 后按钮复位');
    const busyCalls = fetchStub.calls.slice(callsBeforeBusy);
    assert.deepEqual(busyCalls.map((call) => call.url), ['/protoclaw/ph_project/sessions_move'],
      'busy 不做任何刷新请求（不重拉切片、不 loadAgents）');
    assert.equal(move.phSessionMove.selected.size, 1, 'busy 不清空多选');
  });
});

test('ph-settings：分页记忆、页签动作与面板骨架', async () => {
  const { options } = caseOptions();
  await withP2EsmCase(options, async (c) => {
    await c.load(BOOTSTRAP);
    const settings = await c.load(MODULES.settings);
    const agent = c.read('allAgents')[0];

    // 身份为编程小助手时才有插件 / 通知分页
    settings.setPhSettingsAgentId('programming-helper');
    settings.renderPhSettingsOverlay(agent, [], { initialTab: 'feature' });
    const featureHtml = c.document.getElementById('ph-settings-host').innerHTML;
    assert.match(featureHtml, /工作空间设置/);
    assert.match(featureHtml, /插件及配置/);
    assert.match(featureHtml, /功能配置/);

    // 分页切换经动作分发落到本模块（运行环境页 → 本地运行设置分页）
    assert.equal(c.read("ClawFW.actions.invoke('phSettings.switchTab', { dataset: { tab: 'runtime' } })"), true);
    const runtimeHtml = c.document.getElementById('ph-settings-host').innerHTML;
    assert.match(runtimeHtml, /运行环境/);
    assert.match(runtimeHtml, /本地运行设置/);
    assert.match(runtimeHtml, /容器运行设置/);
  });
});
