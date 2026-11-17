import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { prepareClassicSandbox } from './p2-classic-hosts.js';

/**
 * 新建模型预设的生成参数默认值回归测试。
 *
 * 历史问题：目录化改造时只给「添加自定义模型」和 Codex 目录模型各自定了默认值，
 * OpenCode 目录模型留在旧的一组（上下文 200000、视觉关、思考关），同一设置页
 * 里三条新增路径给出三套数值。本测试锁定：
 *   - 自定义模型与 OpenCode 目录模型共用同一份通用默认值；
 *   - Codex 目录模型仍取上游真实能力（窗口来自目录、输出预算 0、温度 0）。
 *
 * 装载路线：一次用例 = 一份真实沙箱 window + 一张真实 ESM 图（`withP2EsmCase`
 * 的 case 级命名空间，静态依赖的 defineKey / claim 每 case 在本 case 的
 * KernelState 上重新发生）。classic 相按 index.html 的先行脚本序装载真实实现。
 * 两条新增路径都走真实用户入口：分发器的 modelSettings.addPreset /
 * modelSettings.addCatalogModel（可添加列表的可选行由设置面板真实渲染写入）。
 */

/** 按 id 复用的 DOM 桩：设置面板渲染与读取走同一元素实例。 */
function createDocumentStub() {
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
  return {
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
}

async function withSettingsCase(fn) {
  const document = createDocumentStub();
  // 服务端载荷：seedSettingsData 只换「服务端给什么」，设置面板经 openSettings
  // 的真实读取链取得设置数据（设置态归 model-settings 模块私有）。
  const server = { config: { defaultModel: {}, agent: {} }, presets: [], connections: null, catalogs: {} };
  return withP2EsmCase({
    globals: {
      document,
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
        if (String(url) === '/protoclaw/model_connections') {
          return { ok: true, json: async () => server.connections || {} };
        }
        if (String(url).startsWith('/protoclaw/model_catalog/') && options?.method === 'POST') {
          const provider = decodeURIComponent(String(url).slice('/protoclaw/model_catalog/'.length));
          return { ok: true, json: async () => server.catalogs[provider] || { models: [] } };
        }
        return { ok: true, json: async () => ({}) };
      },
    },
    classic: (sandbox) => {
      prepareClassicSandbox(sandbox);
      // markdown-utils 在求值期读取该桥键值（生产由 markdown-bootstrap classic 注册）
      sandbox.KernelState.defineKey('markdown-utils', 'escapeHtml', (value) => String(value ?? ''));
    },
  }, async (c) => {
    const module = await c.load('public/src/modules/model-settings.js');
    // 预设列表经 model-preset-cache 命名面回读（model-settings 的静态依赖链已
    // 装载它，这里取同一实例；设置态本身归 model-settings 模块私有）。
    const presetCache = await c.load('public/src/modules/model-preset-cache.js');
    return fn({ c, module, presetCache, server });
  });
}

/**
 * 真实用户路径装载设置数据：服务端载荷 → openSettings（设置态归模块私有）；
 * 目录数据只登记「服务端给什么」，由 addCatalogRow 的公开加载路径进入。
 */
async function seedSettingsData(h, { presets = [], catalog, tier = 'zen' } = {}) {
  h.server.config = { defaultModel: {}, agent: {} };
  h.server.presets = presets;
  h.server.connections = { opencode: { hasApiKey: true, tier } };
  if (catalog) {
    h.server.catalogs[catalog.provider] = { models: Array.isArray(catalog.value?.models) ? catalog.value.models : [] };
  }
  await h.module.openSettings();
}

/**
 * 真实用户路径的目录模型新增：先按公开加载路径取目录（refreshModelCatalog →
 * POST /protoclaw/model_catalog/<provider>），再渲染 provider 页签（写入可添加行
 * 索引），最后经分发器点第 row 行。
 */
async function addCatalogRow(h, provider, row = 0) {
  await h.module.refreshModelCatalog(provider);
  window.ClawFW.settingsTab = provider;
  h.module.renderSettingsOverlay();
  return window.ClawFW.actions.invoke('modelSettings.addCatalogModel', { dataset: { provider, row: String(row) } }, { type: 'click' });
}

const GENERATION_FIELDS = [
  'thinkingEffort',
  'thinkingBudgetTokens',
  'maxTokens',
  'temperature',
  'vision',
  'contextLength',
  'compressRatio',
  'customHeaders',
];

function pickGeneration(preset) {
  const picked = {};
  for (const field of GENERATION_FIELDS) picked[field] = preset[field];
  return picked;
}

