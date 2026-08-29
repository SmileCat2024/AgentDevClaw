import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, after } from 'node:test';

import { hashPassword, verifyPassword, sessionExpired, SESSION_IDLE_TTL_MS, SESSION_TTL_MS } from '../server/auth.js';

const CHILD_SOURCE = String.raw`
  process.env.AGENTDEV_DATA_DIR = process.argv[1];
  const express = (await import('express')).default;
  const { authMiddleware, registerAuthRoutes, getInternalAuthToken } = await import('./server/auth.js');
  const app = express();
  app.use(authMiddleware);
  registerAuthRoutes(app, express);
  app.get('/api/protected', (_req, res) => res.json({ ok: true }));
  const server = app.listen(0, '127.0.0.1', () => {
    process.stdout.write(JSON.stringify({ port: server.address().port, token: getInternalAuthToken() }) + String.fromCharCode(10));
  });
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
`;

function startAuthServer(dataDir) {
  const child = spawn(process.execPath, ['--input-type=module', '--eval', CHILD_SOURCE, dataDir], {
    cwd: join(import.meta.dirname, '..'),
    stdio: ['ignore', 'pipe', 'inherit'],
    windowsHide: true,
  });
  const ready = new Promise((resolve, reject) => {
    let output = '';
    const onData = (chunk) => {
      output += String(chunk);
      const match = output.match(/\{"port":\d+,"token":"[a-f0-9]+"\}/);
      if (!match) return;
      child.stdout.off('data', onData);
      resolve(JSON.parse(match[0]));
    };
    child.stdout.on('data', onData);
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code !== 0) reject(new Error(`auth test server exited with ${code}`));
    });
  });
  return { child, ready };
}

function cookieFrom(response) {
  const value = response.headers.get('set-cookie') || '';
  return value.split(';', 1)[0];
}

async function request(baseUrl, path, init = {}) {
  return fetch(`${baseUrl}${path}`, init);
}

async function waitForFile(filePath, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await access(filePath);
      return;
    } catch {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${filePath}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

describe('authentication primitives', () => {
  it('hashes and verifies passwords without storing the password', () => {
    const password = 'correct horse battery staple';
    const result = hashPassword(password);
    assert.notEqual(result.hash, password);
    assert.notEqual(result.salt, password);
    assert.equal(verifyPassword(password, result.salt, result.hash), true);
    assert.equal(verifyPassword('wrong password', result.salt, result.hash), false);
  });
});

describe('session expiry policy', () => {
  const now = 1_000_000_000_000;
  const record = { absoluteExpiresAt: now + SESSION_TTL_MS, lastActiveAt: now };

  it('keeps a fresh session valid', () => {
    assert.equal(sessionExpired(record, now), false);
  });

  it('expires a session idle for 3 days even inside the 7-day window', () => {
    assert.equal(sessionExpired({ ...record }, now + SESSION_IDLE_TTL_MS - 1), false);
    assert.equal(sessionExpired({ ...record }, now + SESSION_IDLE_TTL_MS), true);
  });

  it('extends the idle window on activity but caps at the absolute 7-day expiry', () => {
    const active = { absoluteExpiresAt: now + SESSION_TTL_MS, lastActiveAt: now + SESSION_TTL_MS - 1000 };
    assert.equal(sessionExpired(active, now + SESSION_TTL_MS - 500), false);
    assert.equal(sessionExpired(active, now + SESSION_TTL_MS), true);
  });
});

describe('authentication HTTP boundary', () => {
  let dataDir;
  let authServer;

  after(async () => {
    authServer?.child.kill('SIGTERM');
    await new Promise((resolve) => authServer?.child.once('exit', resolve));
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  it('protects control routes while preserving internal runtime access', async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'claw-auth-test-'));
    authServer = startAuthServer(dataDir);
    let { port, token } = await authServer.ready;
    let baseUrl = `http://127.0.0.1:${port}`;

    const initialStatus = await request(baseUrl, '/protoclaw/auth/status');
    assert.equal(initialStatus.status, 200);
    assert.deepEqual(await initialStatus.json(), {
      ok: true,
      enabled: false,
      configured: false,
      authenticated: true,
    });

    const setup = await request(baseUrl, '/protoclaw/auth/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true, password: 'test-password-123' }),
    });
    assert.equal(setup.status, 200);
    const sessionCookie = cookieFrom(setup);
    assert.match(sessionCookie, /^claw_session=[a-f0-9]{64}$/);
    assert.match(setup.headers.get('cache-control') || '', /no-store/);

    const unauthorized = await request(baseUrl, '/api/protected');
    assert.equal(unauthorized.status, 401);
    assert.equal((await unauthorized.json()).code, 'AUTH_REQUIRED');

    const malformedInternal = await request(baseUrl, '/api/protected', {
      headers: { authorization: 'Bearer not-the-token' },
    });
    assert.equal(malformedInternal.status, 401);

    const internal = await request(baseUrl, '/api/protected', {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(internal.status, 200);

    const status = await request(baseUrl, '/protoclaw/auth/status');
    assert.equal(status.status, 200);
    assert.equal((await status.json()).authenticated, false);

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const failedLogin = await request(baseUrl, '/protoclaw/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'wrong-password' }),
      });
      assert.equal(failedLogin.status, 401);
    }
    const rateLimited = await request(baseUrl, '/protoclaw/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'wrong-password' }),
    });
    assert.equal(rateLimited.status, 429);
    assert.ok(rateLimited.headers.get('retry-after'));

    const touched = await request(baseUrl, '/api/protected', {
      headers: { cookie: sessionCookie },
    });
    assert.equal(touched.status, 200);
    await waitForFile(join(dataDir, 'auth-sessions.json'));

    authServer.child.kill('SIGTERM');
    await new Promise((resolve) => authServer.child.once('exit', resolve));
    authServer = startAuthServer(dataDir);
    ({ port, token } = await authServer.ready);
    baseUrl = `http://127.0.0.1:${port}`;

    const survived = await request(baseUrl, '/api/protected', {
      headers: { cookie: sessionCookie },
    });
    assert.equal(survived.status, 200);

    const login = await request(baseUrl, '/protoclaw/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'test-password-123' }),
    });
    assert.equal(login.status, 200);
    const loginCookie = cookieFrom(login);
    assert.match(loginCookie, /^claw_session=[a-f0-9]{64}$/);

    const protectedResponse = await request(baseUrl, '/api/protected', {
      headers: { cookie: loginCookie },
    });
    assert.equal(protectedResponse.status, 200);

    const csrfRejected = await request(baseUrl, '/protoclaw/auth/config', {
      method: 'PUT',
      headers: {
        cookie: loginCookie,
        origin: 'https://evil.example',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(csrfRejected.status, 403);
    assert.equal((await csrfRejected.json()).code, 'CSRF_ORIGIN_REJECTED');

    const configRead = await request(baseUrl, '/protoclaw/auth/config', {
      headers: { cookie: loginCookie },
    });
    assert.equal(configRead.status, 200);
    const configBody = await configRead.json();
    assert.equal(configBody.configured, true);
    assert.equal('passwordHash' in configBody, false);
    assert.equal('serviceToken' in configBody, false);

    const disable = await request(baseUrl, '/protoclaw/auth/config', {
      method: 'PUT',
      headers: {
        cookie: loginCookie,
        origin: `http://127.0.0.1:${port}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(disable.status, 200);
    assert.equal((await disable.json()).enabled, false);
  });
});
