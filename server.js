import express from 'express';
import { spawn, execFile } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import process from 'process';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { ViewerWorker } from 'agentdev';
import {
  exportHistoryOnlyHandoffPackage,
  readHandoffPackage,
} from './server/context-continuity/handoff-package.js';
import { exportSummarizedHandoffPackage, writeSummarizedHandoffPackage } from './server/context-continuity/summarized-handoff.js';
import { ClawMCPServer } from './server/claw-mcp.js';
import {
  getRuntimeInboxSnapshot,
  getRuntimeExecutionState,
  listRuntimeExecutionStates,
  findEnvelopeById,
  findEnvelopesBySourceRef,
} from './server/runtime-call-envelope.js';
import { renderConversationHtml } from './server/conversation-renderer.js';
import { setupUsageRoutes } from './server/usage-ledger.js';

// ── Phase 0: shared infrastructure ────────────────────────────────
import {
  PROJECT_ROOT, rootRequire, APP_PORT, VIEWER_PORT,
  AGENTS_ROOT,
  VIEWER_ORIGIN,
  USER_DATA_ROOT,
  PREBUILT_SESSIONS_ROOT, PREBUILT_WORKSPACES_ROOT,
  PROJECT_QQBOT_CONFIG_PATH, PROJECT_WEIXIN_CONFIG_PATH,
  PROJECT_FEISHU_CONFIG_PATH, PROJECT_WECOM_CONFIG_PATH,
  PROJECT_IM_WORKSPACE_CONFIG_PATH,
  FEATURE_REPOSITORY_ROOT, USER_FEATURE_REPOSITORY_ROOT,
  FEATURE_MANIFEST_NAME, GROUP_CHATS_ROOT,
  WORKSPACE_SESSION_AGENT_IDS, HIDDEN_PREBUILT_AGENT_IDS,
  PROJECT_DOCSET_SUBPATH, MODEL_CONFIG_PATH, MODEL_PRESETS_PATH,
  APP_ORIGIN,
} from './server/shared/constants.js';
import { sanitizeSessionFragment, cleanSessionText, isWorkspaceSessionAgent, log, getAssemblyWorkspaceDir, normalizeClientAgentId, parseListField } from './server/shared/string-helpers.js';
import { compareSemver, uniqueStrings } from './server/shared/feature-utils.js';
import { readJson, readJsonSafe, ensureDir } from './server/shared/fs-helpers.js';
import {
  managedAgents, assemblyRuntimeProcesses,
  getManagedRuntimeKey, listAgentRuntimes, pickPrimaryAgentRuntime,
  getAgentRuntime, getAssemblyRuntime, stopAssemblyRuntime, buildStatus,
} from './server/shared/agent-access.js';
import {
  getPrebuiltAgentSessionDir, getPrebuiltSessionFilePath, getPrebuiltSessionIndexPath,
  getPrebuiltWorkspaceDir, getPrebuiltWorkspaceStatePath, getPrebuiltWorkspaceArtifactsDir,
  getWorkspaceArtifactPath,
  getProjectDocsetDir, getProjectDocsetProjectPath, getProjectDocsetFormsDir,
  getProjectDocsetMaterialsDir, getProjectDocsetConversationsDir,
  readSessionIndex, resolvePrebuiltSessionType,
  writeSessionIndex, updateSessionIndex,
  buildSessionTitle, normalizeSessionMetadata, readSessionIndexSync,
} from './server/shared/session-access.js';
import { sendIPCtoSession } from './server/shared/ipc.js';
import { proxyToViewer } from './server/shared/proxy.js';

