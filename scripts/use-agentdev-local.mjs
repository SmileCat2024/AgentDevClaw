#!/usr/bin/env node
// 本地联动开发辅助：把相邻 AgentDev 仓库的全部 @agentdevjs/* 包
// （4 框架包 + 14 生态包）以 junction 形式链接进 node_modules/@agentdevjs/。
//
// 背景：@agentdevjs/* 包尚未发布 npm，Claw 的 package.json 用
// `file:../AgentDev/packages/*` 声明依赖。npm install 在 Windows 上会把
// file: 目录依赖物化为 junction，通常无需手动运行本脚本；它只用于：
//   1. 相邻仓库不在默认位置（../AgentDev）时手动指定路径；
//   2. npm install 后个别 junction 异常时的手工修复。
//
// 切换即就绪：链接完成后检查各包 dist，缺失时自动在框架仓库执行构建
// （framework dist 缺失会导致运行时 require 失败，不能留到启动期才暴露）。
//
// 注意：package.json/package-lock.json 不被修改；发布依赖语义不变。
import { existsSync, lstatSync, rmSync, symlinkSync, readFileSync } from 'fs';
import { resolve, join } from 'path';
import { spawnSync } from 'child_process';

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

const projectRoot = resolve(import.meta.dirname, '..');
const target = resolve(process.argv[2] || process.env.AGENTDEV_LOCAL_PATH || join(projectRoot, '..', 'AgentDev'));
const scopeDir = join(projectRoot, 'node_modules', '@agentdevjs');

const rootPackageJson = join(target, 'package.json');
if (!existsSync(rootPackageJson)) {
  console.error(`[agentdev:local] 未找到本地 AgentDev package.json: ${rootPackageJson}`);
  process.exit(1);
}
const rootPkg = JSON.parse(readFileSync(rootPackageJson, 'utf8'));
if (rootPkg.name !== 'agentdev') {
  console.error(`[agentdev:local] 目标不是 AgentDev 框架仓库（name=${rootPkg.name}）: ${target}`);
  process.exit(1);
}

let linked = 0;
for (const name of PACKAGES) {
  const dir = PACKAGE_MAP[name];
  const pkgJson = join(target, 'packages', dir, 'package.json');
  if (!existsSync(pkgJson)) {
    console.warn(`[agentdev:local] 跳过 @agentdevjs/${name}：包不存在 ${pkgJson}`);
    continue;
  }
  const pkg = JSON.parse(readFileSync(pkgJson, 'utf8'));
  if (pkg.name !== `@agentdevjs/${name}`) {
    console.warn(`[agentdev:local] 跳过 @agentdevjs/${name}：包名不匹配（${pkg.name}）`);
    continue;
  }
  const modulePath = join(scopeDir, name);
  if (existsSync(modulePath)) {
    const stat = lstatSync(modulePath);
    rmSync(modulePath, { recursive: stat.isDirectory() || stat.isSymbolicLink(), force: true });
  }
  symlinkSync(join(target, 'packages', dir), modulePath, process.platform === 'win32' ? 'junction' : 'dir');
  console.log(`[agentdev:local] node_modules/@agentdevjs/${name} -> ${join(target, 'packages', dir)}`);
  linked += 1;
}

console.log(`[agentdev:local] 完成：${linked}/${PACKAGES.length} 个包已链接。`);
console.log('[agentdev:local] 提示：已在运行的 Claw 服务与 agent runtime 仍持有旧模块，重启整个服务后生效。');

// 框架 dist 缺失时自动构建（切换即就绪，不把 require 失败留到运行期）。
const missingDist = PACKAGES.filter((name) => {
  const dir = PACKAGE_MAP[name];
  return existsSync(join(target, 'packages', dir)) && !existsSync(join(target, 'packages', dir, 'dist', 'index.js'));
});
if (missingDist.length > 0) {
  console.log(`[agentdev:local] 框架 dist 缺失（${missingDist.length} 个包），自动构建 AgentDev ...`);
  const isWin = process.platform === 'win32';
  const r = isWin
    ? spawnSync('npm run build', { cwd: target, stdio: 'inherit', shell: true })
    : spawnSync('npm', ['run', 'build'], { cwd: target, stdio: 'inherit' });
  if (r.error || r.status !== 0) {
    console.error('[agentdev:local] 框架构建失败，请进入 AgentDev 仓库手动执行 npm run build 排查。');
    process.exit(r.status ?? 1);
  }
}
