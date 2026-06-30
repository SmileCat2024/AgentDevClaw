import express from 'express';
import { spawn } from 'child_process';
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

// ── Phase 0: shared infrastructure ────────────────────────────────
import {
  PROJECT_ROOT, rootRequire, APP_PORT, VIEWER_PORT,
  AGENTS_ROOT, RUNTIME_SCRIPT, ONE_SHOT_SCRIPT,
  VIEWER_ORIGIN,
  USER_DATA_ROOT, NO_SESSION_TOKEN,
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
import { sanitizeSessionFragment, cleanSessionText, isWorkspaceSessionAgent, log, getAssemblyWorkspaceDir, normalizeClientAgentId, parseListField, sanitizeSpawnEnv } from './server/shared/string-helpers.js';
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
import { notifyRuntimeReady } from './server/shared/runtime-hooks.js';

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

async function discoverAgents(rootDir, currentDir = rootDir) {
  const entries = await fs.readdir(currentDir, { withFileTypes: true });
  const results = [];

  for (const entry of entries) {
    const entryPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      results.push(...await discoverAgents(rootDir, entryPath));
      continue;
    }

    if (entry.isFile() && entry.name === 'metadata.json') {
      const metadata = await readJson(entryPath);
      const agentDir = path.dirname(entryPath);
      results.push({
        ...metadata,
        id: metadata.id ?? path.basename(agentDir),
        relativeDir: path.relative(__dirname, agentDir).replace(/\\/g, '/'),
        agentPath: agentDir,
      });
    }
  }

  return results.sort((left, right) => {
    const leftOrder = typeof left.sortOrder === 'number' ? left.sortOrder : null;
    const rightOrder = typeof right.sortOrder === 'number' ? right.sortOrder : null;
    if (leftOrder !== null && rightOrder !== null) return leftOrder - rightOrder;
    if (leftOrder !== null) return -1;
    if (rightOrder !== null) return 1;
    return (left.name || left.id).localeCompare(right.name || right.id, 'zh-CN');
  });
}

async function getAgentsLight() {
  const agents = await discoverAgents(AGENTS_ROOT);
  const visibleAgents = agents.filter((agent) => !HIDDEN_PREBUILT_AGENT_IDS.has(sanitizeSessionFragment(agent.id)));
  return visibleAgents.map((agent) => ({ ...agent, status: buildStatus(agent.id) }));
}

async function resolveAgentModelPresets(agentId, metaPresets = null) {
  const userConfigPath = path.join(__dirname, '.agentdev', 'agent-configs', `${agentId}.json`);
  const userConfig = await readJsonSafe(userConfigPath, null);
  const userPresets = userConfig?.modelPresets || null;
  if (!userPresets) return metaPresets || null;
  return {
    ...(metaPresets && typeof metaPresets === 'object' ? metaPresets : {}),
    ...userPresets,
  };
}

async function enrichAgent(agent) {
  return {
    ...agent,
    workspace_sessions: await listPrebuiltSessions(agent.id),
    workspace_data: await resolveWorkspaceData(agent),
    workspace_state: await readWorkspaceState(agent.id),
    modelPresets: await resolveAgentModelPresets(agent.id, agent.modelPresets),
  };
}

async function getAgents() {
  const lightAgents = await getAgentsLight();
  return Promise.all(lightAgents.map(enrichAgent));
}

async function requireAgentLight(agentId) {
  const lightAgents = await getAgentsLight();
  const agent = lightAgents.find((item) => item.id === agentId);
  if (agent) return agent;
  // Fallback: hidden agents (e.g. work-group-admin) are not in getAgentsLight
  const allAgents = await discoverAgents(AGENTS_ROOT);
  const hidden = allAgents.find((item) => item.id === agentId);
  if (hidden) return { ...hidden, status: buildStatus(agentId) };
  const error = new Error(`Unknown agent: ${agentId}`);
  error.statusCode = 404;
  throw error;
}

async function requireAgent(agentId) {
  const agent = await requireAgentLight(agentId);
  return enrichAgent(agent);
}

async function readViewerJson(pathname) {
  const response = await fetch(`${VIEWER_ORIGIN}${pathname}`);
  if (!response.ok) {
    throw new Error(`Viewer request failed: ${pathname} ${response.status}`);
  }
  return response.json();
}

async function getPendingInputCount(runtimeSessionId) {
  try {
    const items = await readViewerJson(`/api/agents/${encodeURIComponent(runtimeSessionId)}/input-requests`);
    return Array.isArray(items) ? items.length : 0;
  } catch {
    return null;
  }
}

function resolveActiveWorkspaceSessionMeta(agent) {
  const sessions = Array.isArray(agent?.workspace_sessions?.sessions) ? agent.workspace_sessions.sessions : [];
  const activeSessionId = cleanSessionText(agent?.status?.selectedSessionId || agent?.workspace_sessions?.activeSessionId);
  if (!activeSessionId) {
    return {
      active_workspace_session_id: null,
      active_workspace_session_form_id: null,
      active_workspace_session_title: '',
      active_workspace_agent_name: '',
      active_workspace_display_name: '',
    };
  }

  const matched = sessions.find((session) => cleanSessionText(session?.id) === activeSessionId) || null;
  const formId = cleanSessionText(matched?.formId);
  const title = cleanSessionText(matched?.title);
  const agentName = cleanSessionText(matched?.agentName);
  const displayName = formId === 'assembly-form'
    ? (agentName || title)
    : '';

  return {
    active_workspace_session_id: activeSessionId,
    active_workspace_session_form_id: formId || null,
    active_workspace_session_title: title,
    active_workspace_agent_name: agentName,
    active_workspace_display_name: displayName,
  };
}

