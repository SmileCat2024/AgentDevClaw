import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { ensureAppPortRecoverable } from '../server/boot/port-recovery.js';

const quietLog = () => {};

async function getFreePort() {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

function fakeClawServer({ pid, onShutdown }) {
  return createServer((req, res) => {
    if (req.url === '/protoclaw/health') {
      const body = { ok: true, state: 'ready', pid, appPort: 0, viewerPort: 0 };
      if (pid === undefined) delete body.pid;
      res.end(JSON.stringify(body));
    } else if (req.url === '/protoclaw/shutdown') {
      res.end(JSON.stringify({ ok: true }));
      onShutdown?.();
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
}

test('clear when port is free', async () => {
  const port = await getFreePort();
  const result = await ensureAppPortRecoverable({ port, log: quietLog });
  assert.deepEqual(result, { action: 'clear' });
});

test('recovers gracefully when previous Claw instance exits on request', async () => {
  const port = await getFreePort();
  const server = fakeClawServer({
    pid: process.pid,
    onShutdown: () => {
      server.close();
      server.closeAllConnections?.();
    },
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));

  const result = await ensureAppPortRecoverable({
    port, gracefulWaitMs: 3000, log: quietLog,
  });
  assert.equal(result.action, 'recovered-graceful');
});

test('rejects when a non-Claw process holds the port', async (t) => {
  const port = await getFreePort();
  const server = createServer((_req, res) => {
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  t.after(() => {
    server.close();
    server.closeAllConnections?.();
  });

  await assert.rejects(
    () => ensureAppPortRecoverable({ port, log: quietLog }),
    /非 Claw/,
  );
});

test('recovers legacy instance without pid via port owner resolution', async (t) => {
  if (process.platform !== 'win32') t.skip('netstat 解析仅 Windows 提供');
  const port = await getFreePort();
  const server = fakeClawServer({
    pid: undefined,
    onShutdown: () => {
      server.close();
      server.closeAllConnections?.();
    },
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));

  // 假实例跑在测试进程内，netstat 反查得到的是本测试进程 pid——用例必须走
  // 优雅分支（实例响应 shutdown 即退），不会触发对本进程的强杀。
  const result = await ensureAppPortRecoverable({
    port, gracefulWaitMs: 3000, log: quietLog,
  });
  assert.equal(result.action, 'recovered-graceful');
  assert.equal(result.pid, process.pid);
});

test('kills a stuck previous instance holding the port', async () => {
  const port = await getFreePort();
  // 假实例子进程：应答 shutdown 但清理挂住、永不退出，模拟残留实例。
  const child = spawn(process.execPath, ['-e', `
    const http = require('http');
    const srv = http.createServer((req, res) => {
      if (req.url === '/protoclaw/health') {
        res.end(JSON.stringify({ ok: true, state: 'ready', pid: process.pid }));
      } else if (req.url === '/protoclaw/shutdown') {
        res.end(JSON.stringify({ ok: true }));
      } else {
        res.statusCode = 404;
        res.end('{}');
      }
    });
    srv.listen(Number(process.env.FAKE_PORT), '127.0.0.1', () => console.log('ready'));
  `], {
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, FAKE_PORT: String(port) },
  });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('fake instance did not start')), 4000);
    child.stdout.once('data', () => { clearTimeout(timer); resolve(); });
  });

  try {
    const result = await ensureAppPortRecoverable({
      port, gracefulWaitMs: 500, killWaitMs: 4000, log: quietLog,
    });
    assert.equal(result.action, 'recovered-killed');
    assert.equal(result.pid, child.pid);
    await exited; // 强杀后子进程确实死亡
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGKILL');
      await exited;
    }
  }
});
