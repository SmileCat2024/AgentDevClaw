/**
 * 前端加载链模拟：按 index.html 真实标签设备加载 classic 首屏链（app-core →
 * session-view-state → sidebar-render → runtime-status → app-main），再真实
 * import 已迁为 ESM 的 agent-data-loader（host 工厂 seam）与 sse-client。
 *
 * 契约：
 *   - classic 相：kernel-state / app-core / sidebar-render / auth-client 等
 *     auth-client 都必须仍是 classic 标签且先于 app-main（首屏同步链与桥存储的
 *     唯一实现，不能等 deferred module）；
 *   - ESM 入口链：sse-client 不得是 classic 标签（classic 相解析 import 会
 *     SyntaxError），必须在 index.html 的 module 入口图内可达，并经
 *     kernel-entry → p2-entry 收口（P2 生产装载接线）；
 *   - module 入口必须是静态非 async：async 会让入口绕过 DOMContentLoaded 的
 *     等待，认证初始化与首屏时序随之改变；
 *   - 工作空间动作批：workspace-actions 已迁 ESM，不得回潮成 classic 标签（解析期
 *     SyntaxError），须由 p2-entry 显式 import；同一区域 thread-store 仍是 classic
 *     刷新引擎（三条同步调度必须原位注册），标签必须保留；
 *   - 输入面尾批：choice-input 与 input-model-switcher 已迁 ESM，不得回潮成
 *     classic 标签（解析期 SyntaxError），必须在 module 入口图内可达——前者经
 *     第二波 3b 批次入口带入，后者由 p2-entry 显式 import；与之相邻的
 *     input-helpers / rollback-dialog 已随 P4 T2 迁 ESM（后者现在是纯注册壳），
 *     标签必须删除且须经 p4-entry 可达；
 *   - 调试批：debug-overview / debug-preflight / debug-mcp 已迁 ESM（经
 *     p2-debug-small-bootstrap 与 p2-w2-11-debug-deep-bootstrap 进入入口链），
 *     不得回潮成 classic 标签；debug-logs / debug-features-hooks 仍是 classic
 *     唯一实现（rail 在 classic 相即可点），标签必须保留且不得被入口 import；
 *   - 认证闸：sse-client 的建连与 app-main 的 boot 都以 `__clawAuthReady` 为
 *     前提——模块求值相不建连、boot 不启动，放行后两者都动作。这两件事的先后
 *     不再由脚本标签序保证，而是由认证闸保证；
 *   - sse-client 顶层执行不依赖 app-main 的 boot 结果（模块执行相即可主动
 *     bootSseClient 并建连），hello 后 isSseActive 翻转，桥键对 classic
 *     消费方同为真；
 *   - connection 帧走真实 loadAgents（ESM 图，不是可选链跳过），网络面经
 *     fetch 桩观察。
 *
 * classic 侧一律 `sandbox.loadSource`（它们仍是 classic 唯一实现）；app-main
 * 的 `(async () => { await window.__clawAuthReady; await startApplication(); })()`
 * 在既有用例里由「永不 resolve 的 __clawAuthReady」挡住（测加载链，不跑页面
 * boot），在入口时序用例里由可放行的闸驱动（验认证前后两侧的动作时点）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { CLASSIC_BOOTSTRAP } from './p2-classic-hosts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const HTML = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

/** index.html 的真实标签设备：classic 与 module 分开（迁移期两者语义不同）。 */
const SCRIPT_TAGS = [...HTML.matchAll(/<script\b([^>]*)>/g)]
  .map(([, attrs]) => ({
    src: (attrs.match(/\bsrc="([^"]+)"/) || [])[1],
    isModule: /\btype="module"/.test(attrs),
    isAsync: /\basync\b/.test(attrs),
  }))
  .filter((tag) => tag.src);
const CLASSIC_SRCS = SCRIPT_TAGS.filter((tag) => !tag.isModule).map((tag) => tag.src);
const MODULE_ENTRIES = SCRIPT_TAGS.filter((tag) => tag.isModule);

