/**
 * P2 第二波批次 10（装配工作台与表面块）交付钉子。
 *
 * 钉什么：
 *   1. 批次 ESM 入口（p2-w2-10-assembly-bootstrap.js）真实装载：六个模块的
 *      求值顺序、KernelState 桥键注册/认领、action-dispatcher 注册面。
 *   2. 原行为：assembly-data 的装配环境状态机、workspace-blocks 的 block 可见性
 *      与列表字段解析、feature-config 的配置键归一 —— 搬代码不改行为。
 *   3. strict 修复：fw-config-panel 的 featureScrollTop 原为未声明赋值（strict
 *      IIFE 内必然 ReferenceError），改为模块私有滚动保存状态后，feature 开关
 *      的「渲染前保存 / 重渲染后还原」交互保持原语义。
 *   4. 异步过期：FW 能力缓存按 key 拒绝旧响应，晚到的旧 key 响应不覆盖新缓存。
 *   5. 兼容面穷举：仍有 classic 消费方的键经 kernel-state 桥暴露（与命名导出
 *      同址、不可枚举、claim 后 classic 写方经 setter 转发），批内消费方改 import。
 *      注册全集与声明清单等值——多注册/少注册都红；app-ui 裸调用的 5 个 fw
 *      渲染器桥（renderFWCreateDialog / renderFWConfirmDialog /
 *      renderFWPromptDialog / renderFWSwitchProjectDialog / renderFWFeatureImportDialog）
 *      仍属兼容面。消费方全部 ESM import 的 4 个键（applyWorkspaceBundle /
 *      normalizeWorkspaceStartupDraft / saveWorkspaceFormDraft /
 *      maybeWarnAssemblySessionDrift）桥已注销：仍作命名导出、window 侧缺席
 *      （IMPORT_ONLY_KEYS 钉住）。
 *   6. 同步首屏边界：workspace-docset.js 仍是 classic，`updateProjectDocsetChrome`
 *      在只加载 app-core 的沙箱里可直接执行（首屏路径不依赖 ESM）。
 *
 * 装载路线（withP2EsmCase，配方第三节「真实 import」）：一个用例 = 一份 classic
 * 沙箱 + 一张真实 ESM 图（case 级图隔离，见 test/helpers/p2-esm-case.js）。
 * classic 相按 index.html 真实加载序执行**可装载的真实 owner**：action-dispatcher /
 * i18n / app-core（P2 bootstrap 宿主工厂、AgentLoaderHost、call-interrupt 宿主）/
 * markdown-bootstrap（escapeHtml 桥键唯一实现）/ session-view-state
 * （createSessionViewCommitHost）。六个模块及其跨批依赖一律 `c.load` 真实 import，
 * 不再用 window 桩冒充已迁模块。
 *
 * 未装载的 classic owner（app-main / app-ui 一类的启动期与渲染入口文件）按契约
 * 给同形桩并注明归属；其中 sidebar-render 的三个宿主工厂因工厂体引用 app-main
 * 的会话级词法量（_agentSuspended 等）无法单独装载，同样按契约打桩。被测路径
 * 不经过这些宿主的真实实现（本文件不触发侧栏快照、call 状态对账、运行切换），
 * 桩体保留真实 console 出口，任何异常仍会落进用例的噪音断言，不会被空心 host 吞掉。
 *
 * 每个用例结束统一断言：无残留计时器、无非预期 console.warn / error——异步续体
 * （app_info 类请求、能力缓存、rAF 滚动还原）必须在 case 内结清。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { withP2EsmCase } from './helpers/p2-esm-case.js';

const REPO = path.resolve(import.meta.dirname, '..');
const ENTRY = 'public/src/modules/p2-w2-10-assembly-bootstrap.js';

/** 六个模块（domain 名 = 生产 KernelState 域）。 */
const MODULES = {
  'feature-config': 'public/src/modules/feature-config.js',
  'workspace-docset': 'public/src/modules/p2-w2-10-workspace-docset.js',
  'workspace-blocks': 'public/src/modules/workspace-blocks.js',
  'assembly-data': 'public/src/modules/assembly-data.js',
  'fw-config-panel': 'public/src/modules/fw-config-panel.js',
  'assembly-actions': 'public/src/modules/assembly-actions.js',
};

/** 同图内的状态 owner（与生产同一模块实例）。 */
const STATE_MODULES = {
  i18n: 'public/src/modules/i18n-environment-state.js',
  renderEntry: 'public/src/modules/render-entry-state.js',
};

