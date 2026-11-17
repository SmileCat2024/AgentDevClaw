/**
 * 主题 / 语言域（P4 T1：classic theme-lang 并入 i18n-environment-state）。
 *
 * 钉住三件对外承诺：
 *   1. applyTheme 把主题落成 body[data-theme] + localStorage，并切换两个样式表；
 *   2. applyLanguage 用当前语言重写静态文案，并触发侧栏 / 面板 / 主视图的同步渲染；
 *   3. bindStaticToggleButtons 是幂等的：绑定一次，点击才生效（首屏渲染前无监听）。
 *
 * 装载走 withP2EsmCase：模块求值要真实 KernelState（claim + defineKey）；DOM 侧
 * 换成稳定的元素表，以便断言 setAttribute / textContent 的真实写入。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withP2EsmCase } from './helpers/p2-esm-case.js';

const MODULE = 'public/src/modules/i18n-environment-state.js';

/** 稳定元素表：同一个 id 每次查询返回同一个对象，写入可被断言。 */
function createDocumentStub() {
  const elements = new Map();
  const make = (id) => ({
    id,
    textContent: '',
    title: '',
    innerHTML: '',
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    getAttribute(name) { return this.attributes[name] ?? null; },
    addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); },
    listeners: {},
  });
  const body = make('body');
  body.dataset = {};
  return {
    body,
    elements,
    getElementById(id) {
      if (id === 'body') return body;
      if (!elements.has(id)) elements.set(id, make(id));
      return elements.get(id);
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    createElement: make,
    addEventListener() {},
    readyState: 'complete',
    title: '',
    // hljs / github-markdown 两个样式表链接
    __styles: new Map(),
  };
}

async function withEnvironment({ language = 'zh', theme = 'dark', run }) {
  const doc = createDocumentStub();
  doc.getElementById('hljs-theme-css').attributes.href = '/vendor/hljs/styles/github-dark.min.css';
  doc.getElementById('github-markdown-css').attributes.href = '/vendor/github-markdown-css/github-markdown-dark.css';
  const calls = [];
  await withP2EsmCase({
    globals: { document: doc },
    classic: (sandbox) => {
      // 生产由 app-core 在原声明位置注册这两个状态键（classic 相），域模块 claim
      // 时吸收。这里按同一形态注册，才对得上真实初始化顺序。
      sandbox.KernelState.defineKey('i18n-environment', 'currentLanguage', language);
      sandbox.KernelState.defineKey('i18n-environment', 'currentTheme', theme);
      sandbox.localStorage = { items: new Map(), setItem(k, v) { this.items.set(k, v); }, getItem(k) { return this.items.get(k) ?? null; } };
      sandbox.renderAgentList = () => calls.push('renderAgentList');
      sandbox.renderFeaturePanel = () => calls.push('renderFeaturePanel');
      sandbox.renderCurrentMainView = () => calls.push('renderCurrentMainView');
    },
  }, async (c) => {
    const mod = await c.load(MODULE);
    await run({ mod, doc, calls, c });
  });
}

test('applyTheme 写 body[data-theme] / localStorage 并切换两份样式表', async () => {
  await withEnvironment({
    run: async ({ mod, doc }) => {
      mod.setCurrentTheme('dark');
      mod.applyTheme('light');
      assert.equal(doc.body.dataset.theme, 'light');
      assert.equal(mod.getCurrentTheme(), 'light', '域状态与 DOM 同步更新');
      assert.equal(
        doc.getElementById('hljs-theme-css').attributes.href,
        './vendor/hljs/styles/github.min.css',
        'hilite 主题切到 light 变体',
      );
      assert.equal(
        doc.getElementById('github-markdown-css').attributes.href,
        './vendor/github-markdown-css/github-markdown-light.css',
      );
      mod.applyTheme('anything-else');
      assert.equal(mod.getCurrentTheme(), 'dark', '非 light 一律归一为 dark');
    },
  });
});

test('applyLanguage 按当前语言重写静态文案并触发首屏三段渲染', async () => {
  await withEnvironment({
    run: async ({ mod, doc, calls, c }) => {
      mod.setCurrentLanguage('zh');
      mod.applyLanguage();
      assert.equal(c.window.localStorage.items.get('agentdev-language'), 'zh', '语言落 localStorage');
      assert.equal(doc.title, c.window.t('page_title'), 'document.title 走真实字典');
      assert.equal(doc.getElementById('language-toggle').textContent, c.window.t('language_toggle_short'));
      assert.deepEqual(calls, ['renderAgentList', 'renderFeaturePanel', 'renderCurrentMainView'], '同步渲染顺序与迁移前一致');
    },
  });
});

test('bindStaticToggleButtons 幂等：只绑一次，点击才翻转主题 / 语言', async () => {
  await withEnvironment({
    run: async ({ mod, doc, c }) => {
      mod.setCurrentTheme('dark');
      mod.setCurrentLanguage('zh');
      const themeToggle = doc.getElementById('theme-toggle');
      const languageToggle = doc.getElementById('language-toggle');
      assert.deepEqual(themeToggle.listeners.click ?? [], [], '首屏渲染前没有监听（早期窗口点击无效果）');

      mod.bindStaticToggleButtons();
      mod.bindStaticToggleButtons();
      assert.equal(themeToggle.listeners.click.length, 1, '重复绑定不叠加监听');
      assert.equal(languageToggle.listeners.click.length, 1);

      themeToggle.listeners.click[0]({});
      assert.equal(mod.getCurrentTheme(), 'light', '点击主题按钮翻转主题');
      languageToggle.listeners.click[0]({});
      assert.equal(mod.getCurrentLanguage(), 'en', '点击语言按钮切换语言');
      assert.equal(c.window.localStorage.items.get('agentdev-language'), 'en');
    },
  });
});

test('桥键与命名导出同源；classic 侧对该域的写入经 claim 转发', async () => {
  await withEnvironment({
    run: async ({ mod, c }) => {
      assert.equal(typeof c.window.applyTheme, 'function', 'applyTheme 桥键已注册');
      assert.equal(typeof c.window.applyLanguage, 'function', 'applyLanguage 桥键已注册');
      assert.equal(typeof c.window.showAgentStartError, 'function', 'showAgentStartError 桥键已注册');
      c.read('currentLanguage = "en"');
      assert.equal(mod.getCurrentLanguage(), 'en', 'classic 写方经 setter 落进域状态');
      c.read('currentTheme = "light"');
      assert.equal(mod.getCurrentTheme(), 'light');
    },
  });
});
