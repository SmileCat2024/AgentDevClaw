/**
 * Global Proxy Manager
 *
 * Node.js built-in fetch (undici) does NOT respect HTTP_PROXY / HTTPS_PROXY
 * env vars or the Windows system proxy by default. This module provides a
 * centralised way to configure a proxy that affects:
 *
 *   1. External server.js fetch() calls (via undici.setGlobalDispatcher)
 *   2. All agent child processes (via process.env.HTTPS_PROXY inheritance)
 *   3. All spawned mirror/sub-agent processes (same env inheritance)
 *
 * Loopback traffic is always excluded. Claw proxies its public /api routes to
 * a ViewerWorker on 127.0.0.1 and that internal control plane must never be
 * sent through a desktop HTTP proxy.
 *
 * Config is persisted in ~/.agentdev/AgentDevClaw/proxy-config.json
 */

import { execSync } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { USER_DATA_ROOT } from './constants.js';

const _require = createRequire(import.meta.url);
const _undici = _require('undici');
const _defaultGlobalDispatcher = _undici.getGlobalDispatcher();
const LOOPBACK_NO_PROXY = ['localhost', '127.0.0.1'];
const PROXY_CONNECT_TIMEOUT_MS = 10_000;
const PROXY_HEADERS_TIMEOUT_MS = 60_000;
const ORIGINAL_NO_PROXY = {
  upper: process.env.NO_PROXY,
  lower: process.env.no_proxy,
};

const PROXY_CONFIG_PATH = path.join(USER_DATA_ROOT, 'proxy-config.json');

// ── State ────────────────────────────────────────────────────────

let _appliedProxyUrl = null;   // The proxy URL currently applied (or null)
let _managedDispatcher = null;

function closeManagedDispatcher(dispatcher) {
  if (!dispatcher || dispatcher === _defaultGlobalDispatcher) return;
  Promise.resolve(dispatcher.close?.()).catch((error) => {
    console.warn(`[Proxy] Failed to close previous dispatcher: ${error.message}`);
  });
}

function restoreNoProxyEnvironment() {
  if (ORIGINAL_NO_PROXY.upper == null) delete process.env.NO_PROXY;
  else process.env.NO_PROXY = ORIGINAL_NO_PROXY.upper;
  if (ORIGINAL_NO_PROXY.lower == null) delete process.env.no_proxy;
  else process.env.no_proxy = ORIGINAL_NO_PROXY.lower;
}

/**
 * Merge NO_PROXY values while guaranteeing the Claw/Viewer loopback hosts.
 */
export function buildNoProxyValue(...values) {
  const entries = [];
  const seen = new Set();
  for (const value of [...values, LOOPBACK_NO_PROXY.join(',')]) {
    for (const raw of String(value || '').split(/[\s,]+/)) {
      const entry = raw.trim();
      const key = entry.toLowerCase();
      if (!entry || seen.has(key)) continue;
      seen.add(key);
      entries.push(entry);
    }
  }
  return entries.join(',');
}

/**
 * Create a dispatcher that proxies external requests and bypasses loopback.
 */
export function createProxyDispatcher(url, noProxy = '') {
  return new _undici.EnvHttpProxyAgent({
    httpProxy: url,
    httpsProxy: url,
    noProxy: buildNoProxyValue(noProxy),
    headersTimeout: PROXY_HEADERS_TIMEOUT_MS,
    connect: { timeout: PROXY_CONNECT_TIMEOUT_MS },
  });
}

// ── Config persistence ───────────────────────────────────────────

/**
 * Read proxy config.
 * @returns {{ enabled: boolean, url: string }}
 */
export function getProxyConfig() {
  try {
    const raw = readFileSync(PROXY_CONFIG_PATH, 'utf-8');
    const data = JSON.parse(raw);
    const proxy = data?.proxy;
    return {
      enabled: !!(proxy?.enabled),
      url: typeof proxy?.url === 'string' ? proxy.url.trim() : '',
    };
  } catch {
    return { enabled: false, url: '' };
  }
}

/**
 * Save proxy config.
 * @param {{ enabled: boolean, url: string }} proxyConfig
 */
