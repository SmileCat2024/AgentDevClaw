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
 * new-session 直调 POST /protoclaw/prebuilt_sessions（agentId=coder，ADR-0025，
 * 契约参照 bin/claw.mjs handleSessions：--dir 映射 openDirectory；目录必填，
 * 服务端拒绝目录回退默认——coder 绑错项目的代价是在错误仓库施工）；
 * 响应 threadId 在 session
 * 对象之前（服务端为截断安全特意如此排列）。会话自动建线是标准路径，
 * create 仅用于给已存在会话加挂线程（建线前预校验会话存在且归属匹配，
 * 消灭 head_session_missing 僵尸线程，ticket 035B）。
 *
 * send 提交后登记监视并返回；watch 查询或建立监视并登记一次性待命。
 * 观察生命周期由 CoderMonitor 与 BackgroundAccess 承接，工具不等待执行落定。
 *
 * advance / resume 不入动词表（rotation_failed 残局需人工介入，与技能
 * 故障表一致）：模型调用时得到 unknown_verb + 结构化指引。
 */

import { stat } from 'node:fs/promises';
import { isAbsolute, normalize } from 'node:path';
import type { BackgroundAccess } from '@agentdevjs/core';
import type { CoderMonitor } from './coder-monitor.js';

/** 落定报文附带的事件尾条数（取证用，防长文本撑爆上下文）。 */
const TAIL_EVENT_COUNT = 5;
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
  monitor?: CoderMonitor;
  access?: BackgroundAccess;
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
  monitor?: CoderMonitor;
  access?: BackgroundAccess;
}): { threads: ThreadAdapter } {
  const origin = deps.serverOrigin.replace(/\/+$/, '');
  const fetchImpl: FetchLike = deps.fetchImpl
    ?? (async (url, init) => {
      const response = await fetch(url, init);
      return { ok: response.ok, status: response.status, json: () => response.json() };
    });
  /** 请求 /protoclaw/threads* 控制面（同 bin/claw.mjs clawServerFetch 契约）。 */
  async function request(pathname: string, init: RequestInit = {}): Promise<Record<string, any>> {
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
      // 完整响应体一并挂上（ADR-0027 修订一）：内核结构化拒绝（如
      // threadQuota 负载）经此可被调用方按结构消费，不依赖 message
      // 字符串匹配。
      (error as any).payload = payload;
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
    // ADR-0019：挂起落定的 turn.completed 标记 suspended 与任务数
    const suspendedMark = event?.type === 'turn.completed' && event?.suspended === true
      ? ` suspended${Array.isArray(event?.pendingWakeups) ? ` (pending=${event.pendingWakeups.length})` : ''}`
      : '';
    return `  event: ${event?.type || 'event'}${turn}${itemType}${suspendedMark}`;
  }

  // ── 动词实现（参数已过 033 参数校验道；位置语义见策略声明）──────

  const adapter: ThreadAdapter = async (args, context) => {
    const [verb, ...rest] = args;
    const clawFetch = (pathname: string, init: RequestInit = {}) => {
      context?.signal?.throwIfAborted();
      return request(pathname, { ...init, signal: context?.signal });
    };
    switch (verb) {
      // new-session <agentId> <目录> [title]：创建 Coder APP 会话（agentId=coder，
      // ADR-0025），线程宿主 APP 自动建线（标准路径；create 仅用于已存在会话加挂线程）。
      // 目录必填（服务端已禁止目录回退默认——workspace 最近目录随上次切换
      // 漂移，裸创建几乎必然绑错项目），本地先校验绝对路径与存在性，
      // 错误在派发侧即出，不等 server 400。
      // 契约参照 bin/claw.mjs handleSessions（--dir 映射 openDirectory；
      // coder APP 响应带 threadId）。
      case 'new-session': {
        const [agentId, directory, title] = rest;
        // ADR-0025：coder 是独立 APP（agentId=coder 直接寻址）。本工具是
        // Coder 调度域，写动词锁定 coder 域——传宿主 APP id 会把会话建进
        // 编程小助手名下（绕过目录闸门且不自动建线），结构化拒绝。
        if (agentId !== 'coder') {
          throw new Error(
            `new-session 拒绝：agentId 必须是 coder（收到 “${agentId}”）。`
            + ' coder 是独立 APP（ADR-0025），Coder 会话直接以 agentId=coder 创建，'
            + '不存在其它可派遣的目标 agent。用法：new-session coder <目标工作目录> [标题]',
          );
        }
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
        // ── 线程配额预检（ADR-0027 修订一调度方 UX 层，不承担强制）──────
        // 读配额与非终态线程计数（同一 GET 一次拿齐），满额时提前给可读
        // 提示，不发起注定被拒的创建请求。查询失败不阻塞派发：强制点在
        // server 建线入口（会话落盘之前），竞态与失败由 429 结构化拒绝
        // 兜底（message 已含可行动建议，error.payload.threadQuota 可按
        // 结构消费）。
        try {
          const settings = await clawFetch('/protoclaw/workspace_settings');
          const limit = (settings as any)?.resourcePolicy?.coder?.maxLiveThreads;
          if (Number.isInteger(limit) && limit > 0) {
            const live = (settings as any)?.liveThreads?.coder;
            if (Number.isInteger(live) && live >= limit) {
              throw new Error(
                `new-session 预检拒绝：coder 线程并发上限已满（未归档 ${live}/${limit}），未发起创建。`
                + ' 可行动：归档自己已完成的线程腾出名额（archive），或请用户在 设置 → 工作空间 调整线程并发上限，或放弃本次派发。',
              );
            }
          }
        } catch (error) {
          if (error instanceof Error && error.message.startsWith('new-session 预检拒绝')) throw error;
          // 预检查询失败（server 瞬时不可达等）：继续派发，建线入口兜底。
        }
        const body: Record<string, unknown> = {
          agentId,
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
        // 域校验同 new-session：Coder 调度域内不存在其它目标 agent。
        if (agentId !== 'coder') {
          throw new Error(
            `create 拒绝：agentId 必须是 coder（收到 “${agentId}”）。`
            + ' 用法：create coder <sessionId> [标题]',
          );
        }
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

      // Submission and observation are separate facts; neither operation waits for execution.
      case 'send': {
        const dispatchOnly = rest.includes('--dispatch-only');
        const [threadId, idempotencyKey, text] = rest.filter((token) => token !== '--dispatch-only');
        const payload = await clawFetch(`/protoclaw/threads/${encodeURIComponent(threadId)}/commands`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, idempotencyKey, source: 'coder_shell' }),
          signal: context?.signal,
        });
        const commandId = payload?.command?.commandId;
        const receipt = `sent ${commandId || '(unknown)'} duplicate=${payload?.duplicate === true} delivered=${payload?.delivery?.delivered ?? '(unknown)'}`;
        const wake = payload?.runtimeWake?.ok === false
          ? `runtimeWake=failed (${payload.runtimeWake.code}): ${payload.runtimeWake.message}` : '';
        if (dispatchOnly) return [receipt, wake, 'dispatch-only：未登记监视；需要时显式 watch。'].filter(Boolean).join('\n');
        try {
          if (!deps.monitor) throw new Error('未装配后台监视接入');
          return [receipt, wake, await deps.monitor.observe({ threadId, commandId })].filter(Boolean).join('\n');
        } catch (error) {
          return [receipt, wake, `monitor=failed：${String(error)}。提交已生效，未回滚；用 watch ${threadId} --command=${commandId || '<commandId>'} 重建，不要重发任务。`].filter(Boolean).join('\n');
        }
      }

      case 'watch': {
        if (!deps.monitor || !deps.access) throw new Error('watch 要求已装配后台监视与唤醒投递器');
        const commandId = rest.find((token) => token.startsWith('--command='))?.slice('--command='.length);
        const threads = rest.filter((token) => !token.startsWith('--command='));
        if (commandId && threads.length !== 1) throw new Error('--command 只接受一个 threadId');
        const lines: string[] = [];
        let waiting = false;
        for (const threadId of threads) {
          const thread = (await clawFetch(`/protoclaw/threads/${encodeURIComponent(threadId)}`, { signal: context?.signal })).thread;
          const commands = (thread?.commands || []).filter((c: any) => c.source === 'coder_shell');
          const ids = commandId ? [commandId] : commands.slice(-1).map((c: any) => c.commandId);
          if (!ids.length) throw new Error(`线程 ${threadId} 没有可关联的派发指令；请用 --command=<commandId> 明确目标`);
          for (const id of ids) {
            const identity = { threadId, commandId: id };
            lines.push(await deps.monitor.observe(identity));
            waiting ||= deps.monitor.isObserving(identity);
          }
        }
        if (waiting) deps.access.requestStandby();
        return lines.join('\n');
      }

      // result <threadId> [--turn=N]：取末轮回复（缺省）或指定轮回复全文。
      // 事件流里 item.completed 且 item.type=agent_message 携带回复全文；
      // 核心内容不一定在最后一条（末轮可能只是简短确认/追问回答），
      // 报文尾附全部轮次索引（turn + 字符数，字符数是定位实质报告的
      // 信号）供 --turn=N 精取。报文头附 head sessionId（纯寻址字段）。
      case 'result': {
        const turnFlag = /^--turn=(.*)$/.exec(rest.find((token) => token.startsWith('--turn=')) || '');
        const requestedTurn = turnFlag ? Number(turnFlag[1]) : null;
        if (turnFlag && (!Number.isSafeInteger(requestedTurn) || requestedTurn < 0)) {
          throw new Error(`result 拒绝：--turn 的值 “${turnFlag[1]}” 必须是非负整数轮次号。用法：result <threadId> [--turn=N]`);
        }
        const [threadId] = rest.filter((token) => !token.startsWith('--turn='));
        let headSessionId = '';
        try {
          const threadPayload = await clawFetch(`/protoclaw/threads/${encodeURIComponent(threadId)}`);
          headSessionId = String(threadPayload?.thread?.headSessionId || '');
        } catch { /* 线程详情瞬时不可达不阻塞取回复，session 字段缺省 */ }
        const payload = await clawFetch(`/protoclaw/threads/${encodeURIComponent(threadId)}/events`);
        const events = (payload?.events as Array<Record<string, any>>) || [];
        const messages: Array<Record<string, any>> = [];
        for (const event of events) {
          if (event?.type === 'item.completed' && event?.item?.type === 'agent_message') {
            messages.push(event.item);
          }
        }
        if (messages.length === 0) {
          return `result: 线程 ${threadId} 尚无 agent_message 事件（无末轮回复可取）`;
        }
        const target = requestedTurn !== null
          ? messages.filter((item) => Number(item?.turn) === requestedTurn).at(-1)
          : messages[messages.length - 1];
        if (!target) {
          const available = messages.map((item) => item?.turn).join(',');
          throw new Error(`result 拒绝：线程 ${threadId} 无 turn=${requestedTurn} 的 agent_message。可用轮次：${available}`);
        }
        const text = String(target.text || '');
        const turn = target.turn !== undefined ? ` turn=${target.turn}` : '';
        const session = headSessionId ? `  session=${headSessionId}` : '';
        // 末轮回复是调度方必读的交接材料，动词层不截断（与 CLI watch
        // --with-result 同语义）；极端超长由工具层共享落盘机制兜底
        //（头尾保留 + 全文写盘附路径）。
        const lines = [
          `result threadId=${threadId}${turn}  chars=${text.length}${session}`,
          text,
        ];
        if (messages.length > 1) {
          const index = messages
            .map((item) => `${item?.turn}(chars=${String(item?.text || '').length})`)
            .join('  ');
          lines.push(`（本线程共 ${messages.length} 条回复，按序：${index}；取指定轮全文：result ${threadId} --turn=<轮次>）`);
        }
        return lines.join('\n');
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
