#!/usr/bin/env node
import { existsSync, lstatSync, rmSync } from 'fs';
import { resolve, join } from 'path';
import { spawnSync } from 'child_process';

const projectRoot = resolve(import.meta.dirname, '..');
const modulePath = join(projectRoot, 'node_modules', 'agentdev');

if (existsSync(modulePath)) {
  const stat = lstatSync(modulePath);
  rmSync(modulePath, { recursive: stat.isDirectory() || stat.isSymbolicLink(), force: true });
  console.log('[agentdev:published] 已移除 node_modules/agentdev');
}

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const result = spawnSync(npmCommand, ['install', '--ignore-scripts'], {
  cwd: projectRoot,
  stdio: 'inherit',
  shell: false,
});

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

console.log('[agentdev:published] 已按 package.json/package-lock.json 恢复 npm 发布版 agentdev。');
