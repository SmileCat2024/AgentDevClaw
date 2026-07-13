import path from 'path';
import { promises as fs } from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

import { USER_DATA_ROOT } from '../shared/constants.js';
import {
  sanitizeSessionFragment, cleanSessionText, normalizeClientAgentId,
} from '../shared/string-helpers.js';
import {
  getPrebuiltSessionFilePath,
  updateSessionIndex,
} from '../shared/session-access.js';
import {
  readHandoffPackage,
  exportHistoryOnlyHandoffPackage,
} from '../context-continuity/handoff-package.js';
import {
  exportSummarizedHandoffPackage,
  writeSummarizedHandoffPackage,
} from '../context-continuity/summarized-handoff.js';
import { extractDomainsFromText } from './session-helpers-pure.js';

export function createSessionHandoffHelpers(deps) {
  const {
    startManagedAgent,
    waitForManagedRuntimeReady,
    resolvePrebuiltSessionOwner,
    requirePrebuiltSessionRecord,
    summarizePrebuiltSession,
    requirePrebuiltAgentForRuntime,
    createPrebuiltSession,
    readSessionSnapshotForContinuity,
  } = deps;

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
        projectRoot: PROJECT_ROOT,
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

    // 根据操作类型确定标题前缀
    const handoffMode = cleanSessionText(handoff?.mode);
    const sourceTitle = cleanSessionText(handoff?.sourceRecord?.title);
    let derivedTitle = '';
    if (sourceTitle) {
      if (handoffMode === 'summarized-nine-section') {
        derivedTitle = `（摘要）${sourceTitle}`;
      } else {
        // trim-transcript 或其他模式默认为精简
        derivedTitle = `（精简）${sourceTitle}`;
      }
    }

    const session = await createPrebuiltSession(agent.id, {
      sourceSessionId,
      goal: goal || undefined,
      title: derivedTitle || undefined,
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
    exportContextHandoffForSession,
    createCompactedResumeFromHandoff,
    compactAndResumeCurrentSession,
    compactAndResumeFromProvidedSummary,
    exportProvidedSummaryHandoff,
    lockExplorationSession,
    buildExplorationHandoffPayload,
    writeSyntheticHandoff,
  };
}