/** classic 标签序位置（真实加载序）；不在清单里返回 -1。 */
const classicIndex = (src) => CLASSIC_SRCS.indexOf(src);

/**
 * module 入口图：从 index.html 的 module 标签出发解析静态 import / export-from
 * 相对路径（与 frontend-script-tags-gate 的 R4 登记同口径）。返回
 * 仓库相对路径 → 直接依赖数组；键集合即"module 入口链可达文件"。
 */
function resolveModuleGraph() {
  const repoPath = (src) => `public/${src.replace(/^\.\//, '')}`;
  const graph = new Map();
  const stack = MODULE_ENTRIES.map((tag) => repoPath(tag.src));
  while (stack.length) {
    const current = stack.pop();
    if (graph.has(current)) continue;
    const source = fs.readFileSync(path.join(ROOT, current), 'utf8');
    const resolved = [...source.matchAll(
      /^\s*(?:import|export)\s+(?:[^'"]*?\sfrom\s+)?["']([^"']+)["']/gm,
    )]
      .map((match) => match[1])
      .filter((spec) => spec.startsWith('.'))
      .map((spec) => path.posix.normalize(path.posix.join(path.posix.dirname(current), spec)));
    graph.set(current, resolved);
    for (const dep of resolved) stack.push(dep);
  }
  return graph;
}

const MODULE_GRAPH = resolveModuleGraph();

const SSE_CLIENT = 'public/src/modules/sse-client.js';
const SSE_TAG_SRC = './src/modules/sse-client.js';

/** P2 输入面尾批：已迁 ESM、不得再有 classic 标签的两个域。 */
const INPUT_ESM_BATCH = [
  './src/modules/choice-input.js',
  './src/modules/input-model-switcher.js',
];
/** 工作空间动作批：workspace-actions 已迁 ESM（由 p2-entry 显式 import）。 */
const WORKSPACE_ACTIONS_ESM = './src/modules/workspace-actions.js';
/** 同一区域保留的 classic 刷新引擎：三条同步调度必须原位注册。 */
const THREAD_STORE_CLASSIC = './src/modules/thread-store.js';

/** P4 T2 迁出的输入薄壳：classic 标签必须删除，且须经 p4-entry 可达。 */
const INPUT_SHELL_ESM = [
  './src/modules/input-helpers.js',
  './src/modules/rollback-dialog.js',
];

/** 调试批里已迁 ESM 的模块：不得再有 classic 标签，须经 module 入口图可达。 */
const DEBUG_ESM_BATCH = [
  './src/modules/debug-overview.js',
  './src/modules/debug-preflight.js',
  './src/modules/debug-mcp.js',
  // P4 T2：debug 三件整体迁出，rail 面板的 render / onOpen 闭包改经桥键调用。
  './src/modules/debug-logs.js',
  './src/modules/debug-features-hooks.js',
  './src/modules/debug-panel-host.js',
];
/** 两个调试批次入口（P2 生产装载收口在 p2-entry）。 */
const DEBUG_BOOTSTRAPS = [
  './src/modules/p2-debug-small-bootstrap.js',
  './src/modules/p2-w2-11-debug-deep-bootstrap.js',
];

class MockEventSource {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.listeners = new Map();
    this.onerror = null;
    MockEventSource.instances.push(this);
  }
  addEventListener(kind, fn) {
    if (!this.listeners.has(kind)) this.listeners.set(kind, []);
    this.listeners.get(kind).push(fn);
  }
  close() { this.readyState = 2; }
  emit(kind, data) {
    this.readyState = 1;
    for (const fn of this.listeners.get(kind) || []) fn({ data: JSON.stringify(data) });
  }
}

/** 真实 DOM 形状的元素桩（sse-client 链上的 classic 宿主工厂会读这些字段）。 */
function makeElement() {
  return {
    innerHTML: '', textContent: '', value: '', className: '', style: {}, dataset: {}, children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {}, removeEventListener() {},
    appendChild() {}, insertBefore() {}, remove() {}, replaceWith() {},
    focus() {}, blur() {}, click() {}, select() {}, setSelectionRange() {}, scrollIntoView() {},
    getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 }; },
    closest() { return null; }, matches() { return false; }, contains() { return false; },
    insertAdjacentHTML() {}, querySelector() { return null; }, querySelectorAll() { return []; },
    getAttribute() { return null; }, setAttribute() {}, removeAttribute() {}, hasAttribute() { return false; },
    getElementsByTagName() { return []; }, getElementsByClassName() { return []; },
  };
}

