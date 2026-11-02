// 容器镜像自检（ADR-0037 M5）：以 runtime 语义验证 Agent 运行环境完整性。
// 在镜像内执行：node scripts/container-selftest.js
//
// 镜像按 agent 构建（一 agent 一镜像）：本脚本扫描镜像内实际存在的
// prebuilt agent 装配链（应当恰好是目标 agent；一个都没有 = FAIL）。
//
// 验证内容（与镜像的使用方式一致——runtime 的全部工作就是加载装配链）：
//   1. 加载全部 prebuilt agent 装配链（agent.js → @agentdevjs/* / local-features
//      / features dist / skills 资产），import 成功 = 依赖闭包完整；
//   2. 平台绑定依赖（native 二进制）在 import 链上当场加载——Linux 版缺失
//      或不可加载在此直接失败，而非运行中期才暴露。
//
// 不加载 scripts/run-prebuilt-agent.js（入口脚本顶层即启动，需平台连接）。
import { existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// prebuilt-agents/<分类>/<agentId>/agent.js（当前分类仅有 official，扫描保持
// 两级通用，隐藏 agent 同样参与自检——它们的装配链也必须在镜像内可加载）
function discoverAgentEntries() {
  const entries = [];
  const base = join(root, 'prebuilt-agents');
  for (const category of readdirSync(base, { withFileTypes: true })) {
    if (!category.isDirectory()) continue;
    for (const agent of readdirSync(join(base, category.name), { withFileTypes: true })) {
      if (!agent.isDirectory()) continue;
      const agentFile = join(base, category.name, agent.name, 'agent.js');
      if (existsSync(agentFile)) entries.push({ id: `${category.name}/${agent.name}`, file: agentFile });
    }
  }
  return entries;
}

const loaded = [];
const failures = [];
for (const { id, file } of discoverAgentEntries()) {
  try {
    // 装配链加载成功的标志 = import 不抛错（依赖解析 + 模块体执行）。
    // 导出形态是各 agent 的设计自由（default Agent 类 / 具名类导出），
    // 不绑定统一形态；仅要求导出非空，防止空文件假通过。
    const mod = await import(pathToFileURL(file).href);
    if (Object.keys(mod).length === 0) {
      throw new Error('module has no exports');
    }
    loaded.push(id);
  } catch (err) {
    failures.push(`${id}: ${err.message}`);
  }
}

if (failures.length > 0) {
  console.error('[container-selftest] FAIL\n  ' + failures.join('\n  '));
  process.exit(1);
}
if (loaded.length === 0) {
  console.error('[container-selftest] FAIL: 镜像内未发现任何 agent 装配链（按 agent 构建的镜像必须恰好包含目标 agent）');
  process.exit(1);
}
console.log(`[container-selftest] OK: ${loaded.length} agent 装配链加载成功（${loaded.join(', ')}）`);
