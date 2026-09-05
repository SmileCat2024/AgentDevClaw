/**
 * Pure functions extracted from session-helpers.js.
 *
 * These functions have no closure dependencies — they only depend on
 * module-level imports. Extracted for testability and to reduce the
 * size of session-helpers.js.
 */

import { cleanSessionText } from '../shared/string-helpers.js';
import {
  normalizeSessionMetadata,
  getPrebuiltSessionFilePath,
} from '../shared/session-access.js';

/**
 * Session index metadata version. Bump when the cached fields schema changes;
 * old index records will auto-heal via the slow path on first access.
 */
export const META_VERSION = 1;

/**
 * Extract token usage from a parsed session file object.
 *
 * @param {object} parsed - parsed session JSON (may have runtime.usageStats)
 * @returns {{ inputTokens: number, outputTokens: number, totalTokens: number, lastRequestUsage: object|null }}
 */
export function extractTokenUsage(parsed) {
  const usageStats = parsed?.runtime?.usageStats;
  const totalUsage = usageStats?.totalUsage;
  return {
    inputTokens: totalUsage?.inputTokens || 0,
    outputTokens: totalUsage?.outputTokens || 0,
    totalTokens: totalUsage?.totalTokens || 0,
    lastRequestUsage: usageStats?.lastRequestUsage || null,
  };
}

/**
 * Extract a short preview from the last non-system message in a message list.
 * Whitespace is collapsed and content is truncated to 140 characters.
 *
 * @param {Array} messages - messages from parsed session file
 * @returns {string}
 */
export function extractLastMessagePreview(messages) {
  if (!Array.isArray(messages)) return '';
  const lastMessage = [...messages].reverse().find(
    (message) => message && typeof message.content === 'string' && message.role !== 'system',
  ) || null;
  return lastMessage?.content ? String(lastMessage.content).replace(/\s+/g, ' ').slice(0, 140) : '';
}

/**
 * Resolve session model info from a persisted index record, prioritizing
 * persisted values and falling back to modelInfoMap when they are missing.
 *
 * Extracted from the summarizePrebuiltSession fast-path so it can be tested
 * directly without spinning up the full session helper factory.
 *
 * @param {object} record - session index record (may have modelName, contextLength, compressRatio)
 * @param {object} modelInfoMap - { default: {...} }
 * @returns {{ modelName: string, contextLength: number|null, compressRatio: number }}
 */
export function resolveSessionModelFromRecord(record, modelInfoMap) {
  const fallbackModelInfo = (modelInfoMap && modelInfoMap.default) || {};
  const persistedModelName = cleanSessionText(record.modelName);
  const persistedCL = Number.isFinite(record.contextLength) && record.contextLength > 0
    ? record.contextLength : null;
  const persistedCR = Number.isFinite(record.compressRatio) && record.compressRatio > 0
    ? record.compressRatio : null;
  return {
    modelName: persistedModelName || fallbackModelInfo.modelName || '',
    contextLength: persistedCL || fallbackModelInfo.contextLength || null,
    compressRatio: persistedCR || fallbackModelInfo.compressRatio || 80,
  };
}

/**
 * Determine which sessions are eligible for cleanup.
 * Only targets default "新对话N" titled sessions that have zero messages
 * or whose session file is missing/corrupt.
 *
 * Extracted from cleanupEmptySessions for testability.
 *
 * @param {Array} sessions - session index records
 * @param {Map} sessionMessageCounts - Map<sessionId, {messageCount, fileExists}>
 *   Sessions not in the map are treated as "file missing" and selected for deletion.
 * @returns {string[]} session IDs to delete
 */
export function selectEmptySessions(sessions, sessionMessageCounts) {
  const toDelete = [];
  for (const record of sessions) {
    if (!/^新对话\d+$/.test(cleanSessionText(record.title))) continue;
    const info = sessionMessageCounts.get(record.id);
    if (!info) {
      toDelete.push(record.id);
      continue;
    }
    if (info.messageCount === 0) {
      toDelete.push(record.id);
    }
  }
  return toDelete;
}

/**
 * Compute the updated index state after removing sessions.
 * If the active session is deleted, shifts to the first remaining session.
 *
 * Extracted from cleanupEmptySessions for testability.
 *
 * @param {object} index - { activeSessionId, sessions }
 * @param {string[]} toDelete - session IDs to remove
 * @returns {object} updated { activeSessionId, sessions }
 */
