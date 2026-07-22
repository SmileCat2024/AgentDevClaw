/**
 * OpenAI Codex OAuth Device Code Flow
 *
 * Ported from hermes-agent/hermes_cli/auth.py — implements the full
 * device-code authorization grant used by OpenAI Codex (ChatGPT backend).
 *
 * Flow:
 *   1. POST {issuer}/api/accounts/deviceauth/usercode  → { user_code, device_auth_id }
 *   2. User visits {issuer}/codex/device and enters user_code
 *   3. Poll  {issuer}/api/accounts/deviceauth/token     → { authorization_code, code_verifier }
 *   4. POST  {token_url} grant_type=authorization_code  → { access_token, refresh_token }
 *   5. Refresh: POST {token_url} grant_type=refresh_token → new access_token
 */

import path from 'path';
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { USER_DATA_ROOT } from './shared/constants.js';

// ── Constants ───────────────────────────────────────────────────────

const OPENAI_ISSUER = 'https://auth.openai.com';
const DEFAULT_CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';
const DEFAULT_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const DEVICE_CODE_URL = `${OPENAI_ISSUER}/api/accounts/deviceauth/usercode`;
const DEVICE_POLL_URL = `${OPENAI_ISSUER}/api/accounts/deviceauth/token`;
const VERIFICATION_URL = `${OPENAI_ISSUER}/codex/device`;
const REDIRECT_URI = `${OPENAI_ISSUER}/deviceauth/callback`;
const REFRESH_SKEW_SECONDS = 120;   // refresh 2 min before expiry
const DEFAULT_POLL_INTERVAL = 5;    // seconds
const MAX_LOGIN_WAIT_MS = 15 * 60 * 1000; // 15 minutes
const OAUTH_FETCH_ATTEMPTS = 3;
const OAUTH_RETRY_BASE_DELAY_MS = 300;
const MAX_CONSECUTIVE_POLL_FAILURES = 5;

const OAUTH_TOKENS_DIR = path.join(USER_DATA_ROOT, 'oauth-tokens');

// ── Proxy support ───────────────────────────────────────────────────
//
// Proxy is now managed globally by server/shared/proxy-manager.js.
// At server startup, applyProxy() calls undici.setGlobalDispatcher()
// and sets process.env.HTTPS_PROXY for child processes. No per-module
// proxy code needed here — all fetch() calls automatically use the proxy.

/**
 * No-op passthrough. Proxy is configured globally via proxy-manager.
 * Kept for backward compat — existing call sites don't need changes.
 */
function fetchOptions(extra = {}) {
  return extra;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getNetworkErrorCode(error) {
  return error?.cause?.code || error?.code || '';
}

function isTransientNetworkError(error) {
  const code = getNetworkErrorCode(error);
  if ([
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT',
    'UND_ERR_SOCKET',
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'EAI_AGAIN',
    'ENETUNREACH',
    'EHOSTUNREACH',
  ].includes(code)) {
    return true;
  }
  return error instanceof TypeError && /fetch failed/i.test(error.message || '');
}

function wrapOAuthNetworkError(operation, error) {
  const code = getNetworkErrorCode(error);
  const causeMessage = error?.cause?.message || error?.message || String(error);
  const detail = code ? `${code}: ${causeMessage}` : causeMessage;
  const wrapped = new Error(`${operation} failed: ${detail}`);
  wrapped.code = code || 'OAUTH_NETWORK_ERROR';
  wrapped.transient = isTransientNetworkError(error);
  wrapped.cause = error;
  return wrapped;
}

/**
 * OAuth is commonly reached through a local HTTP proxy. A single CONNECT
 * timeout must not invalidate an otherwise-completed browser authorization.
 */
async function fetchOAuth(url, options, operation, attempts = OAUTH_FETCH_ATTEMPTS) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fetch(url, fetchOptions(options));
    } catch (error) {
      lastError = error;
      if (!isTransientNetworkError(error) || attempt >= attempts) {
        throw wrapOAuthNetworkError(operation, error);
      }
      await sleep(OAUTH_RETRY_BASE_DELAY_MS * attempt);
    }
  }
  throw wrapOAuthNetworkError(operation, lastError);
}

