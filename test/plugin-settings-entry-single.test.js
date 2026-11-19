/**
 * 插件参数入口唯一性（工作空间层只有一处编辑面）
 *
 * 契约：
 *   - 工作空间插件商店卡片的齿轮不再打开第二处配置弹窗，而是把设置页切到
 *     本空间的「参数配置」并选中该插件（同一层不允许两个编辑入口）；
 *   - 插件管理器（全局）是唯一编辑全局默认层的地方，弹窗里没有层 tab。
 *
 * 装载路线：真实 ESM 图（feature-store + ph-settings 与其静态环），动作经生产
 * 注册表分发；document 用按 id 复用的宿主表，断言落在真实渲染出的 HTML 上。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { prepareClassicSandbox } from './p2-classic-hosts.js';

const MANIFEST_ENTRY = {
  featureName: 'agentero',
  manifest: {
    name: 'Agentero',
    settings: {
      properties: {
        vaultPath: { type: 'string', label: { zh: 'Vault 路径', en: 'Vault path' }, description: { zh: '库根目录', en: 'Vault root' } },
      },
    },
  },
};

// 无参数声明的装配项：齿轮不应跳转（进到空页面还得自己返回）
const PLAIN_ENTRY = { featureName: 'plain-feature', manifest: { settings: { properties: {} } } };

const OVERVIEW = {
  mounts: { main: {
    agentero: { kind: 'package', package: '@agentdev/agentero', version: '0.3.1', missing: false },
    'plain-feature': { kind: 'builtin' },
  } },
  builtin: [],
  packages: [{ package: '@agentdev/agentero', displayName: 'Agentero', versions: [{ version: '0.3.1' }] }],
  envReady: { main: { hasEnv: true, ready: true } },
};

function makeFetch() {
  return async (url) => {
    const target = String(url);
    if (target === '/api/feature-store/overview') return { ok: true, status: 200, json: async () => OVERVIEW };
    if (target === '/api/feature-catalog') return { ok: true, status: 200, json: async () => ({ features: [] }) };
    if (target.includes('/protoclaw/system_feature_manifests')) {
      return { ok: true, status: 200, json: async () => ({ features: [MANIFEST_ENTRY, PLAIN_ENTRY], mountedExtras: ['agentero', 'plain-feature'] }) };
    }
    if (target.includes('/protoclaw/feature_config/resolved')) {
      return { ok: true, status: 200, json: async () => ({ layers: [{ id: 'global', label: '全局', sparse: {} }, { id: 'agent', label: '编程小助手', sparse: {} }] }) };
    }
    if (target.includes('/protoclaw/shell_availability') || target.includes('/protoclaw/model_config')) {
      return { ok: true, status: 200, json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
}

function makeElement(id = '') {
  return {
    id, innerHTML: '', textContent: '', value: '', style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {}, removeEventListener() {}, appendChild() {}, insertBefore() {},
    remove() {}, replaceWith() {}, focus() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    getAttribute() { return null; }, setAttribute() {},
  };
}

function createDocumentStub() {
  const hosts = new Map();
  return {
    hosts,
    document: {
      getElementById(id) {
        if (!hosts.has(id)) hosts.set(id, makeElement(id));
        return hosts.get(id);
      },
      createElement: () => makeElement(),
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
      createDocumentFragment: () => makeElement(),
      body: makeElement(),
      documentElement: makeElement(),
      activeElement: null,
      readyState: 'complete',
    },
  };
}

function createActionsStub() {
  return {
    handlers: {},
    registerMany(handlers) { Object.assign(this.handlers, handlers); },
    bindEventType() {},
    invoke(name, el) { return this.handlers[name]?.(el); },
  };
}

async function withStoreAndSettings(fn) {
  const { document, hosts } = createDocumentStub();
  const actions = createActionsStub();
  return withP2EsmCase({
    globals: { document, fetch: makeFetch() },
    classic: (sandbox) => {
      sandbox.run('window.__clawAuthReady = new Promise(() => {}); applyTheme = () => {}; applyLanguage = () => {};'
        + 'ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };'
        + 'setInterval = () => 0; clearInterval = () => {}; requestAnimationFrame = () => 0;'
        // ph-settings 的渲染入口读当前 agent（os 层）；用例提供一个稳定记录。
        + 'getCurrentAgentRecord = () => ({ id: "programming-helper" });');
      prepareClassicSandbox(sandbox);
      sandbox.t = (key) => key;
      sandbox.ClawFW = { actions };
    },
  }, async (c) => {
    const i18n = await c.load('public/src/modules/i18n-environment-state.js');
    i18n.setCurrentLanguage('zh');
    const store = await c.load('public/src/modules/feature-store.js');
    const settings = await c.load('public/src/modules/ph-settings.js');
    // 通知面是本用例的观察对象：真实 DOM toast 在最小 document 桩下不可断言，
    // 因此替换其 show（同一模块实例，ph-settings 持有同一对象引用）。
    const { ClawToast } = await c.load('public/src/modules/toast-notify.js');
    const toastCalls = [];
    ClawToast.show = (opts) => { toastCalls.push(opts); };
    return fn({ store, settings, hosts, actions, toastCalls });
  });
}

describe('插件参数入口唯一性', () => {
  it('商店卡片齿轮跳到本空间参数配置，不再自带第二个配置弹窗', async () => {
    await withStoreAndSettings(async ({ store, hosts, actions }) => {
      await store.phOpenFeatureStore('main');
      const storeHtml = String(hosts.get('ph-feature-store-host').innerHTML);
      assert.match(storeHtml, /data-action="phSettings\.openFeatureConfig" data-identity="main" data-name="agentero"/);
      assert.doesNotMatch(storeHtml, /data-action="featureStore\.openSettings"/,
        '工作空间商店不应再提供第二处参数编辑入口');

      // 点商店卡片的齿轮：收起商店，并整页切到本空间的「参数配置」子页
      await actions.invoke('phSettings.openFeatureConfig', { dataset: { name: 'agentero', identity: 'main' } });
      assert.equal(String(hosts.get('ph-feature-store-host').innerHTML), '', '商店应已收起');
      const settingsHtml = String(hosts.get('ph-settings-host').innerHTML);
      assert.match(settingsHtml, /ph-feature-config-host/, '设置页落在参数配置');
      // 子页形态：整页替换（无左栏、无页内分页器），头部有返回按钮
      assert.doesNotMatch(settingsHtml, /class="ph-settings-sidebar"/, '参数配置子页不渲染主左栏');
      assert.doesNotMatch(settingsHtml, /class="ph-settings-feature-tabs"/, '参数配置子页不渲染页内分页器');
      assert.match(settingsHtml, /data-action="phSettings\.switchFeatureSubTab" data-sub="mounts"/, '返回按钮回到功能配置');

      // 返回：回到本页「功能配置」，分页器与装配清单重新出现
      actions.invoke('phSettings.switchFeatureSubTab', { dataset: { sub: 'mounts' } });
      const backHtml = String(hosts.get('ph-settings-host').innerHTML);
      assert.match(backHtml, /class="ph-settings-feature-tabs"/);
      assert.match(backHtml, /ph-feature-mounts-host/);
      assert.doesNotMatch(backHtml, /ph-feature-config-host/);
    });
  });

  it('没有可配置参数的能力：不跳转，弹 toast 提示', async () => {
    await withStoreAndSettings(async ({ store, hosts, actions, toastCalls }) => {
      await store.phOpenFeatureStore('main');
      await actions.invoke('phSettings.openFeatureConfig', { dataset: { name: 'plain-feature', identity: 'main' } });

      assert.equal(toastCalls.length, 1, '应弹一次提示');
      assert.equal(toastCalls[0].status, 'warning');
      assert.match(String(toastCalls[0].title), /没有可配置的参数/);
      assert.notEqual(String(hosts.get('ph-feature-store-host').innerHTML), '', '商店保持打开，不跳转');
      assert.equal(hosts.get('ph-settings-host'), undefined, '设置页未渲染（没有发生跳转）');
    });
  });
});
