/**
 * Thread Controller — 工作线程控制面（唯一入口）
 *
 * 线程定位（悬置地基）：一个稳定、可寻址的连续性锚点——把一组先后
 * 接力的 Session 认定为同一项进行中的工作，并负责把「之后要做什么」
 * 送到当前承接的 Session。
 *
 * 本层只处理四件事：
 *   1. 当前承接会话（head）是谁；
 *   2. Session 更替（advanceHead）时连续性如何不丢；
 *   3. 更替 / 重启期间新指令如何不丢（appendCommand / deliver）；
 *   4. 对线程的取消等状态迁移。
 *
 * 不处理：任务验收、Issue 语义、自动循环、PR 等上层产品规则。
 *
 * 后续任何「继续一项跨 Session 工作」的代码都应经由本 controller，
 * 不得各自实现 successor 切换与指令迁移。
 */

import {
  ThreadStore,
  ThreadNotFoundError,
  generateThreadId,
} from './thread-store.js';
import {
  createCommandRecord,
  appendCommand,
  pendingCommands,
  findCommand,
  pruneCommands,
  ThreadCommandKind,
  ThreadCommandStatus,
} from './thread-inbox.js';
import { ThreadRuntimeBridge } from './thread-runtime-bridge.js';
import { THREADS_ROOT } from '../shared/constants.js';
import { cleanSessionText } from '../shared/string-helpers.js';

export { ThreadNotFoundError };

export const THREAD_MODES = new Set(['interactive', 'autonomous']);
export const THREAD_STATUSES = new Set(['active', 'completed', 'cancelled', 'blocked']);
export const THREAD_COMMAND_KINDS = new Set(Object.values(ThreadCommandKind));

const VALID_ID_RE = /^[\w.-]{1,200}$/;

function _validateId(value, label) {
  const id = String(value || '').trim();
  if (!VALID_ID_RE.test(id)) {
    throw Object.assign(new Error(`Invalid ${label}: ${JSON.stringify(String(value || ''))}`), {
      code: 'invalid_request',
      status: 400,
    });
  }
  return id;
}

function _pickEnum(value, allowed, fallback) {
  const v = String(value || '').trim();
  return allowed.has(v) ? v : fallback;
}

export class ThreadController {
  /**
   * @param {object} options
   * @param {ThreadStore} options.store
   * @param {ThreadRuntimeBridge} options.bridge
   */
  constructor({ store, bridge } = {}) {
    this.store = store;
    this.bridge = bridge || new ThreadRuntimeBridge();
  }

  // ── 查询 ─────────────────────────────────────────────────────────

  async listThreads({ agentId } = {}) {
    const entries = await this.store.list();
    const normalized = String(agentId || '').trim();
    return normalized ? entries.filter((t) => t.agentId === normalized) : entries;
  }

  async getThread(threadId) {
    const record = await this.store.get(threadId);
    return record;
  }

  // ── 创建 ─────────────────────────────────────────────────────────

  /**
   * 创建线程。sessionId 成为 root 与初始 head。
   */
  async createThread({ agentId, sessionId, title = '', mode = 'interactive', workspaceId = '' } = {}) {
    const normalizedAgentId = _validateId(agentId, 'agentId');
    const normalizedSessionId = _validateId(sessionId, 'sessionId');
    const normalizedMode = _pickEnum(mode, THREAD_MODES, 'interactive');

    const now = Date.now();
    const record = {
      threadId: generateThreadId(),
      agentId: normalizedAgentId,
      workspaceId: cleanSessionText(workspaceId) || normalizedAgentId,
      title: cleanSessionText(title),
      mode: normalizedMode,
      status: 'active',
      rootSessionId: normalizedSessionId,
      headSessionId: normalizedSessionId,
      sessionChain: [
        {
          sessionId: normalizedSessionId,
          role: 'head',
          startedAt: now,
          endedAt: null,
          endKind: null,
          successorSessionId: null,
        },
      ],
      commands: [],
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };

    return this.store.create(record);
  }

  // ── 指令（Thread Inbox）──────────────────────────────────────────

