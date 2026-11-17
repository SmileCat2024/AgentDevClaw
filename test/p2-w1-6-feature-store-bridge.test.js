/**
 * P2 迁移批次 6（Feature 存储与配置编辑器）专属测试。
 *
 * 覆盖三类本批独有的承诺：
 *   1. 兼容面：仍有 classic 消费方的入口（clawOpenPluginManager）经 KernelState
 *      桥键可达，且 claim 后写入转发（classic 写方 = window 赋值）；已改直接
 *      import 的入口（phOpenFeatureStore / _fsRemoveFor / createFeatureConfigEditor /
 *      phOpenDirConfig / phOpenProjectConfig）桥已注销，断言钉在命名导出上。
 *   2. 真实行为：桥入口端到端驱动真实实现（商店/插件管理器渲染、挂载移除的层
 *      写回、项目/默认项目配置弹窗的 scope 解析与元数据补拉）。
 *   3. 显式依赖：escapeHtml 取自 markdown-utils.js 具名导出（markdown-utils 在
 *      模块执行时捕获 classic 相注册的 escapeHtml 桥键）；语言取自
 *      i18n-environment-state.js 命名导出（不是裸 currentLanguage 全局）；其余
 *      classic 依赖（getCurrentAgentRecord / t）是 window 晚绑定；
 *      ensurePhProjectEntitiesLoaded 走 project-data 命名导出（真实 HTTP 数据面）。
 *
 * 装载路线：一次用例 = 一份真实沙箱 window + 一张真实 ESM 图（`withP2EsmCase`
 * 的 case 级命名空间）。本批入口与静态依赖（含 feature-store ↔ ph-settings 环）
 * 落在同一代实例上；静态依赖的 defineKey / claim 每个 case 都在本 case 的
 * KernelState 上重新发生，模块状态与 window 状态不分叉。classic 相按 index.html
 * 的先行脚本序装载真实实现（宿主工厂是生产代码本身）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { prepareClassicSandbox } from './p2-classic-hosts.js';
const T_MAP = { feature_type_capability: '能力', feature_cat_unmapped: '待归类' };

const MANIFEST_ENTRY = {
  featureName: 'agentero',
  manifest: { name: 'Agentero', settings: { properties: { vaultPath: { type: 'string' } } } },
};

const RESOLVED = {
  layers: [
    { id: 'global', label: '全局', sparse: { agentero: { vaultPath: '/vault/a' } } },
    { id: 'agent', label: '编程小助手', sparse: { 'stylized-output': { intensity: 2 }, agentero: { vaultPath: '/vault/b' } } },
  ],
  merged: {},
};

const OVERVIEW = {
  mounts: { main: { agentero: { kind: 'package', package: '@agentdev/agentero', version: '0.3.1' } } },
  builtin: [],
  packages: [{ package: '@agentdev/lsp', displayName: 'LSP', versions: [{ version: '1.0.0' }] }],
};

/** feature-catalog 的 HTTP fixture（真实分组逻辑的数据面）。 */
const CATALOG = {
  provenances: ['bundled', 'installed'],
  types: [{ id: 'ability' }, { id: 'governance' }, { id: 'interface' }, { id: 'system' }],
  features: [
    { name: 'lsp', type: 'ability', displayName: { zh: 'LSP', en: 'LSP' }, provenance: 'bundled', capabilities: ['tools'], group: 'bundled' },
    { name: 'agentero', type: 'interface', displayName: { zh: 'Agentero', en: 'Agentero' }, provenance: 'installed', capabilities: ['tools'], group: 'installed' },
  ],
};

function makeFetch() {
  const calls = [];
  const stub = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });
    if (String(url) === '/api/feature-store/overview') {
      return { ok: true, status: 200, json: async () => stub.overviewNow };
    }
    if (String(url) === '/api/feature-catalog') {
      return { ok: true, status: 200, json: async () => CATALOG };
    }
    if (String(url).includes('/protoclaw/system_feature_manifests')) {
      return { ok: true, status: 200, json: async () => ({ features: [MANIFEST_ENTRY], mountedExtras: ['agentero'] }) };
    }
    if (String(url).includes('/protoclaw/shell_availability')) {
      return { ok: true, status: 200, json: async () => ({ bash: { available: false }, powershell: { available: false } }) };
    }
    if (String(url).includes('/protoclaw/model_config')) {
      return { ok: true, status: 200, json: async () => ({ presets: [] }) };
    }
    if (String(url).includes('/protoclaw/feature_config/resolved')) {
      return { ok: true, status: 200, json: async () => RESOLVED };
    }
    if (String(url).includes('/protoclaw/feature_config/layer')) {
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    if (String(url).includes('/protoclaw/ph_project/projects')) {
      return { ok: true, status: 200, json: async () => stub.projectEntitiesNow };
    }
    return { ok: false, status: 0, json: async () => ({}) };
  };
  stub.calls = calls;
  stub.overviewNow = OVERVIEW;
  stub.projectEntitiesNow = { projects: [] };
  return stub;
}

