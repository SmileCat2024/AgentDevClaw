/**
 * Front-end VM test helper.
 *
 * Provides a reusable sandbox for testing browser-bound JS modules
 * (public/src/*.js) in Node.js without a real browser.
 *
 * Usage:
 *   import { createFrontendSandbox } from './helpers/frontend-vm.js';
 *   const ctx = createFrontendSandbox();
 *   ctx.loadSource('../public/src/app-core.js');
 *   // access functions: ctx.run('getFeatureStatus({ enabled: true })')
 */

import fs from 'node:fs';
import { marked as markedModule } from 'marked';
import { installI18n } from './install-i18n.js';
import { installRuntimeSwitch } from './runtime-switch.js';
import { createRuntimeStatusLoader } from '../../public/src/modules/runtime-status-loader.js';
import { createSessionDataLoader } from '../../public/src/modules/session-data-loader.js';
import { createChatLoading } from '../../public/src/modules/chat-loading.js';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
/**
 * 运行时才创建、index.html 里不存在的元素 id：沙箱桩必须返回 null，否则会构造出
 * "元素存在但没有内部结构"的非法状态（生产里 getElementById 命中即代表已建好）。
 * rail-cust-overlay 由 RailCustomize 的 openModal 动态插入。
 */
const RUNTIME_CREATED_IDS = new Set(['rail-cust-overlay']);

const KERNEL_STATE_PATH = 'public/src/modules/kernel-state.js';

/** Install the real classic kernel bridge into an existing VM context. */
export function installKernelState(context) {
  const fullPath = join(__dirname, '..', '..', KERNEL_STATE_PATH);
  const source = fs.readFileSync(fullPath, 'utf8');
  const existingWindow = context.window;
  if (existingWindow && existingWindow !== context) {
    for (const key of Reflect.ownKeys(existingWindow)) {
      if (!(key in context)) context[key] = existingWindow[key];
    }
  }
  context.window = context;
  vm.runInContext(source, context, { filename: fullPath });
}

/**
 * 沙箱里的 marked 面（vendor UMD 的等价物）。
 *
 * 生产 index.html 的 marked UMD 标签先于所有 module 标签执行，所以 markdown-utils
 * 在**求值期**就能 `new marked.Renderer()` 并 `setOptions(...)`。沙箱缺这一前置面时，
 * import 链上求值 markdown-utils 会抛 "Cannot read properties of undefined"。
 *
 * 每张沙箱一份实例：`setOptions` 落在本实例的闭包 options 上，`parse/parseInline/
 * lexer` 把该 options 逐次传进真实 marked —— 用例之间的渲染配置因此互不泄漏。
 */
function createMarkedStub() {
  let options = {};
  return {
    Renderer: markedModule.Renderer,
    setOptions(next) { options = { ...options, ...next }; },
    parse(text, perCall) { return markedModule.parse(text, { ...options, ...perCall }); },
    parseInline(text, perCall) { return markedModule.parseInline(text, { ...options, ...perCall }); },
    lexer(text, perCall) { return markedModule.lexer(text, { ...options, ...perCall }); },
  };
}

/**
 * Create a browser-like VM sandbox context.
 *
 * @param {object} [overrides] — additional globals to inject
 * @returns {object} sandbox context with helper methods
 */
