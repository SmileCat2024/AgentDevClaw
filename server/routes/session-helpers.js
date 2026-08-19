import path from 'path';
import { promises as fs } from 'fs';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

import { USER_DATA_ROOT, AGENTS_ROOT } from '../shared/constants.js';
import { normalizePathCasing } from '../shared/fs-helpers.js';
import {
  sanitizeSessionFragment, cleanSessionText, isWorkspaceSessionAgent,
  getAssemblyWorkspaceDir, normalizeClientAgentId, log,
} from '../shared/string-helpers.js';
import {
  readSessionIndex, updateSessionIndex,
  getPrebuiltSessionFilePath,
  normalizeSessionMetadata, buildSessionTitle, computeNextSessionNumber,
} from '../shared/session-access.js';
import { resolveSessionModelInfo } from './model-config.js';
import { removeOpenSession } from '../shared/open-sessions-tracker.js';
import { createSessionHandoffHelpers } from './session-handoff-helpers.js';
import { recordSidebarDiagnosticEvent } from '../shared/sidebar-diagnostics.js';

import {
  META_VERSION,
  extractTokenUsage,
  extractLastMessagePreview,
  resolveSessionModelFromRecord,
  selectEmptySessions,
  resolvePostCleanupState,
  searchInTextPure,
  extractToolCallLabel,
  buildSessionTrimPreview,
  estimatePreambleCharCount,
  buildLightPrebuiltSessionRecord,
  compareSidebarSessionReadModels,
  SIDEBAR_SESSION_META_VERSION,
  isSidebarSessionReadModelReady,
  sortSidebarSessions,
  extractDomainsFromText,
} from './session-helpers-pure.js';

import {
  getSearchIndexPath,
  loadPersistentSearchIndex,
  savePersistentSearchIndex,
  extractSessionSearchText,
  ensureSearchIndex,
  searchInText,
  searchSessionsContent,
  invalidateSearchIndex,
} from './session-search-index.js';

// Re-export pure functions for backward compatibility
export {
  META_VERSION,
  extractTokenUsage,
  extractLastMessagePreview,
  resolveSessionModelFromRecord,
  selectEmptySessions,
  resolvePostCleanupState,
  searchInTextPure,
  extractToolCallLabel,
  buildSessionTrimPreview,
  estimatePreambleCharCount,
  buildLightPrebuiltSessionRecord,
  compareSidebarSessionReadModels,
  SIDEBAR_SESSION_META_VERSION,
  isSidebarSessionReadModelReady,
  sortSidebarSessions,
  extractDomainsFromText,
};

