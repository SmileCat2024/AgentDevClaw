/**
 * P2 第二波 5（调试面板族，撤桥后最终形态）—— 真实行为与命名导出面。
 *
 * 最终形态（审核后的边界；调试面板族各文件的归属由其自身批次头注定案）：
 *   - debug-logs / debug-mcp / debug-preflight / debug-features-hooks 保持
 *     **classic 唯一完整同步实现**：首屏 rail 按钮在 deferred 模块执行前就已建立
 *     且可点击，panel.render / onOpen 必须同步可用（保住 renderFeatureDetailOverlay
 *     等 classic 消费面）。它们的行为由既有 classic vm 测试
 *     （frontend-feature-detail-tabs / p2-bootstrap-preflight-publish 等）覆盖，
 *     本文件不重复、不当 ESM 装载。
 *   - debug-overview 已由 W2-11 批次转为 ESM：它名下的 workspace / monitor 面板
 *     没有 `order`，rail 按钮被 rail-customize 强制隐藏，入口只在面板打开或 boot
 *     之后的详情动作里触达（该批批次入口 p2-w2-11-debug-deep-bootstrap）。
 *   - debug-summary-upload 是本文件装载的唯一 ESM 模块：四个入口只由 boot 之后的
 *     工作空间操作/面板动作触发（open_summary / generate_summary 工作空间动作、
 *     Feature 仓库 block 的 data-action），classic 相无触达点。
 *
 * 装载路线（**单实例** KernelState）：classic 相用真实 `prepareClassicSandbox`
 * （index.html 的先行脚本序，boot 体与周期排程中和），再补 index.html 后段的
 * classic 生产脚本（thread-store）；ESM 侧经 withP2EsmCase + `c.load` 真实
 * import（含已迁 ESM 的 remote-connections），与 classic 相共用同一沙箱
 * （= window）与同一 KernelState，
 * debugPanel 是 app-core 的真实 host 工厂，宿主工厂就是生产实现本身——不手写
 * 空工厂大袋。
 *
 * 钉住四件事：
 *   1. 接口面与注销面：debug-summary-upload 的四个入口都是命名导出，动作注册不变；
 *      两个曾服务 classic 消费方的窗口键（openSummaryPopup /
 *      openFeatureUploadDialog）已注销，零消费的 setRepoSearchQuery /
 *      setRepoSourceFilter 本就不上桥——四个名字在 window 上都不留同名键。
 *   2. 状态所有权（撤桥后契约）：classic 侧对同名 window 属性的写入不再转发进
 *      模块，行为只由命名导出驱动。
 *   3. 原行为：repo 过滤写回 classic owner + 关闭表面动画 + 重渲主视图；
 *      上传入口的非 tgz / 合法文件 / 成功 / 失败四条真实路径。
 *   4. 异步过期：同一会话的旧 summary 响应不得覆盖新请求的渲染结果。
 *
 * 噪音纪律：console.warn / console.error 全部记录并断言为空；端点按真实契约形状
 * 应答，未登记端点直接断言失败。计时用可主动驱动的记录器，断言生产声明的延时值
 * 本身（不等待真实 1000ms）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { marked } from 'marked';
import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { prepareClassicSandbox } from './p2-classic-hosts.js';

const DEBUG_SUMMARY = 'public/src/modules/debug-summary-upload.js';
const DEBUG_PANEL = 'public/src/modules/p2-bootstrap-debug-panel.js';
const RENDER_ENTRY_STATE = 'public/src/modules/render-entry-state.js';
const AGENT_STORE = 'public/src/modules/agent-store-state.js';

/** 模块的四个跨文件入口（命名导出；window 上不留同名键）。 */
const ENTRY_EXPORTS = [
  'openSummaryPopup', 'setRepoSearchQuery', 'setRepoSourceFilter', 'openFeatureUploadDialog',
];
/** 模块装载期注册的动作处理器（data-action 名不变，走真实分发器）。 */
const REGISTERED_ACTIONS = [
  'summaryPopup.close', 'summaryPopup.regenerate', 'featureUpload.close', 'featureUpload.submit',
];