function createDocumentStub() {
  const hosts = new Map();
  const makeElement = () => ({
    innerHTML: '',
    textContent: '',
    value: '',
    id: '',
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
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
      body: makeElement(),
      documentElement: makeElement(),
      activeElement: null,
      readyState: 'complete',
    },
  };
}

/**
 * 一次用例 = 一份真实沙箱 window + 一张真实 ESM 图。
 * classic 相（prepareClassicSandbox）提供真实宿主工厂与分发器面；用例自己提供
 * 分发器注册表（要按 action 名驱动本批的真实处理函数）与项目元数据面。
 */
async function withBatchCase(fn) {
  const { document, hosts } = createDocumentStub();
  const fetchStub = makeFetch();
  const actions = {
    handlers: {},
    registerMany(handlers) { Object.assign(this.handlers, handlers); },
    bindEventType() {},
    invoke(name, el) { return this.handlers[name]?.(el); },
  };
  return withP2EsmCase({
    globals: { document, fetch: fetchStub },
    classic: (sandbox) => {
      prepareClassicSandbox(sandbox);
      // escapeHtml 是 markdown-utils 自己的实现与桥键（原 classic bootstrap 已并入），
      // 本批模块 import 的是 markdown-utils 的具名导出，用例不再预注册。
      sandbox.t = (key) => T_MAP[key] || key;
      // feature-store 的 catalog 能力已是直接 import（feature-catalog 真实模块，
      // 数据面经 /api/feature-catalog HTTP 桩），这里只提供动作与项目元数据面
      sandbox.ClawFW = {
        actions,
        phProjectEntities: { projects: [] },
      };
    },
  }, async (c) => {
    const i18n = await c.load('public/src/modules/i18n-environment-state.js');
    i18n.setCurrentLanguage('zh');
    const core = await c.load('public/src/modules/feature-setup-core.js');
    const dirDialog = await c.load('public/src/modules/dir-config-dialog.js');
    const store = await c.load('public/src/modules/feature-store.js');
    const editor = await c.load('public/src/modules/feature-config-editor.js');
    env = { store, editor, dirDialog, core, hosts, actions, fetchStub, i18n };
    try {
      return await fn();
    } finally {
      env = undefined;
    }
  });
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

/** 当前用例的宿主面（withBatchCase 内有效）。 */
let env;

describe('P2-6 兼容桥：仍有 classic 消费方的入口', () => {
  it('保留的 classic 入口经 window 访问器可达；已改 import 的入口桥已注销', () => withBatchCase(async () => {
    assert.equal(typeof window.clawOpenPluginManager, 'function', 'clawOpenPluginManager 应经桥键提供');
    // 消费方（ph-settings / ph-project-actions / 编辑器）已改直接 import → 桥注销
    for (const key of ['phOpenFeatureStore', '_fsRemoveFor', 'createFeatureConfigEditor',
      'phOpenDirConfig', 'phOpenProjectConfig']) {
      assert.equal(window[key], undefined, `${key} 的窗口消费面已归零，不应造桥`);
    }
    assert.equal(typeof env.store.phOpenFeatureStore, 'function');
    assert.equal(typeof env.store._fsRemoveFor, 'function');
    assert.equal(typeof env.editor.createFeatureConfigEditor, 'function');
    assert.equal(typeof env.dirDialog.phOpenDirConfig, 'function');
    assert.equal(typeof env.dirDialog.phOpenProjectConfig, 'function');
    // 消费面只在模块自身模板/动作表的入口收敛为模块私有：不上桥、不在 window 上
    for (const key of ['_fsOpenSettings', '_fsCloseSettings', 'phCloseFeatureStore',
      'phCloseDirConfig', '_fsSettings', '_fsState', '_pmState', '_dirConfigEditor']) {
      assert.equal(window[key], undefined, `${key} 不应出现在 window 上`);
    }
    // 桥键是访问器（configurable，供终局撤除），不是数据属性
    const descriptor = Object.getOwnPropertyDescriptor(window, 'clawOpenPluginManager');
    assert.equal(typeof descriptor.get, 'function');
    assert.equal(typeof descriptor.set, 'function');
    assert.equal(descriptor.configurable, true);
    assert.equal(descriptor.enumerable, false);
  }));

  it('claim 后 classic 写方（window 赋值）转发进本域桥状态', () => withBatchCase(async () => {
    const marker = () => 'classic-written';
    window.clawOpenPluginManager = marker;
    assert.equal(window.clawOpenPluginManager, marker);
    // 复原（同一桥键，无重复注册）
    window.clawOpenPluginManager = env.store.clawOpenPluginManager;
    assert.equal(window.clawOpenPluginManager, env.store.clawOpenPluginManager);
  }));

  it('store 入口与 clawOpenPluginManager 驱动真实渲染', () => withBatchCase(async () => {
    env.i18n.setCurrentLanguage('en');
    await env.store.phOpenFeatureStore('main');
    const storeHtml = String(env.hosts.get('ph-feature-store-host').innerHTML);
    assert.match(storeHtml, /data-category="all"/);
    // 类型分档来自 feature-catalog HTTP 数据（真实分组逻辑，不是桩）
    assert.match(storeHtml, /data-category="ability"/);
    assert.match(storeHtml, /data-category="interface"/);
    assert.match(storeHtml, /data-name="agentero"/);
    assert.match(storeHtml, /fs-status-dot-installed"><\/span>Installed</);

    await window.clawOpenPluginManager();
    const managerHtml = String(env.hosts.get('claw-plugin-manager-host').innerHTML);
    assert.match(managerHtml, /Repository Plugins/);
  }));

  it('escapeHtml 取自 markdown-utils 真实导出：卡片转义生效，且不受 window.escapeHtml 事后替换影响', () => withBatchCase(async () => {
    env.fetchStub.overviewNow = {
      mounts: { main: {} },
      builtin: [],
      packages: [{
        // 无 scope 前缀 → runtimeKey 即包名，带特殊字符以覆盖卡片 title 属性转义
        package: 'evil<img src=x onerror=alert(1)>',
        displayName: '<img src=x onerror=alert(1)>',
        description: 'a "b" & c',
        versions: [{ version: '1.0.0' }],
      }],
    };
    await env.store.phOpenFeatureStore('main');
    const html = String(env.hosts.get('ph-feature-store-host').innerHTML);
    // 真实导出用于 HTML 转义：标签与属性引号被实体化
    assert.doesNotMatch(html, /<img src=x/);
    assert.match(html, /title="evil&lt;img src=x onerror=alert\(1\)&gt;"/);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.match(html, /a &quot;b&quot; &amp; c/);

    // 模块用的是 import 绑定（markdown-utils 执行时捕获的经典相实现），不是运行期读 window
    const previous = window.escapeHtml;
    try {
      window.escapeHtml = (value) => `MARK${value}`;
      await env.store.phOpenFeatureStore('main');
      const after = String(env.hosts.get('ph-feature-store-host').innerHTML);
      assert.doesNotMatch(after, /MARK/);
      assert.match(after, /&lt;img src=x onerror=alert\(1\)&gt;/);
    } finally {
      window.escapeHtml = previous;
    }
  }));

  it('_fsRemoveFor 走层读改写：删除目标键、保留同层其他字段', () => withBatchCase(async () => {
    await env.store._fsRemoveFor('main', 'agentero');
    const put = env.fetchStub.calls.find((call) => call.method === 'PUT');
    assert.equal(put.body.layerId, 'agent');
    assert.equal(put.body.content.agentero, undefined);
    assert.equal(put.body.content['stylized-output'].intensity, 2);
    // 写后刷新共享装配事实（右侧 Features 面板缓存失效入口）
    assert.ok(env.fetchStub.calls.some((call) => call.url === '/api/feature-store/overview'));
  }));
});

describe('P2-6 项目层配置弹窗（dir-config-dialog）', () => {
  it('默认项目层：phOpenDirConfig(dir) 打开 dir:<path> scope 编辑器', () => withBatchCase(async () => {
    env.dirDialog.phOpenDirConfig('/proj/a');
    const dialogHtml = String(env.hosts.get('ph-dir-config-host').innerHTML);
    assert.match(dialogHtml, /项目设置 · 默认项目/);
    assert.match(dialogHtml, /\/proj\/a/);
    await tick();
    assert.ok(env.fetchStub.calls.some((call) => call.url.includes('/protoclaw/feature_config/resolved?agentId=programming-helper&dir=%2Fproj%2Fa')));
    window.ClawFW.actions.invoke('dirConfig.close');
    assert.equal(String(env.hosts.get('ph-dir-config-host').innerHTML), '');
  }));

  it('无参数时取当前目录（window.getCurrentAgentRecord 晚绑定）', () => withBatchCase(async () => {
    window.getCurrentAgentRecord = () => ({ workspace_state: { openDirectory: '/current/dir' } });
    env.dirDialog.phOpenDirConfig();
    const dialogHtml = String(env.hosts.get('ph-dir-config-host').innerHTML);
    assert.match(dialogHtml, /\/current\/dir/);
    window.ClawFW.actions.invoke('dirConfig.close');
  }));

  it('项目层：phOpenProjectConfig(prj_id) 用 projectId 解析层并呈现项目名', () => withBatchCase(async () => {
    window.ClawFW.phProjectEntities.projects = [{ id: 'prj_1', name: 'Proj One', openDirectory: '/work/one' }];
    env.dirDialog.phOpenProjectConfig('prj_1');
    const dialogHtml = String(env.hosts.get('ph-dir-config-host').innerHTML);
    assert.match(dialogHtml, /项目设置 · Proj One/);
    await tick();
    assert.ok(env.fetchStub.calls.some((call) => call.url.includes('projectId=prj_1')));
    // 非项目 id 直接忽略（不打开弹窗、不发请求）
    window.ClawFW.actions.invoke('dirConfig.close');
    const before = env.fetchStub.calls.length;
    env.dirDialog.phOpenProjectConfig('agent-123');
    assert.equal(env.fetchStub.calls.length, before);
  }));

  it('项目元数据未就绪：真实 ensurePhProjectEntitiesLoaded 补拉后重开', () => withBatchCase(async () => {
    // P2 项目/装配批：ensurePhProjectEntitiesLoaded 已由 project-data 直接 import，
    // window 桩不再参与——补拉走真实实现与真实 HTTP 数据面（ph_project/projects）。
    env.fetchStub.projectEntitiesNow = {
      projects: [{ id: 'prj_2', name: 'Late Proj', workDirectory: '/late' }],
    };
    env.dirDialog.phOpenProjectConfig('prj_2');
    // 元数据未就绪：不打开弹窗（宿主未渲染即空）
    assert.equal(String(env.hosts.get('ph-dir-config-host')?.innerHTML ?? ''), '');
    await tick();
    assert.match(String(env.hosts.get('ph-dir-config-host').innerHTML), /Late Proj/);
    assert.ok(
      env.fetchStub.calls.some((call) => call.url.includes('/protoclaw/ph_project/projects')),
      '真实补拉请求（project-data 实现，非 window 桩）',
    );
    window.ClawFW.actions.invoke('dirConfig.close');
  }));
});

describe('P2-6 共享配置编辑器与显式依赖', () => {
  it('createFeatureConfigEditor 真实实例：global scope 拉官方清单、关闭后可重开', () => withBatchCase(async () => {
    const host = {
      innerHTML: '',
      querySelector() { return null; },
      querySelectorAll() { return []; },
      addEventListener() {},
      removeEventListener() {},
    };
    const instance = env.editor.createFeatureConfigEditor({ host, scopeId: 'global' });
    assert.equal(typeof instance.open, 'function');
    assert.equal(typeof instance.close, 'function');
    await instance.open();
    assert.match(host.innerHTML, /fs-editor-body/);
    // global 层不带 agentId（官方清单原语义）
    assert.ok(env.fetchStub.calls.some((call) => call.url === '/protoclaw/system_feature_manifests'));
    instance.close();
    assert.equal(host.innerHTML, '');
    // 关闭后监听已摘除，可再次打开（不累积委托）
    await instance.open();
    assert.match(host.innerHTML, /fs-editor-body/);
    instance.close();
  }));

  it('语言取自 i18n ESM 状态：切换 owner 值即生效；classic 侧写入经桥 setter 回到同一 owner（不出现第二真相源）', () => withBatchCase(async () => {
    // 1) owner 值驱动：切到 en → 商店渲染英文
    env.i18n.setCurrentLanguage('en');
    await env.store.phOpenFeatureStore('main');
    const english = String(env.hosts.get('ph-feature-store-host').innerHTML);
    assert.match(english, /Installed/);
    assert.doesNotMatch(english, /已装配/);

    // 2) classic 写方（window.currentLanguage 是 i18n 域的桥访问器）经 setter 转发进
    //    同一 owner：owner 值与渲染结果一起变更，不是「模块读 A、全局读 B」的分叉。
    window.currentLanguage = 'zh';
    assert.equal(env.i18n.getCurrentLanguage(), 'zh', 'classic 写入应转发进 ESM owner');
    await env.store.phOpenFeatureStore('main');
    assert.match(String(env.hosts.get('ph-feature-store-host').innerHTML), /已装配/);

    // 3) 回到 owner 直写路径：英文重新生效
    env.i18n.setCurrentLanguage('en');
    await env.store.phOpenFeatureStore('main');
    assert.match(String(env.hosts.get('ph-feature-store-host').innerHTML), /Installed/);
  }));
});
