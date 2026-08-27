import express from 'express';
import { execFile } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, createReadStream, promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import process from 'process';
import { randomUUID, createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { ViewerWorker } from '@agentdevjs/viewer';
import {
  exportHistoryOnlyHandoffPackage,
  readHandoffPackage,
} from './server/context-continuity/handoff-package.js';
import { exportSummarizedHandoffPackage, writeSummarizedHandoffPackage } from './server/context-continuity/summarized-handoff.js';
import { ClawMCPServer } from './server/claw-mcp.js';
import { registerMCPGatewayRoutes } from './server/mcp-gateway/routes.js';
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
  APP_ORIGIN, resolveInstanceUdsPath,
} from './server/shared/constants.js';
import { sanitizeSessionFragment, cleanSessionText, isWorkspaceSessionAgent, log, getAssemblyWorkspaceDir, normalizeClientAgentId, parseListField } from './server/shared/string-helpers.js';
import { compareSemver, uniqueStrings } from './server/shared/feature-utils.js';
import { readJson, readJsonSafe, ensureDir, normalizePathCasing } from './server/shared/fs-helpers.js';
import { openDirectoryInSystem } from './server/shared/system-opener.js';
import { createOperationTrace } from './server/shared/operation-trace.js';
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
import { proxyToViewer, setProxyConnectionLookup } from './server/shared/proxy.js';
import { resolveRuntimeObservationTarget } from './server/shared/operation-target.js';
import { buildLocalFailureResponse, readOperationMetadata } from './server/shared/operation-contract.js';
import {
  initRecoveryCache,
  getRecoverySessions,
  consumeRecoverySession,
  dismissRecoverySessions,
} from './server/shared/open-sessions-tracker.js';

// ── Phase 1: domain route modules ────────────────────────────────
import { setupSystemFeatureConfigRoutes } from './server/routes/system-feature-config.js';
import { setupFeatureConfigRoutes } from './server/routes/feature-config.js';
import { setupPreflightRoutes } from './server/routes/preflight.js';
import { setupFsOperationsRoutes } from './server/routes/fs-operations.js';
import { setupGitRoutes } from './server/routes/git.js';
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
import { setupSidebarDiagnosticsRoutes } from './server/routes/sidebar-diagnostics.js';
import { setupCapabilityRoutes } from './server/routes/capability.js';
import { setupOAuthCodexRoutes } from './server/routes/oauth-codex.js';
import { setupProxyConfigRoutes } from './server/routes/proxy-config.js';
import { setupToolStateRoutes } from './server/routes/tool-state.js';
import { getUISurfaceStore, setupUISurfaceRoutes } from './server/routes/ui-surfaces.js';
import { getThreadControl } from './server/thread-control/thread-controller.js';
import { getThreadIntegration } from './server/thread-control/thread-integration.js';
import { onRuntimeReady } from './server/shared/runtime-hooks.js';
import { setupThreadRoutes } from './server/thread-control/thread-routes.js';
import { createThreadLifecycleService } from './server/thread-control/thread-lifecycle.js';
import { setupAcpRoutes } from './server/routes/acp.js';
import { deliverUserInput } from './server/thread-control/input-gateway.js';
import { createThreadRotationService } from './server/thread-control/thread-rotation.js';
import { applyProxy } from './server/shared/proxy-manager.js';
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
import { startEmbeddedRemoteClawConnector } from './server/remote-claw/embedded-connector.js';
import { createTunnelManager } from './server/remote-connections/tunnel-manager.js';
import { createConnectionStore, ConnectionConfigError } from './server/remote-connections/connection-store.js';
import { createConnectionHealth } from './server/remote-connections/connection-health.js';
import { createCatalogAggregator } from './server/remote-connections/catalog-aggregator.js';
import { PH_STYLE_WORKSPACE_AGENT_IDS } from './server/shared/constants.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const viewerWorker = new ViewerWorker(VIEWER_PORT, false, resolveInstanceUdsPath());
const clawMcp = new ClawMCPServer();
const tunnelManager = createTunnelManager();
let remoteClawConnector = null;
let remoteClawContext = null;
const PROJECT_REMOTE_CLAW_CONFIG_PATH = path.join(PROJECT_ROOT, '.agentdev', 'remote-claw.json');

