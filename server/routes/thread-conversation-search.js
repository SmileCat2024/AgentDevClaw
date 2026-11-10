import path from 'node:path';
import { promises as fs } from 'node:fs';
import { segmentGeneration } from './thread-transcript.js';

const INDEX_VERSION = 3;
const MAX_RESULTS = 50;
const MAX_MATCHES_PER_THREAD = 12;

// 搜索域分流：搜对话正文还是工具调用，由调用方显式指定，不做隐式全搜。
export const DOMAIN_ROLES = {
  conversation: ['user', 'assistant'],
  tooling: ['tool', 'tool-call'],
};

// 索引文本截断（按角色）：user/assistant 是检索主力，保留长前缀；工具结果
// 与注入类是体量噪音主力，只保留定位所需前缀。截断行尾部带 [truncated N]。
const TEXT_LIMIT_BY_ROLE = { user: 8000, assistant: 8000, tool: 1200, system: 1200 };
const TOOL_CALL_ARGS_LIMIT = 1200;

// 索引总字符护栏：全量快照达 GB 级的工作空间（编程小助手实测 4.6GB），
// 不设限的 entries 会让 JSON.stringify 超过 V8 单字符串上限（~536M 字符）
// 抛 Invalid string length，索引永远写不出来。三级降级按价值递减排：
// tool 结果行（价值最低）→ tool-call 行（工具名+参数）→ 最旧会话整体。
// user/assistant 正文任何情况下全量保留。会话按更新时间倒序处理。
const INDEX_TOOL_DROP_CHARS = 96_000_000;
const INDEX_CALL_DROP_CHARS = 180_000_000;
const INDEX_HARD_CAP_CHARS = 280_000_000;

function clipIndexText(text, limit) {
  return text.length > limit ? `${text.slice(0, limit)}…[truncated ${text.length}]` : text;
}

function clean(value) { return typeof value === 'string' ? value.trim() : ''; }
function safeId(value) { const id = clean(value); return id && /^[A-Za-z0-9._-]+$/.test(id) ? id : ''; }
function messageText(message) {
  if (typeof message?.content === 'string') return message.content;
  if (Array.isArray(message?.content)) return message.content.filter((part) => part?.type === 'text').map((part) => part.text || '').join('\n');
  return '';
}
function fileSizeOf(session) { return Number(session.fileSize) || 0; }
function queryTerms(query) { return [...new Set(clean(query).toLocaleLowerCase().split(' ').map((term) => term.trim()).filter(Boolean))]; }