// In-memory login sessions (not persisted)
const loginSessions = new Map();

// Track in-flight refreshes to avoid duplicate concurrent refresh calls
const refreshInFlight = new Map();

// ── JWT helpers ────────────────────────────────────────────────────

/**
 * Decode JWT payload claims without signature verification.
 * Returns empty object on any error.
 */
function decodeJwtClaims(token) {
  if (typeof token !== 'string' || token.split('.').length !== 3) return {};
  const payload = token.split('.')[1];
  try {
    const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
    const raw = Buffer.from(padded, 'base64url').toString('utf8');
    const claims = JSON.parse(raw);
    return typeof claims === 'object' && claims !== null ? claims : {};
  } catch {
    return {};
  }
}

/**
 * Check if an access_token (JWT) is expiring within skew_seconds.
 * Returns false if the token is not a JWT or has no exp claim.
 */
export function isTokenExpiring(accessToken, skewSeconds = REFRESH_SKEW_SECONDS) {
  const claims = decodeJwtClaims(accessToken);
  const exp = claims.exp;
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return false;
  return exp <= (Date.now() / 1000 + Math.max(0, skewSeconds));
}

/**
 * Get expiry timestamp (ms) from a JWT access token, or null.
 */
export function getTokenExpiryMs(accessToken) {
  const claims = decodeJwtClaims(accessToken);
  const exp = claims.exp;
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return null;
  return exp * 1000;
}

/**
 * Resolve the ChatGPT account attached to a Codex OAuth access token.
 *
 * OpenAI access tokens currently keep this value in the namespaced auth
 * claim.  The top-level fallback keeps the adapter compatible with older
 * token shapes without persisting a second copy of account metadata.
 */
export function getCodexAccountId(accessToken) {
  const claims = decodeJwtClaims(accessToken);
  const authClaims = claims['https://api.openai.com/auth'];
  const accountId = authClaims && typeof authClaims === 'object'
    ? authClaims.chatgpt_account_id
    : null;
  const fallback = claims.chatgpt_account_id;
  return typeof accountId === 'string' && accountId.trim()
    ? accountId.trim()
    : (typeof fallback === 'string' ? fallback.trim() : '');
}

/**
 * Add the account context required by ChatGPT's Codex backend. Runtime-owned
 * headers replace same-name user entries so a stale preset cannot route a
 * valid OAuth token to the wrong ChatGPT account.
 */
export function buildCodexOAuthHeaders(accessToken, customHeaders = []) {
  const accountId = getCodexAccountId(accessToken);
  const requiredNames = new Set(['chatgpt-account-id']);
  const merged = Array.isArray(customHeaders)
    ? customHeaders.filter((header) => {
        const name = typeof header?.key === 'string' ? header.key.trim().toLowerCase() : '';
        return name && !requiredNames.has(name);
      })
    : [];

  if (accountId) {
    merged.push({
      key: 'ChatGPT-Account-ID',
      value: accountId,
      valueMode: 'static',
    });
  }
  return merged;
}

// ── Token storage ──────────────────────────────────────────────────

function tokenFilePath(providerName) {
  // Sanitize provider name for filesystem
  const safe = providerName.replace(/[^a-zA-Z0-9_\-.]/g, '_');
  return path.join(OAUTH_TOKENS_DIR, `${safe}.json`);
}

/**
 * Read stored OAuth tokens for a provider (synchronous).
 * Returns { access_token, refresh_token, last_refresh, clientId } or null.
 */