async function resolveRuntimeDisplayName(agent, selectedSessionId = null) {
  const fallbackName = cleanSessionText(agent?.name) || cleanSessionText(agent?.id) || 'agent';
  const requestedSessionId = cleanSessionText(selectedSessionId);
  if (sanitizeSessionFragment(agent?.id) === 'qqbot') {
    try {
      const imConfig = await readProjectIMWorkspaceConfig();
      return getPortalAgentDisplayName(imConfig.selectedChannel);
    } catch {}
    return getPortalAgentDisplayName('qq');
  }
  if (!requestedSessionId) {
    return fallbackName;
  }

  try {
    const sessionIndex = await readSessionIndex(agent.id);
    const sessionRecord = sessionIndex.sessions.find((session) => cleanSessionText(session?.id) === requestedSessionId) || { id: requestedSessionId };
    const sessionSummary = await summarizePrebuiltSession(agent.id, sessionRecord);
    const formId = cleanSessionText(sessionSummary?.formId);
    if (sanitizeSessionFragment(agent?.id) === 'agent-creator' && formId === 'assembly-form') {
      return cleanSessionText(sessionSummary?.agentName) || cleanSessionText(sessionSummary?.title) || fallbackName;
    }
  } catch {
  }

  return fallbackName;
}

async function readWorkspaceSessionSnapshot(agentId) {
  const index = await readSessionIndex(agentId);
  return {
    activeSessionId: index.activeSessionId || null,
    sessions: index.sessions.map((record) => buildLightPrebuiltSessionRecord(agentId, record)),
  };
}

async function readActiveWorkspaceSessionMeta(agent) {
  const workspaceSessions = await readWorkspaceSessionSnapshot(agent.id);
  const selectedSessionId = cleanSessionText(agent?.status?.selectedSessionId || workspaceSessions.activeSessionId);
  if (!selectedSessionId) {
    let noSessionDisplayName = '';
    if (sanitizeSessionFragment(agent.id) === 'qqbot') {
      try {
        const imConfig = await readProjectIMWorkspaceConfig();
        noSessionDisplayName = getPortalAgentDisplayName(imConfig.selectedChannel);
      } catch {}
    }
    return {
      workspaceSessions,
      sessionMeta: {
        active_workspace_session_id: null,
        active_workspace_session_form_id: null,
        active_workspace_session_title: '',
        active_workspace_agent_name: '',
        active_workspace_display_name: noSessionDisplayName,
      },
    };
  }

  const matched = Array.isArray(workspaceSessions.sessions)
    ? workspaceSessions.sessions.find((session) => cleanSessionText(session?.id) === selectedSessionId) || null
    : null;
  let title = cleanSessionText(matched?.title);
  let agentName = cleanSessionText(matched?.agentName);
  let formId = cleanSessionText(matched?.formId);

  if (!matched) {
    try {
      const index = await readSessionIndex(agent.id);
      const record = Array.isArray(index?.sessions)
        ? index.sessions.find((session) => cleanSessionText(session?.id) === selectedSessionId) || null
        : null;
      title = cleanSessionText(record?.title);
      agentName = cleanSessionText(record?.agentName);
      formId = cleanSessionText(record?.formId);
    } catch {}
  }

  let displayName = formId === 'assembly-form'
    ? (agentName || title)
    : '';
  if (!displayName && sanitizeSessionFragment(agent.id) === 'qqbot') {
    try {
      const imConfig = await readProjectIMWorkspaceConfig();
      displayName = getPortalAgentDisplayName(imConfig.selectedChannel);
    } catch {}
  }

  return {
    workspaceSessions: {
      ...workspaceSessions,
      activeSessionId: selectedSessionId,
    },
    sessionMeta: {
      active_workspace_session_id: selectedSessionId,
      active_workspace_session_form_id: formId || null,
      active_workspace_session_title: title,
      active_workspace_agent_name: agentName,
      active_workspace_display_name: displayName,
    },
  };
}

async function readWorkspaceSessionMeta(agentId, sessionId) {
  const selectedSessionId = cleanSessionText(sessionId);
  if (!selectedSessionId) {
    return {
      active_workspace_session_id: null,
      active_workspace_session_form_id: null,
      active_workspace_session_title: '',
      active_workspace_agent_name: '',
      active_workspace_display_name: '',
    };
  }

  try {
    const index = await readSessionIndex(agentId);
    const record = Array.isArray(index?.sessions)
      ? index.sessions.find((session) => cleanSessionText(session?.id) === selectedSessionId) || null
      : null;
    const title = cleanSessionText(record?.title);
    const agentName = cleanSessionText(record?.agentName);
    const formId = cleanSessionText(record?.formId);
    let displayName = formId === 'assembly-form' ? (agentName || title) : '';
    if (!displayName && sanitizeSessionFragment(agentId) === 'qqbot') {
      try {
        const imConfig = await readProjectIMWorkspaceConfig();
        displayName = getPortalAgentDisplayName(imConfig.selectedChannel);
      } catch {}
    }
    return {
      active_workspace_session_id: selectedSessionId,
      active_workspace_session_form_id: formId || null,
      active_workspace_session_title: title,
      active_workspace_agent_name: agentName,
      active_workspace_display_name: displayName,
    };
  } catch {
    return {
      active_workspace_session_id: selectedSessionId,
      active_workspace_session_form_id: null,
      active_workspace_session_title: '',
      active_workspace_agent_name: '',
      active_workspace_display_name: '',
    };
  }
}

