#!/usr/bin/env node
// 发布态切换：把 package.json 中的 `file:../AgentDev/packages/*` 本地依赖
// 改写为 npm registry semver 依赖（@agentdevjs/* 已发布 npm），随后执行
// npm install 即从 registry 拉取正式包（自带 dist，无需相邻仓库）。
//
// 与 agentdev:local 的关系：
//   - 本脚本改写依赖声明（file: -> semver），是形态切换的正向通道；
//   - agentdev:local 不改声明，只做 node_modules 手工 junction，用于
//     发布态下临时调试本地源码（npm install 会将其冲回 registry 版）。
//
// 版本来源：优先读相邻 AgentDev 仓库各包的 version（即刚发布的内容）；
// 相邻仓库不在时用 --version 显式指定，或采用默认 ^0.1.0。
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { resolve, join } from 'path';

const projectRoot = resolve(import.meta.dirname, '..');
const pkgPath = join(projectRoot, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

const fileDeps = Object.entries(pkg.dependencies || {}).filter(
  ([, spec]) => String(spec).startsWith('file:../AgentDev/packages/')
);

if (fileDeps.length === 0) {
  console.log('[agentdev:published] 当前已是发布态（无 file:../AgentDev 本地依赖），无需切换。');
  process.exit(0);
}

const agentdevRoot = resolve(projectRoot, '..', 'AgentDev');
const flagIdx = process.argv.indexOf('--version');
const fallback = flagIdx >= 0 ? process.argv[flagIdx + 1] : '^0.1.0';

let changed = 0;
for (const [name] of fileDeps) {
  // file:../AgentDev/packages/<dir> 的目录名从原 spec 中取
  const dir = pkg.dependencies[name].slice('file:../AgentDev/packages/'.length);
  const localPkg = join(agentdevRoot, 'packages', dir, 'package.json');
  let version = fallback;
  if (existsSync(localPkg)) {
    version = `^${JSON.parse(readFileSync(localPkg, 'utf8')).version}`;
  }
  pkg.dependencies[name] = version;
  console.log(`[agentdev:published] ${name}: file:../AgentDev/packages/${dir} -> ${version}`);
  changed += 1;
}

writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
console.log(`[agentdev:published] 已改写 ${changed} 个依赖。接下来执行：npm install`);