export function readTokensSync(providerName) {
  const filePath = tokenFilePath(providerName);
  if (!existsSync(filePath)) return null;
  try {
    const data = JSON.parse(readFileSync(filePath, 'utf8'));
    if (data && typeof data === 'object' && data.access_token) {
      return data;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Write OAuth tokens for a provider.
 */
function writeTokens(providerName, tokens) {
  mkdirSync(OAUTH_TOKENS_DIR, { recursive: true });
  const filePath = tokenFilePath(providerName);
  const payload = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token || '',
    last_refresh: new Date().toISOString(),
    clientId: tokens.clientId || DEFAULT_CLIENT_ID,
  };
  writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

/**
 * Delete stored OAuth tokens for a provider (logout).
 */
export function deleteTokens(providerName) {
  const filePath = tokenFilePath(providerName);
  if (existsSync(filePath)) {
    try { unlinkSync(filePath); } catch {}
  }
}

/**
 * Resolve the current access_token for an OAuth provider.
 * If the token is expiring, triggers a background refresh.
 * Returns the access_token string or null.
 *
 * This is designed to be called synchronously from resolveModelPresetLLM.
 */
export function resolveAccessTokenSync(providerName, clientId) {
  const tokens = readTokensSync(providerName);
  if (!tokens) return null;

  // If expiring, fire background refresh (non-blocking)
  if (isTokenExpiring(tokens.access_token)) {
    refreshTokensInBackground(providerName, tokens.refresh_token, clientId || tokens.clientId);
  }

  return tokens.access_token;
}

// ── Token refresh ──────────────────────────────────────────────────

/**
 * Refresh OAuth tokens via refresh_token grant.
 * Pure HTTP — returns updated token pair.
 */
export async function refreshTokens(providerName, refreshToken, clientId) {
  if (!refreshToken) {
    throw new Error('Missing refresh_token — re-login required');
  }

  const cid = clientId || DEFAULT_CLIENT_ID;

  const resp = await fetchOAuth(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: cid,
    }),
  }, 'Token refresh');

  if (resp.status === 429) {
    const retryAfter = resp.headers.get('retry-after');
    throw new Error(`Token endpoint rate-limited (429). Retry after ${retryAfter || 'a moment'}.`);
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    let detail = '';
    try {
      const err = JSON.parse(text);
      detail = err?.error_description || err?.error || err?.message || text;
    } catch {
      detail = text;
    }
    const relogin = resp.status === 401 || resp.status === 403;
    const error = new Error(`Token refresh failed (${resp.status}): ${detail}`);
    error.reloginRequired = relogin;
    throw error;
  }

  const payload = await resp.json();
  const newAccessToken = payload.access_token;
  if (!newAccessToken) {
    throw new Error('Refresh response missing access_token');
  }

  const updated = {
    access_token: newAccessToken,
    refresh_token: payload.refresh_token || refreshToken, // keep old if not rotated
    clientId: cid,
  };

  writeTokens(providerName, updated);
  return updated;
}

/**
 * Background refresh — fire-and-forget, deduplicated per provider.
 */
function refreshTokensInBackground(providerName, refreshToken, clientId) {
  if (refreshInFlight.has(providerName)) return refreshInFlight.get(providerName);

  const promise = refreshTokens(providerName, refreshToken, clientId)
    .then(() => {
      console.log(`[OAuth/Codex] Token refreshed for "${providerName}"`);
    })
    .catch((err) => {
      console.warn(`[OAuth/Codex] Background refresh failed for "${providerName}":`, err.message);
      if (err.reloginRequired) {
        deleteTokens(providerName);
        console.warn(`[OAuth/Codex] Tokens cleared for "${providerName}" — re-login required`);
      }
    })
    .finally(() => {
      refreshInFlight.delete(providerName);
    });

  refreshInFlight.set(providerName, promise);
  return promise;
}

// ── Device code login flow ─────────────────────────────────────────

/**
 * Step 1: Request a device code from OpenAI.
 * Returns { user_code, device_auth_id, interval }.
 */
