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

/**
 * 平台进程专属 env：只作用于 Claw server 进程自身，禁止泄漏给 spawn 出的
 * agent runtime（ADR-0037）：
 * - AGENTDEV_VIEWER_ADDR：ViewerWorker TCP 控制监听地址。托管 runtime 固定
 *   走 UDS（agent-startup 显式注入 AGENTDEV_UDS_PATH），且 DebugHub 中 TCP
 *   地址优先于 UDS 路径，泄漏会把托管连接整体切到 TCP。
 * - AGENTDEV_VIEWER_ORIGIN：HTTP 面完整 origin，面向外部（容器/远程）runtime
 *   的部署配置。托管本地 runtime 固定回环 + 注入端口（AGENTDEV_VIEWER_PORT），
 *   该 origin 从平台视角书写，对同机 runtime 可能不可达，泄漏会破坏托管
 *   dequeue。
 */
const PLATFORM_ONLY_ENV_KEYS = [
  'AGENTDEV_VIEWER_ADDR',
  'AGENTDEV_VIEWER_ORIGIN',
];

export function sanitizeSpawnEnv(inputEnv) {
  return Object.fromEntries(
    Object.entries(inputEnv || {}).filter(([key, value]) => {
      return typeof key === 'string' && key.length > 0 && value != null;
    }).map(([key, value]) => [key, String(value)])
  );
}

/**
 * Returns a shallow copy of process.env with stripped vars:
 * - per-session env vars: must only be passed via explicit extraEnv to prevent
 *   leakage when the server itself was started from a runtime that carried them;
 * - platform-only env vars: they configure this server process itself and must
 *   never reach spawned agent runtimes (hosted runtimes stay on UDS).
 */
export function childProcessEnv(env = process.env) {
  const copy = { ...env };
  for (const key of [...PER_SESSION_ENV_KEYS, ...PLATFORM_ONLY_ENV_KEYS]) {
    delete copy[key];
  }
  return copy;
}
