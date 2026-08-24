/**
 * ACP 协议层 — 请求校验、响应构造、错误 taxonomy（ticket 019）
 *
 * 设计文档 §4.0：
 *   -32602  参数非法（非 text block / mcpServers 非空 / additionalDirectories
 *           非空 / sessionModes 非空 / 未知 sessionId），data 字段级说明
 *   -32000  CLAW_SERVER_UNREACHABLE（Claw server 未启动 / 连接失败）
 *   -32001  SESSION_BUSY（该 session 已有 active prompt），data 当前 prompt 代数
 *   -32002  PROMPT_TIMEOUT（等待终态超时，不自动 interrupt），data { waitedMs }
 *   -32003  CLAW_ERROR（server 返回业务错误），透传 server 错误体
 *
 * AcpError 继承 SDK RequestError：handler 抛出后由 SDK 连接层直接转为
 * JSON-RPC error 响应（非 RequestError 的普通 Error 会被映射为 -32603）。
 */

import { RequestError } from '@agentclientprotocol/sdk';

export const ERROR_CODES = {
  INVALID_PARAMS: -32602,
  CLAW_SERVER_UNREACHABLE: -32000,
  SESSION_BUSY: -32001,
  PROMPT_TIMEOUT: -32002,
  CLAW_ERROR: -32003,
};

export class AcpError extends RequestError {
  /**
   * @param {number} code JSON-RPC error code（见 ERROR_CODES）
   * @param {string} message
   * @param {unknown} [data]
   */
  constructor(code, message, data) {
    super(code, message, data);
    this.name = 'AcpError';
  }
}

/** 参数非法（-32602），data 携带字段级说明。 */
export function invalidParamsError(field, message) {
  return new AcpError(
    ERROR_CODES.INVALID_PARAMS,
    `Invalid params: ${message}`,
    { field, message },
  );
}

/** Claw server 不可达（-32000）。 */
export function clawUnreachableError(cause) {
  return new AcpError(
    ERROR_CODES.CLAW_SERVER_UNREACHABLE,
    `Claw server unreachable: ${cause instanceof Error ? cause.message : String(cause)}`,
    { code: 'CLAW_SERVER_UNREACHABLE', hint: '先启动 Claw server（npm start）' },
  );
}

/** 该 session 已有 active prompt（-32001），data 携带当前 prompt 代数。 */
export function sessionBusyError(generation) {
  return new AcpError(
    ERROR_CODES.SESSION_BUSY,
    'Session busy: another prompt is still active for this session',
    { code: 'SESSION_BUSY', generation },
  );
}

/** prompt 终态等待超时（-32002）。不自动 interrupt。 */
export function promptTimeoutError(waitedMs) {
  return new AcpError(
    ERROR_CODES.PROMPT_TIMEOUT,
    `Prompt timed out after ${waitedMs}ms waiting for a terminal turn event`,
    { code: 'PROMPT_TIMEOUT', waitedMs },
  );
}

/**
 * Claw server 返回业务错误（-32003），data 透传 server 错误体。
 * @param {number} status HTTP 状态码
 * @param {object|null} body server 错误响应体（{ ok, code, message, ... }）
 */
export function clawServerError(status, body) {
  const message = body?.message || `Claw server returned ${status}`;
  return new AcpError(
    ERROR_CODES.CLAW_ERROR,
    `Claw error: ${message}`,
    { code: 'CLAW_ERROR', status, ...(body && typeof body === 'object' ? { server: body } : {}) },
  );
}

// ── 请求校验 ────────────────────────────────────────────────────────

/**
 * session/new 参数校验（设计 §4.2）。
 *
 * cwd：必填字符串，原样交 server 校验（存在且为目录由 server 判定）；
 * mcpServers：非空一律拒绝（SDK schema 缺省时填 []，协议语义等价于显式空数组）；
 * additionalDirectories：非空拒绝。
 * sessionModes 不在 ACP v1 正式版 NewSessionRequest schema 中，SDK zod 会
 * strip 掉该字段——由 `guardSessionModesMessage` 在消息层拦截（见下）。
 *
 * @returns {{ cwd: string }}
 */
export function validateNewSessionParams(params) {
  const cwd = params?.cwd;
  if (typeof cwd !== 'string' || cwd.trim() === '') {
    throw invalidParamsError('cwd', 'cwd must be a non-empty string');
  }
  if (Array.isArray(params.mcpServers) && params.mcpServers.length > 0) {
    throw invalidParamsError(
      'mcpServers',
      'mcpServers must be an empty array; MCP is not supported by this agent',
    );
  }
  if (Array.isArray(params.additionalDirectories) && params.additionalDirectories.length > 0) {
    throw invalidParamsError(
      'additionalDirectories',
      'additionalDirectories must be empty; additional directories are not supported',
    );
  }
  return { cwd };
}

