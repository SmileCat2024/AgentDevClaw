/**
 * 插件设置弹窗测试（ADR-0046 落地第 1 步：配置入口归位）
 *
 * 覆盖行为承诺：
 *   - 插件商店类型分页与「已装配/未装配」区段（catalog 未就绪落待归类兜底）
 *   - 插件名/描述经 markdown-utils 的真实 escapeHtml 转义（属性与文本两侧）
 *   - _fsSettingsRows 两态视图：跟随（上游最近层值 + 来源标签）/
 *     接管（本层值 + 重置按钮显隐按层语义）/ 无 settings 空态 / group 展开
 *   - 设置弹窗打开：manifests 聚合中找不到该插件 → 空态
 *   - 即时保存：PUT body 以当前层 sparse 为底 + 单字段写入；保存后重拉
 *     resolved（行状态随层事实翻转）
 *   - 层 tab 守卫：无身份上下文（插件管理器全局卡）不允许切到 agent 层
 *
 * ESM 化（P2 迁移批次 6）：装载路线是真实 import + 一次用例一张 ESM 图
 * （withP2EsmCase 的 case 级命名空间，含 feature-store ↔ ph-settings 静态环）。
 * classic 相按 index.html 的先行脚本序在同一沙箱里跑真实实现，因此
 * createSessionViewCommitHost / createAgentCallStatesHost / createRuntimeSwitchHost
 * 等宿主工厂都是生产代码本身，不是手写桩。escapeHtml 按生产形状经 defineKey
 * 注册，由 markdown-utils.js 在模块执行时捕获并作为具名导出供给被测模块；
 * window.t 是 classic 顶层函数桩（模块经 window 晚绑定读取）；document 用按 id
 * 复用的宿主表，使 innerHTML 断言落在模块真实渲染路径上。动作经
 * window.ClawFW.actions 桩按注册名分发，验证的是生产动作表本身，而不是直接调
 * 私有函数。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { prepareClassicSandbox } from './p2-classic-hosts.js';

/** agentero 同款 manifest：单 string 参数 + 双语 label/description。 */
const MANIFEST_ENTRY = {
  featureName: 'agentero',
  manifest: {
    name: 'Agentero',
    settings: {
      properties: {
        vaultPath: {
          type: 'string', format: 'path',
          label: { zh: 'Vault 路径', en: 'Vault path' },
          description: { zh: 'vault 根目录', en: 'vault root' },
        },
      },
    },
  },
};

const RESOLVED_FOLLOW = {
  layers: [
    { id: 'global', label: '全局', sparse: { agentero: { vaultPath: '/vault/a' } } },
    { id: 'agent', label: '编程小助手', sparse: {} },
  ],
  merged: {},
};

const RESOLVED_TAKEOVER = {
  layers: [
    { id: 'global', label: '全局', sparse: { agentero: { vaultPath: '/vault/a' } } },
    { id: 'agent', label: '编程小助手', sparse: { agentero: { vaultPath: '/vault/b' } } },
  ],
  merged: {},
};

/** 商店 overview fixture（类型分页测试用）。 */
const OVERVIEW = {
  mounts: {
    main: {
      agentero: { kind: 'package', package: '@agentdev/agentero', version: '0.3.1' },
      'optional-browser': { kind: 'builtin' },
    },
  },
  builtin: [],
  packages: [
    { package: '@agentdev/lsp', displayName: 'LSP', versions: [{ version: '1.0.0' }, { version: '0.9.0' }] },
    { package: '@agentdev/other', displayName: 'Other', versions: [{ version: '2.0.0' }] },
  ],
};

/**
 * feature-catalog 的 HTTP fixture（真实 catalog 分组逻辑的数据面）。
 * 词表用生产口径 types（ability/governance/interface/system）；四个条目各归一型，
 * 使「切到某一类型只剩该型条目」可被真实分组断言。
 */
