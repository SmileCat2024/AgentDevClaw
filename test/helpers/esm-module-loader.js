/**
 * esm-module-loader.js — 通用 ESM 模块测试装载器（真实 import 路线）。
 *
 * 前端 ESM 化迁移的测试地基（docs/plans/2026-11-16-frontend-esm-strangler-migration.md
 * P0.4）：把 memo-plugin-loader 的「最小 window/document 桩 + 动态 import +
 * 唯一 query 绕模块缓存」泛化为仓库内任意 ESM 模块可用。不预设任何特定
 * 模块的 presenter / 注入面——装载后如何 mount / 注入宿主能力是调用方的事。
 *
 * 三套装载路线分工（与 helpers/load-esm-plugin.js、frontend-vm.js 并列）：
 *   - 本套（真实 import）：模块的全局裸引用面 ⊆ window/document 桩面；
 *   - load-esm-plugin（沙箱源码变换）：模块裸引用任意宿主全局，需在沙箱
 *     注入面里解析；
 *   - frontend-vm（ctx.loadSource）：classic script。
 * 存量 memo-plugin-loader 保持原样（memo 专用配方），新测试一律走本套。
 *
 * API：
 *   installBrowserStubs({ window, document }?) → cleanup()
 *     在 globalThis 装最小 window + document 桩（浏览器环境的最小面）。
 *     window / document 是浅覆盖表：值 === undefined 的键从桩上删除
 *     （模拟浏览器能力缺席），其余值替换 / 新增对应属性。cleanup 恢复
 *     调用前的全局（含「原本没有 window / document」的情形）。
 *   loadModuleOnce(relativePath, { window, document, installGlobals }?)
 *     → Promise<{ module, cleanup }>
 *     真实动态 import 仓库内任意 ESM 模块文件，relativePath 相对仓库根
 *     （如 'public/src/plugins/memo/notes.js'）。每次调用用唯一 query 串
 *     绕开 Node ESM 模块缓存，拿到全新实例（模块级状态不跨调用共享）。
 *     默认自动装桩；调用方已自装时传 installGlobals: false（此时忽略
 *     window/document 覆盖表，cleanup 为无操作，全局归调用方清理）。
 *     import 失败时自动恢复全局再抛出，不留桩泄漏。
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * 运行时才创建、index.html 里不存在的元素 id：沙箱桩必须返回 null，否则会构造出
 * "元素存在但没有内部结构"的非法状态（生产里 getElementById 命中即代表已建好）。
 * rail-cust-overlay 由 RailCustomize 的 openModal 动态插入。
 */
const RUNTIME_CREATED_IDS = new Set(['rail-cust-overlay']);

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

/** 浅覆盖：undefined 值表示删除该键，其余替换 / 新增。 */
function applyOverrides(base, overrides) {
  const out = { ...base };
  for (const [key, value] of Object.entries(overrides || {})) {
    if (value === undefined) delete out[key]; else out[key] = value;
  }
  return out;
}

