#!/usr/bin/env node
/**
 * Ticket 02 — 全局 feature-setup.json 稀疏化清洗（一次性迁移脚本）
 *
 * 现状 feature-setup.json 是 UI 全量 dump 的完整快照，含空串/空数组/null
 * 影子字段。这些字段在新配置队列模型中会永久压制 manifest default，
 * 需清洗为稀疏存储（docs/tickets/00-feature-config-queue-overview.md D11）。
 *
 * 行为：
 * - 递归剔除值为 "" / [] / null 的字段；保留一切非空值（含等于默认值的 pin）
 * - 写回前备份原文件为 feature-setup.json.bak-<timestamp>（不覆盖已有备份）
 * - --dry-run：只打印将删除的字段路径与保留摘要，不写任何文件
 * - 幂等：对已稀疏化的文件重复运行无变化
 *
 * 用法:
 *   node scripts/migrate-feature-setup-sparse.mjs            # 实跑（备份后写回）
 *   node scripts/migrate-feature-setup-sparse.mjs --dry-run  # 只预览
 */

import { homedir } from 'os';
import { join } from 'path';
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'fs';

const dryRun = process.argv.includes('--dry-run');

const targetPath = join(
  homedir(),
  '.agentdev',
  'AgentDevClaw',
  'feature-setup.json'
);

if (!existsSync(targetPath)) {
  console.error(`[migrate-feature-setup-sparse] 目标文件不存在: ${targetPath}`);
  process.exit(1);
}

let raw;
try {
  raw = readFileSync(targetPath, 'utf8');
} catch (e) {
  console.error(`[migrate-feature-setup-sparse] 读取失败: ${e.message}`);
  process.exit(1);
}

let data;
try {
  data = JSON.parse(raw);
} catch (e) {
  console.error(`[migrate-feature-setup-sparse] JSON 解析失败: ${e.message}`);
  process.exit(1);
}

/** 判断字段值是否应被剔除：空串 / 空数组 / null */
function isEmptyValue(value) {
  return value === '' || value === null || (Array.isArray(value) && value.length === 0);
}

/**
 * 递归剔除对象中空值字段。
 * 返回 [清理后的值, 是否有变化]。
 * 注意：空数组/空串/null 本身作为整体被剔除，不进入递归；
 * 数组元素不剔除（数组是标量语义，整体替换，见 D5），只递归对象字段。
 */
function prune(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return [value, false];
  }
  let changed = false;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (isEmptyValue(child)) {
      changed = true;
      continue;
    }
    const [prunedChild, childChanged] = prune(child);
    out[key] = prunedChild;
    if (childChanged) changed = true;
  }
  return [out, changed];
}

/** 收集将被剔除的字段路径（点号连接，顶层即 feature 名） */
function collectRemovedPaths(value, prefix, paths) {
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    const p = prefix ? `${prefix}.${key}` : key;
    if (isEmptyValue(child)) {
      const display = child === '' ? '""' : Array.isArray(child) ? '[]' : 'null';
      paths.push(`${p} (${display})`);
    } else {
      collectRemovedPaths(child, p, paths);
    }
  }
}

const [cleaned, changed] = prune(data);

const removedPaths = [];
collectRemovedPaths(data, '', removedPaths);

console.log(`[migrate-feature-setup-sparse] 目标文件: ${targetPath}`);
if (!changed) {
  console.log('[migrate-feature-setup-sparse] 文件已是稀疏形态，无字段需剔除。');
  console.log('[migrate-feature-setup-sparse] 无需写回（幂等）。');
  process.exit(0);
}

console.log(`\n将剔除的字段路径（${removedPaths.length} 个）:`);
for (const p of removedPaths) {
  console.log(`  - ${p}`);
}

const keptFeatures = Object.keys(cleaned);
console.log(`\n将保留的顶层 feature 配置（${keptFeatures.length} 个）: ${keptFeatures.join(', ')}`);

if (dryRun) {
  console.log('\n[dry-run] 未写入任何文件。');
  process.exit(0);
}

// 备份：不覆盖已有备份，冲突时追加序号
const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
let backupPath = `${targetPath}.bak-${timestamp}`;
let seq = 1;
while (existsSync(backupPath)) {
  backupPath = `${targetPath}.bak-${timestamp}-${seq++}`;
}
copyFileSync(targetPath, backupPath);
console.log(`\n已备份原文件 -> ${backupPath}`);

// 保持 2 空格缩进 + 末尾换行，与现有文件格式一致
writeFileSync(targetPath, JSON.stringify(cleaned, null, 2) + '\n', 'utf8');
console.log('已写入稀疏化结果。');
