/**
 * SessionReferenceFeature — 通用会话内容读取（话题接续读取面）
 *
 * 会话内容的三级读取协议：发现（session_list）→ 概览（session_read_overview，
 * trim 投影视图）→ 某轮全量（session_read_turn）。纯读取视图：不落盘任何
 * 中间材料文件，每次调用对源会话快照现场投影。
 *
 * session_read_overview 双模寻址：sessionId 输入走会话概览（trim 投影）；
 * threadId 输入（wt- 前缀，线程全局唯一）走线程代际导航索引——线程是
 * "对话"的身份（ADR-0032），一条线程经接续产生多代会话，导航索引按代
 * 列出 sessionId/标题/时间/规模/接续方式，供 AI 定位要深入的会话；内容
 * 读取仍以会话为单位（选定代后回到 sessionId 输入）。
 *
 * 输入框引用联动：user-turn 的 metadata['session-reference']（条目：
 * {agentId, sessionId, title?, sessionType?}）在 CallStart 注入一条
 * reminder，提示 AI 按三级读取协议消费被引用会话。引用随消息一次性流动，
 * feature 不持有引用状态。
 *
 * 数据访问走 Claw server：/protoclaw/session_directory（跨 agent 会话目录，
 * 只读各 agent 的 index.json 元数据 + threads/index.json 线程归属标注）与
 * /protoclaw/session_record（规范化消息，含远程命名空间转发）、
 * /protoclaw/threads/:threadId（线程详情 + 代际元数据）。投影复用框架
 * trim 引擎的纯函数 buildTrimmedSeedMessages（默认策略：对话骨架保留、
 * 工具活动折叠），与语境接续（handoff 落盘交接）共享投影逻辑、不共享
 * 任何链路。
 */

import type { AgentFeature, Tool } from '@agentdevjs/core';
import type { CallStartContext, Context } from '@agentdevjs/core';
import { CoreLifecycle, getPackageInfoFromSource } from '@agentdevjs/core';
import type { HookDeclarations, PackageInfo } from '@agentdevjs/core';
import { buildTrimmedSeedMessages, normalizeExportPolicy } from '@agentdevjs/core';
import { fileURLToPath } from 'url';
import { internalAuthHeaders } from '../../shared/src/internal-auth.js';

const OVERVIEW_MAX_CHARS = 30_000;
// 概览正文档的单条消息内容上限：概览是定位用视图，超长正文由 read_turn 全量展开。
const OVERVIEW_LINE_CHAR_LIMIT = 1_200;
// 单轮全量正文的字符预算：超预算时首尾各半保留、中段省略并明示。
// 单轮内可能夹带巨型工具结果（实测单轮正文 45K+），无预算会直灌上下文。
const TURN_DETAIL_MAX_CHARS = 40_000;
// 会话目录里单条 preview 的展示上限。
const LIST_PREVIEW_CHAR_LIMIT = 120;
// todo 语义锚点里单条任务标题的展示上限。
const TODO_SUBJECT_CHAR_LIMIT = 60;

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

interface SessionMessage {
  role?: string;
  turn?: number | null;
  content?: unknown;
  toolCalls?: Array<Record<string, unknown>>;
  toolCallId?: string;
  // unknown：兼容框架 trim 引擎返回的 SessionSeedMessage（tag 为 JsonValue），
  // 本文件对 tag 只做严格等值比较（'folded-tool-activity'），不做类型收窄。
  tag?: unknown;
}

function formatTurn(turn: unknown): string {
  return Number.isInteger(turn) ? `T${turn}` : 'T?';
}

/**
 * 概览正文行渲染。tag 为 folded-tool-activity 的注记消息是框架 trim 引擎
 * 生成的折叠摘要（首行为固定标记，后续行为去重后的工具调用摘要），
 * 压成单行呈现。
 */
function renderSeedLine(message: SessionMessage): string {
  const turn = formatTurn(message?.turn);
  const content = typeof message?.content === 'string' ? message.content : '';
  if (message?.tag === 'folded-tool-activity') {
    const detail = content.split('\n').slice(1).join(' ').replace(/\s+/g, ' ').trim();
    return `[${turn}] (工具活动) ${detail || '(无工具调用摘要)'}`;
  }
  const role = cleanText(message?.role) || 'unknown';
  const clipped = content.length > OVERVIEW_LINE_CHAR_LIMIT
    ? `${content.slice(0, OVERVIEW_LINE_CHAR_LIMIT)}…(截断，read_turn 可读全文)`
    : content;
  return `[${turn}] ${role}: ${clipped}`;
}

interface CallGroup {
  turn: number | null;
  steps: SessionMessage[];
}

/**
 * 将 seed messages 按 call（turn）分组。turn 缺失的 step 归入前一个
 * call，保证分组永远落在 call 边界。
 */
