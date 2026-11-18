/**
 * P2 显式依赖收尾：template-engine 的模板映射重载与 debug-summary-upload 的
 * 详情刷新改走 `agent-loader-host.js` 具名 import（不再经 window 兼容桥）。
 *
 * 装载路线：classic 相用 `prepareClassicSandbox`（index.html 先行脚本序）提供
 * 真实宿主工厂与真实桥实现；ESM 相经 withP2EsmCase + `c.load` 真实 import，
 * 每个用例一张独立模块图。
 *
 * 钉住四件事：
 *   1. 生产入口 `kernel-entry` 整图可求值，且两条新的具名边
 *      （template-engine → agent-loader-host 的环内边、debug-summary-upload →
 *      agent-loader-host）不引入 TDZ；两模块各自作为「首个求值入口」同样成立。
 *   2. 模板重试的真实行为：FEATURE_TEMPLATE_MAP 未就绪 → 500ms 后经具名 import
 *      重载映射 → 递归第二跳命中真实模板模块 → 缓存写入 → 预热重建主视图。
 *   3. 上传成功后的详情刷新：1s 后失效 detail 缓存 → 真实 agent_detail 请求 →
 *      其后重渲主视图（`loadAgentDetail(focusedAgentId)` 的调用点）。
 *   4. 摘要成功后的刷新：`loadAgents()` 走完真实端点链（connected 快照 +
 *      /api/agents）并重渲侧栏列表。
 *
 * 两条行为用例都把窗口桥键换成**抛错哨兵**：只要实现退回 `window.*`，重试或
 * 详情刷新就会被打断、断言直接失败——这是「已迁消费方一律走 import」的抓力。
 *
 * 噪音纪律：console.warn / console.error 全部记录；只允许模板重试路径上一处
 * 已声明的「FEATURE_TEMPLATE_MAP 未就绪」warn，其余一律断言为空。端点按真实
 * 契约形状应答，未登记端点直接断言失败。
 *
 * 计时：不等待真实的 500ms / 1000ms。p2-esm-case 会把自己的 tracked 计时器装到
 * 沙箱与 globalThis 上（node:test 的 mock.timers 打不到那层闭包），所以用例在触发
 * 前把 setTimeout 换成可主动驱动的记录器，断言的是生产代码声明的延时值本身。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { marked } from 'marked';
import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { prepareClassicSandbox } from './p2-classic-hosts.js';

const KERNEL_ENTRY = 'public/src/modules/kernel-entry.js';
const TEMPLATE_ENGINE = 'public/src/modules/template-engine.js';
const DEBUG_SUMMARY = 'public/src/modules/debug-summary-upload.js';
const AGENT_LOADER_HOST = 'public/src/modules/agent-loader-host.js';
const AGENT_STORE = 'public/src/modules/agent-store-state.js';
const SESSION_VIEW_STORAGE = 'public/src/modules/session-view-storage.js';
const RENDER_ENTRY_STATE = 'public/src/modules/render-entry-state.js';

/** 装载期即发起的两个请求（真实契约，见 server/routes/feature-assets.js / agent-lifecycle.js）。 */
const DECLARATIONS_API = '/api/feature-ui/declarations';
const APP_INFO_API = '/protoclaw/app_info';
/**
 * 装载期请求集合（精确相等，多一个少一个都算红）。P4 批次把更多模块并入
 * kernel-entry 图后新增了三项，都是模块求值期的真实请求：
 *   - ui-prefs?agentId=home：debug-panel-host 拉 rail 面板偏好；
 *   - /sounds/voice-recording-*.mp3：voice-input 预载提示音（静态资产）。
 */
const LOAD_TIME_ENDPOINTS = [
  DECLARATIONS_API,
  APP_INFO_API,
  '/api/feature-ui/ui-prefs?agentId=home',
  '/sounds/voice-recording-start.mp3',
  '/sounds/voice-recording-stop.mp3',
];

