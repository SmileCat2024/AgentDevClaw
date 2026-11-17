import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { prepareClassicSandbox } from './p2-classic-hosts.js';

/**
 * 模型设置「额外请求体参数」与 Codex 倍率模式的回归测试。
 *
 * 全部断言都走公开入口（data-action="modelSettings.*" 经真实分发器）：
 *   - 非法请求体参数：savePreset 被拒、预设不被改写、错误区出现文案；
 *   - 合法扩展：savePreset 落盘 providerOptions；
 *   - 倍率模式：editPreset 渲染的表单里出现「标准 / Fast」，savePreset 双向写入；
 *   - 目录未声明 priority 档位的模型不提供 Fast（改用档位缺失提示）。
 * 因此设置面板不需要为测试暴露内部渲染/校验函数（配方「只导出跨文件键」）。
 *
 * 装载路线（ESM 迁移配方第三节）：真实 import + 最小 window/document 桩。
 * 保存链打桩 fetch（PUT /protoclaw/model_config 回显请求体），保存 → 服务端
 * 回读 → 重渲染整条链都走产品代码。
 */

/** 按 id 持久化的追踪型 DOM stub：记录 innerHTML 写入，可断言渲染产物 */
function createTrackingDocument() {
  const elements = new Map();
  const makeElement = (id) => ({
    id,
    style: {},
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    appendChild() {}, removeChild() {}, insertAdjacentHTML() {},
    addEventListener() {}, removeEventListener() {},
    setAttribute() {}, removeAttribute() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    innerHTML: '',
    textContent: '',
    value: '',
    checked: false,
    type: 'text',
  });
  const trackingDocument = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeElement(id));
      return elements.get(id);
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => makeElement(''),
    createTextNode: (text) => ({ textContent: text }),
    addEventListener() {},
    body: makeElement('body'),
    head: makeElement('head'),
    documentElement: makeElement('html'),
    activeElement: null,
    readyState: 'complete',
  };
  trackingDocument.elements = elements;
  return trackingDocument;
}

/**
 * 一次用例 = 一份跟踪型 document + 一张真实 ESM 图（含 model-settings 的静态依赖链）。
 * PUT /protoclaw/model_config 打桩回显请求体：保存 → 服务端回读 → 重渲染整条链
 * 都走产品代码。
 */
async function withSettingsHarness(fn) {
  const doc = createTrackingDocument();
  // 服务端载荷：seedSettingsData 只换「服务端给什么」，设置面板经 openSettings
  // 的真实读取链取得设置数据（设置态归 model-settings 模块私有）。
  const server = { config: { defaultModel: {}, agent: {} }, presets: [], catalogs: {} };
  return withP2EsmCase({
    globals: {
      document: doc,
      fetch: async (url, options) => {
        if (String(url) === '/protoclaw/model_config' && options?.method === 'PUT') {
          const body = JSON.parse(options.body);
          server.config = body.config;
          server.presets = body.presets;
          return { ok: true, json: async () => ({ config: body.config, presets: body.presets }) };
        }
        if (String(url) === '/protoclaw/model_config') {
          return { ok: true, json: async () => ({ config: server.config, presets: server.presets }) };
        }
        if (String(url).startsWith('/protoclaw/model_catalog/') && options?.method === 'POST') {
          const provider = decodeURIComponent(String(url).slice('/protoclaw/model_catalog/'.length));
          return { ok: true, json: async () => server.catalogs[provider] || { models: [] } };
        }
        return { ok: true, json: async () => ({}) };
      },
    },
    classic: (sandbox) => {
      sandbox.run('window.__clawAuthReady = new Promise(() => {}); applyTheme = () => {}; applyLanguage = () => {};'
        + 'ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };');
      prepareClassicSandbox(sandbox);
    },
  }, async (c) => {
    const module = await c.load('public/src/modules/model-settings.js');
    // 保存链写入的预设经 model-preset-cache 命名面回读（model-settings 的静态
    // 依赖链已装载它，这里取同一实例；设置态本身归模块私有）。
    const presetCache = await c.load('public/src/modules/model-preset-cache.js');
    return fn({
      doc,
      module,
      presetCache,
      server,
      /** 后台刷新链（目录 / OAuth 状态）跑完再返回 */
      settle: () => new Promise((resolve) => { setImmediate(resolve); }),
    });
  });
}