function groupSeedByCall(seedMessages: SessionMessage[]): CallGroup[] {
  const calls: CallGroup[] = [];
  let currentTurn: number | null = null;
  let currentSteps: SessionMessage[] = [];
  for (const raw of Array.isArray(seedMessages) ? seedMessages : []) {
    const message = raw as SessionMessage;
    const turn = Number.isInteger(message?.turn) ? (message.turn as number) : currentTurn;
    if (currentSteps.length > 0 && turn !== currentTurn) {
      calls.push({ turn: currentTurn, steps: currentSteps });
      currentSteps = [];
    }
    currentSteps.push(message);
    currentTurn = turn;
  }
  if (currentSteps.length > 0) calls.push({ turn: currentTurn, steps: currentSteps });
  return calls;
}

const TODO_STATUS_VERBS: Record<string, string> = {
  pending: '置回待办',
  in_progress: '开始执行',
  completed: '完成',
  deleted: '取消',
};

interface TodoEvent {
  turn: number | null;
  verb: string;
}

interface TodoTaskEvent {
  subject: string;
  timeline: TodoEvent[];
}

/**
 * 从原始消息提取 todo 语义锚点：task_create / task_update 的调用参数在
 * trim 投影后已被折叠丢弃，因此必须对原始消息解析。按 taskId 聚合为
 * 任务生命周期（创建 → 开始执行 → 完成/取消），标注事件发生的 call 号。
 */
export function extractTodoEvents(messages: SessionMessage[]): TodoTaskEvent[] {
  const toolResultById = new Map<string, unknown>();
  for (const message of Array.isArray(messages) ? messages : []) {
    if (cleanText(message?.role) === 'tool' && cleanText(message?.toolCallId)) {
      toolResultById.set(cleanText(message.toolCallId), message?.content);
    }
  }
  const ordered: TodoTaskEvent[] = [];
  const byKey = new Map<string, TodoTaskEvent>();
  const findOrCreate = (key: string, subject: string): TodoTaskEvent => {
    let event = byKey.get(key);
    if (!event) {
      event = { subject, timeline: [] };
      byKey.set(key, event);
      ordered.push(event);
    }
    return event;
  };

  for (const message of Array.isArray(messages) ? messages : []) {
    const calls = Array.isArray(message?.toolCalls) ? message.toolCalls : [];
    if (calls.length === 0) continue;
    const turn = Number.isInteger(message?.turn) ? (message.turn as number) : null;
    for (const call of calls) {
      const name = cleanText(call?.name);
      if (name !== 'task_create' && name !== 'task_update' && name !== 'task_clear') continue;
      const args = (call?.args ?? call?.arguments ?? {}) as Record<string, unknown>;
      if (name === 'task_create') {
        const subject = truncateText(cleanText(args?.subject) || '(未命名任务)', TODO_SUBJECT_CHAR_LIMIT);
        let taskId = '';
        const result = toolResultById.get(cleanText(call?.id));
        if (typeof result === 'string') {
          try { taskId = cleanText(JSON.parse(result)?.taskId); } catch { /* 结果非 JSON 时忽略 */ }
        }
        const event = findOrCreate(taskId || `subject:${subject}`, subject);
        event.timeline.push({ turn, verb: '创建' });
      } else if (name === 'task_update') {
        const taskId = cleanText(args?.taskId);
        const status = cleanText(args?.status);
        const subject = cleanText(args?.subject);
        const verb = TODO_STATUS_VERBS[status] || `状态→${status || 'unknown'}`;
        const event = byKey.get(taskId)
          ?? findOrCreate(taskId || `subject:${subject || 'unknown'}`, subject || `任务 ${taskId || 'unknown'}`);
        if (subject) event.subject = truncateText(subject, TODO_SUBJECT_CHAR_LIMIT);
        event.timeline.push({ turn, verb });
      } else {
        const event = findOrCreate('task_clear', '(任务列表)');
        event.timeline.push({ turn, verb: '清空列表' });
      }
    }
  }
  return ordered.filter((event) => event.timeline.length > 0);
}

function renderTodoTimeline(events: TodoTaskEvent[]): string[] {
  if (events.length === 0) return [];
  const lines = ['## 任务事件（todo 语义锚点，T<N> = 事件发生的 call）'];
  for (const event of events) {
    const timeline = event.timeline
      .map((step) => `${step.verb}${step.turn === null ? '' : ` T${step.turn}`}`)
      .join(' → ');
    lines.push(`- 「${event.subject}」 ${timeline}`);
  }
  return lines;
}

/**
 * call 的单行速览形态（概览预算不足时的降级粒度）：
 * 轮次号 + step 数 + 首条 user 意图 + 最后一条 assistant 结论摘要。
 */
