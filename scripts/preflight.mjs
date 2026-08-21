#!/usr/bin/env node
/**
 * start/dev 前置轻量校验（prestart/predev）。
 *
 *   - 开发态（file: 依赖）：node_modules 是 junction，校验 18 条链接可用，
 *     缺失时给出修复指引（npm run build 会自动修复）。
 *   - 发布态（semver 依赖）：npm 正式包自带 dist，无本地链接概念，直接放行。
 *
 * 真正的构建工作全部在 npm run build（scripts/build-all.mjs）里完成，
 * 这里只保证「start 前环境基本可用」。
 */
import { execSync } from 'child_process';
import { resolve } from 'path';

const root = resolve(import.meta.dirname, '..');

let dev = true;
try {
  execSync('node scripts/is-dev-mode.mjs', { cwd: root, stdio: 'ignore' });
} catch {
  dev = false;
}

if (dev) {
  // 开发态：只校验链接；修复交给 build（build-all 会先跑 check 自动重建）
  execSync('node scripts/check-agentdev-local.mjs', { cwd: root, stdio: 'inherit' });
} else {
  console.log('[preflight] 发布态：@agentdev/* 为 npm 正式包，跳过本地链接校验');
}