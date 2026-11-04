/**
 * memo 插件模块的测试装载器。
 *
 * memo 的界面模块已从 classic script 迁移为 ES 模块插件
 * （public/src/plugins/memo/）。模块顶层会注册 window 事件监听并读取
 * window.ClawToast，因此必须先提供一个最小 window 再动态 import。
 *
 * 语言经 pluginHost 注入（mount(host)），所以每个测试用例需要独立的模块
 * 实例——Node 的 ESM 模块缓存会跨用例共享，这里用 query 串绕开缓存。
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PLUGIN_DIR = path.resolve(import.meta.dirname, '..', '..', 'public', 'src', 'plugins', 'memo');

/** 在全局装一个最小 window + document（浏览器环境的最小面），返回清理函数。 */
export function installMinimalWindow(extra = {}) {
  const prevWindow = globalThis.window;
  const prevDocument = globalThis.document;
  const element = {
    innerHTML: '',
    textContent: '',
    value: '',
    style: {},
    dataset: {},
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
    scrollTop: 0,
    scrollHeight: 0,
    offsetHeight: 0,
    focus() {},
    blur() {},
  };
  globalThis.window = {
    addEventListener() {},
    removeEventListener() {},
    ClawToast: { show() {} },
    requestAnimationFrame(cb) { return setTimeout(cb, 0); },
    ...extra,
  };
  globalThis.document = {
    // 每次返回独立元素对象：模块对「当前 DOM 是否挂载」的判断靠 getElementById 命中
    getElementById() { return { ...element }; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    createElement() { return { ...element }; },
    createTextNode(text) { return { textContent: text }; },
    addEventListener() {},
    body: { ...element },
    documentElement: { ...element },
    activeElement: null,
    readyState: 'complete',
  };
  return () => {
    if (prevWindow === undefined) delete globalThis.window; else globalThis.window = prevWindow;
    if (prevDocument === undefined) delete globalThis.document; else globalThis.document = prevDocument;
  };
}

/** 供插件 mount(host) 的 presenter：语言、转义、markdown、宿主动作。 */
export function makePresenter({ language = 'zh', workspace, markdown } = {}) {
  return {
    getLanguage: () => language,
    escapeHtml: (v) => String(v ?? '').replace(/[&<>"']/g, (m) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[m]),
    markdown: {
      renderMarkdown: (t) => String(t ?? ''),
      splitMarkdownBlocks: () => [],
      isEditableMarkdownBlock: () => false,
      replaceMarkdownBlock: (src) => src,
      ...markdown,
    },
    workspace: workspace || { runAction() {} },
  };
}

/**
 * 动态 import 一个 memo 插件模块并给它 mount(presenter)。
 * @param {'reminders'|'notes'|'overview'} name
 * @param {object} presenterOptions 见 makePresenter
 * @returns {Promise<{ module: object, api: object, cleanup: () => void }>}
 *   api 是该模块导出的界面对象（MemoRemindersUI 等）
 */
export async function loadMemoModule(name, presenterOptions = {}) {
  const cleanup = installMinimalWindow();
  const file = path.join(PLUGIN_DIR, `${name}.js`);
  // 唯一 query 让每个用例拿到全新模块实例（模块内 cache / loaded 是模块级状态）
  const url = `${pathToFileURL(file).href}?case=${Math.random().toString(36).slice(2)}`;
  const mod = await import(url);
  const descriptor = mod.default;
  const presenter = makePresenter(presenterOptions);
  if (typeof descriptor.mount === 'function') descriptor.mount(presenter);
  const api = mod[`Memo${name[0].toUpperCase()}${name.slice(1)}UI`];
  return { module: mod, api, descriptor, presenter, cleanup };
}
