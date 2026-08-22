/**
 * Session 管理器 — ID 映射、activePrompt 串行约束、取消状态机（ticket 019）
 *
 * 设计 §3 / §6 / §8：
 *   - ACP session 与 Claw session/thread 的映射只存在于 adapter 内存；
 *     adapter 退出 / 断开仅释放内存（dispose），不动任何 Claw 持久化对象
 *   - 一 ACP session 一 active prompt（Q9）：并发 prompt → -32001，不排队
 *   - 双层取消汇流：session/cancel 通知与 $/cancel_request（ctx.signal）
 *     进入同一 cancel()；每次取消只调一次 interrupt（018 路由）
 *   - 终态判定只看事件流（turn.completed / turn.failed / turn.cancelled），
 *     不看看板状态；turn <= baseline.maxTurn 的终态视为旧事件回放，仅告警
 *
 * prompt 执行管线（设计 §6）：
 *   基线捕获（cursor + knownEventIds + maxTurn）
 *   → POST threads/:id/commands（source: "acp" + idempotencyKey）
 *   → 轮询 GET threads/:id/events?after=cursor
 *   → 新事件经 event-mapper 映射为 session/update
 *   → 终态 → PromptResponse
 */

import { randomUUID } from 'node:crypto';

import {
  invalidParamsError,
  clawUnreachableError,
  sessionBusyError,
  promptTimeoutError,
  clawServerError,
  AcpError,
  ERROR_CODES,
} from './protocol.js';
import { ClawUnreachableError, ClawHttpError } from './claw-client.js';
import { createPromptEventMapper } from './event-mapper.js';

export const DEFAULT_PROMPT_TIMEOUT_MS = 1_800_000; // 30 分钟
export const DEFAULT_POLL_INTERVAL_MS = 500;

/** 把 Claw HTTP 错误归一为 ACP 错误 taxonomy（设计 §4.0）。 */
export function toAcpError(error) {
  if (error instanceof AcpError) return error;
  if (error instanceof ClawUnreachableError) return clawUnreachableError(error.cause ?? error);
  if (error instanceof ClawHttpError) return clawServerError(error.status, error.body);
  return error;
}

function diagnosticErrorCode(error) {
  return error instanceof ClawHttpError
    ? error.body?.code ?? error.status
    : error?.data?.code ?? error?.code;
}

/**
 * @param {object} options
 * @param {import('./claw-client.js').ReturnType<typeof import('./claw-client.js').createClawClient>} options.clawClient
 * @param {{ warn: Function, info: Function, error: Function }} [options.log]
 * @param {number} [options.promptTimeoutMs] CLAW_ACP_PROMPT_TIMEOUT_MS（0 禁用）
 * @param {number} [options.pollIntervalMs] CLAW_ACP_POLL_INTERVAL_MS
 */