  /**
   * 幂等追加一条线程指令。
   *
   * @returns {Promise<{command: object, duplicate: boolean, threadRevision: number}>}
   */
  async appendCommand({ threadId, kind, text, source = 'ui', idempotencyKey = '' } = {}) {
    _validateId(threadId, 'threadId');
    const normalizedKind = _pickEnum(kind, THREAD_COMMAND_KINDS, ThreadCommandKind.USER_MESSAGE);
    const normalizedText = String(text || '');
    if (!normalizedText.trim()) {
      throw Object.assign(new Error('Command text must be non-empty'), {
        code: 'invalid_request',
        status: 400,
      });
    }
    if (normalizedText.length > 100_000) {
      throw Object.assign(new Error('Command text too large'), {
        code: 'invalid_request',
        status: 400,
      });
    }

    const command = createCommandRecord({
      threadId,
      kind: normalizedKind,
      text: normalizedText,
      source: cleanSessionText(source) || 'ui',
      idempotencyKey: cleanSessionText(idempotencyKey),
    });

    let appendOutcome = { command, duplicate: false };
    const { record } = await this.store.update(threadId, (draft) => {
      appendOutcome = appendCommand(draft, command);
      pruneCommands(draft);
      return draft;
    });

    return {
      command: appendOutcome.command,
      duplicate: appendOutcome.duplicate,
      threadRevision: record.revision,
    };
  }

  /**
   * 取消一条尚未投递的指令（pending → cancelled）。
   */
  async cancelCommand(threadId, commandId) {
    _validateId(threadId, 'threadId');
    _validateId(commandId, 'commandId');
    const { record } = await this.store.update(threadId, (draft) => {
      const command = findCommand(draft, commandId);
      if (command && command.status === ThreadCommandStatus.PENDING) {
        command.status = ThreadCommandStatus.CANCELLED;
        command.updatedAt = Date.now();
      }
      return draft;
    });
    return findCommand(record, commandId);
  }

  /**
   * 尝试把 pending 指令下沉到当前 head runtime。
   *
   * 休眠地基下 bridge 默认禁用：返回 { attempted: 0, reason: 'bridge_disabled' }，
   * 指令保持 pending。链路启用后按序投递；遇到不可重试原因标记单条 failed。
   *
   * @returns {Promise<{attempted: number, delivered: number, reason?: string, results: Array}>}
   */
  async deliverPendingCommands(threadId) {
    _validateId(threadId, 'threadId');

    const thread = await this.store.get(threadId);
    if (!thread) throw new ThreadNotFoundError(threadId);
    if (thread.status !== 'active') {
      return { attempted: 0, delivered: 0, reason: 'thread_not_active', results: [] };
    }

    const pending = pendingCommands(thread);
    if (pending.length === 0) {
      return { attempted: 0, delivered: 0, results: [] };
    }

    if (!this.bridge.isEnabled()) {
      return { attempted: 0, delivered: 0, reason: 'bridge_disabled', results: [] };
    }

    const results = [];
    let deliveredCount = 0;
    let stopReason = null;

    for (const command of pending) {
      const outcome = await this.bridge.deliver({ thread, command });
      results.push({ commandId: command.commandId, ...outcome });

      if (outcome.accepted) {
        deliveredCount += 1;
      } else if (outcome.retryable) {
        stopReason = outcome.reason;
        break;
      }
    }

    const deliveredIds = new Set(
      results.filter((r) => r.accepted).map((r) => r.commandId),
    );
    const failedResults = new Map(
      results.filter((r) => !r.accepted && r.retryable === false).map((r) => [r.commandId, r.reason]),
    );

    if (deliveredIds.size > 0 || failedResults.size > 0) {
      const { record } = await this.store.update(threadId, (draft) => {
        for (const c of draft.commands || []) {
          if (deliveredIds.has(c.commandId)) {
            c.status = ThreadCommandStatus.DELIVERED;
            c.envelopeId = results.find((r) => r.commandId === c.commandId)?.envelopeId || null;
            c.attempts = (Number(c.attempts) || 0) + 1;
            c.updatedAt = Date.now();
            c.deliveredAt = Date.now();
            c.lastReason = null;
          } else if (failedResults.has(c.commandId)) {
            c.status = ThreadCommandStatus.FAILED;
            c.lastReason = failedResults.get(c.commandId);
            c.attempts = (Number(c.attempts) || 0) + 1;
            c.updatedAt = Date.now();
          }
        }
        return draft;
      });
      thread.revision = record.revision;
    }

    return {
      attempted: results.length,
      delivered: deliveredCount,
      reason: stopReason,
      results,
    };
  }

