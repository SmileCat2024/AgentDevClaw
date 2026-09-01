import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createConnectionHealth, versionMismatch } from '../server/remote-connections/connection-health.js';
import { createRemoteAuthSessions, REMOTE_SESSION_COOKIE } from '../server/remote-connections/remote-auth.js';
import {
  REMOTE_HANDSHAKE_INTERVAL_MS,
  REMOTE_HANDSHAKE_TIMEOUT_MS,
} from '../server/shared/constants.js';

const LOCAL_APP_INFO = { clawVersion: '0.2.0', frameworkVersion: '0.1.0' };
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
    ...overrides,
  };
}

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function networkFailure(code) {
  return () => {
    const error = new TypeError('fetch failed');
    error.cause = { code, errno: -111, syscall: 'connect' };
    throw error;
  };
}

function hangingHandler() {
  return (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('The operation was aborted')));
  });
}

function healthyRoutes(overrides = {}) {
  const routes = {
    '/protoclaw/health': () => jsonResponse({ ok: true, appPort: 1420, viewerPort: 2026 }),
    '/protoclaw/app_info': () => jsonResponse({
      ok: true,
      name: 'AgentDevClaw',
      version: '0.2.0',
      framework: { name: '@agentdevjs/core', version: '0.1.0' },
    }),
    '/api/agents': () => jsonResponse({ agents: [{ id: 'runtime-1' }] }),
    ...overrides,
  };
  return (url, options) => {
    const handler = routes[url.pathname];
    if (!handler) throw new Error(`unexpected path: ${url.pathname}`);
    return handler(url, options);
  };
}

const instances = [];
afterEach(() => {
  for (const health of instances) health.stop();
  instances.length = 0;
});

function createHarness({
  connections = [connection()],
  handler = healthyRoutes(),
  localAppInfo = LOCAL_APP_INFO,
  tunnelManager = null,
  authSessions = null,
  intervalMs = 60000,
  timeoutMs = 200,
} = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url) });
    return handler(new URL(String(url)), options);
  };
  const health = createConnectionHealth({
    fetch: fetchImpl,
    tunnelManager,
    authSessions,
    localAppInfo,
    intervalMs,
    timeoutMs,
    logger: silentLogger,
  });
  health.syncConnections(connections);
  instances.push(health);
  return { health, calls, fetchImpl };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function waitFor(predicate, timeoutMs = 500, stepMs = 5) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor 超时');
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

describe('three-step handshake and appInfo cache', () => {
  it('walks health → app_info → agents in order and caches appInfo', async () => {
    const { health, calls } = createHarness();

    const status = await health.runHandshake('server-a');

    assert.deepEqual(calls.map((call) => new URL(call.url).pathname), [
      '/protoclaw/health', '/protoclaw/app_info', '/api/agents',
    ]);
    assert.equal(status.state, 'connected');
    assert.equal(status.error, null);
    assert.equal(status.versionWarning, null);
    assert.deepEqual(status.appInfo, {
      name: 'AgentDevClaw',
      clawVersion: '0.2.0',
      frameworkVersion: '0.1.0',
      // Legacy app_info without capabilities → all bits default to false (ADR-0011).
      capabilities: { write: false, sessionOps: false, workspaceCreate: false },
      checkedAt: status.appInfo.checkedAt,
    });
    assert.ok(status.lastConnectedAt);
    assert.equal(status.lastHandshakeAt, status.lastConnectedAt);
  });

  it('passes through the full capability set advertised by the remote app_info', async () => {
    const { health } = createHarness({
      handler: healthyRoutes({
        '/protoclaw/app_info': () => jsonResponse({
          ok: true,
          name: 'AgentDevClaw',
          version: '0.2.0',
          framework: { name: '@agentdevjs/core', version: '0.1.0' },
          capabilities: { write: true, sessionOps: true, workspaceCreate: true },
        }),
      }),
    });

    const status = await health.runHandshake('server-a');

    // 回归钉：能力位在握手消费层逐位透传（2026-08-31 曾被过滤为 write 单位，
    // 远程叶子右键菜单 / 远程新对话按钮随门控整体消失）。未知位不透传。
    assert.deepEqual(status.appInfo.capabilities, {
      write: true,
      sessionOps: true,
      workspaceCreate: true,
    });
  });

  it('starts in configured and shows connecting while the handshake is pending', async () => {
    const gates = {
      health: deferred(),
      appInfo: deferred(),
      agents: deferred(),
    };
    const { health } = createHarness({
      handler: (url) => {
        if (url.pathname === '/protoclaw/health') return gates.health.promise;
        if (url.pathname === '/protoclaw/app_info') return gates.appInfo.promise;
        return gates.agents.promise;
      },
    });

    assert.equal(health.getStatus('server-a').state, 'configured');
    const pending = health.runHandshake('server-a');
    assert.equal(health.getStatus('server-a').state, 'connecting');

    gates.health.resolve(jsonResponse({ ok: true }));
    await tick();
    assert.equal(health.getStatus('server-a').state, 'connecting');

    gates.appInfo.resolve(jsonResponse({
      ok: true, name: 'AgentDevClaw', version: '0.2.0', framework: { version: '0.1.0' },
    }));
    await tick();
    assert.equal(health.getStatus('server-a').state, 'connecting');

    gates.agents.resolve(jsonResponse({ agents: [] }));
    assert.equal((await pending).state, 'connected');
  });

  it('returns null for unknown connections', async () => {
    const { health } = createHarness();
    assert.equal(health.getStatus('nope'), null);
    assert.equal(await health.runHandshake('nope'), null);
  });
});

