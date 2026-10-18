/**
 * OpenAI Codex OAuth login — two flows, one token store.
 *
 * Device-code flow (ported from hermes-agent/hermes_cli/auth.py):
 *   1. POST {issuer}/api/accounts/deviceauth/usercode  → { user_code, device_auth_id }
 *   2. User visits {issuer}/codex/device and enters user_code
 *   3. Poll  {issuer}/api/accounts/deviceauth/token     → { authorization_code, code_verifier }
 *   4. POST  {token_url} grant_type=authorization_code  → { access_token, refresh_token }
 *
 * Browser PKCE flow (mirrors `codex login`, the Codex CLI default):
 *   1. Start one-shot callback server on 127.0.0.1:1455 (fallback 1457 — both are
 *      in the redirect-URI allow-list registered for the Codex client_id)
 *   2. User authorizes at {issuer}/oauth/authorize (code_challenge S256 + state)
 *   3. Browser redirects to the callback server with ?code&state
 *   4. POST {token_url} grant_type=authorization_code  → tokens
 *
 * Token refresh (both flows): POST {token_url} grant_type=refresh_token.
 */

import path from 'path';
import crypto from 'crypto';
import http from 'http';
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, openSync, closeSync, writeSync } from 'fs';
import { USER_DATA_ROOT } from './shared/constants.js';
import { fetchWithRetry } from './shared/fetch-retry.js';

// ── Constants ───────────────────────────────────────────────────────

const OPENAI_ISSUER = 'https://auth.openai.com';
const DEFAULT_CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';
const DEFAULT_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const DEVICE_CODE_URL = `${OPENAI_ISSUER}/api/accounts/deviceauth/usercode`;
const DEVICE_POLL_URL = `${OPENAI_ISSUER}/api/accounts/deviceauth/token`;
const VERIFICATION_URL = `${OPENAI_ISSUER}/codex/device`;
const REDIRECT_URI = `${OPENAI_ISSUER}/deviceauth/callback`;
const OAUTH_AUTHORIZE_URL = `${OPENAI_ISSUER}/oauth/authorize`;
// Scope + extras copied from the Codex CLI browser login so the authorize page
// treats this client identically to the official CLI (same public client_id).
const BROWSER_LOGIN_SCOPE = 'openid profile email offline_access api.connectors.read api.connectors.invoke';
const CODEX_ORIGINATOR = 'codex_cli_rs';
const BROWSER_CALLBACK_PORT = 1455;          // registered in OpenAI's redirect URI allow-list
const BROWSER_CALLBACK_FALLBACK_PORT = 1457; // keep in sync with the Codex CLI allow-list
const REFRESH_SKEW_SECONDS = 300;   // refresh 5 min before expiry (aligned with codex-rs proactive window)
// JWT 解不出 exp 时的兜底：距上次刷新超过 7 天视为必须刷新（对齐 codex-rs
// 的 stale-token 兜底），否则无 exp 的 token 会永不刷新。
const NO_EXP_REFRESH_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_POLL_INTERVAL = 5;    // seconds
const MAX_LOGIN_WAIT_MS = 15 * 60 * 1000; // 15 minutes
const OAUTH_FETCH_ATTEMPTS = 3;
const MAX_CONSECUTIVE_POLL_FAILURES = 5;

const OAUTH_TOKENS_DIR = path.join(USER_DATA_ROOT, 'oauth-tokens');

// ── Proxy support ───────────────────────────────────────────────────
//
// Proxy is now managed globally by server/shared/proxy-manager.js.
// At server startup, applyProxy() calls undici.setGlobalDispatcher()
// and sets process.env.HTTPS_PROXY for child processes. No per-module
// proxy code needed here — all fetch() calls automatically use the proxy.

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * OAuth is commonly reached through a local HTTP proxy. A single CONNECT
 * timeout must not invalidate an otherwise-completed browser authorization.
 * Retry policy (transient network errors + retryable upstream statuses,
 * including 5xx) is owned by shared/fetch-retry; no per-attempt timeout
 * here — the poll loop owns its own budget.
 */
