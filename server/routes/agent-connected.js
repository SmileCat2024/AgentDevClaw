import {
  managedAgents,
  buildStatus,
} from '../shared/agent-access.js';
import {
  sanitizeSessionFragment, cleanSessionText,
} from '../shared/string-helpers.js';
import { PH_STYLE_WORKSPACE_AGENT_IDS } from '../shared/constants.js';
import { parseRemoteNamespace } from '../shared/request-target.js';
import { getGroupChatsForSidebar } from './group-chat.js';
import { collectSidebarIdentityEntries } from './agent-discovery.js';
import { readWorkspaceState } from './workspace.js';
import {
  trimSessionRecordForWire,
  sliceSessionsForWire,
} from './session-helpers-pure.js';

// ── Connected Agents Query ───────────────────────────────────────
// Pure query logic: assembles the full connected-agents list from
// prebuilt agents metadata, ViewerWorker runtime data, and managed
// runtime processes. No side effects, no process spawning.
//
// workspace_sessions 响应投影：PH 类工作空间只内嵌当前项目的首屏切片
// （会话规模可达千级，全量内嵌曾使该 3s poll 响应膨胀至 MB 级）；其余
// agent 全量但走 wire 字段裁剪。服务端内部消费（sessionType 索引、active
// 会话解析）在组装前使用完整快照，不受裁剪影响。
const CONNECTED_PAGE_LIMIT = 60;

export function buildWireSessionsSnapshot(agentId, workspaceSessions) {
  const sessions = Array.isArray(workspaceSessions?.sessions) ? workspaceSessions.sessions : [];
  const trimmed = sessions.map(trimSessionRecordForWire);
  if (!PH_STYLE_WORKSPACE_AGENT_IDS.has(sanitizeSessionFragment(agentId))) {
    return { ...workspaceSessions, sessions: trimmed };
  }
  // PH 回退（workspace_state 不可读）：仍带分页元信息（全量已加载），
  // 前端据 sessionTotal 字段存在性判定分页语义，不因缺字段回退混乱。
  // coder 排除口径与正常路径（buildPhProjectScopedSnapshot）一致。
  const counts = sliceSessionsForWire(sessions, { excludeSessionTypes: ['coder'] });
  return {
    ...workspaceSessions,
    sessionProjectDir: null,
    sessionTotal: trimmed.length,
    sessionOffset: 0,
    sessionHasMore: false,
    mainTotal: counts.mainTotal,
    archivedTotal: counts.archivedTotal,
    sessions: trimmed,
  };
}

export async function buildPhProjectScopedSnapshot(agentId, workspaceSessions) {
  const sessions = Array.isArray(workspaceSessions?.sessions) ? workspaceSessions.sessions : [];
  let projectDir = '';
  try {
    const wsState = await readWorkspaceState(agentId);
    projectDir = String(wsState?.openDirectory || '').trim();
  } catch { /* workspace state unavailable → unpaged trim */ }
  if (!projectDir) return buildWireSessionsSnapshot(agentId, workspaceSessions);
  const page = sliceSessionsForWire(sessions, {
    projectDir,
    limit: CONNECTED_PAGE_LIMIT,
    excludeSessionTypes: ['coder'],
  });
  return {
    ...workspaceSessions,
    sessionProjectDir: projectDir,
    sessionTotal: page.total,
    sessionOffset: 0,
    sessionHasMore: page.slice.length < page.total,
    mainTotal: page.mainTotal,
    archivedTotal: page.archivedTotal,
    sessions: page.slice.map(trimSessionRecordForWire),
  };
}