export function resolvePostCleanupState(index, toDelete) {
  if (toDelete.length === 0) return index;
  const deleteSet = new Set(toDelete);
  let nextActiveId = index.activeSessionId;
  const remaining = index.sessions.filter((s) => !deleteSet.has(s.id));
  if (deleteSet.has(nextActiveId)) {
    nextActiveId = remaining[0]?.id ?? null;
  }
  return { activeSessionId: nextActiveId, sessions: remaining };
}

// ── searchInText (pure function, exported for testing) ────────────

const SEARCH_SNIPPET_RADIUS_EXPORT = 40;

/**
 * 在文本中搜索关键词，返回包含上下文的摘要片段。
 * 纯函数，不依赖闭包上下文，可直接 import 测试。
 */
export function searchInTextPure(text, queryLower) {
  const idx = text.toLowerCase().indexOf(queryLower);
  if (idx === -1) return null;
  const start = Math.max(0, idx - SEARCH_SNIPPET_RADIUS_EXPORT);
  const end = Math.min(text.length, idx + queryLower.length + SEARCH_SNIPPET_RADIUS_EXPORT);
  let snippet = text.slice(start, end);
  snippet = snippet.replace(/^\[[^\]]*\]\s*/, '');
  const beforeSnippet = text.slice(0, idx);
  const lastRoleMatch = beforeSnippet.match(/\[(user|assistant)\][^[]*$/);
  const matchRole = lastRoleMatch ? lastRoleMatch[1] : '';
  return { snippet, matchRole, matchIndex: idx };
}

/**
 * Extract a human-readable label for a tool call (e.g. 'read file.js').
 *
 * Pure function — no closure dependencies, exported for direct testing.
 *
 * @param {string} name - tool name
 * @param {object} args - tool call arguments
 * @returns {string|null}
 */
export function extractToolCallLabel(name, args) {
  if (!args || typeof args !== 'object') return null;
  if (name === 'read' || name === 'edit' || name === 'write') {
    const filePath = typeof args.filePath === 'string' ? args.filePath : '';
    if (filePath) {
      const baseName = filePath.split(/[\\/]/).pop() || filePath;
      return `${name} ${baseName}`;
    }
  }
  if (name === 'invoke_skill') {
    const skill = typeof args.skill === 'string' ? args.skill : '';
    if (skill) return `invoke_skill ${skill}`;
  }
  return null;
}

/**
 * Estimate the character count of a single message for context usage display.
 * Counts content text + tool call names/arguments. This is a rough heuristic
 * (actual token consumption depends on the model's tokenizer), but it gives
 * users a reliable proportional sense of which rounds consume the most context.
 *
 * @param {object} m - message object
 * @returns {number} estimated character count
 */
function estimateMessageCharCount(m) {
  let count = 0;
  // content
  if (typeof m.content === 'string') {
    count += m.content.length;
  } else if (Array.isArray(m.content)) {
    for (const part of m.content) {
      if (typeof part === 'string') count += part.length;
      else if (part && typeof part === 'object') count += JSON.stringify(part).length;
    }
  }
  // tool calls (assistant)
  if (Array.isArray(m.toolCalls)) {
    for (const tc of m.toolCalls) {
      count += typeof tc?.name === 'string' ? tc.name.length : 0;
      const args = tc?.args ?? tc?.arguments;
      if (typeof args === 'string') count += args.length;
      else if (args && typeof args === 'object') count += JSON.stringify(args).length;
    }
  }
  // tool results / function_call_output (often in content as non-string)
  if (m.result != null) {
    if (typeof m.result === 'string') count += m.result.length;
    else count += JSON.stringify(m.result).length;
  }
  return count;
}

/**
 * Estimate the character count of preamble messages (system prompt, injected
 * context, etc.) that appear before the first user message. These messages
 * are not part of any trim round but still consume context window space.
 *
 * @param {Array} messages - session messages
 * @returns {number} estimated character count of preamble
 */
export function estimatePreambleCharCount(messages) {
  let count = 0;
  for (const m of messages) {
    if (m?.role === 'user') break;
    count += estimateMessageCharCount(m);
  }
  return count;
}

/**
 * Build a trim preview of session messages, grouping them into user→assistant rounds.
 * The most recent 2 rounds are marked suggestedTrim=false.
 *
 * Each round includes charCount (estimated characters), cumulativeCharCount
 * (running total from the first round), charPercent (fraction of total), and
 * cumulativePercent (running fraction of total).
 *
 * Pure function — depends only on extractToolCallLabel and estimateMessageCharCount
 * (both module-level).
 *
 * @param {Array} messages - session messages
 * @returns {Array} rounds with preview info and trim suggestions
 */
