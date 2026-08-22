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

  if (agent?.id === 'programming-helper' || agent?.id === 'coder') {
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
          '<button class="workspace-action secondary" type="button" data-workspace-action="' + newChatAction + '" onclick="window.runWorkspaceActionFromEvent(event, this.dataset.workspaceAction)">' + escapeHtml(t('workspace_new_chat')) + '</button>',
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
          '<button class="workspace-action secondary" type="button" data-workspace-action="' + newChatAction + '" onclick="window.runWorkspaceActionFromEvent(event, this.dataset.workspaceAction)">' + escapeHtml(t('workspace_new_chat')) + '</button>',
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
  const agentName = isZh ? '编程小助手' : 'Programming Helper';

  // Determine current project — match by normalized id, not raw openDirectory,
  // because workspace_state.openDirectory and project.openDirectory may use
  // different path separators (backslash vs forward slash) or case.
  let normCurrentDir = currentOpenDir.replace(/\\/g, '/').toLowerCase();
  const currentProject = currentOpenDir
    ? projects.find(p => p.id === ('dir:' + normCurrentDir)) || null
    : (projects.length > 0 ? projects[0] : null);

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

  // 模型显示组件 - 简洁设计，无图标
  const modelSwitchHtml = currentProject && modelDisplayName ? [
    '<div class="ph-model-switch' + (hasSecondary ? ' has-secondary' : '') + '" onclick="window.phToggleModelSlot()" title="' + escapeHtml(isZh ? (hasSecondary ? '点击切换到: ' + secondaryModel : '点击配置备选模型') : (hasSecondary ? 'Click to switch to: ' + secondaryModel : 'Click to configure secondary model')) + '">',
    '<span class="ph-model-switch-name">' + escapeHtml(modelDisplayName) + '</span>',
    (hasSecondary ? '<svg class="ph-model-switch-arrow" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 3l4 4-4 4"/><line x1="20" y1="7" x2="8" y2="7"/><path d="M8 21l-4-4 4-4"/><line x1="4" y1="17" x2="16" y2="17"/></svg>' : ''),
    '</div>',
  ].join('') : '';

    const newChatAction = escapeHtml(JSON.stringify({
      type: 'create_session',
      openDirectory: currentProject?.openDirectory || '',
    }));

    // 目录设置按钮（共享配置编辑器，编辑当前目录的目录层）
    const dirConfigBtn = (typeof phDirConfigButtonHtml === 'function')
      ? phDirConfigButtonHtml(agent) : '';

    const headerBar = [
      '<div class="ph-project-bar">',
      '<div class="ph-project-bar-left">',
      dropdownHtml,
      '</div>',
      '<div class="ph-project-bar-right">',
      modelSwitchHtml,
      (currentProject ? '<button class="ph-banner-btn" type="button" data-workspace-action="' + newChatAction + '" onclick="window.runWorkspaceActionFromEvent(event, this.dataset.workspaceAction)">' + (isZh ? '新对话' : 'New Chat') + '</button>' : ''),
      dirConfigBtn,
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
      '<div class="ph-welcome-desc">' + (isZh ? '选择一个本地文件夹作为工作目录，编程小助手将在该项目中协助你。' : 'Select a local folder as your workspace. The assistant will help you code within the project.') + '</div>',
      '</div>',
      '</section>',
    ].join('');
  }

  // Project is active - show its sessions with tabs
  const mainSessions = sortPhSessionsByMode(currentProject.sessions.filter(s => s.sessionType !== 'exploration' && s.sessionType !== 'sub' && s.archived !== true));
  const archivedSessions = sortPhSessionsByMode(currentProject.sessions.filter(s => s.archived === true));
  const explorationSessions = sortPhSessionsByMode(currentProject.sessions.filter(s => s.sessionType === 'exploration'));
  const subSessions = sortPhSessionsByMode(currentProject.sessions.filter(s => s.sessionType === 'sub'));
  const needsTabs = true; // 始终显示分页器，不管每个类型有没有对话

  const renderPhSessionItem = (session, type) => {
    const sType = type || session.sessionType || 'main';
    const isExplorationOrSub = sType === 'exploration' || sType === 'sub';
    // Primary action button + ⋯ more menu button (equivalent to right-click ctx-menu)
    let primaryBtn = '';
    if (isExplorationOrSub) {
      const viewAction = escapeHtml(JSON.stringify({ type: 'view_session_record', sessionId: session.id, agentId: agent.id, sessionType: sType }));
      primaryBtn = '<button class="workspace-action" type="button" data-workspace-action="' + viewAction + '" onclick="window.runWorkspaceAction(this.dataset.workspaceAction, this)">' + escapeHtml(t('workspace_view_record')) + '</button>';
    } else {
      const openAction = escapeHtml(JSON.stringify({ type: 'open_session', sessionId: session.id }));
      primaryBtn = '<button class="workspace-action" type="button" data-workspace-action="' + openAction + '" onclick="window.runWorkspaceAction(this.dataset.workspaceAction, this)">' + escapeHtml(t('workspace_open_chat')) + '</button>';
    }
    const moreBtn = '<button class="workspace-action secondary session-more-btn" type="button" onclick="window.phShowSessionCtxMenu(event, this, \'' + escapeHtml(agent.id) + '\', \'' + escapeHtml(session.id) + '\', \'' + escapeHtml(sType) + '\')"><svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><circle cx="3" cy="7" r="1.3"/><circle cx="7" cy="7" r="1.3"/><circle cx="11" cy="7" r="1.3"/></svg></button>';
    const buttonsHtml = [primaryBtn, moreBtn].join('');
    // Build compact time indicator for title-row left side (only within this week)
    let shortTime = getSessionShortTime(session.updatedAt);
    let recencyCls = getSessionRecencyClass(session.updatedAt);
    let indicatorHtml = shortTime
      ? '<span class="session-time-indicator ' + recencyCls + '"><span class="session-time-dot"></span><span class="session-time-label">' + escapeHtml(shortTime) + '</span></span>'
      : '';
    return [
      '<div class="feature-project-session-item workspace-history-item" data-prebuilt-session-agent-id="' + escapeHtml(agent.id) + '" data-prebuilt-session-id="' + escapeHtml(session.id) + '" data-session-type="' + escapeHtml(sType) + '" data-ctx-role="session" data-ctx-ns="' + escapeHtml(agent.id) + '" data-ctx-id="' + escapeHtml(session.id) + '" data-ctx-variant="' + escapeHtml(sType) + '">',
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
      sType !== 'exploration' && session.preview ? '<div class="workspace-history-preview">' + escapeHtml(session.preview) + '</div>' : '',
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
    const mainEmptyNote = '<div class="feature-project-empty-note">' + escapeHtml(t('workspace_feature_no_sessions')) + '</div><div class="feature-project-empty-actions"><button class="workspace-action" type="button" data-workspace-action="' + newChatAction + '" onclick="window.runWorkspaceActionFromEvent(event, this.dataset.workspaceAction)">' + escapeHtml(t('workspace_new_chat')) + '</button></div>';
    const isSearching = phSearchQuery.trim().length > 0;
    sessionsHtml += '<div class="ph-session-tabs' + (isSearching ? ' searching' : '') + '" data-tab-group="' + tabId + '">';
    sessionsHtml += '<div class="ph-session-tab-bar">';
    sessionsHtml += '<div class="ph-session-tabs-row">';
    sessionsHtml += '<button class="ph-session-tab' + (isSearching ? '' : ' active') + '" data-ph-tab="main" onclick="window.switchPhSessionTab(this)">' + escapeHtml(t('workspace_main_conversations')) + ' <span class="ph-tab-count">' + escapeHtml(String(mainSessions.length)) + '</span></button>';
    sessionsHtml += '<button class="ph-session-tab" data-ph-tab="archived" onclick="window.switchPhSessionTab(this)">' + escapeHtml(t('workspace_archived_conversations')) + ' <span class="ph-tab-count">' + escapeHtml(String(archivedSessions.length)) + '</span></button>';
    sessionsHtml += '<button class="ph-session-tab" data-ph-tab="exploration" onclick="window.switchPhSessionTab(this)">' + escapeHtml(t('workspace_exploration_conversations')) + ' <span class="ph-tab-count">' + escapeHtml(String(explorationSessions.length)) + '</span></button>';
    sessionsHtml += '<button class="ph-session-tab" data-ph-tab="sub" onclick="window.switchPhSessionTab(this)">' + escapeHtml(t('workspace_sub_conversations')) + ' <span class="ph-tab-count">' + escapeHtml(String(subSessions.length)) + '</span></button>';
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
    sessionsHtml += '<div class="ph-session-tab-panel active" data-ph-panel="main"><div class="feature-project-session-list">' + (mainSessions.length > 0 ? renderPhSessionsWithGroups(mainSessions, 'main') : mainEmptyNote) + '</div></div>';
    sessionsHtml += '<div class="ph-session-tab-panel" data-ph-panel="archived"><div class="feature-project-session-list">' + (archivedSessions.length > 0 ? renderPhSessionsWithGroups(archivedSessions, 'archived') : '<div class="feature-project-empty-note">' + escapeHtml(t('workspace_feature_no_sessions')) + '</div>') + '</div></div>';
    sessionsHtml += '<div class="ph-session-tab-panel" data-ph-panel="exploration"><div class="feature-project-session-list">' + (explorationSessions.length > 0 ? renderPhSessionsWithGroups(explorationSessions, 'exploration') : '<div class="feature-project-empty-note">' + escapeHtml(t('workspace_feature_no_sessions')) + '</div>') + '</div></div>';
    sessionsHtml += '<div class="ph-session-tab-panel" data-ph-panel="sub"><div class="feature-project-session-list">' + (subSessions.length > 0 ? renderPhSessionsWithGroups(subSessions, 'sub') : '<div class="feature-project-empty-note">' + escapeHtml(t('workspace_feature_no_sessions')) + '</div>') + '</div></div>';
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
        (isFeatureCreator
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