// ── Agent discovery + identity extracted to server/routes/agent-discovery.js ──
// sessionApi is a mutable reference filled after session-helpers is created,
// breaking the circular dependency (agent-discovery → session-helpers → agent-discovery).
const sessionApi = {};
const agentDiscoveryApi = createAgentDiscoveryModule({ sessionApi });
const {
  discoverAgents, getAgentsLight, resolveAgentModelPresets, enrichAgent,
  getAgents, requireAgentLight, requireAgent,
  readViewerJson, getPendingInputCount,
  resolveActiveWorkspaceSessionMeta, resolveRuntimeDisplayName,
  readWorkspaceSessionSnapshot, readActiveWorkspaceSessionMeta,
  readWorkspaceSessionMeta, collectIdentities,
} = agentDiscoveryApi;
agentDiscoveryApi.setupRoutes(app);

// ── Project docset helpers extracted to server/routes/project-docset.js ──
// ── Session helpers extracted to server/routes/session-helpers.js ──
// ── FS operations extracted to server/routes/fs-operations.js ──
// ── Workspace creators extracted to server/routes/workspace-creators.js ──
// ── Agent Discovery + Identity → server/routes/agent-discovery.js ──

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
  startManagedAgent, startAssemblyRuntime,
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

// ── MCP Gateway: centrally hosted MCP servers for cross-session sharing ──
registerMCPGatewayRoutes(app);

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
  readSessionSnapshotForContinuity,
  resolvePrebuiltSessionOwner, requirePrebuiltAgentForRuntime,
  exportContextHandoffForSession, createCompactedResumeFromHandoff,
  compactAndResumeCurrentSession, compactAndResumeFromProvidedSummary,
  exportProvidedSummaryHandoff, deletePrebuiltProject,
  resolveContextLength,
} = sessionHelpers;

// 打破 agent-discovery ↔ session-helpers 循环依赖
Object.assign(sessionApi, {
  listPrebuiltSessions,
  summarizePrebuiltSession,
  buildLightPrebuiltSessionRecord,
});

const threadControl = getThreadControl();
const threadIntegration = getThreadIntegration();
const threadLifecycle = createThreadLifecycleService({
  control: threadControl,
  interruptSession: async (agentId, sessionId) => {
    const runtime = getAgentRuntime(agentId, sessionId);
    const viewerAgentId = runtime?.viewerAgentId;
    if (!viewerAgentId) return { status: 'not_running' };
    const response = await fetch(`${VIEWER_ORIGIN}/api/agents/${encodeURIComponent(viewerAgentId)}/interrupt`, { method: 'POST' });
    if (!response.ok) throw new Error(`Viewer interrupt returned ${response.status}`);
    return { status: 'interrupted', viewerAgentId };
  },
  stopSession: stopManagedAgent,
});
const threadRotation = createThreadRotationService({
  sessionApi: sessionHelpers,
  stopManagedAgent,
  threadIntegration,
  threadControl,
});

// ── Identity Registry API → server/routes/agent-discovery.js (setupRoutes) ──

// ── Group Chat API → server/routes/group-chat.js ──
const { cleanupOrphanedRouting, notifySessionLineage, notifySessionArchived } = setupGroupChatRoutes(app, express, {
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

// ── Feature Config Queue API (resolved / layer) → server/routes/feature-config.js ──
setupFeatureConfigRoutes(app, express);

// ── Assembly Preflight API → server/routes/preflight.js ──
setupPreflightRoutes(app, express);

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
  try {
    const { agentId, sessionId } = resolveRuntimeObservationTarget(req.query);
    const runtimeKey = getManagedRuntimeKey(agentId, sessionId);
    res.json(getRuntimeInboxSnapshot(runtimeKey));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message, code: error.code });
  }
});

app.get('/protoclaw/runtime/execution_state', (req, res) => {
  try {
    const { agentId, sessionId } = resolveRuntimeObservationTarget(req.query);
    const runtimeKey = getManagedRuntimeKey(agentId, sessionId);
    res.json(getRuntimeExecutionState(runtimeKey));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message, code: error.code });
  }
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

// Runtime observation routes are session-scoped; collection diagnostics remain
// separate and do not derive a target from the page's focused Agent.

// ── End Runtime Inbox observation API ───────────────────────────

// ── Agent Status & Lifecycle API → server/routes/agent-lifecycle.js ──
agentLifecycle.setupRoutes(app, express);
setupSidebarDiagnosticsRoutes(app, express);

// ── Capability control plane (slash / feature command registry transport) ──
setupCapabilityRoutes(app, express);

// ── Sessions → server/routes/session.js ─────────────────────────────────────
setupSessionRoutes(app, express, {
  // Session helpers
  ...sessionHelpers,
  // Agent lifecycle
  requireAgentLight,
  startManagedAgent,
  stopManagedAgent,
  waitForManagedRuntimeReady,
  // Group chat lineage callback
  notifySessionLineage,
  notifySessionArchived,
  clearUISurfaces: (viewerAgentId) => getUISurfaceStore().clearAgent(viewerAgentId),
  threadRotation,
  threadLifecycle,
});