/**
 * 本批桥面声明清单（穷举）。逐键来源见各模块末尾的「兼容桥」注释：
 *   - workspace-blocks 23 键 / assembly-data 15 键 / assembly-actions 19 键：
 *     app-ui 的块渲染、assembly.* 与 workspace 动作、ctx-menu-handlers 的删除确认；
 *   - fw-config-panel 19 键 = 13 个 fw* 入口 + renderProjectListBlock + 5 个 app-ui 渲染器（补充漏兼容）；
 *   - feature-config 1 键（FW 详情配置区）；workspace-docset 4 键（块渲染 +
 *     classic 首屏 updateProjectDocsetChrome 的转调）。
 * 多注册（造无消费桥）、少注册（漏兼容）、重复注册都会让穷举用例变红。
 */
const BRIDGE_SURFACE = {
  'feature-config': [
    'renderFWFeatureSettings',
  ],
  'workspace-docset': [
    'renderWorkspaceArtifactsBlock', 'renderProjectDocsetBlock',
    'renderProjectDocsetContent', 'toggleProjectDocsetOverlay',
  ],
  'workspace-blocks': [
    'shouldRenderBlock', 'renderWorkspaceHero', 'renderWorkspaceActionGroup',
    'renderWorkspaceLauncherGrid', 'renderWorkspaceForm', 'renderFlowEditorBlock',
    'renderWorkspaceStatusGrid', 'getFeatureRepositoryData', 'getRepoLocaleText',
    'parseWorkspaceListField', 'getAssemblyPresetLabel', 'getAssemblyPresetDescription',
    'ASSEMBLY_PRESET_FEATURES', 'ASSEMBLY_BUNDLE_FEATURES', 'applyAssemblyPreset',
    'setBundleFilter', 'getAssemblyStageLabel', 'getAssemblyFeatureLabel',
    'buildAssemblyGeneratedPrompt', 'getAssemblyPromptValue', 'getFeatureTypeLabel',
    'renderFeatureRepositoryBlock', 'renderAssemblyWorkbenchBlock',
  ],
  'assembly-data': [
    // buildWorkspaceProjectKey 的桥已注销（project-data 直接 import），仍作命名导出。
    // normalizeWorkspaceStartupDraft / saveWorkspaceFormDraft 同属已注销桥（见 IMPORT_ONLY_KEYS）。
    'isAssemblySession', 'isAssemblySessionRunning', 'getAssemblySessionStatus',
    'normalizeAssemblyDraft',
    'getAssemblyDisplayName', 'getAssemblyEnvironmentState',
    'getAssemblyEnvironmentStatusLabel', 'getAssemblyEnvironmentStatusTone',
    'renderAssemblyStatusChip', 'getAssemblySavedConfigSummary', 'getAssemblyEditorMode',
    'getWorkspaceFormDraft', 'updateAssemblyDraftField',
    'commitAssemblyDraftField', 'toggleAssemblyStage',
  ],
  'fw-config-panel': [
    'fwSwitchSection', 'fwOpenPromptEditor', 'fwOpenProjectPicker', 'fwBackToList',
    'fwToggleFeature', 'fwSetFeatureFilter', 'fwOpenFeatureImport', 'fwSetFeatureQuery',
    'fwCommitFeatureQuery', 'fwGetFeatureQuery', 'fwRerender', 'fwCreateNewAgent',
    'fwOpenProjectDetail', 'renderProjectListBlock',
    'renderFWCreateDialog', 'renderFWConfirmDialog', 'renderFWPromptDialog',
    'renderFWSwitchProjectDialog', 'renderFWFeatureImportDialog',
  ],
  'assembly-actions': [
    'updateWorkspaceFormDraft', 'toggleWorkspaceSelection',
    'createAssemblyEnvironment', 'launchAssemblyInstance', 'resetAssemblyDraft',
    'switchAssemblyEditingTarget', 'toggleAssemblyControlPanel', 'jumpAssemblyStage',
    'loadSavedAssemblyConfig', 'launchAssemblyConfig', 'deleteSavedAssemblyConfig',
    'launchSavedAssemblyRun', 'fwLaunchConfig', 'fwResumeRun', 'deleteAssemblySessionRecord',
    'loadAssemblySessionIntoDraft', 'stopAssemblySessionRuntime', 'chooseWorkspaceDirectory',
    'getSavedAssemblyConfigs',
  ],
};

/**
 * 仅 ESM import 消费的键：消费方全部直接 import 本模块，桥已注销。
 * 断言面 = 命名导出仍在（真实模块命名空间）+ window 侧缺席（无访问器）。
 */
