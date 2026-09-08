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
 * 契约参照 bin/claw.mjs handleSessions：--dir 映射 openDirectory；目录必填，
 * 服务端拒绝目录回退默认——coder 绑错项目的代价是在错误仓库施工）；
 * 响应 threadId 在 session
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
 * watch 多线程 any-settle（bin/claw.mjs threads watch 同语义）：并发单线程
 * 监视，任一线程落定/失败/终态即整条返回，第一个 settle 的胜出；其余停挂
 * 并在报文尾附最后已知状态，模型用一条 watch 续挂剩余线程。
 *
 * advance / resume 不入动词表（rotation_failed 残局需人工介入，与技能
 * 故障表一致）：模型调用时得到 unknown_verb + 结构化指引。
 */

import { stat } from 'node:fs/promises';
import { isAbsolute, normalize } from 'node:path';

/** 线程/server 连续不可达上限（bin/claw.mjs watchThread 同款语义）。 */
const MAX_CONSECUTIVE_FETCH_ERRORS = 3;
/**
 * 事件停滞判定阈值（bin/claw.mjs watchThread 同款语义）：孤儿执行
 * （runtime 死亡后看板残留 running）或 pending 永不承接时，turn.completed
 * 永不收敛。事件粒度是 turn/item 级，长工具调用期间不产生新事件——单凭
 * 事件停滞误杀正常长任务，需叠加 server 附带的 head runtime 进程存活
 * 事实（headRuntimeRunning）才按停滞终态处置。
 */
