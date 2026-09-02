#!/usr/bin/env node
// prestart 预检：node_modules/@agentdevjs/*（4 框架包 + 14 生态包）必须是"可用构建"
// （dist 存在且含所需导出），且安装形态必须与声明形态一致。
// 开发态强制"本地链接不变量"：@agentdevjs/core 声明为 file: 时，node_modules 中的
// 包必须是指向相邻框架仓库对应包的链接（junction/symlink）。实体拷贝、失效链接、指向
// 其他目标的链接一律不可用——快照必然与框架仓库脱节，缺失的新 API 只会在运行期以
// "framework too old" 一类错误暴露（模型热切换事故的根因）。
// 发布态强制"registry 安装不变量"：声明为 semver 时，node_modules 中不允许出现
// 本地链接——npm install 不会替换恰好满足声明的链接，残留链接会让服务静默跑在
// 与声明脱节的框架版本上。发布态发现任何不一致只报错并指引 agentdev:published，
// 绝不自动改链（registry 安装被偷偷换成相邻仓库链接 = 另一类静默漂移）。
// 背景：依赖经 package.json 的 file:../AgentDev/packages/* 以 junction 形式提供
// （发布态为 npm 正式包，自带 dist）。开发态下 npm install 可能冲掉/未重建链接，
// 本脚本把失败提前为一条可执行的修复指引；若相邻 AgentDev 仓库构建可用，则自动
// 重建全部链接。
import { existsSync, lstatSync, readFileSync, realpathSync } from 'fs';
import { join, resolve } from 'path';
import { spawnSync } from 'child_process';
import { pathToFileURL } from 'url';

const projectRoot = resolve(import.meta.dirname, '..');
const scopeDir = join(projectRoot, 'node_modules', '@agentdevjs');
const linkScript = join(projectRoot, 'scripts', 'use-agentdev-local.mjs');

// @agentdevjs 包名 -> AgentDev/packages/ 下的目录名（唯一例外：rokid-bot -> rokid-feature）
const PACKAGE_MAP = {
  core: 'core',
  llm: 'llm',
  viewer: 'viewer',
  mcp: 'mcp',
  'audio-feedback-feature': 'audio-feedback-feature',
  'audit-feature': 'audit-feature',
  'feishu-bot': 'feishu-bot',
  'image-reader-feature': 'image-reader-feature',
  'memory-feature': 'memory-feature',
  'plugin-compat-feature': 'plugin-compat-feature',
  'qqbot-feature': 'qqbot-feature',
  'rokid-bot': 'rokid-feature',
  'shell-feature': 'shell-feature',
  'tts-feature': 'tts-feature',
  'visual-feature': 'visual-feature',
  'websearch-feature': 'websearch-feature',
  'wecom-bot': 'wecom-bot',
  'weixin-bot': 'weixin-bot',
};
const PACKAGES = Object.keys(PACKAGE_MAP);
// 框架四包做严格导出校验；生态包以 dist 构建产物存在为准。
// 框架导出面变更时同步更新这份清单。
const REQUIRED_EXPORTS = {
  core: ['CoreLifecycle', 'HookDeclarations'],
  llm: ['createLLM'],
  viewer: ['ViewerWorker'],
  mcp: ['MCPFeature'],
};
// 生态包约定 dist 入口文件（tsup 默认输出）。文件存在性即可证明构建可用。
const ENTRY_FILES = ['dist/index.js', 'dist/index.d.ts'];

function siblingAgentdevPath() {
  return resolve(process.env.AGENTDEV_LOCAL_PATH || join(projectRoot, '..', 'AgentDev'));
}

function isFeaturePackage(name) {
  return !(name in REQUIRED_EXPORTS);
}

// 与 is-dev-mode.mjs 同一判定语义（@agentdevjs/core 声明为 file: 即开发态）。
function isDevForm() {
  try {
    const dep = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8')).dependencies?.['@agentdevjs/core'];
    return typeof dep === 'string' && dep.startsWith('file:');
  } catch {
    return false;
  }
}

// 探测单个包。expectLink（开发态 node_modules 探测）时强制本地链接不变量：
// 实体目录 / 失效链接 / 指向 expectedReal 之外目标的链接均判 unlinked。
// expectedReal 为相邻仓库对应包的 realpath，null 表示跳过目标比对（相邻包缺失时）。
// rejectLink（发布态 node_modules 探测）时强制 registry 安装不变量：
// 本地链接判为 linked（与声明形态不一致），实体目录正常参与 dist/导出校验。
function probe(path, name, expectLink = false, expectedReal = null, rejectLink = false) {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return { status: 'missing' };
  }
  if (expectLink) {
    if (!st.isSymbolicLink()) {
      return { status: 'unlinked', why: '是实体目录而非本地链接' };
    }
    let real;
    try {
      real = realpathSync(path);
    } catch {
      return { status: 'unlinked', why: '链接已失效' };
    }
    if (expectedReal && real !== expectedReal) {
      return { status: 'unlinked', why: `链接指向了 ${real} 而非相邻框架仓库对应包` };
    }
  }
  if (rejectLink && st.isSymbolicLink()) {
    let real;
    try {
      real = realpathSync(path);
    } catch {
      real = '目标已失效';
    }
    return { status: 'linked', why: real };
  }
  const isFeat = isFeaturePackage(name);
  if (isFeat) {
    const missingFiles = ENTRY_FILES.filter((f) => !existsSync(join(path, f)));
    if (missingFiles.length > 0) {
      return { status: 'no-dist', isLink: st.isSymbolicLink(), missingFiles };
    }
    return { status: 'ok', isLink: st.isSymbolicLink() };
  }
  const dts = join(path, 'dist', 'index.d.ts');
  const js = join(path, 'dist', 'index.js');
  if (!existsSync(dts) || !existsSync(js)) {
    return { status: 'no-dist', isLink: st.isSymbolicLink() };
  }
  const dtsText = readFileSync(dts, 'utf8');
  const missing = REQUIRED_EXPORTS[name].filter((n) => !dtsText.includes(n));
  if (missing.length > 0) {
    return { status: 'stale', isLink: st.isSymbolicLink(), missing };
  }
  return { status: 'ok', isLink: st.isSymbolicLink() };
}