const IMPORT_ONLY_KEYS = {
  'assembly-actions': ['applyWorkspaceBundle'],
  'assembly-data': ['normalizeWorkspaceStartupDraft', 'saveWorkspaceFormDraft'],
  'fw-config-panel': ['maybeWarnAssemblySessionDrift'],
};

/** 零消费 / 模块私有 helper：一律不得造桥（穷举已覆盖，这里给失败时更直白的诊断）。 */
const PRIVATE_KEYS = [
  // assembly-actions：唯一消费方已 import 或全仓零调用
  'saveWorkspaceForm', 'resetWorkspaceForm', 'saveCurrentAssemblyConfig',
  // fw-config-panel：只服务本模块 data-action 与内部调用
  'fwHandlePromptInput', 'fwHandlePromptKeydown', 'fwClickPickerItem',
  'fwSetPickerCategory', 'fwSetPickerSearch', 'updateFWPromptDraft', 'fwConfirmCreateAgent',
  // workspace-blocks：纯渲染 helper
  'getDirectorySummaryData', 'renderDirectorySummaryPanel', 'normalizeRepoUrl',
  'renderRepoLink', 'formatAssemblyFeatureToken', 'getFeatureCapabilityLabel',
  'getCompatibilityTagLabel', 'getAssemblyFeaturePackageToken',
];

// ── 最小 DOM ────────────────────────────────────────────────────────

function createElementStub(id = '') {
  const classes = new Set();
  return {
    id,
    innerHTML: '', textContent: '', value: '', hidden: false, className: '',
    style: {}, dataset: {}, children: [],
    scrollTop: 0, scrollHeight: 0, clientHeight: 0,
    classList: {
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      contains(name) { return classes.has(name); },
      toggle(name, force) {
        const next = force === undefined ? !classes.has(name) : Boolean(force);
        if (next) classes.add(name); else classes.delete(name);
        return next;
      },
    },
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    addEventListener() {}, removeEventListener() {},
    appendChild(child) { this.children.push(child); return child; },
    removeChild() {},
    insertAdjacentHTML() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    contains() { return false; },
    focus() {}, blur() {},
  };
}

/**
 * 按 id 稳定复用元素；`querySelector('.fw-feat-list')` 命中显式登记的列表元素
 * （fw-config-panel 的滚动保存/还原面）。
 */
function createDocumentStub(featureList = null) {
  const byId = new Map();
  return {
    byId,
    ensure(id) {
      if (!byId.has(id)) byId.set(id, createElementStub(id));
      return byId.get(id);
    },
    getElementById(id) { return byId.get(id) ?? null; },
    querySelector(selector) { return selector === '.fw-feat-list' ? featureList : null; },
    querySelectorAll() { return []; },
    createElement(tag) { return createElementStub(tag); },
    createTextNode(text) { return { textContent: text }; },
    addEventListener() {}, removeEventListener() {},
    createTreeWalker() { return { nextNode: () => null }; },
    body: createElementStub('body'),
    head: createElementStub('head'),
    documentElement: createElementStub('html'),
    activeElement: null,
    readyState: 'complete',
  };
}

// ── classic 相：真实 owner + 未装载 owner 的契约桩 ───────────────────

/** sidebar-render 的三个宿主工厂（工厂体引用 app-main 的会话级词法量）。 */
function installSidebarHostSeams(sandbox) {
  sandbox.createAgentSnapshotLoaderHost = () => ({
    state: {},
    detailIds: new Set(),
    now: () => 0,
    captureToken: () => null,
    isTokenCurrent: () => true,
    ownership: () => ({}),
    connected: async () => [],
    viewer: async () => ({ ok: false, json: async () => ({ agents: [] }) }),
    loadLayout: async () => {},
    loadProjects: async () => {},
    schedule: () => {},
    diagnostic() {},
    runtimeId: (agent) => agent?.id || '',
    agentRuntimeId: (agent) => agent?.id || '',
    logicalId: (agent) => agent?.id || '',
    mergeSessions: (previous) => previous,
    reconcileStops() {},
    pruneCallStates() {},
    renderList() {},
    renderPanel() {},
    refreshCalls() {},
    isRemote: () => false,
    fallback: () => null,
    loadDetail: async () => {},
    selectSurface() {},
    preferHome() {},
    resolveFocus: () => null,
    clickPrebuilt() {},
    loadData: async () => {},
    warn: (...args) => console.warn(...args),
    error: (...args) => console.error(...args),
    log: (...args) => console.log(...args),
  });
  sandbox.createAgentCallStatesHost = () => ({
    calling: new Map(),
    suspended: new Set(),
    interrupting: new Map(),
    finished: new Set(),
    agents: () => [],
    currentRuntimeId: () => null,
    runtimeId: () => '',
    remoteEntries: () => [],
    normalize: (value) => value,
    resolveCalling: () => false,
    isSuspended: () => false,
    markStarted() {},
    syncActionButton() {},
    isSseActive: () => false,
    isRemote: () => false,
    fetch: (...args) => globalThis.fetch(...args),
    now: () => 0,
    lastRefresh: () => 0,
    setLastRefresh() {},
    render() {},
    warn: (...args) => console.warn(...args),
    error: (...args) => console.error(...args),
  });
  sandbox.createP2BootstrapSidebarRenderHost = () => ({
    get lastAgentListRenderSignature() { return ''; },
    set lastAgentListRenderSignature(_value) {},
  });
}

