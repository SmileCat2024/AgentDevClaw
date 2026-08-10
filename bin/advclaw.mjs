#!/usr/bin/env node

/**
 * advclaw - AgentDevClaw 全局启动器
 *
 * 通过 npm link 注册为全局命令后，可在任意目录执行。
 * 脚本根据自身位置推导项目根目录，不依赖硬编码路径。
 *
 * 用法:
 *   advclaw                 启动服务器（后台自动检测新版本）
 *   advclaw --port 1600    使用指定的 Web UI 端口启动
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

function parseStartPort(argv) {
  let rawPort = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--port') {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('-')) {
        console.error('错误: --port 需要一个 1-65535 范围内的端口号');
        process.exit(1);
      }
      rawPort = argv[++i];
    } else if (arg.startsWith('--port=')) {
      rawPort = arg.slice('--port='.length);
    }
  }

  if (rawPort === null) return null;

  const normalizedPort = String(rawPort).trim();
  if (!/^\d+$/.test(normalizedPort)) {
    console.error(`错误: 无效端口号 "${rawPort}"，必须是 1-65535 之间的整数`);
    process.exit(1);
  }

  const port = Number(normalizedPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`错误: 无效端口号 "${rawPort}"，必须是 1-65535 之间的整数`);
    process.exit(1);
  }

  return port;
}

if (subcommand === 'update') {
  await cmdUpdate(args.slice(1));
  process.exit(0);
}

if (subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
  console.log('advclaw - AgentDevClaw 全局启动器');
  console.log('');
  console.log('用法:');
  console.log('  advclaw                 启动服务器');
  console.log('  advclaw --port <port>   使用指定的 Web UI 端口启动');
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

const requestedPort = parseStartPort(args);

// 后台检测新版本（不阻塞服务器启动）
backgroundCheck().catch(() => { /* 网络错误静默忽略 */ });

const childEnv = { ...process.env };
if (requestedPort !== null) childEnv.PORT = String(requestedPort);

// Use npm start rather than invoking server.js directly so the package's
// prestart lifecycle (local Feature compilation) always runs first.
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const child = spawn(npmCommand, ['start'], {
  cwd: projectRoot,
  stdio: 'inherit',
  env: childEnv,
  shell: false,
});

child.on('exit', (code) => {
  process.exit(code ?? 1);
});
