import path from 'path';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import {
  applyContinuityToolPolicy,
  exportFeatureContinuity,
} from './feature-continuity.js';

const HANDOFF_SCHEMA_VERSION = 1;
const HANDOFF_COMPILER_VERSION = 'trim-transcript-v1';

export const DEFAULT_EXPORT_POLICY = {
  strategy: 'trim-transcript',
  includeSystemMessages: false,
  includeUserMessages: true,
  includeAssistantMessages: true,
  keepRecentTurns: null,
  fullPreserveFromTurn: null,
  preservedTurns: null,
  assistantToolCallMode: 'fold',
  toolMessageMode: 'fold',
  toolFoldScope: 'all',
  toolFoldRecentTurns: null,
  foldConsecutiveToolActivity: true,
  foldedToolNoteRole: 'assistant',
  foldToolCallArgs: false,
  foldToolResultSummary: false,
  maxFoldedToolChars: 240,
  preserveToolNames: [],
};

const VALID_TOOL_MODES = new Set(['keep', 'drop', 'fold']);
const VALID_TOOL_SCOPES = new Set(['all', 'recent']);
const VALID_FOLDED_NOTE_ROLES = new Set(['system', 'assistant']);

function sanitizeFragment(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'default';
}

function cleanInlineText(value) {
  return typeof value === 'string'
    ? value.replace(/\s+/g, ' ').trim()
    : '';
}

function cleanMultilineText(value) {
  if (typeof value !== 'string') return '';
  const normalized = value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n').map((line) => line.replace(/[ \t]+/g, ' ').trimEnd());
  const compacted = [];
  let blankRun = 0;
  for (const line of lines) {
    if (line.trim() === '') {
      blankRun += 1;
      if (blankRun <= 1) {
        compacted.push('');
      }
      continue;
    }
    blankRun = 0;
    compacted.push(line);
  }
  return compacted.join('\n').trim();
}

function clampInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function normalizeNullableTurnCount(value) {
  if (value === null || value === undefined || value === '') return null;
  return clampInteger(value, 1, 1, 2000);
}

function normalizeNullableTurnIndex(value) {
  if (value === null || value === undefined || value === '') return null;
  return clampInteger(value, 0, 0, 2000);
}

function normalizeKeepRecentSkillInvokes(value) {
  if (value === null || value === undefined || value === '' || value === false) return null;
  if (value === Infinity || value === 'Infinity') return Infinity;
  return clampInteger(value, null, 1, 2000);
}

function normalizeToolNameList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(cleanInlineText).filter(Boolean))];
}

function normalizeEnum(value, validValues, fallback) {
  const text = cleanInlineText(value);
  return validValues.has(text) ? text : fallback;
}

export function getContextHandoffsRoot(userDataRoot) {
  return path.join(path.resolve(String(userDataRoot || '').trim()), 'context-handoffs');
}

export function getContextHandoffDir(userDataRoot, agentId) {
  return path.join(getContextHandoffsRoot(userDataRoot), sanitizeFragment(agentId));
}