describe('failure classification against the phase 0 error contract', () => {
  it('maps refused local port to transport_unavailable / disconnected (retryable)', async () => {
    const { health } = createHarness({
      handler: healthyRoutes({ '/protoclaw/health': networkFailure('ECONNREFUSED') }),
    });

    const status = await health.runHandshake('server-a');

    assert.equal(status.state, 'disconnected');
    assert.equal(status.error.code, 'transport_unavailable');
    assert.equal(status.error.retryable, true);
    assert.equal(status.error.step, 'health');
    assert.equal(status.appInfo, null);
  });

  it('maps tunnel-up network errors to target_not_found / degraded (remote Claw not running)', async () => {
    const { health } = createHarness({
      connections: [connection({ mode: 'managed', ssh: { host: 'dev.example.com', user: 'ubuntu', port: 22, hostAlias: null } })],
      tunnelManager: { getStatus: () => ({ tunnel: 'up' }) },
      handler: healthyRoutes({ '/protoclaw/health': networkFailure('ECONNRESET') }),
    });

    const status = await health.runHandshake('server-a');

    assert.equal(status.state, 'degraded');
    assert.equal(status.error.code, 'target_not_found');
    assert.equal(status.error.retryable, false);
    assert.ok(status.error.message.includes('ECONNRESET'));
  });

  it('maps tunnel-down network errors to transport_unavailable / disconnected', async () => {
    const { health } = createHarness({
      connections: [connection({ mode: 'managed', ssh: { host: 'dev.example.com', user: 'ubuntu', port: 22, hostAlias: null } })],
      tunnelManager: { getStatus: () => ({ tunnel: 'down' }) },
      handler: healthyRoutes({ '/protoclaw/health': networkFailure('ECONNRESET') }),
    });

    const status = await health.runHandshake('server-a');

    assert.equal(status.state, 'disconnected');
    assert.equal(status.error.code, 'transport_unavailable');
  });

  it('maps an HTTP-failing health endpoint to target_not_found / degraded', async () => {
    const { health } = createHarness({
      handler: healthyRoutes({ '/protoclaw/health': () => jsonResponse({ ok: false }, 503) }),
    });

    const status = await health.runHandshake('server-a');

    assert.equal(status.state, 'degraded');
    assert.equal(status.error.code, 'target_not_found');
    assert.equal(status.error.retryable, false);
  });

  it('maps handshake timeouts to request_timeout / degraded', async () => {
    const startedAt = Date.now();
    const { health } = createHarness({
      handler: healthyRoutes({ '/protoclaw/health': hangingHandler() }),
      timeoutMs: 30,
    });

    const status = await health.runHandshake('server-a');

    assert.equal(status.state, 'degraded');
    assert.equal(status.error.code, 'request_timeout');
    assert.equal(status.error.retryable, true);
    assert.ok(Date.now() - startedAt < 500);
  });

  it('maps protocol failures after health to operation_rejected / degraded', async () => {
    const appInfoFailure = createHarness({
      handler: healthyRoutes({ '/protoclaw/app_info': () => jsonResponse({ ok: false }, 500) }),
    });
    const appInfoStatus = await appInfoFailure.health.runHandshake('server-a');
    assert.equal(appInfoStatus.state, 'degraded');
    assert.equal(appInfoStatus.error.code, 'operation_rejected');
    assert.equal(appInfoStatus.error.step, 'app_info');

    const agentsFailure = createHarness({
      handler: healthyRoutes({ '/api/agents': () => jsonResponse({ agents: null }, 500) }),
    });
    const agentsStatus = await agentsFailure.health.runHandshake('server-a');
    assert.equal(agentsStatus.state, 'degraded');
    assert.equal(agentsStatus.error.code, 'operation_rejected');
    assert.equal(agentsStatus.error.step, 'agents');
  });

  it('classifies non-refused errors behind a manual tunnel as target_not_found', async () => {
    const { health } = createHarness({
      handler: healthyRoutes({ '/protoclaw/health': networkFailure('ECONNRESET') }),
    });

    const status = await health.runHandshake('server-a');

    assert.equal(status.state, 'degraded');
    assert.equal(status.error.code, 'target_not_found');
  });

  it('hints at the access password when the protected remote rejects the handshake (401)', async () => {
    const { health } = createHarness({
      connections: [connection({ auth: null })],
      handler: healthyRoutes({
        '/protoclaw/health': () => jsonResponse({ ok: false, code: 'AUTH_REQUIRED' }, 401),
      }),
    });

    const status = await health.runHandshake('server-a');

    assert.equal(status.state, 'degraded');
    assert.match(status.error.message, /访问密码/);
  });

  it('completes the handshake with credentials when the remote requires login', async () => {
    const seenCookies = [];
    const handler = (url, options) => {
      if (url.pathname === '/protoclaw/auth/login') {
        return {
          ok: true,
          status: 200,
          headers: new Headers([['Set-Cookie', `${REMOTE_SESSION_COOKIE}=token-7; Path=/`]]),
          json: async () => ({ ok: true, authenticated: true }),
        };
      }
      seenCookies.push(options.headers.get('Cookie'));
      return healthyRoutes()(url, options);
    };
    const fetchImpl = async (url, options) => handler(new URL(String(url)), options);
    const authSessions = createRemoteAuthSessions({ fetch: fetchImpl, logger: silentLogger });
    const { health } = createHarness({
      connections: [connection({ auth: { password: 'hunter2' } })],
      handler,
      authSessions,
    });

    const status = await health.runHandshake('server-a');

    assert.equal(status.state, 'connected');
    assert.deepEqual(seenCookies, [
      `${REMOTE_SESSION_COOKIE}=token-7`,
      `${REMOTE_SESSION_COOKIE}=token-7`,
      `${REMOTE_SESSION_COOKIE}=token-7`,
    ]);
  });

  it('surfaces auth failures as a degraded state with an actionable message', async () => {
    const fetchImpl = async (url) => {
      if (new URL(String(url)).pathname === '/protoclaw/auth/login') {
        return jsonResponse({ ok: false, code: 'AUTH_INVALID_CREDENTIALS' }, 401);
      }
      return healthyRoutes()(new URL(String(url)));
    };
    const authSessions = createRemoteAuthSessions({ fetch: fetchImpl, logger: silentLogger });
    const { health } = createHarness({
      connections: [connection({ auth: { password: 'wrong' } })],
      handler: healthyRoutes({
        '/protoclaw/health': () => {
          throw new Error('handshake must fail at login before reaching health');
        },
      }),
      authSessions,
    });

    const status = await health.runHandshake('server-a');

    assert.equal(status.state, 'degraded');
    assert.equal(status.error.code, 'operation_rejected');
    assert.match(status.error.message, /密码/);
  });
});

