import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { loadModuleOnce } from './helpers/esm-module-loader.js';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

async function withCore({ stored = {}, beforeClaim } = {}, callback) {
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
  const ctx = createFrontendSandbox({ document });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = ctx;
  globalThis.document = ctx.document;
  ctx.localStorage.setItem('agentdev-theme', stored.theme || 'dark');
  ctx.localStorage.setItem('agentdev-language', stored.language || 'zh');
  ctx.loadSource('public/src/app-core.js');

  try {
    if (beforeClaim) await beforeClaim(ctx);
    return await callback({ ctx, elements, queries, listeners });
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
}

test('app-core registers persisted language/theme and panel width before ESM claim; classic writes survive claim', async () => {
  await withCore({ stored: { language: 'en', theme: 'light' }, beforeClaim(ctx) {
    assert.equal(ctx.run('currentLanguage'), 'en');
    assert.equal(ctx.run('currentTheme'), 'light');
    ctx.run("currentLanguage = 'fr'; currentTheme = 'dark'; featurePanelWidth = 510;");
    assert.equal(ctx.run('currentLanguage'), 'fr');
    assert.equal(ctx.run('currentTheme'), 'dark');
    assert.equal(ctx.run('featurePanelWidth'), 510);
  } }, async ({ ctx }) => {
    const language = await loadModuleOnce('public/src/modules/i18n-environment-state.js', { installGlobals: false });
    const panel = await loadModuleOnce('public/src/modules/panel-layout-state.js', { installGlobals: false });
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

test('DOM 引用域迁出 app-core：classic 相不再查询元素，dom-refs 在模块相查询一次并绑定监听', async () => {
  await withCore({}, async ({ ctx, elements, queries, listeners }) => {
    // P4 T1：DOM 引用区（含三条顶层 click 监听）已迁 modules/dom-refs.js。
    // classic 相（app-core 求值）不再碰 DOM。
    assert.equal(queries.length, 0, 'app-core 不再做 DOM 查询');
    assert.equal(listeners.length, 0, 'app-core 不再安装 click 监听');

    await loadModuleOnce('public/src/modules/dom-refs.js', { installGlobals: false });
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
    const language = await loadModuleOnce('public/src/modules/i18n-environment-state.js', { installGlobals: false });
    const panel = await loadModuleOnce('public/src/modules/panel-layout-state.js', { installGlobals: false });
    assert.equal(language.module.getCurrentLanguage(), 'zh');
    assert.equal(panel.module.getFeaturePanelWidth(), 460);
    assert.equal(queries.length, domQueries.length);
    assert.equal(listeners.length, domListenerCount);
    elements.get('project-docset-toggle').handlers.get('click')();
    assert.deepEqual(calls.at(-1), ['docset', undefined]);
  });
});
