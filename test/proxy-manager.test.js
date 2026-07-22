import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { testProxyConnectivity } from '../server/shared/proxy-manager.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('proxy connectivity diagnostics', () => {
  it('tests the actual ChatGPT Codex endpoint by default', async () => {
    let requestedUrl = '';
    globalThis.fetch = async (url) => {
      requestedUrl = String(url);
      return { status: 405 };
    };

    const result = await testProxyConnectivity();
    assert.equal(requestedUrl, 'https://chatgpt.com/backend-api/codex/responses');
    assert.equal(result.ok, true);
    assert.equal(result.statusCode, 405);
  });

  it('identifies a response-header timeout separately from connect failures', async () => {
    globalThis.fetch = async () => {
      const error = new TypeError('fetch failed');
      error.cause = Object.assign(new Error('Headers timeout'), { code: 'UND_ERR_HEADERS_TIMEOUT' });
      throw error;
    };

    const result = await testProxyConnectivity();
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'UND_ERR_HEADERS_TIMEOUT');
    assert.equal(result.phase, 'response_headers');
  });
});
