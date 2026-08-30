/**
 * project-data.js — 域 F: Project/Creator 数据层
 *
 * 从 app-ui.js 拆出（Phase 2c-2）。
 * 提供 agent workspace state 管理、项目列表构建、显示名解析等纯数据函数。
 *
 * 依赖（全局作用域，运行时解析）:
 * - app-core.js: allAgents, currentLanguage, isUiOnlyUnit, getCurrentUnitUi
 * - app-core.js: invoke, getCurrentAgentRecord
 * - session-ui.js: getWorkspaceSessions
 */

/**
 * Stable descending sort comparator for sessions and projects.
 * Primary key: updatedAt, secondary: createdAt, tertiary: id.
 * Prevents ordering jumps when updatedAt is equal or missing.
 */
function compareByRecency(a, b) {
  const aUpdated = String(a?.updatedAt || '');
  const bUpdated = String(b?.updatedAt || '');
  if (aUpdated !== bUpdated) return bUpdated.localeCompare(aUpdated);
  const aCreated = String(a?.createdAt || '');
  const bCreated = String(b?.createdAt || '');
  if (aCreated !== bCreated) return bCreated.localeCompare(aCreated);
  return String(b?.id || '').localeCompare(String(a?.id || ''));
}

function getFeatureCreatorProjects(agent = getCurrentAgentRecord()) {
  if (agent?.id !== 'feature-creator') return [];

  const workspaceState = getAgentWorkspaceState(agent);
  const startupForm = workspaceState?.forms?.['startup-form'] || {};
  const sessions = getWorkspaceSessions(agent);
  const projects = new Map();

  const upsertProject = (rawProject = {}) => {
    const normalized = {
      id: String(rawProject.id || buildWorkspaceProjectKey(rawProject)).trim(),
      featureName: String(rawProject.featureName || '').trim(),
      installMode: rawProject.installMode === 'custom' ? 'custom' : 'system',
      targetDir: String(rawProject.targetDir || '').trim(),
      openDirectory: String(rawProject.openDirectory || '').trim(),
      goal: String(rawProject.goal || '').trim(),
      constraints: String(rawProject.constraints || '').trim(),
      createdAt: String(rawProject.createdAt || '').trim(),
      updatedAt: String(rawProject.updatedAt || '').trim(),
      sessions: [],
    };
    if (!normalized.id) return null;

    const existing = projects.get(normalized.id);
    const merged = existing ? {
      ...existing,
      ...normalized,
      featureName: existing.featureName || normalized.featureName,
      targetDir: existing.targetDir || normalized.targetDir,
      openDirectory: existing.openDirectory || normalized.openDirectory,
      goal: existing.goal || normalized.goal,
      constraints: existing.constraints || normalized.constraints,
      createdAt: existing.createdAt || normalized.createdAt,
      updatedAt: normalized.updatedAt || existing.updatedAt,
      sessions: existing.sessions || [],
    } : normalized;
    projects.set(merged.id, merged);
    return merged;
  };

  const stateProjects = Array.isArray(workspaceState?.featureProjects) ? workspaceState.featureProjects : [];
  stateProjects.forEach((project) => upsertProject(project));

  upsertProject({
    featureName: startupForm.feature_name,
    installMode: startupForm.install_mode,
    targetDir: startupForm.target_dir,
    goal: startupForm.goal,
    constraints: startupForm.constraints,
    openDirectory: workspaceState?.openDirectory,
    updatedAt: workspaceState?.updatedAt,
  });

  sessions.forEach((session) => {
    const project = upsertProject({
      featureName: session.featureName,
      targetDir: session.openDirectory ? session.openDirectory.split(/[\\/]+/).slice(0, -1).join('\\') : '',
      openDirectory: session.openDirectory,
      updatedAt: session.updatedAt,
      createdAt: session.createdAt,
    });
    if (project) {
      project.sessions.push(session);
    }
  });

  return Array.from(projects.values())
    .map((project) => {
      const sortedSessions = [...(project.sessions || [])].sort(compareByRecency);
      const latestSession = sortedSessions[0] || null;
      const updatedAt = latestSession?.updatedAt || project.updatedAt || project.createdAt || workspaceState?.updatedAt || '';
      return {
        ...project,
        sessions: sortedSessions,
        latestSession,
        latestSessionId: latestSession?.id || null,
        conversationCount: sortedSessions.length,
        updatedAt,
      };
    })
    .sort(compareByRecency);
}