export function searchThreadConversations(records, query, { domain = 'conversation', limit = MAX_RESULTS, offset = 0, scope = 'all', from, to } = {}) {
  const parseDateBound = (value, endOfDay = false) => {
    if (typeof value !== 'string' || !value.trim()) return null;
    const raw = value.trim();
    const normalized = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(raw)
      ? `${raw}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`
      : raw;
    const timestamp = Date.parse(normalized);
    return Number.isFinite(timestamp) ? timestamp : null;
  };
  const fromTime = parseDateBound(from);
  const toTime = parseDateBound(to, true);
  if (typeof from === 'string' && from.trim() && fromTime === null) throw new TypeError('from must be a valid ISO date/time');
  if (typeof to === 'string' && to.trim() && toTime === null) throw new TypeError('to must be a valid ISO date/time');
  if (fromTime !== null && toTime !== null && fromTime > toTime) throw new TypeError('from must not be later than to');
  const terms = queryTerms(query);
  if (!terms.length) return { query: '', total: 0, results: [] };
  const roleSet = new Set(DOMAIN_ROLES[domain] || DOMAIN_ROLES.conversation);
  const groupByKey = new Map();
  for (const record of records) {
    const recordTime = Date.parse(String(record.updatedAt || ''));
    if (fromTime !== null && (!Number.isFinite(recordTime) || recordTime < fromTime)) continue;
    if (toTime !== null && (!Number.isFinite(recordTime) || recordTime > toTime)) continue;
    if (scope === 'main' && record.archived === true) continue;
    if (scope === 'archived' && record.archived !== true) continue;
    const actualThreadId = clean(record.threadId);
    const groupKey = actualThreadId || `session:${record.agentId}/${record.sessionId}`;
    let group = groupByKey.get(groupKey);
    if (!group) {
      group = { threadId: actualThreadId || null, agentId: record.agentId, title: record.threadTitle || record.title || '', updatedAt: record.updatedAt || '', archived: record.archived === true, matches: [] };
      groupByKey.set(groupKey, group);
    } else {
      if (String(record.updatedAt || '') > String(group.updatedAt || '')) group.updatedAt = record.updatedAt;
      if (record.archived !== true) group.archived = false;
      if (!group.title && (record.threadTitle || record.title)) group.title = record.threadTitle || record.title;
    }
    for (const message of record.messages || []) {
      if (!roleSet.has(message.role)) continue;
      // 重放副本不参与命中：trim 接续会把前代消息带进 successor，同一内容
      // 在前代的索引里已经可搜，重放段重复命中只会制造噪音（账目已标记）。
      if (message.replayed === true) continue;
      const text = clean(message.text);
      const lower = text.toLocaleLowerCase();
      if (!terms.every((term) => lower.includes(term))) continue;
      if (group.matches.length >= MAX_MATCHES_PER_THREAD) continue;
      const first = Math.min(...terms.map((term) => lower.indexOf(term)));
      const start = Math.max(0, first - 100);
      const end = Math.min(text.length, first + Math.max(...terms.map((term) => term.length)) + 180);
      group.matches.push({
        role: message.role,
        kind: message.kind,
        snippet: `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`,
        source: { agentId: record.agentId, sessionId: record.sessionId, turn: message.turn ?? null, messageIndex: message.messageIndex },
        timestamp: message.timestamp ?? null,
      });
    }
  }
  const allResults = [...groupByKey.values()].filter((group) => group.matches.length)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)) || String(a.threadId || '').localeCompare(String(b.threadId || '')));
  const requestedLimit = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : MAX_RESULTS;
  const safeOffset = Number.isFinite(Number(offset)) && Number(offset) > 0 ? Math.floor(Number(offset)) : 0;
  const results = allResults.slice(safeOffset, safeOffset + Math.min(requestedLimit, MAX_RESULTS));
  return { query, total: allResults.length, results, offset: safeOffset, requestedLimit, maxResults: MAX_RESULTS, limitCapped: requestedLimit > MAX_RESULTS };
}

export function extractSearchableMessages(messages, enriched) {
  const rows = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index] || {};
    const timestamp = Number.isFinite(enriched?.[index]?.timestamp) ? enriched[index].timestamp : null;
    const role = clean(message.role);
    const text = messageText(message);
    if (text.trim() && ['user', 'assistant', 'tool', 'system'].includes(role)) {
      rows.push({
        role,
        kind: message.tag?.kind || message.tag || null,
        text: clipIndexText(text, TEXT_LIMIT_BY_ROLE[role] || 1200),
        turn: message.turn ?? null,
        messageIndex: index,
        timestamp,
      });
    }
    for (const call of Array.isArray(message.toolCalls) ? message.toolCalls : []) {
      const argsText = clipIndexText(JSON.stringify(call.args ?? call.arguments ?? {}), TOOL_CALL_ARGS_LIMIT);
      rows.push({
        role: 'tool-call',
        kind: 'tool-call',
        text: `${clean(call.name)} ${argsText}`.trim(),
        turn: message.turn ?? null,
        messageIndex: index,
        timestamp,
      });
    }
  }
  return rows;
}

/**
 * 按 handoff 账目把重放段的行标记为 replayed。锚定失败（旧产物无账目、
 * 内容漂移）时不标记——宁可重复命中，不做内容级猜测去重。
 */
function markReplayedRows(rows, messages, handoff) {
  if (!handoff) return rows;
  const seg = segmentGeneration({ messages, handoff });
  if (seg.boundary !== 'accounted') return rows;
  for (const row of rows) {
    if (row.messageIndex >= seg.offset && row.messageIndex < seg.seedEnd) row.replayed = true;
  }
  return rows;
}

async function readJson(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }

// Windows 上 rename 到被只读句柄打开的目标（并发读索引、杀毒/索引器扫描刚
// 写完的大文件）会 EPERM；短退避重试吸收这类瞬态窗口。
const RENAME_RETRY_DELAYS_MS = [25, 50, 75];
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EACCES', 'ENOTEMPTY']);