// ── Phase 1: domain route modules ────────────────────────────────
import { setupSystemFeatureConfigRoutes } from './server/routes/system-feature-config.js';
import { setupFsOperationsRoutes } from './server/routes/fs-operations.js';
import {
  setupModelConfigRoutes,
  readModelConfig, writeModelConfig,
  readModelPresets, writeModelPresetsFile,
  resolveSessionModelInfo,
} from './server/routes/model-config.js';
import { setupGroupChatRoutes } from './server/routes/group-chat.js';
import { setupDispatchRoutes, getProjectAdapter, fireBootSchedules } from './server/routes/dispatch.js';
import { setupIMRoutes, readProjectIMWorkspaceConfig, getPortalAgentDisplayName } from './server/routes/im.js';
import { createSessionHelpers } from './server/routes/session-helpers.js';
import { setupSessionRoutes } from './server/routes/session.js';
import {
  setupFeatureRepositoryRoutes,
  summarizeFeatureRepository,
  mergeFeatureRepositoryPackages,
} from './server/routes/feature-repository.js';
import { setupFlowRoutes } from './server/routes/flow.js';
import {
  ensureAssemblyWorkspaceBase,
  resolveAssemblyFeatureArchives,
  ensureAssemblyWorkspaceDependencies,
} from './server/routes/assembly-helpers.js';
import {
  setupProjectDocsetRoutes,
  syncWorkspaceProjectDocset,
  summarizeProjectDocset,
} from './server/routes/project-docset.js';
import {
  setupWorkspaceRoutes,
  readWorkspaceState,
  writeWorkspaceState,
  resolveWorkspaceData,
  upsertWorkspacePhProject,
} from './server/routes/workspace.js';
import { setupWorkspaceCreatorRoutes } from './server/routes/workspace-creators.js';
import { createAgentDiscoveryModule } from './server/routes/agent-discovery.js';
import { createAgentLifecycleModule } from './server/routes/agent-lifecycle.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const viewerWorker = new ViewerWorker(VIEWER_PORT, false, process.env.AGENTDEV_UDS_PATH);
const clawMcp = new ClawMCPServer();

// ── Assembly helpers extracted to server/routes/assembly-helpers.js ──
// ── Workspace state + data extracted to server/routes/workspace.js ──

// ── Project docset helpers extracted to server/routes/project-docset.js ──
// ── Session helpers extracted to server/routes/session-helpers.js ──
// ── FS operations extracted to server/routes/fs-operations.js ──
// ── Workspace creators extracted to server/routes/workspace-creators.js ──
// ── Agent Discovery + Identity → server/routes/agent-discovery.js ──

const sessionApi = {};
const agentDiscovery = createAgentDiscoveryModule({ sessionApi });
const {
  discoverAgents, getAgentsLight, resolveAgentModelPresets,
  enrichAgent, getAgents, requireAgentLight, requireAgent,
  readViewerJson, getPendingInputCount,
  resolveActiveWorkspaceSessionMeta, resolveRuntimeDisplayName,
  readWorkspaceSessionSnapshot, readActiveWorkspaceSessionMeta,
  readWorkspaceSessionMeta, collectIdentities,
} = agentDiscovery;

// ── Agent Lifecycle → server/routes/agent-lifecycle.js ──
const agentLifecycle = createAgentLifecycleModule({
  sessionApi,
  getAgents, getAgentsLight, enrichAgent, requireAgentLight,
  resolveRuntimeDisplayName,
  readActiveWorkspaceSessionMeta, readWorkspaceSessionMeta,
  readViewerJson, getPendingInputCount, resolveAgentModelPresets,
});
const {
  getConnectedAgents, waitForProcessExit,
  waitForManagedRuntimeReady, waitForAssemblyRuntimeReady,
  startManagedAgent, startOneShotAgent, startAssemblyRuntime,
  stopManagedAgent,
} = agentLifecycle;

app.all('/protoclaw/claw-mcp', async (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, mcp-session-id, last-event-id');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, DELETE, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    await clawMcp.handleRequest(req, res);
  } catch (error) {
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null }));
    }
  }
});
app.all('/protoclaw/claw-mcp/', async (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, mcp-session-id, last-event-id');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, DELETE, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    await clawMcp.handleRequest(req, res);
  } catch (error) {
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null }));
    }
  }
});

