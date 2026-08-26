#!/usr/bin/env node
// git pull 升级后常忘 npm install，导致 server.js 首个 import 就
// ERR_MODULE_NOT_FOUND。检测 package.json 声明的每个依赖在 node_modules
// 的物理存在性：缺失或为死符号链接（0.2.X 开发态 file: 链接残留，
// npm install 会惰性跳过不重装）时，删链接并自动补跑 npm install，
// 保证 git pull && npm start 开箱即用。
import { execSync } from 'child_process';
import { existsSync, lstatSync, readFileSync, rmSync, statSync } from 'fs';
import { join, resolve } from 'path';

const root = resolve(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const wanted = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });

const brokenLinks = [];
const missing = [];
for (const name of wanted) {
  const dir = join(root, 'node_modules', name);
  const linkStat = existsSync(dir) && lstatSync(dir);
  if (!linkStat) {
    missing.push(name);
    continue;
  }
  // 符号链接但目标不存在 = 死链；npm 对现存链接惰性跳过，必须先删
  if (linkStat.isSymbolicLink() && !statSync(dir)) {
    brokenLinks.push(name);
    rmSync(dir);
  }
}

if (!missing.length && !brokenLinks.length) {
  console.log('[preflight] 根依赖完整，跳过 npm install');
  process.exit(0);
}

if (brokenLinks.length) {
  console.log(`[preflight] 清理死符号链接: ${brokenLinks.join(', ')}`);
}
// 树已损坏时重置 npm hidden lockfile：其中残留的 link 记录会让
// npm install 按旧账重建指向相邻仓库的符号链接而不是下载 registry 包
if (existsSync(join(root, 'node_modules', '.package-lock.json'))) {
  rmSync(join(root, 'node_modules', '.package-lock.json'));
}
console.log(`[preflight] 缺失依赖 ${missing.length + brokenLinks.length} 个（git pull 后未 install？），自动补装…`);
execSync('npm install --no-audit --no-fund', { cwd: root, stdio: 'inherit' });