async function persistIndexFile(temporaryPath, indexPath) {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(temporaryPath, indexPath);
      return { ok: true };
    } catch (error) {
      if (!TRANSIENT_RENAME_CODES.has(error?.code) || attempt >= RENAME_RETRY_DELAYS_MS.length) {
        await fs.rm(temporaryPath, { force: true }).catch(() => {});
        return { ok: false, code: error?.code || 'UNKNOWN' };
      }
      await new Promise((resolve) => setTimeout(resolve, RENAME_RETRY_DELAYS_MS[attempt]));
    }
  }
}

// 同 agent 的并发构建在进程内合并成一份：并发 readJson（只读句柄）与 rename
// 重叠在本机 Node 上必然 EPERM，共用 pid 后缀 tmp 的并发写还会互相截断。搜索
// 是缓存读模型，后来者拿到先来者毫秒级领先的快照即可。
const inFlightIndexBuilds = new Map();

/** Build/update a dedicated per-agent message index using session file mtimes. */
export async function ensureThreadConversationIndex(options, charBudgets) {
  const agentId = clean(options?.agentId);
  const agentSessionDir = typeof options?.getAgentSessionDir === 'function' ? options.getAgentSessionDir(agentId) : null;
  if (!agentSessionDir || !safeId(agentId)) throw new Error('agentId/session directory is invalid');
  const indexPath = path.join(agentSessionDir, 'thread-conversation-search.json');
  const inFlight = inFlightIndexBuilds.get(indexPath);
  if (inFlight) return inFlight;
  const build = buildThreadConversationIndex(options, charBudgets, { agentId, indexPath })
    .finally(() => { if (inFlightIndexBuilds.get(indexPath) === build) inFlightIndexBuilds.delete(indexPath); });
  inFlightIndexBuilds.set(indexPath, build);
  return build;
}

