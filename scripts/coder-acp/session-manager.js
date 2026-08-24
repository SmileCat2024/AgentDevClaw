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
 *     不看看板状态；旧事件识别以 eventId 为主判定（018 起事件必带 eventId，
 *     board 落盘事件的 eventId 固定，重放必同 ID 被 mapper 去重拦截）。
 *     不做 turn 号比较——runtime 的 turn 号是 session 级 0-based 计数，
 *     thread 接力后新 session 从 0 重新计数，跨 runtime 不单调，比较会误杀。
 *
 * prompt 执行管线（设计 §6）：
 *   基线捕获（cursor + knownEventIds）
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
 * runtime UsageInfo（{ inputTokens, outputTokens, totalTokens, cacheReadTokens?,
 * cacheCreationTokens?, reasoningTokens? }）→ ACP Usage（camelCase，字段名见
 * SDK types.gen.d.ts）。缺省字段省略，不构造假值；无任何可用字段 → null
 * （PromptResponse 省略 usage）。缓存字段映射：cacheReadTokens→cachedReadTokens，
 * cacheCreationTokens→cachedWriteTokens，reasoningTokens→thoughtTokens。
 */
export function toAcpUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const out = {};
  if (Number.isFinite(usage.totalTokens)) out.totalTokens = usage.totalTokens;
  if (Number.isFinite(usage.inputTokens)) out.inputTokens = usage.inputTokens;
  if (Number.isFinite(usage.outputTokens)) out.outputTokens = usage.outputTokens;
  if (Number.isFinite(usage.cacheReadTokens)) out.cachedReadTokens = usage.cacheReadTokens;
  if (Number.isFinite(usage.cacheCreationTokens)) out.cachedWriteTokens = usage.cacheCreationTokens;
  if (Number.isFinite(usage.reasoningTokens)) out.thoughtTokens = usage.reasoningTokens;
  return Object.keys(out).length > 0 ? out : null;
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

  /** 基线捕获（设计 §9.3 主判定）：已知 eventId 集合。 */
  async function captureBaseline(session, context = {}) {
    const after = session.eventCursor ?? 0;
    const body = await clawClient.getThreadEvents(session.threadId, after, context);
    const events = Array.isArray(body?.events) ? body.events : [];
    return {
      cursor: Number(body?.cursor) || 0,
      knownEventIds: events.map((event) => event?.eventId).filter((id) => id !== undefined),
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
   * session/resume（协议 v1 正式方法，不回放历史）：把请求的 Claw sessionId
   * （成员或 head）解析到其线程当前 head 并登记映射。
   *
   * 协议 ID 策略：resume 场景下 ACP sessionId === 请求的 Claw sessionId
   * （server 已把 head 解析结果作为 clawSessionId 返回）。与 session/new 的
   * 随机 UUID 不同，这个 ID 持久稳定——client 重启后凭上次记录的 sessionId
   * 即可续接；同一 Claw 会话经 createSession 与 resumeSession 各持一条映射
   * 时互不干扰（不同协议 ID，同一 Claw 目标）。
   *
   * @param {string} clawSessionId 成员或 head 的 Claw sessionId
   * @param {{ cwd?: string }} [params] cwd 由 server 校验（不一致 → -32003）
   * @returns {{ sessionId: string }} ACP 响应（即请求 ID）
   */
  async function resumeSession(clawSessionId, params = {}) {
    if (typeof clawSessionId !== 'string' || !clawSessionId.trim()) {
      throw invalidParamsError('sessionId', 'sessionId must be a non-empty string');
    }
    let body;
    try {
      body = await clawClient.resumeCoderSession(clawSessionId.trim(), params, {
        method: 'session/resume',
        requestedSessionId: clawSessionId,
      });
    } catch (error) {
      throw toAcpError(error);
    }
    if (!body?.ok || !body?.clawSessionId || !body?.threadId) {
      throw clawServerError(200, body ?? null);
    }
    sessions.set(body.clawSessionId, {
      acpSessionId: body.clawSessionId,
      clawSessionId: body.clawSessionId,
      threadId: body.threadId,
      viewerAgentId: body.viewerAgentId ?? null, // 仅存映射，不用于请求路径
      cwd: body.cwd ?? null,
      eventCursor: 0,
      activePrompt: null,
      cancelGeneration: 0,
    });
    trace?.registerSession(body.clawSessionId, {
      clawSessionId: body.clawSessionId,
      threadId: body.threadId,
      runtimeInstanceId: body.viewerAgentId ?? undefined,
    });
    trace?.record('acp.session.resumed', {
      acpSessionId: body.clawSessionId,
      clawSessionId: body.clawSessionId,
      threadId: body.threadId,
      runtimeInstanceId: body.viewerAgentId ?? undefined,
    });
    return { sessionId: body.clawSessionId };
  }

  /**
   * session/list（协议 v1 正式方法）：线程视角会话发现。cwd 过滤原样透传
   * （server 侧做归一化比较），响应直接返回 server payload。
   */
  async function listSessions(params = {}) {
    try {
      return await clawClient.listCoderSessions({ cwd: params?.cwd }, { method: 'session/list' });
    } catch (error) {
      throw toAcpError(error);
    }
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
      // 用户消息回显（codex-acp 风格）：client 转录完整性依赖 agent 侧回显，
      // 在任何管线步骤前发出
      await onUpdate({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text } });

      // 基线捕获（投递前）：cursor + knownEventIds（设计 §9.3）
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
          if (error instanceof ClawHttpError && error.status === 404) {
            // thread 已在 Claw 侧不存在（被关闭/删除）：转结构化 thread_lost 诊断，
            // 用户明确知道需要新建 session 而非继续等待
            throw new AcpError(
              ERROR_CODES.CLAW_ERROR,
              `Claw error: thread ${session.threadId} no longer exists on the Claw server`,
              {
                code: 'CLAW_THREAD_LOST',
                threadId: session.threadId,
                lastKnownState: prompt.lastKnownState,
                hint: 'thread 已在 Claw 侧关闭或删除；请新建 ACP session',
              },
            );
          }
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

        // 终态判定不做 turn 号比较（见文件头注释）：能到达此处的事件必然
        // 携带基线未见的新 eventId（同 eventId 重放已在 mapper 去重拦截），
        // 即命令接受后新出现的终态。
        const resolvedTerminal = terminal;

        if (resolvedTerminal) {
          // 终态前的 update 仍按序发送；取消优先于终态判定
          for (const update of updates) {
            if (isCancelled()) return await returnCancelled();
            await onUpdate(update);
          }
          if (isCancelled()) return await returnCancelled();
          if (resolvedTerminal.kind === 'failed') {
            // 终态失败不抛 JSON-RPC error（codex-acp terminalFailurePromptResponse
            // 风格）：返回 end_turn + _meta.claw.terminalFailure 结构化失败，client
            // 保持对话连续性（可追问/重试）而非弹错误框
            const failure = resolvedTerminal.error ?? {};
            const failureMessage = failure?.message || 'unknown failure';
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
              errorCode: 'TURN_FAILED',
              durationMs: Date.now() - prompt.startedAt,
            }, { level: 'error' });
            const failureUsage = toAcpUsage(resolvedTerminal.usage);
            return {
              stopReason: 'end_turn',
              ...(failureUsage ? { usage: failureUsage } : {}),
              _meta: { claw: { terminalFailure: { message: failureMessage, error: failure } } },
            };
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
          const completedUsage = toAcpUsage(resolvedTerminal.usage);
          return { stopReason: 'end_turn', ...(completedUsage ? { usage: completedUsage } : {}) };
        }

        for (const update of updates) {
          if (isCancelled()) return await returnCancelled();
          await onUpdate(update);
        }

        await interruptibleSleep(pollIntervalMs, prompt.wakeup.signal);
      }
    } catch (error) {
      // 终态失败已改为正常返回（end_turn + _meta，见上）；此处只剩管线基础设施
      // 错误（网络 / server 业务错误 / 超时），统一记一条 trace 后上抛
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
      throw error;
    } finally {
      signal?.removeEventListener('abort', onSignalAbort);
      if (session.activePrompt === prompt) {
        session.activePrompt = null;
      }
    }
  }

  /**
   * session/close（协议 v1 正式方法）：转发 Claw 归档 thread（archive 标记
   * 收纳语义，成员会话保留）并释放映射。有 in-flight prompt 时拒绝（先
   * session/cancel——即先中断再归档）；thread 已消失或已归档视为幂等成功。
   * adapter 断开不触发本方法（dispose 只清内存）——归档只在 client
   * 显式请求时发生。
   */
  async function closeSession(acpSessionId) {
    const session = sessions.get(acpSessionId);
    if (!session) {
      throw invalidParamsError('sessionId', `unknown sessionId: ${acpSessionId}`);
    }
    if (session.activePrompt) {
      throw sessionBusyError(session.activePrompt.generation);
    }
    try {
      await clawClient.archiveThread(session.threadId, {
        method: 'session/close',
        acpSessionId,
        clawSessionId: session.clawSessionId,
      });
    } catch (error) {
      const alreadyGone = error instanceof ClawHttpError
        && (error.status === 404
          || error.body?.code === 'thread_not_found');
      if (!alreadyGone) throw toAcpError(error);
    }
    sessions.delete(acpSessionId);
    trace?.record('acp.session.closed', {
      acpSessionId,
      clawSessionId: session.clawSessionId,
      threadId: session.threadId,
    });
    return {};
  }

  /**
   * 断开清理：仅释放内存映射（设计 §5 / Q12）。Claw session / thread /
   * runtime 按 Claw 自身持久化机制保留；显式归档走 closeSession
   * （session/close），不与断开挂钩。
   */
  function dispose() {
    sessions.clear();
  }

  return {
    createSession,
    resumeSession,
    listSessions,
    runPrompt,
    cancel,
    closeSession,
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
