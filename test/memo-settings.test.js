/**
 * memo-settings.js — Memo 工作空间设置弹窗契约测试
 *
 * 锁定三件事：
 *   1. 面板经 window.ClawFW.appSettingsPanels 注册（首页 action
 *      'open_app_settings' 的查表目标，公共分发器不按 APP ID 分支）；
 *   2. 单模型槽位渲染：预设列表来自全局 model_config，当前值来自
 *      agent-configs/<agentId>.json 的 modelPresets.default.primary；
 *   3. 保存载荷形状：{ agentId, modelPresets: { default } }，两个控件
 *      都空时写 null（回落全局默认）。
 *
 * 服务端读写链路（/protoclaw/agent_model_presets）已由
 * test/model-preset-resolver.test.js 与路由实现覆盖，此处只锁前端契约。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createFrontendSandbox } from './helpers/frontend-vm.js';

const PRESETS = [
  { name: 'Alpha', model: 'alpha-1', provider: 'openai', contextLength: 200000 },
  { name: 'Beta', model: 'beta-1', provider: 'anthropic' },
];

/** 可记录 innerHTML 的 document 替身；querySelector 按选择器映射返回控件替身。 */
function createRecordingDocument() {
  const elements = new Map();
  const controls = new Map();
  const makeEl = (id) => ({
    id,
    innerHTML: '',
    style: {},
    dataset: {},
    appendChild() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
  });
  return {
    elements,
    controls,
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeEl(id));
      return elements.get(id);
    },
    createElement(tag) { return makeEl(tag); },
    querySelector(selector) { return controls.get(selector) || null; },
    querySelectorAll() { return []; },
    addEventListener() {},
    body: makeEl('body'),
  };
}

function createMemoSettingsSandbox({ agentPresets = {}, onRequest = null } = {}) {
  const doc = createRecordingDocument();
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (onRequest) {
      const custom = onRequest(String(url), options);
      if (custom) return custom;
    }
    if (String(url).startsWith('/protoclaw/model_config')) {
      return { ok: true, status: 200, json: async () => ({ presets: PRESETS }) };
    }
    if (String(url).startsWith('/protoclaw/agent_model_presets')) {
      if (options.method === 'PUT') {
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      return { ok: true, status: 200, json: async () => ({ agentId: 'memo', modelPresets: agentPresets }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const ctx = createFrontendSandbox({ document: doc, fetch: fetchImpl });
  ctx.loadSource('public/src/modules/model-preset-cache.js');
  ctx.loadSource('public/src/modules/memo-settings.js');
  ctx.requests = requests;
  ctx.doc = doc;
  return ctx;
}

/** 把模型下拉与思考强度下拉接进 recording document（保存路径的读取源）。 */
function attachControls(doc, { model = '', effort = '' } = {}) {
  doc.controls.set('#memo-settings-host .ph-mc-select[data-memo-slot="model"]', { value: model });
  doc.controls.set('#memo-settings-host .ph-mc-effort[data-memo-slot="effort"]', { value: effort });
}

const lastPut = (requests) => requests.filter((r) => r.options.method === 'PUT').pop();

describe('memo-settings：面板注册与渲染', () => {
  it('注册进 ClawFW.appSettingsPanels，键为 memo', () => {
    const ctx = createMemoSettingsSandbox();
    assert.equal(typeof ctx.run('window.ClawFW.appSettingsPanels.memo.open'), 'function');
    assert.equal(typeof ctx.run('window.ClawFW.appSettingsPanels.memo.close'), 'function');
  });

  it('打开后渲染全部预设，并选中已配置的模型', async () => {
    const ctx = createMemoSettingsSandbox({
      agentPresets: { default: { primary: 'Beta', thinkingEffort: { primary: null } } },
    });
    await ctx.run('openMemoSettings()');
    const html = ctx.doc.getElementById('memo-settings-host').innerHTML;
    assert.match(html, /<option value="Alpha"/, '应列出 Alpha 预设');
    assert.match(html, /<option value="Beta" selected>/, '应选中已配置的 Beta');
    assert.match(html, /beta-1/, '应显示所选预设的模型信息');
  });

  it('未配置模型时选中空选项并提示跟随全局默认', async () => {
    const ctx = createMemoSettingsSandbox({ agentPresets: {} });
    await ctx.run('openMemoSettings()');
    const html = ctx.doc.getElementById('memo-settings-host').innerHTML;
    assert.match(html, /<option value="" selected>/, '空选项应被选中');
    assert.match(html, /跟随全局默认/, '应提示回落全局默认');
  });

  it('关闭后清空宿主容器', async () => {
    const ctx = createMemoSettingsSandbox();
    await ctx.run('openMemoSettings()');
    ctx.run('closeMemoSettings()');
    assert.equal(ctx.doc.getElementById('memo-settings-host').innerHTML, '');
  });
});

describe('memo-settings：保存载荷', () => {
  it('选定模型与思考强度：写 { agentId, modelPresets: { default } }', async () => {
    const ctx = createMemoSettingsSandbox();
    attachControls(ctx.doc, { model: 'Alpha', effort: 'high' });
    await ctx.run('window.memoAutoSaveModel()');
    const put = lastPut(ctx.requests);
    assert.ok(put, '应发出 PUT');
    assert.equal(put.url, '/protoclaw/agent_model_presets');
    assert.deepEqual(JSON.parse(put.options.body), {
      agentId: 'memo',
      modelPresets: { default: { primary: 'Alpha', thinkingEffort: { primary: 'high' } } },
    });
  });

  it('两个控件都空：default 写 null（回落全局默认）', async () => {
    const ctx = createMemoSettingsSandbox();
    attachControls(ctx.doc, { model: '', effort: '' });
    await ctx.run('window.memoAutoSaveModel()');
    const put = lastPut(ctx.requests);
    assert.deepEqual(JSON.parse(put.options.body), {
      agentId: 'memo',
      modelPresets: { default: null },
    });
  });

  it('保存失败时写入错误状态，不抛错', async () => {
    const ctx = createMemoSettingsSandbox({
      onRequest: (url, options) => (options.method === 'PUT'
        ? { ok: false, status: 500, json: async () => ({ error: 'boom' }) }
        : null),
    });
    await ctx.run('openMemoSettings()');
    attachControls(ctx.doc, { model: 'Alpha', effort: '' });
    await ctx.run('window.memoAutoSaveModel()');
    const status = ctx.doc.getElementById('memo-settings-status').innerHTML;
    assert.match(status, /保存失败/);
    assert.match(status, /boom/);
  });
});
