/**
 * Session List Render 模块
 * 从 session-ui.js 拆出 (renderWorkspaceSessionList 按 agent 类型拆分)
 *
 * 依赖全局函数 (定义在 session-ui.js):
 *   getWorkspaceSessions, sortPhSessionsByMode,
 *   renderSessionResumeBadge, renderSessionArchivedBadge,
 *   renderSessionTodoBadge, renderSessionTitleAiButton,
 *   renderSessionTokenBar
 * 依赖全局函数 (定义在 app-core.js 或 app-ui.js):
 *   escapeHtml, localizeWorkspaceValue, formatWorkspaceDate, t,
 *   renderActionButton, currentLanguage,
 *   getFeatureCreatorProjects, getAgentCreatorProjects,
 *   getProgrammingHelperProjects, getFeatureProjectDisplayName,
 *   getAgentProjectDisplayName, getProgrammingHelperProjectDisplayName,
 *   getAgentWorkspaceState, getFeatureSessionDisplayName, isAssemblySession,
 *   phSearchQuery, phSessionSortMode,
 *   getSessionShortTime, getSessionRecencyClass, getTimeGroupLabel
 * 依赖全局变量 (定义在 session-ui.js):
 *   _phOpenSessionsCache
 * 导出全局函数:
 *   renderWorkspaceSessionList
 */

// ── Workspace Session List ───────────────────────────────────────

// ── 视图能力查询（R2-03）──────────────────────────────────────────
// UI 守卫统一经 window.RemoteConnections.capabilityFor 契约查询：
// ('write' | 'sessionOps' | 'workspaceCreate') → boolean；本地身份恒 true、
// 远程按握手能力、缺省 false。视图身份：本地 agent 用其 id；remoteOnly 项目
// 桶用会话数据层携带的宿主级命名空间 id（ADR-0012：身份来自数据层）。
// capabilityFor 未挂载（集成窗口）时退回命名空间判定——本地身份保持可见、
// 远程身份按缺省 false 隐藏；不引入伪能力位。
function viewCapabilityEnabled(identity, action) {
  const id = String(identity || '').trim();
  if (!id) return false;
  const capabilityFor = window.RemoteConnections?.capabilityFor;
  if (typeof capabilityFor === 'function') {
    return capabilityFor(id, action) === true;
  }
  return !isRemoteNamespaceAgentId(id);
}

// remoteOnly 项目桶的视图身份 = 桶内会话数据层携带的宿主级命名空间 id；
// 本地项目视图身份 = agent id。
function projectViewIdentity(agent, project) {
  if (project?.remoteOnly) {
    const sessions = Array.isArray(project.sessions) ? project.sessions : [];
    return String(sessions.find((session) => session?.remoteHostNsId)?.remoteHostNsId || '').trim();
  }
  return String(agent?.id || '').trim();
}

function renderWorkspaceSessionList(agent, block) {
  const sessionFilters = block?.sessionList || {};
  const allowedFormIds = Array.isArray(sessionFilters.formIds)
    ? new Set(sessionFilters.formIds.map((item) => String(item || '').trim()).filter(Boolean))
    : null;
  const sessions = getWorkspaceSessions(agent).filter((session) => {
    if (!allowedFormIds) return true;
    return allowedFormIds.has(String(session?.formId || ''));
  });
  const isFeatureCreator = agent?.id === 'feature-creator';
  const isAgentCreator = agent?.id === 'agent-creator';
  const sessionListMode = String(sessionFilters.mode || '').trim();
  const activeSessionId = agent?.active_workspace_session_id || agent?.workspace_sessions?.activeSessionId || null;
  const title = localizeWorkspaceValue(block.title, t('workspace_history_current'));
  const desc = localizeWorkspaceValue(block.description, '');
  const headerAction = block?.headerAction ? renderActionButton(block.headerAction) : '';

  const ctx = { sessions, isFeatureCreator, isAgentCreator, sessionListMode, activeSessionId, title, desc, headerAction };

  if (isFeatureCreator) {
    return _renderFeatureCreatorSessionList(agent, block, ctx);
  }

  if (isAgentCreator && sessionListMode !== 'assembly') {
    return _renderAgentCreatorSessionList(agent, block, ctx);
  }

  if (agent?.id === 'programming-helper') {
    return _renderProgrammingHelperSessionList(agent, block, ctx);
  }

  return _renderGenericSessionList(agent, block, ctx);
}

// ── Feature Creator ──────────────────────────────────────────────

