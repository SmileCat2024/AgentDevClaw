/**
 * P2 跨批测试地基验收：真实模块图在 withP2EsmCase 下的整图隔离。
 *
 * 选取两组当前已交付的模块，覆盖后续 35+ 跨批测试的两种典型形态：
 *   1. 导航纯 module（navigation-core）：无状态、依赖 fetch 与 classic
 *      window 命名空间，验证「真实 import + 命名导出注入 classic ctx」；
 *   2. feature-store → feature-config-editor → i18n-environment-state /
 *      markdown-utils：多层静态依赖 + 两个模块各自 claim 自己的桥域，
 *      验证同一 case 内共享 state owner、下一 case 整图重建且不撞桥键。
 *
 * 断言只取已交付契约（命名导出、语言驱动的既有文案、桥键可达性、KernelState
 * 统计）与隔离语义，不依赖本批源码的 import 写法或内部私有变量名。
 * classic 侧只用真实 classic 源（i18n.js 提供 window.t，KernelState 由
 * frontend-vm 的 installKernelState 装载），不复制生产桥逻辑。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { prepareClassicSandbox } from './p2-classic-hosts.js';

const NAVIGATION = 'public/src/modules/navigation-core.js';
const I18N_STATE = 'public/src/modules/i18n-environment-state.js';
const MARKDOWN_UTILS = 'public/src/modules/markdown-utils.js';
const FEATURE_EDITOR = 'public/src/modules/feature-config-editor.js';
const FEATURE_STORE = 'public/src/modules/feature-store.js';


function createDocumentStub() {
  const hosts = new Map();
  const makeElement = () => ({
    innerHTML: '',
    textContent: '',
    value: '',
    style: {},
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {},
    removeEventListener() {},
    appendChild() {},
    insertBefore() {},
    remove() {},
    replaceWith() {},
    focus() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getAttribute() { return null; },
    setAttribute() {},
  });
  return {
    hosts,
    document: {
      getElementById(id) {
        if (!hosts.has(id)) hosts.set(id, makeElement());
        return hosts.get(id);
      },
      createElement: () => makeElement(),
      createTextNode: (text) => ({ textContent: text }),
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
      body: makeElement(),
      documentElement: makeElement(),
      readyState: 'complete',
    },
  };
}

function createFeatureFetchStub() {
  const calls = [];
  const stub = async (url, options = {}) => {
    const target = String(url);
    calls.push({ url: target, method: options.method || 'GET' });
    if (target === '/api/feature-store/overview') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          mounts: { main: {} },
          builtin: [],
          packages: [{ package: '@agentdev/lsp', displayName: 'LSP', versions: [{ version: '1.0.0' }] }],
        }),
      };
    }
    if (target === '/api/feature-catalog') {
      return { ok: true, status: 200, json: async () => ({}) };
    }
    if (target.includes('/protoclaw/system_feature_manifests')) {
      return { ok: true, status: 200, json: async () => ({ features: [], mountedExtras: [] }) };
    }
    if (target.includes('/protoclaw/shell_availability')) {
      return { ok: true, status: 200, json: async () => ({}) };
    }
    if (target.includes('/protoclaw/model_config')) {
      return { ok: true, status: 200, json: async () => ({ presets: [] }) };
    }
    if (target.includes('/protoclaw/feature_config/resolved')) {
      return { ok: true, status: 200, json: async () => ({ layers: [], merged: {} }) };
    }
    return { ok: false, status: 0, json: async () => ({}) };
  };
  stub.calls = calls;
  return stub;
}

/** 编辑器宿主的 querySelector 必须稳定返回同一元素，否则拿不到空态文案。 */
function createEditorHost() {
  const elements = new Map();
  const get = (selector) => {
    if (!elements.has(selector)) {
      elements.set(selector, {
        innerHTML: '',
        value: '',
        style: {},
        dataset: {},
        classList: { add() {}, remove() {}, toggle() {} },
        addEventListener() {},
        removeEventListener() {},
        querySelector() { return null; },
        querySelectorAll() { return []; },
        getAttribute() { return null; },
        setAttribute() {},
        focus() {},
      });
    }
    return elements.get(selector);
  };
  return {
    elements,
    innerHTML: '',
    querySelector: get,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
  };
}