// ── DOM：按 id 稳定复用元素；新建节点保留父子关系，查询走真实遍历 ──────────

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
      removeChild(child) {
        const index = el.children.indexOf(child);
        if (index >= 0) el.children.splice(index, 1);
        child.parentNode = null;
        return child;
      },
      remove() { if (el.parentNode) el.parentNode.removeChild(el); },
      querySelector(selector) { return findDescendant(el, selector); },
      querySelectorAll() { return []; },
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
    activeElement: null,
    getElementById(id) {
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

// ── 夹具：真实端点契约 + 噪音记录 + DOM + 渲染效果出口 ────────────────────

const jsonResponse = (payload) => ({ ok: true, status: 200, json: async () => payload });

function createHarness() {
  const warnings = [];
  const errors = [];
  const endpoints = [];
  const unexpectedEndpoints = [];
  const renders = { mainView: [], agentList: [], featurePanel: [] };
  const dom = createDomStub();
  // 用例可控面：上传失败形态、summary 响应是否挂起（过期响应用例）。
  const control = { uploadFails: false, holdSummary: false, summaryResolvers: [], releaseUpload: null };

  const routes = [
    ['/api/feature-ui/declarations', () => jsonResponse({ ok: true, declarations: [], warnings: [] })],
    ['/protoclaw/app_info', () => jsonResponse({ ok: true, version: '0.0.0-p2-fixture', frameworkVersion: '0.0.0-p2-fixture' })],
    // app-core invoke 的 HTTP 回退 + viewer 快照（真实 loadAgents 链路的两源；
    // 两源皆空会走「空快照降级」诊断分支，那是服务端异常的告警路径，不是本用例前提）
    ['/protoclaw/get_connected_agents', () => jsonResponse([{
      id: 'runtime-1', name: 'PH', source: 'prebuilt', runtime_session_id: 'runtime-1',
      connected: true, message_count: 2,
    }])],
    ['/api/agents', () => jsonResponse({ agents: [{ id: 'runtime-1', connected: true, messageCount: 2 }] })],
    ['/protoclaw/agent_detail', () => jsonResponse({ workspace_state: {}, name: 'PH' })],
    ['/api/templates/feature', () => jsonResponse({})],
    ['/protoclaw/session_generate_summary', () => jsonResponse({ ok: true })],
    ['/protoclaw/session_summary', () => (control.holdSummary
      ? new Promise((resolve) => control.summaryResolvers.push(resolve))
      : jsonResponse({ sessionTitle: 'Summary title', summaryText: 'Summary body' }))],
    ['/protoclaw/feature_repository/upload', () => (control.uploadFails
      ? { ok: false, status: 400, text: async () => 'duplicate version', json: async () => ({}) }
      : jsonResponse({ ok: true }))],
  ];

  const fetchStub = async (url, init) => {
    const target = String(url);
    endpoints.push({ url: target, init });
    const route = routes.find(([prefix]) => target.startsWith(prefix));
    if (!route) {
      unexpectedEndpoints.push(target);
      return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
    }
    return route[1]();
  };

  return {
    warnings,
    errors,
    endpoints,
    unexpectedEndpoints,
    renders,
    dom,
    control,
    options: {
      label: 'p2-w2-5-debug-panels',
      classic: (sandbox) => {
        // 真实先行脚本序（顺序同 index.html）：宿主工厂、桥注册与渲染去重
        // 都是生产实现；boot 体挂在永不 resolve 的 __clawAuthReady 之后，
        // applyTheme / applyLanguage 与周期排程一并中和（用例不驱动首屏）。
        prepareClassicSandbox(sandbox);
        //（remote-connections 已迁 ESM：见 withHarness，模块相真实 import。）
        fillMissingLateGlobals(sandbox);
        // 渲染效果出口：数据流与快照合并保持真实，只记录生产渲染入口的调用点。
        // 侧栏布局渲染器（index.html 后段的 classic sidebar-layout.js）在本文件
        // 不是被测对象，按用例夹具给定渲染出口——摘要成功后的列表刷新链路
        // （真实 loadAgents → renderAgentList）因此可观测且不依赖布局状态。
        sandbox.ClawSidebarLayout = {
          isInteracting: () => false,
          signature: () => '',
          load: async () => {},
          render: (groups) => renders.agentList.push(groups),
        };
        // 面板渲染入口（生产 app-ui 的 renderFeaturePanel）：本文件不断言面板
        // 内容，只要求快照落地后的刷新链路可用（与 test/p2-template-summary-imports
        // 同口径的渲染效果出口）。
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

/** 等待 microtask / 已应答请求收敛。 */
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

const settle = async (rounds = 8) => {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

/**
 * 宿主路径会裸调、但由 index.html **后段** classic 脚本提供的全局（先行脚本序
 * 不含它们；真实 owner 是 persistent-input 等壳层脚本）。按「缺失才补」装最小
 * 面——不补齐会让摘要成功后的真实 loadAgents 刷新链以 ReferenceError 收尾，
 * 那是装配缺键而不是被测契约。
 */
const LATE_CLASSIC_STUBS = {
  _syncPersistentActionButton: () => {},
};

function fillMissingLateGlobals(sandbox) {
  for (const [name, value] of Object.entries(LATE_CLASSIC_STUBS)) {
    if (sandbox.run(`typeof ${name} !== 'undefined'`)) continue;
    sandbox[name] = value;
  }
}

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
function assertNoUnexpectedNoise(harness) {
  assert.deepEqual(harness.warnings, [], '不得产生非预期 console.warn');
  assert.deepEqual(harness.errors, [], '不得产生任何 console.error');
  assert.deepEqual(harness.unexpectedEndpoints, [], '不得命中未登记端点（契约形状必须按真实端点给出）');
}

// ── 1. 接口面 / 注销面 / 状态所有权 ─────────────────────────────────

test('接口面：四个入口是命名导出，动作注册不变，装载期不取数', async () => {
  const harness = createHarness();
  await withHarness(harness, async (c) => {
    const module = await c.load(DEBUG_SUMMARY);
    for (const name of ENTRY_EXPORTS) {
      assert.equal(typeof module[name], 'function', `必须导出 ${name}`);
    }
    for (const name of REGISTERED_ACTIONS) {
      assert.equal(c.window.ClawFW.actions.has(name), true, `必须仍注册 ${name}`);
    }
    // 装载期不做任何取数（入口由 boot 后的操作触发；boot 体被 __clawAuthReady 中和）
    assert.deepEqual(harness.endpoints, [], '装载期不得发出任何请求');
  });
  assertNoUnexpectedNoise(harness);
});

test('注销面：退役的两桥与零消费两键在 window 上都不留同名键', async () => {
  const harness = createHarness();
  await withHarness(harness, async (c) => {
    const module = await c.load(DEBUG_SUMMARY);
    for (const name of ENTRY_EXPORTS) {
      // 逐键证据：既没有 KernelState 访问器，也没有同名数据属性
      const descriptor = Object.getOwnPropertyDescriptor(c.window, name);
      assert.equal(descriptor, undefined, `${name} 不应在 window 上留键`);
      assert.equal(c.read(`typeof ${name}`), 'undefined', `${name} 不应可被 classic 裸标识符解析`);
      // 命名导出仍是唯一入口
      assert.equal(typeof module[name], 'function');
    }
  });
  assertNoUnexpectedNoise(harness);
});

test('状态所有权：classic 侧同名 window 写入不转发进模块（无桥）', async () => {
  const harness = createHarness();
  await withHarness(harness, async (c) => {
    const module = await c.load(DEBUG_SUMMARY);
    const original = module.openSummaryPopup;
    const probe = function openSummaryPopupProbe() {};
    c.window.openSummaryPopup = probe; // 普通属性写入：不再有 setter 转发
    assert.equal(c.window.openSummaryPopup, probe);
    assert.equal(module.openSummaryPopup, original, '模块绑定不受 window 写入影响');
    delete c.window.openSummaryPopup;
    assert.equal('openSummaryPopup' in c.window, false);
  });
  assertNoUnexpectedNoise(harness);
});

// ── 2. Repo 过滤（classic owner 写回）──────────────────────────────

test('repo 过滤：写回 classic owner 并关闭表面动画后重渲主视图', async () => {
  const harness = createHarness();
  await withHarness(harness, async (c) => {
    const module = await c.load(DEBUG_SUMMARY);
    const debugPanel = (await c.load(DEBUG_PANEL)).debugPanel;
    const entryState = await c.load(RENDER_ENTRY_STATE);

    entryState.setShouldAnimateWorkspaceSurface(true);
    module.setRepoSearchQuery('  Foo.TGZ ');
    assert.equal(debugPanel.repoSearchQuery, 'foo.tgz');
    assert.equal(entryState.shouldAnimateWorkspaceSurface, false);
    assert.deepEqual(harness.renders.mainView, ['renderCurrentMainView']);

    harness.renders.mainView.length = 0;
    module.setRepoSourceFilter('');
    assert.equal(debugPanel.repoSourceFilter, 'all');
    assert.deepEqual(harness.renders.mainView, ['renderCurrentMainView']);
  });
  assertNoUnexpectedNoise(harness);
});

// ── 3. Feature Upload：真实入口四条路径 ────────────────────────────

function openUploadDialog(c, harness, module) {
  module.openFeatureUploadDialog();
  const dialog = harness.dom.byId.get('feature-upload-dialog');
  const input = harness.dom.byId.get('feature-upload-input');
  const dropzone = harness.dom.byId.get('feature-upload-dropzone');
  assert.equal(dialog.style.display, 'flex', '打开时显示对话框');
  assert.equal(typeof dropzone.onclick, 'function', '点击上传区绑定');
  assert.equal(typeof input.onchange, 'function', '文件选择绑定');
  assert.equal(typeof dropzone.ondrop, 'function', '拖拽绑定');
  return {
    dialog,
    input,
    dropzone,
    status: harness.dom.byId.get('feature-upload-status'),
    submit: harness.dom.byId.get('feature-upload-submit'),
  };
}

test('上传：非 .tgz 与空选择都被拒绝，合法 .tgz 放行', async () => {
  const harness = createHarness();
  await withHarness(harness, async (c) => {
    const module = await c.load(DEBUG_SUMMARY);
    const ui = openUploadDialog(c, harness, module);
    assert.equal(ui.submit.disabled, true, '打开时提交禁用');

    ui.input.onchange({ target: { files: [{ name: 'bundle.zip' }] } });
    assert.match(ui.status.textContent, /请选择 \.tgz 格式的文件/);
    assert.match(ui.status.className, /error/);
    assert.equal(ui.submit.disabled, true);

    ui.input.onchange({ target: { files: [] } });
    assert.equal(ui.status.style.display, 'none');
    assert.equal(ui.submit.disabled, true);

    ui.input.onchange({ target: { files: [{ name: 'pkg.tgz' }] } });
    assert.equal(ui.status.textContent, '已选择: pkg.tgz');
    assert.match(ui.status.className, /success/);
    assert.equal(ui.submit.disabled, false);
  });
  assertNoUnexpectedNoise(harness);
});

test('上传成功：POST multipart、成功文案、1s 后关窗并失效 detail 缓存', async () => {
  const harness = createHarness();
  await withHarness(harness, async (c) => {
    const module = await c.load(DEBUG_SUMMARY);
    const store = await c.load(AGENT_STORE);
    store.setAllAgents([{ id: 'runtime-1', name: 'PH', source: 'prebuilt', runtime_session_id: 'runtime-1' }]);
    store.setFocusedAgentId('runtime-1');
    c.window.AgentLoaderHost.loadedAgentDetailIds.add('runtime-1');

    const timers = installTimerControl(c);
    const ui = openUploadDialog(c, harness, module);
    ui.input.onchange({ target: { files: [{ name: 'pkg.tgz' }] } });

    // 真实入口：分发器注册表里的处理器
    const submitted = c.window.ClawFW.actions.invoke('featureUpload.submit');
    assert.ok(submitted && typeof submitted.then === 'function', '分发器处理器返回提交 promise');
    await submitted;

    const call = harness.endpoints.find((item) => item.url === '/protoclaw/feature_repository/upload');
    assert.ok(call, '必须 POST 上传端点');
    assert.equal(call.init.method, 'POST');
    assert.ok(call.init.body instanceof FormData, '请求体是 multipart FormData');
    assert.equal(ui.status.textContent, '上传成功!');

    // 1s 后：关窗 + 失效当前焦点 agent 的 detail 缓存并重拉（用户可见的列表刷新）
    await fireDelay(timers, 1000);
    assert.equal(ui.dialog.style.display, 'none', '成功后延时关窗');
    assert.ok(
      harness.endpoints.some((item) => item.url.startsWith('/protoclaw/agent_detail?agentId=runtime-1')),
      'detail 缓存失效后必须重新拉取 agent_detail',
    );
    assert.equal(
      c.window.AgentLoaderHost.loadedAgentDetailIds.has('runtime-1'), true,
      '重拉完成后 detail 缓存恢复（证明失效分支真的执行过）',
    );
    assert.deepEqual(harness.renders.mainView, ['renderCurrentMainView']);
  });
  assertNoUnexpectedNoise(harness);
});

test('上传失败：错误文案 + 恢复提交按钮，不发二次请求', async () => {
  const harness = createHarness();
  await withHarness(harness, async (c) => {
    const module = await c.load(DEBUG_SUMMARY);
    harness.control.uploadFails = true;
    const ui = openUploadDialog(c, harness, module);
    ui.input.onchange({ target: { files: [{ name: 'dup.tgz' }] } });

    await c.window.ClawFW.actions.invoke('featureUpload.submit');
    assert.equal(ui.status.textContent, '上传失败: duplicate version');
    assert.match(ui.status.className, /error/);
    assert.equal(ui.submit.disabled, false, '失败后可重试');
    const uploadCalls = harness.endpoints
      .filter((item) => item.url === '/protoclaw/feature_repository/upload');
    assert.equal(uploadCalls.length, 1, '失败路径不发二次请求');
    assert.deepEqual(
      harness.endpoints.map((entry) => entry.url)
        .filter((url) => url.startsWith('/protoclaw/agent_detail')),
      [],
      '失败时不失效 detail 缓存',
    );
  });
  assertNoUnexpectedNoise(harness);
});

// ── 4. Summary 弹窗：命名导出入口 + 异步过期 ──────────────────────

test('summary：同一会话的旧响应不得覆盖新请求（guard token 过期语义）', async () => {
  const harness = createHarness();
  await withHarness(harness, async (c) => {
    const module = await c.load(DEBUG_SUMMARY);
    harness.control.holdSummary = true;

    module.openSummaryPopup('runtime-1', 's1');
    module.openSummaryPopup('runtime-1', 's1');
    assert.equal(harness.control.summaryResolvers.length, 2, '两次打开各发一次请求');
    const overlay = harness.dom.byId.get('summary-popup-overlay');
    assert.ok(overlay, '弹窗 overlay 由模块按需创建');

    harness.control.summaryResolvers[1](jsonResponse({ sessionTitle: 'newer', summaryText: 'NEW' }));
    await settle();
    const afterNewest = overlay.innerHTML;
    assert.match(afterNewest, /newer/);

    harness.control.summaryResolvers[0](jsonResponse({ sessionTitle: 'stale', summaryText: 'OLD' }));
    await settle();
    assert.equal(overlay.innerHTML, afterNewest, '旧响应不得覆盖新渲染');
    assert.doesNotMatch(overlay.innerHTML, /stale/);
  });
  assertNoUnexpectedNoise(harness);
});
