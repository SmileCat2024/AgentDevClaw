#!/usr/bin/env node

/**
 * advclaw - AgentDevClaw 全局启动器
 *
 * 通过 npm link 注册为全局命令后，可在任意目录执行。
 * 脚本根据自身位置推导项目根目录，不依赖硬编码路径。
 *
 * 用法:
 *   advclaw                 启动服务器（后台自动检测新版本）
 *   advclaw update          检查并更新到最新 GitHub Release
 *   advclaw update --check  仅检查是否有新版本
 *
 * 环境变量:
 *   ADVCLAW_NO_UPDATE_CHECK=1  本次启动跳过版本检测
 *   PORT=3000                  自定义服务端口
 */

import { spawn } from 'child_process';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { backgroundCheck, cmdUpdate } from './advclaw-update.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

// ── 命令路由 ────────────────────────────────────────────────────

const args = process.argv.slice(2);
const subcommand = args[0] || '';

if (subcommand === 'update') {
  await cmdUpdate(args.slice(1));
  process.exit(0);
}

if (subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
  console.log('advclaw - AgentDevClaw 全局启动器');
  console.log('');
  console.log('用法:');
  console.log('  advclaw                 启动服务器');
  console.log('  advclaw update          更新到最新 GitHub Release');
  console.log('  advclaw update --check  仅检查是否有新版本');
  console.log('');
  console.log('环境变量:');
  console.log('  ADVCLAW_NO_UPDATE_CHECK=1  跳过版本检测');
  console.log('  PORT=<port>                自定义服务端口');
  process.exit(0);
}

if (subcommand === '--version' || subcommand === '-v') {
  const pkg = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'));
  console.log(`advclaw v${pkg.version}`);
  process.exit(0);
}

// ── 启动服务器 ──────────────────────────────────────────────────

// 后台检测新版本（不阻塞服务器启动）
backgroundCheck().catch(() => { /* 网络错误静默忽略 */ });

const child = spawn(process.execPath, ['server.js'], {
  cwd: projectRoot,
  stdio: 'inherit',
});

child.on('exit', (code) => {
  process.exit(code ?? 1);
});
