import path from 'path';
import os from 'os';
import { promises as fs } from 'fs';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';

import {
  MIRROR_SCRIPT_TIMEOUT_MS,
  SESSION_TRANSFORMATION_TIMEOUT_MS,
} from '../shared/constants.js';
import { normalizePathCasing } from '../shared/fs-helpers.js';
import { consumeRecoverySession } from '../shared/open-sessions-tracker.js';
import {
  cleanSessionText,
  containsReplacementChar,
  childProcessEnv,
} from '../shared/string-helpers.js';
import {
  readSessionIndex,
  updateSessionIndex,
  getPrebuiltSessionFilePath,
  resolvePrebuiltSessionType,
  findMissingCheckpoints,
} from '../shared/session-access.js';
import { getAgentRuntime, stopAssemblyRuntime } from '../shared/agent-access.js';
import { renderConversationHtml } from '../conversation-renderer.js';
import { runInProcessSummary } from '../context-continuity/inprocess-summary.js';
import { createOperationTrace } from '../shared/operation-trace.js';
import { resolveAgentTarget, resolveSessionTarget } from '../shared/operation-target.js';
import {
  bareId,
  resolveForwardHostTarget,
  forwardProtoclawRoute,
  readForwardTargetError,
} from '../shared/remote-forward.js';
import { attachOperationMetadata, readOperationMetadata, buildLocalFailureResponse } from '../shared/operation-contract.js';
import { recordSidebarDiagnosticEvent } from '../shared/sidebar-diagnostics.js';
import { META_VERSION } from './session-helpers.js';
import { setupTokenRefreshRoute } from './session-token-refresh.js';
import { getThreadIntegration, isSuccessionGateFailure } from '../thread-control/thread-integration.js';
import { getInternalAuthToken } from '../auth.js';
import { resolveLifecycleTarget, resolveTransformationTarget, isBrowseOnlyMount } from '../thread-control/target-resolution.js';

// server.js lives at project root; this module is at server/routes/session.js
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

// ADR-0011：远程写幂等闸。远程目标 + 无 idempotencyKey → 400 且请求不过隧道；
// 本地路径保持现状不强制（proxy.js:244-250 同族契约）。
function requireRemoteIdempotencyKey(req, res, metadata = {}) {
  if (readOperationMetadata(req).idempotencyKey) return true;
  res.status(400).json({
    ok: false,
    code: 'idempotency_key_required',
    retryable: false,
    operationId: metadata.operationId || null,
    message: 'Remote write operations require an idempotency key (x-idempotency-key)',
    error: 'Remote write operations require an idempotency key (x-idempotency-key)',
  });
  return false;
}

/**
 * Session-scoped routes. Every session file/index mutation must name both the
 * logical Agent and the Session; no page focus or cross-Agent owner scan may
 * repair a missing target.
 *
 * Registers all session-related protoclaw routes.
 *
 * @param {object} app     Express app instance
 * @param {object} express Express module
 * @param {object} ctx     Context with session helpers + agent lifecycle functions
 */