async function getConnectedAgents() {
  const prebuiltAgents = await getAgentsLight();
  const viewerData = await readViewerJson('/api/agents').catch(() => ({ agents: [], currentAgentId: null }));
  const runtimeAgents = Array.isArray(viewerData.agents) ? viewerData.agents : [];
  const managedRuntimeByViewerId = new Map(
    Array.from(managedAgents.values())
      .filter((runtime) => runtime?.viewerAgentId && runtime.process && runtime.process.exitCode === null && !runtime.stopped)
      .map((runtime) => [String(runtime.viewerAgentId), runtime])
  );

  const connectedAgents = await Promise.all(prebuiltAgents.map(async (agent) => {
    const { workspaceSessions, sessionMeta } = await readActiveWorkspaceSessionMeta(agent);
    return {
      id: agent.id,
      name: agent.name,
      base_name: agent.name,
      description: agent.description,
      kind: agent.kind || 'agent',
      launchMode: agent.launchMode || null,
      ui: agent.ui || null,
      workspace: agent.workspace || null,
      workspace_sessions: workspaceSessions,
      workspace_data: {},
      workspace_state: { forms: {}, openDirectory: '', updatedAt: null },
      active_workspace_session_id: sessionMeta.active_workspace_session_id,
      active_workspace_session_form_id: sessionMeta.active_workspace_session_form_id,
      active_workspace_session_title: sessionMeta.active_workspace_session_title,
      active_workspace_agent_name: sessionMeta.active_workspace_agent_name,
      active_workspace_display_name: sessionMeta.active_workspace_display_name,
      status: 'stopped',
      source: 'prebuilt',
      parent_id: null,
      connection_info: null,
      pid: agent.status.pid,
      runtime_session_id: agent.status.viewerAgentId,
      message_count: 0,
      pending_input_count: null,
      created_at: null,
      modelPresets: await resolveAgentModelPresets(agent.id, agent.modelPresets),
      connected: false,
    };
  }));

  for (const runtimeAgent of runtimeAgents) {
    const managedRuntime = managedRuntimeByViewerId.get(String(runtimeAgent.id || '')) || null;
    if (managedRuntime) {
      const runtimeMeta = await readWorkspaceSessionMeta(managedRuntime.agentId, managedRuntime.selectedSessionId);
      connectedAgents.push({
        id: runtimeAgent.id,
        name: runtimeMeta.active_workspace_display_name
          || runtimeMeta.active_workspace_agent_name
          || runtimeMeta.active_workspace_session_title
          || runtimeAgent.name,
        description: runtimeAgent.description || '',
        status: runtimeAgent.connected ? 'running' : 'stopped',
        source: 'child',
        parent_id: managedRuntime.agentId,
        active_workspace_session_id: runtimeMeta.active_workspace_session_id,
        active_workspace_session_form_id: runtimeMeta.active_workspace_session_form_id,
        active_workspace_session_title: runtimeMeta.active_workspace_session_title,
        active_workspace_agent_name: runtimeMeta.active_workspace_agent_name,
        active_workspace_display_name: runtimeMeta.active_workspace_display_name,
        connection_info: runtimeAgent.connectionInfo || 'viewer://127.0.0.1:2026',
        pid: runtimeAgent.pid || managedRuntime.process?.pid || null,
        runtime_session_id: runtimeAgent.id,
        message_count: runtimeAgent.messageCount ?? 0,
        pending_input_count: await getPendingInputCount(runtimeAgent.id),
        created_at: runtimeAgent.createdAt ?? managedRuntime.startedAt ?? null,
        connected: runtimeAgent.connected ?? false,
      });
      continue;
    }

    const explicitParentHost = connectedAgents.find((agent) =>
      agent.source === 'prebuilt'
      && sanitizeSessionFragment(agent.id) === sanitizeSessionFragment(runtimeAgent.parentAgentId || ''));
    const isExplicitChildRuntime = !!runtimeAgent.parentAgentId && !!explicitParentHost;

    const workspaceHostParent = connectedAgents.find((agent) =>
      agent.source === 'prebuilt'
      && sanitizeSessionFragment(agent.id) === sanitizeSessionFragment(runtimeAgent.parentAgentId || '')
      && (agent.id === 'agent-creator' || agent.id === 'feature-creator'));
    const isWorkspaceHostRuntime =
      workspaceHostParent
      && (cleanSessionText(runtimeAgent.name) === cleanSessionText(workspaceHostParent.base_name)
        || cleanSessionText(runtimeAgent.name) === cleanSessionText(workspaceHostParent.name));
    if (isWorkspaceHostRuntime) {
      continue;
    }

    const matched = connectedAgents.find((agent) => agent.id === runtimeAgent.id)
      || connectedAgents.find((agent) => agent.source === 'prebuilt' && agent.runtime_session_id === runtimeAgent.id)
      || (!isExplicitChildRuntime
        ? connectedAgents.find((agent) => agent.source === 'prebuilt' && (agent.base_name === runtimeAgent.name || agent.name === runtimeAgent.name))
        : null);
    const exposeAsSeparateAssemblyRuntime = matched
      && matched.source === 'prebuilt'
      && (sanitizeSessionFragment(matched.id) === 'agent-creator' || sanitizeSessionFragment(matched.id) === 'flow-workspace')
      && cleanSessionText(matched.active_workspace_session_form_id) === 'assembly-form';

    if (matched && !exposeAsSeparateAssemblyRuntime) {
      matched.status = runtimeAgent.connected ? 'running' : matched.status;
      matched.connection_info = 'viewer://127.0.0.1:2026';
      matched.runtime_session_id = runtimeAgent.id;
      matched.message_count = runtimeAgent.messageCount ?? 0;
      matched.created_at = runtimeAgent.createdAt ?? null;
      matched.connected = runtimeAgent.connected ?? false;
      matched.pending_input_count = await getPendingInputCount(runtimeAgent.id);
      continue;
    }

    if (!runtimeAgent.connected) {
      continue;
    }

    connectedAgents.push({
      id: runtimeAgent.id,
      name: runtimeAgent.name,
      description: runtimeAgent.description || '',
      status: runtimeAgent.connected ? 'running' : 'stopped',
      source: exposeAsSeparateAssemblyRuntime ? 'external' : (runtimeAgent.parentAgentId ? 'child' : 'external'),
      parent_id: exposeAsSeparateAssemblyRuntime ? matched.id : (runtimeAgent.parentAgentId || null),
      active_workspace_session_id: exposeAsSeparateAssemblyRuntime ? (matched.active_workspace_session_id || null) : null,
      active_workspace_session_form_id: exposeAsSeparateAssemblyRuntime ? (matched.active_workspace_session_form_id || null) : null,
      active_workspace_session_title: exposeAsSeparateAssemblyRuntime ? (matched.active_workspace_session_title || null) : null,
      active_workspace_agent_name: exposeAsSeparateAssemblyRuntime ? (matched.active_workspace_agent_name || null) : null,
      active_workspace_display_name: exposeAsSeparateAssemblyRuntime ? (matched.active_workspace_display_name || null) : null,
      connection_info: runtimeAgent.connectionInfo || 'viewer://127.0.0.1:2026',
      pid: runtimeAgent.pid || null,
      runtime_session_id: runtimeAgent.id,
      message_count: runtimeAgent.messageCount ?? 0,
      pending_input_count: await getPendingInputCount(runtimeAgent.id),
      created_at: runtimeAgent.createdAt ?? null,
      connected: runtimeAgent.connected ?? false,
    });
  }

  for (const managed of connectedAgents) {
    const status = buildStatus(managed.id);
    if (status.status === 'running') {
      managed.status = 'running';
      managed.pid = status.pid;
      managed.active_workspace_session_id = status.selectedSessionId || managed.active_workspace_session_id;
      if (status.viewerAgentId) {
        managed.runtime_session_id = status.viewerAgentId;
      }
    } else if (managed.source === 'prebuilt') {
      managed.status = 'stopped';
      managed.pid = null;
      managed.runtime_session_id = null;
      managed.message_count = 0;
      managed.pending_input_count = null;
      managed.connected = false;
      managed.callActive = false;
    }
  }

  // 查询每个 connected agent 的 call 状态（从 ViewerWorker notification）
  await Promise.all(connectedAgents
    .filter((agent) => agent.connected && agent.runtime_session_id)
    .map(async (agent) => {
      try {
        const notif = await readViewerJson(`/api/agents/${encodeURIComponent(agent.runtime_session_id)}/notification`);
        agent.callActive = notif?.callActive === true;
      } catch {
        agent.callActive = false;
      }
    })
  );

  return connectedAgents;
}