export function createSessionHelpers(ctx) {
  const {
    readWorkspaceState,
    writeWorkspaceState,
    discoverAgents,
    enrichAgent,
    startManagedAgent,
    waitForManagedRuntimeReady,
  } = ctx;
  const sidebarReadModelRetryAfter = new Map();

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
  return `新对话${computeNextSessionNumber(index.sessions, openDirectory)}`;
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

async function setSessionHasSummary(agentId, sessionId, hasSummary) {
  return updateSessionIndex(agentId, (index) => {
    let found = false;
    const sessions = index.sessions.map((record) => {
      if (record.id !== cleanSessionText(sessionId)) return record;
      found = true;
      if (record.hasSummary === (hasSummary === true)) return record;
      return { ...record, hasSummary: hasSummary === true };
    });
    return found ? { ...index, sessions } : index;
  });
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
  const projectName = cleanSessionText(record.projectName);
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
    : (normalizedAgentId === 'programming-helper' ? taskTitle : (normalizedAgentId === 'agent-studio' ? (projectName || goal) : featureName));
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
      // Fast path: file unchanged since last read, so the persisted values
      // (captured at creation or updated on last file change) are authoritative.
      // Ensure modelInfoMap has the needed role before delegating to the pure resolver.
      const sTypeFP = cleanSessionText(record.sessionType) || (metadata?.resumeMode === 'one-shot' ? 'sub' : 'main');
      const modelRoleFP = sTypeFP === 'exploration' ? 'exploration' : sTypeFP === 'sub' ? 'sub' : 'default';
      const effectiveMap = (modelInfoMap && modelInfoMap[modelRoleFP])
        ? modelInfoMap
        : { ...(modelInfoMap || {}), [modelRoleFP]: await resolveSessionModelInfo(agentId, sTypeFP) };
      const sessionModelInfo = resolveSessionModelFromRecord(record, effectiveMap, record.sessionType, metadata);
      const summaryInfo = summaryMap ? summaryMap.get(record.id) : null;
      const compactTitle = summaryInfo?.sessionTitle || '';
      return {
        id: record.id,
        title: cleanSessionText(record.title) || compactTitle || buildNamedSessionTitle(displayName, record.createdAt || stat.mtime.toISOString()),
        featureName,
        agentName,
        projectName,
        taskTitle,
        taskType,
        goal,
        constraints,
        expectedOutput,
        targetFiles,
        referenceMaterials,
        sessionType: sTypeFP,
        status: cleanSessionText(record.status) || (record.sessionType === 'exploration' ? 'locked' : ''),
        archived: record.archived === true,
        todo: record.todo === true,
        metadata,
        formId,
        openDirectory,
        createdAt: record.createdAt || stat.birthtime.toISOString(),
        updatedAt: record.updatedAt || (record.savedAt ? new Date(record.savedAt).toISOString() : stat.mtime.toISOString()),
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
    const preview = extractLastMessagePreview(messages);
    const summaryInfo = summaryMap ? summaryMap.get(record.id) : null;
    const compactTitle = summaryInfo?.sessionTitle || '';
    const tokenUsage = extractTokenUsage(parsed);
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
      projectName,
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
      preview,
      hasSummary: summaryMap ? summaryMap.has(record.id) : (await checkSessionHasSummary(agentId, record.id)),
      tokenUsage,
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
        preview,
        tokenUsage,
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
      projectName,
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

async function cleanupEmptySessions(agentId) {
  const index = await readSessionIndex(agentId);

  // Build message count map for sessions with default titles
  const sessionMessageCounts = new Map();
  for (const record of index.sessions) {
    if (!/^新对话\d+$/.test(cleanSessionText(record.title))) continue;
    const sessionPath = getPrebuiltSessionFilePath(agentId, record.id);
    try {
      const raw = await fs.readFile(sessionPath, 'utf8');
      const parsed = JSON.parse(raw);
      const messages = Array.isArray(parsed?.runtime?.context?.messages) ? parsed.runtime.context.messages : [];
      sessionMessageCounts.set(record.id, { messageCount: messages.length, fileExists: true });
    } catch {
      // File missing or corrupt — leave out of map; selectEmptySessions will mark it
    }
  }

  const toDelete = selectEmptySessions(index.sessions, sessionMessageCounts);
  if (toDelete.length === 0) return 0;

  await updateSessionIndex(agentId, (current) => {
    const currentIds = new Set(current.sessions.map((session) => session.id));
    const stillPresent = toDelete.filter((id) => currentIds.has(id));
    return stillPresent.length > 0 ? resolvePostCleanupState(current, stillPresent) : current;
  });

  for (const id of toDelete) {
    await fs.rm(getPrebuiltSessionFilePath(agentId, id), { force: true }).catch(e => console.warn(e));
  }

  console.log(`[sessions] cleaned up ${toDelete.length} empty session(s) for ${agentId}: ${toDelete.join(', ')}`);
  return toDelete.length;
}

async function listPrebuiltSessionsRich(agentId) {
  const startedAt = Date.now();
  const index = await readSessionIndex(agentId);
  const indexLoadedAt = Date.now();
  const summaryMap = await buildSessionSummaryMap(agentId);
  const summariesLoadedAt = Date.now();
  const modelInfoMap = await buildSessionModelInfoMap(agentId);
  const modelsLoadedAt = Date.now();
  const sessions = await Promise.all(index.sessions.map((record) => summarizePrebuiltSession(agentId, record, summaryMap, modelInfoMap)));
  const sessionsLoadedAt = Date.now();

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
    }).catch(e => console.warn(e));
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
  const readModelStartedAt = Date.now();
  const sidebarReadModelComparison = compareSidebarSessionReadModels(
    index.sessions.map((record) => buildLightPrebuiltSessionRecord(agentId, record)),
    sessions,
  );
  const readModelMs = Date.now() - readModelStartedAt;
  const defaultModelInfo = modelInfoMap.default || modelInfoMap.main || {};
  const perfEvent = {
    kind: 'list_perf',
    operation: 'list_sessions',
    phase: 'completed',
    agentId: String(agentId || '').slice(0, 128),
    sessionCount: sessions.length,
    handoffSummaryCount: summaryMap.size,
    writebackCount: writebacks.length,
    indexMs: indexLoadedAt - startedAt,
    handoffMs: summariesLoadedAt - indexLoadedAt,
    modelMs: modelsLoadedAt - summariesLoadedAt,
    sessionsMs: sessionsLoadedAt - modelsLoadedAt,
    readModelMs,
    ...sidebarReadModelComparison,
    totalMs: Date.now() - startedAt,
    result: 'success',
  };
  void recordSidebarDiagnosticEvent(perfEvent, { source: 'server' });
  return {
    revision: Number(index.revision) || 0,
    activeSessionId: index.activeSessionId || (sessions[0]?.id ?? null),
    contextLength: defaultModelInfo.contextLength || null,
    compressRatio: defaultModelInfo.compressRatio || 80,
    sessions,
  };
}

function buildSidebarSessionMigrationPatch(summary, hasSummary, existingRecord = {}) {
  const writeback = summary?._metaWriteback && typeof summary._metaWriteback === 'object'
    ? summary._metaWriteback
    : {};
  return {
    title: cleanSessionText(summary?.title),
    featureName: cleanSessionText(summary?.featureName),
    agentName: cleanSessionText(summary?.agentName),
    taskTitle: cleanSessionText(summary?.taskTitle),
    taskType: cleanSessionText(summary?.taskType),
    goal: cleanSessionText(summary?.goal),
    constraints: cleanSessionText(summary?.constraints),
    expectedOutput: cleanSessionText(summary?.expectedOutput),
    targetFiles: cleanSessionText(summary?.targetFiles),
    referenceMaterials: cleanSessionText(summary?.referenceMaterials),
    sessionType: cleanSessionText(summary?.sessionType) || 'main',
    status: cleanSessionText(summary?.status),
    archived: summary?.archived === true,
    todo: summary?.todo === true,
    metadata: normalizeSessionMetadata(summary?.metadata),
    formId: cleanSessionText(summary?.formId),
    openDirectory: cleanSessionText(summary?.openDirectory),
    createdAt: cleanSessionText(summary?.createdAt) || new Date().toISOString(),
    updatedAt: cleanSessionText(summary?.updatedAt) || cleanSessionText(summary?.createdAt) || new Date().toISOString(),
    fileMtimeMs: Number.isFinite(writeback.fileMtimeMs) ? writeback.fileMtimeMs : existingRecord.fileMtimeMs,
    fileSize: Number.isFinite(writeback.fileSize) ? writeback.fileSize : (Number(summary?.bytes) || existingRecord.fileSize || 0),
    messageCount: Number.isFinite(summary?.messageCount) ? summary.messageCount : 0,
    preview: cleanSessionText(summary?.preview),
    hasSummary: hasSummary === true,
    tokenUsage: summary?.tokenUsage && typeof summary.tokenUsage === 'object'
      ? summary.tokenUsage
      : { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    savedAt: Number.isFinite(writeback.savedAt) ? writeback.savedAt : existingRecord.savedAt,
    metaVersion: Number.isFinite(writeback.metaVersion) ? writeback.metaVersion : (existingRecord.metaVersion || META_VERSION),
    modelName: cleanSessionText(summary?.modelName),
    contextLength: Number.isFinite(summary?.contextLength) && summary.contextLength > 0
      ? summary.contextLength
      : null,
    compressRatio: Number.isFinite(summary?.compressRatio) && summary.compressRatio > 0
      ? summary.compressRatio
      : 80,
    sidebarMetaVersion: SIDEBAR_SESSION_META_VERSION,
  };
}

function sessionChangedDuringSidebarMigration(before, current) {
  if (!before || !current) return true;
  return before.updatedAt !== current.updatedAt
    || before.fileMtimeMs !== current.fileMtimeMs
    || before.fileSize !== current.fileSize
    || before.title !== current.title
    || before.archived !== current.archived
    || before.todo !== current.todo
    || before.hasSummary !== current.hasSummary;
}

async function migrateSidebarSessionReadModel(agentId, initialIndex) {
  const summaryMap = await buildSessionSummaryMap(agentId);
  const modelInfoMap = await buildSessionModelInfoMap(agentId);
  const sourceRecords = new Map(initialIndex.sessions.map((record) => [record.id, record]));
  const richSessions = await Promise.all(initialIndex.sessions.map((record) =>
    summarizePrebuiltSession(agentId, record, summaryMap, modelInfoMap)));
  const richById = new Map(richSessions.map((session) => [session.id, session]));
  const migrationCandidates = initialIndex.sessions.map((record) => ({
    ...record,
    ...buildSidebarSessionMigrationPatch(richById.get(record.id), summaryMap.has(record.id), record),
  }));
  const compatibility = compareSidebarSessionReadModels(
    migrationCandidates.map((record) => buildLightPrebuiltSessionRecord(agentId, record)),
    richSessions,
  );
  if (
    compatibility.missingCount > 0
    || compatibility.extraCount > 0
    || compatibility.mismatchedSessionCount > 0
  ) {
    const error = new Error('Sidebar session migration failed compatibility validation');
    error.code = 'sidebar_read_model_mismatch';
    throw error;
  }

  return updateSessionIndex(agentId, (current) => {
    let changed = false;
    const sessions = current.sessions.map((record) => {
      if (isSidebarSessionReadModelReady(record)) return record;
      const sourceRecord = sourceRecords.get(record.id);
      const rich = richById.get(record.id);
      // A runtime/title/archive mutation may race the one-time migration. Do
      // not overwrite fresher state; the guarded production path will use the
      // rich fallback for this request and retry migration on the next read.
      if (!rich || sessionChangedDuringSidebarMigration(sourceRecord, record)) return record;
      changed = true;
      return {
        ...record,
        ...buildSidebarSessionMigrationPatch(rich, summaryMap.has(record.id), record),
      };
    });
    return changed ? { ...current, sessions } : current;
  });
}

async function listPrebuiltSessionsFromIndex(agentId, options = {}) {
  const startedAt = Date.now();
  let index = await readSessionIndex(agentId);
  const indexLoadedAt = Date.now();
  let migratedCount = 0;
  const incompleteCount = index.sessions.filter((record) => !isSidebarSessionReadModelReady(record)).length;
  if (incompleteCount > 0) {
    index = await migrateSidebarSessionReadModel(agentId, index);
    migratedCount = incompleteCount;
  }
  const remainingIncomplete = index.sessions.filter((record) => !isSidebarSessionReadModelReady(record));
  if (remainingIncomplete.length > 0) {
    const error = new Error('Sidebar session read model is incomplete');
    error.code = 'sidebar_read_model_incomplete';
    throw error;
  }

  const readModelStartedAt = Date.now();
  const sessions = sortSidebarSessions(index.sessions.map((record) =>
    buildLightPrebuiltSessionRecord(agentId, record)));
  const defaultModelInfo = options.includeModelDefaults === false
    ? null
    : await resolveSessionModelInfo(agentId, 'default');
  const readModelMs = Date.now() - readModelStartedAt;
  if (options.recordDiagnostics !== false) {
    void recordSidebarDiagnosticEvent({
      kind: 'list_perf',
      operation: 'list_sessions_index',
      phase: 'completed',
      agentId: String(agentId || '').slice(0, 128),
      sessionCount: sessions.length,
      writebackCount: migratedCount,
      indexMs: indexLoadedAt - startedAt,
      handoffMs: 0,
      sessionsMs: 0,
      readModelMs,
      totalMs: Date.now() - startedAt,
      lightCount: sessions.length,
      result: 'success',
    }, { source: 'server' });
  }
  return {
    revision: Number(index.revision) || 0,
    activeSessionId: index.activeSessionId || (sessions[0]?.id ?? null),
    ...(defaultModelInfo ? {
      contextLength: defaultModelInfo.contextLength || null,
      compressRatio: defaultModelInfo.compressRatio || 80,
    } : {}),
    sessions,
  };
}

async function listPrebuiltSessions(agentId, options = {}) {
  const useIndexReadModel = sanitizeSessionFragment(agentId) === 'programming-helper'
    && options.forceRich !== true;
  if (!useIndexReadModel) return listPrebuiltSessionsRich(agentId);
  const retryAfter = Number(sidebarReadModelRetryAfter.get(agentId)) || 0;
  if (retryAfter > Date.now()) return listPrebuiltSessionsRich(agentId);
  try {
    const result = await listPrebuiltSessionsFromIndex(agentId, options);
    sidebarReadModelRetryAfter.delete(agentId);
    return result;
  } catch (error) {
    // A corrupt legacy record or a concurrent write must not make every
    // connected-agents poll repeat both migration and rich fallback work.
    // No timer is retained; the next request after the bounded window retries.
    sidebarReadModelRetryAfter.set(agentId, Date.now() + 30_000);
    void recordSidebarDiagnosticEvent({
      kind: 'list_perf',
      operation: 'list_sessions_index',
      phase: 'fallback',
      agentId: String(agentId || '').slice(0, 128),
      result: 'degraded',
      errorCode: error?.code || 'sidebar_read_model_failed',
    }, { source: 'server' });
    return listPrebuiltSessionsRich(agentId);
  }
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
    await normalizePathCasing(
      requestedFormId === 'assembly-form'
        ? nextAssemblyEnvDir
        : (
          cleanSessionText(options.openDirectory)
          || cleanSessionText(sourceSession?.openDirectory)
          || cleanSessionText(currentState?.openDirectory)
        )
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
  const nextProjectName =
    cleanSessionText(options.projectName)
    || cleanSessionText(sourceSession?.projectName);
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
    : (normalizedAgentId === 'agent-studio' ? (nextProjectName || nextGoal) : (normalizedAgentId === 'programming-helper' ? '' : nextFeatureName));
  const explicitTitle = cleanSessionText(options.title);
  const nextTitle = explicitTitle || nextTaskTitle || (isProgrammingHelper
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
    projectName: nextProjectName,
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
    archived: false,
    todo: false,
    hasSummary: false,
    messageCount: 0,
    preview: '',
    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    sidebarMetaVersion: SIDEBAR_SESSION_META_VERSION,
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
  } else if (normalizedAgentId === 'agent-studio') {
    const openDirectory = nextOpenDirectory || cleanSessionText(currentState.openDirectory);
    await writeWorkspaceState(agentId, {
      forms: currentState.forms,
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
  } else if (sanitizeSessionFragment(agentId) === 'agent-studio') {
    const currentState = await readWorkspaceState(agentId);
    const openDirectory = cleanSessionText(existing.openDirectory) || cleanSessionText(currentState.openDirectory);
    await writeWorkspaceState(agentId, {
      forms: currentState.forms,
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

function getSessionRecencyValue(session) {
  return String(session?.updatedAt || session?.createdAt || '');
}

function selectFallbackSession(agentId, sessions, sourceSession) {
  const candidates = sessions.filter((session) => (
    session?.archived !== true
    && session?.sessionType !== 'exploration'
    && session?.sessionType !== 'sub'
  ));
  if (sanitizeSessionFragment(agentId) === 'programming-helper') {
    const sourceDirectory = String(sourceSession?.openDirectory || '').trim().replace(/\\/g, '/').toLowerCase();
    if (!sourceDirectory) return null;
    candidates.splice(0, candidates.length, ...candidates.filter((session) => (
      String(session?.openDirectory || '').trim().replace(/\\/g, '/').toLowerCase() === sourceDirectory
    )));
  }
  return candidates.sort((left, right) => (
    getSessionRecencyValue(right).localeCompare(getSessionRecencyValue(left))
    || String(right?.id || '').localeCompare(String(left?.id || ''))
  ))[0] || null;
}

async function deletePrebuiltSession(agentId, sessionId, options = {}) {
  const newIndex = await updateSessionIndex(agentId, (index) => {
    const existing = index.sessions.find((session) => session.id === sessionId);
    if (!existing) {
      const error = new Error(`Unknown prebuilt session: ${sessionId}`);
      error.statusCode = 404;
      throw error;
    }

    const wasActiveSession = index.activeSessionId === sessionId;
    const remainingSessions = index.sessions.filter((session) => session.id !== sessionId);
    const nextActiveSessionId = wasActiveSession
      ? (selectFallbackSession(agentId, remainingSessions, existing)?.id ?? null)
      : index.activeSessionId;
    return { activeSessionId: nextActiveSessionId, sessions: remainingSessions, wasActiveSession };
  });

  await fs.rm(getPrebuiltSessionFilePath(agentId, sessionId), { force: true }).catch(e => console.warn(e));
  invalidateSearchIndex(agentId);
  // Remove from open-sessions tracker
  removeOpenSession(agentId, sessionId).catch(e => console.warn(e));

  const result = {
    protocolVersion: 2,
    deletedSessionId: sessionId,
    wasActiveSession: newIndex.wasActiveSession === true,
    activeSessionId: newIndex.activeSessionId,
    revision: Number(newIndex.revision) || 0,
    sessionDelta: {
      revision: Number(newIndex.revision) || 0,
      activeSessionId: newIndex.activeSessionId,
      upsert: [],
      remove: [sessionId],
    },
  };
  if (options.includeSessions !== false) {
    result.sessions = await listPrebuiltSessions(agentId);
  }
  return result;
}

async function archivePrebuiltSession(agentId, sessionId, archived, options = {}) {
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
    const activeSessionId = archived && index.activeSessionId === sessionId
      ? (selectFallbackSession(agentId, sessions, existing)?.id ?? null)
      : index.activeSessionId;
    return { activeSessionId, sessions };
  });

  const updatedSession = newIndex.sessions.find((session) => session.id === sessionId) || null;
  const result = {
    protocolVersion: 2,
    archivedSessionId: sessionId,
    archived: !!archived,
    activeSessionId: newIndex.activeSessionId,
    revision: Number(newIndex.revision) || 0,
    sessionDelta: {
      revision: Number(newIndex.revision) || 0,
      activeSessionId: newIndex.activeSessionId,
      upsert: updatedSession ? [updatedSession] : [],
      remove: [],
    },
  };
  if (options.includeSessions !== false) {
    result.sessions = await listPrebuiltSessions(agentId);
  }
  return result;
}

async function tagPrebuiltSessionTodo(agentId, sessionId, todo, options = {}) {
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

  const updatedSession = newIndex.sessions.find((session) => session.id === sessionId) || null;
  const result = {
    protocolVersion: 2,
    todoSessionId: sessionId,
    todo: !!todo,
    activeSessionId: newIndex.activeSessionId,
    revision: Number(newIndex.revision) || 0,
    sessionDelta: {
      revision: Number(newIndex.revision) || 0,
      activeSessionId: newIndex.activeSessionId,
      upsert: updatedSession ? [updatedSession] : [],
      remove: [],
    },
  };
  if (options.includeSessions !== false) {
    result.sessions = await listPrebuiltSessions(agentId);
  }
  return result;
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

async function deletePrebuiltProject(agentId, projectId, options = {}) {
  const normalizedAgentId = sanitizeSessionFragment(agentId);
  if (!isWorkspaceSessionAgent(normalizedAgentId)) {
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
  const newIndex = await updateSessionIndex(agentId, (index) => {
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
    await fs.rm(getPrebuiltSessionFilePath(agentId, session.id), { force: true }).catch(e => console.warn(e));
  }
  if (sessionsToDelete.length > 0) {
    invalidateSearchIndex(agentId);
  }

  const result = {
    protocolVersion: 2,
    deletedProjectId: projectId,
    deletedSessionIds: sessionsToDelete.map((s) => s.id),
    activeSessionId: nextActiveSessionId,
    revision: Number(newIndex.revision) || 0,
    sessionDelta: {
      revision: Number(newIndex.revision) || 0,
      activeSessionId: nextActiveSessionId,
      upsert: [],
      remove: sessionsToDelete.map((session) => session.id),
    },
  };
  if (options.includeSessions !== false) {
    result.sessions = await listPrebuiltSessions(agentId);
  }
  return result;
}


async function resolveContextLength(agentId) {
  const info = await resolveSessionModelInfo(agentId, 'default');
  return info.contextLength;
}

  const handoffHelpers = createSessionHandoffHelpers({
    startManagedAgent,
    waitForManagedRuntimeReady,
    resolvePrebuiltSessionOwner,
    requirePrebuiltSessionRecord,
    summarizePrebuiltSession,
    requirePrebuiltAgentForRuntime,
    createPrebuiltSession,
    readSessionSnapshotForContinuity,
    setSessionHasSummary,
  });

  return {
    buildFeatureSessionTitle,
    buildNamedSessionTitle,
    getNextNewSessionTitle,
    checkSessionHasSummary,
    buildSessionSummaryMap,
    setSessionHasSummary,
    buildLightPrebuiltSessionRecord,
    findSessionSummary,
    findSessionSummaryPath,
    extractToolCallLabel,
    buildSessionTrimPreview,
    estimatePreambleCharCount,
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
    ...handoffHelpers,
    deletePrebuiltProject,
    resolveContextLength,
    extractDomainsFromText,
  };
}