const CATALOG = {
  provenances: ['bundled', 'installed'],
  types: [
    { id: 'ability' }, { id: 'governance' }, { id: 'interface' }, { id: 'system' },
  ],
  features: [
    { name: 'lsp', type: 'ability', displayName: { zh: 'LSP', en: 'LSP' }, provenance: 'bundled', capabilities: ['tools'], group: 'bundled' },
    { name: 'other', type: 'governance', displayName: { zh: '其他', en: 'Other' }, provenance: 'bundled', capabilities: ['tools'], group: 'bundled' },
    { name: 'agentero', type: 'interface', displayName: { zh: 'Agentero', en: 'Agentero' }, provenance: 'installed', capabilities: ['tools'], group: 'installed' },
    { name: 'optional-browser', type: 'system', displayName: { zh: '浏览器', en: 'Browser' }, provenance: 'bundled', capabilities: ['tools'], group: 'bundled' },
  ],
};

/** 按需分发的 fetch stub：PUT layer 记录 body，GET resolved 返回可控层事实。 */
function makeFetch({ resolved, overview } = {}) {
  const calls = [];
  const stub = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });
    if (String(url) === '/api/feature-store/overview') {
      return { ok: true, status: 200, json: async () => stub.overviewNow };
    }
    if (String(url) === '/api/feature-catalog') {
      return { ok: true, status: 200, json: async () => stub.catalogNow };
    }
    if (String(url).includes('/protoclaw/system_feature_manifests')) {
      return { ok: true, status: 200, json: async () => stub.manifestsNow };
    }
    if (String(url).includes('/protoclaw/feature_config/resolved')) {
      return { ok: true, status: 200, json: async () => stub.resolvedNow };
    }
    if (String(url).includes('/protoclaw/feature_config/layer')) {
      // 按 PUT 的 layerId 落位（保存后 resolved 反映新层事实）
      const { layerId, content } = JSON.parse(options.body);
      const layerIndex = layerId === 'agent' ? 1 : 0;
      const layers = [
        { ...(stub.resolvedNow?.layers?.[0] || { id: 'global', label: '全局' }) },
        { ...(stub.resolvedNow?.layers?.[1] || { id: 'agent', label: '编程小助手' }) },
      ];
      layers[layerIndex] = { ...layers[layerIndex], sparse: content };
      stub.resolvedNow = { layers, merged: {} };
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    return { ok: false, status: 0, json: async () => ({}) };
  };
  stub.calls = calls;
  stub.resolvedNow = resolved || RESOLVED_FOLLOW;
  stub.overviewNow = overview || OVERVIEW;
  stub.manifestsNow = { features: [MANIFEST_ENTRY], mountedExtras: ['agentero'] };
  stub.catalogNow = CATALOG;
  return stub;
}

const T_MAP = {
  feature_type_ability: '能力',
  feature_type_governance: '治理',
  feature_type_interface: '接口',
  feature_type_system: '系统',
  feature_cat_unmapped: '待归类',
};

// 语言走 i18n-environment-state.js 命名导出（模块经 getCurrentLanguage 读取）。
// 该模块在本测试进程内只执行一次（feature-store 的静态 import 与本处同一 URL），
// 因此这里用无 query 的同一 URL 取到同一实例，逐用例重置语言值。

/** document 桩：按 id 返回稳定宿主对象，模块真实渲染的 innerHTML 可被断言。 */
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
  const body = makeElement();
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
      body,
      documentElement: makeElement(),
      activeElement: null,
      readyState: 'complete',
    },
  };
}

/** 动作分发器桩：按真实注册名保存 handler，invoke 走生产动作表。 */
function createActionsStub() {
  return {
    handlers: {},
    registerMany(handlers) { Object.assign(this.handlers, handlers); },
    bindEventType() {},
    invoke(name, el) { return this.handlers[name]?.(el); },
  };
}

/**
 * 装载被测 ESM 图（kernel-state → markdown-utils / feature-catalog → feature-setup-core
 * → feature-store）。feature-catalog 是已 ESM 的真实依赖（数据面经 /api/feature-catalog
 * HTTP 桩），不再走 window.ClawFW.featureCatalog 桩。markdown-utils 的模块级宿主读取
 * 只有 window.escapeHtml / renderer / marked；后两者仅在函数内使用（本文件不触发
 * markdown 渲染），故只按生产形状注册 escapeHtml 桥键。
 */
