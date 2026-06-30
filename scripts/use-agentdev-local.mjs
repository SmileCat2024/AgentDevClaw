#!/usr/bin/env node
import { existsSync, lstatSync, rmSync, symlinkSync, readFileSync } from 'fs';
import { resolve, join } from 'path';

const projectRoot = resolve(import.meta.dirname, '..');
const target = resolve(process.argv[2] || process.env.AGENTDEV_LOCAL_PATH || join(projectRoot, '..', 'AgentDev'));
const modulePath = join(projectRoot, 'node_modules', 'agentdev');
const targetPackageJson = join(target, 'package.json');

if (!existsSync(targetPackageJson)) {
  console.error(`[agentdev:local] 未找到本地 AgentDev package.json: ${targetPackageJson}`);
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(targetPackageJson, 'utf8'));
if (pkg.name !== 'agentdev') {
  console.error(`[agentdev:local] 目标不是 agentdev 包: ${targetPackageJson}`);
  process.exit(1);
}

if (existsSync(modulePath)) {
  const stat = lstatSync(modulePath);
  rmSync(modulePath, { recursive: stat.isDirectory() || stat.isSymbolicLink(), force: true });
}

symlinkSync(target, modulePath, process.platform === 'win32' ? 'junction' : 'dir');
console.log(`[agentdev:local] node_modules/agentdev -> ${target}`);
console.log('[agentdev:local] package.json/package-lock.json 未修改；发布依赖仍走 npm semver。');
