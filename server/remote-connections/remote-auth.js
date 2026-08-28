import { REMOTE_HANDSHAKE_TIMEOUT_MS } from '../shared/constants.js';
import { createClawLogger } from '../shared/claw-logger.js';

// 远程实例开启单密码访问保护（server/auth.js）时，握手与转发请求必须携带
// 凭据才能通过 /protoclaw 与 /api 的认证。本模块按连接管理登录会话：
// 用连接配置里的 auth.password 向远程 /protoclaw/auth/login 换取
// claw_session cookie，为该连接的出站请求统一附加；cookie 失效（远程重启 /
// 过期）时自动重登录一次。未配置密码的连接直通，行为与从前完全一致。

export const REMOTE_SESSION_COOKIE = 'claw_session';

export class RemoteAuthError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RemoteAuthError';
    this.code = code;
  }
}

function extractSessionCookie(response) {
  const rawCookies = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean);
  for (const raw of rawCookies) {
    const pair = String(raw).split(';', 1)[0];
    const separator = pair.indexOf('=');
    if (separator <= 0) continue;
    if (pair.slice(0, separator).trim() === REMOTE_SESSION_COOKIE) {
      return pair;
    }
  }
  return null;
}

export class RemoteAuthSessions {
  constructor({
    fetch: fetchImpl = globalThis.fetch?.bind(globalThis),
    timeoutMs = REMOTE_HANDSHAKE_TIMEOUT_MS,
    logger = createClawLogger('remote-auth'),
  } = {}) {
    if (typeof fetchImpl !== 'function') {
      throw new TypeError('RemoteAuthSessions 需要可用的 fetch 实现');
    }
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.logger = logger;
    // connectionId → { kind: 'cookie', value } | { kind: 'error', error }
    // error 形态是失败缓存：密码错误时不再重复登录，避免触发远程登录限流；
    // 由 forget()（配置变更 / 密码失效重试）显式清除。
    this.sessions = new Map();
    this.pending = new Map();
  }

  forget(connectionId) {
    this.sessions.delete(connectionId);
    this.pending.delete(connectionId);
  }

  async login(connection, origin) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetch(`${origin}/protoclaw/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ password: connection.auth.password }),
        signal: controller.signal,
      });
      if (response.status === 401) {
        throw new RemoteAuthError('auth_invalid_credentials', '远程访问密码不正确或已更改');
      }
      if (response.status === 429) {
        throw new RemoteAuthError('auth_rate_limited', '远程登录尝试过于频繁，请稍后重试');
      }
      if (!response?.ok) {
        throw new RemoteAuthError('auth_login_failed', `远程登录返回 HTTP ${response?.status}`);
      }
      const cookie = extractSessionCookie(response);
      if (!cookie) {
        throw new RemoteAuthError('auth_login_failed', '远程登录成功但未返回会话 cookie');
      }
      return cookie;
    } catch (error) {
      if (error instanceof RemoteAuthError) throw error;
      throw new RemoteAuthError('auth_login_failed', `远程登录失败：${error?.message || String(error)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  async ensureSession(connection, origin) {
    const cached = this.sessions.get(connection.id);
    if (cached) {
      if (cached.kind === 'error') throw cached.error;
      return cached.value;
    }
    const inflight = this.pending.get(connection.id);
    if (inflight) return inflight;
    const promise = this.login(connection, origin)
      .then((cookie) => {
        this.sessions.set(connection.id, { kind: 'cookie', value: cookie });
        return cookie;
      })
      .catch((error) => {
        const failure = error instanceof RemoteAuthError
          ? error
          : new RemoteAuthError('auth_login_failed', `远程登录失败：${error?.message || String(error)}`);
        this.sessions.set(connection.id, { kind: 'error', error: failure });
        this.logger.warn(`远程连接 ${connection.id} 认证失败`, { code: failure.code, message: failure.message });
        throw failure;
      })
      .finally(() => {
        this.pending.delete(connection.id);
      });
    this.pending.set(connection.id, promise);
    return promise;
  }

  /**
   * 为远程请求附加认证凭据并发送。连接未配置密码时直通（不登录、不改头）。
   * 配置了密码时：覆盖 Cookie 为远程会话（丢弃调用方转发的本地 claw_session，
   * 凭据不跨实例泄漏）；cookie 失效收到 401 时重登录并重试一次。写请求需要
   * 补 Origin 头——远程对 session 身份的非 GET 请求做 same-origin 检查
   * （server/auth.js），服务端转发方持有的凭据即通往该目标，声明为请求源。
   */
  async fetchWithAuth(connection, url, init = {}) {
    if (!connection?.auth?.password) return this.fetch(url, init);
    const origin = new URL(url).origin;
    const send = async () => {
      const cookie = await this.ensureSession(connection, origin);
      const headers = new Headers(init.headers || undefined);
      headers.set('Cookie', cookie);
      if (init.method && !['GET', 'HEAD', 'OPTIONS'].includes(init.method.toUpperCase())) {
        headers.set('Origin', origin);
      }
      return this.fetch(url, { ...init, headers });
    };
    let response = await send();
    if (response.status !== 401) return response;
    this.forget(connection.id);
    response = await send();
    return response;
  }
}

export function createRemoteAuthSessions(options = {}) {
  return new RemoteAuthSessions(options);
}