// ── Open Sessions Recovery → open-sessions-tracker ──────────────────────────
app.get('/protoclaw/open_sessions', async (req, res, next) => {
  try {
    const agentId = typeof req.query.agentId === 'string' ? req.query.agentId.trim() : '';
    if (!agentId) {
      res.status(400).json({ error: 'agentId is required' });
      return;
    }
    const sessions = await getRecoverySessions(agentId);
    res.json({ sessions });
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/open_sessions/restore', express.json(), async (req, res, next) => {
  try {
    const agentId = typeof req.body.agentId === 'string' ? req.body.agentId.trim() : '';
    if (!agentId) {
      res.status(400).json({ error: 'agentId is required' });
      return;
    }
    const sessionIds = Array.isArray(req.body.sessionIds) ? req.body.sessionIds.filter((id) => typeof id === 'string' && id) : [];
    if (sessionIds.length === 0) {
      res.status(400).json({ error: 'sessionIds is required' });
      return;
    }

    const agent = await requireAgentLight(agentId);
    const results = [];

    for (const sessionId of sessionIds) {
      try {
        const session = await activatePrebuiltSession(agent.id, sessionId, { returnSummary: false });
        const status = await startManagedAgent(agent, session.id);
        await waitForManagedRuntimeReady(agent.id, 10000, session.id);
        results.push({ sessionId, ok: true, status });
        consumeRecoverySession(agent.id, sessionId);
      } catch (err) {
        results.push({ sessionId, ok: false, error: String(err.message || err) });
      }
    }

    res.json({ results });
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/open_sessions/dismiss', express.json(), (req, res) => {
  const agentId = typeof req.body.agentId === 'string' ? req.body.agentId.trim() : '';
  if (!agentId) {
    res.status(400).json({ error: 'agentId is required' });
    return;
  }
  dismissRecoverySessions(agentId);
  res.json({ ok: true });
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
setupOAuthCodexRoutes(app, express);
setupProxyConfigRoutes(app, express);
setupToolStateRoutes(app);
setupFeatureRepositoryRoutes(app, express);
setupFlowRoutes(app, express, { readWorkspaceState, resolveAssemblyFeatureArchives });
setupUsageRoutes(app, express);
setupUISurfaceRoutes(app, express);

// ── Work Threads → server/thread-control/（coder 宿主已启用线程承接）──
setupThreadRoutes(app, express, {
  control: threadControl,
  lifecycle: threadLifecycle,
  // head 会话 → 项目目录（PH 项目卡片 coder tab 的线程归属）；会话不存在时返回 null
  resolveSessionOpenDirectory: async (agentId, sessionId) => {
    const record = await requirePrebuiltSessionRecord(agentId, sessionId);
    return cleanSessionText(record?.openDirectory) || null;
  },
});

// ── ACP 支撑路由（coder 原子创建 + 精确中断 + list/resume，ticket 018）──
setupAcpRoutes(app, express, {
  requireAgentLight,
  createPrebuiltSession,
  deletePrebuiltSession,
  startManagedAgent,
  stopManagedAgent,
  waitForManagedRuntimeReady,
  threadIntegration,
  threadControl,
  requirePrebuiltSessionRecord,
  readSessionSnapshotForContinuity,
});
// runtime 就绪补投：succession 时刻 runtime 未就绪而保持 pending 的指令，
// 在 head runtime 真正 ready 时重试（设计 §5 的最后一个投递触发点）。
onRuntimeReady((agentId, sessionId) => {
  getThreadIntegration().handleRuntimeReady(agentId, sessionId);
});



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
    if (!requestedAgentId) {
      return res.status(400).json({ error: 'agentId is required' });
    }
    const agent = await requirePrebuiltAgentForRuntime(requestedAgentId);
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
    const agentId = typeof req.body?.agentId === 'string' ? req.body.agentId.trim() : 'programming-helper';
    if (!PH_STYLE_WORKSPACE_AGENT_IDS.has(agentId)) {
      return res.status(400).json({ error: `agentId is not supported for ph_project: ${agentId}` });
    }
    const rawDirectory = typeof req.body?.openDirectory === 'string' ? req.body.openDirectory.trim() : '';
    if (!rawDirectory) {
      return res.status(400).json({ error: 'openDirectory is required' });
    }
    // Resolve actual filesystem casing so display matches the real directory name.
    // On Windows the directory picker may return a lowercased path.
    const openDirectory = await normalizePathCasing(rawDirectory);
    const timestamp = new Date().toISOString();
    const state = await readWorkspaceState(agentId);
    // Add to phProjects if not already there
    const nextState = upsertWorkspacePhProject(state, { openDirectory }, timestamp);
    // Set as active project
    nextState.openDirectory = openDirectory;
    await writeWorkspaceState(agentId, nextState);
    res.json({ ok: true, state: nextState });
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/ph_project/switch', express.json(), async (req, res, next) => {
  try {
    const agentId = typeof req.body?.agentId === 'string' ? req.body.agentId.trim() : 'programming-helper';
    if (!PH_STYLE_WORKSPACE_AGENT_IDS.has(agentId)) {
      return res.status(400).json({ error: `agentId is not supported for ph_project: ${agentId}` });
    }
    const projectId = typeof req.body?.projectId === 'string' ? req.body.projectId.trim() : '';
    if (!projectId || !projectId.startsWith('dir:')) {
      return res.status(400).json({ error: 'Valid projectId (dir:...) is required' });
    }
    const rawDirectory = projectId.slice(4);
    const timestamp = new Date().toISOString();
    const state = await readWorkspaceState(agentId);
    // Prefer the stored openDirectory (preserves original casing) over the
    // ID-derived path (which is always lowercased).
    const stored = Array.isArray(state.phProjects)
      ? state.phProjects.find((p) => p?.id === projectId)
      : null;
    let openDirectory = stored?.openDirectory || rawDirectory;
    // Resolve actual filesystem casing for paths that were stored lowercased.
    openDirectory = await normalizePathCasing(openDirectory);
    // Ensure the project exists in phProjects
    const nextState = upsertWorkspacePhProject(state, { openDirectory }, timestamp);
    nextState.openDirectory = openDirectory;
    await writeWorkspaceState(agentId, nextState);
    res.json({ ok: true, state: nextState });
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/ph_project/add', express.json(), async (req, res, next) => {
  try {
    const agentId = typeof req.body?.agentId === 'string' ? req.body.agentId.trim() : 'programming-helper';
    if (!PH_STYLE_WORKSPACE_AGENT_IDS.has(agentId)) {
      return res.status(400).json({ error: `agentId is not supported for ph_project: ${agentId}` });
    }
    const rawDirectory = typeof req.body?.openDirectory === 'string' ? req.body.openDirectory.trim() : '';
    if (!rawDirectory) {
      return res.status(400).json({ error: 'openDirectory is required' });
    }
    const openDirectory = await normalizePathCasing(rawDirectory);
    const timestamp = new Date().toISOString();
    const state = await readWorkspaceState(agentId);
    const nextState = upsertWorkspacePhProject(state, { openDirectory }, timestamp);
    await writeWorkspaceState(agentId, nextState);
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
    const result = await openDirectoryInSystem(dirPath);
    if (!result.opened) {
      console.warn(`[server] open in explorer skipped: ${result.reason}`);
    }
    res.json({ ok: true, ...result });
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/prebuilt_project/delete', express.json(), async (req, res, next) => {
  const trace = createOperationTrace({
    operationId: req.body?.operationId,
    operation: 'delete_project',
    agentId: req.body?.agentId,
  });
  trace.mark('server_received');
  try {
    const agent = await requireAgentLight(req.body.agentId);
    if (typeof req.body.projectId !== 'string' || !req.body.projectId) {
      res.status(400).json({ error: 'projectId is required' });
      return;
    }

    const deleted = await deletePrebuiltProject(agent.id, req.body.projectId, {
      includeSessions: req.body.responseMode !== 'delta',
    });
    trace.mark('index_committed', { revision: deleted.revision, removedCount: deleted.deletedSessionIds.length });
    const runtimesToStop = listAgentRuntimes(agent.id).filter((runtime) => deleted.deletedSessionIds.includes(runtime?.selectedSessionId));
    let connected = null;

    if (runtimesToStop.length > 0) trace.mark('source_stop_requested', { runtimeCount: runtimesToStop.length });
    for (const runtime of runtimesToStop) {
      await stopManagedAgent(agent.id, runtime.selectedSessionId);
    }

    res.json({
      deleted,
      agent: connected,
      operationId: trace.operationId,
    });
    trace.mark('response_sent', { revision: deleted.revision });
  } catch (error) {
    trace.mark('failed', { errorCode: error?.code || 'delete_project_failed' });
    next(error);
  }
});


setupFsOperationsRoutes(app);

setupGitRoutes(app, express);

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
// Global collection query: scans all connected Viewer runtimes; it is not a
// focused-Agent read and must not be narrowed by page state.
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

// ViewerWorker 代理：API 接口 + /tpl/ 模板装载资产（URL 由 worker 从注册事实生成）
app.get(/^\/(api|tpl)(\/.*)?$/, (req, res, next) => {
  proxyToViewer(req, res).catch(next);
});

app.post('/api/agents/:agentId/input', (req, res, next) => {
  proxyToViewer(req, res).catch(next);
});

// 用户输入统一网关：线程交接窗口（coder 宿主）转入 Thread Inbox 暂存，
// 其余原样直投 viewer（含排队语义）。所有输入源（聊天框 / 语音 / 交互
// 面板 / 未来 IM 路由）的 user-turn 投递必经此点。
// body 必须在此解析：本文件无全局 express.json()，漏挂会让 req.body 恒为
// undefined（text 归一为空串）——直投路径报 text must be a non-empty string，
// 交接路径误报 image-only。
app.post('/api/agents/:agentId/user-turn', express.json(), async (req, res, next) => {
  try {
    const metadata = readOperationMetadata(req);
    const result = await deliverUserInput({
      viewerAgentId: req.params.agentId,
      text: typeof req.body?.text === 'string' ? req.body.text : '',
      images: Array.isArray(req.body?.images) ? req.body.images : undefined,
      source: typeof req.body?.source === 'string' ? req.body.source : undefined,
      sourceRef: typeof req.body?.sourceRef === 'string' ? req.body.sourceRef : undefined,
      ...(Array.isArray(req.body?.capabilityActivations)
        ? { capabilityActivations: req.body.capabilityActivations.filter((a) => typeof a === 'string') }
        : {}),
      ...metadata,
    });
    res.json({ ...result, ...metadata, operationId: metadata.operationId || null });
  } catch (err) {
    const failure = buildLocalFailureResponse(err, readOperationMetadata(req));
    res.status(err?.status || 502).json(failure);
  }
});

app.get('/api/agents/:agentId/queued-inputs', (req, res, next) => {
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

// ── Image attachment storage ───────────────────────────────────────
// Host-scoped global resource: images are persisted under the local user data
// root and never selected by page focus or an Agent identity.
// Images are persisted to ~/.agentdev/AgentDevClaw/images/ and referenced by
// absolute path in messages. This avoids bloating session JSON with inline base64.
const IMAGES_DIR = path.join(USER_DATA_ROOT, 'images');

const MIME_TO_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
};

// Content-hash → resolved path cache (in-process dedup)
const _imageHashCache = new Map();

app.post('/protoclaw/images/upload', async (req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', async () => {
    try {
      const { base64, mediaType, source } = JSON.parse(body);
      if (!base64 || typeof base64 !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Missing or invalid base64' }));
        return;
      }

      const mime = mediaType || 'image/png';
      const ext = MIME_TO_EXT[mime] || 'png';

      // Dedup by content hash — but verify the file still exists on disk
      const hash = createHash('sha256').update(base64).digest('hex').slice(0, 32);

      if (_imageHashCache.has(hash)) {
        const cached = _imageHashCache.get(hash);
        if (existsSync(cached.path)) {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({
            path: cached.path,
            mediaType: mime,
            source: source || `image.${ext}`,
            size: cached.size,
            url: `/protoclaw/images/${cached.filename}`,
          }));
          return;
        }
        // File was deleted externally — purge stale cache entry, fall through to re-write
        _imageHashCache.delete(hash);
      }

      mkdirSync(IMAGES_DIR, { recursive: true });
      const filename = `${hash}.${ext}`;
      const filePath = path.join(IMAGES_DIR, filename);

      if (!existsSync(filePath)) {
        writeFileSync(filePath, Buffer.from(base64, 'base64'));
      }

      const size = statSync(filePath).size;
      _imageHashCache.set(hash, { path: filePath, size, filename });

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        path: filePath,
        mediaType: mime,
        source: source || `image.${ext}`,
        size,
        url: `/protoclaw/images/${filename}`,
      }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message || 'Upload failed' }));
    }
  });
});

