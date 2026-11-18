/**
 * P2 第二波批次 11（调试总览与功能深面板）+ P4 T2 渲染层批次（debug-features-hooks 转 ESM）。
 *
 * 最终形态：
 *   - debug-features-hooks 已转 ESM：三个渲染入口是命名导出，仍有 classic
 *     消费方（app-ui 的 ClawPanels 注册闭包）的两个经 KernelState 桥键；
 *     Feature 详情选择器改为 import debug-overview 的命名导出，细节弹窗清理
 *     改为 import debug-panel-host 的实现（同批）。首屏渲染由 boot 在模块相触发，
 *     rail 按钮与该模块同相或更晚，不存在「按钮可点、模块未求值」的窗口。
 *   - debug-overview 保持 ESM（经 p2-w2-11 批次入口装载）：workspace / monitor
 *     面板注册元数据没有 `order`，rail 按钮被强制隐藏；入口只在面板打开或
 *     boot 之后的详情动作里触达。
 *
 * 钉什么：
 *   1. 边界：批次入口仍只装载 overview；debug-features-hooks 由 P4 入口装载
 *      （本文件走真实 import），源码含 export 且不再有 classic 副本。
 *   2. 接口面：features 三入口命名导出 + 两个桥键；overview 五键桥 + 一个已注销键。
 *   3. 桥语义：claim 后 classic 写方经 impl.set 转发，不反向改写 ESM 导出。
 *   4. 原行为：Structure / Monitor 渲染、Features 分组与 catalog join、反向钩子
 *      面板、详情弹窗页签复用与重建、技能阅读页真实 fetch 续体、tool / hook
 *      开关 IPC 与 300ms inspector 刷新节流、repo / feature 详情选择器。
 *
 * 装载路线（withP2EsmCase）：一个用例 = 一份 classic 沙箱 + 一张真实 ESM 图。
 * classic 相按真实加载序执行 action-dispatcher / app-core / session-view-state /
 * 右栏注册表；features 与 overview 都走真实 import，落到
 * 同一个 window 与同一个 KernelState。面板重绘经注册表里的假面板记账（真实
 * 编排实现 renderFeaturePanel）。
 *
 * 每个用例结束统一断言：无残留计时器、无非预期 console.warn / error。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { APP_CORE_DOMAIN, prepareEsmModules, SESSION_VIEW_DOMAIN } from './p2-classic-hosts.js';

const REPO = path.resolve(import.meta.dirname, '..');
const ENTRY = 'public/src/modules/p2-w2-11-debug-deep-bootstrap.js';
const OVERVIEW = 'public/src/modules/debug-overview.js';
const FEATURES = 'public/src/modules/debug-features-hooks.js';

const STATE_MODULES = {
  i18n: 'public/src/modules/i18n-environment-state.js',
  renderEntry: 'public/src/modules/render-entry-state.js',
  sessionView: 'public/src/modules/session-view-storage.js',
  orchestration: 'public/src/modules/orchestration-state.js',
  debugPanel: 'public/src/modules/p2-bootstrap-debug-panel.js',
  featureCatalog: 'public/src/modules/feature-catalog.js',
};

/** overview 的命名导出全集（六个选择器/面板入口）。 */
const OVERVIEW_EXPORT_KEYS = [
  'renderStructurePanel',
  'renderMonitorPanel',
  'openFeatureDetails',
  'closeFeatureDetails',
  'openRepositoryPackageDetails',
  'closeRepositoryPackageDetails',
];

/** overview 的兼容桥清单（穷举）：多注册/少注册都会让用例变红。 */
const OVERVIEW_BRIDGE_KEYS = [
  'renderStructurePanel',
  'renderMonitorPanel',
  'openFeatureDetails',
  'closeFeatureDetails',
  'openRepositoryPackageDetails',
];

/**
 * 桥已注销、只剩命名导出的键（classic 消费方归零）。
 * closeRepositoryPackageDetails：唯一消费方 workspace-blocks 的 repo 详情动作
 * 已改命名导出 import（P2 项目/装配批），故 debug-overview 不再注册桥键。
 */
const OVERVIEW_WITHDRAWN_KEYS = ['closeRepositoryPackageDetails'];

/** debug-features-hooks 的命名导出与其中经桥键服务 classic 消费方的两个入口。 */
const FEATURE_ENTRY_EXPORTS = [
  'renderFeaturesPanel',
  'renderReverseHooksPanel',
  'renderFeatureDetailOverlay',
];

/** 本批注册的 data-action（模板字符串是唯一消费面）。 */
const ACTIONS = [
  'debugOverview.selectLifecycle',
  'features.noop',
  'features.setFilter',
  'features.setCapFilter',
  'features.groupToggle',
  'features.rhGroupToggle',
  'features.openDetails',
  'features.setDetailTab',
  'features.openSkill',
  'features.retrySkill',
  'features.toggleSchema',
  'features.toggleTool',
  'features.toggleHook',
  'features.closeSkill',
  'features.closeDetails',
];

// ── 最小 DOM ────────────────────────────────────────────────────────

function createElementStub(id = '') {
  const classes = new Set();
  const attributes = {};
  return {
    id,
    innerHTML: '',
    textContent: '',
    value: '',
    hidden: false,
    disabled: false,
    checked: false,
    className: '',
    open: false,
    style: { setProperty() {} },
    dataset: {},
    children: [],
    clientHeight: 0,
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
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
    setAttribute(name, value) { attributes[name] = String(value); },
    getAttribute(name) { return attributes[name] ?? null; },
    hasAttribute(name) { return name in attributes; },
    removeAttribute(name) { delete attributes[name]; },
    addEventListener() {},
    removeEventListener() {},
    appendChild(child) { this.children.push(child); return child; },
    removeChild(child) { this.children = this.children.filter((item) => item !== child); },
    insertAdjacentHTML() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    contains() { return false; },
    focus() {},
    blur() {},
  };
}

