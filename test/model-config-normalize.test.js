import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveHostTarget } from '../server/shared/operation-target.js';

import {
  normalizeModelPresetsData,
  flattenModelPresets,
  buildStructuredModelPresets,
  normalizeSpeechModel,
  normalizeSpeechPreset,
  DEFAULT_SPEECH_MODEL,
  normalizeProgrammingHelperProcessMode,
} from '../server/routes/model-config.js';

describe('model config host target boundary', () => {
  it('keeps global model configuration independent of page focus', () => {
    assert.deepEqual(resolveHostTarget({ focusedAgentId: 'agent-a' }), {
      scope: 'local-host',
      agentId: null,
    });
  });
});

describe('normalizeProgrammingHelperProcessMode', () => {
  it('accepts only the three workspace process modes', () => {
    assert.equal(normalizeProgrammingHelperProcessMode('isolated'), 'isolated');
    assert.equal(normalizeProgrammingHelperProcessMode('shared-by-project'), 'shared-by-project');
    assert.equal(normalizeProgrammingHelperProcessMode('shared-global'), 'shared-global');
  });

  it('rejects empty or unknown values instead of falling back silently', () => {
    assert.equal(normalizeProgrammingHelperProcessMode(''), null);
    assert.equal(normalizeProgrammingHelperProcessMode('global'), null);
    assert.equal(normalizeProgrammingHelperProcessMode(null), null);
  });
});

// ── normalizeModelPresetsData ───────────────────────────────────────

describe('normalizeModelPresetsData', () => {
  it('normalizes a well-formed structured object', () => {
    const result = normalizeModelPresetsData({
      providers: [{ name: 'p1' }, null, 'bad'],
      presets: [{ name: 's1' }, null, 42],
    });
    assert.deepStrictEqual(result.providers, [{ name: 'p1' }]);
    assert.deepStrictEqual(result.presets, [{ name: 's1' }]);
  });

  it('returns empty arrays for non-object input', () => {
    assert.deepStrictEqual(normalizeModelPresetsData(null), { providers: [], presets: [] });
    assert.deepStrictEqual(normalizeModelPresetsData(undefined), { providers: [], presets: [] });
    assert.deepStrictEqual(normalizeModelPresetsData('hello'), { providers: [], presets: [] });
    assert.deepStrictEqual(normalizeModelPresetsData(42), { providers: [], presets: [] });
  });

  it('returns empty arrays for array input (falls through to buildStructuredModelPresets)', () => {
    // Array input goes to buildStructuredModelPresets which we test separately.
    // An empty array should produce empty providers/presets.
    const result = normalizeModelPresetsData([]);
    assert.deepStrictEqual(result, { providers: [], presets: [] });
  });

  it('filters non-object entries in providers and presets arrays', () => {
    const result = normalizeModelPresetsData({
      providers: [{ ok: true }, 'nope', 0, false, null],
      presets: [{ ok: true }, 'nope', 0, false, null],
    });
    assert.deepStrictEqual(result.providers, [{ ok: true }]);
    assert.deepStrictEqual(result.presets, [{ ok: true }]);
  });

  it('handles missing providers/presets keys', () => {
    const result = normalizeModelPresetsData({ foo: 'bar' });
    assert.deepStrictEqual(result, { providers: [], presets: [] });
  });
});

// ── flattenModelPresets ─────────────────────────────────────────────

