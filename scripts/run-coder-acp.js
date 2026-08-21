#!/usr/bin/env node
/**
 * coder ACP adapter 入口（ticket 019 / ADR-0004）
 *
 * `claw acp coder`（或直接 `node scripts/run-coder-acp.js`）启动的独立
 * stdio 子进程：ACP v1 协议端点，执行权威全部在 Claw server。
 *
 * 纪律（ADR-0004）：
 *   - 进程内零 @agentdev/* import、零 Agent 实例化；唯一对外依赖是 ACP SDK
 *     与本机 HTTP
 *   - stdout 只承载 JSON-RPC（ndjson，每行可 JSON.parse），日志全走 stderr
 *   - Claw server 是前置运行时：未启动时报错，不自动拉起
 *   - 进程退出 / client 断开仅释放内存映射，不动 Claw 持久化对象
 *
 * 配置（设计 §11）：
 *   CLAW_ACP_BASE_URL            默认 http://127.0.0.1:1420
 *   CLAW_ACP_PROMPT_TIMEOUT_MS   默认 1800000；0 禁用超时
 *   CLAW_ACP_POLL_INTERVAL_MS    默认 500
 */

import { Writable, Readable } from 'node:stream';

import * as acp from '@agentclientprotocol/sdk';

import { createClawClient } from './coder-acp/claw-client.js';
import { createTraceLogger } from './coder-acp/trace.js';
import {
  createSessionManager,
  DEFAULT_PROMPT_TIMEOUT_MS,
  DEFAULT_POLL_INTERVAL_MS,
} from './coder-acp/session-manager.js';
import {
  createAcpAgent,
  createStderrLogger,
  readClawVersion,
  applySessionModesGuard,
} from './coder-acp/main.js';

/** 解析正整数环境变量；0 显式允许（用于「0 = 禁用」语义），非法回退默认。 */
function parseEnvInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return fallback;
  return Math.round(value);
}

const log = createStderrLogger();
const trace = createTraceLogger();

function errorFields(error) {
  return {
    errorName: error?.name,
    errorMessage: error?.message ?? String(error),
    errorCode: error?.code,
  };
}

const config = {
  promptTimeoutMs: parseEnvInt('CLAW_ACP_PROMPT_TIMEOUT_MS', DEFAULT_PROMPT_TIMEOUT_MS),
  pollIntervalMs: parseEnvInt('CLAW_ACP_POLL_INTERVAL_MS', DEFAULT_POLL_INTERVAL_MS),
};

const clawClient = createClawClient({ log, trace });
const sessionManager = createSessionManager({ clawClient, log, trace, ...config });

// stdio → Web streams → ndjson（SDK 是唯一的 stdout 写入者）
const transport = acp.ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin),
);

const connection = createAcpAgent({
  sessionManager,
  log,
  trace,
  version: readClawVersion(),
}).connect(applySessionModesGuard(transport, trace));

// 退出清理（仅内存）：SIGINT/SIGTERM / 连接关闭。Claw session / thread /
// runtime 按 Claw 自身持久化与恢复机制保留（Q12）。
// stdin EOF 不直接 exit：由 connection.closed 驱动（ndjson readable 关闭后
// SDK 会先处理完已入队消息再关闭连接，避免截断 pending 响应）。
let exiting = false;
async function shutdown(reason) {
  if (exiting) return;
  exiting = true;
  trace.record('adapter.shutdown', { reason, activeSessions: sessionManager.size });
  sessionManager.dispose();
  log.info(`adapter exiting: ${reason}`);
  await trace.close();
  try {
    connection.close();
  } catch {
    // 连接已关闭时忽略
  }
  // 不调用 process.exit：连接关闭后事件循环自然终止（Windows 上
  // process.exit 会与异步 stdout / keep-alive socket 竞态触发 fail-fast
  // 0xC0000409，实测自然退出干净且不挂句柄）
}

process.on('SIGINT', () => { void shutdown('SIGINT'); });
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('uncaughtException', (error) => {
  trace.record('adapter.uncaught_exception', { ...errorFields(error) }, { level: 'error' });
  throw error;
});
process.on('unhandledRejection', (reason) => {
  trace.record('adapter.unhandled_rejection', { ...errorFields(reason) }, { level: 'error' });
  throw reason;
});
void connection.closed.then(() => shutdown('connection closed'));

log.info(
  `coder ACP adapter started (base=${clawClient.baseUrl}, poll=${config.pollIntervalMs}ms, `
  + `promptTimeout=${config.promptTimeoutMs === 0 ? 'disabled' : `${config.promptTimeoutMs}ms`})`,
);