export function getContextHandoffFilePath(userDataRoot, agentId, handoffId) {
  return path.join(getContextHandoffDir(userDataRoot, agentId), `${sanitizeFragment(handoffId)}.json`);
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

export function normalizeExportPolicy(rawPolicy = {}) {
  return {
    strategy: 'trim-transcript',
    includeSystemMessages: rawPolicy?.includeSystemMessages === true,
    includeUserMessages: rawPolicy?.includeUserMessages !== false,
    includeAssistantMessages: rawPolicy?.includeAssistantMessages !== false,
    keepRecentTurns: normalizeNullableTurnCount(rawPolicy?.keepRecentTurns),
    fullPreserveFromTurn: normalizeNullableTurnIndex(rawPolicy?.fullPreserveFromTurn),
    preservedTurns: Array.isArray(rawPolicy?.preservedTurns)
      ? [...new Set(rawPolicy.preservedTurns.filter(t => Number.isFinite(t)).map(Number))]
      : null,
    assistantToolCallMode: normalizeEnum(rawPolicy?.assistantToolCallMode, VALID_TOOL_MODES, DEFAULT_EXPORT_POLICY.assistantToolCallMode),
    toolMessageMode: normalizeEnum(rawPolicy?.toolMessageMode, VALID_TOOL_MODES, DEFAULT_EXPORT_POLICY.toolMessageMode),
    toolFoldScope: normalizeEnum(rawPolicy?.toolFoldScope, VALID_TOOL_SCOPES, DEFAULT_EXPORT_POLICY.toolFoldScope),
    toolFoldRecentTurns: normalizeNullableTurnCount(rawPolicy?.toolFoldRecentTurns),
    foldConsecutiveToolActivity: rawPolicy?.foldConsecutiveToolActivity !== false,
    foldedToolNoteRole: normalizeEnum(rawPolicy?.foldedToolNoteRole, VALID_FOLDED_NOTE_ROLES, DEFAULT_EXPORT_POLICY.foldedToolNoteRole),
    foldToolCallArgs: rawPolicy?.foldToolCallArgs === true,
    foldToolResultSummary: rawPolicy?.foldToolResultSummary === true,
    maxFoldedToolChars: clampInteger(rawPolicy?.maxFoldedToolChars, DEFAULT_EXPORT_POLICY.maxFoldedToolChars, 80, 4000),
    keepRecentSkillInvokes: normalizeKeepRecentSkillInvokes(rawPolicy?.keepRecentSkillInvokes),
    preserveToolNames: normalizeToolNameList(rawPolicy?.preserveToolNames),
  };
}

function buildSourceRecord(sourceRecord = {}) {
  return {
    title: cleanInlineText(sourceRecord?.title),
    featureName: cleanInlineText(sourceRecord?.featureName),
    agentName: cleanInlineText(sourceRecord?.agentName),
    taskTitle: cleanInlineText(sourceRecord?.taskTitle),
    taskType: cleanInlineText(sourceRecord?.taskType),
    goal: cleanMultilineText(sourceRecord?.goal),
    constraints: cleanMultilineText(sourceRecord?.constraints),
    expectedOutput: cleanMultilineText(sourceRecord?.expectedOutput),
    targetFiles: cleanMultilineText(sourceRecord?.targetFiles),
    referenceMaterials: cleanMultilineText(sourceRecord?.referenceMaterials),
    openDirectory: cleanInlineText(sourceRecord?.openDirectory),
    createdAt: cleanInlineText(sourceRecord?.createdAt),
    updatedAt: cleanInlineText(sourceRecord?.updatedAt),
  };
}

function buildCompactOverview(sourceRecord = {}) {
  const lines = [];
  const title = cleanInlineText(sourceRecord?.taskTitle || sourceRecord?.title);
  const goal = cleanMultilineText(sourceRecord?.goal);
  const constraints = cleanMultilineText(sourceRecord?.constraints);
  const openDirectory = cleanInlineText(sourceRecord?.openDirectory);
  if (title) lines.push(`Task: ${title}`);
  if (goal) lines.push(`Goal: ${goal}`);
  if (constraints) lines.push(`Constraints: ${constraints}`);
  if (openDirectory) lines.push(`Working directory: ${openDirectory}`);
  return lines.join('\n');
}

function safeJsonSnippet(value, maxChars) {
  try {
    const text = cleanMultilineText(typeof value === 'string' ? value : JSON.stringify(value));
    return text.length > maxChars ? `${text.slice(0, Math.max(0, maxChars - 18)).trimEnd()} [truncated]` : text;
  } catch {
    const text = cleanMultilineText(String(value ?? ''));
    return text.length > maxChars ? `${text.slice(0, Math.max(0, maxChars - 18)).trimEnd()} [truncated]` : text;
  }
}

function summarizeToolPayload(rawContent, maxChars) {
  const text = cleanMultilineText(rawContent);
  if (!text) return '';
  try {
    const parsed = JSON.parse(text);
    const errorText = cleanMultilineText(parsed?.error);
    if (errorText) {
      return `error: ${safeJsonSnippet(errorText, maxChars)}`;
    }
    const resultValue = parsed?.result ?? parsed;
    return safeJsonSnippet(resultValue, maxChars);
  } catch {
    return text.length > maxChars ? `${text.slice(0, Math.max(0, maxChars - 18)).trimEnd()} [truncated]` : text;
  }
}

function extractToolCallKeyInfo(name, rawArgs) {
  let args = rawArgs;
  if (typeof args === 'string') { try { args = JSON.parse(args); } catch { return null; } }
  if (!args || typeof args !== 'object') return null;
  if (name === 'read' || name === 'edit' || name === 'write') {
    const filePath = typeof args.filePath === 'string' ? args.filePath : '';
    if (filePath) {
      const baseName = filePath.split(/[\\/]/).pop() || filePath;
      return `${name}(${baseName})`;
    }
  }
  if (name === 'invoke_skill') {
    const skill = typeof args.skill === 'string' ? args.skill : '';
    if (skill) return `invoke_skill(${skill})`;
  }
  return null;
}

function summarizeAssistantToolCalls(toolCalls = [], policy) {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return [];
  return toolCalls.map((call) => {
    const name = cleanInlineText(call?.name) || 'tool';
    const keyInfo = extractToolCallKeyInfo(name, call?.args ?? call?.arguments);
    if (keyInfo) return keyInfo;
    if (!policy.foldToolCallArgs) {
      return name;
    }
    const args = safeJsonSnippet(call?.args ?? call?.arguments ?? {}, policy.maxFoldedToolChars);
    return args ? `${name}(${args})` : `${name}()`;
  });
}

function getMessageTurn(message, fallbackIndex) {
  return Number.isFinite(message?.turn) ? Number(message.turn) : fallbackIndex;
}

function getRetainedTurnSet(rawMessages, policy) {
  if (!policy.keepRecentTurns) return null;
  const turns = rawMessages
    .filter(message => Number.isFinite(message?.turn))
    .map(message => Number(message.turn));
  if (turns.length === 0) return null;
  const uniqueTurns = [...new Set(turns)].sort((a, b) => a - b);
  const keptTurns = uniqueTurns.slice(-policy.keepRecentTurns);
  return new Set(keptTurns);
}

function getFoldedToolTurnSet(rawMessages, retainedTurns, policy) {
  if (policy.toolFoldScope === 'all') return null;
  if (policy.toolFoldRecentTurns) {
    const turns = rawMessages
      .map((message, index) => getMessageTurn(message, index))
      .filter(Number.isFinite);
    if (turns.length === 0) return null;
    const uniqueTurns = [...new Set(turns)].sort((a, b) => a - b);
    return new Set(uniqueTurns.slice(-policy.toolFoldRecentTurns));
  }
  return retainedTurns;
}

function shouldKeepDialogueMessage(role, policy) {
  if (role === 'user') return policy.includeUserMessages;
  if (role === 'assistant') return policy.includeAssistantMessages;
  if (role === 'system') return policy.includeSystemMessages;
  return false;
}

function shouldHandleToolActivity(messageTurn, foldedToolTurns, policy) {
  if (policy.toolFoldScope === 'all') return true;
  if (!foldedToolTurns) return false;
  return foldedToolTurns.has(messageTurn);
}

function getSkillInvokeProtectedTurns(rawMessages, policy) {
  if (!policy.keepRecentSkillInvokes) return null;
  const skillTurns = [];
  for (let i = rawMessages.length - 1; i >= 0; i--) {
    const m = rawMessages[i];
    if (m?.role !== 'assistant') continue;
    const toolCalls = Array.isArray(m.toolCalls) ? m.toolCalls : [];
    const hasSkill = toolCalls.some(tc => tc?.name === 'invoke_skill');
    if (!hasSkill) continue;
    const turn = getMessageTurn(m, i);
    if (!skillTurns.includes(turn)) {
      skillTurns.unshift(turn);
      if (skillTurns.length >= policy.keepRecentSkillInvokes && policy.keepRecentSkillInvokes !== Infinity) break;
    }
  }
  return skillTurns.length > 0 ? new Set(skillTurns) : null;
}

function createSeedMessage(role, content, turn) {
  const text = cleanMultilineText(content);
  if (!text) return null;
  return {
    role,
    content: text,
    turn: Number.isFinite(turn) ? turn : null,
  };
}

function deduplicateToolCallSummaries(summaries) {
  const counts = new Map();
  const order = [];
  for (const s of summaries) {
    if (counts.has(s)) {
      counts.set(s, counts.get(s) + 1);
    } else {
      counts.set(s, 1);
      order.push(s);
    }
  }
  return order.map(s => {
    const c = counts.get(s);
    return c > 1 ? `${s} ×${c}` : s;
  });
}

function flushPendingToolFold(seedMessages, pendingFold, policy, stats) {
  if (!pendingFold || pendingFold.toolCalls.length === 0) {
    return null;
  }

  const deduped = deduplicateToolCallSummaries(pendingFold.toolCalls);
  const lines = ['[Folded tool activity]'];
  lines.push(`assistant tool calls: ${deduped.join('; ')}`);

  const note = createSeedMessage(policy.foldedToolNoteRole, lines.join('\n'), pendingFold.turn);
  if (note) {
    seedMessages.push(note);
    stats.foldedToolNoteCount += 1;
  }
  return null;
}

export function buildTrimmedSeedMessages(rawMessages, policy) {
  const retainedTurns = getRetainedTurnSet(rawMessages, policy);
  const foldedToolTurns = getFoldedToolTurnSet(rawMessages, retainedTurns, policy);
  const skillProtectedTurns = getSkillInvokeProtectedTurns(rawMessages, policy);
  const protectedToolNames = new Set(Array.isArray(policy?.preserveToolNames) ? policy.preserveToolNames : []);
  const protectedToolCallIds = new Set();
  for (const message of rawMessages) {
    const toolCalls = Array.isArray(message?.toolCalls) ? message.toolCalls : [];
    for (const call of toolCalls) {
      const name = cleanInlineText(call?.name);
      const id = cleanInlineText(call?.id);
      if (name && id && protectedToolNames.has(name)) {
        protectedToolCallIds.add(id);
      }
    }
  }
  const fullPreserveFrom = policy.fullPreserveFromTurn;
  // preservedTurns: when set, only these specific turns get full-detail preserve.
  // This takes precedence over fullPreserveFromTurn and supports non-contiguous
  // selections (e.g. "keep round 0, fold rounds 1-N").
  const preservedTurnSet = Array.isArray(policy.preservedTurns) && policy.preservedTurns.length > 0
    ? new Set(policy.preservedTurns)
    : null;
  const hasPreserveBoundary = preservedTurnSet || Number.isFinite(fullPreserveFrom);
  const seedMessages = [];
  const stats = {
    originalMessageCount: rawMessages.length,
    keptSeedMessageCount: 0,
    droppedMessageCount: 0,
    keptDialogueMessageCount: 0,
    droppedDialogueMessageCount: 0,
    foldedToolCallCount: 0,
    droppedToolCallCount: 0,
    foldedToolMessageCount: 0,
    droppedToolMessageCount: 0,
    foldedToolNoteCount: 0,
    keptProtectedToolCallCount: 0,
    keptProtectedToolMessageCount: 0,
  };

  let pendingFold = null;

  const ensurePendingFold = (turn) => {
    if (!pendingFold) {
      pendingFold = {
        turn,
        toolCalls: [],
        toolResults: [],
      };
    }
    return pendingFold;
  };

  const flushIfNeeded = () => {
    pendingFold = flushPendingToolFold(seedMessages, pendingFold, policy, stats);
  };

  const flushImmediatelyIfConfigured = () => {
    if (policy.foldConsecutiveToolActivity === false) {
      flushIfNeeded();
    }
  };

  rawMessages.forEach((message, index) => {
    const role = cleanInlineText(message?.role);
    if (!role) {
      stats.droppedMessageCount += 1;
      return;
    }

    const turn = getMessageTurn(message, index);
    const withinDialogueWindow = hasPreserveBoundary || !retainedTurns || retainedTurns.has(turn);

    // Preserve zone: pass through original message structure (preserves toolCallId, toolCalls, etc.)
    const inPreserveZone = preservedTurnSet
      ? preservedTurnSet.has(turn)
      : (Number.isFinite(fullPreserveFrom) && turn >= fullPreserveFrom);
    if (inPreserveZone) {
      flushIfNeeded();
      if (role === 'tool' || shouldKeepDialogueMessage(role, policy)) {
        seedMessages.push({ ...message, turn });
        stats.keptSeedMessageCount += 1;
        if (role !== 'tool') {
          stats.keptDialogueMessageCount += 1;
        }
      } else {
        stats.droppedDialogueMessageCount += 1;
        stats.droppedMessageCount += 1;
      }
      return;
    }

    const toolCalls = Array.isArray(message?.toolCalls) ? message.toolCalls : [];
    const protectedCalls = role === 'assistant'
      ? toolCalls.filter((call) => protectedToolNames.has(cleanInlineText(call?.name)))
      : [];
    if (protectedCalls.length > 0) {
      flushIfNeeded();
      if (shouldKeepDialogueMessage(role, policy)) {
        seedMessages.push({ ...message, turn });
        stats.keptSeedMessageCount += 1;
        stats.keptDialogueMessageCount += 1;
        stats.keptProtectedToolCallCount += protectedCalls.length;
      } else {
        stats.droppedDialogueMessageCount += 1;
        stats.droppedMessageCount += 1;
      }
      return;
    }

    if (role === 'tool' && protectedToolCallIds.has(cleanInlineText(message?.toolCallId))) {
      flushIfNeeded();
      seedMessages.push({ ...message, turn });
      stats.keptSeedMessageCount += 1;
      stats.keptProtectedToolMessageCount += 1;
      return;
    }

    // Skill-protected zone: turns containing recent invoke_skill calls pass through intact
    if (skillProtectedTurns && skillProtectedTurns.has(turn)) {
      flushIfNeeded();
      if (role === 'tool' || shouldKeepDialogueMessage(role, policy)) {
        seedMessages.push({ ...message, turn });
        stats.keptSeedMessageCount += 1;
        if (role !== 'tool') {
          stats.keptDialogueMessageCount += 1;
        }
      } else {
        stats.droppedDialogueMessageCount += 1;
        stats.droppedMessageCount += 1;
      }
      return;
    }

    // Fold zone: existing logic
    if (role === 'tool') {
      if (!withinDialogueWindow) {
        stats.droppedToolMessageCount += 1;
        stats.droppedMessageCount += 1;
        return;
      }

      const shouldHandle = hasPreserveBoundary
        ? true
        : shouldHandleToolActivity(turn, foldedToolTurns, policy);
      if (policy.toolMessageMode === 'keep' || !shouldHandle) {
        flushIfNeeded();
        const seedMessage = createSeedMessage('tool', message.content, turn);
        if (seedMessage) {
          seedMessages.push(seedMessage);
          stats.keptSeedMessageCount += 1;
        } else {
          stats.droppedMessageCount += 1;
        }
        return;
      }

      if (policy.toolMessageMode === 'drop') {
        stats.droppedToolMessageCount += 1;
        stats.droppedMessageCount += 1;
        return;
      }

      const fold = ensurePendingFold(turn);
      stats.foldedToolMessageCount += 1;
      stats.droppedMessageCount += 1;
      flushImmediatelyIfConfigured();
      return;
    }

    const shouldHandleToolCalls = toolCalls.length > 0 && (hasPreserveBoundary
      ? true
      : shouldHandleToolActivity(turn, foldedToolTurns, policy));
    const toolCallSummaries = summarizeAssistantToolCalls(toolCalls, policy);

    if (!withinDialogueWindow) {
      if (role === 'assistant' || role === 'user' || role === 'system') {
        stats.droppedDialogueMessageCount += 1;
      }
      if (shouldHandleToolCalls) {
        if (policy.assistantToolCallMode === 'fold') {
          stats.foldedToolCallCount += toolCalls.length;
        } else if (policy.assistantToolCallMode === 'drop') {
          stats.droppedToolCallCount += toolCalls.length;
        }
      }
      stats.droppedMessageCount += 1;
      return;
    }

    // When the assistant makes consecutive tool-only turns (no text output),
    // flushing before each one produces a separate [Folded tool activity]
    // entry per turn — needlessly verbose. Skip the flush so tool-call
    // summaries from consecutive tool-only assistant messages accumulate
    // into a single fold, which is flushed later by actual text or a
    // non-assistant message.
    const isToolOnlyAssistantFold = role === 'assistant'
      && !cleanMultilineText(message.content)
      && toolCalls.length > 0
      && policy.assistantToolCallMode === 'fold'
      && shouldHandleToolCalls;
    if (!isToolOnlyAssistantFold) {
      flushIfNeeded();
    }

    if (!shouldKeepDialogueMessage(role, policy)) {
      stats.droppedDialogueMessageCount += 1;
      stats.droppedMessageCount += 1;
    } else {
      let assistantContent = cleanMultilineText(message.content);
      if (role === 'assistant' && toolCalls.length > 0 && policy.assistantToolCallMode === 'keep' && toolCallSummaries.length > 0 && shouldHandleToolCalls) {
        assistantContent = `${assistantContent}\n[tool calls kept inline] ${toolCallSummaries.join('; ')}`.trim();
      }
      const seedMessage = createSeedMessage(role, assistantContent, turn);
      if (seedMessage) {
        seedMessages.push(seedMessage);
        stats.keptSeedMessageCount += 1;
        if (role === 'assistant' || role === 'user' || role === 'system') {
          stats.keptDialogueMessageCount += 1;
        }
      } else if (role !== 'assistant' || toolCalls.length === 0) {
        stats.droppedMessageCount += 1;
      }
    }

    if (role === 'assistant' && toolCalls.length > 0 && shouldHandleToolCalls) {
      if (policy.assistantToolCallMode === 'fold') {
        const fold = ensurePendingFold(turn);
        fold.toolCalls.push(...toolCallSummaries);
        stats.foldedToolCallCount += toolCalls.length;
        flushImmediatelyIfConfigured();
      } else if (policy.assistantToolCallMode === 'drop') {
        stats.droppedToolCallCount += toolCalls.length;
      }
    }
  });

  flushPendingToolFold(seedMessages, pendingFold, policy, stats);
  return {
    seedMessages,
    stats: {
      ...stats,
      retainedTurnCount: retainedTurns ? retainedTurns.size : null,
      foldedToolTurnCount: foldedToolTurns ? foldedToolTurns.size : null,
    },
  };
}

export async function exportHistoryOnlyHandoffPackage({
  userDataRoot,
  agentId,
  sessionId,
  sessionPath,
  sourceRecord = {},
  policy: rawPolicy = {},
}) {
  const sessionSnapshot = await readJson(path.resolve(String(sessionPath || '').trim()));
  const featureContinuity = exportFeatureContinuity(sessionSnapshot, { mode: 'trim-transcript' });
  const policy = normalizeExportPolicy(applyContinuityToolPolicy(rawPolicy));
  const rawMessages = Array.isArray(sessionSnapshot?.runtime?.context?.messages)
    ? sessionSnapshot.runtime.context.messages
    : [];

  const { seedMessages, stats } = buildTrimmedSeedMessages(rawMessages, policy);
  const createdAt = new Date().toISOString();
  const handoffId = `handoff-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const sourceSummary = buildCompactOverview(sourceRecord);

  const handoff = {
    schemaVersion: HANDOFF_SCHEMA_VERSION,
    handoffId,
    createdAt,
    compilerVersion: HANDOFF_COMPILER_VERSION,
    seedKind: 'message-replay',
    mode: 'trim-transcript',
    sourceAgentId: sanitizeFragment(agentId),
    sourceSessionId: sanitizeFragment(sessionId),
    sourceSessionPath: path.resolve(String(sessionPath || '').trim()),
    sourceRecord: buildSourceRecord(sourceRecord),
    policy,
    stats,
    featureContinuity,
    sourceSummary,
    seedMessages,
  };

  const handoffPath = getContextHandoffFilePath(userDataRoot, agentId, handoffId);
  await ensureDir(path.dirname(handoffPath));
  await fs.writeFile(handoffPath, `${JSON.stringify(handoff, null, 2)}\n`, 'utf8');

  return {
    handoff,
    handoffPath,
  };
}

export async function readHandoffPackage({ userDataRoot, agentId, handoffId, handoffPath }) {
  const resolvedPath = handoffPath
    ? path.resolve(String(handoffPath || '').trim())
    : getContextHandoffFilePath(userDataRoot, agentId, handoffId);
  const handoff = await readJson(resolvedPath);
  if (handoff?.schemaVersion !== HANDOFF_SCHEMA_VERSION) {
    const error = new Error(`Unsupported handoff schema version: ${handoff?.schemaVersion ?? 'unknown'}`);
    error.statusCode = 400;
    throw error;
  }
  return {
    handoff,
    handoffPath: resolvedPath,
  };
}
