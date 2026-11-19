/**
 * 参数配置页的字段文案契约
 *
 * manifest 里字段的人读文案有两种既有写法：字符串，或 { zh, en } 双语对象
 * （agentero 这类早期包用 label/description 双语）。编辑器的渲染必须把两种写法
 * 都解析成当前语言的文本；把对象直接拼进模板会渲染成 "[object Object]"。
 *
 * 装载路线：真实 ESM（feature-config-editor → feature-setup-core / i18n /
 * claw-select），fetch 由用例提供，断言落在编辑器真实写出的 HTML 上。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withP2EsmCase } from './helpers/p2-esm-case.js';

const BILINGUAL_MANIFEST = {
  features: [{
    featureName: 'agentero',
    manifest: {
      name: 'Agentero',
      settings: {
        properties: {
          vaultPath: {
            type: 'string',
            label: { zh: 'Vault 路径', en: 'Vault path' },
            description: { zh: '文献库根目录', en: 'Vault root directory' },
          },
        },
        sections: [{ id: 'main', title: { zh: '文献库', en: 'Library' }, properties: ['vaultPath'] }],
      },
    },
  }],
  mountedExtras: ['agentero'],
};

function makeFetch() {
  return async (url) => {
    const target = String(url);
    if (target.startsWith('/protoclaw/system_feature_manifests')) {
      return { ok: true, status: 200, json: async () => BILINGUAL_MANIFEST };
    }
    if (target.startsWith('/protoclaw/feature_config/resolved')) {
      return { ok: true, status: 200, json: async () => ({ layers: [{ id: 'agent', label: '编程小助手', sparse: {} }], accumulatedFields: [] }) };
    }
    if (target === '/protoclaw/shell_availability') return { ok: false, status: 0, json: async () => ({}) };
    if (target === '/protoclaw/model_config') return { ok: true, status: 200, json: async () => ({ presets: [] }) };
    return { ok: true, status: 200, json: async () => ({}) };
  };
}

function createHost() {
  const pane = () => ({ innerHTML: '', scrollTop: 0, querySelector: () => null, querySelectorAll: () => [] });
  const main = pane();
  const nav = pane();
  return {
    main,
    nav,
    host: {
      innerHTML: '',
      querySelector: (selector) => {
        const text = String(selector);
        if (text.includes('data-fce-main')) return main;
        if (text.includes('data-fce-nav')) return nav;
        return null;
      },
      querySelectorAll: () => [],
      appendChild() {},
      addEventListener() {},
    },
  };
}

test('双语 label/description 渲染为当前语言文本，不出现 [object Object]', async () => {
  const { host, main, nav } = createHost();
  await withP2EsmCase({
    globals: { document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} }, fetch: makeFetch() },
    classic: (sandbox) => {
      // 编辑器只依赖 rAF（渲染尾部增强）与少量平台全局，不需要整条 classic 链
      sandbox.run('requestAnimationFrame = (callback) => { callback(); return 0; };'
        + 'applyTheme = () => {}; applyLanguage = () => {};');
      sandbox.ClawFW = { actions: { registerMany() {}, bindEventType() {}, invoke() {} } };
    },
  }, async (c) => {
    const i18n = await c.load('public/src/modules/i18n-environment-state.js');
    i18n.setCurrentLanguage('zh');
    const { createFeatureConfigEditor } = await c.load('public/src/modules/feature-config-editor.js');
    const editor = createFeatureConfigEditor({ host, scopeId: 'agent' });
    await editor.open();
    const html = String(main.innerHTML);

    assert.doesNotMatch(html, /\[object Object\]/, '双语对象不得被直接字符串化');
    assert.match(html, /Vault 路径/, '名称取 label.zh');
    assert.match(html, /文献库根目录/, '说明取 description.zh');
    // 分区标题同样解析（否则左栏导航显示对象）
    assert.match(String(nav.innerHTML), /文献库/);
  });
});
