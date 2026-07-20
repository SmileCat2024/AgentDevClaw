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
 * @param {object} modelInfoMap - { default: {...}, exploration: {...}, sub: {...} }
 * @param {string} sessionType - raw sessionType from the record
 * @param {object} [metadata] - normalized session metadata
 * @returns {{ modelName: string, contextLength: number|null, compressRatio: number }}
 */
export function resolveSessionModelFromRecord(record, modelInfoMap, sessionType, metadata) {
  const sType = cleanSessionText(sessionType) || (metadata?.resumeMode === 'one-shot' ? 'sub' : 'main');
  const modelRole = sType === 'exploration' ? 'exploration' : sType === 'sub' ? 'sub' : 'default';
  const fallbackModelInfo = (modelInfoMap && modelInfoMap[modelRole]) || {};
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
  const lastRoleMatch = beforeSnippet.match(/\[(user|assistant)\][^\[]*$/);
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
 * Build a trim preview of session messages, grouping them into user→assistant rounds.
 * The most recent 2 rounds are marked suggestedTrim=false.
 *
 * Pure function — depends only on extractToolCallLabel (also module-level).
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
        userPreview: content.slice(0, 120),
        assistantPreview: '',
        toolCalls: [],
        messageCount: 1,
      };
    } else if (currentRound) {
      currentRound.messageCount += 1;
      currentRound.turnEnd = Number.isFinite(m.turn) ? m.turn : currentRound.turnEnd;
      currentRound.msgIndexEnd = i;
      if (role === 'assistant') {
        const content = typeof m.content === 'string' ? m.content.replace(/\s+/g, ' ').trim() : '';
        if (content && !currentRound.assistantPreview) {
          currentRound.assistantPreview = content.slice(0, 120);
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
  const sessionType = cleanSessionText(record?.sessionType) || (metadata?.resumeMode === 'one-shot' ? 'sub' : 'main');
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
    status: cleanSessionText(record?.status) || (sessionType === 'exploration' ? 'locked' : ''),
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
    hasSummary: false,
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

/**
 * Extract technology domain keywords from text (for exploration session locking).
 *
 * Pure function — no closure dependencies.
 *
 * @param {string} text
 * @returns {string[]} up to 8 unique domain keywords
 */
export function extractDomainsFromText(text) {
  if (!text || typeof text !== 'string') return [];
  const techPatterns = [
    /\b(Flow|Feature|Hook|ToolRegistry|Node|Edge|Workflow|Assembly|Session|Workspace|Runtime|Context|Prompt|Compaction|Mirror|Handoff|Seed|Inspector|Editor|Surface|Block|State|Config|Form|Agent|Message|Chunk|Template|Variable|Skill|Tool|Permission)\b/gi,
  ];
  const found = new Set();
  for (const pattern of techPatterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const word = match[1];
      if (word.length >= 3) found.add(word);
    }
  }
  return [...found].slice(0, 8);
}