describe('recovery requires a full re-handshake', () => {
  it('recovers disconnected → reconnecting → connecting → connected without stale state', async () => {
    let refused = true;
    const gates = { health: deferred(), appInfo: deferred(), agents: deferred() };
    const { health, calls } = createHarness({
      handler: (url) => {
        if (url.pathname === '/protoclaw/health') {
          return refused ? networkFailure('ECONNREFUSED')() : gates.health.promise;
        }
        if (url.pathname === '/protoclaw/app_info') return gates.appInfo.promise;
        return gates.agents.promise;
      },
    });

    const failed = await health.runHandshake('server-a');
    assert.equal(failed.state, 'disconnected');
    assert.equal(failed.error.code, 'transport_unavailable');

    refused = false;
    const pending = health.runHandshake('server-a');
    assert.equal(health.getStatus('server-a').state, 'reconnecting');
    gates.health.resolve(jsonResponse({ ok: true }));
    await tick();
    assert.equal(health.getStatus('server-a').state, 'connecting');
    gates.appInfo.resolve(jsonResponse({
      ok: true, name: 'AgentDevClaw', version: '0.2.0', framework: { version: '0.1.0' },
    }));
    gates.agents.resolve(jsonResponse({ agents: [] }));
    const recovered = await pending;

    assert.equal(recovered.state, 'connected');
    assert.equal(recovered.error, null);
    assert.equal(recovered.appInfo.clawVersion, '0.2.0');
    assert.ok(recovered.lastConnectedAt >= failed.lastHandshakeAt);
    // 第一轮在 health 即被拒（1 次）+ 第二轮完整三步（3 次）= 恢复重走了全部握手。
    assert.equal(calls.length, 4);
  });

  it('recovers degraded connections through a full re-handshake', async () => {
    let healthBroken = true;
    const { health, calls } = createHarness({
      handler: (url) => {
        if (url.pathname === '/protoclaw/health' && healthBroken) return jsonResponse({ ok: false }, 503);
        return healthyRoutes()(url);
      },
    });

    const degraded = await health.runHandshake('server-a');
    assert.equal(degraded.state, 'degraded');

    healthBroken = false;
    const recovered = await health.runHandshake('server-a');

    assert.equal(recovered.state, 'connected');
    assert.equal(recovered.error, null);
    assert.equal(calls.filter((call) => new URL(call.url).pathname === '/protoclaw/health').length, 2);
    // 第一轮在 health 即失败（1 次），第二轮完整三步（3 次）。
    assert.equal(calls.length, 4);
  });
});