async function waitForProcessExit(child, timeoutMs = 5000) {
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

async function waitForManagedRuntimeReady(agentId, timeoutMs = 10000, sessionId = undefined) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const runtime = getAgentRuntime(agentId, sessionId);
    // Exploration agents run headlessly (no ViewerWorker) — just check ready flag
    if (runtime?.sessionType === 'exploration') {
      if (runtime.ready) return runtime;
    } else {
      const status = buildStatus(agentId, sessionId);
      if (status.viewerAgentId && runtime?.ready) {
        const agents = await getConnectedAgents();
        const viewerAgentId = cleanSessionText(status.viewerAgentId);
        const connected = agents.find((agent) => cleanSessionText(agent.id) === viewerAgentId || cleanSessionText(agent.runtime_session_id || agent.runtimeSessionId) === viewerAgentId);
        if (connected) {
          return connected;
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return null;
}

async function waitForAssemblyRuntimeReady(sessionId, timeoutMs = 10000) {
  const normalizedSessionId = sanitizeSessionFragment(sessionId);
  const start = Date.now();
  console.log(`[PERF] waitForAssemblyRuntimeReady BEGIN session=${normalizedSessionId} timeout=${timeoutMs}`);
  while (Date.now() - start < timeoutMs) {
    const runtime = getAssemblyRuntime(normalizedSessionId);
    if (runtime?.viewerAgentId && runtime?.ready) {
      const viewerData = await readViewerJson('/api/agents').catch(() => ({ agents: [] }));
      const agents = Array.isArray(viewerData?.agents) ? viewerData.agents : [];
      const connected = agents.find((agent) => agent.id === runtime.viewerAgentId);
      if (connected) {
        console.log(`[PERF] waitForAssemblyRuntimeReady FOUND (${Date.now() - start}ms)`);
        return connected;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  console.log(`[PERF] waitForAssemblyRuntimeReady TIMEOUT (${Date.now() - start}ms)`);
  return null;
}

async function startManagedAgent(agent, selectedSessionId = undefined, runtimeOptions = {}) {
  const requestedSessionId = typeof selectedSessionId === 'string' && selectedSessionId
    ? sanitizeSessionFragment(selectedSessionId)
    : (selectedSessionId === null ? null : undefined);
  let preferredSessionId = null;
  if (requestedSessionId === undefined && sanitizeSessionFragment(agent?.id) === 'qqbot') {
    preferredSessionId = (await readProjectIMWorkspaceConfig().catch(() => ({ receptionistSessionId: '' })))?.receptionistSessionId || null;
  }
  const existing = getAgentRuntime(agent.id, requestedSessionId);
  const resolvedSessionId = requestedSessionId !== undefined
    ? requestedSessionId
    : (preferredSessionId || existing?.selectedSessionId || agent.workspace_sessions?.activeSessionId || null);

  if (sanitizeSessionFragment(agent?.id) === 'qqbot') {
    const siblings = listAgentRuntimes(agent.id).filter((rt) =>
      rt?.process && rt.process.exitCode === null && !rt.stopped
      && rt !== existing
    );
    for (const rt of siblings) {
      rt.stopped = true;
      rt.process.kill('SIGTERM');
    }
    await Promise.all(siblings.map((rt) => waitForProcessExit(rt.process)));
  }

  if (resolvedSessionId && !runtimeOptions?.extraEnv?.PROTOCLAW_HANDOFF_PATH) {
    try {
      const idx = await readSessionIndex(agent.id);
      const sessionRecord = idx.sessions.find(s => s.id === resolvedSessionId);
      if (sessionRecord?.metadata?.handoffPath) {
        // Only pass handoff env when the session has no persisted messages yet.
        // If the session file already exists and contains messages, the handoff
        // was already consumed on first boot and re-injecting would duplicate
        // seed messages with conflicting turn values.
        let shouldInjectHandoff = true;
        try {
          const sessionPath = getPrebuiltSessionFilePath(agent.id, resolvedSessionId);
          const raw = await fs.readFile(sessionPath, 'utf8');
          const snapshot = JSON.parse(raw);
          const messages = snapshot?.runtime?.context?.messages;
          if (Array.isArray(messages) && messages.length > 0) {
            shouldInjectHandoff = false;
          }
        } catch {
          // Session file doesn't exist or is unreadable — safe to inject
        }
        if (shouldInjectHandoff) {
          runtimeOptions = {
            ...runtimeOptions,
            extraEnv: {
              ...(runtimeOptions?.extraEnv || {}),
              PROTOCLAW_HANDOFF_PATH: sessionRecord.metadata.handoffPath,
            },
          };
        }
      }
    } catch {}
  }

  if (existing?.process && existing.process.exitCode === null && !existing.stopped) {
    if (!resolvedSessionId || existing.selectedSessionId === resolvedSessionId) {
      return buildStatus(agent.id, resolvedSessionId);
    }

    existing.stopped = true;
    existing.process.kill('SIGTERM');
    await waitForProcessExit(existing.process);
  }

  if (existing?.process && existing.process.exitCode === null && existing.stopped) {
    await waitForProcessExit(existing.process);
  }

  const runtimeDisplayName = await resolveRuntimeDisplayName(agent, resolvedSessionId);

  const isExplorationSession = runtimeOptions?.extraEnv?.PROTOCLAW_SESSION_TYPE === 'exploration';
  const child = spawn(process.execPath, [RUNTIME_SCRIPT, agent.relativeDir, agent.id, runtimeDisplayName, resolvedSessionId || NO_SESSION_TOKEN], {
    cwd: __dirname,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: sanitizeSpawnEnv({
      ...process.env,
      ...(isExplorationSession ? {} : {
        AGENTDEV_DEBUG_TRANSPORT: 'viewer-worker',
        AGENTDEV_VIEWER_PORT: String(VIEWER_PORT),
        AGENTDEV_UDS_PATH: process.env.AGENTDEV_UDS_PATH || '\\\\.\\pipe\\agentdev-viewer',
      }),
      PROTOCLAW_SERVER_ORIGIN: APP_ORIGIN,
      PROTOCLAW_PREBUILT_AGENT_ID: String(agent.id || ''),
      PROTOCLAW_PREBUILT_SESSION_ID: resolvedSessionId || '',
      ...(runtimeOptions?.extraEnv && typeof runtimeOptions.extraEnv === 'object' ? runtimeOptions.extraEnv : {}),
    }),
    windowsHide: true,
  });

  const runtime = {
    key: getManagedRuntimeKey(agent.id, resolvedSessionId),
    agentId: agent.id,
    id: agent.id,
    process: child,
    startedAt: new Date().toISOString(),
    exitCode: null,
    stopped: false,
    viewerAgentId: null,
    selectedSessionId: resolvedSessionId || null,
    ready: false,
    sessionType: runtimeOptions?.extraEnv?.PROTOCLAW_SESSION_TYPE || null,
  };

  managedAgents.set(runtime.key, runtime);

  child.stdout.on('data', (chunk) => {
    const text = String(chunk);
    const match = text.match(/Viewer Agent ID:\s*([^\s]+)/);
    if (match) {
      runtime.viewerAgentId = match[1];
    }
    if (text.includes('[ProtoClaw Runtime] READY session=')) {
      runtime.ready = true;
      // Notify runtime-ready hook (for event-driven dispatch schedules)
      notifyRuntimeReady(agent.id, resolvedSessionId || null);
    }
    log(agent.id, text.trim());
  });

  child.stderr.on('data', (chunk) => {
    log(agent.id, String(chunk).trim(), 'error');
  });

  child.on('exit', (code) => {
    const current = managedAgents.get(runtime.key);
    if (current && current === runtime) {
      current.exitCode = code;
      current.stopped = true;
    }
    log(agent.id, `process exited with code ${code ?? 'null'}`);
  });

  child.on('error', (error) => {
    const current = managedAgents.get(runtime.key);
    if (current) {
      current.exitCode = 1;
      current.stopped = true;
    }
    log(agent.id, `failed to start: ${error.message}`, 'error');
  });

  return buildStatus(agent.id, resolvedSessionId);
}

/**
 * 启动一次性子代理（阻塞式）。
 *
 * 与 startManagedAgent 不同：
 * - 使用 run-one-shot-agent.js 而非 run-prebuilt-agent.js
 * - 不连接 ViewerWorker
 * - 只执行一次 onCall(goal) 后退出
 * - 返回 Promise，在进程退出时 resolve
 */
async function startOneShotAgent(agent, sessionId, goal, options = {}) {
  const resolvedSessionId = sanitizeSessionFragment(sessionId);
  const timeoutMs = options.timeoutMs || 300000;

  return new Promise((resolve, reject) => {
    let resultLine = null;
    const stdoutChunks = [];

    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`One-shot agent timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const child = spawn(process.execPath, [
      ONE_SHOT_SCRIPT,
      agent.relativeDir,
      agent.id,
      resolvedSessionId,
      goal,
    ], {
      cwd: __dirname,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: sanitizeSpawnEnv({
        ...process.env,
        PROTOCLAW_SERVER_ORIGIN: APP_ORIGIN,
        PROTOCLAW_PREBUILT_AGENT_ID: String(agent.id || ''),
        PROTOCLAW_PREBUILT_SESSION_ID: resolvedSessionId || '',
        ...(options.extraEnv && typeof options.extraEnv === 'object' ? options.extraEnv : {}),
      }),
      windowsHide: true,
    });

    child.stdout.on('data', (chunk) => {
      const text = String(chunk);
      stdoutChunks.push(text);
      const lines = text.split('\n');
      for (const line of lines) {
        if (line.startsWith('ONE_SHOT_RESULT:')) {
          resultLine = line;
        }
      }
      log(agent.id, text.trim());
    });

    child.stderr.on('data', (chunk) => {
      log(agent.id, String(chunk).trim(), 'error');
    });

    child.on('exit', (code) => {
      clearTimeout(timeout);
      log(agent.id, `one-shot process exited with code ${code ?? 'null'}`);

      if (resultLine) {
        try {
          const jsonStr = resultLine.slice('ONE_SHOT_RESULT:'.length);
          const result = JSON.parse(jsonStr);
          resolve({ exitCode: code, result, stdout: stdoutChunks.join('') });
        } catch (err) {
          reject(new Error(`Failed to parse one-shot result: ${err.message}`));
        }
      } else {
        reject(new Error(
          `One-shot agent exited (code ${code}) without producing a result. ` +
          `stdout: ${stdoutChunks.join('').slice(-500)}`,
        ));
      }
    });

    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(new Error(`One-shot agent failed to start: ${error.message}`));
    });
  });
}

async function startAssemblyRuntime(sessionId, agentId = 'agent-creator', preActivatedSession = null, preloadedWorkspaceState = null) {
  const _t0 = Date.now();
  console.log(`[PERF] startAssemblyRuntime BEGIN session=${sessionId} agent=${agentId} hasSession=${!!preActivatedSession} hasState=${!!preloadedWorkspaceState}`);
  const agent = await requireAgentLight(agentId || 'agent-creator');
  let session = preActivatedSession || await activatePrebuiltSession(agent.id, sessionId);
  if (!preActivatedSession) {
    console.log(`[PERF] startAssemblyRuntime activatePrebuiltSession (${Date.now() - _t0}ms)`);
  } else {
    console.log(`[PERF] startAssemblyRuntime using pre-activated session (${Date.now() - _t0}ms)`);
  }
  const normalizedSessionId = sanitizeSessionFragment(session.id);
  const existing = getAssemblyRuntime(normalizedSessionId);

  if (existing?.process && existing.process.exitCode === null && !existing.stopped) {
    return existing;
  }

  const workspaceState = preloadedWorkspaceState || await readWorkspaceState(agent.id).catch(() => ({ forms: {}, openDirectory: '', updatedAt: null }));
  if (!preloadedWorkspaceState) {
    console.log(`[PERF] startAssemblyRuntime readWorkspaceState (${Date.now() - _t0}ms)`);
  }
  const assemblyForm = workspaceState?.forms?.['assembly-form'] || {};
  const runtimeDisplayName = cleanSessionText(session.agentName)
    || cleanSessionText(assemblyForm.assembly_name)
    || 'assembled-agent';
  const assemblyWorkspace = cleanSessionText(assemblyForm.env_dir) || getAssemblyWorkspaceDir(runtimeDisplayName);
  const selectedFeatures = parseListField(assemblyForm.selected_features);
  const customWorkdir = cleanSessionText(assemblyForm.workdir);
  const runtimeWorkdir = customWorkdir || assemblyWorkspace;

  if (cleanSessionText(session.openDirectory) !== assemblyWorkspace) {
    let updatedSession = session;
    await updateSessionIndex(agent.id, (index) => {
      const sessions = index.sessions.map((item) => item.id === session.id
        ? { ...item, openDirectory: assemblyWorkspace, updatedAt: new Date().toISOString() }
        : item);
      updatedSession = sessions.find((item) => item.id === session.id) || session;
      return { ...index, sessions };
    });
    session = await summarizePrebuiltSession(agent.id, updatedSession);
  }

  await ensureAssemblyWorkspaceBase(assemblyWorkspace, runtimeDisplayName);
  console.log(`[PERF] startAssemblyRuntime ensureBase (${Date.now() - _t0}ms)`);
  const installResult = await ensureAssemblyWorkspaceDependencies(assemblyWorkspace, selectedFeatures);
  console.log(`[PERF] startAssemblyRuntime ensureDeps (${Date.now() - _t0}ms) skipped=${installResult.skipped}`);
  if (installResult.installedPackages.length > 0) {
    log(`assembly:${normalizedSessionId}`, `refreshed feature dependencies: ${installResult.installedPackages.join(', ')}`);
  }
  await writeWorkspaceState(agent.id, {
    forms: {
      ...(workspaceState?.forms || {}),
      'assembly-form': {
        ...assemblyForm,
        assembly_name: runtimeDisplayName,
        env_created: '1',
        env_dir: assemblyWorkspace,
        env_configured_name: runtimeDisplayName,
        env_configured_features: selectedFeatures.join('\n'),
        env_status: 'ready',
        env_status_message: selectedFeatures.length > 0
          ? `Runtime dependencies refreshed for ${selectedFeatures.length} feature(s).`
          : 'Runtime dependencies refreshed.',
      },
    },
    openDirectory: assemblyWorkspace,
  });
  console.log(`[PERF] startAssemblyRuntime writeWorkspaceState (${Date.now() - _t0}ms)`);
  const spawnArgs = [
    String(RUNTIME_SCRIPT),
    String(agent.relativeDir || ''),
    String(agent.id || ''),
    String(runtimeDisplayName || ''),
    String(normalizedSessionId || ''),
  ];
  const child = spawn(process.execPath, spawnArgs, {
    cwd: __dirname,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: sanitizeSpawnEnv({
      ...process.env,
      AGENTDEV_DEBUG_TRANSPORT: 'viewer-worker',
      AGENTDEV_VIEWER_PORT: String(VIEWER_PORT),
      AGENTDEV_UDS_PATH: process.env.AGENTDEV_UDS_PATH || '\\\\.\\pipe\\agentdev-viewer',
      PROTOCLAW_PREBUILT_AGENT_ID: String(agent.id || ''),
      PROTOCLAW_PREBUILT_SESSION_ID: normalizedSessionId,
      PROTOCLAW_ASSEMBLY_RUNTIME: '1',
      PROTOCLAW_ASSEMBLY_WORKSPACE: runtimeWorkdir,
    }),
    windowsHide: true,
  });

  const runtime = {
    sessionId: normalizedSessionId,
    requestedName: runtimeDisplayName,
    workspaceDir: runtimeWorkdir,
    installedPackages: selectedFeatures,
    process: child,
    startedAt: new Date().toISOString(),
    exitCode: null,
    viewerAgentId: null,
    ready: false,
    stopped: false,
  };

  assemblyRuntimeProcesses.set(normalizedSessionId, runtime);
  console.log(`[PERF] startAssemblyRuntime process SPAWNED (${Date.now() - _t0}ms) pid=${child.pid}`);

  child.stdout?.on('data', (chunk) => {
    const text = chunk.toString();
    log(`assembly:${normalizedSessionId}`, text.trimEnd());
    const viewerMatch = text.match(/Viewer Agent ID:\s*(\S+)/);
    if (viewerMatch) {
      runtime.viewerAgentId = viewerMatch[1];
      console.log(`[PERF] startAssemblyRuntime viewerAgentId=${viewerMatch[1]} (${Date.now() - _t0}ms)`);
    }
    if (text.includes('READY session=')) {
      runtime.ready = true;
      console.log(`[PERF] startAssemblyRuntime READY (${Date.now() - _t0}ms)`);
    }
  });

  child.stderr?.on('data', (chunk) => {
    log(`assembly:${normalizedSessionId}`, chunk.toString().trimEnd(), 'error');
  });

  child.on('exit', (code) => {
    runtime.exitCode = code ?? 0;
    runtime.stopped = true;
    assemblyRuntimeProcesses.delete(normalizedSessionId);
  });

  return runtime;
}

async function stopManagedAgent(agentId, sessionId = undefined) {
  const runtimes = sessionId === undefined ? listAgentRuntimes(agentId) : [getAgentRuntime(agentId, sessionId)].filter(Boolean);
  if (runtimes.length === 0) {
    return buildStatus(agentId, sessionId);
  }

  for (const runtime of runtimes) {
    if (!runtime?.process || runtime.process.exitCode !== null || runtime.stopped) {
      continue;
    }
    runtime.stopped = true;
    runtime.process.kill('SIGTERM');
  }
  return buildStatus(agentId, sessionId);
}

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

// ── Identity Registry API ─────────────────────────────────────────

/**
 * 收集所有已启用 prebuilt agent 声明的 identities。
 * 无 identities 声明的 workspace 自动生成默认身份（向后兼容）。
 */
async function collectIdentities() {
  const agents = await discoverAgents(AGENTS_ROOT);
  const identities = [];

  for (const agent of agents) {
    if (agent.enabled === false) continue;
    if (agent.launchMode === 'ui-only') continue;

    const declared = Array.isArray(agent.identities) ? agent.identities : null;
    if (!declared || declared.length === 0) continue;

    for (const id of declared) {
      // 只暴露显式标记为 groupChat 的身份
      if (!id.groupChat) continue;

      identities.push({
        workspaceId: agent.id,
        workspaceName: agent.name,
        identityId: id.id,
        identityRef: `${agent.id}:${id.id}`,
        displayName: id.displayName || id.id,
        description: id.description || '',
        sessionModel: id.sessionModel || 'persistent',
        qualifierLabel: id.qualifierLabel || null,
        operations: Array.isArray(id.operations) ? id.operations : [],
        callTimeoutMs: typeof id.callTimeoutMs === 'number' ? id.callTimeoutMs : 900000,
      });
    }
  }

  return identities;
}

app.get('/protoclaw/identities', async (_req, res, next) => {
  try {
    const identities = await collectIdentities();
    res.json({ identities });
  } catch (error) {
    next(error);
  }
});

app.get('/protoclaw/identities/:workspaceId/:identityId/sessions', async (req, res, next) => {
  try {
    const { workspaceId, identityId } = req.params;

    // 验证 identity 存在
    const identities = await collectIdentities();
    const identity = identities.find(
      (i) => i.workspaceId === workspaceId && i.identityId === identityId
    );
    if (!identity) {
      return res.status(404).json({ error: `Identity not found: ${workspaceId}:${identityId}` });
    }

    const sessions = [];

    if (identity.sessionModel === 'persistent' && identity.qualifierLabel) {
      // 有 qualifierLabel 的 persistent 身份：从 session index 提取 qualifier 列表
      try {
        const index = await readSessionIndex(workspaceId);
        const seen = new Set();

        for (const record of index.sessions) {
          if (record.archived) continue;
          // qualifier 优先用 openDirectory，其次 title
          const qualifier = record.openDirectory || record.title || record.id;
          if (!qualifier || seen.has(qualifier)) continue;
          seen.add(qualifier);

          sessions.push({
            qualifier,
            label: record.title || qualifier,
            status: buildStatus(workspaceId).status === 'running' ? 'running' : 'idle',
            lastActiveTime: record.updatedAt || record.createdAt || null,
            summary: record.goal || null,
          });
        }
      } catch {
        // session index 不存在或读取失败 → 空列表
      }
    }

    const allowCreate = identity.operations.includes('create');

    res.json({
      sessions,
      allowCreate,
      qualifierLabel: identity.qualifierLabel,
    });
  } catch (error) {
    next(error);
  }
});

// ── End Identity Registry API ─────────────────────────────────────

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

// ── Group Chat API → server/routes/group-chat.js ──
setupGroupChatRoutes(app, express, {
  collectIdentities,
  createPrebuiltSession,
  startManagedAgent,
  stopManagedAgent,
  waitForManagedRuntimeReady,
  requireAgentLight,
  readViewerJson,
  discoverAgents,
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

app.get('/protoclaw/health', (_req, res) => {
  res.json({ ok: true, appPort: APP_PORT, viewerPort: VIEWER_PORT });
});

app.get('/protoclaw/get_prebuilt_agents', async (_req, res, next) => {
  try {
    const agents = await getAgents();
    res.json(agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      description: agent.description,
      icon: agent.icon,
      category: agent.category,
      kind: agent.kind || 'agent',
      launchMode: agent.launchMode || null,
      ui: agent.ui || null,
      features: agent.features || [],
      workspace: agent.workspace || null,
      workspace_sessions: agent.workspace_sessions || { activeSessionId: null, sessions: [] },
      workspace_data: agent.workspace_data || {},
      workspace_state: agent.workspace_state || { forms: {}, openDirectory: '', updatedAt: null },
      active_workspace_session_id: agent.workspace_sessions?.activeSessionId || null,
      modelPresets: agent.modelPresets || null,
      entry_point: agent.relativeDir,
    })));
  } catch (error) {
    next(error);
  }
});

app.get('/protoclaw/get_agents_status', async (_req, res, next) => {
  try {
    const agents = await getAgentsLight();
    res.json(agents.map((agent) => ({
      id: agent.id,
      status: buildStatus(agent.id).status,
      pid: buildStatus(agent.id).pid,
    })));
  } catch (error) {
    next(error);
  }
});

app.get('/protoclaw/get_connected_agents', async (_req, res, next) => {
  try {
    res.json(await getConnectedAgents());
  } catch (error) {
    next(error);
  }
});

app.get('/protoclaw/agent_detail', async (req, res, next) => {
  try {
    const agentId = String(req.query.agentId || '').trim();
    if (!agentId) {
      res.status(400).json({ error: 'agentId is required' });
      return;
    }
    const lightAgents = await getAgentsLight();
    const agent = lightAgents.find((item) => item.id === agentId);
    if (!agent) {
      res.status(404).json({ error: `Unknown agent: ${agentId}` });
      return;
    }
    const enriched = await enrichAgent(agent);
    res.json({
      workspace_sessions: enriched.workspace_sessions || { activeSessionId: null, sessions: [] },
      workspace_data: enriched.workspace_data || {},
      workspace_state: enriched.workspace_state || { forms: {}, openDirectory: '', updatedAt: null },
    });
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/start_agent', express.json(), async (req, res, next) => {
  try {
    const agent = await requireAgentLight(req.body.agentId);
    if (agent.launchMode === 'ui-only') {
      const connectedAgents = await getConnectedAgents();
      const connected = connectedAgents.find((item) => item.id === agent.id) || null;
      res.json({ status: buildStatus(agent.id), agent: connected });
      return;
    }
    // Block qqbot from starting when no IM channel is selected
    if (sanitizeSessionFragment(agent.id) === 'qqbot') {
      const wsConfig = await readProjectIMWorkspaceConfig();
      if (!wsConfig.selectedChannel) {
        const connectedAgents = await getConnectedAgents();
        const connected = connectedAgents.find((item) => item.id === agent.id) || null;
        res.json({ status: buildStatus(agent.id), agent: connected, warning: '未选择 IM 渠道，门户代理不会启动' });
        return;
      }
    }
    const selectedSessionId = req.body.sessionId || null;
    const status = await startManagedAgent(agent, selectedSessionId);
    const connected = await waitForManagedRuntimeReady(agent.id, 10000, selectedSessionId);
    res.json({ status, agent: connected });
  } catch (error) {
    next(error);
  }
});

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


app.post('/protoclaw/stop_agent', express.json(), async (req, res, next) => {
  try {
    const status = await stopManagedAgent(req.body.agentId, req.body.sessionId);
    res.json(status);
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/restart_agent', express.json(), async (req, res, next) => {
  try {
    const agent = await requireAgentLight(req.body.agentId);
    // Block qqbot from restarting when no IM channel is selected
    if (sanitizeSessionFragment(agent.id) === 'qqbot') {
      const wsConfig = await readProjectIMWorkspaceConfig();
      if (!wsConfig.selectedChannel) {
        await stopManagedAgent(agent.id, req.body.sessionId || null);
        const connectedAgents = await getConnectedAgents();
        const connected = connectedAgents.find((item) => item.id === agent.id) || null;
        res.json({ status: buildStatus(agent.id), agent: connected, warning: '未选择 IM 渠道，门户代理不会启动' });
        return;
      }
    }
    const selectedSessionId = req.body.sessionId || null;
    await stopManagedAgent(agent.id, selectedSessionId);
    const status = await startManagedAgent(agent, selectedSessionId);
    const connected = await waitForManagedRuntimeReady(agent.id, 10000, selectedSessionId);
    res.json({ status, agent: connected });
  } catch (error) {
    next(error);
  }
});

setupFsOperationsRoutes(app);

setupWorkspaceCreatorRoutes(app, express);


// ── Server-side audio feedback for choice input requests ───────────────────

const _seenChoiceRequestIds = new Set();
const PLAY_SOUND_SCRIPT = path.join(__dirname, 'scripts', 'play-sound.ps1');

/**
 * Play an audio file on the server machine via PowerShell MCI.
 * Fire-and-forget — does not block the response.
 */
function playSoundOnServer(soundFile) {
  const soundPath = path.join(__dirname, 'public', 'sounds', soundFile);
  const child = spawn('powershell', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', PLAY_SOUND_SCRIPT,
    '-Path', soundPath,
  ], { stdio: 'ignore', windowsHide: true, detached: true });
  child.unref();
}

/**
 * Intercept input-requests proxy: forward to ViewerWorker, but also inspect
 * the response for new choice-type requests and play a terminal bell sound
 * on the server immediately — independent of frontend rendering state.
 */
app.get('/api/agents/:agentId/input-requests', async (req, res, next) => {
  try {
    const targetUrl = `${VIEWER_ORIGIN}${req.originalUrl}`;
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value == null) continue;
      if (key.toLowerCase() === 'host') continue;
      headers.set(key, Array.isArray(value) ? value.join(', ') : value);
    }
    const response = await fetch(targetUrl, { method: 'GET', headers });
    res.status(response.status);
    response.headers.forEach((value, key) => {
      if (key.toLowerCase() === 'transfer-encoding') return;
      res.setHeader(key, value);
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    res.end(buffer);

    // Detect new choice requests after forwarding the response
    if (response.ok) {
      try {
        const requests = JSON.parse(buffer.toString('utf8'));
        if (Array.isArray(requests)) {
          for (const r of requests) {
            const isChoice = r && r.mode === 'choices'
              && Array.isArray(r.questions) && r.questions.length > 0
              && typeof r.requestId === 'string';
            if (isChoice && !_seenChoiceRequestIds.has(r.requestId)) {
              if (_seenChoiceRequestIds.size > 500) _seenChoiceRequestIds.clear();
              _seenChoiceRequestIds.add(r.requestId);
              playSoundOnServer('terminal-bell.mp3');
              break; // one bell per poll cycle
            }
          }
        }
      } catch { /* non-critical */ }
    }
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
