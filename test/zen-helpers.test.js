import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ZEN_BASE_URL,
  OPENCODE_GO_BASE_URL,
  resolveOpenCodeBaseUrl,
  resolveZenModelProtocol,
  buildZenPresetTemplate,
  parseZenModelsResponse,
} from '../server/zen-helpers.js';

describe('zen-helpers', () => {

  // ── Constants ──────────────────────────────────────────────────

  describe('OpenCode gateway URLs', () => {
    it('uses the official Zen and Go v1 gateways', () => {
      assert.equal(ZEN_BASE_URL, 'https://opencode.ai/zen/v1');
      assert.equal(OPENCODE_GO_BASE_URL, 'https://opencode.ai/zen/go/v1');
    });

    it('resolves the fixed gateway URL from the selected tier', () => {
      assert.equal(resolveOpenCodeBaseUrl('zen'), ZEN_BASE_URL);
      assert.equal(resolveOpenCodeBaseUrl('go'), OPENCODE_GO_BASE_URL);
    });

    it('defaults unknown tiers to Zen instead of accepting an arbitrary endpoint', () => {
      assert.equal(resolveOpenCodeBaseUrl('unknown'), ZEN_BASE_URL);
      assert.equal(resolveOpenCodeBaseUrl(), ZEN_BASE_URL);
    });
  });

  // ── resolveZenModelProtocol ────────────────────────────────────

  describe('resolveZenModelProtocol', () => {

    // -- GPT family → openai / responses --
    it('maps gpt-* models to openai/responses', () => {
      for (const id of ['gpt-5.6-terra', 'gpt-5.5', 'gpt-5.5-pro', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-5.3-codex-spark', 'gpt-5.2', 'gpt-5.2-codex', 'gpt-5.1']) {
        const r = resolveZenModelProtocol(id);
        assert.equal(r.protocol, 'openai', `${id} should be openai`);
        assert.equal(r.apiSurface, 'responses', `${id} should be responses`);
      }
    });

    // -- Grok → openai / responses --
    it('maps grok-* models to openai/responses', () => {
      const r = resolveZenModelProtocol('grok-4.5');
      assert.equal(r.protocol, 'openai');
      assert.equal(r.apiSurface, 'responses');
    });

    // -- Claude → anthropic --
    it('maps claude-* models to anthropic', () => {
      for (const id of ['claude-opus-5', 'claude-sonnet-5', 'claude-3.5-sonnet']) {
        const r = resolveZenModelProtocol(id);
        assert.equal(r.protocol, 'anthropic', `${id} should be anthropic`);
        // anthropic protocol has no apiSurface in the resolver
        assert.ok(!r.apiSurface || r.apiSurface === 'chat', `${id} apiSurface check`);
      }
    });

    // -- GLM → openai / chat --
    it('maps glm-* models to openai/chat', () => {
      for (const id of ['glm-5.2', 'glm-5.1', 'glm-5', 'glm-4.7']) {
        const r = resolveZenModelProtocol(id);
        assert.equal(r.protocol, 'openai', `${id} should be openai`);
        assert.equal(r.apiSurface, 'chat', `${id} should be chat`);
      }
    });

    // -- DeepSeek → openai / chat --
    it('maps deepseek-* models to openai/chat', () => {
      for (const id of ['deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4-flash-free']) {
        const r = resolveZenModelProtocol(id);
        assert.equal(r.protocol, 'openai');
        assert.equal(r.apiSurface, 'chat');
      }
    });

    // -- Kimi → openai / chat --
    it('maps kimi-* models to openai/chat', () => {
      const r = resolveZenModelProtocol('kimi-k2.7-code');
      assert.equal(r.protocol, 'openai');
      assert.equal(r.apiSurface, 'chat');
    });

    // -- MiniMax → openai / chat --
    it('maps minimax-* models to openai/chat', () => {
      const r = resolveZenModelProtocol('minimax-m3');
      assert.equal(r.protocol, 'openai');
      assert.equal(r.apiSurface, 'chat');
    });

    // -- Mimo → openai / chat --
    it('maps mimo-* models to openai/chat', () => {
      const r = resolveZenModelProtocol('mimo-v2.5-free');
      assert.equal(r.protocol, 'openai');
      assert.equal(r.apiSurface, 'chat');
    });

    // -- Unknown model defaults to openai/chat (safest for Zen gateway) --
    it('defaults unknown models to openai/chat', () => {
      const r = resolveZenModelProtocol('some-future-model-v99');
      assert.equal(r.protocol, 'openai');
      assert.equal(r.apiSurface, 'chat');
    });

    // -- Empty / null input --
    it('returns openai/chat for empty or null input', () => {
      assert.deepEqual(resolveZenModelProtocol(''), { protocol: 'openai', apiSurface: 'chat' });
      assert.deepEqual(resolveZenModelProtocol(null), { protocol: 'openai', apiSurface: 'chat' });
      assert.deepEqual(resolveZenModelProtocol(undefined), { protocol: 'openai', apiSurface: 'chat' });
    });

    // -- Case-insensitive --
    it('is case-insensitive for model prefix matching', () => {
      assert.equal(resolveZenModelProtocol('GPT-5.6').protocol, 'openai');
      assert.equal(resolveZenModelProtocol('GPT-5.6').apiSurface, 'responses');
      assert.equal(resolveZenModelProtocol('Claude-Opus-5').protocol, 'anthropic');
      assert.equal(resolveZenModelProtocol('GLM-5.2').apiSurface, 'chat');
    });
  });

  // ── buildZenPresetTemplate ─────────────────────────────────────

  describe('buildZenPresetTemplate', () => {

    it('builds a complete flat preset for a GPT model', () => {
      const preset = buildZenPresetTemplate('gpt-5.6-terra', 'zen-key-abc123');
      assert.equal(preset.name, 'Zen gpt-5.6-terra');
      assert.equal(preset.provider, 'openai');
      assert.equal(preset.apiSurface, 'responses');
      assert.equal(preset.model, 'gpt-5.6-terra');
      assert.equal(preset.baseUrl, ZEN_BASE_URL);
      assert.equal(preset.apiKey, 'zen-key-abc123');
      assert.equal(preset.authType, '');
      assert.equal(preset.clientId, '');
      assert.deepEqual(preset.customHeaders, []);
      // contextLength and compressRatio should have sensible defaults
      assert.ok(preset.contextLength > 0, 'should have positive contextLength');
      assert.ok(preset.compressRatio > 0 && preset.compressRatio <= 100, 'compressRatio in valid range');
    });

    it('builds a preset for a Claude model with anthropic protocol', () => {
      const preset = buildZenPresetTemplate('claude-sonnet-5', 'zen-key-xyz');
      assert.equal(preset.provider, 'anthropic');
      assert.equal(preset.model, 'claude-sonnet-5');
      assert.equal(preset.baseUrl, ZEN_BASE_URL);
      assert.equal(preset.apiKey, 'zen-key-xyz');
    });

    it('builds a preset for a DeepSeek model with openai/chat', () => {
      const preset = buildZenPresetTemplate('deepseek-v4-pro', 'zen-key-ds');
      assert.equal(preset.provider, 'openai');
      assert.equal(preset.apiSurface, 'chat');
      assert.equal(preset.model, 'deepseek-v4-pro');
    });

    it('includes providerName set to "OpenCode Zen"', () => {
      const preset = buildZenPresetTemplate('glm-5.2', 'key');
      assert.equal(preset.providerName, 'OpenCode Zen');
    });

    it('produces a flat preset object compatible with PUT /protoclaw/model_config', () => {
      const preset = buildZenPresetTemplate('gpt-5.5', 'my-key');
      // Must have all fields the backend's buildStructuredModelPresets expects
      assert.ok('name' in preset);
      assert.ok('provider' in preset);
      assert.ok('model' in preset);
      assert.ok('baseUrl' in preset);
      assert.ok('apiKey' in preset);
      assert.ok('authType' in preset);
      assert.ok('apiSurface' in preset);
      assert.ok('thinkingEffort' in preset);
      assert.ok('thinkingBudgetTokens' in preset);
      assert.ok('maxTokens' in preset);
      assert.ok('temperature' in preset);
      assert.ok('vision' in preset);
      assert.ok('contextLength' in preset);
      assert.ok('compressRatio' in preset);
      assert.ok('customHeaders' in preset);
    });
  });

  // ── parseZenModelsResponse ─────────────────────────────────────

  describe('parseZenModelsResponse', () => {

    it('parses a standard OpenAI-format model list', () => {
      const raw = {
        data: [
          { id: 'gpt-5.5', object: 'model' },
          { id: 'claude-sonnet-5', object: 'model' },
          { id: 'deepseek-v4-pro', object: 'model' },
        ],
      };
      const models = parseZenModelsResponse(raw);
      assert.equal(models.length, 3);
      assert.equal(models[0].id, 'gpt-5.5');
      assert.equal(models[0].protocol, 'openai');
      assert.equal(models[0].apiSurface, 'responses');
      assert.equal(models[1].id, 'claude-sonnet-5');
      assert.equal(models[1].protocol, 'anthropic');
      assert.equal(models[2].id, 'deepseek-v4-pro');
      assert.equal(models[2].apiSurface, 'chat');
    });

    it('handles empty data array', () => {
      assert.deepEqual(parseZenModelsResponse({ data: [] }), []);
    });

    it('handles null or missing data', () => {
      assert.deepEqual(parseZenModelsResponse({}), []);
      assert.deepEqual(parseZenModelsResponse(null), []);
      assert.deepEqual(parseZenModelsResponse(undefined), []);
    });

    it('deduplicates model IDs', () => {
      const raw = {
        data: [
          { id: 'gpt-5.5' },
          { id: 'gpt-5.5' },
          { id: 'claude-opus-5' },
        ],
      };
      const models = parseZenModelsResponse(raw);
      assert.equal(models.length, 2);
    });
  });
});
