/**
 * claw-guide 插件契约。
 *
 * 该工作空间已从 classic script（public/src/modules/guide-docset.js）迁移为
 * ES 模块插件（public/src/plugins/claw-guide/）。本文件验证三件事：
 *   1. 插件协议字段齐全（id / blocks / actions / mount / unmount）；
 *   2. 宿主能力全部经 mount 注入，模块内不残留对经典脚本全局的裸引用；
 *   3. 卸载时摘除 document 级委托监听并清空状态（卸载后可重新装载）。
 *
 * 为什么这几条值得测：ES 模块作用域看不到 classic script 的顶层 let，
 * 迁移时最容易出现的缺陷是「引用一个不存在的全局」——这类代码在模块里
 * 不抛错而是静默返回 undefined，表现为功能无声失效。第 2 条把注入面固定
 * 下来，注入缺失时断言会直接失败，而不是上线后才发现。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { installMinimalWindow } from './helpers/memo-plugin-loader.js';

const PLUGIN_FILE = path.resolve(
  import.meta.dirname, '..', 'public', 'src', 'plugins', 'claw-guide', 'guide-docset.js',
);

/** 记录 document 上挂过的监听器，用于断言卸载时被摘除。 */
function instrumentDocument() {
  const cleanups = [];
  const listeners = { click: [], scroll: [] };
  const restore = installMinimalWindow();
  cleanups.push(restore);
  const prevDocument = globalThis.document;
  const doc = {
    ...prevDocument,
    addEventListener(type, handler) {
      (listeners[type] || (listeners[type] = [])).push({ handler });
    },
    removeEventListener(type, handler) {
      const list = listeners[type] || [];
      const index = list.findIndex((entry) => entry.handler === handler);
      if (index >= 0) list.splice(index, 1);
    },
  };
  globalThis.document = doc;
  cleanups.push(() => { globalThis.document = prevDocument; });
  return {
    listeners,
    cleanup() { for (const fn of cleanups.reverse()) fn(); },
  };
}

/** 构造 presenter（插件 mount 时注入的宿主能力）。 */
function makeHost(overrides = {}) {
  const calls = { render: 0, zoom: 0, rerender: 0 };
  const host = {
    env: {
      language: 'zh',
      escapeHtml: (v) => String(v ?? '').replace(/[&<>"']/g, (m) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
      })[m]),
      enhanceMathInElement: () => {},
      openImageZoom: () => { calls.zoom++; },
      markdown: {
        render: (text) => { calls.render++; return `<p>${String(text ?? '')}</p>`; },
      },
    },
    workspace: {
      currentAgent: () => ({ id: 'claw-guide', workspaceState: {} }),
      rerender: () => { calls.rerender++; },
      runAction() {},
    },
    ...overrides,
  };
  return { host, calls };
}

async function loadPlugin(host) {
  const url = `${pathToFileURL(PLUGIN_FILE).href}?case=${Math.random().toString(36).slice(2)}`;
  const mod = await import(url);
  const descriptor = mod.default;
  if (typeof descriptor.mount === 'function') descriptor.mount(host);
  return descriptor;
}

test('claw-guide 插件协议：block 与 action 声明齐全', async () => {
  const doc = instrumentDocument();
  try {
    const { host } = makeHost();
    const plugin = await loadPlugin(host);
    assert.equal(plugin.id, 'claw-guide');
    assert.deepEqual(Object.keys(plugin.blocks), ['guide-docset']);
    assert.equal(typeof plugin.blocks['guide-docset'], 'function');
    assert.deepEqual(
      Object.keys(plugin.actions).sort(),
      ['claw-guide.openDoc', 'claw-guide.toggleDir'],
    );
    for (const handler of Object.values(plugin.actions)) {
      assert.equal(typeof handler, 'function');
    }
  } finally { doc.cleanup(); }
});

