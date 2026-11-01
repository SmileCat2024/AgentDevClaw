#!/usr/bin/env node
/**
 * e2e-container-phase.mjs — ADR-0037 M6 容器阶段端到端验收
 *
 * 在隔离实例 + 隔离数据目录上驱动四场景（E2E 纪律与 M1–M3 相同，不碰真实
 * 会话数据；模型配置从真实用户数据目录只读复制）：
 *
 *   ① 托管容器 runtime 创建接入：ACP 建线（真实调度面）→ 容器 spawn →
 *      ticket 注册 → READY → viewerAgentId/threadId/sessionId 返回
 *   ② 完整一轮对话：线程输入 → 容器内 runtime 跨网络 dequeue → 模型回复
 *      落盘快照（AGENTDEV_VIEWER_ORIGIN 实机验收）
 *   ③ 数据面写路径：容器内 shell 写 /workspace 宿主同目录可见；
 *      docker kill 崩溃后新容器恢复会话（引用历史证明快照恢复）；
 *      优雅停止后本地 executor 同数据目录恢复同一会话（跨执行环境一致）
 *   ④ 停止通道收敛：docker kill 强杀 → 容器实体自动清理；stop_agent 优雅
 *      停止 → 容器在宽限期内收敛消失
 *
 * 断言采用快照全文计数法（不依赖快照内部结构）：回复独有 token 的出现
 * 次数增长 = 新 assistant 回复落盘；引用历史题（答案只在历史记录中）=
 * 快照恢复成功。
 *
 * 用法：node scripts/e2e-container-phase.mjs [--image <tag>] [--keep] [--model <preset>]
 *   --image  容器镜像 tag（默认取 agentdev-claw-runtime 最新构建）
 *   --keep   保留隔离目录与平台日志（失败时自动保留）
 */

import { spawn, execFileSync } from 'child_process';
import { existsSync, mkdirSync, cpSync, createWriteStream, readFileSync, rmSync } from 'fs';
import { createServer } from 'net';
import { homedir } from 'os';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE_DATA = process.env.CLAW_E2E_BASE_DATA || join(homedir(), '.agentdev', 'AgentDevClaw');
const AGENT_ID = 'coder';
const POLL_MS = 2000;
const TURN_TIMEOUT_MS = 240_000; // 容器启动 + 模型首段 120s（ADR-0029）+ 工具执行 + 保存

const args = process.argv.slice(2);
function argValue(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
const KEEP = args.includes('--keep');
const IMAGE_ARG = argValue('--image');
const MODEL = argValue('--model');

const results = [];
let keepOnExit = KEEP;
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
}

function log(step, msg) { console.log(`\n== ${step} == ${msg}`); }

function sh(cmd, cmdArgs, opts = {}) {
  return execFileSync(cmd, cmdArgs, { encoding: 'utf8', ...opts }).trim();
}

function freePort() {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => res(port));
    });
    srv.on('error', rej);
  });
}

async function fetchJson(url, init) {
  const resp = await fetch(url, init);
  const text = await resp.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  if (!resp.ok) throw new Error(`${init?.method || 'GET'} ${url} -> ${resp.status}: ${text.slice(0, 400)}`);
  return body;
}

function waitFor(label, predicate, timeoutMs = TURN_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((res, rej) => {
    const tick = async () => {
      let v;
      try { v = await predicate(); } catch (error) { v = false; void error; }
      if (v) return res(v);
      if (Date.now() > deadline) return rej(new Error(`waitFor 超时（${timeoutMs}ms）: ${label}`));
      setTimeout(tick, POLL_MS);
    };
    tick();
  });
}

function countIn(text, needle) {
  let n = 0; let i = text.indexOf(needle);
  while (i !== -1) { n += 1; i = text.indexOf(needle, i + needle.length); }
  return n;
}

function snapshotPath(dataDir, sessionId) {
  return join(dataDir, 'workspaces', AGENT_ID, 'sessions', `${sessionId}.json`);
}