export async function requestDeviceCode(clientId) {
  const cid = clientId || DEFAULT_CLIENT_ID;

  // Retry with backoff on 429
  let resp = null;
  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    resp = await fetchOAuth(DEVICE_CODE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: cid }),
    }, 'Device code request');

    if (resp.status !== 429) break;

    if (attempt < maxAttempts) {
      const retryAfter = parseInt(resp.headers.get('retry-after') || '0', 10);
      const delay = retryAfter > 0 ? Math.min(retryAfter, 60) : Math.min(2 ** attempt, 60);
      console.log(`[OAuth/Codex] Device code rate-limited (429); retrying in ${delay}s...`);
      await new Promise((r) => setTimeout(r, delay * 1000));
    }
  }

  if (!resp) {
    throw new Error('Device code request failed — no response');
  }
  if (resp.status === 429) {
    throw new Error('OpenAI is rate-limiting login requests (HTTP 429). Please wait and try again.');
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Device code request failed (${resp.status}): ${text}`);
  }

  const data = await resp.json();
  const userCode = data.user_code || '';
  const deviceAuthId = data.device_auth_id || '';
  const interval = Math.max(3, parseInt(data.interval || '5', 10));

  if (!userCode || !deviceAuthId) {
    throw new Error('Device code response missing user_code or device_auth_id');
  }

  return { userCode, deviceAuthId, interval };
}

/**
 * Step 2-3: Poll device authorization until the user approves.
 * Returns { authorization_code, code_verifier } or null on timeout.
 *
 * This is a long-polling function — it blocks until completion or timeout.
 * Designed to be called from a background worker.
 */
export async function pollDeviceAuthorization(deviceAuthId, userCode, intervalMs, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || MAX_LOGIN_WAIT_MS);
  const pollInterval = intervalMs || (DEFAULT_POLL_INTERVAL * 1000);
  let consecutiveFailures = 0;
  let lastNetworkError = null;

  while (Date.now() < deadline) {
    await sleep(pollInterval);

    let resp;
    try {
      resp = await fetchOAuth(DEVICE_POLL_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
      }, 'Device authorization poll', 2);
    } catch (error) {
      if (!error?.transient) throw error;
      lastNetworkError = error;
      consecutiveFailures += 1;
      console.warn(`[OAuth/Codex] Device authorization poll network failure ${consecutiveFailures}/${MAX_CONSECUTIVE_POLL_FAILURES}: ${error.message}`);
      if (consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) throw error;
      continue;
    }

    if (resp.status === 200) {
      return await resp.json();
    }
    if (resp.status === 403 || resp.status === 404) {
      consecutiveFailures = 0;
      lastNetworkError = null;
      continue; // user hasn't completed login yet
    }
    if (resp.status === 429 || resp.status >= 500) {
      consecutiveFailures += 1;
      const text = await resp.text().catch(() => '');
      lastNetworkError = new Error(`Device authorization poll returned ${resp.status}: ${text}`);
      if (consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) throw lastNetworkError;
      continue;
    }
    // Unexpected error
    const text = await resp.text().catch(() => '');
    throw new Error(`Device auth poll returned ${resp.status}: ${text}`);
  }

  if (lastNetworkError) throw lastNetworkError;
  return null; // timed out
}

/**
 * Step 4: Exchange authorization code for access/refresh tokens.
 */
export async function exchangeCodeForTokens(authorizationCode, codeVerifier, clientId) {
  const cid = clientId || DEFAULT_CLIENT_ID;

  const resp = await fetchOAuth(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: authorizationCode,
      redirect_uri: REDIRECT_URI,
      client_id: cid,
      code_verifier: codeVerifier,
    }),
  }, 'Token exchange');

  if (resp.status === 429) {
    throw new Error('Token exchange rate-limited (429). Please wait and try again.');
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Token exchange failed (${resp.status}): ${text}`);
  }

  const tokens = await resp.json();
  if (!tokens.access_token) {
    throw new Error('Token exchange response missing access_token');
  }

  return {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token || '',
    clientId: cid,
  };
}

// ── Full login orchestration (background) ──────────────────────────

/**
 * Run the complete device-code login flow in background.
 * Updates the login session status as it progresses.
 *
 * @param {string} sessionId - Login session ID
 * @param {string} providerName - Provider name for token storage
 * @param {string} clientId - OAuth client_id
 */