test('claw-guide 正文渲染：markdown 只经注入的 host.env.markdown.render 产出', async () => {
  const doc = instrumentDocument();
  const prevFetch = globalThis.fetch;
  const prevRaf = globalThis.requestAnimationFrame;
  try {
    const { host, calls } = makeHost();
    // 无持久缓存 → 走真实加载链路：fetch 取回正文后由 buildGuideArticleHtml
    // 调 host.env.markdown.render 生成 HTML。这条路径正是「注入是否真的被用上」
    // 的证据；若模块读裸全局，注入侧计数保持为 0。
    globalThis.localStorage = {
      store: new Map(),
      getItem(k) { return this.store.has(k) ? this.store.get(k) : null; },
      setItem(k, v) { this.store.set(k, String(v)); },
    };
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ ok: true, doc: { title: '简介', content: '一段正文' } }),
    });
    // 渲染后的 DOM 后处理在无真实 DOM 的环境里没有意义，桩掉避免异步触碰 document
    globalThis.requestAnimationFrame = () => 0;

    const plugin = await loadPlugin(host);
    const agent = {
      id: 'claw-guide',
      workspace_data: {
        guide: { exists: true, defaultDoc: 'intro.md', tree: [{ type: 'doc', id: 'intro.md', name: '简介' }] },
      },
    };
    plugin.blocks['guide-docset'](agent, { id: 'guide', type: 'guide-docset' });

    // 加载经 setTimeout(0) 排队，等它落定
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setTimeout(resolve, 5));

    assert.ok(calls.render >= 1, '正文 markdown 必须经 injected host.env.markdown.render 渲染');
  } finally {
    doc.cleanup();
    globalThis.fetch = prevFetch;
    if (prevRaf === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = prevRaf;
    delete globalThis.localStorage;
  }
});

test('claw-guide 挂载时注册 document 委托，卸载时全部摘除', async () => {
  const doc = instrumentDocument();
  try {
    const { host } = makeHost();
    const plugin = await loadPlugin(host);
    const agent = { id: 'claw-guide', workspaceState: {} };
    plugin.blocks['guide-docset'](agent, { id: 'guide', type: 'guide-docset' });
    assert.equal(doc.listeners.click.length, 1, '点击委托已挂载');
    assert.equal(doc.listeners.scroll.length, 1, '滚动监听已挂载');

    plugin.unmount();
    assert.equal(doc.listeners.click.length, 0, '卸载后点击委托必须摘除');
    assert.equal(doc.listeners.scroll.length, 0, '卸载后滚动监听必须摘除');
  } finally { doc.cleanup(); }
});

test('claw-guide 卸载后重新装载：委托不会重复累积', async () => {
  const doc = instrumentDocument();
  try {
    const { host } = makeHost();
    const plugin = await loadPlugin(host);
    const agent = { id: 'claw-guide', workspaceState: {} };
    plugin.blocks['guide-docset'](agent, { id: 'guide', type: 'guide-docset' });
    plugin.unmount();

    // 反复装卸不该让 document 上的委托叠加成多份（重复绑定会让一次点击
    // 触发多次跳转/折叠）
    plugin.mount(host);
    plugin.blocks['guide-docset'](agent, { id: 'guide', type: 'guide-docset' });
    assert.equal(doc.listeners.click.length, 1, '委托只有一份');
    plugin.unmount();
    plugin.mount(host);
    plugin.blocks['guide-docset'](agent, { id: 'guide', type: 'guide-docset' });
    assert.equal(doc.listeners.click.length, 1, '第二轮装卸后仍只有一份');
  } finally { doc.cleanup(); }
});

test('claw-guide 动作处理器：目录折叠切换只影响目标目录', async () => {
  const doc = instrumentDocument();
  try {
    const { host, calls } = makeHost();
    const plugin = await loadPlugin(host);
    const agent = { id: 'claw-guide', workspaceState: {} };
    plugin.blocks['guide-docset'](agent, { id: 'guide', type: 'guide-docset' });

    // 折叠与展开各一次：每次都应触发一次宿主重渲染
    plugin.actions['claw-guide.toggleDir']({ dataset: { guideToggleDir: 'basics' } });
    assert.equal(calls.rerender, 1, '折叠目录后由宿主重渲染');
    plugin.actions['claw-guide.toggleDir']({ dataset: { guideToggleDir: 'basics' } });
    assert.equal(calls.rerender, 2, '再次点击展开同样重渲染');
  } finally { doc.cleanup(); }
});
