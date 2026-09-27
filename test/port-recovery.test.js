import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { ensureAppPortAvailable } from '../server/boot/port-recovery.js';

const quietLog = () => {};

async function getFreePort() {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

function fakeClawServer({ pid, state = 'ready', onShutdown }) {
  return createServer((req, res) => {
    if (req.url === '/protoclaw/health') {
      const body = { ok: true, state, pid, appPort: 0, viewerPort: 0 };
      if (pid === undefined) delete body.pid;
      res.end(JSON.stringify(body));
    } else if (req.url === '/protoclaw/shutdown') {
      onShutdown?.();
      res.end(JSON.stringify({ ok: true }));
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
}

test('clear when port is free', async () => {
  const port = await getFreePort();
  const result = await ensureAppPortAvailable({ port, log: quietLog });
  assert.deepEqual(result, { action: 'clear' });
});

test('refuses an occupied Claw port without requesting shutdown', async (t) => {
  const port = await getFreePort();
  let shutdownRequested = false;
  const server = fakeClawServer({
    pid: process.pid,
    onShutdown: () => { shutdownRequested = true; },
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  t.after(() => {
    server.close();
    server.closeAllConnections?.();
  });

  await assert.rejects(
    () => ensureAppPortAvailable({ port, log: quietLog }),
    /保护正在运行的进程/,
  );
  assert.equal(shutdownRequested, false);
  const health = await fetch(`http://127.0.0.1:${port}/protoclaw/health`);
  assert.equal(health.status, 200);
});

test('rejects when a non-Claw process holds the port without stopping it', async (t) => {
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
    () => ensureAppPortAvailable({ port, log: quietLog }),
    /其他或身份未知的进程/,
  );
  const stillListening = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(stillListening.status, 404);
});