function createDocumentStub() {
  const byId = new Map();
  return {
    byId,
    ensure(id) {
      if (!byId.has(id)) byId.set(id, createElementStub(id));
      return byId.get(id);
    },
    getElementById(id) {
      if (!byId.has(id)) byId.set(id, createElementStub(id));
      return byId.get(id);
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    createElement(tag) {
      const wrapper = {
        firstElementChild: createElementStub(tag),
        set innerHTML(value) { wrapper.firstElementChild.outerHTML = value; },
      };
      return wrapper;
    },
    createTextNode(text) { return { textContent: text, nodeType: 3, nodeValue: text }; },
    addEventListener() {},
    removeEventListener() {},
    createTreeWalker() { return { nextNode: () => null }; },
    body: createElementStub('body'),
    head: createElementStub('head'),
    documentElement: createElementStub('html'),
    activeElement: null,
    readyState: 'complete',
  };
}

/** 页签条节点替身：只实现复用路径真正用到的表面。 */
function createTabBar(featureName, { buttonCount = 3 } = {}) {
  const buttons = ['tools', 'skills', 'hooks'].slice(0, buttonCount).map(key => {
    const labelNode = { nodeType: 3, nodeValue: key };
    const countNode = { textContent: '0' };
    return {
      dataset: { featureDetailTab: key },
      childNodes: [labelNode],
      attributes: {},
      classList: { toggle() {} },
      querySelector(selector) { return selector === '.ph-tab-count' ? countNode : null; },
      setAttribute(name, value) { this.attributes[name] = String(value); },
      getAttribute(name) { return this.attributes[name] ?? null; },
    };
  });
  return {
    dataset: { featureDetailTabsFor: featureName },
    buttons,
    querySelectorAll(selector) {
      return selector === '[data-feature-detail-tab]' ? buttons : [];
    },
    setAttribute(name, value) { this.attributes = { ...(this.attributes || {}), [name]: String(value) }; },
  };
}

/**
 * Feature 详情 portal 替身：`existingTabBar` 模拟「上一次渲染留下的活页签条」，
 * `placeholder` 模拟整条替换时 portal 内的占位节点。
 */
function createPortal({ existingTabBar = null, placeholder = null } = {}) {
  const panel = { replacedBy: null, replaceWith(node) { this.replacedBy = node; } };
  const scroll = { scrollTop: 0 };
  const portal = createElementStub('feature-detail-portal');
  let html = '';
  let writes = 0;
  Object.defineProperty(portal, 'innerHTML', {
    get() { return html; },
    set(value) { html = value; writes += 1; },
  });
  portal.writes = () => writes;
  portal.querySelector = (selector) => {
    if (selector === '[role="tablist"][aria-label]') return existingTabBar;
    if (selector === '.feature-detail-tabs-placeholder') return placeholder;
    if (selector === '.settings-tab-content') return scroll;
    if (selector === '[role="tabpanel"]') return panel;
    return null;
  };
  portal.querySelectorAll = (selector) => (
    selector === '[data-feature-detail-tab]' && existingTabBar ? existingTabBar.buttons : []
  );
  return { portal, panel, scroll, placeholder, existingTabBar };
}

// ── 网络：默认静默成功（catalog / mounts / commands / 技能资源）────────

const CATALOG = {
  provenances: ['official', 'community'],
  types: [{ id: 'ability' }, { id: 'system', collapsed: true }],
  capabilities: ['tools', 'skills', 'policy', 'mcp', 'commands'],
  features: [
    {
      name: 'shell',
      displayName: { zh: '终端', en: 'Shell' },
      group: 'bundled',
      type: 'ability',
      provenance: 'official',
      capabilities: ['tools', 'policy'],
    },
    {
      name: 'memo-notes',
      displayName: { zh: '便签', en: 'Memo notes' },
      group: 'installed',
      type: 'system',
      provenance: 'community',
      capabilities: ['tools', 'skills'],
    },
  ],
};

const MOUNTS = { mounts: { main: { shell: {} }, coder: {} } };

function okJson(payload) {
  return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
}

function createFetchStub(overrides = {}) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url: String(url), options: options || null });
    if (overrides.handle) {
      const handled = await overrides.handle(String(url), options || null, { okJson, CATALOG, MOUNTS });
      if (handled) return handled;
    }
    if (String(url).startsWith('/api/feature-catalog')) return okJson(CATALOG);
    if (String(url).startsWith('/api/feature-store/overview')) return okJson(MOUNTS);
    if (String(url).startsWith('/protoclaw/commands')) return okJson({ ok: true, commands: [{ ref: 'shell.slash' }] });
    if (String(url).startsWith('/res/')) return { ok: true, status: 200, text: async () => overrides.skillBody ?? '# Skill body' };
    if (String(url).startsWith('/protoclaw/agent/tool_state')) return okJson({ ok: true });
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  };
  return { fetch: impl, calls };
}

// ── classic 相：真实 owner + 未装载 owner 的契约桩 ───────────────────