/**
 * 一次用例 = 一份真实沙箱 window + 一张真实 ESM 图（含 feature-store 的静态环）。
 * 分发器面由 createActionsStub 提供（用例要按 action 名驱动真实处理函数）；模块里
 * 裸调用平台 fetch，globals 同时覆盖沙箱与主 realm 的 fetch。
 */
async function withStore({ fetchStub = makeFetch() } = {}, fn) {
  const { document, hosts } = createDocumentStub();
  const actions = createActionsStub();
  return withP2EsmCase({
    globals: { document, fetch: fetchStub },
    classic: (sandbox) => {
      sandbox.run('window.__clawAuthReady = new Promise(() => {}); applyTheme = () => {}; applyLanguage = () => {};'
        + 'ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };'
        + 'setInterval = () => 0; clearInterval = () => {}; requestAnimationFrame = () => 0;');
      prepareClassicSandbox(sandbox);
      // escapeHtml 由 markdown-utils 自身提供（原 classic bootstrap 并入），用例不再预注册。
      sandbox.t = (key) => T_MAP[key] || key;
      // 只提供动作注册面：feature-catalog 的兼容命名空间由它自己的模块挂载
      sandbox.ClawFW = { actions };
    },
  }, async (c) => {
    const i18n = await c.load('public/src/modules/i18n-environment-state.js');
    i18n.setCurrentLanguage('zh');
    // feature-store 静态 import feature-setup-core（纯函数、无模块状态）
    const store = await c.load('public/src/modules/feature-store.js');
    return fn({ store, hosts, actions, fetchStub });
  });
}

/** 输入框桩（settingsField 动作的真实消费面）。 */
function fieldEl(key, value, extra = {}) {
  return {
    dataset: { key },
    type: 'text',
    value,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    ...extra,
  };
}

