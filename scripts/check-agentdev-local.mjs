#!/usr/bin/env node
// prestart 预检：node_modules/agentdev 必须是"可用构建"（dist 存在且含 local-features 所需导出）。
// 背景：npm 上的 agentdev@0.2.x 是旧快照，缺少 CoreLifecycle / HookDeclarations 等导出，
// 直接进入 tsc 会喷出几十条 TS2305。本脚本把失败提前为一条可执行的修复指引；
// 若当前 agentdev 不可用而相邻 AgentDev 仓库构建可用，则自动重建本地链接，
// 使 "npm install 冲掉链接" 之后无需手动重跑 agentdev:local。
import { existsSync, lstatSync, readFileSync, realpathSync } from 'fs';
import { join, resolve } from 'path';
import { spawnSync } from 'child_process';

const projectRoot = resolve(import.meta.dirname, '..');
const modulePath = join(projectRoot, 'node_modules', 'agentdev');
const linkScript = join(projectRoot, 'scripts', 'use-agentdev-local.mjs');
// local-features 依赖、registry 旧快照缺失的导出；框架导出面变更时同步更新这份清单
const REQUIRED_EXPORTS = ['CoreLifecycle', 'HookDeclarations'];

function siblingAgentdevPath() {
  return resolve(process.env.AGENTDEV_LOCAL_PATH || join(projectRoot, '..', 'AgentDev'));
}

function probe(path) {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return { status: 'missing' };
  }
  const dts = join(path, 'dist', 'index.d.ts');
  const js = join(path, 'dist', 'index.js');
  if (!existsSync(dts) || !existsSync(js)) {
    return { status: 'no-dist', isLink: st.isSymbolicLink() };
  }
  const missing = REQUIRED_EXPORTS.filter((name) => !readFileSync(dts, 'utf8').includes(name));
  if (missing.length > 0) {
    return { status: 'stale', isLink: st.isSymbolicLink(), missing };
  }
  return { status: 'ok', isLink: st.isSymbolicLink() };
}

function reason(state) {
  if (state.status === 'missing') {
    return 'node_modules/agentdev 不存在（仓库根目录还没执行过 npm install）';
  }
  if (state.status === 'no-dist') {
    return '缺少 dist 构建产物（未构建，或构建被中断）';
  }
  return `缺少导出 ${state.missing.join(', ')}（npm registry 上的旧快照，不能满足 local-features 的编译需求）`;
}

let state = probe(modulePath);

if (state.status === 'ok') {
  const where = state.isLink ? `本地链接 -> ${realpathSync(modulePath)}` : 'npm 安装';
  console.log(`[agentdev:check] agentdev 可用（${where}）`);
  process.exit(0);
}

// 当前 agentdev 不可用：若相邻 AgentDev 仓库构建可用，自动重建本地链接
const sibling = siblingAgentdevPath();
const hasSibling = existsSync(join(sibling, 'package.json'));
const siblingState = hasSibling ? probe(sibling) : { status: 'missing' };

if (siblingState.status === 'ok') {
  console.warn(`[agentdev:check] 当前 agentdev 不可用：${reason(state)}`);
  console.warn(`[agentdev:check] 尝试重建本地链接 -> ${sibling}`);
  const link = spawnSync(process.execPath, [linkScript, sibling], { stdio: 'inherit' });
  if (link.status === 0 && probe(modulePath).status === 'ok') {
    console.log('[agentdev:check] 已修复：本地链接重建成功');
    process.exit(0);
  }
  console.error('[agentdev:check] 自动修复失败，请手动执行 npm run agentdev:local');
  process.exit(1);
}

if (hasSibling) {
  console.error(`[agentdev:check] agentdev 不可用：${reason(state)}`);
  console.error(`[agentdev:check] 相邻框架仓库 ${sibling} 的构建产物也不可用：${reason(siblingState)}`);
  console.error(`请先构建框架仓库，再重新 npm start：\n  cd ${sibling} && npm install && npm run build`);
  process.exit(1);
}

console.error(`[agentdev:check] agentdev 不可用：${reason(state)}`);
console.error(`开发模式需要本地构建的 AgentDev 框架仓库：
  1. 在相邻目录放置 AgentDev 源码仓库并构建：cd <AgentDev> && npm install && npm run build
  2. node scripts/use-agentdev-local.mjs <AgentDev 路径>   （或设置 AGENTDEV_LOCAL_PATH 后直接 npm start）
  3. npm start`);
process.exit(1);