const STALE_THREAD_MS = 300_000;
/** 落定报文附带的事件尾条数（取证用，防长文本撑爆上下文）。 */
const TAIL_EVENT_COUNT = 5;
/** result 末轮回复的输出上限（超长截断并注明全文长度）。 */
const MAX_RESULT_CHARS = 4_000;
/** list 行内标题的显示上限（工单全文标题会撑爆行宽）。 */
const MAX_TITLE_CHARS = 40;
/** 超长文本省略展示（标题等短字段用）。 */
function ellipsize(text: string, max = MAX_TITLE_CHARS): string {
  const clean = String(text || '').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

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
  const verbs = ['new-session', 'create', 'send', 'watch', 'result', 'list', 'show', 'archive', 'unarchive', 'deliver'] as const;
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
      const error = new Error((payload as any)?.code ? `${detail} [${(payload as any).code}]` : String(detail));
      // 状态与错误码挂到异常上：watch 轮询方据此区分「线程已删（404，
      // 确定终态）」与「server 不可达（连续错误才终态）」
      (error as any).status = response.status;
      (error as any).code = (payload as any)?.code;
      throw error;
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

  /**
   * list 行摘要（信息面比 threadLine 全，调度一屏可读）：
   * 标题 + 项目目录 + 创建/最近活动时间 + pending 指令数；异常标记按需
   * 出现（failed=true / status≠open 时才打印，pending>0 才打印），行短且
   * 异常线程一眼可辨。head 会话 id 不进 list 行（show 有），避免撑宽。
   */
  function listThreadLine(thread: Record<string, any>): string {
    const parts = [
      `threadId=${thread?.threadId || '(unknown)'}`,
      `lifeState=${thread?.lifeState || 'unknown'}`,
    ];
    if (thread?.failed === true) parts.push('failed=true');
    const status = String(thread?.status || 'open');
    if (status && status !== 'open') parts.push(`status=${status}`);
    const commands = Array.isArray(thread?.commands) ? thread.commands : [];
    const pendingCount = commands.filter((command: any) => command?.status === 'pending').length;
    if (pendingCount > 0) parts.push(`pending=${pendingCount}`);
    parts.push(`title=${thread?.title ? ellipsize(String(thread.title)) : '(无标题)'}`);
    if (thread?.headProjectDir) parts.push(`dir=${thread.headProjectDir}`);
    parts.push(`created=${formatThreadTime(thread?.createdAt)}`);
    parts.push(`upd=${formatThreadTime(thread?.lastEventAt ?? thread?.updatedAt)}`);
    return parts.join('  ');
  }

  /** 线程最近活动时间 → 紧凑本地时间（MM-dd HH:mm）。 */
  function formatThreadTime(value: unknown): string {
    const ts = Number(value) || 0;
    if (!ts) return 'unknown';
    const d = new Date(ts);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  // ── list 检索语法 ─────────────────────────────────────────────────
  //
  // CLI 常见用法（= 赋值 flag，任意位置）：位置参数只剩 agentId，其余
  // 条件全走 flag。默认按最近活动倒序取 10 条非终态线程；过滤在 adapter
  // 侧完成——server 列表端点只认 agentId，其余条件（lifeState / 目录 /
  // 标题 / failed）的权威字段都在列表响应上，本地过滤不产生第二事实源。

  /** list 默认显示条数（-n 可覆盖，0 = 不限制）。 */
  const DEFAULT_LIST_LIMIT = 10;

  /** lifeState 合法取值（thread-life-state.js 四态 + closed 终态）。 */
  const LIST_LIFE_STATES = ['executing', 'pending-commands', 'idle', 'archived', 'closed'] as const;

  interface ListFilters {
    agentId?: string;
    statuses: string[];
    failedOnly: boolean;
    dirPrefix?: string;
    title?: string;
    /** null = 不限量（-n=0）；number = 最多显示条数 */
    limit: number | null;
    all: boolean;
  }

  /**
   * list 参数解析：位置参数首项 = agentId，其余为声明 flag（--key=<值>）。
   * 未声明 flag / 裸 --key / 非法枚举 / 非法数值在派发侧即拒绝（报文带用法），
   * 不等 server 或静默忽略——静默忽略过滤条件会让检索结果 silently 失真。
   */
  function parseListArgs(rest: string[]): ListFilters {
    const filters: ListFilters = { statuses: [], failedOnly: false, all: false, limit: DEFAULT_LIST_LIMIT };
    const positional: string[] = [];
    for (const token of rest) {
      const assigned = /^(--status|--dir|--title|-n|--limit)=(.*)$/.exec(token);
      if (assigned) {
        const key = assigned[1];
        if (key === '--status') {
          for (const state of assigned[2].split(',')) {
            const life = String(state.trim());
            if (!LIST_LIFE_STATES.includes(life as (typeof LIST_LIFE_STATES)[number])) {
              throw new Error(`list 拒绝：--status 的值 “${assigned[2]}” 含未知状态，可用: ${LIST_LIFE_STATES.join(',')}`);
            }
            filters.statuses.push(life);
          }
        } else if (key === '--dir') {
          if (!assigned[2]) throw new Error('list 拒绝：--dir 需要目录值，如 --dir=/home/dev/AgentDevClaw');
          filters.dirPrefix = assigned[2];
        } else if (key === '--title') {
          if (!assigned[2]) throw new Error('list 拒绝：--title 需要关键字值');
          filters.title = assigned[2];
        } else {
          const raw = assigned[2];
          const limit = Number(raw);
          if (raw === '' || !Number.isSafeInteger(limit) || limit < 0) {
            throw new Error('list 拒绝：-n/--limit 必须是非负整数（0 = 不限条数）');
          }
          filters.limit = limit === 0 ? null : limit;
        }
        continue;
      }
      if (token === '--all') {
        filters.all = true;
        continue;
      }
      if (token === '--failed') {
        filters.failedOnly = true;
        continue;
      }
      if (token.startsWith('--') || token === '-n') {
        throw new Error(`list 拒绝：未知或写法不支持的参数 “${token}”。用法：list [agentId] [--status=...] [--dir=/目录] [--title=关键字] [-n=条数] [--all] [--failed]（valued flag 必须用 = 赋值形态）`);
      }
      positional.push(token);
    }
    if (filters.statuses.length > 0) filters.statuses = [...new Set(filters.statuses)];
    if (filters.agentId === undefined && positional.length > 0) {
      const agentId = positional[0];
      if (positional.length > 1) {
        throw new Error('list 最多接受 1 个位置参数（agentId）。用法：list [agentId] [--status=...] [--dir=/目录] [--title=关键字] [-n=条数] [--all] [--failed]');
      }
      filters.agentId = agentId;
    }
    return filters;
  }

  /** 目录比较键：反斜杠归一 + 去尾分隔符 + 小写（跨平台路径语义）。 */
  function normalizeDirKey(rawPath: string): string {
    return String(rawPath || '').trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  }

  /** 目录归属判定：thread 目录与过滤前缀相等，或位于其子目录下。 */
  function dirUnder(threadDir: string, prefixKey: string): boolean {
    const threadKey = normalizeDirKey(threadDir);
    if (!threadKey || !prefixKey) return false;
    return threadKey === prefixKey || threadKey.startsWith(`${prefixKey}/`);
  }

  /** 排序锚点：最近活动时间（缺失时回退 updatedAt / createdAt）。 */
  function recencyOf(thread: Record<string, any>): number {
    return Number(thread?.lastEventAt) || Number(thread?.updatedAt) || Number(thread?.createdAt) || 0;
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
        // 线程已删除（record 移除后 404 thread_not_found）：确定终态，续挂
        // 无意义，立即退出——不与 server 不可达混同（那需要连续错误确认）
        if ((error as any)?.code === 'thread_not_found' || (error as any)?.status === 404) {
          return {
            reason: 'thread not found',
            lifeState,
            failed,
            newEvents,
            detail: String((error as Error)?.message || error),
            tailEvents: tailEvents.slice(-TAIL_EVENT_COUNT),
          };
        }
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
      // 终态判定用合成 lifeState：归档是宿主层标记（archive-index），
      // record status 恒为 'open'，按 status 判 archived 永不命中
      const terminalLifeState = String(lifeState || '');
      if (['archived', 'closed'].includes(terminalLifeState)) {
        return {
          reason: `thread ${terminalLifeState}`,
          lifeState,
          failed,
          newEvents,
          tailEvents: tailEvents.slice(-TAIL_EVENT_COUNT),
        };
      }
      // 孤儿执行/滞留：lifeState 卡在 executing（runtime 死亡后看板残留
      // running）或 pending-commands（runtime 永不承接）且事件长期停滞，
      // turn.completed 永不收敛——按停滞终态处置，不烧满 Tool.timeout。
      // 事件停滞不是死亡的充分证据：coder 执行长工具调用（跑实验 / 构建，
      // 可达小时级）期间不产生新 turn/item 事件，事件停滞同样发生；
      // 死亡判定需叠加 head runtime 进程存活事实（server 详情响应附带）。
      // 老版本 server 缺该字段时维持停滞终态，保守行为不变。
      const lastEventAt = Number(thread?.lastEventAt) || 0;
      if (['executing', 'pending-commands'].includes(lifeState) && lastEventAt
        && Date.now() - lastEventAt > STALE_THREAD_MS
        && thread?.headRuntimeRunning !== true) {
        const staleSec = Math.round((Date.now() - lastEventAt) / 1000);
        return {
          reason: 'stalled',
          lifeState,
          failed,
          newEvents,
          detail: thread?.headRuntimeRunning === false
            ? `事件停滞 ${staleSec}s 且 head runtime 进程已不在——孤儿执行，查 Debugger 日志后走恢复路径`
            : `事件停滞 ${staleSec}s——runtime 可能已死亡，查 Debugger 日志后再决定介入方式`,
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
    // unreachable / thread not found / stalled 等终态附诊断 detail
    if (outcome.detail) {
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

  /** waitForTurnSettled 按契约不 reject；此兜底仅防意外异常中断 any-settle 竞速。 */
  function unreachableOutcome(): SettleOutcome {
    return { reason: 'unreachable', lifeState: 'unknown', failed: false, newEvents: 0, tailEvents: [] };
  }

  // ── 动词实现（参数已过 033 参数校验道；位置语义见策略声明）──────

  const adapter: ThreadAdapter = async (args, context) => {
    const [verb, ...rest] = args;
    switch (verb) {
      // new-session <agentId> <目录> [title]：创建 Coder 会话（sessionType=coder），
      // 线程宿主工作空间自动建线（标准路径；create 仅用于已存在会话加挂线程）。
      // 目录必填（服务端已禁止目录回退默认——workspace 最近目录随上次切换
      // 漂移，裸创建几乎必然绑错项目），本地先校验绝对路径与存在性，
      // 错误在派发侧即出，不等 server 400。
      // 契约参照 bin/claw.mjs handleSessions（--dir 映射 openDirectory；
      // sessionType=coder 响应带 threadId）。
      case 'new-session': {
        const [agentId, directory, title] = rest;
        if (!directory) {
          throw new Error(
            `new-session 拒绝：必须显式指定目标工作目录（coder 会话不接受目录回退默认，缺省时服务端会绑定到 workspace 最近目录）。`
            + ` 用法：new-session <agentId> <目标工作目录> [标题]`,
          );
        }
        const normalizedDirectory = normalize(directory);
        if (!isAbsolute(normalizedDirectory)) {
          throw new Error(`new-session 拒绝：目录必须是绝对路径: ${directory}`);
        }
        const directoryStat = await stat(normalizedDirectory).catch(() => null);
        if (!directoryStat?.isDirectory()) {
          throw new Error(`new-session 拒绝：目标工作目录不存在或不是目录: ${directory}`);
        }
        const body: Record<string, unknown> = {
          agentId,
          sessionType: 'coder',
          openDirectory: normalizedDirectory,
        };
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

      // send <threadId> <idempotencyKey> <text> [--no-wait]：派发 + 阻塞等
      // 本轮落定（幂等键必填，缺失在参数校验道拒绝——复用 threads API 既有
      // 字段）。--no-wait：只确认投递即返回，不进落定等待——并行派发多条
      // 长任务时逐条阻塞会烧满工具超时，落定确认交给 watch。flag 按声明
      // 全位置剥离（与参数校验道同语义），位置不影响识别。
      case 'send': {
        const positional = rest.filter((token) => token !== '--no-wait');
        const noWait = positional.length !== rest.length;
        const [threadId, idempotencyKey, text] = positional;
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
        if (noWait) {
          return [
            sentLine,
            `dispatched --no-wait：投递已确认，未等落定。用 watch ${threadId} 续挂等落定，不要重发同键指令。`,
          ].join('\n');
        }
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

      // watch <threadId> [threadId...]：续挂监视，落定即返（超时同 send：
      // 结构化 done）。多线程 any-settle 与 bin/claw.mjs threads watch 同
      // 语义：并发单线程监视，任一线程落定/失败/终态即整条返回，第一个
      // settle 的胜出；其余停挂并附最后已知状态，模型用一条 watch 续挂。
      case 'watch': {
        if (rest.length === 1) {
          const outcome = await waitForTurnSettled(rest[0], {
            signal: context?.signal,
            termination: context?.termination,
          });
          if (outcome.reason === 'timeout' || outcome.reason === 'interrupted') {
            return formatTimeoutDone(rest[0], outcome);
          }
          return formatSettled(rest[0], outcome);
        }
        const watchTargets = rest;
        // 每线程独立中止闸：胜出即停挂其余监视；context 终止（Tool.timeout /
        // 用户打断）级联到全部线程
        const controllers = watchTargets.map(() => new AbortController());
        const contextSignal = context?.signal;
        const abortAll = () => {
          for (const controller of controllers) controller.abort();
        };
        if (contextSignal) {
          if (contextSignal.aborted) abortAll();
          else contextSignal.addEventListener('abort', abortAll, { once: true });
        }
        const attempts = watchTargets.map((threadId, index) =>
          waitForTurnSettled(threadId, {
            signal: controllers[index].signal,
            termination: context?.termination,
          })
            .then((outcome) => ({ threadId, outcome }))
            .catch(() => ({ threadId, outcome: unreachableOutcome() })),
        );
        try {
          const first = await Promise.race(attempts.map(async (attempt) => {
            const { threadId, outcome } = await attempt;
            // timeout/interrupted 是整条调用的终止信号（context 级联产生），
            // 不算单线程胜出
            return {
              threadId,
              outcome,
              settled: outcome.reason !== 'timeout' && outcome.reason !== 'interrupted',
            };
          }));
          if (!first.settled) {
            // 整条调用终止：逐线程附最后已知状态，模型用一条 watch 全部续挂
            const results = await Promise.all(attempts);
            return [
              ...results.map(({ threadId, outcome }) =>
                `done reason=timeout  threadId=${threadId}  life=${outcome.lifeState}  failed=${outcome.failed}  newEvents=${outcome.newEvents}`),
              `工具调用超时（Tool.timeout 契约），指令仍在执行：用 watch ${watchTargets.join(' ')} 续挂监视，不要重复派发同键指令。`,
            ].join('\n');
          }
          // 胜出：停挂其余监视并收集最后已知状态（进程内不弃管，防轮询泄漏）
          abortAll();
          const results = await Promise.all(attempts);
          const losers = results.filter(({ threadId }) => threadId !== first.threadId);
          const stillPending = losers.filter(({ outcome }) =>
            outcome.reason === 'timeout' || outcome.reason === 'interrupted');
          const coSettled = losers.filter(({ outcome }) =>
            outcome.reason !== 'timeout' && outcome.reason !== 'interrupted');
          return [
            formatSettled(first.threadId, first.outcome),
            ...(losers.length > 0 ? [
              '其余监视线程（已停挂）：',
              ...stillPending.map(({ threadId, outcome }) =>
                `  ${threadId}  life=${outcome.lifeState}  failed=${outcome.failed}`),
              ...coSettled.map(({ threadId, outcome }) =>
                `  ${threadId}  done reason=${outcome.reason}  life=${outcome.lifeState}  failed=${outcome.failed}`),
              ...(stillPending.length > 0
                ? [`继续监视：watch ${stillPending.map(({ threadId }) => threadId).join(' ')}`]
                : []),
            ] : []),
          ].join('\n');
        } finally {
          contextSignal?.removeEventListener('abort', abortAll);
        }
      }

      // result <threadId>：取末轮回复（coder 的最终报告）。事件流里
      // item.completed 且 item.type=agent_message 携带回复全文；send/watch
      // 落定后取证用（对应 CLI watch --with-result 的能力，可独立调用）。
      case 'result': {
        const [threadId] = rest;
        const payload = await clawFetch(`/protoclaw/threads/${encodeURIComponent(threadId)}/events`);
        const events = (payload?.events as Array<Record<string, any>>) || [];
        let last: Record<string, any> | null = null;
        for (let i = events.length - 1; i >= 0; i--) {
          const event = events[i];
          if (event?.type === 'item.completed' && event?.item?.type === 'agent_message') {
            last = event;
            break;
          }
        }
        if (!last) {
          return `result: 线程 ${threadId} 尚无 agent_message 事件（无末轮回复可取）`;
        }
        const text = String(last.item.text || '');
        const turn = last.item.turn !== undefined ? ` turn=${last.item.turn}` : '';
        const body = text.length > MAX_RESULT_CHARS
          ? `${text.slice(0, MAX_RESULT_CHARS)}\n…（截断，全文 ${text.length} 字符）`
          : text;
        return [
          `result threadId=${threadId}${turn}  chars=${text.length}`,
          body,
        ].join('\n');
      }

      // list [agentId] [--status=...] [--dir=...] [--title=...] [-n=N] [--all] [--failed]
      // 检索控制（CLI 常见用法：= 赋值 flag，任意位置）。默认按最近活动
      // （lastEventAt）倒序取 10 条非终态线程；过滤在 adapter 侧完成——
      // server 列表端点只认 agentId，其余条件（lifeState / 目录 / 标题 /
      // failed）的权威字段都在列表响应上，本地过滤不产生第二事实源。
      case 'list': {
        const filters = parseListArgs(rest);
        const payload = await clawFetch(`/protoclaw/threads${filters.agentId ? `?agentId=${encodeURIComponent(filters.agentId)}` : ''}`);
        const all = (payload?.threads as Array<Record<string, any>>) || [];
        // 终态（归档/关闭）默认隐藏：是收纳残迹，混在活跃线程里稀释检索
        // 信号；--all 是显式翻查语义，隐藏量附一行，翻查入口可见。显式
        // --status 点名终态时覆盖默认隐藏（点名即所选）。
        const terminal = (thread: Record<string, any>) =>
          ['archived', 'closed'].includes(String(thread?.lifeState || ''));
        const explicitStatus = filters.statuses.length > 0;
        let matched = filters.all || explicitStatus
          ? [...all]
          : all.filter((thread) => !terminal(thread));
        const hiddenTerminal = filters.all || explicitStatus
          ? 0
          : all.filter(terminal).length;
        if (explicitStatus) {
          matched = matched.filter((thread) => filters.statuses.includes(String(thread?.lifeState || '')));
        }
        if (filters.failedOnly) {
          matched = matched.filter((thread) => thread?.failed === true);
        }
        if (filters.dirPrefix) {
          const prefix = normalizeDirKey(filters.dirPrefix);
          matched = matched.filter((thread) => dirUnder(String(thread?.headProjectDir || ''), prefix));
        }
        if (filters.title) {
          const needle = filters.title.toLowerCase();
          matched = matched.filter((thread) => String(thread?.title || '').toLowerCase().includes(needle));
        }
        // 最近活动优先：调度方最关心刚派发/正在执行的线程
        matched.sort((left, right) => recencyOf(right) - recencyOf(left));
        const matchedTotal = matched.length;
        if (typeof filters.limit === 'number' && matched.length > filters.limit) {
          matched = matched.slice(0, filters.limit);
        }
        const lines = [
          `Threads (${matched.length}/${matchedTotal})`,
          ...matched.map(listThreadLine),
        ];
        if (hiddenTerminal > 0) {
          lines.push(`（另有 ${hiddenTerminal} 条已归档/已关闭线程未显示：--all 查看）`);
        }
        if (matched.length < matchedTotal) {
          lines.push(`（只显示最近 ${filters.limit ?? DEFAULT_LIST_LIMIT} 条，-n=0 查看全部）`);
        }
        if (matched.length === 0 && hiddenTerminal === 0) {
          lines.push('（无线程——用 new-session 创建 Coder 会话并建线）');
        }
        return lines.join('\n');
      }

      // show <threadId>：线程详情 + pending 指令数 + 事件尾摘要
      case 'show': {
        const [threadId] = rest;
        const payload = await clawFetch(`/protoclaw/threads/${encodeURIComponent(threadId)}`);
        const thread = payload?.thread || {};
        const eventsPayload = await clawFetch(`/protoclaw/threads/${encodeURIComponent(threadId)}/events`)
          .catch(() => null);
        const tail = ((eventsPayload?.events as Array<Record<string, any>>) || [])
          .slice(-TAIL_EVENT_COUNT);
        const commands = Array.isArray(thread.commands) ? thread.commands : [];
        const pendingCount = commands.filter((command: any) => command?.status === 'pending').length;
        return [
          threadLine(thread),
          ...(commands.length > 0 ? [`commands=${commands.length} (${pendingCount} pending)`] : []),
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
