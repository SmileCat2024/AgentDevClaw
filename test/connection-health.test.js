import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createConnectionHealth, versionMismatch } from '../server/remote-connections/connection-health.js';
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
    localAppInfo,
    intervalMs,
    timeoutMs,
    logger: silentLogger,
  });
  health.syncConnections(connections);
  instances.push(health);
  return { health, calls };
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
      // Legacy app_info without capabilities → write defaults to false (ADR-0011).
      capabilities: { write: false },
      checkedAt: status.appInfo.checkedAt,
    });
    assert.ok(status.lastConnectedAt);
    assert.equal(status.lastHandshakeAt, status.lastConnectedAt);
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