function loadClassicOwners(sandbox) {
  sandbox.loadSource('public/src/modules/action-dispatcher.js');
  // i18n 已迁 ESM（P4）：t 桥键由 createFrontendSandbox 自动装载，见 test/helpers/install-i18n.js
  prepareEsmModules(sandbox, APP_CORE_DOMAIN);
  prepareEsmModules(sandbox, SESSION_VIEW_DOMAIN);
  sandbox.loadSource('public/src/modules/right-panel-registry.js');
  // 插件宿主最小面（生产是 classic claw-host）：面板摘除 / 插件落定订阅只在
  // 存在时挂载，这里给可调用宿主并让 ClawPanels 有一张真注册表。
  sandbox.ClawHost = {
    panels: {
      map: new Map(),
      register(id, panel) { this.map.set(id, panel); },
      get(id) { return this.map.get(id) ?? null; },
      getAll() { return [...this.map.values()]; },
      getAvailable() { return [...this.map.values()]; },
      has(id) { return this.map.has(id); },
      unregister(id) { this.map.delete(id); },
    },
    setPanelTeardownHook() {},
    onPluginLoadSettled() {},
    getPluginLoadState() { return 'loaded'; },
    ensurePlugin() {},
  };
  // app-main 的当前 agent 查询（_runtimeSignals 的可选分支）
  sandbox.getCurrentAgentRecord = () => null;
  // app-ui 的渲染入口与身份查询：记录调用次数，不模拟渲染。
  sandbox.renderMainCalls = 0;
  sandbox.renderCurrentMainView = () => { sandbox.renderMainCalls += 1; };
  sandbox.getRuntimeAwareAgentRecord = () => ({ id: 'runtime-1', connected: true });
  sandbox.getRuntimeAwareAgentName = () => 'Demo Agent';
  // 面板重绘观测：hooks / inspector 面注册假面板，renderFeaturePanel（真实编排
  // 实现）每次渲染都经它记账——本批不把面板宿主的 DOM 效果纳入断言面。
  sandbox.panelRenderCalls = 0;
  for (const panelId of ['hooks', 'workspace', 'inspector']) {
    sandbox.ClawHost.panels.register(panelId, {
      id: panelId,
      render: () => { sandbox.panelRenderCalls += 1; return '<div class="panel-probe"></div>'; },
    });
  }
}

const flushAsync = () => new Promise((resolve) => setImmediate(resolve));

/** 等到真实异步续体落定（不使用真实 sleep；最多 100 个宏任务轮次）。 */
async function waitFor(predicate, label) {
  for (let i = 0; i < 100; i += 1) {
    if (predicate()) return;
    await flushAsync();
  }
  assert.fail(`等待异步续体超时：${label}`);
}

/** 一个用例 = 一份 classic 沙箱 + 一张真实 ESM 图（结束检查计时器与噪音）。 */
async function withDebugCase(options, fn) {
  const {
    documentStub,
    fetchStub,
    globals = {},
    classic = loadClassicOwners,
    allowConsole = {},
  } = options || {};
  const consoleErrors = [];
  const consoleWarns = [];
  const net = fetchStub || createFetchStub();
  const doc = documentStub || createDocumentStub();
  const allowed = (list, args) => list.some((pattern) => (
    pattern instanceof RegExp ? pattern.test(String(args[0])) : String(args[0]).includes(pattern)
  ));
  return withP2EsmCase({
    globals: {
      // markdown-utils 求值期的 vendor 依赖（真实库由 index.html 的 vendor
      // 脚本提供，测试不装载）：Renderer 构造、setOptions 与 renderMarkdown 的 parse。
      marked: {
        Renderer: class { constructor() {} },
        setOptions() {},
        parse: (source) => 'MD:' + source,
      },
      hljs: { getLanguage: () => null },
      document: doc,
      fetch: net.fetch,
      console: {
        log: () => {},
        info: () => {},
        debug: () => {},
        warn: (...args) => { consoleWarns.push(args); },
        error: (...args) => { consoleErrors.push(args); },
      },
      ...globals,
    },
    classic,
  }, async (c) => {
    c.net = net;
    c.doc = doc;
    const result = await fn(c);
    assert.equal(c.timerCount(), 0, '用例结束不应残留计时器');
    assert.deepEqual(
      consoleErrors.filter((args) => !allowed(allowConsole.error || [], args)),
      [],
      '用例内不应出现非预期 console.error',
    );
    assert.deepEqual(
      consoleWarns.filter((args) => !allowed(allowConsole.warn || [], args)),
      [],
      '用例内不应出现非预期 console.warn',
    );
    return result;
  });
}

/**
 * 本批次真实形态：ESM overview（经批次入口）+ ESM debug-features-hooks +
 * feature-catalog 命名空间（全部真实 import，同一沙箱 / 同一 KernelState）。
 */
async function loadBatch(c) {
  await c.load(ENTRY);
  const features = await c.load(FEATURES);
  return {
    overview: await c.load(OVERVIEW),
    features,
    featureCatalog: await c.load(STATE_MODULES.featureCatalog),
    i18n: await c.load(STATE_MODULES.i18n),
    renderEntry: await c.load(STATE_MODULES.renderEntry),
    sessionView: await c.load(STATE_MODULES.sessionView),
    orchestration: await c.load(STATE_MODULES.orchestration),
    debugPanel: (await c.load(STATE_MODULES.debugPanel)).debugPanel,
  };
}

function setInspector(sessionView, inspector) {
  sessionView.setCurrentHookInspector(inspector);
}

function baseFeature(extra = {}) {
  return {
    name: 'shell',
    tools: [],
    skills: [],
    hookCount: 0,
    toolCount: 0,
    enabledToolCount: 0,
    description: '',
    source: '/repo/features/shell/src/index.js',
    status: 'enabled',
    enabled: true,
    mapped: true,
    ...extra,
  };
}

// ── 1. 边界 / 导出面 / 桥面 / 动作面 ────────────────────────────────

