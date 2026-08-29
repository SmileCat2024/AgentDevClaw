/**
 * Session 管理器 — ID 映射、activePrompt 串行约束、取消状态机（ticket 019）
 *
 * 设计 §3 / §6 / §8：
 *   - ACP session 与 Claw session/thread 的映射只存在于 adapter 内存；
 *     adapter 退出 / 断开仅释放内存（dispose），不动任何 Claw 持久化对象
 *   - 一 ACP session 一 active prompt（Q9）：并发 prompt → -32001，不排队
 *   - 一条 Claw thread 至多一个内部消费状态（线程级唯一）：多条 ACP ID
 *     （session/new 的随机 UUID 与 resume 的持久 Claw ID）可作别名指向同一
 *     状态，但绝不允许建立第二个独立状态——双状态会各自消费同一线程事件流，
 *     使终态归因与 cancel 失效（见 §7/§8 审计修复）
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

// ── session/load 历史回放（设计 §4.8）──────────────────────────────

/** Claw 工具名 → ACP ToolKind（client 图标/呈现分类；未知工具归 other）。 */
const TOOL_KIND_BY_NAME = new Map([
  ['read', 'read'],
  ['edit', 'edit'], ['write', 'edit'], ['multi_edit', 'edit'],
  ['bash', 'execute'], ['shell', 'execute'], ['powershell', 'execute'],
  ['grep', 'search'], ['glob', 'search'], ['search', 'search'],
  ['web_search', 'fetch'], ['web_fetch', 'fetch'], ['fetch', 'fetch'],
  ['delete', 'delete'], ['trash', 'delete'],
]);

function mapToolKind(name) {
  return TOOL_KIND_BY_NAME.get(String(name || '').toLowerCase()) ?? 'other';
}

/** tool_call 人类可读标题：`name {json参数}`，超长截断（client 列表呈现）。 */
function buildToolCallTitle(toolCall) {
  const name = String(toolCall?.name || 'tool');
  const args = toolCall?.arguments && typeof toolCall.arguments === 'object'
    ? JSON.stringify(toolCall.arguments)
    : '{}';
  const title = `${name} ${args}`;
  return title.length > 200 ? `${title.slice(0, 197)}...` : title;
}

/**
 * Claw 历史投影消息 → ACP session/update 回放通知序列（纯函数）。
 *
 * 映射（grill Q3 方案 2：reasoning 与内部元数据不外放）：
 *   user        → user_message_chunk
 *   assistant   → 每个工具调用 tool_call（先），文本 agent_message_chunk（后）
 *   tool        → tool_call_update（status: completed + 结果文本块）；
 *                 孤儿结果（无对应 tool_call）跳过
 */
