/**
 * 桥债指标 ratchet（ESM 迁移 plan P0.5）。
 *
 * 静态扫描 public/src/（排除桥实现 kernel-state.js 自身）中的兼容桥调用计数：
 *   registered = KernelState.defineKey( 调用数（桥键注册）
 *   claimed    = KernelState.claim( 调用数（ESM 域模块认领）
 * 选静态扫描而非运行时 stats()：不依赖浏览器加载即可在测试期度量。
 *
 * ratchet 口径：registered 与 claimed 均不得高于基线 .kernel-bridge-baseline.json
 * （{registered, claimed}）。P1 建立期新增兼容键须提供消费面证据，经审核后
 * 显式置 KERNEL_BRIDGE_UPDATE_BASELINE=1 更新基线并在提交说明写明理由。
 * 消费方收敛期即时注销无消费键（删除 defineKey 调用 + delete window.<key>）
 * 并下调基线；不能把建立期基线上调表述为债务下降。
 *
 * 口径独立性（plan 0.5 原文语义）：访问器键本质仍是全局状态，本指标与
 * .frontend-globals-baseline.json 的 state/behavior 两层台账口径独立、双轨
 * 显式统计，防止把桥键在两层口径之间腾挪的口径游戏。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCAN_ROOT = path.join(ROOT, 'public', 'src');
const BRIDGE_IMPL = path.join(SCAN_ROOT, 'modules', 'kernel-state.js');
const BASELINE = path.join(ROOT, '.kernel-bridge-baseline.json');

const CALL_PATTERNS = {
  registered: /KernelState\.defineKey\(/g,
  claimed: /KernelState\.claim\(/g,
};

function listJsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJsFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

function countBridgeCalls() {
  const counts = { registered: 0, claimed: 0 };
  for (const file of listJsFiles(SCAN_ROOT)) {
    // 桥实现自身不算债：它定义协议，不持有任何业务键
    if (path.resolve(file) === BRIDGE_IMPL) continue;
    const source = readFileSync(file, 'utf8');
    for (const [key, pattern] of Object.entries(CALL_PATTERNS)) {
      counts[key] += source.match(pattern)?.length ?? 0;
    }
  }
  return counts;
}

test('桥债 ratchet：defineKey 注册数与 claim 认领数均不得高于基线', () => {
  const counts = countBridgeCalls();
  const update = process.env.KERNEL_BRIDGE_UPDATE_BASELINE === '1';
  if (update || !existsSync(BASELINE)) {
    writeFileSync(BASELINE, JSON.stringify(counts, null, 2) + '\n');
    return;
  }
  const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
  assert.ok(
    counts.registered <= baseline.registered,
    `桥键注册数 ${counts.registered} 超出基线 ${baseline.registered}：新增桥键必须伴随等量注销，` +
      `或显式 KERNEL_BRIDGE_UPDATE_BASELINE=1 更新基线并在提交说明写明理由`,
  );
  assert.ok(
    counts.claimed <= baseline.claimed,
    `桥键认领数 ${counts.claimed} 超出基线 ${baseline.claimed}：认领应随消费方归零即时注销消化，` +
      `确需上调运行 KERNEL_BRIDGE_UPDATE_BASELINE=1 并在提交说明写明理由`,
  );
});
