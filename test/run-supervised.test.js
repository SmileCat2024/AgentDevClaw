import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { killProcessTree } from '../server/shared/process-tree.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SUPERVISOR = path.join(__dirname, '..', 'scripts', 'run-supervised.js');

function spawnSupervised(extraEnv) {
  return spawn(process.execPath, [SUPERVISOR], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...extraEnv },
  });
}

function waitExit(child, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('child did not exit in time')), timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

// 并发负载下被外部终止的子进程 exit 事件可能长时间不到（实测全量 test:core
// 下 8s+），死亡确认以 pid 存活探测为准——这正是被测模块依赖的原语。
async function pollProcessGone(pid, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return true; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

test('supervisor passes through child exit code', async () => {
  const sup = spawnSupervised({ CLAW_SUPERVISED_CMD: 'node -e process.exit(3)' });
  const { code } = await waitExit(sup);
  assert.equal(code, 3);
});

test('supervisor exits 0 when child exits 0', async () => {
  const sup = spawnSupervised({ CLAW_SUPERVISED_CMD: 'node -e process.exit(0)' });
  const { code } = await waitExit(sup);
  assert.equal(code, 0);
});

test('process.kill(pid, 0) distinguishes dead from alive processes', async (t) => {
  // watchdog 依赖的全部机制语义：宿主死亡检测（server.js 的 CLAW_SUPERVISED
  // watchdog）以 ppid 存活轮询实现——Windows 上父进程消亡不发信号、不关
  // 管道（stdin EOF 已实测证伪），kill(pid, 0) 是可用的探测原语。
  const shortLived = spawn(process.execPath, ['-e', 'process.exit(0)']);
  const alive = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { stdio: 'ignore' });
  t.after(() => { void killProcessTree(alive.pid); });
  await waitExit(shortLived);
  assert.throws(() => process.kill(shortLived.pid, 0), { code: 'ESRCH' });
  assert.doesNotThrow(() => process.kill(alive.pid, 0));
  assert.equal(await killProcessTree(alive.pid), true);
  assert.equal(await pollProcessGone(alive.pid), true);
});

test('killProcessTree terminates a stuck child', async (t) => {
  const child = spawn(process.execPath, [
    '-e', 'setInterval(() => {}, 1e9);',
  ], { stdio: 'ignore' });
  t.after(() => { void killProcessTree(child.pid); });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(await killProcessTree(child.pid), true);
  assert.equal(await pollProcessGone(child.pid), true); // taskkill/SIGKILL 不会留下存活进程
});
