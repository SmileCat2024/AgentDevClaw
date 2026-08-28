#!/usr/bin/env node
// 发布态切换：把 package.json 中的 `file:../AgentDev/packages/*` 本地依赖
// 改写为 npm registry semver 依赖（@agentdevjs/* 已发布 npm），随后自动执行
// npm install + npm run build，切换完成即处于可启动状态。
//
// 与 agentdev:local 的关系：
//   - 本脚本改写依赖声明（file: -> semver），是形态切换的正向通道；
//   - agentdev:local 不改声明，只做 node_modules 手工 junction，用于
//     发布态下临时调试本地源码（npm install 会将其冲回 registry 版）。
//
// 版本来源：优先读相邻 AgentDev 仓库各包的 version（即刚发布的内容）；
// 相邻仓库不在时用 --version 显式指定，或采用默认 ^0.1.0。
// features/ 下被预制 agent 源码引用的子包（见 prebuilt-feature-dirs.mjs）
// 对 @agentdevjs/core 的 devDependency 同步对齐到目标版本，避免框架发版后
// 子包构建类型停留在旧版。
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { spawnSync } from 'child_process';
import { FEATURE_DIRS } from './prebuilt-feature-dirs.mjs';

const projectRoot = resolve(import.meta.dirname, '..');
const pkgPath = join(projectRoot, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

const agentdevRoot = resolve(projectRoot, '..', 'AgentDev');
const flagIdx = process.argv.indexOf('--version');
const fallback = flagIdx >= 0 ? process.argv[flagIdx + 1] : '^0.1.0';

// 目标版本：优先相邻框架仓库实际版本，缺失时用 fallback
function versionOf(dir) {
  const localPkg = join(agentdevRoot, 'packages', dir, 'package.json');
  if (existsSync(localPkg)) {
    return `^${JSON.parse(readFileSync(localPkg, 'utf8')).version}`;
  }
  return fallback;
}

const IS_WIN = process.platform === 'win32';
function runNpm(args, cwd = projectRoot) {
  console.log(`[agentdev:published] > npm ${args.join(' ')}`);
  const r = IS_WIN
    ? spawnSync(`npm ${args.join(' ')}`, { cwd, stdio: 'inherit', shell: true })
    : spawnSync('npm', args, { cwd, stdio: 'inherit' });
  if (r.error || r.status !== 0) {
    console.error(`[agentdev:published] npm ${args.join(' ')} 失败，请手动执行排查。`);
    process.exit(r.status ?? 1);
  }
}

const fileDeps = Object.entries(pkg.dependencies || {}).filter(
  ([, spec]) => String(spec).startsWith('file:../AgentDev/packages/')
);

let changed = 0;
for (const [name] of fileDeps) {
  // file:../AgentDev/packages/<dir> 的目录名从原 spec 中取
  const dir = pkg.dependencies[name].slice('file:../AgentDev/packages/'.length);
  const version = versionOf(dir);
  pkg.dependencies[name] = version;
  console.log(`[agentdev:published] ${name}: file:../AgentDev/packages/${dir} -> ${version}`);
  changed += 1;
}
if (changed > 0) writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
else console.log('[agentdev:published] 根声明已是发布态（semver）。');

// features/ 子包的 core devDep 对齐框架版本
const coreVersion = versionOf('core');
for (const name of FEATURE_DIRS) {
  const subPkgPath = join(projectRoot, 'features', name, 'package.json');
  if (!existsSync(subPkgPath)) continue;
  const subPkg = JSON.parse(readFileSync(subPkgPath, 'utf8'));
  const spec = subPkg.devDependencies?.['@agentdevjs/core'];
  if (typeof spec === 'string' && spec.startsWith('^') && spec !== coreVersion) {
    console.log(`[agentdev:published] features/${name}: @agentdevjs/core ${spec} -> ${coreVersion}`);
    subPkg.devDependencies['@agentdevjs/core'] = coreVersion;
    writeFileSync(subPkgPath, JSON.stringify(subPkg, null, 2) + '\n');
  }
}

runNpm(['install', '--no-audit', '--no-fund']);
runNpm(['run', 'build']);
console.log('[agentdev:published] 完成：发布态就绪。');
