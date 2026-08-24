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
  writeTrimWithSummaryHandoffPackage,
} from '../context-continuity/handoff-package.js';
import {
  exportSummarizedHandoffPackage,
  writeSummarizedHandoffPackage,
} from '../context-continuity/summarized-handoff.js';
import { runTrimTranscriptWithSummary } from '../context-continuity/trim-appended-summary.js';
import { applyContinuityToolPolicy } from '../context-continuity/feature-continuity.js';

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
    setSessionHasSummary,
  } = deps;

  async function exportContextHandoffForSession(sessionId, preferredAgentId = '', policy = {}, options = {}) {
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
    const appendSummary = !!options.appendSummary;
    if (normalizedStrategy === 'summarized-nine-section') {
      const agent = await requirePrebuiltAgentForRuntime(ownerAgentId);
      const sourceSessionSnapshot = await readSessionSnapshotForContinuity(ownerAgentId, sessionId);
      const result = await exportSummarizedHandoffPackage({
        userDataRoot: USER_DATA_ROOT,
        agentId: ownerAgentId,
        sessionId,
        sourceRecord: record,
        policy,
        agentRelativeDir: agent.relativeDir,
        projectRoot: PROJECT_ROOT,
        sourceSessionSnapshot,
      });
      await setSessionHasSummary(ownerAgentId, sessionId, true);
      return result;
    }
    // Trim + appended summary: 组合语义（裁剪 + 摘要追加到 seed 尾部）的
    // 权威实现是框架 TrimTranscriptWithSummaryTransformation；Claw 只做
    // 装配（快照、模型预设、continuity 装饰）与 handoff JSON v1 落盘。
    if (appendSummary) {
      const agent = await requirePrebuiltAgentForRuntime(ownerAgentId);
      const sessionSnapshot = await readSessionSnapshotForContinuity(ownerAgentId, sessionId);
      const seed = await runTrimTranscriptWithSummary({
        agentRelativeDir: agent.relativeDir,
        agentId: ownerAgentId,
        sessionId,
        projectRoot: PROJECT_ROOT,
        sourceSessionSnapshot: sessionSnapshot,
        policy: applyContinuityToolPolicy(policy),
      });
      const result = await writeTrimWithSummaryHandoffPackage({
        userDataRoot: USER_DATA_ROOT,
        agentId: ownerAgentId,
        sessionId,
        sessionPath,
        sourceRecord: record,
        sessionSnapshot,
        seed,
      });
      const summaryChars = seed?.meta?.summaryText?.length ?? 0;
      console.log(`[trim_with_summary] combined handoff written (${summaryChars} chars summary) for session=${sessionId}`);
      await setSessionHasSummary(ownerAgentId, sessionId, true);
      return result;
    }

    const result = await exportHistoryOnlyHandoffPackage({
      userDataRoot: USER_DATA_ROOT,
      agentId: ownerAgentId,
      sessionId,
      sessionPath,
      sourceRecord: record,
      policy,
    });

    await setSessionHasSummary(ownerAgentId, sessionId, true);
    return result;
  }

  async function createCompactedResumeFromHandoff({
    preferredAgentId = '',
    handoffId = '',
    handoffPath = '',
    goal = '',
    startRuntime = true,
    trace = null,
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
    trace?.mark('handoff_loaded');
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
    trace?.mark('target_session_created', { targetSessionId: session.id });

    let status = null;
    let connected = null;
    if (startRuntime) {
      trace?.mark('target_runtime_start_requested', { targetSessionId: session.id });
      status = await startManagedAgent(agent, session.id, {
        extraEnv: {
          PROTOCLAW_HANDOFF_PATH: resolvedHandoffPath,
        },
      });
      trace?.mark('target_runtime_started', { targetSessionId: session.id });
      connected = await waitForManagedRuntimeReady(agent.id, 10000, session.id);
      trace?.mark(connected ? 'target_runtime_ready' : 'target_runtime_timeout', {
        targetSessionId: session.id,
        readiness: connected ? 'ready' : 'starting',
      });
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
    appendSummary = false,
    trace = null,
  }) {
    trace?.mark('handoff_export_started');
    const exportResult = await exportContextHandoffForSession(sessionId, preferredAgentId, policy, { appendSummary });
    trace?.mark('handoff_exported');
    const handoffPath = cleanSessionText(exportResult?.handoffPath);
    const handoffId = cleanSessionText(exportResult?.handoff?.handoffId);
    return createCompactedResumeFromHandoff({
      preferredAgentId,
      handoffId,
      handoffPath,
      startRuntime,
      trace,
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
    await setSessionHasSummary(ownerAgentId, sessionId, true);

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
    const result = await writeSummarizedHandoffPackage({
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
    await setSessionHasSummary(ownerAgentId, sessionId, true);
    return result;
  }

  return {
    exportContextHandoffForSession,
    createCompactedResumeFromHandoff,
    compactAndResumeCurrentSession,
    compactAndResumeFromProvidedSummary,
    exportProvidedSummaryHandoff,
  };
}