describe('version gate', () => {
  it('warns on minor-version drift but keeps the connection usable', async () => {
    const { health } = createHarness({
      handler: healthyRoutes({
        '/protoclaw/app_info': () => jsonResponse({
          ok: true, name: 'AgentDevClaw', version: '0.3.1', framework: { version: '0.1.0' },
        }),
      }),
    });

    const status = await health.runHandshake('server-a');

    assert.equal(status.state, 'connected');
    assert.equal(status.error, null);
    assert.deepEqual(status.versionWarning.claw, { local: '0.2.0', remote: '0.3.1' });
    assert.equal(status.versionWarning.framework, undefined);
  });

  it('warns on framework version drift independently', async () => {
    const { health } = createHarness({
      handler: healthyRoutes({
        '/protoclaw/app_info': () => jsonResponse({
          ok: true, name: 'AgentDevClaw', version: '0.2.0', framework: { version: '0.9.0' },
        }),
      }),
    });

    const status = await health.runHandshake('server-a');

    assert.equal(status.state, 'connected');
    assert.equal(status.versionWarning.claw, undefined);
    assert.deepEqual(status.versionWarning.framework, { local: '0.1.0', remote: '0.9.0' });
  });

  it('does not warn on patch-only differences or missing versions', async () => {
    const { health } = createHarness({
      handler: healthyRoutes({
        '/protoclaw/app_info': () => jsonResponse({
          ok: true, name: 'AgentDevClaw', version: '0.2.9', framework: { version: '0.1.3' },
        }),
      }),
    });
    const status = await health.runHandshake('server-a');
    assert.equal(status.versionWarning, null);

    const missing = createHarness({
      handler: healthyRoutes({
        '/protoclaw/app_info': () => jsonResponse({ ok: true, name: 'AgentDevClaw' }),
      }),
    });
    const missingStatus = await missing.health.runHandshake('server-a');
    assert.equal(missingStatus.state, 'connected');
    assert.equal(missingStatus.versionWarning, null);
  });

  it('clears the warning once versions line up again', async () => {
    let drifted = true;
    const { health } = createHarness({
      handler: (url) => {
        if (url.pathname !== '/protoclaw/app_info') return healthyRoutes()(url);
        return jsonResponse({
          ok: true,
          name: 'AgentDevClaw',
          version: drifted ? '1.0.0' : '0.2.4',
          framework: { version: '0.1.0' },
        });
      },
    });

    const warned = await health.runHandshake('server-a');
    assert.ok(warned.versionWarning);

    drifted = false;
    const cleared = await health.runHandshake('server-a');
    assert.equal(cleared.versionWarning, null);
    assert.equal(cleared.state, 'connected');
  });

  it('versionMismatch only flags major/minor drift', () => {
    assert.equal(versionMismatch('0.2.0', '0.2.9'), null);
    assert.equal(versionMismatch('v0.2.0', '0.2.0'), null);
    assert.equal(versionMismatch('0.2.0', null), null);
    assert.equal(versionMismatch('unknown', '0.2.0'), null);
    assert.deepEqual(versionMismatch('0.2.0', '0.3.1'), { local: '0.2.0', remote: '0.3.1' });
    assert.deepEqual(versionMismatch('1.2.0', '0.2.0'), { local: '1.2.0', remote: '0.2.0' });
  });
});