function _renderFeatureCreatorSessionList(agent, block, ctx) {
  const { activeSessionId, title, desc, headerAction } = ctx;
  const projects = getFeatureCreatorProjects(agent);
  const emptyHtml = [
    '<div class="workspace-history-list">',
    '<div class="workspace-history-item"><div>' + escapeHtml(t('workspace_history_empty')) + '</div></div>',
    '</div>',
  ].join('');

  const bodyHtml = projects.length > 0
    ? '<div class="feature-project-list">' + projects.map((project) => {
        const newChatAction = escapeHtml(JSON.stringify({
          type: 'create_session',
          featureName: project.featureName || '',
          openDirectory: project.openDirectory || '',
          targetDir: project.targetDir || '',
        }));
        const projectPreview = project.goal || project.constraints || project.openDirectory || '';
        const sessionsHtml = project.sessions.length > 0
          ? '<div class="feature-project-session-group"><div class="feature-project-subtitle">' + escapeHtml(t('workspace_conversation_group')) + '</div><div class="feature-project-session-list">' + project.sessions.map((session) => {
              const openAction = escapeHtml(JSON.stringify({ type: 'open_session', sessionId: session.id }));
              return [
                '<div class="feature-project-session-item workspace-history-item" data-prebuilt-session-agent-id="' + escapeHtml(agent.id) + '" data-prebuilt-session-id="' + escapeHtml(session.id) + '">',
                '<div class="workspace-history-main">',
                '<div class="workspace-history-title-row">',
                '<div class="workspace-history-title" ondblclick="window.handleSessionTitleDoubleClick(event)" title="' + escapeHtml(currentLanguage === 'zh' ? '双击编辑标题' : 'Double-click to edit title') + '">' + escapeHtml(session.title || session.id) + '</div>',
                renderSessionResumeBadge(session),
                session.id === activeSessionId ? '<span class="workspace-history-active">当前</span>' : '',
                renderSessionArchivedBadge(session),
                renderSessionTitleAiButton(session),
                '</div>',
                '<div class="workspace-history-meta">' + escapeHtml(formatWorkspaceDate(session.updatedAt)) + '</div>',
                session.preview ? '<div class="workspace-history-preview">' + escapeHtml(session.preview) + '</div>' : '',
                renderSessionTokenBar(session, agent),
                '</div>',
                '<div class="workspace-history-side">',
                '<div class="workspace-history-meta compact">' + escapeHtml(t('workspace_history_messages')) + ': ' + escapeHtml(String(session.messageCount ?? 0)) + '</div>',
                '<div class="workspace-actions stacked">',
                '<button class="workspace-action" type="button" data-workspace-action="' + openAction + '" onclick="window.runWorkspaceAction(this.dataset.workspaceAction, this)">' + escapeHtml(t('workspace_open_chat')) + '</button>',
                '</div>',
                '</div>',
                '</div>',
              ].join('');
            }).join('') + '</div></div>'
          : '<div class="feature-project-session-group"><div class="feature-project-subtitle">' + escapeHtml(t('workspace_conversation_group')) + '</div><div class="feature-project-empty-note">' + escapeHtml(t('workspace_feature_no_sessions')) + '</div></div>';

        return [
          '<div class="feature-project-card" data-prebuilt-project-agent-id="' + escapeHtml(agent.id) + '" data-prebuilt-project-id="' + escapeHtml(project.id) + '">',
          '<details class="feature-project-disclosure">',
          '<summary>',
          '<div class="feature-project-row">',
          '<div class="feature-project-summary">',
          '<div class="feature-project-titlebar">',
          '<div class="workspace-history-title">' + escapeHtml(getFeatureProjectDisplayName(project)) + '</div>',
          activeSessionId && project.sessions.some(s => s.id === activeSessionId) ? '<span class="workspace-history-active">当前</span>' : '',
          '</div>',
          '<div class="feature-project-meta-line"><span>' + escapeHtml(formatWorkspaceDate(project.updatedAt)) + '</span></div>',
          projectPreview ? '<div class="workspace-history-preview">' + escapeHtml(projectPreview) + '</div>' : '',
          project.openDirectory ? '<div class="workspace-history-meta">' + escapeHtml(project.openDirectory) + '</div>' : '',
          '</div>',
          '<div class="feature-project-side">',
          '<div class="feature-project-head-actions">',
          (viewCapabilityEnabled(agent.id, 'workspaceCreate') ? '<button class="workspace-action secondary" type="button" data-workspace-action="' + newChatAction + '" onclick="window.runWorkspaceActionFromEvent(event, this.dataset.workspaceAction)">' + escapeHtml(t('workspace_new_chat')) + '</button>' : ''),
          '</div>',
          '<div class="feature-project-toggle" data-label-collapsed="' + escapeHtml(t('workspace_expand_records')) + '" data-label-expanded="' + escapeHtml(t('workspace_collapse_records')) + '" aria-hidden="true"><span class="feature-project-count">' + escapeHtml(String(project.conversationCount || 0)) + '</span></div>',
          '</div>',
          '</div>',
          '</summary>',
          '<div class="feature-project-body">',
          sessionsHtml,
          '</div>',
          '</details>',
          '</div>',
        ].join('');
      }).join('') + '</div>'
    : emptyHtml;

  return [
    '<section class="workspace-section">',
    '<div class="workspace-section-header">',
    '<div>',
    '<div class="workspace-section-title">' + escapeHtml(title) + '</div>',
    '<div class="workspace-section-desc">' + escapeHtml(desc) + '</div>',
    '</div>',
    headerAction,
    '</div>',
    bodyHtml,
    '</section>',
  ].join('');
}

// ── Agent Creator ────────────────────────────────────────────────

