import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

import { USER_DATA_ROOT } from '../shared/constants.js';
import {
  sanitizeSessionFragment,
  cleanSessionText,
  normalizeClientAgentId,
} from '../shared/string-helpers.js';
import {
  readSessionIndex,
  updateSessionIndex,
  getPrebuiltAgentSessionDir,
  getPrebuiltSessionFilePath,
  resolvePrebuiltSessionType,
} from '../shared/session-access.js';
import { getAgentRuntime, stopAssemblyRuntime } from '../shared/agent-access.js';
import {
  readModelPresets,
  resolveSessionModelInfo,
} from './model-config.js';
import { renderConversationHtml } from '../conversation-renderer.js';
import { readHandoffPackage } from '../context-continuity/handoff-package.js';
import { META_VERSION } from './session-helpers.js';

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
    tagPrebuiltSessionTodo,
    writeSyntheticHandoff,
    requireAgentLight,
    startManagedAgent,
    startOneShotAgent,
    stopManagedAgent,
    waitForManagedRuntimeReady
  } = ctx;

// ═══ Block A (server.js L3386-3774) ═══
app.get('/protoclaw/prebuilt_sessions', async (req, res, next) => {
  try {
    if (typeof req.query.agentId !== 'string' || !req.query.agentId) {
      res.status(400).json({ error: 'agentId is required' });
      return;
    }
    res.json(await listPrebuiltSessions(req.query.agentId));
  } catch (error) {
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
    res.json({
      sessionId,
      sessionTitle: parsed.title || '',
      contextLength: null,
      rounds,
    });
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/sessions/branch', express.json(), async (req, res, next) => {
  try {
    const agentId = cleanSessionText(req.body?.agentId);
    const sourceSessionId = cleanSessionText(req.body?.sourceSessionId);
    const cutMsgIndexEnd = req.body?.cutMsgIndexEnd;

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
    const branchUserTurns = branchMessages
      .filter(m => m.role === 'user' && typeof m.turn === 'number')
      .map(m => m.turn);
    const branchCpIndices = branchCheckpoints.map(cp => cp.callIndex);
    const missingCheckpoints = branchUserTurns.filter(t => !branchCpIndices.includes(t));
    if (missingCheckpoints.length > 0) {
      console.warn(`[ProtoClaw] Branch from ${sourceSessionId}: user turns [${branchUserTurns.join(',')}] have missing checkpoints for turns [${missingCheckpoints.join(',')}]. Rollback will be unavailable for those turns.`);
    }

    const newSessionId = `session-${Date.now()}-${randomUUID().slice(0, 6)}`;
    const createdAt = new Date().toISOString();

    const branchSnapshot = {
      ...sourceSnapshot,
      sessionId: newSessionId,
      savedAt: Date.now(),
      runtime: {
        ...(sourceSnapshot.runtime || {}),
        initialized: true,
        callIndex: maxUserTurn,
        context: {
          ...(sourceSnapshot.runtime?.context || {}),
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
      ? `${sourceTitle}（分支）`
      : `分支会话 · ${createdAt.replace(/[TZ]/g, ' ').trim()}`;

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
      openDirectory: sourceRecord?.openDirectory || '',
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

    const agent = await requirePrebuiltAgentForRuntime(agentId);
    await startManagedAgent(agent, newSessionId);
    const connected = await waitForManagedRuntimeReady(agent.id, 10000, newSessionId);

    res.json({
      ok: true,
      newSessionId,
      branchTitle,
      keptMessages: branchMessages.length,
      totalMessages: rawMessages.length,
      agent: connected,
    });
  } catch (error) {
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
      res.json({ ok: true, alreadyExists: true });
      return;
    }
    if (existingSummary && force) {
      try {
        const handoffPath = await findSessionSummaryPath(agentId, sessionId);
        if (handoffPath) await fs.unlink(handoffPath).catch(() => {});
      } catch {}
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
      const timeoutMs = 120000;
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

// ═══ Block B (server.js L3888-4046) ═══
// ── Token Count Refresh ────────────────────────────────────────────────────────

app.post('/protoclaw/refresh_session_token_count', express.json(), async (req, res, next) => {
  try {
    const { sessionId, agentId } = req.body || {};
    if (!sessionId || !agentId) {
      return res.status(400).json({ success: false, error: 'Missing sessionId or agentId' });
    }

    // 读取会话索引
    const index = await readSessionIndex(agentId);
    const sessionRecord = index.sessions.find(s => s.id === sessionId);
    if (!sessionRecord) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }

    // 复用 resolveSessionModelInfo 获取模型预设信息
    const modelInfo = await resolveSessionModelInfo(agentId, 'default');
    const presetName = modelInfo.presetName;
    const modelName = modelInfo.modelName;

    if (!presetName || !modelName) {
      return res.status(400).json({
        success: false,
        error: `Cannot determine model preset for agent ${agentId}`,
      });
    }

    // 读取模型预设配置（含 providers 和 countTokenPath）
    const presetsData = await readModelPresets();
    const preset = presetsData.presets.find(p => p.name === presetName);

    if (!preset) {
      return res.status(404).json({ success: false, error: `Model preset not found: ${presetName}` });
    }

    const countTokenPath = preset.countTokenPath || '/v1/messages/count_tokens';

    // 获取 provider 信息
    const provider = presetsData.providers.find(p => p.name === preset.providerName);
    if (!provider) {
      return res.status(404).json({ success: false, error: `Provider not found: ${preset.providerName}` });
    }

    const baseUrl = provider.endpoints?.[preset.protocol] || '';
    if (!baseUrl) {
      return res.status(400).json({ success: false, error: 'Provider base URL not configured' });
    }

    // 构建 count tokens API URL
    const countTokensUrl = baseUrl.replace(/\/+$/, '') + countTokenPath;

    // 读取会话文件中的实际消息
    const sessionPath = path.join(getPrebuiltAgentSessionDir(agentId), `${sanitizeSessionFragment(sessionId)}.json`);
    let sessionData = {};
    let actualMessages = [];
    try {
      sessionData = JSON.parse(await fs.readFile(sessionPath, 'utf8'));
      const rawMessages = sessionData?.runtime?.context?.messages || [];
      // count_tokens 接口只接受 user/assistant 角色
      // system 角色的内容合并到第一条 user 消息前
      // tool 角色映射为 user（tool_result 嵌入 user message）
      let systemParts = [];
      for (const m of rawMessages) {
        if (!m || m.content == null) continue;
        if (m.role === 'system') {
          systemParts.push(typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
          continue;
        }
        let content;
        if (typeof m.content === 'string') {
          content = m.content;
        } else if (Array.isArray(m.content)) {
          content = m.content.map(b => typeof b === 'string' ? b : (b?.text || JSON.stringify(b))).join('\n');
        } else {
          content = JSON.stringify(m.content);
        }
        // prepend system text to first user message
        let role = m.role;
        if (role === 'tool') role = 'user';
        if (role === 'user' && systemParts.length > 0) {
          content = systemParts.join('\n\n') + '\n\n' + content;
          systemParts = [];
        }
        actualMessages.push({ role, content });
      }
      // 如果只有 system 没有 user，补一条
      if (actualMessages.length === 0 && systemParts.length > 0) {
        actualMessages.push({ role: 'user', content: systemParts.join('\n\n') });
      }
    } catch {}

    // 如果没有消息，无法计数
    if (!actualMessages.length) {
      return res.status(400).json({
        success: false,
        error: '会话中没有可用的消息，无法计数',
      });
    }

    // 调用 count tokens API，使用实际消息
    try {
      const countRequest = {
        model: modelName,
        messages: actualMessages,
      };

      const response = await fetch(countTokensUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': provider.apiKey,
        },
        body: JSON.stringify(countRequest),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Count tokens API failed: ${response.status} ${errorText}`);
      }

      const result = await response.json();
      const tokenCount = result.input_tokens || result.inputTokens;

      if (typeof tokenCount !== 'number' || tokenCount < 0) {
        return res.status(500).json({
          success: false,
          error: 'Count tokens API did not return a valid token count',
          details: result,
        });
      }

      // 写入路径须与 summarizePrebuiltSession 读取路径一致: runtime.usageStats.lastRequestUsage
      if (!sessionData.runtime) sessionData.runtime = {};
      if (!sessionData.runtime.usageStats) sessionData.runtime.usageStats = {};
      sessionData.runtime.usageStats.lastRequestUsage = {
        inputTokens: tokenCount,
        outputTokens: 0,
        totalTokens: tokenCount,
      };
      sessionData.modelName = modelName;
      sessionData.updatedAt = new Date().toISOString();

      await fs.writeFile(sessionPath, JSON.stringify(sessionData, null, 2));

      res.json({
        success: true,
        tokenCount,
      });
    } catch (fetchError) {
      return res.status(500).json({
        success: false,
        error: `Failed to call count tokens API: ${fetchError.message}`,
      });
    }
  } catch (error) {
    next(error);
  }
});

// ═══ Block C (server.js L4048-4595) ═══
// ── Sessions ──────────────────────────────────────────────────────────────────

app.post('/protoclaw/prebuilt_sessions', express.json(), async (req, res, next) => {
  try {
    const agent = await requireAgentLight(req.body.agentId);
    const session = await createPrebuiltSession(agent.id, {
      returnSummary: false,
      sourceSessionId: req.body.sourceSessionId,
      formId: req.body.formId,
      featureName: req.body.featureName,
      agentName: req.body.agentName,
      openDirectory: req.body.openDirectory,
      targetDir: req.body.targetDir,
    });
    const status = await startManagedAgent(agent, session.id);
    res.json({ session, status, agent: null });
  } catch (error) {
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

    await updateSessionIndex(agentId, (index) => {
      const sessionIndex = index.sessions.findIndex(s => s.id === sessionId);
      if (sessionIndex === -1) {
        throw Object.assign(new Error('Session not found'), { statusCode: 404 });
      }
      index.sessions[sessionIndex].title = title.trim();
      index.sessions[sessionIndex].updatedAt = new Date().toISOString();
      return index;
    });

    res.json({ ok: true, sessionId, title: title.trim() });
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

    const titleMirrorScript = path.join(PROJECT_ROOT, 'scripts', 'run-title-mirror.js');
    const resultDir = path.join(os.tmpdir(), `title-mirror-${Date.now()}-${randomUUID().slice(0, 8)}`);
    const resultPath = path.join(resultDir, 'result.json');
    await fs.mkdir(resultDir, { recursive: true });

    const child = spawn(process.execPath, [titleMirrorScript, agentRelativeDir, ownerAgentId, sessionId, JSON.stringify({ maxAttempts: 1 }), resultPath], {
      cwd: __dirname,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env },
    });

    let stderr = '';
    const timeoutMs = 120000;
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
    await fs.rm(resultDir, { recursive: true, force: true }).catch(() => {});

    const title = typeof result?.title === 'string' ? result.title.trim() : '';
    if (!title) {
      return res.status(500).json({ error: 'Title generation returned empty result' });
    }

    await updateSessionIndex(ownerAgentId, (index) => {
      const sessionIndex = index.sessions.findIndex(s => s.id === sessionId);
      if (sessionIndex !== -1) {
        index.sessions[sessionIndex].title = title;
        index.sessions[sessionIndex].updatedAt = new Date().toISOString();
      }
      return index;
    });

    res.json({ ok: true, sessionId, title });
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
      env: { ...process.env },
    });

    let stderr = '';
    const timeoutMs = 120000;
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
    await fs.rm(resultDir, { recursive: true, force: true }).catch(() => {});

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
    const result = await createCompactedResumeFromHandoff({
      preferredAgentId,
      handoffId,
      handoffPath,
      goal: cleanSessionText(req.body?.goal),
      startRuntime: req.body?.startRuntime !== false,
    });
    res.json(result);
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
    const timeoutMs = Number(req.body?.timeoutMs) || 300000;
    const explorationIds = Array.isArray(req.body?.explorationIds)
      ? req.body.explorationIds.map(id => cleanSessionText(id)).filter(Boolean)
      : [];

    if (!goal) {
      res.status(400).json({ error: 'goal is required for one-shot spawn' });
      return;
    }

    req.setTimeout(timeoutMs + 10000);

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
    const timeoutMs = Number(req.body?.timeoutMs) || 300000;

    if (!subSessionId || !message) {
      res.status(400).json({ error: 'sessionId and message are required' });
      return;
    }

    req.setTimeout(timeoutMs + 10000);

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
  try {
    const sessionId = cleanSessionText(req.body?.sessionId);
    if (!sessionId) {
      res.status(400).json({ error: 'sessionId is required' });
      return;
    }

    const preferredAgentId = normalizeClientAgentId(req.body?.agentId);
    const detached = req.body?.detached !== false;
    const policy = req.body?.policy || {};
    console.log(`[compact_and_resume] requested agent=${preferredAgentId || '(auto)'} session=${sessionId} detached=${detached}`);

    if (detached) {
      const jobId = `compact-resume-${Date.now()}-${randomUUID().slice(0, 8)}`;
      setTimeout(() => {
        compactAndResumeCurrentSession({
          preferredAgentId,
          sessionId,
          policy,
          startRuntime: req.body?.startRuntime !== false,
        }).then((result) => {
          console.log(`[compact_and_resume] job ${jobId} completed for session=${sessionId} newSession=${result?.session?.id || 'unknown'}`);
        }).catch((error) => {
          console.error(`[compact_and_resume] job ${jobId} failed for session=${sessionId}:`, error);
        });
      }, 10);

      res.json({
        scheduled: true,
        jobId,
        sessionId,
        agentId: preferredAgentId || null,
      });
      return;
    }

    const result = await compactAndResumeCurrentSession({
      preferredAgentId,
      sessionId,
      policy,
      startRuntime: req.body?.startRuntime !== false,
    });
    console.log(`[compact_and_resume] completed session=${sessionId} newSession=${result?.session?.id || 'unknown'}`);
    res.json(result);
  } catch (error) {
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
    console.log(`[summary_resume] requested agent=${preferredAgentId || '(auto)'} session=${sessionId}`);
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
    res.json(result);
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
  try {
    const agent = await requireAgentLight(req.body.agentId);
    if (typeof req.body.sessionId !== 'string' || !req.body.sessionId) {
      res.status(400).json({ error: 'sessionId is required' });
      return;
    }
    const session = await activatePrebuiltSession(agent.id, req.body.sessionId, { returnSummary: false });
    const status = await startManagedAgent(agent, session.id);
    res.json({ session, status, agent: null });
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/prebuilt_sessions/delete', express.json(), async (req, res, next) => {
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
    const deleted = await deletePrebuiltSession(agent.id, req.body.sessionId);
    const runtime = getAgentRuntime(agent.id);
    const deletedRuntime = getAgentRuntime(agent.id, req.body.sessionId);
    const deletedWasActive = deletedRuntime?.selectedSessionId === req.body.sessionId;
    let connected = null;

    if (deletedRuntime?.process && deletedRuntime.process.exitCode === null && !deletedRuntime.stopped && deletedWasActive) {
      await stopManagedAgent(agent.id, req.body.sessionId);
    }

    res.json({
      deleted,
      agent: connected,
      assemblyRuntime,
    });
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/prebuilt_sessions/archive', express.json(), async (req, res, next) => {
  try {
    const agent = await requireAgentLight(req.body.agentId);
    if (typeof req.body.sessionId !== 'string' || !req.body.sessionId) {
      res.status(400).json({ error: 'sessionId is required' });
      return;
    }
    const archived = req.body.archived !== false;
    const result = await archivePrebuiltSession(agent.id, req.body.sessionId, archived);
    res.json(result);
  } catch (error) {
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
    const result = await tagPrebuiltSessionTodo(agent.id, req.body.sessionId, todo);
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