// ── Identity Registry API → server/routes/agent-discovery.js (setupRoutes) ──

// ── Session helpers → server/routes/session-helpers.js ──
const sessionHelpers = createSessionHelpers({
  readWorkspaceState,
  writeWorkspaceState,
  discoverAgents,
  enrichAgent,
  startManagedAgent,
  waitForManagedRuntimeReady,
});
const {
  buildFeatureSessionTitle, buildNamedSessionTitle, getNextNewSessionTitle,
  checkSessionHasSummary, buildSessionSummaryMap, buildLightPrebuiltSessionRecord,
  findSessionSummary, findSessionSummaryPath, extractToolCallLabel,
  buildSessionTrimPreview, summarizePrebuiltSession,
  getSearchIndexPath, loadPersistentSearchIndex, savePersistentSearchIndex,
  extractSessionSearchText, ensureSearchIndex, searchInText, searchSessionsContent,
  cleanupEmptySessions, listPrebuiltSessions, buildSessionModelInfoMap,
  createPrebuiltSession, activatePrebuiltSession, deletePrebuiltSession,
  archivePrebuiltSession, tagPrebuiltSessionTodo, requirePrebuiltSessionRecord,
  resolvePrebuiltSessionOwner, requirePrebuiltAgentForRuntime,
  exportContextHandoffForSession, createCompactedResumeFromHandoff,
  compactAndResumeCurrentSession, compactAndResumeFromProvidedSummary,
  exportProvidedSummaryHandoff, deletePrebuiltProject,
  resolveContextLength,
  lockExplorationSession, extractDomainsFromText,
  buildExplorationHandoffPayload, writeSyntheticHandoff,
} = sessionHelpers;

// 打破 agent-discovery ↔ session-helpers 循环依赖
Object.assign(sessionApi, {
  listPrebuiltSessions,
  summarizePrebuiltSession,
  buildLightPrebuiltSessionRecord,
});

// ── Identity Registry API → server/routes/agent-discovery.js (setupRoutes) ──
agentDiscovery.setupRoutes(app);

// ── Group Chat API → server/routes/group-chat.js ──
const { cleanupOrphanedRouting } = setupGroupChatRoutes(app, express, {
  collectIdentities,
  createPrebuiltSession,
  startManagedAgent,
  stopManagedAgent,
  waitForManagedRuntimeReady,
  requireAgentLight,
  readViewerJson,
  discoverAgents,
  onAgentExit: agentLifecycle.onAgentExit,
});

// ── System Feature Config API → server/routes/system-feature-config.js ──
setupSystemFeatureConfigRoutes(app, express);

// ── Dispatch API → server/routes/dispatch.js ──
setupDispatchRoutes(app, express, {
  readWorkspaceState,
  writeWorkspaceState,
  readProjectIMWorkspaceConfig,
  listPrebuiltSessions,
  requirePrebuiltAgentForRuntime,
  createPrebuiltSession,
  startManagedAgent,
  waitForManagedRuntimeReady,
  activatePrebuiltSession,
});

// ── Runtime Inbox observation API (read-only) ──────────────────

app.get('/protoclaw/runtime/inbox', (req, res) => {
  const agentId = req.query.agentId;
  const sessionId = req.query.sessionId || null;
  if (!agentId) return res.status(400).json({ error: 'agentId required' });
  const runtimeKey = getManagedRuntimeKey(agentId, sessionId);
  res.json(getRuntimeInboxSnapshot(runtimeKey));
});

app.get('/protoclaw/runtime/execution_state', (req, res) => {
  const agentId = req.query.agentId;
  const sessionId = req.query.sessionId || null;
  if (!agentId) return res.status(400).json({ error: 'agentId required' });
  const runtimeKey = getManagedRuntimeKey(agentId, sessionId);
  res.json(getRuntimeExecutionState(runtimeKey));
});