test('批次边界：P2 批次入口只装载 overview，features 走 P4 入口（ESM）', async () => {
  const entrySource = readFileSync(path.join(REPO, ENTRY), 'utf8');
  assert.equal(entrySource.includes("import './debug-overview.js';"), true, '入口缺少 debug-overview');
  assert.doesNotMatch(entrySource, /^\s*import\s+['"][^'"]*debug-features-hooks\.js['"]/m,
    'P2 批次入口不装载 features（它随 P4 渲染层批次单独接线）');

  // features 已是原生 ESM：源码有命名导出，classic 副本不存在。
  const featuresSource = readFileSync(path.join(REPO, FEATURES), 'utf8');
  for (const name of FEATURE_ENTRY_EXPORTS) {
    assert.match(featuresSource, new RegExp('export function ' + name + '\\('), `缺少命名导出 ${name}`);
  }
  assert.doesNotMatch(featuresSource, /window\.(renderFeaturesPanel|renderReverseHooksPanel)\s*=/,
    '不得散装 window 赋值造桥（桥键统一经 KernelState.defineKey）');
});

test('导出面 / 互操作键 / 动作面齐备', async () => {
  await withDebugCase({}, async (c) => {
    const mods = await loadBatch(c);

    for (const name of OVERVIEW_EXPORT_KEYS) {
      assert.equal(typeof mods.overview[name], 'function', `debug-overview 应导出 ${name}`);
    }
    for (const name of FEATURE_ENTRY_EXPORTS) {
      assert.equal(typeof mods.features[name], 'function', `debug-features-hooks 应导出 ${name}`);
    }

    // overview 五键：KernelState 访问器（桥），classic 消费方经 window 读写。
    for (const key of OVERVIEW_BRIDGE_KEYS) {
      const descriptor = Object.getOwnPropertyDescriptor(c.window, key);
      assert.ok(descriptor && typeof descriptor.get === 'function', `${key} 应经 KernelState 访问器提供`);
      assert.equal(typeof descriptor.value, 'undefined', `${key} 不应是直接从 window 上的散装赋值`);
    }
    // 第六键桥已注销：导出仍在，window 面无访问器（也不允许散装赋值顶上）
    for (const key of OVERVIEW_WITHDRAWN_KEYS) {
      assert.equal(typeof mods.overview[key], 'function', `${key} 仍是命名导出`);
      assert.equal(Object.getOwnPropertyDescriptor(c.window, key), undefined, `${key} 的桥应已注销`);
    }
    // features：仍有 classic 消费方的两个渲染入口经桥键提供（同一实现），
    // 详情弹窗清理入口的唯一消费方是同批 debug-panel-host（import），不占窗口键。
    for (const key of ['renderFeaturesPanel', 'renderReverseHooksPanel']) {
      const descriptor = Object.getOwnPropertyDescriptor(c.window, key);
      assert.ok(descriptor && typeof descriptor.get === 'function', `${key} 应经 KernelState 访问器提供`);
      assert.equal(c.window[key], mods.features[key], `${key} 的窗口面与命名导出同一实现`);
    }
    assert.equal(Object.getOwnPropertyDescriptor(c.window, 'renderFeatureDetailOverlay'), undefined,
      'renderFeatureDetailOverlay 的消费方已改 import，不应留窗口键');

    // classic 消费面恢复：feature-catalog 命名空间仍在（features 面板经它 join）
    assert.equal(typeof c.window.ClawFW.featureCatalog?.resolveDisplayName, 'function');

    const actions = c.window.ClawFW.actions;
    for (const name of ACTIONS) {
      assert.equal(actions.has(name), true, `${name} 应已注册`);
    }
  });
});

// ── 2. R4 早期入口（模块求值前）─────────────────────────────────────

test('模块求值相：features 入口在求值后立即可用，classic 裸标识符解析到同一实现', async () => {
  await withDebugCase({}, async (c) => {
    // 只跑 classic 相：features 模块尚未 import，窗口上没有桥键（原早期入口
    // 窗口随「首屏渲染在模块相」的时序切换消失）。
    for (const key of ['renderFeaturesPanel', 'renderReverseHooksPanel']) {
      assert.equal(Object.getOwnPropertyDescriptor(c.window, key), undefined,
        `${key} 在模块求值前不应存在`);
    }

    const features = await c.load(FEATURES);
    for (const key of FEATURE_ENTRY_EXPORTS) {
      assert.equal(typeof features[key], 'function', `${key} 求值后必须可用（命名导出）`);
    }
    for (const key of ['renderFeaturesPanel', 'renderReverseHooksPanel']) {
      assert.equal(typeof c.window[key], 'function', `${key} 求值后经桥键可见`);
    }
    // hooks / inspector 的 render 入口：空 inspector 出空态，不抛错。
    const featuresHtml = c.window.renderFeaturesPanel();
    const hooksHtml = c.window.renderReverseHooksPanel();
    assert.match(featuresHtml, /feature-panel-empty/);
    assert.match(hooksHtml, /feature-panel-empty/);
    // 详情弹窗清理路径（debug-panel-host 在切换 / 关闭面板时调用）：改为 import 后
    // 直接调用模块导出，窗口上不留同名键。
    features.renderFeatureDetailOverlay(null);
  });
});

// ── 3. 桥语义 ──────────────────────────────────────────────────────

test('桥语义：claim 后 classic 写方经 impl.set 转发进域状态', async () => {
  await withDebugCase({}, async (c) => {
    const mods = await loadBatch(c);

    const replacedOverview = () => 'structure-replaced';
    c.window.renderStructurePanel = replacedOverview;
    assert.equal(c.window.renderStructurePanel, replacedOverview, 'claim 后 setter 应落回域状态');
    assert.equal(mods.overview.renderStructurePanel !== replacedOverview, true, '模块导出保持自身实现');

    const replacedFeatureDetails = () => 'feature-details-replaced';
    c.window.openFeatureDetails = replacedFeatureDetails;
    assert.equal(c.window.openFeatureDetails, replacedFeatureDetails);
  });
});

