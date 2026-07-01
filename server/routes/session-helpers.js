import path from 'path';
import { promises as fs } from 'fs';
import { randomUUID } from 'crypto';

import { USER_DATA_ROOT, AGENTS_ROOT } from '../shared/constants.js';
import {
  sanitizeSessionFragment, cleanSessionText, isWorkspaceSessionAgent,
  getAssemblyWorkspaceDir, normalizeClientAgentId, log,
} from '../shared/string-helpers.js';
import {
  readSessionIndex, updateSessionIndex, writeSessionIndex,
  getPrebuiltSessionFilePath, getPrebuiltAgentSessionDir,
  normalizeSessionMetadata, buildSessionTitle,
} from '../shared/session-access.js';
import { resolveSessionModelInfo } from './model-config.js';
import {
  readHandoffPackage,
  exportHistoryOnlyHandoffPackage,
} from '../context-continuity/handoff-package.js';
import {
  exportSummarizedHandoffPackage,
  writeSummarizedHandoffPackage,
} from '../context-continuity/summarized-handoff.js';

/**
 * Session index metadata version. Bump when the cached fields schema changes;
 * old index records will auto-heal via the slow path on first access.
 */
export const META_VERSION = 1;

export function createSessionHelpers(ctx) {
  const {
    readWorkspaceState,
    writeWorkspaceState,
    discoverAgents,
    enrichAgent,
    startManagedAgent,
    waitForManagedRuntimeReady,
  } = ctx;

function buildFeatureSessionTitle(featureName, createdAtIso) {
  const date = new Date(createdAtIso);
  const parts = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ];
  const time = [
    String(date.getHours()).padStart(2, '0'),
    String(date.getMinutes()).padStart(2, '0'),
  ];
  const base = cleanSessionText(featureName);
  return base ? `${base} · ${parts.join('-')} ${time.join(':')}` : buildSessionTitle(createdAtIso);
}

function buildNamedSessionTitle(name, createdAtIso) {
  return buildFeatureSessionTitle(name, createdAtIso);
}

async function getNextNewSessionTitle(agentId, openDirectory) {
  const index = await readSessionIndex(agentId);
  const normalizedDir = String(openDirectory || '').trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const newSessionPattern = /^新对话(\d+)$/;
  let maxN = 0;
  for (const session of (index.sessions || [])) {
    const sessionDir = String(session?.openDirectory || '').trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    if (normalizedDir && sessionDir !== normalizedDir) continue;
    const m = cleanSessionText(session?.title).match(newSessionPattern);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > maxN) maxN = n;
    }
  }
  return `新对话${maxN + 1}`;
}

async function checkSessionHasSummary(agentId, sessionId) {
  const handoffsDir = path.join(USER_DATA_ROOT, 'context-handoffs', sanitizeSessionFragment(agentId || 'programming-helper'));
  try {
    const files = await fs.readdir(handoffsDir);
    for (const file of files) {
      if (!file.startsWith('handoff-') || !file.endsWith('.json')) continue;
      try {
        const raw = await fs.readFile(path.join(handoffsDir, file), 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed.sourceSessionId === sessionId && !parsed.stats?.synthetic) {
          return true;
        }
      } catch {}
    }
  } catch {}
  return false;
}

async function buildSessionSummaryMap(agentId) {
  const map = new Map();
  const handoffsDir = path.join(USER_DATA_ROOT, 'context-handoffs', sanitizeSessionFragment(agentId || 'programming-helper'));
  try {
    const files = await fs.readdir(handoffsDir);
    for (const file of files) {
      if (!file.startsWith('handoff-') || !file.endsWith('.json')) continue;
      try {
        const raw = await fs.readFile(path.join(handoffsDir, file), 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed.sourceSessionId && !parsed.stats?.synthetic) {
          const existing = map.get(parsed.sourceSessionId);
          const thisCreatedAt = parsed.createdAt || '';
          if (!existing || thisCreatedAt > (existing.createdAt || '')) {
            map.set(parsed.sourceSessionId, {
              sessionTitle: cleanSessionText(parsed.compactOutput?.sessionTitle),
              createdAt: thisCreatedAt,
            });
          }
        }
      } catch {}
    }
  } catch {}
  return map;
}

function buildLightPrebuiltSessionRecord(agentId, record) {
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
    contextLength: null,
    modelName: cleanSessionText(record?.modelName),
  };
}

async function findSessionSummary(agentId, sessionId) {
  const handoffsDir = path.join(USER_DATA_ROOT, 'context-handoffs', sanitizeSessionFragment(agentId || 'programming-helper'));
  try {
    const files = await fs.readdir(handoffsDir);
    for (const file of files) {
      if (!file.startsWith('handoff-') || !file.endsWith('.json')) continue;
      try {
        const raw = await fs.readFile(path.join(handoffsDir, file), 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed.sourceSessionId === sessionId && !parsed.stats?.synthetic) {
          return parsed;
        }
      } catch {}
    }
  } catch {}
  return null;
}

async function findSessionSummaryPath(agentId, sessionId) {
  const handoffsDir = path.join(USER_DATA_ROOT, 'context-handoffs', sanitizeSessionFragment(agentId || 'programming-helper'));
  try {
    const files = await fs.readdir(handoffsDir);
    for (const file of files) {
      if (!file.startsWith('handoff-') || !file.endsWith('.json')) continue;
      try {
        const raw = await fs.readFile(path.join(handoffsDir, file), 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed.sourceSessionId === sessionId && !parsed.stats?.synthetic) {
          return path.join(handoffsDir, file);
        }
      } catch {}
    }
  } catch {}
  return null;
}

