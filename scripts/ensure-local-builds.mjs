#!/usr/bin/env node
// 保证 local-features 与 features/* 的编译产物（gitignored 的 dist）可用且不过时。
//
// 触发重编译的条件（满足其一）：
//   1. dist 不存在（全新克隆 / 老用户从未构建）；
//   2. 源码树中任一文件比 dist 中最新文件更新（git pull / git checkout
//      会刷新源码 mtime，天然命中）。
//
// 背景：prebuilt agent 按源码路径 import local-features/dist 与
// features/*/dist（见各 agent.js 顶层 import），这些 dist 不入库也不随
// npm install 产生。没有本模块时，git pull + npm install + npm start
// 的升级路径会加载陈旧 dist 或直接 import 失败。
//
// 由 preflight.mjs（prestart/predev）调用；也可独立运行。
import { existsSync, readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { spawnSync } from 'child_process';

const root = resolve(import.meta.dirname, '..');
const IS_WIN = process.platform === 'win32';

// Windows 上 npm 是 npm.cmd 批处理，必须经 shell 调用（与 build-features.mjs 同约定）。
function runNpm(args) {
  return IS_WIN
    ? spawnSync(`npm ${args.join(' ')}`, { cwd: root, stdio: 'inherit', shell: true })
    : spawnSync('npm', args, { cwd: root, stdio: 'inherit' });
}

// 目录树内（排除 skip 中的名字）所有文件的最新 mtime；目录不存在返回 0。
function newestMtime(dir, skip = new Set(['node_modules'])) {
  if (!existsSync(dir)) return 0;
  let max = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory() ? skip.has(e.name) : false) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else max = Math.max(max, statSync(p).mtimeMs);
    }
  }
  return max;
}

// 一个可编译单元是否需要重建：源码树（排除产物目录）比 dist 新即过时。
function isStale(srcDir, distDir) {
  const srcNewest = newestMtime(srcDir, new Set(['node_modules', 'dist']));
  const distNewest = newestMtime(distDir, new Set(['node_modules']));
  return srcNewest > distNewest;
}

function ensure(desc, check, buildScript) {
  if (!check()) return false;
  console.log(`[ensure-builds] ${desc} 缺失或过时，执行 ${buildScript} ...`);
  const r = runNpm(['run', buildScript]);
  if (r.error || r.status !== 0) {
    console.error(`[ensure-builds] ${buildScript} 失败，请手动执行排查。`);
    process.exit(r.status ?? 1);
  }
  return true;
}

const builtLf = ensure(
  'local-features/dist',
  () => isStale(join(root, 'local-features'), join(root, 'local-features', 'dist')),
  'build:local-features'
);
const builtFeat = ensure(
  'features/*/dist',
  () => ['force-continuation', 'tickets-build-flow'].some((n) =>
    isStale(join(root, 'features', n), join(root, 'features', n, 'dist'))
  ),
  'build:features'
);

if (!builtLf && !builtFeat) console.log('[ensure-builds] 本地构建产物均为最新，跳过编译。');