/**
 * app-main 的切换宿主面（本批只消费其构造契约：runtime-switch-host 在模块顶层
 * spread 它，切换事务本身不在本文件被测路径）。
 */
function installRuntimeSwitchSeam(sandbox) {
  sandbox.createRuntimeSwitchHost = () => ({
    state: {},
    now: () => 0,
    warn: (...args) => console.warn(...args),
    setSurface() {},
    renderPanel() {},
    renderList() {},
    renderCurrentMainView() {},
    beginLoading() {},
    clearLoading() {},
    navigate() {},
  });
}

/** app-ui 的导航宿主面（workspace-surface-host 顶层 spread；本批不触发导航）。 */
function installWorkspaceSurfaceSeam(sandbox) {
  sandbox.createWorkspaceSurfaceHost = () => ({
    state: {},
    now: () => 0,
    warn: (...args) => console.warn(...args),
    renderPanel() {},
    renderList() {},
    renderCurrentMainView() {},
    saveScroll() {},
    applyPatch() {},
    setFollowLatest() {},
    resetSurface() {},
    beginNavigation() {},
    clearNavigation() {},
    beginLoading() {},
    clearLoading() {},
  });
}

/** classic 相装载：生产加载序里本文件可装载的 owner（不含 app-main / app-ui）。 */
function loadClassicOwners(sandbox) {
  sandbox.loadSource('public/src/modules/action-dispatcher.js');
  // i18n 已迁 ESM（P4）：t 桥键由 createFrontendSandbox 自动装载，见 test/helpers/install-i18n.js
  sandbox.loadSource('public/src/app-core.js');
  sandbox.loadSource('public/src/modules/markdown-bootstrap.js');
  sandbox.loadSource('public/src/modules/session-view-state.js');
  installSidebarHostSeams(sandbox);
  installRuntimeSwitchSeam(sandbox);
  installWorkspaceSurfaceSeam(sandbox);
  // ESM 图经 agent-data-loader → input-actions 触达 poll-coordinator-host，后者在
  // 模块求值期向 classic app-main 取轮询宿主工厂（生产里 app-main 是 classic 唯一
  // 实现，沙箱按同形契约给替身；本文件不驱动轮询）。
  sandbox.createPollCoordinatorHost = () => ({
    run: async () => {}, fastInterval: () => 1000, setTimeout: () => 0, clearTimeout: () => {},
  });
  // app-main 的当前 agent 查询（本文件只覆盖"无当前 agent"这一真实状态分支）
  sandbox.getCurrentAgentRecord = () => null;
  // app-ui 的渲染入口：记录调用次数，不模拟渲染
  sandbox.renderMainCalls = 0;
  sandbox.renderCurrentMainView = () => { sandbox.renderMainCalls += 1; };
}

// ── 用例上下文 ──────────────────────────────────────────────────────

const flushAsync = () => new Promise((resolve) => setImmediate(resolve));
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** 一个用例 = 一份 classic 沙箱 + 一张真实 ESM 图（结束检查计时器与噪音）。 */
async function withBatch10Case(options, fn) {
  const { documentStub, fetch: fetchImpl, globals = {}, classic } = options || {};
  const consoleErrors = [];
  const consoleWarns = [];
  const defaultFetch = async () => ({ ok: false, status: 0, json: async () => ({}) });
  return withP2EsmCase({
    globals: {
      // markdown-bootstrap 的装载期 vendor 依赖（真实库由 index.html 的 vendor
      // 脚本提供，测试不装载）：Renderer 构造与 setOptions 是它唯一的取面。
      marked: { Renderer: class { constructor() {} }, setOptions() {} },
      hljs: { getLanguage: () => null },
      document: documentStub || createDocumentStub(),
      fetch: fetchImpl || defaultFetch,
      console: {
        log: () => {},
        info: () => {},
        debug: () => {},
        warn: (...args) => { consoleWarns.push(args); },
        error: (...args) => { consoleErrors.push(args); },
      },
      ...globals,
    },
    classic: classic || loadClassicOwners,
  }, async (c) => {
    const result = await fn(c);
    assert.equal(c.timerCount(), 0, '用例结束不应残留计时器');
    assert.deepEqual(consoleErrors, [], '用例内不应出现非预期 console.error');
    assert.deepEqual(consoleWarns, [], '用例内不应出现非预期 console.warn');
    return result;
  });
}