app.get('/protoclaw/runtime/execution_states', (_req, res) => {
  res.json({ states: listRuntimeExecutionStates() });
});

app.get('/protoclaw/runtime/envelope', (req, res) => {
  const envelopeId = req.query.envelopeId;
  if (!envelopeId) return res.status(400).json({ error: 'envelopeId required' });
  const envelope = findEnvelopeById(envelopeId);
  if (!envelope) return res.status(404).json({ error: 'envelope not found' });
  res.json(envelope);
});

app.get('/protoclaw/runtime/envelopes_by_source', (req, res) => {
  const sourceRef = req.query.sourceRef;
  if (!sourceRef) return res.status(400).json({ error: 'sourceRef required' });
  res.json({ envelopes: findEnvelopesBySourceRef(sourceRef) });
});

// ── End Runtime Inbox observation API ───────────────────────────

// ── Agent Status & Lifecycle API → server/routes/agent-lifecycle.js ──
agentLifecycle.setupRoutes(app, express);

// ── Sessions → server/routes/session.js ─────────────────────────────────────
setupSessionRoutes(app, express, {
  // Session helpers
  ...sessionHelpers,
  // Agent lifecycle
  requireAgentLight,
  startManagedAgent,
  startOneShotAgent,
  stopManagedAgent,
  waitForManagedRuntimeReady,
});


setupWorkspaceRoutes(app, express);

setupProjectDocsetRoutes(app, express);

// ── IM Workspace → server/routes/im.js ────────────────────────────────────────
setupIMRoutes(app, express, {
  stopManagedAgent,
  requireAgentLight,
  startManagedAgent,
  waitForProcessExit,
  getAgentsLight,
  readViewerJson,
});


// ── Model Config ──────────────────────────────────────────────────────────────
// ── resolveContextLength extracted to server/routes/session-helpers.js ──
app.post('/protoclaw/shutdown', async (_req, res) => {
  res.json({ ok: true });
  setTimeout(() => void shutdown(0), 200);
});

// ── Model Config / Speech / ASR / Agent Presets → server/routes/model-config.js ──
setupModelConfigRoutes(app, express);
setupFeatureRepositoryRoutes(app, express);
setupFlowRoutes(app, express, { readWorkspaceState, resolveAssemblyFeatureArchives });
setupUsageRoutes(app, express);