export function createSessionManager(options = {}) {
  const clawClient = options.clawClient;
  const log = options.log ?? console;
  const trace = options.trace;
  const promptTimeoutMs = options.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  /** @type {Map<string, object>} acpSessionId → session 状态（设计 §3） */
  const sessions = new Map();

  /** 可中断 sleep：cancel 时立即唤醒，避免等满一个轮询间隔。 */
  function interruptibleSleep(ms, abortSignal) {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        abortSignal.removeEventListener('abort', done);
        resolve();
      }
      abortSignal.addEventListener('abort', done, { once: true });
    });
  }

  /** 基线捕获（设计 §9.3 主判定）：已知 eventId 集合 + 已观测最大 turn。 */
  async function captureBaseline(session, context = {}) {
    const after = session.eventCursor ?? 0;
    const body = await clawClient.getThreadEvents(session.threadId, after, context);
    const events = Array.isArray(body?.events) ? body.events : [];
    // turn 号是 0-based（runtime _callIndex）：空基线必须为 -1，否则第一个
    // turn 的终态（turn=0 <= maxTurn=0）会被 stale replay 判定丢弃，prompt 永挂。
    let maxTurn = -1;
    for (const event of events) {
      const turn = typeof event?.turn === 'number'
        ? event.turn
        : (typeof event?.item?.turn === 'number' ? event.item.turn : 0);
      if (turn > maxTurn) maxTurn = turn;
    }
    return {
      cursor: Number(body?.cursor) || 0,
      knownEventIds: events.map((event) => event?.eventId).filter((id) => id !== undefined),
      maxTurn,
    };
  }

  /**
   * session/new：调 018 原子路由建立 Claw session + thread，登记内存映射。
   * @returns {{ sessionId: string }} ACP 响应（协议标识不外泄 Claw ID）
   */
  async function createSession(cwd) {
    let body;
    try {
      body = await clawClient.createCoderSession(cwd, { method: 'session/new' });
    } catch (error) {
      throw toAcpError(error);
    }
    if (!body?.ok || !body?.clawSessionId || !body?.threadId) {
      throw clawServerError(200, body ?? null);
    }
    const acpSessionId = randomUUID();
    trace?.registerSession(acpSessionId, {
      clawSessionId: body.clawSessionId,
      threadId: body.threadId,
      runtimeInstanceId: body.viewerAgentId ?? undefined,
    });
    trace?.record('acp.session.created', {
      acpSessionId,
      clawSessionId: body.clawSessionId,
      threadId: body.threadId,
      runtimeInstanceId: body.viewerAgentId ?? undefined,
    });
    sessions.set(acpSessionId, {
      acpSessionId,
      clawSessionId: body.clawSessionId,
      threadId: body.threadId,
      viewerAgentId: body.viewerAgentId ?? null, // 仅存映射，不用于请求路径
      cwd: body.cwd ?? cwd,
      eventCursor: 0,
      activePrompt: null,
      cancelGeneration: 0,
    });
    return { sessionId: acpSessionId };
  }

  /**
   * 取消状态机（设计 §8）：session/cancel 通知与 ctx.signal 汇入此处。
   * 标记 cancelled → cancelGeneration++ → interrupt 恰好一次（异步，失败仅
   * stderr）→ 唤醒 in-flight prompt 立即返回 cancelled（不等 turn.cancelled
   * 事件——cancel 早于 turn.started 时 runtime 可能来不及产生事件）。
   */
  function cancel(acpSessionId) {
    const session = sessions.get(acpSessionId);
    if (!session) {
      log.warn?.(`acp cancel: unknown session ${acpSessionId}`);
      return;
    }
    const prompt = session.activePrompt;
    if (!prompt) {
      log.warn?.(`acp cancel: session ${acpSessionId} has no active prompt`);
      return;
    }
    if (!prompt.cancelled) {
      prompt.cancelled = true;
      prompt.lastKnownState = 'cancel_requested';
      session.cancelGeneration += 1;
      trace?.record('acp.prompt.cancel_requested', {
        acpSessionId,
        clawSessionId: session.clawSessionId,
        threadId: session.threadId,
        promptGeneration: prompt.generation,
      });
    }
    if (!prompt.interruptRequested) {
      prompt.interruptRequested = true;
      // 恰好一次；失败（含 runtime 已结束的 404）不改变返回 cancelled 的
      // 决定。投递 promise 存入 prompt：runPrompt 返回前 await 它 settle，
      // 保证请求有机会到达 server（进程早退不吞掉 interrupt）。
      prompt.interruptDelivery = clawClient.interruptSession(session.clawSessionId, {
          method: 'session/cancel',
          acpSessionId,
          promptGeneration: prompt.generation,
        }).then(
        () => {
          prompt.lastKnownState = 'interrupt_delivered';
          trace?.record('acp.prompt.interrupt_delivered', {
            acpSessionId,
            clawSessionId: session.clawSessionId,
            threadId: session.threadId,
            promptGeneration: prompt.generation,
          });
          log.info?.(`acp interrupt delivered (session=${session.clawSessionId})`);
        },
        (error) => {
          trace?.record('acp.prompt.interrupt_failed', {
            acpSessionId,
            clawSessionId: session.clawSessionId,
            threadId: session.threadId,
            promptGeneration: prompt.generation,
            errorCode: error?.code,
            errorMessage: error?.message,
          }, { level: 'error' });
          log.error?.(`acp interrupt failed (session=${session.clawSessionId}): ${error instanceof Error ? error.message : String(error)}`);
        },
      );
    }
    prompt.wakeup.abort();
  }

  /**
   * session/prompt 管线（设计 §6）。onUpdate 收到的是已映射的 ACP
   * SessionUpdate 对象（由 main.js 包装为 session/update 通知）。
   *
   * @param {string} acpSessionId
   * @param {string} text 已合并的单条 user message
   * @param {{ onUpdate: (update: object) => Promise<void>|void, signal?: AbortSignal }} io
   * @returns {Promise<{ stopReason: 'end_turn' | 'cancelled' }>}
   */
  async function runPrompt(acpSessionId, text, { onUpdate, signal }) {
    const session = sessions.get(acpSessionId);
    if (!session) {
      throw invalidParamsError('sessionId', `unknown sessionId: ${acpSessionId}`);
    }
    if (session.activePrompt) {
      throw sessionBusyError(session.activePrompt.generation);
    }

    // activePrompt 在任何 await 之前登记：cancel 可能在基线捕获 / 命令投递
    // 期间到达（ACP 语义：cancel 针对 in-flight prompt，不保证 turn 已开始），
    // 登记后任何时点的 cancel 都能命中同一状态机。
    const prompt = {
      generation: session.cancelGeneration,
      commandId: null,
      lastKnownState: 'prompt_received',
      cancelled: false,
      interruptRequested: false,
      interruptDelivery: null,
      baseline: null,
      mapper: null,
      wakeup: new AbortController(),
      startedAt: Date.now(),
    };
    session.activePrompt = prompt;

    // $/cancel_request（ctx.signal）汇入同一取消状态机（设计 §8 双层汇流）
    const onSignalAbort = () => cancel(acpSessionId);
    signal?.addEventListener('abort', onSignalAbort, { once: true });

    const isCancelled = () => prompt.cancelled || session.cancelGeneration !== prompt.generation;

    /** 取消返回前等待 interrupt 投递 settle（成功或失败），保证「恰好一次」
     *  的 HTTP 请求有机会到达 server——否则 adapter 可能在 interrupt 发出
     *  前退出。失败不改变 cancelled 结果。 */
    const returnCancelled = async () => {
      if (prompt.interruptDelivery) await prompt.interruptDelivery;
      return { stopReason: 'cancelled' };
    };

    try {
      trace?.record('acp.prompt.start', {
        acpSessionId,
        clawSessionId: session.clawSessionId,
        threadId: session.threadId,
        promptGeneration: prompt.generation,
        prompt: text,
      });
      // 基线捕获（投递前）：cursor + knownEventIds + maxTurn（设计 §9.3）
      let baseline;
      try {
        baseline = await captureBaseline(session, {
          method: 'thread/events',
          acpSessionId,
          clawSessionId: session.clawSessionId,
          promptGeneration: prompt.generation,
          phase: 'baseline',
        });
      } catch (error) {
        throw toAcpError(error);
      }
      prompt.baseline = baseline;
      prompt.lastKnownState = 'baseline_captured';
      trace?.record('acp.prompt.baseline', {
        acpSessionId,
        clawSessionId: session.clawSessionId,
        threadId: session.threadId,
        promptGeneration: prompt.generation,
        after: baseline.cursor,
        knownEventCount: baseline.knownEventIds.length,
        maxTurn: baseline.maxTurn,
      });
      prompt.mapper = createPromptEventMapper(baseline.knownEventIds);
      session.eventCursor = baseline.cursor;

      if (isCancelled()) {
        return await returnCancelled();
      }

      const idempotencyKey = `acp-${randomUUID()}`;
      try {
        const delivery = await clawClient.appendUserMessage(session.threadId, { text, idempotencyKey }, {
          method: 'session/prompt',
          acpSessionId,
          clawSessionId: session.clawSessionId,
          promptGeneration: prompt.generation,
        });
        prompt.commandId = delivery?.commandId ?? delivery?.id ?? idempotencyKey;
        prompt.lastKnownState = 'command_accepted';
        trace?.record('acp.prompt.command_accepted', {
          acpSessionId,
          clawSessionId: session.clawSessionId,
          threadId: session.threadId,
          commandId: prompt.commandId,
          promptGeneration: prompt.generation,
        });
      } catch (error) {
        trace?.record('acp.prompt.command_error', {
          acpSessionId,
          clawSessionId: session.clawSessionId,
          threadId: session.threadId,
          promptGeneration: prompt.generation,
          errorCode: diagnosticErrorCode(error),
          errorMessage: error?.message,
        }, { level: 'error' });
        throw toAcpError(error);
      }

      while (true) {
        if (isCancelled()) {
          return await returnCancelled();
        }
        if (promptTimeoutMs > 0 && Date.now() - prompt.startedAt >= promptTimeoutMs) {
          // 超时不自动 interrupt（Q25）：adapter 等待超时 ≠ runtime 应停止
          prompt.lastKnownState = 'timeout';
          trace?.record('acp.prompt.timeout', {
            acpSessionId,
            clawSessionId: session.clawSessionId,
            threadId: session.threadId,
            commandId: prompt.commandId,
            promptGeneration: prompt.generation,
            durationMs: Date.now() - prompt.startedAt,
            lastKnownState: prompt.lastKnownState,
            after: session.eventCursor,
          }, { level: 'error' });
          throw promptTimeoutError(Date.now() - prompt.startedAt);
        }

        let body;
        try {
          body = await clawClient.getThreadEvents(session.threadId, session.eventCursor, {
            method: 'thread/events',
            acpSessionId,
            clawSessionId: session.clawSessionId,
            promptGeneration: prompt.generation,
            commandId: prompt.commandId,
          });
        } catch (error) {
          trace?.record('acp.events.poll_error', {
            acpSessionId,
            clawSessionId: session.clawSessionId,
            threadId: session.threadId,
            commandId: prompt.commandId,
            promptGeneration: prompt.generation,
            after: session.eventCursor,
            lastKnownState: prompt.lastKnownState,
            errorCode: diagnosticErrorCode(error),
            errorMessage: error?.message,
          }, { level: 'error' });
          throw toAcpError(error);
        }
        const returnedCursor = Number(body?.cursor);
        const events = Array.isArray(body?.events) ? body.events : [];
        session.eventCursor = returnedCursor || session.eventCursor;
        trace?.record('acp.events.poll', {
          acpSessionId,
          clawSessionId: session.clawSessionId,
          threadId: session.threadId,
          commandId: prompt.commandId,
          promptGeneration: prompt.generation,
          after: session.eventCursor,
          returnedCursor: returnedCursor || session.eventCursor,
          eventCount: events.length,
          eventIds: events.map((event) => event?.eventId).filter(Boolean),
          lastEventType: events.at(-1)?.type,
          lastKnownState: prompt.lastKnownState,
        });

        // 取事件 await 期间可能被 cancel：丢弃该轮增量，立即返回
        if (isCancelled()) {
          return await returnCancelled();
        }

        const { updates, terminal } = prompt.mapper.mapBatch(events);
        for (const update of updates) {
          trace?.record('acp.session_update.mapped', {
            acpSessionId,
            clawSessionId: session.clawSessionId,
            threadId: session.threadId,
            commandId: prompt.commandId,
            promptGeneration: prompt.generation,
            eventId: events.find((event) => event?.item?.id === update?.toolCallId || event?.item?.id === update?.messageId)?.eventId,
            updateType: update.sessionUpdate,
          });
        }

        // 终态 sanity check（设计 §9.3 第 3 层）：turn <= baseline.maxTurn 视为
        // 旧事件回放，仅告警不判定，继续等待。turn 为 null 的终态无从比较，
        // 按正常终态处理（事件不在基线 knownEventIds 中，是命令接受后新出现的）。
        let resolvedTerminal = terminal;
        if (
          terminal
          && typeof terminal.turn === 'number'
          && terminal.turn <= baseline.maxTurn
        ) {
          log.warn?.(
            `acp prompt: terminal ${terminal.kind} turn=${terminal.turn} <= baseline.maxTurn=${baseline.maxTurn}; treating as stale replay, keep waiting`,
          );
          resolvedTerminal = null;
        }

        if (resolvedTerminal) {
          // 终态前的 update 仍按序发送；取消优先于终态判定
          for (const update of updates) {
            if (isCancelled()) return await returnCancelled();
            await onUpdate(update);
          }
          if (isCancelled()) return await returnCancelled();
          if (resolvedTerminal.kind === 'failed') {
            const failure = resolvedTerminal.error ?? {};
            prompt.lastKnownState = 'terminal_failed';
            trace?.record('acp.prompt.terminal', {
              acpSessionId,
              clawSessionId: session.clawSessionId,
              threadId: session.threadId,
              commandId: prompt.commandId,
              promptGeneration: prompt.generation,
              turn: resolvedTerminal.turn,
              terminalEvent: resolvedTerminal.kind,
              lastEventType: events.at(-1)?.type,
              errorCode: ERROR_CODES.CLAW_ERROR,
              durationMs: Date.now() - prompt.startedAt,
            }, { level: 'error' });
            throw new AcpError(
              ERROR_CODES.CLAW_ERROR,
              `Claw error: turn failed: ${failure?.message || 'unknown failure'}`,
              { code: 'CLAW_ERROR', turnFailed: failure },
            );
          }
          if (resolvedTerminal.kind === 'cancelled') {
            prompt.lastKnownState = 'terminal_cancelled';
            trace?.record('acp.prompt.terminal', {
              acpSessionId,
              clawSessionId: session.clawSessionId,
              threadId: session.threadId,
              commandId: prompt.commandId,
              promptGeneration: prompt.generation,
              turn: resolvedTerminal.turn,
              terminalEvent: resolvedTerminal.kind,
              durationMs: Date.now() - prompt.startedAt,
            });
            return await returnCancelled();
          }
          prompt.lastKnownState = 'terminal_completed';
          trace?.record('acp.prompt.terminal', {
            acpSessionId,
            clawSessionId: session.clawSessionId,
            threadId: session.threadId,
            commandId: prompt.commandId,
            promptGeneration: prompt.generation,
            turn: resolvedTerminal.turn,
            terminalEvent: resolvedTerminal.kind,
            durationMs: Date.now() - prompt.startedAt,
          });
          return { stopReason: 'end_turn' };
        }

        for (const update of updates) {
          if (isCancelled()) return await returnCancelled();
          await onUpdate(update);
        }

        await interruptibleSleep(pollIntervalMs, prompt.wakeup.signal);
      }
    } catch (error) {
      if (error instanceof AcpError && error.code === ERROR_CODES.CLAW_ERROR && error.data?.turnFailed) {
        prompt.lastKnownState = 'terminal_failed';
        trace?.record('acp.prompt.error', {
          acpSessionId,
          clawSessionId: session.clawSessionId,
          threadId: session.threadId,
          commandId: prompt.commandId,
          promptGeneration: prompt.generation,
          durationMs: Date.now() - prompt.startedAt,
          lastKnownState: prompt.lastKnownState,
          errorCode: error.data.code,
          errorMessage: error.message,
        }, { level: 'error' });
      }
      if (!(error instanceof AcpError) || error.code !== ERROR_CODES.CLAW_ERROR || error.data?.turnFailed) {
        trace?.record('acp.prompt.error', {
          acpSessionId,
          clawSessionId: session.clawSessionId,
          threadId: session.threadId,
          commandId: prompt.commandId,
          promptGeneration: prompt.generation,
          durationMs: Date.now() - prompt.startedAt,
          lastKnownState: prompt.lastKnownState,
          errorCode: error?.data?.code ?? error?.code,
          errorMessage: error?.message,
        }, { level: 'error' });
      }
      throw error;
    } finally {
      signal?.removeEventListener('abort', onSignalAbort);
      if (session.activePrompt === prompt) {
        session.activePrompt = null;
      }
    }
  }

  /**
   * 断开清理：仅释放内存映射（设计 §5 / Q12）。Claw session / thread /
   * runtime 按 Claw 自身持久化机制保留，v1 无 session/close。
   */
  function dispose() {
    sessions.clear();
  }

  return {
    createSession,
    runPrompt,
    cancel,
    dispose,
    /** 测试与诊断用：当前 session 数量。 */
    get size() {
      return sessions.size;
    },
    /** 测试与诊断用：按 ACP sessionId 取内部状态。 */
    getSession(acpSessionId) {
      return sessions.get(acpSessionId) ?? null;
    },
  };
}