function _renderAgentCreatorSessionList(agent, block, ctx) {
  const { activeSessionId, title, desc, headerAction } = ctx;
  const projects = getAgentCreatorProjects(agent);
  const emptyHtml = [
    '<div class="workspace-history-list">',
    '<div class="workspace-history-item"><div>' + escapeHtml(t('workspace_history_empty')) + '</div></div>',
    '</div>',
  ].join('');

  const bodyHtml = projects.length > 0
    ? '<div class="feature-project-list">' + projects.map((project) => {
        const newChatAction = escapeHtml(JSON.stringify({
          type: 'create_session',
          agentName: project.agentName || '',
          openDirectory: project.openDirectory || '',
          targetDir: project.targetDir || '',
        }));
        const projectPreview = project.goal || project.plannedFeatures || project.constraints || project.openDirectory || '';
        const sessionsHtml = project.sessions.length > 0
          ? '<div class="feature-project-session-group"><div class="feature-project-subtitle">' + escapeHtml(t('workspace_conversation_group')) + '</div><div class="feature-project-session-list">' + project.sessions.map((session) => {
              const openAction = escapeHtml(JSON.stringify({ type: 'open_session', sessionId: session.id }));
              return [
                '<div class="feature-project-session-item workspace-history-item" data-prebuilt-session-agent-id="' + escapeHtml(agent.id) + '" data-prebuilt-session-id="' + escapeHtml(session.id) + '">',
                '<div class="workspace-history-main">',
                '<div class="workspace-history-title-row">',
                '<div class="workspace-history-title" ondblclick="window.handleSessionTitleDoubleClick(event)" title="' + escapeHtml(currentLanguage === 'zh' ? '双击编辑标题' : 'Double-click to edit title') + '">' + escapeHtml(session.title || session.id) + '</div>',
                renderSessionResumeBadge(session),
                session.id === activeSessionId ? '<span class="workspace-history-active">当前</span>' : '',
                renderSessionArchivedBadge(session),
                renderSessionTitleAiButton(session),
                '</div>',
                '<div class="workspace-history-meta">' + escapeHtml(formatWorkspaceDate(session.updatedAt)) + '</div>',
                session.preview ? '<div class="workspace-history-preview">' + escapeHtml(session.preview) + '</div>' : '',
                renderSessionTokenBar(session, agent),
                '</div>',
                '<div class="workspace-history-side">',
                '<div class="workspace-history-meta compact">' + escapeHtml(t('workspace_history_messages')) + ': ' + escapeHtml(String(session.messageCount ?? 0)) + '</div>',
                '<div class="workspace-actions stacked">',
                '<button class="workspace-action" type="button" data-workspace-action="' + openAction + '" onclick="window.runWorkspaceAction(this.dataset.workspaceAction, this)">' + escapeHtml(t('workspace_open_chat')) + '</button>',
                '</div>',
                '</div>',
                '</div>',
              ].join('');
            }).join('') + '</div></div>'
          : '<div class="feature-project-session-group"><div class="feature-project-subtitle">' + escapeHtml(t('workspace_conversation_group')) + '</div><div class="feature-project-empty-note">' + escapeHtml(t('workspace_feature_no_sessions')) + '</div></div>';

        return [
          '<div class="feature-project-card" data-prebuilt-project-agent-id="' + escapeHtml(agent.id) + '" data-prebuilt-project-id="' + escapeHtml(project.id) + '">',
          '<details class="feature-project-disclosure">',
          '<summary>',
          '<div class="feature-project-row">',
          '<div class="feature-project-summary">',
          '<div class="feature-project-titlebar">',
          '<div class="workspace-history-title">' + escapeHtml(getAgentProjectDisplayName(project)) + '</div>',
          activeSessionId && project.sessions.some(s => s.id === activeSessionId) ? '<span class="workspace-history-active">当前</span>' : '',
          '</div>',
          '<div class="feature-project-meta-line"><span>' + escapeHtml(formatWorkspaceDate(project.updatedAt)) + '</span></div>',
          projectPreview ? '<div class="workspace-history-preview">' + escapeHtml(projectPreview) + '</div>' : '',
          project.openDirectory ? '<div class="workspace-history-meta">' + escapeHtml(project.openDirectory) + '</div>' : '',
          '</div>',
          '<div class="feature-project-side">',
          '<div class="feature-project-head-actions">',
          (viewCapabilityEnabled(agent.id, 'workspaceCreate') ? '<button class="workspace-action secondary" type="button" data-workspace-action="' + newChatAction + '" onclick="window.runWorkspaceActionFromEvent(event, this.dataset.workspaceAction)">' + escapeHtml(t('workspace_new_chat')) + '</button>' : ''),
          '</div>',
          '<div class="feature-project-toggle" data-label-collapsed="' + escapeHtml(t('workspace_expand_records')) + '" data-label-expanded="' + escapeHtml(t('workspace_collapse_records')) + '" aria-hidden="true"><span class="feature-project-count">' + escapeHtml(String(project.conversationCount || 0)) + '</span></div>',
          '</div>',
          '</div>',
          '</summary>',
          '<div class="feature-project-body">',
          sessionsHtml,
          '</div>',
          '</details>',
          '</div>',
        ].join('');
      }).join('') + '</div>'
    : emptyHtml;

  return [
    '<section class="workspace-section">',
    '<div class="workspace-section-header">',
    '<div>',
    '<div class="workspace-section-title">' + escapeHtml(title) + '</div>',
    '<div class="workspace-section-desc">' + escapeHtml(desc) + '</div>',
    '</div>',
    headerAction,
    '</div>',
    bodyHtml,
    '</section>',
  ].join('');
}

// ── Programming Helper ───────────────────────────────────────────

