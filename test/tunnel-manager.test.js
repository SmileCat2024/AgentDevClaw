import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { createTunnelManager } from '../server/remote-connections/tunnel-manager.js';

function connection(overrides = {}) {
  return {
    id: 'server-a',
    name: '开发服务器',
    enabled: true,
    mode: 'managed',
    localPort: 22101,
    ssh: { host: 'dev.example.com', user: 'ubuntu', port: 2222, hostAlias: null },
    remote: { appPort: 1420 },
    ...overrides,
  };
}

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stderr = new EventEmitter();
    this.pid = 1001;
    this.exitCode = null;
    this.signalCode = null;
    this.killCalls = [];
  }

  kill(signal) {
    this.killCalls.push(signal);
    this.exit(null, signal);
    return true;
  }

  exit(code = 0, signal = null) {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
  }
}

function createHarness() {
  const children = [];
  const manager = createTunnelManager({
    spawn: () => {
      const child = new FakeChild();
      children.push(child);
      return child;
    },
    exitWaitMs: 20,
    reconnectInitialMs: 10,
    reconnectMaxMs: 30,
  });
  return { manager, children };
}

let harness;
afterEach(async () => {
  await harness?.manager.stopAll();
  harness = null;
});

 describe('tunnel manager origins and spawn arguments', () => {
  beforeEach(() => { harness = createHarness(); });

  it('spawns managed SSH with loopback forwarding and keepalive options', async () => {
    const calls = [];
    const manager = createTunnelManager({
      spawn: (...args) => {
        calls.push(args);
        return new FakeChild();
      },
      exitWaitMs: 20,
    });

    await manager.startConnection(connection());

    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'ssh');
    assert.deepEqual(calls[0][1], [
      '-N',
      '-L', '127.0.0.1:22101:127.0.0.1:1420',
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ServerAliveInterval=15',
      '-o', 'ServerAliveCountMax=3',
      '-p', '2222',
      'ubuntu@dev.example.com',
    ]);
    assert.equal(calls[0][2].windowsHide, true);
    assert.equal(manager.getOrigin('server-a'), 'http://127.0.0.1:22101');
    assert.equal(manager.getStatus('server-a').tunnel, 'up');
    await manager.stopAll();
  });

  it('uses hostAlias and optional BatchMode without exposing another bind address', async () => {
    const calls = [];
    const manager = createTunnelManager({
      spawn: (...args) => { calls.push(args); return new FakeChild(); },
      batchMode: true,
    });

    await manager.startConnection(connection({
      ssh: { host: 'ignored.example.com', user: 'ignored', port: 22, hostAlias: 'prod-box' },
    }));

    assert.deepEqual(calls[0][1], [
      '-N',
      '-L', '127.0.0.1:22101:127.0.0.1:1420',
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ServerAliveInterval=15',
      '-o', 'ServerAliveCountMax=3',
      '-o', 'BatchMode=yes',
      'prod-box',
    ]);
    await manager.stopAll();
  });

  it('does not spawn or create side effects for manual mode', async () => {
    const calls = [];
    const manager = createTunnelManager({ spawn: (...args) => calls.push(args) });

    const status = await manager.startConnection(connection({ mode: 'manual', ssh: null }));

    assert.equal(calls.length, 0);
    assert.equal(manager.getOrigin('server-a'), 'http://127.0.0.1:22101');
    assert.equal(status.tunnel, 'down');
    assert.equal(status.pid, null);
  });

  it('treats url direct mode as process-free with the remote origin', async () => {
    const calls = [];
    const manager = createTunnelManager({ spawn: (...args) => calls.push(args) });

    const status = await manager.startConnection(connection({
      mode: 'url',
      localPort: null,
      baseUrl: 'https://claw.example.com',
      ssh: null,
      remote: null,
    }));

    assert.equal(calls.length, 0, 'url mode never spawns an ssh process');
    assert.equal(manager.getOrigin('server-a'), 'https://claw.example.com');
    assert.equal(status.tunnel, 'up');
    assert.equal(status.origin, 'https://claw.example.com');
    assert.equal(status.pid, null);
  });

  it('restarts a url connection when its baseUrl changes', async () => {
    const urlConnection = connection({
      mode: 'url',
      localPort: null,
      baseUrl: 'https://claw.example.com',
      ssh: null,
      remote: null,
    });
    await harness.manager.startConnection(urlConnection);

    await harness.manager.syncConnections([connection({
      ...urlConnection,
      baseUrl: 'https://moved.example.com',
    })]);

    // origin 直接来自运行时持有的 connection：origin 已更新即证明连接被重建。
    const status = harness.manager.getStatus('server-a');
    assert.equal(status.origin, 'https://moved.example.com');
    assert.equal(status.tunnel, 'up');
  });
});

describe('managed tunnel reconnect lifecycle', () => {
  beforeEach(() => { harness = createHarness(); });

  it('classifies unexpected exits as down and retries with exponential backoff', async () => {
    await harness.manager.startConnection(connection());
    harness.children[0].stderr.emit('data', Buffer.from('connection refused\nsecond diagnostic\n'));
    harness.children[0].exit(255, null);

    assert.equal(harness.manager.getStatus('server-a').tunnel, 'down');
    assert.equal(harness.manager.getStatus('server-a').exitCode, 255);
    assert.deepEqual(harness.manager.getStatus('server-a').stderrTail, ['connection refused', 'second diagnostic']);

    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(harness.children.length, 2);
    assert.equal(harness.manager.getStatus('server-a').tunnel, 'up');

    harness.children[1].exit(255, null);
    assert.equal(harness.manager.getStatus('server-a').reconnectDelayMs, 20);
  });

  it('classifies an intentional stop as stopped and cancels pending reconnect', async () => {
    await harness.manager.startConnection(connection());
    harness.children[0].exit(255, null);
    assert.equal(harness.manager.getStatus('server-a').tunnel, 'down');

    await harness.manager.stopConnection('server-a');
    assert.equal(harness.manager.getStatus('server-a').tunnel, 'stopped');
    assert.equal(harness.children.length, 1);
    assert.deepEqual(harness.children[0].killCalls, []);

    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(harness.children.length, 1);
  });

  it('classifies a spawn failure (e.g. ssh missing from PATH) as down with backoff, not a silent up', async () => {
    await harness.manager.startConnection(connection());
    assert.equal(harness.manager.getStatus('server-a').tunnel, 'up');

    // spawn 成功后进程立即报错（ENOENT 场景走 child 'error' 事件）：
    // 状态必须显式转为 down 并进入退避重连，绝不能停留在 up 造成假成功。
    harness.children[0].emit('error', Object.assign(new Error('spawn ssh ENOENT'), { code: 'ENOENT' }));

    const status = harness.manager.getStatus('server-a');
    assert.equal(status.tunnel, 'down');
    assert.ok(status.stderrTail.some((line) => line.includes('ENOENT')), 'diagnostics should capture the error');

    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(harness.children.length, 2, 'reconnect should respawn after the backoff delay');
    assert.equal(harness.manager.getStatus('server-a').tunnel, 'up');
  });

  it('stops a running child when a connection is disabled or deleted', async () => {
    await harness.manager.startConnection(connection());
    const child = harness.children[0];

    await harness.manager.syncConnections([connection({ enabled: false })]);
    assert.deepEqual(child.killCalls, ['SIGTERM']);
    assert.equal(harness.manager.getStatus('server-a').tunnel, 'stopped');

    await harness.manager.syncConnections([]);
    assert.equal(harness.manager.getStatus('server-a'), null);
  });
});