/** 在全局装最小 window + document 桩，返回恢复原全局的 cleanup。 */
export function installBrowserStubs({ window: windowOverrides, document: documentOverrides } = {}) {
  const prevWindow = globalThis.window;
  const prevDocument = globalThis.document;
  const prevLocalStorage = globalThis.localStorage;
  const element = {
    // children / dataset 是真实 DOM 元素的必备面（模块在求值期或事件回调里遍历
    // 子节点、读写 data-*），桩缺它们会把真实路径误判成 TypeError。
    children: [],
    dataset: {},
    innerHTML: '',
    textContent: '',
    value: '',
    style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setAttribute() {},
    getAttribute() { return null; },
    removeAttribute() {},
    addEventListener() {},
    removeEventListener() {},
    appendChild() {},
    removeChild() {},
    insertAdjacentHTML() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
    matches() { return false; },
    contains() { return false; },
    insertBefore() {},
    remove() {},
    getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
    scrollTop: 0,
    scrollHeight: 0,
    offsetHeight: 0,
    focus() {},
    blur() {},
  };
  globalThis.window = applyOverrides({
    addEventListener() {},
    // 浏览器 window 恒有 fetch；桩上按 globalThis.fetch 转发（用例替换 globalThis.fetch
    // 后仍生效）。模块在求值期捕获 window.fetch（transport 的同源/Viewer 分流补丁），
    // 缺这一面会让装载直接 TypeError。
    fetch: (...args) => globalThis.fetch(...args),
    // 浏览器 window.location 恒在：transport 求值期读 protocol 决定同源 / 直连
    // ViewerWorker 的分流（http(s) → 同源代理）。
    location: { protocol: 'http:', href: 'http://127.0.0.1:14200/', pathname: '/', search: '' },
    removeEventListener() {},
    ClawToast: { show() {} },
    requestAnimationFrame(cb) { return setTimeout(cb, 0); },
    // 浏览器 window 的计时面（真实具备）。周期任务在桩环境**不真正启动**：
    // 通知时钟一类 200ms 轮询会让用例留下未清理句柄，且这些用例断言的不是计时。
    setTimeout: (callback, delay, ...args) => setTimeout(callback, delay, ...args),
    clearTimeout: (timerId) => clearTimeout(timerId),
    setInterval: () => 0,
    clearInterval: () => {},
    queueMicrotask: (callback) => queueMicrotask(callback),
    // 浏览器能力面：CSS.escape（选择器构造）、Blob / URL（导出与图片预览）、
    // matchMedia / getComputedStyle（布局读取）在真实页面里恒在。
    CSS: { escape: (value) => String(value).replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c) },
    Blob: globalThis.Blob,
    URL: globalThis.URL,
    getComputedStyle: () => ({ gap: '0px', getPropertyValue: () => '' }),
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    // 浏览器 window.localStorage 恒在：app-core（主题 / 语言持久值）一类模块在求值期
    // 读取它。ESM 裸引用走宿主 realm，因此同时装到 globalThis（cleanup 一并恢复）。
    localStorage: createLocalStorageStub(),
  }, windowOverrides);
  globalThis.localStorage = globalThis.window.localStorage;
  globalThis.document = applyOverrides({
    // 每次返回独立元素对象：模块对「当前 DOM 是否挂载」的判断靠 getElementById 命中
    getElementById(id) { return RUNTIME_CREATED_IDS.has(id) ? null : { ...element }; },
    contains() { return false; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    createElement() { return { ...element }; },
    createTextNode(text) { return { textContent: text }; },
    createElementNS(_ns, tag) { return { ...element, tagName: String(tag).toUpperCase() }; },
    createDocumentFragment() { return { ...element }; },
    addEventListener() {},
    body: { ...element },
    documentElement: { ...element },
    activeElement: null,
    readyState: 'complete',
  }, documentOverrides);
  return () => {
    if (prevWindow === undefined) delete globalThis.window; else globalThis.window = prevWindow;
    if (prevDocument === undefined) delete globalThis.document; else globalThis.document = prevDocument;
    if (prevLocalStorage === undefined) delete globalThis.localStorage; else globalThis.localStorage = prevLocalStorage;
  };
}

/** 内存版 localStorage（浏览器持久面；用例之间按 install/cleanup 隔离）。 */
function createLocalStorageStub() {
  const data = new Map();
  return {
    getItem: (key) => (data.has(String(key)) ? data.get(String(key)) : null),
    setItem: (key, value) => { data.set(String(key), String(value)); },
    removeItem: (key) => { data.delete(String(key)); },
    clear: () => { data.clear(); },
    key: (index) => [...data.keys()][index] ?? null,
    get length() { return data.size; },
  };
}

let loadSeq = 0;

/**
 * 真实 import 仓库内一个 ESM 模块文件，每次调用拿全新实例。
 * @param {string} relativePath 相对仓库根的模块路径
 * @param {{ window?: object, document?: object, installGlobals?: boolean }} [options]
 * @returns {Promise<{ module: object, cleanup: () => void }>}
 */
export async function loadModuleOnce(relativePath, { window, document, installGlobals = true } = {}) {
  let cleanup = () => {};
  if (installGlobals) cleanup = installBrowserStubs({ window, document });
  try {
    const file = path.resolve(REPO_ROOT, relativePath);
    if (file !== REPO_ROOT && !file.startsWith(REPO_ROOT + path.sep)) {
      throw new Error(`esm-module-loader: ${relativePath} 解析后越出仓库根（${REPO_ROOT}）`);
    }
    // 唯一 query 让每次调用拿到全新模块实例（模块内 cache / host 引用等
    // 是模块级状态）
    const url = `${pathToFileURL(file).href}?esm-loader-case=${++loadSeq}-${Math.random().toString(36).slice(2)}`;
    const module = await import(url);
    return { module, cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}