/** 等一拍：fire-and-forget 保存（handler 不返回 promise 的分支）落盘。 */
const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('身份插件商店分页', () => {
  it('类型为上级分页，类型页内上下分「已装配/未装配」区段，保留插件操作', async () => {
    await withStore({}, async (loaded) => {
      await loaded.store.phOpenFeatureStore('main');
      const host = loaded.hosts.get('ph-feature-store-host');
      const all = String(host.innerHTML);
      // 上级是类型分页器（全部 + 各类型），分组来自真实 feature-catalog HTTP 数据
      assert.match(all, /class="fs-category-tabs"/);
      assert.match(all, /data-category="all"/);
      assert.match(all, /data-category="ability"/);
      assert.match(all, /data-category="governance"/);
      assert.match(all, /data-category="interface"/);
      assert.match(all, /data-category="system"/);
      // 四个条目都在 catalog 词表内 → 无待归类档
      assert.doesNotMatch(all, /data-category="_unmapped"/);
      assert.doesNotMatch(all, /data-tab="mounted"/);
      assert.doesNotMatch(all, /data-tab="available"/);
      assert.doesNotMatch(all, /data-filter="official"/);
      // 类型页内上下区段：已装配（agentero / optional-browser）与未装配（货架）同屏
      assert.match(all, /已装配/);
      assert.match(all, /未装配/);
      assert.match(all, /agentero/);
      assert.match(all, /optional-browser/);
      assert.match(all, /data-action="featureStore\.removeMount"/);
      assert.match(all, /data-action="featureStore\.openSettings"/);
      assert.match(all, /data-action="featureStore\.install"/);
      assert.match(all, /data-action="featureStore\.selectVersion"/);

      // 切到 ability 类型页（catalog 中 lsp 归 ability）：只剩 lsp 的未装配卡；
      // 已装配区段为空态但区段头仍在
      loaded.actions.invoke('featureStore.category', { dataset: { category: 'ability' } });
      const ability = String(host.innerHTML);
      assert.match(ability, /data-package="@agentdev\/lsp"/);
      assert.doesNotMatch(ability, /@agentdev\/other/);
      assert.doesNotMatch(ability, /agentero/);
      assert.doesNotMatch(ability, /optional-browser/);
      assert.match(ability, /此类型暂无已装配插件/);
    });
  });

  it('catalog 词表外条目落待归类兜底，分页器仍显示（标签经 window.t 读取）', async () => {
    // 真实 catalog 已加载（模块级缓存是 feature-catalog 的设计）；seed 未收录的包
    // 走 enrich 的 mapped:false 分支 → 落 _unmapped 兜底组
    await withStore({
      fetchStub: makeFetch({
        overview: {
          mounts: { main: { agentero: { kind: 'package', package: '@agentdev/agentero', version: '0.3.1' } } },
          builtin: [],
          packages: [{ package: '@agentdev/ghost', displayName: 'Ghost', versions: [{ version: '1.0.0' }] }],
        },
      }),
    }, async (loaded) => {
      await loaded.store.phOpenFeatureStore('main');
      const host = loaded.hosts.get('ph-feature-store-host');
      const html = String(host.innerHTML);
      // 分页器恒显示（全部 + 词表内类型 + 待归类兜底）
      assert.match(html, /class="fs-category-tabs"/);
      assert.match(html, /data-category="all"/);
      assert.match(html, /data-category="interface"/);
      assert.match(html, /data-category="_unmapped"/);
      assert.match(html, /待归类/);
      assert.match(html, /data-name="agentero"/);
      assert.match(html, /data-package="@agentdev\/ghost"/);

      // 待归类页只含词表外条目
      loaded.actions.invoke('featureStore.category', { dataset: { category: '_unmapped' } });
      const unmapped = String(host.innerHTML);
      assert.match(unmapped, /data-package="@agentdev\/ghost"/);
      assert.doesNotMatch(unmapped, /data-name="agentero"/);
      assert.match(unmapped, /此类型暂无已装配插件/);
    });
  });

  it('catalog 未就绪（快照为 null）：全部条目落待归类兜底、分页器仍显示、未装配区段给出空货架文案', async () => {
    // 服务未就绪：feature-catalog 拉取失败不缓存 → getFeatureCatalogSnapshot() 恒为
    // null → _fsBuildTypeGroups 走「无词表」三元兜底（全部条目进 _unmapped 组）。
    // overview 只有已装配条目、无新包 → 未装配区段为空 → 渲染空货架文案。
    const fetchStub = makeFetch({
      overview: {
        mounts: { main: { agentero: { kind: 'package', package: '@agentdev/agentero', version: '0.3.1' } } },
        builtin: [],
        packages: [],
      },
    });
    fetchStub.catalogNow = null;
    await withStore({ fetchStub }, async (loaded) => {
      await loaded.store.phOpenFeatureStore('main');
      const html = String(loaded.hosts.get('ph-feature-store-host').innerHTML);
      // 分页器恒显示：全部 + 唯一兜底档
      assert.match(html, /class="fs-category-tabs"/);
      assert.match(html, /data-category="all"/);
      assert.match(html, /data-category="_unmapped"/);
      assert.match(html, /待归类/);
      // 无词表时不产生任何具名类型档
      assert.doesNotMatch(html, /data-category="ability"/);
      assert.doesNotMatch(html, /data-category="interface"/);
      // 已装配事实来自真实 overview，仍正常上架
      assert.match(html, /已装配/);
      assert.match(html, /data-name="agentero"/);
      // 空货架文案（本类型/本档没有可安装的包）
      assert.match(html, /没有可安装的插件/);
    });
  });

  it('插件名/描述经 markdown-utils 的真实 escapeHtml 转义（不注入原始标签）', async () => {
    await withStore({
      fetchStub: makeFetch({
        overview: {
          mounts: { main: {} },
          builtin: [],
          packages: [{
            // 无 scope 前缀 → runtimeKey 即包名，带特殊字符以覆盖卡片 title 属性转义
            package: 'evil<img src=x onerror=alert(1)>',
            displayName: '<img src=x onerror=alert(1)>',
            description: 'a "b" & c',
            versions: [{ version: '1.0.0' }],
          }],
        },
      }),
    }, async (loaded) => {
      await loaded.store.phOpenFeatureStore('main');
      const html = String(loaded.hosts.get('ph-feature-store-host').innerHTML);
      assert.doesNotMatch(html, /<img src=x/);
      assert.match(html, /title="evil&lt;img src=x onerror=alert\(1\)&gt;"/);
      assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
      assert.match(html, /a &quot;b&quot; &amp; c/);
    });
  });
});