/** 同图装载：入口（六模块求值 + 桥/动作注册）与六个模块命名空间。 */
async function loadBatch(c) {
  await c.load(ENTRY);
  const mods = {};
  for (const [domain, file] of Object.entries(MODULES)) mods[domain] = await c.load(file);
  return mods;
}

// ── 1. 入口与导出面 ────────────────────────────────────────────────

test('批次入口按注释顺序装载六个模块，导出面齐备', async () => {
  const entrySource = readFileSync(path.join(REPO, ENTRY), 'utf8');
  for (const file of [
    './feature-config.js',
    './p2-w2-10-workspace-docset.js',
    './workspace-blocks.js',
    './assembly-data.js',
    './fw-config-panel.js',
    './assembly-actions.js',
  ]) {
    assert.equal(entrySource.includes(`import '${file}';`), true, `入口缺少 ${file}`);
  }
  await withBatch10Case({}, async (c) => {
    const mods = await loadBatch(c);
    for (const [name, mod] of Object.entries(mods)) {
      assert.ok(Object.keys(mod).length > 0, `${name} 应导出命名成员`);
    }
    // 跨文件消费的接口面（导入契约）
    assert.equal(typeof mods['assembly-data'].getWorkspaceFormDraft, 'function');
    assert.equal(typeof mods['assembly-data'].getAssemblyEnvironmentState, 'function');
    assert.equal(typeof mods['workspace-blocks'].shouldRenderBlock, 'function');
    assert.equal(typeof mods['workspace-blocks'].parseWorkspaceListField, 'function');
    assert.equal(typeof mods['assembly-actions'].updateWorkspaceFormDraft, 'function');
    assert.equal(typeof mods['fw-config-panel'].requestFWFeatureCapabilities, 'function');
    assert.equal(typeof mods['feature-config'].renderFWFeatureSettings, 'function');
    assert.equal(typeof mods['workspace-docset'].renderProjectDocsetBlock, 'function');
  });
});

// ── 2. 原行为（搬代码不改行为）────────────────────────────────────

test('assembly-data：装配环境状态机与状态文案随语言实时读取', async () => {
  await withBatch10Case({}, async (c) => {
    const mods = await loadBatch(c);
    const i18n = await c.load(STATE_MODULES.i18n);
    const { getAssemblyEnvironmentState, getAssemblyEnvironmentStatusLabel, getAssemblyEnvironmentStatusTone } = mods['assembly-data'];

    const missing = getAssemblyEnvironmentState({});
    assert.equal(missing.status, 'missing-name');
    assert.equal(missing.needsConfiguration, true);

    const ready = getAssemblyEnvironmentState({
      assembly_name: 'demo-agent',
      env_created: '1',
      env_dir: '~/.agentdev/agent-dev/demo-agent',
      env_configured_name: 'demo-agent',
      env_status: 'ready',
      selected_features: '',
      env_configured_features: '',
    });
    assert.equal(ready.status, 'ready');
    assert.equal(ready.isReady, true);
    assert.equal(ready.directoryStale, false);

    const stale = getAssemblyEnvironmentState({
      assembly_name: 'renamed-agent',
      env_created: '1',
      env_dir: '~/.agentdev/agent-dev/demo-agent',
      env_configured_name: 'demo-agent',
      env_status: 'ready',
    });
    assert.equal(stale.status, 'stale');

    // 语言实时读取（同图的 i18n 状态 owner，不是 window 副本）
    i18n.setCurrentLanguage('zh');
    assert.equal(getAssemblyEnvironmentStatusLabel('ready'), '已配置');
    i18n.setCurrentLanguage('en');
    assert.equal(getAssemblyEnvironmentStatusLabel('ready'), 'Ready');
    assert.equal(getAssemblyEnvironmentStatusLabel('unknown-status'), 'Not Configured');
    assert.equal(getAssemblyEnvironmentStatusTone('error'), 'var(--error-color)');
    i18n.setCurrentLanguage('zh');
  });
});

