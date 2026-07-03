#!/usr/bin/env node

/**
 * advclaw - AgentDevClaw 全局启动器
 *
 * 通过 npm link 注册为全局命令后，可在任意目录执行 advclaw 启动服务。
 * 脚本根据自身位置推导项目根目录，不依赖硬编码路径。
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

const child = spawn(process.execPath, ['server.js'], {
  cwd: projectRoot,
  stdio: 'inherit',
});

child.on('exit', (code) => {
  process.exit(code ?? 1);
});