function _renderProgrammingHelperSessionList(agent, block, ctx) {
  const { desc } = ctx;
  const projects = getProgrammingHelperProjects(agent);
  const wsState = getAgentWorkspaceState(agent);
  const currentOpenDir = String(wsState?.openDirectory || '').trim();
  const isZh = currentLanguage === 'zh';
  const agentName = isZh ? '智能编码空间' : 'Intelligent Coding Space';

  // Determine current project — match by normalized id, not raw openDirectory,
  // because workspace_state.openDirectory and project.openDirectory may use
  // different path separators (backslash vs forward slash) or case.
  let normCurrentDir = currentOpenDir.replace(/\\/g, '/').toLowerCase();
  let currentProject = currentOpenDir
    ? projects.find(p => p.id === ('dir:' + normCurrentDir)) || null
    : (projects.length > 0 ? projects[0] : null);

  // 远程独有项目视图覆盖（ADR-0012 决策 1）：view-only 选中优先于工作区目录；
  // 项目消失（断线 / 目录历史清空）时自动回落到工作区目录并清除覆盖。
  const overrideProjectId = (typeof window !== 'undefined' && window.ClawFW?.phSurfaceViewProjectId) || '';
  if (overrideProjectId && overrideProjectId !== currentProject?.id) {
    const overrideProject = projects.find((p) => p.id === overrideProjectId && p.remoteOnly);
    if (overrideProject) {
      currentProject = overrideProject;
    } else if (typeof window !== 'undefined' && window.ClawFW) {
      window.ClawFW.phSurfaceViewProjectId = null;
    }
  }

  // Project header avatar
  const headerAvatar = currentProject
    ? escapeHtml((getProgrammingHelperProjectDisplayName(currentProject) || '?')[0].toUpperCase())
    : '?';
  const headerName = currentProject
    ? escapeHtml(getProgrammingHelperProjectDisplayName(currentProject))
    : (isZh ? '未打开项目' : 'No Project');

  // Open-folder icon button for the active project
  const openFolderBtnHtml = (dir) =>
    '<button class="ph-dropdown-open-folder" type="button" title="' +
    escapeHtml(isZh ? '在文件夹中打开' : 'Open in folder') +
    '" onclick="event.stopPropagation();window.phOpenInExplorer(\'' + escapeHtml(dir) + '\')">' +
    '<svg width="18" height="18" viewBox="0 0 16 16" fill="none"><path d="M2 4.5C2 3.67 2.67 3 3.5 3H6.5L8 4.5H12.5C13.33 4.5 14 5.17 14 6V11.5C14 12.33 13.33 13 12.5 13H3.5C2.67 13 2 12.33 2 11.5V4.5Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>' +
    '<span class="ph-dropdown-open-folder-text">' + escapeHtml(isZh ? '打开' : 'Open') + '</span>' +
    '</button>';

  // Dropdown items for recent projects
  const dropdownItems = projects.map((p) => {
    const pName = getProgrammingHelperProjectDisplayName(p);
    const pAvatar = escapeHtml((pName || '?')[0].toUpperCase());
    const isActive = p.id === (currentProject?.id || '');
    return [
      '<div class="ph-project-dropdown-item' + (isActive ? ' active' : '') + '" data-project-id="' + escapeHtml(p.id) + '" onclick="window.phSwitchProject(\'' + escapeHtml(p.id) + '\')">',
      '<div class="ph-project-dropdown-avatar">' + pAvatar + '</div>',
      '<div class="ph-project-dropdown-info">',
      '<div class="ph-project-dropdown-name">' + escapeHtml(pName) + '</div>',
      '<div class="ph-project-dropdown-path">' + escapeHtml(p.openDirectory) + '</div>',
      '</div>',
      (isActive ? openFolderBtnHtml(p.openDirectory) : ''),
      '</div>',
    ].join('');
  }).join('');

  const dropdownHtml = projects.length > 1
    ? '<div class="ph-project-dropdown">' +
      '<div class="ph-project-dropdown-trigger" onclick="window.phToggleProjectDropdown(event)">' +
      '<div class="ph-project-header-avatar">' + headerAvatar + '</div>' +
      '<div class="ph-project-header-info">' +
      '<div class="ph-project-header-name">' + headerName + '</div>' +
      '</div>' +
      '<svg class="ph-project-dropdown-arrow" width="12" height="12" viewBox="0 0 12 12"><path d="M3 5l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>' +
      '</div>' +
      '<div class="ph-project-dropdown-menu">' + dropdownItems + '</div>' +
      '</div>'
    : '<div class="ph-project-header-static">' +
      '<div class="ph-project-header-avatar">' + headerAvatar + '</div>' +
      '<div class="ph-project-header-info">' +
      '<div class="ph-project-header-name">' + headerName + '</div>' +
      '</div>' +
      (currentProject ? openFolderBtnHtml(currentProject.openDirectory) : '') +
      '</div>';

  // Banner (restored) + project bar
  const bannerHtml = [
    '<div class="ph-banner">',
    '<div>',
    '<div class="ph-banner-title">' + escapeHtml(agentName) + '</div>',
    '<div class="ph-banner-desc">' + escapeHtml(desc) + '</div>',
    '</div>',
    '<div class="ph-banner-actions">',
    '<button class="ph-banner-btn secondary" type="button" onclick="window.phOpenModelConfig()">' + (isZh ? '工作空间设置' : 'Settings') + '</button>',
    '<button class="ph-banner-btn" type="button" onclick="window.phOpenProject()">' + (isZh ? '打开项目' : 'Open Project') + '</button>',
    '</div>',
    '</div>',
  ].join('');

  // 获取当前主代理模型显示
  const modelPresets = agent?.modelPresets || {};
  const defaultPreset = modelPresets.default || {};
  const primaryModel = typeof defaultPreset === 'string' ? defaultPreset : (defaultPreset.primary || '');
  const secondaryModel = typeof defaultPreset === 'string' ? '' : (defaultPreset.secondary || '');

  // 获取模型显示名称（从全局presets中查找）
  const getModelDisplayName = (modelName) => {
    if (!modelName) return '';
    const presets = window.ClawFW?._modelPresets || [];
    const preset = presets.find(p => p.name === modelName);
    if (preset) {
      // 显示模型名称，如果有contextLength则显示
      const ctx2 = preset.contextLength ? ' · ' + Math.round(preset.contextLength / 1000) + 'K' : '';
      return preset.name + ctx2;
    }
    return modelName;
  };

  const modelDisplayName = getModelDisplayName(primaryModel);
  const hasSecondary = !!secondaryModel;

  // 模型显示组件 - 简洁设计，无图标（模型预设属本地 agent 配置；远程视图按
  // 宿主 write 能力决定呈现，不可写宿主不在此呈现模型切换）。
  const viewIdentity = projectViewIdentity(agent, currentProject);
  const canWorkspaceCreate = viewCapabilityEnabled(viewIdentity, 'workspaceCreate');
  const modelSwitchHtml = currentProject && viewCapabilityEnabled(viewIdentity, 'write') && modelDisplayName ? [
    '<div class="ph-model-switch' + (hasSecondary ? ' has-secondary' : '') + '" onclick="window.phToggleModelSlot()" title="' + escapeHtml(isZh ? (hasSecondary ? '点击切换到: ' + secondaryModel : '点击配置备选模型') : (hasSecondary ? 'Click to switch to: ' + secondaryModel : 'Click to configure secondary model')) + '">',
    '<span class="ph-model-switch-name">' + escapeHtml(modelDisplayName) + '</span>',
    (hasSecondary ? '<svg class="ph-model-switch-arrow" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 3l4 4-4 4"/><line x1="20" y1="7" x2="8" y2="7"/><path d="M8 21l-4-4 4-4"/><line x1="4" y1="17" x2="16" y2="17"/></svg>' : ''),
    '</div>',
  ].join('') : '';

    // 新对话动作（R2-03）：remoteOnly 视图携带宿主级命名空间 agentId，服务端
    // 按命名空间分支转发到远程宿主创建；本地动作形状不变。
    const newChatAction = escapeHtml(JSON.stringify({
      type: 'create_session',
      openDirectory: currentProject?.openDirectory || '',
      ...((currentProject?.remoteOnly && viewIdentity) ? { agentId: viewIdentity } : {}),
    }));

    // 目录设置按钮（共享配置编辑器，编辑当前目录的目录层）；
    // 目录由当前项目显式传入，避免运行时二次查询 workspace_state 失效。
    // 目录配置编辑的是本地 agent 的目录层配置，属真本地语义：remoteOnly
    // 项目保持隐藏，不随远程能力放开（无对应远程能力位，不引入伪能力）。
    const dirConfigBtn = (currentProject && !currentProject.remoteOnly && typeof phDirConfigButtonHtml === 'function')
      ? phDirConfigButtonHtml(agent, currentProject.openDirectory) : '';

    const headerBar = [
      '<div class="ph-project-bar">',
      '<div class="ph-project-bar-left">',
      dropdownHtml,
      '</div>',
      '<div class="ph-project-bar-right">',
      modelSwitchHtml,
      dirConfigBtn,
      // 新对话渲染查 workspaceCreate 能力（远程目录经服务端转发创建）。
      (currentProject && canWorkspaceCreate ? '<button class="ph-banner-btn" type="button" data-workspace-action="' + newChatAction + '" onclick="window.runWorkspaceActionFromEvent(event, this.dataset.workspaceAction)">' + (isZh ? '新对话' : 'New Chat') + '</button>' : ''),
      '</div>',
      '</div>',
    ].join('');

  // No project state
  if (!currentProject) {
    return [
      bannerHtml,
      '<section class="workspace-section">',
      '<div class="ph-welcome">',
      '<div class="ph-welcome-icon">&#128193;</div>',
      '<div class="ph-welcome-title">' + (isZh ? '打开一个项目开始编程' : 'Open a project to start coding') + '</div>',
      '<div class="ph-welcome-desc">' + (isZh ? '选择一个本地文件夹作为工作目录，智能编码空间将在该项目中协助你。' : 'Select a local folder as your workspace. The assistant will help you code within the project.') + '</div>',
      '</div>',
      '</section>',
    ].join('');
  }

  // Project is active - show its sessions with tabs
  const mainSessions = sortPhSessionsByMode(currentProject.sessions.filter(s => s.archived !== true));
  const archivedSessions = sortPhSessionsByMode(currentProject.sessions.filter(s => s.archived === true));
  const needsTabs = true; // 始终显示分页器，不管每个类型有没有对话

  const renderPhSessionItem = (session, type) => {
    const sType = type || session.sessionType || 'main';
    // 远程历史会话（ADR-0012 决策 1）：操作寻址用宿主级命名空间 id——
    // 服务端会话端点按命名空间 agentId 解析远程目标并转发（裸 id）。
    const sessionNsId = session.remoteHostNsId || agent.id;
    // Primary action button + ⋯ more menu button (equivalent to right-click ctx-menu)
    const openAction = escapeHtml(JSON.stringify({ type: 'open_session', sessionId: session.id }));
    const primaryBtn = '<button class="workspace-action" type="button" data-workspace-action="' + openAction + '" onclick="window.runWorkspaceAction(this.dataset.workspaceAction, this)">' + escapeHtml(t('workspace_open_chat')) + '</button>';
    const moreBtn = '<button class="workspace-action secondary session-more-btn" type="button" onclick="window.phShowSessionCtxMenu(event, this, \'' + escapeHtml(sessionNsId) + '\', \'' + escapeHtml(session.id) + '\', \'' + escapeHtml(sType) + '\')"><svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><circle cx="3" cy="7" r="1.3"/><circle cx="7" cy="7" r="1.3"/><circle cx="11" cy="7" r="1.3"/></svg></button>';
    const buttonsHtml = [primaryBtn, moreBtn].join('');
    // Build compact time indicator for title-row left side (only within this week)
    let shortTime = getSessionShortTime(session.updatedAt);
    let recencyCls = getSessionRecencyClass(session.updatedAt);
    let indicatorHtml = shortTime
      ? '<span class="session-time-indicator ' + recencyCls + '"><span class="session-time-dot"></span><span class="session-time-label">' + escapeHtml(shortTime) + '</span></span>'
      : '';
    return [
      '<div class="feature-project-session-item workspace-history-item" data-prebuilt-session-agent-id="' + escapeHtml(sessionNsId) + '" data-prebuilt-session-id="' + escapeHtml(session.id) + '" data-session-type="' + escapeHtml(sType) + '" data-ctx-role="session" data-ctx-ns="' + escapeHtml(sessionNsId) + '" data-ctx-id="' + escapeHtml(session.id) + '" data-ctx-variant="' + escapeHtml(sType) + '">',
      '<div class="workspace-history-main">',
      '<div class="workspace-history-title-row">',
      indicatorHtml,
      '<div class="workspace-history-title" ondblclick="window.handleSessionTitleDoubleClick(event)" title="' + escapeHtml(isZh ? '双击编辑标题' : 'Double-click to edit title') + '">' + escapeHtml(session.title || session.id) + '</div>',
      renderSessionResumeBadge(session),
      (typeof window.renderSessionThreadBadge === 'function' ? window.renderSessionThreadBadge(agent.id, session) : ''),
      renderSessionTodoBadge(session),
      renderSessionArchivedBadge(session),
      renderSessionTitleAiButton(session),
      '</div>',
      '<div class="workspace-history-meta">' + escapeHtml(formatWorkspaceDate(session.updatedAt)) + ' · ' + escapeHtml(String(session.messageCount ?? 0)) + ' ' + escapeHtml(isZh ? '条消息' : 'messages') + '</div>',
      session.preview ? '<div class="workspace-history-preview">' + escapeHtml(session.preview) + '</div>' : '',
      renderSessionTokenBar(session, agent),
      '</div>',
      '<div class="workspace-history-side">',
      '<div class="workspace-actions stacked">',
      buttonsHtml,
      '</div>',
      '</div>',
      '</div>',
    ].join('');
  };

  // Render sessions with time-based group headers (今天 / 昨天 / 本周 / 更早)
  const renderPhSessionsWithGroups = (sessions, type) => {
    let html = '';
    let lastGroup = null;
    for (const session of sessions) {
      let group = getTimeGroupLabel(session.updatedAt);
      if (group && group !== lastGroup) {
        html += '<div class="ph-session-group-header">' + escapeHtml(group) + '</div>';
        lastGroup = group;
      }
      html += renderPhSessionItem(session, type);
    }
    return html;
  };

  let sessionsHtml = '';
  if (needsTabs) {
    const tabId = 'ph-tab-' + escapeHtml(agent.id) + '-' + escapeHtml(currentProject.id);
    // 新对话渲染查 workspaceCreate 能力（R2-03）：remoteOnly 视图按宿主握手
    // 能力放开，本地视图恒渲染。
    const newChatBtnHtml = canWorkspaceCreate ? '<div class="feature-project-empty-actions"><button class="workspace-action" type="button" data-workspace-action="' + newChatAction + '" onclick="window.runWorkspaceActionFromEvent(event, this.dataset.workspaceAction)">' + escapeHtml(t('workspace_new_chat')) + '</button></div>' : '';
    const mainEmptyNote = '<div class="feature-project-empty-note">' + escapeHtml(t('workspace_feature_no_sessions')) + '</div>' + newChatBtnHtml;
    const isSearching = phSearchQuery.trim().length > 0;
    const coderCount = (typeof window.CoderThreadsUI?.countFor === 'function') ? window.CoderThreadsUI.countFor(currentProject.openDirectory) : 0;
    // 分页徽标：服务端切片携带当前项目 main/archived 真实总数（远程旧版
    // 无此字段时回退已加载数）。加载更多按整体切片进度（sessionTotal vs
    // 已加载条数），两个 tab 共用同一条追加流。
    const wsMeta = agent?.workspace_sessions || {};
    const loadedCount = Array.isArray(wsMeta.sessions) ? wsMeta.sessions.length : 0;
    const sessionTotal = Number(wsMeta.sessionTotal);
    const mainTabCount = Number.isFinite(Number(wsMeta.mainTotal)) ? Number(wsMeta.mainTotal) : mainSessions.length;
    const archivedTabCount = Number.isFinite(Number(wsMeta.archivedTotal)) ? Number(wsMeta.archivedTotal) : archivedSessions.length;
    const hasMore = Number.isFinite(sessionTotal) && loadedCount < sessionTotal;
    const loadMoreBtnHtml = hasMore
      ? '<div class="ph-load-more-wrap"><button class="workspace-action secondary ph-load-more-btn" type="button" onclick="window.phLoadMoreSessions()">' + escapeHtml(isZh ? '加载更多（已显示 ' + loadedCount + ' / ' + sessionTotal + '）' : 'Load more (' + loadedCount + ' / ' + sessionTotal + ')') + '</button></div>'
      : '';
    sessionsHtml += '<div class="ph-session-tabs' + (isSearching ? ' searching' : '') + '" data-tab-group="' + tabId + '">';
    sessionsHtml += '<div class="ph-session-tab-bar">';
    sessionsHtml += '<div class="ph-session-tabs-row">';
    sessionsHtml += '<button class="ph-session-tab' + (isSearching ? '' : ' active') + '" data-ph-tab="main" onclick="window.switchPhSessionTab(this)">' + escapeHtml(t('workspace_main_conversations')) + ' <span class="ph-tab-count">' + escapeHtml(String(mainTabCount)) + '</span></button>';
    sessionsHtml += '<button class="ph-session-tab" data-ph-tab="archived" onclick="window.switchPhSessionTab(this)">' + escapeHtml(t('workspace_archived_conversations')) + ' <span class="ph-tab-count">' + escapeHtml(String(archivedTabCount)) + '</span></button>';
    sessionsHtml += '<button class="ph-session-tab" data-ph-tab="coder" onclick="window.switchPhSessionTab(this)">Coder <span class="ph-tab-count">' + escapeHtml(String(coderCount)) + '</span></button>';
    sessionsHtml += '</div>';
    sessionsHtml += '<div class="ph-session-toolbar">';
    sessionsHtml += '<div class="ph-session-search-inline">';
    sessionsHtml += '<svg class="ph-search-icon" width="13" height="13" viewBox="0 0 14 14" fill="none"><circle cx="6" cy="6" r="4.5" stroke="currentColor" stroke-width="1.3"/><path d="M9.5 9.5L12.5 12.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
    sessionsHtml += '<input type="text" class="ph-search-input" placeholder="' + escapeHtml(isZh ? '搜索对话内容...' : 'Search conversations...') + '" value="' + escapeHtml(phSearchQuery) + '" oninput="window.phOnSearchInput(this.value)" onkeydown="if(event.key===\'Escape\'){window.phClearSearch()}">';
    sessionsHtml += '<button class="ph-search-clear-btn" type="button" onclick="window.phClearSearch()" title="' + escapeHtml(isZh ? '清除搜索' : 'Clear search') + '"' + (isSearching ? '' : ' style="display:none"') + '><svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button>';
    sessionsHtml += '</div>';
    sessionsHtml += '<div class="ph-session-sort-toggle"><button type="button" onclick="window.phToggleSessionSort(this)" title="' + escapeHtml(isZh ? '切换排序方式' : 'Toggle sort order') + '"><svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M3 2v8M3 10L1.5 8.5M3 10l1.5-1.5M9 10V2M9 2L7.5 3.5M9 2l1.5 1.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>' + escapeHtml(phSessionSortMode === 'createdAt' ? t('workspace_sort_created') : t('workspace_sort_updated')) + '</button></div>';
    sessionsHtml += '</div>';
    sessionsHtml += '</div>';
    sessionsHtml += '<div class="ph-session-tab-panels">';
    sessionsHtml += '<div class="ph-session-tab-panel active" data-ph-panel="main"><div class="feature-project-session-list">' + (mainSessions.length > 0 ? renderPhSessionsWithGroups(mainSessions, 'main') + loadMoreBtnHtml : mainEmptyNote) + '</div></div>';
    sessionsHtml += '<div class="ph-session-tab-panel" data-ph-panel="archived"><div class="feature-project-session-list">' + (archivedSessions.length > 0 ? renderPhSessionsWithGroups(archivedSessions, 'archived') + loadMoreBtnHtml : '<div class="feature-project-empty-note">' + escapeHtml(t('workspace_feature_no_sessions')) + '</div>' + (hasMore ? loadMoreBtnHtml : '')) + '</div></div>';
    const coderPanelHtml = (typeof window.CoderThreadsUI?.render === 'function')
      ? window.CoderThreadsUI.render({ projectDir: currentProject.openDirectory })
      : '';
    sessionsHtml += '<div class="ph-session-tab-panel" data-ph-panel="coder">' + coderPanelHtml + '</div>';
    sessionsHtml += '</div>';
    sessionsHtml += '<div class="ph-search-panel">';
    sessionsHtml += (typeof window._buildPhSearchPanelHtml === 'function' ? window._buildPhSearchPanelHtml(agent.id) : '');
    sessionsHtml += '</div>';
    sessionsHtml += '</div>';
  } else {
    const emptyNote = '<div class="feature-project-empty-note">' + escapeHtml(t('workspace_feature_no_sessions')) + '</div><div class="feature-project-empty-actions"><button class="workspace-action" type="button" data-workspace-action="' + newChatAction + '" onclick="window.runWorkspaceActionFromEvent(event, this.dataset.workspaceAction)">' + escapeHtml(t('workspace_new_chat')) + '</button></div>';
    sessionsHtml = '<div class="feature-project-session-group"><div class="feature-project-session-list">' + (mainSessions.length > 0 ? renderPhSessionsWithGroups(mainSessions, 'main') : emptyNote) + '</div></div>';
  }

  // Schedule async open-sessions recovery card
  setTimeout(() => window.phLoadOpenSessionsCard(agent.id, currentProject.openDirectory), 0);

  return [
    bannerHtml,
    headerBar,
    '<div id="ph-open-sessions-container">' + (_phOpenSessionsCache.html || '') + '</div>',
    '<section class="workspace-section">',
    sessionsHtml,
    '</section>',
  ].join('');
}

