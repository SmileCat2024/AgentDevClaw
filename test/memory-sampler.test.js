/**
 * memory-diagnostics 采样器测试。
 *
 * 契约（每条测试对应的可观察行为）：
 * 1. record() 向指定 JSONL 追加一行，含时间/pid/内存字段，计数函数的数值并入；
 * 2. 计数源抛错不阻断采样（行仍写出，只是缺计数键）；
 * 3. 活动文件超上限时轮转为 .1，两文件均有界；
 * 4. 间隔 ≤0 时 start() 拒绝启动且不产生文件（关闭语义）；
 * 5. start() 立即落基线（实例边界可见），stop() 停止并排空写队列。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMemorySampler, resolveSampleIntervalMs } from '../server/shared/memory-diagnostics.js';

function tempLogDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `claw-mem-diag-${label}-`));
}

test('record appends one JSONL line with memory fields and merged counters', async () => {
  const dir = tempLogDir('line');
  const sampler = createMemorySampler({ logDir: dir, counters: () => ({ runtimes: 3 }) });
  await sampler.record();
  await sampler.flush();
  const filePath = path.join(dir, 'memory-samples.jsonl');
  const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0]);
  assert.ok(!Number.isNaN(Date.parse(record.t)), 't 必须是可解析时间');
  assert.equal(record.pid, process.pid);
  assert.ok(record.rssMb > 0, 'rssMb 必须为正');
  assert.ok(record.heapUsedMb > 0, 'heapUsedMb 必须为正');
  assert.ok(record.upMs >= 0);
  assert.equal(record.runtimes, 3, '计数函数的数值键必须并入采样行');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a throwing counters source never breaks sampling', async () => {
  const dir = tempLogDir('throw');
  const sampler = createMemorySampler({ logDir: dir, counters: () => { throw new Error('boom'); } });
  await sampler.record();
  await sampler.flush();
  const lines = fs.readFileSync(path.join(dir, 'memory-samples.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0]);
  assert.equal(record.pid, process.pid);
  assert.equal(record.runtimes, undefined, '失败的计数键不得写入');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('active file rotates to .1 when exceeding maxFileBytes', async () => {
  const dir = tempLogDir('rotate');
  const maxFileBytes = 4096; // 模块强制下限即 4096
  const sampler = createMemorySampler({ logDir: dir, maxFileBytes });
  // 单行约 200B；写到总量超限必然触发至少一次轮转
  for (let i = 0; i < 30; i += 1) await sampler.record();
  await sampler.flush();
  const active = path.join(dir, 'memory-samples.jsonl');
  const backup = `${active}.1`;
  assert.ok(fs.existsSync(backup), '超限后必须存在 .1 轮转备份');
  const backupSize = fs.statSync(backup).size;
  const activeSize = fs.statSync(active).size;
  assert.ok(backupSize > 0 && backupSize <= maxFileBytes, `备份有界（实际 ${backupSize}）`);
  assert.ok(activeSize > 0 && activeSize <= maxFileBytes + 512, `活动文件重新起算（实际 ${activeSize}）`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('interval <= 0 disables sampling and writes nothing', () => {
  const dir = tempLogDir('off');
  const sampler = createMemorySampler({ logDir: dir, intervalMs: 0 });
  assert.equal(sampler.start(), false, '关闭语义下 start 必须拒绝');
  assert.equal(sampler.describe().running, false);
  assert.equal(fs.existsSync(path.join(dir, 'memory-samples.jsonl')), false, '不得产生文件');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('start writes an immediate baseline and stop drains the queue', async () => {
  const dir = tempLogDir('cycle');
  const sampler = createMemorySampler({ logDir: dir, intervalMs: 60_000 });
  assert.equal(sampler.start(), true);
  assert.equal(sampler.describe().running, true);
  await sampler.stop();
  const lines = fs.readFileSync(path.join(dir, 'memory-samples.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1, 'start 立即落一行基线');
  const record = JSON.parse(lines[0]);
  assert.ok(record.upMs < 5_000, '基线行 upMs 应接近 0（实例边界）');
  assert.equal(sampler.describe().running, false, 'stop 后不再运行');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('resolveSampleIntervalMs honours explicit zero and falls back on garbage', () => {
  assert.equal(resolveSampleIntervalMs({ CLAW_MEM_SAMPLE_MS: '0' }), 0, '显式 0 = 关闭');
  assert.equal(resolveSampleIntervalMs({ CLAW_MEM_SAMPLE_MS: '5000' }), 5000);
  assert.equal(resolveSampleIntervalMs({}), 30_000, '缺省 30s');
  assert.equal(resolveSampleIntervalMs({ CLAW_MEM_SAMPLE_MS: 'garbage' }), 30_000, '非法值回退缺省');
});
