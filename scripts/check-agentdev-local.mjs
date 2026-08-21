#!/usr/bin/env node
// prestart 预检：node_modules/@agentdev/{core,llm,viewer,mcp} 必须是"可用构建"
// （dist 存在且含 local-features 所需导出）。
// 背景：@agentdev/* 四包尚未发布 npm，依赖经 package.json 的 file:../AgentDev/packages/*
// 以 junction 形式提供。npm install 可能冲掉/未重建链接，本脚本把失败提前为一条
// 可执行的修复指引；若当前链接不可用而相邻 AgentDev 仓库构建可用，则自动重建。
import { existsSync, lstatSync, readFileSync, realpathSync } from 'fs';
import { join, resolve } from 'path';
import { spawnSync } from 'child_process';

const projectRoot = resolve(import.meta.dirname, '..');
const scopeDir = join(projectRoot, 'node_modules', '@agentdev');
const linkScript = join(projectRoot, 'scripts', 'use-agentdev-local.mjs');
const PACKAGES = ['core', 'llm', 'viewer', 'mcp'];
// local-features 依赖、旧 registry 快照缺失的导出；框架导出面变更时同步更新这份清单
const REQUIRED_EXPORTS = {
  core: ['CoreLifecycle', 'HookDeclarations'],
  llm: ['createLLM'],
  viewer: ['ViewerWorker'],
  mcp: ['MCPFeature'],
};

function siblingAgentdevPath() {
  return resolve(process.env.AGENTDEV_LOCAL_PATH || join(projectRoot, '..', 'AgentDev'));
}

function probe(path, requiredExports) {
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
  const dtsText = readFileSync(dts, 'utf8');
  const missing = requiredExports.filter((name) => !dtsText.includes(name));
  if (missing.length > 0) {
    return { status: 'stale', isLink: st.isSymbolicLink(), missing };
  }
  return { status: 'ok', isLink: st.isSymbolicLink() };
}

function reason(state) {
  if (state.status === 'missing') {
    return '不存在（仓库根目录还没执行过 npm install，或链接被移除）';
  }
  if (state.status === 'no-dist') {
    return '缺少 dist 构建产物（框架仓库未构建，或构建被中断）';
  }
  return `缺少导出 ${state.missing.join(', ')}（构建产物过期，需重新构建框架仓库）`;
}

const states = new Map();
for (const name of PACKAGES) {
  states.set(name, probe(join(scopeDir, name), REQUIRED_EXPORTS[name]));
}

const allOk = [...states.values()].every((s) => s.status === 'ok');
if (allOk) {
  for (const name of PACKAGES) {
    const state = states.get(name);
    const where = state.isLink ? `本地链接 -> ${realpathSync(join(scopeDir, name))}` : 'npm 安装';
    console.log(`[agentdev:check] @agentdev/${name} 可用（${where}）`);
  }
  process.exit(0);
}

// 存在不可用的包：若相邻 AgentDev 仓库四个包的构建都可用，自动重建全部链接
const sibling = siblingAgentdevPath();
const hasSibling = existsSync(join(sibling, 'package.json'));
const siblingStates = new Map();
for (const name of PACKAGES) {
  siblingStates.set(name, hasSibling ? probe(join(sibling, 'packages', name), REQUIRED_EXPORTS[name]) : { status: 'missing' });
}
const siblingAllOk = [...siblingStates.values()].every((s) => s.status === 'ok');

if (hasSibling && siblingAllOk) {
  for (const name of PACKAGES) {
    if (states.get(name).status !== 'ok') {
      console.warn(`[agentdev:check] 当前 @agentdev/${name} 不可用：${reason(states.get(name))}`);
    }
  }
  console.warn(`[agentdev:check] 尝试重建本地链接 -> ${sibling}`);
  const link = spawnSync(process.execPath, [linkScript, sibling], { stdio: 'inherit' });
  let repaired = true;
  for (const name of PACKAGES) {
    if (probe(join(scopeDir, name), REQUIRED_EXPORTS[name]).status !== 'ok') repaired = false;
  }
  if (link.status === 0 && repaired) {
    console.log('[agentdev:check] 已修复：本地链接重建成功');
    process.exit(0);
  }
  console.error('[agentdev:check] 自动修复失败，请手动执行 npm run agentdev:local');
  process.exit(1);
}

for (const name of PACKAGES) {
  const state = states.get(name);
  if (state.status !== 'ok') {
    console.error(`[agentdev:check] @agentdev/${name} 不可用：${reason(state)}`);
    if (hasSibling && siblingStates.get(name).status !== 'ok') {
      console.error(`[agentdev:check] 相邻框架仓库对应包也不可用：${reason(siblingStates.get(name))}`);
    }
  }
}
if (!hasSibling) {
  console.error(`[agentdev:check] 未找到相邻框架仓库 ${sibling}`);
}
console.error(`开发模式需要本地构建的 AgentDev 框架仓库：
  1. 在相邻目录放置 AgentDev 源码仓库并构建：cd <AgentDev> && npm install && npm run build
  2. node scripts/use-agentdev-local.mjs <AgentDev 路径>   （或设置 AGENTDEV_LOCAL_PATH 后直接 npm start）
  3. npm start`);
process.exit(1);
