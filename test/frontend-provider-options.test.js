import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

function createSettingsSandbox() {
  const ctx = createFrontendSandbox({ alert: () => {} });
  ctx.run("let currentLanguage = 'en'; window.ClawFW = {};");
  ctx.loadSource('public/src/modules/model-settings.js');
  return ctx;
}

describe('model settings provider request body options', () => {
  it('rejects JSON values that could override protocol-owned request fields', () => {
    const ctx = createSettingsSandbox();
    for (const [json, protocol, surface] of [
      ['{"messages":[]}', 'openai', 'chat'],
      ['{"parallel_tool_calls":false}', 'openai', 'responses'],
      ['{"input":[]}', 'openai', 'responses'],
      ['{"nested":{"constructor":{}}}', 'openai', 'chat'],
      ['[]', 'openai', 'chat'],
      ['{"temperature":0}', 'unknown-provider', 'chat'],
    ]) {
      const result = ctx.run(`validateProviderOptionsDraft(${JSON.stringify(json)}, ${JSON.stringify(protocol)}, ${JSON.stringify(surface)})`);
      assert.equal(result.valid, false, json);
    }
  });

  it('allows provider-owned extensions while rejecting keys below unsafe nesting depth', () => {
    const ctx = createSettingsSandbox();
    const allowed = ctx.run(`validateProviderOptionsDraft('{"temperature":0,"service_tier":"priority","custom":{"enabled":true}}', 'openai', 'responses')`);
    assert.equal(allowed.valid, true);
    assert.deepEqual(JSON.parse(JSON.stringify(allowed.value)), { temperature: 0, service_tier: 'priority', custom: { enabled: true } });

    const deeplyNested = { value: {} };
    let current = deeplyNested;
    for (let i = 0; i < 35; i++) { current.value = {}; current = current.value; }
    const rejected = ctx.run(`validateProviderOptionsDraft(${JSON.stringify(JSON.stringify(deeplyNested))}, 'openai', 'chat')`);
    assert.equal(rejected.valid, false);
  });

  it('renders Normal/Fast and saves both directions for catalog and legacy OAuth presets', async () => {
    for (const identity of [{ catalogProvider: 'codex' }, { authType: 'oauth-codex' }]) {
      const ctx = createSettingsSandbox();
      ctx.escapeHtml = (value) => String(value ?? '');
      ctx.run(`var _oauthPollTimer = null;
        window.ClawFW.settingsData = { config: {}, presets: [{
          name: 'Codex test', model: 'gpt-test', provider: 'openai', apiSurface: 'responses',
          ...${JSON.stringify(identity)}, providerOptions: { custom_flag: true }
        }] };
        window.ClawFW.modelCatalogs = { codex: { loaded: true, models: [{ id: 'gpt-test', serviceTiers: [{ id: 'priority', name: 'Fast', description: '2x speed, increased usage' }] }] } };
        saveSettingsConfig = async () => true;
        applySettingsPreset = async () => {};
      `);
      const elements = {
        'settings-preset-service-tier': { value: 'priority' },
        'settings-preset-provider-options': { value: '{"custom_flag":true}', classList: { add() {}, remove() {} } },
        'settings-preset-name': { value: 'Codex test' },
      };
      ctx.document.getElementById = (id) => elements[id] || null;
      const initialHtml = ctx.run('renderSettingsEditForm(0, window.ClawFW.settingsData.presets, true)');
      assert.match(initialHtml, /settings-preset-service-tier/);
      assert.match(initialHtml, />标准<\/option>/);
      assert.match(initialHtml, /倍率模式/);
      assert.doesNotMatch(initialHtml, /仅填写当前接口协议适配支持的请求体字段|Fast 更快|2x speed, increased usage/);
      assert.match(initialHtml, /value="priority"[^>]*>Fast/);
      await ctx.run('saveSettingsPreset(0)');
      assert.equal(ctx.run('window.ClawFW.settingsData.presets[0].providerOptions.service_tier'), 'priority');
      const savedHtml = ctx.run('renderSettingsEditForm(0, window.ClawFW.settingsData.presets, true)');
      assert.match(savedHtml, /value="priority" selected/);
      assert.doesNotMatch(savedHtml.match(/<textarea[^>]*id="settings-preset-provider-options"[^>]*>([\s\S]*?)<\/textarea>/)[1], /service_tier/);
      elements['settings-preset-service-tier'].value = '';
      await ctx.run('saveSettingsPreset(0)');
      assert.equal(ctx.run('window.ClawFW.settingsData.presets[0].providerOptions.service_tier'), undefined);
      assert.equal(ctx.run('window.ClawFW.settingsData.presets[0].providerOptions.custom_flag'), true);
    }
  });

  it('does not offer Fast for Codex models without a declared priority tier', () => {
    const ctx = createSettingsSandbox();
    ctx.run(`window.ClawFW = { modelCatalogs: { codex: { models: [
      { id: 'gpt-fast', serviceTiers: [{ id: 'priority', name: 'Fast', description: 'Fast tier' }] },
      { id: 'gpt-standard', serviceTiers: [] }
    ] } } };`);
    const selected = ctx.run(`getCodexServiceTiers({ model: 'gpt-fast' }, window.ClawFW.modelCatalogs.codex.models[0])`);
    const standard = ctx.run(`getCodexServiceTiers({ model: 'gpt-standard' }, window.ClawFW.modelCatalogs.codex.models[1])`);
    assert.deepEqual(JSON.parse(JSON.stringify(selected)), [{ id: 'priority', name: 'Fast', description: 'Fast tier' }]);
    assert.deepEqual(JSON.parse(JSON.stringify(standard)), []);
  });
});
