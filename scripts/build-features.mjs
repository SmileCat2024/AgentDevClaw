#!/usr/bin/env node
// 构建 features/ 下被预制 agent 按源码路径引用的 feature 包。
// 这些包的 dist 不入库（gitignore），也不在 local-features/tsconfig.json 覆盖范围内，
// 必须在 prestart 现场构建；新增此类 feature 时把目录名加进 FEATURE_DIRS。
import { existsSync } from 'fs';
import { join, resolve } from 'path';
import { spawnSync } from 'child_process';

const FEATURE_DIRS = ['force-continuation'];
const root = resolve(import.meta.dirname, '..');
const IS_WIN = process.platform === 'win32';

// Windows 上 npm 是 npm.cmd 批处理，必须经 shell 调用；
// 此时传 args 数组会触发 Node DEP0190，因此统一拼成命令字符串（参数均为常量，无注入面）。
function runNpm(args, cwd) {
  return IS_WIN
    ? spawnSync(`npm ${args.join(' ')}`, { cwd, stdio: 'inherit', shell: true })
    : spawnSync('npm', args, { cwd, stdio: 'inherit' });
}

for (const name of FEATURE_DIRS) {
  const dir = join(root, 'features', name);
  if (!existsSync(join(dir, 'package.json'))) {
    console.error(`[build:features] 未找到 features/${name}/package.json`);
    process.exit(1);
  }
  const steps = [
    ['npm install', ['install', '--no-audit', '--no-fund']],
    ['npm run build', ['run', 'build']],
  ];
  for (const [label, args] of steps) {
    console.log(`[build:features] features/${name}: ${label}`);
    const r = runNpm(args, dir);
    if (r.error || r.status !== 0) {
      console.error(`[build:features] features/${name} ${label} 失败${r.error ? `: ${r.error.message}` : ''}`);
      process.exit(r.status ?? 1);
    }
  }
}
console.log('[build:features] 完成');
