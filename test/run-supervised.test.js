import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
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

// server 自主关闭（POST /protoclaw/shutdown）不给 supervisor 任何信号——health
// watchdog 是唯一的感知通道：假 server 先 ready、后转 503 shutting_down 且清理
// 挂死（不退出），断言 supervisor 启动 grace 并收割，进程树无残留。
test('health watchdog reaps a server stuck in self-shutdown', async (t) => {
  const port = 18000 + Math.floor(Math.random() * 2000);
  // 假 server：health 先 200，1 秒后转 503 shutting_down，之后永久挂住不退出。
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
    'setInterval(() => {}, 1e9);',
  ].join('\n');
  fs.writeFileSync(fakeScript, fakeSource);
  t.after(() => fs.rmSync(fakeScript, { force: true }));

  const sup = spawnSupervised({
    CLAW_SUPERVISED_CMD: `node ${fakeScript}`,
    PORT: String(port),
    CLAW_SUPERVISOR_HEALTH_MS: '120',
    CLAW_SUPERVISOR_GRACE_MS: '250',
  });
  let out = '';
  sup.stdout.on('data', (c) => { out += c; });
  sup.stderr.on('data', (c) => { out += c; });

  const { code } = await waitExit(sup, 10000);
  assert.equal(code, 0); // 收割路径视为正常结束
  assert.match(out, /health reports shutting_down/);
  assert.match(out, /force-killing/);
});

// 宿主死亡检测（ppid watchdog）：wrapper 作为宿主 spawn supervisor 后自行退出
// （模拟桌面宿主被单独强杀——不给任何信号），supervisor 应检测到宿主消失并
// 驱动完整停机链（grace 收割子进程）后自行退出，不孤儿化。
test('supervisor stops itself when host process dies', async (t) => {
  const wrapper = spawn(process.execPath, ['-e', [
    "const { spawn } = require('node:child_process');",
    'const child = spawn(process.execPath, [process.env.SUP_PATH], { stdio: \'ignore\' });',
    'console.log(child.pid);',
    'setTimeout(() => process.exit(0), 100);',
  ].join('\n')], {
    stdio: ['ignore', 'pipe', 'ignore'],
    env: {
      ...process.env,
      SUP_PATH: SUPERVISOR,
      CLAW_SUPERVISED_CMD: 'node -e setInterval(()=>{},1e9)',
      CLAW_SUPERVISOR_HOST_PING_MS: '200',
      CLAW_SUPERVISOR_GRACE_MS: '250',
    },
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
  t.after(() => { void killProcessTree(supPid); }); // watchdog 失效时的兜底清理
  assert.equal(await pollProcessGone(supPid), true, 'supervisor should exit after host death');
});