async function buildThreadConversationIndex(options, charBudgets, { agentId, indexPath }) {
  const toolDropChars = Number(charBudgets?.toolDrop) || INDEX_TOOL_DROP_CHARS;
  const callDropChars = Number(charBudgets?.callDrop) || INDEX_CALL_DROP_CHARS;
  const hardCapChars = Number(charBudgets?.hardCap) || INDEX_HARD_CAP_CHARS;
  const { getSessionFilePath, sessions, threadBySession, readHandoff } = options;
  let previous = null;
  try {
    const stored = await readJson(indexPath);
    if (stored.version === INDEX_VERSION) previous = stored.entries || {};
  } catch { /* first search or old/corrupt index: rebuild */ }
  const entries = {};
  let indexedChars = 0;
  let droppedToolRows = 0;
  let droppedCallRows = 0;
  let skippedSessions = 0;
  for (const session of sessions) {
    const sessionId = safeId(session.id);
    if (!sessionId) continue;
    const thread = threadBySession.get(sessionId) || {};
    const mtime = Number(session.fileMtimeMs) || 0;
    const fileSize = fileSizeOf(session);
    const cached = previous?.[sessionId];
    const base = cached && mtime > 0 && cached.fileMtimeMs === mtime && cached.fileSize === fileSize ? cached : await (async () => {
      try {
        const snapshot = await readJson(getSessionFilePath(agentId, sessionId));
        const context = snapshot?.runtime?.context || {};
        const messages = Array.isArray(context.messages) ? context.messages : [];
        const enriched = Array.isArray(context.enrichedMessages) ? context.enrichedMessages : [];
        const handoffId = clean(session?.metadata?.handoffId);
        const handoff = typeof readHandoff === 'function' && handoffId
          ? await readHandoff(agentId, handoffId).catch(() => null)
          : null;
        return {
          fileMtimeMs: mtime,
          fileSize,
          messages: markReplayedRows(extractSearchableMessages(messages, enriched), messages, handoff),
        };
      } catch { return null; }
    })();
    if (!base) continue;
    let rows = base.messages;
    if (indexedChars > hardCapChars) {
      skippedSessions += 1;
      continue;
    } else if (indexedChars > callDropChars) {
      const kept = rows.filter((row) => row.role === 'user' || row.role === 'assistant');
      droppedToolRows += rows.filter((row) => row.role === 'tool').length;
      droppedCallRows += rows.filter((row) => row.role === 'tool-call').length;
      rows = kept;
    } else if (indexedChars > toolDropChars) {
      const kept = rows.filter((row) => row.role !== 'tool');
      droppedToolRows += rows.length - kept.length;
      rows = kept;
    }
    const rowChars = rows.reduce((sum, row) => sum + (row.text ? row.text.length : 0), 0);
    if (indexedChars + rowChars > hardCapChars) { skippedSessions += 1; continue; }
    indexedChars += rowChars;
    entries[sessionId] = {
      ...base,
      messages: rows,
      agentId,
      sessionId,
      threadId: thread.threadId || null,
      threadTitle: thread.title || '',
      title: clean(session.title),
      updatedAt: clean(session.updatedAt),
      archived: session.archived === true,
    };
  }
  await fs.mkdir(path.dirname(indexPath), { recursive: true });
  const temporaryPath = `${indexPath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, JSON.stringify({ version: INDEX_VERSION, entries }), 'utf8');
  const persist = await persistIndexFile(temporaryPath, indexPath);
  const result = {
    records: Object.values(entries),
    coverage: {
      degraded: droppedToolRows > 0 || droppedCallRows > 0 || skippedSessions > 0,
      droppedToolRows,
      droppedCallRows,
      skippedSessions,
      indexedChars,
    },
  };
  if (!persist.ok) {
    // 索引已在内存构建完成：持久化失败只降级（磁盘旧索引供下次续跑并重试），
    // 不把整次搜索打挂。
    console.warn(`[thread-conversation-search] index persist degraded for ${agentId} (${persist.code}); serving in-memory index`);
    return { ...result, persistFailed: true };
  }
  return result;
}

export function buildThreadSessionLookup(threadIndexEntries) {
  const bySession = new Map();
  for (const thread of Array.isArray(threadIndexEntries) ? threadIndexEntries : []) {
    for (const sessionId of Array.isArray(thread.sessionIds) ? thread.sessionIds : []) {
      const id = clean(sessionId);
      if (id && !bySession.has(id)) bySession.set(id, { threadId: clean(thread.threadId), title: clean(thread.title) });
    }
  }
  return bySession;
}

export function setupThreadConversationSearchRoute(app, { discoverAgents, readSessionIndex, getAgentSessionDir, threadsRoot, getSessionFilePath, readHandoff }) {
  app.get('/protoclaw/search_conversations', async (req, res, next) => {
    try {
      const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
      const domain = req.query.domain === 'conversation' || req.query.domain === 'tooling' ? req.query.domain : null;
      if (!query || !domain) {
        res.status(400).json({ error: 'q and domain (conversation|tooling) are required' });
        return;
      }
      const agentsFilter = typeof req.query.agents === 'string'
        ? req.query.agents.split(',').map((agent) => clean(agent)).filter(Boolean)
        : null;
      const allAgents = await discoverAgents();
      const targets = agentsFilter ? allAgents.filter((agent) => agentsFilter.includes(agent.id)) : allAgents;
      const threadsIndex = await readJson(path.join(threadsRoot, 'index.json')).catch(() => ({ threads: [] }));
      const threadBySession = buildThreadSessionLookup(threadsIndex.threads);
      const indexed = await Promise.all(targets.map(async (agent) => {
        const index = await readSessionIndex(agent.id);
        const { records, coverage } = await ensureThreadConversationIndex({
          agentId: agent.id,
          getAgentSessionDir,
          getSessionFilePath,
          sessions: index.sessions || [],
          threadBySession,
          readHandoff,
        });
        return { agentId: agent.id, records, coverage };
      }));
      const result = searchThreadConversations(indexed.flatMap((item) => item.records), query, {
        domain,
        scope: req.query.scope === 'main' || req.query.scope === 'archived' ? req.query.scope : 'all',
        from: typeof req.query.from === 'string' ? req.query.from : undefined,
        to: typeof req.query.to === 'string' ? req.query.to : undefined,
        limit: Number(req.query.limit) || MAX_RESULTS,
        offset: Number(req.query.offset) || 0,
      });
      const degradedAgents = indexed.filter((item) => item.coverage.degraded);
      const payload = {
        ...result,
        ...(degradedAgents.length ? {
          indexCoverage: degradedAgents.map(({ agentId, coverage }) => ({ agentId, ...coverage })),
        } : {}),
      };
      res.json({ ...payload, totalThreads: result.total, requestedLimit: result.requestedLimit, maxResults: MAX_RESULTS, limitCapped: result.limitCapped });
    } catch (error) { next(error); }
  });
}
