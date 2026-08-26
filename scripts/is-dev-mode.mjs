#!/usr/bin/env node
/**
 * 判定当前 Claw 的 @agentdevjs/* 依赖形态：
 *   - 开发态（file:../AgentDev/packages/*）：node_modules 是 junction，
 *     需要链接校验/修复与本地框架构建；
 *   - 发布态（semver）：node_modules 是 npm 正式包，自带 dist。
 *
 * 供 build-all.mjs 与 prestart/predev 共用。
 * 用法：node scripts/is-dev-mode.mjs   # 退出码 0=开发态, 1=发布态
 */
import { readFileSync } from 'fs';
import { join, resolve } from 'path';

const root = resolve(import.meta.dirname, '..');

try {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const dep = (pkg.dependencies || {})['@agentdevjs/core'];
  if (typeof dep === 'string' && dep.startsWith('file:')) {
    process.exit(0); // 开发态
  }
  process.exit(1);   // 发布态
} catch {
  process.exit(1);
}