describe('插件设置弹窗 — _fsSettingsRows 两态视图', () => {

  it('agent 层跟随：控件值取上游 global 层值，携带来源层标签，无重置按钮', () => withStore({}, async (loaded) => {
    const rows = loaded.store._fsSettingsRows(MANIFEST_ENTRY, RESOLVED_FOLLOW, 'agent');
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.state.status, 'follow');
    assert.equal(row.controlValue, '/vault/a');
    assert.equal(row.upstreamLabel, '全局');
    assert.equal(row.showReset, false);
  }));

  it('agent 层接管：控件值取本层值，显示重置按钮', () => withStore({}, async (loaded) => {
    const rows = loaded.store._fsSettingsRows(MANIFEST_ENTRY, RESOLVED_TAKEOVER, 'agent');
    const row = rows[0];
    assert.equal(row.state.status, 'takeover');
    assert.equal(row.controlValue, '/vault/b');
    assert.equal(row.showReset, true);
    // 接管态仍携带上游（重置后据此显示生效值）
    assert.equal(row.state.upstream.value, '/vault/a');
  }));

  it('global 层重置按钮语义：接管值等于 manifest default 时隐藏（恢复默认无意义）', () => withStore({}, async (loaded) => {
    const manifest = { featureName: 'agentero', manifest: { settings: { properties: { vaultPath: { type: 'string', default: '/d' } } } } };
    const rowsSame = loaded.store._fsSettingsRows(
      manifest,
      { layers: [{ id: 'global', label: '全局', sparse: { agentero: { vaultPath: '/d' } } }] },
      'global');
    assert.equal(rowsSame[0].showReset, false);
    const rowsDiff = loaded.store._fsSettingsRows(
      manifest,
      { layers: [{ id: 'global', label: '全局', sparse: { agentero: { vaultPath: '/x' } } }] },
      'global');
    assert.equal(rowsDiff[0].showReset, true);
  }));

  it('无 settings.properties → null（弹窗渲染空态文案）', () => withStore({}, async (loaded) => {
    assert.equal(loaded.store._fsSettingsRows({ featureName: 'x', manifest: {} }, RESOLVED_FOLLOW, 'agent'), null);
  }));

  it('group 属性展开为子键行（fullKey 三段、行数与声明一致）', () => withStore({}, async (loaded) => {
    const rows = loaded.store._fsSettingsRows(
      { featureName: 'g', manifest: { settings: { properties: { conn: { type: 'group', properties: { host: { type: 'string' }, port: { type: 'number' } } } } } } },
      { layers: [{ id: 'agent', sparse: {} }] },
      'agent');
    assert.equal(rows.length, 2);
    assert.equal(rows[0].key, 'g.conn.host');
    assert.equal(rows[1].key, 'g.conn.port');
  }));

  it('无上游无默认：控件值 undefined（input 渲染空），上游类型 default', () => withStore({}, async (loaded) => {
    const rows = loaded.store._fsSettingsRows(MANIFEST_ENTRY, { layers: [{ id: 'agent', sparse: {} }] }, 'agent');
    assert.equal(rows[0].controlValue, undefined);
    assert.equal(rows[0].state.upstream.kind, 'default');
  }));
});

