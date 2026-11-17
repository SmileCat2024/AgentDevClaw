/**
 * P2 批次 2（右栏注册表与插件底座）交付钉子 —— 只覆盖本批真实迁出的三个 ESM 模块。
 *
 * 迁出边界（本批最终形态）：
 *   feature-catalog / git-graph / feature-ui-registry  →  ESM（本测试真实 import）
 *   right-panel-registry / panel-plugins / rail-customize → 保持唯一 classic 原实现
 *   （首屏同步交互与 classic 相声明不可延后；其行为由各自既有 classic 测试覆盖）
 *
 * 钉什么：
 *   1. 批次入口真实装载三模块后的行为（GitGraph 协议、动态面板声明、catalog 拉取）。
 *   2. 兼容面：既有公开命名空间（GitGraph / ClawFW.featureCatalog / ClawFW.featureUi）
 *      与命名导出同源；无新增散装全局。
 *   3. 边界：三个 classic 文件未被转成 ESM、入口不 import 它们、index.html 标签保留。
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createFrontendSandbox } from './helpers/frontend-vm.js';
import { loadModuleOnce } from './helpers/esm-module-loader.js';

const DECLARATIONS_API = '/api/feature-ui/declarations';
const CATALOG_API = '/api/feature-catalog';

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const CATALOG = {
  schemaVersion: 1,
  capabilities: [{ id: 'tools' }],
  provenances: ['builtin'],
  types: [{ id: 'ability', collapsed: false }],
  features: [{ name: 'shell', displayName: { zh: 'Shell', en: 'Shell' }, type: 'ability', capabilities: ['tools'], provenance: 'builtin', group: 'bundled' }],
};

const DECL = {
  panelId: 'demo-panel',
  pluginId: 'panel-demo',
  package: 'demo-plugin',
  version: '1.0.0',
  url: '/protoclaw/feature-assets/demo-plugin/1.0.0/index.js',
  meta: { label: { zh: '演示', en: 'Demo' }, order: 70, when: {} },
};

let restoreGlobals = null;

function bindSandboxGlobals(ctx) {
  const prev = { window: globalThis.window, document: globalThis.document };
  globalThis.window = ctx.window;
  globalThis.document = ctx.document;
  return () => {
    if (prev.window === undefined) delete globalThis.window; else globalThis.window = prev.window;
    if (prev.document === undefined) delete globalThis.document; else globalThis.document = prev.document;
  };
}

describe('P2 W1-2 批次入口：三个 ESM 模块的真实行为', () => {
  let ctx;
  let fetchCalls;
  let setCurrentLanguage;

  before(async () => {
    fetchCalls = [];
    ctx = createFrontendSandbox({
      fetch: async (url) => {
        const target = String(url);
        fetchCalls.push(target);
        if (target.startsWith(DECLARATIONS_API)) {
          return { ok: true, json: async () => ({ ok: true, declarations: [DECL] }) };
        }
        if (target.startsWith(CATALOG_API)) {
          return { ok: true, json: async () => CATALOG };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      },
    });
    // 宿主注册表仍是 classic（feature-ui-registry 经 window.ClawHost.panels 声明 stub）
    ctx.loadSource('public/src/modules/claw-host.js');
    ctx.loadSource('public/src/modules/right-panel-registry.js');

    restoreGlobals = bindSandboxGlobals(ctx);
    await loadModuleOnce('public/src/modules/p2-w1-2-panel-bootstrap.js', { installGlobals: false });
    ({ setCurrentLanguage } = await import('../public/src/modules/i18n-environment-state.js'));
    // 生产由 app-core 的 defineKey 初值给出语言，claim 时吸收进状态域；测试直接置同一初值
    setCurrentLanguage('zh');
    await settle();
  });

  after(() => {
    // 停掉声明轮询后解绑沙箱全局
    ctx.window.ClawFW?.featureUi?.stop();
    setCurrentLanguage('zh');
    if (restoreGlobals) { restoreGlobals(); restoreGlobals = null; }
  });

  it('git-graph：window.GitGraph 协议可用（URL 装载插件的既有消费面）', () => {
    const graph = ctx.window.GitGraph;
    assert.equal(typeof graph.computeLanes, 'function');
    assert.equal(typeof graph.buildGraphSvg, 'function');
    assert.equal(typeof graph.rowWidth, 'function');
    assert.equal(graph.constants.ROW_H, 26);

    const lanes = graph.computeLanes([{ hash: 'a', parents: ['b'] }, { hash: 'b', parents: [] }]);
    assert.equal(lanes.rows.length, 2);
    assert.equal(lanes.laneCount, 1);
  });

  it('feature-ui-registry：动态面板声明经声明 API 拉取后进 ClawHost 注册表', async () => {
    assert.ok(fetchCalls.some((url) => url.startsWith(DECLARATIONS_API)), '应请求声明 API');
    const panel = ctx.window.ClawHost.panels.get('demo-panel');
    assert.ok(panel && panel.stub, '动态声明的 stub 应已注册');
    assert.equal(panel.stub.url, DECL.url);
    assert.equal(panel.title(), '演示', '标题按宿主语言实时取值（直接 import 已迁移 i18n 域）');
    setCurrentLanguage('en');
    assert.equal(panel.title(), 'Demo');
    setCurrentLanguage('zh');
  });

  it('feature-catalog：命名空间协议可用且拉取走 window.fetch', async () => {
    const fc = ctx.window.ClawFW.featureCatalog;
    assert.equal(typeof fc.loadFeatureCatalog, 'function');
    assert.equal(typeof fc.groupFeaturesByType, 'function');

    const catalog = await fc.loadFeatureCatalog(true);
    assert.ok(fetchCalls.some((url) => url.startsWith(CATALOG_API)), '应请求 catalog API');
    assert.ok(Array.isArray(catalog.features));
    assert.equal(fc.getFeatureCatalogSnapshot(), catalog, '快照与返回值同一引用（模块级缓存唯一 owner）');

    const groups = fc.groupFeaturesByType([{ name: 'shell', tools: [], toolCount: 1 }], catalog);
    assert.equal(groups[0].id, 'ability');
  });

  it('兼容面与命名导出同源（同一函数引用，不是同名拷贝）', async () => {
    const graphLoad = await loadModuleOnce('public/src/modules/git-graph.js');
    assert.equal(globalThis.window.GitGraph.computeLanes, graphLoad.module.computeLanes);
    assert.equal(globalThis.window.GitGraph.constants, graphLoad.module.constants);
    graphLoad.cleanup();

    const catalogLoad = await loadModuleOnce('public/src/modules/feature-catalog.js', {
      window: { fetch: async () => ({ ok: false, status: 404, json: async () => ({}) }), ClawFW: {} },
    });
    assert.equal(globalThis.window.ClawFW.featureCatalog.loadFeatureCatalog, catalogLoad.module.loadFeatureCatalog);
    assert.equal(globalThis.window.ClawFW.featureCatalog.groupFeaturesByType, catalogLoad.module.groupFeaturesByType);
    catalogLoad.cleanup();

    const uiLoad = await loadModuleOnce('public/src/modules/feature-ui-registry.js', {
      window: {
        fetch: async () => ({ ok: true, json: async () => ({ ok: true, declarations: [] }) }),
        ClawFW: {},
        setInterval: (fn, ms) => setInterval(fn, ms),
        clearInterval: (id) => clearInterval(id),
      },
    });
    assert.equal(globalThis.window.ClawFW.featureUi.refresh, uiLoad.module.refresh);
    assert.equal(globalThis.window.ClawFW.featureUi.stop, uiLoad.module.stop);
    uiLoad.module.stop();
    uiLoad.cleanup();
  });

  it('迁出边界：三个 classic 文件仍是 classic，入口不 import 它们', () => {
    const entry = fs.readFileSync(
      new URL('../public/src/modules/p2-w1-2-panel-bootstrap.js', import.meta.url), 'utf8');
    for (const classic of ['right-panel-registry', 'panel-plugins', 'rail-customize']) {
      assert.doesNotMatch(entry, new RegExp(`import '\\./${classic}\\.js'`),
        `批次入口不得 import classic 文件 ${classic}.js`);
    }

    for (const classic of ['right-panel-registry', 'panel-plugins', 'rail-customize']) {
      const source = fs.readFileSync(
        new URL(`../public/src/modules/${classic}.js`, import.meta.url), 'utf8');
      assert.doesNotMatch(source, /^\s*(export\s+(default|function|const|let|class|\{))/m,
        `${classic}.js 应保持 classsic 原实现（无 ESM 导出）`);
    }

    // 首屏同步交互与 classic 相声明由原实现承担：它们的 classic 标签必须保留
    const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
    for (const classic of ['right-panel-registry', 'panel-plugins', 'rail-customize']) {
      assert.match(html, new RegExp(`<script src="\\./src/modules/${classic}\\.js"></script>`),
        `${classic}.js 的 classic 标签必须保留（接线时不得删除）`);
    }
  });

  it('本批不新增桥键：三个 ESM 文件不触碰 KernelState', () => {
    for (const module of ['feature-catalog', 'git-graph', 'feature-ui-registry']) {
      const source = fs.readFileSync(
        new URL(`../public/src/modules/${module}.js`, import.meta.url), 'utf8');
      assert.doesNotMatch(source, /KernelState\.(defineKey|claim)\(/,
        `${module}.js 不应注册/认领桥键（本批无新增桥债）`);
      assert.doesNotMatch(source, /window\.(currentLanguage|focusedAgentId|activeFeaturePanel)\b/,
        `${module}.js 不应经 window 晚绑定已迁移的状态键`);
    }
  });
});