async function fetchOAuth(url, options, operation, attempts = OAUTH_FETCH_ATTEMPTS) {
  return fetchWithRetry(url, options, { attempts, timeoutMs: 0, operation });
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
 * Decide whether a stored tokens object is due for refresh.
 *
 * Unlike isTokenExpiring this takes the full tokens object: when the
 * access_token carries no usable exp claim (opaque or non-JWT), fall back to
 * the age of last_refresh (7 days) instead of never refreshing.
 * Display semantics (getTokenStatus) keep using isTokenExpiring directly.
 */
export function isTokenRefreshDue(tokens, skewSeconds = REFRESH_SKEW_SECONDS) {
  const accessToken = tokens?.access_token;
  if (!accessToken) return false;
  const claims = decodeJwtClaims(accessToken);
  if (typeof claims.exp === 'number' && Number.isFinite(claims.exp)) {
    return isTokenExpiring(accessToken, skewSeconds);
  }
  const last = Date.parse(tokens.last_refresh || '');
  return !Number.isFinite(last) || Date.now() - last > NO_EXP_REFRESH_AGE_MS;
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

// ── Credential change notification (ADR-0028 修订) ──────────────────
// 登录完成（新凭证族落盘）时通知宿主侧：运行中 runtime 的 LLM 实例是参数
// 快照，旧凭证仍有效期间没有 401 可触发 auth-recovery，必须由宿主主动推送
// 重 resolve。本模块被 server 与 runtime 子进程共享，保持零 server 侧依赖：
// 回调由路由装配时经 setCredentialChangeListener 注入。仅登录流程触发，
// 常规 token refresh 不触发——那类轮换由 401 反应式恢复覆盖，推送只会造成
// 无意义的实例churn。
let credentialChangeListener = null;

export function setCredentialChangeListener(fn) {
  credentialChangeListener = typeof fn === 'function' ? fn : null;
}

function notifyCredentialChange(providerName) {
  if (!credentialChangeListener) return;
  try {
    credentialChangeListener(providerName);
  } catch (err) {
    console.warn(`[OAuth/Codex] Credential change listener failed:`, err?.message || err);
  }
}

/**
 * Resolve the current access_token for an OAuth provider.
 * If the token is due for refresh (exp window or last_refresh fallback),
 * triggers a background refresh.
 * Returns the access_token string or null.
 *
 * This is designed to be called synchronously from resolveModelPresetLLM.
 */
export function resolveAccessTokenSync(providerName, clientId) {
  const tokens = readTokensSync(providerName);
  if (!tokens) return null;

  // If due, fire background refresh (non-blocking)
  if (isTokenRefreshDue(tokens)) {
    refreshTokensInBackground(providerName, tokens.refresh_token, clientId || tokens.clientId);
  }

  return tokens.access_token;
}

// ── Cross-process refresh lock ─────────────────────────────────────
// OAuth refresh_token 是一次性的：轮换后旧值立即作废，两个进程并发拿同一旧值
// POST 会触发 OpenAI 判 refresh_token_reused 并吊销整个 token family。进程内
// refreshInFlight 挡不住跨进程（server 与 plain agent / one-shot / mirror 等
// 宿主都会走 resolveAccessTokenSync），用 O_EXCL 独占创建锁文件把网络刷新
// 串行化：等锁者拿到锁后重读 token 文件，refresh_token 已被轮换就直接采用，
// 不再发网络请求。

const TOKEN_LOCK_STALE_MS = 30_000;      // holder 崩溃残留锁的回收阈值（正常刷新秒级完成）
const TOKEN_LOCK_WAIT_TIMEOUT_MS = 10_000;
const TOKEN_LOCK_POLL_MS = 100;

function tokenLockFilePath(providerName) {
  return `${tokenFilePath(providerName)}.lock`;
}

function acquireTokenLock(providerName) {
  mkdirSync(OAUTH_TOKENS_DIR, { recursive: true });
  try {
    // Exclusive create is atomic on all platforms ('wx' fails when the file exists).
    const fd = openSync(tokenLockFilePath(providerName), 'wx');
    // Ownership token: release only deletes the lock we still own, so a
    // stale-lock steal by another process can't be clobbered by a late holder.
    const ownership = JSON.stringify({ pid: process.pid, acquiredAt: Date.now() });
    try {
      writeSync(fd, ownership);
    } finally {
      closeSync(fd);
    }
    return ownership;
  } catch (error) {
    if (error?.code === 'EEXIST') return null;
    throw error;
  }
}

function isTokenLockStale(providerName) {
  try {
    const acquiredAt = JSON.parse(readFileSync(tokenLockFilePath(providerName), 'utf8'))?.acquiredAt;
    return typeof acquiredAt !== 'number' || Date.now() - acquiredAt > TOKEN_LOCK_STALE_MS;
  } catch {
    // 锁文件已消失（持有者刚释放）或内容残缺（写入中途崩溃）——都可安全重抢
    return true;
  }
}

function releaseTokenLock(providerName, ownership) {
  if (!ownership) return;
  try {
    if (readFileSync(tokenLockFilePath(providerName), 'utf8') === ownership) {
      unlinkSync(tokenLockFilePath(providerName));
    }
  } catch {}
}

async function withTokenLock(providerName, waitTimeoutMs, fn) {
  const deadline = Date.now() + waitTimeoutMs;
  for (;;) {
    let ownership = acquireTokenLock(providerName);
    if (!ownership && isTokenLockStale(providerName)) {
      // 持有者已死或异常滞留——回收残锁后重试独占创建
      try { unlinkSync(tokenLockFilePath(providerName)); } catch {}
      ownership = acquireTokenLock(providerName);
    }
    if (ownership) {
      try {
        return await fn();
      } finally {
        releaseTokenLock(providerName, ownership);
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for the OAuth refresh lock of "${providerName}" — another process is refreshing`);
    }
    await sleep(TOKEN_LOCK_POLL_MS);
  }
}

// ── Token refresh ──────────────────────────────────────────────────

// refresh_token 永久失效错误码（对齐 codex-rs login/src/auth/manager.rs
// classify_refresh_token_failure）：OpenAI 对已作废 refresh_token 实际返回
// 400 + invalid_grant（嵌套 envelope 里 error.code 才带具体原因），只认
// 401/403 会漏掉"必须重登"的情形。
const PERMANENT_REFRESH_ERROR_CODES = [
  'refresh_token_reused',
  'refresh_token_expired',
  'refresh_token_invalidated',
];

/**
 * Parse a failed refresh response body into the fields used for
 * classification, mirroring codex-rs TokenErrorDetail::parse: standard OAuth
 * `error` string, nested `error.code`, or top-level `code`, plus
 * `error_description` for diagnostics.
 */
function parseTokenErrorBody(text) {
  let parsed = {};
  try {
    const body = JSON.parse(text);
    if (body && typeof body === 'object') parsed = body;
  } catch {}
  const error = parsed.error;
  return {
    error: typeof error === 'string' ? error : '',
    errorCode: typeof error?.code === 'string' ? error.code : (typeof parsed.code === 'string' ? parsed.code : ''),
    errorDescription: typeof parsed.error_description === 'string' ? parsed.error_description : '',
    errorMessage: typeof parsed.message === 'string' ? parsed.message : (typeof error?.message === 'string' ? error.message : ''),
  };
}

/**
 * Permanent (re-login required) refresh rejection:
 *   - 401/403 as before;
 *   - 400 + invalid_grant (the shape OpenAI actually returns for a dead
 *     refresh_token);
 *   - 400 + refresh_token_reused / expired / invalidated in the unified error
 *     code or the error_description.
 */
function isPermanentRefreshRejection(status, body) {
  if (status === 401 || status === 403) return true;
  if (status !== 400) return false;
  const code = [body.error, body.errorCode].find((value) => value) || '';
  if (code.toLowerCase() === 'invalid_grant') return true;
  const haystack = `${code} ${body.errorDescription}`.toLowerCase();
  return PERMANENT_REFRESH_ERROR_CODES.some((marker) => haystack.includes(marker));
}

/**
 * Refresh OAuth tokens via refresh_token grant.
 * Serialized across processes by the provider-granularity file lock; a caller
 * that waited while another process rotated the refresh_token adopts the
 * stored tokens instead of re-using its stale copy over the network.
 * Pure HTTP — returns updated token pair.
 */
export async function refreshTokens(providerName, refreshToken, clientId, { lockWaitTimeoutMs = TOKEN_LOCK_WAIT_TIMEOUT_MS } = {}) {
  if (!refreshToken) {
    throw new Error('Missing refresh_token — re-login required');
  }

  return withTokenLock(providerName, lockWaitTimeoutMs, async () => {
    // Re-read under the lock: another process may have rotated the
    // refresh_token while we waited. A missing file is not ours to judge —
    // callers pre-check the store and the HTTP round-trip re-classifies.
    const current = readTokensSync(providerName);
    if (current?.refresh_token && current.refresh_token !== refreshToken) {
      // Already rotated by another process — adopting the stored copy is the
      // only safe move; re-sending our stale one would revoke the token family.
      console.log(`[OAuth/Codex] Refresh token for "${providerName}" already rotated by another process — adopting stored tokens`);
      return current;
    }
    return performTokenRefresh(providerName, current?.refresh_token || refreshToken, clientId);
  });
}

/**
 * The network round-trip, must run under the provider lock.
 */
async function performTokenRefresh(providerName, refreshToken, clientId) {
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
    const body = parseTokenErrorBody(text);
    const detail = body.errorDescription || body.error || body.errorMessage || text;
    const error = new Error(`Token refresh failed (${resp.status}): ${detail}`);
    error.reloginRequired = isPermanentRefreshRejection(resp.status, body);
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

/**
 * Startup pre-refresh for one OAuth provider: await a due refresh to
 * completion so a subsequent synchronous resolve reads a fresh token file.
 * Reuses the background path (in-process dedup + lock + relogin cleanup);
 * failures are swallowed by that path — startup proceeds with the current
 * token either way. Returns true when a refresh was actually awaited.
 */
export async function preflightRefreshTokens(providerName, clientId) {
  const tokens = readTokensSync(providerName);
  if (!tokens) return false;
  if (!isTokenRefreshDue(tokens)) return false;
  await refreshTokensInBackground(providerName, tokens.refresh_token, clientId || tokens.clientId);
  return true;
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
 * `redirectUri` must match the one used when the code was issued — the
 * device-code flow uses the issuer's callback page, the browser flow uses the
 * local callback server.
 */
export async function exchangeCodeForTokens(authorizationCode, codeVerifier, clientId, redirectUri = REDIRECT_URI) {
  const cid = clientId || DEFAULT_CLIENT_ID;

  const resp = await fetchOAuth(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: authorizationCode,
      redirect_uri: redirectUri,
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
    notifyCredentialChange(providerName);

    session.status = 'approved';
    console.log(`[OAuth/Codex] Login completed for provider "${providerName}" (session=${sessionId})`);
  } catch (error) {
    session.status = 'error';
    session.errorMessage = error.message || String(error);
    console.warn(`[OAuth/Codex] Login failed (session=${sessionId}):`, error.message);
  }
}

// ── Browser PKCE login flow ────────────────────────────────────────

function generatePkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, codeChallenge };
}

function generateState() {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * Build the /oauth/authorize URL (PKCE S256 + state), mirroring the Codex CLI
 * browser login parameters so the authorize page matches the official client.
 */
export function buildBrowserAuthorizeUrl({ clientId, redirectUri, codeChallenge, state }) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
    scope: BROWSER_LOGIN_SCOPE,
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    originator: CODEX_ORIGINATOR,
  });
  // URLSearchParams encodes spaces as '+'; percent-encode them to the safer
  // RFC 3986 form.
  return `${OAUTH_AUTHORIZE_URL}?${params.toString().replace(/\+/g, '%20')}`;
}

function listenServer(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
}

/**
 * Start the one-shot localhost callback server. Tries the Codex-registered
 * port 1455 first, then the registered fallback 1457; both are required
 * because OpenAI validates redirect_uri against the client's allow-list.
 */
export async function startBrowserCallbackServer() {
  let lastError = null;
  for (const port of [BROWSER_CALLBACK_PORT, BROWSER_CALLBACK_FALLBACK_PORT]) {
    const server = http.createServer();
    try {
      await listenServer(server, port);
      return { server, port };
    } catch (error) {
      lastError = error;
      if (error?.code !== 'EADDRINUSE') throw error;
    }
  }
  throw new Error(
    `Browser login callback ports ${BROWSER_CALLBACK_PORT}/${BROWSER_CALLBACK_FALLBACK_PORT} are both in use`
    + (lastError?.message ? `: ${lastError.message}` : ''),
  );
}

/**
 * Validate callback query parameters against the expected state.
 * Pure function — the HTTP layer owns session lookups.
 */
export function handleBrowserCallback(query, expectedState) {
  const state = query.get('state') || '';
  if (state !== expectedState) return { outcome: 'state-mismatch' };

  const providerError = query.get('error');
  if (providerError) {
    return {
      outcome: 'provider-error',
      error: providerError,
      description: query.get('error_description') || '',
    };
  }

  const code = query.get('code') || '';
  if (!code) return { outcome: 'missing-code' };

  return { outcome: 'code', code };
}

// The callback page reflects provider-returned error/description from the
// request query — escape before interpolating into HTML.
function escapeHtmlText(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function callbackPageHtml(title, bodyText) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtmlText(title)}</title></head>`
    + `<body style="font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#1e1f24;color:#e6e6e6;">`
    + `<div style="text-align:center;"><h2>${escapeHtmlText(title)}</h2><p>${escapeHtmlText(bodyText)}</p></div></body></html>`;
}

function wireBrowserCallback(server, sessionId) {
  server.on('request', (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (url.pathname !== '/auth/callback') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const session = loginSessions.get(sessionId);
    const result = handleBrowserCallback(url.searchParams, session?.state || '');

    if (result.outcome === 'code') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(callbackPageHtml('Authorized', 'Login approved — you can close this tab and return to AgentDevClaw.'));
      session?.callbackResolve?.(result.code);
    } else if (result.outcome === 'provider-error') {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(callbackPageHtml('Authorization failed', `${result.error}${result.description ? ' — ' + result.description : ''}`));
      session?.callbackReject?.(new Error(
        `Authorization denied: ${result.error}${result.description ? ` — ${result.description}` : ''}`,
      ));
    } else if (result.outcome === 'state-mismatch') {
      // Stray request (e.g. a second browser tab): answer it, keep waiting.
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(callbackPageHtml('Invalid request', 'This login request does not match the active session. Close this tab and retry from the original one.'));
    } else {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(callbackPageHtml('Authorization failed', 'The callback was missing an authorization code.'));
      session?.callbackReject?.(new Error('Authorization callback missing code'));
    }
  });
}

/**
 * Wait for the browser callback, exchange the code for tokens, then shut the
 * callback server down. Runs in the background once beginBrowserLogin resolves.
 */
async function finishBrowserLogin(server, sessionId, providerName, clientId) {
  const session = loginSessions.get(sessionId);
  if (!session) {
    server.close();
    return;
  }

  const timeoutId = setTimeout(() => {
    session.callbackReject?.(Object.assign(
      new Error('Browser login timed out before authorization'),
      { timedOut: true },
    ));
  }, MAX_LOGIN_WAIT_MS);

  let code;
  try {
    code = await new Promise((resolve, reject) => {
      session.callbackResolve = resolve;
      session.callbackReject = reject;
    });

    const tokens = await exchangeCodeForTokens(code, session.pkce.verifier, clientId, session.redirectUri);
    writeTokens(providerName, tokens);
    notifyCredentialChange(providerName);
    session.status = 'approved';
    console.log(`[OAuth/Codex] Browser login completed for provider "${providerName}" (session=${sessionId})`);
  } catch (error) {
    if (error?.timedOut) {
      session.status = 'expired';
      session.errorMessage = 'Browser login timed out before authorization';
    } else {
      session.status = 'error';
      session.errorMessage = error.message || String(error);
    }
    console.warn(`[OAuth/Codex] Browser login failed (session=${sessionId}):`, session.errorMessage);
  } finally {
    clearTimeout(timeoutId);
    session.callbackResolve = null;
    session.callbackReject = null;
    server.close();
  }
}

/**
 * Start the browser PKCE login: spins up the local callback server and
 * resolves with the authorize URL once everything is ready. The background
 * wait for the callback (and the token exchange) continues on its own.
 */
export async function beginBrowserLogin(sessionId, providerName, clientId) {
  const session = loginSessions.get(sessionId);
  if (!session) throw new Error('Login session not found');

  const cid = clientId || session.clientId;
  const { server, port } = await startBrowserCallbackServer();
  const pkce = generatePkce();
  const state = generateState();
  const redirectUri = `http://localhost:${port}/auth/callback`;
  const authUrl = buildBrowserAuthorizeUrl({ clientId: cid, redirectUri, codeChallenge: pkce.codeChallenge, state });

  session.mode = 'browser';
  session.authUrl = authUrl;
  session.state = state;
  session.pkce = pkce;
  session.redirectUri = redirectUri;
  session.status = 'pending';
  session.expiresAt = Date.now() + MAX_LOGIN_WAIT_MS;

  wireBrowserCallback(server, sessionId);
  finishBrowserLogin(server, sessionId, providerName, cid).catch((err) => {
    console.warn(`[OAuth/Codex] Browser login worker error (session=${sessionId}):`, err?.message || err);
  });
  return { authUrl, port };
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
    mode: 'device', // 'device' | 'browser'
    status: 'initiating', // initiating → pending → approved | expired | error
    userCode: null,
    verificationUrl: null,
    authUrl: null,
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
    mode: sess.mode || 'device',
    status: sess.status,
    userCode: sess.userCode,
    verificationUrl: sess.verificationUrl,
    authUrl: sess.authUrl || null,
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
