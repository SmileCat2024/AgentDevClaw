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
 *      落盘快照（AGENTDEV_VIEWER_ORIGIN 实机验收）；容器运行期宿主直连
 *      读写索引（容器索引读走平台 HTTP、写走 meta_sync——ADR-0037 容器
 *      修订，委托/驱逐补偿机制退役）
 *   ③ 数据面写路径：容器内 shell 写 /workspace 宿主同目录可见；
 *      docker kill 崩溃后新容器恢复会话（引用历史证明快照恢复）
 *   ④ 停止通道收敛：docker kill 强杀 → 容器实体自动清理；stop_agent 优雅
 *      停止 → 容器在宽限期内收敛消失
 *   ⑤ 编程小助手入口容器模式 + 本地/容器会话并存（并存闸退役验证）
 *   ⑥ 资源读取协议（ADR-0038）：容器模板 /res/ 回源成功 + 未注册根与
 *      穿越路径拒绝（宿主读不到容器内包根，回源是唯一通路）
 *
 * 断言采用快照全文计数法（不依赖快照内部结构）：回复独有 token 的出现
 * 次数增长 = 新 assistant 回复落盘；引用历史题（答案只在历史记录中）=
 * 快照恢复成功。
 *
 * 用法：node scripts/e2e-container-phase.mjs [--image <tag>] [--keep] [--model <preset>]
 *   --image  容器镜像（显式覆盖；默认走按 agent 镜像 agentdev-claw-runtime:<agentId>）
 *   --keep   保留隔离目录与平台日志（失败时自动保留）
 */