function startPlatform({ mode, ports, dataDir, logFile, image }) {
  const env = {
    ...process.env,
    AGENTDEV_DATA_DIR: dataDir,
    PORT: String(ports.app),
    AGENTDEV_VIEWER_PORT: String(ports.viewerHttp),
    CLAW_RUNTIME_EXECUTOR: mode,
  };
  // 剥离宿主残留的显式 UDS 管道（M1 识别的宿主专属 env）：显式值会短路按隔离
  // 数据根的 per-instance 派生，与真实实例的固定管道冲突（EADDRINUSE）。
  delete env.AGENTDEV_UDS_PATH;
  if (mode === 'container') {
    // 容器后端前置（resolvePlatformGatewayContext）：TCP 监听 + 非回环 HTTP 绑定
    env.AGENTDEV_VIEWER_ADDR = `0.0.0.0:${ports.viewerTcp}`;
    env.AGENTDEV_VIEWER_HTTP_BIND = '0.0.0.0';
    env.CLAW_RUNTIME_EXECUTOR_AGENTS = AGENT_ID;
    env.CLAW_RUNTIME_CONTAINER_IMAGE = image;
  }
  const child = spawn(process.execPath, ['server.js'], {
    cwd: REPO_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stream = createWriteStream(logFile, { flags: 'a' });
  child.stdout.pipe(stream); child.stderr.pipe(stream);
  const stop = () => new Promise((res) => {
    if (child.exitCode !== null) return res();
    child.on('exit', () => res());
    child.kill();
    setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 8000);
  });
  return { child, stop, baseUrl: `http://127.0.0.1:${ports.app}` };
}

async function main() {
  // ---- 预检 ----
  log('preflight', `docker / 镜像 / 模型配置`);
  sh('docker', ['version', '--format', '{{.Server.Version}}']);
  const IMAGE = (IMAGE_ARG
    ? (IMAGE_ARG.includes(':') ? IMAGE_ARG : `agentdev-claw-runtime:${IMAGE_ARG}`)
    : (() => {
      const tag = sh('docker', ['images', 'agentdev-claw-runtime', '--format', '{{.Tag}}'])
        .split('\n').map((s) => s.trim()).filter(Boolean)[0];
      return tag ? `agentdev-claw-runtime:${tag}` : null;
    })());
  if (!IMAGE) throw new Error('无 agentdev-claw-runtime 镜像（先 npm run pack:container）');
  sh('docker', ['image', 'inspect', IMAGE]);
  if (!existsSync(join(BASE_DATA, 'presets.json'))) {
    throw new Error(`真实数据目录缺 presets.json（${BASE_DATA}），无可用模型配置`);
  }
  console.log(`  镜像: ${IMAGE}`);
  console.log(`  模型配置源: ${BASE_DATA}`);

  // ---- 隔离环境 ----
  const runDir = join(REPO_ROOT, 'dist', `e2e-container-${Date.now()}`);
  const dataDir = join(runDir, 'data');
  const wsDir = join(runDir, 'ws');
  mkdirSync(join(dataDir, 'agent-configs'), { recursive: true });
  mkdirSync(wsDir, { recursive: true });
  for (const file of ['presets.json', 'default.json', 'model-connections.json']) {
    const src = join(BASE_DATA, file);
    if (existsSync(src)) cpSync(src, join(dataDir, file));
  }
  const oauthSrc = join(BASE_DATA, 'oauth-tokens');
  if (existsSync(oauthSrc)) cpSync(oauthSrc, join(dataDir, 'oauth-tokens'), { recursive: true });
  const coderCfgSrc = join(BASE_DATA, 'agent-configs', `${AGENT_ID}.json`);
  if (existsSync(coderCfgSrc)) cpSync(coderCfgSrc, join(dataDir, 'agent-configs', `${AGENT_ID}.json`));
  console.log(`  隔离目录: ${runDir}`);

  const ports = { app: await freePort(), viewerHttp: await freePort(), viewerTcp: await freePort() };
  console.log(`  端口: app=${ports.app} viewerHttp=${ports.viewerHttp} viewerTcp=${ports.viewerTcp}`);

  const cleanup = [];
  let failed = false;
  try {
    // ---- 平台（容器模式）----
    log('S0', '启动隔离平台（容器执行模式）');
    const platform = startPlatform({ mode: 'container', ports, dataDir, logFile: join(runDir, 'platform-container.log'), image: IMAGE });
    cleanup.push(() => platform.stop());
    await waitFor('平台 health', () => fetchJson(`${platform.baseUrl}/protoclaw/health`).then(() => true), 60_000);
    console.log('  平台就绪');

    // ---- 场景 ①：ACP 建线 → 容器 spawn → ticket 注册 → READY ----
    log('S1', 'ACP 建线驱动托管容器 runtime（注册接入 + READY）');
    const created = await fetchJson(`${platform.baseUrl}/protoclaw/acp/${AGENT_ID}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: AGENT_ID, cwd: wsDir, ...(MODEL ? { model: MODEL } : {}) }),
    });
    const { threadId, clawSessionId, viewerAgentId } = created;
    if (!threadId || !clawSessionId || !viewerAgentId) throw new Error(`ACP 建线响应缺字段: ${JSON.stringify(created).slice(0, 300)}`);
    const sessionId = clawSessionId;
    const containerName = `claw-rt-${AGENT_ID}-${sessionId}`;
    await waitFor('容器运行', () => sh('docker', ['ps', '--filter', `name=${containerName}`, '--format', '{{.Names}}'], { stdio: ['ignore', 'pipe', 'ignore'] }).length > 0, 30_000);
    record('① 注册接入（ACP 建线 + ticket 注册 + READY + 容器运行）', true,
      `thread=${String(threadId).slice(0, 12)}… session=${String(sessionId).slice(0, 12)}… viewer=${viewerAgentId}`);

    const input = (text) => fetchJson(`${platform.baseUrl}/protoclaw/threads/${threadId}/input`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }),
    });
    const snapText = () => readFileSync(snapshotPath(dataDir, sessionId), 'utf8');
    const waitForCount = (needle, baseline) => waitFor(
      `快照 ${needle} 计数 > ${baseline}`,
      () => countIn(snapText(), needle) > baseline,
    );

    // ---- 场景 ②：完整一轮对话（跨网络 dequeue → 模型 → 快照）----
    log('S2', '完整一轮对话：容器内 dequeue → 模型回复落盘');
    const S2_TOKEN = '86415'; // 12345 × 7；输入文本不含该串
    const s2Base = countIn(snapText(), S2_TOKEN);
    await input('请计算 12345 乘以 7，只回复阿拉伯数字结果，不要其他任何内容。');
    await waitForCount(S2_TOKEN, s2Base);
    record('② 完整一轮对话（输入 → 容器 dequeue → 模型回复 → 快照落盘）', true, `回复含 ${S2_TOKEN}`);

    // ---- 场景 ③a：数据面写路径（/workspace → 宿主同目录）----
    log('S3a', '容器内 shell 写 /workspace，宿主目录可见');
    const s3Base = countIn(snapText(), 'WROTE-OK');
    await input('请用 shell 工具执行：echo m6-e2e > /workspace/m6-e2e-marker.txt，成功后只回复：WROTE-OK');
    await waitForCount('WROTE-OK', s3Base);
    await waitFor('宿主 ws/m6-e2e-marker.txt', () => existsSync(join(wsDir, 'm6-e2e-marker.txt'))
      && readFileSync(join(wsDir, 'm6-e2e-marker.txt'), 'utf8').includes('m6-e2e'));
    record('③a 数据面写路径（/workspace 写文件 → 宿主可见 + 回执落盘）', true);

    // ---- 场景 ④a：docker kill 崩溃收敛 ----
    log('S4a', 'docker kill 强杀 → 容器实体自动清理');
    sh('docker', ['kill', containerName]);
    await waitFor('崩溃容器被清理', () => sh('docker', ['ps', '-a', '--filter', `name=${containerName}`, '--format', '{{.Names}}'], { stdio: ['ignore', 'pipe', 'ignore'] }).length === 0, 30_000);
    record('④a 崩溃收敛（kill → wait 收敛 → 容器实体移除）', true);

    // ---- 场景 ③b：崩溃后新容器恢复会话（引用历史）----
    log('S3b', '崩溃后新容器恢复会话：引用历史中的被乘数');
    // 答案 12345 已存在于 S2 的用户输入历史（count=1）；新回复引用后 count 增长
    const s3bBase = countIn(snapText(), '12345');
    await input('回顾我们的对话：我让你计算的乘法里，被乘数是多少？只回复那个五位数本身。');
    await waitFor('新容器重建运行', () => sh('docker', ['ps', '--filter', `name=${containerName}`, '--format', '{{.Names}}'], { stdio: ['ignore', 'pipe', 'ignore'] }).length > 0, 30_000);
    await waitForCount('12345', s3bBase);
    record('③b 崩溃恢复（新容器唤起 + 快照恢复 + 历史引用正确）', true);

    // ---- 场景 ④b：stop_agent 优雅停止 ----
    log('S4b', 'stop_agent 优雅停止 → 宽限期内收敛');
    await fetchJson(`${platform.baseUrl}/protoclaw/stop_agent`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: AGENT_ID, sessionId }),
    });
    await waitFor('优雅停止后容器消失', () => sh('docker', ['ps', '-a', '--filter', `name=${containerName}`, '--format', '{{.Names}}'], { stdio: ['ignore', 'pipe', 'ignore'] }).length === 0, 30_000);
    // Thread 记录的实际布局是 threads/threads/<tid>.json（threads 根下是
    // index.json 与 threads/ 子目录，见 ThreadStore 数据布局）。
    const threadFile = join(dataDir, 'threads', 'threads', `${threadId}.json`);
    const threadOk = existsSync(threadFile) && (() => { try { JSON.parse(readFileSync(threadFile, 'utf8')); return true; } catch { return false; } })();
    record('④b 优雅停止（stop_agent → 容器收敛 + 线程记录完好）', threadOk, threadOk ? undefined : 'threads 记录缺失或损坏');

    // ---- 场景 ③c：本地 executor 恢复容器写的会话（跨执行环境一致）----
    log('S3c', '本地 executor 同数据目录恢复同一会话');
    await platform.stop();
    const ports2 = { app: await freePort(), viewerHttp: await freePort() };
    const local = startPlatform({ mode: 'local', ports: ports2, dataDir, logFile: join(runDir, 'platform-local.log') });
    cleanup.push(() => local.stop());
    await waitFor('本地平台 health', () => fetchJson(`${local.baseUrl}/protoclaw/health`).then(() => true), 60_000);
    // 答案 12345 当前 count = S2 输入 1 + S3b 回复 1 = 2；本地恢复后再引用则 > 该基线
    const s3cBase = countIn(snapText(), '12345');
    await fetchJson(`${local.baseUrl}/protoclaw/threads/${threadId}/input`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '再确认一次：第一条消息里让你计算的乘法，被乘数是多少？只回复那个五位数本身。' }),
    });
    await waitFor('本地恢复回复落盘', () => countIn(snapText(), '12345') > s3cBase, TURN_TIMEOUT_MS);
    record('③c 跨执行环境一致（容器写快照 → 本地 runtime 恢复引用）', true);
  } catch (error) {
    failed = true;
    console.error(`\n[E2E 中断] ${error.message}`);
    keepOnExit = true;
  } finally {
    for (const fn of cleanup.reverse()) { await fn().catch(() => {}); }
  }

  // ---- 汇总 ----
  const pass = results.filter((r) => r.ok).length;
  console.log(`\n===== E2E 结果: ${pass}/${results.length} =====`);
  for (const r of results) console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}`);
  if (failed || pass < results.length) keepOnExit = true;
  if (keepOnExit) {
    console.log(`现场保留: ${runDir}（含平台日志与隔离数据）`);
  } else {
    try {
      rmSync(runDir, { recursive: true, force: true });
      console.log('隔离目录已清理');
    } catch (error) {
      console.log(`隔离目录清理失败（可能有文件句柄未释放，请手动删除）: ${runDir} — ${error.message}`);
    }
  }
  process.exit(failed || pass < results.length ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
