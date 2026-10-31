import path from 'path';
import { promises as fs } from 'fs';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

import { USER_DATA_ROOT, AGENTS_ROOT, PH_STYLE_WORKSPACE_AGENT_IDS } from '../shared/constants.js';
import { normalizePathCasing } from '../shared/fs-helpers.js';
import {
  sanitizeSessionFragment, cleanSessionText, isWorkspaceSessionAgent,
  getAssemblyWorkspaceDir, normalizeClientAgentId, log,
} from '../shared/string-helpers.js';
import {
  readSessionIndex, readSessionIndexShared, querySessionIndexPage, updateSessionIndex,
  getPrebuiltSessionFilePath,
  normalizeSessionMetadata, buildSessionTitle, computeNextSessionNumber,
  findPrebuiltSessionRecordShared,
} from '../shared/session-access.js';
import { getAgentRuntime, isManagedRuntimeRunning } from '../shared/agent-access.js';
import { readThreadMembership } from '../shared/thread-membership.js';
import { resolveSessionModelInfo } from './model-config.js';
import { removeOpenSession } from '../shared/open-sessions-tracker.js';
import { createSessionHandoffHelpers } from './session-handoff-helpers.js';
import { recordSidebarDiagnosticEvent } from '../shared/sidebar-diagnostics.js';
import { resolveNewSessionAgent } from '../shared/workspace-agents.js';
import { getPhProject, getPhSessionGateInfo } from './ph-projects.js';
import { getSessionProjectId } from '../shared/session-project.js';

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
  buildSessionTrimMessagePreview,
  estimatePreambleCharCount,
  buildLightPrebuiltSessionRecord,
  buildSessionDirectoryEntries,
  compareSidebarSessionReadModels,
  SIDEBAR_SESSION_META_VERSION,
  isSidebarSessionReadModelReady,
  sortSidebarSessions,
  trimSessionRecordForWire,
  sliceSessionsForWire,
  cleanStudioFeatureIds,
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
  buildSessionTrimMessagePreview,
  estimatePreambleCharCount,
  buildLightPrebuiltSessionRecord,
  buildSessionDirectoryEntries,
  compareSidebarSessionReadModels,
  SIDEBAR_SESSION_META_VERSION,
  isSidebarSessionReadModelReady,
  sortSidebarSessions,
  trimSessionRecordForWire,
  sliceSessionsForWire,
  cleanStudioFeatureIds,
};

// 归档/删除 active 会话后的后继选择。无 ctx 依赖，提为模块级纯函数以便单测。
function getSessionRecencyValue(session) {
  return String(session?.updatedAt || session?.createdAt || '');
}

export function selectFallbackSession(agentId, sessions, sourceSession) {
  const candidates = sessions.filter((session) => (
    session?.archived !== true
  ));
  if (PH_STYLE_WORKSPACE_AGENT_IDS.has(sanitizeSessionFragment(agentId))) {
    // 归属优先于目录（ticket 044）：回选只在来源会话自己的集合内进行——
    // 项目会话回选同项目运行中会话，目录会话回选同目录且非项目的运行中
    // 会话；绝不让删除/归档 A 内会话回选到 D 或 B（同路径也不行）。
    const sourceProjectId = cleanSessionText(sourceSession?.projectId);
    if (sourceProjectId) {
      candidates.splice(0, candidates.length, ...candidates.filter((session) => (
        cleanSessionText(session?.projectId) === sourceProjectId
        && isManagedRuntimeRunning(getAgentRuntime(agentId, session.id))
      )));
    } else {
      const sourceDirectory = String(sourceSession?.openDirectory || '').trim().replace(/\\/g, '/').toLowerCase();
      if (!sourceDirectory) return null;
      // PH 后继只选仍在运行的会话：目录下再无运行中会话时回退 null，
      // 归档/删除路由据此跳过 startManagedAgent，而不是复活已停止的会话。
      candidates.splice(0, candidates.length, ...candidates.filter((session) => (
        !cleanSessionText(session?.projectId)
        && String(session?.openDirectory || '').trim().replace(/\\/g, '/').toLowerCase() === sourceDirectory
        && isManagedRuntimeRunning(getAgentRuntime(agentId, session.id))
      )));
    }
  }
  return candidates.sort((left, right) => (
    getSessionRecencyValue(right).localeCompare(getSessionRecencyValue(left))
    || String(right?.id || '').localeCompare(String(left?.id || ''))
  ))[0] || null;
}