const featureCaseOptions = () => {
  const { document, hosts } = createDocumentStub();
  const fetchStub = createFeatureFetchStub();
  const actions = {
    handlers: {},
    registerMany(handlers) { Object.assign(this.handlers, handlers); },
    bindEventType() {},
    invoke(name, element) { return this.handlers[name]?.(element); },
  };
  return {
    hosts,
    fetchStub,
    options: {
      classic: (sandbox) => {
        // feature-store 的整条静态链（ph-settings → 会话/项目编排 → agent-loader-host）
        // 依赖 classic 相的真实宿主工厂（createAgentCallStatesHost 读 runtime-status 的
        // 词法容器、createSessionViewCommitHost 在 session-view-state、
        // createRuntimeSwitchHost 在 app-main）：按 index.html 的真实先行脚本序装载。
        prepareClassicSandbox(sandbox);
      },
      globals: {
        fetch: fetchStub,
        document,
        ClawFW: { actions, phProjectEntities: { projects: [] } },
      },
    },
  };
};

describe('导航纯 module：真实 import + 导出注入 classic ctx', () => {
  test('同一 case 内是同一实例；fetch 走 case 注入面；注入面与生产 window 桥同源', async () => {
    const calls = [];
    let seq = 0;
    const fetchStub = async (url) => {
      calls.push(String(url));
      seq += 1;
      return { ok: true, status: 200, json: async () => ({ ready: true, agent: { runtime_session_id: `rt-${seq}` } }) };
    };

    const evidence = await withP2EsmCase({ globals: { fetch: fetchStub } }, async (c) => {
      const nav = await c.load(NAVIGATION);
      const again = await c.load(NAVIGATION);
      assert.equal(again, nav, '同一 case 同一路径返回同一命名空间');

      for (const name of ['waitForRuntimeReady', 'waitForRemoteRuntimeRef',
        'resolveHostAgentId', 'extractRuntimeId', 'resolveStoppedRuntimeFallback']) {
        assert.equal(typeof nav[name], 'function', `${name} 应是命名导出`);
      }

      const agent = await nav.waitForRuntimeReady({ agentId: 'agent-a', sessionId: 'sess-a', attempts: 1, intervalMs: 1 });
      assert.equal(agent.runtime_session_id, 'rt-1');
      assert.deepEqual(calls, ['/protoclaw/runtime_status?agentId=agent-a&sessionId=sess-a']);

      // 模块顶层的 window.NavigationCore（生产 classic 消费方协议）与命名导出同源
      assert.equal(c.read('typeof NavigationCore.waitForRuntimeReady'), 'function');
      c.expose('NavExports', nav);
      assert.equal(
        c.read('NavExports.waitForRuntimeReady === NavigationCore.waitForRuntimeReady'),
        true,
        '注入 classic ctx 的导出面必须就是模块实例本身，不是副本',
      );
      assert.equal(c.read('typeof NavExports.extractRuntimeId'), 'function');
      return nav;
    });
    assert.equal(typeof evidence.waitForRuntimeReady, 'function');
    assert.equal(typeof globalThis.window, 'undefined', 'case 结束后全局 window 必须撤走');
  });
});

