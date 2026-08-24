import {
  managedAgents,
  buildStatus,
} from '../shared/agent-access.js';
import {
  sanitizeSessionFragment, cleanSessionText,
} from '../shared/string-helpers.js';
import { getGroupChatsForSidebar } from './group-chat.js';
import { collectSidebarIdentityEntries } from './agent-discovery.js';

// ── Connected Agents Query ───────────────────────────────────────
// Pure query logic: assembles the full connected-agents list from
// prebuilt agents metadata, ViewerWorker runtime data, and managed
// runtime processes. No side effects, no process spawning.

export function createConnectedAgentsQuery(deps) {
  const {
    getAgentsLight,
    readActiveWorkspaceSessionMeta,
    readWorkspaceSessionMeta,
    readViewerJson,
    getPendingInputCount,
    resolveAgentModelPresets,
  } = deps;

  async function getConnectedAgents() {
    const prebuiltAgents = await getAgentsLight();
    const viewerData = await readViewerJson('/api/agents').catch(() => ({ agents: [] }));
    const runtimeAgents = Array.isArray(viewerData.agents) ? viewerData.agents : [];
    const managedRuntimeByViewerId = new Map(
      Array.from(managedAgents.values())
        .filter((runtime) => runtime?.viewerAgentId
          && runtime.process
          && runtime.process.exitCode === null
          && !runtime.stopped
          && !runtime.stopping)
        .map((runtime) => [String(runtime.viewerAgentId), runtime])
    );
    const stoppingViewerRuntimeIds = new Set(
      Array.from(managedAgents.values())
        .filter((runtime) => runtime?.stopping && runtime?.viewerAgentId)
        .map((runtime) => String(runtime.viewerAgentId))
    );

    // Pre-fetch group chat data for work-group sidebar grouping.
    // Only reads files when work-group agent is present; skipped otherwise.
    const hasWorkGroup = prebuiltAgents.some((agent) => sanitizeSessionFragment(agent.id) === 'work-group');
    const gcChats = hasWorkGroup ? await getGroupChatsForSidebar() : [];

    const connectedAgents = await Promise.all(prebuiltAgents.map(async (agent) => {
      const { workspaceSessions, sessionMeta } = await readActiveWorkspaceSessionMeta(agent);
      const isWorkGroup = sanitizeSessionFragment(agent.id) === 'work-group';
      return {
        id: agent.id,
        name: agent.name,
        base_name: agent.name,
        description: agent.description,
        kind: agent.kind || 'agent',
        launchMode: agent.launchMode || null,
        processMode: agent.processMode || 'isolated',
        ui: agent.ui || null,
        workspace: agent.workspace || null,
        workspace_sessions: workspaceSessions,
        workspace_data: {},
        workspace_state: isWorkGroup
          ? { forms: {}, openDirectory: '', updatedAt: null, gcChats }
          : { forms: {}, openDirectory: '', updatedAt: null },
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
      if (stoppingViewerRuntimeIds.has(String(runtimeAgent.id || ''))) continue;
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
        matched.input_accepted = runtimeAgent.inputAccepted !== false;
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
        input_accepted: runtimeAgent.inputAccepted !== false,
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

    // Sidebar 投影：identities[].sidebarEntry=true 的身份展开为独立侧栏条目。
    // 必须在状态/callActive 全部落定后拷贝宿主字段（共享 runtime 状态），
    // 并紧邻宿主插入以保持侧栏分组顺序。runtime 匹配循环不会看到投影条目
    //（id 含 ':'，且 name 匹配时宿主条目在前），不会误绑外部 runtime。
    const projectionsByHostId = new Map();
    for (const light of prebuiltAgents) {
      const identities = collectSidebarIdentityEntries(light);
      if (!identities.length) continue;
      const host = connectedAgents.find((a) => a.source === 'prebuilt' && a.id === light.id);
      if (!host) continue;
      projectionsByHostId.set(light.id, await Promise.all(identities.map(async (identity) => ({
        ...host,
        id: `${host.id}:${identity.id}`,
        agentId: host.id,
        sessionType: identity.sessionType || identity.id,
        name: identity.displayName || identity.id,
        base_name: identity.displayName || identity.id,
        description: identity.description || host.description,
        icon: identity.icon || host.icon || null,
        ui: identity.ui || null,
        modelPresets: await resolveAgentModelPresets(identity.id, identity.modelPresets),
      }))));
    }
    if (projectionsByHostId.size === 0) {
      return connectedAgents;
    }
    const withProjections = [];
    for (const entry of connectedAgents) {
      withProjections.push(entry);
      const projections = entry.source === 'prebuilt' ? projectionsByHostId.get(entry.id) : null;
      if (projections) withProjections.push(...projections);
    }
    return withProjections;
  }

  return { getConnectedAgents };
}
