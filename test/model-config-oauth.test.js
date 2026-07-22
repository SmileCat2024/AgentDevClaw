/**
 * Tests for OAuth field (authType, clientId) round-trip through
 * flattenModelPresets / buildStructuredModelPresets in model-config.js.
 *
 * These are pure-function tests — no file I/O.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  flattenModelPresets,
  buildStructuredModelPresets,
  resolvePresetApiSurface,
} from '../server/routes/model-config.js';

// ── Helpers ────────────────────────────────────────────────────────

const OAUTH_ENDPOINT = 'https://chatgpt.com/backend-api/codex';
const API_KEY_ENDPOINT = 'https://api.openai.com/v1';

function makeOAuthPreset(overrides = {}) {
  return {
    name: 'Codex GPT-4o',
    provider: 'openai',
    apiSurface: 'chat',
    model: 'gpt-4o',
    baseUrl: OAUTH_ENDPOINT,
    apiKey: '',
    authType: 'oauth-codex',
    clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
    ...overrides,
  };
}

function makeApiKeyPreset(overrides = {}) {
  return {
    name: 'OpenAI GPT-4',
    provider: 'openai',
    apiSurface: 'chat',
    model: 'gpt-4',
    baseUrl: API_KEY_ENDPOINT,
    apiKey: 'sk-test-key',
    authType: '',
    clientId: '',
    ...overrides,
  };
}

// ── Flatten tests ──────────────────────────────────────────────────

describe('flattenModelPresets with OAuth providers', () => {
  it('extracts authType and clientId from provider records', () => {
    const structured = {
      providers: [{
        name: 'Codex OAuth',
        authType: 'oauth-codex',
        clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
        endpoints: { openai: OAUTH_ENDPOINT },
      }],
      presets: [{
        name: 'Codex GPT-4o',
        providerName: 'Codex OAuth',
        protocol: 'openai',
        apiSurface: 'chat',
        model: 'gpt-4o',
      }],
    };

    const flat = flattenModelPresets(structured);
    assert.equal(flat.length, 1);
    assert.equal(flat[0].authType, 'oauth-codex');
    assert.equal(flat[0].clientId, 'app_EMoamEEZ73f0CkXaXp7hrann');
    assert.equal(flat[0].apiKey, '');
    assert.equal(flat[0].apiSurface, 'responses');
  });

  it('returns empty authType for non-OAuth providers', () => {
    const structured = {
      providers: [{
        name: 'Standard OpenAI',
        apiKey: 'sk-xxx',
        endpoints: { openai: API_KEY_ENDPOINT },
      }],
      presets: [{
        name: 'GPT-4',
        providerName: 'Standard OpenAI',
        protocol: 'openai',
        model: 'gpt-4',
      }],
    };

    const flat = flattenModelPresets(structured);
    assert.equal(flat[0].authType, '');
    assert.equal(flat[0].clientId, '');
  });
});

// ── Build tests ────────────────────────────────────────────────────

describe('buildStructuredModelPresets with OAuth providers', () => {
  it('stores authType and clientId in provider record', () => {
    const flat = [makeOAuthPreset()];
    const structured = buildStructuredModelPresets(flat);

    assert.equal(structured.providers.length, 1);
    const provider = structured.providers[0];
    assert.equal(provider.authType, 'oauth-codex');
    assert.equal(provider.clientId, 'app_EMoamEEZ73f0CkXaXp7hrann');
    assert.equal(provider.endpoints.openai, OAUTH_ENDPOINT);
    // OAuth providers should have empty apiKey
    assert.equal(provider.apiKey, '');
    assert.equal(structured.presets[0].apiSurface, 'responses');
  });

  it('does not add authType/clientId when empty', () => {
    const flat = [makeApiKeyPreset()];
    const structured = buildStructuredModelPresets(flat);

    assert.equal(structured.providers.length, 1);
    const provider = structured.providers[0];
    assert.equal(provider.authType, undefined);
    assert.equal(provider.clientId, undefined);
  });

  it('groups two OAuth presets with same endpoint into one provider', () => {
    const flat = [
      makeOAuthPreset({ name: 'Codex GPT-4o', model: 'gpt-4o' }),
      makeOAuthPreset({ name: 'Codex GPT-4-mini', model: 'gpt-4o-mini' }),
    ];
    const structured = buildStructuredModelPresets(flat);

    assert.equal(structured.providers.length, 1, 'should merge into one provider');
    assert.equal(structured.presets.length, 2);
    assert.equal(structured.presets[0].providerName, structured.presets[1].providerName);
  });

  it('does NOT merge OAuth and API-key providers at the same endpoint', () => {
    const flat = [
      makeOAuthPreset({ baseUrl: 'https://same.endpoint/v1' }),
      makeApiKeyPreset({ baseUrl: 'https://same.endpoint/v1', apiKey: 'sk-real' }),
    ];
    const structured = buildStructuredModelPresets(flat);

    assert.equal(structured.providers.length, 2, 'OAuth and API-key should be separate providers');
    const oauthProvider = structured.providers.find((p) => p.authType === 'oauth-codex');
    const apiKeyProvider = structured.providers.find((p) => !p.authType);
    assert.ok(oauthProvider, 'should have an OAuth provider');
    assert.ok(apiKeyProvider, 'should have an API-key provider');
  });

  it('preserves provider name from existing data when signature matches', () => {
    const existing = {
      providers: [{
        name: 'My Custom Codex',
        authType: 'oauth-codex',
        clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
        apiKey: '',
        endpoints: { openai: OAUTH_ENDPOINT },
      }],
      presets: [],
    };
    const flat = [
      makeOAuthPreset({ providerName: 'My Custom Codex' }),
    ];
    const structured = buildStructuredModelPresets(flat, existing);

    assert.equal(structured.providers.length, 1);
    assert.equal(structured.providers[0].name, 'My Custom Codex');
    assert.equal(structured.presets[0].providerName, 'My Custom Codex');
  });

  it('does NOT match existing provider when authType differs', () => {
    const existing = {
      providers: [{
        name: 'API Key Provider',
        apiKey: '',
        endpoints: { openai: OAUTH_ENDPOINT },
        // no authType — this is an API-key provider with empty key
      }],
      presets: [],
    };
    const flat = [
      makeOAuthPreset({ providerName: 'API Key Provider' }),
    ];
    const structured = buildStructuredModelPresets(flat, existing);

    // Should create a new provider since authType differs (empty vs oauth-codex)
    assert.ok(structured.providers.length >= 1);
    const oauthProvider = structured.providers.find((p) => p.authType === 'oauth-codex');
    assert.ok(oauthProvider, 'should have created a new OAuth provider');
  });
});

// ── Full round-trip tests ──────────────────────────────────────────

describe('Flatten → Build → Flatten round-trip', () => {
  it('preserves OAuth fields through complete round-trip', () => {
    const originalFlat = [makeOAuthPreset()];

    // Build → structured
    const structured = buildStructuredModelPresets(originalFlat);

    // Flatten → back to flat
    const roundTripped = flattenModelPresets(structured);

    assert.equal(roundTripped.length, 1);
    assert.equal(roundTripped[0].authType, 'oauth-codex');
    assert.equal(roundTripped[0].clientId, 'app_EMoamEEZ73f0CkXaXp7hrann');
    assert.equal(roundTripped[0].baseUrl, OAUTH_ENDPOINT);
    assert.equal(roundTripped[0].apiKey, '');
    assert.equal(roundTripped[0].model, 'gpt-4o');
    assert.equal(roundTripped[0].provider, 'openai');
    assert.equal(roundTripped[0].apiSurface, 'responses');
  });

  it('preserves mixed OAuth + API-key presets through round-trip', () => {
    const originalFlat = [
      makeOAuthPreset(),
      makeApiKeyPreset(),
    ];

    const structured = buildStructuredModelPresets(originalFlat);
    const roundTripped = flattenModelPresets(structured);

    assert.equal(roundTripped.length, 2);
    const oauth = roundTripped.find((p) => p.authType === 'oauth-codex');
    const apiKey = roundTripped.find((p) => p.authType === '');
    assert.ok(oauth, 'should have OAuth preset');
    assert.ok(apiKey, 'should have API-key preset');
    assert.equal(oauth.clientId, 'app_EMoamEEZ73f0CkXaXp7hrann');
    assert.equal(apiKey.apiKey, 'sk-test-key');
  });

  it('handles OAuth preset without clientId (edge case)', () => {
    const originalFlat = [
      makeOAuthPreset({ clientId: '' }),
    ];

    const structured = buildStructuredModelPresets(originalFlat);
    const roundTripped = flattenModelPresets(structured);

    assert.equal(roundTripped[0].authType, 'oauth-codex');
    assert.equal(roundTripped[0].clientId, '');
  });
});

describe('resolvePresetApiSurface', () => {
  it('forces Responses for Codex OAuth even when a legacy client sends chat', () => {
    assert.equal(resolvePresetApiSurface('openai', 'oauth-codex', 'chat'), 'responses');
  });

  it('does not change ordinary OpenAI API-key presets', () => {
    assert.equal(resolvePresetApiSurface('openai', '', 'chat'), 'chat');
    assert.equal(resolvePresetApiSurface('openai', '', 'responses'), 'responses');
  });
});
