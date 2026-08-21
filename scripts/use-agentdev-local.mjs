#!/usr/bin/env node
// 本地联动开发辅助：把相邻 AgentDev 仓库的四个框架包（core/llm/viewer/mcp）
// 以 junction 形式链接进 node_modules/@agentdev/。
//
// 背景：@agentdev/* 四包尚未发布 npm，Claw 的 package.json 用
// `file:../AgentDev/packages/*` 声明依赖。npm install 在 Windows 上会把
// file: 目录依赖物化为 junction，通常无需手动运行本脚本；它只用于：
//   1. 相邻仓库不在默认位置（../AgentDev）时手动指定路径；
//   2. npm install 后个别 junction 异常时的手工修复。
//
// 注意：package.json/package-lock.json 不被修改；发布依赖语义不变。
import { existsSync, lstatSync, rmSync, symlinkSync, readFileSync } from 'fs';
import { resolve, join } from 'path';

const PACKAGES = ['core', 'llm', 'viewer', 'mcp'];

const projectRoot = resolve(import.meta.dirname, '..');
const target = resolve(process.argv[2] || process.env.AGENTDEV_LOCAL_PATH || join(projectRoot, '..', 'AgentDev'));
const scopeDir = join(projectRoot, 'node_modules', '@agentdev');

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
  const pkgJson = join(target, 'packages', name, 'package.json');
  if (!existsSync(pkgJson)) {
    console.warn(`[agentdev:local] 跳过 @agentdev/${name}：包不存在 ${pkgJson}`);
    continue;
  }
  const pkg = JSON.parse(readFileSync(pkgJson, 'utf8'));
  if (pkg.name !== `@agentdev/${name}`) {
    console.warn(`[agentdev:local] 跳过 @agentdev/${name}：包名不匹配（${pkg.name}）`);
    continue;
  }
  const modulePath = join(scopeDir, name);
  if (existsSync(modulePath)) {
    const stat = lstatSync(modulePath);
    rmSync(modulePath, { recursive: stat.isDirectory() || stat.isSymbolicLink(), force: true });
  }
  symlinkSync(join(target, 'packages', name), modulePath, process.platform === 'win32' ? 'junction' : 'dir');
  console.log(`[agentdev:local] node_modules/@agentdev/${name} -> ${join(target, 'packages', name)}`);
  linked += 1;
}

console.log(`[agentdev:local] 完成：${linked}/${PACKAGES.length} 个包已链接。`);
