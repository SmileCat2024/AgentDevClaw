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
 * reminder，提示 AI 按三级读取协议消费被引用会话。引用随消息一次性流动。
 *
 * 引用账本（轮转接续）：用户引用与 AI 主动读取过的会话记入 feature 内存
 * 账本（上限条目、最新来源覆盖、lastSeenAt 滚动），经 declareContinuity
 * 随会话快照持久化、随 trim / rotate / branch 接续转移到新 runtime。上下文
 * 轮转（trim 折叠会吃掉 reminder 与工具调用参数）后，新代第一次 CallStart
 * 注入一条账本 reminder，把累计的会话寻址重新交还模型——引用的关键信息
 * 不依赖旧上下文存活。每代注入一次（ledgerInjected 代内标志，不随
 * continuity 转移，换代自动复位）。
 *
 * 数据访问走 Claw server：/protoclaw/session_directory（跨 agent 会话目录，
 * 只读各 agent 的 index.json 元数据 + threads/index.json 线程归属标注）与
 * /protoclaw/session_record（规范化消息，含远程命名空间转发；另带
 * title/goal/timestamps/archived 等背景字段，概览头部据此补齐时空背景）、
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
import { declareContinuity } from '../../continuity-participant/src/index.js';
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
// 引用账本容量上限：超出时按 lastSeenAt 挤出最旧条目。账本是每代注入的
// 固定成本（每条约一行），上限保证注入体积有界。
const LEDGER_MAX_ENTRIES = 20;
// 概览头部 goal 字段的展示上限：goal 是会话目标声明，可能很长，超限截断。
const OVERVIEW_GOAL_CHAR_LIMIT = 300;

/**
 * 引用账本 continuity 协议名（claw.* 命名空间，协议字符串随 handoff 落盘，
 * 命名后不可改）。专用协议而非通用透传：为将来 schema 演进（如条目字段
 * 变化需要 export 清理）预留 server 侧 adapter 登记位。
 */
export const SESSION_REFERENCE_CONTINUITY_PROTOCOL = 'claw.session-reference-continuity.v1';

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
 * 概览头部的会话背景元数据（来自 session_record 响应，均可选——旧会话
 * 或远端旧版可能缺字段，渲染时按存在性省略）。时间锚为消息时间戳的
 * 首末有效值（毫秒）。
 */
export interface SessionOverviewMeta {
  agentId: string;
  sessionId: string;
  title?: string;
  goal?: string;
  sessionType?: string;
  archived?: boolean;
  messageCount?: number;
  firstAt?: number | null;
  lastAt?: number | null;
}

/**
 * 从 session_record 的 timestamps（与 messages 平行的毫秒数组）提取时间
 * 范围：首个与最后一个有效值。全空（旧会话无时间锚）返回 null。
 */
export function extractTimeRange(timestamps: unknown): { firstAt: number | null; lastAt: number | null } | null {
  if (!Array.isArray(timestamps)) return null;
  const valid = timestamps.filter((ts): ts is number => typeof ts === 'number' && Number.isFinite(ts) && ts > 0);
  if (valid.length === 0) return null;
  return { firstAt: valid[0], lastAt: valid[valid.length - 1] };
}

/**
 * trim 视图概览：todo 语义锚点（从原始消息提取——trim 投影会丢掉工具参数）
 * + 按 call 分组的转录。头部先给会话时空背景（标题/目标/时间范围/归档态/
 * 消息数——模型据此判断会话新旧与语境），概览必须覆盖全部轮次（read_turn
 * 需要轮次号寻址，丢轮等于丢入口）：正文总长超预算时，从最老的轮次开始
 * 降级为单行速览，最新轮次保持正文；全部降级仍装不下时才允许省略并明示。
 */