describe('per-connection isolation and connection sync', () => {
  it('keeps one failing connection from affecting another', async () => {
    const handler = (url) => {
      if (url.port === '22101') return networkFailure('ECONNREFUSED')();
      return healthyRoutes()(url);
    };
    const { health, calls } = createHarness({
      connections: [connection(), connection({ id: 'server-b', name: '备份服务器', localPort: 22102 })],
      handler,
    });

    const failed = await health.runHandshake('server-a');
    const healthy = await health.runHandshake('server-b');

    assert.equal(failed.state, 'disconnected');
    assert.equal(healthy.state, 'connected');
    assert.equal(healthy.error, null);
    assert.equal(health.listStatuses().length, 2);
    assert.equal(calls.length, 4);
  });

  it('drops removed or disabled connections from tracking', () => {
    const { health } = createHarness({
      connections: [connection(), connection({ id: 'server-b', localPort: 22102 })],
    });

    health.syncConnections([connection({ id: 'server-b', localPort: 22102 })]);
    assert.equal(health.getStatus('server-a'), null);
    assert.equal(health.listStatuses().length, 1);

    health.syncConnections([connection({ id: 'server-b', localPort: 22102, enabled: false })]);
    assert.equal(health.getStatus('server-b'), null);
    assert.equal(health.listStatuses().length, 0);
  });

  it('resets state when the connection addressing changes', async () => {
    const { health } = createHarness();
    await health.runHandshake('server-a');
    assert.equal(health.getStatus('server-a').state, 'connected');

    health.syncConnections([connection({ localPort: 22105 })]);

    const status = health.getStatus('server-a');
    assert.equal(status.state, 'configured');
    assert.equal(status.appInfo, null);
    assert.equal(status.error, null);
    assert.equal(status.localPort, 22105);
  });
});

describe('url direct mode', () => {
  const urlConnection = {
    id: 'server-url',
    name: '直连服务器',
    enabled: true,
    mode: 'url',
    localPort: null,
    baseUrl: 'https://claw.example.com',
    ssh: null,
    remote: null,
  };

  it('handshakes directly against the remote origin without a local port', async () => {
    const { health, calls } = createHarness({ connections: [urlConnection] });

    const status = await health.runHandshake('server-url');

    assert.equal(status.state, 'connected');
    assert.equal(status.origin, 'https://claw.example.com');
    assert.deepEqual(calls.map((call) => call.url), [
      'https://claw.example.com/protoclaw/health',
      'https://claw.example.com/protoclaw/app_info',
      'https://claw.example.com/api/agents',
    ]);
  });

  it('classifies every network error as transport unavailable (no tunnel to blame)', async () => {
    const { health } = createHarness({
      connections: [urlConnection],
      handler: healthyRoutes({ '/protoclaw/health': networkFailure('ENOTFOUND') }),
    });

    const status = await health.runHandshake('server-url');

    assert.equal(status.state, 'disconnected');
    assert.equal(status.error.code, 'transport_unavailable');
    assert.equal(status.error.retryable, true);
  });

  it('resets state when the baseUrl changes', async () => {
    const { health } = createHarness({ connections: [urlConnection] });
    await health.runHandshake('server-url');
    assert.equal(health.getStatus('server-url').state, 'connected');

    health.syncConnections([{ ...urlConnection, baseUrl: 'https://moved.example.com' }]);

    const status = health.getStatus('server-url');
    assert.equal(status.state, 'configured');
    assert.equal(status.appInfo, null);
    assert.equal(status.origin, 'https://moved.example.com');
  });
});