describe('feature-store → editor → i18n / markdown：共享 owner 与整图重建', () => {
  test('同一 case 内 i18n owner 跨消费方共享；桥键可达；下一 case 整图独立', async () => {
    const first = featureCaseOptions();
    let firstI18n;
    let firstStore;
    let firstEditor;
    let firstStats;

    await withP2EsmCase(first.options, async (c) => {
      // 桥键是本 case 的图装载后才注册：装载前不存在
      assert.equal(c.read('typeof phOpenFeatureStore'), 'undefined');

      firstI18n = await c.load(I18N_STATE);
      const markdown = await c.load(MARKDOWN_UTILS);
      firstEditor = await c.load(FEATURE_EDITOR);
      firstStore = await c.load(FEATURE_STORE);

      assert.equal(await c.load(I18N_STATE), firstI18n, 'i18n owner 在同一 case 内是同一实例');
      // escapeHtml 是 markdown-utils 自身的实现与命名导出（原 classic bootstrap 已并入）
      assert.equal(markdown.escapeHtml('<b>&"'), '&lt;b&gt;&amp;&quot;');

      firstStats = JSON.parse(c.read('JSON.stringify(KernelState.stats())'));
      assert.ok(firstStats.registeredKeys > 0);
      assert.ok(firstStats.claimedKeys > 0);

      // 两个消费方都从 i18n owner 读语言
      firstI18n.setCurrentLanguage('en');
      await firstStore.phOpenFeatureStore('main');
      const storeHtml = String(first.hosts.get('ph-feature-store-host')?.innerHTML || '');
      assert.match(storeHtml, /Installed/, 'feature-store 的 _fsT 读到 en');

      const editorHost = createEditorHost();
      const instance = firstEditor.createFeatureConfigEditor({ host: editorHost, scopeId: 'global' });
      await instance.open();
      const mainHtml = String(editorHost.querySelector('[data-fce-main]').innerHTML || '');
      assert.match(mainHtml, /No configurable features are available\./, 'editor 的 _fceT 读到同一 owner 的 en');
      assert.equal(instance.instanceId, 'fce-1');
      instance.close();

      // 桥已注销的入口（phOpenFeatureStore 由 ph-settings 直接 import）不在 window 上；
      // 保留的 classic 入口（clawOpenPluginManager）经访问器可达。
      assert.equal(c.read('typeof phOpenFeatureStore'), 'undefined', '改 import 的入口已撤桥');
      assert.equal(c.read('typeof clawOpenPluginManager'), 'function', '装载后桥键在本 case window 上可达');
    });

    // 第二个 case：全新沙箱 + 全新图；不重复 claim（重复会直接抛错）
    const second = featureCaseOptions();
    await withP2EsmCase(second.options, async (c) => {
      assert.equal(c.read('typeof clawOpenPluginManager'), 'undefined', '上一 case 的桥键不得出现在新 window');
      const i18n = await c.load(I18N_STATE);
      const editor = await c.load(FEATURE_EDITOR);
      const store = await c.load(FEATURE_STORE);

      assert.notEqual(store, firstStore, '入口是新一代实例');
      assert.notEqual(editor, firstEditor);
      assert.notEqual(i18n, firstI18n);
      // 语言初值由 classic 相（app-core 注册 i18n 桥键真初值）播种，与本 case 的图
      // 一致；断言点是不继承上一 case 的 'en'——新图从 classic 播种值重新开始。
      assert.equal(i18n.getCurrentLanguage(), 'zh', 'i18n 状态不继承上一 case');
      assert.notEqual(i18n.getCurrentLanguage(), 'en');
      assert.equal(firstI18n.getCurrentLanguage(), 'en', '上一 case 的图仍持有自己的状态');

      const stats = JSON.parse(c.read('JSON.stringify(KernelState.stats())'));
      assert.deepEqual(stats, firstStats, '同一批模块在新 case 重新注册/认领同一组键');

      // 新 case 的语言写回只影响新图
      i18n.setCurrentLanguage('zh');
      await store.phOpenFeatureStore('main');
      const storeHtml = String(second.hosts.get('ph-feature-store-host')?.innerHTML || '');
      assert.match(storeHtml, /已装配/, '新 case 的消费方读新 owner');

      const editorHost = createEditorHost();
      const instance = editor.createFeatureConfigEditor({ host: editorHost, scopeId: 'global' });
      await instance.open();
      const mainHtml = String(editorHost.querySelector('[data-fce-main]').innerHTML || '');
      assert.match(mainHtml, /当前没有可配置的 Feature。/, 'editor 的模块私有计数器与语言都已重置');
      assert.equal(instance.instanceId, 'fce-1', '模块私有 _fceSeq 从 1 重新开始（整图重建）');
      instance.close();
    });
  });
});