function reason(state) {
  if (state.status === 'missing') {
    return '不存在（仓库根目录还没执行过 npm install，或链接被移除）';
  }
  if (state.status === 'unlinked') {
    return `${state.why || '未链接到相邻框架仓库'}；开发态要求 node_modules/@agentdevjs/* 为指向相邻仓库的本地链接，实体快照会与框架仓库脱节（新 API 缺失，运行期报 "framework too old"）`;
  }
  if (state.status === 'linked') {
    return `是本地链接 -> ${state.why}；发布态要求 npm registry 安装，本地链接会绕过发布版本、与根声明脱节；执行 npm run agentdev:published 摘除链接并安装 registry 最新版`;
  }
  if (state.status === 'no-dist') {
    if (state.missingFiles) {
      return `缺少构建产物 ${state.missingFiles.join(', ')}（框架仓库未构建，或构建被中断）`;
    }
    return '缺少 dist 构建产物（框架仓库未构建，或构建被中断）';
  }
  return `缺少导出 ${state.missing.join(', ')}（构建产物过期，需重新构建框架仓库）`;
}

function main() {
  const isDev = isDevForm();
  const sibling = siblingAgentdevPath();
  const hasSibling = existsSync(join(sibling, 'package.json'));

  // 相邻仓库对应包的 realpath，供开发态链接目标比对
  const expectedReals = new Map();
  for (const name of PACKAGES) {
    const p = join(sibling, 'packages', PACKAGE_MAP[name]);
    try {
      expectedReals.set(name, hasSibling && existsSync(p) ? realpathSync(p) : null);
    } catch {
      expectedReals.set(name, null);
    }
  }

  const states = new Map();
  for (const name of PACKAGES) {
    states.set(name, probe(join(scopeDir, name), name, isDev, expectedReals.get(name), !isDev));
  }

  const allOk = [...states.values()].every((s) => s.status === 'ok');
  if (allOk) {
    for (const name of PACKAGES) {
      const state = states.get(name);
      const where = state.isLink ? `本地链接 -> ${realpathSync(join(scopeDir, name))}` : 'npm 安装';
      console.log(`[agentdev:check] @agentdevjs/${name} 可用（${where}）`);
    }
    process.exit(0);
  }

  // 发布态：只报错 + 给出修复路径，绝不自动修复——把 registry 安装偷偷改链到
  // 相邻仓库，等于制造另一类与声明脱节的静默漂移。
  if (!isDev) {
    for (const name of PACKAGES) {
      const state = states.get(name);
      if (state.status !== 'ok') {
        console.error(`[agentdev:check] @agentdevjs/${name} 不可用：${reason(state)}`);
      }
    }
    console.error(`[agentdev:check] 发布态要求 @agentdevjs/* 为 npm registry 安装：
  1. 包缺失 / dist 缺失 / 导出过期 -> npm install
  2. 存在本地链接 -> npm run agentdev:published   （摘除链接并安装 registry 最新版）`);
    process.exit(1);
  }

  // 存在不可用的包：若相邻 AgentDev 仓库对应包构建都可用，自动重建全部链接
  const siblingStates = new Map();
  for (const name of PACKAGES) {
    const dir = PACKAGE_MAP[name];
    siblingStates.set(name, hasSibling ? probe(join(sibling, 'packages', dir), name) : { status: 'missing' });
  }
  const siblingAllOk = [...siblingStates.values()].every((s) => s.status === 'ok');

  if (hasSibling && siblingAllOk) {
    for (const name of PACKAGES) {
      if (states.get(name).status !== 'ok') {
        console.warn(`[agentdev:check] 当前 @agentdevjs/${name} 不可用：${reason(states.get(name))}`);
      }
    }
    console.warn(`[agentdev:check] 尝试重建本地链接 -> ${sibling}`);
    const link = spawnSync(process.execPath, [linkScript, sibling], { stdio: 'inherit' });
    let repaired = true;
    for (const name of PACKAGES) {
      if (probe(join(scopeDir, name), name, isDev, expectedReals.get(name)).status !== 'ok') repaired = false;
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
      console.error(`[agentdev:check] @agentdevjs/${name} 不可用：${reason(state)}`);
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
}

// CLI 守卫：仅直接执行时运行主流程；被测试 import 时只暴露 probe / reason。
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}

export { PACKAGE_MAP, REQUIRED_EXPORTS, probe, reason, isDevForm, siblingAgentdevPath };