export function setupSessionRoutes(app, express, ctx) {
  const {
    activatePrebuiltSession,
    archivePrebuiltSession,
    buildSessionTrimPreview,
    estimatePreambleCharCount,
    compactAndResumeCurrentSession,
    compactAndResumeFromProvidedSummary,
    createCompactedResumeFromHandoff,
    createPrebuiltSession,
    deletePrebuiltSession,
    exportContextHandoffForSession,
    exportProvidedSummaryHandoff,
    findSessionSummary,
    findSessionSummaryPath,
    listPrebuiltSessions,
    requirePrebuiltAgentForRuntime,
    requirePrebuiltSessionRecord,
    resolvePrebuiltSessionOwner,
    searchSessionsContent,
    setSessionHasSummary,
    tagPrebuiltSessionTodo,
    requireAgentLight,
    startManagedAgent,
    stopManagedAgent,
    waitForManagedRuntimeReady,
    notifySessionLineage,
    notifySessionArchived,
    clearUISurfaces,
    threadRotation,
    threadLifecycle,
    threadSuccession,
    threadDelete,
  } = ctx;

  // T003：统一目标解析的成员归属真相源——经 threadLifecycle.findThreadBySession
  // 绑定框架 WorkThread 的会话链记录（同源：input-gateway / acp），
  // 所有 Session 路由共用同一解析结果，杜绝「按 sessionType 特判」的分叉。
  const _memberLookup = async (agentId, sessionId) => {
    if (typeof threadLifecycle?.findThreadBySession !== 'function') return null;
    return threadLifecycle.findThreadBySession(agentId, sessionId).catch(() => null);
  };

  // T003：统一目标描述符 → 路由响应附加块（请求目标 + 实际生效对象 + 归属），
  // 让调用方不会误以为「Session 成功、Thread 未变化」。
  const _targetShape = (target) => ({
    target: {
      request: target.request,
      actual: target.actual,
      membership: target.membership,
      threadId: target.threadId ?? null,
      headSessionId: target.headSessionId ?? null,
    },
  });

// Automation trigger from thread-host runtimes (ContextRotationTriggerFeature):
// the event is ephemeral and thread-rotation is its only consumer. Interactive
// fuse state never flows through here — the session control panel reads it via
// runtime IPC (/protoclaw/context_guard_status in agent-lifecycle.js).
app.post('/protoclaw/context_guard_event', express.json(), async (req, res, next) => {
  try {
    const agentId = cleanSessionText(req.body?.agentId);
    const sessionId = cleanSessionText(req.body?.sessionId);
    if (!agentId || !sessionId) {
      res.status(400).json({ error: 'agentId and sessionId are required' });
      return;
    }
    if (threadRotation) {
      void threadRotation.handleContextGuard(agentId, sessionId).catch((error) => {
        console.error('[thread-rotation] context rotation failed:', error.message);
      });
    }
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

// ═══ Block A (server.js L3386-3774) ═══
app.get('/protoclaw/prebuilt_sessions', async (req, res, next) => {
  const startedAt = Date.now();
  try {
    if (typeof req.query.agentId !== 'string' || !req.query.agentId) {
      res.status(400).json({ error: 'agentId is required' });
      return;
    }
    // ADR-0011：远程命名空间 agentId → 转发远程同名会话列表（裸 id）；本地
    // 身份走下方既有读取路径，行为字节级不动。
    try {
      const hostTarget = resolveForwardHostTarget(req.query.agentId);
      if (hostTarget.scope === 'remote') {
        return await forwardProtoclawRoute(
          res,
          hostTarget,
          '/protoclaw/prebuilt_sessions?agentId=' + encodeURIComponent(bareId(req.query.agentId)),
        );
      }
    } catch (error) {
      return res.status(readForwardTargetError(error)).json(buildLocalFailureResponse(error));
    }
    const sessions = await listPrebuiltSessions(req.query.agentId);
    res.json(sessions);
    void recordSidebarDiagnosticEvent({
      kind: 'read_perf',
      operation: 'prebuilt_sessions_response',
      phase: 'completed',
      agentId: req.query.agentId,
      durationMs: Date.now() - startedAt,
      sessionCount: Array.isArray(sessions.sessions) ? sessions.sessions.length : 0,
      responseBytes: Number(res.getHeader?.('Content-Length')) || 0,
      revision: sessions.revision,
      result: 'success',
    }, { source: 'server' });
  } catch (error) {
    void recordSidebarDiagnosticEvent({
      kind: 'read_perf',
      operation: 'prebuilt_sessions_response',
      phase: 'failed',
      agentId: String(req.query.agentId || '').trim(),
      durationMs: Date.now() - startedAt,
      result: 'failed',
      errorCode: error?.code || 'prebuilt_sessions_failed',
    }, { source: 'server' });
    next(error);
  }
});

app.get('/protoclaw/search_sessions', async (req, res, next) => {
  try {
    const agentId = typeof req.query.agentId === 'string' ? req.query.agentId : '';
    const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const openDirectory = typeof req.query.openDirectory === 'string' ? req.query.openDirectory : '';
    if (!agentId) {
      res.status(400).json({ error: 'agentId is required' });
      return;
    }
    // ADR-0011：远程命名空间身份 → 转发远程同名搜索路由（裸 id + 原始 q /
    // openDirectory）；本地身份走下方既有索引扫描路径，行为字节级不动。
    try {
      const hostTarget = resolveForwardHostTarget(agentId);
      if (hostTarget.scope === 'remote') {
        const params = new URLSearchParams({
          agentId: bareId(agentId),
          q: query,
          ...(openDirectory ? { openDirectory } : {}),
        });
        return await forwardProtoclawRoute(res, hostTarget, `/protoclaw/search_sessions?${params.toString()}`);
      }
    } catch (error) {
      return res.status(readForwardTargetError(error)).json(buildLocalFailureResponse(error));
    }
    if (!query) {
      res.json({ query: '', results: [], total: 0, indexed: 0 });
      return;
    }
    const result = await searchSessionsContent(agentId, query, openDirectory);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.get('/protoclaw/session_record', async (req, res, next) => {
  try {
    const agentId = req.query.agentId;
    const sessionId = req.query.sessionId;
    if (!agentId || !sessionId) {
      res.status(400).json({ error: 'agentId and sessionId are required' });
      return;
    }
    // ADR-0011：远程命名空间身份 → 转发远程同名会话记录路由（裸 id）；本地
    // 身份走下方既有文件读取路径，行为字节级不动。
    try {
      const hostTarget = resolveForwardHostTarget(agentId, sessionId);
      if (hostTarget.scope === 'remote') {
        const params = new URLSearchParams({
          agentId: bareId(agentId),
          sessionId: bareId(sessionId),
        });
        return await forwardProtoclawRoute(res, hostTarget, `/protoclaw/session_record?${params.toString()}`);
      }
    } catch (error) {
      return res.status(readForwardTargetError(error)).json(buildLocalFailureResponse(error));
    }
    const sessionPath = getPrebuiltSessionFilePath(agentId, sessionId);
    const raw = await fs.readFile(sessionPath, 'utf8');
    const parsed = JSON.parse(raw);
    const messages = Array.isArray(parsed?.runtime?.context?.messages) ? parsed.runtime.context.messages : [];
    const sessionType = await resolvePrebuiltSessionType(agentId, sessionId);
    res.json({
      sessionId,
      sessionType: sessionType || null,
      goal: parsed.goal || null,
      messages: messages.map(m => ({
        role: m.role,
        turn: Number.isInteger(m.turn) ? m.turn : null,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        ...(Array.isArray(m.toolCalls) ? { toolCalls: m.toolCalls } : {}),
        ...(typeof m.reasoning === 'string' && m.reasoning ? { reasoning: m.reasoning } : {}),
        ...(m.toolCallId ? { toolCallId: m.toolCallId } : {}),
        ...(m.usage ? { usage: m.usage } : {}),
        ...(m.execution ? { execution: m.execution } : {}),
      })),
    });
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/render_conversation', express.json(), async (req, res, next) => {
  try {
    const { agentId: resolvedAgentId, sessionId } = resolveSessionTarget(req.body);
    const { lastNCalls } = req.body || {};
    const sessionPath = getPrebuiltSessionFilePath(resolvedAgentId, sessionId);
    const raw = await fs.readFile(sessionPath, 'utf8');
    const parsed = JSON.parse(raw);
    const messages = Array.isArray(parsed?.runtime?.context?.messages) ? parsed.runtime.context.messages : [];
    if (messages.length === 0) {
      res.status(404).json({ error: 'Session has no messages to render' });
      return;
    }

    const html = renderConversationHtml(messages, {
      title: `对话记录 ${sessionId.slice(-12)}`,
      agentId: resolvedAgentId,
      sessionId,
      lastNCalls: typeof lastNCalls === 'number' && lastNCalls > 0 ? lastNCalls : null,
    });

    const tempDir = path.join(process.cwd(), '.agentdev', 'temp');
    await fs.mkdir(tempDir, { recursive: true });
    const filename = `conversation-${sessionId.slice(-12)}-${Date.now()}.html`;
    const filePath = path.join(tempDir, filename);
    await fs.writeFile(filePath, html, 'utf8');

    const stat = await fs.stat(filePath);
    res.json({
      path: filePath,
      filename,
      size: stat.size,
      messageCount: messages.length,
    });
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      res.status(404).json({ error: 'Session file not found' });
    } else {
      next(error);
    }
  }
});

app.get('/protoclaw/session_trim_preview', async (req, res, next) => {
  try {
    const agentId = req.query.agentId;
    const sessionId = req.query.sessionId;
    if (!agentId || !sessionId) {
      res.status(400).json({ error: 'agentId and sessionId are required' });
      return;
    }
    // ADR-0011：远程命名空间身份 → 转发远程同名 trim 预览路由（裸 id，预览
    // 的消息读取与轮次切分全部发生在远程端）；本地身份走下方既有预览路径，
    // 行为字节级不动。GET 只读，无幂等闸。
    try {
      const hostTarget = resolveForwardHostTarget(agentId, sessionId);
      if (hostTarget.scope === 'remote') {
        const params = new URLSearchParams({
          agentId: bareId(agentId),
          sessionId: bareId(sessionId),
        });
        return await forwardProtoclawRoute(res, hostTarget, `/protoclaw/session_trim_preview?${params.toString()}`);
      }
    } catch (error) {
      return res.status(readForwardTargetError(error)).json(buildLocalFailureResponse(error));
    }
    const sessionPath = getPrebuiltSessionFilePath(agentId, sessionId);
    const raw = await fs.readFile(sessionPath, 'utf8');
    const parsed = JSON.parse(raw);
    const messages = Array.isArray(parsed?.runtime?.context?.messages) ? parsed.runtime.context.messages : [];
    const rounds = buildSessionTrimPreview(messages);
    const preambleCharCount = estimatePreambleCharCount(messages);
    let totalCharCount = preambleCharCount;
    for (const r of rounds) totalCharCount += r.charCount;
    res.json({
      sessionId,
      sessionTitle: parsed.title || '',
      contextLength: null,
      preamblePercent: totalCharCount > 0 ? preambleCharCount / totalCharCount : 0,
      rounds,
    });
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/sessions/branch', express.json(), async (req, res, next) => {
  const requestMetadata = readOperationMetadata(req);
  const trace = createOperationTrace({
    ...requestMetadata,
    operationId: requestMetadata.operationId,
    operation: 'branch_session',
    agentId: req.body?.agentId,
    sessionId: req.body?.sourceSessionId,
  });
  trace.mark('server_received');
  try {
    const agentId = cleanSessionText(req.body?.agentId);
    const sourceSessionId = cleanSessionText(req.body?.sourceSessionId);
    const cutMsgIndexEnd = req.body?.cutMsgIndexEnd;
    const archiveOriginal = req.body?.archiveOriginal === true;

    if (!agentId || !sourceSessionId) {
      res.status(400).json({ error: 'agentId and sourceSessionId are required' });
      return;
    }
    if (typeof cutMsgIndexEnd !== 'number' || !Number.isFinite(cutMsgIndexEnd)) {
      res.status(400).json({ error: 'cutMsgIndexEnd must be a finite number' });
      return;
    }

    // ADR-0011：远程命名空间身份 → 转发远程同名分支路由（裸 id，新会话文件、
    // checkpoint 提取与索引落盘全部发生在远程端；本地身份走下方既有分支路径，
    // 行为字节级不动）。远程写强制幂等键（本地路径保持现状不强制）。
    try {
      const hostTarget = resolveForwardHostTarget(agentId, sourceSessionId);
      if (hostTarget.scope === 'remote') {
        if (!requireRemoteIdempotencyKey(req, res, trace)) return;
        return await forwardProtoclawRoute(res, hostTarget, '/protoclaw/sessions/branch', {
          method: 'POST',
          body: {
            ...(req.body || {}),
            agentId: bareId(agentId),
            sourceSessionId: bareId(sourceSessionId),
          },
        });
      }
    } catch (error) {
      attachOperationMetadata(error, requestMetadata);
      trace.mark('failed', { errorCode: error?.code || 'branch_failed' });
      return res.status(readForwardTargetError(error)).json(buildLocalFailureResponse(error, requestMetadata));
    }

    const sourcePath = getPrebuiltSessionFilePath(agentId, sourceSessionId);
    const sourceRaw = await fs.readFile(sourcePath, 'utf8');
    const sourceSnapshot = JSON.parse(sourceRaw);
    const rawMessages = Array.isArray(sourceSnapshot?.runtime?.context?.messages)
      ? sourceSnapshot.runtime.context.messages
      : [];

    const branchMessages = rawMessages.slice(0, cutMsgIndexEnd + 1);

    if (branchMessages.length === 0) {
      res.status(400).json({ error: 'No messages to keep after branch cut' });
      return;
    }

    // Determine the maximum user turn in the branch so we can preserve the
    // invariant: user message turn === checkpoint callIndex === _callIndex.
    // Previously callIndex was hardcoded to 0 which broke rollback entirely.
    let maxUserTurn = -1;
    for (const m of branchMessages) {
      if (m.role === 'user' && typeof m.turn === 'number') {
        maxUserTurn = Math.max(maxUserTurn, m.turn);
      }
    }

    // Only keep checkpoints whose callIndex is within the branch range.
    // Checkpoints beyond the cut point reference context that no longer exists.
    const sourceCheckpoints = Array.isArray(sourceSnapshot.rollbackHistory)
      ? sourceSnapshot.rollbackHistory
      : [];
    const branchCheckpoints = sourceCheckpoints.filter(
      cp => typeof cp.callIndex === 'number' && cp.callIndex <= maxUserTurn
    );

    // Truncate enrichedMessages to match the branch message range.
    const sourceEnriched = Array.isArray(sourceSnapshot.runtime?.context?.enrichedMessages)
      ? sourceSnapshot.runtime.context.enrichedMessages
      : [];
    const branchEnriched = sourceEnriched.filter(
      em => typeof em.turn !== 'number' || em.turn <= maxUserTurn
    );

    // Read the source session index record early so its metadata (title, etc.)
    // is available when building the branch record. Previously sourceRecord was
    // only assigned inside the updateSessionIndex callback, which ran AFTER the
    // branch record was constructed — so all sourceRecord fields were always null.
    let sourceRecord = null;
    try {
      const sourceIdx = await readSessionIndex(agentId);
      sourceRecord = sourceIdx.sessions.find(s => s.id === sourceSessionId) || null;
    } catch {}

    // Validate checkpoint integrity: warn if user turns lack matching checkpoints.
    const missingCheckpoints = findMissingCheckpoints(branchMessages, branchCheckpoints);
    if (missingCheckpoints.length > 0) {
      const branchUserTurns = branchMessages
        .filter(m => m.role === 'user' && typeof m.turn === 'number')
        .map(m => m.turn);
      console.warn(`[ProtoClaw] Branch from ${sourceSessionId}: user turns [${branchUserTurns.join(',')}] have missing checkpoints for turns [${missingCheckpoints.join(',')}]. Rollback will be unavailable for those turns.`);
    }

    const newSessionId = `session-${Date.now()}-${randomUUID().slice(0, 6)}`;
    const createdAt = new Date().toISOString();
    const sourceRuntime = sourceSnapshot.runtime || {};

    // 从 checkpoint 提取运行态（兼容 v1 runtime 和 v2 runtimeState）
    const getCheckpointRuntimeState = (cp) => {
      if (!cp) return null;
      if (cp.kind === 'context-boundary' && cp.runtimeState) return cp.runtimeState;
      if (cp.runtime) return cp.runtime;
      return null;
    };

    const runtimeCheckpointAfterCut = getCheckpointRuntimeState(
      sourceCheckpoints.find(
        cp => typeof cp.callIndex === 'number' && cp.callIndex === maxUserTurn + 1
      )
    );
    const runtimeCheckpointAtCut = getCheckpointRuntimeState(
      [...sourceCheckpoints]
        .reverse()
        .find(cp => typeof cp.callIndex === 'number' && cp.callIndex <= maxUserTurn)
    );
    const runtimeForBranchState = runtimeCheckpointAfterCut || runtimeCheckpointAtCut || sourceRuntime;

    const branchSnapshot = {
      ...sourceSnapshot,
      sessionId: newSessionId,
      savedAt: Date.now(),
      runtime: {
        ...sourceRuntime,
        initialized: true,
        callIndex: maxUserTurn,
        featureStates: Array.isArray(runtimeForBranchState?.featureStates)
          ? runtimeForBranchState.featureStates
          : (Array.isArray(sourceRuntime.featureStates) ? sourceRuntime.featureStates : []),
        usageStats: runtimeForBranchState?.usageStats || sourceRuntime.usageStats,
        context: {
          ...(sourceRuntime.context || {}),
          messages: branchMessages,
          enrichedMessages: branchEnriched,
        },
      },
      rollbackHistory: branchCheckpoints,
    };
    delete branchSnapshot.title;

    const branchSessionPath = getPrebuiltSessionFilePath(agentId, newSessionId);
    await fs.writeFile(branchSessionPath, JSON.stringify(branchSnapshot, null, 2), 'utf8');

    const sourceTitle = sourceRecord?.title || '';
    const branchTitle = sourceTitle
      ? `（分支）${sourceTitle}`
      : `（分支）新对话 · ${createdAt.replace(/[TZ]/g, ' ').trim()}`;

    const branchRecord = {
      id: newSessionId,
      title: branchTitle,
      featureName: sourceRecord?.featureName || '',
      agentName: sourceRecord?.agentName || '',
      taskTitle: sourceRecord?.taskTitle || '',
      taskType: sourceRecord?.taskType || '',
      goal: sourceRecord?.goal || '',
      constraints: sourceRecord?.constraints || '',
      expectedOutput: sourceRecord?.expectedOutput || '',
      targetFiles: sourceRecord?.targetFiles || '',
      referenceMaterials: sourceRecord?.referenceMaterials || '',
      formId: sourceRecord?.formId || '',
      openDirectory: await normalizePathCasing(sourceRecord?.openDirectory || ''),
      sessionType: sourceRecord?.sessionType || 'main',
      metadata: {
        ...(sourceRecord?.metadata || {}),
        branchSourceSessionId: sourceSessionId,
        branchCutMsgIndexEnd: cutMsgIndexEnd,
      },
      createdAt,
      updatedAt: createdAt,
    };

    const nextIndex = await updateSessionIndex(agentId, (index) => {
      return {
        activeSessionId: newSessionId,
        sessions: [branchRecord, ...index.sessions.filter((s) => s.id !== newSessionId)],
      };
    });
    trace.mark('index_committed', { revision: nextIndex.revision });

    // 线程宿主（coder）：分支即新线程（不在原线程内分叉）。新会话成为
    // 一条独立线程的 root 与初始 head；非宿主工作空间 no-op，失败不阻断。
    await getThreadIntegration().onSessionCreated(agentId, branchRecord);

    const agent = await requirePrebuiltAgentForRuntime(agentId);
    await startManagedAgent(agent, newSessionId);
    trace.mark('target_runtime_started');
    const connected = await waitForManagedRuntimeReady(agent.id, 10000, newSessionId);
    trace.mark(connected ? 'target_runtime_ready' : 'target_runtime_timeout');

    // 服务端归档原会话（如果请求要求）
    let branchArchived = false;
    let branchArchiveError = '';
    let branchArchiveResult = null;
    if (archiveOriginal) {
      try {
        branchArchiveResult = await archivePrebuiltSession(agentId, sourceSessionId, true, { includeSessions: false });
        branchArchived = true;
      } catch (err) {
        branchArchiveError = err instanceof Error ? err.message : String(err);
        console.error('[branch] failed to archive original session:', err);
      }
    }

    const finalRevision = branchArchiveResult?.revision || nextIndex.revision || 0;
    const deltaUpserts = [branchRecord];
    if (branchArchiveResult?.sessionDelta?.upsert?.[0]) {
      deltaUpserts.push(branchArchiveResult.sessionDelta.upsert[0]);
    }

    res.json({
      protocolVersion: 2,
      operationId: trace.operationId,
      revision: finalRevision,
      ok: true,
      newSessionId,
      branchTitle,
      keptMessages: branchMessages.length,
      totalMessages: rawMessages.length,
      agent: connected,
      sessionDelta: {
        revision: finalRevision,
        activeSessionId: newSessionId,
        upsert: deltaUpserts,
        remove: [],
      },
      archive: {
        requested: archiveOriginal,
        succeeded: archiveOriginal ? branchArchived : null,
        error: branchArchiveError || null,
      },
    });
    trace.mark('response_sent', { revision: finalRevision });

    // 血缘继承：branch 产生新 session，通知关联群聊
    if (notifySessionLineage) {
      notifySessionLineage({ agentId, fromSessionId: sourceSessionId, toSessionId: newSessionId, reason: 'branch', archived: branchArchived })
        .catch((err) => console.error('[branch] lineage notification failed:', err));
    }
  } catch (error) {
    attachOperationMetadata(error, requestMetadata);
    trace.mark('failed', { errorCode: error?.code || 'branch_failed' });
    next(error);
  }
});

app.get('/protoclaw/session_summary', async (req, res, next) => {
  try {
    const agentId = req.query.agentId;
    const sessionId = req.query.sessionId;
    if (!agentId || !sessionId) {
      res.status(400).json({ error: 'agentId and sessionId are required' });
      return;
    }
    // ADR-0011：远程命名空间身份 → 转发远程同名摘要查询路由（裸 id，摘要的
    // 查找与读取全部发生在远程端）；本地身份走下方既有查询路径，行为字节级
    // 不动。GET 只读，无幂等闸。
    try {
      const hostTarget = resolveForwardHostTarget(agentId, sessionId);
      if (hostTarget.scope === 'remote') {
        const params = new URLSearchParams({
          agentId: bareId(agentId),
          sessionId: bareId(sessionId),
        });
        return await forwardProtoclawRoute(res, hostTarget, `/protoclaw/session_summary?${params.toString()}`);
      }
    } catch (error) {
      return res.status(readForwardTargetError(error)).json(buildLocalFailureResponse(error));
    }
    const handoff = await findSessionSummary(agentId, sessionId);
    if (!handoff) {
      res.status(404).json({ error: 'No summary found for this session' });
      return;
    }
    res.json({
      sessionId,
      summaryText: handoff.sourceSummary || handoff.summaryArtifact?.summaryText || '',
      sessionTitle: handoff.compactOutput?.sessionTitle || '',
      importantFiles: handoff.compactOutput?.importantFiles || [],
      importantSkills: handoff.compactOutput?.importantSkills || [],
      createdAt: handoff.createdAt || null,
    });
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/session_generate_summary', express.json(), async (req, res, next) => {
  try {
    const agentId = cleanSessionText(req.body?.agentId);
    const sessionId = cleanSessionText(req.body?.sessionId);
    if (!agentId || !sessionId) {
      res.status(400).json({ error: 'agentId and sessionId are required' });
      return;
    }
    // ADR-0011：远程命名空间身份 → 转发远程同名摘要生成路由（裸 id，LLM 调用
    // 与 handoff 落盘全部发生在远程端）；本地身份走下方既有生成路径，行为字节
    // 级不动。远程写强制幂等键（本地路径保持现状不强制）。
    try {
      const hostTarget = resolveForwardHostTarget(agentId, sessionId);
      if (hostTarget.scope === 'remote') {
        if (!requireRemoteIdempotencyKey(req, res)) return;
        return await forwardProtoclawRoute(res, hostTarget, '/protoclaw/session_generate_summary', {
          method: 'POST',
          body: {
            ...(req.body || {}),
            agentId: bareId(agentId),
            sessionId: bareId(sessionId),
          },
        });
      }
    } catch (error) {
      return res.status(readForwardTargetError(error)).json(buildLocalFailureResponse(error));
    }
    const force = !!req.body?.force;
    // T003：summary 只能作用于 Thread 当前 head；历史 Session 返回
    // stale_session（附 Thread ID 与当前 head），不静默改写目标。
    const transformTarget = await resolveTransformationTarget({
      agentId, sessionId, memberLookup: _memberLookup,
    });
    if (!transformTarget.ok && transformTarget.code === 'stale_session') {
      // 直接以 409 统一形状返回（不经全局错误处理器——那里会丢弃 target 附加块）。
      res.status(409).json({
        ok: false,
        code: 'stale_session',
        message: transformTarget.message,
        ..._targetShape(transformTarget),
      });
      return;
    }
    const existingSummary = await findSessionSummary(agentId, sessionId);
    if (existingSummary && !force) {
      await setSessionHasSummary(agentId, sessionId, true);
      res.json({ ok: true, alreadyExists: true });
      return;
    }
    if (existingSummary && force) {
      const handoffPath = await findSessionSummaryPath(agentId, sessionId);
      if (handoffPath) await fs.unlink(handoffPath).catch(e => console.warn(e));
      const remainingSummary = await findSessionSummary(agentId, sessionId);
      await setSessionHasSummary(agentId, sessionId, !!remainingSummary);
    }
    const agentRelativeDir = path.join('prebuilt-agents', 'official', agentId);

    console.log(`[generate_summary] in-process summary begin agent=${agentId} session=${sessionId}`);
    const result = await runInProcessSummary({
      agentRelativeDir,
      projectRoot: PROJECT_ROOT,
      agentId,
      sessionId,
      maxAttempts: 1,
      timeoutMs: SESSION_TRANSFORMATION_TIMEOUT_MS,
    });
    if (!result?.summaryText) {
      res.status(500).json({ error: 'In-process summary did not produce a valid summary' });
      return;
    }
    await exportProvidedSummaryHandoff({
      preferredAgentId: agentId,
      sessionId,
      summaryText: result.summaryText,
      importantFiles: result.importantFiles || [],
      importantSkills: result.importantSkills || [],
    });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

// ═══ Block B: Token Count Refresh (extracted to session-token-refresh.js) ═══
setupTokenRefreshRoute(app, express);

// ═══ Block C (server.js L4048-4595) ═══
// ── Sessions ──────────────────────────────────────────────────────────────────

app.post('/protoclaw/prebuilt_sessions', express.json(), async (req, res, next) => {
  const requestMetadata = readOperationMetadata(req);
  const trace = createOperationTrace({
    ...requestMetadata,
    operationId: requestMetadata.operationId,
    operation: 'create_session',
    agentId: req.body?.agentId,
  });
  trace.mark('server_received');
  try {
    const { agentId } = resolveAgentTarget(req.body);
    // ADR-0011：远程命名空间身份 → 转发远程同名创建路由（裸 id，远程端启动
    // 自己的 runtime）；本地身份走下方既有创建路径，行为字节级不动。远程写
    // 强制幂等键（本地路径保持现状不强制）。
    try {
      const hostTarget = resolveForwardHostTarget(agentId);
      if (hostTarget.scope === 'remote') {
        if (!requireRemoteIdempotencyKey(req, res, trace)) return;
        const {
          agentId: _agentId,
          ...createFields
        } = req.body || {};
        return await forwardProtoclawRoute(res, hostTarget, '/protoclaw/prebuilt_sessions', {
          method: 'POST',
          body: { ...createFields, agentId: bareId(agentId) },
        });
      }
    } catch (error) {
      return res.status(readForwardTargetError(error)).json(buildLocalFailureResponse(error));
    }
    const agent = await requireAgentLight(agentId);
    // sessionType 限定已知值：main 是用户会话缺省形态；coder 是线程宿主
    // 会话，仅由调度面（ACP / dispatch / CLI）显式创建，前端不传此字段。
    const requestedSessionType = cleanSessionText(req.body?.sessionType);
    if (requestedSessionType && !['main', 'coder'].includes(requestedSessionType)) {
      res.status(400).json({ error: `unsupported sessionType: ${requestedSessionType}` });
      return;
    }
    // coder 是无人值守身份，目录绑定错的代价是在错误的项目里施工：禁止裸
    // 创建——缺目录时 createPrebuiltSession 会回退到 workspace state 的最近
    // 目录（随上次目录切换/会话创建漂移，几乎必然绑错）。调度面（coder_shell
    // / claw CLI）必须显式指定已存在的绝对路径；successor 派生路径
    // （sourceSessionId 继承来源身份与目录）不受此闸门约束。
    if (requestedSessionType === 'coder' && !req.body?.sourceSessionId) {
      const rawDirectory = typeof req.body?.openDirectory === 'string' ? req.body.openDirectory.trim() : '';
      if (!rawDirectory) {
        res.status(400).json({
          error: 'coder 会话必须显式指定 openDirectory（目标工作目录），不接受目录回退默认'
            + '（缺省时会绑定到 workspace 最近目录，几乎必然绑错项目）。'
            + '调度面请用 coder_shell new-session <agentId> <目录> 或 claw sessions create --session-type coder --dir <目录> 显式指定。',
        });
        return;
      }
      if (!path.isAbsolute(rawDirectory)) {
        res.status(400).json({ error: `openDirectory 必须是绝对路径: ${rawDirectory}` });
        return;
      }
      const directoryStat = await fs.stat(rawDirectory).catch(() => null);
      if (!directoryStat?.isDirectory()) {
        res.status(400).json({ error: `openDirectory 不存在或不是目录: ${rawDirectory}` });
        return;
      }
    }
    // 标题随创建写入（线程标题自动跟随 session.title），免去创建后单独 PUT；
    // 拒绝编码损坏的文本（原生 curl 按 ANSI 代码页转码的典型产物）。
    const requestedTitle = cleanSessionText(req.body?.title);
    if (containsReplacementChar(requestedTitle)) {
      res.status(400).json({ error: 'title 含无效编码字符（U+FFFD），通常由控制台代码页转码（如原生 curl）造成；请改用 claw CLI 传参' });
      return;
    }
    const session = await createPrebuiltSession(agent.id, {
      returnSummary: false,
      title: requestedTitle || undefined,
      sessionType: requestedSessionType || undefined,
      sourceSessionId: req.body.sourceSessionId,
      formId: req.body.formId,
      featureName: req.body.featureName,
      agentName: req.body.agentName,
      projectName: req.body.projectName,
      openDirectory: req.body.openDirectory,
      targetDir: req.body.targetDir,
    });
    const committedIndex = await readSessionIndex(agent.id);
    trace.mark('index_committed', { revision: committedIndex.revision, sessionCount: committedIndex.sessions.length });
    const status = await startManagedAgent(agent, session.id);
    trace.mark('target_runtime_started');
    // 线程宿主工作空间（coder）：新会话自动成为一条新线程的初始 head。
    // 非 host 工作空间为 no-op；失败不阻断会话创建。返回值带 threadId
    // 供调度方直接投递，省去创建后从列表反查。
    const createdThread = await getThreadIntegration().onSessionCreated(agent.id, session);
    res.json({
      protocolVersion: 2,
      operationId: trace.operationId,
      revision: committedIndex.revision,
      // threadId 放在 session 全量对象之前：调用方截断输出（head -c 等）时
      // 调度句柄仍然可见，不需要再从 threads list 反查。
      threadId: createdThread?.threadId || null,
      session,
      sessionDelta: {
        revision: committedIndex.revision,
        activeSessionId: committedIndex.activeSessionId,
        upsert: [session],
        remove: [],
      },
      status,
      targetSessionId: session.id,
      targetStatus: status,
      agent: null,
    });
    trace.mark('response_sent');
  } catch (error) {
    attachOperationMetadata(error, requestMetadata);
    trace.mark('failed', { errorCode: error?.code || 'create_failed' });
    next(error);
  }
});

app.put('/protoclaw/prebuilt_sessions/:sessionId/title', express.json(), async (req, res, next) => {
  try {
    const { agentId, title } = req.body || {};
    const sessionId = req.params.sessionId;

    if (!agentId || typeof agentId !== 'string') {
      return res.status(400).json({ error: 'agentId is required' });
    }
    if (!sessionId || typeof sessionId !== 'string') {
      return res.status(400).json({ error: 'sessionId is required' });
    }
    if (!title || typeof title !== 'string' || !title.trim()) {
      return res.status(400).json({ error: 'title is required and must be non-empty' });
    }
    // ADR-0011：远程命名空间身份 → 转发远程同名改名路由（裸 id，远程端做
    // 自己的索引更新）；本地身份走下方既有索引更新路径，行为字节级不动。
    // 远程写强制幂等键（本地路径保持现状不强制）。
    try {
      const hostTarget = resolveForwardHostTarget(agentId, sessionId);
      if (hostTarget.scope === 'remote') {
        if (!requireRemoteIdempotencyKey(req, res)) return;
        return await forwardProtoclawRoute(
          res,
          hostTarget,
          `/protoclaw/prebuilt_sessions/${encodeURIComponent(bareId(sessionId))}/title`,
          {
            method: 'PUT',
            body: { agentId: bareId(agentId), title: title.trim() },
          },
        );
      }
    } catch (error) {
      return res.status(readForwardTargetError(error)).json(buildLocalFailureResponse(error));
    }
    if (containsReplacementChar(title)) {
      return res.status(400).json({ error: 'title 含无效编码字符（U+FFFD），通常由控制台代码页转码（如原生 curl）造成；请改用 claw CLI 传参' });
    }

    const updatedIndex = await updateSessionIndex(agentId, (index) => {
      const sessionIndex = index.sessions.findIndex(s => s.id === sessionId);
      if (sessionIndex === -1) {
        throw Object.assign(new Error('Session not found'), { statusCode: 404 });
      }
      index.sessions[sessionIndex].title = title.trim();
      index.sessions[sessionIndex].updatedAt = new Date().toISOString();
      return index;
    });

    const updatedSession = updatedIndex.sessions.find((session) => session.id === sessionId) || null;
    res.json({
      protocolVersion: 2,
      ok: true,
      sessionId,
      title: title.trim(),
      revision: Number(updatedIndex.revision) || 0,
      sessionDelta: {
        revision: Number(updatedIndex.revision) || 0,
        activeSessionId: updatedIndex.activeSessionId,
        upsert: updatedSession ? [updatedSession] : [],
        remove: [],
      },
    });
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/generate_session_title', express.json(), async (req, res, next) => {
  try {
    const agentId = cleanSessionText(req.body?.agentId);
    const sessionId = cleanSessionText(req.body?.sessionId);
    if (!agentId || !sessionId) {
      return res.status(400).json({ error: 'agentId and sessionId are required' });
    }
    // ADR-0011：远程命名空间身份 → 转发远程同名 AI 标题路由（裸 id，LLM 调用
    // 与索引更新都发生在远程端，用远程模型配置）；本地身份走下方既有 title
    // mirror 路径，行为字节级不动。远程写强制幂等键。
    try {
      const hostTarget = resolveForwardHostTarget(agentId, sessionId);
      if (hostTarget.scope === 'remote') {
        if (!requireRemoteIdempotencyKey(req, res)) return;
        return await forwardProtoclawRoute(res, hostTarget, '/protoclaw/generate_session_title', {
          method: 'POST',
          body: {
            ...(req.body || {}),
            agentId: bareId(agentId),
            sessionId: bareId(sessionId),
          },
        });
      }
    } catch (error) {
      return res.status(readForwardTargetError(error)).json(buildLocalFailureResponse(error));
    }

    const ownerAgentId = await resolvePrebuiltSessionOwner(sessionId, agentId);
    if (!ownerAgentId) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const agent = await requirePrebuiltAgentForRuntime(ownerAgentId);
    const agentRelativeDir = agent.relativeDir;
    if (!agentRelativeDir) {
      return res.status(500).json({ error: 'Agent directory not resolved' });
    }

    // 防御：检查 session JSON 文件是否已落盘。
    // 新创建的会话（尤其是 trim/summary 衍生会话）在 runtime 首次保存前
    // 磁盘上不存在 JSON 文件，title mirror 子进程加载时会 ENOENT。
    try {
      await fs.access(getPrebuiltSessionFilePath(ownerAgentId, sessionId));
    } catch {
      return res.status(404).json({ error: 'Session file not yet written to disk' });
    }

    const titleMirrorScript = path.join(PROJECT_ROOT, 'scripts', 'run-title-mirror.js');
    const resultDir = path.join(os.tmpdir(), `title-mirror-${Date.now()}-${randomUUID().slice(0, 8)}`);
    const resultPath = path.join(resultDir, 'result.json');
    await fs.mkdir(resultDir, { recursive: true });

    const child = spawn(process.execPath, [titleMirrorScript, agentRelativeDir, ownerAgentId, sessionId, JSON.stringify({ maxAttempts: 3 }), resultPath], {
      cwd: __dirname,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...childProcessEnv(), PROTOCLAW_INTERNAL_TOKEN: getInternalAuthToken() },
    });

    let stderr = '';
    const timeoutMs = MIRROR_SCRIPT_TIMEOUT_MS;
    let timedOut = false;
    let exitCode = null;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stderr.on('data', (chunk) => {
      const text = String(chunk);
      stderr += text;
      for (const line of text.split('\n')) {
        if (line.trim()) console.log(`[title-mirror] ${line.trimEnd()}`);
      }
    });

    await new Promise((resolve, reject) => {
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        exitCode = code;
        resolve();
      });
    });

    // 成败以落盘的 result.json 为准：writeFileSync 在子进程任何退出路径之前
    // 同步完成。Windows 上进程退出阶段可能因 libuv 与 keep-alive socket 的
    // 竞态 fail-fast（uv_async 断言，退出码非零），但标题结果此时已完整写盘，
    // 不能按退出码判失败。
    let result;
    try {
      const raw = await fs.readFile(resultPath, 'utf8');
      result = JSON.parse(raw.trim());
    } catch {
      if (timedOut) {
        throw new Error(`Title generation timed out after ${timeoutMs}ms${stderr.trim() ? `\n${stderr.trim()}` : ''}`);
      }
      throw new Error(stderr.trim() || `run-title-mirror exited with code ${exitCode}`);
    } finally {
      await fs.rm(resultDir, { recursive: true, force: true }).catch(e => console.warn(e));
    }

    const title = typeof result?.title === 'string' ? result.title.trim() : '';
    if (!title) {
      return res.status(500).json({ error: 'Title generation returned empty result' });
    }

    const updatedIndex = await updateSessionIndex(ownerAgentId, (index) => {
      const sessionIndex = index.sessions.findIndex(s => s.id === sessionId);
      if (sessionIndex !== -1) {
        index.sessions[sessionIndex].title = title;
        index.sessions[sessionIndex].updatedAt = new Date().toISOString();
      }
      return index;
    });

    const updatedSession = updatedIndex.sessions.find((session) => session.id === sessionId) || null;
    res.json({
      protocolVersion: 2,
      ok: true,
      sessionId,
      title,
      revision: Number(updatedIndex.revision) || 0,
      sessionDelta: {
        revision: Number(updatedIndex.revision) || 0,
        activeSessionId: updatedIndex.activeSessionId,
        upsert: updatedSession ? [updatedSession] : [],
        remove: [],
      },
    });
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/generate_recap', express.json(), async (req, res, next) => {
  try {
    const agentId = cleanSessionText(req.body?.agentId);
    const sessionId = cleanSessionText(req.body?.sessionId);
    if (!agentId || !sessionId) {
      return res.status(400).json({ error: 'agentId and sessionId are required' });
    }
    // ADR-0011：远程命名空间身份 → 转发远程同名 AI recap 路由（裸 id，LLM
    // 调用发生在远程端）；本地身份走下方既有 recap mirror 路径，行为字节级
    // 不动。远程写强制幂等键。
    try {
      const hostTarget = resolveForwardHostTarget(agentId, sessionId);
      if (hostTarget.scope === 'remote') {
        if (!requireRemoteIdempotencyKey(req, res)) return;
        return await forwardProtoclawRoute(res, hostTarget, '/protoclaw/generate_recap', {
          method: 'POST',
          body: {
            ...(req.body || {}),
            agentId: bareId(agentId),
            sessionId: bareId(sessionId),
          },
        });
      }
    } catch (error) {
      return res.status(readForwardTargetError(error)).json(buildLocalFailureResponse(error));
    }

    const ownerAgentId = await resolvePrebuiltSessionOwner(sessionId, agentId);
    if (!ownerAgentId) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const agent = await requirePrebuiltAgentForRuntime(ownerAgentId);
    const agentRelativeDir = agent.relativeDir;
    if (!agentRelativeDir) {
      return res.status(500).json({ error: 'Agent directory not resolved' });
    }

    const recapMirrorScript = path.join(PROJECT_ROOT, 'scripts', 'run-recap-mirror.js');
    const resultDir = path.join(os.tmpdir(), `recap-mirror-${Date.now()}-${randomUUID().slice(0, 8)}`);
    const resultPath = path.join(resultDir, 'result.json');
    await fs.mkdir(resultDir, { recursive: true });

    const child = spawn(process.execPath, [recapMirrorScript, agentRelativeDir, ownerAgentId, sessionId, JSON.stringify({ maxAttempts: 1 }), resultPath], {
      cwd: __dirname,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...childProcessEnv(), PROTOCLAW_INTERNAL_TOKEN: getInternalAuthToken() },
    });

    let stderr = '';
    const timeoutMs = MIRROR_SCRIPT_TIMEOUT_MS;
    let timedOut = false;
    let exitCode = null;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stderr.on('data', (chunk) => {
      const text = String(chunk);
      stderr += text;
      for (const line of text.split('\n')) {
        if (line.trim()) console.log(`[recap-mirror] ${line.trimEnd()}`);
      }
    });

    await new Promise((resolve, reject) => {
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        exitCode = code;
        resolve();
      });
    });

    // 成败以落盘的 result.json 为准，与 generate_session_title 同理：
    // Windows 上退出码非零可能只是退出阶段的 libuv fail-fast，结果文件
    // 已在此之前同步写盘。
    let result;
    try {
      const raw = await fs.readFile(resultPath, 'utf8');
      result = JSON.parse(raw.trim());
    } catch {
      if (timedOut) {
        throw new Error(`Recap generation timed out after ${timeoutMs}ms${stderr.trim() ? `\n${stderr.trim()}` : ''}`);
      }
      throw new Error(stderr.trim() || `run-recap-mirror exited with code ${exitCode}`);
    } finally {
      await fs.rm(resultDir, { recursive: true, force: true }).catch(e => console.warn(e));
    }

    const recap = typeof result?.recap === 'string' ? result.recap.trim() : '';
    if (!recap) {
      return res.status(500).json({ error: 'Recap generation returned empty result' });
    }

    res.json({ ok: true, sessionId, recap });
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/context_handoffs/export', express.json(), async (req, res, next) => {
  try {
    const { agentId: preferredAgentId, sessionId } = resolveSessionTarget(req.body);
    const result = await exportContextHandoffForSession(sessionId, preferredAgentId, req.body?.policy || {});
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/context_handoffs/compacted_resume', express.json(), async (req, res, next) => {
  try {
    const handoffId = cleanSessionText(req.body?.handoffId);
    const handoffPath = cleanSessionText(req.body?.handoffPath);
    if (!handoffId && !handoffPath) {
      res.status(400).json({ error: 'handoffId or handoffPath is required' });
      return;
    }

    // ADR-0011：远程命名空间身份 → 转发远程同名压缩产物续聊路由（裸 id，
    // handoff 查找、新会话创建与续聊启动全部发生在远程端）；本地身份走下方
    // 既有路径，行为字节级不动。远程写强制幂等键。
    // 注意：handoffPath 是远程端磁盘路径，不能被本地路径解析误用——远程分支
    // 必须在 createCompactedResumeFromHandoff 之前短路。
    try {
      const hostTarget = resolveForwardHostTarget(req.body?.agentId, handoffId);
      if (hostTarget.scope === 'remote') {
        if (!requireRemoteIdempotencyKey(req, res)) return;
        const forwardedBody = {
          ...(req.body || {}),
          agentId: bareId(req.body?.agentId || ''),
        };
        if (handoffId) forwardedBody.handoffId = bareId(handoffId);
        if (handoffPath) forwardedBody.handoffPath = handoffPath;
        return await forwardProtoclawRoute(res, hostTarget, '/protoclaw/context_handoffs/compacted_resume', {
          method: 'POST',
          body: forwardedBody,
        });
      }
    } catch (error) {
      return res.status(readForwardTargetError(error)).json(buildLocalFailureResponse(error));
    }

    // A handoff path carries its own source identity. Handoff-id lookup is
    // still explicitly scoped by agentId; page focus is never consulted.
    const preferredAgentId = resolveAgentTarget(req.body).agentId;
    const archiveOriginal = req.body?.archiveOriginal === true;
    const result = await createCompactedResumeFromHandoff({
      preferredAgentId,
      handoffId,
      handoffPath,
      goal: cleanSessionText(req.body?.goal),
      startRuntime: req.body?.startRuntime !== false,
    });

    // 服务端归档原会话
    let didArchive = false;
    let archiveError = '';
    if (archiveOriginal && result?.handoff?.sourceSessionId) {
      const archiveAgentId = preferredAgentId || result.handoff.sourceAgentId;
      if (archiveAgentId) {
        try {
          await archivePrebuiltSession(archiveAgentId, result.handoff.sourceSessionId, true);
          didArchive = true;
        } catch (err) {
          archiveError = err instanceof Error ? err.message : String(err);
          console.error('[compacted_resume] failed to archive original session:', err);
        }
      }
    }

    res.json({
      ...result,
      archive: {
        requested: archiveOriginal,
        succeeded: archiveOriginal ? didArchive : null,
        error: archiveError || null,
      },
    });

    // 血缘继承：sourceSessionId 来自 handoff 包
    if (notifySessionLineage && result?.session?.id && result?.handoff?.sourceSessionId) {
      notifySessionLineage({
        agentId: preferredAgentId || result.handoff.sourceAgentId,
        fromSessionId: result.handoff.sourceSessionId,
        toSessionId: result.session.id,
        reason: 'summary',
        archived: didArchive,
      }).catch((err) => console.error('[compacted_resume] lineage notification failed:', err));
    }
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/context_handoffs/compact_and_resume', express.json(), async (req, res, next) => {
  const target = (() => {
    try {
      return resolveSessionTarget({ agentId: req.body?.agentId, sessionId: req.body?.sessionId });
    } catch (error) {
      return { error };
    }
  })();
  if (target.error) {
    res.status(target.error.status || 400).json({ error: target.error.message, code: target.error.code });
    return;
  }
  const requestMetadata = readOperationMetadata(req);
  const trace = createOperationTrace({
    ...requestMetadata,
    operationId: requestMetadata.operationId,
    operation: req.body?.reason === 'trim' ? 'trim_session' : 'compact_session',
    agentId: req.body?.agentId,
    sessionId: req.body?.sessionId,
  });
  trace.mark('server_received');
  let onClientClosed = null;
  try {
    const { agentId: preferredAgentId, sessionId } = target;

    // ADR-0011：远程命名空间身份 → 转发远程同名压缩续聊路由（裸 id，压缩、
    // 新会话创建与激活全部发生在远程端）；本地身份走下方既有路径，行为字节级
    // 不动。远程写强制幂等键（本地路径保持现状不强制）。
    try {
      const hostTarget = resolveForwardHostTarget(preferredAgentId, sessionId);
      if (hostTarget.scope === 'remote') {
        if (!requireRemoteIdempotencyKey(req, res, trace)) return;
        return await forwardProtoclawRoute(res, hostTarget, '/protoclaw/context_handoffs/compact_and_resume', {
          method: 'POST',
          body: {
            ...(req.body || {}),
            agentId: bareId(preferredAgentId),
            sessionId: bareId(sessionId),
          },
        });
      }
    } catch (error) {
      attachOperationMetadata(error, requestMetadata);
      trace.mark('failed', { errorCode: error?.code || 'compact_failed' });
      return res.status(readForwardTargetError(error)).json(buildLocalFailureResponse(error, requestMetadata));
    }

    // T003：上下文变换只能作用于 Thread 当前 head。目标是 Thread 历史 Session 时
    // 返回明确的 stale_session 过期目标错误（附 Thread ID 与当前 head），不静默
    // 改写成 head、不启动接力。非 Thread Session（standalone）保持原 Session 语义。
    const transformTarget = await resolveTransformationTarget({
      agentId: preferredAgentId,
      sessionId,
      memberLookup: _memberLookup,
    });
    if (!transformTarget.ok && transformTarget.code === 'stale_session') {
      // 直接以 409 统一形状返回（不经全局错误处理器——那里会丢弃 target 附加块）：
      // 调用方拿到 Thread ID 与当前 head，可据此重定向到当前 head 发起变换。
      trace.mark('failed', { errorCode: 'stale_session' });
      res.status(409).json({
        ok: false,
        code: 'stale_session',
        message: transformTarget.message,
        ..._targetShape(transformTarget),
        operationId: trace.operationId,
      });
      return;
    }

    const detached = req.body?.detached !== false;
    const policy = req.body?.policy || {};
    const archiveOriginal = req.body?.archiveOriginal === true;
    const lineageReason = req.body?.reason === 'trim' ? 'trim' : 'summary';
    const trimCutRounds = typeof req.body?.trimCutRounds === 'number' ? req.body.trimCutRounds : undefined;
    const appendSummary = req.body?.appendSummary === true;
    const requestAbortController = detached ? null : new AbortController();
    onClientClosed = requestAbortController
      ? () => {
          if (!res.writableEnded) {
            requestAbortController.abort(new Error('Compacted resume request was aborted by the client'));
          }
        }
      : null;
    if (onClientClosed) {
      req.once('aborted', onClientClosed);
      res.once('close', onClientClosed);
    }
    console.log(`[compact_and_resume] requested agent=${preferredAgentId || '(auto)'} session=${sessionId} detached=${detached} archive=${archiveOriginal} reason=${lineageReason} appendSummary=${appendSummary}`);

    // 线程交接意图（coder 宿主）：接力期间 inbox 指令保持 pending，不被
    // 投向即将退役的旧 head。公共入口一处标记，detached / 同步分支共用；
    // 提交点（thread-succession）推进 head 时原子清除。非线程宿主 no-op。
    // 挡板写入失败即中断：放行会让交接窗口内的新指令直投即将退役的旧
    // head 并随其退役丢失——显式失败优于静默丢失。
    const successionBegun = await getThreadIntegration().beginSessionSuccession({
      agentId: preferredAgentId,
      sessionId,
      reason: lineageReason,
    });
    if (isSuccessionGateFailure(successionBegun)) {
      const error = new Error(`Thread handoff gate write failed for session=${sessionId}: ${successionBegun.error || 'unknown error'}`);
      error.code = 'thread_handoff_gate_failed';
      error.status = 500;
      throw error;
    }

    // K14：线程历史棒次会话不是合法的 compact 源——begin/apply 对非 head
    // 全部静默 no-op，会产生线程无感知的孤儿 successor。入口显式拒绝，
    // 引导切到当前 head。
    const memberThread = await getThreadIntegration().findThreadBySession(preferredAgentId, sessionId);
    if (memberThread && memberThread.headSessionId !== sessionId) {
      const error = new Error(`Session ${sessionId} is a historical thread generation; open the current head session to compact`);
      error.code = 'session_not_head';
      error.status = 409;
      throw error;
    }

    // R8：线程域手动接力同样退役旧 head runtime——export 镜像读 session
    // 文件，不先 stop/flush 会基于过期快照生成失真摘要，successor 接线也
    // 不该与旧 runtime 并存。只在挡板立起后执行（纯 session 的手动 compact
    // 不得被动停 runtime）；失败不阻断，与 rotation 的 stop 语义一致。
    if (successionBegun.applied) {
      await stopManagedAgent(preferredAgentId, sessionId).catch((err) => {
        console.warn(`[compact_and_resume] failed to retire pre-compact runtime for session=${sessionId}:`, err?.message || err);
      });
    }

    if (detached) {
      const jobId = `compact-resume-${Date.now()}-${randomUUID().slice(0, 8)}`;
      setTimeout(() => {
        compactAndResumeCurrentSession({
          preferredAgentId,
          sessionId,
          policy,
          startRuntime: req.body?.startRuntime !== false,
          appendSummary,
          trace,
        }).then(async (result) => {
          trace.mark('resume_completed', {
            targetSessionId: result?.session?.id || '',
            jobId,
          });
          console.log(`[compact_and_resume] job ${jobId} completed for session=${sessionId} newSession=${result?.session?.id || 'unknown'}`);
          // 线程接力（coder 宿主）：共享提交点（thread-succession）——
          // successor READY 且身份一致才推进 head + 投递暂存指令（no-op for
          // others）；未 READY / 身份失败记录阶段与原因，旧 head 保持有效。
          const commit = threadSuccession
            ? await threadSuccession.commitSuccession({
              agentId: preferredAgentId,
              fromSessionId: sessionId,
              toSessionId: result?.session?.id,
              reason: lineageReason,
              successorReady: result?.agent != null,
            })
            : await getThreadIntegration().applySessionSuccession({
              agentId: preferredAgentId,
              fromSessionId: sessionId,
              toSessionId: result?.session?.id,
              reason: lineageReason,
            });
          if (!commit.applied && !['no_thread_for_session', 'thread_not_found', 'invalid_succession'].includes(commit.reason)) {
            console.warn(`[compact_and_resume] job ${jobId} thread succession not committed for session=${sessionId}: ${commit.reason} (${commit.stage || ''})`);
          }
          // R8：推进失败（applied=false + handoff_failed）时线程仍指向原会话，
          // 归档会挖掉线程的 head——跳过归档。
          const successionBlocked = commit?.applied === false
            && commit?.reason === 'handoff_failed';
          // 服务端归档原会话
          let didArchive = false;
          if (archiveOriginal && preferredAgentId && !successionBlocked) {
            try {
              await archivePrebuiltSession(preferredAgentId, sessionId, true, { includeSessions: false });
              didArchive = true;
            } catch (err) {
              console.error('[compact_and_resume] failed to archive original session:', err);
            }
          }
          // 血缘继承
          if (notifySessionLineage && result?.session?.id) {
            notifySessionLineage({ agentId: preferredAgentId, fromSessionId: sessionId, toSessionId: result.session.id, reason: lineageReason, archived: didArchive, ...(trimCutRounds != null ? { trimCutRounds } : {}) })
              .catch((err) => console.error('[compact_and_resume] lineage notification failed:', err));
          }
        }).catch(async (error) => {
          console.error(`[compact_and_resume] job ${jobId} failed for session=${sessionId}:`, error);
          trace.mark('failed', {
            errorCode: error?.code || 'compact_failed',
            errorMessage: error instanceof Error ? error.message : String(error),
            jobId,
          });
          // T002：detached 生成失败也要收敛线程交接——记录失败阶段（错误
          // code，生成阶段缺省 compact_or_successor）+ 收敛挡板；旧 head
          // 保持有效。共享提交点缺席时走 integration 兜底（K3 守卫下对
          // 未立挡板场景 no-op）。非线程宿主 no-op。
          const failureDetail = error instanceof Error ? error.message : String(error);
          if (threadSuccession && typeof threadSuccession.failSuccession === 'function') {
            threadSuccession.failSuccession({
              agentId: preferredAgentId,
              fromSessionId: sessionId,
              reason: 'compact_failed',
              stage: error?.code || 'compact_or_successor',
              error: failureDetail,
            }).catch((failure) => {
              console.error('[compact_and_resume] failed to persist succession failure:', failure?.message || failure);
            });
          } else {
            await getThreadIntegration().failSessionSuccession({
              agentId: preferredAgentId,
              sessionId,
              reason: 'compact_failed',
              stage: error?.code || 'compact_or_successor',
              error: failureDetail,
            }).catch((failure) => {
              console.error('[compact_and_resume] failed to persist rotation_failed:', failure?.message || failure);
            });
          }
        });
      }, 10);

      res.json({
        protocolVersion: 2,
        operationId: trace.operationId,
        scheduled: true,
        jobId,
        sessionId,
        agentId: preferredAgentId || null,
      });
      trace.mark('response_sent');
      return;
    }

    const result = await compactAndResumeCurrentSession({
      signal: requestAbortController?.signal || null,
      preferredAgentId,
      sessionId,
      policy,
      startRuntime: req.body?.startRuntime !== false,
      appendSummary,
      trace,
    });
    trace.mark('resume_completed', { targetSessionId: result?.session?.id || '' });
    console.log(`[compact_and_resume] completed session=${sessionId} newSession=${result?.session?.id || 'unknown'}`);

    // 线程接力（coder 宿主）：共享提交点（thread-succession）——successor
    // READY 且身份一致才推进 head + 投递暂存指令（no-op for others）；
    // 未 READY / 身份失败记录阶段与原因，旧 head 保持有效。放在响应前：
    // 前端拿到响应即导航到新会话并刷新线程状态，需保证 head 已推进（或
    // 失败已收敛），避免徽标短暂指向旧会话。
    const successionOutcome = threadSuccession
      ? await threadSuccession.commitSuccession({
        agentId: preferredAgentId,
        fromSessionId: sessionId,
        toSessionId: result?.session?.id,
        reason: lineageReason,
        successorReady: result?.agent != null,
      })
      : await getThreadIntegration().applySessionSuccession({
        agentId: preferredAgentId,
        fromSessionId: sessionId,
        toSessionId: result?.session?.id,
        reason: lineageReason,
      });
    // R8：推进失败（applied=false + handoff_failed）时线程仍指向原会话，
    // 归档会挖掉线程的 head——跳过归档并写明原因。
    const successionBlocked = successionOutcome?.applied === false
      && successionOutcome?.reason === 'handoff_failed';

    // 服务端归档原会话
    let didArchive = false;
    let archiveError = '';
    let archiveResult = null;
    if (archiveOriginal && preferredAgentId) {
      if (successionBlocked) {
        archiveError = 'thread succession failed; archive skipped to keep the thread head';
        console.warn(`[compact_and_resume] skipping archive for session=${sessionId}: ${archiveError}`);
      } else {
        try {
          archiveResult = await archivePrebuiltSession(preferredAgentId, sessionId, true, { includeSessions: false });
          didArchive = true;
        } catch (err) {
          archiveError = err instanceof Error ? err.message : String(err);
          console.error('[compact_and_resume] failed to archive original session:', err);
        }
      }
    }

    const finalIndex = preferredAgentId ? await readSessionIndex(preferredAgentId) : null;
    const targetSessionId = cleanSessionText(result?.session?.id);
    const deltaIds = new Set([targetSessionId, archiveOriginal ? sessionId : ''].filter(Boolean));
    const deltaUpserts = Array.isArray(finalIndex?.sessions)
      ? finalIndex.sessions.filter((session) => deltaIds.has(session.id))
      : (result?.session ? [result.session] : []);
    const finalRevision = archiveResult?.revision || finalIndex?.revision || 0;

    res.json({
      protocolVersion: 2,
      operationId: trace.operationId,
      revision: finalRevision,
      ...result,
      threadSuccession: successionOutcome,
      sessionDelta: {
        revision: finalRevision,
        activeSessionId: finalIndex?.activeSessionId || targetSessionId || null,
        upsert: deltaUpserts,
        remove: [],
      },
      archive: {
        requested: archiveOriginal,
        succeeded: archiveOriginal ? didArchive : null,
        error: archiveError || null,
      },
    });
    trace.mark('response_sent', { revision: finalRevision });

    // 血缘继承
    if (notifySessionLineage && result?.session?.id) {
      notifySessionLineage({ agentId: preferredAgentId, fromSessionId: sessionId, toSessionId: result.session.id, reason: lineageReason, archived: didArchive, ...(trimCutRounds != null ? { trimCutRounds } : {}) })
        .catch((err) => console.error('[compact_and_resume] lineage notification failed:', err));
    }
  } catch (error) {
    attachOperationMetadata(error, requestMetadata);
    trace.mark('failed', {
      errorCode: error?.code || 'compact_failed',
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    // T002：生成阶段抛错（handoff 导出 / successor 创建失败）且挡板已写入时
    // 收敛交接——记录失败阶段 + 清除挡板，旧 head 保持有效。failSuccession
    // 底层即 integration 的 failSessionSuccession，此处直接走 integration
    // 兜底：K3 守卫对未立挡板场景 no-op；target 在 try 外声明，catch 内
    // 不引用 try 作用域标识。detached 分支的生成失败在各自 catch 内收敛。
    await getThreadIntegration().failSessionSuccession({
      agentId: target?.agentId || '',
      sessionId: target?.sessionId || '',
      reason: 'compact_failed',
      stage: error?.code || 'compact_or_successor',
      error: error instanceof Error ? error.message : String(error),
    }).catch((failure) => {
      console.error('[compact_and_resume] failed to persist rotation_failed:', failure?.message || failure);
    });
    next(error);
  } finally {
    if (onClientClosed) {
      req.off('aborted', onClientClosed);
      res.off('close', onClientClosed);
    }
  }
});

app.post('/protoclaw/prebuilt_sessions/activate', express.json(), async (req, res, next) => {
  const requestMetadata = readOperationMetadata(req);
  const trace = createOperationTrace({
    ...requestMetadata,
    operationId: requestMetadata.operationId,
    operation: 'activate_session',
    agentId: req.body?.agentId,
    sessionId: req.body?.sessionId,
  });
  trace.mark('server_received');
  try {
    const { agentId, sessionId } = resolveSessionTarget(req.body);
    // ADR-0011：远程命名空间身份 → 转发远程同名 activate 路由（裸 id，远程端
    // startManagedAgent 启动 runtime，经 Phase 1.5 投影自动回到本地侧栏）；
    // 本地身份走下方既有激活路径，行为字节级不动。远程写强制幂等键。
    try {
      const hostTarget = resolveForwardHostTarget(agentId, sessionId);
      if (hostTarget.scope === 'remote') {
        if (!requireRemoteIdempotencyKey(req, res, trace)) return;
        return await forwardProtoclawRoute(res, hostTarget, '/protoclaw/prebuilt_sessions/activate', {
          method: 'POST',
          body: {
            ...(req.body || {}),
            agentId: bareId(agentId),
            sessionId: bareId(sessionId),
          },
        });
      }
    } catch (error) {
      attachOperationMetadata(error, requestMetadata);
      trace.mark('failed', { errorCode: error?.code || 'activate_failed' });
      return res.status(readForwardTargetError(error)).json(buildLocalFailureResponse(error, requestMetadata));
    }
    const agent = await requireAgentLight(agentId);
    // T003：历史 Session 的 activate 只允许浏览 / 挂载视角，不改变 head。
    // 解析目标归属：Thread 成员时附统一目标形状（实际对象 = Thread）；
    // 历史成员标记 browseOnly=true——挂载运行以便只读查看，但绝不推进
    // Thread head（head 只由上下文变换的接力提交点推进，见 thread-succession）。
    const activateTarget = await resolveLifecycleTarget({
      agentId: agent.id,
      sessionId,
      memberLookup: _memberLookup,
    });
    const browseOnly = activateTarget.ok && isBrowseOnlyMount(activateTarget);
    const session = await activatePrebuiltSession(agent.id, sessionId, { returnSummary: false });
    const committedIndex = await readSessionIndex(agent.id);
    trace.mark('index_committed', { revision: committedIndex.revision });
    const status = await startManagedAgent(agent, session.id);
    trace.mark('target_runtime_started');
    consumeRecoverySession(agent.id, session.id);
    res.json({
      protocolVersion: 2,
      operationId: trace.operationId,
      revision: committedIndex.revision,
      session,
      sessionDelta: {
        revision: committedIndex.revision,
        activeSessionId: committedIndex.activeSessionId,
        upsert: [session],
        remove: [],
      },
      status,
      targetSessionId: session.id,
      targetStatus: status,
      agent: null,
      browseOnly: browseOnly || null,
      ..._targetShape(activateTarget),
    });
    trace.mark('response_sent');
  } catch (error) {
    attachOperationMetadata(error, requestMetadata);
    trace.mark('failed', { errorCode: error?.code || 'activate_failed' });
    next(error);
  }
});

app.post('/protoclaw/prebuilt_sessions/delete', express.json(), async (req, res, next) => {
  const requestMetadata = readOperationMetadata(req);
  const trace = createOperationTrace({
    ...requestMetadata,
    operationId: requestMetadata.operationId,
    operation: 'delete_session',
    agentId: req.body?.agentId,
    sessionId: req.body?.sessionId,
  });
  trace.mark('server_received');
  try {
    const { agentId, sessionId } = resolveSessionTarget(req.body);
    // ADR-0011：远程命名空间身份 → 转发远程同名删除路由（裸 id，远程端做
    // 自己的收口与索引删除）；本地身份走下方既有删除路径，行为字节级不动。
    // 远程写强制幂等键。
    try {
      const hostTarget = resolveForwardHostTarget(agentId, sessionId);
      if (hostTarget.scope === 'remote') {
        if (!requireRemoteIdempotencyKey(req, res, trace)) return;
        return await forwardProtoclawRoute(res, hostTarget, '/protoclaw/prebuilt_sessions/delete', {
          method: 'POST',
          body: {
            ...(req.body || {}),
            agentId: bareId(agentId),
            sessionId: bareId(sessionId),
          },
        });
      }
    } catch (error) {
      attachOperationMetadata(error, requestMetadata);
      trace.mark('failed', { errorCode: error?.code || 'delete_failed' });
      return res.status(readForwardTargetError(error)).json(buildLocalFailureResponse(error, requestMetadata));
    }
    const agent = await requireAgentLight(agentId);

    let assemblyRuntime = null;
    if (agent.id === 'agent-creator' || agent.id === 'flow-workspace') {
      assemblyRuntime = await stopAssemblyRuntime(sessionId);
    }
    const deletedRecord = await requirePrebuiltSessionRecord(agent.id, sessionId);
    // T005：删除按 Thread 成员关系解析（统一入口，复用 T003 的
    // resolveLifecycleTarget）。Thread 成员（root / historical / head）不能
    // 单独删除 Session——删除的是工作容器本身（级联清理其 Session / handoff /
    // Inbox / 执行记录 / record）；独立 Session（如 main）保持原删除语义。
    const lifecycleTarget = await resolveLifecycleTarget({
      agentId: agent.id,
      sessionId,
      memberLookup: _memberLookup,
    });
    if (lifecycleTarget.ok && lifecycleTarget.actual.type === 'thread') {
      if (!threadDelete || typeof threadDelete.deleteThread !== 'function') {
        trace.mark('failed', { errorCode: 'thread_delete_not_wired' });
        res.status(503).json({
          ok: false,
          code: 'thread_delete_not_wired',
          message: 'Thread delete is not wired on this server; thread members cannot be deleted individually',
          ..._targetShape(lifecycleTarget),
          operationId: trace.operationId,
        });
        return;
      }
      // 历史 Session 发起删除 → 实际对象是所属 Thread（响应以 Thread 为主体，
      // 保留原请求目标，调用方不会误以为「Session 成功、Thread 未变化」）。
      // 部分失败返回结构化残留（cleanup.failures），不伪装成功。
      const deleteResult = await threadDelete.deleteThread(lifecycleTarget.actual.id, {
        reason: 'session_delete_redirect',
      });
      trace.mark('thread_delete_complete', { status: deleteResult.status });
      res.json({
        ok: deleteResult.status === 'complete',
        code: deleteResult.status === 'complete' ? 'thread_deleted' : 'thread_delete_partial',
        deleted: deleteResult.deleted,
        idempotent: deleteResult.idempotent === true,
        threadId: deleteResult.threadId,
        status: deleteResult.status,
        cleanup: deleteResult.cleanup,
        failures: deleteResult.cleanup?.failures || [],
        ..._targetShape(lifecycleTarget),
        deletedSessionId: sessionId,
        operationId: trace.operationId,
      });
      trace.mark('response_sent');
      return;
    }
    const deletedRuntime = getAgentRuntime(agent.id, sessionId);
    const deleted = await deletePrebuiltSession(agent.id, sessionId, {
      includeSessions: req.body.responseMode !== 'delta',
    });
    // 线程宿主：被删会话是线程 head 时收口该线程；非宿主 / 非 head / 无线程：no-op。
    await getThreadIntegration().onSessionDeleted(agent.id, sessionId);
    if (deletedRuntime?.viewerAgentId && clearUISurfaces) {
      clearUISurfaces(deletedRuntime.viewerAgentId);
    }
    trace.mark('index_committed', { revision: deleted.revision });
    let connected = null;

    if (deletedRuntime?.process && deletedRuntime.process.exitCode === null && !deletedRuntime.stopped) {
      trace.mark('source_stop_requested');
      await stopManagedAgent(agent.id, sessionId);
    }

    const targetSessionId = deleted.wasActiveSession ? (deleted.activeSessionId || null) : null;
    let targetStatus = null;
    let targetStartupError = null;
    if (targetSessionId) {
      try {
        targetStatus = await startManagedAgent(agent, targetSessionId);
      } catch (error) {
        targetStartupError = String(error?.message || error);
      }
    }
    res.json({
      deleted,
      agent: connected,
      assemblyRuntime,
      targetSessionId,
      targetStatus,
      targetStartupError,
      operationId: trace.operationId,
    });
    trace.mark('response_sent');
  } catch (error) {
    trace.mark('failed', { errorCode: error?.code || 'delete_failed' });
    next(error);
  }
});

app.post('/protoclaw/prebuilt_sessions/archive', express.json(), async (req, res, next) => {
  const requestMetadata = readOperationMetadata(req);
  const trace = createOperationTrace({
    ...requestMetadata,
    operationId: requestMetadata.operationId,
    operation: 'archive_session',
    agentId: req.body?.agentId,
    sessionId: req.body?.sessionId,
  });
  trace.mark('server_received');
  try {
    const { agentId, sessionId } = resolveSessionTarget(req.body);
    // ADR-0011：远程命名空间身份 → 转发远程同名归档路由（裸 id，coder 线程
    // 收口等生命周期语义由远程端裁决）；本地身份走下方既有归档路径，行为
    // 字节级不动。远程写强制幂等键。
    try {
      const hostTarget = resolveForwardHostTarget(agentId, sessionId);
      if (hostTarget.scope === 'remote') {
        if (!requireRemoteIdempotencyKey(req, res, trace)) return;
        return await forwardProtoclawRoute(res, hostTarget, '/protoclaw/prebuilt_sessions/archive', {
          method: 'POST',
          body: {
            ...(req.body || {}),
            agentId: bareId(agentId),
            sessionId: bareId(sessionId),
          },
        });
      }
    } catch (error) {
      attachOperationMetadata(error, requestMetadata);
      trace.mark('failed', { errorCode: error?.code || 'archive_failed' });
      return res.status(readForwardTargetError(error)).json(buildLocalFailureResponse(error, requestMetadata));
    }
    const agent = await requireAgentLight(agentId);
    const sessionRecord = await requirePrebuiltSessionRecord(agent.id, sessionId);
    const archived = req.body.archived !== false;
    // T003：目标按 Thread 成员关系解析（统一入口），不再按 sessionType 特判——
    // Thread 成员（head / 历史）的归档 / 恢复定位所属 Thread 执行 Thread 语义；
    // 独立 Session 保持原语义。响应附统一目标形状，主体为实际生效对象。
    const lifecycleTarget = await resolveLifecycleTarget({
      agentId: agent.id,
      sessionId,
      memberLookup: _memberLookup,
    });
    if (lifecycleTarget.ok && lifecycleTarget.actual.type === 'thread') {
      if (archived) {
        const threadResult = await threadLifecycle.archiveThread(lifecycleTarget.actual.id, { reason: 'session_archive_redirect' });
        res.json({
          ...threadResult,
          ..._targetShape(lifecycleTarget),
          archivedSessionId: sessionId,
          archived: true,
          operationId: trace.operationId,
        });
        trace.mark('response_sent');
        return;
      }
      const threadResult = await threadLifecycle.unarchiveThread(lifecycleTarget.actual.id);
      res.json({
        ...threadResult,
        ..._targetShape(lifecycleTarget),
        archivedSessionId: sessionId,
        archived: false,
        operationId: trace.operationId,
      });
      trace.mark('response_sent');
      return;
    }
    const result = await archivePrebuiltSession(agent.id, sessionId, archived, {
      includeSessions: req.body.responseMode !== 'delta',
    });
    trace.mark('index_committed', { revision: result.revision });
    // 只有归档的是 active 会话才接力启动后继；归档非 active 会话不得
    // 拉起一个用户从未要求运行的 activeSessionId（可能早已停止）。
    const targetSessionId = archived && result.wasActiveSession
      ? (result.activeSessionId || null)
      : null;
    let targetStatus = null;
    let targetStartupError = null;
    if (targetSessionId) {
      try {
        targetStatus = await startManagedAgent(agent, targetSessionId);
      } catch (error) {
        targetStartupError = String(error?.message || error);
      }
    }
    res.json({ ...result, ..._targetShape(lifecycleTarget), targetSessionId, targetStatus, targetStartupError, operationId: trace.operationId });
    trace.mark('response_sent');

    // 归档状态变化通知关联群聊；线程投影仍以 session index 的实时状态为准。
    if (notifySessionArchived) {
      notifySessionArchived({ agentId: agent.id, sessionId, archived })
        .catch((err) => console.error('[archive] notification failed:', err));
    }
  } catch (error) {
    trace.mark('failed', { errorCode: error?.code || 'archive_failed' });
    next(error);
  }
});

app.post('/protoclaw/prebuilt_sessions/todo', express.json(), async (req, res, next) => {
  try {
    const { agentId, sessionId } = resolveSessionTarget(req.body);
    // ADR-0011：远程命名空间身份 → 转发远程同名 todo 设置路由（裸 id）；本地
    // 身份走下方既有索引标记路径，行为字节级不动。远程写强制幂等键（本地
    // 路径保持现状不强制）。
    try {
      const hostTarget = resolveForwardHostTarget(agentId, sessionId);
      if (hostTarget.scope === 'remote') {
        if (!requireRemoteIdempotencyKey(req, res)) return;
        return await forwardProtoclawRoute(res, hostTarget, '/protoclaw/prebuilt_sessions/todo', {
          method: 'POST',
          body: {
            ...(req.body || {}),
            agentId: bareId(agentId),
            sessionId: bareId(sessionId),
          },
        });
      }
    } catch (error) {
      return res.status(readForwardTargetError(error)).json(buildLocalFailureResponse(error));
    }
    const agent = await requireAgentLight(agentId);
    const todo = req.body.todo !== false;
    const result = await tagPrebuiltSessionTodo(agent.id, sessionId, todo, {
      includeSessions: req.body.responseMode !== 'delta',
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// ── Session meta sync: runtime child process pushes fresh metadata after save ──
app.post('/protoclaw/session_meta_sync', express.json(), async (req, res, next) => {
  try {
    const agentId = cleanSessionText(req.body?.agentId);
    const sessionId = cleanSessionText(req.body?.sessionId);
    if (!agentId || !sessionId) {
      res.status(400).json({ error: 'agentId and sessionId are required' });
      return;
    }
    const sessionPath = getPrebuiltSessionFilePath(agentId, sessionId);
    let stat;
    try {
      stat = await fs.stat(sessionPath);
    } catch {
      res.status(404).json({ error: 'session file not found' });
      return;
    }

    const messageCount = typeof req.body.messageCount === 'number' ? req.body.messageCount : 0;
    const preview = cleanSessionText(req.body.preview);
    const tokenUsage = req.body.tokenUsage || { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    const savedAt = typeof req.body.savedAt === 'number' ? req.body.savedAt : stat.mtimeMs;
    const modelPatch = {};
    const modelName = cleanSessionText(req.body.modelName);
    const contextLength = Number(req.body.contextLength);
    const compressRatio = Number(req.body.compressRatio);
    if (modelName) modelPatch.modelName = modelName;
    if (Number.isFinite(contextLength) && contextLength > 0) modelPatch.contextLength = contextLength;
    if (Number.isFinite(compressRatio) && compressRatio > 0) modelPatch.compressRatio = compressRatio;

    await updateSessionIndex(agentId, (index) => {
      const sessions = index.sessions.map((s) => {
        if (s.id !== sessionId) return s;
        return {
          ...s,
          fileMtimeMs: stat.mtimeMs,
          fileSize: stat.size,
          messageCount,
          preview,
          tokenUsage,
          ...modelPatch,
          savedAt,
          metaVersion: META_VERSION,
          updatedAt: new Date(savedAt).toISOString(),
          // Auto-clear todo when session is actively producing new data
          todo: false,
        };
      });
      return { ...index, sessions };
    });

    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});
}
