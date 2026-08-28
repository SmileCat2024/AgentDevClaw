/**
 * Tests for server/remote-connections/remote-auth.js
 *
 * Covers: pass-through for connections without credentials, login and
 * session-cookie attachment, 401 → re-login → single retry, failure
 * caching for wrong passwords (protects the remote's login rate limit),
 * Origin header injection for forwarded writes.
 *
 * All I/O goes through an injected fetch — no real network.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createRemoteAuthSessions,
  RemoteAuthError,
  REMOTE_SESSION_COOKIE,
} from '../server/remote-connections/remote-auth.js';

const silentLogger = { trace() {}, debug() {}, info() {}, warn() {}, error() {} };

function connection(overrides = {}) {
  return {
    id: 'server-a',
    name: '开发服务器',
    enabled: true,
    mode: 'manual',
    localPort: 22101,
    ssh: null,
    remote: { appPort: 1420 },
    auth: { password: 'hunter2' },
    ...overrides,
  };
}

function responseWithSetCookie(body, status = 200) {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  headers.append('Set-Cookie', `${REMOTE_SESSION_COOKIE}=session-token-1; HttpOnly; Path=/; Max-Age=604800`);
  return { ok: status >= 200 && status < 300, status, headers, json: async () => body };
}

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, headers: new Headers(), json: async () => body };
}

function createSessions({ connection: conn = connection(), loginResponse = null, handler = null } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const request = { url: String(url), init };
    calls.push(request);
    if (handler) return handler(request, calls);
    const parsed = new URL(String(url));
    if (parsed.pathname === '/protoclaw/auth/login') {
      return loginResponse || responseWithSetCookie({ ok: true, authenticated: true });
    }
    return jsonResponse({ ok: true });
  };
  const sessions = createRemoteAuthSessions({ fetch: fetchImpl, timeoutMs: 200, logger: silentLogger });
  return { sessions, calls };
}

describe('remote auth sessions', () => {
  it('passes through untouched for connections without credentials', async () => {
    const { sessions, calls } = createSessions({ connection: connection({ auth: null }) });

    const response = await sessions.fetchWithAuth(
      connection({ auth: null }),
      'http://127.0.0.1:22101/protoclaw/health',
      { headers: { Accept: 'application/json' } },
    );

    assert.equal(response.ok, true);
    assert.equal(calls.length, 1, 'no login round-trip should happen');
    assert.equal(new URL(calls[0].url).pathname, '/protoclaw/health');
    assert.equal(calls[0].init.headers.Cookie, undefined, 'no cookie without credentials');
  });

  it('logs in once and attaches the session cookie to requests', async () => {
    const { sessions, calls } = createSessions();

    await sessions.fetchWithAuth(connection(), 'http://127.0.0.1:22101/protoclaw/health');
    await sessions.fetchWithAuth(connection(), 'http://127.0.0.1:22101/protoclaw/app_info');

    const loginCalls = calls.filter((call) => new URL(call.url).pathname === '/protoclaw/auth/login');
    assert.equal(loginCalls.length, 1, 'the session is reused across requests');
    assert.deepEqual(JSON.parse(loginCalls[0].init.body), { password: 'hunter2' });
    for (const call of calls.filter((call) => new URL(call.url).pathname !== '/protoclaw/auth/login')) {
      assert.equal(call.init.headers.get('Cookie'), `${REMOTE_SESSION_COOKIE}=session-token-1`);
    }
  });

  it('re-logins and retries exactly once when the session expires (401)', async () => {
    let handshakeRequests = 0;
    const { sessions, calls } = createSessions({
      handler: (request) => {
        const { pathname } = new URL(request.url);
        if (pathname === '/protoclaw/auth/login') return responseWithSetCookie({ ok: true });
        // 会话在远程侧被清空（重启 / 过期）：第一次请求 401，重试后放行。
        handshakeRequests += 1;
        return handshakeRequests === 1 ? jsonResponse({ ok: false }, 401) : jsonResponse({ ok: true });
      },
    });

    const response = await sessions.fetchWithAuth(connection(), 'http://127.0.0.1:22101/protoclaw/health');

    assert.equal(response.status, 200);
    const logins = calls.filter((call) => new URL(call.url).pathname === '/protoclaw/auth/login');
    assert.equal(logins.length, 2, 'initial login + one re-login after the 401');
    assert.equal(handshakeRequests, 2, 'exactly one retry — no loop');
  });

  it('caches wrong-password failures instead of hammering the login endpoint', async () => {
    const { sessions, calls } = createSessions({
      loginResponse: jsonResponse({ ok: false, code: 'AUTH_INVALID_CREDENTIALS' }, 401),
    });

    await assert.rejects(
      () => sessions.fetchWithAuth(connection(), 'http://127.0.0.1:22101/protoclaw/health'),
      (error) => {
        assert.ok(error instanceof RemoteAuthError);
        assert.equal(error.code, 'auth_invalid_credentials');
        assert.match(error.message, /密码/);
        return true;
      },
    );
    // 周期握手会反复调用；失败缓存必须拦住重复登录（远程 15 分钟窗口内
    // 限流 10 次）。
    await assert.rejects(
      () => sessions.fetchWithAuth(connection(), 'http://127.0.0.1:22101/protoclaw/health'),
      RemoteAuthError,
    );
    assert.equal(
      calls.filter((call) => new URL(call.url).pathname === '/protoclaw/auth/login').length,
      1,
    );

    // 配置变更（用户改密码）后 forget 清除失败缓存，新密码立即生效。
    sessions.forget(connection().id);
    await assert.rejects(
      () => sessions.fetchWithAuth(connection(), 'http://127.0.0.1:22101/protoclaw/health'),
      RemoteAuthError,
    );
    assert.equal(
      calls.filter((call) => new URL(call.url).pathname === '/protoclaw/auth/login').length,
      2,
    );
  });

  it('maps login rate limiting to an explicit retryable-later error', async () => {
    const { sessions } = createSessions({
      loginResponse: jsonResponse({ ok: false, code: 'AUTH_RATE_LIMITED' }, 429),
    });

    await assert.rejects(
      () => sessions.fetchWithAuth(connection(), 'http://127.0.0.1:22101/protoclaw/health'),
      (error) => {
        assert.equal(error.code, 'auth_rate_limited');
        assert.match(error.message, /频繁|稍后/);
        return true;
      },
    );
  });

  it('sets the Origin header to the remote origin for forwarded writes only', async () => {
    const { sessions, calls } = createSessions();

    await sessions.fetchWithAuth(connection(), 'http://127.0.0.1:22101/api/agents/rt-1/input', {
      method: 'POST',
      headers: { Origin: 'http://localhost:1420' },
      body: '{}',
    });
    await sessions.fetchWithAuth(connection(), 'http://127.0.0.1:22101/api/agents/rt-1/messages');

    const write = calls.find((call) => new URL(call.url).pathname.endsWith('/input'));
    const read = calls.find((call) => new URL(call.url).pathname.endsWith('/messages'));
    assert.equal(write.init.headers.get('Origin'), 'http://127.0.0.1:22101');
    assert.equal(read.init.headers.get('Origin'), null);
  });
});