export function buildSessionTrimPreview(messages) {
  const rounds = [];
  let currentRound = null;

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const role = typeof m?.role === 'string' ? m.role : '';
    if (role === 'user') {
      if (currentRound) rounds.push(currentRound);
      const content = typeof m.content === 'string' ? m.content.replace(/\s+/g, ' ').trim() : '';
      currentRound = {
        roundIndex: rounds.length,
        turnStart: Number.isFinite(m.turn) ? m.turn : i,
        turnEnd: Number.isFinite(m.turn) ? m.turn : i,
        msgIndexStart: i,
        msgIndexEnd: i,
        userPreview: content.slice(0, 200),
        assistantPreview: '',
        toolCalls: [],
        messageCount: 1,
        charCount: estimateMessageCharCount(m),
      };
    } else if (currentRound) {
      currentRound.messageCount += 1;
      currentRound.turnEnd = Number.isFinite(m.turn) ? m.turn : currentRound.turnEnd;
      currentRound.msgIndexEnd = i;
      currentRound.charCount += estimateMessageCharCount(m);
      if (role === 'assistant') {
        const content = typeof m.content === 'string' ? m.content.replace(/\s+/g, ' ').trim() : '';
        if (content && !currentRound.assistantPreview) {
          currentRound.assistantPreview = content.slice(0, 200);
        }
        const toolCalls = Array.isArray(m.toolCalls) ? m.toolCalls : [];
        for (const tc of toolCalls) {
          const name = typeof tc?.name === 'string' ? tc.name : '';
          if (!name) continue;
          let args = tc.args ?? tc.arguments ?? {};
          if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
          const label = extractToolCallLabel(name, args) || name;
          currentRound.toolCalls.push({ name, summary: label });
        }
      }
    }
  }
  if (currentRound) rounds.push(currentRound);

  // Include preamble (system prompt etc.) in the total so that percentages
  // across all rounds + preamble add up to 100%.
  const preambleCharCount = estimatePreambleCharCount(messages);
  let totalCharCount = preambleCharCount;
  for (const r of rounds) totalCharCount += r.charCount;
  let cumulative = 0;
  for (const r of rounds) {
    cumulative += r.charCount;
    r.cumulativeCharCount = cumulative;
    r.charPercent = totalCharCount > 0 ? r.charCount / totalCharCount : 0;
    r.cumulativePercent = totalCharCount > 0 ? cumulative / totalCharCount : 0;
  }

  const recentCount = 2;
  for (let i = 0; i < rounds.length; i++) {
    rounds[i].suggestedTrim = i < rounds.length - recentCount;
  }

  return rounds;
}

/**
 * Build a lightweight session record from an index entry without reading the file.
 *
 * Pure function — depends only on module-level imports (cleanSessionText,
 * normalizeSessionMetadata, getPrebuiltSessionFilePath).
 *
 * @param {string} agentId
 * @param {object} record - session index record
 * @returns {object} lightweight session summary
 */