export function renderSeedOverview(
  rawMessages: SessionMessage[],
  seedMessages: SessionMessage[],
  meta: SessionOverviewMeta,
): { text: string; truncated: boolean } {
  const header: string[] = [
    `[会话转录概览] ${meta.agentId}/${meta.sessionId}${cleanText(meta.title) ? `「${truncateText(cleanText(meta.title), 80)}」` : ''}`,
  ];
  const facts: string[] = [];
  if (cleanText(meta.sessionType)) facts.push(`类型: ${cleanText(meta.sessionType)}`);
  if (meta.archived === true) facts.push('已归档');
  if (Number.isFinite(Number(meta.messageCount))) facts.push(`原始消息 ${Number(meta.messageCount)} 条`);
  const first = formatTimestamp(meta.firstAt);
  const last = formatTimestamp(meta.lastAt);
  if (first || last) facts.push(`${first || 'unknown'} ~ ${last || '进行中'}`);
  if (facts.length > 0) header.push(facts.join(' ｜ '));
  const goal = cleanText(meta.goal);
  if (goal) header.push(`目标: ${truncateText(goal, OVERVIEW_GOAL_CHAR_LIMIT)}`);
  header.push('（trim 视图：对话保留、工具活动折叠为摘要；轮次号 T<N> 用于 session_read_turn 深入）');

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
 * timestamps（可选，与 messages 平行的毫秒数组）用于头部时间锚：模型读
 * 单轮详情时知道这轮发生在什么时候。
 * 返回 null 表示该轮不存在（或消息未标注 turn）。
 */
export function renderTurnDetail(
  messages: SessionMessage[],
  turn: number,
  meta: { agentId: string; sessionId: string },
  timestamps?: Array<number | null>,
): { text: string; truncated: boolean; omittedChars: number } | null {
  const list = Array.isArray(messages) ? messages : [];
  const selected = list
    .map((message, index) => ({ message, index }))
    .filter((item) => item.message?.turn === turn);
  if (selected.length === 0) return null;
  const timeAnchors = Array.isArray(timestamps) ? timestamps : [];
  const turnTime = selected.reduce((found, item) => {
    if (found) return found;
    return formatTimestamp(timeAnchors[item.index]);
  }, '');
  const lines: string[] = [
    `[会话轮次详情] ${meta.agentId}/${meta.sessionId} ${formatTurn(turn)}`
    + `（全量，共 ${selected.length} 条消息${turnTime ? ` ｜ ${turnTime}` : ''}）`,
  ];
  for (const { message } of selected) {
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

/** ISO 字符串（目录条目 updatedAt 等）→ 本地友好格式；非法输入返回空串。 */
function formatIsoTimestamp(iso: unknown): string {
  if (typeof iso !== 'string' || !iso.trim()) return '';
  const ms = Date.parse(iso.trim());
  return Number.isFinite(ms) ? formatTimestamp(ms) : '';
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
  /** head Session 的索引标题（ADR-0041：线程记录自身的 title 不再消费）。 */
  headSessionTitle?: string | null;
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
  // ADR-0041：对话标题只取当前 head Session 的索引标题。线程记录里的 title
  // 是历史实现残留（也仍可能存在于旧数据里），不作为对话名称使用。
  const title = cleanText(thread.headSessionTitle) || '(无标题)';
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

/**
 * 引用账本条目（captureState 持久化数据，schema 随协议版本管理）。
 * origin 记最近一次交互来源（用户引用 / AI 读取），重复引用或读取时滚动
 * 更新 lastSeenAt 与元数据，不产生重复条目。
 */
export interface LedgerEntry {
  agentId: string;
  sessionId: string;
  title: string;
  sessionType: string;
  origin: 'user-reference' | 'agent-read';
  /** 最近一次引用/读取时刻（ISO 字符串）。 */
  lastSeenAt: string;
}

/** 账本注入 reminder 的条目形态：账本条目 + 注入时的存在性校验结果。 */
export type VerifiedLedgerEntry = LedgerEntry & { availability: 'ok' | 'missing' | 'unknown' };

const LEDGER_ORIGIN_LABELS: Record<LedgerEntry['origin'], string> = {
  'user-reference': '用户引用',
  'agent-read': '已读取',
};

/**
 * 渲染账本注入 reminder。与 renderReferenceReminder 同规则：agentId 标注
 * 必须是可原样填参的纯值（禁止复合 token），标题保留 AI 生成免责声明。
 * 每条带来源与最后交互时间——跨代后模型据此判断引用的新旧与语境。
 */
export function renderLedgerReminder(entries: VerifiedLedgerEntry[]): string {
  const lines = entries.map((entry) => {
    const time = formatTimestamp(Date.parse(entry.lastSeenAt));
    const head = `- ${entry.sessionId}${entry.title ? `「${truncateText(entry.title, 80)}」` : ''}`
      + ` — agentId: ${entry.agentId}（身份: ${entry.sessionType}，${LEDGER_ORIGIN_LABELS[entry.origin] ?? entry.origin}`
      + `${time ? `，${time}` : ''}）`;
    if (entry.availability === 'missing') return `${head} — 已不存在，无法读取`;
    if (entry.availability === 'unknown') return `${head} — 读取入口暂不可用`;
    return head;
  });
  return [
    '[会话引用账本] 本对话（含精简或接续之前的历史段）累计引用或读取过以下会话；轮转后如需回看内容，按行内寻址用 session_read_overview / session_read_turn 读取：',
    ...lines,
    '（标题由 AI 自动生成，仅供参考，不能代表会话真实内容与方向，请以实际读取内容为准；与当前任务无关的条目可忽略。）',
  ].join('\n');
}

function formatDirectoryEntryText(entry: Record<string, unknown>): string[] {
  const title = cleanText(entry.title);
  const agentId = cleanText(entry.agentId);
  const sessionId = cleanText(entry.sessionId);
  const openDirectory = cleanText(entry.openDirectory);
  // updatedAt 是 ISO 原文，渲染为本地友好格式；非法值回退原文（不吞数据）。
  const updatedAt = formatIsoTimestamp(entry.updatedAt) || cleanText(entry.updatedAt);
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

class SessionReferenceFeatureInner implements AgentFeature {
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

  /** 引用账本：本会话（含接续前身）引用/读取过的会话寻址，随 continuity 转移。 */
  private ledger: LedgerEntry[] = [];
  /**
   * 账本注入的代内标志：本代 runtime 已注入过一次账本 reminder 后置位，
   * 不再重复。restoreState（接续/分支/恢复）复位——新代第一次 CallStart
   * 重新注入。热重载（同代恢复）也会复位并多注入一次：信息冗余无害，
   * 漏注入的代价（轮转后寻址丢失）远大于此。
   */
  private ledgerInjected = false;

  constructor(config: { agentId?: string; serverOrigin?: string } = {}) {
    this.agentId = cleanText(config.agentId)
      || process.env.PROTOCLAW_PREBUILT_AGENT_ID
      || 'programming-helper';
    this.serverOrigin = cleanText(config.serverOrigin)
      || process.env.PROTOCLAW_SERVER_ORIGIN
      || 'http://127.0.0.1:1420';
  }

  // ── 引用账本（captureState / restoreState 经 declareContinuity 持久化） ──

  /**
   * 记账：按 (agentId, sessionId) 去重，重复交互滚动更新来源与时间；
   * 超上限时按 lastSeenAt 挤出最旧条目。missing 的引用不记（账本价值在
   * 回看寻址，已删除的会话没有回看价值；存在性在每次注入时重新校验）。
   */
  recordLedger(
    ref: { agentId: string; sessionId: string; title?: string; sessionType?: string },
    origin: LedgerEntry['origin'],
  ): void {
    const agentId = cleanText(ref.agentId);
    const sessionId = cleanText(ref.sessionId);
    if (!agentId || !sessionId) return;
    const title = cleanText(ref.title);
    const sessionType = cleanText(ref.sessionType) || 'main';
    const now = new Date().toISOString();
    const existing = this.ledger.find((e) => e.agentId === agentId && e.sessionId === sessionId);
    if (existing) {
      existing.origin = origin;
      existing.lastSeenAt = now;
      if (title) existing.title = title;
      existing.sessionType = sessionType;
      return;
    }
    this.ledger.push({ agentId, sessionId, title, sessionType, origin, lastSeenAt: now });
    if (this.ledger.length > LEDGER_MAX_ENTRIES) {
      // 挤出最旧：lastSeenAt 最小者。并列（同毫秒批量记账）时取数组中
      // 更靠前的——push 序即插入序，先记的算更旧。不用排序截断：降序
      // 排序的稳定序在并列时会错误地把最新 push 的留在尾部被砍。
      let oldestIndex = 0;
      for (let index = 1; index < this.ledger.length; index++) {
        if (Date.parse(this.ledger[index].lastSeenAt) < Date.parse(this.ledger[oldestIndex].lastSeenAt)) {
          oldestIndex = index;
        }
      }
      this.ledger.splice(oldestIndex, 1);
    }
  }

  captureState(): unknown {
    return { schemaVersion: 1, references: this.ledger.map((entry) => ({ ...entry })) };
  }

  async restoreState(state: unknown): Promise<void> {
    const refs = state && typeof state === 'object'
      ? (state as { references?: unknown }).references
      : null;
    this.ledger = (Array.isArray(refs) ? refs : [])
      .filter((entry): entry is Record<string, unknown> =>
        !!entry && typeof entry === 'object'
        && cleanText((entry as Record<string, unknown>).agentId) !== ''
        && cleanText((entry as Record<string, unknown>).sessionId) !== '')
      .slice(0, LEDGER_MAX_ENTRIES)
      .map((entry) => ({
        agentId: cleanText(entry.agentId),
        sessionId: cleanText(entry.sessionId),
        title: cleanText(entry.title),
        sessionType: cleanText(entry.sessionType) || 'main',
        origin: entry.origin === 'agent-read' ? 'agent-read' as const : 'user-reference' as const,
        lastSeenAt: cleanText(entry.lastSeenAt) || new Date().toISOString(),
      }));
    this.ledgerInjected = false;
  }

  /**
   * 解析并注入本条消息携带的会话引用（metadata['session-reference']），
   * 同时执行每代一次的账本注入（轮转后寻址接续的确定性通道）。
   *
   * 消费入口两个且互斥：call 边界（本 CallStart 钩子）与 call 内注入
   * （onTurnMetadata，agent 正忙时排队的消息经 dispatchTurnMetadata 派发）。
   * 账本注入只在 CallStart 路径：忙时追加的引用有自己的 reminder，账本
   * 在下一次 CallStart（若本代尚未注入过）补齐。
   */
  async injectSessionReferences(ctx: CallStartContext): Promise<void> {
    const entries = this.parseReferenceEntries(
      (ctx.metadata as Record<string, unknown> | undefined)?.['session-reference'],
    );
    const turn = typeof (ctx.agent as any)?._callIndex === 'number'
      ? (ctx.agent as any)._callIndex
      : 0;
    if (!this.ledgerInjected) {
      this.ledgerInjected = true;
      await this.injectLedgerOnce(ctx.context, turn, entries);
    }
    if (entries.length === 0) return;
    await this.verifyAndInjectReferences(entries, ctx.context, turn);
  }

  /**
   * call 内注入点的消费入口：运行中追加的带引用消息不再等待 call 结束，
   * reminder 随注入点落位（与 CallStart 路径共享引用注入逻辑）。
   */
  async onTurnMetadata(
    value: unknown,
    { context, agent }: { context: Context; agent?: unknown },
  ): Promise<void> {
    const entries = this.parseReferenceEntries(value);
    if (entries.length === 0) return;
    const turn = typeof (agent as any)?._callIndex === 'number'
      ? (agent as any)._callIndex
      : 0;
    await this.verifyAndInjectReferences(entries, context, turn);
  }

  /** 解析 metadata 引用条目：非对象数组与缺 sessionId 的条目一律剔除。 */
  private parseReferenceEntries(raw: unknown): Array<Record<string, unknown>> {
    return Array.isArray(raw)
      ? raw.filter((item): item is Record<string, unknown> =>
          !!item && typeof item === 'object' && cleanText((item as Record<string, unknown>).sessionId) !== '')
      : [];
  }

  /**
   * 每代一次的账本注入：把累计引用/读取过的会话寻址重新交还模型。本条
   * 消息刚引用的会话有自己的专属 reminder，从账本注入中排除（同轮不双份）。
   */
  private async injectLedgerOnce(
    context: Context,
    turn: number,
    currentEntries: Array<Record<string, unknown>>,
  ): Promise<void> {
    const exclude = new Set(currentEntries.map((entry) =>
      `${cleanText(entry.agentId) || this.agentId}/${cleanText(entry.sessionId)}`));
    const candidates = this.ledger
      .filter((entry) => !exclude.has(`${entry.agentId}/${entry.sessionId}`))
      .sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt));
    if (candidates.length === 0) return;
    const verified: VerifiedLedgerEntry[] = await Promise.all(candidates.map(async (entry) => ({
      ...entry,
      availability: await this.checkAvailability(entry.agentId, entry.sessionId),
    })));
    context.addSystemMessage(renderLedgerReminder(verified), turn, this.name, 'reminder');
  }

  /** 校验存在性 → 注入引用 reminder → 记账（missing 不入账本）。 */
  private async verifyAndInjectReferences(
    entries: Array<Record<string, unknown>>,
    context: Context,
    turn: number,
  ): Promise<void> {
    const verified: VerifiedSessionReference[] = await Promise.all(entries.map(async (entry) => {
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
    context.addSystemMessage(renderReferenceReminder(verified), turn, this.name, 'reminder');
    for (const ref of verified) {
      if (ref.availability === 'missing') continue;
      this.recordLedger(ref, 'user-reference');
    }
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
          '会话概览：头部为会话背景（标题、目标、时间范围、归档态、消息数，缺省字段自动省略）与任务事件时间线（todo 语义锚点），' +
          '正文为按 call 分组的对话骨架（用户/AI 消息保留，工具活动折叠为单行摘要），每行标注轮次号 T<N>；' +
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
            // AI 主动读取同样入账（agent-read 来源）：轮转后账本持有全部
            // 寻址，不依赖旧上下文里的工具调用参数存活。
            this.recordLedger({
              agentId,
              sessionId,
              title: cleanText(record?.title),
              sessionType: cleanText(record?.sessionType),
            }, 'agent-read');
            const policy = normalizeExportPolicy();
            const { seedMessages } = buildTrimmedSeedMessages(messages, policy);
            const timeRange = extractTimeRange(record?.timestamps);
            const { text, truncated } = renderSeedOverview(messages, seedMessages, {
              agentId,
              sessionId,
              title: cleanText(record?.title),
              goal: cleanText(record?.goal),
              sessionType: cleanText(record?.sessionType),
              archived: record?.archived === true,
              messageCount: messages.length,
              firstAt: timeRange?.firstAt ?? null,
              lastAt: timeRange?.lastAt ?? null,
            });
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
            let timestamps = Array.isArray(record?.timestamps) ? record.timestamps : undefined;
            if (messages.length === 0) {
              // 按轮取回为空：轮次不存在，或远端旧版忽略 turn 参数后该轮确实无消息。
              // 回退全量取回一次，保证「轮次不存在」错误里 availableTurns 提示可用。
              const full = await fetchSessionRecord(this.serverOrigin, agentId, sessionId);
              messages = Array.isArray(full?.messages) ? full.messages : [];
              timestamps = Array.isArray(full?.timestamps) ? full.timestamps : undefined;
            }
            const detail = renderTurnDetail(messages, turn, { agentId, sessionId }, timestamps);
            if (detail === null) {
              const availableTurns = collectTurns(messages);
              return {
                error: `轮次 ${turn} 不存在`,
                availableTurns,
                hint: '可先用 session_read_overview 获取有效的轮次标注',
              };
            }
            // 成功读取入账（agent-read 来源）。
            this.recordLedger({
              agentId,
              sessionId,
              title: cleanText(record?.title),
              sessionType: cleanText(record?.sessionType),
            }, 'agent-read');
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
 * continuity 自声明包装：引用账本随 trim / rotate / branch 接续与快照恢复
 * 流转（专用协议，importMode replace——restoreState 恢复的是账本全集，
 * 新代继续滚动记账）。装配方（prebuilt agent.js）继续 import 同名导出，
 * 包装对构造签名与静态 hooks 透明。
 */
export const SessionReferenceFeature = declareContinuity(SessionReferenceFeatureInner, {
  protocol: SESSION_REFERENCE_CONTINUITY_PROTOCOL,
  importMode: 'replace',
});

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