function createDocumentStub() {
  return {
    getElementById: () => makeElement(),
    createElement: () => makeElement(),
    createTextNode: (text) => ({ textContent: text }),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {},
    getElementsByTagName: () => [], getElementsByClassName: () => [],
    body: makeElement(), head: makeElement(), documentElement: makeElement(),
    readyState: 'complete',
  };
}

/**
 * app-main 的顶层与宿主工厂仍依赖一批 classic 全局（真实页面由更早的
 * classic 文件提供）。本测试只验证加载链，因此按既有注入面提供它们；
 * `__clawAuthReady` 永不 resolve，挡住页面 boot 主链（本文件的第一个用例就是
 * 「有 auth 变量 → 顶层不建连」，第二个用例是「无 auth 变量 → 顶层自举」）。
 */
const APP_MAIN_PRELUDE_BASE = `
  getCurrentHostAgentRecord = () => ({ id: 'programming-helper', source: 'prebuilt' });
  renderAgentList = () => {};
  renderCurrentMainView = () => {};
  renderFeaturePanel = () => {};
  resetRuntimeStatusForSwitch = () => {};
  applyLanguage = () => {};
  applyTheme = () => {};
  isChatSurfaceActive = () => true;
  getRuntimeAwareAgentRecord = () => null;
  notifyChatViewportMutation = () => {};
  isRemoteNamespaceAgentId = (value) => typeof value === 'string' && value.startsWith('remote:');
  getEmptyOverviewSnapshot = () => ({ empty: true });
  getEmptyTodoPlan = () => ({ tasks: [] });
  notifyInputSurfaceChanged = () => {};
  getAgentRuntimeId = (agent) => agent?.id || '';
`;

/** 既有用例的 prelude：认证永不放行，页面 boot 主链被挡住。 */
const APP_MAIN_PRELUDE = `${APP_MAIN_PRELUDE_BASE}
  window.__clawAuthReady = new Promise(() => {});
`;

/**
 * 入口时序用例的 prelude：认证闸可放行，并把 boot 的续体换成计数器。
 *
 * `startApplication` 在浏览器里是 ESM 图（application-startup-host）的导出；
 * 本用例只钉「boot 等认证、放行后才启动」这一时序事实，不驱动真实启动链
 * （真实启动链由 test/p2-production-boot-browser-check.mjs 在浏览器里验）。
 */
const AUTH_GATE_PRELUDE = `${APP_MAIN_PRELUDE_BASE}
  window.__testAuthGate = (() => {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    window.__clawAuthReady = promise;
    return { resolve };
  })();
  startApplication = () => { window.__bootCalls = (window.__bootCalls || 0) + 1; };
`;

/**
 * 本文件允许的既有生产诊断（逐条理由；其余任何 warn/error 一律失败）：
 *   - 【sidebar】empty connected snapshot：fixture 没有已连接 agent（两侧快照皆空）
 *     时 loadAgents 的稳态提示，不是失败。
 */
const NOISE_ALLOWED = [/^warn: \[sidebar\] empty connected snapshot/];

const APP_MAIN_SOURCE = 'public/src/app-main.js';

