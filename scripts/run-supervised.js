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

child.on('exit', (code) => {
  if (graceTimer) clearTimeout(graceTimer);
  // 主动停机路径（含强杀收割）视为正常结束；仅 server 自身异常退出时透传退出码。
  process.exit(stopping ? 0 : (code ?? 0));
});

child.on('error', (err) => {
  console.error(`[supervisor] failed to start server: ${err.message}`);
  process.exit(1);
});
