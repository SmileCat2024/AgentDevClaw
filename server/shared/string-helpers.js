import path from 'path';
import os from 'os';
import { WORKSPACE_SESSION_AGENT_IDS } from './constants.js';
import { createClawLogger } from './claw-logger.js';

export function sanitizeSessionFragment(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'default';
}

export function cleanSessionText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 检测文本中是否含 Unicode 替换字符（U+FFFD）。正常用户输入几乎不会
 * 有意包含它；出现即意味着字节在某处经历了错误的编码转换——典型场景：
 * 原生 exe（如 curl.exe）在非 UTF-8 代码页（zh-CN Windows 为 GBK）的
 * 控制台下被 MSYS bash 按 ANSI 转码参数后提交的文本。此类内容入库即
 * 是脏数据（部分 GBK 字节对恰好构成合法 UTF-8 双字节序列，混入异形
 * 字符），在入口直接拒绝。
 */
export function containsReplacementChar(value) {
  return typeof value === 'string' && value.includes('\uFFFD');
}

export function isWorkspaceSessionAgent(agentId) {
  return WORKSPACE_SESSION_AGENT_IDS.has(sanitizeSessionFragment(agentId));
}

// 兼容包装：旧 stream 语义映射到统一日志等级。
// info/debug/trace → stdout，warn/error → stderr（审计分流契约）。
const STREAM_TO_LEVEL = {
  log: 'info',
  info: 'info',
  trace: 'trace',
  debug: 'debug',
  warn: 'warn',
  error: 'error',
};

const prefixLoggers = new Map();

export function log(prefix, message, stream = 'log') {
  const level = STREAM_TO_LEVEL[stream] || 'info';
  let logger = prefixLoggers.get(prefix);
  if (!logger) {
    logger = createClawLogger(prefix);
    prefixLoggers.set(prefix, logger);
  }
  logger[level](message);
}

export function getAssemblyWorkspaceDir(assemblyName) {
  return path.join(os.homedir(), '.agentdev', 'agent-dev', sanitizeSessionFragment(assemblyName));
}

export function normalizeClientAgentId(value, fallback = '') {
  const text = cleanSessionText(value);
  if (!text) return fallback;
  const lower = text.toLowerCase();
  if (lower === 'null' || lower === 'undefined') return fallback;
  return sanitizeSessionFragment(text);
}

export function parseListField(value) {
  return String(value || '')
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

const PER_SESSION_ENV_KEYS = [
  'PROTOCLAW_HANDOFF_PATH',
  'PROTOCLAW_HANDOFF_PAYLOAD',
];

export function sanitizeSpawnEnv(inputEnv) {
  return Object.fromEntries(
    Object.entries(inputEnv || {}).filter(([key, value]) => {
      return typeof key === 'string' && key.length > 0 && value != null;
    }).map(([key, value]) => [key, String(value)])
  );
}

/**
 * Returns a shallow copy of process.env with per-session env vars stripped.
 * These vars must only be passed via explicit extraEnv to prevent leakage
 * when the server itself was started from a runtime that carried them.
 */
export function childProcessEnv(env = process.env) {
  const copy = { ...env };
  for (const key of PER_SESSION_ENV_KEYS) delete copy[key];
  return copy;
}