test('workspace-blocks：block 可见性与列表字段解析保持原语义', async () => {
  await withBatch10Case({}, async (c) => {
    const mods = await loadBatch(c);
    const renderEntry = await c.load(STATE_MODULES.renderEntry);
    const { shouldRenderBlock, parseWorkspaceListField, serializeWorkspaceListField, getAssemblyStageLabel } = mods['workspace-blocks'];

    renderEntry.setCurrentWorkspaceTab('home');
    assert.equal(shouldRenderBlock({ visibility: 'home-default' }), true);
    assert.equal(shouldRenderBlock({ visibility: 'tab:home' }), true);
    assert.equal(shouldRenderBlock({ visibility: 'tab:history' }), false);
    assert.equal(shouldRenderBlock({ visibility: 'chat-header-only' }), false);
    assert.equal(shouldRenderBlock({}), true);

    renderEntry.setCurrentWorkspaceTab('block:extra');
    assert.equal(shouldRenderBlock({ visibility: 'focus', id: 'extra' }), true);
    assert.equal(shouldRenderBlock({ visibility: 'focus', id: 'other' }), false);
    renderEntry.setCurrentWorkspaceTab(null);

    assert.deepEqual(parseWorkspaceListField('a\nb, c ,,'), ['a', 'b', 'c']);
    assert.deepEqual(parseWorkspaceListField([' a ', '', 'b']), ['a', 'b']);
    assert.equal(serializeWorkspaceListField(['b', 'a', 'b', '']), 'b\na');
    assert.equal(getAssemblyStageLabel('capabilities'), '选择能力');
  });
});

test('feature-config：配置键别名归一与比较保持原语义', async () => {
  await withBatch10Case({}, async (c) => {
    const mods = await loadBatch(c);
    const { normalizeFeatureConfigMap, featureConfigKeyMatches, normalizeFeatureConfigEntry } = mods['feature-config'];
    const normalized = normalizeFeatureConfigMap({
      'shell-feature': { model: 'x', empty: undefined },
      '': { model: 'y' },
      'memory-feature': {},
    });
    assert.deepEqual(normalized, { 'shell-feature': { model: 'x' } });
    assert.equal(featureConfigKeyMatches('@agentdevjs/shell-feature', 'shell-feature'), true);
    assert.equal(featureConfigKeyMatches('shell', 'shell-feature'), true);
    assert.equal(featureConfigKeyMatches('memory', 'shell-feature'), false);
    assert.deepEqual(normalizeFeatureConfigEntry(null), {});
  });
});

// ── 3. strict 缺陷修复：feature 开关的滚动保存 / 还原 ────────────────

test('fw-config-panel：feature 开关保留列表滚动位置（原 featureScrollTop 未声明缺陷已修）', async () => {
  const featureListEl = createElementStub('.fw-feat-list');
  await withBatch10Case({ documentStub: createDocumentStub(featureListEl) }, async (c) => {
    const mods = await loadBatch(c);
    const { fwToggleFeature } = mods['fw-config-panel'];
    featureListEl.scrollTop = 240;

    // 无当前 agent（真实状态分支）→ 只走滚动保存/还原；strict 下不得再抛 ReferenceError
    await assert.doesNotReject(() => fwToggleFeature('assembly-form', 'shell-feature'),
      'strict 下不得再抛 ReferenceError');

    // 重渲染后按帧还原：模拟重建后的列表（新元素、初始 scrollTop=0）
    featureListEl.scrollTop = 0;
    await tick();
    await tick();
    assert.equal(featureListEl.scrollTop, 240);
  });
});

// ── 4. 异步过期：旧 key 的晚到响应不得覆盖新缓存 ────────────────────

test('fw-config-panel：能力缓存拒绝过期响应，仍按当前 key 复用缓存', async () => {
  const pending = new Map();
  await withBatch10Case({
    fetch: (url) => new Promise((resolve) => {
      const key = String(url).includes('agentId=agent-a') ? 'a' : 'b';
      pending.set(key, resolve);
    }),
  }, async (c) => {
    const mods = await loadBatch(c);
    const { requestFWFeatureCapabilities } = mods['fw-config-panel'];
    const agentA = { id: 'agent-a', workspace_data: {} };
    const agentB = { id: 'agent-b', workspace_data: {} };

    const requestA = requestFWFeatureCapabilities(agentA, { selected_features: '' });
    await flushAsync();
    const requestB = requestFWFeatureCapabilities(agentB, { selected_features: '' });
    await flushAsync();

    // 新 key 先返回：写入缓存并触发一次重绘
    pending.get('b')({ ok: true, json: async () => ({ marker: 'B' }) });
    await requestB;

    // 旧 key 后返回：只把载荷交还调用方，不覆盖缓存、不再触发重绘
    pending.get('a')({ ok: true, json: async () => ({ marker: 'A' }) });
    const staleResult = await requestA;
    assert.deepEqual(staleResult, { marker: 'A' });
    assert.equal(c.window.renderMainCalls, 1, '旧 key 的晚到响应不得再触发一次重绘');

    const cached = await requestFWFeatureCapabilities(agentB, { selected_features: '' });
    assert.deepEqual(cached, { marker: 'B' });
  });
});

