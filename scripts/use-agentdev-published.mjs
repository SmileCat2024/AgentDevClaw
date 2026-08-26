#!/usr/bin/env node
// 说明：@agentdevjs/* 四包尚未发布 npm，Claw 依赖以 file:../AgentDev/packages/* junction
// 形态运行，不存在"切回 npm 发布版"的可用路径。本脚本保留命令占位并给出指引，
// 待四包发版后应改写为：移除 file: 依赖、写入 semver、npm install。
import { existsSync } from 'fs';
import { resolve, join } from 'path';

const projectRoot = resolve(import.meta.dirname, '..');
const pkg = JSON.parse(await import('fs').then((m) => m.readFileSync(join(projectRoot, 'package.json'), 'utf8')));
const fileDeps = Object.entries(pkg.dependencies || {}).filter(([, spec]) => String(spec).startsWith('file:../'));
const published = Object.entries(pkg.dependencies || {}).filter(([name]) => name.startsWith('@agentdevjs/') && !String(pkg.dependencies[name]).startsWith('file:'));

console.log('[agentdev:published] @agentdevjs/core|llm|viewer|mcp 尚未发布 npm。');
if (fileDeps.length > 0) {
  console.log('[agentdev:published] 当前本地源码依赖（junction 形态）：');
  for (const [name, spec] of fileDeps) console.log(`  ${name}: ${spec}`);
}
if (published.length > 0) {
  console.log('[agentdev:published] 已按 semver 声明的生态包（tgz 安装）：');
  for (const [name] of published) console.log(`  ${name}`);
}
if (existsSync(join(projectRoot, 'node_modules', 'agentdev'))) {
  console.warn('[agentdev:published] 警告：node_modules/agentdev 存在残留目录（旧单包），可手动删除。');
}
console.log('[agentdev:published] 发版后请将上述 file:../AgentDev/packages/* 依赖改为 semver 并重新 npm install。');
process.exit(0);