function renderCallOneLiner(group: CallGroup): string {
  const turn = formatTurn(group.turn);
  let userHead = '';
  let assistantTail = '';
  let toolNoteCount = 0;
  for (const step of group.steps) {
    const content = typeof step?.content === 'string' ? step.content : '';
    if (step?.tag === 'folded-tool-activity') {
      toolNoteCount += 1;
      continue;
    }
    const role = cleanText(step?.role);
    if (role === 'user' && !userHead) {
      userHead = truncateText(content.replace(/\s+/g, ' ').trim(), 60);
    }
    if (role === 'assistant') {
      assistantTail = truncateText(content.replace(/\s+/g, ' ').trim(), 80);
    }
  }
  const parts: string[] = [];
  if (userHead) parts.push(userHead);
  if (assistantTail) parts.push(`结论: ${assistantTail}`);
  if (toolNoteCount > 0) parts.push(`工具活动 ×${toolNoteCount}`);
  return `[${turn}] (${group.steps.length} 条) ${parts.join(' ｜ ') || '(空轮次)'}`;
}

/**
 * trim 视图概览：todo 语义锚点（从原始消息提取——trim 投影会丢掉工具参数）
 * + 按 call 分组的转录。概览必须覆盖全部轮次（read_turn 需要轮次号寻址，
 * 丢轮等于丢入口）：正文总长超预算时，从最老的轮次开始降级为单行速览，
 * 最新轮次保持正文；全部降级仍装不下时才允许省略并明示。
 */
export function renderSeedOverview(
  rawMessages: SessionMessage[],
  seedMessages: SessionMessage[],
  meta: { agentId: string; sessionId: string },
): { text: string; truncated: boolean } {
  const header = [
    `[会话转录概览] ${meta.agentId}/${meta.sessionId}`,
    '（trim 视图：对话保留、工具活动折叠为摘要；轮次号 T<N> 用于 session_read_turn 深入）',
  ];

  const body: string[] = [...header];
  let used = header.join('\n').length;
  let truncated = false;

  const todoLines = renderTodoTimeline(extractTodoEvents(rawMessages));
  if (todoLines.length > 0) {
    const block = ['──────────────────', ...todoLines];
    body.push(...block);
    used += block.join('\n').length + 1;
  }

  const callGroups = groupSeedByCall(seedMessages);
  const proseTexts = callGroups.map((group) => group.steps.map(renderSeedLine).join('\n'));
  const oneLinerTexts = callGroups.map(renderCallOneLiner);

  // 贪心降级：从最老的轮次开始，把超出预算的轮次从正文形态换成单行速览，
  // 直到总长装进预算。降级的是老轮次，最近轮次保留正文（现状优先）。
  let total = used + proseTexts.reduce((sum, text) => sum + text.length + 2, 0);
  let degradeCount = 0;
  while (degradeCount < callGroups.length && total > OVERVIEW_MAX_CHARS) {
    total -= proseTexts[degradeCount].length + 2;
    total += oneLinerTexts[degradeCount].length + 1;
    degradeCount += 1;
  }

  if (degradeCount > 0) {
    truncated = true;
    body.push('──────────────────', `## 前段轮次（单行速览，细节用 session_read_turn 展开）`);
    for (let index = 0; index < degradeCount; index++) {
      body.push(oneLinerTexts[index]);
    }
  }

  for (let index = degradeCount; index < callGroups.length; index++) {
    body.push('──────────────────', proseTexts[index]);
  }
  return { text: body.join('\n'), truncated };
}

function renderToolCallsInline(toolCalls: Array<Record<string, unknown>>): string[] {
  const lines: string[] = [];
  for (const call of Array.isArray(toolCalls) ? toolCalls : []) {
    const name = cleanText(call?.name) || 'unknown';
    const args = call?.args ?? call?.arguments ?? {};
    let argsText: string;
    try {
      argsText = JSON.stringify(args);
    } catch {
      argsText = '[unserializable]';
    }
    lines.push(`  → 调用 ${name}(${argsText})`);
  }
  return lines;
}

/**
 * 某轮全量展开：按 turn 过滤原始消息（含完整工具调用与结果）。单轮正文
 * 超出 TURN_DETAIL_MAX_CHARS 预算时首尾各半保留、中段省略并明示——首部
 * 是用户意图，尾部是本轮结论，中段通常是巨型工具结果。
 * 返回 null 表示该轮不存在（或消息未标注 turn）。
 */
