import { format } from 'util';

/**
 * Claw 服务端分级日志器（非 agent 运行日志专用）。
 *
 * 边界约定：
 * - agent 运行时内部日志（feature 提供）必须走 claw 日志体系
 *   （agentdev createLogger → DebugHub → Web UI，无头时 stdio fallback），
 *   由 ESLint no-console 强制。
 * - 非 agent 运行的日志（server 进程、脚本等）没有前端显示载体，
 *   console/stdio 是唯一正当通道，本模块为其提供等级与分流纪律：
 *   - 等级：trace/debug/info/warn/error（审计必要前提）
 *   - stdio 分流（AGENTDEV_LOG_STREAM = 'auto' | 'stderr'，默认 auto，
 *     与 agentdev 框架同一契约）：
 *     auto   → trace/debug/info 走 stdout，warn/error 走 stderr
 *     stderr → 全部等级走 stderr（无头模式：stdout 只留给结果输出）
 *   - CLAW_LOG_LEVEL 可过滤冗长度（默认 trace 全量）
 */

const LOG_LEVEL_WEIGHT = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
};

const VALID_LEVELS = new Set(Object.keys(LOG_LEVEL_WEIGHT));

let nextLogId = 1;

function resolveStdioMinLevel() {
  const raw = (process.env.CLAW_LOG_LEVEL || '').trim().toLowerCase();
  return VALID_LEVELS.has(raw) ? raw : 'trace';
}

function resolveStream(level) {
  const mode = (process.env.AGENTDEV_LOG_STREAM || 'auto').trim().toLowerCase();
  if (mode === 'stderr') return process.stderr;
  return level === 'warn' || level === 'error' ? process.stderr : process.stdout;
}

function writeStdio(level, args) {
  const line = format(...args);
  resolveStream(level).write(line + '\n');
}

export function createClawLogger(namespace) {
  const emit = (level) => (message, data) => {
    const entry = {
      id: `srv-log-${Date.now()}-${nextLogId++}`,
      timestamp: Date.now(),
      level,
      namespace,
      message,
      data,
    };
    if (LOG_LEVEL_WEIGHT[level] >= LOG_LEVEL_WEIGHT[resolveStdioMinLevel()]) {
      writeStdio(level, [`[${namespace}] ${message}`, ...(data === undefined ? [] : [data])]);
    }
    return entry;
  };
  return {
    trace: emit('trace'),
    debug: emit('debug'),
    info: emit('info'),
    warn: emit('warn'),
    error: emit('error'),
  };
}