export function createConnectedAgentsQuery(deps) {
  const {
    getAgentsLight,
    readActiveWorkspaceSessionMeta,
    readWorkspaceSessionMeta,
    readViewerJson,
    getPendingInputCount,
    resolveAgentModelPresets,
    readRemoteCatalog = null,
  } = deps;

  // 在线远程连接中属于本地宿主的存活身份（"宿主Id sessionType"集合）。
  // coder 等投影身份只在远程主机运行时，投影条目由此获得存在依据；
  // 身份判定与本地路径同构（宿主归属 + sessionType），不引入新概念。
  async function collectRemoteLiveIdentities() {
    if (typeof readRemoteCatalog !== 'function') return new Set();
    const catalog = await readRemoteCatalog().catch(() => null);
    const identities = new Set();
    const sections = Array.isArray(catalog?.connections) ? catalog.connections : [];
    for (const section of sections) {
      if (section?.status !== 'connected') continue;
      const workspaces = Array.isArray(section.workspaces) ? section.workspaces : [];
      for (const workspace of workspaces) {
        const entries = Array.isArray(workspace?.entries) ? workspace.entries : [];
        for (const entry of entries) {
          const owner = entry?.agentId
            ? parseRemoteNamespace(String(entry.agentId))?.agentId || ''
            : '';
          const sessionType = String(entry?.sessionType || '').trim();
          if (owner && sessionType) identities.add(`${owner} ${sessionType}`);
        }
      }
    }
    return identities;
  }

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

    // 会话级身份索引：managed child runtime 条目按 sessionId 解析 sessionType，
    // 前端据此把 coder 会话 runtime 归到 coder 投影条目（而非宿主 main 条目）下。
    const sessionTypeByAgentAndId = new Map();
    const connectedAgents = await Promise.all(prebuiltAgents.map(async (agent) => {
      const { workspaceSessions, sessionMeta } = await readActiveWorkspaceSessionMeta(agent);
      const isWorkGroup = sanitizeSessionFragment(agent.id) === 'work-group';
      for (const session of Array.isArray(workspaceSessions?.sessions) ? workspaceSessions.sessions : []) {
        const sid = String(session?.id || '').trim();
        if (sid) sessionTypeByAgentAndId.set(`${agent.id} ${sid}`, session.sessionType || 'main');
      }
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
        workspace_sessions: PH_STYLE_WORKSPACE_AGENT_IDS.has(sanitizeSessionFragment(agent.id))
          ? await buildPhProjectScopedSnapshot(agent.id, workspaceSessions)
          : buildWireSessionsSnapshot(agent.id, workspaceSessions),
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
        // sessionType fallback: the runtime record carries the authoritative
        // snapshot resolved at spawn time. The session index read can miss
        // during successor-commit / index-write races; falling straight back
        // to 'main' misroutes a coder session onto the host row.
        const sessionType = sessionTypeByAgentAndId.get(`${managedRuntime.agentId} ${managedRuntime.selectedSessionId}`)
          || managedRuntime.sessionType
          || 'main';
        connectedAgents.push({
          id: runtimeAgent.id,
          sessionType,
          sidebar_entry_id: sessionType === 'main'
            ? managedRuntime.agentId
            : `${managedRuntime.agentId}:${sessionType}`,
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
          open_directory: runtimeMeta.open_directory || '',
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

      // Viewer-only child runtimes do not carry workspace metadata themselves.
      // Resolve their selected session through the same session index used for
      // managed runtimes, so the sidebar can project the real directory instead
      // of falling back to an internal parent agent id.
      const childWorkspaceMeta = !exposeAsSeparateAssemblyRuntime && runtimeAgent.parentAgentId
        ? await readWorkspaceSessionMeta(runtimeAgent.parentAgentId, runtimeAgent.selectedSessionId)
        : null;
      connectedAgents.push({
        id: runtimeAgent.id,
        name: runtimeAgent.name,
        description: runtimeAgent.description || '',
        status: runtimeAgent.connected ? 'running' : 'stopped',
        source: exposeAsSeparateAssemblyRuntime ? 'external' : (runtimeAgent.parentAgentId ? 'child' : 'external'),
        parent_id: exposeAsSeparateAssemblyRuntime ? matched.id : (runtimeAgent.parentAgentId || null),
        sidebar_entry_id: exposeAsSeparateAssemblyRuntime
          ? matched.id
          : (runtimeAgent.parentAgentId
            ? (String(runtimeAgent.sessionType || 'main') === 'main'
              ? runtimeAgent.parentAgentId
              : `${runtimeAgent.parentAgentId}:${String(runtimeAgent.sessionType || 'main')}`)
            : ''),
        active_workspace_session_id: exposeAsSeparateAssemblyRuntime
          ? (matched.active_workspace_session_id || null)
          : (childWorkspaceMeta?.active_workspace_session_id || null),
        active_workspace_session_form_id: exposeAsSeparateAssemblyRuntime
          ? (matched.active_workspace_session_form_id || null)
          : (childWorkspaceMeta?.active_workspace_session_form_id || null),
        active_workspace_session_title: exposeAsSeparateAssemblyRuntime
          ? (matched.active_workspace_session_title || null)
          : (childWorkspaceMeta?.active_workspace_session_title || null),
        active_workspace_agent_name: exposeAsSeparateAssemblyRuntime
          ? (matched.active_workspace_agent_name || null)
          : (childWorkspaceMeta?.active_workspace_agent_name || null),
        active_workspace_display_name: exposeAsSeparateAssemblyRuntime
          ? (matched.active_workspace_display_name || null)
          : (childWorkspaceMeta?.active_workspace_display_name || null),
        open_directory: exposeAsSeparateAssemblyRuntime
          ? ''
          : (childWorkspaceMeta?.open_directory || ''),
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
      let status = buildStatus(managed.id);
      // The workspace row represents the main identity. A coder session shares
      // the workspace host but belongs to the separate sidebar projection; do
      // not let primary-runtime selection attach that child to the PH row.
      if (managed.source === 'prebuilt'
        && status.status === 'running'
        && sessionTypeByAgentAndId.get(`${managed.id} ${status.selectedSessionId}`) === 'coder') {
        const mainRuntime = Array.from(managedRuntimeByViewerId.values())
          .find((runtime) => runtime.agentId === managed.id
            && sessionTypeByAgentAndId.get(`${managed.id} ${runtime.selectedSessionId}`) !== 'coder');
        status = mainRuntime
          ? buildStatus(managed.id, mainRuntime.selectedSessionId)
          : {
            ...status,
            status: 'stopped',
            pid: null,
            viewerAgentId: null,
            selectedSessionId: null,
          };
      }
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
    //
    // 投影条目仅在该身份存在存活 runtime 会话时出现（coder 会话进程在线）；
    // 身份闲置时左侧不出现面板，浏览入口在工作空间内部的项目卡片 coder tab。
    //
    // 会话级字段（runtime_session_id / active_workspace_* / workspace_sessions /
    // message_count 等）不继承：那是宿主 main 会话的内容，继承会在投影条目
    // 下合成出 main 会话的镜像。coder 的运行信号来自线程 lifeState，
    // coder 会话 runtime 由 sessionType 路由到投影条目下。
    const remoteLiveIdentities = await collectRemoteLiveIdentities();
    const projectionsByHostId = new Map();
    for (const light of prebuiltAgents) {
      const identities = collectSidebarIdentityEntries(light);
      if (!identities.length) continue;
      const host = connectedAgents.find((a) => a.source === 'prebuilt' && a.id === light.id);
      if (!host) continue;
      const projected = (await Promise.all(identities.map(async (identity) => {
        const identitySessionType = identity.sessionType || identity.id;
        // Live-session detection keeps the projection visible across the
        // relay window (old runtime exiting → new runtime spawning): a
        // spawned-but-not-yet-registered runtime is still a live process in
        // managedAgents, so the projection does not vanish for the whole
        // startup stretch. The spawn-time sessionType snapshot is
        // authoritative here — coder runtimes always carry it.
        // 第三来源：远程主机上存活的同身份会话。coder 只在远程运行时，本地无
        // runtime 也无 managed 进程，投影条目由远程 catalog 快照支撑。
        const hasLiveSession = connectedAgents.some((a) => a.source === 'child'
          && a.parent_id === host.id
          && a.sessionType === identitySessionType)
          || Array.from(managedAgents.values()).some((runtime) => (
            runtime.agentId === host.id
            && runtime.process
            && runtime.process.exitCode === null
            && !runtime.stopped
            && !runtime.stopping
            && (runtime.sessionType || 'main') === identitySessionType
          ))
          || remoteLiveIdentities.has(`${host.id} ${identitySessionType}`);
        if (!hasLiveSession) return null;
        const {
          workspace_sessions: _ws,
          workspace_state: _wstate,
          active_workspace_session_id: _awsid,
          active_workspace_session_form_id: _awsfid,
          active_workspace_session_title: _awst,
          active_workspace_agent_name: _awgn,
          active_workspace_display_name: _awdn,
          runtime_session_id: _rsid,
          message_count: _mc,
          pending_input_count: _pic,
          callActive: _ca,
          pid: _pid,
          created_at: _cat,
          ...hostBase
        } = host;
        return {
          ...hostBase,
          id: `${host.id}:${identity.id}`,
          agentId: host.id,
          sessionType: identitySessionType,
          name: identity.displayName || identity.id,
          base_name: identity.displayName || identity.id,
          description: identity.description || host.description,
          icon: identity.icon || host.icon || null,
          ui: identity.ui || null,
          sidebarGroup: identity.sidebarGroup || null,
          modelPresets: await resolveAgentModelPresets(identity.id, identity.modelPresets),
        };
      }))).filter(Boolean);
      if (projected.length) projectionsByHostId.set(light.id, projected);
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
