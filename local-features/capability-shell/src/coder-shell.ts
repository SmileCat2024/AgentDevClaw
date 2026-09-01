/**
 * coder 领域 shell — threads adapter + 策略声明（ticket 034；ticket 035）
 *
 * 在 033 基座上落地第一个领域 shell：`coder_shell({ command })`。动词表
 * 9 个（new-session / create / send / watch / list / show / archive /
 * unarchive / deliver），adapter 用 Node fetch 直调 Claw server 的
 * `/protoclaw/threads*` 与 `/protoclaw/prebuilt_sessions` 控制面
 * （同机回环；单密码认证开启时经 PROTOCLAW_INTERNAL_TOKEN 携带内部服务令牌，
 * 与 bin/claw.mjs 的 clawServerFetch 同一契约）。请求形态与参数参照
 * `bin/claw.mjs` threads / sessions 子命令；serverOrigin 解析参照
 * local-features/dispatch 的 runtimeIdentity 模式（默认 http://127.0.0.1:1420）。
 *
 * new-session 直调 POST /protoclaw/prebuilt_sessions（sessionType=coder，
 * 契约参照 bin/claw.mjs handleSessions：--dir 映射 openDirectory，本动词 v1
 * 不暴露目录参数，会话绑定 agent 工作空间目录）；响应 threadId 在 session
 * 对象之前（服务端为截断安全特意如此排列）。会话自动建线是标准路径，
 * create 仅用于给已存在会话加挂线程（建线前预校验会话存在且归属匹配，
 * 消灭 head_session_missing 僵尸线程，ticket 035B）。
 *
 * send 阻塞语义：POST commands 后在本 adapter 内轮询 GET events 直到本轮
 * 落定（判定字段语义参照 bin/claw.mjs watchThread：turn.completed 且
 * lifeState 离开 executing，链式多轮自动跟随；failed=true / 线程终态即出）。
 * 不实现任何 CLI 时间 flag；超时唯一闸门 = 033 基座的 Tool.timeout 契约：
 * 终止信号到达后 adapter 在 settle 窗口内返回结构化 done reason=timeout
 * （非错误），模型自然续挂 watch。
 *
 * advance / resume 不入动词表（rotation_failed 残局需人工介入，与技能
 * 故障表一致）：模型调用时得到 unknown_verb + 结构化指引。
 */

/** 线程/server 连续不可达上限（bin/claw.mjs watchThread 同款语义）。 */
const MAX_CONSECUTIVE_FETCH_ERRORS = 3;
/** 落定报文附带的事件尾条数（取证用，防长文本撑爆上下文）。 */
const TAIL_EVENT_COUNT = 5;

