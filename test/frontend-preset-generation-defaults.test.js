/**
 * 新建模型预设的生成参数默认值回归测试。
 *
 * 历史问题：目录化改造时只给「添加自定义模型」和 Codex 目录模型各自定了默认值，
 * OpenCode 目录模型留在旧的一组（上下文 200000、视觉关、思考关），同一设置页
 * 里三条新增路径给出三套数值。本测试锁定：
 *   - 自定义模型与 OpenCode 目录模型共用同一份通用默认值；
 *   - Codex 目录模型仍取上游真实能力（窗口来自目录、输出预算 0、温度 0）。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createFrontendSandbox } from './helpers/frontend-vm.js';

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

function createSettingsSandbox(overrides = {}) {
  const ctx = createFrontendSandbox({
    renderSettingsOverlay: () => {},
    refreshOAuthStatus: () => {},
    alert: () => {},
    ...overrides,
  });
  // OpenCode 目录添加依赖 oauth-flow.js 的 resolveOpenCodeProtocolClient（协议归类）
  ctx.loadSource('public/src/modules/oauth-flow.js');
  ctx.loadSource('public/src/modules/model-settings.js');
  ctx.run('window.ClawFW = window.ClawFW || {}');
  return ctx;
}

function seedSettingsData(ctx, { presets = [], catalog, tier = 'zen' } = {}) {
  ctx.run(`window.ClawFW.settingsData = ${JSON.stringify({
    config: { defaultModel: {}, agent: {} },
    presets,
    connections: { opencode: { hasApiKey: true, tier } },
  })}`);
  if (catalog) {
    ctx.run(`window.ClawFW.modelCatalogs = { ${catalog.provider}: ${JSON.stringify(catalog.value)} }`);
  }
}

// vm 沙箱对象来自另一个 realm，deepStrictEqual 会因原型不同而失败；
// 经 JSON 往返转成本 realm 的普通对象再比较。
function pickGeneration(preset) {
  const picked = {};
  for (const field of GENERATION_FIELDS) picked[field] = preset[field];
  return JSON.parse(JSON.stringify(picked));
}

async function addCatalogModel(ctx, provider, ids) {
  await ctx.run(`addCatalogModels(${JSON.stringify(provider)}, ${JSON.stringify(ids)})`);
}

describe('新建模型预设的生成参数默认值', () => {
  it('自定义模型新增时使用通用默认值', () => {
    const ctx = createSettingsSandbox();
    seedSettingsData(ctx);
    ctx.run('addSettingsPreset()');
    const preset = ctx.run('window.ClawFW.settingsData.presets[0]');
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

  it('OpenCode 目录模型与自定义模型共用同一份默认值', async () => {
    const ctx = createSettingsSandbox();
    seedSettingsData(ctx, {
      catalog: {
        provider: 'opencode',
        value: { models: [{ id: 'claude-haiku-5-5', protocol: 'anthropic', apiSurface: 'chat' }], loaded: true },
      },
    });
    await addCatalogModel(ctx, 'opencode', ['claude-haiku-5-5']);
    const opencodePreset = ctx.run('window.ClawFW.settingsData.presets[0]');

    seedSettingsData(ctx);
    ctx.run('addSettingsPreset()');
    const customPreset = ctx.run('window.ClawFW.settingsData.presets[0]');

    assert.deepEqual(pickGeneration(opencodePreset), pickGeneration(customPreset));
  });

  it('Codex 目录声明的 Fast 档位写入预设请求参数，标准默认不强制指定档位', async () => {
    const ctx = createSettingsSandbox();
    seedSettingsData(ctx, {
      catalog: {
        provider: 'codex',
        value: { models: [{ id: 'gpt-6-luna', serviceTiers: [{ id: 'priority', name: 'Fast', description: 'Fast service' }], defaultServiceTier: null }], loaded: true },
      },
    });
    await addCatalogModel(ctx, 'codex', ['gpt-6-luna']);
    const preset = ctx.run('window.ClawFW.settingsData.presets[0]');
    assert.equal(preset.providerOptions.service_tier, undefined);
    assert.deepEqual(JSON.parse(JSON.stringify(preset.serviceTiers)), [{ id: 'priority', name: 'Fast', description: 'Fast service' }]);

  });

  it('Codex 目录模型保留上游真实能力，不被通用默认值覆盖', async () => {
    const ctx = createSettingsSandbox();
    seedSettingsData(ctx, {
      catalog: {
        provider: 'codex',
        value: {
          models: [{ id: 'gpt-6-sol', contextLength: 272000, thinkingEffort: 'high' }],
          loaded: true,
        },
      },
    });
    await addCatalogModel(ctx, 'codex', ['gpt-6-sol']);
    const preset = ctx.run('window.ClawFW.settingsData.presets[0]');
    assert.equal(preset.contextLength, 272000);
    assert.equal(preset.thinkingEffort, 'high');
    assert.equal(preset.maxTokens, 0);
    assert.equal(preset.temperature, 0);
    assert.equal(preset.thinkingBudgetTokens, null);
    assert.equal(preset.vision, true);
  });
});