test('classic features 动作经 ESM 桥驱动详情选择器', async () => {
  await withDebugCase({}, async (c) => {
    const mods = await loadBatch(c);
    mods.renderEntry.setActiveFeaturePanel('hooks');
    setInspector(mods.sessionView, { lifecycleOrder: [], features: [baseFeature()], hooks: [] });

    c.window.ClawFW.actions.invoke('features.openDetails', {
      dataset: { featureName: 'shell' },
    });
    assert.equal(mods.debugPanel.selectedFeatureName, 'shell');
    assert.equal(c.window.panelRenderCalls, 1, '打开详情应触发一次面板重渲染');

    c.window.ClawFW.actions.invoke('features.closeDetails', {});
    assert.equal(mods.debugPanel.selectedFeatureName, null);
    assert.equal(c.window.panelRenderCalls, 2);
  });
});

// ── 4. Structure / Monitor 面板（搬代码不改行为）────────────────────

test('Structure 面板：生命周期 chips、文档与状态读取，选择器写 owner 并重渲染', async () => {
  await withDebugCase({}, async (c) => {
    const mods = await loadBatch(c);
    mods.i18n.setCurrentLanguage('zh');
    mods.orchestration.setCurrentRuntimeAgentId('runtime-1');
    mods.renderEntry.setActiveFeaturePanel('workspace');
    setInspector(mods.sessionView, {
      lifecycleOrder: ['AgentInitiate', 'StepFinish', 'ToolUse'],
      features: [
        { name: 'shell', status: 'enabled', enabled: true },
        { name: 'lsp', status: 'removed' },
      ],
      hooks: [
        { lifecycle: 'StepFinish', entries: [{ kind: 'guard' }, { kind: 'observe' }] },
        { lifecycle: 'ToolUse', entries: [{ kind: 'guard' }] },
      ],
      standaloneTools: [],
    });
    mods.sessionView.setCurrentMessages([{}, {}, {}]);
    mods.debugPanel.selectedOverviewLifecycle = 'StepFinish';

    const html = mods.overview.renderStructurePanel();
    assert.match(html, /class="hooks-panel"/);
    assert.match(html, /data-action="debugOverview\.selectLifecycle" data-lifecycle="AgentInitiate"/);
    assert.match(html, /data-lifecycle="StepFinish"[^>]*><strong>StepFinish<\/strong>/, '当前生命周期 chip 带 active 由 class 表达');
    assert.match(html, /<div class="hooks-stat-label">Hooks<\/div><div class="hooks-stat-value">3<\/div>/, '三个 hook 条目计入统计');
    assert.match(html, /<div class="hooks-stat-label">Decision<\/div><div class="hooks-stat-value">2<\/div>/, '两个 guard 决策点计数');
    assert.match(html, /hooks-section-title">StepFinish<\/div>/, '默认文档标题取当前生命周期');
    assert.match(html, /markdown-body/, '生命周期文档经 markdown 渲染');
    assert.match(html, /Demo Agent/);
    assert.match(html, /<span>[^<]*<\/span><span>3 [^<]*<\/span>/, '消息条数进入连接卡');

    // 选择器：写 classic owner（debugPanel）→ 面板处于 workspace 时重渲染
    c.window.ClawFW.actions.invoke('debugOverview.selectLifecycle', {
      dataset: { lifecycle: 'ToolUse' },
    });
    assert.equal(mods.debugPanel.selectedOverviewLifecycle, 'ToolUse');
    assert.equal(c.window.panelRenderCalls, 1, '选择生命周期应触发一次面板重渲染');

    const next = mods.overview.renderStructurePanel();
    assert.match(next, /hooks-section-title">ToolUse<\/div>/);
  });
});

test('Monitor 面板：用量卡、缓存环形与上下文 chip 随快照渲染', async () => {
  await withDebugCase({}, async (c) => {
    const mods = await loadBatch(c);
    mods.i18n.setCurrentLanguage('en');
    mods.sessionView.setCurrentOverviewSnapshot({
      usageStats: {
        totalUsage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500, cacheReadTokens: 300, cacheCreationTokens: 120 },
        calls: [
          { callIndex: 0, stepCount: 1, totalUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
          { callIndex: 1, stepCount: 2, totalUsage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 } },
        ],
        totalRequests: 5,
        totalCacheHitRequests: 3,
      },
      context: { messageCount: 4, charCount: 2048, turnCount: 2, toolCallCount: 6 },
    });

    const html = mods.overview.renderMonitorPanel();
    assert.match(html, /overview-usage-grid/);
    assert.match(html, /usage-bar-fill input/);
    assert.match(html, /rate-ring/);
    assert.match(html, /class="usage-card cache-card"/, 'cache 卡复用同一 usage-card 配方');
    assert.match(html, /60%/, '会话缓存命中率 = 3 / 5');
    assert.match(html, /2,048 chars/, '上下文长度按千分位格式化');
    assert.match(html, /context-chip-grid/);
    assert.match(html, /Demo Agent/);
  });
});

test('Monitor 面板：无快照时走 getEmptyOverviewSnapshot 空态', async () => {
  await withDebugCase({}, async (c) => {
    const mods = await loadBatch(c);
    mods.sessionView.setCurrentOverviewSnapshot(null);
    const html = mods.overview.renderMonitorPanel();
    assert.match(html, /overview-usage-grid/);
    assert.match(html, /还没有 LLM 请求/, '无调用时用量卡副标题走 metric_no_calls 文案');
  });
});

// ── 5. Features / 反向钩子面板（classic 唯一实现）────────────────────

test('Features 面板：catalog join（来源分页器 / 能力下拉 / 分组 / displayName）', async () => {
  await withDebugCase({}, async (c) => {
    const mods = await loadBatch(c);
    mods.i18n.setCurrentLanguage('zh');
    mods.renderEntry.setActiveFeaturePanel('hooks');
    setInspector(mods.sessionView, {
      lifecycleOrder: ['StepFinish'],
      features: [
        { name: 'shell', status: 'enabled', enabled: true, hookCount: 1, toolCount: 2, enabledToolCount: 1, skillCount: 0, description: '', source: '/repo/features/shell/src/index.js', tools: [] },
        { name: 'memo-notes', status: 'enabled', enabled: true, hookCount: 0, toolCount: 1, enabledToolCount: 1, skillCount: 2, description: '', source: '/repo/features/memo-notes/src/index.js', tools: [] },
      ],
      hooks: [],
      standaloneTools: [{ name: 'clock', state: 'enabled', description: 'time', source: 'time-awareness' }],
    });

    const html = mods.features.renderFeaturesPanel();
    // catalog 与 $mount 装配事实是异步拉取：先落定再用第二帧断言 join 结果
    await flushAsync();
    await flushAsync();
    const joined = mods.features.renderFeaturesPanel();

    assert.match(html, /feature-panel-empty|feature-src-seg/, '首帧即可渲染分组壳');
    assert.match(joined, /feature-src-seg/, '来源分页器');
    assert.match(joined, /data-action="features.setFilter" data-filter="installed"/);
    assert.match(joined, /data-action="features.setCapFilter"/, 'catalog 就绪后渲染能力下拉');
    assert.match(joined, /feature-group-title/, '两个分组出现组头');
    assert.match(joined, /终端/, 'displayName 按语言取 catalog 词条');
    assert.match(joined, /standalone_tools_title|clock/, '独立工具区沿用原渲染');
    assert.match(joined, /feature-card-name">shell|feature-card-name">终端/);
  });
});

test('Features 面板：空 inspector 走空态卡，不发 catalog 请求', async () => {
  await withDebugCase({}, async (c) => {
    const mods = await loadBatch(c);
    setInspector(mods.sessionView, { lifecycleOrder: [], features: [], hooks: [] });
    const html = mods.features.renderFeaturesPanel();
    assert.match(html, /feature-panel-empty/);
    assert.equal(c.net.calls.length, 0, '空 inspector 不应触发 catalog / mounts 拉取');
  });
});

test('反向钩子面板：分组卡默认展开态、条目元信息与开关', async () => {
  await withDebugCase({}, async (c) => {
    const mods = await loadBatch(c);
    mods.i18n.setCurrentLanguage('en');
    setInspector(mods.sessionView, {
      lifecycleOrder: ['CallStart', 'StepFinish'],
      features: [],
      hooks: [
        {
          lifecycle: 'CallStart',
          entries: [{
            featureName: 'shell',
            methodName: 'registerPendingWorkOnCallStart',
            kind: 'observe',
            enabled: true,
            description: 'register pending work',
            source: { display: '/repo/features/shell/src/hooks.ts' },
          }],
        },
        { lifecycle: 'StepFinish', entries: [] },
      ],
    });

    const html = mods.features.renderReverseHooksPanel();
    assert.match(html, /class="rh-list"/);
    assert.equal((html.match(/class="rh-group/g) || []).length, 2);
    assert.match(html, /class="rh-group[^"]*" open/, '有挂载的分组默认展开');
    assert.match(html, /class="rh-group is-empty"/, '零挂载分组标记 is-empty');
    assert.match(html, /rh-method/);
    assert.match(html, /registerPendingWorkOnCallStart\(\)/);
    assert.match(html, /data-action="features\.toggleHook" data-lifecycle="CallStart"/);
    assert.match(html, /观察?\s*·|observe/, 'kind 文案按语言解析');
  });
});

// ── 6. Feature 详情弹窗 / 页签 / 技能阅读页 ─────────────────────────

test('详情弹窗：同 Feature 轮询重绘复用活页签条，跨 Feature 整条重建', async () => {
  const sameBar = createTabBar('shell');
  const portalHarness = createPortal({
    existingTabBar: sameBar,
    placeholder: { replacedWith: null, replaceWith(node) { this.replacedWith = node; } },
  });
  const documentStub = createDocumentStub();
  documentStub.byId.set('feature-detail-portal', portalHarness.portal);

  await withDebugCase({ documentStub }, async (c) => {
    const mods = await loadBatch(c);
    mods.debugPanel.selectedFeatureName = 'shell';

    mods.features.renderFeatureDetailOverlay(baseFeature({
      tools: [{ name: 'run', state: 'enabled', enabled: true }],
      skills: [{ name: 'guide', description: 'Help', root: 0, path: 'skills/guide/SKILL.md' }],
    }));
    assert.equal(portalHarness.placeholder.replacedWith, sameBar, '同 Feature 复用活页签条');
    assert.equal(sameBar.buttons[0].querySelector('.ph-tab-count').textContent, '1', '复用路径同步计数');

    // 跨 Feature：旧页签条不得复用（动作参数绑定 featureName）
    const crossPortal = createPortal({
      existingTabBar: createTabBar('previous-feature'),
      placeholder: { replacedWith: null, replaceWith(node) { this.replacedWith = node; } },
    });
    c.doc.byId.set('feature-detail-portal', crossPortal.portal);
    mods.features.renderFeatureDetailOverlay(baseFeature({ name: 'next-feature' }));
    assert.notEqual(crossPortal.placeholder.replacedWith, crossPortal.portal.querySelector('[role="tablist"][aria-label]'));
    assert.match(crossPortal.placeholder.replacedWith.outerHTML, /data-feature-detail-tabs-for="next-feature"/);
    assert.match(crossPortal.placeholder.replacedWith.outerHTML, /data-tab-key="skills" data-feature-name="next-feature"/);
  });
});

test('详情弹窗：页签原地切换内容而不重建 portal，离开技能分页退出阅读页', async () => {
  const portalHarness = createPortal();
  const documentStub = createDocumentStub();
  documentStub.byId.set('feature-detail-portal', portalHarness.portal);

  await withDebugCase({ documentStub }, async (c) => {
    const mods = await loadBatch(c);
    const feature = baseFeature({
      skills: [{ name: 'guide', description: 'Guide', root: 0, path: 'skills/guide/SKILL.md' }],
    });
    mods.debugPanel.selectedFeatureName = 'shell';
    mods.renderEntry.setActiveFeaturePanel('hooks');
    mods.orchestration.setCurrentRuntimeAgentId('runtime-1');
    mods.sessionView.setCurrentHookInspector({
      lifecycleOrder: ['StepFinish'],
      features: [feature],
      hooks: [{ lifecycle: 'StepFinish', entries: [{ featureName: 'shell', methodName: 'decide', kind: 'guard', enabled: true }] }],
    });

    mods.features.renderFeatureDetailOverlay(feature);
    const writesAfterRender = portalHarness.portal.writes();

    c.window.ClawFW.actions.invoke('features.setDetailTab', {
      dataset: { tabKey: 'skills', featureName: 'shell' },
    });
    assert.equal(portalHarness.portal.writes(), writesAfterRender, '页签切换不得重建 portal');
    assert.match(portalHarness.panel.replacedBy.outerHTML, /feature-skill-list/);

    c.window.ClawFW.actions.invoke('features.setDetailTab', {
      dataset: { tabKey: 'hooks', featureName: 'shell' },
    });
    assert.match(portalHarness.panel.replacedBy.outerHTML, /feature-hook-item/);
    assert.match(portalHarness.panel.replacedBy.outerHTML, /feature-hook-lifecycle/);

    // 进入阅读页后切走再切回：内容回到列表而不是上一份文档
    c.window.ClawFW.actions.invoke('features.setDetailTab', {
      dataset: { tabKey: 'skills', featureName: 'shell' },
    });
    c.window.ClawFW.actions.invoke('features.openSkill', {
      dataset: { featureName: 'shell', skillName: 'guide' },
    });
    assert.match(portalHarness.portal.innerHTML, /feature-skill-reader/);
    await waitFor(() => /MD:# Skill body/.test(portalHarness.portal.innerHTML), '技能正文渲染');
    c.window.ClawFW.actions.invoke('features.setDetailTab', {
      dataset: { tabKey: 'tools', featureName: 'shell' },
    });
    c.window.ClawFW.actions.invoke('features.setDetailTab', {
      dataset: { tabKey: 'skills', featureName: 'shell' },
    });
    assert.match(portalHarness.panel.replacedBy.outerHTML, /feature-skill-list/);
    assert.doesNotMatch(portalHarness.panel.replacedBy.outerHTML, /feature-skill-reader/);
  });
});

test('技能阅读页：真实 fetch 续体按缓存渲染正文，失败态给重试按钮', async () => {
  const portalHarness = createPortal();
  const documentStub = createDocumentStub();
  documentStub.byId.set('feature-detail-portal', portalHarness.portal);
  let skillFails = false;
  const net = createFetchStub({
    skillBody: '# Guide body',
    handle: async (url) => {
      if (!url.startsWith('/res/')) return null;
      if (skillFails) return { ok: false, status: 500, text: async () => '' };
      return { ok: true, status: 200, text: async () => '# Guide body' };
    },
  });

  await withDebugCase({ documentStub, fetchStub: net }, async (c) => {
    const mods = await loadBatch(c);
    mods.orchestration.setCurrentRuntimeAgentId('runtime-1');
    mods.renderEntry.setActiveFeaturePanel('hooks');
    mods.debugPanel.selectedFeatureName = 'shell';
    const feature = baseFeature({
      skills: [{ name: 'guide', description: 'Guide', root: 0, path: 'skills/guide/SKILL.md' }],
    });
    mods.sessionView.setCurrentHookInspector({ lifecycleOrder: [], features: [feature], hooks: [] });

    c.window.ClawFW.actions.invoke('features.setDetailTab', {
      dataset: { tabKey: 'skills', featureName: 'shell' },
    });
    c.window.ClawFW.actions.invoke('features.openSkill', {
      dataset: { featureName: 'shell', skillName: 'guide' },
    });
    assert.match(portalHarness.portal.innerHTML, /feature-skill-reader/, '阅读页替换列表');
    assert.match(portalHarness.portal.innerHTML, /gen-ui-spinner/, '正文未就位时空态卡显示加载态');
    await waitFor(() => /MD:# Guide body/.test(portalHarness.portal.innerHTML), '技能正文渲染');
    assert.match(portalHarness.portal.innerHTML, /MD:# Guide body/, 'fetched 正文经 markdown 渲染进阅读页');

    // 失败态：500 视为可重试，卡内给 retry 动作
    skillFails = true;
    c.window.ClawFW.actions.invoke('features.retrySkill', {
      dataset: { featureName: 'shell', skillName: 'guide' },
    });
    assert.match(portalHarness.portal.innerHTML, /gen-ui-spinner/, '重试后回到加载态');
    await waitFor(() => /feature-detail-empty-actions/.test(portalHarness.portal.innerHTML), '技能失败态');
    assert.match(portalHarness.portal.innerHTML, /feature-detail-empty-actions/);
    assert.match(portalHarness.portal.innerHTML, /data-action="features.retrySkill"/);
    await flushAsync();
    await flushAsync();
  });
});

// ── 7. 开关 IPC 与 poll 刷新节流（classic 唯一实现）─────────────────

test('tool / hook 开关：IPC 请求体与 _scheduleInspectorRefresh 节流时延保持原语义', async () => {
  const refreshCalls = [];
  const net = createFetchStub();
  await withDebugCase({ fetchStub: net }, async (c) => {
    const mods = await loadBatch(c);
    mods.orchestration.setCurrentRuntimeAgentId('runtime-1');
    // _scheduleInspectorRefresh 是 app-main 的 classic 顶层赋值（本批不新增
    // ready/等待/补画）：这里按真实形态挂在 window 上，记录时延。
    c.window._scheduleInspectorRefresh = (delay) => { refreshCalls.push(delay); };

    const toolToggle = createElementStub('tool-toggle');
    toolToggle.dataset = { scope: 'tool', name: 'run_shell_command' };
    toolToggle.checked = true; // checked → enable
    await c.window.ClawFW.actions.invoke('features.toggleTool', toolToggle);

    const toolCall = net.calls.find((call) => call.url.startsWith('/protoclaw/agent/tool_state'));
    assert.ok(toolCall, 'tool 开关应发起 IPC 请求');
    assert.equal(toolCall.options.method, 'POST');
    const body = JSON.parse(toolCall.options.body);
    assert.equal(body.scope, 'tool');
    assert.equal(body.name, 'run_shell_command');
    assert.equal(body.action, 'enable');
    assert.equal(body.runtimeId, 'runtime-1');

    const hookToggle = createElementStub('hook-toggle');
    hookToggle.dataset = { lifecycle: 'StepFinish', featureName: 'shell', methodName: 'decide' };
    hookToggle.checked = false; // unchecked → disable
    await c.window.ClawFW.actions.invoke('features.toggleHook', hookToggle);

    const hookCall = net.calls.filter((call) => call.url.startsWith('/protoclaw/agent/tool_state')).at(-1);
    const hookBody = JSON.parse(hookCall.options.body);
    assert.equal(hookBody.scope, 'hook');
    assert.equal(hookBody.lifecycle, 'StepFinish');
    assert.equal(hookBody.featureName, 'shell');
    assert.equal(hookBody.methodName, 'decide');
    assert.equal(hookBody.action, 'disable');

    assert.deepEqual(refreshCalls, [300, 300], '两次开关各触发一次 300ms 节流的 inspector 刷新');
  });
});

test('开关失败：请求非 2xx 时回滚 checkbox 并保留已有错误出口', async () => {
  const net = createFetchStub({
    handle: async (url) => (
      url.startsWith('/protoclaw/agent/tool_state')
        ? { ok: false, status: 500, json: async () => ({}), text: async () => '' }
        : null
    ),
  });
  await withDebugCase({
    fetchStub: net,
    allowConsole: { warn: [/\[toggleToolState\]/] },
  }, async (c) => {
    const mods = await loadBatch(c);
    mods.orchestration.setCurrentRuntimeAgentId('runtime-1');
    const checkbox = createElementStub('tool-toggle');
    checkbox.dataset = { scope: 'tool', name: 'run_shell_command' };
    checkbox.checked = true;

    await c.window.ClawFW.actions.invoke('features.toggleTool', checkbox);
    assert.equal(checkbox.checked, false, '失败时回滚 checkbox 到动作前状态');
  });
});

// ── 8. 仓库详情 / Feature 详情选择器（overview ESM + 桥）───────────

test('仓库包详情选择器：写 owner、重渲染主视图；open 走桥、close 只剩命名导出', async () => {
  await withDebugCase({}, async (c) => {
    const mods = await loadBatch(c);
    assert.equal(c.window.openRepositoryPackageDetails, mods.overview.openRepositoryPackageDetails);
    // close 的桥已注销（消费方 workspace-blocks 改 import）；classic app-ui 仍读 open，桥保留
    assert.equal(Object.getOwnPropertyDescriptor(c.window, 'closeRepositoryPackageDetails'), undefined);
    assert.equal(typeof mods.overview.closeRepositoryPackageDetails, 'function');

    mods.overview.openRepositoryPackageDetails('pkg-42');
    assert.equal(mods.debugPanel.selectedRepositoryPackageId, 'pkg-42');
    assert.equal(c.window.renderMainCalls, 1);

    mods.overview.closeRepositoryPackageDetails();
    assert.equal(mods.debugPanel.selectedRepositoryPackageId, null);
    assert.equal(c.window.renderMainCalls, 2);
  });
});

test('Feature 详情选择器：open/close 写 owner，面板在 hooks 时重渲染', async () => {
  await withDebugCase({}, async (c) => {
    const mods = await loadBatch(c);
    mods.renderEntry.setActiveFeaturePanel('hooks');
    setInspector(mods.sessionView, { lifecycleOrder: [], features: [baseFeature()], hooks: [] });

    mods.overview.openFeatureDetails('shell');
    assert.equal(mods.debugPanel.selectedFeatureName, 'shell');
    assert.equal(c.window.panelRenderCalls, 1);

    mods.overview.closeFeatureDetails();
    assert.equal(mods.debugPanel.selectedFeatureName, null);
    assert.equal(c.window.panelRenderCalls, 2);

    // 面板不在 hooks 面时不触发重渲染（原语义）
    mods.renderEntry.setActiveFeaturePanel('workspace');
    mods.overview.openFeatureDetails('shell');
    assert.equal(c.window.panelRenderCalls, 2);
  });
});