describe('periodic probing lifecycle', () => {
  it('probes on start, recovers automatically, and stops cleanly', async () => {
    let phase = 'down';
    const { health, calls } = createHarness({
      handler: (url) => {
        if (url.pathname === '/protoclaw/health' && phase === 'down') return networkFailure('ECONNREFUSED')();
        return healthyRoutes()(url);
      },
      intervalMs: 15,
      timeoutMs: 50,
    });

    health.start();
    await waitFor(() => calls.length >= 3);
    assert.equal(health.getStatus('server-a').state, 'disconnected');

    phase = 'up';
    await waitFor(() => health.getStatus('server-a').state === 'connected');

    health.stop();
    const count = calls.length;
    await new Promise((resolve) => setTimeout(resolve, 45));
    assert.equal(calls.length, count);
    assert.equal(health.getStatus('server-a').state, 'connected');
  });

  it('schedules the first probe immediately after start', async () => {
    const { health, calls } = createHarness({ intervalMs: 60000 });
    assert.equal(calls.length, 0);

    health.start();
    await waitFor(() => calls.length >= 3);
    assert.equal(health.getStatus('server-a').state, 'connected');
  });

  it('keeps default constants inside the 10s convergence budget', () => {
    assert.ok(REMOTE_HANDSHAKE_INTERVAL_MS > 0);
    assert.ok(REMOTE_HANDSHAKE_TIMEOUT_MS > 0);
    assert.ok(REMOTE_HANDSHAKE_INTERVAL_MS + REMOTE_HANDSHAKE_TIMEOUT_MS < 10000);
  });
});

// ── 慢断快收（REMOTE_CONNECTION_FAILURE_THRESHOLD）────────────────────────
// connected 态下的可重试失败（传输断 / 超时）是网络抖动噪声的高发形态，
// 单次不置位；连续达阈值才呈现断线。确定性失败（远端明确拒绝）与从未
// 连通过的首轮探测无闪烁问题，保持立即置位。

describe('slow-break fast-recover failure hysteresis', () => {
  function phaseHarness(getPhase) {
    const healthy = healthyRoutes();
    return createHarness({
      handler: (url, options) => {
        const phase = getPhase();
        if (phase === 'refused') return networkFailure('ECONNREFUSED')();
        if (phase === 'health500') {
          if (url.pathname === '/protoclaw/health') return jsonResponse({ ok: false }, 500);
          return healthy(url, options);
        }
        return healthy(url, options);
      },
    });
  }

  it('a single retryable failure keeps connected with the error recorded', async () => {
    let phase = 'healthy';
    const { health } = phaseHarness(() => phase);
    assert.equal((await health.runHandshake('server-a')).state, 'connected');

    phase = 'refused';
    const status = await health.runHandshake('server-a');

    assert.equal(status.state, 'connected', 'single retryable failure must not flip the state');
    assert.equal(status.error.code, 'transport_unavailable');
    assert.ok(status.appInfo, 'connected presentation keeps appInfo (capabilities intact)');
  });

  it('consecutive retryable failures reach the threshold and disconnect', async () => {
    let phase = 'healthy';
    const { health } = phaseHarness(() => phase);
    await health.runHandshake('server-a');

    phase = 'refused';
    await health.runHandshake('server-a');
    assert.equal(health.getStatus('server-a').state, 'connected');

    const status = await health.runHandshake('server-a');
    assert.equal(status.state, 'disconnected');
    assert.equal(status.error.code, 'transport_unavailable');
  });

  it('a successful handshake resets the failure counter', async () => {
    let phase = 'healthy';
    const { health } = phaseHarness(() => phase);
    await health.runHandshake('server-a');

    phase = 'refused';
    await health.runHandshake('server-a');
    phase = 'healthy';
    assert.equal((await health.runHandshake('server-a')).state, 'connected');

    phase = 'refused';
    const status = await health.runHandshake('server-a');
    assert.equal(status.state, 'connected', 'counter restarted from zero after recovery');
  });

  it('a definitive failure (target rejected) transitions immediately without hysteresis', async () => {
    let phase = 'healthy';
    const { health } = phaseHarness(() => phase);
    await health.runHandshake('server-a');

    phase = 'health500';
    const status = await health.runHandshake('server-a');

    assert.equal(status.state, 'degraded', 'non-retryable failures are facts, not noise');
    assert.equal(status.error.retryable, false);
  });

  it('the very first probe cycle has no hysteresis (never was connected)', async () => {
    const { health } = createHarness({
      handler: networkFailure('ECONNREFUSED'),
    });

    const status = await health.runHandshake('server-a');

    assert.equal(status.state, 'disconnected', 'initial connect failures surface immediately');
  });
});
