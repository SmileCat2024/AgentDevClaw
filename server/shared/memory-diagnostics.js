/**
 * 服务进程内存采样器（OOM 崩溃取证）。
 *
 * 背景：2026-10 起主进程多次以 exit 134（V8 heap OOM）退出，dump 只有 pid 与
 * 运行时长，事后无法把崩溃与增长轨迹对上。本模块周期采样 server 自身内存与
 * 常驻结构计数，落 JSONL 文件；下次崩溃后用 dump 头部的 pid/uptime 对表
 * supervisor.log 与本文件即可还原崩溃前的增长曲线。
 *
 * 契约：
 * - 只记录数值与计数，绝不记录对话内容、路径外的标识或凭证；
 * - 磁盘有界：单文件超 maxFileBytes 轮转为 .1（覆盖旧备份），总量 ≤ 2×上限；
 * - 采样与写盘全部 best-effort：任何失败只 warn 一行，绝不影响服务；
 * - 定时器 unref：不阻止进程退出；stop() 返回写队列，可被 shutdown 等待。
 *
 * 环境变量：CLAW_MEM_SAMPLE_MS（采样间隔，0 或负数关闭，缺省 30s）。
 */

import os from 'node:os';
import path from 'node:path';
import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { resolveUserDataDir } from './constants.js';

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;
const MIN_MAX_FILE_BYTES = 4096;

function toMb(bytes) {
  return Math.round((bytes / (1024 * 1024)) * 10) / 10;
}

export function resolveSampleIntervalMs(env = process.env) {
  const raw = Number.parseInt(typeof env.CLAW_MEM_SAMPLE_MS === 'string' ? env.CLAW_MEM_SAMPLE_MS : '', 10);
  return Number.isFinite(raw) ? raw : DEFAULT_INTERVAL_MS;
}

export function createMemorySampler(options = {}) {
  const intervalMs = Number.isFinite(options.intervalMs) ? options.intervalMs : DEFAULT_INTERVAL_MS;
  const logDir = path.resolve(options.logDir || path.join(resolveUserDataDir(), 'logs'));
  const fileName = typeof options.fileName === 'string' && options.fileName ? options.fileName : 'memory-samples.jsonl';
  const maxFileBytes = Math.max(
    MIN_MAX_FILE_BYTES,
    Number.isFinite(options.maxFileBytes) ? options.maxFileBytes : DEFAULT_MAX_FILE_BYTES,
  );
  const counters = typeof options.counters === 'function' ? options.counters : null;
  const filePath = path.join(logDir, fileName);
  const backupPath = `${filePath}.1`;
  const startedAt = Date.now();

  let timer = null;
  let stopped = false;
  let queue = Promise.resolve();

  function collectSnapshot() {
    const mu = process.memoryUsage();
    const record = {
      t: new Date().toISOString(),
      pid: process.pid,
      upMs: Date.now() - startedAt,
      rssMb: toMb(mu.rss),
      heapUsedMb: toMb(mu.heapUsed),
      heapTotalMb: toMb(mu.heapTotal),
      externalMb: toMb(mu.external),
      freeMb: toMb(os.freemem()),
    };
    if (counters) {
      try {
        const counts = counters() || {};
        for (const [key, value] of Object.entries(counts)) {
          if (Number.isFinite(value)) record[key] = value;
        }
      } catch { /* 计数源故障不阻断采样 */ }
    }
    return record;
  }

  async function writeLine(line) {
    await mkdir(logDir, { recursive: true });
    const current = await stat(filePath).catch(() => null);
    if (current && current.size + Buffer.byteLength(line, 'utf8') > maxFileBytes) {
      // rename 在两平台都会覆盖既有目标；轮转失败不阻断追加（文件继续增长到下次成功）
      await rename(filePath, backupPath).catch(() => {});
    }
    await appendFile(filePath, line, 'utf8');
  }

  /** 采样一次并落盘（异步排队，返回写队列便于测试与收尾等待）。 */
  function record() {
    const line = `${JSON.stringify(collectSnapshot())}\n`;
    queue = queue.then(() => writeLine(line)).catch((error) => {
      console.warn('[memory-diagnostics] sample write failed:', error?.message || error);
    });
    return queue;
  }

  return {
    record,
    /** 启动周期采样；立即落一份基线（upMs≈0 的行即实例边界）。间隔 ≤0 视为关闭。 */
    start() {
      if (stopped || timer || intervalMs <= 0) return false;
      record();
      timer = setInterval(() => record(), intervalMs);
      timer.unref?.();
      return true;
    },
    /** 停止采样；返回写队列，调用方可选择 await 排空。 */
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      stopped = true;
      return queue;
    },
    /** 供测试与诊断读取写队列。 */
    flush: () => queue,
    describe: () => ({ intervalMs, logDir, fileName, maxFileBytes, running: timer !== null }),
  };
}