function getAgentCreatorProjects(agent = getCurrentAgentRecord()) {
  if (agent?.id !== 'agent-creator') return [];

  const workspaceState = getAgentWorkspaceState(agent);
  const startupForm = workspaceState?.forms?.['startup-form'] || {};
  const sessions = getWorkspaceSessions(agent);
  const projects = new Map();

  const upsertProject = (rawProject = {}) => {
    const normalized = {
      id: String(rawProject.id || buildWorkspaceProjectKey({
        openDirectory: rawProject.openDirectory,
        featureName: rawProject.agentName,
        targetDir: rawProject.targetDir,
      })).trim(),
      agentName: String(rawProject.agentName || '').trim(),
      installMode: rawProject.installMode === 'custom' ? 'custom' : 'system',
      targetDir: String(rawProject.targetDir || '').trim(),
      openDirectory: String(rawProject.openDirectory || '').trim(),
      goal: String(rawProject.goal || '').trim(),
      constraints: String(rawProject.constraints || '').trim(),
      targetUser: String(rawProject.targetUser || '').trim(),
      runtimeStyle: String(rawProject.runtimeStyle || '').trim(),
      plannedFeatures: String(rawProject.plannedFeatures || '').trim(),
      createdAt: String(rawProject.createdAt || '').trim(),
      updatedAt: String(rawProject.updatedAt || '').trim(),
      sessions: [],
    };
    if (!normalized.id) return null;

    const existing = projects.get(normalized.id);
    const merged = existing ? {
      ...existing,
      ...normalized,
      agentName: existing.agentName || normalized.agentName,
      targetDir: existing.targetDir || normalized.targetDir,
      openDirectory: existing.openDirectory || normalized.openDirectory,
      goal: existing.goal || normalized.goal,
      constraints: existing.constraints || normalized.constraints,
      targetUser: existing.targetUser || normalized.targetUser,
      runtimeStyle: existing.runtimeStyle || normalized.runtimeStyle,
      plannedFeatures: existing.plannedFeatures || normalized.plannedFeatures,
      createdAt: existing.createdAt || normalized.createdAt,
      updatedAt: normalized.updatedAt || existing.updatedAt,
      sessions: existing.sessions || [],
    } : normalized;
    projects.set(merged.id, merged);
    return merged;
  };

  const stateProjects = Array.isArray(workspaceState?.agentProjects) ? workspaceState.agentProjects : [];
  stateProjects.forEach((project) => upsertProject(project));

  upsertProject({
    agentName: startupForm.agent_name,
    installMode: startupForm.install_mode,
    targetDir: startupForm.target_dir,
    goal: startupForm.goal,
    constraints: startupForm.constraints,
    targetUser: startupForm.target_user,
    runtimeStyle: startupForm.runtime_style,
    plannedFeatures: startupForm.planned_features,
    openDirectory: workspaceState?.openDirectory,
    updatedAt: workspaceState?.updatedAt,
  });

  sessions
    .filter((session) => String(session?.formId || '') !== 'assembly-form')
    .forEach((session) => {
    const project = upsertProject({
      agentName: session.agentName,
      targetDir: session.openDirectory ? session.openDirectory.split(/[\\/]+/).slice(0, -1).join('\\') : '',
      openDirectory: session.openDirectory,
      updatedAt: session.updatedAt,
      createdAt: session.createdAt,
    });
    if (project) {
      project.sessions.push(session);
    }
  });

  return Array.from(projects.values())
    .map((project) => {
      const sortedSessions = [...(project.sessions || [])].sort(compareByRecency);
      const latestSession = sortedSessions[0] || null;
      const updatedAt = latestSession?.updatedAt || project.updatedAt || project.createdAt || workspaceState?.updatedAt || '';
      return {
        ...project,
        sessions: sortedSessions,
        latestSession,
        latestSessionId: latestSession?.id || null,
        conversationCount: sortedSessions.length,
        updatedAt,
      };
    })
    .sort(compareByRecency);
}

