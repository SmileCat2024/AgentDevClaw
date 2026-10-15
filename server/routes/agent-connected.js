import {
  managedAgents,
  buildStatus,
  isManagedRuntimeRunning,
  listAgentRuntimes,
} from '../shared/agent-access.js';
import {
  sanitizeSessionFragment, cleanSessionText,
} from '../shared/string-helpers.js';
import { PH_STYLE_WORKSPACE_AGENT_IDS } from '../shared/constants.js';
import { getGroupChatsForSidebar } from './group-chat.js';
import { readWorkspaceState } from './workspace.js';
import {
  trimSessionRecordForWire,
  sliceSessionsForWire,
} from './session-helpers-pure.js';
import { readWorkspaceVisibilityOverrides } from './workspace-settings.js';
import { getThreadControl } from '../thread-control/thread-controller.js';

// ── Connected Agents Query ───────────────────────────────────────
// Pure query logic: assembles the full connected-agents list from
// prebuilt agents metadata, ViewerWorker runtime data, and managed
// runtime processes. No side effects, no process spawning.
//
// workspace_sessions 响应投影：PH 类工作空间只内嵌当前项目的首屏切片
// （会话规模可达千级，全量内嵌曾使该 3s poll 响应膨胀至 MB 级）；其余
// agent 全量但走 wire 字段裁剪。服务端内部消费（active 会话解析）在组装
// 前使用完整快照，不受裁剪影响。
//
// 身份模型（ADR-0025）：条目 = APP（工作空间），无并列身份投影。prebuilt
// 条目携带 metadata 声明的 visibility（persistent / on-demand）与 host
// 关联；on-demand 的存在性由服务端合流（作者默认 + 用户覆盖 + 有无存活
// 且绑定 Session 的 managed Runtime）以 sidebarVisible 下发，前端纯消费。
const CONNECTED_PAGE_LIMIT = 60;

export function buildWireSessionsSnapshot(agentId, workspaceSessions) {
  const sessions = Array.isArray(workspaceSessions?.sessions) ? workspaceSessions.sessions : [];
  const trimmed = sessions.map(trimSessionRecordForWire);
  if (!PH_STYLE_WORKSPACE_AGENT_IDS.has(sanitizeSessionFragment(agentId))) {
    return { ...workspaceSessions, sessions: trimmed };
  }
  // PH 回退（workspace_state 不可读）：仍带分页元信息（全量已加载），
  // 前端据 sessionTotal 字段存在性判定分页语义，不因缺字段回退混乱。
  const counts = sliceSessionsForWire(sessions);
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
    // 测试缝：用户覆盖读取器（默认读用户数据根 workspace-settings.json）
    readVisibilityOverrides = readWorkspaceVisibilityOverrides,
    // 测试缝：线程控制面（默认单例）
    resolveThreadControl = getThreadControl,
  } = deps;

  // 存活 Runtime、接续挡板或仍可寻址的未归档线程资产都能保留 APP 入口。
  async function hasRunningSessions(agentId) {
    const hasRuntime = listAgentRuntimes(agentId).some((runtime) => (
      isManagedRuntimeRunning(runtime) && Boolean(runtime.selectedSessionId)
    ));
    if (hasRuntime) return true;

    try {
      const control = resolveThreadControl();
      const [threads, archiveEntries] = await Promise.all([
        control.core.listThreads({ agentId }),
        control.archive.list().catch(() => ({})),
      ]);
      // listThreads 是 index 摘要（无 deleting）：摘要初筛归档 / closed 后，
      // 按全量记录排除删除事务窗口——deleting 只写在记录文件上。
      const candidates = threads.filter((thread) => (
        String(thread?.agentId || '').trim() === agentId
          && thread?.status !== 'closed'
          && !Object.hasOwn(archiveEntries, thread?.threadId)
      ));
      for (const thread of candidates) {
        const record = await control.core.getThread(thread?.threadId).catch(() => null);
        if (record && record.deleting !== true) return true;
      }
      return false;
    } catch {
      return false;
    }
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

    const connectedAgents = await Promise.all(prebuiltAgents.map(async (agent) => {
      const { workspaceSessions, sessionMeta } = await readActiveWorkspaceSessionMeta(agent);
      const isWorkGroup = sanitizeSessionFragment(agent.id) === 'work-group';
      const visibility = agent.visibility === 'on-demand' ? 'on-demand' : 'persistent';
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
        permissions: Array.isArray(agent.permissions) ? agent.permissions : [],
        // APP 级呈现声明（ADR-0025）：visibility 决定侧栏存在性策略，
        // host 是与宿主 APP 的关联绑定（排序相邻 / 宿主首页入口）。
        visibility,
        host: agent.host || null,
        // 侧栏分组声明（通用呈现通道）：作者在 metadata 声明 sidebarGroup
        // （如 'tool' / 'work-group'），前端 groupConnectedAgents 优先消费；
        // 缺省时回退宿主跟随与既有归类。
        sidebarGroup: agent.sidebarGroup || null,
        // on-demand 存在性（服务端合流，前端纯消费）：作者声明默认 +
        // 用户覆盖（workspace-settings）合流出 visibilityPolicy；auto =
        // 有存活且绑定 Session 的 Runtime，或未归档线程资产 / 接续挡板时显示。sidebarVisible 是最终判定结果。
        ...(visibility === 'on-demand' ? await (async () => {
          const overrides = await readVisibilityOverrides();
          const visibilityPolicy = overrides[agent.id] === 'always' ? 'always' : 'auto';
           const running = await hasRunningSessions(agent.id);
          return {
            visibilityPolicy,
            hasRunningSessions: running,
            sidebarVisible: visibilityPolicy === 'always' || running,
          };
        })() : {}),
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
        active_workspace_session_dir: sessionMeta.active_workspace_session_dir || '',
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
          sidebar_entry_id: managedRuntime.agentId,
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
          : (runtimeAgent.parentAgentId || ''),
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

  return { getConnectedAgents };
}