describe('新建模型预设的生成参数默认值', () => {
  it('自定义模型新增时使用通用默认值', async () => {
    await withSettingsCase(async (h) => {
      await seedSettingsData(h);
      window.ClawFW.actions.invoke('modelSettings.addPreset', { dataset: {} }, { type: 'click' });
      const preset = h.presetCache.getClawModelPresets()[0];
      assert.deepEqual(pickGeneration(preset), {
        thinkingEffort: 'medium',
        thinkingBudgetTokens: 32000,
        maxTokens: 96000,
        temperature: null,
        vision: true,
        contextLength: 1000000,
        compressRatio: 80,
        customHeaders: [],
      });
    });
  });

  it('OpenCode 目录模型与自定义模型共用同一份默认值', async () => {
    await withSettingsCase(async (h) => {
      await seedSettingsData(h, {
        catalog: {
          provider: 'opencode',
          value: { models: [{ id: 'claude-haiku-5-5', protocol: 'anthropic', apiSurface: 'chat' }], loaded: true },
        },
      });
      await addCatalogRow(h, 'opencode');
      const opencodePreset = h.presetCache.getClawModelPresets()[0];

      await seedSettingsData(h);
      window.ClawFW.actions.invoke('modelSettings.addPreset', { dataset: {} }, { type: 'click' });
      const customPreset = h.presetCache.getClawModelPresets()[0];

      assert.deepEqual(pickGeneration(opencodePreset), pickGeneration(customPreset));
    });
  });

  it('Codex 目录声明的 Fast 档位写入预设请求参数，标准默认不强制指定档位', async () => {
    await withSettingsCase(async (h) => {
      await seedSettingsData(h, {
        catalog: {
          provider: 'codex',
          value: { models: [{ id: 'gpt-6-luna', serviceTiers: [{ id: 'priority', name: 'Fast', description: 'Fast service' }], defaultServiceTier: null }], loaded: true },
        },
      });
      await addCatalogRow(h, 'codex');
      const preset = h.presetCache.getClawModelPresets()[0];
      assert.equal(preset.providerOptions.service_tier, undefined);
      assert.deepEqual(preset.serviceTiers, [{ id: 'priority', name: 'Fast', description: 'Fast service' }]);
    });
  });

  it('Codex 目录模型保留上游真实能力，不被通用默认值覆盖', async () => {
    await withSettingsCase(async (h) => {
      await seedSettingsData(h, {
        catalog: {
          provider: 'codex',
          value: {
            models: [{ id: 'gpt-6-sol', contextLength: 272000, thinkingEffort: 'high' }],
            loaded: true,
          },
        },
      });
      await addCatalogRow(h, 'codex');
      const preset = h.presetCache.getClawModelPresets()[0];
      assert.equal(preset.contextLength, 272000);
      assert.equal(preset.thinkingEffort, 'high');
      assert.equal(preset.maxTokens, 0);
      assert.equal(preset.temperature, 0);
      assert.equal(preset.thinkingBudgetTokens, null);
      assert.equal(preset.vision, true);
    });
  });
});

describe('用例隔离（整图每 case 重建）', () => {
  it('两个连续 case：语言、目录数据与预设列表不跨 case 泄漏', async () => {
    let firstPresets = null;
    await withSettingsCase(async (h) => {
      const i18n = await h.c.load('public/src/modules/i18n-environment-state.js');
      i18n.setCurrentLanguage('en');
      await seedSettingsData(h, {
        catalog: { provider: 'codex', value: { models: [{ id: 'leak-probe' }], loaded: true } },
      });
      window.ClawFW.actions.invoke('modelSettings.addPreset', { dataset: {} }, { type: 'click' });
      firstPresets = h.presetCache.getClawModelPresets();
      assert.equal(firstPresets.length, 1);
      assert.equal(i18n.getCurrentLanguage(), 'en');
    });

    await withSettingsCase(async (h) => {
      const i18n = await h.c.load('public/src/modules/i18n-environment-state.js');
      // classic 相播种的语言初值，而不是上一 case 的 en
      assert.equal(i18n.getCurrentLanguage(), 'zh', '语言状态不得跨 case 继承');
      // 设置数据在本 case 的模块实例里是空初值（每 case 一份模块图），不继承上一 case 的预设
      assert.equal(h.presetCache.getClawModelPresets().length, 0, '设置数据不得跨 case 泄漏');
      await seedSettingsData(h);
      window.ClawFW.actions.invoke('modelSettings.addPreset', { dataset: {} }, { type: 'click' });
      assert.equal(h.presetCache.getClawModelPresets().length, 1);
      assert.notEqual(h.presetCache.getClawModelPresets(), firstPresets, '预设数组不得复用上一 case 的引用');
      // i18n 域在本 case 的 KernelState 上被认领（不是悬空 claim）
      assert.equal(h.c.read('window.KernelState.stats().claimedKeys > 0'), true);
    });
  });
});