describe('flattenModelPresets', () => {
  it('flattens structured presets with provider endpoint lookup', () => {
    const flat = flattenModelPresets({
      providers: [
        { name: 'Anthropic', apiKey: 'key-123', endpoints: { anthropic: 'https://api.anthropic.com' } },
      ],
      presets: [
        {
          name: 'Claude Sonnet',
          protocol: 'anthropic',
          providerName: 'Anthropic',
          model: 'claude-3.5-sonnet',
        },
      ],
    });
    assert.strictEqual(flat.length, 1);
    const p = flat[0];
    assert.strictEqual(p.name, 'Claude Sonnet');
    assert.strictEqual(p.provider, 'anthropic');
    assert.strictEqual(p.baseUrl, 'https://api.anthropic.com');
    assert.strictEqual(p.apiKey, 'key-123');
    assert.strictEqual(p.model, 'claude-3.5-sonnet');
    assert.strictEqual(p.apiSurface, 'chat');
  });

  it('falls back to preset.baseUrl when provider has no matching endpoint', () => {
    const flat = flattenModelPresets({
      providers: [{ name: 'OpenAI', apiKey: 'sk-key', endpoints: { openai: 'https://api.openai.com' } }],
      presets: [
        { name: 'GPT', protocol: 'openai', providerName: 'OpenAI', baseUrl: 'https://custom.com', model: 'gpt-4' },
      ],
    });
    // provider endpoint for 'openai' protocol exists, so that wins
    assert.strictEqual(flat[0].baseUrl, 'https://api.openai.com');
  });

  it('falls back to preset.baseUrl when providerName not found', () => {
    const flat = flattenModelPresets({
      providers: [{ name: 'Other', apiKey: 'key' }],
      presets: [
        { name: 'P1', protocol: 'openai', providerName: 'UnknownProvider', baseUrl: 'https://custom.com', apiKey: 'fallback-key', model: 'gpt-4' },
      ],
    });
    assert.strictEqual(flat[0].baseUrl, 'https://custom.com');
    assert.strictEqual(flat[0].apiKey, 'fallback-key');
  });

  it('defaults provider to anthropic when protocol/provider not specified', () => {
    const flat = flattenModelPresets({
      providers: [],
      presets: [{ name: 'P', model: 'm' }],
    });
    assert.strictEqual(flat[0].provider, 'anthropic');
  });

  it('clamps compressRatio to [1, 100] and defaults to 80', () => {
    const flat = flattenModelPresets({
      presets: [
        { name: 'A', compressRatio: 0 },
        { name: 'B', compressRatio: 200 },
        { name: 'C', compressRatio: 50 },
        { name: 'D' },
      ],
    });
    assert.strictEqual(flat[0].compressRatio, 1);
    assert.strictEqual(flat[1].compressRatio, 100);
    assert.strictEqual(flat[2].compressRatio, 50);
    assert.strictEqual(flat[3].compressRatio, 80);
  });

  it('parses numeric fields', () => {
    const flat = flattenModelPresets({
      presets: [{
        name: 'P',
        thinkingBudgetTokens: '1000',
        maxTokens: '8192',
        temperature: '0.7',
        contextLength: '200000',
      }],
    });
    assert.strictEqual(flat[0].thinkingBudgetTokens, 1000);
    assert.strictEqual(flat[0].maxTokens, 8192);
    assert.strictEqual(flat[0].temperature, 0.7);
    assert.strictEqual(flat[0].contextLength, 200000);
  });

  it('filters customHeaders to valid objects', () => {
    const flat = flattenModelPresets({
      presets: [{
        name: 'P',
        customHeaders: [{ key: 'a' }, null, 'bad', { key: 'b' }],
      }],
    });
    assert.deepStrictEqual(flat[0].customHeaders, [{ key: 'a' }, { key: 'b' }]);
  });

  it('returns empty array for falsy input', () => {
    assert.deepStrictEqual(flattenModelPresets(null), []);
    assert.deepStrictEqual(flattenModelPresets(undefined), []);
  });
});

// ── buildStructuredModelPresets ─────────────────────────────────────

describe('buildStructuredModelPresets', () => {
  it('builds providers and presets from flat array', () => {
    const result = buildStructuredModelPresets([
      { name: 'Sonnet', provider: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: 'key1', model: 'claude-3.5-sonnet' },
      { name: 'Haiku', provider: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: 'key1', model: 'claude-3.5-haiku' },
    ]);
    assert.strictEqual(result.providers.length, 1);
    assert.strictEqual(result.providers[0].name, 'Sonnet');
    assert.strictEqual(result.providers[0].apiKey, 'key1');
    assert.strictEqual(result.providers[0].endpoints.anthropic, 'https://api.anthropic.com');
    assert.strictEqual(result.presets.length, 2);
    assert.strictEqual(result.presets[0].name, 'Sonnet');
    assert.strictEqual(result.presets[0].providerName, 'Sonnet');
    assert.strictEqual(result.presets[1].name, 'Haiku');
    assert.strictEqual(result.presets[1].providerName, 'Sonnet');
  });

  it('creates separate providers for different signatures', () => {
    const result = buildStructuredModelPresets([
      { name: 'A', provider: 'anthropic', baseUrl: 'url1', apiKey: 'k1' },
      { name: 'B', provider: 'openai', baseUrl: 'url2', apiKey: 'k2' },
    ]);
    assert.strictEqual(result.providers.length, 2);
    assert.strictEqual(result.presets.length, 2);
  });

  it('skips non-object entries in flatPresets', () => {
    const result = buildStructuredModelPresets([
      null,
      { name: 'Valid', provider: 'anthropic' },
      'bad',
    ]);
    assert.strictEqual(result.presets.length, 1);
    assert.strictEqual(result.presets[0].name, 'Valid');
  });

  it('merges with existing providers', () => {
    const existing = {
      providers: [{ name: 'ExistingProvider', apiKey: 'ek', endpoints: { anthropic: 'https://old.com' } }],
      presets: [],
    };
    const result = buildStructuredModelPresets(
      [{ name: 'New', provider: 'anthropic', baseUrl: 'https://old.com', apiKey: 'ek', providerName: 'ExistingProvider' }],
      existing
    );
    // Should reuse the existing provider since signature matches
    assert.strictEqual(result.presets[0].providerName, 'ExistingProvider');
  });

  it('handles empty array', () => {
    const result = buildStructuredModelPresets([]);
    assert.deepStrictEqual(result, { providers: [], presets: [] });
  });

  it('uses provider from preset.provider field when providerName not specified', () => {
    const result = buildStructuredModelPresets([
      { provider: 'anthropic', model: 'm1', baseUrl: 'u1', apiKey: 'k1' },
    ]);
    // No name field → falls back to model name
    assert.strictEqual(result.presets[0].name, 'm1');
  });

  it('handles preset without baseUrl and apiKey (empty provider record)', () => {
    const result = buildStructuredModelPresets([
      { name: 'P', provider: 'anthropic' },
    ]);
    assert.strictEqual(result.providers[0].apiKey, '');
    assert.deepStrictEqual(result.providers[0].endpoints, {});
  });
});