export function saveProxyConfig(proxyConfig) {
  try {
    mkdirSync(USER_DATA_ROOT, { recursive: true });
    const data = { proxy: {
      enabled: !!proxyConfig.enabled,
      url: typeof proxyConfig.url === 'string' ? proxyConfig.url.trim() : '',
    }};
    writeFileSync(PROXY_CONFIG_PATH, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.warn('[Proxy] Failed to save config:', err.message);
  }
}

// ── System proxy detection ───────────────────────────────────────

/**
 * Detect system proxy from env vars and Windows registry.
 * @returns {{ url: string|null, source: string }}
 */
export function detectSystemProxy() {
  // 1. Environment variables
  const envProxy = process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.HTTP_PROXY || process.env.http_proxy;
  if (envProxy) {
    return { url: envProxy, source: 'env' };
  }

  // 2. Windows registry
  if (process.platform === 'win32') {
    try {
      const regOut = execSync(
        'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable',
        { encoding: 'utf-8', timeout: 3000 }
      );
      const enableMatch = regOut.match(/ProxyEnable\s+REG_DWORD\s+0x([0-9a-fA-F]+)/);
      if (!enableMatch || parseInt(enableMatch[1], 16) !== 1) {
        return { url: null, source: 'registry' };
      }

      const serverOut = execSync(
        'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer',
        { encoding: 'utf-8', timeout: 3000 }
      );
      const serverMatch = serverOut.match(/ProxyServer\s+REG_SZ\s+(.+)/);
      if (!serverMatch) return { url: null, source: 'registry' };

      const raw = serverMatch[1].trim();
      // ProxyServer can be "127.0.0.1:7890" or "http=...;https=..."
      const parts = raw.split(';');
      for (const part of parts) {
        const eqIdx = part.indexOf('=');
        const proto = eqIdx >= 0 ? part.slice(0, eqIdx).toLowerCase() : '';
        const addr = eqIdx >= 0 ? part.slice(eqIdx + 1) : part;
        if (proto === 'https' || proto === '') {
          return { url: addr.startsWith('http') ? addr : `http://${addr}`, source: 'registry' };
        }
      }
      // Fallback: first entry
      const first = parts[0];
      const addr = first.includes('=') ? first.split('=')[1] : first;
      return { url: addr.startsWith('http') ? addr : `http://${addr}`, source: 'registry' };
    } catch {
      return { url: null, source: 'registry' };
    }
  }

  // 3. macOS / Linux: no standard system proxy mechanism beyond env vars
  return { url: null, source: 'none' };
}

// ── Apply / Remove ───────────────────────────────────────────────

/**
 * Apply the configured proxy globally.
 *
 * - Sets process.env.HTTPS_PROXY / HTTP_PROXY so child processes inherit
 * - Calls undici.setGlobalDispatcher so server.js fetch() calls use the proxy
 *
 * Should be called at server startup and whenever proxy config changes.
 */
export function applyProxy() {
  const { enabled, url } = getProxyConfig();

  if (!enabled || !url) {
    // Remove proxy from env
    delete process.env.HTTPS_PROXY;
    delete process.env.https_proxy;
    delete process.env.HTTP_PROXY;
    delete process.env.http_proxy;

    restoreNoProxyEnvironment();
    _undici.setGlobalDispatcher(_defaultGlobalDispatcher);
    const previousDispatcher = _managedDispatcher;
    _managedDispatcher = null;
    closeManagedDispatcher(previousDispatcher);

    _appliedProxyUrl = null;
    console.log('[Proxy] Disabled — requests go direct.');
    return;
  }

  // Set env vars for child process inheritance
  process.env.HTTPS_PROXY = url;
  process.env.HTTP_PROXY = url;

  const noProxy = buildNoProxyValue(
    ORIGINAL_NO_PROXY.upper,
    ORIGINAL_NO_PROXY.lower,
    process.env.NO_PROXY,
    process.env.no_proxy,
  );
  process.env.NO_PROXY = noProxy;
  process.env.no_proxy = noProxy;

  // Set undici global dispatcher for server.js process
  try {
    const nextDispatcher = createProxyDispatcher(url, noProxy);
    _undici.setGlobalDispatcher(nextDispatcher);
    const previousDispatcher = _managedDispatcher;
    _managedDispatcher = nextDispatcher;
    closeManagedDispatcher(previousDispatcher);
    _appliedProxyUrl = url;
    console.log(`[Proxy] Global proxy active: ${url}`);
  } catch (err) {
    console.warn(`[Proxy] Failed to set undici dispatcher: ${err.message}`);
    // Still set env vars as fallback
    _appliedProxyUrl = url;
  }
}

/**
 * Returns the proxy URL currently applied (or null if none).
 */
export function getActiveProxyUrl() {
  return _appliedProxyUrl;
}

// ── Connectivity test ────────────────────────────────────────────

/**
 * Test proxy connectivity by making a request through it.
 * @param {string} testUrl - URL to fetch through the proxy
 * @returns {{ ok: boolean, statusCode: number, durationMs: number, error: string|null }}
 */
export async function testProxyConnectivity(testUrl = 'https://chatgpt.com/backend-api/codex/responses') {
  const start = Date.now();
  try {
    const resp = await fetch(testUrl, {
      method: 'GET',
      signal: AbortSignal.timeout(12000),
    });
    return {
      ok: resp.status < 500,
      statusCode: resp.status,
      durationMs: Date.now() - start,
      error: null,
    };
  } catch (err) {
    return {
      ok: false,
      statusCode: 0,
      durationMs: Date.now() - start,
      error: err.message || String(err),
      errorCode: err?.cause?.code || err?.code || null,
      phase: err?.cause?.code === 'UND_ERR_HEADERS_TIMEOUT'
        ? 'response_headers'
        : (err?.cause?.code === 'UND_ERR_CONNECT_TIMEOUT' ? 'connect' : 'request'),
    };
  }
}