describe('插件设置弹窗 — 打开与即时保存', () => {
  it('打开：拉 manifests + resolved，行按层事实渲染（默认本空间层）', async () => {
    await withStore({}, async (loaded) => {
      await loaded.actions.invoke('featureStore.openSettings', { dataset: { name: 'agentero', identity: 'main' } });
      const urls = loaded.fetchStub.calls.map((call) => call.url);
      assert.ok(urls.some((url) => url.includes('/protoclaw/system_feature_manifests?agentId=programming-helper')));
      assert.ok(urls.some((url) => url.includes('/protoclaw/feature_config/resolved?agentId=programming-helper')));
      // 从身份商店进入时默认编辑本空间层；上游 global 值仍可见并被跟随。
      const html = String(loaded.hosts.get('ph-plugin-settings-host').innerHTML);
      assert.match(html, /Vault 路径/);
      // 跟随态：控件显示上游 global 值，并标注来源层
      assert.match(html, /data-key="agentero\.vaultPath" value="\/vault\/a"/);
      assert.match(html, /class="fs-settings-state fs-settings-follow">跟随 全局</);
      // 本空间层 tab 处于选中态（真实输出的类名 + 动作 + scope 三元组）
      assert.match(html, /class="fs-settings-tab active" data-action="featureStore\.settingsTab" data-scope="agent"/);
    });
  });

  it('显式全局入口仍打开全局层；无身份上下文也只能编辑全局层', async () => {
    await withStore({}, async (loaded) => {
      await loaded.actions.invoke('featureStore.openSettings', { dataset: { name: 'agentero', identity: 'main', scope: 'global' } });
      let html = String(loaded.hosts.get('ph-plugin-settings-host').innerHTML);
      assert.match(html, /class="fs-settings-tab active" data-action="featureStore\.settingsTab" data-scope="global"/);

      await loaded.actions.invoke('featureStore.openSettings', { dataset: { name: 'agentero' } });
      html = String(loaded.hosts.get('ph-plugin-settings-host').innerHTML);
      // 无身份上下文：不显示两层 tab，只提示全局默认配置
      assert.doesNotMatch(html, /data-scope="agent"/);
      assert.match(html, /全局默认配置/);
      loaded.actions.invoke('featureStore.settingsTab', { dataset: { scope: 'agent' } });
      loaded.actions.invoke('featureStore.settingsField', fieldEl('agentero.vaultPath', '/vault/z'));
      await tick();
      const put = loaded.fetchStub.calls.filter((call) => call.method === 'PUT').pop();
      assert.equal(put.body.layerId, 'global');
    });
  });

  it('工作空间插件清单的设置动作：dataset 的插件名/身份/本空间层三元一起透传到同一弹窗', async () => {
    // 生产动作表：featureStore.openSettings(el) → _fsOpenSettings(el.dataset.name,
    // el.dataset.identity, { initialScope: el.dataset.scope })。断言落在可观察后果上：
    // 弹窗开在该插件、本空间层 tab 生效、保存写入 agentId + layerId=agent（身份透传）。
    await withStore({}, async (loaded) => {
      await loaded.actions.invoke('featureStore.openSettings', {
        dataset: { name: 'agentero', identity: 'main', scope: 'agent' },
      });
      const html = String(loaded.hosts.get('ph-plugin-settings-host').innerHTML);
      assert.match(html, /class="fs-settings-tab active" data-action="featureStore\.settingsTab" data-scope="agent"/,
        'scope=agent 时应直接落在本空间层');
      assert.match(html, /Vault 路径/, '弹窗渲染的是该插件的 manifest 参数行');

      // 身份透传证据：保存落到 identity 对应的 agent 层
      await loaded.actions.invoke('featureStore.settingsField', fieldEl('agentero.vaultPath', '/vault/from-workspace'));
      await tick();
      const put = loaded.fetchStub.calls.filter((call) => call.method === 'PUT').pop();
      assert.deepEqual(put.body, {
        agentId: 'programming-helper',
        layerId: 'agent',
        content: { agentero: { vaultPath: '/vault/from-workspace' } },
      });
    });
  });

  it('manifests 聚合查无该插件 → 空态（不抛错）', async () => {
    const fetchStub = makeFetch();
    fetchStub.manifestsNow = { features: [], mountedExtras: [] };
    await withStore({ fetchStub }, async (loaded) => {
      await loaded.actions.invoke('featureStore.openSettings', { dataset: { name: 'agentero', identity: 'main' } });
      const html = String(loaded.hosts.get('ph-plugin-settings-host').innerHTML);
      assert.match(html, /该插件没有声明可配置参数/);
      assert.doesNotMatch(html, /fs-error-banner/);
    });
  });

  it('保存：PUT 以当前层 sparse 为底 + 单字段写入，成功后行状态翻转', async () => {
    await withStore({}, async (loaded) => {
      await loaded.actions.invoke('featureStore.openSettings', { dataset: { name: 'agentero', identity: 'main' } });
      await loaded.actions.invoke('featureStore.settingsField', fieldEl('agentero.vaultPath', '/vault/b'));
      await tick();
      // PUT body：agentId/layerId 寻址正确，content 以 agent 层 sparse（{}）为底写入单字段
      const put = loaded.fetchStub.calls.find((call) => call.method === 'PUT');
      assert.deepEqual(put.body, {
        agentId: 'programming-helper',
        layerId: 'agent',
        content: { agentero: { vaultPath: '/vault/b' } },
      });
      // 保存后重拉 resolved（stub 反映新层事实）→ 行翻转为接管
      const html = String(loaded.hosts.get('ph-plugin-settings-host').innerHTML);
      assert.match(html, /本层已接管/);
      assert.match(html, /value="\/vault\/b"/);
      assert.match(html, /fs-settings-reset/);
    });
  });

  it('保存不丢同层既有字段：agent 层已有其他插件配置时，PUT content 必须保留它们', async () => {
    const fetchStub = makeFetch({
      resolved: {
        layers: [
          { id: 'global', label: '全局', sparse: {} },
          { id: 'agent', label: '编程小助手', sparse: { 'stylized-output': { intensity: 2 } } },
        ],
        merged: {},
      },
    });
    await withStore({ fetchStub }, async (loaded) => {
      await loaded.actions.invoke('featureStore.openSettings', { dataset: { name: 'agentero', identity: 'main' } });
      await loaded.actions.invoke('featureStore.settingsField', fieldEl('agentero.vaultPath', '/vault/c'));
      await tick();
      const put = fetchStub.calls.find((call) => call.method === 'PUT');
      assert.equal(put.body.content['stylized-output']?.intensity, 2);
      assert.equal(put.body.content.agentero?.vaultPath, '/vault/c');
    });
  });

  it('重置（value=null）：字段从本层删除，恢复跟随', async () => {
    const fetchStub = makeFetch({ resolved: RESOLVED_TAKEOVER });
    await withStore({ fetchStub }, async (loaded) => {
      await loaded.actions.invoke('featureStore.openSettings', { dataset: { name: 'agentero', identity: 'main' } });
      await loaded.actions.invoke('featureStore.settingsReset', { dataset: { key: 'agentero.vaultPath' } });
      const put = fetchStub.calls.find((call) => call.method === 'PUT');
      // 删除语义：content 中不再有该字段（agent 层空 → 键被剪枝）
      assert.equal(put.body.content.agentero, undefined);
      const html = String(loaded.hosts.get('ph-plugin-settings-host').innerHTML);
      assert.match(html, /跟随 全局/);
    });
  });

  it('插件管理器只显示仓库与默认装配，不再另造全局 Feature 参数入口', async () => {
    const fetchStub = makeFetch({
      overview: {
        packages: [{ package: 'agentero', displayName: 'Agentero', description: 'Library', versions: [{ version: '1.0.0' }] }],
        mounts: { global: { agentero: { package: 'agentero', version: '1.0.0' } } },
      },
    });
    await withStore({ fetchStub }, async (loaded) => {
      await loaded.store.clawOpenPluginManager();
      const managerHtml = String(loaded.hosts.get('claw-plugin-manager-host').innerHTML);
      assert.match(managerHtml, /仓库插件/);
      // ADR-0046 2026-11-19 修订：全局级装配 → 默认装配（仅对声明 defaultMounts 的工作空间生效）
      assert.match(managerHtml, /默认装配/);
      assert.doesNotMatch(managerHtml, /打开全局配置|Global Defaults|全局装配/);
      assert.equal(loaded.actions.handlers['pluginManager.openGlobalConfig'], undefined);
    });
  });

  it('层 tab 守卫：无身份上下文（插件管理器全局装配卡）不能切到 agent 层', async () => {
    await withStore({}, async (loaded) => {
      await loaded.actions.invoke('featureStore.openSettings', { dataset: { name: 'agentero' } });
      loaded.actions.invoke('featureStore.settingsTab', { dataset: { scope: 'agent' } });
      await loaded.actions.invoke('featureStore.settingsReset', { dataset: { key: 'agentero.vaultPath' } });
      const put = loaded.fetchStub.calls.find((call) => call.method === 'PUT');
      assert.equal(put.body.layerId, 'global');
    });
  });
});