// Serve stored images for frontend preview
app.get('/protoclaw/images/:filename', (req, res) => {
  const filename = path.basename(req.params.filename);
  // Prevent path traversal
  if (filename !== req.params.filename || filename.includes('..')) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Invalid filename' }));
    return;
  }
  const filePath = path.join(IMAGES_DIR, filename);
  if (!existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Image not found' }));
    return;
  }
  const ext = path.extname(filename).slice(1);
  const mimeEntry = Object.entries(MIME_TO_EXT).find(([, e]) => e === ext);
  const mime = mimeEntry ? mimeEntry[0] : 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=86400' });
  createReadStream(filePath).pipe(res);
});

app.get('/protoclaw/remote_claw/config', async (_req, res) => {
  const config = await readRemoteClawConfig();
  res.json({
    ok: true,
    config: sanitizeRemoteClawConfig(config),
    runtime: {
      enabled: remoteClawConnector?.enabled === true,
      appOrigin: APP_ORIGIN,
      lanUrls: getLanRelayCandidates(config.relayUrl),
    },
  });
});

app.get('/protoclaw/remote_claw/devices', async (_req, res, next) => {
  try {
    const config = await readRemoteClawConfig();
    if (!config?.relayUrl || !config?.connectorToken) return res.json({ ok: true, devices: [] });
    const data = await relayGet(config.relayUrl, '/api/devices', config.connectorToken);
    res.json({ ok: true, devices: data.devices || [] });
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/remote_claw/connect', express.json(), async (req, res, next) => {
  try {
    const relayUrl = cleanRemoteUrl(req.body?.relayUrl);
    if (!relayUrl) return res.status(400).json({ ok: false, error: 'relayUrl is required' });
    const workspaceName = String(req.body?.workspaceName || 'AgentDevClaw').trim() || 'AgentDevClaw';
    const currentConfig = await readRemoteClawConfig();
    const installationId = String(currentConfig?.installationId || `claw_${randomUUID()}`);
    if (currentConfig?.connectorToken && cleanRemoteUrl(currentConfig.relayUrl) === relayUrl) {
      const config = { ...currentConfig, enabled: true, workspaceName, installationId };
      await writeRemoteClawConfig(config);
      restartRemoteClawConnector();
      return res.json({ ok: true, config: sanitizeRemoteClawConfig(config), reusedDevice: true });
    }
    const registerResp = await relayPost(relayUrl, '/api/devices/register', null, {
      schemaVersion: 1,
      type: 'connector',
      name: workspaceName,
      installationId,
    });
    const connectorToken = registerResp?.deviceToken;
    if (!connectorToken) return res.status(502).json({ ok: false, error: 'relay did not return connector token' });
    const config = {
      enabled: true,
      relayUrl,
      connectorToken,
      installationId,
      workspaceName,
      heartbeatMs: positiveInt(req.body?.heartbeatMs, 15_000),
      snapshotMs: positiveInt(req.body?.snapshotMs, 5_000),
      commandMs: positiveInt(req.body?.commandMs, 2_000),
    };
    await writeRemoteClawConfig(config);
    restartRemoteClawConnector();
    res.json({ ok: true, config: sanitizeRemoteClawConfig(config), deviceId: registerResp.deviceId, userId: registerResp.userId });
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/remote_claw/pairing', express.json(), async (req, res, next) => {
  try {
    const config = await readRemoteClawConfig();
    if (!config?.enabled || !config?.relayUrl || !config?.connectorToken) {
      return res.status(400).json({ ok: false, error: 'Remote Claw is not connected' });
    }
    const mobileRelayUrl = cleanRemoteUrl(req.body?.mobileRelayUrl) || pickMobileRelayUrl(config.relayUrl);
    const data = await relayPost(config.relayUrl, '/api/pairings', config.connectorToken, {
      schemaVersion: 1,
      relayUrl: config.relayUrl,
      mobileRelayUrl,
      workspaceName: config.workspaceName || 'AgentDevClaw',
      name: `Connect ${os.hostname()} phone`,
    });
    res.json({ ok: true, pairing: data, mobileRelayUrl });
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/remote_claw/disconnect', express.json(), async (_req, res, next) => {
  try {
    const config = await readRemoteClawConfig();
    await writeRemoteClawConfig({ ...config, enabled: false });
    restartRemoteClawConnector();
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.delete('/protoclaw/remote_claw/registration', async (_req, res, next) => {
  try {
    const config = await readRemoteClawConfig();
    if (config?.relayUrl && config?.connectorToken) {
      await relayDelete(config.relayUrl, '/api/me', config.connectorToken);
    }
    await writeRemoteClawConfig({ enabled: false, installationId: config?.installationId || `claw_${randomUUID()}` });
    restartRemoteClawConnector();
    res.json({ ok: true, removed: true });
  } catch (error) {
    next(error);
  }
});

// ── ADR-0008 远程连接：工作空间目录聚合（R1-05）──
const connectionStore = createConnectionStore();
setProxyConnectionLookup(connectionStore);
const connectionHealth = createConnectionHealth({ tunnelManager });
connectionHealth.start();

// 健康探测与托管隧道共用同一份连接真值：幂等 diff 同步，增删改 / enable
// 开关即时生效（managed 隧道随 enabled 自动起停，R1-02 生命周期接线）。
async function syncRemoteConnectionInfrastructure(connections) {
  connectionHealth.syncConnections(connections);
  await tunnelManager.syncConnections(connections);
}

void connectionStore.load()
  .then((connections) => syncRemoteConnectionInfrastructure(connections))
  .catch((error) => {
    console.warn('[remote-connections] 初始化失败，remote_catalog 将返回空列表：', error?.message || error);
  });

const remoteCatalogAggregator = createCatalogAggregator({
  listConnections: async () => {
    await connectionStore.ensureLoaded();
    const connections = connectionStore.listConnections();
    await syncRemoteConnectionInfrastructure(connections);
    return connections;
  },
  getStatus: (connectionId) => connectionHealth.getStatus(connectionId),
});

app.get('/protoclaw/remote_catalog', async (_req, res, next) => {
  try {
    res.json(await remoteCatalogAggregator.aggregate());
  } catch (error) {
    next(error);
  }
});

// ── ADR-0008 远程连接管理 API（R1-07 连接管理 UI 的宿主端点）──
// 校验与持久化在 ConnectionStore（R1-01 schema），本层只做薄壳；
// 写路径同步健康探测与隧道生命周期，全部不重启生效。

function sendRemoteConnectionFailure(res, req, error, fallbackStatus = 500) {
  const status = error instanceof ConnectionConfigError ? 400 : fallbackStatus;
  res.status(status).json(buildLocalFailureResponse(error, readOperationMetadata(req)));
}

app.get('/protoclaw/remote_connections', async (_req, res, next) => {
  try {
    await connectionStore.ensureLoaded();
    const connections = connectionStore.listConnections();
    await syncRemoteConnectionInfrastructure(connections);
    const tunnels = {};
    for (const status of tunnelManager.listStatuses()) {
      tunnels[status.id] = status;
    }
    res.json({
      ok: true,
      connections,
      statuses: connectionHealth.listStatuses(),
      tunnels,
    });
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/remote_connections', express.json(), async (req, res, next) => {
  try {
    const connection = await connectionStore.upsertConnection(req.body || {});
    await syncRemoteConnectionInfrastructure(connectionStore.listConnections());
    res.json({ ok: true, connection });
  } catch (error) {
    if (error instanceof ConnectionConfigError) {
      sendRemoteConnectionFailure(res, req, error, 400);
      return;
    }
    next(error);
  }
});

app.delete('/protoclaw/remote_connections/:id', async (req, res, next) => {
  try {
    const removed = await connectionStore.deleteConnection(req.params.id);
    await syncRemoteConnectionInfrastructure(connectionStore.listConnections());
    res.json({ ok: true, removed });
  } catch (error) {
    if (error instanceof ConnectionConfigError) {
      sendRemoteConnectionFailure(res, req, error, 404);
      return;
    }
    next(error);
  }
});

app.post('/protoclaw/remote_connections/:id/handshake', async (req, res, next) => {
  try {
    await connectionStore.ensureLoaded();
    if (!connectionStore.getConnection(req.params.id)) {
      res.status(404).json({ ok: false, error: '未找到远程连接' });
      return;
    }
    const status = await connectionHealth.runHandshake(req.params.id);
    res.json({ ok: true, status });
  } catch (error) {
    next(error);
  }
});

app.use('/vendor', express.static(path.join(__dirname, 'node_modules')));
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    if (/\.(?:html|css|js)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-store');
    }
  },
}));

app.use((error, req, res, _next) => {
  // Local failures expose a stable machine contract while retaining `error` for
  // existing clients. The server never retries or queues an uncertain write.
  const status = error.statusCode || error.status || 500;
  res.status(status).json(buildLocalFailureResponse(error, readOperationMetadata(req)));
});

async function readRemoteClawConfig() {
  try {
    return await readJsonSafe(PROJECT_REMOTE_CLAW_CONFIG_PATH, {});
  } catch {
    return {};
  }
}

async function writeRemoteClawConfig(config) {
  await ensureDir(path.dirname(PROJECT_REMOTE_CLAW_CONFIG_PATH));
  await fs.writeFile(PROJECT_REMOTE_CLAW_CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

function sanitizeRemoteClawConfig(config = {}) {
  return {
    enabled: config.enabled === true,
    relayUrl: config.relayUrl || '',
    workspaceName: config.workspaceName || 'AgentDevClaw',
    hasConnectorToken: Boolean(config.connectorToken),
    heartbeatMs: config.heartbeatMs || 15_000,
    snapshotMs: config.snapshotMs || 5_000,
    commandMs: config.commandMs || 2_000,
  };
}

function restartRemoteClawConnector() {
  remoteClawConnector?.stop?.();
  remoteClawConnector = remoteClawContext ? startEmbeddedRemoteClawConnector(remoteClawContext) : null;
}

async function relayPost(relayUrl, pathname, token, body) {
  const response = await fetch(`${cleanRemoteUrl(relayUrl)}${pathname}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body || {}),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || json.ok === false) {
    const message = json?.error?.message || json?.error || `Relay HTTP ${response.status}`;
    const error = new Error(message);
    error.statusCode = response.ok ? 502 : response.status;
    throw error;
  }
  return json.data || json;
}

async function relayGet(relayUrl, pathname, token) {
  const response = await fetch(`${cleanRemoteUrl(relayUrl)}${pathname}`, {
    headers: { 'Authorization': `Bearer ${token}`, 'X-Remote-Claw-Protocol': '1' },
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || json.ok === false) throw new Error(json?.error?.message || json?.error || `Relay HTTP ${response.status}`);
  return json.data || json;
}

async function relayDelete(relayUrl, pathname, token) {
  const response = await fetch(`${cleanRemoteUrl(relayUrl)}${pathname}`, {
    method: 'DELETE',
    headers: {
      'Authorization': `Bearer ${token}`,
      'X-Remote-Claw-Protocol': '1',
    },
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || json.ok === false) throw new Error(json?.error?.message || json?.error || `Relay HTTP ${response.status}`);
  return json.data || json;
}

function cleanRemoteUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getLanRelayCandidates(relayUrl) {
  const cleaned = cleanRemoteUrl(relayUrl);
  const candidates = [];
  if (cleaned && !/\/\/(127\.0\.0\.1|localhost)(:|\/|$)/i.test(cleaned)) candidates.push(cleaned);
  let parsed = null;
  try { parsed = cleaned ? new URL(cleaned) : null; } catch { parsed = null; }
  const port = parsed?.port || (parsed?.protocol === 'https:' ? '443' : '8080');
  const protocol = parsed?.protocol || 'http:';
  for (const [interfaceName, iface] of Object.entries(os.networkInterfaces())) {
    if (/docker|vethernet|wsl|vmware|virtualbox|loopback/i.test(interfaceName)) continue;
    for (const addr of iface || []) {
      if (addr.family !== 'IPv4' || addr.internal || /^169\.254\./.test(addr.address)) continue;
      candidates.push(`${protocol}//${addr.address}${port ? `:${port}` : ''}`);
    }
  }
  return [...new Set(candidates)];
}

function pickMobileRelayUrl(relayUrl) {
  const candidates = getLanRelayCandidates(relayUrl);
  return candidates.find((url) => !/\/\/(127\.0\.0\.1|localhost)(:|\/|$)/i.test(url)) || candidates[0] || relayUrl;
}

async function shutdown(exitCode = 0) {
  remoteClawConnector?.stop?.();
  await tunnelManager.stopAll();

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

  await viewerWorker.stop().catch(e => console.warn(e));
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

  // 初始化 crash recovery 缓存：读取上次异常关闭时的 open-sessions → 内存，然后清空文件
  for (const agentId of WORKSPACE_SESSION_AGENT_IDS) {
    try {
      await initRecoveryCache(agentId);
    } catch (err) {
      console.warn(`[open-sessions] initRecoveryCache failed for ${agentId}:`, err.message);
    }
  }

  // Apply global proxy before listening (affects all fetch + child processes)
  applyProxy();

  app.listen(APP_PORT, () => {
    log('server', `product ui: http://127.0.0.1:${APP_PORT}`);
    log('server', `viewer worker: ${VIEWER_ORIGIN}`);
    remoteClawContext = {
      getAgentsLight,
      getConnectedAgents,
      listPrebuiltSessions,
      requireAgentLight,
      activatePrebuiltSession,
      startManagedAgent,
      waitForManagedRuntimeReady,
    };
    restartRemoteClawConnector();
    fireBootSchedules();
  });
}

main().catch((error) => {
  log('server', error.stack || error.message, 'error');
  process.exit(1);
});