import { spawn, execFileSync } from 'child_process';
import { existsSync, mkdirSync, cpSync, createWriteStream, readFileSync, writeFileSync, rmSync } from 'fs';
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
    // 不设 CLAW_RUNTIME_CONTAINER_IMAGE：走后端按 agent 默认镜像
    // agentdev-claw-runtime:<agentId>（显式覆盖仅在 --image 时注入）
    if (image) env.CLAW_RUNTIME_CONTAINER_IMAGE = image;
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
    : null);
  if (IMAGE) {
    // 显式覆盖：两 agent 共用同一镜像（调试副 tag 等）
    sh('docker', ['image', 'inspect', IMAGE]);
    console.log(`  镜像（显式覆盖）: ${IMAGE}`);
  } else {
    // 默认走按 agent 镜像（后端默认 agentdev-claw-runtime:<agentId>）：
    // 本脚本拉起 coder 与 programming-helper 两个容器，镜像各自预检。
    for (const id of [AGENT_ID, 'programming-helper']) {
      const img = `agentdev-claw-runtime:${id}`;
      sh('docker', ['image', 'inspect', img]);
      console.log(`  镜像: ${img}`);
    }
  }
  if (!existsSync(join(BASE_DATA, 'presets.json'))) {
    throw new Error(`真实数据目录缺 presets.json（${BASE_DATA}），无可用模型配置`);
  }
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
  // A host-side canary in the isolated data root that is intentionally outside
  // the container allowlist. The runtime must not see it, even though nearby
  // model/session files are mounted for normal operation.
  const forbiddenHostPath = join(dataDir, 'remote-connections.json');
  writeFileSync(forbiddenHostPath, '{"marker":"host-only-canary"}');
  // The ACP route enforces the isolated user's approved Coder mode just like
  // production. Make this test fixture explicitly approve container execution.
  const workspaceSettingsSrc = join(BASE_DATA, 'workspace-settings.json');
  const workspaceSettings = existsSync(workspaceSettingsSrc)
    ? JSON.parse(readFileSync(workspaceSettingsSrc, 'utf8'))
    : { version: 1 };
  workspaceSettings.resourcePolicy = {
    ...(workspaceSettings.resourcePolicy || {}),
    coder: {
      ...(workspaceSettings.resourcePolicy?.coder || {}),
      runtimeExecutionMode: 'container',
    },
  };
  writeFileSync(join(dataDir, 'workspace-settings.json'), JSON.stringify(workspaceSettings, null, 2));
  const oauthSrc = join(BASE_DATA, 'oauth-tokens');
  if (existsSync(oauthSrc)) cpSync(oauthSrc, join(dataDir, 'oauth-tokens'), { recursive: true });
  const coderCfgSrc = join(BASE_DATA, 'agent-configs', `${AGENT_ID}.json`);
  if (existsSync(coderCfgSrc)) cpSync(coderCfgSrc, join(dataDir, 'agent-configs', `${AGENT_ID}.json`));
  const phCfgSrc = join(BASE_DATA, 'agent-configs', 'programming-helper.json');
  if (existsSync(phCfgSrc)) cpSync(phCfgSrc, join(dataDir, 'agent-configs', 'programming-helper.json'));
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
      body: JSON.stringify({ agentId: AGENT_ID, cwd: wsDir, runtimeMode: 'container', ...(MODEL ? { model: MODEL } : {}) }),
    });
    const { threadId, clawSessionId, viewerAgentId } = created;
    if (!threadId || !clawSessionId || !viewerAgentId) throw new Error(`ACP 建线响应缺字段: ${JSON.stringify(created).slice(0, 300)}`);
    const sessionId = clawSessionId;
    const containerName = `claw-rt-${AGENT_ID}-${sessionId}`;
    await waitFor('容器运行', () => sh('docker', ['ps', '--filter', `name=${containerName}`, '--format', '{{.Names}}'], { stdio: ['ignore', 'pipe', 'ignore'] }).length > 0, 30_000);
    record('① 注册接入（ACP 建线 + ticket 注册 + READY + 容器运行）', true,
      `thread=${String(threadId).slice(0, 12)}… session=${String(sessionId).slice(0, 12)}… viewer=${viewerAgentId}`);
    const mounts = JSON.parse(sh('docker', ['inspect', containerName, '--format', '{{json .Mounts}}']));
    const mountAllows = mounts.every((mount) => {
      const destination = String(mount.Destination || '').replaceAll('\\\\', '/');
      const source = String(mount.Source || '').replaceAll('\\\\', '/');
      const allowed = [
        '/workspace', '/data/workspaces/coder/sessions',
        '/data/agent-configs/coder.json', '/data/workspaces/coder/feature-config/agent.json',
        '/data/default.json', '/data/presets.json', '/data/model-connections.json',
        '/data/feature-setup.json', '/data/oauth-tokens', '/data/images',
      ];
      const isExpected = allowed.includes(destination)
        || destination.startsWith('/data/context-handoffs/');
      const isHostOnly = source === forbiddenHostPath.replaceAll('\\\\', '/');
      return isExpected && !isHostOnly;
    });
    const forbiddenCheck = sh('docker', ['exec', containerName, 'node', '-e',
      "const fs=require('node:fs'); const p='/data/remote-connections.json'; if(fs.existsSync(p)) process.exit(1); try { fs.accessSync('/data/remote-connections.json'); process.exit(2); } catch (e) { if (e.code !== 'ENOENT') process.exit(3); } console.log('FORBIDDEN_ABSENT');",
    ]);
    const readOnlyMounts = mounts.filter((mount) => [
      '/data/default.json', '/data/presets.json', '/data/model-connections.json',
      '/data/feature-setup.json', '/data/agent-configs/coder.json',
      '/data/workspaces/coder/feature-config/agent.json',
    ].includes(mount.Destination)).every((mount) => mount.RW === false);
    record('①b 只挂载允许的数据路径（宿主 canary 不可见）',
      mountAllows && forbiddenCheck === 'FORBIDDEN_ABSENT' && readOnlyMounts,
      `mounts=${mounts.map((m) => `${m.Destination}${m.RW ? ':rw' : ':ro'}`).join(',')}`);

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

    // ---- 场景 ②b：容器运行期宿主直连读写索引（ADR-0037 容器修订）----
    // 容器内索引读走平台 HTTP（CLAW_SESSION_INDEX_REMOTE=1）、写走
    // session_meta_sync——容器不打开 index.db，宿主与 db 的同内核连接无
    // 跨界锁问题（委托/驱逐补偿机制已退役）。断言：宿主列表在列；独立宿主
    // node 子进程真开新连接直读成功（证明宿主可随时新开连接）；容器侧
    // meta_sync 已把对话统计写入宿主索引（messageCount 推进）。
    const listed = await fetchJson(`${platform.baseUrl}/protoclaw/prebuilt_sessions?agentId=${AGENT_ID}`);
    const listedOk = Array.isArray(listed.sessions) && listed.sessions.some((s) => s.id === sessionId);
    const directRead = sh('node', ['--input-type=module', '-e',
      "import { readSessionIndex } from './server/shared/session-access.js'; const i=await readSessionIndex(process.env.TEST_AGENT); const s=i.sessions.find((x)=>x.id===process.env.TEST_SESSION_ID); console.log(JSON.stringify({ found: !!s, messageCount: s?.messageCount ?? 0 }));",
    ], { env: { ...process.env, AGENTDEV_DATA_DIR: dataDir, TEST_AGENT: AGENT_ID, TEST_SESSION_ID: sessionId } });
    const direct = JSON.parse(directRead);
    const metaSynced = await waitFor('容器 meta_sync 推进宿主索引 messageCount', async () => {
      const relisted = await fetchJson(`${platform.baseUrl}/protoclaw/prebuilt_sessions?agentId=${AGENT_ID}`).catch(() => null);
      const row = Array.isArray(relisted?.sessions) ? relisted.sessions.find((s) => s.id === sessionId) : null;
      return (row?.messageCount ?? 0) >= 1;
    }, 30_000).then(() => true, () => false);
    record('②b 容器运行期宿主直连读写索引（独立进程新开连接不撞锁 + meta_sync 写生效）',
      listedOk && direct.found && direct.messageCount >= 1 && metaSynced,
      `listed=${listedOk} direct=${directRead} metaSynced=${metaSynced}`);

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

     // The Coder task is explicitly pinned to container mode and its successor
     // sessions inherit that mode. Switching this same task to local would violate
     // the product contract; cross-executor recovery belongs in a separate policy.
     const sessionIndex = sh('node', ['--input-type=module', '-e',
       "import { readSessionIndex } from './server/shared/session-access.js'; const i=await readSessionIndex('coder'); console.log(JSON.stringify(i.sessions.find(s=>s.id===process.env.TEST_SESSION_ID)?.metadata?.runtimeMode || null));",
     ], { env: { ...process.env, AGENTDEV_DATA_DIR: dataDir, TEST_SESSION_ID: sessionId } });
      const persistedRuntimeMode = JSON.parse(sessionIndex);
      record('③c Coder 会话固定容器模式（任务执行环境持久化）', persistedRuntimeMode === 'container',
        persistedRuntimeMode === 'container' ? undefined : `runtimeMode=${persistedRuntimeMode}`);

    // ---- 场景 ⑤：编程小助手入口容器模式（POST prebuilt_sessions + runtimeMode）----
    // 交互入口（无策略闸门）：入口显式选 container → 会话创建即拉起容器，
    // metadata 持久化；挂载白名单与 coder 同构（仅自身数据路径）。
    log('S5', '编程小助手入口容器模式创建会话');
    const PH_ID = 'programming-helper';
    const phWsDir = join(runDir, 'ws-ph');
    mkdirSync(phWsDir, { recursive: true });
    const phCreated = await fetchJson(`${platform.baseUrl}/protoclaw/prebuilt_sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: PH_ID, runtimeMode: 'container', openDirectory: phWsDir }),
    });
    const phSessionId = phCreated?.session?.id;
    if (!phSessionId) throw new Error(`编程小助手创建响应缺 session.id: ${JSON.stringify(phCreated).slice(0, 300)}`);
    const phContainerName = `claw-rt-${PH_ID}-${phSessionId}`;
    await waitFor('PH 容器运行', () => sh('docker', ['ps', '--filter', `name=${phContainerName}`, '--format', '{{.Names}}'], { stdio: ['ignore', 'pipe', 'ignore'] }).length > 0, 30_000);
    const phMounts = JSON.parse(sh('docker', ['inspect', phContainerName, '--format', '{{json .Mounts}}']));
    const phAllowed = [
      '/workspace', `/data/workspaces/${PH_ID}/sessions`,
      `/data/agent-configs/${PH_ID}.json`,
      '/data/default.json', '/data/presets.json', '/data/model-connections.json',
      '/data/feature-setup.json', '/data/oauth-tokens', '/data/images',
    ];
    const phMountsOk = phMounts.every((mount) => phAllowed.includes(mount.Destination)
      || String(mount.Destination || '').startsWith('/data/context-handoffs/'));
    const phModeOut = sh('node', ['--input-type=module', '-e',
      "import { readSessionIndex } from './server/shared/session-access.js'; const i=await readSessionIndex('programming-helper'); console.log(JSON.stringify(i.sessions.find(s=>s.id===process.env.TEST_SESSION_ID)?.metadata?.runtimeMode || null));",
    ], { env: { ...process.env, AGENTDEV_DATA_DIR: dataDir, TEST_SESSION_ID: phSessionId } });
    const phPersisted = JSON.parse(phModeOut);

    // ---- 场景 ⑤b：本地/容器会话并存（ADR-0037 容器修订的直接受益）----
    // PH 容器会话运行中创建同 agent 的 standard（本地）会话：索引读协议化后
    // 锁问题域消失，创建应成功（并存闸已退役，原为 409 local_runtime_active
    // / container_runtime_active）。本地 runtime 是真实 spawn 的 node 子进程
    //（pid 数字形态；容器条目 pid 为容器名）。
    log('S5b', '容器会话运行中创建本地（standard）会话');
    const phLocalCreated = await fetchJson(`${platform.baseUrl}/protoclaw/prebuilt_sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: PH_ID, openDirectory: phWsDir }),
    });
    const phLocalId = phLocalCreated?.session?.id;
    if (!phLocalId) throw new Error(`本地会话创建响应缺 session.id: ${JSON.stringify(phLocalCreated).slice(0, 300)}`);
    // 观察点 = 平台日志锚：本地 runtime 就绪必打 ClawDispatch 轮询行（携带
    // 本地 sessionId）。/api/agents 全量列表在 viewer 面（Bearer），app 端口
    // 无该路由，不用作判定。
    const platformLogPath = join(runDir, 'platform-container.log');
    const localRuntimeUp = await waitFor('PH 本地 runtime 就绪（日志锚 sessionId）', () => {
      try {
        return readFileSync(platformLogPath, 'utf8').includes(`sessionId=${phLocalId}`);
      } catch { return false; }
    }, 60_000).then(() => true, () => false);
    const containerStillUp = sh('docker', ['ps', '--filter', `name=${phContainerName}`, '--format', '{{.Names}}'], { stdio: ['ignore', 'pipe', 'ignore'] }).length > 0;
    record('⑤b 本地/容器会话并存（容器运行中本地创建成功 + 双方共存）',
      localRuntimeUp && containerStillUp,
      `localRuntime=${localRuntimeUp} containerUp=${containerStillUp}`);
    // 收尾：先停本地会话再停容器会话（避免遗留 runtime 占用平台通道）
    await fetchJson(`${platform.baseUrl}/protoclaw/stop_agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: PH_ID, sessionId: phLocalId }),
    }).catch(() => {});

    // ---- 场景 ⑥：资源读取协议（ADR-0038）——容器模板 /res/ 跨边界回源 ----
    // 容器 runtime 的 feature 包根是容器内路径，宿主 ViewerWorker 的文件系统
    // 不可达；模板资产现按 /res/{agentId}/{rootId}/{rel} 寻址，viewer 经
    // host-request 向 runtime 回源取字节。断言：模板映射产出 /res/ URL 且经
    // 平台端口取回非空字节（跨边界回源成功）；未注册 rootId 与穿越路径均被
    // 拒绝且不泄漏文件内容。
    log('S6', '资源读取协议：容器模板 /res/ 回源 + 越根拒绝');
    // 容器形态下 viewerAgentId 经 ticket 身份交接异步到达（创建响应不带；
    // viewer id 槽位会跨 agent 复用，如 agent-1-1）。从平台日志按
    // 「Viewer Agent ID: <id> → 创建新会话: <phSessionId>」就近配对解析。
    const phLogText = () => { try { return readFileSync(platformLogPath, 'utf8'); } catch { return ''; } };
    const phViewerAgentId = phCreated?.status?.viewerAgentId
      || phCreated?.viewerAgentId
      || await waitFor('PH 容器 viewerAgentId 解析（日志配对）', () => {
        const text = phLogText();
        const sessionIdx = text.indexOf(`创建新会话: ${phSessionId}`);
        if (sessionIdx < 0) return false;
        const matches = [...text.slice(0, sessionIdx).matchAll(/Viewer Agent ID: (agent-[\w-]+)/g)];
        return matches.length > 0 ? matches.at(-1)[1] : false;
      }, 60_000).catch(() => null);
    const s6 = { mapOk: false, bytesOk: false, rootRejected: false, traversalRejected: false, detail: '' };
    if (phViewerAgentId) {
      const templateMap = await waitFor('容器 runtime 模板映射就绪', () => fetchJson(
        `${platform.baseUrl}/api/templates/feature?agentId=${encodeURIComponent(phViewerAgentId)}`,
      ).then((m) => (m && Object.keys(m).length > 0 ? m : false)).catch(() => false), 60_000).catch(() => null);
      const resUrl = templateMap
        ? Object.values(templateMap).find((u) => String(u).startsWith('/res/'))
        : undefined;
      s6.mapOk = Boolean(resUrl);
      if (resUrl) {
        const assetResp = await fetch(`${platform.baseUrl}${resUrl}`);
        const assetBody = await assetResp.text();
        s6.bytesOk = assetResp.ok && assetBody.length > 0;
        const probeRoot = await fetch(`${platform.baseUrl}/res/${encodeURIComponent(phViewerAgentId)}/99/nope.js`);
        s6.rootRejected = probeRoot.status === 404;
        // WHATWG URL 会折叠明文 .. 段，用百分号编码探测服务端解码后的拒绝
        const probeTraversal = await fetch(`${platform.baseUrl}/res/${encodeURIComponent(phViewerAgentId)}/0/%2e%2e/%2e%2e/etc/passwd`);
        const traversalBody = await probeTraversal.text();
        s6.traversalRejected = probeTraversal.status === 404 && !traversalBody.includes('root:');
        s6.detail = `map=${resUrl} bytes=${assetBody.length} rootProbe=${probeRoot.status} traversalProbe=${probeTraversal.status}`;
      } else {
        s6.detail = `模板映射无 /res/ 条目: ${JSON.stringify(templateMap).slice(0, 160)}`;
      }
    } else {
      s6.detail = '创建响应与平台日志均未解析到 viewerAgentId';
    }
    record('⑥ 资源读取协议（容器模板 /res/ 回源 + 未注册根/穿越路径拒绝）',
      s6.mapOk && s6.bytesOk && s6.rootRejected && s6.traversalRejected, s6.detail);

    const phStop = await fetchJson(`${platform.baseUrl}/protoclaw/stop_agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: PH_ID, sessionId: phSessionId }),
    }).then(
      () => ({ ok: true }),
      (error) => ({ ok: false, error: String(error?.message || error).slice(0, 200) }),
    );
    const phConverged = phStop.ok
      ? await waitFor('PH 容器收敛', () => sh('docker', ['ps', '-a', '--filter', `name=${phContainerName}`, '--format', '{{.Names}}'], { stdio: ['ignore', 'pipe', 'ignore'] }).length === 0, 30_000).then(() => true).catch(() => false)
      : false;
    record('⑤ 编程小助手入口容器模式（创建 → 容器运行 → metadata 持久化 → 优雅停止）',
      phMountsOk && phPersisted === 'container' && phConverged,
      `mountsOk=${phMountsOk} runtimeMode=${phPersisted} stop=${JSON.stringify(phStop)} converged=${phConverged}`);
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