  // ── 会话接力（head 推进）────────────────────────────────────────

  /**
   * 推进线程 head：headSessionId: fromSessionId → toSessionId。
   *
   * 关键不变量（与 store 原子写共同保证）：任一时刻线程要么明确指向
   * 旧 head，要么明确指向新 head；推进与指令状态在同一次落盘中变更。
   *
   * @param {object} params
   * @param {string} params.threadId
   * @param {string} params.toSessionId - 新承接会话（successor）
   * @param {string} [params.fromSessionId] - 期望的当前 head（防错投）
   * @param {number} [params.expectedRevision] - 乐观并发检查
   * @param {string} [params.endKind] - 旧 head 的结束原因（manual / context_rotation / restart …）
   */
  async advanceHead({ threadId, toSessionId, fromSessionId, expectedRevision, endKind = 'manual' } = {}) {
    _validateId(threadId, 'threadId');
    const normalizedTo = _validateId(toSessionId, 'toSessionId');
    const normalizedFrom = fromSessionId ? _validateId(fromSessionId, 'fromSessionId') : null;

    const { record } = await this.store.update(
      threadId,
      (draft) => {
        if (draft.status !== 'active') {
          throw Object.assign(new Error(`Thread "${threadId}" is not active (status: ${draft.status})`), {
            code: 'thread_not_active',
            status: 409,
          });
        }
        if (normalizedFrom && draft.headSessionId !== normalizedFrom) {
          throw Object.assign(
            new Error(
              `Head mismatch on thread "${threadId}": expected ${normalizedFrom}, current ${draft.headSessionId}`,
            ),
            { code: 'head_mismatch', status: 409 },
          );
        }
        if (draft.headSessionId === normalizedTo) {
          throw Object.assign(new Error(`Session "${normalizedTo}" is already the head of thread "${threadId}"`), {
            code: 'already_head',
            status: 409,
          });
        }
        if ((draft.sessionChain || []).some((entry) => entry.sessionId === normalizedTo)) {
          throw Object.assign(
            new Error(`Session "${normalizedTo}" already appears in the chain of thread "${threadId}"`),
            { code: 'duplicate_session', status: 409 },
          );
        }

        const now = Date.now();
        const currentHead = (draft.sessionChain || []).find(
          (entry) => entry.sessionId === draft.headSessionId,
        );
        if (currentHead) {
          currentHead.role = 'predecessor';
          currentHead.endedAt = now;
          currentHead.endKind = cleanSessionText(endKind) || 'manual';
          currentHead.successorSessionId = normalizedTo;
        }
        draft.sessionChain = draft.sessionChain || [];
        draft.sessionChain.push({
          sessionId: normalizedTo,
          role: 'head',
          startedAt: now,
          endedAt: null,
          endKind: null,
          successorSessionId: null,
        });
        draft.headSessionId = normalizedTo;
        return draft;
      },
      { expectedRevision: Number.isInteger(expectedRevision) ? expectedRevision : undefined },
    );

    return record;
  }

  // ── 状态迁移 ─────────────────────────────────────────────────────

  /**
   * 取消线程：active → cancelled；pending 指令一并取消（意图不再投递）。
   */
  async cancelThread(threadId, { reason = '' } = {}) {
    _validateId(threadId, 'threadId');
    const { record } = await this.store.update(threadId, (draft) => {
      if (draft.status === 'active') {
        draft.status = 'cancelled';
        draft.cancelledAt = Date.now();
        draft.cancelReason = cleanSessionText(reason);
      }
      const now = Date.now();
      for (const c of draft.commands || []) {
        if (c.status === ThreadCommandStatus.PENDING) {
          c.status = ThreadCommandStatus.CANCELLED;
          c.lastReason = 'thread_cancelled';
          c.updatedAt = now;
        }
      }
      return draft;
    });
    return record;
  }
}

// ── 默认单例（server.js 装配）────────────────────────────────────

let _defaultController = null;

/**
 * 默认 controller：数据落 USER_DATA_ROOT/threads，bridge 默认休眠。
 */
export function getThreadController() {
  if (!_defaultController) {
    _defaultController = new ThreadController({
      store: new ThreadStore({ rootDir: THREADS_ROOT }),
      bridge: new ThreadRuntimeBridge({ enabled: false }),
    });
  }
  return _defaultController;
}