// ── 5. 兼容面穷举：桥键与 classic 写方转发 ──────────────────────────

test('仍有 classic 消费方的键经桥暴露：注册全集与命名导出同址、不可枚举', async () => {
  await withBatch10Case({}, async (c) => {
    const domains = Object.keys(BRIDGE_SURFACE);
    const expectedAll = domains.flatMap((domain) => BRIDGE_SURFACE[domain].map((key) => `${domain}:${key}`));

    // 包裹 KernelState 的注册/认领，记录入口装载期的 (domain, key)
    const recordedKeys = [];
    const recordedClaims = [];
    const kernel = c.window.KernelState;
    const originalDefineKey = kernel.defineKey;
    const originalClaim = kernel.claim;
    kernel.defineKey = (domain, key, initialValue) => {
      recordedKeys.push(`${domain}:${key}`);
      return originalDefineKey.call(kernel, domain, key, initialValue);
    };
    kernel.claim = (domain, impl) => {
      recordedClaims.push(domain);
      return originalClaim.call(kernel, domain, impl);
    };
    try {
      await c.load(ENTRY);
    } finally {
      kernel.defineKey = originalDefineKey;
      kernel.claim = originalClaim;
    }

    // 1) 注册全集等值（本批域名过滤；依赖模块的注册不在其中）
    const batchKeys = recordedKeys.filter((entry) => domains.includes(entry.split(':')[0]));
    assert.deepEqual([...batchKeys].sort(), [...expectedAll].sort(), '桥键注册全集必须与声明清单等值');
    assert.equal(batchKeys.length, new Set(batchKeys).size, '同一桥键不得注册两次');

    // 1b) 仅 ESM import 消费的键不得再注册桥键（导入期就断言，避免被后面的同源断言掩盖）
    for (const [domain, keys] of Object.entries(IMPORT_ONLY_KEYS)) {
      for (const key of keys) {
        assert.equal(batchKeys.includes(`${domain}:${key}`), false,
          `${domain}:${key} 的消费方全部 import，不应再注册桥键`);
      }
    }

    // 2) 认领：每域恰好一次
    const claims = recordedClaims.filter((domain) => domains.includes(domain));
    assert.deepEqual([...claims].sort(), [...domains].sort());

    const mods = await loadBatch(c);
    for (const domain of domains) {
      for (const key of BRIDGE_SURFACE[domain]) {
        assert.equal(c.window[key], mods[domain][key], `${domain}:${key} 桥键应与命名导出同源`);
        assert.equal(Object.prototype.propertyIsEnumerable.call(c.window, key), false,
          `${key} 不应进入枚举面`);
        assert.equal(Object.keys(c.window).includes(key), false, `${key} 不应泄漏到 Object.keys`);
        const descriptor = Object.getOwnPropertyDescriptor(c.window, key);
        assert.equal(typeof descriptor?.get, 'function', `${key} 应有桥 getter`);
        assert.equal(typeof descriptor?.set, 'function', `${key} 应成对提供 setter`);
      }
    }

    // 2b) 仅 ESM import 消费的键：命名导出仍在真实命名空间，window 侧完全缺席
    for (const [domain, keys] of Object.entries(IMPORT_ONLY_KEYS)) {
      for (const key of keys) {
        assert.equal(typeof mods[domain][key], 'function',
          `${domain}:${key} 应仍是命名导出（消费方直接 import）`);
        assert.equal(Object.prototype.hasOwnProperty.call(c.window, key), false,
          `${key} 的桥已注销，window 上不得再有该键`);
        assert.equal(Object.getOwnPropertyDescriptor(c.window, key), undefined,
          `${key} 不应残留桥访问器`);
      }
    }

    // 3) 零消费 / 模块私有 helper 一律不造桥
    for (const key of PRIVATE_KEYS) {
      assert.equal(Object.prototype.hasOwnProperty.call(c.window, key), false, `${key} 不应出现在 window 上`);
    }
  });
});