export function createFrontendSandbox(overrides = {}) {
  // Minimal DOM stubs
  const elementStub = {
    // dataset 是真实 DOM 元素的必备面：迁移后的模块在模块相/异步回调里读写
    // dataset（如 chat-context-bar 的 popupBound），桩缺它会把真实的 DOM 路径
    // 误判成 TypeError。
    dataset: {},
    // children 同样是真实元素的必备面：RailCustomize 的锚点定位读
    // Array.from(rail.children)，桩缺它会抛 "undefined is not iterable"。
    children: [],
    style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    appendChild() {},
    removeChild() {},
    insertAdjacentHTML() {},
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    removeAttribute() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
    matches() { return false; },
    contains() { return false; },
    insertBefore() {},
    remove() {},
    getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
    innerHTML: '',
    textContent: '',
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
  };

  const documentStub = {
    getElementById(id) { return RUNTIME_CREATED_IDS.has(id) ? null : { ...elementStub }; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    createElement() { return { ...elementStub }; },
    createTextNode(text) { return { textContent: text }; },
    addEventListener() {},
    body: { ...elementStub },
    head: { ...elementStub },
    documentElement: { ...elementStub },
    // Document 的真实必备面（子节点操作与命中判断），模块在模块相直接调用。
    contains() { return false; },
    readyState: 'complete',
  };

  const localStorageData = {};
  const localStorageStub = {
    getItem(key) { return localStorageData[key] ?? null; },
    setItem(key, value) { localStorageData[key] = String(value); },
    removeItem(key) { delete localStorageData[key]; },
    clear() { Object.keys(localStorageData).forEach(k => delete localStorageData[k]); },
  };

  const windowStub = {
    document: documentStub,
    localStorage: localStorageStub,
    // 浏览器全局：模块相就要求的真实必备面。app-ui 顶层建窄栏 ResizeObserver，
    // 渲染链用 CSS.escape / CSS.supports（selector 转义与能力探测）。沙箱缺它们
    // 会让迁进模块相的代码在求值期抛 ReferenceError（stub 是 no-op，不模拟回调）。
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    CSS: { escape: (value) => String(value), supports: () => false },
    marked: createMarkedStub(),
    // 浏览器全局；部分生产模块（如 ph-project-actions.js）失败路径会调用 alert
    alert() {},
    location: { href: 'http://127.0.0.1:1420', protocol: 'http:', pathname: '/', search: '' },
    addEventListener() {},
    removeEventListener() {},
    innerWidth: 1280,
    innerHeight: 720,
    scrollTo() {},
    requestAnimationFrame(cb) { return setTimeout(cb, 0); },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    console,
    fetch: async () => ({ ok: false, status: 0, json: async () => ({}) }),
  };

  const context = Object.assign(windowStub, {
    // Browser globals
    window: windowStub,
    document: documentStub,
    localStorage: localStorageStub,
    location: windowStub.location,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Date,
    Math,
    JSON,
    Map,
    Set,
    Array,
    Object,
    String,
    Number,
    Boolean,
    RegExp,
    Error,
    Promise,
    encodeURIComponent,
    decodeURIComponent,
    // 浏览器全局 fetch（与 windowStub.fetch 同款默认，可被 overrides 覆盖）
    fetch: windowStub.fetch,
    // escapeHtml stub — real definition is in modules/markdown-utils.js
    escapeHtml(text) {
      if (text == null) return '';
      return String(text).replace(/[&<>"']/g, m => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
      })[m]);
    },
    // State defaults
    currentLanguage: 'zh',
    focusedAgentId: null,
    currentRuntimeAgentId: null,
    currentMessages: [],
    // session-view-state.js 模块级依赖（生产中由 app-core.js 声明）：
    // 最小可写占位，真实提交语义由下方加载的真模块提供。
    currentInputRequests: [],
    toolRenderConfigs: {},
    TOOL_NAMES: {},
    currentHookInspector: { lifecycleOrder: [], features: [], hooks: [] },
    currentOverviewSnapshot: {},
    currentTodoPlan: {},
    currentRuntimeConnected: false,
    _switchEpoch: 0,
    allAgents: [],
    setCurrentHookInspector(value) { context.currentHookInspector = value || {}; },
    setCurrentOverviewSnapshot(value) { context.currentOverviewSnapshot = value || {}; },
    setCurrentTodoPlan(value) { context.currentTodoPlan = value || {}; },
    ...overrides,
  });

  vm.createContext(context);

  /**
   * Load and execute a front-end JS source file in the sandbox.
   * @param {string} relativePath — path relative to project root
   */
  context.loadSource = function (relativePath) {
    const fullPath = join(__dirname, '..', '..', relativePath);
    const source = fs.readFileSync(fullPath, 'utf8');
    vm.runInContext(source, context, { filename: fullPath });
    if (relativePath === 'public/src/app-core.js') {
      context.__createChatLoading = createChatLoading;
      // 计时句柄是本沙箱私有的：生产的 _chatLoadingTimeout 已归 ESM owner
      // （orchestration-state），classic 相没有该全局，也不为测试重建桥。
      Object.assign(context, vm.runInContext(`(() => {
        let chatLoadingTimeout = null;
        return __createChatLoading({
          loading: () => _chatLoadingSession, timer: () => chatLoadingTimeout,
          setLoading: value => { _chatLoadingSession = value; },
          setTimer: value => { chatLoadingTimeout = value; },
          setTimeout: (callback, delay) => setTimeout(callback, delay),
          clearTimeout: id => clearTimeout(id),
          render: () => { if (typeof renderCurrentMainView === 'function') renderCurrentMainView(); },
        });
      })()`, context));
      delete context.__createChatLoading;
    }
    // session-view-state（P4 T2 起 ESM）不再经 loadSource 装载：本沙箱路线只剩
    // classic script。需要它时用 withP2EsmCase + `c.load('.../session-view-state.js')`
    // （或 p2-classic-hosts 的 prepareEsmModules），桥键会装到同一个沙箱 window 上。
    if (relativePath === 'public/src/modules/agent-data-loader.js') {
      Object.assign(context, createRuntimeStatusLoader(vm.runInContext('createRuntimeStatusLoaderHost()', context)));
      Object.assign(context, createSessionDataLoader(vm.runInContext('createSessionDataLoaderHost()', context)));
    }
    if (relativePath === 'public/src/app-main.js') installRuntimeSwitch(context);
    // app-ui 已迁 ESM（P4 T2 末件）：本沙箱路线只剩 classic script，不再有
    // loadSource('public/src/app-ui.js') 的入口（classic 相解析 export 直接
    // SyntaxError）。需要它的导航宿主时走 withP2EsmCase + APP_UI_DOMAIN
    // （p2-classic-hosts），桥键与模块导出都装到同一沙箱 window 上。
  };

  // Make the real kernel bridge available before classic modules register keys.
  installKernelState(context);
  // i18n 已迁 ESM（P4）：t 是桥键，字典与翻译函数来自真实实现，沙箱不再
  // loadSource('public/src/i18n.js')（classic 相解析 export 会直接 SyntaxError）。
  installI18n(context);

  /**
   * Run an expression in the sandbox and return the result.
   * @param {string} code — JS expression to evaluate
   * @returns {*} result
   */
  context.run = function (code) {
    return vm.runInContext(code, context);
  };

  return context;
}

/**
 * Extract a code block between two markers in a source file.
 * Useful when you only need a subset of a large file.
 *
 * @param {string} source — full source text
 * @param {string} startMarker — text to start from (inclusive)
 * @param {string} endMarker — text to end before (exclusive)
 * @returns {string} extracted block
 */
export function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  if (start === -1) throw new Error(`Missing start marker: ${startMarker}`);
  // endMarker 为 null/undefined 时取到文件尾（ESM 插件的 export default 块在文件尾部）
  if (endMarker == null) return source.slice(start);
  const end = source.indexOf(endMarker, start);
  if (end === -1) throw new Error(`Missing end marker: ${endMarker}`);
  return source.slice(start, end);
}
