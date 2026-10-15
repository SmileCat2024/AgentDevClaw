/**
 * Tests for fetchCodexModelCatalog in model-config.js.
 *
 * The Codex /models endpoint requires a client_version query parameter (missing
 * param → 400) and filters visible models by minimal_client_version; these tests
 * pin the request shape and the parsing/filtering contract with a stubbed fetch.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { fetchCodexModelCatalog } from '../server/routes/model-config.js';

// Backoff delays are zeroed so simulated-failure retry loops stay instant.
process.env.AGENTDEV_FETCH_RETRY_BASE_DELAY_MS = '0';

// Minimal JWT so buildCodexOAuthHeaders can attach the account-id header.
function makeAccessToken(accountId = 'acct-123') {
  const enc = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `x.${enc({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId } })}.y`;
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

describe('fetchCodexModelCatalog request shape', () => {
  it('sends client_version query and OAuth headers', async () => {
    let seenUrl = '';
    let seenHeaders = null;
    const fetchImpl = async (url, init) => {
      seenUrl = url;
      seenHeaders = init.headers;
      return jsonResponse(200, { models: [] });
    };
    const token = makeAccessToken();
    const result = await fetchCodexModelCatalog(token, fetchImpl);

    assert.deepEqual(result, { models: [] });
    assert.ok(seenUrl.startsWith('https://chatgpt.com/backend-api/codex/models?client_version='),
      `URL must carry client_version: ${seenUrl}`);
    assert.match(seenUrl, /client_version=\d+\.\d+\.\d+$/, 'client_version must be plain semver');
    assert.equal(seenHeaders.Authorization, `Bearer ${token}`);
    assert.equal(seenHeaders['ChatGPT-Account-ID'], 'acct-123');
  });
});

describe('fetchCodexModelCatalog parsing', () => {
  it('maps catalog fields and filters visibility=hide models', async () => {
    const fetchImpl = async () => jsonResponse(200, {
      models: [
        {
          slug: 'gpt-5.6-sol',
          display_name: 'GPT-5.6 Sol',
          context_window: 272000,
          default_reasoning_level: 'medium',
          supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }],
          visibility: 'list',
        },
        {
          slug: 'gpt-reserve',
          display_name: 'Reserve',
          visibility: 'hide',
        },
        {
          // visibility omitted → treated as list
          slug: 'gpt-6-luna',
          display_name: 'GPT-6 Luna',
        },
      ],
    });
    const { models } = await fetchCodexModelCatalog('opaque-token', fetchImpl);

    assert.equal(models.length, 2);
    const sol = models.find((m) => m.id === 'gpt-5.6-sol');
    assert.equal(sol.displayName, 'GPT-5.6 Sol');
    assert.equal(sol.contextLength, 272000);
    assert.equal(sol.thinkingEffort, 'medium');
    assert.deepEqual(sol.supportedThinkingEfforts, ['low', 'medium', 'high']);
    assert.ok(models.some((m) => m.id === 'gpt-6-luna'), 'missing visibility defaults to list');
    assert.ok(!models.some((m) => m.id === 'gpt-reserve'), 'hide models are dropped');
  });

  it('deduplicates repeated slugs and tolerates malformed entries', async () => {
    const fetchImpl = async () => jsonResponse(200, {
      models: [
        { slug: 'gpt-a' },
        { slug: 'gpt-a' },
        { slug: '' },
        null,
      ],
    });
    const { models } = await fetchCodexModelCatalog('opaque-token', fetchImpl);
    assert.deepEqual(models.map((m) => m.id), ['gpt-a']);
  });
});

describe('fetchCodexModelCatalog failures', () => {
  it('surfaces upstream 400 without retrying', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return jsonResponse(400, { error: { message: 'bad request' } });
    };
    const result = await fetchCodexModelCatalog('opaque-token', fetchImpl);
    assert.deepEqual(result, {
      error: 'Codex model catalog request failed: 400',
      status: 400,
    });
    assert.equal(calls, 1, '4xx must not be retried');
  });

  it('retries a transient upstream failure and succeeds', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return calls === 1
        ? jsonResponse(503, {})
        : jsonResponse(200, { models: [{ slug: 'gpt-a' }] });
    };
    const result = await fetchCodexModelCatalog('opaque-token', fetchImpl);
    assert.deepEqual(result, {
      models: [{
        id: 'gpt-a',
        displayName: 'gpt-a',
        contextLength: null,
        thinkingEffort: null,
        supportedThinkingEfforts: [],
      }],
    });
    assert.equal(calls, 2);
  });

  it('retries transient network errors and succeeds', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      if (calls === 1) {
        const error = new TypeError('fetch failed');
        error.cause = Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' });
        throw error;
      }
      return jsonResponse(200, { models: [] });
    };
    const result = await fetchCodexModelCatalog('opaque-token', fetchImpl);
    assert.deepEqual(result, { models: [] });
    assert.equal(calls, 2);
  });

  it('maps exhausted transport failures to 502', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      const error = new TypeError('fetch failed');
      error.cause = Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' });
      throw error;
    };
    const result = await fetchCodexModelCatalog('opaque-token', fetchImpl);
    assert.equal(result.status, 502);
    assert.match(result.error, /^Codex model catalog request failed: /);
    assert.equal(calls, 3);
  });
});