/**
 * app-main 之前的生产先行链（与 test/p2-classic-hosts.js 的 CLASSIC_BOOTSTRAP
 * 同源，只把 app-main 留到认证闸之后装载）。
 *
 * 为什么不再手写宿主工厂：ESM 图求值期会调用 classic 相的真实工厂
 * （createWorkspaceSurfaceHost ← app-ui、createRuntimeSwitchHost ← app-main、
 * createThreadStoreHost ← thread-store …）。手写同形空工厂等于把宿主契约复制
 * 进测试，生产改动无法被发现；这里直接执行真实 classic 脚本。
 */
const CLASSIC_HOST_CHAIN = CLASSIC_BOOTSTRAP.filter((file) => file !== APP_MAIN_SOURCE);

/**
 * 装载真实 classic 宿主链；`beforeAppMain` 是认证闸 / prelude 的插入点。
 * 只关掉用例不测的周期排程与平台 Observer（不是宿主契约本身）。
 */
function loadClassicHostChain(sandbox, beforeAppMain) {
  sandbox.run(`
    ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
    MutationObserver = class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
    IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
    setInterval = () => 0;
    clearInterval = () => {};
    requestAnimationFrame = () => 0;
  `);
  for (const file of CLASSIC_HOST_CHAIN) sandbox.loadSource(file);
  // classic 刷新引擎（index.html 里的 thread-store 标签）：ESM 图求值期要它提供
  // 的窄宿主 createThreadStoreHost()。它与 app-main 一样属于"后段 classic 脚本"，
  // 在 ESM 图之前装载（生产顺序亦然）。
  sandbox.loadSource('public/src/modules/thread-store.js');
  if (typeof beforeAppMain === 'function') beforeAppMain(sandbox);
  sandbox.loadSource(APP_MAIN_SOURCE);
}

/**
 * 用例级控制台噪音捕获：加载链的意义就是「顶层无未定义引用」，而 production 的
 * `promise.catch` / `host.warn` 会把失败降级成 warn 输出（loadAgents 的 catch 等），
 * 测试若不看输出就可能带着 ReferenceError 变绿。case 内接管 console.warn /
 * console.error，用例结束断言为空——不吞错。
 */
function captureConsoleNoise(allowed = []) {
  const entries = [];
  const original = { warn: console.warn, error: console.error };
  const record = (level) => (...args) => {
    entries.push(`${level}: ${args.map((value) => (value instanceof Error ? value.message : String(value))).join(' ')}`);
  };
  console.warn = record('warn');
  console.error = record('error');
  return {
    entries,
    restore() {
      console.warn = original.warn;
      console.error = original.error;
    },
    assertClean(label) {
      const unexpected = entries.filter((line) => !allowed.some((pattern) => pattern.test(line)));
      assert.deepEqual(unexpected, [],
        `${label} 不得出现非预期 warn/error 输出：\n${unexpected.join('\n')}`);
    },
  };
}

/**
 * 入口时序用例的环境：与 bootCaseOptions 相同的 classic 链与 app-main，但
 * `__clawAuthReady` 是可放行的闸（并记录 boot 续体调用次数）。
 */
const authGatedCaseOptions = () => {
  const fetchStub = createFetchStub();
  const document = createDocumentStub();
  return {
    fetchStub,
    options: {
      classic: (sandbox) => {
        // 真实先行链（宿主工厂即生产实现），认证闸插在 app-main 之前
        loadClassicHostChain(sandbox, (s) => s.run(AUTH_GATE_PRELUDE));
      },
      globals: {
        document,
        EventSource: MockEventSource,
        URLSearchParams,
        ClawToast: { show() {} },
        performance: { now: () => Date.now() },
        fetch: fetchStub,
      },
    },
  };
};

/** 让已 resolve 的 promise 续体（含 app-main boot 与 sse-client 的 .then）跑完。 */
const hostSetTimeout = globalThis.setTimeout;
const flushMicrotasks = () => new Promise((resolve) => hostSetTimeout(resolve, 0));

