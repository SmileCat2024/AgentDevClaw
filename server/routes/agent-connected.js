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
  buildChildRuntimeAgent,
} from './session-helpers-pure.js';
import { readWorkspaceVisibilityOverrides } from './workspace-settings.js';
import { getThreadControl } from '../thread-control/thread-controller.js';
import { readThreadMembership } from '../shared/thread-membership.js';
import { readSidebarSnapshot } from './sidebar-snapshot.js';
import { performance } from 'node:perf_hooks';

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

export async function buildWireSessionsSnapshot(agentId, workspaceSessions) {
  const sessions = Array.isArray(workspaceSessions?.sessions) ? workspaceSessions.sessions : [];
  const trimmed = sessions.map(trimSessionRecordForWire);
  if (!PH_STYLE_WORKSPACE_AGENT_IDS.has(sanitizeSessionFragment(agentId))) {
    return { ...workspaceSessions, sessions: trimmed };
  }
  // PH 回退（workspace_state 不可读）：仍带分页元信息（全量已加载），
  // 前端据 sessionTotal 字段存在性判定分页语义，不因缺字段回退混乱。
  //
  // 口径一致性（ADR-0032）：sessions / sessionTotal 必须与 mainTotal /
  // archivedTotal 同源。此前 sessions 与 sessionTotal 用未过滤的全量，计数
  // 却按线程成员口径——历史代成员既以普通行返回，又让「加载更多」的进度
  // 分母虚高（已显示数永远追不上 sessionTotal），前端会持续提示还有更多。
  const page = sliceSessionsForWire(sessions, {
    threadMembership: await readThreadMembership(agentId),
  });
  return {
    ...workspaceSessions,
    sessionProjectDir: null,
    sessionTotal: page.total,
    sessionOffset: 0,
    sessionHasMore: false,
    mainTotal: page.mainTotal,
    archivedTotal: page.archivedTotal,
    sessions: page.slice.map(trimSessionRecordForWire),
  };
}