export function buildSessionReplayNotifications(messages) {
  const updates = [];
  const seenToolCallIds = new Set();
  for (const msg of Array.isArray(messages) ? messages : []) {
    if (!msg || typeof msg !== 'object') continue;
    if (msg.role === 'user') {
      if (typeof msg.content === 'string' && msg.content) {
        updates.push({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: msg.content } });
      }
    } else if (msg.role === 'assistant') {
      for (const toolCall of Array.isArray(msg.toolCalls) ? msg.toolCalls : []) {
        if (!toolCall?.id) continue;
        const toolCallId = String(toolCall.id);
        seenToolCallIds.add(toolCallId);
        updates.push({
          sessionUpdate: 'tool_call',
          toolCallId,
          title: buildToolCallTitle(toolCall),
          kind: mapToolKind(toolCall.name),
        });
      }
      if (typeof msg.content === 'string' && msg.content) {
        updates.push({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: msg.content } });
      }
    } else if (msg.role === 'tool') {
      const toolCallId = typeof msg.toolCallId === 'string' ? msg.toolCallId : '';
      if (!toolCallId || !seenToolCallIds.has(toolCallId)) continue;
      const text = typeof msg.content === 'string' ? msg.content : '';
      updates.push({
        sessionUpdate: 'tool_call_update',
        toolCallId,
        status: 'completed',
        content: text ? [{ type: 'text', text }] : [],
      });
    }
  }
  return updates;
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

  /** @type {Map<string, object>} threadId → session 状态（线程级唯一消费状态，设计 §3） */
  const threadStates = new Map();
  /** @type {Map<string, string>} acpSessionId → threadId 别名解析（多协议 ID 指向同一状态） */
  const aliasToThread = new Map();

  /**
   * 按 ACP sessionId 解析内部状态：先走别名表，再按线程唯一键取状态。
   * @returns {object|null}
   */
  function resolveSession(acpSessionId) {
    if (typeof acpSessionId !== 'string' || !acpSessionId) return null;
    const threadId = aliasToThread.get(acpSessionId);
    if (!threadId) return null;
    return threadStates.get(threadId) ?? null;
  }

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

  /** 无中断方的固定间隔等待。 */
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
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
   * 登记 thread 级状态 + ACP 别名。同 thread 已存在状态（session/new 与
   * resume 落到同一线程）时复用并补别名，绝不建立第二个独立消费状态——
   * 双状态会各自消费同一事件流，导致终态归因与 cancel 失效。
   * @returns {object} thread 级状态
   */
  function registerThreadState(acpSessionId, { clawSessionId, threadId, viewerAgentId, cwd }) {
    let state = threadStates.get(threadId);
    if (!state) {
      state = {
        acpSessionId: acpSessionId, // 主别名（首次登记时建立协议 ID 的会话）
        clawSessionId,
        threadId,
        viewerAgentId: viewerAgentId ?? null, // 仅存映射，不用于请求路径
        cwd,
        eventCursor: 0,
        activePrompt: null,
        cancelGeneration: 0,
        closing: false, // closeSession 收敛标记：拒绝收敛窗口内的新 prompt
      };
      threadStates.set(threadId, state);
    } else if (!state.clawSessionId && clawSessionId) {
      state.clawSessionId = clawSessionId;
    }
    aliasToThread.set(acpSessionId, threadId);
    return state;
  }

  /** 清理某 thread 状态：先删别名（含状态主键），再删状态本身。 */
  function removeThreadState(state) {
    for (const [alias, threadId] of aliasToThread) {
      if (threadId === state.threadId) aliasToThread.delete(alias);
    }
    aliasToThread.delete(state.acpSessionId);
    threadStates.delete(state.threadId);
  }

  /** 按 thread 主键供测试/诊断读取内部状态。 */
  function getThreadState(threadId) {
    return threadStates.get(threadId) ?? null;
  }

  /**
   * session/new：调 018 原子路由建立 Claw session + thread，登记内存映射。
   * @param {string} cwd
   * @param {{ model?: string }} [options] 可选启动模型预设（server 消歧解析）
   * @returns {{ sessionId: string }} ACP 响应（协议标识不外泄 Claw ID）
   */
  async function createSession(cwd, options = {}) {
    let body;
    try {
      body = await clawClient.createCoderSession(cwd, { method: 'session/new' }, { model: options.model });
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
    const state = registerThreadState(acpSessionId, {
      clawSessionId: body.clawSessionId,
      threadId: body.threadId,
      viewerAgentId: body.viewerAgentId ?? null,
      cwd: body.cwd ?? cwd,
    });
    // 新线程必然新建状态；若复用（重复 create/竞态）返回既有主键而非新 UUID
    return { sessionId: state.acpSessionId };
  }

  /**
   * session/resume（协议 v1 正式方法，不回放历史）：把请求的 Claw sessionId
   * （成员或 head）解析到其线程当前 head 并登记映射。
   *
   * 协议 ID 策略：resume 场景下 ACP sessionId === 请求的 Claw sessionId
   * （server 已把 head 解析结果作为 clawSessionId 返回）。与 session/new 的
   * 随机 UUID 不同，这个 ID 持久稳定——client 重启后凭上次记录的 sessionId
   * 即可续接；同一 Claw 线程经 createSession 与 resumeSession 各持一条协议
   * 别名（不同协议 ID，同一线程目标），但内部只有一个线程级消费状态。
   *
   * @param {string} clawSessionId 成员或 head 的 Claw sessionId
   * @param {{ cwd: string }} params cwd 必填（SDK schema），server 校验
   *   一致性（不一致 → -32003）
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
    const state = registerThreadState(body.clawSessionId, {
      clawSessionId: body.clawSessionId,
      threadId: body.threadId,
      viewerAgentId: body.viewerAgentId ?? null,
      cwd: body.cwd ?? null,
    });
    // 重复 resume 同一线程：复用既有状态，绝不覆盖含 activePrompt 的状态
    // （覆盖会让 session/cancel 失去目标；线程级唯一保证 cancel 命中）。
    trace?.registerSession(body.clawSessionId, {
      clawSessionId: body.clawSessionId,
      threadId: body.threadId,
      runtimeInstanceId: body.viewerAgentId ?? undefined,
    });
    trace?.record('acp.session.resumed', {
      acpSessionId: body.clawSessionId,
      requestedSessionId: clawSessionId,
      clawSessionId: body.clawSessionId,
      threadId: body.threadId,
      reused: state.acpSessionId !== body.clawSessionId || state.lastResumedAt !== undefined,
    });
    state.lastResumedAt = Date.now();
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
   * session/load（协议 v1 正式方法，带历史回放）= resume（控制面）+
   * head 历史读取（数据面）+ 回放通知。
   *
   * 复用 resumeSession 的全部校验与解析（cwd 一致性、head/成员链、归档
   * 拒绝、急切挂载）；历史回放的是 **head** 的历史——与实际上下文一致
   * （请求成员会话时，compact 接力后 head 上下文才是 prompt 的落点）。
   * 通知的 sessionId 与映射登记均为 head（协议 ID 策略同 resume）。
   *
   * @param {string} clawSessionId client 记录的（成员或 head）Claw sessionId
   * @param {{ cwd?: string }} [params]
   * @param {(notification: {method: 'session/update', params: {sessionId, update}}) => void} notify
   * @returns {{ sessionId: string }} 协议响应扩展字段（协议本体为 void）
   */
  async function loadSession(clawSessionId, params = {}, notify) {
    const resumed = await resumeSession(clawSessionId, params);
    const headSessionId = resumed.sessionId;

    let history;
    try {
      history = await clawClient.getCoderSessionHistory(headSessionId, {
        method: 'session/load',
        requestedSessionId: clawSessionId,
      });
    } catch (error) {
      throw toAcpError(error);
    }
    if (!history?.ok || !Array.isArray(history?.messages)) {
      throw clawServerError(200, history ?? null);
    }

    const updates = buildSessionReplayNotifications(history.messages);
    for (const update of updates) {
      notify?.({ method: 'session/update', params: { sessionId: headSessionId, update } });
    }
    trace?.record('acp.session.loaded', {
      acpSessionId: headSessionId,
      clawSessionId: headSessionId,
      requestedSessionId: clawSessionId,
      replayUpdates: updates.length,
    });
    // 协议响应本体不含会话标识（历史经 session/update 回放，其 sessionId 即
    // head）；head 协议 ID 经 _meta.claw 扩展命名空间带给需要它的 client。
    return { _meta: { claw: { sessionId: headSessionId } } };
  }

  /**
   * 取消状态机（设计 §8）：session/cancel 通知与 ctx.signal 汇入此处。
   * 标记 cancelled → cancelGeneration++ → interrupt 恰好一次（异步，失败仅
   * stderr）→ 唤醒 in-flight prompt 立即返回 cancelled（不等 turn.cancelled
   * 事件——cancel 早于 turn.started 时 runtime 可能来不及产生事件）。
   */
  function cancel(acpSessionId) {
    const session = resolveSession(acpSessionId);
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
    const session = resolveSession(acpSessionId);
    if (!session) {
      throw invalidParamsError('sessionId', `unknown sessionId: ${acpSessionId}`);
    }
    if (session.activePrompt) {
      throw sessionBusyError(session.activePrompt.generation);
    }
    // close 收敛中：runtime 正在停止，受理新 prompt 只会挂起到超时
    if (session.closing) {
      throw sessionBusyError(session.cancelGeneration);
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

      // 每条 prompt 一个全新随机幂等键是设计语义而非偷懒：每条 ACP prompt
      // 都是新意图（用户重发相同文本 = 合法重发，必须重新入箱执行）。
      // 重复提交由 Inbox 的 idempotencyKey 去重兜底（adapter 无自动重试，
      // 不存在同键二次提交）；投递面双发（K7 崩溃窗口）由 R4 容忍契约兜底。
      // 禁止改为内容派生键——Inbox 去重覆盖 pending/delivered 保留窗口，
      // 内容键会误杀「已执行完成后故意重发相同文本」的合法意图。
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
   * session/close（协议 v1 正式方法）：ACP §9.8 close = cancel + 释放资源。
   * 有 in-flight prompt 时先走同一取消状态机（interrupt 恰好一次 + 唤醒），
   * 等待其 settle；随后精确停掉该会话的 runtime（stop 路由，未运行时幂等
   * 成功）并释放 adapter 侧映射。thread / session 持久数据不动——归档是
   * Claw 管理面的动作，不在 ACP 协议面内；adapter 断开不触发本方法
   * （dispose 只清内存），释放只在 client 显式请求时发生。
   */
  async function closeSession(acpSessionId) {
    const session = resolveSession(acpSessionId);
    if (!session) {
      throw invalidParamsError('sessionId', `unknown sessionId: ${acpSessionId}`);
    }
    // ACP §9.8：close = cancel + 释放资源。busy 不再拒绝，先取消。
    if (session.activePrompt) {
      const prompt = session.activePrompt;
      cancel(acpSessionId); // 与 session/cancel 同一状态机：interrupt 恰好一次
      trace?.record('acp.session.close_cancelling', {
        acpSessionId,
        clawSessionId: session.clawSessionId,
        threadId: session.threadId,
        promptGeneration: prompt.generation,
      });
      // 等 prompt 彻底退出轮询（interrupt 送达 + finally 清 activePrompt），
      // 避免停 runtime 与事件轮询并发收敛。
      while (session.activePrompt === prompt) {
        await sleep(pollIntervalMs);
      }
    }
    // 收敛后到清映射前的窗口内拒绝新 prompt：此时 runtime 即将/已被 stop，
    // 新 prompt 会入箱到无投递触发的线程上挂起到超时。
    session.closing = true;
    try {
      await clawClient.stopCoderSession(session.clawSessionId, {
        method: 'session/close',
        acpSessionId,
        clawSessionId: session.clawSessionId,
      });
    } catch (error) {
      trace?.record('acp.session.stop_failed', {
        acpSessionId,
        clawSessionId: session.clawSessionId,
        threadId: session.threadId,
        errorCode: error instanceof ClawHttpError ? (error.body?.code ?? error.status) : error?.code,
        errorMessage: error?.message,
      }, { level: 'error' });
      throw toAcpError(error);
    }
    removeThreadState(session);
    trace?.record('acp.session.closed', {
      acpSessionId,
      clawSessionId: session.clawSessionId,
      threadId: session.threadId,
    });
    return {};
  }

  /**
   * 断开清理：仅释放内存映射（设计 §5 / Q12）。Claw session / thread /
   * runtime 按 Claw 自身持久化机制保留；显式释放（停 runtime + 清映射）
   * 走 closeSession（session/close），不与断开挂钩。
   */
  function dispose() {
    threadStates.clear();
    aliasToThread.clear();
  }

  return {
    createSession,
    resumeSession,
    listSessions,
    loadSession,
    runPrompt,
    cancel,
    closeSession,
    dispose,
    /** 测试与诊断用：当前线程级状态数量。 */
    get size() {
      return threadStates.size;
    },
    /** 测试与诊断用：按 ACP sessionId 取内部状态（别名解析到线程状态）。 */
    getSession(acpSessionId) {
      return resolveSession(acpSessionId);
    },
    /** 测试与诊断用：按 Claw threadId 直接取内部状态。 */
    getThreadState,
  };
}
