import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { killProcessTree } from '../server/shared/process-tree.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SUPERVISOR = path.join(__dirname, '..', 'scripts', 'run-supervised.js');

function isolatedTestEnv(extraEnv = {}) {
  const suffix = `${process.pid}-${Math.random().toString(36).slice(2)}`;
  return {
    ...process.env,
    // Fail closed: a typo in a test's child-command variable must never launch
    // the real server and let its port-recovery path shut down a developer's app.
    CLAW_SUPERVISED_CMD: 'node -e process.exit(0)',
    CLAW_SUPERVISOR_LOG: 'off',
    PORT: String(30000 + Math.floor(Math.random() * 20000)),
    AGENTDEV_VIEWER_PORT: String(30000 + Math.floor(Math.random() * 20000)),
    AGENTDEV_DATA_DIR: path.join(os.tmpdir(), `agentdev-supervised-test-${suffix}`),
    ...extraEnv,
  };
}

function spawnSupervised(extraEnv) {
  return spawn(process.execPath, [SUPERVISOR], {
    stdio: ['ignore', 'pipe', 'pipe'],
    // 所有子进程都使用隔离端口与数据目录；日志断言用例显式覆盖关闭值。
    env: isolatedTestEnv(extraEnv),
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
  // 验证测试清理辅助函数的进程存活探测语义。
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

// health 上报 shutting_down 仅供诊断；进程由服务自身决定何时退出。
test('health observation does not reap a server in self-shutdown', async (t) => {
  const port = 18000 + Math.floor(Math.random() * 2000);
  const logPath = path.join(os.tmpdir(), `.tmp-sup-log-health-${process.pid}.log`);
  fs.rmSync(logPath, { force: true });
  // 假 server：health 先 200，随后转 shutting_down，再由自身正常退出。
  // CLAW_SUPERVISED_CMD 按空格切分、不支持带引号参数，故落成临时脚本文件。
  const fakeScript = path.join(__dirname, `.tmp-fake-shutdown-server-${process.pid}.mjs`);
  const fakeSource = [
    "import http from 'node:http';",
    "let phase = 'ready';",
    "setTimeout(() => { phase = 'shutting_down'; }, 400);",
    "http.createServer((req, res) => {",
    "  if (phase === 'shutting_down') {",
    "    res.writeHead(503, { 'Content-Type': 'application/json' });",
    "    res.end(JSON.stringify({ state: 'shutting_down' }));",
    "  } else {",
    "    res.writeHead(200, { 'Content-Type': 'application/json' });",
    "    res.end(JSON.stringify({ state: 'ready' }));",
    "  }",
    `}).listen(${port}, '127.0.0.1');`,
    "setTimeout(() => process.exit(0), 1400);",
    'setInterval(() => {}, 1e9);',
  ].join('\n');
  fs.writeFileSync(fakeScript, fakeSource);
  t.after(() => { fs.rmSync(fakeScript, { force: true }); fs.rmSync(logPath, { force: true }); });

  const sup = spawnSupervised({
    CLAW_SUPERVISED_CMD: `node ${fakeScript}`,
    PORT: String(port),
    CLAW_SUPERVISOR_HEALTH_MS: '120',
    CLAW_SUPERVISOR_GRACE_MS: '250',
    CLAW_SUPERVISOR_LOG: logPath,
  });
  let out = '';
  sup.stdout.on('data', (c) => { out += c; });
  sup.stderr.on('data', (c) => { out += c; });

  const { code } = await waitExit(sup, 10000);
  assert.equal(code, 0); // 服务自然退出，supervisor 透传退出码
  assert.doesNotMatch(out, /force-killing|grace window/);
  assert.match(fs.readFileSync(logPath, 'utf8'), /health reports shutting_down/);
});

// 瞬时不可达不得误杀：假 server ready 后事件循环阻塞 600ms（重负载工况的
// 缩影——曾因此被连续探测失败误判死亡、整树收割），远小于挂死窗口，supervisor
// 应保持看护、透传其自然退出码，且不可达/恢复事件落入日志文件。
test('health observation tolerates transient unreachability under load', async (t) => {
  const port = 18000 + Math.floor(Math.random() * 2000);
  const logPath = path.join(os.tmpdir(), `.tmp-sup-log-tolerant-${process.pid}.log`);
  fs.rmSync(logPath, { force: true });
  const fakeScript = path.join(__dirname, `.tmp-fake-busy-server-${process.pid}.mjs`);
  const fakeSource = [
    "import http from 'node:http';",
    `http.createServer((req, res) => {`,
    "  res.writeHead(200, { 'Content-Type': 'application/json' });",
    "  res.end(JSON.stringify({ state: 'ready' }));",
    `}).listen(${port}, '127.0.0.1', () => {`,
    "  setTimeout(() => { const s = Date.now(); while (Date.now() - s < 600) {} }, 400);",
    "  setTimeout(() => process.exit(7), 1400);",
    '});',
  ].join('\n');
  fs.writeFileSync(fakeScript, fakeSource);
  t.after(() => { fs.rmSync(fakeScript, { force: true }); fs.rmSync(logPath, { force: true }); });

  const sup = spawnSupervised({
    CLAW_SUPERVISED_CMD: `node ${fakeScript}`,
    PORT: String(port),
    CLAW_SUPERVISOR_HEALTH_MS: '60',
    CLAW_SUPERVISOR_PROBE_MS: '200',
    CLAW_SUPERVISOR_HANG_WINDOW_MS: '1200',
    CLAW_SUPERVISOR_LOG: logPath,
  });
  let out = '';
  sup.stdout.on('data', (c) => { out += c; });
  sup.stderr.on('data', (c) => { out += c; });

  const { code } = await waitExit(sup, 10000);
  assert.equal(code, 7); // 未被收割，退出码透传
  assert.doesNotMatch(out, /grace window|force-killing/);
  const logText = fs.readFileSync(logPath, 'utf8');
  assert.match(logText, /health unreachable after ready \(observation only\)/);
  assert.match(logText, /health reachable again after \d+ms/);
});

// 即使探测持续不可达，supervisor 也只观察，不终止服务。
test('health observation does not terminate a busy server', async (t) => {
  const port = 18000 + Math.floor(Math.random() * 2000);
  const fakeScript = path.join(__dirname, `.tmp-fake-hung-server-${process.pid}.mjs`);
  const fakeSource = [
    "import http from 'node:http';",
    `http.createServer((req, res) => {`,
    "  res.writeHead(200, { 'Content-Type': 'application/json' });",
    "  res.end(JSON.stringify({ state: 'ready' }));",
    `}).listen(${port}, '127.0.0.1', () => {`,
    "  setTimeout(() => { const s = Date.now(); while (Date.now() - s < 900) {} }, 300);",
    "  setTimeout(() => process.exit(9), 1400);",
    '});',
  ].join('\n');
  fs.writeFileSync(fakeScript, fakeSource);
  t.after(() => { fs.rmSync(fakeScript, { force: true }); });

  const sup = spawnSupervised({
    CLAW_SUPERVISED_CMD: `node ${fakeScript}`,
    PORT: String(port),
    CLAW_SUPERVISOR_HEALTH_MS: '60',
    CLAW_SUPERVISOR_PROBE_MS: '200',
    CLAW_SUPERVISOR_HANG_WINDOW_MS: '800',
    CLAW_SUPERVISOR_GRACE_MS: '300',
  });
  let out = '';
  sup.stdout.on('data', (c) => { out += c; });
  sup.stderr.on('data', (c) => { out += c; });

  const { code } = await waitExit(sup, 10000);
  assert.equal(code, 9); // 保留服务自己的退出码
  assert.doesNotMatch(out, /force-killing|grace window/);
});

// 关键事件落盘：supervisor 生命周期事件写入 CLAW_SUPERVISOR_LOG 指定文件，
// 终端输出丢失后仍可事后归因。
test('supervisor persists lifecycle events to the log file', async (t) => {
  const logPath = path.join(os.tmpdir(), `.tmp-sup-log-basic-${process.pid}.log`);
  fs.rmSync(logPath, { force: true });
  t.after(() => fs.rmSync(logPath, { force: true }));

  const sup = spawnSupervised({
    CLAW_SUPERVISOR_LOG: logPath,
    CLAW_SUPERVISED_CMD: 'node -e process.exit(5)',
  });
  const { code } = await waitExit(sup);
  assert.equal(code, 5);
  const logText = fs.readFileSync(logPath, 'utf8');
  assert.match(logText, /supervisor started: pid \d+, child pid \d+/);
  assert.match(logText, /child exited: code 5/);
});

// launcher 消失不授予 supervisor 终止服务进程树的权限。
// wrapper 以 detached 启动 supervisor，建模桌面宿主（Rust CreateProcess，
// 无 libuv Job Object）：Node ≥ 24 的 libuv 在 Windows 为非 detached 子进程
// 建 KILL_ON_JOB_CLOSE Job，launcher 退出时 OS 会连坐收割整棵树——那样测的
// 是进程树策略而非 supervisor 语义，断言永远过不去。
test('supervisor leaves its child untouched when its launcher exits', async (t) => {
  const wrapper = spawn(process.execPath, ['-e', [
    "const { spawn } = require('node:child_process');",
    "const child = spawn(process.execPath, [process.env.SUP_PATH], { stdio: 'ignore', detached: true });",
    'child.unref();',
    'console.log(child.pid);',
    'setTimeout(() => process.exit(0), 100);',
  ].join('\n')], {
    stdio: ['ignore', 'pipe', 'ignore'],
    env: isolatedTestEnv({
      SUP_PATH: SUPERVISOR,
      CLAW_SUPERVISED_CMD: 'node -e setInterval(()=>{},1e9)',
      CLAW_SUPERVISOR_GRACE_MS: '250',
    }),
  });
  const supPid = await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error('wrapper did not report supervisor pid')), 4000);
    wrapper.stdout.on('data', (c) => {
      out += c;
      const pid = Number.parseInt(out, 10);
      if (Number.isInteger(pid)) { clearTimeout(timer); resolve(pid); }
    });
  });
  t.after(() => { void killProcessTree(supPid); }); // 清理由测试创建的子进程
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.doesNotThrow(() => process.kill(supPid, 0), 'supervisor must leave the child untouched');
});