/** 一份可真实加载的模板模块 URL（与 data: URL 同一实例，用于断言缓存命中）。 */
const WORKING_TEMPLATE_URL = 'data:text/javascript,export default { call: () => "ok", result: () => "ok" }';
const workingTemplate = await import(WORKING_TEMPLATE_URL);

/** 模板未就绪 warn（loadTemplate 的 retry 分支，生产原文）。 */
const TEMPLATE_NOT_READY_WARN = /not found in FEATURE_TEMPLATE_MAP, waiting/;

const jsonResponse = (payload) => ({ ok: true, status: 200, json: async () => payload });

/**
 * 最小 DOM：按 id 稳定复用元素，新建节点记录子节点并支持 className 选择器查询
 * （summary 弹窗 / toast / feature-upload 对话框都按这些真实调用取节点）。
 * 不是「空桩」：节点保留父子关系，查询走真实遍历，找不到就返回 null。
 */
function createDomStub() {
  const byId = new Map();

  function classMatches(el, selector) {
    if (!selector.startsWith('.')) return false;
    const classes = String(el.className || '').split(/\s+/).filter(Boolean);
    return selector.slice(1).split('.').every((name) => classes.includes(name));
  }

  function findDescendant(el, selector) {
    for (const child of el.children) {
      if (classMatches(child, selector)) return child;
      const nested = findDescendant(child, selector);
      if (nested) return nested;
    }
    return null;
  }

  function createElement(tag = 'div') {
    const el = {
      tagName: String(tag).toUpperCase(),
      id: '',
      className: '',
      innerHTML: '',
      textContent: '',
      value: '',
      type: '',
      title: '',
      disabled: false,
      hidden: false,
      files: null,
      style: {},
      dataset: {},
      children: [],
      parentNode: null,
      scrollTop: 0,
      scrollHeight: 0,
      clientHeight: 0,
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      setAttribute(name, value) { el[name] = value; },
      removeAttribute(name) { delete el[name]; },
      getAttribute() { return null; },
      addEventListener() {},
      removeEventListener() {},
      appendChild(child) { child.parentNode = el; el.children.push(child); return child; },
      insertBefore(child, reference) {
        child.parentNode = el;
        const index = el.children.indexOf(reference);
        el.children.splice(index < 0 ? el.children.length : index, 0, child);
        return child;
      },
      removeChild(child) {
        const index = el.children.indexOf(child);
        if (index >= 0) el.children.splice(index, 1);
        child.parentNode = null;
        return child;
      },
      remove() { if (el.parentNode) el.parentNode.removeChild(el); },
      querySelector(selector) { return findDescendant(el, selector); },
      querySelectorAll(selector) {
        const found = [];
        const walk = (node) => {
          for (const child of node.children) {
            if (classMatches(child, selector)) found.push(child);
            walk(child);
          }
        };
        walk(el);
        return found;
      },
      closest() { return null; },
      focus() {},
      click() {},
      getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0 }; },
    };
    return el;
  }

  const documentStub = {
    body: createElement('body'),
    head: createElement('head'),
    documentElement: createElement('html'),
    readyState: 'complete',
    // Document 的真实必备面：RailCustomize 在模块求值期用 document.contains 判断
    // 焦点元素归属；缺它会 TypeError。
    contains() { return false; },
    getElementById(id) {
      // rail-cust-overlay 是运行时才创建的元素（openModal 插入），命中它会让模块
      // 走进"空 overlay"的非法状态，这里按真实语义返回 null。
      if (id === 'rail-cust-overlay') return null;
      if (!byId.has(id)) {
        const el = createElement('div');
        el.id = id;
        byId.set(id, el);
      }
      return byId.get(id);
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    createElement,
    createTextNode(text) { return { textContent: String(text), parentNode: null }; },
    addEventListener() {},
    removeEventListener() {},
  };

  return { document: documentStub, byId };
}

class NoopObserver {
  observe() {}

  unobserve() {}

  disconnect() {}

  takeRecords() { return []; }
}

