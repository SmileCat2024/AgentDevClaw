/**
 * 插件设置弹窗测试（ADR-0046 落地第 1 步：配置入口归位）
 *
 * 覆盖行为承诺：
 *   - _fsSettingsRows 两态视图：跟随（上游最近层值 + 来源标签）/
 *     接管（本层值 + 重置按钮显隐按层语义）/ 无 settings 空态 / group 展开
 *   - _fsOpenSettings 数据加载：manifests 聚合中找不到该插件 → 空态
 *   - _fsSettingsSave 即时保存：PUT body 以当前层 sparse 为底 + 单字段
 *     写入；保存后重拉 resolved（行状态随层事实翻转）
 *   - 层 tab 守卫：无身份上下文（插件管理器全局卡）不允许切到 agent 层
 *
 * 两态判定本体（fsFieldStates / fsControlValue / fsShowReset / fsWithField）
 * 在 feature-setup-core.js，已有独立测试；本文件锚定设置弹窗对它们的组装。
 * resolved fixture 形状来自 resolved API 契约（layers[].id/label/sparse）。
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

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

/** 按需分发的 fetch stub：PUT layer 记录 body，GET resolved 返回可控层事实。 */
function makeFetch({ resolved } = {}) {
  const calls = [];
  const stub = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });
    if (String(url).includes('/protoclaw/system_feature_manifests')) {
      return { ok: true, status: 200, json: async () => ({ features: [MANIFEST_ENTRY], mountedExtras: ['agentero'] }) };
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
  return stub;
}

function loadModule(fetchStub) {
  const ctx = createFrontendSandbox({ fetch: fetchStub });
  ctx.run('window.ClawFW = window.ClawFW || {};');
  ctx.run('window.ClawFW.actions = window.ClawFW.actions || { registerMany() {} };');
  ctx.loadSource('public/src/modules/feature-setup-core.js');
  ctx.loadSource('public/src/modules/feature-store.js');
  return ctx;
}

describe('插件设置弹窗 — _fsSettingsRows 两态视图', () => {
  let ctx;
  beforeEach(() => {
    ctx = loadModule(makeFetch());
    ctx.run(`var MANIFEST_ENTRY = ${JSON.stringify(MANIFEST_ENTRY)};`);
    ctx.run(`var RESOLVED_FOLLOW = ${JSON.stringify(RESOLVED_FOLLOW)};`);
    ctx.run(`var RESOLVED_TAKEOVER = ${JSON.stringify(RESOLVED_TAKEOVER)};`);
  });

  it('agent 层跟随：控件值取上游 global 层值，携带来源层标签，无重置按钮', () => {
    const rows = ctx.run('_fsSettingsRows(MANIFEST_ENTRY, RESOLVED_FOLLOW, "agent")');
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.state.status, 'follow');
    assert.equal(row.controlValue, '/vault/a');
    assert.equal(row.upstreamLabel, '全局');
    assert.equal(row.showReset, false);
  });

  it('agent 层接管：控件值取本层值，显示重置按钮', () => {
    const rows = ctx.run('_fsSettingsRows(MANIFEST_ENTRY, RESOLVED_TAKEOVER, "agent")');
    const row = rows[0];
    assert.equal(row.state.status, 'takeover');
    assert.equal(row.controlValue, '/vault/b');
    assert.equal(row.showReset, true);
    // 接管态仍携带上游（重置后据此显示生效值）
    assert.equal(row.state.upstream.value, '/vault/a');
  });

  it('global 层重置按钮语义：接管值等于 manifest default 时隐藏（恢复默认无意义）', () => {
    const rowsSame = ctx.run(`
      _fsSettingsRows(
        { featureName: 'agentero', manifest: { settings: { properties: { vaultPath: { type: 'string', default: '/d' } } } } },
        { layers: [{ id: 'global', label: '全局', sparse: { agentero: { vaultPath: '/d' } } }] },
        'global')`);
    assert.equal(rowsSame[0].showReset, false);
    const rowsDiff = ctx.run(`
      _fsSettingsRows(
        { featureName: 'agentero', manifest: { settings: { properties: { vaultPath: { type: 'string', default: '/d' } } } } },
        { layers: [{ id: 'global', label: '全局', sparse: { agentero: { vaultPath: '/x' } } }] },
        'global')`);
    assert.equal(rowsDiff[0].showReset, true);
  });

  it('无 settings.properties → null（弹窗渲染空态文案）', () => {
    const rows = ctx.run('_fsSettingsRows({ featureName: "x", manifest: {} }, RESOLVED_FOLLOW, "agent")');
    assert.equal(rows, null);
  });

  it('group 属性展开为子键行（fullKey 三段、行数与声明一致）', () => {
    const rows = ctx.run(`
      _fsSettingsRows(
        { featureName: 'g', manifest: { settings: { properties: { conn: { type: 'group', properties: { host: { type: 'string' }, port: { type: 'number' } } } } } } },
        { layers: [{ id: 'agent', sparse: {} }] },
        'agent')`);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].key, 'g.conn.host');
    assert.equal(rows[1].key, 'g.conn.port');
  });

  it('无上游无默认：控件值 undefined（input 渲染空），上游类型 default', () => {
    const rows = ctx.run('_fsSettingsRows(MANIFEST_ENTRY, { layers: [{ id: "agent", sparse: {} }] }, "agent")');
    assert.equal(rows[0].controlValue, undefined);
    assert.equal(rows[0].state.upstream.kind, 'default');
  });
});