test('claim 之后 classic 写方经 setter 转发进桥值，模块实现仍是唯一真相', async () => {
  await withBatch10Case({}, async (c) => {
    const mods = await loadBatch(c);
    const key = 'getAssemblyDisplayName';
    const original = c.window[key];
    const sentinel = () => 'sentinel';
    c.window[key] = sentinel;
    assert.equal(c.window[key], sentinel, 'claim 后的 setter 必须保留写值');
    // 模块内部调用走本地绑定（不再经 window），实现不被外部覆盖影响
    assert.equal(mods['assembly-data'].getAssemblyDisplayName({ assembly_name: 'demo' }), 'demo');
    c.window[key] = original;
    assert.equal(c.window[key], original);
  });
});

test('批内消费方改 import：classic 动作处理器只剩跨批依赖的 window 转调', async () => {
  await withBatch10Case({}, async (c) => {
    await c.load(ENTRY);
    // workspace-blocks 的表单/仓库动作仍注册（data-action 名不变，走真实分发器）
    const actions = c.window.ClawFW.actions;
    for (const name of [
      'wsBlocks.formDraft', 'wsBlocks.saveForm', 'wsBlocks.resetForm', 'wsBlocks.chooseDirectory',
      'wsBlocks.toggleSelection', 'wsBlocks.repoDetails', 'wsBlocks.repoFilter',
      'wsBlocks.repoSearch', 'wsBlocks.openFeatureUpload',
      'wsDocset.runAction', 'wsDocset.setPage', 'wsDocset.materialImport',
      'fw.confirmFeatureImport', 'fw.handleConfirm', 'featureConfig.commitValue',
    ]) {
      assert.equal(actions.has(name), true, `缺少动作处理器：${name}`);
    }
  });
  // debug 面板族依赖都是 ESM，全部本批 import，不再经 window 转调：
  //   - debug-summary-upload（setRepoSearchQuery / setRepoSourceFilter /
  //     openFeatureUploadDialog）；
  //   - debug-overview（openRepositoryPackageDetails / closeRepositoryPackageDetails，
  //     P2 项目/装配批随 debug-overview 的命名导出收敛；后者消费方已归零，
  //     debug-overview 的 defineKey 同步注销）。
  const blocksSource = readFileSync(path.join(REPO, 'public/src/modules/workspace-blocks.js'), 'utf8');
  for (const key of ['setRepoSearchQuery', 'setRepoSourceFilter', 'openFeatureUploadDialog',
    'openRepositoryPackageDetails', 'closeRepositoryPackageDetails']) {
    assert.equal(blocksSource.includes(`window.${key}`), false, `workspace-blocks 不应再经 window 转调 ${key}`);
  }
  assert.equal(
    /from '\.\/debug-overview\.js'/.test(blocksSource), true,
    'workspace-blocks 的 repo 详情动作应 import debug-overview 命名导出',
  );
  // 桥键注销钉钉子：debug-overview 不再为 closeRepositoryPackageDetails 建桥
  const overviewSource = readFileSync(path.join(REPO, 'public/src/modules/debug-overview.js'), 'utf8');
  assert.equal(
    overviewSource.includes("defineKey('debug-overview', 'closeRepositoryPackageDetails'"), false,
    'closeRepositoryPackageDetails 消费方已归零，不应再注册桥键',
  );
});

// ── 6. 同步首屏边界：workspace-docset 的 classic 唯一实现 ────────────

test('workspace-docset 保留 classic 首屏边界：只加载 app-core 即可执行 chrome 同步', async () => {
  const source = readFileSync(path.join(REPO, 'public/src/modules/workspace-docset.js'), 'utf8');
  assert.equal(/^export\s/m.test(source), false, 'workspace-docset.js 必须保持 classic（无 export）');
  assert.equal(source.includes('function updateProjectDocsetChrome('), true);

  // classic 相只装 app-core + workspace-docset：ESM 渲染实现缺席也不得抛错
  await withBatch10Case({
    classic: (sandbox) => {
      sandbox.loadSource('public/src/app-core.js');
      sandbox.loadSource('public/src/modules/workspace-docset.js');
    },
  }, async (c) => {
    assert.equal(typeof c.window.updateProjectDocsetChrome, 'function');
    // 首屏路径：agent 为 null（allAgents 尚未加载）时同步执行，不依赖任何 ESM
    c.read('updateProjectDocsetChrome(null)');
    assert.equal(c.read('currentProjectDocsetOpen'), false);
    assert.equal(c.read('currentProjectRequirementEdit'), null);
    // ESM 渲染实现尚未装载也不得抛错：docset 不存在时不会走 window.renderProjectDocsetContent
    assert.equal(c.read('typeof window.renderProjectDocsetContent'), 'undefined');
  });
});
