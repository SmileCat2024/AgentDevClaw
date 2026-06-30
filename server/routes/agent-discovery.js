import path from 'path';
import { promises as fs } from 'fs';
import {
  AGENTS_ROOT, HIDDEN_PREBUILT_AGENT_IDS, VIEWER_ORIGIN, PROJECT_ROOT,
} from '../shared/constants.js';
import { sanitizeSessionFragment, cleanSessionText } from '../shared/string-helpers.js';
import { readJson, readJsonSafe } from '../shared/fs-helpers.js';
import { buildStatus } from '../shared/agent-access.js';
import { readSessionIndex } from '../shared/session-access.js';
import { resolveWorkspaceData, readWorkspaceState } from './workspace.js';
import { readProjectIMWorkspaceConfig, getPortalAgentDisplayName } from './im.js';

// ── Agent Discovery + Identity ─────────────────────────────────────
// Factory pattern: sessionApi is a mutable reference object that gets
// filled after session-helpers is created, breaking the circular
// dependency (agent-discovery → session-helpers → agent-discovery).

export function createAgentDiscoveryModule(ctx) {
  const { sessionApi } = ctx;

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
          relativeDir: path.relative(PROJECT_ROOT, agentDir).replace(/\\/g, '/'),
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
    const userConfigPath = path.join(PROJECT_ROOT, '.agentdev', 'agent-configs', `${agentId}.json`);
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
      workspace_sessions: await sessionApi.listPrebuiltSessions(agent.id),
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
      const sessionSummary = await sessionApi.summarizePrebuiltSession(agent.id, sessionRecord);
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
      sessions: index.sessions.map((record) => sessionApi.buildLightPrebuiltSessionRecord(agentId, record)),
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

  // ── Identity Registry ─────────────────────────────────────────────

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

  // ── Route Registration ────────────────────────────────────────────

  function setupRoutes(app) {
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
  }

  return {
    discoverAgents,
    getAgentsLight,
    resolveAgentModelPresets,
    enrichAgent,
    getAgents,
    requireAgentLight,
    requireAgent,
    readViewerJson,
    getPendingInputCount,
    resolveActiveWorkspaceSessionMeta,
    resolveRuntimeDisplayName,
    readWorkspaceSessionSnapshot,
    readActiveWorkspaceSessionMeta,
    readWorkspaceSessionMeta,
    collectIdentities,
    setupRoutes,
  };
}