async function readSessionSnapshotForContinuity(agentId, sessionId) {
  try {
    const raw = await fs.readFile(getPrebuiltSessionFilePath(agentId, sessionId), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function extractToolCallLabel(name, args) {
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

function buildSessionTrimPreview(messages) {
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

async function summarizePrebuiltSession(agentId, record, summaryMap, modelInfoMap) {
  const sessionPath = getPrebuiltSessionFilePath(agentId, record.id);
  const normalizedAgentId = sanitizeSessionFragment(agentId);
  const metadata = normalizeSessionMetadata(record.metadata);
  const workspaceState = isWorkspaceSessionAgent(agentId)
    ? await readWorkspaceState(agentId)
    : null;
  const isProgrammingHelper = normalizedAgentId === 'programming-helper';
  const formId = cleanSessionText(record.formId) || (isProgrammingHelper ? '' : 'startup-form');
  const sourceForm = workspaceState?.forms?.[formId] || {};
  const startupForm = isProgrammingHelper ? {} : (workspaceState?.forms?.['startup-form'] || {});
  const featureName = cleanSessionText(record.featureName) || cleanSessionText(sourceForm.feature_name) || cleanSessionText(startupForm.feature_name);
  const agentName = cleanSessionText(record.agentName) || cleanSessionText(sourceForm.agent_name || sourceForm.assembly_name) || cleanSessionText(startupForm.agent_name);
  const taskTitle = cleanSessionText(record.taskTitle) || cleanSessionText(sourceForm.task_title) || cleanSessionText(startupForm.task_title);
  const taskType = cleanSessionText(record.taskType) || cleanSessionText(sourceForm.task_type) || cleanSessionText(startupForm.task_type);
  const goal = cleanSessionText(record.goal) || cleanSessionText(sourceForm.goal) || cleanSessionText(startupForm.goal);
  const constraints = cleanSessionText(record.constraints) || cleanSessionText(sourceForm.constraints) || cleanSessionText(startupForm.constraints);
  const expectedOutput = cleanSessionText(record.expectedOutput) || cleanSessionText(sourceForm.expected_output) || cleanSessionText(startupForm.expected_output);
  const targetFiles = cleanSessionText(record.targetFiles) || cleanSessionText(sourceForm.target_files) || cleanSessionText(startupForm.target_files);
  const referenceMaterials = cleanSessionText(record.referenceMaterials) || cleanSessionText(sourceForm.reference_materials) || cleanSessionText(startupForm.reference_materials);
  // NOTE: Do NOT fall back to workspaceState.openDirectory for non-assembly
  // agents. workspaceState.openDirectory is the *current* project directory,
  // not the one the session was created with. Falling back here causes sessions
  // with empty openDirectory to appear in every project the user opens.
  const openDirectory = (normalizedAgentId === 'agent-creator' || normalizedAgentId === 'flow-workspace') && formId === 'assembly-form'
    ? (
        cleanSessionText(sourceForm.env_dir)
        || cleanSessionText(record.openDirectory)
      )
    : cleanSessionText(record.openDirectory);
  const displayName = (normalizedAgentId === 'agent-creator' || (normalizedAgentId === 'flow-workspace' && formId === 'assembly-form'))
    ? agentName
    : (normalizedAgentId === 'programming-helper' ? taskTitle : featureName);
  try {
    const stat = await fs.stat(sessionPath);

    // ── Fast path: use cached metadata when the session file hasn't changed ──
    if (
      record.fileMtimeMs === stat.mtimeMs &&
      record.fileSize === stat.size &&
      record.metaVersion === META_VERSION &&
      typeof record.messageCount === 'number' &&
      typeof record.preview !== 'undefined' &&
      record.tokenUsage
    ) {
      const sType = cleanSessionText(record.sessionType) || (metadata?.resumeMode === 'one-shot' ? 'sub' : 'main');
      const modelRole = sType === 'exploration' ? 'exploration' : sType === 'sub' ? 'sub' : 'default';
      const fallbackModelInfo = (modelInfoMap && modelInfoMap[modelRole])
        || await resolveSessionModelInfo(agentId, sType);
      const persistedModelName = cleanSessionText(record.modelName);
      const persistedCL = Number.isFinite(record.contextLength) && record.contextLength > 0
        ? record.contextLength : null;
      const persistedCR = Number.isFinite(record.compressRatio) && record.compressRatio > 0
        ? record.compressRatio : null;
      // Fast path: file unchanged since last read, so the persisted values
      // (captured at creation or updated on last file change) are authoritative.
      const sessionModelInfo = {
        modelName: persistedModelName || fallbackModelInfo.modelName || '',
        contextLength: persistedCL || fallbackModelInfo.contextLength || null,
        compressRatio: persistedCR || fallbackModelInfo.compressRatio || 80,
      };
      const summaryInfo = summaryMap ? summaryMap.get(record.id) : null;
      const compactTitle = summaryInfo?.sessionTitle || '';
      return {
        id: record.id,
        title: cleanSessionText(record.title) || compactTitle || buildNamedSessionTitle(displayName, record.createdAt || stat.mtime.toISOString()),
        featureName,
        agentName,
        taskTitle,
        taskType,
        goal,
        constraints,
        expectedOutput,
        targetFiles,
        referenceMaterials,
        sessionType: sType,
        status: cleanSessionText(record.status) || (record.sessionType === 'exploration' ? 'locked' : ''),
        archived: record.archived === true,
        todo: record.todo === true,
        metadata,
        formId,
        openDirectory,
        createdAt: record.createdAt || stat.birthtime.toISOString(),
        updatedAt: record.savedAt ? new Date(record.savedAt).toISOString() : (record.updatedAt || stat.mtime.toISOString()),
        path: sessionPath,
        exists: true,
        bytes: stat.size,
        messageCount: record.messageCount,
        preview: cleanSessionText(record.preview),
        hasSummary: summaryMap ? summaryMap.has(record.id) : (await checkSessionHasSummary(agentId, record.id)),
        tokenUsage: record.tokenUsage,
        contextLength: sessionModelInfo.contextLength || null,
        compressRatio: sessionModelInfo.compressRatio || 80,
        modelName: sessionModelInfo.modelName || '',
      };
    }

    const raw = await fs.readFile(sessionPath, 'utf8');
    const parsed = JSON.parse(raw);
    const messages = Array.isArray(parsed?.runtime?.context?.messages) ? parsed.runtime.context.messages : [];
    const lastMessage = [...messages].reverse().find((message) => message && typeof message.content === 'string' && message.role !== 'system') || null;
    const summaryInfo = summaryMap ? summaryMap.get(record.id) : null;
    const compactTitle = summaryInfo?.sessionTitle || '';
    const usageStats = parsed?.runtime?.usageStats;
    const totalUsage = usageStats?.totalUsage;
    const sType = cleanSessionText(record.sessionType) || (metadata?.resumeMode === 'one-shot' ? 'sub' : 'main');
    const modelRole = sType === 'exploration' ? 'exploration' : sType === 'sub' ? 'sub' : 'default';
    const fallbackModelInfo = (modelInfoMap && modelInfoMap[modelRole])
      || await resolveSessionModelInfo(agentId, sType);
    // When the session file has changed (new activity), the session is running
    // with the current model configuration. Use the live config values for both
    // display and writeback so the index stays fresh.
    const sessionModelInfo = {
      modelName: fallbackModelInfo.modelName || '',
      contextLength: fallbackModelInfo.contextLength || null,
      compressRatio: fallbackModelInfo.compressRatio || 80,
    };
    const result = {
      id: record.id,
      title: cleanSessionText(record.title) || compactTitle || buildNamedSessionTitle(displayName, record.createdAt || stat.mtime.toISOString()),
      featureName,
      agentName,
      taskTitle,
      taskType,
      goal,
      constraints,
      expectedOutput,
      targetFiles,
      referenceMaterials,
      sessionType: cleanSessionText(record.sessionType) || (metadata?.resumeMode === 'one-shot' ? 'sub' : 'main'),
      status: cleanSessionText(record.status) || (record.sessionType === 'exploration' ? 'locked' : ''),
      archived: record.archived === true,
      todo: record.todo === true,
      metadata,
      formId,
      openDirectory,
      createdAt: record.createdAt || stat.birthtime.toISOString(),
      updatedAt: typeof parsed?.savedAt === 'number' ? new Date(parsed.savedAt).toISOString() : (record.updatedAt || stat.mtime.toISOString()),
      path: sessionPath,
      exists: true,
      bytes: stat.size,
      messageCount: messages.length,
      preview: lastMessage?.content ? String(lastMessage.content).replace(/\s+/g, ' ').slice(0, 140) : '',
      hasSummary: summaryMap ? summaryMap.has(record.id) : (await checkSessionHasSummary(agentId, record.id)),
      tokenUsage: {
        inputTokens: totalUsage?.inputTokens || 0,
        outputTokens: totalUsage?.outputTokens || 0,
        totalTokens: totalUsage?.totalTokens || 0,
        lastRequestUsage: usageStats?.lastRequestUsage || null,
      },
      contextLength: sessionModelInfo.contextLength || null,
      compressRatio: sessionModelInfo.compressRatio || 80,
      modelName: sessionModelInfo.modelName || '',
    };
    // Attach writeback payload as non-enumerable so it doesn't leak into API JSON responses
    Object.defineProperty(result, '_metaWriteback', {
      value: {
        fileMtimeMs: stat.mtimeMs,
        fileSize: stat.size,
        messageCount: messages.length,
        preview: lastMessage?.content ? String(lastMessage.content).replace(/\s+/g, ' ').slice(0, 140) : '',
        tokenUsage: {
          inputTokens: totalUsage?.inputTokens || 0,
          outputTokens: totalUsage?.outputTokens || 0,
          totalTokens: totalUsage?.totalTokens || 0,
          lastRequestUsage: usageStats?.lastRequestUsage || null,
        },
        savedAt: typeof parsed?.savedAt === 'number' ? parsed.savedAt : null,
        metaVersion: META_VERSION,
        modelName: sessionModelInfo.modelName || '',
        contextLength: sessionModelInfo.contextLength || null,
        compressRatio: sessionModelInfo.compressRatio || 80,
      },
      enumerable: false,
      configurable: true,
    });
    return result;
  } catch {
    return {
      id: record.id,
      title: record.title || buildNamedSessionTitle(displayName, record.createdAt || new Date().toISOString()),
      featureName,
      agentName,
      taskTitle,
      taskType,
      goal,
      constraints,
      expectedOutput,
      targetFiles,
      referenceMaterials,
      sessionType: cleanSessionText(record.sessionType) || (metadata?.resumeMode === 'one-shot' ? 'sub' : 'main'),
      status: cleanSessionText(record.status) || (record.sessionType === 'exploration' ? 'locked' : ''),
      archived: record.archived === true,
      todo: record.todo === true,
      metadata,
      formId,
      openDirectory,
      createdAt: record.createdAt || new Date().toISOString(),
      updatedAt: record.updatedAt || record.createdAt || new Date().toISOString(),
      path: sessionPath,
      exists: false,
      bytes: 0,
      messageCount: 0,
      preview: '',
      hasSummary: false,
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      contextLength: null,
      compressRatio: 80,
      modelName: '',
    };
  }
}

// ── Session Content Search Index ────────────────────────────────
// In-memory cache: agentId → Map<sessionId, { sessionId, title, openDirectory, fileMtimeMs, text }>
const _searchIndexCache = new Map();
const _searchIndexBuilding = new Map();
const SEARCH_INDEX_VERSION = 1;
const SEARCH_SNIPPET_RADIUS = 40;
const SEARCH_MAX_RESULTS = 50;

function getSearchIndexPath(agentId) {
  return path.join(getPrebuiltAgentSessionDir(agentId), 'search-index.json');
}

async function loadPersistentSearchIndex(agentId) {
  try {
    const raw = await fs.readFile(getSearchIndexPath(agentId), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed.version !== SEARCH_INDEX_VERSION) return null;
    return parsed.entries || {};
  } catch {
    return null;
  }
}

async function savePersistentSearchIndex(agentId, entriesMap) {
  try {
    const data = { version: SEARCH_INDEX_VERSION, entries: entriesMap };
    await fs.writeFile(getSearchIndexPath(agentId), JSON.stringify(data), 'utf8');
  } catch {}
}

async function extractSessionSearchText(sessionPath) {
  const raw = await fs.readFile(sessionPath, 'utf8');
  const parsed = JSON.parse(raw);
  const messages = Array.isArray(parsed?.runtime?.context?.messages) ? parsed.runtime.context.messages : [];
  const parts = [];
  for (const m of messages) {
    if (m.role === 'user' && typeof m.content === 'string' && m.content.trim()) {
      parts.push('[user] ' + m.content);
    } else if (m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()) {
      parts.push('[assistant] ' + m.content);
    }
  }
  return parts.join('\n');
}

async function ensureSearchIndex(agentId) {
  // Deduplicate concurrent builds
  if (_searchIndexBuilding.has(agentId)) {
    return _searchIndexBuilding.get(agentId);
  }

  const buildPromise = (async () => {
    const index = await readSessionIndex(agentId);
    const memCache = _searchIndexCache.get(agentId);
    const persistent = memCache ? null : await loadPersistentSearchIndex(agentId);

    // Source of truth for valid entries: index.json session IDs
    const validIds = new Set(index.sessions.map(s => s.id));

    // Build entries map: start from existing cache (in-memory or persistent)
    const entries = new Map();
    const toRead = []; // sessions that need file reads

    for (const record of index.sessions) {
      // Check in-memory cache first, then persistent
      const source = memCache?.get(record.id) || persistent?.[record.id];
      if (
        source &&
        source.fileMtimeMs === record.fileMtimeMs &&
        typeof source.text === 'string'
      ) {
        entries.set(record.id, {
          ...source,
          title: cleanSessionText(record.title) || source.title || record.id,
          openDirectory: cleanSessionText(record.openDirectory),
          sessionType: cleanSessionText(record.sessionType) || source.sessionType || 'main',
          archived: record.archived === true,
          todo: record.todo === true,
        });
      } else {
        toRead.push(record);
      }
    }

    // Read files in batches, yielding between batches
    const BATCH_SIZE = 10;
    for (let i = 0; i < toRead.length; i += BATCH_SIZE) {
      const batch = toRead.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(async (record) => {
        try {
          const sessionPath = getPrebuiltSessionFilePath(agentId, record.id);
          const text = await extractSessionSearchText(sessionPath);
          entries.set(record.id, {
            sessionId: record.id,
            title: cleanSessionText(record.title) || record.id,
            openDirectory: cleanSessionText(record.openDirectory),
            sessionType: cleanSessionText(record.sessionType) || 'main',
            archived: record.archived === true,
            todo: record.todo === true,
            fileMtimeMs: record.fileMtimeMs || 0,
            text,
          });
        } catch {
          // Skip unreadable sessions
        }
      }));
      if (i + BATCH_SIZE < toRead.length) {
        await new Promise(resolve => setImmediate(resolve));
      }
    }

    // Persist updated index (only if we actually read files)
    if (toRead.length > 0) {
      const persistData = {};
      for (const [id, entry] of entries) {
        persistData[id] = {
          sessionId: entry.sessionId,
          title: entry.title,
          openDirectory: entry.openDirectory,
          sessionType: entry.sessionType,
          archived: entry.archived,
          fileMtimeMs: entry.fileMtimeMs,
          text: entry.text,
        };
      }
      await savePersistentSearchIndex(agentId, persistData);
    }

    // Cache in memory
    _searchIndexCache.set(agentId, entries);
    return entries;
  })();

  _searchIndexBuilding.set(agentId, buildPromise);
  try {
    const result = await buildPromise;
    return result;
  } finally {
    _searchIndexBuilding.delete(agentId);
  }
}

function searchInText(text, queryLower) {
  const idx = text.toLowerCase().indexOf(queryLower);
  if (idx === -1) return null;
  const start = Math.max(0, idx - SEARCH_SNIPPET_RADIUS);
  const end = Math.min(text.length, idx + queryLower.length + SEARCH_SNIPPET_RADIUS);
  let snippet = text.slice(start, end);
  // Strip role prefix from the beginning of snippet if present
  snippet = snippet.replace(/^\[[^\]]*\]\s*/, '');
  // Determine match role by looking backwards for role tag
  const beforeSnippet = text.slice(0, idx);
  const lastRoleMatch = beforeSnippet.match(/\[(user|assistant)\][^\[]*$/);
  const matchRole = lastRoleMatch ? lastRoleMatch[1] : '';
  return { snippet, matchRole, matchIndex: idx };
}

async function searchSessionsContent(agentId, query, openDirectory) {
  const entries = await ensureSearchIndex(agentId);
  const queryLower = query.toLowerCase();
  const results = [];

  // Normalize openDirectory for filtering
  const normalizedDir = openDirectory
    ? String(openDirectory).replace(/\\/g, '/').toLowerCase()
    : null;

  for (const [sessionId, entry] of entries) {
    // Filter by openDirectory
    if (normalizedDir) {
      const entryDir = String(entry.openDirectory || '').replace(/\\/g, '/').toLowerCase();
      if (entryDir !== normalizedDir) continue;
    }

    // Search in text content
    const match = searchInText(entry.text, queryLower);
    if (match) {
      results.push({
        sessionId: entry.sessionId,
        title: entry.title,
        openDirectory: entry.openDirectory,
        sessionType: entry.sessionType || 'main',
        archived: entry.archived === true,
        snippet: match.snippet,
        matchRole: match.matchRole,
        matchedInText: true,
      });
    }
  }

  // Sort by title relevance then by recency (approximated by sessionId timestamp)
  results.sort((a, b) => {
    // Exact title match gets priority
    const aTitle = a.title.toLowerCase().includes(queryLower) ? 0 : 1;
    const bTitle = b.title.toLowerCase().includes(queryLower) ? 0 : 1;
    if (aTitle !== bTitle) return aTitle - bTitle;
    return String(b.sessionId).localeCompare(String(a.sessionId));
  });

  const total = results.length;
  const trimmed = results.slice(0, SEARCH_MAX_RESULTS);

  return {
    query,
    results: trimmed,
    total,
    indexed: entries.size,
  };
}

async function cleanupEmptySessions(agentId) {
  const index = await readSessionIndex(agentId);
  const toDelete = [];
  for (const record of index.sessions) {
    // Only target default "新对话N" titled sessions
    if (!/^新对话\d+$/.test(cleanSessionText(record.title))) continue;
    const sessionPath = getPrebuiltSessionFilePath(agentId, record.id);
    try {
      const raw = await fs.readFile(sessionPath, 'utf8');
      const parsed = JSON.parse(raw);
      const messages = Array.isArray(parsed?.runtime?.context?.messages) ? parsed.runtime.context.messages : [];
      // Empty session: no messages at all (never had user input)
      if (messages.length === 0) {
        toDelete.push(record.id);
      }
    } catch {
      // Session file missing or corrupt — also clean up
      toDelete.push(record.id);
    }
  }

  if (toDelete.length === 0) return 0;

  let nextActiveId = index.activeSessionId;
  const remaining = index.sessions.filter((s) => !toDelete.includes(s.id));
  if (toDelete.includes(nextActiveId)) {
    nextActiveId = remaining[0]?.id ?? null;
  }
  await writeSessionIndex(agentId, { activeSessionId: nextActiveId, sessions: remaining });

  for (const id of toDelete) {
    await fs.rm(getPrebuiltSessionFilePath(agentId, id), { force: true }).catch(() => {});
  }

  console.log(`[sessions] cleaned up ${toDelete.length} empty session(s) for ${agentId}: ${toDelete.join(', ')}`);
  return toDelete.length;
}

async function listPrebuiltSessions(agentId) {
  const index = await readSessionIndex(agentId);
  const summaryMap = await buildSessionSummaryMap(agentId);
  const modelInfoMap = await buildSessionModelInfoMap(agentId);
  const sessions = await Promise.all(index.sessions.map((record) => summarizePrebuiltSession(agentId, record, summaryMap, modelInfoMap)));

  // ── Batch writeback of stale index metadata ──
  const writebacks = [];
  for (const s of sessions) {
    if (s?._metaWriteback) {
      writebacks.push({ id: s.id, updatedAt: s.updatedAt, ...s._metaWriteback });
      delete s._metaWriteback;
    }
  }
  if (writebacks.length > 0) {
    updateSessionIndex(agentId, (idx) => {
      let dirty = false;
      const sessionMap = new Map(idx.sessions.map((s) => [s.id, s]));
      for (const wb of writebacks) {
        const existing = sessionMap.get(wb.id);
        if (!existing) continue;
        if (
          existing.fileMtimeMs === wb.fileMtimeMs &&
          existing.fileSize === wb.fileSize &&
          existing.metaVersion === wb.metaVersion
        ) continue; // already up-to-date (concurrent list may have written first)
        dirty = true;
        sessionMap.set(wb.id, {
          ...existing,
          fileMtimeMs: wb.fileMtimeMs,
          fileSize: wb.fileSize,
          messageCount: wb.messageCount,
          preview: wb.preview,
          tokenUsage: wb.tokenUsage,
          savedAt: wb.savedAt,
          metaVersion: wb.metaVersion,
          updatedAt: wb.updatedAt,
          modelName: wb.modelName || existing.modelName || '',
          contextLength: wb.contextLength ?? existing.contextLength ?? null,
          compressRatio: wb.compressRatio ?? existing.compressRatio ?? 80,
        });
      }
      if (!dirty) return idx;
      return { ...idx, sessions: Array.from(sessionMap.values()) };
    }).catch(() => {});
  }

  sessions.sort((left, right) => {
    const aUpdated = String(right.updatedAt || '');
    const bUpdated = String(left.updatedAt || '');
    if (aUpdated !== bUpdated) return aUpdated.localeCompare(bUpdated);
    const aCreated = String(right.createdAt || '');
    const bCreated = String(left.createdAt || '');
    if (aCreated !== bCreated) return aCreated.localeCompare(bCreated);
    return String(right.id || '').localeCompare(String(left.id || ''));
  });
  const defaultModelInfo = modelInfoMap.default || modelInfoMap.main || {};
  return {
    activeSessionId: index.activeSessionId || (sessions[0]?.id ?? null),
    contextLength: defaultModelInfo.contextLength || null,
    compressRatio: defaultModelInfo.compressRatio || 80,
    sessions,
  };
}

async function buildSessionModelInfoMap(agentId) {
  const roles = ['default', 'exploration', 'sub'];
  const map = {};
  await Promise.all(roles.map(async (role) => {
    map[role] = await resolveSessionModelInfo(agentId, role);
  }));
  return map;
}

async function createPrebuiltSession(agentId, options = {}) {
  const normalizedAgentId = sanitizeSessionFragment(agentId);
  const sessionMetadata = normalizeSessionMetadata(options.metadata);
  const currentState = isWorkspaceSessionAgent(agentId)
    ? await readWorkspaceState(agentId)
    : null;
  const isProgrammingHelper = normalizedAgentId === 'programming-helper';
  const requestedFormId = cleanSessionText(options.formId) || (isProgrammingHelper ? '' : 'startup-form');
  const startupForm = isProgrammingHelper ? {} : (currentState?.forms?.['startup-form'] || {});
  const sourceForm = currentState?.forms?.[requestedFormId] || startupForm;
  const sourceSessionId = cleanSessionText(options.sourceSessionId);
  const preIndex = await readSessionIndex(agentId);
  const sourceSession = sourceSessionId
    ? preIndex.sessions.find((session) => session.id === sourceSessionId) || null
    : null;
  const createdAt = new Date().toISOString();
  const sessionId = `session-${Date.now()}-${randomUUID().slice(0, 6)}`;
  const nextFeatureName =
    cleanSessionText(options.featureName)
    || cleanSessionText(sourceSession?.featureName)
    || cleanSessionText(sourceForm.feature_name)
    || cleanSessionText(startupForm.feature_name);
  const nextAgentName =
    cleanSessionText(options.agentName)
    || cleanSessionText(sourceSession?.agentName)
    || cleanSessionText(sourceForm.agent_name || sourceForm.assembly_name)
    || cleanSessionText(startupForm.agent_name);
  const assemblyForm = currentState?.forms?.['assembly-form'] || {};
  const nextAssemblyEnvDir =
    cleanSessionText(options.openDirectory)
    || cleanSessionText(sourceForm.env_dir)
    || cleanSessionText(assemblyForm.env_dir)
    || (requestedFormId === 'assembly-form' && nextAgentName ? getAssemblyWorkspaceDir(nextAgentName) : '');
  const nextOpenDirectory =
    requestedFormId === 'assembly-form'
      ? nextAssemblyEnvDir
      : (
        cleanSessionText(options.openDirectory)
        || cleanSessionText(sourceSession?.openDirectory)
        || cleanSessionText(currentState?.openDirectory)
      );
  const nextTaskTitle =
    cleanSessionText(options.taskTitle)
    || cleanSessionText(sourceSession?.taskTitle)
    || cleanSessionText(sourceForm.task_title)
    || cleanSessionText(startupForm.task_title);
  const nextTaskType =
    cleanSessionText(options.taskType)
    || cleanSessionText(sourceSession?.taskType)
    || cleanSessionText(sourceForm.task_type)
    || cleanSessionText(startupForm.task_type);
  const nextGoal =
    cleanSessionText(options.goal)
    || cleanSessionText(sourceSession?.goal)
    || cleanSessionText(sourceForm.goal)
    || cleanSessionText(startupForm.goal);
  const nextConstraints =
    cleanSessionText(options.constraints)
    || cleanSessionText(sourceSession?.constraints)
    || cleanSessionText(sourceForm.constraints)
    || cleanSessionText(startupForm.constraints);
  const nextExpectedOutput =
    cleanSessionText(options.expectedOutput)
    || cleanSessionText(sourceSession?.expectedOutput)
    || cleanSessionText(sourceForm.expected_output)
    || cleanSessionText(startupForm.expected_output);
  const nextTargetFiles =
    cleanSessionText(options.targetFiles)
    || cleanSessionText(sourceSession?.targetFiles)
    || cleanSessionText(sourceForm.target_files)
    || cleanSessionText(startupForm.target_files);
  const nextReferenceMaterials =
    cleanSessionText(options.referenceMaterials)
    || cleanSessionText(sourceSession?.referenceMaterials)
    || cleanSessionText(sourceForm.reference_materials)
    || cleanSessionText(startupForm.reference_materials);
  const sessionDisplayName = normalizedAgentId === 'agent-creator'
    ? nextAgentName
    : (normalizedAgentId === 'programming-helper' ? '' : nextFeatureName);
  const nextTitle = nextTaskTitle || (isProgrammingHelper
    ? await getNextNewSessionTitle(agentId, nextOpenDirectory)
    : buildNamedSessionTitle(sessionDisplayName, createdAt));
  // 解析当前模型配置，持久化到 session index record
  const sessionType = cleanSessionText(options.sessionType) || 'main';
  const modelRole = sessionType === 'exploration' ? 'exploration' : sessionType === 'sub' ? 'sub' : 'default';
  const currentModelInfo = await resolveSessionModelInfo(agentId, modelRole);

  const record = {
    id: sessionId,
    title: nextTitle,
    featureName: nextFeatureName,
    agentName: nextAgentName,
    taskTitle: nextTaskTitle,
    taskType: nextTaskType,
    goal: nextGoal,
    constraints: nextConstraints,
    expectedOutput: nextExpectedOutput,
    targetFiles: nextTargetFiles,
    referenceMaterials: nextReferenceMaterials,
    formId: requestedFormId,
    openDirectory: nextOpenDirectory,
    sessionType,
    metadata: sessionMetadata,
    modelName: currentModelInfo.modelName || '',
    contextLength: currentModelInfo.contextLength || null,
    compressRatio: currentModelInfo.compressRatio || 80,
    createdAt,
    updatedAt: createdAt,
  };
  const nextIndex = await updateSessionIndex(agentId, (index) => {
    return {
      activeSessionId: sessionId,
      sessions: [record, ...index.sessions.filter((session) => session.id !== sessionId)],
    };
  });

  if (normalizedAgentId === 'feature-creator') {
    const featureName = nextFeatureName || cleanSessionText(startupForm.feature_name);
    const openDirectory = nextOpenDirectory || cleanSessionText(currentState.openDirectory);
    const targetDir = cleanSessionText(options.targetDir)
      || (openDirectory ? path.dirname(openDirectory) : cleanSessionText(startupForm.target_dir));
    await writeWorkspaceState(agentId, {
      forms: {
        ...currentState.forms,
        'startup-form': {
          ...startupForm,
          feature_name: featureName,
          target_dir: targetDir,
        },
      },
      openDirectory,
    });
  } else if (normalizedAgentId === 'agent-creator') {
    const formId = requestedFormId;
    const targetForm = currentState.forms?.[formId] || {};
    const agentName = nextAgentName || cleanSessionText(targetForm.agent_name || targetForm.assembly_name || startupForm.agent_name);
    const openDirectory = formId === 'assembly-form'
      ? (nextOpenDirectory || cleanSessionText(targetForm.env_dir) || getAssemblyWorkspaceDir(agentName || 'assembled-agent'))
      : (nextOpenDirectory || cleanSessionText(currentState.openDirectory));
    const targetDir = cleanSessionText(options.targetDir)
      || (openDirectory ? path.dirname(openDirectory) : cleanSessionText(targetForm.target_dir || startupForm.target_dir));
    await writeWorkspaceState(agentId, {
      forms: {
        ...currentState.forms,
        [formId]: {
          ...targetForm,
          ...(formId === 'assembly-form'
            ? {
                assembly_name: agentName,
                env_created: '1',
                env_dir: openDirectory,
              }
            : { agent_name: agentName }),
          target_dir: targetDir,
        },
      },
      openDirectory,
    });
  } else if (normalizedAgentId === 'flow-workspace') {
    const formId = requestedFormId;
    const targetForm = currentState.forms?.[formId] || {};
    const agentName = nextAgentName || cleanSessionText(targetForm.agent_name || targetForm.assembly_name);
    const openDirectory = formId === 'assembly-form'
      ? (nextOpenDirectory || cleanSessionText(targetForm.env_dir) || getAssemblyWorkspaceDir(agentName || 'flow-agent'))
      : (nextOpenDirectory || cleanSessionText(currentState.openDirectory));
    await writeWorkspaceState(agentId, {
      forms: {
        ...currentState.forms,
        [formId]: {
          ...targetForm,
          ...(formId === 'assembly-form'
            ? { assembly_name: agentName, env_created: '1', env_dir: openDirectory }
            : { agent_name: agentName }),
        },
      },
      openDirectory,
    });
  } else if (normalizedAgentId === 'programming-helper') {
    const openDirectory = nextOpenDirectory || cleanSessionText(currentState.openDirectory);
    const cleanedForms = { ...currentState.forms };
    delete cleanedForms['startup-form'];
    await writeWorkspaceState(agentId, {
      forms: cleanedForms,
      openDirectory,
    });
  }

  if (options.returnSummary === false) {
    return buildLightPrebuiltSessionRecord(agentId, record);
  }
  return summarizePrebuiltSession(agentId, record);
}

async function activatePrebuiltSession(agentId, sessionId, options = {}) {
  await updateSessionIndex(agentId, (index) => {
    const session = index.sessions.find((s) => s.id === sessionId);
    if (!session) {
      const error = new Error(`Unknown prebuilt session: ${sessionId}`);
      error.statusCode = 404;
      throw error;
    }
    return { ...index, activeSessionId: sessionId };
  });

  const index = await readSessionIndex(agentId);
  const existing = index.sessions.find((s) => s.id === sessionId);

  if (sanitizeSessionFragment(agentId) === 'feature-creator') {
    const currentState = await readWorkspaceState(agentId);
    const startupForm = currentState.forms?.['startup-form'] || {};
    const openDirectory = cleanSessionText(existing?.openDirectory) || cleanSessionText(currentState.openDirectory);
    const featureName = cleanSessionText(existing?.featureName) || cleanSessionText(startupForm.feature_name);
    const targetDir = openDirectory ? path.dirname(openDirectory) : cleanSessionText(startupForm.target_dir);
    await writeWorkspaceState(agentId, {
      forms: {
        ...currentState.forms,
        'startup-form': {
          ...startupForm,
          feature_name: featureName,
          target_dir: targetDir,
        },
      },
      openDirectory,
    });
  } else if (sanitizeSessionFragment(agentId) === 'agent-creator') {
    const currentState = await readWorkspaceState(agentId);
    const formId = cleanSessionText(existing.formId) || 'startup-form';
    const startupForm = currentState.forms?.['startup-form'] || {};
    const targetForm = currentState.forms?.[formId] || startupForm;
    const openDirectory = formId === 'assembly-form'
      ? (cleanSessionText(existing.openDirectory) || cleanSessionText(targetForm.env_dir) || getAssemblyWorkspaceDir(cleanSessionText(existing.agentName) || 'assembled-agent'))
      : (cleanSessionText(existing.openDirectory) || cleanSessionText(currentState.openDirectory));
    const agentName = cleanSessionText(existing.agentName) || cleanSessionText(targetForm.agent_name || targetForm.assembly_name || startupForm.agent_name);
    const targetDir = openDirectory ? path.dirname(openDirectory) : cleanSessionText(targetForm.target_dir || startupForm.target_dir);
    await writeWorkspaceState(agentId, {
      forms: {
        ...currentState.forms,
        [formId]: {
          ...targetForm,
          ...(formId === 'assembly-form'
            ? {
                assembly_name: agentName,
                env_created: '1',
                env_dir: openDirectory,
              }
            : { agent_name: agentName }),
          target_dir: targetDir,
        },
      },
      openDirectory,
    });
  } else if (sanitizeSessionFragment(agentId) === 'flow-workspace') {
    const currentState = await readWorkspaceState(agentId);
    const formId = cleanSessionText(existing.formId) || 'assembly-form';
    const targetForm = currentState.forms?.[formId] || {};
    const openDirectory = formId === 'assembly-form'
      ? (cleanSessionText(existing.openDirectory) || cleanSessionText(targetForm.env_dir) || getAssemblyWorkspaceDir(cleanSessionText(existing.agentName) || 'flow-agent'))
      : (cleanSessionText(existing.openDirectory) || cleanSessionText(currentState.openDirectory));
    const agentName = cleanSessionText(existing.agentName) || cleanSessionText(targetForm.agent_name || targetForm.assembly_name);
    const targetDir = openDirectory ? path.dirname(openDirectory) : cleanSessionText(targetForm.target_dir);
    await writeWorkspaceState(agentId, {
      forms: {
        ...currentState.forms,
        [formId]: {
          ...targetForm,
          ...(formId === 'assembly-form'
            ? {
                assembly_name: agentName,
                env_created: '1',
                env_dir: openDirectory,
              }
            : { agent_name: agentName }),
          target_dir: targetDir,
        },
      },
      openDirectory,
    });
  } else if (sanitizeSessionFragment(agentId) === 'programming-helper') {
    const currentState = await readWorkspaceState(agentId);
    const openDirectory = cleanSessionText(existing.openDirectory) || cleanSessionText(currentState.openDirectory);
    const cleanedForms = { ...currentState.forms };
    delete cleanedForms['startup-form'];
    await writeWorkspaceState(agentId, {
      forms: cleanedForms,
      openDirectory,
    });
  }

  if (options?.returnSummary === false) {
    return buildLightPrebuiltSessionRecord(agentId, existing);
  }
  return summarizePrebuiltSession(agentId, existing);
}

async function deletePrebuiltSession(agentId, sessionId) {
  const newIndex = await updateSessionIndex(agentId, (index) => {
    const existing = index.sessions.find((session) => session.id === sessionId);
    if (!existing) {
      const error = new Error(`Unknown prebuilt session: ${sessionId}`);
      error.statusCode = 404;
      throw error;
    }

    const remainingSessions = index.sessions.filter((session) => session.id !== sessionId);
    const nextActiveSessionId = index.activeSessionId === sessionId
      ? (remainingSessions[0]?.id ?? null)
      : index.activeSessionId;
    return { activeSessionId: nextActiveSessionId, sessions: remainingSessions };
  });

  await fs.rm(getPrebuiltSessionFilePath(agentId, sessionId), { force: true }).catch(() => {});

  return {
    deletedSessionId: sessionId,
    activeSessionId: newIndex.activeSessionId,
    sessions: await listPrebuiltSessions(agentId),
  };
}

async function archivePrebuiltSession(agentId, sessionId, archived) {
  const newIndex = await updateSessionIndex(agentId, (index) => {
    const existing = index.sessions.find((session) => session.id === sessionId);
    if (!existing) {
      const error = new Error(`Unknown prebuilt session: ${sessionId}`);
      error.statusCode = 404;
      throw error;
    }
    const sessions = index.sessions.map((session) =>
      session.id === sessionId ? { ...session, archived: !!archived, todo: archived ? false : session.todo } : session,
    );
    return { activeSessionId: index.activeSessionId, sessions };
  });

  return {
    archivedSessionId: sessionId,
    archived: !!archived,
    activeSessionId: newIndex.activeSessionId,
    sessions: await listPrebuiltSessions(agentId),
  };
}

async function tagPrebuiltSessionTodo(agentId, sessionId, todo) {
  const newIndex = await updateSessionIndex(agentId, (index) => {
    const existing = index.sessions.find((session) => session.id === sessionId);
    if (!existing) {
      const error = new Error(`Unknown prebuilt session: ${sessionId}`);
      error.statusCode = 404;
      throw error;
    }
    // Only non-archived sessions can be tagged as todo
    if (todo && existing.archived) {
      const error = new Error('Cannot tag an archived session as todo');
      error.statusCode = 400;
      throw error;
    }
    const sessions = index.sessions.map((session) =>
      session.id === sessionId ? { ...session, todo: !!todo } : session,
    );
    return { activeSessionId: index.activeSessionId, sessions };
  });

  return {
    todoSessionId: sessionId,
    todo: !!todo,
    activeSessionId: newIndex.activeSessionId,
    sessions: await listPrebuiltSessions(agentId),
  };
}

async function requirePrebuiltSessionRecord(agentId, sessionId) {
  const index = await readSessionIndex(agentId);
  const existing = index.sessions.find((session) => session.id === cleanSessionText(sessionId));
  if (!existing) {
    const error = new Error(`Unknown prebuilt session: ${sessionId}`);
    error.statusCode = 404;
    throw error;
  }
  return existing;
}

async function resolvePrebuiltSessionOwner(sessionId, preferredAgentId = '') {
  const cleanSessionId = cleanSessionText(sessionId);
  if (!cleanSessionId) return null;

  const candidates = [];
  const addCandidate = (agentId) => {
    const normalized = normalizeClientAgentId(agentId);
    if (normalized && !candidates.includes(normalized)) candidates.push(normalized);
  };

  addCandidate(preferredAgentId);
  addCandidate('flow-workspace');
  addCandidate('agent-creator');
  addCandidate('feature-creator');
  addCandidate('programming-helper');
  try {
    const discovered = await discoverAgents(AGENTS_ROOT);
    discovered.forEach((agent) => addCandidate(agent?.id));
  } catch {}

  for (const agentId of candidates) {
    try {
      const index = await readSessionIndex(agentId);
      if (index.sessions.some((session) => session.id === cleanSessionId)) {
        return agentId;
      }
    } catch {}
  }

  return null;
}

async function requirePrebuiltAgentForRuntime(agentId) {
  const normalizedAgentId = normalizeClientAgentId(agentId);
  const discovered = await discoverAgents(AGENTS_ROOT);
  const metadata = discovered.find((item) => sanitizeSessionFragment(item.id) === normalizedAgentId);
  if (!metadata) {
    const error = new Error(`Unknown agent: ${agentId}`);
    error.statusCode = 404;
    throw error;
  }
  return enrichAgent(metadata);
}

async function exportContextHandoffForSession(sessionId, preferredAgentId = '', policy = {}) {
  const ownerAgentId = await resolvePrebuiltSessionOwner(sessionId, preferredAgentId);
  if (!ownerAgentId) {
    const error = new Error(`Unknown prebuilt session: ${sessionId}`);
    error.statusCode = 404;
    throw error;
  }

  const record = await requirePrebuiltSessionRecord(ownerAgentId, sessionId);
  const summary = await summarizePrebuiltSession(ownerAgentId, record);
  if (!summary.exists) {
    const error = new Error(`Session snapshot not found for handoff export: ${sessionId}`);
    error.statusCode = 409;
    throw error;
  }
  const sessionPath = getPrebuiltSessionFilePath(ownerAgentId, sessionId);
  const normalizedStrategy = typeof policy?.strategy === 'string' ? policy.strategy.trim() : '';
  if (normalizedStrategy === 'summarized-nine-section') {
    const agent = await requirePrebuiltAgentForRuntime(ownerAgentId);
    const sourceSessionSnapshot = await readSessionSnapshotForContinuity(ownerAgentId, sessionId);
    return exportSummarizedHandoffPackage({
      userDataRoot: USER_DATA_ROOT,
      agentId: ownerAgentId,
      sessionId,
      sourceRecord: record,
      policy,
      agentRelativeDir: agent.relativeDir,
      projectRoot: __dirname,
      sourceSessionSnapshot,
    });
  }
  return exportHistoryOnlyHandoffPackage({
    userDataRoot: USER_DATA_ROOT,
    agentId: ownerAgentId,
    sessionId,
    sessionPath,
    sourceRecord: record,
    policy,
  });
}

async function createCompactedResumeFromHandoff({
  preferredAgentId = '',
  handoffId = '',
  handoffPath = '',
  goal = '',
  startRuntime = true,
}) {
  const normalizedAgentId = normalizeClientAgentId(preferredAgentId);
  if (!handoffPath && (!normalizedAgentId || !handoffId)) {
    const error = new Error('agentId is required when resuming from handoffId');
    error.statusCode = 400;
    throw error;
  }
  const { handoff, handoffPath: resolvedHandoffPath } = await readHandoffPackage({
    userDataRoot: USER_DATA_ROOT,
    agentId: normalizedAgentId || cleanSessionText(preferredAgentId),
    handoffId,
    handoffPath,
  });
  const sourceAgentId = cleanSessionText(handoff?.sourceAgentId);
  const sourceSessionId = cleanSessionText(handoff?.sourceSessionId);

  if (!sourceAgentId || !sourceSessionId) {
    const error = new Error('Invalid handoff package: sourceAgentId/sourceSessionId is required');
    error.statusCode = 400;
    throw error;
  }

  if (normalizedAgentId && normalizedAgentId !== sanitizeSessionFragment(sourceAgentId)) {
    const error = new Error('Phase-1 compacted resume only supports resuming within the source agent');
    error.statusCode = 400;
    throw error;
  }

  const agent = await requirePrebuiltAgentForRuntime(sourceAgentId);
  if (!handoff?.stats?.synthetic) {
    await requirePrebuiltSessionRecord(agent.id, sourceSessionId);
  }
  const session = await createPrebuiltSession(agent.id, {
    sourceSessionId,
    goal: goal || undefined,
      metadata: {
        resumeMode: 'compacted',
        sourceAgentId,
        sourceSessionId,
        handoffId: cleanSessionText(handoff?.handoffId) || cleanSessionText(handoffId),
        handoffPath: resolvedHandoffPath,
        handoffCreatedAt: cleanSessionText(handoff?.createdAt),
        handoffMode: cleanSessionText(handoff?.mode),
        handoffSummaryKind: cleanSessionText(handoff?.summaryShape),
      },
    });

  let status = null;
  let connected = null;
  if (startRuntime) {
    status = await startManagedAgent(agent, session.id, {
      extraEnv: {
        PROTOCLAW_HANDOFF_PATH: resolvedHandoffPath,
      },
    });
    connected = await waitForManagedRuntimeReady(agent.id, 10000, session.id);
  }

  return {
    handoff,
    handoffPath: resolvedHandoffPath,
    session,
    status,
    agent: connected,
  };
}

async function compactAndResumeCurrentSession({
  preferredAgentId = '',
  sessionId = '',
  policy = {},
  startRuntime = true,
}) {
  const exportResult = await exportContextHandoffForSession(sessionId, preferredAgentId, policy);
  const handoffPath = cleanSessionText(exportResult?.handoffPath);
  const handoffId = cleanSessionText(exportResult?.handoff?.handoffId);
  return createCompactedResumeFromHandoff({
    preferredAgentId,
    handoffId,
    handoffPath,
    startRuntime,
  });
}

async function compactAndResumeFromProvidedSummary({
  preferredAgentId = '',
  sessionId = '',
  summaryText = '',
  rawResponse = '',
  importantFiles = [],
  importantSkills = [],
  sessionTitle = '',
  fileRanges = {},
  policy = {},
  startRuntime = true,
}) {
  const ownerAgentId = await resolvePrebuiltSessionOwner(sessionId, preferredAgentId);
  if (!ownerAgentId) {
    const error = new Error(`Unknown prebuilt session: ${sessionId}`);
    error.statusCode = 404;
    throw error;
  }

  const record = await requirePrebuiltSessionRecord(ownerAgentId, sessionId);
  const sourceSessionSnapshot = await readSessionSnapshotForContinuity(ownerAgentId, sessionId);
  const handoffResult = await writeSummarizedHandoffPackage({
    userDataRoot: USER_DATA_ROOT,
    agentId: ownerAgentId,
    sessionId,
    sourceRecord: record,
    policy,
    summaryText,
    rawResponse,
    importantFiles,
    importantSkills,
    sessionTitle,
    fileRanges,
    sourceSessionSnapshot,
  });

  return createCompactedResumeFromHandoff({
    preferredAgentId: ownerAgentId,
    handoffId: cleanSessionText(handoffResult?.handoff?.handoffId),
    handoffPath: cleanSessionText(handoffResult?.handoffPath),
    startRuntime,
  });
}

async function exportProvidedSummaryHandoff({
  preferredAgentId = '',
  sessionId = '',
  summaryText = '',
  rawResponse = '',
  importantFiles = [],
  importantSkills = [],
  sessionTitle = '',
  fileRanges = {},
  policy = {},
  sessionTimestamp = null,
  gitMeta = null,
}) {
  const ownerAgentId = await resolvePrebuiltSessionOwner(sessionId, preferredAgentId);
  if (!ownerAgentId) {
    const error = new Error(`Unknown prebuilt session: ${sessionId}`);
    error.statusCode = 404;
    throw error;
  }

  const record = await requirePrebuiltSessionRecord(ownerAgentId, sessionId);
  const sourceSessionSnapshot = await readSessionSnapshotForContinuity(ownerAgentId, sessionId);
  return writeSummarizedHandoffPackage({
    userDataRoot: USER_DATA_ROOT,
    agentId: ownerAgentId,
    sessionId,
    sourceRecord: record,
    policy,
    summaryText,
    rawResponse,
    importantFiles,
    importantSkills,
    sessionTitle,
    fileRanges,
    sessionTimestamp,
    gitMeta,
    sourceSessionSnapshot,
  });
}

async function deletePrebuiltProject(agentId, projectId) {
  const normalizedAgentId = sanitizeSessionFragment(agentId);
  if (!WORKSPACE_SESSION_AGENT_IDS.has(normalizedAgentId)) {
    const error = new Error(`Agent ${agentId} does not support project deletion`);
    error.statusCode = 400;
    throw error;
  }

  const state = await readWorkspaceState(agentId);
  const projectsKey = normalizedAgentId === 'feature-creator'
    ? 'featureProjects'
    : normalizedAgentId === 'programming-helper'
      ? 'phProjects'
      : 'agentProjects';
  const projects = Array.isArray(state[projectsKey]) ? [...state[projectsKey]] : [];
  const projectIndex = projects.findIndex((p) => p?.id === projectId);

  if (projectIndex < 0) {
    const error = new Error(`Unknown project: ${projectId}`);
    error.statusCode = 404;
    throw error;
  }

  const project = projects[projectIndex];
  const projectOpenDirectory = typeof project.openDirectory === 'string' ? project.openDirectory.trim().toLowerCase().replace(/\\/g, '/') : '';
  const projectFeatureName = typeof (project.featureName || project.agentName) === 'string' ? (project.featureName || project.agentName).trim().toLowerCase() : '';

  projects.splice(projectIndex, 1);
  await writeWorkspaceState(agentId, { [projectsKey]: projects });

  let sessionsToDelete = [];
  let nextActiveSessionId = null;
  await updateSessionIndex(agentId, (index) => {
    sessionsToDelete = [];
    const remainingSessions = index.sessions.filter((session) => {
      const sessionDir = typeof session.openDirectory === 'string' ? session.openDirectory.trim().toLowerCase().replace(/\\/g, '/') : '';
      const sessionName = typeof (session.featureName || session.agentName) === 'string' ? (session.featureName || session.agentName).trim().toLowerCase() : '';
      const matchesDir = projectOpenDirectory && sessionDir === projectOpenDirectory;
      const matchesName = !projectOpenDirectory && projectFeatureName && sessionName === projectFeatureName;
      if (matchesDir || matchesName) {
        sessionsToDelete.push(session);
        return false;
      }
      return true;
    });

    const deletedWasActive = sessionsToDelete.some((s) => s.id === index.activeSessionId);
    nextActiveSessionId = deletedWasActive
      ? (remainingSessions[0]?.id ?? null)
      : index.activeSessionId;
    return { activeSessionId: nextActiveSessionId, sessions: remainingSessions };
  });

  for (const session of sessionsToDelete) {
    await fs.rm(getPrebuiltSessionFilePath(agentId, session.id), { force: true }).catch(() => {});
  }

  return {
    deletedProjectId: projectId,
    deletedSessionIds: sessionsToDelete.map((s) => s.id),
    activeSessionId: nextActiveSessionId,
    sessions: await listPrebuiltSessions(agentId),
  };
}


async function resolveContextLength(agentId) {
  const info = await resolveSessionModelInfo(agentId, 'default');
  return info.contextLength;
}

async function lockExplorationSession(agentId, sessionId, goal, response) {
  try {
    await updateSessionIndex(agentId, (index) => {
      const record = index.sessions.find(s => s.id === sessionId);
      if (!record) return index;
      record.sessionType = 'exploration';
      record.status = 'locked';
      record.lockedAt = new Date().toISOString();
      if (goal) record.goal = goal;
      record.domains = extractDomainsFromText(response || goal || '');
      record.updatedAt = new Date().toISOString();
      return { ...index };
    });
    console.log(`[lockExploration] Locked session=${sessionId} domains=${record.domains?.join(',') || '(none)'}`);
  } catch (err) {
    console.error(`[lockExploration] Failed for session=${sessionId}:`, err.message);
  }
}

function extractDomainsFromText(text) {
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

async function buildExplorationHandoffPayload(agentId, explorationIds, goal) {
  const handoffsDir = path.join(USER_DATA_ROOT, 'context-handoffs', sanitizeSessionFragment(agentId || 'programming-helper'));

  // --- Phase 1: Read handoff files for 交接班信息 (sourceSummary + importantFiles/Skills) ---
  let handoffFiles = [];
  try {
    handoffFiles = (await fs.readdir(handoffsDir)).filter(f => f.startsWith('handoff-') && !f.startsWith('handoff-synthetic-') && f.endsWith('.json'));
  } catch {}

  const allImportantFiles = [];
  const allImportantSkills = [];
  const allFileRanges = {};
  const summaryParts = [];

  for (const expId of explorationIds) {
    let bestParsed = null;
    let bestCreatedAt = '';
    for (const fname of handoffFiles) {
      try {
        const raw = await fs.readFile(path.join(handoffsDir, fname), 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed.sourceSessionId !== expId) continue;
        const ca = parsed.createdAt || '';
        if (ca > bestCreatedAt) {
          bestParsed = parsed;
          bestCreatedAt = ca;
        }
      } catch {}
    }
    if (bestParsed) {
      // sourceSummary (老版摘要) is part of 交接班信息
      const summary = bestParsed.sourceSummary || bestParsed.summaryText || '';
      if (summary) {
        summaryParts.push(`## 探索记录 ${expId}\n${summary}`);
      }
      if (Array.isArray(bestParsed.compactOutput?.importantFiles)) {
        allImportantFiles.push(...bestParsed.compactOutput.importantFiles);
      }
      if (Array.isArray(bestParsed.compactOutput?.importantSkills)) {
        allImportantSkills.push(...bestParsed.compactOutput.importantSkills);
      }
      if (bestParsed.compactOutput?.fileRanges && typeof bestParsed.compactOutput.fileRanges === 'object') {
        Object.assign(allFileRanges, bestParsed.compactOutput.fileRanges);
      }
    }
  }

  const combinedSummary = summaryParts.join('\n\n');

  // --- Phase 2: Read session files for full conversation history (全量历史) ---
  const sessionsDir = path.join(USER_DATA_ROOT, 'workspaces', sanitizeSessionFragment(agentId || 'programming-helper'), 'sessions');
  const allSeedMessages = [];

  for (const expId of explorationIds) {
    try {
      const sessionPath = path.join(sessionsDir, `${expId}.json`);
      const rawSession = await fs.readFile(sessionPath, 'utf8');
      const sessionData = JSON.parse(rawSession);
      const messages = sessionData?.runtime?.context?.messages;
      if (!Array.isArray(messages)) continue;

      // Include user, assistant, tool messages (skip system prompts — sub-agent has its own)
      const conversationMessages = messages
        .filter(m => m && m.role && m.role !== 'system' && (m.content || Array.isArray(m.toolCalls)))
        .map(m => {
          const msg = { role: m.role, content: typeof m.content === 'string' ? m.content : '' };
          if (typeof m.turn === 'number') msg.turn = m.turn;
          if (Array.isArray(m.toolCalls) && m.toolCalls.length > 0) msg.toolCalls = m.toolCalls;
          if (m.toolCallId) msg.toolCallId = m.toolCallId;
          return msg;
        });

      if (conversationMessages.length > 0) {
        allSeedMessages.push(...conversationMessages);
      }
    } catch (err) {
      console.warn(`[buildExplorationHandoffPayload] Failed to read session ${expId}: ${err.message}`);
    }
  }

  return {
    packageId: `synthetic-exploration-${Date.now()}`,
    sourceSessionId: explorationIds[0] || 'unknown',
    sourceSummary: combinedSummary,
    seedMessages: allSeedMessages,
    mode: 'summary',
    stats: { synthetic: true },
    compactOutput: {
      importantFiles: [...new Set(allImportantFiles)],
      importantSkills: [...new Set(allImportantSkills)],
      fileRanges: allFileRanges,
    },
  };
}

async function writeSyntheticHandoff(agentId, payload) {
  const dir = path.join(USER_DATA_ROOT, 'context-handoffs', sanitizeSessionFragment(agentId || 'programming-helper'));
  await fs.mkdir(dir, { recursive: true });
  const fileName = `handoff-synthetic-${Date.now()}.json`;
  const filePath = path.join(dir, fileName);
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
  return filePath;
}

  return {
    buildFeatureSessionTitle,
    buildNamedSessionTitle,
    getNextNewSessionTitle,
    checkSessionHasSummary,
    buildSessionSummaryMap,
    buildLightPrebuiltSessionRecord,
    findSessionSummary,
    findSessionSummaryPath,
    extractToolCallLabel,
    buildSessionTrimPreview,
    summarizePrebuiltSession,
    getSearchIndexPath,
    loadPersistentSearchIndex,
    savePersistentSearchIndex,
    extractSessionSearchText,
    ensureSearchIndex,
    searchInText,
    searchSessionsContent,
    cleanupEmptySessions,
    listPrebuiltSessions,
    buildSessionModelInfoMap,
    createPrebuiltSession,
    activatePrebuiltSession,
    deletePrebuiltSession,
    archivePrebuiltSession,
    tagPrebuiltSessionTodo,
    requirePrebuiltSessionRecord,
    resolvePrebuiltSessionOwner,
    requirePrebuiltAgentForRuntime,
    exportContextHandoffForSession,
    createCompactedResumeFromHandoff,
    compactAndResumeCurrentSession,
    compactAndResumeFromProvidedSummary,
    exportProvidedSummaryHandoff,
    deletePrebuiltProject,
    resolveContextLength,
    lockExplorationSession,
    extractDomainsFromText,
    buildExplorationHandoffPayload,
    writeSyntheticHandoff,
  };
}