export async function runDeviceCodeLogin(sessionId, providerName, clientId) {
  const session = loginSessions.get(sessionId);
  if (!session) return;

  try {
    // Step 1: request device code
    const { userCode, deviceAuthId, interval } = await requestDeviceCode(clientId);

    session.userCode = userCode;
    session.verificationUrl = VERIFICATION_URL;
    session.deviceAuthId = deviceAuthId;
    session.interval = interval;
    session.status = 'pending';
    session.expiresAt = Date.now() + MAX_LOGIN_WAIT_MS;

    // Step 2-3: poll for authorization (background)
    const codeResp = await pollDeviceAuthorization(
      deviceAuthId, userCode, interval * 1000, MAX_LOGIN_WAIT_MS,
    );

    if (!codeResp) {
      session.status = 'expired';
      session.errorMessage = 'Device code expired before approval';
      return;
    }

    const authorizationCode = codeResp.authorization_code || '';
    const codeVerifier = codeResp.code_verifier || '';
    if (!authorizationCode || !codeVerifier) {
      session.status = 'error';
      session.errorMessage = 'Device auth response missing authorization_code or code_verifier';
      return;
    }

    // Step 4: exchange for tokens
    const tokens = await exchangeCodeForTokens(authorizationCode, codeVerifier, clientId);

    // Save tokens
    writeTokens(providerName, tokens);

    session.status = 'approved';
    console.log(`[OAuth/Codex] Login completed for provider "${providerName}" (session=${sessionId})`);
  } catch (error) {
    session.status = 'error';
    session.errorMessage = error.message || String(error);
    console.warn(`[OAuth/Codex] Login failed (session=${sessionId}):`, error.message);
  }
}

// ── Session management ─────────────────────────────────────────────

/**
 * Create a new login session.
 */
export function createLoginSession(providerName, clientId) {
  // Clean up old sessions (> 20 min)
  const now = Date.now();
  for (const [id, sess] of loginSessions) {
    if (sess.createdAt && now - sess.createdAt > 20 * 60 * 1000) {
      loginSessions.delete(id);
    }
  }

  const sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  loginSessions.set(sessionId, {
    sessionId,
    providerName,
    clientId: clientId || DEFAULT_CLIENT_ID,
    status: 'initiating', // initiating → pending → approved | expired | error
    userCode: null,
    verificationUrl: null,
    deviceAuthId: null,
    interval: DEFAULT_POLL_INTERVAL,
    expiresAt: null,
    errorMessage: null,
    createdAt: now,
  });
  return sessionId;
}

/**
 * Get login session status (safe to poll from HTTP handler).
 */
export function getLoginSession(sessionId) {
  const sess = loginSessions.get(sessionId);
  if (!sess) return null;
  return {
    sessionId: sess.sessionId,
    status: sess.status,
    userCode: sess.userCode,
    verificationUrl: sess.verificationUrl,
    expiresAt: sess.expiresAt,
    errorMessage: sess.errorMessage,
  };
}

// ── Public query helpers ───────────────────────────────────────────

/**
 * Get token status for a provider (for UI display).
 * Does NOT return the actual token value.
 */
export function getTokenStatus(providerName) {
  const tokens = readTokensSync(providerName);
  if (!tokens) return { loggedIn: false };

  const expiryMs = getTokenExpiryMs(tokens.access_token);
  const isExpired = expiryMs !== null && expiryMs <= Date.now();
  const isExpiring = isTokenExpiring(tokens.access_token, 300); // 5 min window for display

  return {
    loggedIn: !isExpired,
    expiresAt: expiryMs ? new Date(expiryMs).toISOString() : null,
    lastRefresh: tokens.last_refresh || null,
    isExpiring,
  };
}

export {
  DEFAULT_CLIENT_ID,
  DEFAULT_CODEX_BASE_URL,
  VERIFICATION_URL,
};