// 归属显式化（补 ticket 045 未落实的读侧）：045 要求「选项目后轮询不被覆盖」，
// 但切片此前一律读 workspace_state.openDirectory 做目录切片。浏览目标是本地
// UI 状态（typed target），服务端无从得知——用户浏览项目时轮询仍回目录切片，
// 且目录集合按契约排除项目会话，前端按项目身份过滤后列表归零、徽标却是目录
// 口径，表现为「对话加载不出来」。调用方可显式传 projectId / projectDir；
// 缺省时回退目录语义（既有行为，纯目录用户不变）。
export async function buildPhProjectScopedSnapshot(agentId, workspaceSessions, ownership = {}) {
  const sessions = Array.isArray(workspaceSessions?.sessions) ? workspaceSessions.sessions : [];
  const requestedProjectId = String(ownership?.projectId || '').trim();
  let projectDir = String(ownership?.projectDir || '').trim();
  if (!requestedProjectId && !projectDir) {
    try {
      const wsState = await readWorkspaceState(agentId);
      projectDir = String(wsState?.openDirectory || '').trim();
    } catch { /* workspace state unavailable → unpaged trim */ }
  }
  if (!requestedProjectId && !projectDir) return buildWireSessionsSnapshot(agentId, workspaceSessions);
  const page = sliceSessionsForWire(sessions, {
    ...(requestedProjectId ? { projectId: requestedProjectId } : { projectDir }),
    limit: CONNECTED_PAGE_LIMIT,
    // ADR-0032 列表口径：计数/切片按线程归档状态，历史代成员不进入
    threadMembership: await readThreadMembership(agentId),
  });
  return {
    ...workspaceSessions,
    // 切片归属与计数同源：sessionProjectId / sessionProjectDir 必须描述
    // 本切片的实际过滤口径，前端据此判定快照身份、避免跨归属合并。
    sessionProjectDir: requestedProjectId ? null : projectDir,
    sessionProjectId: requestedProjectId || null,
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
    // In-process fast path (ga-slow fix 2026-10-29): ViewerWorker runs in the
    // same process; its getNotificationSnapshot is the implementation behind
    // the /notification HTTP handler. Optional — absent falls back to fetch.
    getRuntimeNotification = null,
    // 测试缝：用户覆盖读取器（默认读用户数据根 workspace-settings.json）
    readVisibilityOverrides = readWorkspaceVisibilityOverrides,
    // 测试缝：线程控制面（默认单例）
    resolveThreadControl = getThreadControl,
  } = deps;

  // 存活 Runtime 或 rotating 接续挡板（持久化事务事实）保留 APP 入口；
  // 其余未归档线程资产（open/hold/rotation_failed 等）不代表运行态，
  // 不撑入口（ADR-0025 原始裁决，2026-10-18 回摆撤销资产驱动扩展）。
  async function hasRunningSessions(agentId, sidebarThreads) {
    const hasRuntime = listAgentRuntimes(agentId).some((runtime) => (
      isManagedRuntimeRunning(runtime) && Boolean(runtime.selectedSessionId)
    ));
    if (hasRuntime) return true;

    return sidebarThreads.some(thread => thread.agentId === agentId
      && thread.status === 'rotating' && !thread.archivedAt && !thread.deleting);
  }

  async function getConnectedAgents(ownership = {}) {
    return readSidebarSnapshot(resolveThreadControl(), (sidebarThreads) => (
      projectConnectedAgents(sidebarThreads, ownership)
    ));
  }

  async function projectConnectedAgents(sidebarThreads, ownership = {}) {
    const prebuiltAgents = await getAgentsLight();
    const viewerData = await readViewerJson('/api/agents').catch(() => ({ agents: [] }));
    const runtimeAgents = Array.isArray(viewerData.agents) ? viewerData.agents : [];
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
        agents: agent.agents,
        defaultAgentId: agent.defaultAgentId,
        workspace: agent.workspace || null,
        permissions: Array.isArray(agent.permissions) ? agent.permissions : [],
        // 作者默认值（ADR-0030）：通知权限项的 metadata 默认层，设置面板
        // 三态呈现与判定链生效值展示的前端数据源。
        permissionDefaults: agent.permissionDefaults && typeof agent.permissionDefaults === 'object'
          ? agent.permissionDefaults
          : {},
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
        // 有存活且绑定 Session 的 Runtime，或 rotating 接续挡板在途时显示。sidebarVisible 是最终判定结果。
        ...(visibility === 'on-demand' ? await (async () => {
          const overrides = await readVisibilityOverrides();
          const visibilityPolicy = overrides[agent.id] === 'always' ? 'always' : 'auto';
          const running = await hasRunningSessions(agent.id, sidebarThreads);
          return {
            visibilityPolicy,
            hasRunningSessions: running,
            sidebarVisible: visibilityPolicy === 'always' || running,
          };
        })() : {}),
        workspace_sessions: PH_STYLE_WORKSPACE_AGENT_IDS.has(sanitizeSessionFragment(agent.id))
          ? await buildPhProjectScopedSnapshot(agent.id, workspaceSessions, ownership)
          : await buildWireSessionsSnapshot(agent.id, workspaceSessions),
        // Thread identity and runtime presence share this read transaction.
        // Do not join this with the independently polled thread board in the UI.
        sidebar_threads: await Promise.all(sidebarThreads.filter(thread => thread.agentId === agent.id
          && (thread.status === 'rotating' || listAgentRuntimes(agent.id).some(runtime =>
            isManagedRuntimeRunning(runtime) && (thread.headSessionId === runtime.selectedSessionId
              || thread.sessionIds.includes(runtime.selectedSessionId))))).map(async thread => {
          const meta = await readWorkspaceSessionMeta(thread.agentId, thread.headSessionId);
          return { ...thread, headSessionTitle: meta.active_workspace_session_title || thread.title,
            headProjectId: meta.project_id || '', headProjectDir: meta.open_directory || '' };
        })),
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
        // 归属身份透传（ticket 044）：'' = 目录会话；非空 = 项目归属。
        active_workspace_session_project_id: sessionMeta.active_workspace_session_project_id || '',
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
    // Snapshot identity after workspace metadata loading. A runtime may publish
    // its ID while the async APP/session projection above is in flight.
    const managedRuntimes = Array.from(managedAgents.values());
    const managedRuntimeByViewerId = new Map();
    const retiredViewerRuntimeIds = new Set();
    for (const runtime of managedRuntimes) {
      const viewerAgentId = cleanSessionText(runtime?.viewerAgentId);
      if (!viewerAgentId) continue;
      if (!isManagedRuntimeRunning(runtime)) {
        // Viewer disconnect propagation is not the lifetime authority for hosted
        // runtimes. A retired Session must not fall through as a viewer-only child.
        retiredViewerRuntimeIds.add(viewerAgentId);
      } else {
        managedRuntimeByViewerId.set(viewerAgentId, runtime);
      }
    }

    for (const runtimeAgent of runtimeAgents) {
      if (retiredViewerRuntimeIds.has(String(runtimeAgent.id || ''))) continue;
      const managedRuntime = managedRuntimeByViewerId.get(String(runtimeAgent.id || '')) || null;
      if (managedRuntime) {
        const runtimeMeta = await readWorkspaceSessionMeta(managedRuntime.agentId, managedRuntime.selectedSessionId);
        connectedAgents.push({
          id: runtimeAgent.id,
          workspaceAgentId: runtimeMeta.workspaceAgentId || 'main',
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
          // 归属身份透传（ticket 044）：'' = 目录会话；非空 = 项目归属，
          // 前端侧栏据此把项目会话与同路径目录会话分组隔离。
          project_id: runtimeMeta.project_id || '',
          source_session_id: runtimeMeta.source_session_id || '',
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
        workspaceAgentId: childWorkspaceMeta?.workspaceAgentId || 'main',
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
        project_id: exposeAsSeparateAssemblyRuntime
          ? ''
          : (childWorkspaceMeta?.project_id || ''),
        source_session_id: exposeAsSeparateAssemblyRuntime ? '' : (childWorkspaceMeta?.source_session_id || ''),
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

    // A READY successor may have registered after the Viewer list was read.
    // Hosted readiness is direct evidence, not a placeholder inferred from a
    // thread board. Include every ready instance, not only the host's primary.
    const projectedIds = new Set(connectedAgents.filter(agent => agent.source !== 'prebuilt').map(agent => agent.runtime_session_id));
    for (const [viewerId, runtime] of managedRuntimeByViewerId) {
      if (!runtime.ready || projectedIds.has(viewerId)) continue;
      const meta = await readWorkspaceSessionMeta(runtime.agentId, runtime.selectedSessionId);
      connectedAgents.push(buildChildRuntimeAgent({ id: viewerId, connected: true,
        pid: runtime.process?.pid, created_at: runtime.startedAt }, {
        agentId: runtime.agentId, sessionId: runtime.selectedSessionId, sessionMeta: meta,
      }));
    }

    for (const managed of connectedAgents) {
      if (managed.source !== 'prebuilt') continue;
      const status = buildStatus(managed.id);
      if (status.status === 'running') {
        // Primary selection may change while metadata is being read. Switch
        // the complete session identity projection, not just its ID: otherwise
        // the synthetic runtime borrows the previous session's project/title.
        if (status.selectedSessionId && status.selectedSessionId !== managed.active_workspace_session_id) {
          const meta = await readWorkspaceSessionMeta(managed.id, status.selectedSessionId);
          Object.assign(managed, {
            active_workspace_session_id: status.selectedSessionId,
            active_workspace_session_form_id: meta.active_workspace_session_form_id,
            active_workspace_session_title: meta.active_workspace_session_title,
            active_workspace_agent_name: meta.active_workspace_agent_name,
            active_workspace_display_name: meta.active_workspace_display_name,
            active_workspace_session_dir: meta.open_directory || '',
            active_workspace_session_project_id: meta.project_id || '',
          });
          managed.workspace_sessions = { ...managed.workspace_sessions, activeSessionId: status.selectedSessionId };
        }
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
          const notif = getRuntimeNotification
            ? getRuntimeNotification(agent.runtime_session_id)
            : await readViewerJson(`/api/agents/${encodeURIComponent(agent.runtime_session_id)}/notification`);
          agent.callActive = notif?.callActive === true;
        } catch {
          agent.callActive = false;
        }
      })
    );

    // Metadata and notification reads above yield to lifecycle mutations. Recheck
    // hosted ownership at publication so a close/restart during those reads
    // cannot publish a retired instance. Viewer-only external agents are intact.
    const currentRuntimes = new Set(managedAgents.values());
    return connectedAgents.filter((agent) => {
      const runtime = managedRuntimeByViewerId.get(String(agent.runtime_session_id || agent.id || ''));
      if (!runtime || (isManagedRuntimeRunning(runtime) && currentRuntimes.has(runtime))) return true;
      if (agent.source !== 'prebuilt') return false;
      Object.assign(agent, { status: 'stopped', pid: null, runtime_session_id: null,
        connected: false, callActive: false, message_count: 0, pending_input_count: null });
      return true;
    });
  }

  return { getConnectedAgents };
}
