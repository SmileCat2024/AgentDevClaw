import path from 'path';
import os from 'os';
import { promises as fs } from 'fs';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';

import {
  USER_DATA_ROOT,
  MIRROR_SCRIPT_TIMEOUT_MS,
  SPAWN_AGENT_TIMEOUT_MS,
  REQ_TIMEOUT_BUFFER_MS,
} from '../shared/constants.js';
import { normalizePathCasing } from '../shared/fs-helpers.js';
import { consumeRecoverySession } from '../shared/open-sessions-tracker.js';
import {
  cleanSessionText,
  normalizeClientAgentId,
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
import { readHandoffPackage } from '../context-continuity/handoff-package.js';
import { createOperationTrace } from '../shared/operation-trace.js';
import { recordSidebarDiagnosticEvent } from '../shared/sidebar-diagnostics.js';
import { META_VERSION } from './session-helpers.js';
import { setupTokenRefreshRoute } from './session-token-refresh.js';
import { getThreadIntegration } from '../thread-control/thread-integration.js';

// server.js lives at project root; this module is at server/routes/session.js
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

/**
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
    buildExplorationHandoffPayload,
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
    lockExplorationSession,
    requirePrebuiltAgentForRuntime,
    requirePrebuiltSessionRecord,
    resolvePrebuiltSessionOwner,
    searchSessionsContent,
    setSessionHasSummary,
    tagPrebuiltSessionTodo,
    writeSyntheticHandoff,
    requireAgentLight,
    startManagedAgent,
    startOneShotAgent,
    stopManagedAgent,
    waitForManagedRuntimeReady,
    notifySessionLineage,
    notifySessionArchived,
    clearUISurfaces,
    coderTickets,
  } = ctx;

function normalizeContextGuardState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const thresholdTokens = Number(value.thresholdTokens);
  const inputTokens = Number(value.inputTokens);
  const blockedAt = Number(value.blockedAt);
  return {
    blocked: value.blocked === true,
    blockedAt: Number.isFinite(blockedAt) && blockedAt > 0 ? Math.round(blockedAt) : null,
    thresholdTokens: Number.isFinite(thresholdTokens) && thresholdTokens > 0 ? Math.round(thresholdTokens) : null,
    inputTokens: Number.isFinite(inputTokens) && inputTokens > 0 ? Math.round(inputTokens) : null,
    reason: cleanSessionText(value.reason).slice(0, 1000) || null,
  };
}

// The runtime reports this event before its interrupted call has completed.
// Keeping it separate from session_meta_sync makes the UI feedback immediate.
app.post('/protoclaw/context_guard_event', express.json(), async (req, res, next) => {
  try {
    const agentId = cleanSessionText(req.body?.agentId);
    const sessionId = cleanSessionText(req.body?.sessionId);
    const contextGuard = normalizeContextGuardState(req.body?.contextGuard);
    if (!agentId || !sessionId || !contextGuard?.blocked) {
      res.status(400).json({ error: 'agentId, sessionId, and blocked contextGuard state are required' });
      return;
    }
    let found = false;
    await updateSessionIndex(agentId, (index) => {
      const sessions = index.sessions.map((session) => {
        if (session.id !== sessionId) return session;
        found = true;
        return { ...session, contextGuard, updatedAt: new Date().toISOString() };
      });
      return { ...index, sessions };
    });
    if (!found) {
      res.status(404).json({ error: 'session not found' });
      return;
    }
    if (agentId === 'coder' && coderTickets) {
      void coderTickets.handleContextGuard(agentId, sessionId).catch((error) => {
        console.error('[coder-tickets] context rotation failed:', error.message);
      });
    }
    res.json({ ok: true, contextGuard });
  } catch (error) {
    next(error);
  }
});

// A Claw-owned read endpoint: ViewerWorker notification data does not include
// local Feature state, so the client reads the persisted guard state alongside it.
app.get('/protoclaw/context_guard_status', async (req, res, next) => {
  try {
    const agentId = cleanSessionText(req.query.agentId);
    const sessionId = cleanSessionText(req.query.sessionId);
    if (!agentId || !sessionId) {
      res.status(400).json({ error: 'agentId and sessionId are required' });
      return;
    }
    const index = await readSessionIndex(agentId);
    const session = index.sessions.find((item) => item.id === sessionId);
    if (!session) {
      res.status(404).json({ error: 'session not found' });
      return;
    }
    res.json({
      agentId,
      sessionId,
      contextGuard: normalizeContextGuardState(session.contextGuard),
    });
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
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      })),
    });
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/render_conversation', express.json(), async (req, res, next) => {
  try {
    const { sessionId, agentId, lastNCalls } = req.body || {};
    if (!sessionId || typeof sessionId !== 'string') {
      res.status(400).json({ error: 'sessionId is required' });
      return;
    }
    const resolvedAgentId = (typeof agentId === 'string' && agentId) || 'qqbot';
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
  const trace = createOperationTrace({
    operationId: req.body?.operationId,
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
    const force = !!req.body?.force;
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
    const agentDir = path.join('prebuilt-agents', 'official', agentId);
    const resultPath = path.join(os.tmpdir(), `compact-mirror-${Date.now()}.json`);

    // Resolve sessionType from the workspace session index first; session files may not carry the product-level type.
    const sessionType = await resolvePrebuiltSessionType(agentId, sessionId);

    const args = [
      path.join(PROJECT_ROOT, 'scripts', 'run-compact-mirror.js'),
      agentDir,
      agentId,
      sessionId,
      JSON.stringify({ sessionType, maxAttempts: 1 }),
      resultPath,
    ];
    const output = await new Promise((resolve, reject) => {
      const child = spawn('node', args, { cwd: PROJECT_ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timeoutMs = MIRROR_SCRIPT_TIMEOUT_MS;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, timeoutMs);
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) {
          reject(new Error(`Compact mirror timed out after ${timeoutMs}ms${stderr.trim() ? `\n${stderr.trim()}` : ''}`));
          return;
        }
        if (code !== 0) reject(new Error(stderr || stdout || `compact mirror exited with code ${code}`));
        else resolve(stdout);
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    console.log('[generate_summary] compact mirror output:', output?.slice(0, 200));
    const result = await fs.readFile(resultPath, 'utf8').then(JSON.parse).catch(() => null);
    if (!result?.ok || !result.summaryText) {
      res.status(500).json({ error: 'Compact mirror did not produce a valid summary' });
      return;
    }
    await exportProvidedSummaryHandoff({
      preferredAgentId: agentId,
      sessionId,
      summaryText: result.summaryText,
      rawResponse: result.rawResponse || '',
      importantFiles: result.importantFiles || [],
      importantSkills: result.importantSkills || [],
      sessionTitle: result.sessionTitle || '',
    });
    try { await fs.unlink(resultPath); } catch {}
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
  const trace = createOperationTrace({
    operationId: req.body?.operationId,
    operation: 'create_session',
    agentId: req.body?.agentId,
  });
  trace.mark('server_received');
  try {
    const agent = await requireAgentLight(req.body.agentId);
    const session = await createPrebuiltSession(agent.id, {
      returnSummary: false,
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
    // 非 host 工作空间为 no-op；失败不阻断会话创建。
    await getThreadIntegration().onSessionCreated(agent.id, session);
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
    });
    trace.mark('response_sent');
  } catch (error) {
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
      env: childProcessEnv(),
    });

    let stderr = '';
    const timeoutMs = MIRROR_SCRIPT_TIMEOUT_MS;
    let timedOut = false;
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
        if (timedOut) {
          reject(new Error(`Title generation timed out after ${timeoutMs}ms${stderr.trim() ? `\n${stderr.trim()}` : ''}`));
          return;
        }
        if (code !== 0) {
          reject(new Error(stderr.trim() || `run-title-mirror exited with code ${code}`));
          return;
        }
        resolve();
      });
    });

    const raw = await fs.readFile(resultPath, 'utf8');
    const result = JSON.parse(raw.trim());
    await fs.rm(resultDir, { recursive: true, force: true }).catch(e => console.warn(e));

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
      env: childProcessEnv(),
    });

    let stderr = '';
    const timeoutMs = MIRROR_SCRIPT_TIMEOUT_MS;
    let timedOut = false;
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
        if (timedOut) {
          reject(new Error(`Recap generation timed out after ${timeoutMs}ms${stderr.trim() ? `\n${stderr.trim()}` : ''}`));
          return;
        }
        if (code !== 0) {
          reject(new Error(stderr.trim() || `run-recap-mirror exited with code ${code}`));
          return;
        }
        resolve();
      });
    });

    const raw = await fs.readFile(resultPath, 'utf8');
    const result = JSON.parse(raw.trim());
    await fs.rm(resultDir, { recursive: true, force: true }).catch(e => console.warn(e));

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
    const sessionId = cleanSessionText(req.body?.sessionId);
    if (!sessionId) {
      res.status(400).json({ error: 'sessionId is required' });
      return;
    }

    const preferredAgentId = normalizeClientAgentId(req.body?.agentId);
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

    const preferredAgentId = normalizeClientAgentId(req.body?.agentId);
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
// ── Exploration helpers extracted to server/routes/session-helpers.js ──
app.post('/protoclaw/spawn_one_shot', express.json(), async (req, res, next) => {
  try {
    const handoffId = cleanSessionText(req.body?.handoffId);
    const handoffPath = cleanSessionText(req.body?.handoffPath);
    const goal = cleanSessionText(req.body?.goal);
    const timeoutMs = Number(req.body?.timeoutMs) || SPAWN_AGENT_TIMEOUT_MS;
    const explorationIds = Array.isArray(req.body?.explorationIds)
      ? req.body.explorationIds.map(id => cleanSessionText(id)).filter(Boolean)
      : [];

    if (!goal) {
      res.status(400).json({ error: 'goal is required for one-shot spawn' });
      return;
    }

    req.setTimeout(timeoutMs + REQ_TIMEOUT_BUFFER_MS);

    const preferredAgentId = normalizeClientAgentId(req.body?.agentId);
    const agentId = preferredAgentId || 'programming-helper';

    const isExploration = explorationIds.length === 0 && !handoffId && !handoffPath;
    const sessionType = isExploration ? 'exploration' : 'sub';

    let resolvedHandoffPath = null;
    let sourceSessionId = null;
    let handoff = null;

    if (isExploration) {
      sourceSessionId = `__protoclaw-exploration-${Date.now()}__`;
      console.log(`[spawn_one_shot] Exploration mode: no parent context`);
    } else {
      if (explorationIds.length > 0) {
        const handoffPayload = await buildExplorationHandoffPayload(agentId, explorationIds, goal);
        const syntheticPath = await writeSyntheticHandoff(agentId, handoffPayload);
        resolvedHandoffPath = syntheticPath;
        sourceSessionId = explorationIds[0];
        console.log(`[spawn_one_shot] Sub-agent mode: from explorations ${explorationIds.join(',')}`);
      } else {
        if (!handoffId && !handoffPath) {
          res.status(400).json({ error: 'handoffId, handoffPath, or explorationIds required' });
          return;
        }
        const handoffResult = await readHandoffPackage({
          userDataRoot: USER_DATA_ROOT,
          agentId: agentId || '',
          handoffId,
          handoffPath,
        });
        handoff = handoffResult.handoff;
        resolvedHandoffPath = handoffResult.handoffPath;
        const hSourceAgentId = cleanSessionText(handoff?.sourceAgentId);
        sourceSessionId = cleanSessionText(handoff?.sourceSessionId);
        if (!hSourceAgentId || !sourceSessionId) {
          res.status(400).json({ error: 'Invalid handoff: sourceAgentId/sourceSessionId required' });
          return;
        }
      }
    }

    const agent = await requirePrebuiltAgentForRuntime(agentId);
    if (!isExploration && !handoff?.stats?.synthetic && explorationIds.length === 0) {
      await requirePrebuiltSessionRecord(agent.id, sourceSessionId);
    }

    const session = await createPrebuiltSession(agent.id, {
      sourceSessionId,
      goal,
      sessionType,
      metadata: {
        resumeMode: 'one-shot',
        ...(isExploration ? {} : {
          handoffId: cleanSessionText(handoff?.handoffId) || cleanSessionText(handoffId),
          handoffPath: resolvedHandoffPath,
          handoffCreatedAt: cleanSessionText(handoff?.createdAt),
          handoffMode: cleanSessionText(handoff?.mode),
          sourceExplorationIds: explorationIds.length > 0 ? explorationIds : undefined,
        }),
      },
    });

    console.log(`[spawn_one_shot] Starting agent=${agent.id} session=${session.id} type=${sessionType} goal="${goal.slice(0, 80)}"`);

    const { exitCode, result } = await startOneShotAgent(agent, session.id, goal, {
      timeoutMs,
      extraEnv: {
        PROTOCLAW_SESSION_TYPE: sessionType,
        PROTOCLAW_MODEL_PRESET_ROLE: sessionType === 'exploration' ? 'exploration' : 'sub',
        ...(resolvedHandoffPath ? { PROTOCLAW_HANDOFF_PATH: resolvedHandoffPath } : {}),
      },
    });

    console.log(`[spawn_one_shot] Completed agent=${agent.id} session=${session.id} type=${sessionType} ok=${result.ok} duration=${result.durationMs}ms`);

    if (isExploration && result.ok) {
      await lockExplorationSession(agent.id, session.id, goal, result.response);
    }

    res.json({
      session: { id: session.id, title: session.title || null, sessionType },
      result: {
        ok: result.ok,
        response: result.response,
        error: result.error,
        durationMs: result.durationMs,
      },
      exitCode,
    });
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/resume_sub', express.json(), async (req, res, next) => {
  try {
    const subSessionId = cleanSessionText(req.body?.sessionId);
    const message = cleanSessionText(req.body?.message);
    const timeoutMs = Number(req.body?.timeoutMs) || SPAWN_AGENT_TIMEOUT_MS;

    if (!subSessionId || !message) {
      res.status(400).json({ error: 'sessionId and message are required' });
      return;
    }

    req.setTimeout(timeoutMs + REQ_TIMEOUT_BUFFER_MS);

    const agentId = 'programming-helper';
    const agent = await requirePrebuiltAgentForRuntime(agentId);

    await updateSessionIndex(agentId, (index) => {
      const record = index.sessions.find(s => s.id === subSessionId);
      if (!record) {
        throw Object.assign(new Error(`Session ${subSessionId} not found`), { statusCode: 404 });
      }
      if (record.sessionType === 'exploration') {
        throw Object.assign(new Error('Cannot resume an exploration session (it is locked)'), { statusCode: 400 });
      }
      if (record.sessionType !== 'sub') {
        throw Object.assign(new Error(`Session ${subSessionId} is not a sub-agent session (type=${record.sessionType})`), { statusCode: 400 });
      }

      record.sessionType = 'sub';
      record.updatedAt = new Date().toISOString();
      return { ...index };
    });

    console.log(`[resume_sub] Resuming sub-agent session=${subSessionId} message="${message.slice(0, 80)}"`);

    const { exitCode, result } = await startOneShotAgent(agent, subSessionId, message, {
      timeoutMs,
      extraEnv: {
        PROTOCLAW_MODEL_PRESET_ROLE: 'sub',
      },
    });

    console.log(`[resume_sub] Completed session=${subSessionId} ok=${result.ok} duration=${result.durationMs}ms`);

    res.json({
      session: { id: subSessionId },
      result: {
        ok: result.ok,
        response: result.response,
        error: result.error,
        durationMs: result.durationMs,
      },
      exitCode,
    });
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/context_handoffs/compact_and_resume', express.json(), async (req, res, next) => {
  const trace = createOperationTrace({
    operationId: req.body?.operationId,
    operation: req.body?.reason === 'trim' ? 'trim_session' : 'compact_session',
    agentId: req.body?.agentId,
    sessionId: req.body?.sessionId,
  });
  trace.mark('server_received');
  try {
    const sessionId = cleanSessionText(req.body?.sessionId);
    if (!sessionId) {
      res.status(400).json({ error: 'sessionId is required' });
      return;
    }

    const preferredAgentId = normalizeClientAgentId(req.body?.agentId);
    const detached = req.body?.detached !== false;
    const policy = req.body?.policy || {};
    const archiveOriginal = req.body?.archiveOriginal === true;
    const lineageReason = req.body?.reason === 'trim' ? 'trim' : 'summary';
    const trimCutRounds = typeof req.body?.trimCutRounds === 'number' ? req.body.trimCutRounds : undefined;
    const appendSummary = req.body?.appendSummary === true;
    console.log(`[compact_and_resume] requested agent=${preferredAgentId || '(auto)'} session=${sessionId} detached=${detached} archive=${archiveOriginal} reason=${lineageReason} appendSummary=${appendSummary}`);

    // 线程交接意图（coder 宿主）：接力期间 inbox 指令保持 pending，不被
    // 投向即将退役的旧 head。公共入口一处标记，detached / 同步分支共用；
    // applySessionSuccession 推进 head 时原子清除。非线程宿主 no-op。
    await getThreadIntegration().beginSessionSuccession({
      agentId: preferredAgentId,
      sessionId,
      reason: lineageReason,
    });

    if (detached) {
      const jobId = `compact-resume-${Date.now()}-${randomUUID().slice(0, 8)}`;
      setTimeout(() => {
        compactAndResumeCurrentSession({
          preferredAgentId,
          sessionId,
          policy,
          startRuntime: req.body?.startRuntime !== false,
          appendSummary,
        }).then(async (result) => {
          console.log(`[compact_and_resume] job ${jobId} completed for session=${sessionId} newSession=${result?.session?.id || 'unknown'}`);
          // 线程接力（coder 宿主）：head 推进 + 暂存指令投递（no-op for others）
          await getThreadIntegration().applySessionSuccession({
            agentId: preferredAgentId,
            fromSessionId: sessionId,
            toSessionId: result?.session?.id,
            reason: lineageReason,
          });
          // 服务端归档原会话
          let didArchive = false;
          if (archiveOriginal && preferredAgentId) {
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
        }).catch((error) => {
          console.error(`[compact_and_resume] job ${jobId} failed for session=${sessionId}:`, error);
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
      preferredAgentId,
      sessionId,
      policy,
      startRuntime: req.body?.startRuntime !== false,
      appendSummary,
      trace,
    });
    trace.mark('resume_completed', { targetSessionId: result?.session?.id || '' });
    console.log(`[compact_and_resume] completed session=${sessionId} newSession=${result?.session?.id || 'unknown'}`);

    // 线程接力（coder 宿主）：head 推进 + 暂存指令投递（no-op for others）。
    // 放在响应前：前端拿到响应即导航到新会话并刷新线程状态，需保证
    // head 已推进，避免徽标短暂指向旧会话。
    const threadSuccession = await getThreadIntegration().applySessionSuccession({
      agentId: preferredAgentId,
      fromSessionId: sessionId,
      toSessionId: result?.session?.id,
      reason: lineageReason,
    });

    // 服务端归档原会话
    let didArchive = false;
    let archiveError = '';
    let archiveResult = null;
    if (archiveOriginal && preferredAgentId) {
      try {
        archiveResult = await archivePrebuiltSession(preferredAgentId, sessionId, true, { includeSessions: false });
        didArchive = true;
      } catch (err) {
        archiveError = err instanceof Error ? err.message : String(err);
        console.error('[compact_and_resume] failed to archive original session:', err);
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
      threadSuccession,
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
    trace.mark('failed', { errorCode: error?.code || 'compact_failed' });
    next(error);
  }
});

app.post('/protoclaw/context_handoffs/summary_resume', express.json(), async (req, res, next) => {
  try {
    const sessionId = cleanSessionText(req.body?.sessionId);
    const summaryText = typeof req.body?.summaryText === 'string' ? req.body.summaryText.trim() : '';
    if (!sessionId) {
      res.status(400).json({ error: 'sessionId is required' });
      return;
    }
    if (!summaryText) {
      res.status(400).json({ error: 'summaryText is required' });
      return;
    }

    const preferredAgentId = normalizeClientAgentId(req.body?.agentId);
    const archiveOriginal = req.body?.archiveOriginal === true;
    console.log(`[summary_resume] requested agent=${preferredAgentId || '(auto)'} session=${sessionId}`);

    // 线程交接意图（coder 宿主）：同 compact_and_resume 入口的标记
    await getThreadIntegration().beginSessionSuccession({
      agentId: preferredAgentId,
      sessionId,
      reason: 'summary',
    });

    const result = await compactAndResumeFromProvidedSummary({
      preferredAgentId,
      sessionId,
      summaryText,
      rawResponse: typeof req.body?.rawResponse === 'string' ? req.body.rawResponse : '',
      importantFiles: Array.isArray(req.body?.importantFiles) ? req.body.importantFiles : [],
      importantSkills: Array.isArray(req.body?.importantSkills) ? req.body.importantSkills : [],
      sessionTitle: typeof req.body?.sessionTitle === 'string' ? req.body.sessionTitle : '',
      fileRanges: typeof req.body?.fileRanges === 'object' && req.body.fileRanges !== null ? req.body.fileRanges : {},
      policy: req.body?.policy || {},
      startRuntime: req.body?.startRuntime !== false,
    });
    console.log(`[summary_resume] completed session=${sessionId} newSession=${result?.session?.id || 'unknown'}`);

    // 线程接力（coder 宿主）：head 推进 + 暂存指令投递（no-op for others）
    const threadSuccession = await getThreadIntegration().applySessionSuccession({
      agentId: preferredAgentId,
      fromSessionId: sessionId,
      toSessionId: result?.session?.id,
      reason: 'summary',
    });

    // 服务端归档原会话
    let didArchive = false;
    let archiveError = '';
    if (archiveOriginal && preferredAgentId) {
      try {
        await archivePrebuiltSession(preferredAgentId, sessionId, true);
        didArchive = true;
      } catch (err) {
        archiveError = err instanceof Error ? err.message : String(err);
        console.error('[summary_resume] failed to archive original session:', err);
      }
    }

    res.json({
      ...result,
      threadSuccession,
      archive: {
        requested: archiveOriginal,
        succeeded: archiveOriginal ? didArchive : null,
        error: archiveError || null,
      },
    });

    // 血缘继承
    if (notifySessionLineage && result?.session?.id) {
      notifySessionLineage({ agentId: preferredAgentId, fromSessionId: sessionId, toSessionId: result.session.id, reason: 'summary', archived: didArchive })
        .catch((err) => console.error('[summary_resume] lineage notification failed:', err));
    }
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/context_handoffs/summary_export', express.json(), async (req, res, next) => {
  try {
    const sessionId = cleanSessionText(req.body?.sessionId);
    const summaryText = typeof req.body?.summaryText === 'string' ? req.body.summaryText.trim() : '';
    if (!sessionId) {
      res.status(400).json({ error: 'sessionId is required' });
      return;
    }
    if (!summaryText) {
      res.status(400).json({ error: 'summaryText is required' });
      return;
    }
    const preferredAgentId = normalizeClientAgentId(req.body?.agentId);
    const result = await exportProvidedSummaryHandoff({
      preferredAgentId,
      sessionId,
      summaryText,
      rawResponse: typeof req.body?.rawResponse === 'string' ? req.body.rawResponse : '',
      importantFiles: Array.isArray(req.body?.importantFiles) ? req.body.importantFiles : [],
      importantSkills: Array.isArray(req.body?.importantSkills) ? req.body.importantSkills : [],
      sessionTitle: typeof req.body?.sessionTitle === 'string' ? req.body.sessionTitle : '',
      fileRanges: typeof req.body?.fileRanges === 'object' && req.body.fileRanges !== null ? req.body.fileRanges : {},
      policy: req.body?.policy || {},
      sessionTimestamp: typeof req.body?.sessionTimestamp === 'string' ? req.body.sessionTimestamp : null,
      gitMeta: req.body?.gitMeta && typeof req.body.gitMeta === 'object' ? req.body.gitMeta : null,
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// ═══ Block D (server.js L4710-4834) ═══
app.post('/protoclaw/prebuilt_sessions/activate', express.json(), async (req, res, next) => {
  const trace = createOperationTrace({
    operationId: req.body?.operationId,
    operation: 'activate_session',
    agentId: req.body?.agentId,
    sessionId: req.body?.sessionId,
  });
  trace.mark('server_received');
  try {
    const agent = await requireAgentLight(req.body.agentId);
    if (typeof req.body.sessionId !== 'string' || !req.body.sessionId) {
      res.status(400).json({ error: 'sessionId is required' });
      return;
    }
    const session = await activatePrebuiltSession(agent.id, req.body.sessionId, { returnSummary: false });
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
    });
    trace.mark('response_sent');
  } catch (error) {
    trace.mark('failed', { errorCode: error?.code || 'activate_failed' });
    next(error);
  }
});

app.post('/protoclaw/prebuilt_sessions/delete', express.json(), async (req, res, next) => {
  const trace = createOperationTrace({
    operationId: req.body?.operationId,
    operation: 'delete_session',
    agentId: req.body?.agentId,
    sessionId: req.body?.sessionId,
  });
  trace.mark('server_received');
  try {
    const agent = await requireAgentLight(req.body.agentId);
    if (typeof req.body.sessionId !== 'string' || !req.body.sessionId) {
      res.status(400).json({ error: 'sessionId is required' });
      return;
    }

    let assemblyRuntime = null;
    if (agent.id === 'agent-creator' || agent.id === 'flow-workspace') {
      assemblyRuntime = await stopAssemblyRuntime(req.body.sessionId);
    }
    const deletedRuntime = getAgentRuntime(agent.id, req.body.sessionId);
    const deleted = await deletePrebuiltSession(agent.id, req.body.sessionId, {
      includeSessions: req.body.responseMode !== 'delta',
    });
    // 线程宿主（coder）：被删会话是线程 head 时取消该线程（pending 指令
    // 一并取消）。非宿主 / 非 head / 无线程：no-op。
    await getThreadIntegration().onSessionDeleted(agent.id, req.body.sessionId);
    if (deletedRuntime?.viewerAgentId && clearUISurfaces) {
      clearUISurfaces(deletedRuntime.viewerAgentId);
    }
    trace.mark('index_committed', { revision: deleted.revision });
    let connected = null;

    if (deletedRuntime?.process && deletedRuntime.process.exitCode === null && !deletedRuntime.stopped) {
      trace.mark('source_stop_requested');
      await stopManagedAgent(agent.id, req.body.sessionId);
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
  const trace = createOperationTrace({
    operationId: req.body?.operationId,
    operation: 'archive_session',
    agentId: req.body?.agentId,
    sessionId: req.body?.sessionId,
  });
  trace.mark('server_received');
  try {
    const agent = await requireAgentLight(req.body.agentId);
    if (typeof req.body.sessionId !== 'string' || !req.body.sessionId) {
      res.status(400).json({ error: 'sessionId is required' });
      return;
    }
    const archived = req.body.archived !== false;
    const result = await archivePrebuiltSession(agent.id, req.body.sessionId, archived, {
      includeSessions: req.body.responseMode !== 'delta',
    });
    trace.mark('index_committed', { revision: result.revision });
    const targetSessionId = archived && result.activeSessionId !== req.body.sessionId
      ? result.activeSessionId
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
    res.json({ ...result, targetSessionId, targetStatus, targetStartupError, operationId: trace.operationId });
    trace.mark('response_sent');

    // 归档状态变化通知关联群聊；线程投影仍以 session index 的实时状态为准。
    if (notifySessionArchived) {
      notifySessionArchived({ agentId: agent.id, sessionId: req.body.sessionId, archived })
        .catch((err) => console.error('[archive] notification failed:', err));
    }
  } catch (error) {
    trace.mark('failed', { errorCode: error?.code || 'archive_failed' });
    next(error);
  }
});

app.post('/protoclaw/prebuilt_sessions/todo', express.json(), async (req, res, next) => {
  try {
    const agent = await requireAgentLight(req.body.agentId);
    if (typeof req.body.sessionId !== 'string' || !req.body.sessionId) {
      res.status(400).json({ error: 'sessionId is required' });
      return;
    }
    const todo = req.body.todo !== false;
    const result = await tagPrebuiltSessionTodo(agent.id, req.body.sessionId, todo, {
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
    const contextGuard = req.body.contextGuard && typeof req.body.contextGuard === 'object'
      ? req.body.contextGuard : null;
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
          ...(contextGuard ? { contextGuard } : {}),
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