/**
 * 真实用户路径打开设置面板：服务端载荷 → openSettings（设置态归模块私有）；
 * 目录数据只登记「服务端给什么」，由真实加载路径（编辑 Codex 预设时的
 * refreshModelCatalog → POST /protoclaw/model_catalog/<provider>）进入。
 */
async function seedSettingsData(h, { presets = [], catalogs = null } = {}) {
  h.server.config = { defaultModel: {}, agent: {} };
  h.server.presets = presets;
  if (catalogs) {
    for (const [provider, value] of Object.entries(catalogs)) {
      h.server.catalogs[provider] = { models: Array.isArray(value?.models) ? value.models : [] };
    }
  }
  await h.module.openSettings();
}

/** 真实用户路径：点预设卡片的「编辑」 */
async function openEditForm(h, idx) {
  window.ClawFW.actions.invoke('modelSettings.editPreset', { dataset: {} }, { type: 'click' }, idx);
  await h.settle();
}

/** 真实用户路径：点编辑表单的「保存」 */
async function savePreset(h, idx) {
  const dispatched = window.ClawFW.actions.invoke('modelSettings.savePreset', { dataset: {} }, { type: 'click' }, idx);
  await h.settle();
  return dispatched;
}

function overlayHtml(h) {
  return h.doc.getElementById('settings-overlay-host').innerHTML;
}

function providerOptionsTextarea(html) {
  const match = html.match(/<textarea[^>]*id="settings-preset-provider-options"[^>]*>([\s\S]*?)<\/textarea>/);
  assert.ok(match, '编辑表单包含额外请求体参数输入框');
  return match[1];
}

