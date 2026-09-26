import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// server.js 停机序列的 HTTP 收口模式（D4 修复的语义验证）：closeIdleConnections
// 只收空闲连接，挂起中的在途请求会让裸 close() 永不回调——这正是 shutdown 链
// 死锁的形态。收尾窗口超时后 closeAllConnections 强断，close 的完成不依赖任何
// 外部连接的自觉。此处以缩短的 grace 验证同一模式（server.js 同步维护点）。

test('shutdown close completes despite a hung in-flight request', async () => {
  const server = http.createServer(() => { /* 故意挂起：永不响应 */ });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const req = http.get({ host: '127.0.0.1', port, path: '/hang' }, () => {});
  await new Promise((resolve) => {
    req.on('error', () => resolve());
    req.on('socket', (socket) => socket.once('connect', resolve));
  });

  const GRACE_MS = 200;
  const start = Date.now();
  await new Promise((resolve) => {
    server.closeIdleConnections();
    const forceTimer = setTimeout(() => server.closeAllConnections(), GRACE_MS);
    server.close(() => {
      clearTimeout(forceTimer);
      resolve();
    });
  });
  const elapsed = Date.now() - start;

  // 无兜底时本用例会因 close 回调永不到而超时失败；有兜底时在 grace 后完成
  assert.ok(elapsed >= GRACE_MS - 50, `close should wait out the grace window, got ${elapsed}ms`);
  assert.ok(elapsed < GRACE_MS + 2000, `close should complete shortly after grace, got ${elapsed}ms`);
  req.destroy();
});
