#!/usr/bin/env node
// Claw 服务宿主（supervisor）。
//
// 进程裁决权契约：本进程持有终端与 server 进程的生杀权；server.js 只拥有
// "尽力清理"的执行权，其清理进度不构成本进程退出的前提。停机信号先给
// server 优雅窗口，窗口过后（或再次收到停机信号）无条件收割整棵进程树
// （server 的 runtime 子进程在树内，一并终结）。
//
// 本进程若被单独强杀（server 收不到任何通知），server 侧以 ppid 存活探测
// 轮询自灭（CLAW_SUPERVISED watchdog），启动自愈（port-recovery）是最后防线。
//
// 桌面化路径：Electron/Tauri 主进程即同一宿主角色，本文件建立的裁决权
// 结构可直接移植，server.js 的生命周期语义无需再改。

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { killProcessTree } from '../server/shared/process-tree.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SERVER_ENTRY = path.join(__dirname, '..', 'server.js');

const GRACE_MS = Number.parseInt(process.env.CLAW_SUPERVISOR_GRACE_MS || '', 10) || 10_000;

// 测试/替代宿主可注入任意子命令（空格分隔）；缺省托管本仓库 server.js。
const childCommand = process.env.CLAW_SUPERVISED_CMD
  ? process.env.CLAW_SUPERVISED_CMD.split(' ').filter(Boolean)
  : [process.execPath, DEFAULT_SERVER_ENTRY];

const child = spawn(childCommand[0], childCommand.slice(1), {
  stdio: ['ignore', 'inherit', 'inherit'],
  env: { ...process.env, CLAW_SUPERVISED: '1' },
});

let stopping = false;
let graceTimer = null;

function requestStop(reason) {
  if (stopping || child.exitCode !== null) return;
  stopping = true;
  console.log(`[supervisor] ${reason}; grace window ${GRACE_MS}ms, Ctrl+C again to force`);

  // Ctrl+C 经控制台已直达 server（同 console 进程组，server 自行走有序关闭）。
  // 仅 Unix 定向信号（只命中本进程）需要显式转发；Windows 下 kill('SIGTERM')
  // 是无条件终止而非通知，不走这条——宽限窗口后的进程树收割保证最终语义。
  if (process.platform !== 'win32') {
    try { child.kill('SIGTERM'); } catch { /* already dead */ }
  }

  // 通知 server 自主有序关闭：Ctrl+C 路径冗余但幂等；宿主死亡检测触发时
  // （Windows 无法向子进程转发信号）这是 server 收到优雅关闭请求的唯一通道。
  // 尽力而为，失败由 grace 窗口后的收割兜底。
  fetch(`http://127.0.0.1:${HEALTH_PORT}/protoclaw/shutdown`, {
    method: 'POST',
    signal: AbortSignal.timeout(1500),
  }).catch(() => {});

  graceTimer = setTimeout(() => void forceKill('grace window elapsed'), GRACE_MS);
  graceTimer.unref?.();
}

async function forceKill(reason) {
  if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
  if (child.exitCode !== null) return;
  console.log(`[supervisor] force-killing server process tree (${reason})`);
  await killProcessTree(child.pid);
}

process.on('SIGINT', () => (stopping ? void forceKill('second interrupt') : requestStop('interrupt received')));
process.on('SIGTERM', () => requestStop('terminate received'));
process.on('SIGHUP', () => requestStop('hangup received'));

// 宿主死亡检测：桌面宿主（Tauri 主进程）被单独强杀时不给本进程任何信号，
// 这里主动轮询父进程存活（与 server 侧 CLAW_SUPERVISED watchdog 对称），宿主
// 消失即进入停机流程，服务不孤儿化。npm/终端场景下控制台关闭会先发整组信号，
// 与本检测互为兜底；正常停机时 requestStop 幂等早退，无冲突。
const HOST_PING_MS = Number.parseInt(process.env.CLAW_SUPERVISOR_HOST_PING_MS || '', 10) || 3000;
const hostWatchdog = setInterval(() => {
  try {
    process.kill(process.ppid, 0);
  } catch {
    clearInterval(hostWatchdog);
    requestStop('host process gone');
  }
}, HOST_PING_MS);
hostWatchdog.unref();

// health watchdog：server 自主关闭（POST /protoclaw/shutdown）或挂死时不给本进程
// 任何信号，只靠停机信号的 grace 收割永远不会启动——这里补充"宿主主动询问"
// 的感知通道，对应桌面宿主对服务进程的标准监督姿势。ready 之前的探测失败属
// 启动期正常现象，不计数。
const HEALTH_PORT = Number.parseInt(process.env.PORT || '1420', 10);
// 测试可经 CLAW_SUPERVISOR_HEALTH_MS 缩短探测周期
const HEALTH_INTERVAL_MS = Number.parseInt(process.env.CLAW_SUPERVISOR_HEALTH_MS || '', 10) || 2000;
const HEALTH_FAILURE_LIMIT = 2;
let healthReadySeen = false;
let healthFailures = 0;

async function probeHealth() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const res = await fetch(`http://127.0.0.1:${HEALTH_PORT}/protoclaw/health`, { signal: controller.signal });
    if (res.ok) { healthReadySeen = true; healthFailures = 0; return; }
    let state = '';
    try { state = (await res.json())?.state || ''; } catch { /* body 不可解析按未知 503 处理 */ }
    // starting 等其他过渡态不视为死亡；shutting_down 表示 server 已开始自主关闭，
    // 若其清理挂死，grace 窗口到期由本进程收割。
    if (state === 'shutting_down') requestStop('health reports shutting_down');
  } catch {
    if (!healthReadySeen) return;
    healthFailures += 1;
    if (healthFailures >= HEALTH_FAILURE_LIMIT) {
      requestStop(`health probe failed ${healthFailures} times after ready`);
    }
  } finally {
    clearTimeout(timer);
  }
}

const healthWatchdog = setInterval(() => void probeHealth(), HEALTH_INTERVAL_MS);
healthWatchdog.unref();

child.on('exit', (code) => {
  clearInterval(healthWatchdog);
  if (graceTimer) clearTimeout(graceTimer);
  // 主动停机路径（含强杀收割）视为正常结束；仅 server 自身异常退出时透传退出码。
  process.exit(stopping ? 0 : (code ?? 0));
});

child.on('error', (err) => {
  console.error(`[supervisor] failed to start server: ${err.message}`);
  process.exit(1);
});