describe('model settings provider request body options', () => {
  it('savePreset 拒绝会覆盖协议保留字段或超深嵌套的 JSON，且不改写预设', async () => {
    const cases = [
      { json: '{"messages":[]}', overrides: {} },
      { json: '{"parallel_tool_calls":false}', overrides: { apiSurface: 'responses' } },
      { json: '{"input":[]}', overrides: { apiSurface: 'responses' } },
      { json: '{"nested":{"constructor":{}}}', overrides: {} },
      { json: '[]', overrides: {} },
      { json: '{"temperature":0}', overrides: { provider: 'unknown-provider' } },
    ];
    for (const { json, overrides } of cases) {
      await withSettingsHarness(async (h) => {
        await seedSettingsData(h, {
          presets: [{
            name: '回归用模型',
            provider: 'openai',
            apiSurface: 'chat',
            model: 'gpt-test',
            baseUrl: 'https://api.example.com/v1',
            providerOptions: { keep: true },
            ...overrides,
          }],
        });
        h.doc.getElementById('settings-preset-provider-options').value = json;
        await savePreset(h, 0);

        assert.deepEqual(h.presetCache.getClawModelPresets()[0].providerOptions, { keep: true }, json + ' 不应被写入');
        assert.notEqual(h.doc.getElementById('settings-provider-options-error').textContent, '', json + ' 应显示错误文案');
      });
    }

    // 超深嵌套（35 层）同样被拒
    await withSettingsHarness(async (h) => {
      await seedSettingsData(h, {
        presets: [{ name: 'deep', provider: 'openai', apiSurface: 'chat', model: 'gpt-test', providerOptions: { keep: true } }],
      });
      const deeplyNested = { value: {} };
      let current = deeplyNested;
      for (let i = 0; i < 35; i++) { current.value = {}; current = current.value; }
      h.doc.getElementById('settings-preset-provider-options').value = JSON.stringify(deeplyNested);
      await savePreset(h, 0);
      assert.deepEqual(h.presetCache.getClawModelPresets()[0].providerOptions, { keep: true });
      assert.notEqual(h.doc.getElementById('settings-provider-options-error').textContent, '');
    });
  });

  it('savePreset 接受 provider 自有扩展字段', async () => {
    await withSettingsHarness(async (h) => {
      await seedSettingsData(h, {
        presets: [{ name: 'ext', provider: 'openai', apiSurface: 'responses', model: 'gpt-test', providerOptions: {} }],
      });
      h.doc.getElementById('settings-preset-provider-options').value = '{"temperature":0,"service_tier":"priority","custom":{"enabled":true}}';
      await savePreset(h, 0);
      assert.deepEqual(h.presetCache.getClawModelPresets()[0].providerOptions, {
        temperature: 0,
        service_tier: 'priority',
        custom: { enabled: true },
      });
    });
  });

  it('编辑表单渲染标准/Fast 倍率并双向保存（Codex 目录与 legacy OAuth 预设）', async () => {
    for (const identity of [{ catalogProvider: 'codex' }, { authType: 'oauth-codex' }]) {
      await withSettingsHarness(async (h) => {
        await seedSettingsData(h, {
          presets: [{
            name: 'Codex test', model: 'gpt-test', provider: 'openai', apiSurface: 'responses',
            ...identity, providerOptions: { custom_flag: true },
          }],
          catalogs: {
            codex: {
              loaded: true,
              models: [{ id: 'gpt-test', serviceTiers: [{ id: 'priority', name: 'Fast', description: '2x speed, increased usage' }] }],
            },
          },
        });

        await openEditForm(h, 0);
        const initialHtml = overlayHtml(h);
        assert.match(initialHtml, /settings-preset-service-tier/);
        assert.match(initialHtml, />标准<\/option>/);
        assert.match(initialHtml, /倍率模式/);
        assert.doesNotMatch(initialHtml, /仅填写当前接口协议适配支持的请求体字段|Fast 更快|2x speed, increased usage/);
        assert.match(initialHtml, /value="priority"[^>]*>Fast/);

        h.doc.getElementById('settings-preset-service-tier').value = 'priority';
        h.doc.getElementById('settings-preset-provider-options').value = '{"custom_flag":true}';
        h.doc.getElementById('settings-preset-name').value = 'Codex test';
        await savePreset(h, 0);
        assert.equal(h.presetCache.getClawModelPresets()[0].providerOptions.service_tier, 'priority');

        await openEditForm(h, 0);
        const savedHtml = overlayHtml(h);
        assert.match(savedHtml, /value="priority" selected/);
        assert.doesNotMatch(providerOptionsTextarea(savedHtml), /service_tier/);

        h.doc.getElementById('settings-preset-service-tier').value = '';
        h.doc.getElementById('settings-preset-provider-options').value = '{"custom_flag":true}';
        await savePreset(h, 0);
        assert.equal(h.presetCache.getClawModelPresets()[0].providerOptions.service_tier, undefined);
        assert.equal(h.presetCache.getClawModelPresets()[0].providerOptions.custom_flag, true);
      });
    }
  });

  it('目录未声明 priority 档位的 Codex 模型不提供 Fast，改显示档位缺失提示', async () => {
    await withSettingsHarness(async (h) => {
      await seedSettingsData(h, {
        presets: [
          { name: 'fast', model: 'gpt-fast', provider: 'openai', apiSurface: 'responses', catalogProvider: 'codex' },
          { name: 'standard', model: 'gpt-standard', provider: 'openai', apiSurface: 'responses', catalogProvider: 'codex' },
        ],
        catalogs: {
          codex: {
            loaded: true,
            models: [
              { id: 'gpt-fast', serviceTiers: [{ id: 'priority', name: 'Fast', description: 'Fast tier' }] },
              { id: 'gpt-standard', serviceTiers: [] },
            ],
          },
        },
      });

      await openEditForm(h, 0);
      assert.match(overlayHtml(h), /value="priority"[^>]*>Fast/, '声明了 priority 档位的模型提供 Fast');

      await openEditForm(h, 1);
      const standardHtml = overlayHtml(h);
      assert.doesNotMatch(standardHtml, />Fast<\/option>/, '未声明 priority 档位的模型不提供 Fast');
      assert.match(standardHtml, /尚无可用的加速档位信息/, '改显示档位缺失提示');
    });
  });
});