export function createSessionHelpers(ctx) {
  const {
    readWorkspaceState,
    writeWorkspaceState,
    discoverAgents,
    enrichAgent,
    startManagedAgent,
    waitForManagedRuntimeReady,
    // 启动期空会话清理的线程守卫：cleanup 直接删文件，不经 delete
    // 路由——head 会话属于某活跃线程时不能单独删除；删除服务会明确拒绝，
    // 避免线程失去 head 后成为孤儿。
    assertSessionDeletable = null,
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

async function getNextNewSessionTitle(agentId, openDirectory, projectId = '') {
  const index = await readSessionIndexShared(agentId);
  return `新对话${computeNextSessionNumber(index.sessions, openDirectory, { projectId })}`;
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
  const isPhStyleWorkspace = PH_STYLE_WORKSPACE_AGENT_IDS.has(normalizedAgentId);
  const formId = cleanSessionText(record.formId) || (isPhStyleWorkspace ? '' : 'startup-form');
  const sourceForm = workspaceState?.forms?.[formId] || {};
  const startupForm = isPhStyleWorkspace ? {} : (workspaceState?.forms?.['startup-form'] || {});
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
    : (isPhStyleWorkspace ? taskTitle : (normalizedAgentId === 'agent-studio' ? (projectName || goal) : featureName));
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
      const sTypeFP = cleanSessionText(record.sessionType) || 'main';
      const effectiveMap = (modelInfoMap && modelInfoMap.default)
        ? modelInfoMap
        : { ...(modelInfoMap || {}), default: await resolveSessionModelInfo(agentId) };
      const sessionModelInfo = resolveSessionModelFromRecord(record, effectiveMap);
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
        workspaceAgentId: record.workspaceAgentId || 'main',
        projectId: cleanSessionText(record.projectId),
        sessionType: sTypeFP,
        status: cleanSessionText(record.status),
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
    const fallbackModelInfo = (modelInfoMap && modelInfoMap.default)
      || await resolveSessionModelInfo(agentId);
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
      workspaceAgentId: record.workspaceAgentId || 'main',
      projectId: cleanSessionText(record.projectId),
      sessionType: cleanSessionText(record.sessionType) || 'main',
      status: cleanSessionText(record.status),
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
      workspaceAgentId: record.workspaceAgentId || 'main',
      projectId: cleanSessionText(record.projectId),
      sessionType: cleanSessionText(record.sessionType) || 'main',
      status: cleanSessionText(record.status),
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

  const candidates = selectEmptySessions(index.sessions, sessionMessageCounts);
  if (candidates.length === 0) return 0;
  const toDelete = [];
  for (const id of candidates) {
    if (!assertSessionDeletable) {
      toDelete.push(id);
      continue;
    }
    try {
      await assertSessionDeletable(agentId, id);
      toDelete.push(id);
    } catch (error) {
      console.warn(`[sessions] session deletion guard failed for ${id}:`, error?.message || error);
    }
  }
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

async function listPrebuiltSessionsRich(agentId, options = {}) {
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
  // 降级读模型的响应面与索引读模型保持同一 wire 口径（coder 排除、分页切片、
  // 字段裁剪）：30s 降级窗口内分页请求若返回全量富列表，前端会看到 coder 混入
  // 与计数漂移。activeSessionId 取过滤前的 sessions[0]（active 会话与列表
  // 过滤无关）。成员表读取一次复用（同文件版本同引用）。
  const membership = await readThreadMembership(agentId);
  const richPageOptions = {
    projectDir: options.sessionProjectDir,
    projectId: options.sessionProjectId,
    query: options.sessionQuery,
    archived: options.sessionArchived,
    offset: options.sessionOffset,
    limit: options.sessionLimit,
    // ADR-0032 列表口径：计数/切片按线程归档状态，历史代成员不进入
    threadMembership: membership,
  };
  const richPageActive = options.sessionProjectDir !== undefined
    || options.sessionProjectId !== undefined
    || options.sessionQuery !== undefined
    || options.sessionArchived !== undefined
    || options.sessionOffset !== undefined
    || options.sessionLimit !== undefined
    ;
  let wireSessions = sessions;
  let richPageMeta = {};
  if (richPageActive) {
    const page = sliceSessionsForWire(sessions, richPageOptions);
    wireSessions = page.slice;
    richPageMeta = {
      sessionTotal: page.total,
      sessionOffset: page.offset,
      sessionHasMore: page.offset + page.slice.length < page.total,
      sessionProjectDir: String(options.sessionProjectDir || '') || null,
      sessionProjectId: cleanSessionText(options.sessionProjectId) || null,
      mainTotal: page.mainTotal,
      archivedTotal: page.archivedTotal,
    };
  }
  if (options.wireTrim === true) {
    wireSessions = wireSessions.map(trimSessionRecordForWire);
    if (!richPageActive) {
      const counts = sliceSessionsForWire(sessions, {
        threadMembership: membership,
      });
      richPageMeta = { mainTotal: counts.mainTotal, archivedTotal: counts.archivedTotal };
    }
  }
  return {
    revision: Number(index.revision) || 0,
    activeSessionId: index.activeSessionId || (sessions[0]?.id ?? null),
    contextLength: defaultModelInfo.contextLength || null,
    compressRatio: defaultModelInfo.compressRatio || 80,
    ...richPageMeta,
    sessions: wireSessions,
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

// 侧栏投影缓存：PH 索引可达数千会话，秒级轮询（get_connected_agents 与
// prebuilt_sessions 条件刷新）每次重复「全量 buildLight + 排序」是主线程
// CPU 停顿的主要来源之一（服务进程实测 readModelMs p50 134ms，单轮 ga 主
// 线程 CPU 达数百 ms，且直接拖慢同进程创建请求的索引提交段）。以共享索引
// 对象与共享线程成员表对象的身份作键（WeakMap，与 _sessionRecordMaps 同
// 构）：任一文件变化 → readSessionIndexShared / readThreadMembership 返回
// 新对象 → 缓存条目自然失效并被回收，无显式版本管理。
//
// 契约：projection.sessions 与本函数返回值共享（wireTrim / 分页未激活时
// 原样透出），调用方只读，不得修改（readSessionIndexShared 同款契约）。
const _sidebarProjectionCache = new WeakMap(); // index → Map<membership, projection>

async function listPrebuiltSessionsFromIndex(agentId, options = {}) {
  const startedAt = Date.now();
  let index = await readSessionIndexShared(agentId);
  const indexLoadedAt = Date.now();
  let migratedCount = 0;
  const incompleteCount = index.sessions.filter((record) => !isSidebarSessionReadModelReady(record)).length;
  if (incompleteCount > 0) {
    // 迁移入参为共享只读索引（migrateSidebarSessionReadModel 只读消费，写回
    // 经 updateSessionIndex 自行克隆），返回独立对象；迁移路径的投影不进缓
    // 存——写回后文件版本变化，下一轮共享读取自然以新身份重建。
    index = await migrateSidebarSessionReadModel(agentId, index);
    migratedCount = incompleteCount;
    const remainingIncomplete = index.sessions.filter((record) => !isSidebarSessionReadModelReady(record));
    if (remainingIncomplete.length > 0) {
      const error = new Error('Sidebar session read model is incomplete');
      error.code = 'sidebar_read_model_incomplete';
      throw error;
    }
  }

  const readModelStartedAt = Date.now();
  // activeSessionId 回退链保持旧语义：索引声明值 → （分页路径）db meta →
  // 按 updated_at 排序的最新会话。index.sessions[0] 是 position 顺序（插入序），
  // 不是旧实现的排序口径，不能进入回退链。
  let activeSessionId = index.activeSessionId || null;
  let pageRevision = null;
  const pageActive = options.sessionProjectDir !== undefined
    || options.sessionProjectId !== undefined
    || options.sessionId !== undefined
    || options.sessionQuery !== undefined
    || options.sessionArchived !== undefined
    || options.sessionOffset !== undefined
    || options.sessionLimit !== undefined;
  const membership = await readThreadMembership(agentId);
  let sessions = [];
  if (!pageActive) {
    // 全量投影只供未分页的内部消费；分页列表由 SQLite 直接返回当前页，
    // 避免查询下推后仍在 JS 全量 buildLight + sort。
    let byMembership = migratedCount > 0 ? null : _sidebarProjectionCache.get(index);
    if (!byMembership && migratedCount === 0) {
      byMembership = new Map();
      _sidebarProjectionCache.set(index, byMembership);
    }
    let projection = byMembership && byMembership.get(membership);
    if (!projection) {
      projection = {
        revision: Number(index.revision) || 0,
        sessions: sortSidebarSessions(index.sessions.map((record) =>
          buildLightPrebuiltSessionRecord(agentId, record))),
      };
      if (byMembership) {
        byMembership.clear();
        byMembership.set(membership, projection);
      }
    }
    sessions = projection.sessions;
  }
  const defaultModelInfo = options.includeModelDefaults === false
    ? null
    : await resolveSessionModelInfo(agentId);
  const readModelMs = Date.now() - readModelStartedAt;

  // Wire 投影：分页（projectDir/query/archived/offset/limit 任一提供即激活）
  // 与字段裁剪（wireTrim）。分页激活时 sessions 为切片并携带 total/hasMore
  // 元信息；裁剪只在响应面发生，内部消费（active 会话解析等）使用上面的
  // 完整投影。
  const pageOptions = {
    projectDir: options.sessionProjectDir,
    projectId: options.sessionProjectId,
    sessionId: cleanSessionText(options.sessionId),
    query: options.sessionQuery,
    archived: options.sessionArchived,
    offset: options.sessionOffset,
    limit: options.sessionLimit,
    // ADR-0032 列表口径：一行 = 一段对话，历史代成员不进入切片与计数、head
    // 按线程归档状态分桶。PH 的列表请求走本函数（索引读模型），rich 降级路径
    // 早已接入同一口径——此处漏接会让历史代成员以普通会话行返回，「我的对话」
    // 混入 900+ 条只该经「历史 · N」入口到达的旧代记录，分页键位与计数同步
    // 失真（实测 2116 vs 应有的 1717）。成员表复用上方已读取的共享实例
    // （同文件版本同引用），不二次读取。
    threadMembership: membership,
  };
  let wireSessions = sessions;
  let pageMeta = {};
  if (pageActive) {
    const page = await querySessionIndexPage(agentId, {
      projectDir: pageOptions.projectDir,
      projectId: pageOptions.projectId,
      query: pageOptions.query,
      archived: pageOptions.archived,
      offset: pageOptions.offset,
      limit: pageOptions.limit,
      sessionId: pageOptions.sessionId,
      threadMembership: membership,
    });
    if (!activeSessionId) activeSessionId = page.activeSessionId || page.fallbackActiveSessionId || null;
    pageRevision = page.revision;
    wireSessions = page.slice.map((entry) => ({
      ...buildLightPrebuiltSessionRecord(agentId, entry.record),
      archived: entry.archived,
    }));
    pageMeta = {
      sessionTotal: page.total,
      sessionOffset: page.offset,
      sessionHasMore: page.offset + page.slice.length < page.total,
      sessionProjectDir: String(options.sessionProjectDir || '') || null,
      sessionProjectId: cleanSessionText(options.sessionProjectId) || null,
      mainTotal: page.mainTotal,
      archivedTotal: page.archivedTotal,
    };
  }
  if (options.wireTrim === true) {
    wireSessions = wireSessions.map(trimSessionRecordForWire);
    if (!pageActive) {
      const counts = sliceSessionsForWire(sessions, {
        threadMembership: membership,
      });
      pageMeta = { mainTotal: counts.mainTotal, archivedTotal: counts.archivedTotal };
    }
  }

  if (options.recordDiagnostics !== false) {
    void recordSidebarDiagnosticEvent({
      kind: 'list_perf',
      operation: 'list_sessions_index',
      phase: 'completed',
      agentId: String(agentId || '').slice(0, 128),
      sessionCount: wireSessions.length,
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
    revision: pageActive && typeof pageRevision === 'number' ? pageRevision : (Number(index.revision) || 0),
    activeSessionId: activeSessionId || sessions[0]?.id || null,
    ...(defaultModelInfo ? {
      contextLength: defaultModelInfo.contextLength || null,
      compressRatio: defaultModelInfo.compressRatio || 80,
    } : {}),
    ...pageMeta,
    sessions: wireSessions,
  };
}

async function listPrebuiltSessions(agentId, options = {}) {
  const useIndexReadModel = PH_STYLE_WORKSPACE_AGENT_IDS.has(sanitizeSessionFragment(agentId))
    && options.forceRich !== true;
  if (!useIndexReadModel) return listPrebuiltSessionsRich(agentId, options);
  const retryAfter = Number(sidebarReadModelRetryAfter.get(agentId)) || 0;
  if (retryAfter > Date.now()) return listPrebuiltSessionsRich(agentId, options);
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
    return listPrebuiltSessionsRich(agentId, options);
  }
}

async function buildSessionModelInfoMap(agentId) {
  const map = { default: await resolveSessionModelInfo(agentId) };
  return map;
}

async function createPrebuiltSession(agentId, options = {}) {
  const normalizedAgentId = sanitizeSessionFragment(agentId);
  const sessionMetadata = normalizeSessionMetadata(options.metadata);
  const currentState = isWorkspaceSessionAgent(agentId)
    ? await readWorkspaceState(agentId)
    : null;
  const isPhStyleWorkspace = PH_STYLE_WORKSPACE_AGENT_IDS.has(normalizedAgentId);
  const requestedFormId = cleanSessionText(options.formId) || (isPhStyleWorkspace ? '' : 'startup-form');
  const startupForm = isPhStyleWorkspace ? {} : (currentState?.forms?.['startup-form'] || {});
  const sourceForm = currentState?.forms?.[requestedFormId] || startupForm;
  const sourceSessionId = cleanSessionText(options.sourceSessionId);
  // 普通创建无需预读索引：标题编号在 updateSessionIndex 锁内基于最新记录
  // 分配。只有派生创建需要读取来源记录，且使用共享只读快照避免深克隆。
  const sourceSession = sourceSessionId
    ? (await readSessionIndexShared(agentId)).sessions.find((session) => session.id === sourceSessionId) || null
    : null;
  const workspace = (await discoverAgents(AGENTS_ROOT)).find((entry) => entry.id === agentId);
  if (!workspace) throw Object.assign(new Error(`Unknown workspace: ${agentId}`), { statusCode: 404 });
  if (sourceSessionId && !sourceSession) {
    throw Object.assign(new Error(`Unknown source session: ${sourceSessionId}`), { statusCode: 404 });
  }
  // PH 归属释放窗口（项目改绑 / 会话归属转移）内拒绝派生：来源会话的归属
  // 正在被改写，此刻派生会按旧归属落盘、随即与来源分叉成不一致的兄弟。
  if (sourceSessionId) {
    const sourceOwnershipGate = getPhSessionGateInfo(sourceSessionId);
    if (sourceOwnershipGate) {
      throw Object.assign(new Error(sourceOwnershipGate.message), {
        statusCode: 409,
        code: sourceOwnershipGate.code,
      });
    }
  }
  const workspaceAgentId = resolveNewSessionAgent(workspace, options, sourceSession);
  // ── PH 项目归属（ticket 042）──────────────────────────────────────────
  // 显式 projectId 仅 PH 接受；无参数保持目录语义（不查找同路径项目）；
  // 派生会话（sourceSessionId）继承来源索引的归属，显式传入与来源不一致时
  // 报错——与 workspaceAgentId 的"A derived session must retain its source
  // Agent"同构，当前页面/工作空间选择不能覆盖来源归属。
  const requestedProjectId = cleanSessionText(options.projectId);
  if (requestedProjectId && normalizedAgentId !== 'programming-helper') {
    throw Object.assign(
      new Error(`projectId is only supported for programming-helper sessions: ${normalizedAgentId}`),
      { statusCode: 400 },
    );
  }
  const inheritedProjectId = getSessionProjectId(sourceSession);
  if (requestedProjectId && sourceSession && requestedProjectId !== inheritedProjectId) {
    throw Object.assign(
      new Error('A derived session must retain its source project'),
      { statusCode: 400 },
    );
  }
  const nextProjectId = requestedProjectId || inheritedProjectId;
  // 项目会话的运行/记录目录来自项目表当前记录；显式项目身份无效或未知直接
  // 报错（400/404/500 由 getPhProject 语义决定），不退回目录路径。
  const projectWorkDirectory = nextProjectId
    ? (await getPhProject(nextProjectId)).workDirectory
    : '';
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
      // 项目会话（显式或派生继承）：目录以项目表当前记录为权威，
      // options.openDirectory / 来源旧记录 / 工作空间当前目录都不参与。
      nextProjectId
        ? projectWorkDirectory
        : (requestedFormId === 'assembly-form'
          ? nextAssemblyEnvDir
          : (
            cleanSessionText(options.openDirectory)
            || cleanSessionText(sourceSession?.openDirectory)
            || (normalizedAgentId === 'agent-studio' ? '' : cleanSessionText(currentState?.openDirectory))
          ))
    );
  if (normalizedAgentId === 'agent-studio') {
    if (!nextOpenDirectory || !path.isAbsolute(nextOpenDirectory)) {
      throw new Error('Agent Studio 需要先选择项目目录。');
    }
    const directory = await fs.stat(nextOpenDirectory).catch(() => null);
    if (!directory?.isDirectory()) {
      throw new Error(`Agent Studio 项目目录不存在或不是文件夹：${nextOpenDirectory}`);
    }
  }
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
    : (normalizedAgentId === 'agent-studio' ? (nextProjectName || nextGoal) : (isPhStyleWorkspace ? '' : nextFeatureName));
  const explicitTitle = cleanSessionText(options.title);
  const needsSequentialTitle = !explicitTitle && !nextTaskTitle && isPhStyleWorkspace;
  const nextTitle = explicitTitle || nextTaskTitle || (isPhStyleWorkspace
    ? ''
    : buildNamedSessionTitle(sessionDisplayName, createdAt));
  // 派生会话默认继承来源会话的身份；只有没有来源时才创建 main。
  // 这样 compact/summary 等 successor 路径即使未重复传参，也不会把 coder
  // 静默降级成普通用户会话。
  const sessionType = cleanSessionText(options.sessionType)
    || cleanSessionText(sourceSession?.sessionType)
    || 'main';
  const currentModelInfo = await resolveSessionModelInfo(agentId);

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
    // PH 项目归属（ticket 042）：仅项目会话落盘该字段，目录会话不带非空
    // projectId（旧记录无此字段 = 目录会话，读取时归一为 ''）。
    ...(nextProjectId ? { projectId: nextProjectId } : {}),
    sessionType,
    workspaceAgentId,
    metadata: {
      ...sessionMetadata,
      // 会话 ↔ feature 绑定（ADR-0022）：创建参数直传 + 派生会话继承来源绑定。
      ...(normalizedAgentId === 'agent-studio'
        ? {
          studioFeatureIds: cleanStudioFeatureIds([
            ...(Array.isArray(options.studioFeatureIds) ? options.studioFeatureIds : []),
            ...(Array.isArray(sourceSession?.metadata?.studioFeatureIds) ? sourceSession.metadata.studioFeatureIds : []),
            ...(Array.isArray(sourceSession?.studioFeatureIds) ? sourceSession.studioFeatureIds : []),
          ]),
        }
        : {}),
    },
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
    // 在写锁内使用最新索引分配编号，复用事务本来就要读取的快照；并发创建
    // 会串行观察前一条记录，避免重复编号，也不需要创建前额外读一次索引。
    if (needsSequentialTitle) {
      record.title = `新对话${computeNextSessionNumber(index.sessions, nextOpenDirectory, { projectId: nextProjectId })}`;
    }
    return {
      activeSessionId: sessionId,
      sessions: [record, ...index.sessions.filter((session) => session.id !== sessionId)],
    };
  }, { skipContentComparison: true });
  // updateSessionIndex 返回的 index 已含推进后的 revision；透传给调用方，
  // 省去路由层随后的 readSessionIndex 重复读取。
  const committedRevision = Number(nextIndex.revision) || 0;

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
    // ADR-0022：不再把 openDirectory 写进 workspace state——那是跨会话共享的
    // 最近目录，任何一次会话创建都会改写它，制造目录漂移。会话目录以会话
    // 自身 openDirectory 为唯一权威（创建时显式指定或继承来源会话）。
  } else if (normalizedAgentId === 'programming-helper') {
    // 项目会话不触碰 workspace state：openDirectory 是目录对话的当前选择，
    // 项目路径由项目表权威持有，不得借会话创建写回旧目录状态（041 契约）。
    if (!nextProjectId) {
      const openDirectory = nextOpenDirectory || cleanSessionText(currentState.openDirectory);
      const cleanedForms = { ...currentState.forms };
      delete cleanedForms['startup-form'];
      await writeWorkspaceState(agentId, {
        forms: cleanedForms,
        openDirectory,
      });
    }
  }

  if (options.returnSummary === false) {
    return Object.assign(buildLightPrebuiltSessionRecord(agentId, record), { indexRevision: committedRevision });
  }
  return Object.assign(await summarizePrebuiltSession(agentId, record), { indexRevision: committedRevision });
}

async function activatePrebuiltSession(agentId, sessionId, options = {}) {
  const updatedIndex = await updateSessionIndex(agentId, (index) => {
    const session = index.sessions.find((s) => s.id === sessionId);
    if (!session) {
      const error = new Error(`Unknown prebuilt session: ${sessionId}`);
      error.statusCode = 404;
      throw error;
    }
    return { ...index, activeSessionId: sessionId };
  });

  const existing = updatedIndex.sessions.find((s) => s.id === sessionId);

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
  } else if (PH_STYLE_WORKSPACE_AGENT_IDS.has(sanitizeSessionFragment(agentId))) {
    // 项目会话（ticket 042）：Session 保存的旧目录记录不得写回目录选择——
    // openDirectory state 是目录对话的当前选择，项目目录由项目表权威持有。
    if (!cleanSessionText(existing?.projectId)) {
      const currentState = await readWorkspaceState(agentId);
      const openDirectory = cleanSessionText(existing.openDirectory) || cleanSessionText(currentState.openDirectory);
      const cleanedForms = { ...currentState.forms };
      delete cleanedForms['startup-form'];
      await writeWorkspaceState(agentId, {
        forms: cleanedForms,
        openDirectory,
      });
    }
  }

  if (options?.returnSummary === false) {
    return Object.assign(buildLightPrebuiltSessionRecord(agentId, existing), { indexRevision: Number(updatedIndex.revision) || 0 });
  }
  return Object.assign(await summarizePrebuiltSession(agentId, existing), { indexRevision: Number(updatedIndex.revision) || 0 });
}

async function deletePrebuiltSession(agentId, sessionId, options = {}) {
  let deletedHandoffPath = '';
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
    deletedHandoffPath = typeof existing?.metadata?.handoffPath === 'string'
      ? existing.metadata.handoffPath
      : '';
    return { activeSessionId: nextActiveSessionId, sessions: remainingSessions, wasActiveSession };
  });

  await fs.rm(getPrebuiltSessionFilePath(agentId, sessionId), { force: true }).catch(e => console.warn(e));
  // branch 注入文件（ADR-0034 §4.1）：未被消费（会话从未启动）时随会话一并清理；
  // 已消费的注入文件由 runtime 首启导入后自删，此处 force 容忍缺失。
  if (deletedHandoffPath) {
    await fs.rm(deletedHandoffPath, { force: true }).catch(e => console.warn(e));
  }
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
    const wasActiveSession = index.activeSessionId === sessionId;
    const activeSessionId = archived && wasActiveSession
      ? (selectFallbackSession(agentId, sessions, existing)?.id ?? null)
      : index.activeSessionId;
    return { activeSessionId, sessions, wasActiveSession };
  });

  const updatedSession = newIndex.sessions.find((session) => session.id === sessionId) || null;
  const result = {
    protocolVersion: 2,
    archivedSessionId: sessionId,
    archived: !!archived,
    wasActiveSession: newIndex.wasActiveSession === true,
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

const TODO_COLORS = new Set(['white', 'red', 'yellow', 'green', 'blue']);

async function tagPrebuiltSessionTodo(agentId, sessionId, todo, options = {}) {
  // 待办颜色仅在 todo=true 时写入；取消待办时一并清除，保持索引干净
  const color = TODO_COLORS.has(options.color) ? options.color : 'white';
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
      session.id === sessionId
        ? { ...session, todo: !!todo, todoColor: todo ? color : null }
        : session,
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

  // An explicit agentId is authoritative. Never scan another Agent's session
  // index to repair a mismatched or missing request target.
  if (preferredAgentId) {
    addCandidate(preferredAgentId);
  } else {
    addCandidate('flow-workspace');
    addCandidate('agent-creator');
    addCandidate('feature-creator');
    addCandidate('programming-helper');
    try {
      const discovered = await discoverAgents(AGENTS_ROOT);
      discovered.forEach((agent) => addCandidate(agent?.id));
    } catch {}
  }

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
    : PH_STYLE_WORKSPACE_AGENT_IDS.has(normalizedAgentId)
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
      // 目录批量删除不收编项目会话（ticket 044）：项目会话的 openDirectory
      // 只是创建时记录，与同路径目录会话分属不同集合；其删除走项目删除
      // 端点（046），不得随目录删除连带清索引或正文。
      if (cleanSessionText(session?.projectId)) return true;
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
  const info = await resolveSessionModelInfo(agentId);
  return info.contextLength;
}

  const handoffHelpers = createSessionHandoffHelpers({
    startManagedAgent,
    waitForManagedRuntimeReady,
    resolvePrebuiltSessionOwner,
    requirePrebuiltSessionRecord,
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
    buildSessionTrimMessagePreview,
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
    updateSessionIndex,
    createPrebuiltSession,
    activatePrebuiltSession,
    deletePrebuiltSession,
    archivePrebuiltSession,
    tagPrebuiltSessionTodo,
    requirePrebuiltSessionRecord,
    findPrebuiltSessionRecordShared,
    readSessionSnapshotForContinuity,
    resolvePrebuiltSessionOwner,
    requirePrebuiltAgentForRuntime,
    ...handoffHelpers,
    deletePrebuiltProject,
    resolveContextLength,
  };
}