export function renderTurnDetail(
  messages: SessionMessage[],
  turn: number,
  meta: { agentId: string; sessionId: string },
): { text: string; truncated: boolean; omittedChars: number } | null {
  const selected = (Array.isArray(messages) ? messages : [])
    .filter((message) => message?.turn === turn);
  if (selected.length === 0) return null;
  const lines: string[] = [
    `[会话轮次详情] ${meta.agentId}/${meta.sessionId} ${formatTurn(turn)}（全量，共 ${selected.length} 条消息）`,
  ];
  for (const message of selected) {
    const content = typeof message?.content === 'string' ? message.content : '';
    if (cleanText(message?.role) === 'tool') {
      lines.push(`[${formatTurn(turn)}] tool 结果(${cleanText(message?.toolCallId) || 'unknown'}): ${content}`);
      continue;
    }
    lines.push(`[${formatTurn(turn)}] ${cleanText(message?.role) || 'unknown'}: ${content}`);
    for (const callLine of renderToolCallsInline(message?.toolCalls ?? [])) {
      lines.push(callLine);
    }
  }
  const full = lines.join('\n');
  if (full.length <= TURN_DETAIL_MAX_CHARS) {
    return { text: full, truncated: false, omittedChars: 0 };
  }
  const keep = Math.floor(TURN_DETAIL_MAX_CHARS / 2);
  const omittedChars = full.length - keep * 2;
  const marker = `……（中段省略 ${omittedChars} 字符：单轮正文超出 ${TURN_DETAIL_MAX_CHARS} 预算，首尾各保留一半，被省略的通常是巨型工具结果中段）`;
  return {
    text: `${full.slice(0, keep)}\n${marker}\n${full.slice(full.length - keep)}`,
    truncated: true,
    omittedChars,
  };
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…`;
}

/**
 * 线程 ID 判别：线程全局 ID 固定 wt- 前缀（generateWorkThreadId），与会话
 * ID（session- 前缀）格式天然可辨，双模输入按前缀分流、零歧义。
 */
export function isThreadId(id: string): boolean {
  return id.startsWith('wt-');
}

function formatTimestamp(ms: unknown): string {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return '';
  const date = new Date(value);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 线程代际链条目（sessionChainMeta 形态：链事实 + 会话索引合并元数据）。 */
export interface ThreadChainEntry {
  sessionId?: string;
  role?: string | null;
  startedAt?: number | null;
  endedAt?: number | null;
  endKind?: string | null;
  title?: string | null;
  updatedAt?: string | null;
  messageCount?: number | null;
  archived?: boolean;
}

/** 线程详情记录（GET /protoclaw/threads/:threadId 响应的 thread 字段子集）。 */
export interface ThreadDetailRecord {
  threadId?: string;
  agentId?: string;
  title?: string;
  status?: string;
  lifeState?: string;
  rootSessionId?: string;
  headSessionId?: string;
  sessionChain?: ThreadChainEntry[];
  createdAt?: number;
  updatedAt?: number;
}

const THREAD_LIFE_STATE_LABELS: Record<string, string> = {
  archived: '已归档',
  executing: '执行中',
  'pending-commands': '待投递指令',
  idle: '空闲',
  closed: '已关闭',
};

/**
 * 线程代际导航索引（threadId 输入的概览形态）：线程元信息 + 按代列出的
 * 会话链。这是定位视图不是内容视图——每代给出 sessionId（含可原样填参的
 * agentId 纯值标注）、标题、时间与规模、接续方式，AI 据此选定要深入的
 * 代，再以 sessionId 输入读会话概览。
 *
 * 代际链数据源：优先 sessionChainMeta（服务端已合并会话索引元数据——
 * 标题/规模/归档态，按代倒序最新在前）；缺省时退化为线程记录自带的
 * sessionChain（正序，无索引合并字段）。
 */
export function renderThreadOverview(
  thread: ThreadDetailRecord,
  sessionChainMeta?: ThreadChainEntry[],
): string {
  const threadId = cleanText(thread.threadId);
  const agentId = cleanText(thread.agentId);
  const title = cleanText(thread.title) || '(无标题)';
  const lifeState = cleanText(thread.lifeState);
  const lifeLabel = THREAD_LIFE_STATE_LABELS[lifeState] || lifeState || cleanText(thread.status) || 'unknown';

  let chain: ThreadChainEntry[];
  if (Array.isArray(sessionChainMeta) && sessionChainMeta.length > 0) {
    chain = sessionChainMeta;
  } else {
    chain = [...(Array.isArray(thread.sessionChain) ? thread.sessionChain : [])].reverse();
  }

  const lines = [
    `[线程导航] ${threadId}「${title}」`,
    `agent: ${agentId || 'unknown'} ｜ 状态: ${lifeLabel} ｜ 创建: ${formatTimestamp(thread.createdAt) || 'unknown'} ｜ 更新: ${formatTimestamp(thread.updatedAt) || 'unknown'} ｜ 共 ${chain.length} 代`,
    '（线程是代际导航索引：同一对话经接续产生的各代会话按时间在此列出；选定代后用 session_read_overview 以该代 sessionId + agentId 深入，最终内容读取仍以会话为单位）',
  ];
  if (chain.length === 0) {
    lines.push('（无线程代际记录）');
    return lines.join('\n');
  }

  lines.push('──────────────────', '## 代际链（最新在前）');
  const total = chain.length;
  chain.forEach((entry, index) => {
    const sessionId = cleanText(entry.sessionId) || '(unknown)';
    const generation = total - index; // 倒序下标 0 = 最新代
    const marks = [`第 ${generation} 代`];
    if (sessionId === cleanText(thread.headSessionId)) marks.push('最新');
    if (sessionId === cleanText(thread.rootSessionId)) marks.push('起始');
    const facts: string[] = [];
    if (Number.isFinite(Number(entry.messageCount))) facts.push(`${Number(entry.messageCount)} 条消息`);
    const started = formatTimestamp(entry.startedAt);
    const ended = formatTimestamp(entry.endedAt);
    if (started) facts.push(`${started}${ended ? ` ~ ${ended}` : ' ~ 进行中'}`);
    if (cleanText(entry.endKind)) facts.push(`接续: ${cleanText(entry.endKind)}`);
    if (entry.archived === true) facts.push('会话已归档');
    const entryTitle = cleanText(entry.title);
    lines.push(
      `- [${marks.join('·')}] ${sessionId}${entryTitle ? `「${truncateText(entryTitle, 60)}」` : ''}`
      + ` (${facts.join(', ') || '无元数据'}) — agentId: ${agentId || 'unknown'}`,
    );
  });

  lines.push(
    '──────────────────',
    '阅读策略：最新代承载当前结论与状态、早期代含任务起源与背景；与任务相关的是哪一代就深入哪一代，无需逐代通读。',
  );
  return lines.join('\n');
}

/**
 * 取回线程详情（GET /protoclaw/threads/:threadId，线程全局唯一寻址不依赖
 * agentId）。404 返回 null（线程不存在，调用方转译为可读错误）；其他失败
 * 抛错由调用方捕获。
 */
async function fetchThreadDetail(
  serverOrigin: string,
  threadId: string,
): Promise<{ thread?: ThreadDetailRecord; sessionChainMeta?: ThreadChainEntry[] } | null> {
  const resp = await fetch(`${serverOrigin}/protoclaw/threads/${encodeURIComponent(threadId)}`, {
    headers: internalAuthHeaders(),
  });
  if (resp.status === 404) return null;
  const data = await resp.json().catch(() => null);
  if (!resp.ok) {
    const message = (data as { message?: unknown; error?: unknown } | null);
    throw new Error(cleanText(message?.message) || cleanText(message?.error) || `threads 详情请求失败 (${resp.status})`);
  }
  return data as { thread?: ThreadDetailRecord; sessionChainMeta?: ThreadChainEntry[] } | null;
}

/**
 * 已验证的会话引用条目（injectSessionReferences 的注入输入）。
 */
export interface VerifiedSessionReference {
  agentId: string;
  sessionId: string;
  title: string;
  sessionType: string;
  availability: 'ok' | 'missing' | 'unknown';
}

/**
 * 渲染引用注入 reminder。只陈述引用事实（每条会话的寻址身份），不讲解
 * 工具用法——读取工具的 agentId 是必填参数，AI 填参时从行内标注取值即可。
 * agentId 标注必须是可原样填参的纯值，禁止与 sessionType 等其他字段拼接
 * 成复合 token——历史上 `agent: xxx/main` 的写法会被 AI 整串当 agentId
 * 传入，下游 404（sessionType 不参与寻址，仅是元数据）。
 * 标题由 AI 自动生成，仅供定位参考——文案明确提示不能代表会话真实内容
 * 与方向，以 session_read_overview 实际内容为准。
 */
export function renderReferenceReminder(references: VerifiedSessionReference[]): string {
  const lines = references.map((ref) => {
    const head = `- ${ref.sessionId}${ref.title ? `「${truncateText(ref.title, 80)}」` : ''} — agentId: ${ref.agentId}（身份: ${ref.sessionType}）`;
    if (ref.availability === 'missing') return `${head} — 已不存在，无法读取，请告知用户该引用已失效`;
    if (ref.availability === 'unknown') return `${head} — 读取入口暂不可用，尝试读取失败时请告知用户`;
    return head;
  });
  return [
    '[会话引用] 用户在本条消息中引用了以下会话（标题由 AI 自动生成，仅供参考，不能代表会话真实内容与方向，请以实际读取内容为准）：',
    ...lines,
    '建议先用 session_read_overview 阅读概览，按需用 session_read_turn 深入相关轮次；与当前任务无关的内容可忽略。',
  ].join('\n');
}

function formatDirectoryEntryText(entry: Record<string, unknown>): string[] {
  const title = cleanText(entry.title);
  const agentId = cleanText(entry.agentId);
  const sessionId = cleanText(entry.sessionId);
  const openDirectory = cleanText(entry.openDirectory);
  const updatedAt = cleanText(entry.updatedAt);
  const messageCount = typeof entry.messageCount === 'number' ? entry.messageCount : 0;
  const sessionType = cleanText(entry.sessionType) || 'main';
  const preview = truncateText(cleanText(entry.preview), LIST_PREVIEW_CHAR_LIMIT);
  // 线程归属标注（可空）：同线程的多代条目共享同一 threadId，AI 可据此
  // 识别"这几条是同一对话的几代"并按 threadId 输入读代际导航。
  const threadId = cleanText(entry.threadId);
  const threadTitle = cleanText(entry.threadTitle);
  const threadNote = threadId ? ` — 线程 ${threadId}${threadTitle ? `「${truncateText(threadTitle, 40)}」` : ''}` : '';
  const lines = [
    `[${agentId}] ${sessionId} "${title}" (${sessionType}, ${messageCount}条, ${updatedAt})${openDirectory ? ` @ ${openDirectory}` : ''}${threadNote}`,
  ];
  if (preview) {
    lines.push(`    摘要: ${preview}`);
  }
  return lines;
}

export class SessionReferenceFeature implements AgentFeature {
  readonly name = 'session-reference';
  readonly source = fileURLToPath(import.meta.url).replace(/\\/g, '/');

  private _packageInfo: PackageInfo | null = null;

  getPackageInfo(): PackageInfo | null {
    if (!this._packageInfo) {
      this._packageInfo = getPackageInfoFromSource(this.source);
    }
    return this._packageInfo;
  }

  getTemplateNames(): string[] {
    return ['session-list', 'session-read'];
  }

  /**
   * 输入框引用联动的消费入口：CallStart 读 metadata['session-reference']
   * 并注入 reminder。observe 语义——注入失败不阻断用户消息。
   */
  static hooks: HookDeclarations = {
    injectSessionReferences: { lifecycle: CoreLifecycle.CallStart, kind: 'observe' as const },
  };

  private readonly agentId: string;
  private readonly serverOrigin: string;

  constructor(config: { agentId?: string; serverOrigin?: string } = {}) {
    this.agentId = cleanText(config.agentId)
      || process.env.PROTOCLAW_PREBUILT_AGENT_ID
      || 'programming-helper';
    this.serverOrigin = cleanText(config.serverOrigin)
      || process.env.PROTOCLAW_SERVER_ORIGIN
      || 'http://127.0.0.1:1420';
  }

  /**
   * 解析并注入本条消息携带的会话引用（metadata['session-reference']）。
   * 引用随消息一次性消费：注入 reminder 后 metadata 即完成使命，
   * feature 不保留任何引用状态。
   *
   * 消费入口两个且互斥：call 边界（本 CallStart 钩子）与 call 内注入
   * （onTurnMetadata，agent 正忙时排队的消息经 dispatchTurnMetadata 派发）。
   */
  async injectSessionReferences(ctx: CallStartContext): Promise<void> {
    const raw = (ctx.metadata as Record<string, unknown> | undefined)?.['session-reference'];
    await this.injectReferences(raw, ctx.context, ctx.agent);
  }

  /**
   * call 内注入点的消费入口：运行中追加的带引用消息不再等待 call 结束，
   * reminder 随注入点落位（与 CallStart 路径共享注入逻辑）。
   */
  async onTurnMetadata(
    value: unknown,
    { context, agent }: { context: Context; agent?: unknown },
  ): Promise<void> {
    await this.injectReferences(value, context, agent);
  }

  private async injectReferences(raw: unknown, context: Context, agent?: unknown): Promise<void> {
    const entries = Array.isArray(raw)
      ? raw.filter((item): item is Record<string, unknown> =>
          !!item && typeof item === 'object' && cleanText((item as Record<string, unknown>).sessionId) !== '')
      : [];
    if (entries.length === 0) return;

    const verified = await Promise.all(entries.map(async (entry) => {
      const agentId = cleanText(entry.agentId) || this.agentId;
      const sessionId = cleanText(entry.sessionId);
      const availability = await this.checkAvailability(agentId, sessionId);
      return {
        agentId,
        sessionId,
        title: cleanText(entry.title),
        sessionType: cleanText(entry.sessionType) || 'main',
        availability,
      };
    }));

    const text = renderReferenceReminder(verified);
    const turn = typeof (agent as any)?._callIndex === 'number'
      ? (agent as any)._callIndex
      : 0;
    context.addSystemMessage(text, turn, this.name, 'reminder');
  }

  /**
   * 引用目标的存在性验证。404 → 'missing'（reminder 中明示）；其他失败
   * （网络 / 服务错误）→ 'unknown'，不把基础设施故障误报为会话不存在。
   */
  private async checkAvailability(agentId: string, sessionId: string): Promise<'ok' | 'missing' | 'unknown'> {
    const params = new URLSearchParams({ agentId, sessionId });
    try {
      const resp = await fetch(`${this.serverOrigin}/protoclaw/session_record?${params}`, {
        headers: internalAuthHeaders(),
      });
      if (resp.ok) return 'ok';
      if (resp.status === 404) return 'missing';
      return 'unknown';
    } catch {
      return 'unknown';
    }
  }

  getTools(): Tool[] {
    return [
      {
        name: 'session_list',
        parallelizable: true,
        render: { call: 'session-list', result: 'session-list' },
        description:
          '列出可参考的历史会话目录（跨 agent 聚合）。返回每个会话的 agentId、sessionId、标题、摘要、工作目录与更新时间；' +
          '属于线程宿主工作空间的条目带线程归属标注（— 线程 wt-…「线程标题」）：同一线程的多代条目共享同一 threadId，' +
          '线程 ID 可直接作为 session_read_overview 的输入读代际导航。' +
          '先找到目标会话的 agentId 与 sessionId（会话按二元组寻址），再用 session_read_overview 查看其概览。',
        parameters: {
          type: 'object',
          properties: {
            limit: {
              type: 'number',
              description: '最多返回的会话条数（可选，默认 50，按更新时间倒序）',
            },
            offset: {
              type: 'number',
              description: '跳过前 N 条，与 limit 配合翻页（可选，默认 0）',
            },
            includeArchived: {
              type: 'boolean',
              description: '是否包含已归档会话（可选，默认不包含）',
            },
          },
        },
        execute: async (args: any) => {
          const limit = typeof args?.limit === 'number' && args.limit > 0 ? Math.floor(args.limit) : 50;
          const offset = typeof args?.offset === 'number' && args.offset > 0 ? Math.floor(args.offset) : 0;
          const params = new URLSearchParams({ limit: String(limit) });
          if (offset > 0) params.set('offset', String(offset));
          if (args?.includeArchived === true) params.set('includeArchived', '1');
          try {
            const resp = await fetch(`${this.serverOrigin}/protoclaw/session_directory?${params}`, {
              headers: internalAuthHeaders(),
            });
            const data = await resp.json().catch(() => null);
            if (!resp.ok) {
              return { error: data?.error || `session_directory 请求失败 (${resp.status})` };
            }
            const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
            if (sessions.length === 0) {
              return { text: '没有可参考的会话。', total: 0 };
            }
            const lines = sessions.flatMap(formatDirectoryEntryText);
            const rangeNote = offset > 0 ? `，第 ${offset + 1} 条起` : '';
            return {
              text: `共 ${sessions.length} 个会话（按更新时间倒序${rangeNote}）：\n${lines.join('\n')}`,
              total: sessions.length,
              sessions,
            };
          } catch (err: any) {
            return { error: `会话目录获取失败: ${err?.message || err}` };
          }
        },
      },
      {
        name: 'session_read_overview',
        parallelizable: true,
        render: { call: 'session-read', result: 'session-read' },
        description:
          '读取概览，输入双模：sessionId 输入返回该会话的 trim 视图概览；threadId 输入（wt- 前缀，线程全局唯一）返回线程的代际导航索引。' +
          '会话概览：头部附任务事件时间线（todo 语义锚点），正文为按 call 分组的对话骨架（用户/AI 消息保留，工具活动折叠为单行摘要），每行标注轮次号 T<N>；' +
          '轮次过多时未入正文的轮次以单行速览收录（概览覆盖全部轮次）。' +
          '线程导航：线程元信息 + 代际链（每代的 sessionId、标题、时间与规模、接续方式），用于定位要深入的会话——选定代后仍以该代 sessionId + agentId 调用本工具读会话概览。' +
          '阅读策略：仅对与当前任务相关的轮次/代际深入，不要逐轮通读——概览是索引不是全文；' +
          '用户意图不明确时，先复述概览脉络与用户确认关注点再下钻。',
        parameters: {
          type: 'object',
          properties: {
            sessionId: {
              type: 'string',
              description: '要读取的会话 ID，或线程 ID（wt- 前缀）',
            },
            agentId: {
              type: 'string',
              description: '会话所属的 agent ID（session_list 条目或会话引用 reminder 行内 agentId 标注的值）；sessionId 输入时必填，threadId 输入时无需提供（线程全局唯一）',
            },
          },
          required: ['sessionId'],
        },
        execute: async (args: any) => {
          const sessionId = cleanText(args?.sessionId);
          const agentId = cleanText(args?.agentId);
          if (!sessionId) {
            return { error: 'sessionId is required' };
          }
          try {
            if (isThreadId(sessionId)) {
              const detail = await fetchThreadDetail(this.serverOrigin, sessionId);
              if (detail === null) {
                return {
                  error: `线程不存在: ${sessionId}（线程按全局 ID 寻址；若要读的是对话，请改用 sessionId 输入）`,
                };
              }
              const thread = detail?.thread;
              if (!thread || !cleanText(thread.threadId)) {
                return { error: '线程详情响应缺少 thread 记录' };
              }
              const chainMeta = Array.isArray(detail?.sessionChainMeta) ? detail.sessionChainMeta : undefined;
              const text = renderThreadOverview(thread, chainMeta);
              return { text, threadId: cleanText(thread.threadId) };
            }
            if (!agentId) {
              return { error: 'agentId is required（会话按 (agentId, sessionId) 二元组寻址，不能省略；线程 ID 输入时无需 agentId）' };
            }
            const record = await fetchSessionRecord(this.serverOrigin, agentId, sessionId);
            const messages = Array.isArray(record?.messages) ? record.messages : [];
            if (messages.length === 0) {
              return { error: `会话没有消息: ${agentId}/${sessionId}` };
            }
            const policy = normalizeExportPolicy();
            const { seedMessages } = buildTrimmedSeedMessages(messages, policy);
            const { text, truncated } = renderSeedOverview(messages, seedMessages, { agentId, sessionId });
            return { text, truncated, messageCount: messages.length };
          } catch (err: any) {
            return { error: `会话概览读取失败: ${err?.message || err}` };
          }
        },
      },
      {
        name: 'session_read_turn',
        parallelizable: true,
        render: { call: 'session-read', result: 'session-read' },
        description:
          '读取指定会话某一轮的完整原始内容（含完整的工具调用与工具结果；单轮正文超出预算时保留首尾、中段省略并明示）。' +
          '轮次号来自 session_read_overview 概览中的 T<N> 标注。',
        parameters: {
          type: 'object',
          properties: {
            sessionId: {
              type: 'string',
              description: '要读取的会话 ID',
            },
            turn: {
              type: 'number',
              description: '轮次号（session_read_overview 输出中的 T<N>）',
            },
            agentId: {
              type: 'string',
              description: '会话所属的 agent ID（session_list 条目或会话引用 reminder 行内 agentId 标注的值）',
            },
          },
          required: ['sessionId', 'turn', 'agentId'],
        },
        execute: async (args: any) => {
          const sessionId = cleanText(args?.sessionId);
          const turn = Number(args?.turn);
          const agentId = cleanText(args?.agentId);
          if (!sessionId) {
            return { error: 'sessionId is required' };
          }
          if (!agentId) {
            return { error: 'agentId is required（会话按 (agentId, sessionId) 二元组寻址，不能省略）' };
          }
          if (!Number.isInteger(turn) || turn < 0) {
            return { error: 'turn 必须是非负整数（来自概览中的 T<N> 标注）' };
          }
          try {
            const record = await fetchSessionRecord(this.serverOrigin, agentId, sessionId, turn);
            let messages = Array.isArray(record?.messages) ? record.messages : [];
            if (messages.length === 0) {
              // 按轮取回为空：轮次不存在，或远端旧版忽略 turn 参数后该轮确实无消息。
              // 回退全量取回一次，保证「轮次不存在」错误里 availableTurns 提示可用。
              const full = await fetchSessionRecord(this.serverOrigin, agentId, sessionId);
              messages = Array.isArray(full?.messages) ? full.messages : [];
            }
            const detail = renderTurnDetail(messages, turn, { agentId, sessionId });
            if (detail === null) {
              const availableTurns = collectTurns(messages);
              return {
                error: `轮次 ${turn} 不存在`,
                availableTurns,
                hint: '可先用 session_read_overview 获取有效的轮次标注',
              };
            }
            return {
              text: detail.text,
              turn,
              truncated: detail.truncated,
              omittedChars: detail.omittedChars,
              messageCount: messages.filter((m) => m?.turn === turn).length,
            };
          } catch (err: any) {
            return { error: `会话轮次读取失败: ${err?.message || err}` };
          }
        },
      },
    ];
  }
}

/**
 * 取回会话记录。带 turn 时请求按轮过滤（server 只回该轮消息，省去大体积
 * 全量传输）；远端旧版不认识 turn 参数会回全量，由调用方按 turn 自行过滤，
 * 行为兼容。
 */
async function fetchSessionRecord(serverOrigin: string, agentId: string, sessionId: string, turn?: number) {
  const params = new URLSearchParams({ agentId, sessionId });
  if (Number.isInteger(turn)) params.set('turn', String(turn));
  const resp = await fetch(`${serverOrigin}/protoclaw/session_record?${params}`, {
    headers: internalAuthHeaders(),
  });
  const data = await resp.json().catch(() => null);
  if (!resp.ok) {
    throw new Error(data?.error || `session_record 请求失败 (${resp.status})`);
  }
  return data;
}

function collectTurns(messages: SessionMessage[]): number[] {
  const turns = new Set<number>();
  for (const message of messages) {
    if (Number.isInteger(message?.turn)) {
      turns.add(message.turn as number);
    }
  }
  return [...turns].sort((a, b) => a - b);
}
