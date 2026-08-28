#!/usr/bin/env node
/**
 * start/dev 前置轻量校验（prestart/predev）。
 *
 *   - 开发态（file: 依赖）：node_modules 必须是指向相邻仓库的本地链接，
 *     check-agentdev-local 校验并在相邻仓库可用时自动重建（实体拷贝/失效/错向
 *     链接同样触发），失败才给出修复指引。
 *   - 发布态（semver 依赖）：npm 正式包自带 dist，无本地链接概念，跳过校验。
 *   - 两种形态均保证 local-features 与 features/* 的 dist 可用且不过时
 *     （ensure-local-builds：git pull 升级后自动补编译，避免加载陈旧产物）。
 */
import { execSync } from 'child_process';
import { resolve } from 'path';

const root = resolve(import.meta.dirname, '..');

// 根依赖同步兜底：git pull 后未 npm install 时自动补装（含 install
// 半途失败的场景——hidden lock 快照不更新会再次触发并透传真实错误）
execSync('node scripts/ensure-root-deps.mjs', { cwd: root, stdio: 'inherit' });

let dev = true;
try {
  execSync('node scripts/is-dev-mode.mjs', { cwd: root, stdio: 'ignore' });
} catch {
  dev = false;
}

if (dev) {
  // 开发态：校验链接；不可用时 check 会自动重建（见 check-agentdev-local）
  execSync('node scripts/check-agentdev-local.mjs', { cwd: root, stdio: 'inherit' });
} else {
  console.log('[preflight] 发布态：@agentdevjs/* 为 npm 正式包，跳过本地链接校验');
}

execSync('node scripts/ensure-local-builds.mjs', { cwd: root, stdio: 'inherit' });