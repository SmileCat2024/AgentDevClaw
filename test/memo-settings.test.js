/**
 * memo 设置弹窗（plugins/memo/settings.js，原 modules/memo-settings.js）契约测试
 *
 * 锁定：
 *   1. 面板随插件 mount 注册进 window.ClawFW.appSettingsPanels（首页 action
 *      'open_app_settings' 的查表目标），unmount 摘除——设置弹窗与首页界面
 *      同生命周期，是 memo 插件化的收尾件；
 *   2. 单模型槽位渲染：预设列表来自全局 model_config，当前值来自
 *      agent-configs/<agentId>.json 的 modelPresets.default.primary；
 *   3. 保存载荷形状：{ agentId, modelPresets: { default } }，两个控件
 *      都空时写 null（回落全局默认）；
 *   4. 控件事件走 data-action 分发（memoSettings.*），无内联 onchange/onclick。
 *
 * 服务端读写链路（/protoclaw/agent_model_presets）已由
 * test/model-preset-resolver.test.js 与路由实现覆盖，此处只锁前端契约。
 *
 * 装载纪律：按状态需求分组共享模块实例（渲染组 / 保存组），卸载用例独享
 * ——动态 import 次数压到 3 次，避免启动 burst 挤压真实子进程测试。
 */

import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';

import { installMinimalWindow, makePresenter } from './helpers/memo-plugin-loader.js';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const SETTINGS_FILE = path.resolve(
  import.meta.dirname, '..', 'public', 'src', 'plugins', 'memo', 'settings.js',
);

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

/** 装载 settings 模块实例（新 query 绕模块缓存），fetch 按路由表应答并记录请求。 */
async function loadSettings({ agentPresets = {}, onRequest = null } = {}) {
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
    if (String(url).startsWith('/protoclaw/workspace_settings')) {
      return { ok: true, status: 200, json: async () => ({ resourcePolicy: {} }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const restoreWindow = installMinimalWindow();
  const prevDocument = globalThis.document;
  const prevFetch = globalThis.fetch;
  globalThis.document = doc;
  globalThis.fetch = fetchImpl;
  const url = `${pathToFileURL(SETTINGS_FILE).href}?case=${Math.random().toString(36).slice(2)}`;
  const mod = await import(url);
  const descriptor = mod.default;
  descriptor.mount(makePresenter());
  return {
    mod, descriptor, doc, requests,
    cleanup() {
      descriptor.unmount();
      globalThis.document = prevDocument;
      globalThis.fetch = prevFetch;
      restoreWindow();
    },
  };
}

/** 把模型下拉与思考强度下拉接进 recording document（保存路径的读取源）。 */
function attachControls(doc, { model = '', effort = '' } = {}) {
  doc.controls.set('#memo-settings-host .ph-mc-select[data-memo-slot="model"]', { value: model });
  doc.controls.set('#memo-settings-host .ph-mc-effort[data-memo-slot="effort"]', { value: effort });
}

const lastPut = (requests) => requests.filter((r) => r.options.method === 'PUT').pop();

describe('memo-settings：面板注册与渲染', () => {
  // 渲染组共享一个实例（open() 自带状态重置，用例间无耦合）
  let ctx;
  before(async () => {
    ctx = await loadSettings({
      agentPresets: { default: { primary: 'Beta', thinkingEffort: { primary: null } } },
    });
  });
  after(() => { ctx?.cleanup(); });

  it('mount 时注册进 ClawFW.appSettingsPanels，unmount 摘除', async () => {
    assert.equal(typeof globalThis.window.ClawFW.appSettingsPanels.memo.open, 'function');
    assert.equal(typeof globalThis.window.ClawFW.appSettingsPanels.memo.close, 'function');

    const solo = await loadSettings();
    try {
      assert.ok(globalThis.window.ClawFW.appSettingsPanels.memo, '装载后注册在案');
      solo.descriptor.unmount();
      assert.equal(globalThis.window.ClawFW.appSettingsPanels.memo, undefined, '卸载后摘除注册');
    } finally { solo.cleanup(); }
  });

  it('打开后渲染全部预设，选中已配置模型，控件走 data-action 无内联事件', async () => {
    await ctx.mod.MemoSettingsUI.open();
    const html = ctx.doc.getElementById('memo-settings-host').innerHTML;
    assert.match(html, /<option value="Alpha"/, '应列出 Alpha 预设');
    assert.match(html, /<option value="Beta" selected>/, '应选中已配置的 Beta');
    assert.match(html, /beta-1/, '应显示所选预设的模型信息');
    assert.ok(!html.includes('onchange='), '不得残留内联 onchange');
    assert.ok(!html.includes('onclick='), '不得残留内联 onclick');
    assert.match(html, /data-action="memoSettings\.modelChanged"/);
    assert.match(html, /data-action="memoSettings\.autoSave"/);
    assert.match(html, /data-action="memoSettings\.close"/);
  });

  it('未配置模型时选中空选项并提示跟随全局默认', async () => {
    const fresh = await loadSettings({ agentPresets: {} });
    try {
      await fresh.mod.MemoSettingsUI.open();
      const html = fresh.doc.getElementById('memo-settings-host').innerHTML;
      assert.match(html, /<option value="" selected>/, '空选项应被选中');
      assert.match(html, /跟随全局默认/, '应提示回落全局默认');
    } finally { fresh.cleanup(); }
  });

  it('关闭后清空宿主容器', async () => {
    await ctx.mod.MemoSettingsUI.open();
    ctx.mod.MemoSettingsUI.close();
    assert.equal(ctx.doc.getElementById('memo-settings-host').innerHTML, '');
  });
});

describe('memo-settings：保存载荷', () => {
  // 保存组共享一个实例（autoSave 只读控件替身与发请求，无 open 依赖）
  let ctx;
  before(async () => { ctx = await loadSettings(); });
  after(() => { ctx?.cleanup(); });

  it('选定模型与思考强度：写 { agentId, modelPresets: { default } }', async () => {
    attachControls(ctx.doc, { model: 'Alpha', effort: 'high' });
    await ctx.mod.MemoSettingsUI.autoSave();
    const put = lastPut(ctx.requests);
    assert.ok(put, '应发出 PUT');
    assert.equal(put.url, '/protoclaw/agent_model_presets');
    assert.deepEqual(JSON.parse(put.options.body), {
      agentId: 'memo',
      modelPresets: { default: { primary: 'Alpha', thinkingEffort: { primary: 'high' } } },
    });
  });

  it('两个控件都空：default 写 null（回落全局默认）', async () => {
    attachControls(ctx.doc, { model: '', effort: '' });
    await ctx.mod.MemoSettingsUI.autoSave();
    const put = lastPut(ctx.requests);
    assert.deepEqual(JSON.parse(put.options.body), {
      agentId: 'memo',
      modelPresets: { default: null },
    });
  });

  it('保存失败时写入错误状态，不抛错', async () => {
    const failing = await loadSettings({
      onRequest: (url, options) => (options.method === 'PUT'
        ? { ok: false, status: 500, json: async () => ({ error: 'boom' }) }
        : null),
    });
    try {
      await failing.mod.MemoSettingsUI.open();
      attachControls(failing.doc, { model: 'Alpha', effort: '' });
      await failing.mod.MemoSettingsUI.autoSave();
      const status = failing.doc.getElementById('memo-settings-status').innerHTML;
      assert.match(status, /保存失败/);
      assert.match(status, /boom/);
    } finally { failing.cleanup(); }
  });
});
