/**
 * Tests for server/oauth-codex.js
 *
 * Covers:
 *   - JWT decoding & expiry detection (pure functions)
 *   - Token file read/write/delete (temp files)
 *   - Token status queries
 *   - Device-code login flow (mocked fetch)
 *   - Token refresh (mocked fetch)
 *   - Session management
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import os from 'os';
import net from 'net';

import {
  isTokenExpiring,
  getTokenExpiryMs,
  getCodexAccountId,
  buildCodexOAuthHeaders,
  readTokensSync,
  deleteTokens,
  resolveAccessTokenSync,
  getTokenStatus,
  createLoginSession,
  getLoginSession,
  runDeviceCodeLogin,
  requestDeviceCode,
  pollDeviceAuthorization,
  exchangeCodeForTokens,
  refreshTokens,
  buildBrowserAuthorizeUrl,
  handleBrowserCallback,
  startBrowserCallbackServer,
  beginBrowserLogin,
  DEFAULT_CLIENT_ID,
  DEFAULT_CODEX_BASE_URL,
} from '../server/oauth-codex.js';

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Build a fake JWT with the given claims.
 * Signature is not valid — we never verify it.
 */
function makeJwt(claims) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${header}.${payload}.sig`;
}

const nowSec = () => Math.floor(Date.now() / 1000);

/**
 * Compute the token file path that oauth-codex.js uses internally.
 * Mirrors the same USER_DATA_ROOT + sanitization logic.
 */
function tokenFilePath(providerName) {
  const safe = providerName.replace(/[^a-zA-Z0-9_\-.]/g, '_');
  const dir = path.join(os.homedir(), '.agentdev', 'AgentDevClaw', 'oauth-tokens');
  return path.join(dir, `${safe}.json`);
}

function writeTestTokens(providerName, tokens) {
  const fp = tokenFilePath(providerName);
  writeFileSync(fp, JSON.stringify(tokens, null, 2), 'utf8');
  return fp;
}

const TEST_PROVIDER = '__test_oauth_provider';

/**
 * Create a mock fetch that returns configurable responses per URL.
 */
function mockFetch(handlers) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    calls.push({ url: urlStr, opts });
    for (const { match, respond } of handlers) {
      if (urlStr.includes(match)) {
        const result = respond(opts, calls.length);
        if (result instanceof Response) return result;
        return makeResponse(result);
      }
    }
    return makeResponse({ status: 404, body: 'no mock' });
  };
  return {
    calls,
    restore() { globalThis.fetch = original; },
  };
}

function makeResponse({ status = 200, body = {}, headers = {} }) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function makeTransientFetchError(code = 'UND_ERR_CONNECT_TIMEOUT') {
  const error = new TypeError('fetch failed');
  error.cause = Object.assign(new Error('Connect Timeout Error'), { code });
  return error;
}

// ── Cleanup ────────────────────────────────────────────────────────

let createdFiles = [];

function cleanupProvider(name) {
  const fp = tokenFilePath(name);
  if (existsSync(fp)) {
    try { rmSync(fp); } catch {}
  }
}

afterEach(() => {
  for (const name of [TEST_PROVIDER, `${TEST_PROVIDER}_2`, `${TEST_PROVIDER}_3`]) {
    cleanupProvider(name);
  }
  createdFiles = [];
});

// ── JWT decode & expiry ────────────────────────────────────────────

describe('isTokenExpiring', () => {
  it('returns true when exp is within the skew window', () => {
    const token = makeJwt({ exp: nowSec() + 60 }); // 1 min from now, within 120s skew
    assert.equal(isTokenExpiring(token), true);
  });

  it('returns false when exp is well in the future', () => {
    const token = makeJwt({ exp: nowSec() + 86400 }); // 1 day
    assert.equal(isTokenExpiring(token), false);
  });

  it('returns true when exp is in the past', () => {
    const token = makeJwt({ exp: nowSec() - 100 });
    assert.equal(isTokenExpiring(token), true);
  });

  it('returns false for non-JWT strings', () => {
    assert.equal(isTokenExpiring('not-a-jwt'), false);
    assert.equal(isTokenExpiring('a.b'), false); // only 2 parts
    assert.equal(isTokenExpiring('a.b.c.d'), false); // 4 parts
  });

  it('returns false for JWT without exp claim', () => {
    const token = makeJwt({ sub: 'user123' });
    assert.equal(isTokenExpiring(token), false);
  });

  it('respects custom skew seconds', () => {
    const token = makeJwt({ exp: nowSec() + 600 }); // 10 min
    assert.equal(isTokenExpiring(token, 120), false); // default skew
    assert.equal(isTokenExpiring(token, 700), true); // larger skew
  });

  it('returns false for non-string input', () => {
    assert.equal(isTokenExpiring(null), false);
    assert.equal(isTokenExpiring(undefined), false);
    assert.equal(isTokenExpiring(12345), false);
  });
});

describe('getTokenExpiryMs', () => {
  it('returns expiry in milliseconds', () => {
    const exp = nowSec() + 3600;
    const token = makeJwt({ exp });
    assert.equal(getTokenExpiryMs(token), exp * 1000);
  });

  it('returns null when no exp claim', () => {
    const token = makeJwt({ sub: 'x' });
    assert.equal(getTokenExpiryMs(token), null);
  });

  it('returns null for non-JWT', () => {
    assert.equal(getTokenExpiryMs('garbage'), null);
  });

  it('returns null for malformed base64 payload', () => {
    // header.payload.sig with invalid base64 payload
    assert.equal(getTokenExpiryMs('eyJhbGc.xxx.sig'), null);
  });
});

describe('Codex OAuth request context', () => {
  it('reads the ChatGPT account id from the namespaced auth claim', () => {
    const token = makeJwt({
      'https://api.openai.com/auth': { chatgpt_account_id: 'acct-namespaced' },
      chatgpt_account_id: 'acct-fallback',
    });
    assert.equal(getCodexAccountId(token), 'acct-namespaced');
  });

  it('supports the legacy top-level account claim', () => {
    assert.equal(getCodexAccountId(makeJwt({ chatgpt_account_id: 'acct-top' })), 'acct-top');
  });

  it('returns an empty account id for opaque or malformed tokens', () => {
    assert.equal(getCodexAccountId('opaque-token'), '');
    assert.equal(getCodexAccountId(makeJwt({})), '');
  });

  it('replaces a stale account header while preserving unrelated custom headers', () => {
    const token = makeJwt({
      'https://api.openai.com/auth': { chatgpt_account_id: 'acct-current' },
    });
    const headers = buildCodexOAuthHeaders(token, [
      { key: 'X-Trace', value: 'trace-1', valueMode: 'static' },
      { key: 'chatgpt-account-id', value: 'acct-stale', valueMode: 'static' },
    ]);

    assert.deepEqual(headers, [
      { key: 'X-Trace', value: 'trace-1', valueMode: 'static' },
      { key: 'ChatGPT-Account-ID', value: 'acct-current', valueMode: 'static' },
    ]);
  });
});

// ── Token file I/O ─────────────────────────────────────────────────

describe('readTokensSync', () => {
  it('returns parsed tokens when file exists', () => {
    writeTestTokens(TEST_PROVIDER, {
      access_token: makeJwt({ exp: nowSec() + 3600 }),
      refresh_token: 'refresh-abc',
      last_refresh: '2026-01-01T00:00:00Z',
      clientId: DEFAULT_CLIENT_ID,
    });
    const result = readTokensSync(TEST_PROVIDER);
    assert.ok(result);
    assert.equal(result.refresh_token, 'refresh-abc');
    assert.equal(result.clientId, DEFAULT_CLIENT_ID);
  });

  it('returns null when file does not exist', () => {
    assert.equal(readTokensSync('nonexistent_provider_xyz'), null);
  });

  it('returns null for corrupted JSON', () => {
    writeTestTokens(TEST_PROVIDER, { broken: 'json' }); // missing access_token
    assert.equal(readTokensSync(TEST_PROVIDER), null);
  });

  it('handles provider name with special characters', () => {
    const weirdName = 'My Provider (Test)!';
    writeTestTokens(weirdName, {
      access_token: 'tok',
      refresh_token: 'ref',
    });
    const result = readTokensSync(weirdName);
    assert.ok(result);
    assert.equal(result.access_token, 'tok');
    cleanupProvider(weirdName);
  });
});

describe('deleteTokens', () => {
  it('removes an existing token file', () => {
    writeTestTokens(TEST_PROVIDER, {
      access_token: 'tok',
      refresh_token: 'ref',
    });
    assert.ok(existsSync(tokenFilePath(TEST_PROVIDER)));
    deleteTokens(TEST_PROVIDER);
    assert.equal(existsSync(tokenFilePath(TEST_PROVIDER)), false);
  });

  it('does not throw when file does not exist', () => {
    assert.doesNotThrow(() => deleteTokens('totally_missing_xyz'));
  });
});

// ── Token status ───────────────────────────────────────────────────

describe('getTokenStatus', () => {
  it('returns loggedIn=true for valid non-expiring token', () => {
    writeTestTokens(TEST_PROVIDER, {
      access_token: makeJwt({ exp: nowSec() + 86400 }),
      refresh_token: 'ref',
      last_refresh: '2026-07-22T10:00:00Z',
      clientId: DEFAULT_CLIENT_ID,
    });
    const status = getTokenStatus(TEST_PROVIDER);
    assert.equal(status.loggedIn, true);
    assert.equal(status.isExpiring, false);
    assert.ok(status.expiresAt);
    assert.equal(status.lastRefresh, '2026-07-22T10:00:00Z');
  });

  it('returns loggedIn=false when no tokens', () => {
    const status = getTokenStatus('missing_provider_xyz');
    assert.equal(status.loggedIn, false);
  });

  it('returns loggedIn=false for expired token', () => {
    writeTestTokens(TEST_PROVIDER, {
      access_token: makeJwt({ exp: nowSec() - 100 }),
      refresh_token: 'ref',
    });
    const status = getTokenStatus(TEST_PROVIDER);
    assert.equal(status.loggedIn, false);
  });

  it('returns isExpiring=true when within 5-min display window', () => {
    writeTestTokens(TEST_PROVIDER, {
      access_token: makeJwt({ exp: nowSec() + 120 }), // 2 min, within 300s display window
      refresh_token: 'ref',
    });
    const status = getTokenStatus(TEST_PROVIDER);
    assert.equal(status.loggedIn, true);
    assert.equal(status.isExpiring, true);
  });

  it('returns null expiresAt for non-JWT token', () => {
    writeTestTokens(TEST_PROVIDER, {
      access_token: 'opaque-not-a-jwt',
      refresh_token: 'ref',
    });
    const status = getTokenStatus(TEST_PROVIDER);
    assert.equal(status.loggedIn, true);
    assert.equal(status.expiresAt, null);
  });
});

// ── resolveAccessTokenSync ─────────────────────────────────────────

describe('resolveAccessTokenSync', () => {
  it('returns access_token when tokens exist and are fresh', () => {
    const token = makeJwt({ exp: nowSec() + 3600 });
    writeTestTokens(TEST_PROVIDER, {
      access_token: token,
      refresh_token: 'ref',
      clientId: DEFAULT_CLIENT_ID,
    });
    const result = resolveAccessTokenSync(TEST_PROVIDER, DEFAULT_CLIENT_ID);
    assert.equal(result, token);
  });

  it('returns null when no tokens stored', () => {
    assert.equal(resolveAccessTokenSync('missing_xyz'), null);
  });

  it('still returns current token (even if expiring) while triggering background refresh', async () => {
    const expiringToken = makeJwt({ exp: nowSec() + 30 }); // expiring within 120s
    writeTestTokens(TEST_PROVIDER, {
      access_token: expiringToken,
      refresh_token: 'refresh-val',
      clientId: DEFAULT_CLIENT_ID,
    });

    // Mock fetch for the background refresh
    const mocked = mockFetch([
      {
        match: '/oauth/token',
        respond: () => ({
          status: 200,
          body: {
            access_token: makeJwt({ exp: nowSec() + 7200 }),
            refresh_token: 'new-refresh',
          },
        }),
      },
    ]);

    try {
      const result = resolveAccessTokenSync(TEST_PROVIDER, DEFAULT_CLIENT_ID);
      // Should return the current (expiring) token immediately
      assert.equal(result, expiringToken);

      // Wait for background refresh to complete
      await new Promise((r) => setTimeout(r, 500));

      // Token file should now have the new token
      const updated = readTokensSync(TEST_PROVIDER);
      assert.ok(updated);
      assert.notEqual(updated.access_token, expiringToken);

      // Verify fetch was called
      assert.ok(mocked.calls.length >= 1, 'fetch should have been called for refresh');
    } finally {
      mocked.restore();
    }
  });
});

// ── Session management ─────────────────────────────────────────────

describe('createLoginSession & getLoginSession', () => {
  it('creates a session with correct initial state', () => {
    const sid = createLoginSession(TEST_PROVIDER, DEFAULT_CLIENT_ID);
    assert.ok(sid, 'session ID should be non-empty');

    const sess = getLoginSession(sid);
    assert.ok(sess);
    assert.equal(sess.status, 'initiating');
    assert.equal(sess.userCode, null);
    assert.equal(sess.verificationUrl, null);
    assert.equal(sess.errorMessage, null);
  });

  it('returns null for non-existent session', () => {
    assert.equal(getLoginSession('fake-sid-123'), null);
  });

  it('does not expose sensitive fields (deviceAuthId)', () => {
    const sid = createLoginSession(TEST_PROVIDER, DEFAULT_CLIENT_ID);
    const sess = getLoginSession(sid);
    assert.ok(sess);
    assert.equal(sess.deviceAuthId, undefined, 'deviceAuthId should not be in public output');
  });
});

// ── Device code request (mocked fetch) ─────────────────────────────

describe('requestDeviceCode', () => {
  it('retries a transient proxy connection failure', async () => {
    let attempts = 0;
    const mocked = mockFetch([
      {
        match: 'deviceauth/usercode',
        respond: () => {
          attempts += 1;
          if (attempts === 1) throw makeTransientFetchError();
          return {
            status: 200,
            body: { user_code: 'RETRY-OK', device_auth_id: 'dae-retry', interval: 5 },
          };
        },
      },
    ]);

    try {
      const result = await requestDeviceCode(DEFAULT_CLIENT_ID);
      assert.equal(result.userCode, 'RETRY-OK');
      assert.equal(attempts, 2);
    } finally {
      mocked.restore();
    }
  });

  it('returns userCode, deviceAuthId, and interval on success', async () => {
    const mocked = mockFetch([
      {
        match: 'deviceauth/usercode',
        respond: () => ({
          status: 200,
          body: {
            user_code: 'ABCD-1234',
            device_auth_id: 'dae-xyz',
            interval: 5,
          },
        }),
      },
    ]);

    try {
      const result = await requestDeviceCode(DEFAULT_CLIENT_ID);
      assert.equal(result.userCode, 'ABCD-1234');
      assert.equal(result.deviceAuthId, 'dae-xyz');
      assert.equal(result.interval, 5);
    } finally {
      mocked.restore();
    }
  });

  it('throws on missing user_code in response', async () => {
    const mocked = mockFetch([
      {
        match: 'deviceauth/usercode',
        respond: () => ({ status: 200, body: { device_auth_id: 'dae' } }),
      },
    ]);

    try {
      await assert.rejects(
        () => requestDeviceCode(DEFAULT_CLIENT_ID),
        /missing user_code/,
      );
    } finally {
      mocked.restore();
    }
  });

  it('throws on missing device_auth_id in response', async () => {
    const mocked = mockFetch([
      {
        match: 'deviceauth/usercode',
        respond: () => ({ status: 200, body: { user_code: 'ABCD' } }),
      },
    ]);

    try {
      await assert.rejects(
        () => requestDeviceCode(DEFAULT_CLIENT_ID),
        /missing.*device_auth_id/,
      );
    } finally {
      mocked.restore();
    }
  });

  it('throws on HTTP error', async () => {
    const mocked = mockFetch([
      {
        match: 'deviceauth/usercode',
        respond: () => ({ status: 500, body: 'server error' }),
      },
    ]);

    try {
      await assert.rejects(
        () => requestDeviceCode(DEFAULT_CLIENT_ID),
        /500/,
      );
    } finally {
      mocked.restore();
    }
  });

  it('uses default client_id when none provided', async () => {
    const mocked = mockFetch([
      {
        match: 'deviceauth/usercode',
        respond: (opts) => {
          const body = JSON.parse(opts.body);
          return {
            status: 200,
            body: {
              user_code: 'XX',
              device_auth_id: 'YY',
              interval: 5,
              _receivedClientId: body.client_id,
            },
          };
        },
      },
    ]);

    try {
      await requestDeviceCode(); // no clientId
      assert.equal(mocked.calls.length, 1);
      const sentBody = JSON.parse(mocked.calls[0].opts.body);
      assert.equal(sentBody.client_id, DEFAULT_CLIENT_ID);
    } finally {
      mocked.restore();
    }
  });
});

// ── Device authorization polling (mocked fetch) ────────────────────

describe('pollDeviceAuthorization', () => {
  it('keeps polling after a transient proxy connection failure', async () => {
    let attempts = 0;
    const mocked = mockFetch([
      {
        match: 'deviceauth/token',
        respond: () => {
          attempts += 1;
          if (attempts === 1) throw makeTransientFetchError();
          return {
            status: 200,
            body: { authorization_code: 'retry-code', code_verifier: 'retry-verifier' },
          };
        },
      },
    ]);

    try {
      const result = await pollDeviceAuthorization('dae', 'ABCD', 10, 5000);
      assert.equal(result.authorization_code, 'retry-code');
      assert.equal(attempts, 2);
    } finally {
      mocked.restore();
    }
  });

  it('returns code data on 200 response', async () => {
    const mocked = mockFetch([
      {
        match: 'deviceauth/token',
        respond: () => ({
          status: 200,
          body: {
            authorization_code: 'auth-code-123',
            code_verifier: 'verifier-456',
          },
        }),
      },
    ]);

    try {
      const result = await pollDeviceAuthorization('dae', 'ABCD-1234', 10, 5000);
      assert.ok(result);
      assert.equal(result.authorization_code, 'auth-code-123');
      assert.equal(result.code_verifier, 'verifier-456');
    } finally {
      mocked.restore();
    }
  });

  it('continues polling on 403 (pending)', async () => {
    let callCount = 0;
    const mocked = mockFetch([
      {
        match: 'deviceauth/token',
        respond: () => {
          callCount++;
          if (callCount < 3) return { status: 403 };
          return {
            status: 200,
            body: { authorization_code: 'late', code_verifier: 'v' },
          };
        },
      },
    ]);

    try {
      const result = await pollDeviceAuthorization('dae', 'ABCD', 10, 5000);
      assert.ok(result);
      assert.equal(result.authorization_code, 'late');
      assert.ok(callCount >= 3, `expected >=3 fetch calls, got ${callCount}`);
    } finally {
      mocked.restore();
    }
  });

  it('returns null on timeout', async () => {
    const mocked = mockFetch([
      {
        match: 'deviceauth/token',
        respond: () => ({ status: 403 }), // always pending
      },
    ]);

    try {
      const result = await pollDeviceAuthorization('dae', 'ABCD', 10, 50); // 50ms timeout
      assert.equal(result, null);
    } finally {
      mocked.restore();
    }
  });

  it('throws on unexpected HTTP error (500)', async () => {
    const mocked = mockFetch([
      {
        match: 'deviceauth/token',
        respond: () => ({ status: 500, body: 'oops' }),
      },
    ]);

    try {
      await assert.rejects(
        () => pollDeviceAuthorization('dae', 'ABCD', 10, 5000),
        /500/,
      );
    } finally {
      mocked.restore();
    }
  });
});

// ── Token exchange (mocked fetch) ──────────────────────────────────

describe('exchangeCodeForTokens', () => {
  it('retries a transient proxy connection failure', async () => {
    let attempts = 0;
    const mocked = mockFetch([
      {
        match: '/oauth/token',
        respond: () => {
          attempts += 1;
          if (attempts === 1) throw makeTransientFetchError('ECONNRESET');
          return {
            status: 200,
            body: { access_token: makeJwt({ exp: nowSec() + 3600 }), refresh_token: 'rt-retry' },
          };
        },
      },
    ]);

    try {
      const result = await exchangeCodeForTokens('auth-code', 'verifier', DEFAULT_CLIENT_ID);
      assert.equal(result.refresh_token, 'rt-retry');
      assert.equal(attempts, 2);
    } finally {
      mocked.restore();
    }
  });

  it('returns access_token and refresh_token on success', async () => {
    const mocked = mockFetch([
      {
        match: '/oauth/token',
        respond: () => ({
          status: 200,
          body: {
            access_token: makeJwt({ exp: nowSec() + 3600 }),
            refresh_token: 'rt-new',
          },
        }),
      },
    ]);

    try {
      const result = await exchangeCodeForTokens('auth-code', 'verifier', DEFAULT_CLIENT_ID);
      assert.ok(result.access_token);
      assert.equal(result.refresh_token, 'rt-new');
      assert.equal(result.clientId, DEFAULT_CLIENT_ID);
    } finally {
      mocked.restore();
    }
  });

  it('throws on missing access_token in response', async () => {
    const mocked = mockFetch([
      {
        match: '/oauth/token',
        respond: () => ({ status: 200, body: { foo: 'bar' } }),
      },
    ]);

    try {
      await assert.rejects(
        () => exchangeCodeForTokens('code', 'verifier', DEFAULT_CLIENT_ID),
        /missing access_token/,
      );
    } finally {
      mocked.restore();
    }
  });

  it('throws on HTTP error', async () => {
    const mocked = mockFetch([
      {
        match: '/oauth/token',
        respond: () => ({ status: 400, body: 'bad request' }),
      },
    ]);

    try {
      await assert.rejects(
        () => exchangeCodeForTokens('code', 'verifier', DEFAULT_CLIENT_ID),
        /400/,
      );
    } finally {
      mocked.restore();
    }
  });
});

describe('runDeviceCodeLogin', () => {
  it('finishes an approved browser login despite one transient poll failure', async () => {
    let pollAttempts = 0;
    const mocked = mockFetch([
      {
        match: 'deviceauth/usercode',
        respond: () => ({
          status: 200,
          body: { user_code: 'FLOW-OK', device_auth_id: 'dae-flow', interval: 0 },
        }),
      },
      {
        match: 'deviceauth/token',
        respond: () => {
          pollAttempts += 1;
          if (pollAttempts === 1) throw makeTransientFetchError();
          return {
            status: 200,
            body: { authorization_code: 'flow-code', code_verifier: 'flow-verifier' },
          };
        },
      },
      {
        match: '/oauth/token',
        respond: () => ({
          status: 200,
          body: { access_token: makeJwt({ exp: nowSec() + 3600 }), refresh_token: 'flow-refresh' },
        }),
      },
    ]);
    const providerName = `${TEST_PROVIDER}_3`;
    const sessionId = createLoginSession(providerName, DEFAULT_CLIENT_ID);

    try {
      await runDeviceCodeLogin(sessionId, providerName, DEFAULT_CLIENT_ID);
      assert.equal(getLoginSession(sessionId)?.status, 'approved');
      assert.equal(readTokensSync(providerName)?.refresh_token, 'flow-refresh');
    } finally {
      mocked.restore();
    }
  });
});

// ── Token refresh (mocked fetch) ───────────────────────────────────

describe('refreshTokens', () => {
  it('returns updated tokens and persists them', async () => {
    const newToken = makeJwt({ exp: nowSec() + 7200 });
    const mocked = mockFetch([
      {
        match: '/oauth/token',
        respond: () => ({
          status: 200,
          body: {
            access_token: newToken,
            refresh_token: 'rotated-rt',
          },
        }),
      },
    ]);

    try {
      const result = await refreshTokens(TEST_PROVIDER, 'old-rt', DEFAULT_CLIENT_ID);
      assert.equal(result.access_token, newToken);
      assert.equal(result.refresh_token, 'rotated-rt');

      // Verify persisted to file
      const stored = readTokensSync(TEST_PROVIDER);
      assert.ok(stored);
      assert.equal(stored.access_token, newToken);
      assert.equal(stored.refresh_token, 'rotated-rt');
    } finally {
      mocked.restore();
    }
  });

  it('keeps old refresh_token when response omits it', async () => {
    const mocked = mockFetch([
      {
        match: '/oauth/token',
        respond: () => ({
          status: 200,
          body: { access_token: 'new-access' },
        }),
      },
    ]);

    try {
      const result = await refreshTokens(TEST_PROVIDER, 'old-rt', DEFAULT_CLIENT_ID);
      assert.equal(result.access_token, 'new-access');
      assert.equal(result.refresh_token, 'old-rt');
    } finally {
      mocked.restore();
    }
  });

  it('throws when refresh_token is missing', async () => {
    await assert.rejects(
      () => refreshTokens(TEST_PROVIDER, '', DEFAULT_CLIENT_ID),
      /Missing refresh_token/,
    );
  });

  it('sets reloginRequired on 401', async () => {
    const mocked = mockFetch([
      {
        match: '/oauth/token',
        respond: () => ({ status: 401, body: 'unauthorized' }),
      },
    ]);

    try {
      await assert.rejects(
        () => refreshTokens(TEST_PROVIDER, 'rt', DEFAULT_CLIENT_ID),
        (err) => {
          assert.match(err.message, /401/);
          assert.equal(err.reloginRequired, true);
          return true;
        },
      );
    } finally {
      mocked.restore();
    }
  });

  it('sets reloginRequired on 403', async () => {
    const mocked = mockFetch([
      {
        match: '/oauth/token',
        respond: () => ({ status: 403, body: 'forbidden' }),
      },
    ]);

    try {
      await assert.rejects(
        () => refreshTokens(TEST_PROVIDER, 'rt', DEFAULT_CLIENT_ID),
        (err) => {
          assert.equal(err.reloginRequired, true);
          return true;
        },
      );
    } finally {
      mocked.restore();
    }
  });

  it('includes rate-limit info on 429', async () => {
    const mocked = mockFetch([
      {
        match: '/oauth/token',
        respond: () => ({
          status: 429,
          body: 'rate limited',
          headers: { 'Retry-After': '30' },
        }),
      },
    ]);

    try {
      await assert.rejects(
        () => refreshTokens(TEST_PROVIDER, 'rt', DEFAULT_CLIENT_ID),
        /429.*30/,
      );
    } finally {
      mocked.restore();
    }
  });
});

// ── Browser PKCE login flow ────────────────────────────────────────

describe('buildBrowserAuthorizeUrl', () => {
  it('builds a Codex-CLI-compatible authorize URL with PKCE S256', () => {
    const urlStr = buildBrowserAuthorizeUrl({
      clientId: DEFAULT_CLIENT_ID,
      redirectUri: 'http://localhost:1455/auth/callback',
      codeChallenge: 'challenge-abc',
      state: 'state-xyz',
    });
    const url = new URL(urlStr);
    assert.equal(url.origin + url.pathname, 'https://auth.openai.com/oauth/authorize');
    const q = url.searchParams;
    assert.equal(q.get('response_type'), 'code');
    assert.equal(q.get('client_id'), DEFAULT_CLIENT_ID);
    assert.equal(q.get('redirect_uri'), 'http://localhost:1455/auth/callback');
    assert.equal(q.get('code_challenge'), 'challenge-abc');
    assert.equal(q.get('code_challenge_method'), 'S256');
    assert.equal(q.get('state'), 'state-xyz');
    assert.equal(q.get('scope'), 'openid profile email offline_access api.connectors.read api.connectors.invoke');
    assert.equal(q.get('originator'), 'codex_cli_rs');
    assert.equal(q.get('codex_cli_simplified_flow'), 'true');
    assert.equal(q.get('id_token_add_organizations'), 'true');
    // Spaces must be percent-encoded, not '+'
    assert.ok(!url.search.includes('+'), 'scope spaces should be percent-encoded');
  });
});

describe('handleBrowserCallback', () => {
  it('accepts a matching state with a code', () => {
    const result = handleBrowserCallback(
      new URLSearchParams('code=abc&state=st-1'),
      'st-1',
    );
    assert.equal(result.outcome, 'code');
    assert.equal(result.code, 'abc');
  });

  it('rejects a state mismatch', () => {
    const result = handleBrowserCallback(
      new URLSearchParams('code=abc&state=other'),
      'st-1',
    );
    assert.equal(result.outcome, 'state-mismatch');
  });

  it('surfaces provider errors with descriptions', () => {
    const result = handleBrowserCallback(
      new URLSearchParams('error=access_denied&error_description=user+cancelled&state=st-1'),
      'st-1',
    );
    assert.equal(result.outcome, 'provider-error');
    assert.equal(result.error, 'access_denied');
    assert.equal(result.description, 'user cancelled');
  });

  it('rejects a callback without a code', () => {
    const result = handleBrowserCallback(new URLSearchParams('state=st-1'), 'st-1');
    assert.equal(result.outcome, 'missing-code');
  });
});

describe('startBrowserCallbackServer', () => {
  it('falls back to port 1457 when 1455 is in use', async () => {
    const blocker = net.createServer();
    await new Promise((resolve) => blocker.listen(1455, '127.0.0.1', resolve));
    try {
      const { server, port } = await startBrowserCallbackServer();
      assert.equal(port, 1457);
      await new Promise((resolve) => server.close(resolve));
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
  });
});

describe('beginBrowserLogin', () => {
  const BROWSER_PROVIDER = '__test_oauth_provider_browser';

  async function waitForStatus(sessionId, status, timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const sess = getLoginSession(sessionId);
      if (sess && sess.status === status) return sess;
      if (sess && (sess.status === 'error' || sess.status === 'expired')) {
        throw new Error(`login ended as ${sess.status}: ${sess.errorMessage}`);
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`timed out waiting for status "${status}"`);
  }

  it('completes login after a real callback hits the local server', async () => {
    const realFetch = globalThis.fetch;
    let exchangedRedirectUri = null;
    const mocked = mockFetch([
      {
        match: '/oauth/token',
        respond: (opts) => {
          exchangedRedirectUri = new URLSearchParams(String(opts.body)).get('redirect_uri');
          return {
            status: 200,
            body: {
              access_token: makeJwt({ exp: nowSec() + 3600 }),
              refresh_token: 'browser-refresh',
            },
          };
        },
      },
    ]);

    try {
      const sessionId = createLoginSession(BROWSER_PROVIDER, DEFAULT_CLIENT_ID);
      const { authUrl, port } = await beginBrowserLogin(sessionId, BROWSER_PROVIDER, DEFAULT_CLIENT_ID);

      assert.ok([1455, 1457].includes(port), `unexpected callback port ${port}`);
      assert.ok(authUrl.startsWith('https://auth.openai.com/oauth/authorize?'), 'authorize URL malformed');

      const sess = getLoginSession(sessionId);
      assert.equal(sess.mode, 'browser');
      assert.equal(sess.status, 'pending');
      assert.equal(sess.authUrl, authUrl);

      // Simulate the browser redirect with the real fetch — the mocked global
      // would not reach the local callback server.
      const state = new URL(authUrl).searchParams.get('state');
      const resp = await realFetch(`http://127.0.0.1:${port}/auth/callback?code=browser-code&state=${encodeURIComponent(state)}`);
      assert.equal(resp.status, 200);

      await waitForStatus(sessionId, 'approved');
      assert.equal(exchangedRedirectUri, `http://localhost:${port}/auth/callback`);

      const stored = readTokensSync(BROWSER_PROVIDER);
      assert.ok(stored);
      assert.equal(stored.refresh_token, 'browser-refresh');
    } finally {
      mocked.restore();
      cleanupProvider(BROWSER_PROVIDER);
    }
  });

  it('answers a wrong-state callback with 400 and keeps the session pending', async () => {
    const realFetch = globalThis.fetch;
    const mocked = mockFetch([
      {
        match: '/oauth/token',
        respond: () => ({
          status: 200,
          body: {
            access_token: makeJwt({ exp: nowSec() + 3600 }),
            refresh_token: 'browser-refresh-2',
          },
        }),
      },
    ]);

    try {
      const sessionId = createLoginSession(BROWSER_PROVIDER, DEFAULT_CLIENT_ID);
      const { port } = await beginBrowserLogin(sessionId, BROWSER_PROVIDER, DEFAULT_CLIENT_ID);

      const bad = await realFetch(`http://127.0.0.1:${port}/auth/callback?code=x&state=wrong`);
      assert.equal(bad.status, 400);
      assert.equal(getLoginSession(sessionId).status, 'pending');

      // Close out the session with a valid callback so the callback server and
      // its timers shut down.
      const sess = getLoginSession(sessionId);
      const state = new URL(sess.authUrl).searchParams.get('state');
      const good = await realFetch(`http://127.0.0.1:${port}/auth/callback?code=ok&state=${encodeURIComponent(state)}`);
      assert.equal(good.status, 200);
      await waitForStatus(sessionId, 'approved');
    } finally {
      mocked.restore();
      cleanupProvider(BROWSER_PROVIDER);
    }
  });
});

// ── Exported constants ─────────────────────────────────────────────

describe('Exported constants', () => {
  it('exports correct default values', () => {
    assert.equal(DEFAULT_CLIENT_ID, 'app_EMoamEEZ73f0CkXaXp7hrann');
    assert.equal(DEFAULT_CODEX_BASE_URL, 'https://chatgpt.com/backend-api/codex');
  });
});