export function buildLightPrebuiltSessionRecord(agentId, record) {
  const metadata = normalizeSessionMetadata(record?.metadata);
  const sessionType = cleanSessionText(record?.sessionType) || 'main';
  return {
    id: cleanSessionText(record?.id),
    title: cleanSessionText(record?.title),
    featureName: cleanSessionText(record?.featureName),
    agentName: cleanSessionText(record?.agentName),
    taskTitle: cleanSessionText(record?.taskTitle),
    taskType: cleanSessionText(record?.taskType),
    goal: cleanSessionText(record?.goal),
    constraints: cleanSessionText(record?.constraints),
    expectedOutput: cleanSessionText(record?.expectedOutput),
    targetFiles: cleanSessionText(record?.targetFiles),
    referenceMaterials: cleanSessionText(record?.referenceMaterials),
    sessionType,
    status: cleanSessionText(record?.status),
    archived: record?.archived === true,
    todo: record?.todo === true,
    metadata,
    formId: cleanSessionText(record?.formId) || '',
    openDirectory: cleanSessionText(record?.openDirectory),
    createdAt: cleanSessionText(record?.createdAt) || new Date().toISOString(),
    updatedAt: cleanSessionText(record?.updatedAt) || cleanSessionText(record?.createdAt) || new Date().toISOString(),
    path: getPrebuiltSessionFilePath(agentId, cleanSessionText(record?.id) || ''),
    exists: true,
    bytes: record?.fileSize || 0,
    messageCount: typeof record?.messageCount === 'number' ? record.messageCount : 0,
    preview: cleanSessionText(record?.preview),
    hasSummary: record?.hasSummary === true,
    tokenUsage: record?.tokenUsage || { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    contextLength: Number.isFinite(Number(record?.contextLength)) && Number(record.contextLength) > 0
      ? Number(record.contextLength)
      : null,
    compressRatio: Number.isFinite(Number(record?.compressRatio)) && Number(record.compressRatio) > 0
      ? Number(record.compressRatio)
      : 80,
    modelName: cleanSessionText(record?.modelName),
  };
}

export const SIDEBAR_SESSION_META_VERSION = 1;

/**
 * Returns whether an index entry contains the complete, versioned projection
 * required by the production sidebar read model. This deliberately validates
 * field shape rather than truthiness so legitimate empty values remain valid.
 */
export function isSidebarSessionReadModelReady(record) {
  if (!record || typeof record !== 'object') return false;
  if (Number(record.sidebarMetaVersion) < SIDEBAR_SESSION_META_VERSION) return false;
  if (record.archived !== true && record.archived !== false) return false;
  if (record.todo !== true && record.todo !== false) return false;
  if (record.hasSummary !== true && record.hasSummary !== false) return false;
  if (typeof record.createdAt !== 'string' || !record.createdAt) return false;
  if (typeof record.updatedAt !== 'string' || !record.updatedAt) return false;
  if (!Number.isFinite(record.messageCount) || record.messageCount < 0) return false;
  if (typeof record.preview !== 'string') return false;
  if (!record.tokenUsage || typeof record.tokenUsage !== 'object' || Array.isArray(record.tokenUsage)) return false;
  if (typeof record.modelName !== 'string') return false;
  if (record.contextLength !== null && (!Number.isFinite(record.contextLength) || record.contextLength <= 0)) return false;
  if (!Number.isFinite(record.compressRatio) || record.compressRatio <= 0) return false;
  return true;
}

export function sortSidebarSessions(sessions = []) {
  return [...(Array.isArray(sessions) ? sessions : [])].sort((left, right) => {
    const updatedOrder = String(right?.updatedAt || '').localeCompare(String(left?.updatedAt || ''));
    if (updatedOrder !== 0) return updatedOrder;
    const createdOrder = String(right?.createdAt || '').localeCompare(String(left?.createdAt || ''));
    if (createdOrder !== 0) return createdOrder;
    return String(right?.id || '').localeCompare(String(left?.id || ''));
  });
}

// ── Wire 投影（分页 + 字段裁剪）─────────────────────────────────────
// 列表响应只回传前端消费的字段：path（服务端绝对路径）前端零消费，
// metadata 仅 resumeMode 被读取（compacted resume 徽标）。服务端内部
// 消费（active 会话解析、summarize 等）继续使用完整投影，裁剪只发生
// 在响应组装层。

const WIRE_SESSION_PAGE_MAX_LIMIT = 500;

function normalizeProjectDirForCompare(dir) {
  return String(dir || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

export function trimSessionRecordForWire(record) {
  if (!record || typeof record !== 'object') return record;
  const resumeMode = String(record?.metadata?.resumeMode || '').trim();
  const next = { ...record };
  delete next.path;
  next.metadata = resumeMode ? { resumeMode } : {};
  return next;
}

/**
 * 按分页/过滤参数从已排序的全量 light records 产出响应切片。
 *
 * 过滤顺序与语义：
 *   - projectDir: 归一化目录相等（反斜杠→斜杠、忽略大小写、去尾斜杠），
 *     与前端项目桶 id 的归一化规则一致
 *   - archived: 'main'（archived !== true）| 'archived'（=== true）| 缺省全部
 *   - query: title / openDirectory 子串（大小写不敏感）
 *
 * 返回 { slice, total, mainTotal, archivedTotal }；total 为过滤后未切片
 * 总数，main/archived 计数不受过滤影响（前端 tab 徽标需要真实总数）。
 */
export function sliceSessionsForWire(sessions, options = {}) {
  const source = Array.isArray(sessions) ? sessions : [];
  const projectDir = String(options.projectDir || '').trim();
  const normalizedProject = projectDir ? normalizeProjectDirForCompare(projectDir) : '';
  const query = String(options.query || '').trim().toLowerCase();
  const archivedFilter = options.archived === 'main' || options.archived === 'archived'
    ? options.archived
    : null;
  // 前端项目桶按身份分流（coder 会话归线程视图，不进主列表）；服务端切片
  // 必须同口径排除，否则 total 与已加载数永不相等，加载更多无法收敛。
  const excludeSessionTypes = Array.isArray(options.excludeSessionTypes)
    ? new Set(options.excludeSessionTypes.map((type) => String(type || '').trim()))
    : null;

  let mainTotal = 0;
  let archivedTotal = 0;
  const filtered = [];
  for (const session of source) {
    if (excludeSessionTypes && excludeSessionTypes.has(String(session?.sessionType || 'main'))) continue;
    if (normalizedProject
      && normalizeProjectDirForCompare(session?.openDirectory) !== normalizedProject) continue;
    // 徽标计数：当前项目内 main/archived 真实总数，不受 tab/query 过滤影响
    if (session?.archived === true) archivedTotal += 1; else mainTotal += 1;
    if (archivedFilter === 'main' && session?.archived === true) continue;
    if (archivedFilter === 'archived' && session?.archived !== true) continue;
    if (query) {
      const title = String(session?.title || '').toLowerCase();
      const directory = String(session?.openDirectory || '').toLowerCase();
      if (!title.includes(query) && !directory.includes(query)) continue;
    }
    filtered.push(session);
  }

  const total = filtered.length;
  const offset = Number.isFinite(Number(options.offset)) && Number(options.offset) > 0
    ? Math.floor(Number(options.offset))
    : 0;
  const rawLimit = Number.isFinite(Number(options.limit)) ? Math.floor(Number(options.limit)) : 0;
  const limit = rawLimit > 0 ? Math.min(rawLimit, WIRE_SESSION_PAGE_MAX_LIMIT) : 0;
  const slice = limit > 0 ? filtered.slice(offset, offset + limit) : filtered.slice(offset);
  return { slice, total, mainTotal, archivedTotal, offset };
}

const SIDEBAR_READ_MODEL_FIELDS = [
  'title', 'featureName', 'agentName', 'taskTitle', 'sessionType', 'status',
  'archived', 'todo', 'formId', 'openDirectory', 'createdAt', 'updatedAt',
  'messageCount', 'preview', 'hasSummary', 'contextLength', 'compressRatio',
  'modelName', 'tokenUsage',
];

function sidebarReadModelValue(value) {
  if (value == null) return null;
  if (typeof value === 'object') {
    try { return JSON.stringify(value); } catch { return '[unserializable]'; }
  }
  return value;
}

/**
 * Compare the index-backed sidebar read model with the authoritative rich
 * session list. Only aggregate counts leave this function; session content is
 * never included in diagnostics.
 */
export function compareSidebarSessionReadModels(lightSessions = [], authoritativeSessions = []) {
  const lightById = new Map((Array.isArray(lightSessions) ? lightSessions : [])
    .filter((session) => cleanSessionText(session?.id))
    .map((session) => [cleanSessionText(session.id), session]));
  const authoritativeById = new Map((Array.isArray(authoritativeSessions) ? authoritativeSessions : [])
    .filter((session) => cleanSessionText(session?.id))
    .map((session) => [cleanSessionText(session.id), session]));
  let missingCount = 0;
  let fieldMismatchCount = 0;
  let mismatchedSessionCount = 0;
  let exactSessionCount = 0;

  for (const [id, authoritative] of authoritativeById) {
    const light = lightById.get(id);
    if (!light) {
      missingCount += 1;
      continue;
    }
    let mismatched = false;
    for (const field of SIDEBAR_READ_MODEL_FIELDS) {
      if (sidebarReadModelValue(light[field]) === sidebarReadModelValue(authoritative[field])) continue;
      fieldMismatchCount += 1;
      mismatched = true;
    }
    if (mismatched) mismatchedSessionCount += 1;
    else exactSessionCount += 1;
  }

  let extraCount = 0;
  for (const id of lightById.keys()) {
    if (!authoritativeById.has(id)) extraCount += 1;
  }
  return {
    lightCount: lightById.size,
    authoritativeCount: authoritativeById.size,
    missingCount,
    extraCount,
    exactSessionCount,
    mismatchedSessionCount,
    fieldMismatchCount,
  };
}

