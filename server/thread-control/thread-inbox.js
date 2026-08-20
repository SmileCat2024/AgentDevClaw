/**
 * Thread Inbox — 线程级待投递指令（纯函数层）
 *
 * 语义定位：这条指令属于某项连续工作（thread），而不属于某个可能被
 * 替换的 runtime。指令先持久化（pending），由 controller 在当前承接
 * 会话可用时经 bridge 下沉为 runtime envelope（delivered）。
 *
 * 本模块不持有状态、不做 IO；所有操作作用于 thread record 的
 * `commands` 数组，由 ThreadStore 的原子写保证持久化。
 *
 * 不承诺 LLM 副作用 exactly-once：只承诺命令身份持久化 + 幂等入队 +
 * 可追踪的投递状态。真实世界副作用由新会话核对现实状态后继续。
 */

import { randomUUID } from 'crypto';

export const ThreadCommandStatus = Object.freeze({
  PENDING:   'pending',
  IN_FLIGHT: 'in_flight',
  DELIVERED: 'delivered',
  FAILED:    'failed',
  CANCELLED: 'cancelled',
});

const TERMINAL_STATUSES = new Set([
  ThreadCommandStatus.DELIVERED,
  ThreadCommandStatus.FAILED,
  ThreadCommandStatus.CANCELLED,
]);

export const ThreadCommandKind = Object.freeze({
  USER_MESSAGE:        'user_message',
  SYSTEM_CONTINUATION: 'system_continuation',
  EXTERNAL:            'external',
});

/** 终态指令保留上限（超出按时间裁剪，防止 commands 无限增长） */
export const MAX_RETAINED_TERMINAL_COMMANDS = 200;

export function generateCommandId() {
  return `cmd-${randomUUID()}`;
}

/**
 * 构造新指令记录（不修改 thread record）。
 */
export function createCommandRecord({ threadId, kind, text, source, idempotencyKey }) {
  const now = Date.now();
  return {
    commandId: generateCommandId(),
    threadId: threadId || '',
    kind: kind || ThreadCommandKind.USER_MESSAGE,
    text: typeof text === 'string' ? text : '',
    source: source || 'ui',
    idempotencyKey: idempotencyKey || '',
    status: ThreadCommandStatus.PENDING,
    attempts: 0,
    envelopeId: null,
    lastReason: null,
    createdAt: now,
    updatedAt: now,
    deliveredAt: null,
  };
}

/**
 * 幂等追加指令。若 idempotencyKey 命中既有的 pending / in_flight /
 * delivered 指令，直接返回既有指令（重复提交不产生副作用）。
 *
 * @returns {{command: object, duplicate: boolean}}
 */
export function appendCommand(record, command) {
  const commands = Array.isArray(record.commands) ? record.commands : [];
  record.commands = commands;

  if (command.idempotencyKey) {
    const existing = commands.find(
      (c) =>
        c.idempotencyKey === command.idempotencyKey &&
        (c.status === ThreadCommandStatus.PENDING ||
          c.status === ThreadCommandStatus.IN_FLIGHT ||
          c.status === ThreadCommandStatus.DELIVERED),
    );
    if (existing) {
      return { command: existing, duplicate: true };
    }
  }

  commands.push(command);
  return { command, duplicate: false };
}

/**
 * 按 createdAt + commandId 稳定排序的 pending 指令。
 */
export function pendingCommands(record) {
  const commands = Array.isArray(record?.commands) ? record.commands : [];
  return commands
    .filter((c) => c?.status === ThreadCommandStatus.PENDING)
    .sort((a, b) => (a.createdAt - b.createdAt) || (a.commandId < b.commandId ? -1 : 1));
}

export function findCommand(record, commandId) {
  const commands = Array.isArray(record?.commands) ? record.commands : [];
  return commands.find((c) => c?.commandId === commandId) || null;
}

/**
 * 裁剪终态指令，保留最近 MAX_RETAINED_TERMINAL_COMMANDS 条。
 * pending / in_flight 永不裁剪。
 */
export function pruneCommands(record, maxRetained = MAX_RETAINED_TERMINAL_COMMANDS) {
  const commands = Array.isArray(record?.commands) ? record.commands : [];
  const terminal = commands.filter((c) => TERMINAL_STATUSES.has(c?.status));
  if (terminal.length <= maxRetained) return false;

  const dropSet = new Set(
    terminal
      .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0))
      .slice(maxRetained)
      .map((c) => c.commandId),
  );
  record.commands = commands.filter((c) => !dropSet.has(c.commandId));
  return true;
}
