import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withP2EsmCase } from './helpers/p2-esm-case.js';

/**
 * 用例基座：classic 相（本地存储写入）→ 模块相由本用例按序装载
 * app-core（注册桥键）→ 目标域（claim 吸收）。
 *
 * app-core 自 P4 T5 起是 ESM：它的注册相位仍是「先于一切域的 claim」，靠装载序
 * 表达——本用例显式先装 app-core，再装被验的域，与生产 index.html 的 module 标签
 * 序同构（生产顺序见 p2-classic-hosts 的 APP_CORE_DOMAIN 注释）。
 */
async function withCore({ stored = {}, beforeDomain } = {}, callback) {
  const elements = new Map();
  const queries = [];
  const listeners = [];
  const document = {
    getElementById(id) {
      queries.push(id);
      if (!elements.has(id)) {
        const handlers = new Map();
        elements.set(id, {
          id,
          handlers,
          addEventListener(type, handler) {
            listeners.push({ element: id, type, handler });
            handlers.set(type, handler);
          },
        });
      }
      return elements.get(id);
    },
  };
  return withP2EsmCase({
    globals: { document },
    classic: (sandbox) => {
      sandbox.localStorage.setItem('agentdev-theme', stored.theme || 'dark');
      sandbox.localStorage.setItem('agentdev-language', stored.language || 'zh');
    },
  }, async (c) => {
    await c.load('public/src/app-core.js');
    if (beforeDomain) await beforeDomain(c);
    return callback({ ctx: c.window, elements, queries, listeners, c });
  });
}

test('app-core registers persisted language/theme and panel width before ESM claim; classic writes survive claim', async () => {
  await withCore({ stored: { language: 'en', theme: 'light' }, beforeDomain(c) {
    // app-core 已注册桥键、目标域尚未 claim：此时 classic 写方经访问器落进哑存储，
    // 随后被 claim 吸收（与迁移前「注册相位 → claim」的先后完全一致）。
    assert.equal(c.read('currentLanguage'), 'en');
    assert.equal(c.read('currentTheme'), 'light');
    c.read("currentLanguage = 'fr'; currentTheme = 'dark'; featurePanelWidth = 510;");
    assert.equal(c.read('currentLanguage'), 'fr');
    assert.equal(c.read('currentTheme'), 'dark');
    assert.equal(c.read('featurePanelWidth'), 510);
  } }, async ({ ctx, c }) => {
    const language = { module: await c.load('public/src/modules/i18n-environment-state.js') };
    const panel = { module: await c.load('public/src/modules/panel-layout-state.js') };
    assert.equal(language.module.getCurrentLanguage(), 'fr');
    assert.equal(language.module.getCurrentTheme(), 'dark');
    assert.equal(panel.module.getFeaturePanelWidth(), 510);

    ctx.run("currentLanguage = 'zh'; currentTheme = 'light'; featurePanelWidth = 640;");
    assert.equal(language.module.getCurrentLanguage(), 'zh');
    assert.equal(language.module.getCurrentTheme(), 'light');
    assert.equal(panel.module.getFeaturePanelWidth(), 640);

    language.module.setCurrentLanguage('en');
    language.module.setCurrentTheme('dark');
    panel.module.setFeaturePanelWidth(470);
    assert.equal(ctx.run('currentLanguage'), 'en');
    assert.equal(ctx.run('currentTheme'), 'dark');
    assert.equal(ctx.run('featurePanelWidth'), 470);
  });
});

test('DOM 引用域迁出 app-core：app-core 求值不查询元素，dom-refs 在模块相查询一次并绑定监听', async () => {
  await withCore({}, async ({ ctx, elements, queries, listeners, c }) => {
    // P4 T1：DOM 引用区（含三条顶层 click 监听）已迁 modules/dom-refs.js。
    // app-core 求值（已是模块相）不再碰 DOM。
    assert.equal(queries.length, 0, 'app-core 不再做 DOM 查询');
    assert.equal(listeners.length, 0, 'app-core 不再安装 click 监听');

    await c.load('public/src/modules/dom-refs.js');
    const domQueries = [...queries];
    const domListenerCount = listeners.length;
    assert.deepEqual(domQueries.filter((id) => [
      'project-docset-toggle', 'chat-process-toggle', 'project-docset-overlay',
    ].includes(id)), [
      'project-docset-toggle', 'chat-process-toggle', 'project-docset-overlay',
    ]);

    const calls = [];
    ctx.toggleProjectDocsetOverlay = (value) => calls.push(['docset', value]);
    ctx.toggleChatProcessVisibility = () => calls.push(['process']);
    elements.get('project-docset-toggle').handlers.get('click')();
    elements.get('chat-process-toggle').handlers.get('click')();
    elements.get('project-docset-overlay').handlers.get('click')({ target: elements.get('project-docset-overlay') });
    assert.deepEqual(calls, [['docset', undefined], ['process'], ['docset', false]]);

    // 后续 state claim 不重跑 DOM 查询 / 监听安装（元素引用是同一批）
    const language = { module: await c.load('public/src/modules/i18n-environment-state.js') };
    const panel = { module: await c.load('public/src/modules/panel-layout-state.js') };
    assert.equal(language.module.getCurrentLanguage(), 'zh');
    assert.equal(panel.module.getFeaturePanelWidth(), 460);
    assert.equal(queries.length, domQueries.length);
    assert.equal(listeners.length, domListenerCount);
    elements.get('project-docset-toggle').handlers.get('click')();
    assert.deepEqual(calls.at(-1), ['docset', undefined]);
  });
});