/** fetch 注入形态（测试用最小面）。 */
export type FetchLike = (
  url: string,
  init?: RequestInit,
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/** adapter 收到的执行上下文（033 分派层注入 + 管线透传）。 */
export interface ThreadAdapterContext {
  stdin: string;
  /** 框架终止原因查询：超时返回 'timeout'（settle 窗口内结构化收尾用） */
  termination?: () => 'timeout' | 'user' | null;
  /** 框架合并 signal（Tool.timeout / 用户打断共用，ADR-0005） */
  signal?: AbortSignal;
}

export type ThreadAdapter = (args: string[], context?: ThreadAdapterContext) => Promise<string>;

/**
 * threads adapter 表：动词 → 进程内实现。
 *
 * 033 分派层传给 adapter 的是「已剥动词的参数数组」，不含动词本身；
 * 每个 coder 动词的 adapter key 形如 `threads:<verb>`，按 key 解出动词后
 * 路由到对应实现（工厂返回 per-verb 的 AdapterMap 项，动词即绑定）。
 */
export function createThreadsAdapters(deps: {
  serverOrigin: string;
  fetchImpl?: FetchLike;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): Record<string, ThreadAdapter> {
  const adapter = createThreadsAdapter(deps).threads;
  const verbs = ['new-session', 'create', 'send', 'watch', 'list', 'show', 'archive', 'unarchive', 'deliver'] as const;
  const map: Record<string, ThreadAdapter> = {};
  for (const verb of verbs) {
    map[`threads:${verb}`] = async (args, context) => {
      // adapter 收到的首参是动词本身（策略声明 argPrefix 未用，参数校验道
      // 保证 args 即动词参数），显式携带动词供统一实现分派
      return adapter([verb, ...args], context);
    };
  }
  return map;
}

interface SettleOutcome {
  reason: string;
  lifeState: string;
  failed: boolean;
  newEvents: number;
  /** 连续不可达时的诊断 */
  detail?: string;
  /** 落定时刻的事件尾摘要（取证用） */
  tailEvents: Array<Record<string, any>>;
}

/**
 * threads adapter 工厂。
 *
 * serverOrigin 解析参照 local-features/dispatch 的 runtimeIdentity 模式：
 * 显式配置 → PROTOCLAW_SERVER_ORIGIN → http://127.0.0.1:1420。
 * 请求形态与参数参照 bin/claw.mjs threads 子命令；单密码认证开启时经
 * PROTOCLAW_INTERNAL_TOKEN 携带内部服务令牌（server/auth.js authenticateInternal）。
 */
export function createThreadsAdapter(deps: {
  serverOrigin: string;
  fetchImpl?: FetchLike;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): { threads: ThreadAdapter } {
  const origin = deps.serverOrigin.replace(/\/+$/, '');
  const fetchImpl: FetchLike = deps.fetchImpl
    ?? (async (url, init) => {
      const response = await fetch(url, init);
      return { ok: response.ok, status: response.status, json: () => response.json() };
    });
  const pollIntervalMs = deps.pollIntervalMs ?? 2_000;
  const sleepMs = deps.sleep
    ?? ((ms: number) => new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ms);
      t.unref?.();
    }));

  /** 请求 /protoclaw/threads* 控制面（同 bin/claw.mjs clawServerFetch 契约）。 */
  async function clawFetch(pathname: string, init: RequestInit = {}): Promise<Record<string, any>> {
    const internalToken = String(process.env.PROTOCLAW_INTERNAL_TOKEN || '').trim();
    const headers: Record<string, string> = {
      ...((init.headers as Record<string, string>) || {}),
    };
    if (internalToken && !headers.Authorization) {
      headers.Authorization = `Bearer ${internalToken}`;
    }
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await fetchImpl(`${origin}${pathname}`, { ...init, headers });
    } catch (err) {
      throw new Error(`Claw server not reachable at ${origin} — ${String((err as Error)?.message || err)}`, { cause: err });
    }
    const payload = (await response.json().catch(() => ({}))) as Record<string, any>;
    if (!response.ok || payload?.ok === false) {
      const detail = payload?.error || payload?.message || `HTTP ${response.status}`;
      throw new Error((payload as any)?.code ? `${detail} [${(payload as any).code}]` : String(detail));
    }
    return payload;
  }

  /** 线程快照 → 单行摘要（不含 commands 明细，防长文本撑爆上下文）。 */
  function threadLine(thread: Record<string, any>): string {
    const parts = [
      `threadId=${thread?.threadId || '(unknown)'}`,
      `lifeState=${thread?.lifeState || 'unknown'}`,
      `failed=${thread?.failed === true}`,
      `status=${thread?.status || 'unknown'}`,
    ];
    if (thread?.title) parts.push(`title=${thread.title}`);
    if (thread?.headSessionId) parts.push(`head=${thread.headSessionId}`);
    return parts.join('  ');
  }

  /** 事件压缩为一行（取证用）。 */
  function eventLine(event: Record<string, any>): string {
    const itemType = event?.item?.type ? ` item=${event.item.type}` : '';
    const turn = event?.turn !== undefined ? ` turn=${event.turn}` : '';
    return `  event: ${event?.type || 'event'}${turn}${itemType}`;
  }

  /**
   * 阻塞等待本轮落定（判定字段语义参照 bin/claw.mjs watchThread 与
   * server/thread-control 的 started/done 逻辑：turn.completed 且 lifeState
   * 离开 executing，链式多轮自动跟随；failed=true / 线程终态即出）。
   * Tool.timeout / 用户打断经 signal + termination 在 settle 窗口内到达：
   * 返回结构化 done（reason=timeout / interrupted，非错误），模型自然续挂
   * watch——这是唯一超时闸门，adapter 不实现任何时间 flag。
   */
  async function waitForTurnSettled(
    threadId: string,
    options: Pick<ThreadAdapterContext, 'signal' | 'termination'> = {},
  ): Promise<SettleOutcome> {
    // 基线：只取游标不回放历史事件（watch 语义：只等本轮的新事件）
    let cursor = 0;
    try {
      const base = await clawFetch(`/protoclaw/threads/${encodeURIComponent(threadId)}/events`);
      cursor = Number(base?.cursor) || 0;
    } catch { /* 事件端点瞬时不可用不阻断等待 */ }

    let turnSettled = false;
    let idleRounds = 0;
    let consecutiveFetchErrors = 0;
    let lifeState = 'unknown';
    let failed = false;
    let newEvents = 0;
    const tailEvents: Array<Record<string, any>> = [];

    while (true) {
      // 终止即结果（ADR-0005）：结构化 done（reason=timeout / interrupted，非错误）
      if (options.signal?.aborted) {
        const reason = options.termination?.() === 'timeout' ? 'timeout' : 'interrupted';
        return { reason, lifeState, failed, newEvents, tailEvents: tailEvents.slice(-TAIL_EVENT_COUNT) };
      }
      await sleepMs(pollIntervalMs);

      let thread: Record<string, any> | null;
      try {
        thread = (await clawFetch(`/protoclaw/threads/${encodeURIComponent(threadId)}`))?.thread ?? null;
        consecutiveFetchErrors = 0;
      } catch (error) {
        consecutiveFetchErrors += 1;
        if (consecutiveFetchErrors >= MAX_CONSECUTIVE_FETCH_ERRORS) {
          return {
            reason: 'unreachable',
            lifeState,
            failed,
            newEvents,
            detail: String((error as Error)?.message || error),
            tailEvents: tailEvents.slice(-TAIL_EVENT_COUNT),
          };
        }
        continue; // server 短暂不可达不打断等待窗口
      }
      lifeState = String(thread?.lifeState || 'unknown');
      failed = thread?.failed === true;

      // 事件游标推进（只计数 + 记忆 turn 状态，不透传事件流）
      let events: Array<Record<string, any>> = [];
      try {
        const payload = await clawFetch(`/protoclaw/threads/${encodeURIComponent(threadId)}/events?after=${cursor}`);
        events = (payload?.events as Array<Record<string, any>>) || [];
        if (payload?.cursor !== undefined) cursor = Number(payload.cursor) || cursor;
      } catch { /* 瞬时失败下轮再取 */ }
      for (const event of events) {
        newEvents += 1;
        tailEvents.push(event);
        // 跨轮记忆：turn.completed 与 lifeState 离开 executing 常在不同轮次到达；
        // 链式多轮时新一轮 turn.started 已接棒（bin/claw.mjs watchThread 同款语义）
        if (event?.type === 'turn.completed') turnSettled = true;
        if (event?.type === 'turn.started') turnSettled = false;
      }

      if (failed) {
        return { reason: 'failed', lifeState, failed, newEvents, tailEvents: tailEvents.slice(-TAIL_EVENT_COUNT) };
      }
      if (['archived', 'closed'].includes(String(thread?.status || ''))) {
        return {
          reason: `thread ${thread?.status}`,
          lifeState,
          failed,
          newEvents,
          tailEvents: tailEvents.slice(-TAIL_EVENT_COUNT),
        };
      }
      if (turnSettled && lifeState !== 'executing') {
        return { reason: 'turn.completed', lifeState, failed, newEvents, tailEvents: tailEvents.slice(-TAIL_EVENT_COUNT) };
      }
      const pending = Array.isArray(thread?.commands)
        ? thread.commands.filter((command: any) => command?.status === 'pending').length
        : 0;
      if (lifeState !== 'executing' && pending === 0) {
        idleRounds += 1;
        if (idleRounds >= 2) {
          return {
            reason: 'idle-no-pending',
            lifeState,
            failed,
            newEvents,
            tailEvents: tailEvents.slice(-TAIL_EVENT_COUNT),
          };
        }
      } else {
        idleRounds = 0;
      }
    }
  }

  /** done 摘要（紧凑输出：只给调度判断所需字段，不回显工单全文）。 */
  function formatSettled(threadId: string, outcome: SettleOutcome, sentLine?: string): string {
    const lines = [
      sentLine,
      `done reason=${outcome.reason}  threadId=${threadId}  life=${outcome.lifeState}  failed=${outcome.failed}  newEvents=${outcome.newEvents}`,
    ];
    if (outcome.reason === 'unreachable' && outcome.detail) {
      lines.push(`detail: ${outcome.detail}`);
    }
    if (outcome.tailEvents.length > 0) {
      lines.push('事件尾：', ...outcome.tailEvents.map(eventLine));
    }
    return lines.join('\n');
  }

  /** 工具超时终态（结构化 done，非错误；模型据此续挂 watch）。 */
  function formatTimeoutDone(threadId: string, outcome: SettleOutcome): string {
    return [
      `done reason=timeout  threadId=${threadId}  life=${outcome.lifeState}  failed=${outcome.failed}  newEvents=${outcome.newEvents}`,
      `工具调用超时（Tool.timeout 契约），指令仍在执行：用 watch ${threadId} 续挂监视，不要重复派发同键指令。`,
      ...(outcome.tailEvents.length > 0 ? ['事件尾：', ...outcome.tailEvents.map(eventLine)] : []),
    ].join('\n');
  }

  // ── 动词实现（参数已过 033 参数校验道；位置语义见策略声明）──────

  const adapter: ThreadAdapter = async (args, context) => {
    const [verb, ...rest] = args;
    switch (verb) {
      // new-session <agentId> [title]：创建 Coder 会话（sessionType=coder），
      // 线程宿主工作空间自动建线（标准路径；create 仅用于已存在会话加挂线程）。
      // 契约参照 bin/claw.mjs handleSessions（sessionType=coder 响应带 threadId）。
      case 'new-session': {
        const [agentId, title] = rest;
        const body: Record<string, unknown> = { agentId, sessionType: 'coder' };
        if (title) body.title = title;
        const payload = await clawFetch('/protoclaw/prebuilt_sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        // threadId 在响应的 session 全量对象之前（服务端为截断安全特意如此排列）
        const sessionId = payload?.session?.id || payload?.targetSessionId || '(unknown)';
        const threadId = payload?.threadId ?? null;
        return [
          `sessionId=${sessionId}`,
          threadId
            ? `threadId=${threadId}`
            : `threadId=null（未自动建线——非线程宿主或钩子失败；用 create ${agentId} ${sessionId} 手动建线）`,
        ].join('\n');
      }

      // create <agentId> <sessionId> [title]：为已存在的 Coder 会话建线程。
      // 预校验（ticket 035B）：建线前 GET 会话列表确认会话存在且归属该
      // agent，杜绝 head_session_missing 僵尸线程；列表按 agentId 查询，
      // 目标会话不在列表 = 不存在或不属于该 agent，同样拒绝。
      case 'create': {
        const [agentId, sessionId, title] = rest;
        let sessionNote = '';
        try {
          const sessionsPayload = await clawFetch(
            `/protoclaw/prebuilt_sessions?agentId=${encodeURIComponent(agentId)}`,
          );
          const sessions = (sessionsPayload?.sessions as Array<Record<string, any>>) || [];
          if (!sessions.some((session) => session?.id === sessionId)) {
            throw new Error(
              `create 拒绝：会话 ${sessionId} 在 agent ${agentId} 名下不存在（或不属于该 agent），未建线程。`
              + ` 无可用 Coder 会话时先用 new-session ${agentId} 创建（自动建线），不要对不存在的会话建线程。`,
            );
          }
        } catch (error) {
          // 结构化拒绝（会话不存在）原样上抛；查询失败（server 瞬时不可达等）
          // 不阻塞建线：网络错误不放大成功能缺失，按原逻辑继续建线，
          // 但响应注明会话未验证
          if (error instanceof Error && error.message.startsWith('create 拒绝')) throw error;
          sessionNote = '注意：建线前会话预校验未完成（查询失败），会话存在性未验证。';
        }
        const body: Record<string, unknown> = { agentId, sessionId };
        if (title) body.title = title;
        const payload = await clawFetch('/protoclaw/threads', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const line = threadLine(payload?.thread ?? payload ?? {});
        return sessionNote ? `${line}\n${sessionNote}` : line;
      }

      // send <threadId> <idempotencyKey> <text>：派发 + 阻塞等本轮落定
      // （幂等键必填，缺失在参数校验道拒绝——复用 threads API 既有字段）
      case 'send': {
        const [threadId, idempotencyKey, text] = rest;
        const payload = await clawFetch(`/protoclaw/threads/${encodeURIComponent(threadId)}/commands`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, idempotencyKey, source: 'coder_shell' }),
        });
        // head runtime 唤起失败：指令已入箱但无承接进程，如实透出（按技能故障表
        // 处置），不进入落定等待——等待只会滞留到一个不会来的 ready。
        const runtimeWake = payload?.runtimeWake;
        if (runtimeWake && runtimeWake.ok === false) {
          return [
            `sent ${payload?.command?.commandId || '(unknown)'} duplicate=${payload?.duplicate === true} delivered=${payload?.delivery?.delivered ?? '(unknown)'}`,
            `runtimeWake=failed (${runtimeWake.code}): ${runtimeWake.message}`,
            'runtime 唤起失败：按技能故障表处置（head_session_missing / runtime_ready_timeout），不要重复派发同键指令。',
          ].join('\n');
        }
        const sentLine = `sent ${payload?.command?.commandId || '(unknown)'} duplicate=${payload?.duplicate === true} delivered=${payload?.delivery?.delivered ?? '(unknown)'}`;
        const outcome = await waitForTurnSettled(threadId, {
          signal: context?.signal,
          termination: context?.termination,
        });
        // settle 窗口内因 Tool.timeout 收尾：结构化 done（非错误），模型续挂 watch
        if (outcome.reason === 'timeout' || outcome.reason === 'interrupted') {
          return [
            sentLine,
            formatTimeoutDone(threadId, outcome),
          ].join('\n');
        }
        return formatSettled(threadId, outcome, sentLine);
      }

      // watch <threadId>：续挂监视，落定即返（超时同 send：结构化 done）
      case 'watch': {
        const [threadId] = rest;
        const outcome = await waitForTurnSettled(threadId, {
          signal: context?.signal,
          termination: context?.termination,
        });
        if (outcome.reason === 'timeout' || outcome.reason === 'interrupted') {
          return formatTimeoutDone(threadId, outcome);
        }
        return formatSettled(threadId, outcome);
      }

      // list [agentId]：线程列表
      case 'list': {
        const [agentId] = rest;
        const query = agentId ? `?agentId=${encodeURIComponent(agentId)}` : '';
        const payload = await clawFetch(`/protoclaw/threads${query}`);
        const threads = (payload?.threads as Array<Record<string, any>>) || [];
        return [`Threads (${threads.length}):`, ...threads.map(threadLine)].join('\n');
      }

      // show <threadId>：线程详情 + 事件尾摘要
      case 'show': {
        const [threadId] = rest;
        const payload = await clawFetch(`/protoclaw/threads/${encodeURIComponent(threadId)}`);
        const thread = payload?.thread || {};
        const eventsPayload = await clawFetch(`/protoclaw/threads/${encodeURIComponent(threadId)}/events`)
          .catch(() => null);
        const tail = ((eventsPayload?.events as Array<Record<string, any>>) || [])
          .slice(-TAIL_EVENT_COUNT);
        return [
          threadLine(thread),
          ...(tail.length > 0 ? ['事件尾：', ...tail.map(eventLine)] : []),
        ].join('\n');
      }

      // archive / unarchive：归档即打断收纳语义透传（执行中归档直接打断收纳，
      // 已归档线程拒绝新指令；系统 409 报错经 dispatch_failed 文案透出）
      case 'archive': {
        const [threadId] = rest;
        const payload = await clawFetch(`/protoclaw/threads/${encodeURIComponent(threadId)}/archive`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: 'coder_shell_dispatch' }),
        });
        return `archived threadId=${payload?.threadId || rest[0]} archivedAt=${payload?.archivedAt || '(unknown)'}`;
      }

      case 'unarchive': {
        const [threadId] = rest;
        const payload = await clawFetch(`/protoclaw/threads/${encodeURIComponent(threadId)}/unarchive`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        return `unarchived threadId=${payload?.threadId || rest[0]}（runtime 不会自动启动，需重新投递指令唤醒）`;
      }

      // deliver <threadId>：恢复闸重投（runtime 不在时自动唤起再投一次）
      case 'deliver': {
        const [threadId] = rest;
        const payload = await clawFetch(`/protoclaw/threads/${encodeURIComponent(threadId)}/deliver`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        const runtimeWake = payload?.runtimeWake;
        const lines = [
          `deliver attempted=${payload?.attempted ?? 0} delivered=${payload?.delivered ?? 0}${payload?.reason ? ` reason=${payload.reason}` : ''}`,
        ];
        if (runtimeWake && runtimeWake.ok === false) {
          lines.push(`runtimeWake=failed (${runtimeWake.code}): ${runtimeWake.message}`);
          lines.push('runtime 唤起失败：按技能故障表处置。');
        }
        return lines.join('\n');
      }

      default:
        // 动词道保证到不了这里；防御性拒绝保持报文契约
        throw new Error(`未知动词: ${verb ?? '(空)'}`);
    }
  };

  return { threads: adapter };
}