/**
 * session/resume 参数校验（协议 v1 正式方法）。
 *
 * sessionId：必填非空字符串（即 client 记录的 Claw sessionId）；
 * cwd：可选；提供时必须为字符串（存在性 / 与持久化记录的一致性由 server
 *      校验，不一致返回 -32003 cwd_mismatch）；
 * mcpServers / additionalDirectories：与 session/new 同语义，非空一律拒绝。
 *
 * @returns {{ sessionId: string, cwd?: string }}
 */
export function validateResumeSessionParams(params) {
  const sessionId = params?.sessionId;
  if (typeof sessionId !== 'string' || sessionId.trim() === '') {
    throw invalidParamsError('sessionId', 'sessionId must be a non-empty string');
  }
  const cwd = params?.cwd;
  if (cwd !== undefined && typeof cwd !== 'string') {
    throw invalidParamsError('cwd', 'cwd must be a string when provided');
  }
  if (Array.isArray(params.mcpServers) && params.mcpServers.length > 0) {
    throw invalidParamsError(
      'mcpServers',
      'mcpServers must be an empty array; MCP is not supported by this agent',
    );
  }
  if (Array.isArray(params.additionalDirectories) && params.additionalDirectories.length > 0) {
    throw invalidParamsError(
      'additionalDirectories',
      'additionalDirectories must be empty; additional directories are not supported',
    );
  }
  return { sessionId: sessionId.trim(), ...(cwd !== undefined ? { cwd } : {}) };
}

/**
 * session/load 参数校验（协议 v1 正式方法，带历史回放）。
 *
 * 校验规则与 resume 同构：sessionId 必填非空字符串；cwd 可选字符串
 * （一致性与存在性由 server 校验）；mcpServers / additionalDirectories
 * 非空一律拒绝。
 *
 * @returns {{ sessionId: string, cwd?: string }}
 */
export function validateLoadSessionParams(params) {
  const sessionId = params?.sessionId;
  if (typeof sessionId !== 'string' || sessionId.trim() === '') {
    throw invalidParamsError('sessionId', 'sessionId must be a non-empty string');
  }
  const cwd = params?.cwd;
  if (cwd !== undefined && typeof cwd !== 'string') {
    throw invalidParamsError('cwd', 'cwd must be a string when provided');
  }
  if (Array.isArray(params.mcpServers) && params.mcpServers.length > 0) {
    throw invalidParamsError(
      'mcpServers',
      'mcpServers must be an empty array; MCP is not supported by this agent',
    );
  }
  if (Array.isArray(params.additionalDirectories) && params.additionalDirectories.length > 0) {
    throw invalidParamsError(
      'additionalDirectories',
      'additionalDirectories must be empty; additional directories are not supported',
    );
  }
  return { sessionId: sessionId.trim(), ...(cwd !== undefined ? { cwd } : {}) };
}

/**
 * session/prompt 输入规则（设计 §4.3）：prompt[] 仅允许 type: "text" 的
 * block，多块按顺序合并为一条消息（\n\n 连接）。image / resource /
 * resource_link / context 等非文本 block 一律拒绝。
 *
 * @param {Array<{type: string}>} prompt
 * @returns {string} 合并后的文本
 */
export function mergePromptText(prompt) {
  if (!Array.isArray(prompt) || prompt.length === 0) {
    throw invalidParamsError('prompt', 'prompt must be a non-empty array of content blocks');
  }
  const texts = [];
  for (const block of prompt) {
    if (block?.type !== 'text') {
      throw invalidParamsError(
        'prompt',
        `unsupported content block type "${block?.type}"; only text blocks are accepted`,
      );
    }
    if (typeof block.text !== 'string') {
      throw invalidParamsError('prompt', 'text block is missing its text field');
    }
    texts.push(block.text);
  }
  return texts.join('\n\n');
}

// ── sessionModes 消息层拦截 ─────────────────────────────────────────

/**
 * `sessionModes` 已不在 ACP v1 正式版 NewSessionRequest schema 中，SDK 的
 * zod parse 会把该未知字段 strip 掉——handler 永远看不到它，无法在方法内
 * 拒绝。因此对 `session/new` 请求在进入 SDK 前做一次薄拦截：非空
 * sessionModes 直接以 -32602 应答并丢弃该消息，其余消息原样放行。
 *
 * @param {object} message ndjson 流上的 JSON-RPC 消息对象
 * @returns {object|null} 若拒绝，返回应写回 client 的 error response；否则 null
 */
export function guardSessionModesMessage(message) {
  if (
    message
    && typeof message === 'object'
    && message.method === 'session/new'
    && message.params
    && typeof message.params === 'object'
    && Array.isArray(message.params.sessionModes)
    && message.params.sessionModes.length > 0
  ) {
    return {
      jsonrpc: '2.0',
      ...(message.id !== undefined ? { id: message.id } : {}),
      error: {
        code: ERROR_CODES.INVALID_PARAMS,
        message: 'Invalid params: sessionModes must be empty; session modes are not supported',
        data: { field: 'sessionModes', message: 'sessionModes must be empty; session modes are not supported' },
      },
    };
  }
  return null;
}