// ── Generic / Fallback ───────────────────────────────────────────

function _renderGenericSessionList(agent, block, ctx) {
  const { sessions, isFeatureCreator, activeSessionId, title, desc, headerAction } = ctx;

  let bodyHtml = '<div class="workspace-history-list"><div class="workspace-history-item"><div>' + escapeHtml(t('workspace_history_empty')) + '</div></div></div>';
  if (sessions.length > 0) {
    bodyHtml = '<div class="workspace-history-list">' + sessions.map((session) => {
      const openAction = escapeHtml(JSON.stringify({ type: 'open_session', sessionId: session.id }));
      const newChatAction = escapeHtml(JSON.stringify({
        type: 'create_session_from_session',
        sessionId: session.id,
        featureName: session.featureName || '',
        openDirectory: session.openDirectory || '',
      }));
      const compactedResumeAction = escapeHtml(JSON.stringify({
        type: 'compacted_resume_session',
        sessionId: session.id,
      }));
      const primaryTitle = isFeatureCreator
        ? getFeatureSessionDisplayName(session, agent)
        : (session.title || session.id);
      const isAssembly = isAssemblySession(session);
      const allowCompactedResume = !isAssembly;
      // data-ctx-* enables the declarative ctx-menu (summary/trim/branch)
      // for agents listed in CTX_SESSION_OPS_AGENTS; agents outside that
      // set get an empty item list and fall through to the legacy menu.
      const ctxVariant = isAssembly ? 'assembly' : 'default';
      return [
        '<div class="workspace-history-item" data-prebuilt-session-agent-id="' + escapeHtml(agent.id) + '" data-prebuilt-session-id="' + escapeHtml(session.id) + '" data-ctx-role="session" data-ctx-ns="' + escapeHtml(agent.id) + '" data-ctx-id="' + escapeHtml(session.id) + '" data-ctx-variant="' + escapeHtml(ctxVariant) + '">',
        '<div class="workspace-history-main">',
        '<div class="workspace-history-title-row">',
        '<div class="workspace-history-title" ondblclick="window.handleSessionTitleDoubleClick(event)" title="' + escapeHtml(currentLanguage === 'zh' ? '双击编辑标题' : 'Double-click to edit title') + '">' + escapeHtml(primaryTitle) + '</div>',
        renderSessionResumeBadge(session),
        (typeof window.renderSessionThreadBadge === 'function' ? window.renderSessionThreadBadge(agent.id, session) : ''),
        session.id === activeSessionId ? '<span class="workspace-history-active">当前</span>' : '',
        renderSessionArchivedBadge(session),
        renderSessionTitleAiButton(session),
        '</div>',
        '<div class="workspace-history-meta">' + escapeHtml(formatWorkspaceDate(session.updatedAt)) + '</div>',
        session.preview ? '<div class="workspace-history-preview">' + escapeHtml(session.preview) + '</div>' : '',
        renderSessionTokenBar(session, agent),
        '</div>',
        '<div class="workspace-history-side">',
        '<div class="workspace-history-meta compact">',
        escapeHtml(t('workspace_history_messages')) + ': ' + escapeHtml(String(session.messageCount ?? 0)),
        (session.openDirectory ? '<br>' + escapeHtml(session.openDirectory) : ''),
        '</div>',
        '<div class="workspace-actions stacked">',
        '<button class="workspace-action" type="button" data-workspace-action="' + openAction + '" onclick="window.runWorkspaceAction(this.dataset.workspaceAction, this)">' + escapeHtml(t('workspace_open_chat')) + '</button>',
        (allowCompactedResume
          ? '<button class="workspace-action secondary" type="button" data-workspace-action="' + compactedResumeAction + '" onclick="window.runWorkspaceAction(this.dataset.workspaceAction, this)">' + escapeHtml(t('workspace_light_resume')) + '</button>'
          : ''),
        (isFeatureCreator && viewCapabilityEnabled(agent.id, 'workspaceCreate')
          ? '<button class="workspace-action secondary" type="button" data-workspace-action="' + newChatAction + '" onclick="window.runWorkspaceAction(this.dataset.workspaceAction, this)">' + escapeHtml(t('workspace_new_chat')) + '</button>'
          : ''),
        '</div>',
        '</div>',
        '</div>',
      ].join('');
    }).join('') + '</div>';
  }

  return [
    '<section class="workspace-section">',
    '<div class="workspace-section-header">',
    '<div>',
    '<div class="workspace-section-title">' + escapeHtml(title) + '</div>',
    '<div class="workspace-section-desc">' + escapeHtml(desc) + '</div>',
    '</div>',
    headerAction,
    '</div>',
    bodyHtml,
    '</section>',
  ].join('');
}