function getPathLeaf(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const parts = text.split(/[\\/]+/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : text;
}

function toFeatureDisplayName(value) {
  const text = String(value || '').trim().replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9-]+$/g, '');
  if (!text) return '';
  return text
    .split('-')
    .filter(Boolean)
    .map((part, index) => {
      const lower = part.toLowerCase();
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join('');
}

function getFeatureSessionDisplayName(session, agent = getCurrentAgentRecord()) {
  const workspaceState = getAgentWorkspaceState(agent);
  const directoryName = getPathLeaf(session?.openDirectory) || getPathLeaf(workspaceState?.openDirectory);
  const derivedName = toFeatureDisplayName(directoryName);
  if (derivedName) return derivedName;
  const rawName = toFeatureDisplayName(session?.featureName);
  if (rawName) return rawName;
  return String(session?.id || '').trim();
}

function getFeatureProjectDisplayName(project) {
  const directoryName = getPathLeaf(project?.openDirectory);
  const derivedName = toFeatureDisplayName(directoryName);
  if (derivedName) return derivedName;
  const rawName = toFeatureDisplayName(project?.featureName);
  if (rawName) return rawName;
  return 'UntitledFeature';
}

function getAgentProjectDisplayName(project) {
  const directoryName = getPathLeaf(project?.openDirectory);
  const derivedName = toFeatureDisplayName(directoryName);
  if (derivedName) return derivedName;
  const rawName = toFeatureDisplayName(project?.agentName);
  if (rawName) return rawName;
  return 'UntitledAgent';
}

function getProgrammingHelperProjects(agent = getCurrentAgentRecord()) {
  if (!isPhStyleWorkspaceAgent(agent)) return [];

  const workspaceState = getAgentWorkspaceState(agent);
  const sessions = getWorkspaceSessions(agent);
  const projects = new Map();

  const upsertProject = (rawProject = {}) => {
    const openDirectory = String(rawProject.openDirectory || '').trim();
    if (!openDirectory) return null;

    const id = `dir:${openDirectory.replace(/\\/g, '/').toLowerCase()}`;
    const projectName = getPathLeaf(openDirectory);

    const existing = projects.get(id);
    const merged = existing ? {
      ...existing,
      updatedAt: existing.updatedAt || rawProject.updatedAt,
      sessions: existing.sessions || [],
    } : {
      id,
      type: 'directory',
      openDirectory,
      name: projectName,
      sessions: [],
      createdAt: rawProject.createdAt,
      updatedAt: rawProject.updatedAt,
    };
    projects.set(id, merged);
    return merged;
  };

  const stateProjects = Array.isArray(workspaceState?.phProjects) ? workspaceState.phProjects : [];
  stateProjects.forEach((project) => upsertProject(project));

  // coder 会话（sessionType='coder'）归属线程视图（coder 投影入口），
  // 不进入编程小助手入口的项目 / 会话列表。
  sessions
    .filter((session) => String(session?.sessionType || '').trim() !== 'coder')
    .forEach((session) => {
      const project = upsertProject({
        openDirectory: session.openDirectory,
        updatedAt: session.updatedAt,
        createdAt: session.createdAt,
      });
      if (project) {
        project.sessions.push(session);
      }
    });

  // 远程历史会话混入（R2-01，ADR-0012 决策 1）：与本地会话在同一项目桶内
  // 混合排序，无来源分区、无远程徽标。目录本地不存在时创建 remoteOnly 桶：
  // 仅用于 surface 视图呈现，不参与本地工作区切换语义（phSwitchProject）。
  // 标记是「该桶无本地目录」的数据事实（保留，不做 UI 门控）：消费端经
  // getProjectLocalHostAgentId 解析本地宿主身份后查询能力矩阵
  // （window.RemoteConnections.capabilityFor）做门控判定。
  if (typeof getRemoteHistoryProjectBuckets === 'function') {
    for (const bucket of getRemoteHistoryProjectBuckets()) {
      const dirId = `dir:${String(bucket.openDirectory).replace(/\\/g, '/').toLowerCase()}`;
      const isRemoteOnly = !projects.has(dirId);
      const project = upsertProject({ openDirectory: bucket.openDirectory });
      if (!project) continue;
      if (isRemoteOnly) project.remoteOnly = true;
      for (const session of bucket.sessions) {
        if (project.sessions.some((item) => item.id === session.id)) continue;
        project.sessions.push(session);
      }
    }
  }

  return Array.from(projects.values())
    .map((project) => ({
      ...project,
      sessions: project.sessions.sort(compareByRecency),
      conversationCount: project.sessions.length,
      latestSessionId: project.sessions[0]?.id || null,
      updatedAt: project.sessions[0]?.updatedAt || project.updatedAt || '',
    }))
    .sort(compareByRecency);
}

function getProgrammingHelperProjectDisplayName(project) {
  const directoryName = getPathLeaf(project?.openDirectory);
  return directoryName || 'UntitledProject';
}

// 项目桶的本地宿主身份（能力门控寻址用，ADR-0012 决策 1）：本地目录桶归
// 本地工作区身份；remoteOnly 桶的目录仅存在于远程主机，没有本地宿主，返回
// 空串——本地工作区切换等真本地动作对该类桶不可用（这是真本地事实而非
// 能力位，不造伪能力位），由消费端按「动作不可用」路由到视图呈现。
function getProjectLocalHostAgentId(project, localAgentId) {
  if (!project || project.remoteOnly) return '';
  return String(localAgentId || '');
}

function hasWorkspaceSessions(agent = getCurrentAgentRecord()) {
  return getWorkspaceSessions(agent).length > 0;
}

function canEnterWorkspaceChat(agent = getCurrentAgentRecord()) {
  const ui = getCurrentUnitUi(agent);
  if (!ui) return true;
  if (isUiOnlyUnit(agent)) return false;
  return hasWorkspaceSessions(agent);
}

function getWorkspaceFormStorageKey(agentId) {
  return `protoclaw:workspace-form:${agentId}`;
}

function getAgentWorkspaceState(agent) {
  return agent?.workspace_state && typeof agent.workspace_state === 'object'
    ? agent.workspace_state
    : { forms: {}, openDirectory: '', updatedAt: null };
}

function updateAgentWorkspaceState(agentId, nextState) {
  for (const agent of allAgents) {
    if (agent.id === agentId) {
      agent.workspace_state = nextState;
    }
  }
}

function updateAgentRecord(agentId, updates = {}) {
  let matched = null;
  allAgents = allAgents.map((agent) => {
    if (agent.id !== agentId) return agent;
    matched = { ...agent, ...updates };
    return matched;
  });
  return matched;
}

function applyManagedPrebuiltAgent(agentId, connectedAgent, options = {}) {
  if (!connectedAgent) {
    return updateAgentRecord(agentId, {
      runtime_session_id: null,
      runtimeSessionId: null,
      connected: false,
      status: 'stopped',
      message_count: 0,
      launchMode: options.uiOnlyWhenStopped ? 'ui-only' : null,
    });
  }

  return updateAgentRecord(agentId, {
    ...connectedAgent,
    status: connectedAgent.connected === false ? 'stopped' : 'running',
    message_count: connectedAgent.messageCount ?? connectedAgent.message_count ?? 0,
    launchMode: connectedAgent.launchMode || null,
  });
}

function getWorkspaceBlockData(agent, blockId) {
  const workspaceData = agent?.workspace_data;
  if (!workspaceData || typeof workspaceData !== 'object') return null;
  return workspaceData[blockId] || null;
}