app.post('/protoclaw/assembly_environment/create', express.json(), async (req, res, next) => {
  try {
    const agentId = sanitizeSessionFragment(String(req.body?.agentId || 'agent-creator').trim());
    const assemblyName = sanitizeSessionFragment(String(req.body?.assemblyName || '').trim());
    const force = req.body?.force === true;
    const selectedFeatures = uniqueStrings(Array.isArray(req.body?.selectedFeatures)
      ? req.body.selectedFeatures.map((value) => String(value || '').trim()).filter(Boolean)
      : parseListField(req.body?.selectedFeatures));
    if (!assemblyName || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(assemblyName)) {
      res.status(400).json({ error: 'Invalid assembly name' });
      return;
    }
    const envDir = getAssemblyWorkspaceDir(assemblyName);
    const existed = existsSync(envDir);
    if (existed && !force) {
      res.status(409).json({
        error: 'Assembly environment already exists',
        code: 'ASSEMBLY_ENV_EXISTS',
        directory: envDir,
        existed: true,
      });
      return;
    }
    await ensureAssemblyWorkspaceBase(envDir, assemblyName);
    const installResult = await ensureAssemblyWorkspaceDependencies(envDir, selectedFeatures);
    const currentState = await readWorkspaceState(agentId).catch(() => ({ forms: {}, openDirectory: '', updatedAt: null }));
    const assemblyForm = currentState?.forms?.['assembly-form'] || {};
    const assemblyConfigs = Array.isArray(currentState?.assemblyConfigs)
      ? currentState.assemblyConfigs.map((item) => {
          if (cleanSessionText(item?.id) !== assemblyName) {
            return item;
          }
          return {
            ...item,
            envDir,
            envConfiguredName: assemblyName,
            envConfiguredFeatures: selectedFeatures,
            envStatus: 'ready',
            envStatusMessage: existed ? 'Environment dependencies refreshed in the existing directory.' : 'Environment directory created and dependencies installed.',
            updatedAt: new Date().toISOString(),
          };
        })
      : [];
    await writeWorkspaceState(agentId, {
      forms: {
        ...currentState.forms,
        'assembly-form': {
          ...assemblyForm,
          assembly_name: assemblyName,
          env_created: '1',
          env_dir: envDir,
          env_configured_name: assemblyName,
          env_configured_features: selectedFeatures.join('\n'),
          env_status: 'ready',
          env_status_message: existed ? 'Environment dependencies refreshed in the existing directory.' : 'Environment directory created and dependencies installed.',
          target_dir: assemblyForm.target_dir || path.dirname(envDir),
        },
      },
      openDirectory: envDir,
      assemblyConfigs,
    });
    res.json({ directory: envDir, created: !existed, existed, installedPackages: installResult.installedPackages });
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/assembly_runtime/start', express.json(), async (req, res, next) => {
  const _t0 = Date.now();
  try {
    const requestedSessionId = cleanSessionText(req.body?.sessionId);
    const requestedAgentId = normalizeClientAgentId(req.body?.agentId);
    const resolvedOwnerId = requestedSessionId
      ? (await resolvePrebuiltSessionOwner(requestedSessionId, requestedAgentId) || requestedAgentId || 'flow-workspace')
      : (requestedAgentId || 'flow-workspace');
    const agent = await requirePrebuiltAgentForRuntime(resolvedOwnerId);
    console.log(`[PERF] /assembly_runtime/start BEGIN agentId=${agent.id} sessionId=${requestedSessionId || '(new)'}`);
    const session = requestedSessionId
      ? await activatePrebuiltSession(agent.id, requestedSessionId)
      : await createPrebuiltSession(agent.id, {
          formId: 'assembly-form',
          agentName: req.body?.agentName,
          openDirectory: req.body?.openDirectory,
          targetDir: req.body?.targetDir,
        });
    console.log(`[PERF] /assembly_runtime/start session ready (${Date.now() - _t0}ms)`);
    const wsState = await readWorkspaceState(agent.id).catch(() => ({ forms: {}, openDirectory: '', updatedAt: null }));
    await startAssemblyRuntime(session.id, agent.id, session, wsState);
    console.log(`[PERF] /assembly_runtime/start startAssemblyRuntime done (${Date.now() - _t0}ms)`);
    const connected = await waitForAssemblyRuntimeReady(session.id);
    console.log(`[PERF] /assembly_runtime/start waitForReady done (${Date.now() - _t0}ms)`);
    const latestSession = await summarizePrebuiltSession(agent.id, session);
    console.log(`[PERF] /assembly_runtime/start COMPLETE (${Date.now() - _t0}ms total)`);
    res.json({ session: latestSession, runtime: connected });
  } catch (error) {
    console.error(`[PERF] /assembly_runtime/start FAILED (${Date.now() - _t0}ms):`, error.message);
    next(error);
  }
});

app.post('/protoclaw/assembly_runtime/stop', express.json(), async (req, res, next) => {
  try {
    const sessionId = cleanSessionText(req.body?.sessionId);
    if (!sessionId) {
      res.status(400).json({ error: 'sessionId is required' });
      return;
    }
    res.json(await stopAssemblyRuntime(sessionId));
  } catch (error) {
    next(error);
  }
});


app.post('/protoclaw/ph_project/open', express.json(), async (req, res, next) => {
  try {
    const openDirectory = typeof req.body?.openDirectory === 'string' ? req.body.openDirectory.trim() : '';
    if (!openDirectory) {
      return res.status(400).json({ error: 'openDirectory is required' });
    }
    const timestamp = new Date().toISOString();
    const state = await readWorkspaceState('programming-helper');
    // Add to phProjects if not already there
    const nextState = upsertWorkspacePhProject(state, { openDirectory }, timestamp);
    // Set as active project
    nextState.openDirectory = openDirectory;
    await writeWorkspaceState('programming-helper', nextState);
    res.json({ ok: true, state: nextState });
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/ph_project/switch', express.json(), async (req, res, next) => {
  try {
    const projectId = typeof req.body?.projectId === 'string' ? req.body.projectId.trim() : '';
    if (!projectId || !projectId.startsWith('dir:')) {
      return res.status(400).json({ error: 'Valid projectId (dir:...) is required' });
    }
    const openDirectory = projectId.slice(4);
    const timestamp = new Date().toISOString();
    const state = await readWorkspaceState('programming-helper');
    // Ensure the project exists in phProjects
    const nextState = upsertWorkspacePhProject(state, { openDirectory }, timestamp);
    nextState.openDirectory = openDirectory;
    await writeWorkspaceState('programming-helper', nextState);
    res.json({ ok: true, state: nextState });
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/ph_project/add', express.json(), async (req, res, next) => {
  try {
    const openDirectory = typeof req.body?.openDirectory === 'string' ? req.body.openDirectory.trim() : '';
    if (!openDirectory) {
      return res.status(400).json({ error: 'openDirectory is required' });
    }
    const timestamp = new Date().toISOString();
    const state = await readWorkspaceState('programming-helper');
    const nextState = upsertWorkspacePhProject(state, { openDirectory }, timestamp);
    await writeWorkspaceState('programming-helper', nextState);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/ph_project/open_in_explorer', express.json(), async (req, res, next) => {
  try {
    const dirPath = typeof req.body?.path === 'string' ? req.body.path.trim() : '';
    if (!dirPath) {
      return res.status(400).json({ error: 'path is required' });
    }
    const { existsSync } = await import('fs');
    if (!existsSync(dirPath)) {
      return res.status(404).json({ error: 'Directory not found' });
    }
    if (process.platform === 'win32') {
      spawn('cmd.exe', ['/c', 'start', '""', dirPath], { stdio: 'ignore', detached: true }).unref();
    } else {
      const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
      spawn(cmd, [dirPath], { stdio: 'ignore', detached: true }).unref();
    }
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/prebuilt_project/delete', express.json(), async (req, res, next) => {
  try {
    const agent = await requireAgentLight(req.body.agentId);
    if (typeof req.body.projectId !== 'string' || !req.body.projectId) {
      res.status(400).json({ error: 'projectId is required' });
      return;
    }

    const deleted = await deletePrebuiltProject(agent.id, req.body.projectId);
    const runtimesToStop = listAgentRuntimes(agent.id).filter((runtime) => deleted.deletedSessionIds.includes(runtime?.selectedSessionId));
    let connected = null;

    for (const runtime of runtimesToStop) {
      await stopManagedAgent(agent.id, runtime.selectedSessionId);
    }

    res.json({
      deleted,
      agent: connected,
    });
  } catch (error) {
    next(error);
  }
});


setupFsOperationsRoutes(app);

setupWorkspaceCreatorRoutes(app, express);


// ── Server-side audio feedback for choice input requests ───────────────────

const _seenChoiceRequestIds = new Set();

/**
 * Play an audio file on the server machine via WPF MediaPlayer + Dispatcher.
 * Uses the same proven pattern as AudioFeedbackFeature._playSound to avoid
 * the MCI reliability issues (silent failures, codec/device registration gaps)
 * that plagued the previous play-sound.ps1 approach.
 *
 * Fire-and-forget (callback style) — does not block the response.
 */
function playSoundOnServer(soundFile) {
  const soundPath = path.join(__dirname, 'public', 'sounds', soundFile);
  const escapedPath = soundPath.replace(/'/g, "''");
  const psScript = [
    'Add-Type -AssemblyName PresentationCore',
    'Add-Type -AssemblyName WindowsBase',
    '$p = New-Object System.Windows.Media.MediaPlayer',
    '$frame = New-Object System.Windows.Threading.DispatcherFrame',
    '$timer = New-Object System.Windows.Threading.DispatcherTimer',
    '$timer.Interval = [TimeSpan]::FromMilliseconds(5000)',
    '$timer.Add_Tick({ $frame.Continue = $false })',
    '$p.Add_MediaOpened({ $frame.Continue = $false })',
    "$p.Open('" + escapedPath + "')",
    '$timer.Start()',
    '[System.Windows.Threading.Dispatcher]::PushFrame($frame)',
    '$timer.Stop()',
    '$p.Volume = 1.0',
    '$p.Play()',
    '$dur = 2',
    'try { if ($p.NaturalDuration.HasTimeSpan) { $dur = $p.NaturalDuration.TimeSpan.TotalSeconds } } catch {}',
    'Start-Sleep -Seconds ([math]::Ceiling([math]::Max($dur, 0.5)))',
    '$p.Stop()',
    '$p.Close()',
  ].join('; ');

  execFile('powershell', ['-NoProfile', '-Command', psScript], {
    timeout: 15000,
    windowsHide: true,
  }, (err) => {
    if (err) console.error('[choice-bell] Playback failed:', err.message);
  });
}

/**
 * Global choice-request alerts: scan ALL connected agents for pending
 * choice-type input requests (not just the currently focused one).
 * Plays a terminal bell for any newly seen requests and returns the
 * full list of active choice alerts so the frontend can show toasts.
 */
app.get('/protoclaw/choice_alerts', async (_req, res, next) => {
  try {
    const agentsRes = await fetch(`${VIEWER_ORIGIN}/api/agents`);
    if (!agentsRes.ok) {
      res.json({ alerts: [] });
      return;
    }
    const agentsData = await agentsRes.json();
    const agents = Array.isArray(agentsData?.agents) ? agentsData.agents : [];
    const connected = agents.filter((a) => a.connected !== false);

    const alerts = [];
    await Promise.all(connected.map(async (agent) => {
      try {
        const reqRes = await fetch(
          `${VIEWER_ORIGIN}/api/agents/${encodeURIComponent(agent.id)}/input-requests`
        );
        if (!reqRes.ok) return;
        const requests = await reqRes.json();
        if (!Array.isArray(requests)) return;
        for (const r of requests) {
          const isChoice = r && r.mode === 'choices'
            && Array.isArray(r.questions) && r.questions.length > 0
            && typeof r.requestId === 'string';
          if (isChoice) {
            alerts.push({
              requestId: r.requestId,
              agentId: agent.id,
              agentName: agent.name || agent.id,
            });
          }
        }
      } catch { /* skip individual agent errors */ }
    }));

    // Play terminal bell for newly discovered choice requests
    for (const alert of alerts) {
      if (!_seenChoiceRequestIds.has(alert.requestId)) {
        if (_seenChoiceRequestIds.size > 500) _seenChoiceRequestIds.clear();
        _seenChoiceRequestIds.add(alert.requestId);
        playSoundOnServer('terminal-bell.mp3');
        break; // one bell per cycle
      }
    }

    res.json({ alerts });
  } catch (err) {
    next(err);
  }
});

app.get(/^\/(api|features|template|tools|npm)(\/.*)?$/, (req, res, next) => {
  proxyToViewer(req, res).catch(next);
});

app.get(/^\/(chunk-|BasicAgent-|ExplorerAgent-|notification-|resolver-|types-|index\.js).*$/, (req, res, next) => {
  proxyToViewer(req, res).catch(next);
});

app.put('/api/agents/current', (req, res, next) => {
  proxyToViewer(req, res).catch(next);
});

app.post('/api/agents/:agentId/input', (req, res, next) => {
  proxyToViewer(req, res).catch(next);
});

app.post('/api/agents/:agentId/queue-input', (req, res, next) => {
  proxyToViewer(req, res).catch(next);
});

app.get('/api/agents/:agentId/queued-inputs', (req, res, next) => {
  proxyToViewer(req, res).catch(next);
});

app.post('/api/agents/:agentId/dequeue-input', (req, res, next) => {
  proxyToViewer(req, res).catch(next);
});

app.post('/api/agents/:agentId/interrupt', (req, res, next) => {
  console.log(`[Server] POST /api/agents/${req.params.agentId}/interrupt → proxying to ViewerWorker`);
  proxyToViewer(req, res).catch(next);
});

app.get('/api/agents/:agentId/running', (req, res, next) => {
  proxyToViewer(req, res).catch(next);
});

app.delete('/api/agents/:agentId', (req, res, next) => {
  proxyToViewer(req, res).catch(next);
});

app.use('/vendor', express.static(path.join(__dirname, 'node_modules')));
app.use(express.static(path.join(__dirname, 'public')));

app.use((error, _req, res, _next) => {
  res.status(error.statusCode || 500).json({ error: error.message || 'Internal Server Error' });
});

async function shutdown(exitCode = 0) {
  for (const runtime of managedAgents.values()) {
    if (runtime.process && runtime.process.exitCode === null && !runtime.stopped) {
      runtime.stopped = true;
      runtime.process.kill('SIGTERM');
    }
  }

  for (const runtime of assemblyRuntimeProcesses.values()) {
    if (runtime.process && runtime.process.exitCode === null && !runtime.stopped) {
      runtime.stopped = true;
      runtime.process.kill('SIGTERM');
    }
  }

  await viewerWorker.stop().catch(() => {});
  process.exit(exitCode);
}

process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));

async function main() {
  await viewerWorker.start();

  // Ensure config directory and essential files exist (config/ is gitignored)
  try {
    await ensureDir(path.join(__dirname, 'config'));
    const exampleConfigPath = path.join(__dirname, 'config', 'default.example.json');
    if (!existsSync(MODEL_CONFIG_PATH)) {
      const example = await readJsonSafe(exampleConfigPath, null);
      await writeModelConfig(example || { defaultModel: {}, agent: {} });
      log('server', 'Created config/default.json from template');
    }
    if (!existsSync(MODEL_PRESETS_PATH)) {
      await writeModelPresetsFile({ providers: [], presets: [] });
      log('server', 'Created config/presets.json');
    }
  } catch (err) {
    log('server', `config init failed: ${err.message}`, 'warn');
  }

  // One-time cleanup of stale empty sessions from previous runs.
  // Only runs at startup — never during normal operation.
  for (const agentId of WORKSPACE_SESSION_AGENT_IDS) {
    try {
      await cleanupEmptySessions(agentId);
    } catch (err) {
      console.warn(`[sessions] startup cleanup failed for ${agentId}:`, err.message);
    }
  }

  // 群聊孤儿 routing 状态修复：Claw 重启后清理 processing 状态的死亡消息
  try {
    await cleanupOrphanedRouting();
  } catch (err) {
    console.warn('[group-chat] startup cleanup failed:', err.message);
  }

  app.listen(APP_PORT, () => {
    log('server', `product ui: http://127.0.0.1:${APP_PORT}`);
    log('server', `viewer worker: ${VIEWER_ORIGIN}`);
    fireBootSchedules();
  });
}

main().catch((error) => {
  log('server', error.stack || error.message, 'error');
  process.exit(1);
});