/** 在「非预期 warn/error 必须为空」的守卫下跑一个 case（失败也要还原 console）。 */
async function withNoiseClean(label, fn) {
  const noise = captureConsoleNoise(NOISE_ALLOWED);
  try {
    const result = await fn();
    noise.assertClean(label);
    return result;
  } finally {
    noise.restore();
  }
}

/** 网络面桩：connected agents 与 /api/agents 空快照（真实 loadAgents 全链可跑通）。 */
function createFetchStub() {
  const calls = [];
  let notifyAgentsRequested;
  const agentsRequested = new Promise((resolve) => { notifyAgentsRequested = resolve; });
  const stub = async (url) => {
    const target = String(url);
    calls.push(target);
    if (target === '/api/agents') notifyAgentsRequested();
    const body = target.includes('/protoclaw/get_connected_agents') ? []
      : target === '/api/agents' ? { agents: [] }
        : {};
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
  stub.calls = calls;
  stub.agentsRequested = agentsRequested;
  return stub;
}

const bootCaseOptions = () => {
  const fetchStub = createFetchStub();
  const document = createDocumentStub();
  return {
    fetchStub,
    options: {
      classic: (sandbox) => {
        // 真实先行链；认证闸永不 resolve，挡住 app-main boot 主链
        loadClassicHostChain(sandbox, (s) => s.run(APP_MAIN_PRELUDE));
      },
      globals: {
        document,
        EventSource: MockEventSource,
        URLSearchParams,
        ClawToast: { show() {} },
        // 浏览器平台全局：sidebar-render 的宿主工厂用它给快照打时间戳
        performance: { now: () => Date.now() },
        fetch: fetchStub,
      },
    },
  };
};

/**
 * 「无 auth 变量 → 模块顶层自举」用例的环境：装载完整真实先行链（宿主工厂即
 * 生产实现，含 app-main），app-main 装载时捕获永不 resolve 的认证闸，随后删除
 * auth 变量——sse-client 求值时环境里没有 `__clawAuthReady`，走顶层自举分支；
 * boot 主链仍被已捕获的 promise 挡住。本用例只验证自举与建连，不驱动页面域。
 */
const selfBootCaseOptions = () => {
  const fetchStub = createFetchStub();
  const document = createDocumentStub();
  return {
    fetchStub,
    options: {
      classic: (sandbox) => {
        // 真实先行链含 app-main 的真实宿主工厂；app-main 装载时已同步捕获永不
        // resolve 的认证闸，之后删除 auth 变量——自举用例要求 sse-client 求值时
        // 环境里没有 `__clawAuthReady`（boot 主链仍被已捕获的 promise 挡住）。
        loadClassicHostChain(sandbox, (s) => s.run(APP_MAIN_PRELUDE));
        sandbox.run('delete window.__clawAuthReady;');
      },
      globals: {
        document,
        EventSource: MockEventSource,
        URLSearchParams,
        ClawToast: { show() {} },
        performance: { now: () => Date.now() },
        fetch: fetchStub,
      },
    },
  };
};

describe('前端加载链（index.html 真实入口 + P2 ESM 图，P2 子集）', () => {
  it('入口与时序契约：classic 首屏链仍按 index.html 标签序在 classic 相加载，sse-client 经 module 入口图（kernel-entry → p2-entry）装载，SSE 与 boot 都由认证闸放行', async () => {
    // ── classic 相：首屏同步链与桥存储的唯一实现必须仍是 classic 标签，且先于 app-main
    const mainIdx = classicIndex('./src/app-main.js');
    assert.notEqual(mainIdx, -1, 'app-main 必须是 classic 标签（页面 boot 的唯一实现）');
    const classicRequirements = [
      './src/modules/kernel-state.js', // 桥存储：状态访问器必须先于一切域模块
      './src/app-core.js', // DOM 引用与 createP2Bootstrap*Host 工厂
      './src/modules/sidebar-render.js', // renderAgentList：首屏同步调用
      './src/modules/auth-client.js', // __clawAuthReady 的创建方
    ];
    for (const src of classicRequirements) {
      const idx = classicIndex(src);
      assert.notEqual(idx, -1, `${src} 必须是 classic 标签（首屏同步链不能在 deferred 相才就绪）`);
      assert.ok(idx < mainIdx, `${src} 必须先于 app-main 加载：脚本序 ${idx} < ${mainIdx}`);
    }
    assert.ok(
      classicIndex('./src/modules/kernel-state.js') < classicIndex('./src/app-core.js'),
      '桥存储必须先于 app-core 注册首个桥键',
    );
    // ── module 入口：静态非 async；sse-client 不在 classic 标签里，必须在入口图内可达
    for (const entry of MODULE_ENTRIES) {
      assert.equal(
        entry.isAsync,
        false,
        `module 入口 ${entry.src} 不得加 async：async 会绕过 DOMContentLoaded 的等待，`
          + '认证初始化与首屏时序随之改变（plan R4）',
      );
    }
    assert.equal(
      CLASSIC_SRCS.includes(SSE_TAG_SRC),
      false,
      'sse-client 已是 ESM：classic 标签会在解析期 SyntaxError',
    );
    assert.ok(
      MODULE_ENTRIES.some((entry) => entry.src === './src/modules/kernel-entry.js'),
      'kernel-entry 必须是 index.html 的 module 入口',
    );
    const kernelRepoPath = 'public/src/modules/kernel-entry.js';
    const sseRepoPath = 'public/src/modules/sse-client.js';
    assert.ok(
      MODULE_GRAPH.has(sseRepoPath),
      `sse-client 必须在 module 入口图内可达（可达文件 ${MODULE_GRAPH.size} 个）`,
    );
    assert.ok(
      MODULE_GRAPH.get(kernelRepoPath)?.includes('public/src/modules/p2-entry.js'),
      'kernel-entry 必须 import p2-entry：P2 已迁消费方的装载收口在入口链上，不是散装标签',
    );
    assert.equal(
      MODULE_ENTRIES.some((entry) => entry.src === SSE_TAG_SRC),
      false,
      'sse-client 不得另立 module 标签：重复入口会让同一 URL 在图与入口上双线维护',
    );

    // ── 输入面尾批：两个已迁 ESM 的域与两个保留的 classic 薄壳 ──
    for (const src of INPUT_ESM_BATCH) {
      assert.equal(
        CLASSIC_SRCS.includes(src),
        false,
        `${src} 已迁 ESM：classic 标签会在解析期 SyntaxError（整条脚本不执行）`,
      );
      assert.ok(
        MODULE_GRAPH.has(src.replace(/^\.\//, 'public/')),
        `${src} 必须在 module 入口图内可达（可达文件 ${MODULE_GRAPH.size} 个）`,
      );
    }
    assert.ok(
      MODULE_GRAPH.get('public/src/modules/p2-entry.js')?.includes(
        'public/src/modules/input-model-switcher.js',
      ),
      'input-model-switcher 必须由 p2-entry 显式 import：它没有批次入口文件，'
        + '不能靠偶然的 import 边进入生产装载链',
    );
    for (const src of INPUT_SHELL_ESM) {
      assert.equal(
        CLASSIC_SRCS.includes(src),
        false,
        `${src} 已迁 ESM（P4 T2）：classic 标签会在解析期 SyntaxError`,
      );
      assert.ok(
        MODULE_GRAPH.has(src.replace(/^\.\//, 'public/')),
        `${src} 必须在 module 入口图内可达（p4-entry → kernel-entry）`,
      );
    }

    // ── 工作空间动作批：workspace-actions 已迁 ESM，thread-store 仍是 classic 引擎 ──
    assert.equal(
      CLASSIC_SRCS.includes(WORKSPACE_ACTIONS_ESM),
      false,
      `${WORKSPACE_ACTIONS_ESM} 已迁 ESM：classic 标签会在解析期 SyntaxError（整条脚本不执行）`,
    );
    assert.ok(
      (MODULE_GRAPH.get('public/src/modules/p2-entry.js') || [])
        .includes('public/src/modules/workspace-actions.js'),
      'workspace-actions 必须由 p2-entry 显式 import：它没有批次入口文件',
    );
    assert.notEqual(
      classicIndex(THREAD_STORE_CLASSIC),
      -1,
      `${THREAD_STORE_CLASSIC} 的刷新引擎仍是 classic：三条同步调度必须原位注册，标签不得随 workspace-actions 一起删`,
    );

    // ── 调试批：三个 ESM 模块 + 两个 classic 唯一实现 + 两条批次入口 ──
    for (const src of DEBUG_ESM_BATCH) {
      assert.equal(
        CLASSIC_SRCS.includes(src),
        false,
        `${src} 已迁 ESM：classic 标签会在解析期 SyntaxError（整条脚本不执行）`,
      );
      assert.ok(
        MODULE_GRAPH.has(src.replace(/^\.\//, 'public/')),
        `${src} 必须在 module 入口图内可达（调试批次入口 → p2-entry）`,
      );
    }
    const entryGraph = MODULE_GRAPH.get('public/src/modules/p2-entry.js') || [];
    for (const bootstrap of DEBUG_BOOTSTRAPS) {
      assert.ok(
        entryGraph.includes(bootstrap.replace(/^\.\//, 'public/')),
        `${bootstrap} 必须由 p2-entry 显式 import：调试批次没有散装 module 标签`,
      );
    }
    // P4 T2 起 debug-logs / debug-features-hooks / debug-panel-host 也进了 ESM 图：
    // 它们的桥键在模块相注册，rail 按钮由首屏渲染（boot）生成后才有闭包消费。
    for (const src of DEBUG_ESM_BATCH.slice(3)) {
      assert.ok(
        MODULE_GRAPH.has(src.replace(/^\.\//, 'public/')),
        `${src} 必须经 p4-entry 进入 module 入口图`,
      );
    }

    // ── 认证闸的运行时语义：真实 classic 链 + 真实 sse-client import
    const { fetchStub, options } = authGatedCaseOptions();
    MockEventSource.instances.length = 0;
    await withNoiseClean('入口时序用例', () => withP2EsmCase(options, async (c) => {
      // 真实 import 链：host seam 先于消费方求值（与生产装载顺序一致）
      await c.load('public/src/modules/agent-data-loader.js');
      const sse = await c.load(SSE_CLIENT);

      // 模块求值相：认证未放行，两个消费方都必须还没动作
      assert.equal(MockEventSource.instances.length, 0, '认证放行前 sse-client 不得建连');
      assert.equal(c.read('window.__bootCalls || 0'), 0, '认证放行前 app-main boot 不得启动');
      assert.deepEqual(fetchStub.calls, [], '认证放行前不得发起任何网络请求');

      // 放行认证：SSE 建连与 boot 启动都必须发生在这之后
      c.read('window.__testAuthGate.resolve({ enabled: false, authenticated: true })');
      await flushMicrotasks();
      assert.equal(c.read('window.__bootCalls || 0'), 1, '认证放行后 boot 必须启动（且只启动一次）');
      const source = MockEventSource.instances[MockEventSource.instances.length - 1];
      assert.ok(source, '认证放行后 sse-client 必须建连');
      assert.equal(source.url, '/protoclaw/events');
      assert.equal(sse.isSseActive(), false, '建连成功但 hello 之前不算激活');
      source.emit('hello', { hello: true });
      assert.equal(sse.isSseActive(), true);
      assert.equal(c.read('isSseActive()'), true, '桥键对 classic 消费方同步激活');
    }));
  });

  it('无 __clawAuthReady 时模块顶层自举：import 即建连，hello 后激活（不显式调用 boot）', async () => {
    const { fetchStub, options } = selfBootCaseOptions();
    // MockEventSource.instances 是模块级静态：每个用例重置
    MockEventSource.instances.length = 0;
    await withNoiseClean('无 auth 变量自举用例', () => withP2EsmCase(options, async (c) => {
      // 前置事实：环境里确实没有 auth 就绪变量（自举分支的条件）
      assert.equal(c.read('typeof window.__clawAuthReady'), 'undefined',
        '本用例必须在不含 __clawAuthReady 的环境里跑');
      assert.equal(MockEventSource.instances.length, 0, 'import 之前没有连接');

      // agent-data-loader 的 host 工厂 seam 先于消费方求值
      await c.load('public/src/modules/agent-data-loader.js');
      // 只 import、不调用 bootSseClient：模块顶层语句应自行建连
      const sse = await c.load(SSE_CLIENT);
      const source = MockEventSource.instances[MockEventSource.instances.length - 1];
      assert.ok(source, '模块顶层已自举建连（无 auth 变量分支）');
      assert.equal(source.url, '/protoclaw/events');
      assert.equal(sse.isSseActive(), false, '建连成功但未收到 hello 前不算激活');
      assert.deepEqual(fetchStub.calls, [], '顶层自举只建 SSE 连接，不发任何 HTTP 请求');

      source.emit('hello', { hello: true });
      assert.equal(sse.isSseActive(), true);
      assert.equal(c.read('isSseActive()'), true, '桥键对 classic 消费方同步激活');
    }));
  });

  it('有 __clawAuthReady（永不 resolve）：顶层不建连，classic 首屏链 → 真实 import → 显式 boot + hello 激活 + connection 走真实 loadAgents', async () => {
    const { fetchStub, options } = bootCaseOptions();
    // MockEventSource.instances 是模块级静态：每个用例重置
    MockEventSource.instances.length = 0;
    await withNoiseClean('有 auth 变量首屏链用例', async () => {
      await withP2EsmCase(options, async (c) => {
        // agent-data-loader（P2 W2-4 已迁 ESM）：提供 createSessionDataLoaderHost /
        // createRuntimeStatusLoaderHost 两个装配 seam，必须先于消费它们的 host 模块求值
        await c.load('public/src/modules/agent-data-loader.js');
        const sse = await c.load(SSE_CLIENT);
        assert.equal(typeof sse.bootSseClient, 'function', 'bootSseClient 是命名导出');
        assert.equal(typeof sse.isSseActive, 'function');
        assert.equal(MockEventSource.instances.length, 0,
          'auth 变量存在时顶层必须等它就绪，不得提前建连');

        // 浏览器里顶层自动 boot；这里 __clawAuthReady 永不 resolve（挡住 app-main
        // 页面 boot），按真实公开入口显式建连。
        sse.bootSseClient();
        const source = MockEventSource.instances[MockEventSource.instances.length - 1];
        assert.ok(source, 'boot 已建连');
        assert.equal(source.url, '/protoclaw/events');

        source.emit('hello', { hello: true });
        assert.equal(sse.isSseActive(), true);
        assert.equal(c.read('isSseActive()'), true, '桥键服务 classic 消费方（app-main）');

        source.emit('connection', { kind: 'connection', agentId: 'a-1', data: { connected: true } });
        // connection 分支的真实 loadAgents 是浮动的异步工作：等它真正发起请求再收尾
        await fetchStub.agentsRequested;
        await new Promise((resolve) => setTimeout(resolve, 0));
        assert.ok(fetchStub.calls.includes('/api/agents'),
          `connection 帧必须走真实 loadAgents，实际请求: ${fetchStub.calls.join(', ')}`);
        assert.equal(sse.isSseActive(), true, 'connection 帧不得打断已激活的连接');
      });
      // case 结束：全局注入面（含 window）全部撤走
      assert.equal(typeof globalThis.window, 'undefined');
    });
  });
});