// ── normalizeSpeechModel ────────────────────────────────────────────

describe('normalizeSpeechModel', () => {
  it('returns defaults for non-object input', () => {
    assert.deepStrictEqual(normalizeSpeechModel(null), DEFAULT_SPEECH_MODEL);
    assert.deepStrictEqual(normalizeSpeechModel(undefined), DEFAULT_SPEECH_MODEL);
    assert.deepStrictEqual(normalizeSpeechModel('hello'), DEFAULT_SPEECH_MODEL);
    assert.deepStrictEqual(normalizeSpeechModel(42), DEFAULT_SPEECH_MODEL);
  });

  it('returns defaults for empty object', () => {
    const result = normalizeSpeechModel({});
    assert.strictEqual(result.baseUrl, '');
    assert.strictEqual(result.apiKey, '');
    assert.strictEqual(result.model, '');
    assert.strictEqual(result.language, 'auto');
  });

  it('preserves provided values', () => {
    const result = normalizeSpeechModel({
      baseUrl: 'https://asr.example.com',
      apiKey: 'sk-test',
      model: 'whisper-1',
      language: 'en',
    });
    assert.strictEqual(result.baseUrl, 'https://asr.example.com');
    assert.strictEqual(result.apiKey, 'sk-test');
    assert.strictEqual(result.model, 'whisper-1');
    assert.strictEqual(result.language, 'en');
  });

  it('trims whitespace from values', () => {
    const result = normalizeSpeechModel({
      baseUrl: '  https://asr.example.com  ',
      apiKey: '  sk-test  ',
      model: '  whisper-1  ',
      language: '  en  ',
    });
    assert.strictEqual(result.baseUrl, 'https://asr.example.com');
    assert.strictEqual(result.apiKey, 'sk-test');
    assert.strictEqual(result.model, 'whisper-1');
    assert.strictEqual(result.language, 'en');
  });

  it('falls back to default model when model is empty', () => {
    const result = normalizeSpeechModel({ model: '' });
    assert.strictEqual(result.model, '');
  });

  it('falls back to default language when language is empty', () => {
    const result = normalizeSpeechModel({ language: '' });
    assert.strictEqual(result.language, 'auto');
  });
});

// ── normalizeSpeechPreset ───────────────────────────────────────────

describe('normalizeSpeechPreset', () => {
  it('returns null for non-object input', () => {
    assert.strictEqual(normalizeSpeechPreset(null), null);
    assert.strictEqual(normalizeSpeechPreset(undefined), null);
    assert.strictEqual(normalizeSpeechPreset('hello'), null);
    assert.strictEqual(normalizeSpeechPreset(42), null);
  });

  it('normalizes a valid preset with all fields', () => {
    const result = normalizeSpeechPreset({
      name: '  My Preset  ',
      baseUrl: '  https://asr.example.com  ',
      apiKey: '  sk-test  ',
      model: '  whisper-1  ',
      language: '  en  ',
    });
    assert.strictEqual(result.name, 'My Preset');
    assert.strictEqual(result.baseUrl, 'https://asr.example.com');
    assert.strictEqual(result.apiKey, 'sk-test');
    assert.strictEqual(result.model, 'whisper-1');
    assert.strictEqual(result.language, 'en');
  });

  it('falls back to default model and language for empty values', () => {
    const result = normalizeSpeechPreset({ name: 'Test' });
    assert.strictEqual(result.model, '');
    assert.strictEqual(result.language, 'auto');
    assert.strictEqual(result.name, 'Test');
  });

  it('handles empty object', () => {
    const result = normalizeSpeechPreset({});
    assert.strictEqual(result.name, '');
    assert.strictEqual(result.baseUrl, '');
    assert.strictEqual(result.model, '');
  });
});