/**
 * 一个用例的 fixture：真实端点契约 + 噪音记录 + DOM + 渲染效果出口记录。
 * 端点未登记即进 `unexpectedEndpoints`，用例收尾断言为空。
 */
function createHarness() {
  const warnings = [];
  const errors = [];
  const endpoints = [];
  const unexpectedEndpoints = [];
  const dom = createDomStub();
  const renders = { mainView: [], agentList: [], featurePanel: [] };

  const agents = [{
    id: 'runtime-1', name: 'PH', source: 'prebuilt', runtime_session_id: 'runtime-1',
    connected: true, message_count: 2,
  }];

  const routes = [
    [DECLARATIONS_API, () => jsonResponse({ ok: true, declarations: [], warnings: [] })],
    // rail-customize 在模块求值期拉呈现偏好（拿不到会 warn 并沿用内存态）；这里按
    // 真实形状应答，让"装载期只有已登记请求、无非预期 warn"的断言保持精确。
    ['/api/feature-ui/ui-prefs', () => jsonResponse({ ok: true, prefs: {} })],
    // voice-input 预载提示音（静态资产，非 API）
    ['/sounds/', () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' })],
    [APP_INFO_API, () => jsonResponse({ ok: true, version: '0.0.0-p2-fixture', frameworkVersion: '0.0.0-p2-fixture' })],
    // /protoclaw/get_connected_agents（app-core invoke 的 HTTP 回退，返回数组）
    ['/protoclaw/get_connected_agents', () => jsonResponse(agents)],
    ['/api/agents', () => jsonResponse({ agents: [{ id: 'runtime-1', connected: true, messageCount: 2 }] })],
    ['/protoclaw/agent_detail', () => jsonResponse({ workspace_state: {}, name: 'PH' })],
    ['/protoclaw/session_summary', () => jsonResponse({ sessionTitle: 'Summary title', summaryText: 'Summary body' })],
    ['/protoclaw/feature_repository/upload', () => jsonResponse({ ok: true })],
    ['/api/templates/feature', () => jsonResponse({ 'retry-template': WORKING_TEMPLATE_URL })],
  ];

  const fetchStub = async (url) => {
    const target = String(url);
    endpoints.push(target);
    const route = routes.find(([prefix]) => target.startsWith(prefix));
    if (!route) {
      unexpectedEndpoints.push(target);
      return { ok: false, status: 404, json: async () => ({}) };
    }
    return route[1]();
  };

  return {
    warnings,
    errors,
    endpoints,
    unexpectedEndpoints,
    dom,
    renders,
    agents,
    options: {
      label: 'p2-template-summary-imports',
      classic: (sandbox) => {
        prepareClassicSandbox(sandbox);
        //（remote-connections 已迁 ESM：见 withHarness，模块相真实 import。）
        // 渲染效果出口：数据流保持真实，只记录生产渲染入口的调用（与
        // test/frontend-agent-snapshot-loader.test.js 同口径，不复制宿主契约）。
        // sidebar-render 迁 ESM（P4 T2）后 `renderAgentList` 不再是可替换的 classic
        // 全局：用真实渲染入口每次都会调用的顶栏 chrome 作为「重渲发生」的观测点
        // （与 p2-w2-6 / p2-w2-8 同一口径）。
        sandbox.updateCurrentAgentChrome = () => renders.agentList.push('renderAgentList');
        sandbox.renderFeaturePanel = () => renders.featurePanel.push('renderFeaturePanel');
        sandbox.renderCurrentMainView = () => renders.mainView.push('renderCurrentMainView');
      },
      globals: {
        fetch: fetchStub,
        document: dom.document,
        marked,
        performance,
        MutationObserver: NoopObserver,
        ResizeObserver: NoopObserver,
        IntersectionObserver: NoopObserver,
        console: {
          ...console,
          log() {},
          info() {},
          debug() {},
          warn: (...args) => warnings.push(args),
          error: (...args) => errors.push(args),
        },
      },
    },
  };
}

/**
 * 用例入口：远程连接域已迁 ESM（P4 T3）→ 每个 case 先真实 import 它，
 * 再跑用例体（生产里 sidebar-render 的宿主闭包与 debug-summary-upload 都读它的
 * isRemoteNamespaceAgentId 真实实现，不用桩）。
 */
function withHarness(harness, fn) {
  return withP2EsmCase(harness.options, async (c) => {
        // 刷新引擎（P4 T3 起是真实 ESM）：交互域在**装载期**取它的窄宿主
        // createThreadStoreHost，必须先于 thread-store-domain 进同一张图。
    await c.load('public/src/modules/thread-store.js');
    await c.load('public/src/modules/remote-connections.js');
    return fn(c);
  });
}

const settle = async (rounds = 12) => {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

/**
 * 把 case 内的 setTimeout 换成可主动驱动的记录器（沙箱与主 realm 同步替换，
 * classic 的 window.setTimeout 与 ESM 的裸 setTimeout 都落在同一记录器上）。
 */
function installTimerControl(c) {
  const timers = [];
  const setTimeoutStub = (callback, delay) => {
    const entry = { callback, ms: Number(delay) || 0, cleared: false, fired: false };
    timers.push(entry);
    return entry;
  };
  const clearTimeoutStub = (handle) => {
    if (handle && typeof handle === 'object') handle.cleared = true;
  };
  c.window.setTimeout = setTimeoutStub;
  c.window.clearTimeout = clearTimeoutStub;
  globalThis.setTimeout = setTimeoutStub;
  globalThis.clearTimeout = clearTimeoutStub;
  return timers;
}

/** 触发唯一一个指定延时的待发定时器（断言生产声明的延时值本身）。 */
async function fireDelay(timers, ms) {
  const pending = timers.filter((entry) => !entry.cleared && !entry.fired && entry.ms === ms);
  assert.equal(pending.length, 1, `应有一个待触发的 ${ms}ms 定时器`);
  pending[0].fired = true;
  pending[0].callback();
  await settle();
}

/** 用例收尾：非预期 warn / 任何 error / 未登记端点一律为空。 */
function assertNoUnexpectedNoise(harness, { allowedWarnings = [] } = {}) {
  const unexpectedWarnings = harness.warnings
    .filter((args) => !allowedWarnings.some((pattern) => pattern.test(String(args[0]))));
  assert.deepEqual(unexpectedWarnings, [], '不得产生非预期 console.warn');
  assert.deepEqual(harness.errors, [], '不得产生任何 console.error');
  assert.deepEqual(harness.unexpectedEndpoints, [], '不得命中未登记端点（契约形状必须按真实端点给出）');
}

// ── 1. 图与求值顺序 ─────────────────────────────────────────────────

test('生产入口整图求值：kernel-entry 下两条新具名边都可求值', async () => {
  const harness = createHarness();
  await withHarness(harness, async (c) => {
    const entry = await c.load(KERNEL_ENTRY);
    assert.deepEqual(Object.keys(entry), [], 'kernel-entry 是纯副作用入口');

    const engine = await c.load(TEMPLATE_ENGINE);
    const summary = await c.load(DEBUG_SUMMARY);
    const loaderHost = await c.load(AGENT_LOADER_HOST);

    // 两处改写依赖的绑定就是 agent-loader-host 的命名导出（同一 case 图同一实例）
    assert.equal(typeof loaderHost.loadFeatureTemplateMap, 'function');
    assert.equal(typeof loaderHost.loadAgentDetail, 'function');
    assert.equal(typeof engine.warmTemplatesInBackground, 'function');
    assert.equal(typeof summary.openSummaryPopup, 'function');
    assert.equal(typeof summary.openFeatureUploadDialog, 'function');

    // 装载期请求集合按真实契约应答，且恰好是已知的两个
    assert.deepEqual(
      [...new Set(harness.endpoints)].sort(),
      [...LOAD_TIME_ENDPOINTS].sort(),
      '装载期请求集合必须与登记清单精确一致（新增外部依赖要显式登记）',
    );
  });
  assertNoUnexpectedNoise(harness);
});

test('template-engine 作为首个入口先求值：与 agent-loader-host 的静态环闭合', async () => {
  const harness = createHarness();
  await withHarness(harness, async (c) => {
    const engine = await c.load(TEMPLATE_ENGINE);
    assert.equal(typeof engine.warmTemplatesInBackground, 'function');
    assert.equal(typeof engine.applyTemplate, 'function');
    // 环对端在另一侧先打开时同样已求值（同一 case 图）
    const loaderHost = await c.load(AGENT_LOADER_HOST);
    assert.equal(typeof loaderHost.loadFeatureTemplateMap, 'function');
    assert.equal(typeof loaderHost.loadAgentDetail, 'function');
  });
  assertNoUnexpectedNoise(harness);
});

test('debug-summary-upload 作为首个入口先求值：与 agent-loader-host 的静态边闭合', async () => {
  const harness = createHarness();
  await withHarness(harness, async (c) => {
    const summary = await c.load(DEBUG_SUMMARY);
    assert.equal(typeof summary.openSummaryPopup, 'function');
    assert.equal(typeof summary.setRepoSearchQuery, 'function');
    const loaderHost = await c.load(AGENT_LOADER_HOST);
    assert.equal(typeof loaderHost.loadAgentDetail, 'function');
  });
  assertNoUnexpectedNoise(harness);
});

// ── 2. 模板重试（loadFeatureTemplateMap 具名 import）──────────────────

test('模板重试：映射未就绪时经具名 import 重载并完成预热重建', async () => {
  const harness = createHarness();
  await withHarness(harness, async (c) => {
    const engine = await c.load(TEMPLATE_ENGINE);
    const storage = await c.load(SESSION_VIEW_STORAGE);
    const renderEntry = await c.load(RENDER_ENTRY_STATE);

    c.read("currentRuntimeAgentId = 'runtime-a'");
    storage.setCurrentMessages([{ role: 'tool', content: 'result' }]);
    renderEntry.setLastRenderedChatSig('rendered');
    // FEATURE_TEMPLATE_MAP 未就绪：真实桥键 setter → agent-loader-host 的 live binding
    c.window.FEATURE_TEMPLATE_MAP = {};
    // 窗口桥键换成抛错哨兵：实现退回 window.* 即打断重试
    c.window.loadFeatureTemplateMap = () => {
      throw new Error('模板重载必须走具名 import，不得经 window 桥');
    };

    const timers = installTimerControl(c);
    engine.warmTemplatesInBackground(['retry-template'], 'runtime-a');
    await settle();

    // 第一次尝试：映射里没有该模板 → 500ms 后重载
    assert.equal(timers.filter((entry) => entry.ms === 500).length, 1, '一次重试 = 一次 500ms 等待');
    await fireDelay(timers, 500);

    assert.ok(
      harness.endpoints.some((url) => url.startsWith('/api/templates/feature?agentId=runtime-a')),
      '重载经具名 import 打到真实的 feature 模板端点',
    );
    // 递归第二跳命中真实模板模块并写入缓存
    storage.setToolRenderConfigs({ probe: { render: { call: 'retry-template', result: 'retry-template' } } });
    const picked = engine.getToolRenderTemplate('probe');
    assert.equal(picked.call, workingTemplate.default.call);
    assert.equal(picked.result, workingTemplate.default.result);
    // 预热完成：清渲染去重签名并重渲主视图
    assert.deepEqual(harness.renders.mainView, ['renderCurrentMainView']);
    assert.equal(renderEntry._lastRenderedChatSig, '');
  });
  // 唯一允许的噪音是重试路径自己声明的「模板映射未就绪」warn
  assertNoUnexpectedNoise(harness, { allowedWarnings: [TEMPLATE_NOT_READY_WARN] });
  assert.equal(
    harness.warnings.filter((args) => TEMPLATE_NOT_READY_WARN.test(String(args[0]))).length,
    1,
    '未就绪 warn 恰好一次（后续递归已命中）',
  );
});

// ── 3. 上传成功后的详情刷新（loadAgentDetail 具名 import）──────────────

test('上传成功：1s 后经具名 import 重拉 agent_detail 并在其后重渲主视图', async () => {
  const harness = createHarness();
  await withHarness(harness, async (c) => {
    const store = await c.load(AGENT_STORE);
    const summary = await c.load(DEBUG_SUMMARY);
    store.setAllAgents([{ id: 'runtime-1', name: 'PH', source: 'prebuilt', runtime_session_id: 'runtime-1' }]);
    store.setFocusedAgentId('runtime-1');
    c.window.AgentLoaderHost.loadedAgentDetailIds.add('runtime-1');
    // 窗口桥键换成抛错哨兵：实现退回 window.* 即打断详情刷新
    c.window.loadAgentDetail = () => {
      throw new Error('详情刷新必须走具名 import，不得经 window 桥');
    };

    const timers = installTimerControl(c);
    summary.openFeatureUploadDialog();
    const dialog = harness.dom.byId.get('feature-upload-dialog');
    const input = harness.dom.byId.get('feature-upload-input');
    const status = harness.dom.byId.get('feature-upload-status');

    input.onchange({ target: { files: [{ name: 'bundle.tgz' }] } });
    assert.equal(status.textContent, '已选择: bundle.tgz');

    const submitted = c.window.ClawFW.actions.invoke('featureUpload.submit');
    assert.ok(submitted && typeof submitted.then === 'function', '分发器处理器返回提交 promise');
    await submitted;
    assert.equal(status.textContent, '上传成功!');

    await fireDelay(timers, 1000);
    assert.equal(dialog.style.display, 'none', '成功后延时关窗');
    assert.ok(
      harness.endpoints.some((url) => url.startsWith('/protoclaw/agent_detail?agentId=runtime-1')),
      'detail 缓存失效后经具名 import 重拉 agent_detail',
    );
    assert.equal(
      c.window.AgentLoaderHost.loadedAgentDetailIds.has('runtime-1'), true,
      '重拉完成后 detail 缓存恢复（证明失效分支真的执行过）',
    );
    assert.deepEqual(harness.renders.mainView, ['renderCurrentMainView'], '详情落地后重渲主视图');
  });
  assertNoUnexpectedNoise(harness);
});

// ── 4. 摘要成功后的刷新（loadAgents 真实端点链）───────────────────────

test('摘要成功：真实 loadAgents 端点链走完并重渲侧栏列表', async () => {
  const harness = createHarness();
  await withHarness(harness, async (c) => {
    const store = await c.load(AGENT_STORE);
    const summary = await c.load(DEBUG_SUMMARY);
    store.setAllAgents([{ id: 'runtime-1', name: 'PH', source: 'prebuilt', runtime_session_id: 'runtime-1' }]);
    store.setFocusedAgentId('runtime-1');

    summary.openSummaryPopup('runtime-1', 's1');
    await settle();

    const overlay = harness.dom.byId.get('summary-popup-overlay');
    assert.match(overlay.innerHTML, /Summary title/, '摘要成功后弹窗渲染真实响应内容');
    assert.ok(harness.endpoints.some((url) => url.startsWith('/protoclaw/session_summary?agentId=runtime-1')));
    // 摘要落地后触发列表刷新：connected 快照 + viewer 快照都按真实契约请求
    assert.ok(harness.endpoints.some((url) => url.startsWith('/protoclaw/get_connected_agents')));
    assert.ok(harness.endpoints.includes('/api/agents'));
    assert.deepEqual(harness.renders.agentList, ['renderAgentList'], '快照落地后重渲侧栏列表');
  });
  assertNoUnexpectedNoise(harness);
});