describe('插件设置弹窗 — 打开与即时保存', () => {
  it('打开：拉 manifests + resolved，行按层事实渲染', async () => {
    const fetchStub = makeFetch();
    const ctx = loadModule(fetchStub);
    await ctx.run('window._fsOpenSettings("agentero", "main")');
    assert.equal(ctx.run('_fsSettings.open'), true);
    assert.equal(ctx.run('_fsSettings.hasIdentity'), true);
    assert.equal(ctx.run('_fsSettings.agentId'), 'programming-helper');
    // 默认打开全局默认 tab；agent 层空、global 层有值 → 跟随无（global 是第一层，其上无上游）
    const rows = ctx.run('_fsSettingsRows(_fsSettings.manifest, _fsSettings.resolved, _fsSettings.scopeId)');
    assert.equal(rows[0].state.status, 'takeover');
    assert.equal(rows[0].controlValue, '/vault/a');
  });

  it('manifests 聚合查无该插件 → manifest 置 null（空态）', async () => {
    const fetchStub = makeFetch();
    // 覆盖 manifests 响应为不含目标插件
    const base = fetchStub;
    const ctx = createFrontendSandbox({ fetch: async (url) => {
      if (String(url).includes('system_feature_manifests')) {
        return { ok: true, status: 200, json: async () => ({ features: [], mountedExtras: [] }) };
      }
      if (String(url).includes('feature_config/resolved')) {
        return { ok: true, status: 200, json: async () => RESOLVED_FOLLOW };
      }
      return { ok: false, status: 0, json: async () => ({}) };
    } });
    ctx.run('window.ClawFW = window.ClawFW || {}; window.ClawFW.actions = window.ClawFW.actions || { registerMany() {} };');
    ctx.loadSource('public/src/modules/feature-setup-core.js');
    ctx.loadSource('public/src/modules/feature-store.js');
    await ctx.run('window._fsOpenSettings("agentero", "main")');
    assert.equal(ctx.run('_fsSettings.manifest'), null);
    assert.equal(ctx.run('_fsSettings.error'), '');
  });

  it('保存：PUT 以当前层 sparse 为底 + 单字段写入，成功后行状态翻转', async () => {
    const fetchStub = makeFetch();
    const ctx = loadModule(fetchStub);
    await ctx.run('window._fsOpenSettings("agentero", "main")');
    // 切到本空间层编辑（agent 层空 → 跟随态显示 global 值）
    ctx.run('_fsSettingsSwitchTab("agent")');
    assert.equal(ctx.run('_fsSettings.scopeId'), 'agent');
    await ctx.run('_fsSettingsSave("agentero.vaultPath", "/vault/b")');
    // PUT body：agentId/layerId 寻址正确，content 以 agent 层 sparse（{}）为底写入单字段
    const put = fetchStub.calls.find((c) => c.method === 'PUT');
    assert.deepEqual(put.body, {
      agentId: 'programming-helper',
      layerId: 'agent',
      content: { agentero: { vaultPath: '/vault/b' } },
    });
    // 保存后重拉 resolved（stub 反映新层事实）→ 行翻转为接管
    const rows = ctx.run('_fsSettingsRows(_fsSettings.manifest, _fsSettings.resolved, "agent")');
    assert.equal(rows[0].state.status, 'takeover');
    assert.equal(rows[0].controlValue, '/vault/b');
  });

  it('保存不丢同层既有字段：agent 层已有其他插件配置时，PUT content 必须保留它们', async () => {
    // 层事实：agent 层已有 stylized-output 的配置（整层写回的丢字段 = 用户配置丢失）
    const fetchStub = makeFetch({
      resolved: {
        layers: [
          { id: 'global', label: '全局', sparse: {} },
          { id: 'agent', label: '编程小助手', sparse: { 'stylized-output': { intensity: 2 } } },
        ],
        merged: {},
      },
    });
    const ctx = loadModule(fetchStub);
    await ctx.run('window._fsOpenSettings("agentero", "main")');
    ctx.run('_fsSettingsSwitchTab("agent")');
    await ctx.run('_fsSettingsSave("agentero.vaultPath", "/vault/c")');
    const put = fetchStub.calls.find((c) => c.method === 'PUT');
    assert.equal(put.body.content['stylized-output']?.intensity, 2);
    assert.equal(put.body.content.agentero?.vaultPath, '/vault/c');
  });

  it('重置（value=null）：字段从本层删除，恢复跟随', async () => {
    const fetchStub = makeFetch({ resolved: RESOLVED_TAKEOVER });
    const ctx = loadModule(fetchStub);
    await ctx.run('window._fsOpenSettings("agentero", "main")');
    ctx.run('_fsSettingsSwitchTab("agent")');
    await ctx.run('_fsSettingsSave("agentero.vaultPath", null)');
    const put = fetchStub.calls.find((c) => c.method === 'PUT');
    // 删除语义：content 中不再有该字段（agent 层空 → 键被剪枝）
    assert.equal(put.body.content.agentero, undefined);
  });

  it('层 tab 守卫：无身份上下文（插件管理器）不能切到 agent 层', async () => {
    const fetchStub = makeFetch();
    const ctx = loadModule(fetchStub);
    // 不传 identityContext（插件管理器全局卡）
    await ctx.run('window._fsOpenSettings("agentero", null)');
    assert.equal(ctx.run('_fsSettings.hasIdentity'), false);
    ctx.run('_fsSettingsSwitchTab("agent")');
    assert.equal(ctx.run('_fsSettings.scopeId'), 'global');
  });
});
