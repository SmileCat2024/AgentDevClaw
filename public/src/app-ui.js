
function selectWorkspaceSurface(agentId, options = {}) {
  if (agentId && !loadedAgentDetailIds.has(agentId)) {
    loadAgentDetail(agentId).then(() => renderCurrentMainView());
  }
  const targetAgent = allAgents.find((item) => item.id === agentId) || null;
  const unitKey = getUnitPreferenceKey(targetAgent || getCurrentAgentRecord());
  const workspaceTabs = getUnitTabs(targetAgent || getCurrentAgentRecord());
  const preferredWorkspaceMode = unitKey ? workspaceSurfaceModePreferences[unitKey] : null;
  let nextWorkspaceTab = getDefaultUnitMode(targetAgent || getCurrentAgentRecord());
  if (nextWorkspaceTab === 'chat') {
    if (preferredWorkspaceMode && workspaceTabs.some((tab) => tab.id === preferredWorkspaceMode)) {
      nextWorkspaceTab = preferredWorkspaceMode;
    } else {
      const ui = getCurrentUnitUi(targetAgent || getCurrentAgentRecord());
      const fallbackWorkspaceTab = workspaceTabs.find((tab) => tab.id !== 'chat')?.id || ui?.entry || 'home';
      nextWorkspaceTab = fallbackWorkspaceTab;
    }
  }
  const prevAgentId = currentAgentId;
  currentAgentId = agentId || null;
  currentRuntimeAgentId = null;
  readOnlyMode = false;
  currentWorkspaceArtifactDetail = null;
  currentWorkspaceDocsetDetail = null;
  currentProjectDocsetOpen = false;
  currentProjectRequirementEdit = null;
  currentProjectDocsetPage = 'requirement';
  currentWorkspaceTab = nextWorkspaceTab;
  // Only animate on agent change or first entry, not when returning from chat within the same agent.
  shouldAnimateWorkspaceSurface = (prevAgentId !== agentId);
  setFollowLatest(true);
  resetRuntimeBackedSurfaceState();
  renderAgentList();
  renderCurrentMainView();
  if (!options.skipFeaturePanel) {
    renderFeaturePanel();
  }
}

function upsertConnectedAgent(agent) {
  if (!agent?.id) return null;
  const index = allAgents.findIndex((item) => item.id === agent.id);
  const nextAgent = index >= 0
    ? { ...allAgents[index], ...agent }
    : { ...agent };
  if (index >= 0) {
    allAgents[index] = nextAgent;
  } else {
    allAgents.push(nextAgent);
  }
  return nextAgent;
}

function getUnitPreferenceKey(agent = getCurrentAgentRecord()) {
  if (!agent) return null;
  return agent.source === 'prebuilt' ? agent.id : (agent.id || null);
}

function getPreferredUnitMode(agent = getCurrentAgentRecord()) {
  const key = getUnitPreferenceKey(agent);
  return key ? (unitModePreferences[key] || null) : null;
}

function setPreferredUnitMode(mode, agent = getCurrentAgentRecord()) {
  const key = getUnitPreferenceKey(agent);
  if (!key) {
    currentWorkspaceTab = mode;
    return;
  }
  unitModePreferences[key] = mode;
  if (mode && mode !== 'chat' && !isWorkspaceHostUnit(agent)) {
    workspaceSurfaceModePreferences[key] = mode;
  }
  currentWorkspaceTab = mode;
}

function getPassiveWorkspaceSurfaceMode(agent = getCurrentAgentRecord()) {
  const ui = getCurrentUnitUi(agent);
  const tabs = getUnitTabs(agent);
  const nonChatTabs = tabs.filter((tab) => tab.id !== 'chat');
  if (ui?.entry && ui.entry !== 'chat' && nonChatTabs.some((tab) => tab.id === ui.entry)) {
    return ui.entry;
  }
  return nonChatTabs[0]?.id || 'home';
}

function getDefaultUnitMode(agent = getCurrentAgentRecord()) {
  const ui = getCurrentUnitUi(agent);
  if (!ui) return 'chat';
  if (isWorkspaceHostUnit(agent)) {
    if (readOnlyMode || currentRuntimeAgentId) {
      return 'chat';
    }
    return getPassiveWorkspaceSurfaceMode(agent);
  }
  const canEnterChat = canEnterWorkspaceChat(agent);
  const tabs = getUnitTabs(agent);
  const fallbackTab = tabs[0]?.id || 'home';
  const preferred = getPreferredUnitMode(agent);
  if (preferred) {
    if (preferred === 'chat') {
      if (canEnterChat) {
        return 'chat';
      }
      return fallbackTab === 'chat' && !canEnterChat ? 'home' : fallbackTab;
    }
    if (tabs.some((tab) => tab.id === preferred)) {
      return preferred;
    }
  }
  if (currentMessages.length > 0 && ui.entry !== 'home' && canEnterChat) {
    return 'chat';
  }
  if (ui.entry === 'chat' && canEnterChat) {
    return 'chat';
  }
  if (tabs.some((tab) => tab.id === ui.entry)) {
    return ui.entry;
  }
  return fallbackTab;
}

function ensureUnitMode(agent = getCurrentAgentRecord()) {
  const ui = getCurrentUnitUi(agent);
  if (!ui) {
    currentWorkspaceTab = null;
    return null;
  }

  if (isWorkspaceHostUnit(agent)) {
    currentWorkspaceTab = (readOnlyMode || currentRuntimeAgentId)
      ? 'chat'
      : getPassiveWorkspaceSurfaceMode(agent);
    return currentWorkspaceTab;
  }

  if (!currentWorkspaceTab) {
    currentWorkspaceTab = getDefaultUnitMode(agent);
  }

  if (currentWorkspaceTab === 'chat' && !canEnterWorkspaceChat(agent)) {
    currentWorkspaceTab = getPassiveWorkspaceSurfaceMode(agent);
  }

  return currentWorkspaceTab;
}

function getUnitTabs(agent = getCurrentAgentRecord()) {
  const ui = getCurrentUnitUi(agent);
  const tabs = Array.isArray(ui?.tabs) ? ui.tabs : [];
  return tabs
    .map((tab) => typeof tab === 'string' ? { id: tab, label: tab } : tab)
    .filter((tab) => tab && tab.id);
}

function getUnitTabLabel(tab) {
  if (tab?.id === 'home') return localizeWorkspaceValue(tab?.label, t('workspace_tab_welcome'));
  if (tab?.id === 'chat') return localizeWorkspaceValue(tab?.label, t('workspace_tab_chat'));
  return localizeWorkspaceValue(tab?.label, String(tab?.id || ''));
}

function getWorkspaceSessions(agent = getCurrentAgentRecord()) {
  return Array.isArray(agent?.workspace_sessions?.sessions) ? agent.workspace_sessions.sessions : [];
}

function getWorkspaceSessionById(agent = getCurrentAgentRecord(), sessionId = '') {
  return getWorkspaceSessions(agent).find((session) => session.id === String(sessionId || '').trim()) || null;
}

function isCompactedResumeSession(session) {
  return String(session?.metadata?.resumeMode || '').trim() === 'compacted';
}

function renderSessionResumeBadge(session) {
  if (!isCompactedResumeSession(session)) return '';
  return '<span class="workspace-history-active">' + escapeHtml(t('workspace_compacted_badge')) + '</span>';
}

function renderSessionTitleAiButton(session) {
  var isZh = currentLanguage === 'zh';
  return '<button class="session-title-ai-btn session-title-ai-btn-hidden" type="button" title="' + escapeHtml(isZh ? 'AI 生成标题' : 'AI generate title') + '" onmousedown="if(this._setGenerating)this._setGenerating(true);" onclick="event.stopPropagation();window.generateSessionTitle(\'' + escapeHtml(session.id) + '\',this)" aria-label="' + escapeHtml(isZh ? 'AI 生成标题' : 'AI generate title') + '"><span class="session-title-ai-btn-icon">✦</span><span class="session-title-ai-btn-text">' + escapeHtml(isZh ? 'AI生成' : 'AI Generate') + '</span></button>';
}

function getSessionContextLength(session, agent) {
  const cl = session?.contextLength;
  if (Number.isFinite(cl) && cl > 0) return cl;
  const fallback = agent?.workspace_sessions?.contextLength;
  if (Number.isFinite(fallback) && fallback > 0) return fallback;
  return 128000;
}

function renderSessionTokenBar(session, agent) {
  // 优先使用最后一次请求的用量，如果不存在则回退到累积值
  const lastRequest = session?.tokenUsage?.lastRequestUsage;
  const used = (lastRequest?.totalTokens || session?.tokenUsage?.totalTokens || 0);
  if (!used) return '';
  const hasExplicitCL = Number.isFinite(session?.contextLength) && session.contextLength > 0
    || Number.isFinite(agent?.workspace_sessions?.contextLength) && agent.workspace_sessions.contextLength > 0;
  if (!hasExplicitCL && !used) return '';
  const max = getSessionContextLength(session, agent);
  const pct = Math.min(100, Math.round((used / max) * 100));
  const tone = pct < 50 ? 'low' : pct < 80 ? 'mid' : 'high';
  const modelLabel = session?.modelName ? ' · ' + session.modelName : '';
  // 如果使用的是累积值（没有lastRequestUsage），添加标注
  const dataSource = lastRequest ? '' : ' (累积)';
  // 添加刷新按钮
  const refreshBtn = '<button class="token-refresh-btn" type="button" title="刷新 Token 计数" onclick="refreshSessionTokenCount(\'' + session.id + '\', \'' + agent.id + '\', this)" aria-label="刷新 Token 计数">↻</button>';
  return '<span class="session-token-inline tone-' + tone + '">'
    + '<span class="session-token-bar"><span class="session-token-bar-fill" style="width:' + pct + '%"></span></span>'
    + '<span class="session-token-pct">' + pct + '%' + modelLabel + dataSource + '</span>'
    + refreshBtn
    + '</span>';
}

/**
 * 更新聊天界面顶部的 context bar（模型名 + token 占比）。
 * 从 currentOverviewSnapshot 取 lastRequestUsage，从当前 agent/session 取模型名和 contextLength。
 */
function getRuntimeAwareAgentRecord() {
  if (typeof getCurrentRuntimeRecord === 'function') {
    const runtimeRecord = getCurrentRuntimeRecord();
    if (runtimeRecord) {
      return runtimeRecord;
    }
  }
  return getCurrentAgentRecord();
}

function getRuntimeAwareAgentName() {
  const agent = getRuntimeAwareAgentRecord();
  if (!agent) return t('active_none');
  return agent.active_workspace_display_name
    || agent.active_workspace_agent_name
    || agent.active_workspace_session_title
    || agent.name
    || t('active_none');
}

function updateChatContextBar() {
  var bar = document.getElementById('chat-context-bar');
  if (!bar) return;

  // 跟 chat-process-toggle 同一逻辑：非聊天界面时隐藏
  if (shouldRenderWorkspaceSurface()) {
    bar.classList.add('hidden');
    return;
  }
  bar.classList.remove('hidden');

  var agent = getRuntimeAwareAgentRecord();
  if (!agent) { bar.innerHTML = ''; return; }

  // 找到当前活跃会话
  var sessions = agent.workspace_sessions && agent.workspace_sessions.sessions || [];
  var activeId = (agent.workspace_sessions && agent.workspace_sessions.activeSessionId)
    || agent.active_workspace_session_id;
  var activeSession = activeId
    ? sessions.find(function(s) { return s.id === activeId; })
    : (sessions[0] || null);

  // 模型名
  var modelName = activeSession ? activeSession.modelName : '';

  // token 用量：runtime 存活时优先从 currentOverviewSnapshot 取实时数据
  var used = 0;
  var isLastRequest = false;
  var liveUsage = currentOverviewSnapshot && currentOverviewSnapshot.usageStats && currentOverviewSnapshot.usageStats.lastRequestUsage;
  if (liveUsage && liveUsage.totalTokens) {
    used = liveUsage.totalTokens;
    isLastRequest = true;
  } else if (activeSession && activeSession.tokenUsage) {
    var lr = activeSession.tokenUsage.lastRequestUsage;
    if (lr && lr.totalTokens) {
      used = lr.totalTokens;
      isLastRequest = true;
    } else {
      used = activeSession.tokenUsage.totalTokens || 0;
    }
  }

  // context length
  var contextLength = getSessionContextLength(activeSession, agent);

  if (!used && !modelName) { bar.innerHTML = ''; return; }

  var html = '';
  if (modelName) {
    html += '<span class="ccb-model">' + escapeHtml(modelName) + '</span>';
  }
  if (used && contextLength > 0) {
    var pct = Math.min(100, Math.round((used / contextLength) * 100));
    var tone = pct < 50 ? 'low' : pct < 80 ? 'mid' : 'high';
    var label = isLastRequest
      ? pct + '%'
      : pct + '% (\u7d2f\u79ef)';
    html += '<span class="ccb-token tone-' + tone + '">'
      + '<span class="ccb-bar"><span class="ccb-fill" style="width:' + pct + '%"></span></span>'
      + '<span class="ccb-label">' + label + '</span>'
      + '</span>';
  }
  bar.innerHTML = html;
}

async function refreshSessionTokenCount(sessionId, agentId, btnElement) {
  if (!btnElement) return;
  btnElement.innerHTML = '⟳';
  btnElement.classList.add('loading');
  btnElement.disabled = true;
  
  try {
    const response = await fetch('/protoclaw/refresh_session_token_count', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, agentId }),
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(errorText || 'Failed to refresh token count');
    }
    
    const result = await response.json();
    
    if (result.success) {
      // 局部更新：只刷新 token 用量显示，不触发全量渲染（避免滚动位置丢失）
      var agent = typeof getCurrentAgentRecord === 'function' ? getCurrentAgentRecord() : null;
      if (agent) {
        var sessions = agent.workspace_sessions && agent.workspace_sessions.sessions || [];
        var target = sessions.find(function(s) { return s.id === sessionId; });
        if (target) {
          if (!target.tokenUsage) target.tokenUsage = {};
          target.tokenUsage.lastRequestUsage = {
            totalTokens: result.tokenCount,
          };
        }
      }
      // 更新顶部 context bar
      if (typeof updateChatContextBar === 'function') {
        updateChatContextBar();
      }
      // 更新 workspace surface 中的 session token bar（局部替换）
      var tokenBarEl = btnElement && btnElement.closest('.session-token-inline');
      if (agent && tokenBarEl) {
        var sessions2 = agent.workspace_sessions && agent.workspace_sessions.sessions || [];
        var activeId = (agent.workspace_sessions && agent.workspace_sessions.activeSessionId)
          || agent.active_workspace_session_id;
        var sess = sessionId ? sessions2.find(function(s) { return s.id === sessionId; }) : null;
        if (sess && typeof renderSessionTokenBar === 'function') {
          var newBar = renderSessionTokenBar(sess, agent);
          if (newBar) {
            var temp = document.createElement('span');
            temp.innerHTML = newBar;
            var replacement = temp.firstElementChild;
            if (replacement) tokenBarEl.replaceWith(replacement);
          }
        }
      }
    } else {
      // 显示错误信息
      window.alert(result.error || (currentLanguage === 'zh' ? '刷新失败' : 'Refresh failed'));
    }
  } catch (error) {
    console.error('Failed to refresh token count:', error);
    window.alert((currentLanguage === 'zh' ? '刷新 Token 计数失败: ' : 'Failed to refresh token count: ') + error.message);
  } finally {
    // 恢复按钮状态
    btnElement.innerHTML = originalContent;
    btnElement.classList.remove('loading');
    btnElement.disabled = false;
  }
}

window.generateSessionTitle = async function(sessionId, btnElement) {
  if (!btnElement) return;
  
  var isZh = currentLanguage === 'zh';
  var originalContent = btnElement.innerHTML;
  btnElement.innerHTML = '<span class="session-title-ai-btn-icon">✦</span><span class="session-title-ai-btn-text">' + (isZh ? '生成中...' : 'Generating...') + '</span>';
  btnElement.classList.add('loading');
  btnElement.disabled = true;
  
  // Set generating flag to prevent closing
  if (btnElement._setGenerating) {
    btnElement._setGenerating(true);
  }

  try {
    var sessionItem = btnElement.closest('[data-prebuilt-session-agent-id]');
    var agentId = sessionItem ? sessionItem.dataset.prebuiltSessionAgentId : '';
    if (!agentId) throw new Error('Agent ID not found');

    var response = await fetch('/protoclaw/generate_session_title', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId, sessionId }),
    });

    if (!response.ok) {
      var errorText = await response.text();
      throw new Error(errorText || 'Failed to generate title');
    }

    var result = await response.json();
    if (result.ok && result.title) {
      var titleRow = btnElement.closest('.workspace-history-title-row');
      if (titleRow) {
        var titleEl = titleRow.querySelector('.workspace-history-title');
        if (titleEl) titleEl.textContent = result.title;
        // Exit edit mode: restore the input to plain text div
        var input = titleRow.querySelector('.session-title-edit-input');
        if (input) {
          var titleDiv = input.closest('.workspace-history-title');
          if (titleDiv) titleDiv.textContent = result.title;
        }
      }
      var agent = typeof getCurrentAgentRecord === 'function' ? getCurrentAgentRecord() : null;
      if (agent) {
        var sessions = agent.workspace_sessions && agent.workspace_sessions.sessions || [];
        var target = sessions.find(function(s) { return s.id === sessionId; });
        if (target) target.title = result.title;
      }
    }
  } catch (error) {
    console.error('Failed to generate session title:', error);
    window.alert((isZh ? '生成标题失败: ' : 'Failed to generate title: ') + (error.message || error));
  } finally {
    btnElement.innerHTML = originalContent;
    btnElement.classList.remove('loading');
    btnElement.disabled = false;
    // Reset generating flag
    if (btnElement._setGenerating) {
      btnElement._setGenerating(false);
    }
    // Hide button after generation completes
    btnElement.classList.add('session-title-ai-btn-hidden');
  }
};

function ensurePhModelConfigHost() {
  let host = document.getElementById('ph-model-config-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'ph-model-config-host';
    document.body.appendChild(host);
  }
  return host;
}

function renderPhModelConfigOverlay(agent, presets) {
  const host = ensurePhModelConfigHost();
  if (!agent) { host.innerHTML = ''; return; }
  const isZh = currentLanguage === 'zh';
  const current = agent.modelPresets || {};
  const roles = [
    { key: 'default', label: isZh ? '主代理' : 'Main Agent', desc: isZh ? '对话和编码任务' : 'Chat & coding tasks' },
    { key: 'exploration', label: isZh ? '探索代理' : 'Explorer', desc: isZh ? '代码探索与调研' : 'Code exploration & research' },
    { key: 'sub', label: isZh ? '子代理' : 'Sub Agent', desc: isZh ? '派生执行子任务' : 'Spawned task execution' },
    { key: 'system', label: isZh ? '系统管理' : 'System', desc: isZh ? '系统自管理能力' : 'System self-management' },
  ];
  const rows = roles.map(function(role) {
    const val = current[role.key] || '';
    const opts = presets.map(function(p) {
      const sel = (p.name === val) ? ' selected' : '';
      return '<option value="' + escapeHtml(p.name) + '"' + sel + '>' + escapeHtml(p.name) + '</option>';
    }).join('');
    const currentPreset = presets.find(function(p) { return p.name === val; });
    const infoHtml = currentPreset
      ? '<span class="ph-mc-info">' + escapeHtml(currentPreset.model || '') + (currentPreset.contextLength ? ' · ' + Math.round(currentPreset.contextLength / 1000) + 'K ctx' : '') + '</span>'
      : '<span class="ph-mc-info">' + (isZh ? '跟随全局默认' : 'Follows global default') + '</span>';
    return '<div class="ph-mc-row">'
      + '<div class="ph-mc-role"><div class="ph-mc-role-name">' + escapeHtml(role.label) + '</div><div class="ph-mc-role-desc">' + escapeHtml(role.desc) + '</div></div>'
      + '<div class="ph-mc-control">'
      + '<select class="ph-mc-select" data-preset-role="' + role.key + '">'
      + '<option value=""' + (!val ? ' selected' : '') + '>' + (isZh ? '(默认)' : '(Default)') + '</option>'
      + opts
      + '</select>'
      + infoHtml
      + '</div>'
      + '</div>';
  }).join('');

  host.innerHTML = [
    '<div class="feature-detail-overlay" onclick="if(event.target===this)window.phCloseModelConfig()">',
    '<div class="feature-detail-window" style="max-width:520px;">',
    '<div class="feature-detail-head">',
    '<div>',
    '<div class="feature-detail-title">' + (isZh ? '模型配置' : 'Model Config') + '</div>',
    '<div class="feature-detail-subtitle">' + (isZh ? '为不同角色指定模型预设' : 'Assign model presets to different roles') + '</div>',
    '</div>',
    '<button class="feature-detail-close" type="button" onclick="window.phCloseModelConfig()">×</button>',
    '</div>',
    '<div class="ph-mc-body">',
    rows,
    '</div>',
    '<div class="ph-mc-footer">',
    '<button class="settings-btn settings-btn-primary" type="button" onclick="window.phSaveModelConfig()">' + (isZh ? '保存' : 'Save') + '</button>',
    '<button class="settings-btn settings-btn-secondary" type="button" onclick="window.phCloseModelConfig()">' + (isZh ? '取消' : 'Cancel') + '</button>',
    '</div>',
    '</div>',
    '</div>',
  ].join('');
}

function isAssemblySession(session) {
  return String(session?.formId || '') === 'assembly-form';
}

function isAssemblySessionRunning(agent, session) {
  if (!agent || !session || !isAssemblySession(session)) return false;
  const activeSessionId = agent?.active_workspace_session_id || agent?.workspace_sessions?.activeSessionId || null;
  return activeSessionId === session.id && !!(agent.runtime_session_id || agent.runtimeSessionId);
}

function getAssemblySessionStatus(agent, session) {
  if (isAssemblySessionRunning(agent, session)) {
    return {
      label: currentLanguage === 'zh' ? '运行中' : 'Running',
      tone: 'var(--success-color)',
    };
  }
  return {
    label: currentLanguage === 'zh' ? '已保存会话' : 'Saved Session',
    tone: 'var(--text-secondary)',
  };
}

function buildWorkspaceProjectKey(source = {}) {
  const openDirectory = String(source?.openDirectory || '').trim();
  if (openDirectory) {
    return `dir:${openDirectory.replace(/\\/g, '/').toLowerCase()}`;
  }
  const featureName = String(source?.featureName || '').trim().toLowerCase();
  const targetDir = String(source?.targetDir || '').trim().replace(/\\/g, '/').toLowerCase();
  if (featureName && targetDir) {
    return `feature:${featureName}@${targetDir}`;
  }
  if (featureName) {
    return `feature:${featureName}`;
  }
  return '';
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
      const sortedSessions = [...(project.sessions || [])].sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));
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
    .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));
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
      const sortedSessions = [...(project.sessions || [])].sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));
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
    .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));
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
  if (agent?.id !== 'programming-helper') return [];

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

  sessions.forEach((session) => {
    const project = upsertProject({
      openDirectory: session.openDirectory,
      updatedAt: session.updatedAt,
      createdAt: session.createdAt,
    });
    if (project) {
      project.sessions.push(session);
    }
  });

  return Array.from(projects.values())
    .map((project) => ({
      ...project,
      sessions: project.sessions.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))),
      conversationCount: project.sessions.length,
      latestSessionId: project.sessions[0]?.id || null,
      updatedAt: project.sessions[0]?.updatedAt || project.updatedAt || '',
    }))
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

function getProgrammingHelperProjectDisplayName(project) {
  const directoryName = getPathLeaf(project?.openDirectory);
  return directoryName || 'UntitledProject';
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

// --- Feature Config helpers (data-path only, no UI) ---

function getFeatureConfig(agent, featureKey) {
  const ws = getAgentWorkspaceState(agent);
  const configs = ws?.forms?.['feature-configs'];
  if (!configs || typeof configs !== 'object') return {};
  const entry = configs[featureKey];
  return entry && typeof entry === 'object' ? { ...entry } : {};
}

function normalizeFeatureConfigEntry(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return {};
  return Object.fromEntries(Object.entries(config).filter(([key, value]) => String(key || '').trim() && value !== undefined));
}

function findFeatureConfigMapEntry(configs, featureKey) {
  if (!configs || typeof configs !== 'object') return null;
  const target = String(featureKey || '').trim();
  if (!target) return null;
  if (configs[target] && typeof configs[target] === 'object' && !Array.isArray(configs[target])) {
    return { key: target, value: normalizeFeatureConfigEntry(configs[target]) };
  }
  const matched = Object.entries(configs).find(([key]) => featureConfigKeyMatches(key, target));
  if (!matched) return null;
  return { key: String(matched[0] || '').trim(), value: normalizeFeatureConfigEntry(matched[1]) };
}

function removeMatchingFeatureConfigAliases(configs, featureKey) {
  const target = String(featureKey || '').trim();
  Object.keys(configs || {}).forEach((key) => {
    if (key !== target && featureConfigKeyMatches(key, target)) {
      delete configs[key];
    }
  });
}

async function updateFeatureConfigField(agent, featureKey, field, value) {
  const ws = getAgentWorkspaceState(agent);
  const configs = { ...(ws?.forms?.['feature-configs'] || {}) };
  const entry = findFeatureConfigMapEntry(configs, featureKey);
  const current = normalizeFeatureConfigEntry(entry?.value || {});
  removeMatchingFeatureConfigAliases(configs, featureKey);
  if (value === undefined) {
    delete current[field];
  } else {
    current[field] = value;
  }
  if (Object.keys(current).length > 0) {
    configs[featureKey] = current;
  } else {
    delete configs[featureKey];
  }
  const nextForms = { ...(ws.forms || {}), 'feature-configs': configs };
  const payload = {
    forms: nextForms,
    openDirectory: typeof ws.openDirectory === 'string' ? ws.openDirectory : '',
  };
  if ((agent.id === 'agent-creator' || agent.id === 'flow-workspace') && nextForms['assembly-form']) {
    payload.assemblyConfigs = buildAutoSavedAssemblyConfigs(
      agent,
      nextForms['assembly-form'],
      Array.isArray(ws?.assemblyConfigs) ? ws.assemblyConfigs : getSavedAssemblyConfigs(agent),
      configs,
    );
  }
  const response = await fetch('/protoclaw/workspace_state', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId: agent.id, state: payload }),
  });
  if (!response.ok) {
    throw new Error(await response.text().catch(() => 'Failed to save feature config'));
  }
  const nextState = await response.json();
  updateAgentWorkspaceState(agent.id, nextState);
  saveWorkspaceFormDraft(agent.id, nextState.forms || {});
  return nextState;
}

async function writeFeatureConfig(agent, featureKey, config) {
  const ws = getAgentWorkspaceState(agent);
  const configs = { ...(ws?.forms?.['feature-configs'] || {}) };
  removeMatchingFeatureConfigAliases(configs, featureKey);
  const normalized = normalizeFeatureConfigEntry(config);
  if (Object.keys(normalized).length > 0) {
    configs[featureKey] = normalized;
  } else {
    delete configs[featureKey];
  }
  const nextForms = { ...(ws.forms || {}), 'feature-configs': configs };
  const payload = {
    forms: nextForms,
    openDirectory: typeof ws.openDirectory === 'string' ? ws.openDirectory : '',
  };
  if ((agent.id === 'agent-creator' || agent.id === 'flow-workspace') && nextForms['assembly-form']) {
    payload.assemblyConfigs = buildAutoSavedAssemblyConfigs(
      agent,
      nextForms['assembly-form'],
      Array.isArray(ws?.assemblyConfigs) ? ws.assemblyConfigs : getSavedAssemblyConfigs(agent),
      configs,
    );
  }
  const response = await fetch('/protoclaw/workspace_state', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId: agent.id, state: payload }),
  });
  if (!response.ok) {
    throw new Error(await response.text().catch(() => 'Failed to save feature config'));
  }
  const nextState = await response.json();
  updateAgentWorkspaceState(agent.id, nextState);
  saveWorkspaceFormDraft(agent.id, nextState.forms || {});
  return nextState;
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

function sanitizeWorkspacePathFragment(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'untitled-feature';
}

function isValidFeatureCreatorName(value) {
  return /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(String(value || '').trim());
}

function isValidAgentCreatorName(value) {
  return /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(String(value || '').trim());
}

function normalizeAssemblyDirectoryToken(value) {
  return String(value || '').trim().replace(/[\\\/]+/g, '/').toLowerCase();
}

function findAssemblyConfigConflict(agent, rawForm = {}) {
  const form = normalizeAssemblyDraft(rawForm);
  const name = String(form.assembly_name || '').trim();
  const editingId = String(form.editing_config_id || '').trim();
  const envDir = String(form.env_dir || '').trim();
  const configs = getSavedAssemblyConfigs(agent);
  const conflictingName = name
    ? configs.find((item) => item.id === name && item.id !== editingId) || null
    : null;
  const normalizedEnvDir = normalizeAssemblyDirectoryToken(envDir);
  const conflictingDirectory = normalizedEnvDir
    ? configs.find((item) => (
      item.id !== editingId
      && item.id !== name
      && normalizeAssemblyDirectoryToken(item.envDir) === normalizedEnvDir
    )) || null
    : null;
  return {
    conflictingName,
    conflictingDirectory,
  };
}

function getFeatureCreatorOutputDirectory(agent, startupDraft = {}) {
  if (agent?.id !== 'feature-creator') return '';
  const featureName = String(startupDraft.feature_name || '').trim();
  const parentDir = String(startupDraft.target_dir || '').trim();
  if (!featureName || !parentDir) return '';
  return parentDir.replace(/[\\\/]+$/, '') + '\\' + featureName;
}

function getAgentCreatorOutputDirectory(agent, startupDraft = {}) {
  if (agent?.id !== 'agent-creator') return '';
  const agentName = String(startupDraft.agent_name || '').trim();
  const parentDir = String(startupDraft.target_dir || '').trim();
  if (!agentName || !parentDir) return '';
  return parentDir.replace(/[\\\/]+$/, '') + '\\' + agentName;
}

function normalizeFeatureCreatorStartupDraft(agent, rawDraft = {}) {
  if (agent?.id !== 'feature-creator' && agent?.id !== 'agent-creator') {
    return { ...(rawDraft || {}) };
  }

  const blockData = getWorkspaceBlockData(agent, 'startup-form') || {};
  const nextDraft = { ...(rawDraft || {}) };
  const installMode = nextDraft.install_mode === 'custom' ? 'custom' : 'system';
  nextDraft.install_mode = installMode;

  if (installMode === 'system') {
    const root = blockData.systemInstallRoot || '';
    nextDraft.target_dir = root || '';
  } else {
    nextDraft.target_dir = typeof nextDraft.target_dir === 'string' ? nextDraft.target_dir : '';
  }

  return nextDraft;
}

function normalizeProgrammingHelperStartupDraft(agent, rawDraft = {}) {
  return {};
}

function normalizeWorkspaceStartupDraft(agent, rawDraft = {}) {
  if (agent?.id === 'feature-creator' || agent?.id === 'agent-creator') {
    return normalizeFeatureCreatorStartupDraft(agent, rawDraft);
  }
  return { ...(rawDraft || {}) };
}

function getExpectedAssemblyEnvDir(assemblyName) {
  const name = String(assemblyName || '').trim();
  return name ? `~/.agentdev/agent-dev/${name}` : '';
}

function normalizeAssemblyDraft(rawDraft = {}) {
  const nextDraft = { ...(rawDraft || {}) };
  nextDraft.assembly_name = typeof nextDraft.assembly_name === 'string' ? nextDraft.assembly_name : '';
  nextDraft.display_name = typeof nextDraft.display_name === 'string' ? nextDraft.display_name : '';
  nextDraft.env_dir = typeof nextDraft.env_dir === 'string' ? nextDraft.env_dir : '';
  nextDraft.env_created = String(nextDraft.env_created || '') === '1' ? '1' : '0';
  nextDraft.env_configured_name = typeof nextDraft.env_configured_name === 'string' ? nextDraft.env_configured_name : '';
  nextDraft.env_status = typeof nextDraft.env_status === 'string' ? nextDraft.env_status : '';
  nextDraft.env_status_message = typeof nextDraft.env_status_message === 'string' ? nextDraft.env_status_message : '';
  nextDraft.env_configured_features = typeof nextDraft.env_configured_features === 'string' ? nextDraft.env_configured_features : '';
  nextDraft.editing_config_id = typeof nextDraft.editing_config_id === 'string' ? nextDraft.editing_config_id : '';
  nextDraft.model_preset = typeof nextDraft.model_preset === 'string' ? nextDraft.model_preset : '';
  nextDraft.workdir = typeof nextDraft.workdir === 'string' ? nextDraft.workdir : '';
  return nextDraft;
}

function getAssemblyDisplayName(rawDraft) {
  const draft = normalizeAssemblyDraft(rawDraft);
  const dn = String(draft.display_name || '').trim();
  return dn || String(draft.assembly_name || '').trim();
}

function getAssemblyEnvironmentState(rawDraft = {}) {
  const draft = normalizeAssemblyDraft(rawDraft);
  const assemblyName = String(draft.assembly_name || '').trim();
  const configuredName = String(draft.env_configured_name || '').trim();
  const configuredDir = String(draft.env_dir || '').trim();
  const selectedFeatures = parseWorkspaceListField(draft.selected_features);
  const configuredFeatures = parseWorkspaceListField(draft.env_configured_features);
  const expectedDir = getExpectedAssemblyEnvDir(assemblyName);
  const transientStates = new Set(['creating', 'installing', 'starting', 'running', 'error']);
  let status = String(draft.env_status || '').trim();
  const stale = !!(assemblyName && configuredName && configuredName !== assemblyName);
  const hasConfiguredTrace = !!(configuredDir || configuredName || draft.env_created === '1');
  const featureSnapshotKnown = configuredFeatures.length > 0 || selectedFeatures.length === 0;
  const normalizedConfiguredDir = normalizeAssemblyDirectoryToken(configuredDir);
  const directoryMatchesExpected = !!(!normalizedConfiguredDir || !assemblyName
    || normalizedConfiguredDir.endsWith(`/agent-dev/${String(assemblyName || '').toLowerCase()}`));
  const featureStale = hasConfiguredTrace && (
    !featureSnapshotKnown
    || selectedFeatures.length !== configuredFeatures.length
    || selectedFeatures.some((item) => !configuredFeatures.includes(item))
  );
  const directoryStale = hasConfiguredTrace && !!(configuredDir && assemblyName && !directoryMatchesExpected);

  if (!assemblyName) {
    status = 'missing-name';
  } else if (stale || featureStale || directoryStale) {
    status = 'stale';
  } else if (!transientStates.has(status)) {
    if (configuredDir || draft.env_created === '1') {
      status = 'ready';
    } else if (hasConfiguredTrace) {
      status = 'stale';
    } else {
      status = 'missing';
    }
  }

  return {
    status,
    stale,
    assemblyName,
    configuredName,
    configuredDir,
    directoryStale,
    selectedFeatures,
    configuredFeatures,
    expectedDir,
    directory: configuredDir || expectedDir,
    message: String(draft.env_status_message || '').trim(),
    isReady: status === 'ready' || status === 'running',
    needsConfiguration: status === 'missing' || status === 'missing-name' || status === 'stale',
  };
}

function getAssemblyEnvironmentStatusLabel(status) {
  const labels = {
    'missing-name': currentLanguage === 'zh' ? '待填写名称' : 'Name Required',
    missing: currentLanguage === 'zh' ? '未配置' : 'Not Configured',
    stale: currentLanguage === 'zh' ? '需重新配置' : 'Needs Reconfigure',
    creating: currentLanguage === 'zh' ? '创建目录中' : 'Creating Directory',
    installing: currentLanguage === 'zh' ? '正在安装依赖' : 'Installing Dependencies',
    starting: currentLanguage === 'zh' ? '启动运行时中' : 'Starting Runtime',
    running: currentLanguage === 'zh' ? '已启动' : 'Running',
    ready: currentLanguage === 'zh' ? '已配置' : 'Ready',
    error: currentLanguage === 'zh' ? '配置失败' : 'Failed',
  };
  return labels[status] || (currentLanguage === 'zh' ? '未配置' : 'Not Configured');
}

function getAssemblyEnvironmentStatusTone(status) {
  if (status === 'ready' || status === 'running') return 'var(--success-color)';
  if (status === 'creating' || status === 'installing' || status === 'starting') return 'var(--warning-color)';
  if (status === 'error' || status === 'stale') return 'var(--error-color)';
  return 'var(--text-secondary)';
}

function renderAssemblyStatusChip(label, tone) {
  return '<span class="assembly-status-chip" style="color:' + escapeHtml(tone || 'var(--text-secondary)') + ';">' + escapeHtml(label || '') + '</span>';
}

function getAssemblySavedConfigSummary(agent, config) {
  const configId = String(config?.id || '').trim();
  const sessions = getWorkspaceSessions(agent).filter((session) => (
    isAssemblySession(session) && String(session?.agentName || '').trim() === configId
  ));
  const runningCount = sessions.filter((session) => isAssemblySessionRunning(agent, session)).length;
  return {
    sessionCount: sessions.length,
    runningCount,
    latestSession: sessions[0] || null,
  };
}

function getAssemblyEditorMode(draft, savedSetupExists = false) {
  const normalized = normalizeAssemblyDraft(draft);
  const assemblyName = String(normalized.assembly_name || '').trim();
  if (savedSetupExists && assemblyName) {
    return 'editing-saved';
  }
  return assemblyName ? 'creating' : 'blank';
}

function buildFeatureConfigLookupKeys(value) {
  const raw = String(value || '').trim();
  const normalized = raw.toLowerCase().replace(/^@agentdev\//, '').replace(/-feature$/, '');
  const keys = new Set();
  if (raw) keys.add(raw.toLowerCase());
  if (normalized) {
    keys.add(normalized);
    keys.add(`@agentdev/${normalized}`);
    keys.add(`@agentdev/${normalized}-feature`);
  }
  return keys;
}

function featureConfigKeyMatches(featureRef, configKey) {
  const left = buildFeatureConfigLookupKeys(featureRef);
  const right = buildFeatureConfigLookupKeys(configKey);
  for (const key of left) {
    if (right.has(key)) return true;
  }
  return false;
}

function normalizeFeatureConfigMap(configs) {
  if (!configs || typeof configs !== 'object') return {};
  const result = {};
  Object.entries(configs).forEach(([key, value]) => {
    const normalizedKey = String(key || '').trim();
    const normalizedValue = normalizeFeatureConfigEntry(value);
    if (!normalizedKey || !Object.keys(normalizedValue).length) return;
    result[normalizedKey] = normalizedValue;
  });
  return result;
}

function collectAssemblyProjectFeatureConfigs(agent, rawForm = {}, featureConfigsSource = null) {
  const form = normalizeAssemblyDraft(rawForm);
  const source = normalizeFeatureConfigMap(featureConfigsSource);
  const selectedFeatures = canonicalizeAssemblyFeatureSelection(agent, parseWorkspaceListField(form.selected_features));
  const snapshot = {};
  selectedFeatures.forEach((token) => {
    const matchedEntry = Object.entries(source).find(([key]) => featureConfigKeyMatches(token, key));
    if (matchedEntry) {
      snapshot[matchedEntry[0]] = normalizeFeatureConfigEntry(matchedEntry[1]);
    }
  });
  return snapshot;
}

function buildAutoSavedAssemblyConfigs(agent, rawForm = {}, currentConfigs = getSavedAssemblyConfigs(agent), featureConfigsSource = null) {
  const form = normalizeAssemblyDraft(rawForm);
  const name = String(form.assembly_name || '').trim();
  const editingId = String(form.editing_config_id || '').trim();
  if (!name || !isValidAgentCreatorName(name)) {
    return currentConfigs;
  }

  const conflicts = findAssemblyConfigConflict(agent, form);
  if (conflicts.conflictingName || conflicts.conflictingDirectory) {
    return currentConfigs;
  }

  const normalizedFeatures = canonicalizeAssemblyFeatureSelection(agent, parseWorkspaceListField(form.selected_features));
  const normalizedToolkits = parseWorkspaceListField(form.recommended_toolkits);
  const normalizedConfiguredFeatures = canonicalizeAssemblyFeatureSelection(agent, parseWorkspaceListField(form.env_configured_features));
  const hasEnvTrace = !!(String(form.env_dir || '').trim() || form.env_created === '1' || String(form.env_configured_name || '').trim());
  const existing = currentConfigs.filter((item) => item.id !== name && item.id !== editingId);
  const featureConfigs = collectAssemblyProjectFeatureConfigs(
    agent,
    form,
    featureConfigsSource || getAgentWorkspaceState(agent)?.forms?.['feature-configs'] || {},
  );

  return [
    {
      id: name,
      name: getAssemblyDisplayName(form),
      displayName: String(form.display_name || '').trim(),
      preset: String(form.preset || '').trim(),
      goal: String(form.goal || '').trim(),
      targetUser: String(form.target_user || '').trim(),
      features: normalizedFeatures,
      toolkits: normalizedToolkits,
      constraints: String(form.constraints || '').trim(),
      customSystemPrompt: String(form.custom_system_prompt || '').trim(),
      envDir: String(form.env_dir || '').trim(),
      envConfiguredName: hasEnvTrace ? (String(form.env_configured_name || '').trim() || name) : '',
      envConfiguredFeatures: normalizedConfiguredFeatures,
      envStatus: String(form.env_status || '').trim(),
      envStatusMessage: String(form.env_status_message || '').trim(),
      modelPreset: String(form.model_preset || '').trim(),
      workdir: String(form.workdir || '').trim(),
      featureConfigs,
      updatedAt: new Date().toISOString(),
    },
    ...existing,
  ];
}

function getWorkspaceFormDraft(agent) {
  if (!agent?.id) return {};
  const serverForms = getAgentWorkspaceState(agent).forms || {};
  try {
    const raw = localStorage.getItem(getWorkspaceFormStorageKey(agent.id));
    const localForms = raw ? JSON.parse(raw) : {};
    const forms = { ...serverForms, ...localForms };
    if (forms['startup-form']) {
      forms['startup-form'] = normalizeWorkspaceStartupDraft(agent, forms['startup-form']);
    }
    if ((agent.id === 'agent-creator' || agent.id === 'flow-workspace') && forms['assembly-form']) {
      forms['assembly-form'] = normalizeAssemblyDraft(forms['assembly-form']);
    }
    return forms;
  } catch {
    const forms = { ...serverForms };
    if (forms['startup-form']) {
      forms['startup-form'] = normalizeWorkspaceStartupDraft(agent, forms['startup-form']);
    }
    if ((agent.id === 'agent-creator' || agent.id === 'flow-workspace') && forms['assembly-form']) {
      forms['assembly-form'] = normalizeAssemblyDraft(forms['assembly-form']);
    }
    return forms;
  }
}

function saveWorkspaceFormDraft(agentId, values) {
  localStorage.setItem(getWorkspaceFormStorageKey(agentId), JSON.stringify(values || {}));
}

function resetWorkspaceFormDraft(agentId) {
  localStorage.removeItem(getWorkspaceFormStorageKey(agentId));
}

async function persistWorkspaceState(agent, draft, options = {}) {
  if (!agent?.id) return null;
  const normalizedDraft = { ...(draft || {}) };
  if (normalizedDraft['startup-form']) {
    normalizedDraft['startup-form'] = normalizeWorkspaceStartupDraft(agent, normalizedDraft['startup-form']);
  }
  if ((agent.id === 'agent-creator' || agent.id === 'flow-workspace') && normalizedDraft['assembly-form']) {
    normalizedDraft['assembly-form'] = normalizeAssemblyDraft(normalizedDraft['assembly-form']);
  }
  const currentState = getAgentWorkspaceState(agent);
  const openDirectory = typeof options.openDirectory === 'string'
    ? options.openDirectory
    : (typeof currentState.openDirectory === 'string' ? currentState.openDirectory : '');
  const payload = {
    forms: normalizedDraft,
    openDirectory,
  };
  if (Array.isArray(options.assemblyConfigs)) {
    payload.assemblyConfigs = options.assemblyConfigs;
  } else if ((agent.id === 'agent-creator' || agent.id === 'flow-workspace') && normalizedDraft['assembly-form']) {
    payload.assemblyConfigs = buildAutoSavedAssemblyConfigs(
      agent,
      normalizedDraft['assembly-form'],
      Array.isArray(currentState?.assemblyConfigs) ? currentState.assemblyConfigs : getSavedAssemblyConfigs(agent),
    );
  }
  const response = await fetch('/protoclaw/workspace_state', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId: agent.id, state: payload }),
  });
  if (!response.ok) {
    throw new Error(await response.text().catch(() => 'Failed to save workspace state'));
  }
  const nextState = await response.json();
  updateAgentWorkspaceState(agent.id, nextState);
  saveWorkspaceFormDraft(agent.id, nextState.forms || {});
  return nextState;
}

function normalizeQQBotConfigData(raw = {}) {
  return {
    appId: typeof raw.appId === 'string' ? raw.appId : '',
    clientSecret: typeof raw.clientSecret === 'string' ? raw.clientSecret : '',
    accountId: typeof raw.accountId === 'string' ? raw.accountId : '',
    markdownSupport: typeof raw.markdownSupport === 'boolean' ? raw.markdownSupport : true,
  };
}

function isQQBotConfigEditor(block) {
  return block?.configEditor?.type === 'qqbot';
}

function getQQBotConfigDraft() {
  return qqbotConfigState.draft || qqbotConfigState.data || normalizeQQBotConfigData();
}

async function ensureQQBotConfigLoaded(force = false) {
  if (qqbotConfigRequest && !force) {
    return qqbotConfigRequest;
  }

  if (!force && qqbotConfigState.data && !qqbotConfigState.error) {
    return qqbotConfigState.data;
  }

  qqbotConfigState.loading = true;
  qqbotConfigState.error = '';
  if (force) {
    qqbotConfigState.data = null;
    qqbotConfigState.draft = null;
  }
  renderCurrentMainView();

  qqbotConfigRequest = fetch('/protoclaw/qqbot_config')
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(await response.text().catch(() => 'Failed to load qqbot config'));
      }
      return response.json();
    })
    .then((payload) => {
      const config = normalizeQQBotConfigData(payload?.config || {});
      qqbotConfigState.data = config;
      qqbotConfigState.draft = { ...config };
      qqbotConfigState.sourcePath = payload?.sourcePath || '';
      qqbotConfigState.error = '';
      return config;
    })
    .catch((error) => {
      qqbotConfigState.error = error && error.message ? error.message : String(error);
      throw error;
    })
    .finally(() => {
      qqbotConfigState.loading = false;
      qqbotConfigRequest = null;
      renderCurrentMainView();
    });

  return qqbotConfigRequest;
}

function normalizeIMWorkspaceBundleData(raw = {}) {
  const workspaceConfig = raw?.workspaceConfig || {};
  const channels = workspaceConfig?.channels && typeof workspaceConfig.channels === 'object'
    ? workspaceConfig.channels
    : {};
  return {
    workspaceConfig: {
      selectedChannel: typeof workspaceConfig.selectedChannel === 'string' && workspaceConfig.selectedChannel
        ? workspaceConfig.selectedChannel
        : 'qq',
      receptionistSessionId: typeof workspaceConfig.receptionistSessionId === 'string'
        ? workspaceConfig.receptionistSessionId
        : '',
      channels: {
        qq: {
          label: typeof channels?.qq?.label === 'string' ? channels.qq.label : '',
          role: typeof channels?.qq?.role === 'string' ? channels.qq.role : '',
          note: typeof channels?.qq?.note === 'string' ? channels.qq.note : '',
        },
        weixin: {
          label: typeof channels?.weixin?.label === 'string' ? channels.weixin.label : '',
          role: typeof channels?.weixin?.role === 'string' ? channels.weixin.role : '',
          note: typeof channels?.weixin?.note === 'string' ? channels.weixin.note : '',
        },
      },
    },
    qqConfig: normalizeQQBotConfigData(raw?.qqConfig || {}),
    weixinConfig: {
      configured: !!raw?.weixinConfig?.configured,
      baseUrl: typeof raw?.weixinConfig?.baseUrl === 'string' ? raw.weixinConfig.baseUrl : '',
      loginTime: raw?.weixinConfig?.loginTime || null,
      sourcePath: typeof raw?.weixinConfig?.sourcePath === 'string' ? raw.weixinConfig.sourcePath : '',
    },
    binding: {
      pending: !!raw?.binding?.pending,
      status: typeof raw?.binding?.status === 'string' ? raw.binding.status : 'idle',
      qrcodeId: typeof raw?.binding?.qrcodeId === 'string' ? raw.binding.qrcodeId : '',
      qrcodeUrl: typeof raw?.binding?.qrcodeUrl === 'string' ? raw.binding.qrcodeUrl : '',
      qrcodeDataUrl: typeof raw?.binding?.qrcodeDataUrl === 'string' ? raw.binding.qrcodeDataUrl : '',
      error: typeof raw?.binding?.error === 'string' ? raw.binding.error : '',
      issuedAt: raw?.binding?.issuedAt || null,
      confirmedAt: raw?.binding?.confirmedAt || null,
      sourcePath: typeof raw?.binding?.sourcePath === 'string' ? raw.binding.sourcePath : '',
    },
    sessions: Array.isArray(raw?.sessions) ? raw.sessions.map((session) => ({
      id: typeof session?.id === 'string' ? session.id : '',
      title: typeof session?.title === 'string' ? session.title : (typeof session?.id === 'string' ? session.id : ''),
      updatedAt: session?.updatedAt || null,
    })).filter((session) => session.id) : [],
    receptionistSession: raw?.receptionistSession && typeof raw.receptionistSession === 'object'
      ? {
          id: typeof raw.receptionistSession.id === 'string' ? raw.receptionistSession.id : '',
          title: typeof raw.receptionistSession.title === 'string' ? raw.receptionistSession.title : '',
          updatedAt: raw.receptionistSession.updatedAt || null,
        }
      : null,
    qqSourcePath: typeof raw?.qqSourcePath === 'string' ? raw.qqSourcePath : '',
    workspaceSourcePath: typeof raw?.workspaceSourcePath === 'string' ? raw.workspaceSourcePath : '',
    savedAt: raw?.savedAt || null,
  };
}

function isIMWorkspaceConfigEditor(block) {
  return block?.configEditor?.type === 'im-workspace';
}

function getIMWorkspaceDraft() {
  return imWorkspaceState.draft || imWorkspaceState.data || normalizeIMWorkspaceBundleData();
}

async function ensureIMWorkspaceLoaded(force = false) {
  if (imWorkspaceRequest && !force) {
    return imWorkspaceRequest;
  }

  if (!force && imWorkspaceState.data && !imWorkspaceState.error) {
    return imWorkspaceState.data;
  }

  imWorkspaceState.loading = true;
  imWorkspaceState.error = '';
  if (force) {
    imWorkspaceState.data = null;
    imWorkspaceState.draft = null;
  }
  renderCurrentMainView();

  imWorkspaceRequest = fetch('/protoclaw/im_workspace_bundle')
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(await response.text().catch(() => 'Failed to load IM workspace config'));
      }
      return response.json();
    })
    .then((payload) => {
      const bundle = normalizeIMWorkspaceBundleData(payload || {});
      imWorkspaceState.data = bundle;
      imWorkspaceState.draft = JSON.parse(JSON.stringify(bundle));
      imWorkspaceState.savedAt = bundle.savedAt || null;
      imWorkspaceState.error = '';
      return bundle;
    })
    .catch((error) => {
      imWorkspaceState.error = error && error.message ? error.message : String(error);
      throw error;
    })
    .finally(() => {
      imWorkspaceState.loading = false;
      imWorkspaceRequest = null;
      renderCurrentMainView();
    });

  return imWorkspaceRequest;
}

function shouldRenderWorkspaceSurface(agent = getCurrentAgentRecord()) {
  const ui = getCurrentUnitUi(agent);
  if (!ui) {
    return false;
  }

  if (isWorkspaceHostUnit(agent)) {
    return !(readOnlyMode || currentRuntimeAgentId);
  }

  const mode = ensureUnitMode(agent);
  return mode && mode !== 'chat';
}

function isChatSurfaceActive(agent = getCurrentAgentRecord()) {
  const ui = getCurrentUnitUi(agent);
  if (!ui) return true;
  if (isWorkspaceHostUnit(agent)) {
    return !!(readOnlyMode || currentRuntimeAgentId);
  }
  return ensureUnitMode(agent) === 'chat';
}

function shouldRenderBlock(block) {
  const visibility = block?.visibility || 'always';
  if (visibility === 'home-default') {
    return currentWorkspaceTab === 'home' || !currentWorkspaceTab;
  }
  if (typeof visibility === 'string' && visibility.startsWith('tab:')) {
    return currentWorkspaceTab === visibility.slice(4);
  }
  if (visibility === 'chat-header-only') {
    return false;
  }
  if (visibility !== 'focus') return true;
  return currentWorkspaceTab === `block:${block.id}`;
}

function renderActionButton(action, options = {}) {
  const label = localizeWorkspaceValue(action?.label, '');
  const encoded = escapeHtml(JSON.stringify(action?.action || {}));
  return '<button class="workspace-action" type="button" data-workspace-action="' + encoded + '" onclick="window.runWorkspaceAction(this.dataset.workspaceAction, this)"' + (options.disabled ? ' disabled' : '') + '>' + escapeHtml(label) + '</button>';
}

function renderWorkspaceHero(agent, block) {
  const title = localizeWorkspaceValue(block.title, agent.name || agent.id);
  const body = localizeWorkspaceValue(block.body, agent.description || '');
  const heroClass = agent?.id === 'home' ? 'workspace-hero home-shell' : 'workspace-hero';
  return [
    '<section class="' + heroClass + '">',
    '<div class="workspace-kicker">' + escapeHtml(localizeWorkspaceValue(block.kicker, t('workspace_kicker'))) + '</div>',
    '<div class="workspace-title">' + escapeHtml(title) + '</div>',
    '<div class="workspace-body">' + escapeHtml(body) + '</div>',
    '</section>',
  ].join('');
}

function renderWorkspaceActionGroup(block) {
  const actions = Array.isArray(block?.actions) ? block.actions : [];
  if (actions.length === 0) return '';
  return [
    '<div class="workspace-actions">',
    actions.map((action) => renderActionButton(action)).join(''),
    '</div>',
  ].join('');
}

function renderWorkspaceLauncherGrid(agent, block) {
  const cards = Array.isArray(block?.cards) ? block.cards : [];
  const directorySummary = getDirectorySummaryData(agent, block);
  const sessionCount = getWorkspaceSessions(agent).length;
  const featureProjectCount = agent?.id === 'feature-creator' ? getFeatureCreatorProjects(agent).length : 0;
  const agentProjectCount = agent?.id === 'agent-creator' ? getAgentCreatorProjects(agent).length : 0;
  if (cards.length === 0) return '';
  const gridClass = agent?.id === 'home' ? 'workspace-launch-grid home-grid' : 'workspace-launch-grid';

  return [
    '<section class="' + gridClass + '">',
    cards.map((card, index) => {
      const title = localizeWorkspaceValue(card.title, '');
      const body = localizeWorkspaceValue(card.body, '');
      const note = localizeWorkspaceValue(card.note, '');
      const actionLabel = localizeWorkspaceValue(card.actionLabel, '');
      const action = escapeHtml(JSON.stringify(card.action || {}));
      const actionType = card?.action?.type || '';
      const disabled = (
        (actionType === 'open_latest_session' && (agent?.id === 'feature-creator'
          ? featureProjectCount === 0
          : (agent?.id === 'agent-creator' ? agentProjectCount === 0 : sessionCount === 0)))
        || (actionType === 'show_chat' && sessionCount === 0)
      );
      const shouldRenderNote = note.trim() !== '';
      const extraClass = agent?.id === 'home'
        ? (' home-card' + (index === 0 ? ' home-card-primary' : ''))
        : '';

      return [
        '<div class="workspace-launch-card' + (index === 0 ? ' primary' : '') + extraClass + (disabled ? ' disabled' : '') + '">',
        '<div class="workspace-launch-title">' + escapeHtml(title) + '</div>',
        '<div class="workspace-launch-body">' + escapeHtml(body) + '</div>',
        shouldRenderNote
          ? '<div class="workspace-launch-note">' + escapeHtml(note) + '</div>'
          : '',
        '<button class="workspace-action" type="button" data-workspace-action="' + action + '" onclick="window.runWorkspaceAction(this.dataset.workspaceAction, this)"' + (disabled ? ' disabled' : '') + '>' + escapeHtml(actionLabel) + '</button>',
        '</div>',
      ].join('');
    }).join(''),
    '</section>',
  ].join('');
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

  if (isFeatureCreator) {
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

  if (isAgentCreator && sessionListMode !== 'assembly') {
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

  if (agent?.id === 'programming-helper') {
    const projects = getProgrammingHelperProjects(agent);
    const emptyHtml = [
      '<div class="workspace-history-list">',
      '<div class="workspace-history-item"><div>' + escapeHtml(currentLanguage === 'zh' ? '暂无项目，点击下方按钮选择工作目录并开始新的对话' : 'No projects yet. Select a working directory to start.') + '</div></div>',
      '<div class="workspace-actions">',
      '<button class="workspace-action" type="button" onclick="window.phSelectDirectoryAndCreateSession()">' + escapeHtml(t('workspace_select_directory_new_project')) + '</button>',
      '</div>',
      '</div>',
    ].join('');

    const bodyHtml = projects.length > 0
      ? '<div class="feature-project-list">' + projects.map((project) => {
          const newChatAction = escapeHtml(JSON.stringify({
            type: 'create_session',
            openDirectory: project.openDirectory || '',
          }));
          const mainSessions = project.sessions.filter(s => s.sessionType !== 'exploration' && s.sessionType !== 'sub');
          const explorationSessions = project.sessions.filter(s => s.sessionType === 'exploration');
          const subSessions = project.sessions.filter(s => s.sessionType === 'sub');
          const needsTabs = explorationSessions.length > 0 || subSessions.length > 0;

          const renderPhSessionItem = (session, type) => {
            const sType = type || session.sessionType || 'main';
            const deleteAction = escapeHtml(JSON.stringify({ type: 'delete_session', sessionId: session.id, openDirectory: project.openDirectory }));

            let titleExtra = '';

            let buttonsHtml = '';
            if (sType === 'main') {
              const openAction = escapeHtml(JSON.stringify({ type: 'open_session', sessionId: session.id }));
              const compactAction = escapeHtml(JSON.stringify({ type: 'compact_session_menu', sessionId: session.id }));
              buttonsHtml = [
                '<button class="workspace-action" type="button" data-workspace-action="' + openAction + '" onclick="window.runWorkspaceAction(this.dataset.workspaceAction, this)">' + escapeHtml(t('workspace_open_chat')) + '</button>',
                '<button class="workspace-action secondary compact-trigger" type="button" data-workspace-action="' + compactAction + '" onclick="window.showCompactMenu(event, this)">' + escapeHtml(t('workspace_compact_session')) + '</button>',
                '<button class="workspace-action secondary delete-trigger" type="button" data-workspace-action="' + deleteAction + '" onclick="window.runWorkspaceAction(this.dataset.workspaceAction, this)">' + escapeHtml(t('workspace_session_delete')) + '</button>',
              ].join('');
            } else if (sType === 'exploration') {
              const viewAction = escapeHtml(JSON.stringify({ type: 'view_session_record', sessionId: session.id, agentId: agent.id, sessionType: 'exploration' }));
              const summaryAction = escapeHtml(JSON.stringify({ type: 'open_summary', sessionId: session.id, agentId: agent.id }));
              const summaryBtnClass = session.hasSummary ? 'workspace-action summary-exists' : 'workspace-action secondary';
              buttonsHtml = [
                '<button class="workspace-action" type="button" data-workspace-action="' + viewAction + '" onclick="window.runWorkspaceAction(this.dataset.workspaceAction, this)">' + escapeHtml(t('workspace_view_record')) + '</button>',
                '<button class="' + summaryBtnClass + '" type="button" data-workspace-action="' + summaryAction + '" onclick="window.runWorkspaceAction(this.dataset.workspaceAction, this)">' + escapeHtml(session.hasSummary ? t('workspace_view_summary') : t('workspace_generate_summary')) + '</button>',
                '<button class="workspace-action secondary delete-trigger" type="button" data-workspace-action="' + deleteAction + '" onclick="window.runWorkspaceAction(this.dataset.workspaceAction, this)">' + escapeHtml(t('workspace_session_delete')) + '</button>',
              ].join('');
            } else if (sType === 'sub') {
              const viewAction = escapeHtml(JSON.stringify({ type: 'view_session_record', sessionId: session.id, agentId: agent.id, sessionType: 'sub' }));
              buttonsHtml = [
                '<button class="workspace-action" type="button" data-workspace-action="' + viewAction + '" onclick="window.runWorkspaceAction(this.dataset.workspaceAction, this)">' + escapeHtml(t('workspace_view_record')) + '</button>',
                '<button class="workspace-action secondary delete-trigger" type="button" data-workspace-action="' + deleteAction + '" onclick="window.runWorkspaceAction(this.dataset.workspaceAction, this)">' + escapeHtml(t('workspace_session_delete')) + '</button>',
              ].join('');
            }

            return [
              '<div class="feature-project-session-item workspace-history-item" data-prebuilt-session-agent-id="' + escapeHtml(agent.id) + '" data-prebuilt-session-id="' + escapeHtml(session.id) + '" data-session-type="' + escapeHtml(sType) + '">',
              '<div class="workspace-history-main">',
              '<div class="workspace-history-title-row">',
              '<div class="workspace-history-title" ondblclick="window.handleSessionTitleDoubleClick(event)" title="' + escapeHtml(currentLanguage === 'zh' ? '双击编辑标题' : 'Double-click to edit title') + '">' + escapeHtml(session.title || session.id) + '</div>',
              renderSessionResumeBadge(session),
              renderSessionTitleAiButton(session),
              '</div>',
              '<div class="workspace-history-meta">' + escapeHtml(formatWorkspaceDate(session.updatedAt)) + '</div>',
              sType !== 'exploration' && session.preview ? '<div class="workspace-history-preview">' + escapeHtml(session.preview) + '</div>' : '',
              renderSessionTokenBar(session, agent),
              '</div>',
              '<div class="workspace-history-side">',
              '<div class="workspace-history-meta compact">' + escapeHtml(t('workspace_history_messages')) + ': ' + escapeHtml(String(session.messageCount ?? 0)) + '</div>',
              '<div class="workspace-actions stacked">',
              buttonsHtml,
              '</div>',
              '</div>',
              '</div>',
            ].join('');
          };

          let sessionsHtml = '';
          if (needsTabs) {
            const tabId = 'ph-tab-' + escapeHtml(agent.id) + '-' + escapeHtml(project.id);
            sessionsHtml += '<div class="ph-session-tabs" data-tab-group="' + tabId + '">';
            sessionsHtml += '<div class="ph-session-tab-bar">';
            sessionsHtml += '<button class="ph-session-tab active" data-ph-tab="main" onclick="window.switchPhSessionTab(this)">' + escapeHtml(t('workspace_main_conversations')) + ' <span class="ph-tab-count">' + escapeHtml(String(mainSessions.length)) + '</span></button>';
            sessionsHtml += '<button class="ph-session-tab" data-ph-tab="exploration" onclick="window.switchPhSessionTab(this)">' + escapeHtml(t('workspace_exploration_conversations')) + ' <span class="ph-tab-count">' + escapeHtml(String(explorationSessions.length)) + '</span></button>';
            sessionsHtml += '<button class="ph-session-tab" data-ph-tab="sub" onclick="window.switchPhSessionTab(this)">' + escapeHtml(t('workspace_sub_conversations')) + ' <span class="ph-tab-count">' + escapeHtml(String(subSessions.length)) + '</span></button>';
            sessionsHtml += '</div>';
            const mainEmptyNote = '<div class="feature-project-empty-note">' + escapeHtml(t('workspace_feature_no_sessions')) + '</div><div class="feature-project-empty-actions"><button class="workspace-action" type="button" data-workspace-action="' + newChatAction + '" onclick="window.runWorkspaceActionFromEvent(event, this.dataset.workspaceAction)">' + escapeHtml(t('workspace_new_chat')) + '</button></div>';
            sessionsHtml += '<div class="ph-session-tab-panel active" data-ph-panel="main"><div class="feature-project-session-list">' + (mainSessions.length > 0 ? mainSessions.map(s => renderPhSessionItem(s, 'main')).join('') : mainEmptyNote) + '</div></div>';
            sessionsHtml += '<div class="ph-session-tab-panel" data-ph-panel="exploration"><div class="feature-project-session-list">' + (explorationSessions.length > 0 ? explorationSessions.map(s => renderPhSessionItem(s, 'exploration')).join('') : '<div class="feature-project-empty-note">' + escapeHtml(t('workspace_feature_no_sessions')) + '</div>') + '</div></div>';
            sessionsHtml += '<div class="ph-session-tab-panel" data-ph-panel="sub"><div class="feature-project-session-list">' + (subSessions.length > 0 ? subSessions.map(s => renderPhSessionItem(s, 'sub')).join('') : '<div class="feature-project-empty-note">' + escapeHtml(t('workspace_feature_no_sessions')) + '</div>') + '</div></div>';
            sessionsHtml += '</div>';
          } else {
            const emptyNote = '<div class="feature-project-empty-note">' + escapeHtml(t('workspace_feature_no_sessions')) + '</div><div class="feature-project-empty-actions"><button class="workspace-action" type="button" data-workspace-action="' + newChatAction + '" onclick="window.runWorkspaceActionFromEvent(event, this.dataset.workspaceAction)">' + escapeHtml(t('workspace_new_chat')) + '</button></div>';
            sessionsHtml = '<div class="feature-project-session-group"><div class="feature-project-session-list">' + (mainSessions.length > 0 ? mainSessions.map(s => renderPhSessionItem(s, 'main')).join('') : emptyNote) + '</div></div>';
          }

          return [
            '<div class="feature-project-card" data-prebuilt-project-agent-id="' + escapeHtml(agent.id) + '" data-prebuilt-project-id="' + escapeHtml(project.id) + '">',
            '<details class="feature-project-disclosure">',
            '<summary>',
            '<div class="feature-project-row">',
            '<div class="feature-project-summary">',
            '<div class="feature-project-titlebar">',
            '<div class="workspace-history-title">' + escapeHtml(getProgrammingHelperProjectDisplayName(project)) + '</div>',
            '</div>',
            '<div class="feature-project-meta-line"><span>' + escapeHtml(formatWorkspaceDate(project.updatedAt)) + '</span></div>',
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

    const isZh = currentLanguage === 'zh';
    const agentName = isZh ? '编程小助手' : 'Programming Helper';
    return [
      '<div class="ph-banner">',
      '<div>',
      '<div class="ph-banner-title">' + escapeHtml(agentName) + '</div>',
      '<div class="ph-banner-desc">' + escapeHtml(desc) + '</div>',
      '</div>',
      '<div class="ph-banner-actions">',
      '<button class="ph-banner-btn secondary" type="button" onclick="window.phOpenModelConfig()">' + (isZh ? '配置模型' : 'Model Config') + '</button>',
      '<button class="ph-banner-btn" type="button" onclick="window.phSelectDirectoryAndCreateSession()">' + escapeHtml(t('workspace_new_project')) + '</button>',
      '</div>',
      '</div>',
      '<section class="workspace-section">',
      bodyHtml,
      '</section>',
    ].join('');
  }

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
      const allowCompactedResume = !isAssemblySession(session);
      return [
        '<div class="workspace-history-item" data-prebuilt-session-agent-id="' + escapeHtml(agent.id) + '" data-prebuilt-session-id="' + escapeHtml(session.id) + '">',
        '<div class="workspace-history-main">',
        '<div class="workspace-history-title-row">',
        '<div class="workspace-history-title" ondblclick="window.handleSessionTitleDoubleClick(event)" title="' + escapeHtml(currentLanguage === 'zh' ? '双击编辑标题' : 'Double-click to edit title') + '">' + escapeHtml(primaryTitle) + '</div>',
        renderSessionResumeBadge(session),
        session.id === activeSessionId ? '<span class="workspace-history-active">当前</span>' : '',
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

function renderWorkspaceField(agent, field, draft, formId) {
  const name = String(field.name || '').trim();
  if (!name) return '';

  const label = localizeWorkspaceValue(field.label, name);
  const placeholder = localizeWorkspaceValue(field.placeholder, '');
  const value = draft[name] ?? '';
  const escapedName = escapeHtml(name);
  const escapedLabel = escapeHtml(label);
  const escapedPlaceholder = escapeHtml(placeholder);
  const escapedValue = escapeHtml(String(value));

  if (field.type === 'textarea') {
    return [
      '<label class="workspace-form-field">',
      '<span class="workspace-form-label">' + escapedLabel + '</span>',
      '<textarea class="workspace-form-textarea" placeholder="' + escapedPlaceholder + '" oninput="window.updateWorkspaceFormDraft(&quot;' + escapeHtml(formId) + '&quot;, &quot;' + escapedName + '&quot;, this.value)">' + escapedValue + '</textarea>',
      '</label>',
    ].join('');
  }

  if (field.type === 'select') {
    const options = Array.isArray(field.options) ? field.options : [];
    const optionsHtml = options.map((option) => {
      const optionValue = typeof option === 'string' ? option : String(option?.value ?? '');
      const optionLabel = typeof option === 'string' ? option : localizeWorkspaceValue(option?.label, optionValue);
      const selected = String(value) === optionValue ? ' selected' : '';
      return '<option value="' + escapeHtml(optionValue) + '"' + selected + '>' + escapeHtml(optionLabel) + '</option>';
    }).join('');
    return [
      '<label class="workspace-form-field">',
      '<span class="workspace-form-label">' + escapedLabel + '</span>',
      '<select class="workspace-form-select" onchange="window.updateWorkspaceFormDraft(&quot;' + escapeHtml(formId) + '&quot;, &quot;' + escapedName + '&quot;, this.value)">',
      optionsHtml,
      '</select>',
      '</label>',
    ].join('');
  }

  if (field.type === 'directory-picker') {
    if (!field.modeField) {
      const displayedValue = String(value || '');
      return [
        '<label class="workspace-form-field">',
        '<span class="workspace-form-label">' + escapedLabel + '</span>',
        '<div class="workspace-form-directory-picker">',
        '<input class="workspace-form-input" type="text" value="' + escapeHtml(displayedValue || t('workspace_directory_not_selected')) + '" readonly data-workspace-form-display="' + escapeHtml(formId + ':' + escapedName) + '">',
        '<button class="workspace-action" type="button" onclick="window.chooseWorkspaceDirectory(&quot;' + escapeHtml(formId) + '&quot;, &quot;' + escapedName + '&quot;)">' + escapeHtml(t('workspace_pick_directory')) + '</button>',
        '</div>',
        '<div class="workspace-form-note">' + escapeHtml(t('workspace_pick_directory_hint')) + '</div>',
        '</label>',
      ].join('');
    }

    const modeValue = String(draft[field.modeField || 'install_mode'] || 'system');
    const isCustomMode = modeValue === 'custom';
    const displayedValue = String(value || '');
    const outputDir = getFeatureCreatorOutputDirectory(agent, draft);
    if (isCustomMode) {
      return [
        '<label class="workspace-form-field">',
        '<span class="workspace-form-label">' + escapedLabel + '</span>',
        '<div class="workspace-form-directory-picker">',
        '<input class="workspace-form-input" type="text" value="' + escapeHtml(displayedValue || t('workspace_directory_not_selected')) + '" readonly data-workspace-form-display="' + escapeHtml(formId + ':' + escapedName) + '">',
        '<button class="workspace-action" type="button" onclick="window.chooseWorkspaceDirectory(&quot;' + escapeHtml(formId) + '&quot;, &quot;' + escapedName + '&quot;)">' + escapeHtml(t('workspace_pick_directory')) + '</button>',
        '</div>',
        '<div class="workspace-form-note">' + escapeHtml(t('workspace_pick_directory_hint')) + '</div>',
        outputDir ? '<div class="workspace-form-note" data-workspace-output-note="' + escapeHtml(formId) + '">' + escapeHtml(t('feature_creator_output_dir')) + ': ' + escapeHtml(outputDir) + '</div>' : '',
        '</label>',
      ].join('');
    }
    return [
      '<label class="workspace-form-field">',
      '<span class="workspace-form-label">' + escapedLabel + '</span>',
      '<input class="workspace-form-input" type="text" value="' + escapeHtml(displayedValue || t('workspace_directory_not_selected')) + '" readonly data-workspace-form-display="' + escapeHtml(formId + ':' + escapedName) + '">',
      '<div class="workspace-form-note">' + escapeHtml(t('workspace_install_mode_system')) + '</div>',
      outputDir ? '<div class="workspace-form-note" data-workspace-output-note="' + escapeHtml(formId) + '">' + escapeHtml(t('feature_creator_output_dir')) + ': ' + escapeHtml(outputDir) + '</div>' : '',
      '</label>',
    ].join('');
  }

  return [
    '<label class="workspace-form-field">',
    '<span class="workspace-form-label">' + escapedLabel + '</span>',
    '<input class="workspace-form-input" type="' + escapeHtml(field.type || 'text') + '" value="' + escapedValue + '" placeholder="' + escapedPlaceholder + '" oninput="window.updateWorkspaceFormDraft(&quot;' + escapeHtml(formId) + '&quot;, &quot;' + escapedName + '&quot;, this.value)">',
    '</label>',
  ].join('');
}

function renderWorkspaceForm(agent, block) {
  const title = localizeWorkspaceValue(block.title, t('workspace_tab_form'));
  const desc = localizeWorkspaceValue(block.description, '');
  const fields = Array.isArray(block.fields) ? block.fields : [];
  const formId = block.id || 'form';
  if (fields.length === 0) {
    return '<section class="workspace-section"><div class="workspace-section-title">' + escapeHtml(t('workspace_form_empty')) + '</div></section>';
  }

  const draft = getWorkspaceFormDraft(agent)[formId] || {};
  const submitAction = escapeHtml(JSON.stringify(block.submitAction || { type: 'show_chat' }));
  const backAction = block.backAction ? renderActionButton(block.backAction) : '';
  return [
    '<section class="workspace-section">',
    '<div class="workspace-section-header">',
    '<div>',
    '<div class="workspace-section-title">' + escapeHtml(title) + '</div>',
    '<div class="workspace-section-desc">' + escapeHtml(desc) + '</div>',
    '</div>',
    '</div>',
    '<div class="workspace-form">',
    fields.map((field) => renderWorkspaceField(agent, field, draft, formId)).join(''),
    '<div class="workspace-form-actions' + (backAction ? ' spread' : '') + '">',
    backAction ? '<div>' + backAction + '</div>' : '',
    '<div class="workspace-actions">',
    '<button class="workspace-action" type="button" data-workspace-form-id="' + escapeHtml(formId) + '" data-workspace-submit-action="' + submitAction + '" onclick="window.saveWorkspaceForm(this.dataset.workspaceFormId, this.dataset.workspaceSubmitAction)">' + escapeHtml(t('workspace_form_save')) + '</button>',
    '<button class="workspace-action" type="button" data-workspace-form-id="' + escapeHtml(formId) + '" onclick="window.resetWorkspaceForm(this.dataset.workspaceFormId)">' + escapeHtml(t('workspace_form_reset')) + '</button>',
    '</div>',
    '</div>',
    '<div class="workspace-form-note">' + escapeHtml(t('workspace_form_saved')) + '</div>',
    '</div>',
    '</section>',
  ].join('');
}

function renderQQBotConfigField(field, draft, updateHandler = 'window.updateQQBotConfigDraft') {
  const name = String(field?.name || '').trim();
  if (!name) return '';

  const label = localizeWorkspaceValue(field.label, name);
  const value = draft[name];

  if (field.type === 'checkbox') {
    return [
      '<label class="workspace-config-field checkbox">',
      '<span class="workspace-config-label">' + escapeHtml(label) + '</span>',
      '<span class="workspace-config-checkbox">',
      '<input type="checkbox" ' + (value ? 'checked ' : '') + 'onchange="' + updateHandler + '(&quot;' + escapeHtml(name) + '&quot;, this.checked)">',
      '<span>' + escapeHtml(label) + '</span>',
      '</span>',
      '</label>',
    ].join('');
  }

  return [
    '<label class="workspace-config-field">',
    '<span class="workspace-config-label">' + escapeHtml(label) + '</span>',
    '<input class="workspace-config-input" type="' + escapeHtml(field.type || 'text') + '" value="' + escapeHtml(String(value ?? '')) + '" oninput="' + updateHandler + '(&quot;' + escapeHtml(name) + '&quot;, this.value)">',
    '</label>',
  ].join('');
}

function renderIMWorkspaceTextField(label, value, onInput) {
  return [
    '<label class="workspace-config-field">',
    '<span class="workspace-config-label">' + escapeHtml(label) + '</span>',
    '<input class="workspace-config-input" type="text" value="' + escapeHtml(String(value ?? '')) + '" oninput="' + onInput + '">',
    '</label>',
  ].join('');
}

function renderIMWorkspaceSelectField(label, value, options, onChange) {
  const optionsHtml = options.map((option) => {
    const optionValue = String(option?.value ?? '');
    const optionLabel = String(option?.label ?? optionValue);
    const selected = String(value || '') === optionValue ? ' selected' : '';
    return '<option value="' + escapeHtml(optionValue) + '"' + selected + '>' + escapeHtml(optionLabel) + '</option>';
  }).join('');

  return [
    '<label class="workspace-config-field">',
    '<span class="workspace-config-label">' + escapeHtml(label) + '</span>',
    '<select class="workspace-form-select" onchange="' + onChange + '">',
    optionsHtml,
    '</select>',
    '</label>',
  ].join('');
}

function renderIMWorkspaceInlineSelect(value, options, onChange) {
  const hasIcons = options.some((o) => o.icon);

  if (!hasIcons) {
    const optionsHtml = options.map((option) => {
      const optionValue = String(option?.value ?? '');
      const optionLabel = String(option?.label ?? optionValue);
      const selected = String(value || '') === optionValue ? ' selected' : '';
      return '<option value="' + escapeHtml(optionValue) + '"' + selected + '>' + escapeHtml(optionLabel) + '</option>';
    }).join('');
    return '<select class="workspace-form-select im-inline-select" onchange="' + onChange + '">' + optionsHtml + '</select>';
  }

  // Custom dropdown with icons
  const itemsHtml = options.map((option) => {
    const optionValue = String(option?.value ?? '');
    const optionLabel = String(option?.label ?? optionValue);
    const isActive = String(value || '') === optionValue;
    return '<div class="im-dropdown-item' + (isActive ? ' active' : '') + '" data-value="' + escapeHtml(optionValue) + '" onclick="window.imSelectChannel(this, &quot;' + escapeHtml(optionValue) + '&quot;)">' + (option.icon || '') + '<span>' + escapeHtml(optionLabel) + '</span></div>';
  }).join('');

  const current = options.find((o) => String(o.value) === String(value || '')) || options[0];
  const currentLabel = String(current?.label ?? '');
  const currentIcon = current?.icon || '';

  return [
    '<div class="im-dropdown" data-onchange="' + escapeHtml(onChange) + '">',
    '<div class="im-dropdown-trigger" onclick="window.toggleIMDropdown(this)">',
    currentIcon + '<span>' + escapeHtml(currentLabel) + '</span>',
    '<svg class="im-dropdown-arrow" viewBox="0 0 12 12" fill="currentColor"><path d="M2 4l4 4 4-4"/></svg>',
    '</div>',
    '<div class="im-dropdown-menu">' + itemsHtml + '</div>',
    '</div>',
  ].join('');
}

function renderFlowEditorBlock(agent, block) {
  if (window.ClawFlowEditor && typeof window.ClawFlowEditor.renderBlock === 'function') {
    return window.ClawFlowEditor.renderBlock(agent, block, {
      currentLanguage,
      escapeHtml,
      localizeWorkspaceValue,
      getCurrentAgentRecord,
      getWorkspaceFormDraft,
      saveWorkspaceFormDraft,
      persistWorkspaceState,
      renderCurrentMainView,
      updateAgentWorkspaceState,
      getAgentWorkspaceState,
    });
  }
  const title = localizeWorkspaceValue(block.title, currentLanguage === 'zh' ? '编排' : 'Flows');
  return [
    '<section class="assembly-intro">',
    '<div class="workspace-section-title">' + escapeHtml(title) + '</div>',
    '<div class="assembly-workbench-note">' + escapeHtml(currentLanguage === 'zh' ? 'Flow 编辑器资源正在加载。' : 'Flow editor assets are loading.') + '</div>',
    '</section>',
  ].join('');
}

function renderIMWorkspaceConfigEditor(block) {
  const editor = block?.configEditor || {};
  const draft = getIMWorkspaceDraft();
  const selectedChannel = draft.workspaceConfig?.selectedChannel || 'qq';
  const qqConfigured = !!(draft.qqConfig?.appId && draft.qqConfig?.clientSecret);
  const weixinConfigured = !!draft.weixinConfig?.configured;
  const bindingStatus = draft.binding?.status || 'idle';
  const hasQrCode = !!draft.binding?.qrcodeDataUrl;
  const receptionistOptions = [
    { value: 'qq', label: 'QQ', icon: '<svg class="im-channel-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M21.395 15.035a40 40 0 0 0-.803-2.264l-1.079-2.695c.001-.032.014-.562.014-.836C19.526 4.632 17.351 0 12 0S4.474 4.632 4.474 9.241c0 .274.013.804.014.836l-1.08 2.695a39 39 0 0 0-.802 2.264c-1.021 3.283-.69 4.643-.438 4.673.54.065 2.103-2.472 2.103-2.472 0 1.469.756 3.387 2.394 4.771-.612.188-1.363.479-1.845.835-.434.32-.379.646-.301.778.343.578 5.883.369 7.482.189 1.6.18 7.14.389 7.483-.189.078-.132.132-.458-.301-.778-.483-.356-1.233-.646-1.846-.836 1.637-1.384 2.393-3.302 2.393-4.771 0 0 1.563 2.537 2.103 2.472.251-.03.581-1.39-.438-4.673"/></svg>' },
    { value: 'weixin', label: '微信', icon: '<svg class="im-channel-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M8.691 2.188C3.891 2.188 0 5.476 0 9.53c0 2.212 1.17 4.203 3.002 5.55a.59.59 0 0 1 .213.665l-.39 1.48c-.019.07-.048.141-.048.213 0 .163.13.295.29.295a.326.326 0 0 0 .167-.054l1.903-1.114a.864.864 0 0 1 .717-.098 10.16 10.16 0 0 0 2.837.403c.276 0 .543-.027.811-.05-.857-2.578.157-4.972 1.932-6.446 1.703-1.415 3.882-1.98 5.853-1.838-.576-3.583-4.196-6.348-8.596-6.348zM5.785 5.991c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178A1.17 1.17 0 0 1 4.623 7.17c0-.651.52-1.18 1.162-1.18zm5.813 0c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178 1.17 1.17 0 0 1-1.162-1.178c0-.651.52-1.18 1.162-1.18zm5.34 2.867c-1.797-.052-3.746.512-5.28 1.786-1.72 1.428-2.687 3.72-1.78 6.22.942 2.453 3.666 4.229 6.884 4.229.826 0 1.622-.12 2.361-.336a.722.722 0 0 1 .598.082l1.584.926a.272.272 0 0 0 .14.047c.134 0 .24-.111.24-.247 0-.06-.023-.12-.038-.177l-.327-1.233a.582.582 0 0 1-.023-.156.49.49 0 0 1 .201-.398C23.024 18.48 24 16.82 24 14.98c0-3.21-2.931-5.837-6.656-6.088V8.89c-.135-.01-.27-.027-.407-.03zm-2.53 3.274c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.97-.982zm4.844 0c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.969-.982z"/></svg>' },
  ];
  const fields = Array.isArray(editor.fields) ? editor.fields : [];

  if (!imWorkspaceState.data && !imWorkspaceState.loading && !imWorkspaceState.error) {
    ensureIMWorkspaceLoaded().catch((error) => {
      console.error('Failed to load IM workspace config:', error);
    });
  }

  const statusText = imWorkspaceState.error
    ? imWorkspaceState.error
    : imWorkspaceState.binding
      ? t('im_workspace_binding')
      : imWorkspaceState.polling
        ? t('im_workspace_polling')
        : imWorkspaceState.saving
          ? t('im_workspace_saving')
          : imWorkspaceState.loading
            ? t('im_workspace_loading')
            : imWorkspaceState.savedAt
              ? `${t('im_workspace_auto_saved')}: ${formatWorkspaceDate(imWorkspaceState.savedAt)}`
              : t('im_workspace_start_hint');

  const weixinBadge = weixinConfigured
    ? t('im_workspace_bound')
    : bindingStatus === 'pending'
      ? t('im_workspace_pending')
      : bindingStatus === 'expired'
        ? t('im_workspace_expired')
        : t('im_workspace_not_bound');

  const weixinActionsHtml = (() => {
    const actions = [];
    const secondary = [];
    if (weixinConfigured) {
      secondary.push('<button class="workspace-action secondary" type="button" onclick="window.logoutWeixinBinding()">' + escapeHtml(t('im_workspace_logout_weixin')) + '</button>');
    }
    secondary.push('<button class="workspace-action secondary" type="button" onclick="window.refreshWeixinBinding()">' + escapeHtml(t('im_workspace_refresh_weixin_bind')) + '</button>');
    actions.push('<div class="im-card-action-row"><button class="workspace-action" type="button" onclick="window.startWeixinBinding()">' + escapeHtml(t('im_workspace_start_weixin_bind')) + '</button></div>');
    if (secondary.length) {
      actions.push('<div class="im-card-action-row">' + secondary.join('') + '</div>');
    }
    if (hasQrCode) {
      actions.push('<div class="im-workspace-qrcode-hint">' + escapeHtml(t('im_workspace_weixin_qrcode_hint')) + '</div>');
    }
    return actions.join('');
  })();

  const sessionsHtml = draft.sessions.length > 0
    ? '<div class="workspace-history-list">' + draft.sessions.map((session) => {
        const isActive = String(draft.workspaceConfig?.receptionistSessionId || '') === String(session.id);
        const openAction = escapeHtml(JSON.stringify({ type: 'open_session', sessionId: session.id }));
        return [
          '<div class="workspace-history-item' + (isActive ? ' active' : '') + '">',
          '<div class="workspace-history-main">',
          '<div class="workspace-history-title-row">',
          '<div class="workspace-history-title">' + escapeHtml(session.title || session.id) + '</div>',
          (isActive ? '<span class="workspace-history-active">当前</span>' : ''),
          '</div>',
          '<div class="workspace-history-meta">' + escapeHtml(session.updatedAt ? formatWorkspaceDate(session.updatedAt) : session.id) + '</div>',
          '</div>',
          '<div class="workspace-history-side">',
          '<div class="workspace-actions stacked">',
          '<button class="workspace-action" type="button" data-workspace-action="' + openAction + '" onclick="window.launchReceptionistSession(&quot;' + escapeHtml(session.id) + '&quot;)">' + escapeHtml(t('workspace_open_chat')) + '</button>',
          '</div>',
          '</div>',
          '</div>',
        ].join('');
      }).join('') + '</div>'
    : '<div class="workspace-form-note">' + escapeHtml(t('im_workspace_no_session')) + '</div>';

  return [
    '<div class="im-workspace-channel-grid">',
    '<section class="im-workspace-channel-card' + (selectedChannel === 'qq' ? ' selected' : '') + '">',
    '<div class="im-workspace-channel-head">',
    '<div class="im-workspace-channel-title"><svg class="im-channel-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M21.395 15.035a40 40 0 0 0-.803-2.264l-1.079-2.695c.001-.032.014-.562.014-.836C19.526 4.632 17.351 0 12 0S4.474 4.632 4.474 9.241c0 .274.013.804.014.836l-1.08 2.695a39 39 0 0 0-.802 2.264c-1.021 3.283-.69 4.643-.438 4.673.54.065 2.103-2.472 2.103-2.472 0 1.469.756 3.387 2.394 4.771-.612.188-1.363.479-1.845.835-.434.32-.379.646-.301.778.343.578 5.883.369 7.482.189 1.6.18 7.14.389 7.483-.189.078-.132.132-.458-.301-.778-.483-.356-1.233-.646-1.846-.836 1.637-1.384 2.393-3.302 2.393-4.771 0 0 1.563 2.537 2.103 2.472.251-.03.581-1.39-.438-4.673"/></svg>' + escapeHtml(t('im_workspace_qq_section')) + '</div>',
    '<span class="workspace-config-badge ' + (qqConfigured ? 'ready' : 'warn') + '">' + escapeHtml(qqConfigured ? t('qqbot_config_ready') : t('qqbot_config_incomplete')) + '</span>',
    '</div>',
    '<div class="workspace-config-grid">',
    fields.map((field) => renderQQBotConfigField(field, draft.qqConfig || {}, 'window.updateIMQQConfigDraft')).join(''),
    '</div>',
    '</section>',
    '<section class="im-workspace-channel-card' + (selectedChannel === 'weixin' ? ' selected' : '') + '">',
    '<div class="im-workspace-channel-head">',
    '<div class="im-workspace-channel-title"><svg class="im-channel-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M8.691 2.188C3.891 2.188 0 5.476 0 9.53c0 2.212 1.17 4.203 3.002 5.55a.59.59 0 0 1 .213.665l-.39 1.48c-.019.07-.048.141-.048.213 0 .163.13.295.29.295a.326.326 0 0 0 .167-.054l1.903-1.114a.864.864 0 0 1 .717-.098 10.16 10.16 0 0 0 2.837.403c.276 0 .543-.027.811-.05-.857-2.578.157-4.972 1.932-6.446 1.703-1.415 3.882-1.98 5.853-1.838-.576-3.583-4.196-6.348-8.596-6.348zM5.785 5.991c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178A1.17 1.17 0 0 1 4.623 7.17c0-.651.52-1.18 1.162-1.18zm5.813 0c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178 1.17 1.17 0 0 1-1.162-1.178c0-.651.52-1.18 1.162-1.18zm5.34 2.867c-1.797-.052-3.746.512-5.28 1.786-1.72 1.428-2.687 3.72-1.78 6.22.942 2.453 3.666 4.229 6.884 4.229.826 0 1.622-.12 2.361-.336a.722.722 0 0 1 .598.082l1.584.926a.272.272 0 0 0 .14.047c.134 0 .24-.111.24-.247 0-.06-.023-.12-.038-.177l-.327-1.233a.582.582 0 0 1-.023-.156.49.49 0 0 1 .201-.398C23.024 18.48 24 16.82 24 14.98c0-3.21-2.931-5.837-6.656-6.088V8.89c-.135-.01-.27-.027-.407-.03zm-2.53 3.274c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.97-.982zm4.844 0c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.969-.982z"/></svg>' + escapeHtml(t('im_workspace_weixin_section')) + '</div>',
    '<span class="workspace-config-badge ' + (weixinConfigured ? 'ready' : 'warn') + '">' + escapeHtml(weixinBadge) + '</span>',
    '</div>',
    weixinActionsHtml,
    '</section>',
    '</div>',
    '<section class="workspace-section">',
    '<div class="workspace-section-header">',
    '<div>',
    '<div class="workspace-section-title">' + escapeHtml(t('im_workspace_identity_title')) + '</div>',
    '<div class="workspace-section-desc">' + escapeHtml(t('im_workspace_receptionist_hint')) + '</div>',
    '</div>',
    '<div class="im-workspace-header-actions">',
    renderIMWorkspaceInlineSelect(
      selectedChannel,
      receptionistOptions,
      'window.updateIMWorkspaceField(&quot;workspaceConfig.selectedChannel&quot;, this.value)',
    ),
    '<button class="workspace-action im-new-chat-btn" type="button" onclick="window.createReceptionistSession()">' + escapeHtml(t('im_workspace_new_chat')) + '</button>',
    '</div>',
    '</div>',
    sessionsHtml,
    '<div class="workspace-config-status">' + escapeHtml(statusText) + '</div>',
    '</section>',
    renderWeixinQrCodeDialog(),
  ].join('');
}

function renderWeixinQrCodeDialog() {
  if (!imWorkspaceState.weixinQrDialogOpen) return '';
  const draft = getIMWorkspaceDraft();
  const hasQrCode = !!draft.binding?.qrcodeDataUrl;
  if (!hasQrCode) return '';
  return [
    '<div class="feature-detail-overlay" onclick="if(event.target===this)window.closeWeixinQrCodeDialog()">',
    '<div class="feature-detail-window" style="width:min(100%,420px);">',
    '<div class="feature-detail-head">',
    '<div>',
    '<div class="feature-detail-title">' + escapeHtml(t('im_workspace_weixin_qrcode_dialog_title')) + '</div>',
    '<div class="feature-detail-subtitle">' + escapeHtml(t('im_workspace_weixin_qrcode_dialog_desc')) + '</div>',
    '</div>',
    '<button class="feature-detail-close" type="button" onclick="window.closeWeixinQrCodeDialog()">×</button>',
    '</div>',
    '<div class="im-qrcode-dialog-body">',
    '<div class="im-qrcode-dialog-img-wrap">',
    '<img src="' + escapeHtml(draft.binding.qrcodeDataUrl) + '" alt="Weixin QR code">',
    '</div>',
    '<div class="im-qrcode-dialog-hint">' + escapeHtml(t('im_workspace_weixin_qrcode_hint')) + '</div>',
    '<div class="workspace-actions" style="justify-content:center;">',
    '<button class="workspace-action" type="button" onclick="window.refreshWeixinBinding()">' + escapeHtml(t('im_workspace_refresh_weixin_bind')) + '</button>',
    '</div>',
    '</div>',
    '</div>',
    '</div>',
  ].join('');
}

function getDirectorySummaryData(agent, block) {
  const blockId = String(block?.id || '').trim();
  if (!blockId) return null;
  const workspaceData = agent?.workspace_data;
  if (!workspaceData || typeof workspaceData !== 'object') return null;
  return workspaceData[blockId] || null;
}

function renderDirectorySummaryPanel(agent, block) {
  const summary = getDirectorySummaryData(agent, block);
  if (!summary) return '';

  const title = localizeWorkspaceValue(block?.directorySummary?.title, '目录概览');
  const pathLabel = localizeWorkspaceValue(block?.directorySummary?.pathLabel, '目录路径');
  const updatedLabel = localizeWorkspaceValue(block?.directorySummary?.updatedLabel, '最后变更');
  const names = Array.isArray(summary.sampleNames) ? summary.sampleNames : [];

  return [
    '<div class="workspace-note-panel">',
    '<div class="workspace-note-title">' + escapeHtml(title) + '</div>',
    '<div class="workspace-note-row">' + escapeHtml(pathLabel) + ': ' + escapeHtml(summary.path || '-') + '</div>',
    '<div class="workspace-note-row">' + escapeHtml(updatedLabel) + ': ' + escapeHtml(summary.updatedAt ? formatWorkspaceDate(summary.updatedAt) : '-') + '</div>',
    names.length > 0
      ? '<div class="workspace-tag-list">' + names.map((name) => '<span class="workspace-tag">' + escapeHtml(name) + '</span>').join('') + '</div>'
      : '',
    summary.error ? '<div class="workspace-note-row">' + escapeHtml(summary.error) + '</div>' : '',
    '</div>',
  ].join('');
}

function renderWorkspaceStatusGrid(agent, block) {
  const title = localizeWorkspaceValue(block.title, t('workspace_tab_live'));
  const desc = localizeWorkspaceValue(block.description, agent?.description || '');
  const sessions = getWorkspaceSessions(agent);
  const summary = sessions.find((session) => session.id === (agent?.active_workspace_session_id || agent?.workspace_sessions?.activeSessionId)) || sessions[0] || null;
  const connected = agent ? (agent.connected !== false ? t('status_connected') : t('status_disconnected')) : t('status_no_agent');
  const imDraft = getIMWorkspaceDraft();
  const directorySummary = getDirectorySummaryData(agent, block);
  const canOpenChat = canEnterWorkspaceChat(agent);
  const cardsHtml = [
    { label: t('workspace_live_status'), value: connected, note: agent?.status || '-' },
    { label: t('workspace_live_runtime'), value: agent?.runtime_session_id || agent?.runtimeSessionId || '-', note: agent?.pid ? `PID ${agent.pid}` : '-' },
    { label: t('workspace_live_pending'), value: String(agent?.pending_input_count ?? 0), note: String(agent?.message_count ?? currentMessages.length ?? 0) + ' ' + t('feature_messages') },
    { label: t('workspace_live_session'), value: summary ? (summary.title || summary.id || '-') : t('workspace_history_empty'), note: summary?.updatedAt ? formatWorkspaceDate(summary.updatedAt) : '-' },
    directorySummary
      ? {
          label: localizeWorkspaceValue(block?.directorySummary?.countLabel, 'Skills'),
          value: String(directorySummary.skillCount ?? 0),
          note: directorySummary.exists
            ? `${localizeWorkspaceValue(block?.directorySummary?.countNote, 'Entries')}: ${directorySummary.entryCount ?? 0}`
            : (directorySummary.error || 'Not ready'),
        }
      : null,
    isIMWorkspaceConfigEditor(block)
      ? {
          label: t('workspace_live_config'),
          value: imDraft.workspaceConfig?.selectedChannel === 'weixin'
            ? (imDraft.weixinConfig?.configured ? t('im_workspace_bound') : t('im_workspace_not_bound'))
            : (imDraft.qqConfig?.appId && imDraft.qqConfig?.clientSecret ? t('qqbot_config_ready') : t('qqbot_config_incomplete')),
          note: imDraft.workspaceConfig?.selectedChannel === 'weixin'
            ? (imDraft.workspaceConfig?.channels?.weixin?.label || t('im_workspace_weixin_section'))
            : (imDraft.workspaceConfig?.channels?.qq?.label || t('im_workspace_qq_section')),
        }
      : null,
  ].filter(Boolean).map((card) => (
    '<div class="workspace-card"><div class="workspace-card-label">' + escapeHtml(card.label) + '</div><div class="workspace-card-value">' + escapeHtml(card.value) + '</div><div class="workspace-card-note">' + escapeHtml(card.note) + '</div></div>'
  )).join('');

  const sectionHtml = [
    '<section class="workspace-section">',
    '<div class="workspace-section-header">',
    '<div>',
    '<div class="workspace-section-title">' + escapeHtml(title) + '</div>',
    '<div class="workspace-section-desc">' + escapeHtml(desc) + '</div>',
    '</div>',
    '<button class="workspace-action" type="button" data-workspace-action="{&quot;type&quot;:&quot;show_chat&quot;}" onclick="window.runWorkspaceAction(this.dataset.workspaceAction, this)"' + (canOpenChat ? '' : ' disabled') + '>' + escapeHtml(t('workspace_open_chat')) + '</button>',
    '</div>',
    '<div class="workspace-grid">' + cardsHtml + '</div>',
    directorySummary ? renderDirectorySummaryPanel(agent, block) : '',
    isIMWorkspaceConfigEditor(block) ? renderIMWorkspaceConfigEditor(block) : '',
    '</section>',
  ].join('');

  return sectionHtml;
}

function getFeatureRepositoryData(agent, block) {
  const blockId = String(block?.id || '').trim();
  if (!blockId) return null;
  const workspaceData = agent?.workspace_data;
  if (!workspaceData || typeof workspaceData !== 'object') return null;
  return workspaceData[blockId] || null;
}

function getRepoLocaleText(zh, en) {
  return currentLanguage === 'zh' ? zh : en;
}

function parseWorkspaceListField(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || '').trim()).filter(Boolean);
  }
  return String(value || '')
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function serializeWorkspaceListField(items) {
  return Array.from(new Set((Array.isArray(items) ? items : []).map((item) => String(item || '').trim()).filter(Boolean))).join('\n');
}

function getAssemblyPresetLabel(value) {
  const map = {
    'general-chatbot': currentLanguage === 'zh' ? '通用对话助手' : 'General Chatbot',
    'tool-operator': currentLanguage === 'zh' ? '工具执行助手' : 'Tool Operator',
    'workflow-assistant': currentLanguage === 'zh' ? '工作流推进助手' : 'Workflow Assistant',
  };
  return map[value] || value || (currentLanguage === 'zh' ? '未设置' : 'Unset');
}

function getAssemblyPresetDescription(value) {
  const map = {
    'general-chatbot': currentLanguage === 'zh'
      ? '偏向通用对话体验，强调基础能力完整和上手速度。'
      : 'Optimized for a general chat experience with balanced baseline capabilities.',
    'tool-operator': currentLanguage === 'zh'
      ? '偏向联网、执行和观察类能力，适合操作型助手。'
      : 'Optimized for web, execution, and observation capabilities for operator-style assistants.',
    'workflow-assistant': currentLanguage === 'zh'
      ? '偏向任务推进、控制和过程组织，适合持续跟进型 Agent。'
      : 'Optimized for task progression, control, and process organization.',
  };
  return map[value] || '';
}

const ASSEMBLY_PRESET_FEATURES = {
  'general-chatbot': ['websearch-feature', 'audit-feature', 'memory-feature'],
  'tool-operator': ['shell-feature', 'lsp-feature', 'websearch-feature'],
  'workflow-assistant': ['memory-feature', 'audit-feature', 'plugin-compat-feature'],
};

const ASSEMBLY_BUNDLE_FEATURES = {
  'web-retrieval': ['websearch-feature', 'visual-feature', 'audit-feature'],
  'memory-copilot': ['memory-feature', 'audit-feature'],
  'dev-operator': ['shell-feature', 'lsp-feature', 'websearch-feature'],
};

window.applyAssemblyPreset = (formId, presetKey) => {
  const agent = getCurrentAgentRecord();
  if (!agent?.id) return;
  const draft = getWorkspaceFormDraft(agent);
  draft[formId] = draft[formId] || {};
  draft[formId].preset = presetKey;
  const features = ASSEMBLY_PRESET_FEATURES[presetKey] || [];
  const featureTokens = [];
  features.forEach((token) => {
    const match = getAssemblyFeaturePackageToken(token, agent);
    if (match) featureTokens.push(match);
  });
  draft[formId].selected_features = serializeWorkspaceListField(canonicalizeAssemblyFeatureSelection(agent, featureTokens));
  saveWorkspaceFormDraft(agent.id, draft);
  shouldAnimateWorkspaceSurface = false;
  renderCurrentMainView();
};

function getAssemblyFeaturePackageToken(featureRef, agentOrPackages) {
  const pkgs = Array.isArray(agentOrPackages?.workspace_data?.['assembly-workbench']?.packages)
    ? agentOrPackages.workspace_data['assembly-workbench'].packages
    : (Array.isArray(agentOrPackages) ? agentOrPackages : []);
  for (const p of pkgs) {
    const id = (p.id || '').toLowerCase();
    const pn = (p.packageName || '').toLowerCase();
    const ref = featureRef.toLowerCase().replace(/-feature$/, '');
    if (id.includes(ref) || pn.includes(ref)) return p.id || p.packageName || featureRef;
  }
  return featureRef;
}

window.setBundleFilter = (formId, bundleKey) => {
  const agent = getCurrentAgentRecord();
  if (!agent?.id) return;
  const draft = getWorkspaceFormDraft(agent);
  draft[formId] = draft[formId] || {};
  const currentFilter = draft[formId].bundle_filter || '';
  draft[formId].bundle_filter = currentFilter === bundleKey ? '' : bundleKey;
  saveWorkspaceFormDraft(agent.id, draft);
  shouldAnimateWorkspaceSurface = false;
  renderCurrentMainView();
};

function getAssemblyStageLabel(value) {
  const map = {
    goal: currentLanguage === 'zh' ? '定义目标 Agent' : 'Define Target Agent',
    capabilities: currentLanguage === 'zh' ? '选择能力' : 'Choose Capabilities',
    environment: currentLanguage === 'zh' ? '环境准备' : 'Environment Setup',
    review: currentLanguage === 'zh' ? '确认与启动' : 'Review And Launch',
  };
  return map[value] || value || '';
}

function formatAssemblyFeatureToken(value) {
  return String(value || '')
    .trim()
    .replace(/^@agentdev\//, '')
    .replace(/-feature$/, '')
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function getAssemblyFeatureLabel(token, packages = []) {
  const normalized = String(token || '').trim();
  if (!normalized) return '';
  const matched = packages.find((item) => {
    const candidates = [
      item?.id,
      item?.packageName,
      item?.name,
    ].map((entry) => String(entry || '').trim()).filter(Boolean);
    return candidates.includes(normalized);
  });
  return matched?.name || formatAssemblyFeatureToken(normalized) || normalized;
}

function buildAssemblyGeneratedPrompt(form, packages = []) {
  const assemblyName = getAssemblyDisplayName(form) || (currentLanguage === 'zh' ? '未命名 Agent' : 'Untitled Agent');
  const preset = String(form?.preset || 'general-chatbot').trim();
  const goal = String(form?.goal || '').trim();
  const selectedFeatures = parseWorkspaceListField(form?.selected_features)
    .map((item) => getAssemblyFeatureLabel(item, packages))
    .filter(Boolean);

  const sections = [
    currentLanguage === 'zh'
      ? `你是一个已经装配完成并直接面对最终用户的聊天 Agent。\n你的名称是：${assemblyName}。`
      : `You are a chat agent that has already been assembled and now speaks directly to the end user.\nYour name is: ${assemblyName}.`,
    currentLanguage === 'zh'
      ? `预设定位：${getAssemblyPresetLabel(preset)}。${getAssemblyPresetDescription(preset)}`
      : `Preset: ${getAssemblyPresetLabel(preset)}. ${getAssemblyPresetDescription(preset)}`,
  ];

  if (goal) {
    sections.push(currentLanguage === 'zh' ? `主要目标：${goal}` : `Primary goal: ${goal}`);
  }
  if (selectedFeatures.length > 0) {
    sections.push((currentLanguage === 'zh' ? '当前已启用能力：' : 'Enabled capabilities: ') + selectedFeatures.join(currentLanguage === 'zh' ? '、' : ', '));
  }
  sections.push(currentLanguage === 'zh'
    ? '直接以目标 Agent 身份与用户对话，不要提及 Agent Creator、装配过程或工作空间内部机制。没有挂载的能力不要假装拥有。'
    : 'Speak directly as the target agent. Do not mention Agent Creator, the assembly workflow, or workspace internals. Never pretend to have capabilities that are not enabled.');

  return sections.join('\n\n');
}

function getAssemblyPromptValue(form, packages = []) {
  const custom = String(form?.custom_system_prompt || '').trim();
  return custom || buildAssemblyGeneratedPrompt(form, packages);
}

function formatRepoFileSize(size) {
  const value = Number(size || 0);
  if (!Number.isFinite(value) || value <= 0) return '-';
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KB`;
  return `${value} B`;
}

function normalizeRepoUrl(value) {
  if (!value || typeof value !== 'string') return '';
  try {
    const parsed = new URL(value);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.toString();
    }
  } catch {}
  return '';
}

function renderRepoLink(url, label) {
  const safeUrl = normalizeRepoUrl(url);
  if (!safeUrl) return '';
  return '<a class="workspace-action secondary workspace-link-button" href="' + escapeHtml(safeUrl) + '" target="_blank" rel="noreferrer">' + escapeHtml(label) + '</a>';
}

function getFeatureTypeLabel(value) {
  const map = {
    tools: 'tools',
    mcp: 'mcp',
    hooks: 'hooks',
    control: 'control',
    rollback: 'rollback',
  };
  return map[value] || value;
}

function getCompatibilityTagLabel(value) {
  const map = {
    'supports-rollback': getRepoLocaleText('支持 rollback', 'supports rollback'),
    'no-rollback': getRepoLocaleText('不支持 rollback', 'no rollback'),
  };
  return map[value] || value;
}

function renderFeatureRepositoryBlock(agent, block) {
  const title = localizeWorkspaceValue(block.title, getRepoLocaleText('Feature 仓库', 'Feature Repository'));
  const desc = localizeWorkspaceValue(block.description, '');
  const repository = getFeatureRepositoryData(agent, block);
  const packages = Array.isArray(repository?.packages) ? repository.packages : [];
  const assemblySelection = block?.assemblySelection || null;
  const selectionFormId = typeof assemblySelection?.formId === 'string' ? assemblySelection.formId : '';
  const selectionField = typeof assemblySelection?.featureField === 'string' ? assemblySelection.featureField : '';
  const selectedValues = selectionFormId && selectionField
    ? new Set(parseWorkspaceListField(getWorkspaceFormDraft(agent)?.[selectionFormId]?.[selectionField]))
    : null;
  const officialCount = packages.filter((item) => item.source === 'official').length;
  const customCount = packages.filter((item) => item.source === 'custom').length;

  if (!repository || repository.error) {
    return [
      '<section class="workspace-section">',
      '<div class="workspace-section-header">',
      '<div>',
      '<div class="workspace-section-title">' + escapeHtml(title) + '</div>',
      '<div class="workspace-section-desc">' + escapeHtml(desc) + '</div>',
      '</div>',
      '</div>',
      '<div class="workspace-repo-warning">' + escapeHtml(repository?.error || getRepoLocaleText('仓库数据暂不可用。', 'Repository data is unavailable.')) + '</div>',
      '</section>',
    ].join('');
  }

  if (packages.length === 0) {
    return [
      '<section class="workspace-section">',
      '<div class="workspace-section-header">',
      '<div>',
      '<div class="workspace-section-title">' + escapeHtml(title) + '</div>',
      '<div class="workspace-section-desc">' + escapeHtml(desc) + '</div>',
      '</div>',
      '</div>',
      '<div class="workspace-history-item"><div>' + escapeHtml(getRepoLocaleText('当前仓库中还没有 tgz 包。', 'No tgz packages were found in the repository.')) + '</div></div>',
      '</section>',
    ].join('');
  }

  const summaryHtml = [
    {
      label: getRepoLocaleText('Feature', 'Features'),
      value: String(repository.packageCount ?? packages.length),
      note: getRepoLocaleText('按包名聚合后的条目数', 'Grouped package entries'),
    },
    {
      label: getRepoLocaleText('归档', 'Archives'),
      value: String(repository.archiveCount ?? 0),
      note: getRepoLocaleText('resources/features 中的 tgz 数量', 'tgz archives under resources/features'),
    },
    {
      label: getRepoLocaleText('缺失元数据', 'Missing Metadata'),
      value: String(repository.missingManifestCount ?? 0),
      note: getRepoLocaleText('没有 agentdev-feature.json 的归档', 'Archives without agentdev-feature.json'),
    },
  ].map((card) => [
    '<div class="workspace-card">',
    '<div class="workspace-card-label">' + escapeHtml(card.label) + '</div>',
    '<div class="workspace-card-value">' + escapeHtml(card.value) + '</div>',
    '<div class="workspace-card-note">' + escapeHtml(card.note) + '</div>',
    '</div>',
  ].join('')).join('');

  const filteredPackages = packages
    .filter((item) => {
      if (repoSourceFilter === 'official') return item.source === 'official';
      if (repoSourceFilter === 'custom') return item.source === 'custom';
      return true;
    })
    .filter((item) => {
      if (!repoSearchQuery) return true;
      const haystack = [
        item?.name,
        item?.id,
        item?.packageName,
        item?.description,
        ...(Array.isArray(item?.featureTypes) ? item.featureTypes : []),
        ...(Array.isArray(item?.tags) ? item.tags : []),
      ].join(' ').toLowerCase();
      return haystack.includes(repoSearchQuery);
    });

  const selectedPackage = packages.find((item) => item.id === selectedRepositoryPackageId) || null;
  if (selectedRepositoryPackageId && !selectedPackage) {
    selectedRepositoryPackageId = null;
  }

  const packagesHtml = filteredPackages.length === 0
    ? '<div class="workspace-history-item"><div>' + escapeHtml(getRepoLocaleText('没有匹配当前搜索的 Feature。', 'No features matched the current search.')) + '</div></div>'
    : filteredPackages.map((item) => {
    const versions = Array.isArray(item.versions) ? item.versions : [];
    const warnings = Array.isArray(item.warnings) ? item.warnings : [];
    const featureTypes = Array.isArray(item.featureTypes) ? item.featureTypes : [];
    const compatibilityTags = Array.isArray(item.compatibility?.tags) ? item.compatibility.tags : [];
    const packageToken = item.id || item.name || item.packageName || '';
    const isSelected = selectedValues ? selectedValues.has(packageToken) || selectedValues.has(item.packageName || '') : false;
    const previewTags = [
      ...featureTypes.map(getFeatureTypeLabel),
      ...compatibilityTags.map(getCompatibilityTagLabel),
    ];

    return [
      '<article class="workspace-repo-card" role="button" tabindex="0" data-feature-repo-package-id="' + escapeHtml(item.id) + '" onclick="window.openRepositoryPackageDetails(&quot;' + escapeHtml(item.id) + '&quot;)" title="' + escapeHtml(getRepoLocaleText('查看详情', 'View Details')) + '">',
      '<div class="workspace-repo-head">',
      '<div class="workspace-repo-title-wrap">',
      '<div class="workspace-repo-title">' + escapeHtml(item.name || item.id) + '</div>',
      '<div class="workspace-repo-subtitle">' + escapeHtml(item.packageName || item.id) + '</div>',
      '</div>',
      '<div class="workspace-repo-badges">',
      '<span class="workspace-repo-badge ready">v' + escapeHtml(item.latestVersion || '-') + '</span>',
      item.source === 'official'
        ? '<span class="workspace-repo-badge ready">' + escapeHtml(getRepoLocaleText('官方', 'Official')) + '</span>'
        : '<span class="workspace-repo-badge" style="background:var(--surface);color:var(--text-secondary);">' + escapeHtml(getRepoLocaleText('自定义', 'Custom')) + '</span>',
      isSelected ? '<span class="workspace-repo-badge ready">' + escapeHtml(getRepoLocaleText('已挂载', 'Enabled')) + '</span>' : '',
      warnings.length > 0 ? '<span class="workspace-repo-badge warn">' + escapeHtml(getRepoLocaleText('存在警告', 'Warnings')) + '</span>' : '',
      '</div>',
      '</div>',
      item.description ? '<div class="workspace-repo-desc">' + escapeHtml(item.description) + '</div>' : '',
      '<div class="workspace-repo-preview">' + escapeHtml(getRepoLocaleText('归档', 'Archives')) + ': ' + escapeHtml(String(item.archiveCount || versions.length || 0)) + ' · ' + escapeHtml(getRepoLocaleText('更新', 'Updated')) + ': ' + escapeHtml(formatWorkspaceDate(item.updatedAt)) + '</div>',
      previewTags.length > 0 ? '<div class="workspace-tag-list">' + previewTags.map((tag) => '<span class="workspace-tag">' + escapeHtml(tag) + '</span>').join('') + '</div>' : '',
      (selectionFormId && selectionField)
        ? '<div class="workspace-repo-actions"><button class="workspace-action' + (isSelected ? ' secondary' : '') + '" type="button" onclick="event.stopPropagation(); window.toggleWorkspaceSelection(&quot;' + escapeHtml(selectionFormId) + '&quot;, &quot;' + escapeHtml(selectionField) + '&quot;, &quot;' + escapeHtml(packageToken) + '&quot;)">' + escapeHtml(isSelected ? getRepoLocaleText('停用', 'Disable') : getRepoLocaleText('启用', 'Enable')) + '</button></div>'
        : '',
      '</article>',
    ].join('');
  }).join('');

  const detailHtml = !selectedPackage ? '' : (() => {
    const versions = Array.isArray(selectedPackage.versions) ? selectedPackage.versions : [];
    const warnings = Array.isArray(selectedPackage.warnings) ? selectedPackage.warnings : [];
    const tags = Array.isArray(selectedPackage.tags) ? selectedPackage.tags : [];
    const featureTypes = Array.isArray(selectedPackage.featureTypes) ? selectedPackage.featureTypes : [];
    const compatibilityTags = Array.isArray(selectedPackage.compatibility?.tags) ? selectedPackage.compatibility.tags : [];
    const requirements = selectedPackage.requirements || {};
    const requirementTags = [
      ...(Array.isArray(requirements.platforms) ? requirements.platforms.map((value) => `${getRepoLocaleText('平台', 'Platform')}: ${value}`) : []),
      ...(requirements.node ? [`Node: ${requirements.node}`] : []),
      ...(Array.isArray(requirements.external) ? requirements.external.map((value) => `${getRepoLocaleText('外部资源', 'External')}: ${value}`) : []),
      ...(Array.isArray(requirements.services) ? requirements.services.map((value) => `${getRepoLocaleText('服务', 'Service')}: ${value}`) : []),
    ];
    const agentdevCompat = selectedPackage.agentdev && typeof selectedPackage.agentdev.compatible === 'string'
      ? selectedPackage.agentdev.compatible
      : '';
    const linksHtml = [
      renderRepoLink(selectedPackage.homepage, getRepoLocaleText('主页', 'Homepage')),
      renderRepoLink(selectedPackage.repository, getRepoLocaleText('仓库', 'Repository')),
    ].filter(Boolean).join('');
    const selectedToken = selectedPackage.id || selectedPackage.name || selectedPackage.packageName || '';
    const isSelected = selectedValues ? selectedValues.has(selectedToken) || selectedValues.has(selectedPackage.packageName || '') : false;

    return [
      '<div class="feature-detail-overlay" onclick="if (event.target === this) window.closeRepositoryPackageDetails()">',
      '<div class="feature-detail-window">',
      '<div class="feature-detail-head">',
      '<div>',
      '<div class="feature-detail-title">' + escapeHtml(selectedPackage.name || selectedPackage.id) + '</div>',
      '<div class="feature-detail-subtitle">' + escapeHtml(selectedPackage.packageName || selectedPackage.id) + '</div>',
      '</div>',
      '<button class="feature-detail-close" type="button" title="' + escapeHtml(t('panel_close')) + '" onclick="window.closeRepositoryPackageDetails()">×</button>',
      '</div>',
      '<div class="feature-detail-stats">',
      '<div class="feature-detail-stat"><div class="feature-detail-stat-label">' + escapeHtml(getRepoLocaleText('来源', 'Source')) + '</div><div class="feature-detail-stat-value">' + escapeHtml(selectedPackage.source === 'official' ? getRepoLocaleText('官方', 'Official') : getRepoLocaleText('自定义', 'Custom')) + '</div></div>',
      '<div class="feature-detail-stat"><div class="feature-detail-stat-label">' + escapeHtml(getRepoLocaleText('最新版本', 'Latest')) + '</div><div class="feature-detail-stat-value">' + escapeHtml(selectedPackage.latestVersion || '-') + '</div></div>',
      '<div class="feature-detail-stat"><div class="feature-detail-stat-label">' + escapeHtml(getRepoLocaleText('归档数', 'Archives')) + '</div><div class="feature-detail-stat-value">' + escapeHtml(String(selectedPackage.archiveCount || versions.length || 0)) + '</div></div>',
      '<div class="feature-detail-stat"><div class="feature-detail-stat-label">' + escapeHtml(getRepoLocaleText('更新时间', 'Updated')) + '</div><div class="feature-detail-stat-value">' + escapeHtml(formatWorkspaceDate(selectedPackage.updatedAt)) + '</div></div>',
      '</div>',
      '<div class="feature-panel-section">',
      '<div class="feature-panel-section-title">' + escapeHtml(getRepoLocaleText('详情', 'Details')) + '</div>',
      selectedPackage.description ? '<div class="feature-detail-subtitle">' + escapeHtml(selectedPackage.description) + '</div>' : '',
      agentdevCompat ? '<div class="workspace-form-note">AgentDev: ' + escapeHtml(agentdevCompat) + '</div>' : '',
      '</div>',
      featureTypes.length > 0 ? '<div class="feature-panel-section"><div class="feature-panel-section-title">' + escapeHtml(getRepoLocaleText('Feature 类型', 'Feature Types')) + '</div><div class="workspace-tag-list">' + featureTypes.map((tag) => '<span class="workspace-tag">' + escapeHtml(getFeatureTypeLabel(tag)) + '</span>').join('') + '</div></div>' : '',
      '<div class="feature-panel-section"><div class="feature-panel-section-title">' + escapeHtml(getRepoLocaleText('兼容性', 'Compatibility')) + '</div><div class="workspace-tag-list">' + compatibilityTags.map((tag) => '<span class="workspace-tag">' + escapeHtml(getCompatibilityTagLabel(tag)) + '</span>').join('') + '</div></div>',
      requirementTags.length > 0 ? '<div class="feature-panel-section"><div class="feature-panel-section-title">' + escapeHtml(getRepoLocaleText('依赖摘要', 'Requirements')) + '</div><div class="workspace-tag-list">' + requirementTags.map((tag) => '<span class="workspace-tag">' + escapeHtml(tag) + '</span>').join('') + '</div></div>' : '',
      tags.length > 0 ? '<div class="feature-panel-section"><div class="feature-panel-section-title">' + escapeHtml(getRepoLocaleText('标签', 'Tags')) + '</div><div class="workspace-tag-list">' + tags.map((tag) => '<span class="workspace-tag">' + escapeHtml(tag) + '</span>').join('') + '</div></div>' : '',
      versions.length > 0 ? '<div class="feature-panel-section"><div class="feature-panel-section-title">' + escapeHtml(getRepoLocaleText('版本', 'Versions')) + '</div><div class="workspace-tag-list">' + versions.map((version) => '<span class="workspace-tag">' + escapeHtml(`v${version.version || '-'} · ${version.fileName}`) + '</span>').join('') + '</div></div>' : '',
      warnings.length > 0 ? '<div class="feature-panel-section"><div class="feature-panel-section-title">' + escapeHtml(getRepoLocaleText('警告', 'Warnings')) + '</div><div class="workspace-repo-warning">' + warnings.map((warning) => escapeHtml(warning)).join('<br>') + '</div></div>' : '',
      (selectionFormId && selectionField)
        ? '<div class="feature-panel-section"><div class="feature-panel-section-title">' + escapeHtml(getRepoLocaleText('装配动作', 'Assembly Action')) + '</div><div class="workspace-repo-actions"><button class="workspace-action' + (isSelected ? ' secondary' : '') + '" type="button" onclick="window.toggleWorkspaceSelection(&quot;' + escapeHtml(selectionFormId) + '&quot;, &quot;' + escapeHtml(selectionField) + '&quot;, &quot;' + escapeHtml(selectedToken) + '&quot;)">' + escapeHtml(isSelected ? getRepoLocaleText('从当前装配移除', 'Remove From Assembly') : getRepoLocaleText('挂到当前装配', 'Enable For Assembly')) + '</button></div></div>'
        : '',
      linksHtml ? '<div class="feature-panel-section"><div class="feature-panel-section-title">' + escapeHtml(getRepoLocaleText('链接', 'Links')) + '</div><div class="workspace-repo-actions">' + linksHtml + '</div></div>' : '',
      '</div>',
      '</div>',
    ].join('');
  })();

  return [
    '<section class="workspace-section">',
    '<div class="workspace-section-header">',
    '<div>',
    '<div class="workspace-section-title">' + escapeHtml(title) + '</div>',
    '<div class="workspace-section-desc">' + escapeHtml(desc) + '</div>',
    '</div>',
    '</div>',
    '<div class="workspace-repo-summary">' + summaryHtml + '</div>',
    '<div class="assembly-source-tabs">',
    '<button class="assembly-source-tab' + (repoSourceFilter === 'all' ? ' active' : '') + '" type="button" onclick="window.setRepoSourceFilter(&quot;all&quot;)">' + escapeHtml(getRepoLocaleText('全部', 'All')) + ' (' + (officialCount + customCount) + ')</button>',
    '<button class="assembly-source-tab' + (repoSourceFilter === 'official' ? ' active' : '') + '" type="button" onclick="window.setRepoSourceFilter(&quot;official&quot;)">' + escapeHtml(getRepoLocaleText('官方', 'Official')) + ' (' + officialCount + ')</button>',
    '<button class="assembly-source-tab' + (repoSourceFilter === 'custom' ? ' active' : '') + '" type="button" onclick="window.setRepoSourceFilter(&quot;custom&quot;)">' + escapeHtml(getRepoLocaleText('自定义', 'Custom')) + ' (' + customCount + ')</button>',
    '</div>',
    '<div class="assembly-capability-topbar" style="margin-bottom:14px;">',
    '<input class="assembly-search-input" style="flex:1 1 280px;min-height:40px;" type="text" value="' + escapeHtml(repoSearchQuery) + '" placeholder="' + escapeHtml(getRepoLocaleText('按名称、说明或标签搜索', 'Search by name, description, or tags')) + '" oninput="repoSearchQuery=this.value.trim().toLowerCase()" onblur="window.setRepoSearchQuery(this.value)" onkeydown="if(event.key===&quot;Enter&quot;){event.preventDefault();window.setRepoSearchQuery(this.value);}" >',
    '<button class="workspace-action" type="button" onclick="window.openFeatureUploadDialog()">' + escapeHtml(getRepoLocaleText('上传 tgz', 'Upload tgz')) + '</button>',
    '</div>',
    '<div class="workspace-repo-list">' + packagesHtml + '</div>',
    detailHtml,
    '</section>',
  ].join('');
}

function renderAssemblyWorkbenchBlock(agent, block) {
  return renderAssemblyWorkbenchStageFlow(agent, block);
}

window.ClawFW = {
  mode: 'list',
  section: 'features',
  projectPickerOpen: false,
  createDialogOpen: false,
  promptEditorOpen: false,
  confirmDialog: null,
  featureImport: null,
  featureQuery: null,
  driftDialog: null,
  featureCapabilities: { key: '', loading: false, error: '', data: null },
  fwSlashPicker: { open: false, query: '', startIndex: 0, activeIndex: 0, category: 'all', formId: '' },
  settingsOpen: false,
  settingsData: null,
  settingsEditing: null,
  _modelPresets: null,
};

function getFWFeatureCapabilityState() {
  if (!window.ClawFW.featureCapabilities || typeof window.ClawFW.featureCapabilities !== 'object') {
    window.ClawFW.featureCapabilities = { key: '', loading: false, error: '', data: null };
  }
  return window.ClawFW.featureCapabilities;
}

function buildFWFeatureCapabilityKey(agent, draft = {}) {
  const selected = canonicalizeAssemblyFeatureSelection(agent, parseWorkspaceListField(draft.selected_features));
  return `${String(agent?.id || '')}|${selected.join(',')}`;
}

async function requestFWFeatureCapabilities(agent, draft = {}, options = {}) {
  if (!agent?.id) return null;
  const cache = getFWFeatureCapabilityState();
  const key = buildFWFeatureCapabilityKey(agent, draft);
  if (!options.force && cache.loading && cache.key === key) {
    return cache.data;
  }
  if (!options.force && cache.key === key && cache.data) {
    return cache.data;
  }

  cache.key = key;
  cache.loading = true;
  cache.error = '';
  try {
    const response = await fetch('/protoclaw/flow_capabilities?agentId=' + encodeURIComponent(agent.id));
    if (!response.ok) {
      throw new Error(await response.text().catch(() => 'Failed to load feature capabilities'));
    }
    const payload = await response.json();
    if (cache.key !== key) {
      return payload;
    }
    cache.data = payload && typeof payload === 'object' ? payload : {};
    cache.loading = false;
    cache.error = '';
  } catch (error) {
    if (cache.key === key) {
      cache.loading = false;
      cache.error = error?.message || String(error);
      cache.data = null;
    }
  }
  shouldAnimateWorkspaceSurface = false;
  renderCurrentMainView();
  return cache.data;
}

function ensureFWFeatureCapabilities(agent, draft = {}) {
  const cache = getFWFeatureCapabilityState();
  const key = buildFWFeatureCapabilityKey(agent, draft);
  if (cache.key !== key && !cache.loading) {
    requestFWFeatureCapabilities(agent, draft).catch((error) => {
      console.error('Failed to load feature capabilities:', error);
    });
  }
  return cache;
}

function parseWorkspaceTimeMs(value) {
  const time = value ? new Date(String(value)).getTime() : 0;
  return Number.isFinite(time) ? time : 0;
}

function findAssemblyConfigForSession(agent, session) {
  const projectId = String(session?.agentName || '').trim();
  if (!projectId) return null;
  return getSavedAssemblyConfigs(agent).find((item) => String(item?.id || '').trim() === projectId || String(item?.name || '').trim() === projectId) || null;
}

async function fetchAssemblyGraphSummary(projectId) {
  const normalized = String(projectId || '').trim();
  if (!normalized) return null;
  try {
    const response = await fetch('/protoclaw/flow_graphs?agentId=' + encodeURIComponent(normalized));
    if (!response.ok) return null;
    const payload = await response.json().catch(() => null);
    const flows = Array.isArray(payload?.flows) ? payload.flows : [];
    return flows.find((item) => String(item?.id || '') === 'agent-flow-graph') || null;
  } catch (error) {
    console.warn('Failed to fetch assembly graph summary:', error);
    return null;
  }
}

async function inspectAssemblySessionDrift(agent, sessionId) {
  const session = getWorkspaceSessionById(agent, sessionId);
  if (!session || !isAssemblySession(session) || isAssemblySessionRunning(agent, session)) {
    return null;
  }
  const sessionTime = parseWorkspaceTimeMs(session.updatedAt);
  const projectId = String(session.agentName || '').trim();
  const reasons = [];
  const savedConfig = findAssemblyConfigForSession(agent, session);
  const configTime = parseWorkspaceTimeMs(savedConfig?.updatedAt);
  if (savedConfig && ((!sessionTime && configTime) || (sessionTime && configTime > sessionTime))) {
    reasons.push({
      title: currentLanguage === 'zh' ? '能力装配已更新' : 'Assembly config changed',
      detail: currentLanguage === 'zh'
        ? '这个项目的 Feature 选择或基础配置在该对话保存之后发生过变化。'
        : 'The project feature selection or base configuration changed after this session was last saved.',
      updatedAt: savedConfig?.updatedAt || '',
    });
  }
  const graph = await fetchAssemblyGraphSummary(projectId);
  const graphTime = parseWorkspaceTimeMs(graph?.updatedAt);
  if (graph && ((!sessionTime && graphTime) || (sessionTime && graphTime > sessionTime))) {
    reasons.push({
      title: currentLanguage === 'zh' ? '编排图已更新' : 'Flow graph changed',
      detail: currentLanguage === 'zh'
        ? '该对话对应的编排图在会话保存之后被编辑过，恢复时可能出现定义与现场不一致。'
        : 'The orchestration graph was edited after this session was saved, so restoring it may resume with stale runtime state.',
      updatedAt: graph?.updatedAt || '',
    });
  }
  if (!reasons.length) return null;
  return {
    session,
    projectId,
    reasons,
  };
}

function ensureAssemblyDriftDialogHost() {
  let host = document.getElementById('assembly-drift-dialog-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'assembly-drift-dialog-host';
    document.body.appendChild(host);
  }
  return host;
}

function closeAssemblyDriftDialog() {
  window.ClawFW.driftDialog = null;
  const host = document.getElementById('assembly-drift-dialog-host');
  if (host) host.innerHTML = '';
}

async function confirmAssemblyDriftDialogProceed() {
  const pending = window.ClawFW.driftDialog;
  closeAssemblyDriftDialog();
  if (typeof pending?.onConfirm === 'function') {
    try {
      await pending.onConfirm();
    } catch (error) {
      console.error('Failed to continue after drift warning:', error);
      window.alert((currentLanguage === 'zh' ? '继续打开旧对话失败：' : 'Failed to continue opening the older conversation: ') + (error?.message || error));
    }
  }
}

function renderAssemblyDriftDialog() {
  const pending = window.ClawFW.driftDialog;
  const host = ensureAssemblyDriftDialogHost();
  if (!pending) {
    host.innerHTML = '';
    return;
  }
  const reasons = Array.isArray(pending.reasons) ? pending.reasons : [];
  host.innerHTML = [
    '<div class="feature-detail-overlay" onclick="if (event.target === this) closeAssemblyDriftDialog()">',
    '<div class="feature-detail-window">',
    '<div class="feature-detail-head">',
    '<div>',
    '<div class="feature-detail-title">' + escapeHtml(currentLanguage === 'zh' ? '检测到项目定义已经变化' : 'Project definition changed') + '</div>',
    '<div class="feature-detail-subtitle">' + escapeHtml(currentLanguage === 'zh'
      ? '你正在打开一个较早保存的对话。当前项目的装配或编排图在此之后被修改过，恢复时可能继续沿用旧的运行时状态。'
      : 'You are opening an older saved conversation. The project assembly or flow graph changed after it was saved, so the resumed runtime may carry stale state.') + '</div>',
    '</div>',
    '<button class="feature-detail-close" type="button" title="' + escapeHtml(t('panel_close')) + '" onclick="closeAssemblyDriftDialog()">×</button>',
    '</div>',
    reasons.length ? '<div class="fw-switch-modal-list">' + reasons.map((item) => [
      '<div class="fw-switch-modal-card active" style="cursor:default;">',
      '<strong>' + escapeHtml(item.title || '') + '</strong>',
      '<span>' + escapeHtml([item.detail || '', item.updatedAt ? formatWorkspaceDate(item.updatedAt) : ''].filter(Boolean).join(' · ')) + '</span>',
      '</div>',
    ].join('')).join('') + '</div>' : '',
    '<div class="feature-detail-subtitle">' + escapeHtml(currentLanguage === 'zh'
      ? '这不是阻止项，但如果后续行为异常，优先考虑重启运行时或重置流程状态。'
      : 'This is not a blocker, but if behavior looks off, restart the runtime or reset the flow state first.') + '</div>',
    '<div class="workspace-actions" style="justify-content:flex-end;">',
    '<button class="workspace-action secondary" type="button" onclick="closeAssemblyDriftDialog()">' + escapeHtml(currentLanguage === 'zh' ? '先不打开' : 'Not now') + '</button>',
    '<button class="workspace-action" type="button" onclick="confirmAssemblyDriftDialogProceed()">' + escapeHtml(currentLanguage === 'zh' ? '继续打开旧对话' : 'Open anyway') + '</button>',
    '</div>',
    '</div>',
    '</div>',
  ].join('');
}

async function maybeWarnAssemblySessionDrift(agent, sessionId, onConfirm) {
  const pending = await inspectAssemblySessionDrift(agent, sessionId);
  if (!pending) {
    await onConfirm();
    return;
  }
  window.ClawFW.driftDialog = {
    ...pending,
    onConfirm,
  };
  renderAssemblyDriftDialog();
}

/* ── Settings Overlay ────────────────────────────────────────────────────────── */

function ensureSettingsHost() {
  let host = document.getElementById('settings-overlay-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'settings-overlay-host';
    document.body.appendChild(host);
  }
  return host;
}

async function openSettings() {
  window.ClawFW.settingsOpen = true;
  window.ClawFW.settingsEditing = null;
  window.ClawFW.settingsData = null;
  renderSettingsOverlay();
  try {
    const resp = await fetch('/protoclaw/model_config');
    const data = await resp.json();
    window.ClawFW.settingsData = data;
    window.ClawFW._modelPresets = Array.isArray(data?.presets) ? data.presets : [];
    renderSettingsOverlay();
  } catch (error) {
    console.error('Failed to load model config:', error);
  }
}

function closeSettings() {
  window.ClawFW.settingsOpen = false;
  window.ClawFW.settingsEditing = null;
  window.ClawFW.settingsData = null;
  const host = document.getElementById('settings-overlay-host');
  if (host) host.innerHTML = '';
}

function renderSettingsOverlay() {
  const host = ensureSettingsHost();
  if (!window.ClawFW.settingsOpen) {
    host.innerHTML = '';
    return;
  }
  const data = window.ClawFW.settingsData;
  const config = data?.config || { defaultModel: {}, agent: {} };
  const presets = Array.isArray(data?.presets) ? data.presets : [];
  const dm = config.defaultModel || {};
  const ag = config.agent || {};
  const editing = window.ClawFW.settingsEditing;
  const isZh = currentLanguage === 'zh';

  const presetCards = presets.length
    ? presets.map((p, idx) => {
        const isActive = dm.model === p.model && dm.provider === p.provider && dm.baseUrl === p.baseUrl;
        return [
          '<div class="settings-preset-card' + (isActive ? ' active' : '') + '" onclick="applySettingsPreset(' + idx + ')">',
          '<div class="settings-preset-dot"></div>',
          '<div class="settings-preset-info">',
          '<div class="settings-preset-name">' + escapeHtml(p.name || p.model || ('Preset ' + (idx + 1))) + '</div>',
          '<div class="settings-preset-detail">' + escapeHtml((p.provider || '—') + ' · ' + (p.model || '—') + (p.baseUrl ? ' · ' + p.baseUrl : '')) + '</div>',
          '</div>',
          '<div class="settings-preset-actions">',
          '<button class="settings-icon-btn" type="button" title="' + (isZh ? '编辑' : 'Edit') + '" onclick="event.stopPropagation();editSettingsPreset(' + idx + ')">',
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>',
          '</button>',
          '<button class="settings-icon-btn danger" type="button" title="' + (isZh ? '删除' : 'Delete') + '" onclick="event.stopPropagation();deleteSettingsPreset(' + idx + ')">',
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>',
          '</button>',
          '</div>',
          '</div>',
        ].join('');
      }).join('')
    : '<div style="padding:16px;text-align:center;color:var(--text-secondary);font-size:13px;">' + (isZh ? '暂无预设，点击下方按钮添加' : 'No presets yet. Click the button below to add one') + '</div>';

  host.innerHTML = [
    '<div class="feature-detail-overlay" onclick="if(event.target===this)closeSettings()">',
    '<div class="feature-detail-window" style="width:min(100%,560px);max-height:min(100%,720px);">',
    '<div class="feature-detail-head">',
    '<div>',
    '<div class="feature-detail-title">' + (isZh ? '模型设置' : 'Model Settings') + '</div>',
    '<div class="feature-detail-subtitle">' + (isZh ? '管理 LLM 预设并切换当前使用的模型' : 'Manage LLM presets and switch the active model') + '</div>',
    '</div>',
    '<button class="feature-detail-close" type="button" title="' + (isZh ? '关闭' : 'Close') + '" onclick="closeSettings()">×</button>',
    '</div>',

    /* ── Presets Section (hidden when editing) ── */
    editing === null ? [
    '<div class="settings-section">',
    '<div class="settings-section-title">' + (isZh ? '预设列表' : 'Presets') + '</div>',
    '<div class="settings-presets-list">' + presetCards + '</div>',
    '<button class="settings-btn settings-btn-secondary" type="button" style="align-self:flex-start;" onclick="addSettingsPreset()">+ ' + (isZh ? '添加预设' : 'Add Preset') + '</button>',
    '</div>',
    ].join('') : '',

    /* ── Edit Form (inline) ── */
    editing !== null ? renderSettingsEditForm(editing, presets, isZh) : '',

    /* ── Current Config Display (hidden when editing) ── */
    !editing ? [
      '<div class="settings-section">',
      '<div class="settings-section-title">' + (isZh ? '当前激活配置' : 'Active Configuration') + '</div>',
      '<div style="padding:14px;border-radius:12px;border:1px solid rgba(99,145,255,0.25);background:rgba(99,145,255,0.05);">',
      '<div style="display:grid;grid-template-columns:auto 1fr;gap:6px 14px;font-size:13px;">',
      '<span style="color:var(--text-secondary);font-weight:500;">Provider</span><span style="color:var(--text-primary);">' + escapeHtml(dm.provider || '—') + '</span>',
      '<span style="color:var(--text-secondary);font-weight:500;">Model</span><span style="color:var(--text-primary);">' + escapeHtml(dm.model || '—') + '</span>',
      dm.baseUrl ? '<span style="color:var(--text-secondary);font-weight:500;">Base URL</span><span style="color:var(--text-primary);word-break:break-all;">' + escapeHtml(dm.baseUrl) + '</span>' : '',
      '<span style="color:var(--text-secondary);font-weight:500;">API Key</span><span style="color:var(--text-primary);">' + (dm.apiKey ? dm.apiKey.slice(0, 8) + '••••' : '—') + '</span>',
      dm.thinkingBudgetTokens != null ? '<span style="color:var(--text-secondary);font-weight:500;">Thinking Tokens</span><span style="color:var(--text-primary);">' + dm.thinkingBudgetTokens + '</span>' : '',
      '</div>',
      '</div>',
      '</div>',
    ].join('') : '',

    '</div>',
    '</div>',
  ].join('');
}

function renderSettingsEditForm(editIdx, presets, isZh) {
  const preset = presets[editIdx] || {};
  const isNew = preset._isNew;
  return [
    '<div class="settings-section">',
    '<div class="settings-section-title">' + (isNew ? (isZh ? '新建预设' : 'New Preset') : (isZh ? '编辑预设' : 'Edit Preset')) + '</div>',
    '<div class="settings-field">',
    '<label>' + (isZh ? '名称' : 'Name') + '</label>',
    '<input class="settings-input" id="settings-preset-name" type="text" value="' + escapeHtml(preset.name || '') + '" placeholder="' + (isZh ? '例如：智谱 GLM-5' : 'e.g. ZhiPu GLM-5') + '">',
    '</div>',
    '<div class="settings-row">',
    '<div class="settings-field">',
    '<label>Provider</label>',
    '<select class="settings-input" id="settings-preset-provider">',
    '<option value="anthropic"' + (preset.provider === 'anthropic' ? ' selected' : '') + '>Anthropic</option>',
    '<option value="openai"' + (preset.provider === 'openai' ? ' selected' : '') + '>OpenAI</option>',
    '</select>',
    '</div>',
    '<div class="settings-field">',
    '<label>Model</label>',
    '<input class="settings-input" id="settings-preset-model" type="text" value="' + escapeHtml(preset.model || '') + '" placeholder="glm-5-turbo">',
    '</div>',
    '</div>',
    '<div class="settings-field">',
    '<label>Base URL</label>',
    '<input class="settings-input" id="settings-preset-baseurl" type="text" value="' + escapeHtml(preset.baseUrl || '') + '" placeholder="https://open.bigmodel.cn/api/anthropic">',
    '</div>',
    '<div class="settings-field">',
    '<label>API Key</label>',
    '<div style="position:relative;display:flex;align-items:stretch;">',
    '<input class="settings-input" id="settings-preset-apikey" type="password" value="' + escapeHtml(preset.apiKey || '') + '" placeholder="sk-..." style="padding-right:40px;">',
    '<button type="button" onclick="toggleApiKeyVisibility()" style="position:absolute;right:8px;top:50%;transform:translateY(-50%);background:none;border:none;cursor:pointer;padding:4px;display:flex;align-items:center;justify-content:center;color:var(--text-secondary);transition:color 0.2s;" onmouseover="this.style.color=\'var(--text-primary)\'" onmouseout="this.style.color=\'var(--text-secondary)\'" title="' + (isZh ? '显示/隐藏' : 'Show/Hide') + '">',
    '<svg id="apikey-eye-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">',
    '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>',
    '<circle cx="12" cy="12" r="3"></circle>',
    '</svg>',
    '<svg id="apikey-eye-off-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:none;">',
    '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path>',
    '<line x1="1" y1="1" x2="23" y2="23"></line>',
    '</svg>',
    '</button>',
    '</div>',
    '</div>',
    '<div class="settings-row">',
    '<div class="settings-field">',
    '<label>Thinking Budget Tokens</label>',
    '<input class="settings-input" id="settings-preset-thinking" type="number" value="' + (preset.thinkingBudgetTokens ?? '') + '" placeholder="' + (isZh ? '留空使用默认值' : 'Leave empty for default') + '">',
    '</div>',
    '<div class="settings-field">',
    '<label>Temperature</label>',
    '<input class="settings-input" id="settings-preset-temperature" type="number" step="0.1" min="0" max="2" value="' + (preset.temperature ?? '') + '" placeholder="' + (isZh ? '留空使用默认值' : 'Leave empty for default') + '">',
    '</div>',
    '</div>',
    '<div class="settings-row">',
    '<div class="settings-field">',
    '<label>' + (isZh ? '上下文长度' : 'Context Length') + '</label>',
    '<input class="settings-input" id="settings-preset-context-length" type="number" value="' + (preset.contextLength ?? '') + '" placeholder="200000">',
    '</div>',
    '<div class="settings-field">',
    '<label>' + (isZh ? 'Count Token 路径' : 'Count Token Path') + '</label>',
    '<input class="settings-input" id="settings-preset-count-token-path" type="text" value="' + escapeHtml(preset.countTokenPath || '') + '" placeholder="/v1/messages/count_tokens">',
    '</div>',
    '</div>',
    '<div class="settings-actions">',
    '<button class="settings-btn settings-btn-secondary" type="button" onclick="cancelSettingsEdit()">' + (isZh ? '取消' : 'Cancel') + '</button>',
    '<button class="settings-btn settings-btn-primary" type="button" onclick="saveSettingsPreset(' + editIdx + ')">' + (isZh ? '保存' : 'Save') + '</button>',
    '</div>',
    '</div>',
  ].join('');
}

function addSettingsPreset() {
  const presets = window.ClawFW.settingsData?.presets || [];
  presets.push({
    _isNew: true,
    name: '',
    provider: 'anthropic',
    model: '',
    baseUrl: '',
    apiKey: '',
    thinkingBudgetTokens: null,
    temperature: null,
  });
  window.ClawFW.settingsData = window.ClawFW.settingsData || {};
  window.ClawFW.settingsData.presets = presets;
  window.ClawFW.settingsEditing = presets.length - 1;
  renderSettingsOverlay();
}

function editSettingsPreset(idx) {
  window.ClawFW.settingsEditing = idx;
  renderSettingsOverlay();
}

function cancelSettingsEdit() {
  const presets = window.ClawFW.settingsData?.presets || [];
  const editing = window.ClawFW.settingsEditing;
  if (editing !== null && presets[editing]?._isNew) {
    presets.splice(editing, 1);
  }
  window.ClawFW.settingsEditing = null;
  renderSettingsOverlay();
}

async function deleteSettingsPreset(idx) {
  const presets = window.ClawFW.settingsData?.presets || [];
  presets.splice(idx, 1);
  window.ClawFW.settingsData.presets = presets;
  window.ClawFW.settingsEditing = null;
  await saveSettingsConfig();
}

function toggleApiKeyVisibility() {
  const input = document.getElementById('settings-preset-apikey');
  const eyeIcon = document.getElementById('apikey-eye-icon');
  const eyeOffIcon = document.getElementById('apikey-eye-off-icon');

  if (!input) return;

  if (input.type === 'password') {
    input.type = 'text';
    if (eyeIcon) eyeIcon.style.display = 'none';
    if (eyeOffIcon) eyeOffIcon.style.display = 'block';
  } else {
    input.type = 'password';
    if (eyeIcon) eyeIcon.style.display = 'block';
    if (eyeOffIcon) eyeOffIcon.style.display = 'none';
  }
}

async function saveSettingsPreset(idx) {
  const presets = window.ClawFW.settingsData?.presets || [];
  const el = (id) => document.getElementById(id);
  const thinkingRaw = el('settings-preset-thinking')?.value?.trim();
  const tempRaw = el('settings-preset-temperature')?.value?.trim();
  const contextLengthRaw = el('settings-preset-context-length')?.value?.trim();
  const countTokenPathRaw = el('settings-preset-count-token-path')?.value?.trim();
  const preset = {
    name: (el('settings-preset-name')?.value || '').trim(),
    providerName: presets[idx]?.providerName || '',
    provider: (el('settings-preset-provider')?.value || 'anthropic').trim(),
    model: (el('settings-preset-model')?.value || '').trim(),
    baseUrl: (el('settings-preset-baseurl')?.value || '').trim(),
    apiKey: (el('settings-preset-apikey')?.value || '').trim(),
    thinkingBudgetTokens: thinkingRaw !== '' ? parseInt(thinkingRaw, 10) || null : null,
    temperature: tempRaw !== '' ? parseFloat(tempRaw) || null : null,
    contextLength: contextLengthRaw !== '' ? parseInt(contextLengthRaw, 10) || null : null,
    countTokenPath: countTokenPathRaw || null,
  };
  presets[idx] = preset;
  window.ClawFW.settingsData.presets = presets;
  window.ClawFW.settingsEditing = null;
  await saveSettingsConfig();
}

async function applySettingsPreset(idx) {
  const presets = window.ClawFW.settingsData?.presets || [];
  const preset = presets[idx];
  if (!preset) return;
  const config = window.ClawFW.settingsData?.config || { defaultModel: {}, agent: {} };
  const defaultModel = {
    provider: preset.provider || 'anthropic',
    model: preset.model || '',
    baseUrl: preset.baseUrl || '',
    apiKey: preset.apiKey || '',
  };
  if (preset.thinkingBudgetTokens != null) {
    defaultModel.thinkingBudgetTokens = preset.thinkingBudgetTokens;
  }
  config.defaultModel = defaultModel;
  if (preset.temperature != null) {
    config.agent = config.agent || {};
    config.agent.temperature = preset.temperature;
  }
  try {
    const resp = await fetch('/protoclaw/model_config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config, presets }),
    });
    const result = await resp.json();
    window.ClawFW.settingsData.config = result.config;
    window.ClawFW.settingsData.presets = result.presets;
    window.ClawFW._modelPresets = Array.isArray(result?.presets) ? result.presets : [];
    renderSettingsOverlay();
  } catch (error) {
    console.error('Failed to save model config:', error);
  }
}

async function saveSettingsConfig() {
  const config = window.ClawFW.settingsData?.config || { defaultModel: {}, agent: {} };
  const presets = window.ClawFW.settingsData?.presets || [];
  try {
    const resp = await fetch('/protoclaw/model_config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config, presets }),
    });
    const result = await resp.json();
    window.ClawFW.settingsData.config = result.config;
    window.ClawFW.settingsData.presets = result.presets;
    window.ClawFW._modelPresets = Array.isArray(result?.presets) ? result.presets : [];
    renderSettingsOverlay();
  } catch (error) {
    console.error('Failed to save config:', error);
  }
}

function renderProjectListBlock(agent, block) {
  const st = window.ClawFW;
  const formId = String(block?.assemblySelection?.formId || 'assembly-form');

  if (st.mode === 'detail' && st._projectId) {
    return renderFWDetail(agent, block, formId, st);
  }
  return renderFWList(agent, block, formId);
}

function fwRerender() {
  currentWorkspaceTab = 'workspace';
  // When the prompt editor contentEditable dialog is open, skip full re-render
  // to preserve cursor position and input state.
  if (window.ClawFW.promptEditorOpen && document.querySelector('.fw-prompt-editor.fe-prompt-ce')) {
    return;
  }
  if (typeof renderCurrentMainView === 'function') renderCurrentMainView();
}

function fwEnterDetail(projectId, section) {
  const st = window.ClawFW;
  st.mode = 'detail';
  st._projectId = projectId;
  st.section = section || 'features';
  fwRerender();
}

function fwBackToList() {
  window.ClawFW.mode = 'list';
  window.ClawFW.section = 'features';
  fwRerender();
}

function fwSwitchSection(section) {
  window.ClawFW.section = section;
  const isOrchestrate = section === 'orchestrate';
  const root = document.querySelector('.fw-detail, .fw-detail-orchestrate');
  if (root) {
    root.classList.toggle('fw-detail', !isOrchestrate);
    root.classList.toggle('fw-detail-orchestrate', isOrchestrate);
  }
  const sectionOrder = ['features', 'config', 'orchestrate'];
  const activeIndex = sectionOrder.indexOf(section);
  document.querySelectorAll('.fw-detail-toggle .fw-toggle').forEach((button, index) => {
    button.classList.toggle('active', index === activeIndex);
  });
  ['features', 'config', 'orchestrate'].forEach((key) => {
    const pane = document.querySelector('.fw-pane-' + key);
    if (pane) pane.hidden = key !== section;
  });
  if (isOrchestrate) {
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  }
}

function fwOpenPromptEditor() {
  const sp = window.ClawFW.fwSlashPicker;
  sp.open = false; sp.query = ''; sp.activeIndex = 0; sp.category = 'all';
  window.ClawFW.promptEditorOpen = true;
  fwRerender();
}

function fwClosePromptEditor() {
  // commit final text from contentEditable
  const ce = document.querySelector('.fw-prompt-editor.fe-prompt-ce');
  if (ce) {
    const U = window.PromptEditorUtils;
    const rawText = U ? U.htmlToPrompt(ce) : ce.innerText;
    const formId = ce.getAttribute('data-fw-form-id');
    if (formId) {
      window.updateFWPromptDraft(formId, rawText);
      window.commitAssemblyDraftField(formId, 'custom_system_prompt', rawText);
    }
  }
  window.ClawFW.promptEditorOpen = false;
  window.ClawFW.fwSlashPicker.open = false;
  window.ClawFW.fwSlashPicker.query = '';
  fwRerender();
}

// ── FW Prompt Editor: slash picker helpers ───────────────────────

const FW_PICKER_CATEGORIES = ['all', 'template', 'variable'];
const FW_PICKER_CAT_LABELS = {
  all: currentLanguage === 'zh' ? '全部' : 'All',
  template: currentLanguage === 'zh' ? '模板' : 'Templates',
  variable: currentLanguage === 'zh' ? '变量' : 'Variables',
};

function fwCollectPickerItems() {
  const U = window.PromptEditorUtils;
  if (!U) return [];
  const caps = U.getCapabilities();
  const items = [];
  const seen = new Set();
  function addItem(item) {
    const key = [item.type, item.key, item.insertText].join('::');
    if (seen.has(key)) return;
    seen.add(key);
    items.push(item);
  }
  (caps.variables || []).forEach(v => {
    if (!v?.key) return;
    addItem({ type: 'variable', key: String(v.key), title: String(v.title || v.key), description: String(v.description || ''), featureName: String(v.featureName || ''), insertText: '{{' + String(v.key) + '}}' });
  });
  (caps.nodeTemplates || []).forEach(t => {
    if (!t?.id || !t.prompt) return;
    addItem({ type: 'template', key: String(t.id), title: String(t.name || t.id), description: String(t.description || ''), featureName: String(t.featureName || t.packageName || ''), insertText: String(t.prompt) });
  });
  (caps.modes || []).forEach(m => {
    if (!Array.isArray(m.suggestedPromptFragments)) return;
    m.suggestedPromptFragments.forEach(f => {
      if (!f?.id) return;
      addItem({ type: 'fragment', key: String(f.id), title: String(f.title || f.id), description: String(f.description || ''), featureName: String(m.featureName || ''), insertText: String(f.template || '') });
    });
  });
  return items;
}

function fwFilterPickerItems(items, query) {
  if (!query) return items.slice(0, 60);
  const q = query.toLowerCase();
  return items.filter(item => [item.title, item.key, item.description, item.featureName].join(' ').toLowerCase().indexOf(q) >= 0).slice(0, 60);
}

function fwApplyCategoryFilter(items) {
  const cat = window.ClawFW.fwSlashPicker.category || 'all';
  if (cat === 'all') return items;
  if (cat === 'template') return items.filter(it => it.type === 'template' || it.type === 'fragment');
  if (cat === 'variable') return items.filter(it => it.type === 'variable');
  return items;
}

function fwRenderPickerDropdown() {
  const host = document.getElementById('fw-prompt-picker-host');
  if (!host) return;
  const sp = window.ClawFW.fwSlashPicker;
  if (!sp.open) { host.innerHTML = ''; return; }
  const U = window.PromptEditorUtils;
  const query = sp.query || '';
  const allItems = fwFilterPickerItems(fwCollectPickerItems(), query);
  const items = fwApplyCategoryFilter(allItems);
  let listEl = host.querySelector('.fw-picker-list');
  let searchEl = host.querySelector('.fw-picker-search');
  if (!host.querySelector('.fw-prompt-picker')) {
    host.innerHTML = '<div class="fw-prompt-picker">'
      + '<div class="fw-picker-search-wrap"><input class="fw-picker-search" value="' + escapeHtml(query) + '" placeholder="' + escapeHtml(currentLanguage === 'zh' ? '搜索变量或片段…' : 'Search…') + '" oninput="window.fwSetPickerSearch(this.value)" onkeydown="window.fwHandlePromptKeydown(event)"></div>'
      + '<div class="fw-picker-tabs"></div>'
      + '<div class="fw-picker-list"></div>'
      + '</div>';
    listEl = host.querySelector('.fw-picker-list');
    searchEl = host.querySelector('.fw-picker-search');
  }
  if (searchEl && document.activeElement !== searchEl) searchEl.value = query;
  // render tabs
  const tabsEl = host.querySelector('.fw-picker-tabs');
  if (tabsEl) {
    const curCat = sp.category || 'all';
    const tabCounts = { all: allItems.length, template: 0, variable: 0 };
    allItems.forEach(it => { if (it.type === 'variable') tabCounts.variable++; else tabCounts.template++; });
    let tabsHtml = '';
    FW_PICKER_CATEGORIES.forEach(cat => {
      tabsHtml += '<button type="button" class="fw-picker-tab' + (cat === curCat ? ' active' : '') + '" onmousedown="event.preventDefault()" onclick="window.fwSetPickerCategory(\'' + cat + '\')">'
        + FW_PICKER_CAT_LABELS[cat] + ' <span class="fw-picker-tab-count">' + tabCounts[cat] + '</span></button>';
    });
    tabsEl.innerHTML = tabsHtml;
  }
  if (!items.length) {
    if (listEl) listEl.innerHTML = '<div class="fw-picker-empty">' + escapeHtml(currentLanguage === 'zh' ? '没有匹配项' : 'No matches') + '</div>';
    return;
  }
  const grouped = {};
  items.forEach(item => { const g = U.shortFeatureName(item.featureName) || (currentLanguage === 'zh' ? '其他' : 'Other'); if (!grouped[g]) grouped[g] = []; grouped[g].push(item); });
  let html = '';
  let idx = 0;
  Object.keys(grouped).forEach(group => {
    html += '<div class="fw-picker-group-header">' + escapeHtml(group) + '</div>';
    grouped[group].forEach(item => {
      const i = idx++;
      const isVar = item.type === 'variable';
      const isTpl = item.type === 'template';
      const icon = isVar ? '{ }' : (isTpl ? '&#9638;' : '&#9998;');
      const label = isVar ? (currentLanguage === 'zh' ? '变量' : 'Var') : (isTpl ? (currentLanguage === 'zh' ? '模板' : 'Tpl') : (currentLanguage === 'zh' ? '片段' : 'Snip'));
      const titleHtml = U.highlightMatch(item.title, query);
      const descHtml = item.description ? '<div class="fw-picker-item-preview">' + U.highlightMatch(item.description, query) + '</div>' : '';
      html += '<div class="fw-picker-item' + (i === sp.activeIndex ? ' active' : '') + '" data-picker-index="' + i + '" onmousedown="event.preventDefault()" onclick="window.fwClickPickerItem(' + i + ')">'
        + '<div class="fw-picker-item-main">'
        + '<span class="fw-picker-item-icon' + (isVar ? ' var-icon' : ' frag-icon') + '">' + icon + '</span>'
        + '<div class="fw-picker-item-text"><div class="fw-picker-item-title">' + titleHtml + '</div>' + descHtml + '</div>'
        + '</div>'
        + '<span class="fw-picker-item-badge' + (isVar ? ' var-badge' : ' frag-badge') + '">' + escapeHtml(label) + '</span>'
        + '</div>';
    });
  });
  if (listEl) listEl.innerHTML = html;
  // auto-scroll active item
  if (listEl && sp.activeIndex >= 0) {
    const activeEl = listEl.querySelector('.fw-picker-item.active');
    if (activeEl) activeEl.scrollIntoView({ block: 'nearest' });
  }
}

window.fwHandlePromptInput = (e) => {
  const U = window.PromptEditorUtils;
  if (!U) return;
  const ce = e.target;
  const rawText = U.htmlToPrompt(ce);
  const formId = ce.getAttribute('data-fw-form-id');
  if (formId) window.updateFWPromptDraft(formId, rawText);
  const cursorOffset = U.getPromptCursorOffset(ce);
  const trigger = U.detectSlashTrigger(rawText, cursorOffset >= 0 ? cursorOffset : rawText.length);
  const sp = window.ClawFW.fwSlashPicker;
  sp.formId = formId;
  if (trigger) {
    sp.open = true; sp.query = trigger.query; sp.startIndex = trigger.startIndex; sp.activeIndex = 0;
  } else if (sp.open) {
    sp.open = false; sp.query = '';
  }
  fwRenderPickerDropdown();
};

window.fwHandlePromptKeydown = (e) => {
  const U = window.PromptEditorUtils;
  if (!U) return;
  const sp = window.ClawFW.fwSlashPicker;
  // Backspace: delete variable chip
  if (e.key === 'Backspace' && !sp.open) {
    const ce = document.querySelector('.fw-prompt-editor.fe-prompt-ce');
    if (ce && (document.activeElement === ce || ce.contains(document.activeElement))) {
      const chip = U.findPrevVarChip(ce);
      if (chip) {
        e.preventDefault();
        chip.remove();
        const rawText = U.htmlToPrompt(ce);
        const formId = ce.getAttribute('data-fw-form-id');
        if (formId) window.updateFWPromptDraft(formId, rawText);
        return;
      }
    }
  }
  if (sp.open) {
    const allItems = fwFilterPickerItems(fwCollectPickerItems(), sp.query);
    const items = fwApplyCategoryFilter(allItems);
    if (e.key === 'Escape') {
      e.preventDefault(); sp.open = false; sp.query = ''; fwRenderPickerDropdown(); return;
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      let curIdx = FW_PICKER_CATEGORIES.indexOf(sp.category || 'all');
      curIdx = e.key === 'ArrowRight' ? (curIdx + 1) % FW_PICKER_CATEGORIES.length : (curIdx - 1 + FW_PICKER_CATEGORIES.length) % FW_PICKER_CATEGORIES.length;
      sp.category = FW_PICKER_CATEGORIES[curIdx]; sp.activeIndex = 0;
      fwRenderPickerDropdown(); return;
    }
    if (items.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); sp.activeIndex = (sp.activeIndex + 1) % items.length; fwRenderPickerDropdown(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); sp.activeIndex = (sp.activeIndex - 1 + items.length) % items.length; fwRenderPickerDropdown(); return; }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const item = items[sp.activeIndex];
        if (item) fwInsertPickerItem(item);
        return;
      }
    }
  }
};

function fwInsertPickerItem(item) {
  const U = window.PromptEditorUtils;
  if (!U) return;
  const ce = document.querySelector('.fw-prompt-editor.fe-prompt-ce');
  if (!ce) return;
  const rawText = U.htmlToPrompt(ce);
  const cursorOffset = U.getPromptCursorOffset(ce);
  const offset = cursorOffset >= 0 ? cursorOffset : rawText.length;
  const trigger = U.detectSlashTrigger(rawText, offset);
  if (!trigger) return;
  const before = rawText.substring(0, trigger.startIndex);
  const after = rawText.substring(offset);
  const newText = before + item.insertText + after;
  const formId = ce.getAttribute('data-fw-form-id');
  if (formId) window.updateFWPromptDraft(formId, newText);
  const sp = window.ClawFW.fwSlashPicker;
  sp.open = false; sp.query = '';
  const savedOffset = before.length + item.insertText.length;
  ce.innerHTML = U.promptToHTML(newText);
  U.setPromptCursorOffset(ce, savedOffset);
  fwRenderPickerDropdown();
}

window.fwClickPickerItem = (index) => {
  const sp = window.ClawFW.fwSlashPicker;
  const allItems = fwFilterPickerItems(fwCollectPickerItems(), sp.query);
  const items = fwApplyCategoryFilter(allItems);
  const item = items[index];
  if (item) fwInsertPickerItem(item);
};

window.fwSetPickerCategory = (cat) => {
  window.ClawFW.fwSlashPicker.category = cat;
  window.ClawFW.fwSlashPicker.activeIndex = 0;
  fwRenderPickerDropdown();
};

window.fwSetPickerSearch = (value) => {
  window.ClawFW.fwSlashPicker.query = value || '';
  window.ClawFW.fwSlashPicker.activeIndex = 0;
  fwRenderPickerDropdown();
};

window.updateFWPromptDraft = (formId, value) => {
  const agent = getCurrentAgentRecord();
  if (!agent?.id) return;
  const draft = getWorkspaceFormDraft(agent);
  draft[formId] = draft[formId] || {};
  draft[formId].custom_system_prompt = value;
  saveWorkspaceFormDraft(agent.id, draft);
};

function rememberFWFeatureScroll() {
  const list = document.querySelector('.fw-feat-list');
  window.ClawFW.featureScrollTop = list ? list.scrollTop : 0;
}

function restoreFWFeatureScroll() {
  const top = Number(window.ClawFW.featureScrollTop || 0);
  requestAnimationFrame(() => {
    const list = document.querySelector('.fw-feat-list');
    if (list) list.scrollTop = top;
  });
}

async function fwToggleFeature(formId, token) {
  rememberFWFeatureScroll();
  await window.toggleWorkspaceSelection(formId, 'selected_features', token);
  restoreFWFeatureScroll();
}

function fwSetFeatureFilter(formId, value) {
  window.commitAssemblyDraftField(formId, 'feature_source_filter', value);
}

function fwSetFeatureQuery(formId, value) {
  window.ClawFW.featureQuery = String(value || '');
  fwFilterFeatureList();
}

function fwCommitFeatureQuery(formId, value) {
  const query = String(value || '');
  window.ClawFW.featureQuery = query;
  updateAssemblyDraftWithoutRender(formId, 'feature_query', query);
  const agent = getCurrentAgentRecord();
  if (!agent?.id) return;
  const draft = getWorkspaceFormDraft(agent);
  persistWorkspaceState(agent, draft).catch((error) => {
    console.error('Failed to persist feature search query:', error);
  });
}

function fwFilterFeatureList() {
  const query = String(window.ClawFW.featureQuery || '').trim().toLowerCase();
  const list = document.querySelector('.fw-feat-list');
  const head = document.querySelector('[data-fw-feature-count]');
  if (!list) return;
  let visible = 0;
  list.querySelectorAll('.fw-feat').forEach((card) => {
    const haystack = String(card.getAttribute('data-fw-feature-search') || '').toLowerCase();
    const matched = !query || haystack.includes(query);
    card.hidden = !matched;
    if (matched) visible += 1;
  });
  const empty = list.querySelector('[data-fw-feature-empty]');
  if (empty) empty.hidden = visible !== 0;
  if (head) {
    const total = Number(head.getAttribute('data-total') || 0);
    const mounted = Number(head.getAttribute('data-mounted') || 0);
    head.textContent = (currentLanguage === 'zh' ? '当前显示 ' : 'Showing ')
      + visible + ' / ' + total
      + (currentLanguage === 'zh' ? `，已挂载 ${mounted}` : `, mounted ${mounted}`);
  }
}

async function fwOpenFeatureImport(formId) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.tgz';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const formData = new FormData();
      formData.append('file', file);
      const response = await fetch('/protoclaw/feature_repository/parse_upload', { method: 'POST', body: formData });
      if (!response.ok) throw new Error(await response.text().catch(() => 'parse upload failed'));
      const parsed = await response.json();
      window.ClawFW.featureImport = { ...parsed, formId };
      fwRerender();
    } catch (error) {
      window.alert((currentLanguage === 'zh' ? '解析 tgz 失败：' : 'Failed to parse tgz: ') + (error?.message || error));
    }
  };
  input.click();
}

async function fwCancelFeatureImport() {
  const uploadId = window.ClawFW.featureImport?.uploadId;
  window.ClawFW.featureImport = null;
  if (uploadId) {
    await fetch('/protoclaw/feature_repository/cancel_import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploadId }),
    }).catch(() => {});
  }
  fwRerender();
}

async function fwConfirmFeatureImport(mode) {
  const pending = window.ClawFW.featureImport;
  if (!pending?.uploadId) return;
  try {
    const response = await fetch('/protoclaw/feature_repository/confirm_import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploadId: pending.uploadId }),
    });
    if (!response.ok) throw new Error(await response.text().catch(() => 'import failed'));
    const result = await response.json();
    const token = result?.summary?.packageName || result?.summary?.id || pending?.summary?.packageName || pending?.summary?.id || '';
    window.ClawFW.featureImport = null;
    await loadAgents().catch(() => {});
    if (mode === 'mount' && token) {
      await fwToggleFeature(pending.formId || 'assembly-form', token);
    } else {
      fwRerender();
    }
  } catch (error) {
    window.alert((currentLanguage === 'zh' ? '导入失败：' : 'Import failed: ') + (error?.message || error));
  }
}

function fwOpenProjectPicker() {
  window.ClawFW.projectPickerOpen = true;
  fwRerender();
}

function fwCloseProjectPicker() {
  window.ClawFW.projectPickerOpen = false;
  fwRerender();
}

function fwSelectProject(projectId) {
  window.ClawFW.projectPickerOpen = false;
  window.loadSavedAssemblyConfig(projectId).then(function() { fwEnterDetail(projectId, window.ClawFW.section || 'features'); });
}

window.fwCreateNewAgent = function() {
  fwOpenCreateDialog();
};

window.fwOpenProjectDetail = async function(projectId) {
  await window.loadSavedAssemblyConfig(projectId);
  fwEnterDetail(projectId, 'features');
};

function renderFWSwitchProjectDialog(agent, currentName) {
  if (!window.ClawFW.projectPickerOpen) return '';
  const configs = getSavedAssemblyConfigs(agent);
  const cards = configs.length
    ? configs.map(item => {
      const active = item.id === currentName;
      return [
        '<button class="fw-switch-modal-card' + (active ? ' active' : '') + '" type="button" onclick="fwSelectProject(\'' + escapeHtml(item.id) + '\')">',
        '<strong>' + escapeHtml(item.name || item.id) + '</strong>',
        '<span>' + escapeHtml([item.features.length + (currentLanguage === 'zh' ? ' 个 Feature' : ' Features'), item.goal || getAssemblyPresetLabel(item.preset) || ''].filter(Boolean).join(' · ')) + '</span>',
        '</button>',
      ].join('');
    }).join('')
    : '<div class="feature-detail-subtitle">' + escapeHtml(currentLanguage === 'zh' ? '还没有可切换的项目。' : 'No saved projects yet.') + '</div>';
  return [
    '<div class="feature-detail-overlay" onclick="if (event.target === this) fwCloseProjectPicker()">',
    '<div class="feature-detail-window">',
    '<div class="feature-detail-head">',
    '<div>',
    '<div class="feature-detail-title">' + escapeHtml(currentLanguage === 'zh' ? '切换 Agent 项目' : 'Switch Agent Project') + '</div>',
    '<div class="feature-detail-subtitle">' + escapeHtml(currentLanguage === 'zh' ? '选择一个项目继续配置能力或编辑编排图。' : 'Choose a project to configure capabilities or edit its graph.') + '</div>',
    '</div>',
    '<button class="feature-detail-close" type="button" title="' + escapeHtml(t('panel_close')) + '" onclick="fwCloseProjectPicker()">×</button>',
    '</div>',
    '<div class="fw-switch-modal-list">' + cards + '</div>',
    '</div>',
    '</div>',
  ].join('');
}

function fwOpenCreateDialog() {
  window.ClawFW.createDialogOpen = true;
  fwRerender();
  requestAnimationFrame(() => {
    const input = document.getElementById('fw-create-folder-name');
    if (input) input.focus();
  });
}

function fwCloseCreateDialog() {
  window.ClawFW.createDialogOpen = false;
  fwRerender();
}

window.fwConfirmCreateAgent = async function() {
  const folderInput = document.getElementById('fw-create-folder-name');
  const displayInput = document.getElementById('fw-create-display-name');
  const folderName = String(folderInput?.value || '').trim();
  const displayName = String(displayInput?.value || '').trim();
  if (!isValidAgentCreatorName(folderName)) {
    window.alert(currentLanguage === 'zh' ? '项目标识必须以小写字母开头，只允许小写字母、数字和连字符。' : 'Project ID must start with a lowercase letter and contain only lowercase letters, numbers, and hyphens.');
    return;
  }
  const agent = getCurrentAgentRecord();
  if (agent) {
    const configs = getSavedAssemblyConfigs(agent);
    if (configs.some(c => c.id === folderName)) {
      window.alert(currentLanguage === 'zh' ? `项目 "${folderName}" 已存在，请使用其他标识。` : `Project "${folderName}" already exists. Choose a different ID.`);
      return;
    }
  }
  window.ClawFW.createDialogOpen = false;
  await window.resetAssemblyDraft();
  const draft = getWorkspaceFormDraft(getCurrentAgentRecord());
  draft['assembly-form'] = normalizeAssemblyDraft({
    ...(draft['assembly-form'] || {}),
    assembly_name: folderName,
    display_name: displayName,
    editing_config_id: folderName,
  });
  saveWorkspaceFormDraft(getCurrentAgentRecord().id, draft);
  try {
    await persistWorkspaceState(getCurrentAgentRecord(), draft);
  } catch (error) {
    console.error('Failed to save new project:', error);
  }
  fwEnterDetail(folderName, 'features');
};

function renderFWCreateDialog() {
  if (!window.ClawFW.createDialogOpen) return '';
  return [
    '<div class="feature-detail-overlay" onclick="if(event.target===this)fwCloseCreateDialog()">',
    '<div class="feature-detail-window" style="width:min(100%,480px);">',
    '<div class="feature-detail-head">',
    '<div>',
    '<div class="feature-detail-title">' + escapeHtml(currentLanguage === 'zh' ? '创建新 Agent 项目' : 'Create New Agent Project') + '</div>',
    '<div class="feature-detail-subtitle">' + escapeHtml(currentLanguage === 'zh' ? '设置项目标识和显示名称后进入配置界面。标识创建后不可修改。' : 'Set the project ID and display name before entering the editor. The ID cannot be changed after creation.') + '</div>',
    '</div>',
    '<button class="feature-detail-close" type="button" title="' + escapeHtml(t('panel_close')) + '" onclick="fwCloseCreateDialog()">×</button>',
    '</div>',
    '<div class="fw-create-fields">',
    '<div class="fw-field">',
    '<label>' + escapeHtml(currentLanguage === 'zh' ? '项目标识' : 'Project ID') + '</label>',
    '<input id="fw-create-folder-name" class="fw-input" placeholder="my-agent" pattern="[a-z][a-z0-9-]*" onkeydown="if(event.key===\'Enter\')window.fwConfirmCreateAgent()">',
    '<span class="fw-name-lock-hint">' + escapeHtml(currentLanguage === 'zh' ? '用于文件夹名和环境绑定，创建后不可修改' : 'Used for directory and environment binding. Cannot be changed.') + '</span>',
    '</div>',
    '<div class="fw-field">',
    '<label>' + escapeHtml(currentLanguage === 'zh' ? '显示名称' : 'Display Name') + '</label>',
    '<input id="fw-create-display-name" class="fw-input" placeholder="My Agent" onkeydown="if(event.key===\'Enter\')window.fwConfirmCreateAgent()">',
    '<span class="fw-name-lock-hint">' + escapeHtml(currentLanguage === 'zh' ? '在对话和界面中展示，可随时修改' : 'Shown in conversations and UI. Can be changed anytime.') + '</span>',
    '</div>',
    '</div>',
    '<div class="workspace-actions" style="margin-top:16px;justify-content:flex-end;">',
    '<button class="workspace-action secondary" type="button" onclick="fwCloseCreateDialog()">' + escapeHtml(currentLanguage === 'zh' ? '取消' : 'Cancel') + '</button>',
    '<button class="workspace-action" type="button" onclick="window.fwConfirmCreateAgent()">' + escapeHtml(currentLanguage === 'zh' ? '创建并继续' : 'Create & Continue') + '</button>',
    '</div>',
    '</div>',
    '</div>',
  ].join('');
}

function fwOpenConfirmDialog(opts) {
  window.ClawFW.confirmDialog = {
    title: opts.title || '',
    message: opts.message || '',
    confirmLabel: opts.confirmLabel || (currentLanguage === 'zh' ? '确认' : 'Confirm'),
    cancelLabel: opts.cancelLabel || (currentLanguage === 'zh' ? '取消' : 'Cancel'),
    danger: !!opts.danger,
    onConfirm: opts.onConfirm || null,
  };
  fwRerender();
}

function fwCloseConfirmDialog() {
  window.ClawFW.confirmDialog = null;
  fwRerender();
}

function fwHandleConfirm() {
  const dialog = window.ClawFW.confirmDialog;
  const callback = dialog?.onConfirm || null;
  window.ClawFW.confirmDialog = null;
  fwRerender();
  if (typeof callback === 'function') callback();
}

function renderFWConfirmDialog() {
  const dialog = window.ClawFW.confirmDialog;
  if (!dialog) return '';
  return [
    '<div class="feature-detail-overlay" onclick="if(event.target===this)fwCloseConfirmDialog()">',
    '<div class="feature-detail-window" style="width:min(100%,420px);">',
    '<div class="feature-detail-head">',
    '<div>',
    '<div class="feature-detail-title">' + escapeHtml(dialog.title) + '</div>',
    '<div class="feature-detail-subtitle">' + escapeHtml(dialog.message) + '</div>',
    '</div>',
    '<button class="feature-detail-close" type="button" title="' + escapeHtml(t('panel_close')) + '" onclick="fwCloseConfirmDialog()">×</button>',
    '</div>',
    '<div class="workspace-actions" style="margin-top:16px;justify-content:flex-end;">',
    '<button class="workspace-action secondary" type="button" onclick="fwCloseConfirmDialog()">' + escapeHtml(dialog.cancelLabel) + '</button>',
    '<button class="' + (dialog.danger ? 'workspace-action danger' : 'workspace-action') + '" type="button" onclick="fwHandleConfirm()">' + escapeHtml(dialog.confirmLabel) + '</button>',
    '</div>',
    '</div>',
    '</div>',
  ].join('');
}

function renderFWPromptDialog(agent, formId, draft) {
  if (!window.ClawFW.promptEditorOpen) return '';
  const U = window.PromptEditorUtils;
  if (!U) return '';
  const caps = U.getCapabilities();
  const vars = Array.isArray(caps.variables) ? caps.variables : [];
  const templates = Array.isArray(caps.nodeTemplates) ? caps.nodeTemplates : [];
  const modes = Array.isArray(caps.modes) ? caps.modes : [];
  const fragCount = modes.reduce((s, m) => s + (Array.isArray(m.suggestedPromptFragments) ? m.suggestedPromptFragments.length : 0), 0);
  const varCount = vars.length;
  const tplCount = templates.length + fragCount;
  const rawText = String(draft.custom_system_prompt || '');
  const htmlContent = U.promptToHTML(rawText);
  return [
    '<div class="feature-detail-overlay" onkeydown="event.stopPropagation()">',
    '<div class="feature-detail-window" style="width:min(100%,780px);max-height:min(100%,780px);">',
    '<div class="feature-detail-head">',
    '<div>',
    '<div class="feature-detail-title">' + escapeHtml(currentLanguage === 'zh' ? '编辑系统提示词' : 'Edit System Prompt') + '</div>',
    '<div class="feature-detail-subtitle">' + escapeHtml(currentLanguage === 'zh' ? '输入 / 插入变量或模板片段。变量以块显示，模板与片段插入后展开为纯文本。' : 'Type / to insert variables or template fragments. Variables appear as blocks, templates expand to plain text.') + '</div>',
    '</div>',
    '<button class="feature-detail-close" type="button" title="' + escapeHtml(t('panel_close')) + '" onclick="fwClosePromptEditor()">×</button>',
    '</div>',
    '<div class="fw-prompt-editor-wrap">',
    '<div class="fw-prompt-editor fe-prompt-ce" contenteditable="true" autofocus data-fw-form-id="' + escapeHtml(formId) + '" oninput="window.fwHandlePromptInput(event)" onkeydown="window.fwHandlePromptKeydown(event)">' + htmlContent + '</div>',
    '<div id="fw-prompt-picker-host"></div>',
    '</div>',
    '<div class="fe-prompt-footer">',
    '<div class="fe-prompt-footer-hint">',
    '<span>' + escapeHtml(currentLanguage === 'zh' ? '输入 / 可插入 ' : 'Type / to insert ') + '</span><span class="fe-prompt-footer-count">' + varCount + '</span><span>' + escapeHtml(currentLanguage === 'zh' ? ' 个变量' : ' variables') + '</span>',
    '<span class="fe-prompt-footer-sep">·</span>',
    '<span class="fe-prompt-footer-count">' + tplCount + '</span><span>' + escapeHtml(currentLanguage === 'zh' ? ' 个模板/片段' : ' templates/fragments') + '</span>',
    '</div>',
    '<button class="fe-prompt-footer-done" type="button" onclick="fwClosePromptEditor()">' + escapeHtml(currentLanguage === 'zh' ? '完成编辑' : 'Done') + '</button>',
    '</div>',
    '</div>',
    '</div>',
  ].join('');
}

function renderFWFeatureImportDialog() {
  const pending = window.ClawFW.featureImport;
  if (!pending) return '';
  const summary = pending.summary || {};
  const warnings = Array.isArray(summary.warnings) ? summary.warnings : [];
  const featureTypes = Array.isArray(summary.featureTypes) ? summary.featureTypes : [];
  return [
    '<div class="feature-detail-overlay" onclick="if (event.target === this) fwCancelFeatureImport()">',
    '<div class="feature-detail-window">',
    '<div class="feature-detail-head">',
    '<div>',
    '<div class="feature-detail-title">' + escapeHtml(currentLanguage === 'zh' ? '解析 Feature 包' : 'Parsed Feature Package') + '</div>',
    '<div class="feature-detail-subtitle">' + escapeHtml(currentLanguage === 'zh' ? '确认解析结果后再决定是否导入。' : 'Review the parsed metadata before importing.') + '</div>',
    '</div>',
    '<button class="feature-detail-close" type="button" title="' + escapeHtml(t('panel_close')) + '" onclick="fwCancelFeatureImport()">×</button>',
    '</div>',
    '<div class="fw-import-result">',
    '<div class="fw-import-card">',
    '<div class="fw-import-title">' + escapeHtml(summary.name || summary.id || summary.fileName || '-') + '</div>',
    '<div class="fw-import-meta">' + escapeHtml([summary.packageName, summary.latestVersion || summary.version, summary.fileName, formatRepoFileSize(summary.size)].filter(Boolean).join(' · ')) + '</div>',
    summary.description ? '<div class="fw-import-meta">' + escapeHtml(summary.description) + '</div>' : '',
    featureTypes.length ? '<div class="workspace-tag-list">' + featureTypes.map(type => '<span class="workspace-tag">' + escapeHtml(getFeatureTypeLabel(type)) + '</span>').join('') + '</div>' : '',
    '</div>',
    warnings.length ? '<div class="fw-import-warning">' + warnings.map(item => escapeHtml(item)).join('<br>') + '</div>' : '',
    '<div class="workspace-actions" style="justify-content:flex-end;">',
    '<button class="workspace-action secondary" type="button" onclick="fwCancelFeatureImport()">' + escapeHtml(currentLanguage === 'zh' ? '取消' : 'Cancel') + '</button>',
    '<button class="workspace-action" type="button" onclick="fwConfirmFeatureImport(\'mount\')">' + escapeHtml(currentLanguage === 'zh' ? '导入' : 'Import') + '</button>',
    '<button class="workspace-action secondary" type="button" onclick="fwConfirmFeatureImport(\'repo\')">' + escapeHtml(currentLanguage === 'zh' ? '导入并添加到仓库' : 'Import to Repository') + '</button>',
    '</div>',
    '</div>',
    '</div>',
    '</div>',
  ].join('');
}

function groupAssemblyRunsByProject(agent, configs, runs) {
  const groups = new Map();
  configs.forEach(config => {
    groups.set(config.id, {
      id: config.id,
      name: config.name || config.id,
      goal: config.goal || getAssemblyPresetLabel(config.preset) || '',
      features: config.features || [],
      runs: [],
      updatedAt: config.updatedAt || '',
    });
  });
  runs.forEach(run => {
    const key = String(run.agentName || run.assemblyName || run.title || 'unknown').trim() || 'unknown';
    if (!groups.has(key)) {
      groups.set(key, {
        id: key,
        name: key === 'unknown' ? (currentLanguage === 'zh' ? '未归档运行' : 'Unsorted Runs') : key,
        goal: '',
        features: [],
        runs: [],
        updatedAt: run.updatedAt || run.createdAt || '',
      });
    }
    groups.get(key).runs.push(run);
  });
  return [...groups.values()]
    .filter(group => group.runs.length > 0)
    .sort((left, right) => String(right.runs[0]?.updatedAt || right.updatedAt || '').localeCompare(String(left.runs[0]?.updatedAt || left.updatedAt || '')));
}

function renderFWList(agent, block, formId) {
  const configs = getSavedAssemblyConfigs(agent).slice(0, 20);
  const runs = getWorkspaceSessions(agent)
    .filter(s => String(s?.formId || '') === 'assembly-form');

  let html = '<div class="fw">';
  html += '<div class="fw-banner"><div>';
  html += '<div class="fw-banner-title">' + escapeHtml(currentLanguage === 'zh' ? 'Agent 工作空间' : 'Agent Workspace') + '</div>';
  html += '<div class="fw-banner-desc">' + escapeHtml(currentLanguage === 'zh' ? '创建 Agent 项目、配置能力、编排工作流、启动测试。' : 'Create Agent projects, configure capabilities, orchestrate workflows, and launch tests.') + '</div>';
  html += '</div>';
  html += '<button class="fw-btn" onclick="window.fwCreateNewAgent()">' + escapeHtml(currentLanguage === 'zh' ? '新建 Agent' : 'New Agent') + '</button>';
  html += '</div>';

  if (configs.length) {
    html += '<div class="fw-section"><h3>' + escapeHtml(currentLanguage === 'zh' ? '项目' : 'Projects') + '</h3>';
    html += '<div class="fw-grid">';
    configs.forEach(item => {
      const summary = getAssemblySavedConfigSummary(agent, item);
      const running = summary.runningCount > 0;
      html += '<div class="fw-card' + (running ? ' fw-live' : '') + '" data-prebuilt-project-agent-id="' + escapeHtml(agent.id) + '" data-prebuilt-project-id="' + escapeHtml(item.id) + '" onclick="window.fwOpenProjectDetail(\'' + escapeHtml(item.id) + '\')">';
      html += '<div class="fw-card-name">' + escapeHtml(item.name) + '</div>';
      html += '<div class="fw-card-desc">' + escapeHtml(item.goal || getAssemblyPresetLabel(item.preset) || '-') + '</div>';
      html += '<div class="fw-card-meta"><span>' + item.features.length + (currentLanguage === 'zh' ? ' Feature' : ' Features') + '</span>';
      if (running) html += '<span class="fw-green">' + escapeHtml(currentLanguage === 'zh' ? '运行中' : 'Running') + '</span>';
      html += '</div>';
      html += '<div class="fw-card-act">';
      html += '<button class="fw-btn fw-btn-primary" onclick="event.stopPropagation();window.fwLaunchConfig(\'' + escapeHtml(item.id) + '\',this)">' + escapeHtml(currentLanguage === 'zh' ? '启动' : 'Launch') + '</button>';
      html += '<button class="fw-btn" onclick="event.stopPropagation();window.fwOpenProjectDetail(\'' + escapeHtml(item.id) + '\')">' + escapeHtml(currentLanguage === 'zh' ? '编辑' : 'Edit') + '</button>';
      html += '</div></div>';
    });
    html += '</div></div>';
  } else {
    html += '<div class="fw-section"><h3>' + escapeHtml(currentLanguage === 'zh' ? '项目' : 'Projects') + '</h3><div class="fw-empty"><div>' + escapeHtml(currentLanguage === 'zh' ? '还没有项目' : 'No projects yet') + '</div>';
    html += '<button class="fw-btn" onclick="window.fwCreateNewAgent()">' + escapeHtml(currentLanguage === 'zh' ? '创建第一个' : 'Create first') + '</button></div></div>';
  }

  if (runs.length) {
    const runGroups = groupAssemblyRunsByProject(agent, configs, runs);
    html += '<div class="fw-section"><h3>' + escapeHtml(currentLanguage === 'zh' ? '对话记录' : 'Conversations') + '</h3><div class="fw-run-list">';
    runGroups.forEach((group, gi) => {
      const runningCount = group.runs.filter(item => isAssemblySessionRunning(agent, item)).length;
      html += '<details class="fw-run-project' + (gi % 2 === 1 ? ' fw-run-alt' : '') + '" open>';
      html += '<summary><div class="fw-run-head"><div><div class="fw-run-title">' + escapeHtml(group.name) + '</div>';
      html += '<div class="fw-run-meta">' + escapeHtml([runningCount ? (currentLanguage === 'zh' ? runningCount + ' 个运行中' : runningCount + ' running') : '', group.goal, group.features.length ? group.features.length + ' Feature' : ''].filter(Boolean).join(' · ')) + '</div></div>';
      html += '<span class="fw-run-count">' + escapeHtml(String(group.runs.length)) + '</span></div></summary>';
      html += '<div class="fw-run-body">';
      group.runs.forEach(item => {
        const running = isAssemblySessionRunning(agent, item);
        html += '<div class="fw-run-item" data-prebuilt-session-agent-id="' + escapeHtml(agent.id) + '" data-prebuilt-session-id="' + escapeHtml(item.id) + '">';
        html += '<div><div class="fw-run-item-title">' + escapeHtml(item.title || item.agentName || item.id) + '</div>';
        html += '<div class="fw-run-item-meta">' + escapeHtml([running ? (currentLanguage === 'zh' ? '运行中' : 'Running') : (currentLanguage === 'zh' ? '已停止' : 'Stopped'), formatWorkspaceDate(item.updatedAt || item.createdAt), item.openDirectory || ''].filter(Boolean).join(' · ')) + '</div></div>';
        html += '<div class="fw-card-act">';
        html += '<button class="fw-btn fw-btn-primary" onclick="window.fwResumeRun(\'' + escapeHtml(item.id) + '\',this)">' + escapeHtml(currentLanguage === 'zh' ? '继续' : 'Continue') + '</button>';
        if (running) html += '<button class="fw-btn" onclick="window.stopAssemblySessionRuntime(\'' + escapeHtml(item.id) + '\');setTimeout(fwRerender,200)">' + escapeHtml(currentLanguage === 'zh' ? '停止' : 'Stop') + '</button>';
        html += '</div></div>';
      });
      html += '</div></details>';
    });
    html += '</div></div>';
  }

  html += '</div>';
  html += renderFWCreateDialog();
  html += renderFWConfirmDialog();
  return html;
}

function resolveFeaturePackageRecord(packages, token) {
  const rawToken = String(token || '').trim();
  if (!rawToken) return null;
  const rawKeys = buildFeatureConfigLookupKeys(rawToken);
  return (packages || []).find((pkg) => {
    const candidates = [
      pkg?.packageName,
      pkg?.name,
      pkg?.id,
      String(pkg?.name || '').replace(/^@agentdev\//, ''),
    ].filter(Boolean);
    return candidates.some((value) => {
      const keys = buildFeatureConfigLookupKeys(value);
      for (const key of keys) {
        if (rawKeys.has(key)) return true;
      }
      return false;
    });
  }) || null;
}

function findFeatureManifestForSelection(caps, token, pkg) {
  const manifests = Array.isArray(caps?.featureManifests) ? caps.featureManifests : [];
  const candidates = [
    token,
    pkg?.packageName,
    pkg?.name,
    pkg?.id,
  ].filter(Boolean);
  return manifests.find((manifest) => {
    const manifestKeys = [
      manifest?.packageName,
      manifest?.featureName,
      manifest?.featureId,
    ].filter(Boolean);
    return candidates.some((value) => manifestKeys.some((key) => featureConfigKeyMatches(value, key)));
  }) || null;
}

function getFeatureManifestPropertyEntries(manifest) {
  const properties = manifest?.settings?.properties;
  return properties && typeof properties === 'object'
    ? Object.entries(properties).filter(([key, value]) => String(key || '').trim() && value && typeof value === 'object')
    : [];
}

function getFeatureManifestDisplayName(token, pkg, manifest) {
  const raw = String(pkg?.name || manifest?.featureName || manifest?.packageName || token || '').trim();
  return raw.replace(/^@agentdev\//, '').replace(/-feature$/, '');
}

function formatManifestDefaultValue(property) {
  if (!property || !Object.prototype.hasOwnProperty.call(property, 'default')) return currentLanguage === 'zh' ? '无默认值' : 'No default';
  const value = property.default;
  if (property.type === 'boolean') return value ? 'true' : 'false';
  if (property.type === 'directory') {
    if (Array.isArray(value) && value.length > 0) return value.join(', ');
    return currentLanguage === 'zh' ? '空' : 'Empty';
  }
  if (value === '' || value == null) return currentLanguage === 'zh' ? '空' : 'Empty';
  return String(value);
}

function normalizeManifestComparableValue(type, value) {
  if (type === 'number') {
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
  }
  if (type === 'boolean') {
    return value === true || value === 'true' || value === 1 || value === '1';
  }
  if (type === 'directory') {
    const dirs = Array.isArray(value) ? value : [];
    return dirs.slice().sort().join('|');
  }
  if (type === 'file' && Array.isArray(value)) {
    return value.slice().sort().join('|');
  }
  return String(value ?? '').trim();
}

function getFeatureConfigStatusMeta(manifest, config) {
  const entries = getFeatureManifestPropertyEntries(manifest);
  let overriddenCount = 0;
  entries.forEach(([field, property]) => {
    if (!Object.prototype.hasOwnProperty.call(config, field)) return;
    const currentValue = normalizeManifestComparableValue(property.type, config[field]);
    const defaultValue = normalizeManifestComparableValue(property.type, property.default);
    if (currentValue !== defaultValue) {
      overriddenCount += 1;
    }
  });
  return {
    overriddenCount,
    customized: overriddenCount > 0,
    label: overriddenCount > 0
      ? (currentLanguage === 'zh' ? `已自定义 ${overriddenCount} 项` : `${overriddenCount} override${overriddenCount > 1 ? 's' : ''}`)
      : (currentLanguage === 'zh' ? '使用默认值' : 'Using defaults'),
  };
}

function coerceFeatureManifestValue(type, rawValue) {
  if (type === 'boolean') return !!rawValue;
  if (type === 'number') {
    const text = String(rawValue ?? '').trim();
    if (!text) return undefined;
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (type === 'directory') {
    if (Array.isArray(rawValue)) return rawValue.filter(Boolean);
    if (typeof rawValue === 'string') {
      const trimmed = rawValue.trim();
      return trimmed ? [trimmed] : [];
    }
    return [];
  }
  if (type === 'file' && Array.isArray(rawValue)) {
    return rawValue.map((value) => String(value || '').trim()).filter(Boolean);
  }
  const text = String(rawValue ?? '').trim();
  return text ? text : undefined;
}

function parseInlineDataValue(rawValue) {
  if (rawValue == null) return '';
  const text = String(rawValue);
  if (!text) return '';
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function normalizeAcceptList(accept) {
  return (Array.isArray(accept) ? accept : [accept])
    .flatMap((value) => String(value || '').split(','))
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

function matchesFeatureConfigAccept(pathValue, accept) {
  const pathText = String(pathValue || '').trim().toLowerCase();
  if (!pathText) return true;
  const accepts = normalizeAcceptList(accept);
  if (!accepts.length) return true;
  const extensionMatch = pathText.match(/(\.[a-z0-9]+)$/i);
  const ext = extensionMatch ? extensionMatch[1].toLowerCase() : '';
  return accepts.some((rule) => {
    if (rule.startsWith('.')) {
      return ext === rule;
    }
    if (rule === 'audio/*') {
      return ['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac'].includes(ext);
    }
    if (/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(rule)) {
      const subtype = rule.split('/')[1];
      return ext === `.${String(subtype || '').replace(/^\./, '')}`;
    }
    return false;
  });
}

function featureControlDomId(featureKey, field, suffix = '') {
  const raw = `${String(featureKey || '')}__${String(field || '')}${suffix ? `__${suffix}` : ''}`;
  return 'fw-manifest-' + raw.replace(/[^a-z0-9_-]+/gi, '-');
}

function renderFeatureConfigControl(featureKey, field, property, currentValue) {
  const serializedFeatureKey = escapeHtml(JSON.stringify(String(featureKey || '')));
  const serializedField = escapeHtml(JSON.stringify(String(field || '')));
  const type = String(property?.type || 'string');
  const displayValue = currentValue !== undefined && currentValue !== null ? String(currentValue) : '';
  if (type === 'boolean') {
    return '<label class="fw-setting-boolean"><input type="checkbox"' + (currentValue === true || currentValue === 'true' ? ' checked' : '') + ' onchange="window.fwCommitFeatureConfigValue(JSON.parse(this.dataset.featureKey), JSON.parse(this.dataset.fieldName), \'boolean\', this.checked)" data-feature-key="' + serializedFeatureKey + '" data-field-name="' + serializedField + '"><span>' + escapeHtml(currentLanguage === 'zh' ? '启用此项' : 'Enabled') + '</span></label>';
  }
  if (type === 'select') {
    const options = Array.isArray(property?.options) ? property.options : [];
    let html = '<select class="fw-setting-select" data-feature-key="' + serializedFeatureKey + '" data-field-name="' + serializedField + '" onchange="window.fwCommitFeatureConfigValue(JSON.parse(this.dataset.featureKey), JSON.parse(this.dataset.fieldName), \'select\', this.value)">';
    html += '<option value="">' + escapeHtml(currentLanguage === 'zh' ? '使用默认值' : 'Use default') + '</option>';
    options.forEach((option) => {
      const optionValue = option && Object.prototype.hasOwnProperty.call(option, 'value') ? option.value : '';
      html += '<option value="' + escapeHtml(String(optionValue ?? '')) + '"' + (String(optionValue ?? '') === displayValue ? ' selected' : '') + '>' + escapeHtml(option?.label || String(optionValue ?? '')) + '</option>';
    });
    html += '</select>';
    return html;
  }
  if (type === 'number') {
    const hasRange = Number.isFinite(Number(property?.min)) || Number.isFinite(Number(property?.max));
    const min = Number.isFinite(Number(property?.min)) ? Number(property.min) : 0;
    const max = Number.isFinite(Number(property?.max)) ? Number(property.max) : 100;
    const step = Number.isFinite(Number(property?.step)) && Number(property.step) > 0 ? Number(property.step) : 1;
    if (hasRange) {
      const rangeId = featureControlDomId(featureKey, field, 'range');
      const numberId = featureControlDomId(featureKey, field, 'number');
      const rawCurrent = displayValue || String(property?.default ?? min);
      return [
        '<div class="fw-setting-range-row">',
        '<input class="fw-setting-range" id="' + escapeHtml(rangeId) + '" type="range" min="' + escapeHtml(String(min)) + '" max="' + escapeHtml(String(max)) + '" step="' + escapeHtml(String(step)) + '" value="' + escapeHtml(rawCurrent) + '"',
        ' data-feature-key="' + serializedFeatureKey + '" data-field-name="' + serializedField + '"',
        ' oninput="window.fwSyncManifestRange(' + escapeHtml(JSON.stringify(numberId)) + ', this.value)"',
        ' onchange="window.fwCommitFeatureConfigValue(JSON.parse(this.dataset.featureKey), JSON.parse(this.dataset.fieldName), \'number\', this.value)">',
        '<input class="fw-setting-input fw-setting-number" id="' + escapeHtml(numberId) + '" type="number" min="' + escapeHtml(String(min)) + '" max="' + escapeHtml(String(max)) + '" step="' + escapeHtml(String(step)) + '" value="' + escapeHtml(rawCurrent) + '"',
        ' data-feature-key="' + serializedFeatureKey + '" data-field-name="' + serializedField + '"',
        ' oninput="window.fwSyncManifestRange(' + escapeHtml(JSON.stringify(rangeId)) + ', this.value)"',
        ' onchange="window.fwCommitFeatureConfigValue(JSON.parse(this.dataset.featureKey), JSON.parse(this.dataset.fieldName), \'number\', this.value)">',
        '</div>',
      ].join('');
    }
  }
  if (type === 'file') {
    const acceptValue = escapeHtml(String(property?.accept ?? ''));
    const files = Array.isArray(currentValue) ? currentValue : null;
    const maxItems = Number(property?.maxItems) > 0 ? Number(property.maxItems) : 5;
    if (files) {
      let html = '<div class="fw-setting-directory-list">';
      files.forEach((filePath, index) => {
        html += '<div class="fw-setting-dir-item">';
        html += '<input class="fw-setting-input" value="' + escapeHtml(String(filePath || '')) + '" placeholder="' + escapeHtml(currentLanguage === 'zh' ? '文件路径' : 'File path') + '" data-feature-key="' + serializedFeatureKey + '" data-field-name="' + serializedField + '" data-file-index="' + index + '" onchange="window.fwUpdateConfigFilePath(JSON.parse(this.dataset.featureKey), JSON.parse(this.dataset.fieldName), Number(this.dataset.fileIndex), this.value)">';
        html += '<button class="workspace-action secondary" type="button" onclick="window.fwPickFeatureConfigFile(this)" data-feature-key="' + serializedFeatureKey + '" data-field-name="' + serializedField + '" data-file-index="' + index + '" data-accept="' + acceptValue + '">' + escapeHtml(currentLanguage === 'zh' ? '选择文件' : 'Browse') + '</button>';
        html += '<button class="fw-setting-dir-remove" type="button" onclick="window.fwRemoveConfigFile(JSON.parse(this.dataset.featureKey), JSON.parse(this.dataset.fieldName), Number(this.dataset.fileIndex))" data-feature-key="' + serializedFeatureKey + '" data-field-name="' + serializedField + '" data-file-index="' + index + '">&times;</button>';
        html += '</div>';
      });
      if (files.length < maxItems) {
        html += '<button class="fw-setting-dir-add workspace-action" type="button" onclick="window.fwAddConfigFile(JSON.parse(this.dataset.featureKey), JSON.parse(this.dataset.fieldName))" data-feature-key="' + serializedFeatureKey + '" data-field-name="' + serializedField + '">+ ' + escapeHtml(currentLanguage === 'zh' ? '添加文件' : 'Add file') + '</button>';
      }
      html += '</div>';
      return html;
    }
    return [
      '<div class="fw-setting-file-row">',
      '<input class="fw-setting-input" value="' + escapeHtml(displayValue) + '" placeholder="' + escapeHtml(property?.placeholder || (currentLanguage === 'zh' ? '留空则使用默认路径' : 'Leave blank to use the default path')) + '" data-feature-key="' + serializedFeatureKey + '" data-field-name="' + serializedField + '" onchange="window.fwCommitFeatureConfigValue(JSON.parse(this.dataset.featureKey), JSON.parse(this.dataset.fieldName), \'file\', this.value)">',
      '<button class="workspace-action secondary" type="button" onclick="window.fwPickFeatureConfigFile(this)" data-feature-key="' + serializedFeatureKey + '" data-field-name="' + serializedField + '" data-accept="' + acceptValue + '">' + escapeHtml(currentLanguage === 'zh' ? '选择文件' : 'Browse') + '</button>',
      '</div>',
    ].join('');
  }
  if (type === 'directory') {
    const dirs = Array.isArray(currentValue) ? currentValue : [];
    const maxItems = Number(property?.maxItems) > 0 ? Number(property.maxItems) : 5;
    let html = '<div class="fw-setting-directory-list">';
    dirs.forEach((dir, index) => {
      html += '<div class="fw-setting-dir-item">';
      html += '<input class="fw-setting-input" value="' + escapeHtml(String(dir || '')) + '" placeholder="' + escapeHtml(currentLanguage === 'zh' ? '目录路径' : 'Directory path') + '" data-feature-key="' + serializedFeatureKey + '" data-field-name="' + serializedField + '" data-dir-index="' + index + '" onchange="window.fwUpdateConfigDirectoryPath(JSON.parse(this.dataset.featureKey), JSON.parse(this.dataset.fieldName), Number(this.dataset.dirIndex), this.value)">';
      html += '<button class="workspace-action secondary" type="button" onclick="window.fwPickFeatureConfigDirectory(this)" data-feature-key="' + serializedFeatureKey + '" data-field-name="' + serializedField + '" data-dir-index="' + index + '">' + escapeHtml(currentLanguage === 'zh' ? '选择目录' : 'Browse') + '</button>';
      html += '<button class="fw-setting-dir-remove" type="button" onclick="window.fwRemoveConfigDirectory(JSON.parse(this.dataset.featureKey), JSON.parse(this.dataset.fieldName), Number(this.dataset.dirIndex))" data-feature-key="' + serializedFeatureKey + '" data-field-name="' + serializedField + '" data-dir-index="' + index + '">&times;</button>';
      html += '</div>';
    });
    if (dirs.length < maxItems) {
      html += '<button class="fw-setting-dir-add workspace-action" type="button" onclick="window.fwAddConfigDirectory(JSON.parse(this.dataset.featureKey), JSON.parse(this.dataset.fieldName))" data-feature-key="' + serializedFeatureKey + '" data-field-name="' + serializedField + '">+ ' + escapeHtml(currentLanguage === 'zh' ? '添加目录' : 'Add directory') + '</button>';
    }
    html += '</div>';
    return html;
  }
  return '<input class="fw-setting-input" type="' + (type === 'number' ? 'number' : 'text') + '" value="' + escapeHtml(displayValue) + '" placeholder="' + escapeHtml(property?.placeholder || (currentLanguage === 'zh' ? '留空则使用默认值' : 'Leave blank to use the default value')) + '"' + (type === 'number' && Number.isFinite(Number(property?.min)) ? ' min="' + escapeHtml(String(property.min)) + '"' : '') + (type === 'number' && Number.isFinite(Number(property?.max)) ? ' max="' + escapeHtml(String(property.max)) + '"' : '') + (type === 'number' && Number.isFinite(Number(property?.step)) ? ' step="' + escapeHtml(String(property.step)) + '"' : '') + ' data-feature-key="' + serializedFeatureKey + '" data-field-name="' + serializedField + '" onchange="window.fwCommitFeatureConfigValue(JSON.parse(this.dataset.featureKey), JSON.parse(this.dataset.fieldName), \'' + escapeHtml(type) + '\', this.value)">';
}

function renderFWFeatureSettings(agent, draft, packages) {
  const selected = canonicalizeAssemblyFeatureSelection(agent, parseWorkspaceListField(draft.selected_features));
  const cache = ensureFWFeatureCapabilities(agent, draft);
  const caps = cache.data || {};
  const featureConfigMap = normalizeFeatureConfigMap(getAgentWorkspaceState(agent)?.forms?.['feature-configs'] || {});
  const groups = selected.map((token) => {
    const pkg = resolveFeaturePackageRecord(packages, token);
    const manifest = findFeatureManifestForSelection(caps, token, pkg);
    const featureKey = String(manifest?.packageName || pkg?.packageName || token || '').trim();
    const currentEntry = findFeatureConfigMapEntry(featureConfigMap, featureKey)
      || findFeatureConfigMapEntry(featureConfigMap, token);
    return {
      token,
      pkg,
      manifest,
      featureKey,
      name: getFeatureManifestDisplayName(token, pkg, manifest),
      currentConfig: normalizeFeatureConfigEntry(currentEntry?.value || {}),
    };
  });

  // Append built-in features with manifest that aren't already in selected
  const coveredKeys = groups.map((g) => g.featureKey).filter(Boolean);
  const isCovered = (key) => coveredKeys.some((existing) => featureConfigKeyMatches(key, existing));
  const builtInManifests = Array.isArray(caps?.featureManifests) ? caps.featureManifests : [];
  builtInManifests.forEach((manifest) => {
    const featureKey = String(manifest?.featureId || manifest?.featureName || manifest?.packageName || '').trim();
    if (!featureKey || isCovered(featureKey)) return;
    if (getFeatureManifestPropertyEntries(manifest).length === 0) return;
    const currentEntry = findFeatureConfigMapEntry(featureConfigMap, featureKey);
    groups.push({
      token: featureKey,
      pkg: null,
      manifest,
      featureKey,
      name: getFeatureManifestDisplayName(featureKey, null, manifest),
      currentConfig: normalizeFeatureConfigEntry(currentEntry?.value || {}),
    });
    coveredKeys.push(featureKey);
  });

  const configurableGroups = groups.filter((item) => getFeatureManifestPropertyEntries(item.manifest).length > 0);

  let html = '<section class="fw-settings">';

  if (!configurableGroups.length && !selected.length) {
    html += '<div class="fw-settings-empty">' + escapeHtml(currentLanguage === 'zh' ? '先在右侧启用至少一个 Feature，这里才会出现对应的配置表单。' : 'Enable at least one Feature on the right to reveal its settings here.') + '</div>';
    html += '</section>';
    return html;
  }

  if (cache.loading && !cache.data) {
    html += '<div class="fw-settings-empty">' + escapeHtml(currentLanguage === 'zh' ? '正在读取已启用 Feature 的配置契约…' : 'Loading manifests for mounted Features…') + '</div>';
    html += '</section>';
    return html;
  }

  if (cache.error && !cache.data) {
    html += '<div class="fw-settings-empty danger">' + escapeHtml((currentLanguage === 'zh' ? '读取 Feature 契约失败：' : 'Failed to load Feature manifests: ') + cache.error) + '</div>';
    html += '</section>';
    return html;
  }

  configurableGroups.forEach((group) => {
    const entries = getFeatureManifestPropertyEntries(group.manifest);
    const status = getFeatureConfigStatusMeta(group.manifest, group.currentConfig);
    html += '<div class="fw-setting-group">';
    html += '<div class="fw-setting-group-head"><div class="fw-setting-group-title">' + escapeHtml(group.name) + '</div>';
    html += '<div class="fw-setting-group-actions"><span class="fw-setting-status' + (status.customized ? ' customized' : '') + '">' + escapeHtml(status.label) + '</span><button class="workspace-action secondary" type="button" onclick="window.fwResetFeatureConfig(' + escapeHtml(JSON.stringify(group.featureKey)) + ')">' + escapeHtml(currentLanguage === 'zh' ? '恢复默认' : 'Reset') + '</button></div></div>';
    html += '<div class="fw-setting-grid">';
    entries.forEach(([field, property]) => {
      const currentValue = Object.prototype.hasOwnProperty.call(group.currentConfig, field)
        ? group.currentConfig[field]
        : property.default;
      html += '<div class="fw-setting-row">';
      html += '<div class="fw-setting-label-row"><label>' + escapeHtml(property.title || field) + '</label></div>';
      html += renderFeatureConfigControl(group.featureKey, field, property, currentValue);
      const hintParts = [];
      if (property.description) hintParts.push(property.description);
      const defVal = formatManifestDefaultValue(property);
      if (defVal) hintParts.push((currentLanguage === 'zh' ? '默认' : 'default') + ': ' + defVal);
      if (hintParts.length) {
        html += '<div class="fw-setting-hint">' + escapeHtml(hintParts.join(' · ')) + '</div>';
      }
      html += '</div>';
    });
    html += '</div></div>';
  });

  if (!configurableGroups.length) {
    html += '<div class="fw-settings-empty">' + escapeHtml(currentLanguage === 'zh' ? '当前已挂载 Feature 还没有暴露可配置项。' : 'No mounted Feature exposes project-level settings yet.') + '</div>';
  }

  html += '</section>';
  return html;
}

window.fwRefreshFeatureCapabilities = async () => {
  const agent = getCurrentAgentRecord();
  if (!agent?.id) return;
  const draft = normalizeAssemblyDraft(getWorkspaceFormDraft(agent)?.['assembly-form'] || {});
  await requestFWFeatureCapabilities(agent, draft, { force: true });
  if (window.ClawFlowEditor && typeof window.ClawFlowEditor.refreshCapabilities === 'function') {
    window.ClawFlowEditor.refreshCapabilities().catch(() => {});
  }
};

window.fwCommitFeatureConfigValue = async (featureKey, field, type, rawValue) => {
  const agent = getCurrentAgentRecord();
  if (!agent?.id) return;
  try {
    const value = coerceFeatureManifestValue(type, rawValue);
    await updateFeatureConfigField(agent, String(featureKey || ''), String(field || ''), value);
    shouldAnimateWorkspaceSurface = false;
    renderCurrentMainView();
  } catch (error) {
    console.error('Failed to save feature config field:', error);
    window.alert((currentLanguage === 'zh' ? '保存 Feature 配置失败：' : 'Failed to save feature config: ') + (error?.message || error));
  }
};

window.fwResetFeatureConfig = async (featureKey) => {
  const agent = getCurrentAgentRecord();
  if (!agent?.id) return;
  try {
    await writeFeatureConfig(agent, String(featureKey || ''), {});
    shouldAnimateWorkspaceSurface = false;
    renderCurrentMainView();
  } catch (error) {
    console.error('Failed to reset feature config:', error);
    window.alert((currentLanguage === 'zh' ? '恢复默认配置失败：' : 'Failed to reset feature config: ') + (error?.message || error));
  }
};

window.fwSyncManifestRange = (targetId, value) => {
  const target = document.getElementById(String(targetId || ''));
  if (target) {
    target.value = String(value ?? '');
  }
};

window.fwPickFeatureConfigFile = async (button) => {
  const agent = getCurrentAgentRecord();
  if (!agent?.id || !(button instanceof HTMLElement)) return;
  try {
    const parsedFeatureKey = parseInlineDataValue(button.dataset.featureKey);
    const parsedField = parseInlineDataValue(button.dataset.fieldName);
    const parsedAccept = parseInlineDataValue(button.dataset.accept || '');
    const fileIndex = button.dataset.fileIndex == null ? null : Number(button.dataset.fileIndex);
    const previousLabel = button.textContent || (currentLanguage === 'zh' ? '选择文件' : 'Browse');
    button.disabled = true;
    button.textContent = currentLanguage === 'zh' ? '打开中…' : 'Opening…';
    const selected = await invoke('select_files');
    const chosenPath = Array.isArray(selected?.paths) ? String(selected.paths[0] || '').trim() : '';
    if (!chosenPath) {
      return;
    }
    if (parsedAccept && !matchesFeatureConfigAccept(chosenPath, parsedAccept)) {
      throw new Error(currentLanguage === 'zh' ? '所选文件类型不符合该配置项要求，请重新选择。' : 'The selected file type is not allowed for this setting. Please choose another file.');
    }
    if (fileIndex != null && Number.isFinite(fileIndex)) {
      const current = getFeatureConfig(agent, String(parsedFeatureKey || ''));
      const files = Array.isArray(current[parsedField]) ? [...current[parsedField]] : [];
      while (files.length <= fileIndex) files.push('');
      files[fileIndex] = chosenPath;
      current[parsedField] = files.filter(Boolean);
      await writeFeatureConfig(agent, String(parsedFeatureKey || ''), current);
    } else {
      await updateFeatureConfigField(agent, String(parsedFeatureKey || ''), String(parsedField || ''), chosenPath || undefined);
    }
    shouldAnimateWorkspaceSurface = false;
    renderCurrentMainView();
  } catch (error) {
    console.error('Failed to pick feature config file:', error);
    window.alert((currentLanguage === 'zh' ? '选择配置文件失败：' : 'Failed to choose file: ') + (error?.message || error));
  } finally {
    button.disabled = false;
    button.textContent = currentLanguage === 'zh' ? '选择文件' : 'Browse';
  }
};

window.fwAddConfigFile = async (featureKey, field) => {
  const agent = getCurrentAgentRecord();
  if (!agent?.id) return;
  try {
    const current = getFeatureConfig(agent, String(featureKey || ''));
    const files = Array.isArray(current[field]) ? [...current[field]] : [];
    files.push('');
    current[field] = files;
    await writeFeatureConfig(agent, String(featureKey || ''), current);
    shouldAnimateWorkspaceSurface = false;
    renderCurrentMainView();
  } catch (error) {
    console.error('Failed to add config file:', error);
  }
};

window.fwRemoveConfigFile = async (featureKey, field, index) => {
  const agent = getCurrentAgentRecord();
  if (!agent?.id) return;
  try {
    const current = getFeatureConfig(agent, String(featureKey || ''));
    const files = Array.isArray(current[field]) ? [...current[field]] : [];
    files.splice(index, 1);
    if (files.length > 0) {
      current[field] = files.filter(Boolean);
    } else {
      delete current[field];
    }
    await writeFeatureConfig(agent, String(featureKey || ''), current);
    shouldAnimateWorkspaceSurface = false;
    renderCurrentMainView();
  } catch (error) {
    console.error('Failed to remove config file:', error);
  }
};

window.fwUpdateConfigFilePath = async (featureKey, field, index, value) => {
  const agent = getCurrentAgentRecord();
  if (!agent?.id) return;
  const trimmed = String(value || '').trim();
  try {
    const current = getFeatureConfig(agent, String(featureKey || ''));
    const files = Array.isArray(current[field]) ? [...current[field]] : [];
    while (files.length <= index) files.push('');
    if (trimmed) {
      files[index] = trimmed;
      current[field] = files.filter(Boolean);
    } else {
      files.splice(index, 1);
      if (files.length > 0) {
        current[field] = files.filter(Boolean);
      } else {
        delete current[field];
      }
    }
    await writeFeatureConfig(agent, String(featureKey || ''), current);
  } catch (error) {
    console.error('Failed to update config file path:', error);
  }
};

window.fwPickFeatureConfigDirectory = async (button) => {
  const agent = getCurrentAgentRecord();
  if (!agent?.id || !(button instanceof HTMLElement)) return;
  try {
    const parsedFeatureKey = parseInlineDataValue(button.dataset.featureKey);
    const parsedField = parseInlineDataValue(button.dataset.fieldName);
    const dirIndex = Number(button.dataset.dirIndex);
    const previousLabel = button.textContent || (currentLanguage === 'zh' ? '选择目录' : 'Browse');
    button.disabled = true;
    button.textContent = currentLanguage === 'zh' ? '打开中…' : 'Opening…';
    const selected = await invoke('select_directory');
    const chosenPath = Array.isArray(selected?.paths) ? String(selected.paths[0] || '').trim() : (typeof selected?.path === 'string' ? selected.path.trim() : '');
    if (!chosenPath) {
      return;
    }
    const current = getFeatureConfig(agent, String(parsedFeatureKey || ''));
    const dirs = Array.isArray(current[parsedField]) ? [...current[parsedField]] : [];
    while (dirs.length <= dirIndex) dirs.push('');
    dirs[dirIndex] = chosenPath;
    current[parsedField] = dirs.filter(Boolean);
    await writeFeatureConfig(agent, String(parsedFeatureKey || ''), current);
    shouldAnimateWorkspaceSurface = false;
    renderCurrentMainView();
  } catch (error) {
    console.error('Failed to pick feature config directory:', error);
    window.alert((currentLanguage === 'zh' ? '选择目录失败：' : 'Failed to choose directory: ') + (error?.message || error));
  } finally {
    button.disabled = false;
    button.textContent = currentLanguage === 'zh' ? '选择目录' : 'Browse';
  }
};

window.fwAddConfigDirectory = async (featureKey, field) => {
  const agent = getCurrentAgentRecord();
  if (!agent?.id) return;
  try {
    const current = getFeatureConfig(agent, String(featureKey || ''));
    const dirs = Array.isArray(current[field]) ? [...current[field]] : [];
    dirs.push('');
    current[field] = dirs;
    await writeFeatureConfig(agent, String(featureKey || ''), current);
    shouldAnimateWorkspaceSurface = false;
    renderCurrentMainView();
  } catch (error) {
    console.error('Failed to add config directory:', error);
  }
};

window.fwRemoveConfigDirectory = async (featureKey, field, index) => {
  const agent = getCurrentAgentRecord();
  if (!agent?.id) return;
  try {
    const current = getFeatureConfig(agent, String(featureKey || ''));
    const dirs = Array.isArray(current[field]) ? [...current[field]] : [];
    dirs.splice(index, 1);
    if (dirs.length > 0) {
      current[field] = dirs;
    } else {
      delete current[field];
    }
    await writeFeatureConfig(agent, String(featureKey || ''), current);
    shouldAnimateWorkspaceSurface = false;
    renderCurrentMainView();
  } catch (error) {
    console.error('Failed to remove config directory:', error);
  }
};

window.fwUpdateConfigDirectoryPath = async (featureKey, field, index, value) => {
  const agent = getCurrentAgentRecord();
  if (!agent?.id) return;
  const trimmed = String(value || '').trim();
  try {
    const current = getFeatureConfig(agent, String(featureKey || ''));
    const dirs = Array.isArray(current[field]) ? [...current[field]] : [];
    while (dirs.length <= index) dirs.push('');
    if (trimmed) {
      dirs[index] = trimmed;
      current[field] = dirs.filter(Boolean);
    } else {
      dirs.splice(index, 1);
      if (dirs.length > 0) {
        current[field] = dirs;
      } else {
        delete current[field];
      }
    }
    await writeFeatureConfig(agent, String(featureKey || ''), current);
  } catch (error) {
    console.error('Failed to update config directory path:', error);
  }
};

function renderFWDetail(agent, block, formId, st) {
  if (!window.ClawFW._modelPresets) {
    window.ClawFW._modelPresets = [];
    fetch('/protoclaw/model_config').then(function(r) { return r.json(); }).then(function(d) {
      window.ClawFW._modelPresets = Array.isArray(d?.presets) ? d.presets : [];
      fwRerender();
    }).catch(function() { window.ClawFW._modelPresets = []; });
  }
  const draft = normalizeAssemblyDraft(getWorkspaceFormDraft(agent)?.[formId] || {});
  const name = String(draft.assembly_name || '').trim();
  const section = st.section || 'features';
  const isOrchestrate = section === 'orchestrate';
  const isConfig = section === 'config';

  let html = '<div class="fw' + (isOrchestrate ? ' fw-detail-orchestrate' : ' fw-detail') + '">';

  html += '<div class="fw-detail-head">';
  html += '<div class="fw-detail-nav">';
  html += '<button class="fw-btn fw-btn-ghost fw-back-btn" title="' + escapeHtml(currentLanguage === 'zh' ? '返回项目列表' : 'Back to projects') + '" onclick="fwBackToList()">&lt;</button>';
  html += '<button class="fw-btn fw-project-switch" type="button" onclick="fwOpenProjectPicker()">' + escapeHtml(currentLanguage === 'zh' ? '切换项目' : 'Switch Project') + '</button>';
  html += '</div>';
  html += '<div class="fw-detail-toggle">';
  html += '<button class="fw-toggle' + (section === 'features' ? ' active' : '') + '" onclick="fwSwitchSection(\'features\')">' + escapeHtml(currentLanguage === 'zh' ? '通用设置' : 'General') + '</button>';
  html += '<button class="fw-toggle' + (isConfig ? ' active' : '') + '" onclick="fwSwitchSection(\'config\')">' + escapeHtml(currentLanguage === 'zh' ? '能力配置' : 'Features') + '</button>';
  html += '<button class="fw-toggle' + (isOrchestrate ? ' active' : '') + '" onclick="fwSwitchSection(\'orchestrate\')">' + escapeHtml(currentLanguage === 'zh' ? '协作蓝图' : 'Blueprint') + '</button>';
  html += '</div>';
  html += '<div class="fw-detail-actions">';
  const _launchBusy = ['creating', 'installing', 'starting'].includes(String(draft.env_status || ''));
  const _launchLabel = _launchBusy
    ? (currentLanguage === 'zh' ? '启动中...' : 'Launching...')
    : (currentLanguage === 'zh' ? '启动' : 'Launch');
  html += '<button class="fw-btn fw-btn-primary' + (_launchBusy ? ' fw-btn-busy' : '') + '"' + (_launchBusy ? ' disabled' : '') + ' onclick="window.launchAssemblyInstance()">' + escapeHtml(_launchLabel) + '</button>';
  html += '</div>';
  html += '</div>';

  html += '<div class="fw-detail-body">';
  html += '<div class="fw-detail-pane fw-pane-features"' + (section !== 'features' ? ' hidden' : '') + '>';
  html += renderFWFeatures(agent, block, formId, draft);
  html += '</div>';
  html += '<div class="fw-detail-pane fw-pane-config"' + (!isConfig ? ' hidden' : '') + '>';
  html += renderFWConfigPane(agent, block, formId, draft);
  html += '</div>';
  html += '<div class="fw-detail-pane fw-pane-orchestrate"' + (!isOrchestrate ? ' hidden' : '') + '>';
  html += renderFWOrchestrate(agent, block);
  html += '</div>';
  html += '</div>';

  html += '</div>';
  html += renderFWSwitchProjectDialog(agent, name);
  html += renderFWCreateDialog();
  html += renderFWPromptDialog(agent, formId, draft);
  html += renderFWFeatureImportDialog();
  return html;
}

function renderFWFeatures(agent, block, formId, draft) {
  const repository = getFeatureRepositoryData(agent, block);
  const packages = Array.isArray(repository?.packages) ? repository.packages : [];
  const selected = parseWorkspaceListField(draft.selected_features);
  const selectedSet = new Set(selected);
  const sourceFilter = String(draft.feature_source_filter || 'all');
  const searchValue = window.ClawFW.featureQuery == null ? String(draft.feature_query || '') : String(window.ClawFW.featureQuery || '');
  const searchQuery = searchValue.trim().toLowerCase();
  const env = getAssemblyEnvironmentState(draft);
  const sourcePackages = packages
    .filter((pkg) => {
      const token = pkg.packageName || pkg.name || pkg.id || '';
      const shortName = (pkg.name || token).replace(/^@agentdev\//, '');
      const enabled = selectedSet.has(token) || selectedSet.has(shortName) || selectedSet.has(pkg.id || '');
      if (sourceFilter === 'mounted') return enabled;
      if (sourceFilter === 'official') return pkg.source === 'official';
      if (sourceFilter === 'custom') return pkg.source === 'custom';
      return true;
    });
  const getFeatureSearchText = (pkg) => [
    pkg?.name,
    pkg?.id,
    pkg?.packageName,
    pkg?.description,
    ...(Array.isArray(pkg?.featureTypes) ? pkg.featureTypes : []),
    ...(Array.isArray(pkg?.tags) ? pkg.tags : []),
  ].join(' ');
  const visiblePackages = sourcePackages.filter((pkg) => !searchQuery || getFeatureSearchText(pkg).toLowerCase().includes(searchQuery));
  const officialCount = packages.filter(pkg => pkg.source === 'official').length;
  const customCount = packages.filter(pkg => pkg.source === 'custom').length;

  let html = '<div class="fw-cols">';
  html += '<div class="fw-left">';
  html += '<div class="fw-group-label">' + escapeHtml(currentLanguage === 'zh' ? '基本信息' : 'General') + '</div>';
  html += '<div class="fw-field"><label>' + escapeHtml(currentLanguage === 'zh' ? '标识' : 'ID') + '</label>';
  if (draft.env_created === '1') {
    html += '<input class="fw-input" value="' + escapeHtml(draft.assembly_name || '') + '" readonly>';
  } else {
    html += '<input class="fw-input" value="' + escapeHtml(draft.assembly_name || '') + '" placeholder="my-agent" oninput="window.updateAssemblyDraftField(\'' + formId + '\',\'assembly_name\',this.value)" onblur="window.commitAssemblyDraftField(\'' + formId + '\',\'assembly_name\',this.value)">';
  }
  html += '</div>';
  html += '<div class="fw-field"><label>' + escapeHtml(currentLanguage === 'zh' ? '名称' : 'Name') + '</label>';
  html += '<input class="fw-input" value="' + escapeHtml(draft.display_name || '') + '" placeholder="' + escapeHtml(draft.assembly_name || 'My Agent') + '" oninput="window.updateAssemblyDraftField(\'' + formId + '\',\'display_name\',this.value)" onblur="window.commitAssemblyDraftField(\'' + formId + '\',\'display_name\',this.value)">';
  html += '</div>';
  html += '<div class="fw-field"><label>' + escapeHtml(currentLanguage === 'zh' ? '目标' : 'Goal') + '</label>';
  html += '<textarea class="fw-textarea" placeholder="' + escapeHtml(currentLanguage === 'zh' ? '这个 Agent 帮用户做什么？' : 'What does this Agent do?') + '" oninput="window.updateAssemblyDraftField(\'' + formId + '\',\'goal\',this.value)" onblur="window.commitAssemblyDraftField(\'' + formId + '\',\'goal\',this.value)">' + escapeHtml(draft.goal || '') + '</textarea></div>';
  html += '<div class="fw-field"><label>' + escapeHtml(currentLanguage === 'zh' ? 'LLM 预设' : 'LLM Preset') + '</label>';
  const _modelPresets = Array.isArray(window.ClawFW._modelPresets) ? window.ClawFW._modelPresets : [];
  html += '<select class="flow-editor-select" onchange="window.updateAssemblyDraftField(\'' + formId + '\',\'model_preset\',this.value);window.commitAssemblyDraftField(\'' + formId + '\',\'model_preset\',this.value)">';
  html += '<option value="">' + escapeHtml(currentLanguage === 'zh' ? '使用全局默认模型' : 'Use global default model') + '</option>';
  _modelPresets.forEach(function(p) {
    html += '<option value="' + escapeHtml(p.name || '') + '"' + (draft.model_preset === p.name ? ' selected' : '') + '>' + escapeHtml(p.name + ' (' + (p.model || '—') + ')') + '</option>';
  });
  html += '</select></div>';
  html += '<div class="fw-field"><label>' + escapeHtml(currentLanguage === 'zh' ? '工作目录' : 'Workdir') + '</label>';
  html += '<div style="display:flex;gap:8px;align-items:center;">';
  html += '<input class="fw-input" style="flex:1;" value="' + escapeHtml(draft.workdir || '') + '" placeholder="' + escapeHtml(currentLanguage === 'zh' ? '留空沿用运行环境目录' : 'Use environment directory by default') + '" oninput="window.updateAssemblyDraftField(\'' + formId + '\',\'workdir\',this.value)" onblur="window.commitAssemblyDraftField(\'' + formId + '\',\'workdir\',this.value)">';
  html += '<button class="fw-btn fw-btn-subtle" type="button" onclick="window.chooseWorkspaceDirectory(\'' + formId + '\',\'workdir\')">' + escapeHtml(currentLanguage === 'zh' ? '选择' : 'Browse') + '</button>';
  html += '</div></div>';
  html += '<button class="fw-prompt-card" type="button" onclick="fwOpenPromptEditor()">';
  html += '<span class="fw-prompt-title">' + escapeHtml(currentLanguage === 'zh' ? '系统提示词' : 'System Prompt') + '</span>';
  html += '<span class="fw-prompt-preview">' + escapeHtml(draft.custom_system_prompt || (currentLanguage === 'zh' ? '使用自动生成的系统提示词。点击打开大编辑器。' : 'Use the generated system prompt. Click to open the large editor.')) + '</span>';
  html += '</button>';
  html += '<div class="fw-group-label">' + escapeHtml(currentLanguage === 'zh' ? '运行环境' : 'Environment') + '</div>';
  html += '<div class="fw-env">';
  html += '<div class="fw-env-head"><span class="fw-dot" style="background:' + escapeHtml(getAssemblyEnvironmentStatusTone(env.status)) + '"></span><span class="fw-env-status">' + escapeHtml(getAssemblyEnvironmentStatusLabel(env.status)) + '</span></div>';
  if (env.status === 'ready') {
    if (env.directory) html += '<div class="fw-env-dir"><code>' + escapeHtml(env.directory) + '</code></div>';
    html += '<div class="fw-env-note">' + escapeHtml(currentLanguage === 'zh' ? '环境已就绪，可直接启动。' : 'Environment ready. You can launch directly.') + '</div>';
    html += '<div class="fw-env-actions"><button class="fw-btn fw-btn-subtle" onclick="window.createAssemblyEnvironment();setTimeout(fwRerender,300)">' + escapeHtml(currentLanguage === 'zh' ? '重建环境' : 'Rebuild') + '</button></div>';
  } else if (env.status === 'missing' || env.status === 'missing-name') {
    html += '<div class="fw-env-note">' + escapeHtml(env.status === 'missing-name'
      ? (currentLanguage === 'zh' ? '填写标识后创建运行环境。' : 'Set an ID first, then create the environment.')
      : (currentLanguage === 'zh' ? '尚未创建运行环境，首次启动前需要准备。' : 'No runtime environment yet. Create one before launch.')) + '</div>';
    html += '<div class="fw-env-actions"><button class="fw-btn fw-btn-primary" onclick="window.createAssemblyEnvironment();setTimeout(fwRerender,300)"' + (env.status === 'missing-name' ? ' disabled' : '') + '>' + escapeHtml(currentLanguage === 'zh' ? '创建环境' : 'Create') + '</button></div>';
  } else if (env.status === 'stale') {
    if (env.directory) html += '<div class="fw-env-dir"><code>' + escapeHtml(env.directory) + '</code></div>';
    html += '<div class="fw-env-note">' + escapeHtml(env.message || (currentLanguage === 'zh' ? '能力配置已变更，需要更新环境。' : 'Capabilities changed. Update the environment to match.')) + '</div>';
    html += '<div class="fw-env-actions"><button class="fw-btn fw-btn-accent" onclick="window.createAssemblyEnvironment();setTimeout(fwRerender,300)">' + escapeHtml(currentLanguage === 'zh' ? '更新环境' : 'Update') + '</button></div>';
  } else {
    if (env.directory) html += '<div class="fw-env-dir"><code>' + escapeHtml(env.directory) + '</code></div>';
    if (env.message) html += '<div class="fw-env-note">' + escapeHtml(env.message) + '</div>';
  }
  html += '</div>';
  html += '</div>';

  html += '<div class="fw-right">';
  html += '<div class="fw-feat-toolbar">';
  html += '<div class="fw-feat-tabs">';
  [
    ['all', currentLanguage === 'zh' ? '全部' : 'All', packages.length],
    ['mounted', currentLanguage === 'zh' ? '已挂载' : 'Mounted', selected.length],
    ['official', currentLanguage === 'zh' ? '官方' : 'Official', officialCount],
    ['custom', currentLanguage === 'zh' ? '自定义' : 'Custom', customCount],
  ].forEach(tab => {
    html += '<button class="fw-feat-tab' + (sourceFilter === tab[0] ? ' active' : '') + '" type="button" onclick="fwSetFeatureFilter(\'' + escapeHtml(formId) + '\',\'' + escapeHtml(tab[0]) + '\')">' + escapeHtml(tab[1] + ' ' + tab[2]) + '</button>';
  });
  html += '</div>';
  html += '<input class="fw-feat-search" value="' + escapeHtml(searchValue) + '" placeholder="' + escapeHtml(currentLanguage === 'zh' ? '搜索 Feature' : 'Search Features') + '" oninput="fwSetFeatureQuery(\'' + escapeHtml(formId) + '\', this.value)" onblur="fwCommitFeatureQuery(\'' + escapeHtml(formId) + '\', this.value)">';
  html += '<button class="fw-btn" type="button" onclick="fwOpenFeatureImport(\'' + escapeHtml(formId) + '\')">' + escapeHtml(currentLanguage === 'zh' ? '上传 tgz' : 'Upload tgz') + '</button>';
  html += '</div>';
  html += '<div class="fw-feat-head" data-fw-feature-count data-total="' + escapeHtml(String(sourcePackages.length)) + '" data-mounted="' + escapeHtml(String(selected.length)) + '">' + escapeHtml((currentLanguage === 'zh' ? '当前显示 ' : 'Showing ') + visiblePackages.length + ' / ' + sourcePackages.length + (currentLanguage === 'zh' ? `，已挂载 ${selected.length}` : `, mounted ${selected.length}`)) + '</div>';
  html += '<div class="fw-feat-list">';
  if (!packages.length) {
    html += '<div style="padding:20px;color:var(--text-secondary);font-size:13px;">' + escapeHtml(currentLanguage === 'zh' ? 'Feature 仓库加载中...' : 'Loading...') + '</div>';
  } else if (!sourcePackages.length) {
    html += '<div style="padding:20px;color:var(--text-secondary);font-size:13px;">' + escapeHtml(currentLanguage === 'zh' ? '没有匹配的 Feature。' : 'No matching Features.') + '</div>';
  } else {
    sourcePackages.forEach(pkg => {
      const token = pkg.packageName || pkg.name || pkg.id || '';
      const shortName = (pkg.name || token).replace(/^@agentdev\//, '');
      const enabled = selectedSet.has(token) || selectedSet.has(shortName) || selectedSet.has(pkg.id || '');
      const featureTypes = Array.isArray(pkg.featureTypes) ? pkg.featureTypes : [];
      const searchText = getFeatureSearchText(pkg);
      const matched = !searchQuery || searchText.toLowerCase().includes(searchQuery);
      html += '<div class="fw-feat' + (enabled ? ' on' : '') + '" data-fw-feature-search="' + escapeHtml(searchText) + '" onclick="fwToggleFeature(\'' + escapeHtml(formId) + '\',\'' + escapeHtml(token) + '\')"' + (matched ? '' : ' hidden') + '>';
      html += '<div class="fw-feat-top"><div class="fw-feat-name">' + escapeHtml(shortName) + '</div>';
      html += '<span class="fw-feat-badge mount">' + escapeHtml(enabled ? (currentLanguage === 'zh' ? '已挂载' : 'Mounted') : (currentLanguage === 'zh' ? '未挂载' : 'Off')) + '</span></div>';
      html += '<div class="fw-feat-desc">' + escapeHtml(pkg.description || (currentLanguage === 'zh' ? '暂无说明。' : 'No description.')) + '</div>';
      html += '<div class="fw-feat-meta">';
      html += '<span class="fw-feat-badge">' + escapeHtml(pkg.source === 'official' ? (currentLanguage === 'zh' ? '官方' : 'Official') : (currentLanguage === 'zh' ? '自定义' : 'Custom')) + '</span>';
      if (pkg.latestVersion || pkg.version) html += '<span class="fw-feat-badge">v' + escapeHtml(pkg.latestVersion || pkg.version) + '</span>';
      featureTypes.slice(0, 2).forEach(type => { html += '<span class="fw-feat-badge">' + escapeHtml(getFeatureTypeLabel(type)) + '</span>'; });
      html += '</div></div>';
    });
    html += '<div data-fw-feature-empty style="padding:20px;color:var(--text-secondary);font-size:13px;"' + (visiblePackages.length ? ' hidden' : '') + '>' + escapeHtml(currentLanguage === 'zh' ? '没有匹配的 Feature。' : 'No matching Features.') + '</div>';
  }
  html += '</div></div></div>';
  return html;
}

function renderFWConfigPane(agent, block, formId, draft) {
  const repository = getFeatureRepositoryData(agent, block);
  const packages = Array.isArray(repository?.packages) ? repository.packages : [];
  let html = '<div class="fw-config-pane">';
  html += '<div class="fw-config-hero">';
  html += '<span class="fw-config-hero-title">' + escapeHtml(currentLanguage === 'zh' ? 'Feature 配置' : 'Feature Config') + '</span>';
  html += '<span class="fw-config-hero-note">' + escapeHtml(currentLanguage === 'zh'
    ? '静态参数，流程节点中的 Mode 只负责切换运行时状态'
    : 'Static params. Flow modes only switch runtime state') + '</span>';
  html += '</div>';
  html += renderFWFeatureSettings(agent, draft, packages);
  html += '</div>';
  return html;
}

function renderFWOrchestrate(agent, block) {
  const flowBlock = { id: 'flow-editor', type: 'flow-editor', title: { zh: '编排', en: 'Graph' } };
  return renderFlowEditorBlock(agent, flowBlock);
}

function renderFlowWorkspaceProjectHero(agent, options = {}) {
  const draft = normalizeAssemblyDraft(getWorkspaceFormDraft(agent)?.['assembly-form'] || {});
  const name = String(draft.assembly_name || '').trim();
  const projectName = getAssemblyDisplayName(draft) || (currentLanguage === 'zh' ? '未命名 Agent 项目' : 'Untitled Agent Project');
  const features = parseWorkspaceListField(draft.selected_features);
  const envState = getAssemblyEnvironmentState(draft);
  const sessions = getWorkspaceSessions(agent).filter((session) => String(session?.formId || '') === 'assembly-form');
  const runningCount = sessions.filter((session) => isAssemblySessionRunning(agent, session)).length;
  const graphBinding = name
    ? `${currentLanguage === 'zh' ? '编排图绑定' : 'Graph'}: ~/.agentdev/AgentDevClaw/flows/${name}/agent-flow-graph.json`
    : (currentLanguage === 'zh' ? '先命名 Agent 后，编排图会绑定到该项目。' : 'Name the Agent first; the graph will bind to that project.');
  const active = options.active || '';
  return [
    '<section class="flow-project-hero">',
    '<div class="flow-project-hero-main">',
    '<div class="assembly-workbench-kicker">' + escapeHtml(currentLanguage === 'zh' ? '当前 Agent 项目' : 'Current Agent Project') + '</div>',
    '<div class="flow-project-title">' + escapeHtml(projectName) + '</div>',
    '<div class="flow-project-subtitle">' + escapeHtml(graphBinding) + '</div>',
    '<div class="assembly-card-meta">',
    renderAssemblyStatusChip(name ? (currentLanguage === 'zh' ? '已绑定项目' : 'Project Bound') : (currentLanguage === 'zh' ? '待命名' : 'Needs Name'), name ? 'var(--success-color)' : 'var(--warning-color)'),
    renderAssemblyStatusChip(currentLanguage === 'zh' ? `${features.length} 个 Feature` : `${features.length} Features`, 'var(--text-secondary)'),
    renderAssemblyStatusChip(getAssemblyEnvironmentStatusLabel(envState.status), getAssemblyEnvironmentStatusTone(envState.status)),
    renderAssemblyStatusChip(currentLanguage === 'zh' ? `${runningCount} 个运行中` : `${runningCount} Running`, runningCount > 0 ? 'var(--success-color)' : 'var(--text-secondary)'),
    '</div>',
    '</div>',
    '<div class="flow-project-actions">',
    '<button class="workspace-action' + (active === 'projects' ? ' secondary' : '') + '" type="button" onclick="window.runWorkspaceAction(JSON.stringify({type: \'show_workspace_tab\', tab: \'projects\'}))">' + escapeHtml(currentLanguage === 'zh' ? '项目总览' : 'Overview') + '</button>',
    '<button class="workspace-action' + (active === 'assemble' ? ' secondary' : '') + '" type="button" onclick="window.runWorkspaceAction(JSON.stringify({type: \'show_workspace_tab\', tab: \'assemble\'}))">' + escapeHtml(currentLanguage === 'zh' ? '能力配置' : 'Features') + '</button>',
    '<button class="workspace-action' + (active === 'orchestrate' ? ' secondary' : '') + '" type="button" onclick="window.runWorkspaceAction(JSON.stringify({type: \'show_workspace_tab\', tab: \'orchestrate\'}))">' + escapeHtml(currentLanguage === 'zh' ? '协作蓝图' : 'Blueprint') + '</button>',
    '<button class="workspace-action" type="button" onclick="window.launchAssemblyInstance()">' + escapeHtml(currentLanguage === 'zh' ? '快速运行测试' : 'Quick Test Run') + '</button>',
    '</div>',
    '</section>',
  ].join('');
}

function renderAssemblyLibraryBlock(agent, block) {
  const title = localizeWorkspaceValue(block.title, currentLanguage === 'zh' ? 'Agent 项目' : 'Agent Projects');
  const desc = localizeWorkspaceValue(block.description, '');
  const savedConfigs = getSavedAssemblyConfigs(agent).slice(0, 12);
  const recentRuns = getWorkspaceSessions(agent)
    .filter((session) => String(session?.formId || '') === 'assembly-form')
    .slice(0, 12);
  const draft = normalizeAssemblyDraft(getWorkspaceFormDraft(agent)?.['assembly-form'] || {});
  const activeSessionId = agent?.active_workspace_session_id || agent?.workspace_sessions?.activeSessionId || null;
  const savedConfigHtml = savedConfigs.length > 0
    ? savedConfigs.map((item) => {
        const summary = getAssemblySavedConfigSummary(agent, item);
        return '<div class=”workspace-history-item”><div class=”workspace-history-main”><div class=”assembly-card-head”><div class=”assembly-card-copy”><div class=”workspace-history-title”>' + escapeHtml(item.name) + '</div><div class=”assembly-card-meta”>'
          + renderAssemblyStatusChip(currentLanguage === 'zh' ? `${item.features.length} 个 Feature` : `${item.features.length} Features`, 'var(--text-secondary)')
          + renderAssemblyStatusChip(summary.runningCount > 0
            ? (currentLanguage === 'zh' ? `${summary.runningCount} 个运行中实例` : `${summary.runningCount} Running`)
            : (currentLanguage === 'zh' ? '当前无运行实例' : 'No Running Instance'),
          summary.runningCount > 0 ? 'var(--success-color)' : 'var(--text-secondary)')
          + '</div></div></div><div class=”workspace-history-preview”>' + escapeHtml(item.goal || getAssemblyPresetLabel(item.preset)) + '</div><div class=”workspace-history-meta”>' + escapeHtml([
            item.updatedAt ? new Date(item.updatedAt).toLocaleString() : '',
            summary.sessionCount > 0
              ? (currentLanguage === 'zh' ? `共 ${summary.sessionCount} 次实例记录` : `${summary.sessionCount} instance record(s)`)
              : (currentLanguage === 'zh' ? '尚未启动过实例' : 'No instances launched yet'),
          ].filter(Boolean).join(' · ')) + '</div></div><div class=”workspace-actions stacked”><button class=”workspace-action” type=”button” onclick=”window.loadSavedAssemblyConfig(&quot;' + escapeHtml(item.id) + '&quot;)”>' + escapeHtml(getRepoLocaleText('编辑配置', 'Edit Setup')) + '</button><button class=”workspace-action secondary” type=”button” onclick=”window.launchAssemblyConfig(&quot;' + escapeHtml(item.id) + '&quot;)”>' + escapeHtml(getRepoLocaleText('启动实例', 'Launch Instance')) + '</button><button class=”workspace-action secondary” type=”button” onclick=”window.deleteSavedAssemblyConfig(&quot;' + escapeHtml(item.id) + '&quot;)”>' + escapeHtml(getRepoLocaleText('删除', 'Delete')) + '</button></div></div>';
      }).join('')
    : '<div class=”assembly-empty-note”>' + escapeHtml(currentLanguage === 'zh' ? '还没有 Agent 项目。点击”新建 Agent 项目”，命名后就会绑定一张编排图。' : 'No Agent projects yet. Create one, name it, and a graph will bind to it.') + '</div>';
  const recentRunHtml = recentRuns.length > 0
    ? recentRuns.map((item) => {
        const status = getAssemblySessionStatus(agent, item);
        const running = isAssemblySessionRunning(agent, item);
        const isCurrent = activeSessionId && item.id === activeSessionId;
        return '<div class=”workspace-history-item” data-prebuilt-session-agent-id=”' + escapeHtml(agent.id) + '” data-prebuilt-session-id=”' + escapeHtml(item.id) + '”><div class=”workspace-history-main”><div class=”assembly-card-head”><div class=”assembly-card-copy”><div class=”workspace-history-title”>' + escapeHtml(item.agentName || item.title || item.id) + (isCurrent ? ' <span class=”workspace-history-active”>' + escapeHtml(currentLanguage === 'zh' ? '当前' : 'Current') + '</span>' : '') + '</div><div class=”assembly-card-meta”>'
          + renderAssemblyStatusChip(status.label, status.tone)
          + renderAssemblyStatusChip(currentLanguage === 'zh' ? '运行实例' : 'Runtime Instance', 'var(--text-secondary)')
          + '</div></div></div><div class=”workspace-history-preview”>' + escapeHtml(item.preview || item.goal || item.agentName || '') + '</div><div class=”workspace-history-meta”>' + escapeHtml([item.createdAt ? new Date(item.createdAt).toLocaleString() : '', item.openDirectory || ''].filter(Boolean).join(' · ')) + '</div></div><div class=”workspace-actions stacked”><button class=”workspace-action” type=”button” onclick=”window.launchSavedAssemblyRun(&quot;' + escapeHtml(item.id) + '&quot;)”>' + escapeHtml(getRepoLocaleText('继续聊天', 'Continue Chat')) + '</button><button class=”workspace-action secondary” type=”button” onclick=”window.loadAssemblySessionIntoDraft(&quot;' + escapeHtml(item.id) + '&quot;)”>' + escapeHtml(getRepoLocaleText('回到编辑', 'Back To Editor')) + '</button>' + (running ? '<button class=”workspace-action secondary” type=”button” onclick=”window.stopAssemblySessionRuntime(&quot;' + escapeHtml(item.id) + '&quot;)”>' + escapeHtml(getRepoLocaleText('关闭实例', 'Stop Instance')) + '</button>' : '') + '<button class=”workspace-action secondary” type=”button” onclick=”window.deleteAssemblySessionRecord(&quot;' + escapeHtml(item.id) + '&quot;)”>' + escapeHtml(getRepoLocaleText('删除记录', 'Delete Record')) + '</button></div></div>';
      }).join('')
    : '<div class=”assembly-empty-note”>' + escapeHtml(currentLanguage === 'zh' ? '还没有启动过测试实例。' : 'No test runtime instances launched yet.') + '</div>';

  return [
    '<div class=”assembly-flow”>',
    renderFlowWorkspaceProjectHero(agent, { active: 'my-chatbots' }),
    '<section class=”assembly-intro compact”>',
    '<div class=”workspace-section-title”>' + escapeHtml(currentLanguage === 'zh' ? '项目管理与快速测试' : 'Project Management And Quick Testing') + '</div>',
    '<div class=”assembly-workbench-note”>' + escapeHtml(desc || (currentLanguage === 'zh'
      ? '这里先回答三个问题：正在编辑谁、它绑定哪张编排图、有没有可运行实例。配置、编排图和运行时都围绕当前 Agent 项目展开。'
      : 'This view answers three things first: who you are editing, which graph is bound, and whether a runtime exists. Setup, graph, and runtime all revolve around the current Agent project.')) + '</div>',
    '<div class=”assembly-history-actions”>',
    '<button class=”workspace-action” type=”button” onclick=”window.resetAssemblyDraft()”>' + escapeHtml(currentLanguage === 'zh' ? '新建 Agent 项目' : 'New Agent Project') + '</button>',
    '<button class=”workspace-action secondary” type=”button” onclick=”window.runWorkspaceAction(JSON.stringify({type: \'show_workspace_tab\', tab: \'assembly\'}))”>' + escapeHtml(currentLanguage === 'zh' ? '配置能力' : 'Configure Capabilities') + '</button>',
    '<button class=”workspace-action secondary” type=”button” onclick=”window.runWorkspaceAction(JSON.stringify({type: \'show_workspace_tab\', tab: \'flows\'}))”>' + escapeHtml(currentLanguage === 'zh' ? '打开编排图' : 'Open Graph') + '</button>',
    '</div>',
    '</section>',
    '<section class=”assembly-library-stack”>',
    '<div class=”assembly-history-card assembly-library-card”><div class=”assembly-card-title”>' + escapeHtml(currentLanguage === 'zh' ? 'Agent 项目配置' : 'Agent Project Setups') + '</div><div class=”assembly-card-body”>' + escapeHtml(currentLanguage === 'zh' ? '每个配置代表一个 Agent 项目：身份、Feature、环境和唯一编排图都围绕它组织。' : 'Each setup is an Agent project: identity, Features, environment, and the unique graph are organized around it.') + '</div>' + savedConfigHtml + '</div>',
    '<div class=”assembly-history-card assembly-library-card”><div class=”assembly-card-title”>' + escapeHtml(currentLanguage === 'zh' ? '运行中的测试实例 / 最近会话' : 'Running Test Instances / Recent Sessions') + '</div><div class=”assembly-card-body”>' + escapeHtml(currentLanguage === 'zh' ? '这些实例会按对应 Agent 项目读取 Feature 配置和绑定编排图。' : 'These instances load the corresponding Agent project Feature setup and bound graph.') + '</div>' + recentRunHtml + '</div>',
    '</section>',
    '</div>',
  ].join('');
}

function renderAssemblyStageHeader(formId, activeStage, stageKey, index, summary) {
  return [
    '<button class="assembly-stage-header" type="button" onclick="window.toggleAssemblyStage(&quot;' + escapeHtml(formId) + '&quot;, &quot;' + escapeHtml(stageKey) + '&quot;)">',
    '<span class="assembly-stage-number">' + escapeHtml(String(index)) + '</span>',
    '<span><div class="assembly-stage-title">' + escapeHtml(getAssemblyStageLabel(stageKey)) + '</div><div class="assembly-stage-summary">' + escapeHtml(summary) + '</div></span>',
    '<span class="assembly-stage-indicator">' + escapeHtml(activeStage === stageKey ? (currentLanguage === 'zh' ? '当前阶段' : 'Current Step') : (currentLanguage === 'zh' ? '展开' : 'Expand')) + '</span>',
    '</button>',
  ].join('');
}

function renderAssemblyFeatureCards(featuredPackages, selectedFeatures, formId, searchQuery, packages) {
  if (featuredPackages.length === 0) {
    return '<div class="assembly-empty-note">' + escapeHtml(searchQuery
      ? getRepoLocaleText('没有匹配当前搜索的 Feature。', 'No features matched the current search.')
      : getRepoLocaleText('Feature 仓库暂时为空。', 'The feature repository is currently empty.')) + '</div>';
  }

  return featuredPackages.map((item) => {
    const packageToken = item.id || item.packageName || item.name || '';
    const enabled = selectedFeatures.includes(packageToken) || selectedFeatures.includes(item.packageName || '');
    return [
      '<article class="assembly-feature-card' + (enabled ? ' active' : '') + '" onclick="window.toggleWorkspaceSelection(&quot;' + escapeHtml(formId) + '&quot;, &quot;selected_features&quot;, &quot;' + escapeHtml(packageToken) + '&quot;)">',
      '<div class="assembly-feature-head">',
      '<div>',
      '<div class="assembly-feature-title">' + escapeHtml(item.name || item.id || getAssemblyFeatureLabel(packageToken, packages)) + '</div>',
      '<div class="assembly-feature-subtitle">' + escapeHtml(item.packageName || item.id || '') + '</div>',
      '</div>',
      '<div class="workspace-repo-badges">',
      '<span class="workspace-repo-badge ready">v' + escapeHtml(item.latestVersion || '-') + '</span>',
      item.source === 'official'
        ? '<span class="workspace-repo-badge ready">' + escapeHtml(getRepoLocaleText('官方', 'Official')) + '</span>'
        : '<span class="workspace-repo-badge" style="background:var(--surface);color:var(--text-secondary);">' + escapeHtml(getRepoLocaleText('自定义', 'Custom')) + '</span>',
      enabled ? '<span class="workspace-repo-badge ready">' + escapeHtml(getRepoLocaleText('已启用', 'Enabled')) + '</span>' : '',
      '</div>',
      '</div>',
      item.description ? '<div class="workspace-repo-desc">' + escapeHtml(item.description) + '</div>' : '',
      '<div class="assembly-pill-row">' + (Array.isArray(item.featureTypes) ? item.featureTypes.map((tag) => '<span class="workspace-tag">' + escapeHtml(getFeatureTypeLabel(tag)) + '</span>').join('') : '') + '</div>',
      '<div class="workspace-repo-actions">',
      '<button class="workspace-action' + (enabled ? ' secondary' : '') + '" type="button" onclick="event.stopPropagation(); window.toggleWorkspaceSelection(&quot;' + escapeHtml(formId) + '&quot;, &quot;selected_features&quot;, &quot;' + escapeHtml(packageToken) + '&quot;)">' + escapeHtml(enabled ? getRepoLocaleText('停用', 'Disable') : getRepoLocaleText('启用', 'Enable')) + '</button>',
      '<button class="workspace-action secondary" type="button" onclick="event.stopPropagation(); window.openRepositoryPackageDetails(&quot;' + escapeHtml(item.id || packageToken) + '&quot;)">' + escapeHtml(getRepoLocaleText('详情', 'Details')) + '</button>',
      '</div>',
      '</article>',
    ].join('');
  }).join('');
}

function renderAssemblyWorkbenchStageFlow(agent, block) {
  const title = localizeWorkspaceValue(block.title, currentLanguage === 'zh' ? 'Agent 装配台' : 'Agent Assembly Workbench');
  const desc = localizeWorkspaceValue(block.description, '');
  const repository = getFeatureRepositoryData(agent, block);
  const packages = Array.isArray(repository?.packages) ? repository.packages : [];
  const formId = String(block?.assemblySelection?.formId || 'assembly-form');
  const draft = getWorkspaceFormDraft(agent)?.[formId] || {};
  const selectedFeatures = parseWorkspaceListField(draft.selected_features);
  const selectedToolkits = parseWorkspaceListField(draft.recommended_toolkits);
  const preset = String(draft.preset || 'general-chatbot');
  const stage = draft.assembly_stage == null ? 'goal' : String(draft.assembly_stage);
  const searchQuery = String(draft.feature_query || '').trim().toLowerCase();
  const sourceFilter = String(draft.feature_source_filter || 'all');
  const bundleFilter = String(draft.bundle_filter || '');
  const officialCount = packages.filter((item) => item.source === 'official').length;
  const customCount = packages.filter((item) => item.source === 'custom').length;
  const savedConfigs = getSavedAssemblyConfigs(agent).slice(0, 6);
  const featuredPackages = packages
    .filter((item) => {
      if (sourceFilter === 'official') return item.source === 'official';
      if (sourceFilter === 'custom') return item.source === 'custom';
      if (sourceFilter === 'preset') {
        const presetFeatures = ASSEMBLY_PRESET_FEATURES[preset] || [];
        return presetFeatures.some((ref) => {
          const refNorm = ref.toLowerCase().replace(/-feature$/, '');
          const id = (item.id || '').toLowerCase();
          const pn = (item.packageName || '').toLowerCase();
          return id.includes(refNorm) || pn.includes(refNorm);
        });
      }
      if (sourceFilter === 'bundle') {
        if (!bundleFilter) return true;
        const bundleFeatures = ASSEMBLY_BUNDLE_FEATURES[bundleFilter] || [];
        return bundleFeatures.some((ref) => {
          const refNorm = ref.toLowerCase().replace(/-feature$/, '');
          const id = (item.id || '').toLowerCase();
          const pn = (item.packageName || '').toLowerCase();
          return id.includes(refNorm) || pn.includes(refNorm);
        });
      }
      return true;
    })
    .filter((item) => {
      if (!searchQuery || sourceFilter === 'preset' || sourceFilter === 'bundle') return true;
      const haystack = [
        item?.name,
        item?.id,
        item?.packageName,
        item?.description,
        ...(Array.isArray(item?.featureTypes) ? item.featureTypes : []),
        ...(Array.isArray(item?.tags) ? item.tags : []),
      ].join(' ').toLowerCase();
      return haystack.includes(searchQuery);
    })
    .slice(0, 18);
  const recentRuns = getWorkspaceSessions(agent)
    .filter((session) => String(session?.formId || '') === 'assembly-form')
    .slice(0, 6);
  const generatedPrompt = buildAssemblyGeneratedPrompt(draft, packages);
  const effectivePrompt = getAssemblyPromptValue(draft, packages);
  const assemblyName = getAssemblyDisplayName(draft) || (currentLanguage === 'zh' ? '未命名 Agent' : 'Untitled Agent');
  const goalSummary = String(draft.goal || '').trim();
  const selectedFeatureChips = selectedFeatures.length > 0
    ? selectedFeatures.map((item) => '<span class="workspace-tag">' + escapeHtml(getAssemblyFeatureLabel(item, packages)) + '</span>').join('')
    : '<span class="workspace-tag">' + escapeHtml(currentLanguage === 'zh' ? '还没有启用 Feature' : 'No features enabled yet') + '</span>';
  const selectedToolkitChips = selectedToolkits.length > 0
    ? selectedToolkits.map((item) => '<span class="workspace-tag">' + escapeHtml(item) + '</span>').join('')
    : '<span class="workspace-tag">' + escapeHtml(currentLanguage === 'zh' ? '还没有选择套件' : 'No bundles selected yet') + '</span>';
  const savedSetupExists = !!getSavedAssemblyConfigs(agent).find((item) => item.id === assemblyName);
  const editorMode = getAssemblyEditorMode(draft, savedSetupExists);
  const goalStageSummary = [
    assemblyName,
    goalSummary || (currentLanguage === 'zh' ? '还没有写主要目标' : 'No goal yet'),
  ].filter(Boolean).join(' | ');
  const capabilityStageSummary = [
    getAssemblyPresetLabel(preset),
    currentLanguage === 'zh' ? `${selectedFeatures.length} 个 Feature 已启用` : `${selectedFeatures.length} features enabled`,
    selectedToolkits.length > 0 ? (currentLanguage === 'zh' ? `${selectedToolkits.length} 个套件` : `${selectedToolkits.length} bundles`) : '',
  ].filter(Boolean).join(' | ');
  const reviewStageSummary = currentLanguage === 'zh'
    ? '核对当前配置，然后启动'
    : 'Review the current setup, then launch';
  const envState = getAssemblyEnvironmentState(draft);
  const envAssemblyName = envState.assemblyName;
  const envDir = envState.directory;
  const envStatus = envState.status;
  const envStatusLabel = getAssemblyEnvironmentStatusLabel(envStatus);
  const envStatusTone = getAssemblyEnvironmentStatusTone(envStatus);
  const envStatusMessage = envState.message
    || (envStatus === 'stale'
      ? (currentLanguage === 'zh'
        ? '当前名称与上次配置的环境不一致，需要重新配置环境目录。'
        : 'The current name no longer matches the configured environment. Reconfigure the environment directory.')
      : '');
  const envDirPreview = [
    envDir + '/',
    '  .agentdev/',
    '    audit/',
    '    plugins/',
    '    tts/',
    '  CLAUDE.md',
  ].join('\n');
  const environmentStageSummary = currentLanguage === 'zh'
    ? (envDir ? `${envStatusLabel}: ${envDir}` : '需要先填写 Agent 名称')
    : (envDir ? `${envStatusLabel}: ${envDir}` : 'Agent name required');
  const runningInstancesForDraft = recentRuns.filter((session) => (
    String(session?.agentName || '').trim() === String(draft.assembly_name || '').trim()
    && isAssemblySessionRunning(agent, session)
  )).length;
  const switcherValue = editorMode === 'editing-saved' ? assemblyName : '__new__';
  const switcherOptions = [
    '<option value="__new__"' + (switcherValue === '__new__' ? ' selected' : '') + '>' + escapeHtml(currentLanguage === 'zh' ? '新建配置' : 'New Setup') + '</option>',
    ...savedConfigs.map((item) => '<option value="' + escapeHtml(item.id) + '"' + (switcherValue === item.id ? ' selected' : '') + '>' + escapeHtml(item.name) + '</option>'),
  ].join('');
  const targetListHtml = [
    '<button class="assembly-target-item' + (editorMode !== 'editing-saved' ? ' active' : '') + '" type="button" onclick="window.switchAssemblyEditingTarget(&quot;__new__&quot;)">',
    '<span class="assembly-target-item-title">' + escapeHtml(currentLanguage === 'zh' ? '新建配置' : 'New Setup') + '</span>',
    '<span class="assembly-target-item-meta">' + escapeHtml(currentLanguage === 'zh' ? '开始一个新的 chatbot 配置。' : 'Start a fresh chatbot setup.') + '</span>',
    '</button>',
    ...savedConfigs.map((item) => (
      '<button class="assembly-target-item' + (switcherValue === item.id ? ' active' : '') + '" type="button" onclick="window.switchAssemblyEditingTarget(&quot;' + escapeHtml(item.id) + '&quot;)">' +
      '<span class="assembly-target-item-title">' + escapeHtml(item.name) + '</span>' +
      '<span class="assembly-target-item-meta">' + escapeHtml(item.goal || getAssemblyPresetLabel(item.preset)) + '</span>' +
      '</button>'
    )),
  ].join('');
  const stageListHtml = [
    { key: 'goal', title: currentLanguage === 'zh' ? '目标' : 'Goal', meta: goalStageSummary || (currentLanguage === 'zh' ? '明确这个 chatbot 要解决什么问题。' : 'Define what this chatbot should do.') },
    { key: 'capabilities', title: currentLanguage === 'zh' ? '能力' : 'Capabilities', meta: capabilityStageSummary },
    { key: 'environment', title: currentLanguage === 'zh' ? '环境' : 'Environment', meta: environmentStageSummary },
    { key: 'review', title: currentLanguage === 'zh' ? '启动' : 'Launch', meta: reviewStageSummary },
  ].map((item, index) => (
    '<button class="assembly-target-item' + (stage === item.key ? ' active' : '') + '" type="button" onclick="window.jumpAssemblyStage(&quot;' + escapeHtml(item.key) + '&quot;)">' +
    '<span class="assembly-target-item-title">' + escapeHtml(`${index + 1}. ${item.title}`) + '</span>' +
    '<span class="assembly-target-item-meta">' + escapeHtml(item.meta) + '</span>' +
    '</button>'
  )).join('');
  const presetCards = [
    'general-chatbot',
    'tool-operator',
    'workflow-assistant',
  ].map((item) => [
    '<div class="assembly-preset-card' + (preset === item ? ' active' : '') + '" onclick="window.applyAssemblyPreset(&quot;' + escapeHtml(formId) + '&quot;, &quot;' + escapeHtml(item) + '&quot;)">',
    '<div class="assembly-card-title">' + escapeHtml(getAssemblyPresetLabel(item)) + '</div>',
    '<div class="assembly-card-body">' + escapeHtml(getAssemblyPresetDescription(item)) + '</div>',
    '<button class="workspace-action' + (preset === item ? ' secondary' : '') + '" type="button" onclick="event.stopPropagation(); window.applyAssemblyPreset(&quot;' + escapeHtml(formId) + '&quot;, &quot;' + escapeHtml(item) + '&quot;)">' + escapeHtml(preset === item ? getRepoLocaleText('当前预设', 'Current Preset') : getRepoLocaleText('切换到此预设', 'Use This Preset')) + '</button>',
    '</div>',
  ].join('')).join('');

  const bundleCards = [
    {
      key: 'web-retrieval',
      title: currentLanguage === 'zh' ? '联网检索套件' : 'Web Retrieval',
      body: currentLanguage === 'zh' ? 'websearch + visual + audit' : 'websearch + visual + audit',
    },
    {
      key: 'memory-copilot',
      title: currentLanguage === 'zh' ? '记忆陪跑套件' : 'Memory Copilot',
      body: currentLanguage === 'zh' ? 'memory + audit' : 'memory + audit',
    },
    {
      key: 'dev-operator',
      title: currentLanguage === 'zh' ? '开发执行套件' : 'Dev Operator',
      body: currentLanguage === 'zh' ? 'shell + lsp + websearch' : 'shell + lsp + websearch',
    },
  ].map((item) => [
    '<div class="assembly-bundle-card' + (bundleFilter === item.key ? ' active' : '') + '" onclick="window.setBundleFilter(&quot;' + escapeHtml(formId) + '&quot;, &quot;' + escapeHtml(item.key) + '&quot;)">',
    '<div class="assembly-card-title">' + escapeHtml(item.title) + '</div>',
    '<div class="assembly-card-body">' + escapeHtml(item.body) + '</div>',
    '<button class="workspace-action' + (bundleFilter === item.key ? '' : ' secondary') + '" type="button" onclick="event.stopPropagation(); window.setBundleFilter(&quot;' + escapeHtml(formId) + '&quot;, &quot;' + escapeHtml(item.key) + '&quot;)">' + escapeHtml(bundleFilter === item.key ? getRepoLocaleText('显示全部', 'Show All') : getRepoLocaleText('筛选', 'Filter')) + '</button>',
    '</div>',
  ].join('')).join('');

  const featureCards = renderAssemblyFeatureCards(featuredPackages, selectedFeatures, formId, searchQuery, packages);

  return [
    '<div class="assembly-flow">',
    renderFlowWorkspaceProjectHero(agent, { active: 'assemble' }),
    '<section class="assembly-intro compact">',
    '<div class="workspace-section-title">' + escapeHtml(currentLanguage === 'zh' ? '组装当前 Agent 项目' : 'Assemble Current Agent Project') + '</div>',
    '<div class="assembly-workbench-note">' + escapeHtml(currentLanguage === 'zh'
      ? '配置 Agent 身份、选择 Feature 能力、准备运行环境，然后启动测试。编排图与项目一对一绑定。'
      : 'Configure Agent identity, select Feature capabilities, prepare runtime environment, then test. The graph is one-to-one bound to the project.') + '</div>',
    '</section>',
    '<aside class="assembly-side-rail"><section class="assembly-quick-dock"><div class="assembly-quick-dock-main"><div class="assembly-quick-dock-copy"><div class="assembly-quick-dock-title">' + escapeHtml(editorMode === 'editing-saved'
      ? (currentLanguage === 'zh' ? `编辑中：${assemblyName || '未命名配置'}` : `Editing: ${assemblyName || 'Untitled Setup'}`)
      : (currentLanguage === 'zh' ? `新建中：${assemblyName || '未命名 Agent'}` : `New: ${assemblyName || 'Untitled Agent'}`)) + '</div><div class="assembly-quick-dock-meta">' + escapeHtml([
        editorMode === 'editing-saved'
          ? (currentLanguage === 'zh' ? '自动保存中' : 'Auto-saved')
          : (currentLanguage === 'zh' ? '新建配置' : 'New Setup'),
        `${currentLanguage === 'zh' ? '步骤' : 'Step'} ${stage === 'goal' ? '1' : stage === 'capabilities' ? '2' : stage === 'environment' ? '3' : '4'}`,
        envStatusLabel,
      ].filter(Boolean).join(' · ')) + '</div></div><div class="assembly-quick-dock-actions"><button class="assembly-quick-dock-action" type="button" onclick="window.launchAssemblyInstance()">' + escapeHtml(currentLanguage === 'zh' ? '启动' : 'Launch') + '</button><button class="assembly-quick-dock-action" type="button" onclick="window.toggleAssemblyControlPanel()">' + escapeHtml(assemblyControlPanelOpen ? (currentLanguage === 'zh' ? '收起' : 'Close') : (currentLanguage === 'zh' ? '更多' : 'More')) + '</button></div></div></section>',
    assemblyControlPanelOpen ? '<section class="assembly-floating-panel"><div class="assembly-floating-head"><div><div class="assembly-floating-title">' + escapeHtml(editorMode === 'editing-saved'
      ? (currentLanguage === 'zh' ? `正在编辑 ${assemblyName || '未命名配置'}` : `Editing ${assemblyName || 'Untitled Setup'}`)
      : (currentLanguage === 'zh' ? `新建 ${assemblyName || '未命名 Agent'}` : `New ${assemblyName || 'Untitled Agent'}`)) + '</div><div class="assembly-floating-subtitle">' + escapeHtml(currentLanguage === 'zh'
      ? '切换当前编辑对象，常用动作也放在这里。'
      : 'Switch the current editing target here, with the most common actions close by.') + '</div></div><button class="workspace-action secondary" type="button" onclick="window.toggleAssemblyControlPanel()">' + escapeHtml(currentLanguage === 'zh' ? '关闭' : 'Close') + '</button></div><section class="assembly-editor-panel"><div class="assembly-editor-panel-title">' + escapeHtml(currentLanguage === 'zh' ? '步骤导航' : 'Step Navigation') + '</div><div class="assembly-target-list">' + stageListHtml + '</div></section><section class="assembly-editor-panel"><div class="assembly-editor-panel-title">' + escapeHtml(currentLanguage === 'zh' ? '编辑目标' : 'Editing Target') + '</div><div class="assembly-target-list">' + targetListHtml + '</div></section><div class="assembly-floating-actions"><button class="workspace-action" type="button" onclick="window.launchAssemblyInstance()">' + escapeHtml(currentLanguage === 'zh' ? '启动实例' : 'Launch Instance') + '</button></div></section>' : '',
    '</aside>',
    '<section class="assembly-stage' + (stage === 'goal' ? ' active' : '') + '">',
    renderAssemblyStageHeader(formId, stage, 'goal', 1, goalStageSummary),
    stage === 'goal' ? [
      '<div class="assembly-stage-body">',
      '<div class="assembly-form-grid">',
      '<label class="assembly-inline-field"><span class="assembly-inline-label">' + escapeHtml(currentLanguage === 'zh' ? '目标 Agent 名称' : 'Target Agent Name') + '</span><input class="assembly-inline-input" data-assembly-field="assembly_name" type="text" value="' + escapeHtml(String(draft.assembly_name || '')) + '" placeholder="' + escapeHtml(currentLanguage === 'zh' ? '例如 support-chatbot' : 'For example support-chatbot') + '" oninput="window.updateAssemblyDraftField(&quot;' + escapeHtml(formId) + '&quot;, &quot;assembly_name&quot;, this.value)" onblur="window.commitAssemblyDraftField(&quot;' + escapeHtml(formId) + '&quot;, &quot;assembly_name&quot;, this.value)"></label>',
      '<label class="assembly-inline-field full"><span class="assembly-inline-label">' + escapeHtml(currentLanguage === 'zh' ? '主要目标' : 'Goal') + '</span><textarea class="assembly-inline-textarea" data-assembly-field="goal" oninput="window.updateAssemblyDraftField(&quot;' + escapeHtml(formId) + '&quot;, &quot;goal&quot;, this.value)" onblur="window.commitAssemblyDraftField(&quot;' + escapeHtml(formId) + '&quot;, &quot;goal&quot;, this.value)">' + escapeHtml(String(draft.goal || '')) + '</textarea></label>',
      '</div>',
      '<details class="assembly-prompt-panel"' + (String(draft.advanced_prompt_open || '') === '1' ? ' open' : '') + ' ontoggle="window.updateWorkspaceFormDraft(&quot;' + escapeHtml(formId) + '&quot;, &quot;advanced_prompt_open&quot;, this.open ? &quot;1&quot; : &quot;0&quot;)">',
      '<summary class="assembly-card-title">' + escapeHtml(currentLanguage === 'zh' ? '高级：自定义系统提示词' : 'Advanced: Custom System Prompt') + '</summary>',
      '<div class="assembly-workbench-note">' + escapeHtml(currentLanguage === 'zh' ? '默认会根据目标、预设和已启用 Feature 自动生成系统提示词。只有你想强行微调行为时才需要覆盖。' : 'By default the system prompt is generated from the goal, preset, and enabled features. Override it only when you need to force behavior.') + '</div>',
      '<label class="assembly-inline-field"><span class="assembly-inline-label">' + escapeHtml(currentLanguage === 'zh' ? '自动生成版本' : 'Generated Prompt') + '</span><div class="assembly-generated-prompt">' + escapeHtml(generatedPrompt) + '</div></label>',
      '<label class="assembly-inline-field"><span class="assembly-inline-label">' + escapeHtml(currentLanguage === 'zh' ? '自定义覆盖内容（可留空）' : 'Custom Override (Optional)') + '</span><textarea class="assembly-inline-textarea" data-assembly-field="custom_system_prompt" oninput="window.updateAssemblyDraftField(&quot;' + escapeHtml(formId) + '&quot;, &quot;custom_system_prompt&quot;, this.value)" onblur="window.commitAssemblyDraftField(&quot;' + escapeHtml(formId) + '&quot;, &quot;custom_system_prompt&quot;, this.value)">' + escapeHtml(String(draft.custom_system_prompt || '')) + '</textarea></label>',
      '</details>',
      '<div class="assembly-stage-actions"><button class="workspace-action" type="button" onclick="window.updateWorkspaceFormDraft(&quot;' + escapeHtml(formId) + '&quot;, &quot;assembly_stage&quot;, &quot;capabilities&quot;)">' + escapeHtml(currentLanguage === 'zh' ? '下一步：选择能力' : 'Next: Choose Capabilities') + '</button></div>',
      '</div>',
    ].join('') : '',
    '</section>',
    '<section class="assembly-stage' + (stage === 'capabilities' ? ' active' : '') + '">',
    renderAssemblyStageHeader(formId, stage, 'capabilities', 2, capabilityStageSummary),
    stage === 'capabilities' ? [
      '<div class="assembly-stage-body">',
      '<div class="assembly-source-tabs">',
      '<button class="assembly-source-tab' + (sourceFilter === 'all' ? ' active' : '') + '" type="button" onclick="window.commitAssemblyDraftField(&quot;' + escapeHtml(formId) + '&quot;, &quot;feature_source_filter&quot;, &quot;all&quot;)">' + escapeHtml(currentLanguage === 'zh' ? '全部' : 'All') + '</button>',
      '<button class="assembly-source-tab' + (sourceFilter === 'preset' ? ' active' : '') + '" type="button" onclick="window.commitAssemblyDraftField(&quot;' + escapeHtml(formId) + '&quot;, &quot;feature_source_filter&quot;, &quot;preset&quot;)">' + escapeHtml(currentLanguage === 'zh' ? '预设' : 'Preset') + '</button>',
      '<button class="assembly-source-tab' + (sourceFilter === 'bundle' ? ' active' : '') + '" type="button" onclick="window.commitAssemblyDraftField(&quot;' + escapeHtml(formId) + '&quot;, &quot;feature_source_filter&quot;, &quot;bundle&quot;)">' + escapeHtml(currentLanguage === 'zh' ? '套件' : 'Bundle') + '</button>',
      '<button class="assembly-source-tab' + (sourceFilter === 'official' ? ' active' : '') + '" type="button" onclick="window.commitAssemblyDraftField(&quot;' + escapeHtml(formId) + '&quot;, &quot;feature_source_filter&quot;, &quot;official&quot;)">' + escapeHtml(currentLanguage === 'zh' ? '官方' : 'Official') + '</button>',
      '<button class="assembly-source-tab' + (sourceFilter === 'custom' ? ' active' : '') + '" type="button" onclick="window.commitAssemblyDraftField(&quot;' + escapeHtml(formId) + '&quot;, &quot;feature_source_filter&quot;, &quot;custom&quot;)">' + escapeHtml(currentLanguage === 'zh' ? '自定义' : 'Custom') + '</button>',
      '</div>',
      sourceFilter === 'preset' ? [
        '<div class="assembly-workbench-grid">' + presetCards + '</div>',
        '<div class="assembly-summary-block"><div class="assembly-summary-label">' + escapeHtml(currentLanguage === 'zh' ? '预设包含的 Feature（点击可取消）' : 'Preset Features (click to deselect)') + '</div><div class="assembly-summary-row">' + selectedFeatureChips + '</div></div>',
        '<div class="assembly-feature-grid">' + featureCards + '</div>',
      ].join('') : '',
      sourceFilter === 'bundle' ? [
        '<div class="assembly-workbench-grid">' + bundleCards + '</div>',
        '<div class="assembly-feature-grid">' + featureCards + '</div>',
      ].join('') : '',
      sourceFilter !== 'preset' && sourceFilter !== 'bundle' ? [
        '<div class="assembly-capability-topbar">',
        '<input class="assembly-search-input" style="flex:1 1 280px;min-height:40px;" type="text" value="' + escapeHtml(String(draft.feature_query || '')) + '" placeholder="' + escapeHtml(currentLanguage === 'zh' ? '按名称、说明或标签搜索' : 'Search by name, description, or tags') + '" oninput="window.updateAssemblyDraftField(&quot;' + escapeHtml(formId) + '&quot;, &quot;feature_query&quot;, this.value)" onblur="window.commitAssemblyDraftField(&quot;' + escapeHtml(formId) + '&quot;, &quot;feature_query&quot;, this.value)" onkeydown="if(event.key===&quot;Enter&quot;){event.preventDefault();window.commitAssemblyDraftField(&quot;' + escapeHtml(formId) + '&quot;,&quot;feature_query&quot;,this.value);}">',
        '<button class="workspace-action secondary" type="button" onclick="window.launchAssemblyInstance()">' + escapeHtml(currentLanguage === 'zh' ? '快速启动' : 'Quick Launch') + '</button>',
        '</div>',
        '<div class="assembly-summary-block"><div class="assembly-summary-label">' + escapeHtml(currentLanguage === 'zh' ? '当前已启用 Feature' : 'Enabled Features') + '</div><div class="assembly-summary-row">' + selectedFeatureChips + '</div></div>',
        '<div class="assembly-feature-grid">' + featureCards + '</div>',
      ].join('') : '',
      '<div class="assembly-stage-actions"><button class="workspace-action secondary" type="button" onclick="window.updateWorkspaceFormDraft(&quot;' + escapeHtml(formId) + '&quot;, &quot;assembly_stage&quot;, &quot;goal&quot;)">' + escapeHtml(currentLanguage === 'zh' ? '返回：修改目标' : 'Back: Edit Goal') + '</button><button class="workspace-action" type="button" onclick="window.updateWorkspaceFormDraft(&quot;' + escapeHtml(formId) + '&quot;, &quot;assembly_stage&quot;, &quot;environment&quot;)">' + escapeHtml(currentLanguage === 'zh' ? '下一步：环境准备' : 'Next: Environment Setup') + '</button></div>',
      '</div>',
    ].join('') : '',
    '</section>',
    '<section class="assembly-stage' + (stage === 'environment' ? ' active' : '') + '">',
    renderAssemblyStageHeader(formId, stage, 'environment', 3, environmentStageSummary),
    stage === 'environment' ? [
      '<div class="assembly-stage-body">',
      '<div class="assembly-summary-card">',
      '<div class="assembly-workbench-kicker">' + escapeHtml(currentLanguage === 'zh' ? 'Agent 独立工作环境' : 'Agent Workspace') + '</div>',
      '<div class="assembly-workbench-note">' + escapeHtml(currentLanguage === 'zh'
        ? '每个 Agent 项目拥有独立的工作目录，用于存放记忆、审计日志、配置文件等运行时数据。'
        : 'Each chatbot has its own workspace directory for memory, audit logs, config files, and other runtime data.') + '</div>',
      '<div class="assembly-summary-block"><div class="assembly-summary-label">' + escapeHtml(currentLanguage === 'zh' ? '当前状态' : 'Current Status') + '</div><div class="assembly-summary-copy"><span class="workspace-tag" style="border-color:' + escapeHtml(envStatusTone) + ';color:' + escapeHtml(envStatusTone) + ';">' + escapeHtml(envStatusLabel) + '</span></div></div>',
      '<div class="assembly-summary-block"><div class="assembly-summary-label">' + escapeHtml(currentLanguage === 'zh' ? '环境目录' : 'Environment Directory') + '</div><div class="assembly-summary-copy"><code>' + escapeHtml(envDir || (currentLanguage === 'zh' ? '未设置' : 'Not set')) + '</code></div></div>',
      '<div class="assembly-summary-block"><div class="assembly-summary-label">' + escapeHtml(currentLanguage === 'zh' ? '将创建的目录结构' : 'Directory Structure') + '</div><div class="assembly-summary-copy"><pre style="margin:0;white-space:pre-wrap;font-size:13px;line-height:1.5;">' + escapeHtml(envDir ? envDirPreview : (currentLanguage === 'zh' ? '请先在第一步填写 Agent 名称' : 'Please set an agent name in step 1')) + '</pre></div></div>',
      envStatusMessage ? '<div class="assembly-summary-block"><div class="assembly-summary-copy" style="color:' + escapeHtml(envStatusTone) + ';">' + escapeHtml(envStatusMessage) + '</div></div>' : '',
      '<div class="assembly-summary-block"><div class="assembly-summary-label">' + escapeHtml(currentLanguage === 'zh' ? '启动时会发生什么' : 'What Happens On Launch') + '</div><div class="assembly-summary-copy">' + escapeHtml(currentLanguage === 'zh'
        ? '1. 先检查并准备用户目录环境。 2. 然后在该目录执行 npm install，安装 agentdev 和你选中的 Features。 3. 最后启动 chatbot runtime。'
        : '1. Prepare the user environment directory. 2. Run npm install there for agentdev and the selected features. 3. Launch the chatbot runtime.') + '</div></div>',
      '<div class="assembly-summary-actions">',
      '<button class="workspace-action" type="button" onclick="window.createAssemblyEnvironment()">' + escapeHtml(envState.isReady ? (currentLanguage === 'zh' ? '重新配置环境' : 'Reconfigure Environment') : (currentLanguage === 'zh' ? '创建环境' : 'Create Environment')) + '</button>',
      '</div>',
      '</div>',
      '<div class="assembly-stage-actions">',
      '<button class="workspace-action secondary" type="button" onclick="window.updateWorkspaceFormDraft(&quot;' + escapeHtml(formId) + '&quot;, &quot;assembly_stage&quot;, &quot;capabilities&quot;)">' + escapeHtml(currentLanguage === 'zh' ? '返回：修改能力' : 'Back: Edit Capabilities') + '</button>',
      '<button class="workspace-action" type="button" onclick="window.updateWorkspaceFormDraft(&quot;' + escapeHtml(formId) + '&quot;, &quot;assembly_stage&quot;, &quot;review&quot;)">' + escapeHtml(currentLanguage === 'zh' ? '下一步：确认与启动' : 'Next: Review And Launch') + '</button>',
      '</div>',
      '</div>',
    ].join('') : '',
    '</section>',
    '<section class="assembly-stage' + (stage === 'review' ? ' active' : '') + '">',
    renderAssemblyStageHeader(formId, stage, 'review', 4, reviewStageSummary),
    stage === 'review' ? [
      '<div class="assembly-stage-body">',
      '<div class="assembly-summary-card">',
      '<div class="assembly-workbench-kicker">' + escapeHtml(currentLanguage === 'zh' ? '你即将启动的 Agent' : 'The Agent You Are About To Launch') + '</div>',
      '<div class="assembly-summary-title">' + escapeHtml(assemblyName) + '</div>',
      '<div class="assembly-summary-copy">' + escapeHtml(goalSummary || (currentLanguage === 'zh' ? '还没有填写主要目标，建议至少补一句这个 Agent 要解决什么问题。' : 'No primary goal yet. Add at least one sentence describing what this agent should solve.')) + '</div>',
      '<div class="assembly-summary-block"><div class="assembly-summary-label">' + escapeHtml(currentLanguage === 'zh' ? '预设' : 'Preset') + '</div><div class="assembly-summary-copy">' + escapeHtml(getAssemblyPresetLabel(preset)) + ' · ' + escapeHtml(getAssemblyPresetDescription(preset)) + '</div></div>',
      '<div class="assembly-summary-block"><div class="assembly-summary-label">' + escapeHtml(currentLanguage === 'zh' ? '套件' : 'Bundles') + '</div><div class="assembly-summary-row">' + selectedToolkitChips + '</div></div>',
      '<div class="assembly-summary-block"><div class="assembly-summary-label">' + escapeHtml(currentLanguage === 'zh' ? '已启用 Feature' : 'Enabled Features') + '</div><div class="assembly-summary-row">' + selectedFeatureChips + '</div></div>',
      '<div class="assembly-summary-block"><div class="assembly-summary-label">' + escapeHtml(currentLanguage === 'zh' ? '环境状态' : 'Environment Status') + '</div><div class="assembly-summary-copy"><span class="workspace-tag" style="border-color:' + escapeHtml(envStatusTone) + ';color:' + escapeHtml(envStatusTone) + ';">' + escapeHtml(envStatusLabel) + '</span>' + (envDir ? ' <code>' + escapeHtml(envDir) + '</code>' : '') + '</div></div>',
      envStatusMessage ? '<div class="assembly-summary-block"><div class="assembly-summary-copy" style="color:' + escapeHtml(envStatusTone) + ';">' + escapeHtml(envStatusMessage) + '</div></div>' : '',
      '<div class="assembly-summary-block"><div class="assembly-summary-label">' + escapeHtml(currentLanguage === 'zh' ? '最终系统提示词' : 'Effective System Prompt') + '</div><div class="assembly-generated-prompt">' + escapeHtml(effectivePrompt) + '</div></div>',
      '<div class="assembly-summary-actions">',
      '<button class="workspace-action" type="button" onclick="window.launchAssemblyInstance()">' + escapeHtml(currentLanguage === 'zh' ? '启动测试 Agent' : 'Launch Test Agent') + '</button>',
      '<button class="workspace-action secondary" type="button" onclick="window.updateWorkspaceFormDraft(&quot;' + escapeHtml(formId) + '&quot;, &quot;assembly_stage&quot;, &quot;environment&quot;)">' + escapeHtml(currentLanguage === 'zh' ? '返回：环境准备' : 'Back: Environment') + '</button>',
      '<button class="workspace-action secondary" type="button" onclick="window.runWorkspaceAction(JSON.stringify({type: \'show_workspace_tab\', tab: \'projects\'}))">' + escapeHtml(currentLanguage === 'zh' ? '查看项目总览' : 'View Project') + '</button>',
      '<button class="workspace-action secondary" type="button" onclick="window.runWorkspaceAction(JSON.stringify({type: \'show_workspace_tab\', tab: \'project\'}))">' + escapeHtml(currentLanguage === 'zh' ? '升级到项目开发' : 'Promote To Project') + '</button>',
      '</div>',
      '</div>',
      '</div>',
    ].join('') : '',
    '</section>',
    '</div>',
  ].join('');
}

function getWorkspaceArtifactData(agent, block) {
  const blockId = String(block?.id || '').trim();
  if (!blockId) return null;
  const workspaceData = agent?.workspace_data;
  if (!workspaceData || typeof workspaceData !== 'object') return null;
  return workspaceData[blockId] || null;
}

function getArtifactKindLabel(value) {
  const map = {
    draft: 'draft',
    plan: 'plan',
    handoff: 'handoff',
    progress: 'progress',
    decision: 'decision',
    verification: 'verification',
    'debug-report': 'debug-report',
  };
  return map[value] || value || 'artifact';
}

function buildArtifactPreview(item) {
  const payload = item?.payload && typeof item.payload === 'object' ? item.payload : {};
  const candidates = [
    payload.goal,
    payload.constraints,
    payload.planned_features,
    payload.feature_name,
    payload.agent_name,
    payload.target_user,
    payload.runtime_style,
  ];
  const matched = candidates.find((value) => typeof value === 'string' && value.trim());
  return matched ? String(matched).trim() : '';
}

function getSelectedArtifactId(agent, block) {
  if (!currentWorkspaceArtifactDetail) return '';
  if (currentWorkspaceArtifactDetail.agentId !== agent?.id) return '';
  if (currentWorkspaceArtifactDetail.blockId !== String(block?.id || '')) return '';
  return currentWorkspaceArtifactDetail.artifactId || '';
}

function renderArtifactPayloadDetails(item) {
  const payload = item?.payload && typeof item.payload === 'object' ? item.payload : {};
  const entries = Object.entries(payload)
    .filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== '');

  if (entries.length === 0) {
    return '<div class="workspace-history-meta">No payload details.</div>';
  }

  return '<div class="workspace-history-list">' + entries.map(([key, value]) => {
    return [
      '<div class="workspace-history-item">',
      '<div class="workspace-history-main">',
      '<div class="workspace-history-title">' + escapeHtml(String(key)) + '</div>',
      '<div class="workspace-history-preview">' + escapeHtml(String(value)) + '</div>',
      '</div>',
      '</div>',
    ].join('');
  }).join('') + '</div>';
}

function getWorkspaceLabelFromId(value) {
  if (value === 'feature-creator') return 'Feature Creator';
  if (value === 'agent-creator') return 'Agent Creator';
  return value || 'Workspace';
}

function renderWorkspaceArtifactsBlock(agent, block) {
  const data = getWorkspaceArtifactData(agent, block);
  const title = localizeWorkspaceValue(block.title, 'Artifacts');
  const desc = localizeWorkspaceValue(block.description, '');
  const items = Array.isArray(data?.items) ? data.items : [];
  const emptyText = localizeWorkspaceValue(block.emptyText, 'No artifacts yet.');
  const currentOpenDirectory = String(getAgentWorkspaceState(agent)?.openDirectory || '').trim();
  const scopedDesc = currentOpenDirectory
    ? ((desc ? desc + ' ' : '') + currentOpenDirectory)
    : desc;
  const selectedArtifactId = getSelectedArtifactId(agent, block);
  const selectedItem = items.find((item) => String(item?.id || '') === selectedArtifactId) || null;

  const bodyHtml = items.length > 0
    ? '<div class="workspace-docset-panel"><div class="workspace-docset-panel-body"><div class="workspace-docset-ledger">' + items.map((item) => {
        const preview = buildArtifactPreview(item);
        const kind = getArtifactKindLabel(item.kind);
        const relatedDir = String(item?.relatedTo?.openDirectory || '').trim();
        const sourceWorkspace = String(item?.source?.workspace || data?.workspaceId || '').trim();
        const openAction = escapeHtml(JSON.stringify({
          type: 'open_artifact_preview',
          blockId: String(block?.id || ''),
          artifactId: item.id,
        }));
        return [
          '<div class="workspace-docset-row">',
          '<div>',
          '<div class="workspace-docset-row-title">' + escapeHtml(item.title || item.id || kind) + '</div>',
          preview ? '<div class="workspace-docset-row-preview">' + escapeHtml(preview) + '</div>' : '',
          '<div class="workspace-docset-row-meta"><span>' + escapeHtml(kind) + '</span><span>' + escapeHtml(formatWorkspaceDate(item.updatedAt)) + '</span>' + (relatedDir ? '<span>' + escapeHtml(relatedDir) + '</span>' : '') + (sourceWorkspace ? '<span>' + escapeHtml(getWorkspaceLabelFromId(sourceWorkspace)) + '</span>' : '') + '</div>',
          '</div>',
          '<div class="workspace-actions"><button class="workspace-action secondary" type="button" data-workspace-action="' + openAction + '" onclick="window.runWorkspaceAction(this.dataset.workspaceAction, this)">查看</button></div>',
          '</div>',
        ].join('');
      }).join('') + '</div></div></div>'
    : '<div class="workspace-docset-panel"><div class="workspace-docset-panel-body"><div class="workspace-docset-row"><div class="workspace-docset-row-preview">' + escapeHtml(emptyText) + '</div></div></div></div>';

  const detailHtml = selectedItem
    ? [
        '<div class="workspace-docset-detail">',
        '<div class="workspace-docset-panel">',
        '<div class="workspace-docset-panel-head"><div class="workspace-docset-panel-title">' + escapeHtml(selectedItem.title || selectedItem.id || 'artifact') + '</div><div class="workspace-actions">',
        selectedItem?.source?.workspace
          ? '<button class="workspace-action" type="button" data-workspace-action="' + escapeHtml(JSON.stringify({ type: 'navigate_unit', targetAgentId: String(selectedItem.source.workspace) })) + '" onclick="window.runWorkspaceAction(this.dataset.workspaceAction, this)">进入来源工作空间</button>'
          : '',
        '<button class="workspace-action secondary" type="button" data-workspace-action="' + escapeHtml(JSON.stringify({ type: 'close_artifact_preview', blockId: String(block?.id || '') })) + '" onclick="window.runWorkspaceAction(this.dataset.workspaceAction, this)">关闭预览</button>',
        '</div></div>',
        '<div class="workspace-docset-panel-body">',
        '<div class="workspace-docset-chip-row"><span class="workspace-docset-chip">' + escapeHtml(getArtifactKindLabel(selectedItem.kind)) + '</span><span class="workspace-docset-chip">' + escapeHtml(formatWorkspaceDate(selectedItem.updatedAt)) + '</span>' + (selectedItem?.relatedTo?.openDirectory ? '<span class="workspace-docset-chip">' + escapeHtml(String(selectedItem.relatedTo.openDirectory)) + '</span>' : '') + '</div>',
        renderArtifactPayloadDetails(selectedItem),
        '</div>',
        '</div>',
      ].join('')
    : '';

  return [
    '<section class="workspace-section">',
    '<div class="workspace-section-header">',
    '<div>',
    '<div class="workspace-section-title">' + escapeHtml(title) + '</div>',
    '<div class="workspace-section-desc">' + escapeHtml(scopedDesc || (data?.artifactCount != null ? `${data.artifactCount} artifacts` : '')) + '</div>',
    '</div>',
    '</div>',
    bodyHtml,
    detailHtml,
    '</section>',
  ].join('');
}

function getProjectDocsetData(agent, block) {
  const blockId = String(block?.id || '').trim();
  if (!blockId) return null;
  const workspaceData = agent?.workspace_data;
  if (!workspaceData || typeof workspaceData !== 'object') return null;
  return workspaceData[blockId] || null;
}

function getCurrentProjectDocset(agent = getCurrentAgentRecord()) {
  const workspaceData = agent?.workspace_data;
  if (!workspaceData || typeof workspaceData !== 'object') return null;
  const data = workspaceData['project-docset'];
  return data && typeof data === 'object' ? data : null;
}

function getSelectedProjectDocsetDetail(agent, block) {
  if (!currentWorkspaceDocsetDetail) return null;
  if (currentWorkspaceDocsetDetail.agentId !== agent?.id) return null;
  if (currentWorkspaceDocsetDetail.blockId !== String(block?.id || '')) return null;
  return currentWorkspaceDocsetDetail;
}

function getWorkspaceUiBlock(agent, blockId) {
  const ui = getCurrentUnitUi(agent);
  const blocks = Array.isArray(ui?.home?.blocks) ? ui.home.blocks : [];
  return blocks.find((item) => String(item?.id || '') === String(blockId || '')) || null;
}

function isProjectRequirementEditing(agent) {
  return !!(currentProjectRequirementEdit && currentProjectRequirementEdit.agentId === (agent?.id || ''));
}

function getProjectRequirementDraft(agent) {
  const forms = getWorkspaceFormDraft(agent);
  const startupForm = forms?.['startup-form'];
  return startupForm && typeof startupForm === 'object' ? startupForm : {};
}

function resetProjectRequirementDraft(agent) {
  if (!agent?.id) return;
  const forms = getWorkspaceFormDraft(agent);
  const serverForm = getAgentWorkspaceState(agent)?.forms?.['startup-form'] || {};
  forms['startup-form'] = normalizeWorkspaceStartupDraft(agent, { ...serverForm });
  saveWorkspaceFormDraft(agent.id, forms);
}

function renderProjectDocsetFields(fields) {
  const entries = Object.entries(fields || {}).filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== '');
  if (entries.length === 0) {
    return '<div class="workspace-docset-row-preview">当前没有可展示的字段。</div>';
  }
  return '<div class="workspace-docset-fields">' + entries.map(([key, value]) => (
    '<div class="workspace-docset-field"><div class="workspace-docset-field-label">' + escapeHtml(String(key)) + '</div><div class="workspace-docset-field-value">' + escapeHtml(String(value)) + '</div></div>'
  )).join('') + '</div>';
}

function renderProjectRequirementCards(agent, requirementBlock, draft) {
  const fields = Array.isArray(requirementBlock?.fields) ? requirementBlock.fields : [];
  const rows = fields.map((field) => {
    const key = String(field?.name || '').trim();
    if (!key) return '';
    const label = localizeWorkspaceValue(field.label, key);
    const value = draft[key];
    if (value === undefined || value === null || String(value).trim() === '') return '';
    return [
      '<div class="project-docset-requirement-row">',
      '<div class="project-docset-requirement-key">' + escapeHtml(label) + '</div>',
      '<div class="project-docset-requirement-text">' + escapeHtml(String(value)) + '</div>',
      '</div>',
    ].join('');
  }).filter(Boolean).join('');

  return rows
    ? '<div class="project-docset-requirement-stack">' + rows + '</div>'
    : '<div class="project-docset-detail-empty">当前项目还没有需求内容。先把目标、目录和约束补进去。</div>';
}

function renderProjectDocsetList(title, count, itemsHtml) {
  return [
    '<section class="project-docset-group">',
    '<div class="project-docset-group-head">',
    '<div class="project-docset-group-title">' + escapeHtml(title) + '</div>',
    '<div class="project-docset-group-count">' + escapeHtml(String(count)) + '</div>',
    '</div>',
    '<div class="project-docset-list">' + itemsHtml + '</div>',
    '</section>',
  ].join('');
}

function renderProjectDocsetSidebarItem(title, preview, meta, section, itemId, blockId, options = {}) {
  const active = !!options.active;
  const tag = options.tag ? '<span class="project-docset-item-tag">' + escapeHtml(options.tag) + '</span>' : '';
  const action = escapeHtml(JSON.stringify({
    type: 'open_project_docset_preview',
    blockId: String(blockId || ''),
    section,
    itemId,
  }));
  return [
    '<button class="project-docset-item' + (active ? ' active' : '') + '" type="button" data-workspace-action="' + action + '" onclick="window.runWorkspaceAction(this.dataset.workspaceAction, this)">',
    '<div class="project-docset-item-top">',
    '<div class="project-docset-item-title">' + escapeHtml(title) + '</div>',
    tag,
    '</div>',
    preview ? '<div class="project-docset-item-preview">' + escapeHtml(preview) + '</div>' : '',
    meta ? '<div class="project-docset-item-meta">' + meta.map((item) => '<span>' + escapeHtml(String(item)) + '</span>').join('') + '</div>' : '',
    '</button>',
  ].join('');
}

function renderProjectDocsetDetailList(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return '<div class="project-docset-detail-empty">这里暂时没有内容。</div>';
  }
  return '<div class="project-docset-detail-list">' + items.map((item) => (
    '<div class="project-docset-detail-list-item">' + escapeHtml(String(item)) + '</div>'
  )).join('') + '</div>';
}

function resolveProjectDocsetDetail(agent, block, data) {
  const selected = getSelectedProjectDocsetDetail(agent, block);
  const currentConversationRecord = data?.currentConversationRecord && typeof data.currentConversationRecord === 'object' ? data.currentConversationRecord : null;
  const conversationRecords = Array.isArray(data?.conversationRecords) ? data.conversationRecords : [];
  const materials = Array.isArray(data?.materials) ? data.materials : [];

  if (selected?.section === 'conversation') {
    const record = conversationRecords.find((item) => String(item.sessionId || '') === selected.itemId) || currentConversationRecord;
    if (record) return { type: 'conversation', value: record };
  }
  if (selected?.section === 'material') {
    const material = materials.find((item) => String(item.id || '') === selected.itemId);
    if (material) return { type: 'material', value: material };
  }

  if (currentConversationRecord) return { type: 'conversation', value: currentConversationRecord };
  if (materials[0]) return { type: 'material', value: materials[0] };
  return null;
}

function renderProjectDocsetDetailPane(detail) {
  if (!detail) {
    return '<div class="project-docset-detail-empty">从左侧选择一条推进记录或资料，就会在这里展开。</div>';
  }

  if (detail.type === 'conversation') {
    const record = detail.value || {};
    const blocks = [];
    if (record.summary) {
      blocks.push('<section class="project-docset-detail-block"><div class="project-docset-detail-block-title">阶段总结</div><div class="project-docset-requirement-value">' + escapeHtml(String(record.summary)) + '</div></section>');
    }
    if (record.currentFocus) {
      blocks.push('<section class="project-docset-detail-block"><div class="project-docset-detail-block-title">当前焦点</div><div class="project-docset-requirement-value">' + escapeHtml(String(record.currentFocus)) + '</div></section>');
    }
    if (Array.isArray(record.keyDecisions) && record.keyDecisions.length > 0) {
      blocks.push('<section class="project-docset-detail-block"><div class="project-docset-detail-block-title">关键决策</div>' + renderProjectDocsetDetailList(record.keyDecisions) + '</section>');
    }
    if (Array.isArray(record.nextActions) && record.nextActions.length > 0) {
      blocks.push('<section class="project-docset-detail-block"><div class="project-docset-detail-block-title">下一步</div>' + renderProjectDocsetDetailList(record.nextActions) + '</section>');
    }
    if (Array.isArray(record.openQuestions) && record.openQuestions.length > 0) {
      blocks.push('<section class="project-docset-detail-block"><div class="project-docset-detail-block-title">待确认问题</div>' + renderProjectDocsetDetailList(record.openQuestions) + '</section>');
    }
    if ((record.relatedMaterialIds || []).length > 0) {
      blocks.push('<section class="project-docset-detail-block"><div class="project-docset-detail-block-title">关联资料</div>' + renderProjectDocsetFields({
        relatedMaterialIds: Array.isArray(record.relatedMaterialIds) ? record.relatedMaterialIds.join(', ') : '',
      }) + '</section>');
    }

    return [
      '<div class="project-docset-detail-card">',
      '<div class="project-docset-detail-head">',
      '<div>',
      '<div class="project-docset-detail-kicker">推进记录</div>',
      '<div class="project-docset-detail-title">' + escapeHtml(record.title || record.sessionId || 'Conversation') + '</div>',
      '<div class="project-docset-detail-subtitle">' + escapeHtml([record.sessionId || '', formatWorkspaceDate(record.updatedAt)].filter(Boolean).join(' · ')) + '</div>',
      '</div>',
      '</div>',
      blocks.join('') || '<div class="project-docset-detail-empty">这条推进记录还比较空，可以继续补阶段总结、关键决策和下一步。</div>',
      '</div>',
    ].join('');
  }

  if (detail.type === 'material') {
    const material = detail.value || {};
    return [
      '<div class="project-docset-detail-card">',
      '<div class="project-docset-detail-head">',
      '<div>',
      '<div class="project-docset-detail-kicker">资料</div>',
      '<div class="project-docset-detail-title">' + escapeHtml(material.title || material.id || 'Material') + '</div>',
      '<div class="project-docset-detail-subtitle">' + escapeHtml(formatWorkspaceDate(material.updatedAt)) + '</div>',
      '</div>',
      '</div>',
      ((material.sourcePath || material.path)
        ? '<section class="project-docset-detail-block"><div class="project-docset-detail-block-title">来源路径</div>' + renderProjectDocsetFields({
          sourcePath: material.sourcePath || '',
          materialPath: material.path || '',
        }) + '</section>'
        : ''),
      '<section class="project-docset-detail-block"><div class="project-docset-detail-block-title">文档正文</div><div class="feature-panel-section overview-doc"><div class="markdown-body">' + renderMarkdown(material.content || '') + '</div></div></section>',
      '</div>',
    ].join('');
  }

  return '<div class="project-docset-detail-empty">当前没有可展开的内容。</div>';
}

function getProjectDocsetPage() {
  return ['requirement', 'log', 'materials'].includes(currentProjectDocsetPage)
    ? currentProjectDocsetPage
    : 'requirement';
}

function renderProjectDocsetContent(agent, block, data) {
  const requirementForm = data?.requirementForm?.payload && typeof data.requirementForm.payload === 'object' ? data.requirementForm.payload : {};
  const currentConversationRecord = data?.currentConversationRecord && typeof data.currentConversationRecord === 'object' ? data.currentConversationRecord : null;
  const conversationRecords = Array.isArray(data?.conversationRecords) ? data.conversationRecords : [];
  const materials = Array.isArray(data?.materials) ? data.materials : [];
  const selected = getSelectedProjectDocsetDetail(agent, block);
  const requirementBlock = getWorkspaceUiBlock(agent, 'startup-form');
  const requirementDraft = getProjectRequirementDraft(agent);
  const editingRequirement = isProjectRequirementEditing(agent);
  const effectiveRequirement = editingRequirement ? requirementDraft : { ...requirementForm, ...requirementDraft };
  const currentSessionId = String(data?.currentSessionId || 'workspace');
  const page = getProjectDocsetPage();
  const combinedConversations = [
    ...(currentConversationRecord ? [{ ...currentConversationRecord, __current: true }] : []),
    ...conversationRecords.filter((item) => String(item?.sessionId || '') !== String(currentConversationRecord?.sessionId || '')),
  ];
  const activeSection = selected?.section || '';
  const activeItemId = selected?.itemId || '';
  const hasExplicitSelection = Boolean(activeSection && activeItemId);
  const detail = resolveProjectDocsetDetail(agent, block, data);

  const conversationItemsHtml = combinedConversations.length > 0
    ? combinedConversations.map((item) => renderProjectDocsetSidebarItem(
        item.title || item.sessionId || 'Conversation',
        item.summary || item.currentFocus || '这条推进记录还没有明确摘要。',
        [item.__current ? '当前对话' : (item.sessionId || ''), formatWorkspaceDate(item.updatedAt)].filter(Boolean),
        'conversation',
        item.sessionId || currentSessionId,
        String(block?.id || ''),
        {
          active: hasExplicitSelection
            ? (activeSection === 'conversation' && activeItemId === String(item.sessionId || ''))
            : !!item.__current,
          tag: item.__current ? 'Now' : 'Log',
        },
      )).join('')
    : '<div class="project-docset-detail-empty">当前项目还没有推进记录。先把这次对话的阶段结论写进去。</div>';

  const materialItemsHtml = materials.length > 0
    ? materials.map((item) => renderProjectDocsetSidebarItem(
        item.title || item.id || 'Material',
        item.sourcePath || item.path || item.preview || '这份资料还没有摘要。',
        [item.sourcePath || item.path || '', formatWorkspaceDate(item.updatedAt)].filter(Boolean),
        'material',
        item.id,
        String(block?.id || ''),
        {
          active: hasExplicitSelection
            ? (activeSection === 'material' && activeItemId === String(item.id || ''))
            : (!currentConversationRecord && materials[0] && materials[0].id === item.id),
          tag: 'Doc',
        },
      )).join('')
    : '<div class="project-docset-detail-empty">当前还没有资料。AI 方案、外部文档和参考说明都可以放在这里。</div>';

  const requirementTitle = agent?.id === 'agent-creator' ? 'Agent 需求' : '用户需求';
  const requirementSummary = effectiveRequirement.goal || effectiveRequirement.agent_goal || effectiveRequirement.agent_name || effectiveRequirement.feature_name || '当前还没有明确目标。';
  const requirementBody = editingRequirement
    ? [
        '<div class="project-docset-requirement-form">',
        (Array.isArray(requirementBlock?.fields) ? requirementBlock.fields : []).map((field) => renderWorkspaceField(agent, field, requirementDraft, 'startup-form')).join(''),
        '</div>',
        '<div class="project-docset-requirement-actions">',
        '<button class="workspace-action secondary" type="button" onclick="window.cancelProjectRequirementEdit()">取消</button>',
        '<button class="workspace-action" type="button" onclick="window.saveProjectRequirementForm()">保存需求</button>',
        '</div>',
      ].join('')
    : renderProjectRequirementCards(agent, requirementBlock, effectiveRequirement);

  const pagerHtml = [
    { id: 'requirement', label: '需求' },
    { id: 'log', label: '推进记录' },
    { id: 'materials', label: '资料' },
  ].map((item) => (
    '<button class="project-docset-tab' + (page === item.id ? ' active' : '') + '" type="button" onclick="window.setProjectDocsetPage(&quot;' + escapeHtml(item.id) + '&quot;)">' + escapeHtml(item.label) + '</button>'
  )).join('');

  const requirementPageHtml = [
    '<div class="project-docset-page requirement-page">',
    '<div class="project-docset-requirement">',
    '<div class="project-docset-requirement-head">',
    '<div>',
    '<div class="project-docset-requirement-title">' + escapeHtml(requirementTitle) + '</div>',
    '<div class="project-docset-requirement-subtitle">这里保存项目目标、约束和上下文，是后续所有对话共享的起点。</div>',
    '</div>',
    '<div class="workspace-actions">' + (
      editingRequirement
        ? '<button class="workspace-action secondary" type="button" onclick="window.cancelProjectRequirementEdit()">退出编辑</button>'
        : '<button class="workspace-action secondary" type="button" onclick="window.startProjectRequirementEdit()">编辑需求</button>'
    ) + '</div>',
    '</div>',
    requirementBody,
    '</div>',
    '</div>',
  ].join('');

  const logPageHtml = [
    '<div class="project-docset-page">',
    '<div class="project-docset-browser">',
    '<aside class="project-docset-browser-list">',
    renderProjectDocsetList('推进记录', combinedConversations.length, conversationItemsHtml),
    '</aside>',
    '<section class="project-docset-browser-detail">' + renderProjectDocsetDetailPane(detail && detail.type === 'conversation' ? detail : (combinedConversations.length > 0 ? { type: 'conversation', value: combinedConversations[0] } : null)) + '</section>',
    '</div>',
    '</div>',
  ].join('');

  const materialsPageHtml = [
    '<div class="project-docset-page">',
    '<div class="project-docset-page-head">',
    '<div class="project-docset-page-note">这里放可复用的资料引用：AI 方案书、外部文档、参考目录或本地文件路径。</div>',
    '<div class="workspace-actions">',
    '<button class="workspace-action secondary" type="button" onclick="window.openProjectMaterialImport(&quot;files&quot;)">导入文件</button>',
    '<button class="workspace-action secondary" type="button" onclick="window.openProjectMaterialImport(&quot;folder&quot;)">导入文件夹</button>',
    '</div>',
    '</div>',
    '<div class="project-docset-browser">',
    '<aside class="project-docset-browser-list">',
    renderProjectDocsetList('资料', materials.length, materialItemsHtml),
    '</aside>',
    '<section class="project-docset-browser-detail">' + renderProjectDocsetDetailPane(detail && detail.type === 'material' ? detail : (materials.length > 0 ? { type: 'material', value: materials[0] } : null)) + '</section>',
    '</div>',
    '</div>',
  ].join('');

  const pageBody = page === 'requirement'
    ? requirementPageHtml
    : (page === 'log' ? logPageHtml : materialsPageHtml);

  return [
    '<div class="project-docset-shell-v2">',
    '<div class="project-docset-topbar">',
    '<div class="project-docset-tabs">' + pagerHtml + '</div>',
    '</div>',
    pageBody,
    '</div>',
  ].join('');
}

function renderProjectDocsetBlock(agent, block) {
  const data = getProjectDocsetData(agent, block);
  const title = localizeWorkspaceValue(block.title, 'Project Docset');
  const desc = localizeWorkspaceValue(block.description, '');
  const emptyText = localizeWorkspaceValue(block.emptyText, 'No project docset yet.');

  if (!data?.exists) {
    return [
      '<section class="workspace-section">',
      '<div class="workspace-section-header"><div><div class="workspace-section-title">' + escapeHtml(title) + '</div><div class="workspace-section-desc">' + escapeHtml(desc) + '</div></div></div>',
      '<div class="workspace-history-list"><div class="workspace-history-item"><div>' + escapeHtml(emptyText) + '</div></div></div>',
      '</section>',
    ].join('');
  }

  return [
    '<section class="workspace-section workspace-docset-shell">',
    '<div class="workspace-section-header"><div><div class="workspace-section-title">' + escapeHtml(title) + '</div><div class="workspace-section-desc">' + escapeHtml(desc || (data?.projectDir || '')) + '</div></div></div>',
    renderProjectDocsetContent(agent, block, data),
    '</section>',
  ].join('');
}

function renderWorkspaceBlock(agent, block) {
  if (!shouldRenderBlock(block)) return '';
  if (block.type === 'hero') return renderWorkspaceHero(agent, block);
  if (block.type === 'launcher-grid') return renderWorkspaceLauncherGrid(agent, block);
  if (block.type === 'action-group') return renderWorkspaceActionGroup(block);
  if (block.type === 'session-list') return renderWorkspaceSessionList(agent, block);
  if (block.type === 'form') return renderWorkspaceForm(agent, block);
  if (block.type === 'status-grid') return renderWorkspaceStatusGrid(agent, block);
  if (block.type === 'assembly-library') return renderAssemblyLibraryBlock(agent, block);
  if (block.type === 'assembly-workbench') return renderAssemblyWorkbenchBlock(agent, block);
  if (block.type === 'project-list') return renderProjectListBlock(agent, block);
  if (block.type === 'feature-repository') return renderFeatureRepositoryBlock(agent, block);
  if (block.type === 'workspace-artifacts') return renderWorkspaceArtifactsBlock(agent, block);
  if (block.type === 'project-docset') return renderProjectDocsetBlock(agent, block);
  if (block.type === 'config-editor') return isIMWorkspaceConfigEditor(block) ? renderIMWorkspaceConfigEditor(block) : '';
  if (block.type === 'flow-editor') return renderFlowEditorBlock(agent, block);
  return '';
}

function renderWorkspaceSurface(agent = getCurrentAgentRecord()) {
  const ui = getCurrentUnitUi(agent);
  if (!agent || !ui) {
    return getEmptyStateHtml();
  }

  const blocks = Array.isArray(ui.home?.blocks) ? ui.home.blocks : [];
  const content = blocks.map((block) => renderWorkspaceBlock(agent, block)).filter(Boolean).join('');
  const hasAssemblyWorkbench = blocks.some((block) => block?.type === 'assembly-workbench');
  const animateClass = shouldAnimateWorkspaceSurface && !hasAssemblyWorkbench ? ' animate-in' : '';
  shouldAnimateWorkspaceSurface = false;

  return '<div class="workspace-surface' + animateClass + '">' + content + '</div>';
}

function updateProjectDocsetChrome(agent = getCurrentAgentRecord()) {
  if (!projectDocsetToggle || !projectDocsetOverlay || !projectDocsetSheet) return;
  const docset = getCurrentProjectDocset(agent);
  const canShowButton = Boolean(docset?.exists) && ensureUnitMode(agent) === 'chat';
  projectDocsetToggle.classList.toggle('hidden', !canShowButton);
  projectDocsetToggle.classList.toggle('active', canShowButton && currentProjectDocsetOpen);
  projectDocsetToggle.textContent = currentLanguage === 'zh' ? '项目文档' : 'Project Docs';

  if (!canShowButton) {
    currentProjectDocsetOpen = false;
    currentProjectRequirementEdit = null;
  }

  projectDocsetOverlay.classList.toggle('hidden', !(canShowButton && currentProjectDocsetOpen));
  if (!(canShowButton && currentProjectDocsetOpen)) {
    projectDocsetSheet.innerHTML = '';
    return;
  }

  const block = {
    id: 'project-docset',
    title: { zh: '项目文档集', en: 'Project Docset' },
    description: { zh: '当前项目的实时文档状态。', en: 'Live project documentation for the current conversation.' },
  };

  projectDocsetSheet.innerHTML = [
    '<div class="project-docset-sheet-head">',
    '<div>',
    '<div class="project-docset-sheet-title">' + escapeHtml(localizeWorkspaceValue(block.title, 'Project Docset')) + '</div>',
    '<div class="project-docset-sheet-subtitle">' + escapeHtml(String(docset?.projectDir || '')) + '</div>',
    '</div>',
    '<div class="workspace-actions"><button class="workspace-action secondary" type="button" onclick="window.toggleProjectDocsetOverlay(false)">关闭</button></div>',
    '</div>',
    '<div class="project-docset-sheet-body">',
    renderProjectDocsetContent(agent, block, docset),
    '</div>',
  ].join('');
}

function isEditingWorkspaceForm() {
  const active = document.activeElement;
  if (!(active instanceof Element)) {
    return false;
  }
  return Boolean(active.closest('.workspace-form') || active.closest('.project-docset-requirement-form'));
}

function renderCurrentMainView() {
  const agent = getCurrentAgentRecord();
  renderWorkspaceTabs(agent);
  renderInputRequests(currentInputRequests);
  if (shouldRenderWorkspaceSurface(agent)) {
    const newHtml = renderWorkspaceSurface(agent);
    // Also force re-render if the container is not currently showing workspace content
    // (e.g. returning from chat mode where workspace HTML was cached but DOM shows messages).
    const containerIsWorkspace = !!container.querySelector('.workspace-surface');
    if (lastRenderedWorkspaceHtml !== newHtml || !containerIsWorkspace) {
      if (isEditingWorkspaceForm()) {
        updateProjectDocsetChrome(agent);
        updateFollowLatestButton();
        return;
      }
      container.querySelectorAll('details.feature-project-disclosure[open]').forEach((el) => {
        const card = el.closest('.feature-project-card');
        if (card?.dataset?.prebuiltProjectId) {
          expandedProjectIds.add(card.dataset.prebuiltProjectId);
        }
      });
      container.querySelectorAll('.ph-session-tabs[data-tab-group]').forEach((tg) => {
        const activeBtn = tg.querySelector('.ph-session-tab.active');
        if (activeBtn?.dataset?.phTab) {
          savedPhTabState[tg.dataset.tabGroup] = activeBtn.dataset.phTab;
        }
      });
      const savedScroll = container.scrollTop;
      container.innerHTML = newHtml;
      lastRenderedWorkspaceHtml = newHtml;
      if (savedScroll > 0) container.scrollTop = savedScroll;
      expandedProjectIds.forEach((pid) => {
        const card = container.querySelector(`.feature-project-card[data-prebuilt-project-id="${CSS.escape(pid)}"]`);
        if (card) {
          const details = card.querySelector('details.feature-project-disclosure');
          if (details) details.open = true;
        }
      });
      Object.entries(savedPhTabState).forEach(([group, tab]) => {
        const tg = container.querySelector(`.ph-session-tabs[data-tab-group="${CSS.escape(group)}"]`);
        if (tg) {
          tg.querySelectorAll('.ph-session-tab').forEach((t) => t.classList.toggle('active', t.dataset.phTab === tab));
          tg.querySelectorAll('.ph-session-tab-panel').forEach((p) => p.classList.toggle('active', p.dataset.phPanel === tab));
        }
      });
    }
    updateProjectDocsetChrome(agent);
    updateChatContextBar();
    if (typeof updateChatProcessToggle === 'function') {
      updateChatProcessToggle();
    }
    updateFollowLatestButton();
    requestAnimationFrame(updateAssemblySideRailPosition);
    return;
  }

  // Keep lastRenderedWorkspaceHtml intact so returning from chat to workspace
  // can skip re-render if workspace data hasn't changed.
  if (currentMessages.length === 0) {
    container.innerHTML = getEmptyStateHtml();
    updateProjectDocsetChrome(agent);
    updateChatContextBar();
    if (typeof updateChatProcessToggle === 'function') {
      updateChatProcessToggle();
    }
    updateFollowLatestButton();
    return;
  }

  render(currentMessages);
  updateChatContextBar();
  updateProjectDocsetChrome(agent);
  if (typeof updateChatProcessToggle === 'function') {
    updateChatProcessToggle();
  }
  requestAnimationFrame(updateAssemblySideRailPosition);
}

function updateAssemblySideRailPosition() {
  const rail = container.querySelector('.assembly-side-rail');
  const flow = container.querySelector('.assembly-flow');
  if (!rail || !flow) {
    if (assemblySideRailRevealTimer) {
      clearTimeout(assemblySideRailRevealTimer);
      assemblySideRailRevealTimer = null;
    }
    return;
  }
  if (window.innerWidth <= 920) {
    if (assemblySideRailRevealTimer) {
      clearTimeout(assemblySideRailRevealTimer);
      assemblySideRailRevealTimer = null;
    }
    rail.classList.add('positioned');
    rail.classList.add('ready');
    rail.style.removeProperty('--assembly-side-left');
    rail.style.removeProperty('--assembly-side-top');
    return;
  }
  const flowRect = flow.getBoundingClientRect();
  const dockRect = rail.getBoundingClientRect();
  const railWidth = dockRect.width || 316;
  const left = Math.max(flowRect.left + flowRect.width - railWidth - 14, flowRect.left + 14);
  const top = Math.max(flowRect.top + 12, 132);
  rail.style.setProperty('--assembly-side-left', `${Math.round(left)}px`);
  rail.style.setProperty('--assembly-side-top', `${Math.round(top)}px`);
  rail.classList.add('positioned');
  if (rail.classList.contains('ready')) return;
  if (assemblySideRailRevealTimer) {
    clearTimeout(assemblySideRailRevealTimer);
  }
  assemblySideRailRevealTimer = setTimeout(() => {
    if (!document.body.contains(rail)) return;
    rail.classList.add('ready');
    assemblySideRailRevealTimer = null;
  }, 140);
}

function resetRuntimeBackedSurfaceState() {
  currentMessages = [];
  currentInputRequests = [];
  window.lastInputRequests = [];
  renderInputRequests([]);
  setCurrentLogs([]);
  setCurrentHookInspector({ lifecycleOrder: [], features: [], hooks: [] });
  setCurrentOverviewSnapshot(getEmptyOverviewSnapshot());
  setConnectionStatus(false);
  updateNotificationStatus({});
  lastRenderedWorkspaceHtml = '';
  currentWorkspaceArtifactDetail = null;
  currentWorkspaceDocsetDetail = null;
  currentProjectDocsetOpen = false;
  currentProjectRequirementEdit = null;
  currentProjectDocsetPage = 'requirement';
  updateProjectDocsetChrome(getCurrentAgentRecord());
}

function renderWorkspaceTabs(agent = getCurrentAgentRecord()) {
  if (!workspaceTabsBar) return;
  if (isWorkspaceHostUnit(agent)) {
    workspaceTabsBar.classList.add('hidden');
    workspaceTabsBar.innerHTML = '';
    return;
  }
  const tabs = getUnitTabs(agent);
  if (tabs.length <= 1) {
    workspaceTabsBar.classList.add('hidden');
    workspaceTabsBar.innerHTML = '';
    return;
  }

  const activeMode = ensureUnitMode(agent) || 'home';
  const canOpenChat = canEnterWorkspaceChat(agent);
  workspaceTabsBar.classList.remove('hidden');
  workspaceTabsBar.innerHTML = tabs.map((tab) => (
    '<button class="workspace-tab' + (tab.id === activeMode ? ' active' : '') + '" type="button" data-workspace-action="' + escapeHtml(JSON.stringify(
      tab.action || (tab.id === 'chat'
        ? { type: 'show_chat' }
        : (tab.id === 'home'
          ? { type: 'show_home' }
          : { type: 'show_workspace_tab', tab: tab.id }))
    )) + '" onclick="window.runWorkspaceAction(this.dataset.workspaceAction, this)"' + (tab.id === 'chat' && !canOpenChat ? ' disabled' : '') + '>' +
    escapeHtml(getUnitTabLabel(tab)) +
    '</button>'
  )).join('');
}

function getToggleButtonLabel(collapsed) {
  return collapsed
    ? '<svg viewBox="0 0 24 24"><path d="M16.59 8.59L12 13.17 7.41 8.59 6 10l6 6 6-6z"/></svg> ' + escapeHtml(t('expand'))
    : '<svg viewBox="0 0 24 24"><path d="M12 8l-6 6 1.41 1.41L12 10.83l4.59 4.58L18 14z"/></svg> ' + escapeHtml(t('collapse'));
}

function isNearBottom() {
  const threshold = 48;
  return container.scrollHeight - container.scrollTop - container.clientHeight <= threshold;
}

function updateFollowLatestButton() {
  if (!followLatestButton) return;
  const hasMessages = currentMessages.length > 0 && isChatSurfaceActive();
  followLatestButton.classList.toggle('hidden', !hasMessages);
  followLatestButton.classList.toggle('active', followLatestEnabled);
  followLatestButton.innerHTML =
    '<span class="follow-latest-dot"></span><span>' +
    escapeHtml(t(followLatestEnabled ? 'follow_latest_on' : 'follow_latest_off')) +
    '</span>';
}

function markManualScrollIntent() {
  lastManualScrollIntentAt = Date.now();
}

function hasRecentManualScrollIntent() {
  return Date.now() - lastManualScrollIntentAt < 1500;
}

function animateScrollTo(targetTop, duration = 150) {
  const settleToken = ++followScrollSettleToken;
  lastManualScrollIntentAt = 0;
  suppressFollowScrollEvent = true;

  const startTop = container.scrollTop;
  const delta = targetTop - startTop;
  if (Math.abs(delta) < 1 || duration <= 0) {
    container.scrollTop = targetTop;
    suppressFollowScrollEvent = false;
    return;
  }

  const startAt = performance.now();
  const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

  const step = (now) => {
    if (settleToken !== followScrollSettleToken) {
      return;
    }

    const progress = Math.min(1, (now - startAt) / duration);
    container.scrollTop = startTop + delta * easeOutCubic(progress);

    if (progress < 1) {
      requestAnimationFrame(step);
      return;
    }

    container.scrollTop = targetTop;
    suppressFollowScrollEvent = false;
  };

  requestAnimationFrame(step);
}

function captureAssemblyFieldFocus() {
  const activeElement = document.activeElement;
  if (!activeElement) return null;
  const fieldName = activeElement.getAttribute && activeElement.getAttribute('data-assembly-field');
  if (!fieldName) return null;
  return {
    fieldName,
    selectionStart: typeof activeElement.selectionStart === 'number' ? activeElement.selectionStart : null,
    selectionEnd: typeof activeElement.selectionEnd === 'number' ? activeElement.selectionEnd : null,
  };
}

function restoreAssemblyFieldFocus(snapshot) {
  if (!snapshot?.fieldName) return;
  const target = document.querySelector('[data-assembly-field="' + CSS.escape(snapshot.fieldName) + '"]');
  if (!target) return;
  target.focus({ preventScroll: true });
  if (snapshot.selectionStart != null && snapshot.selectionEnd != null && typeof target.setSelectionRange === 'function') {
    target.setSelectionRange(snapshot.selectionStart, snapshot.selectionEnd);
  }
}

function scheduleAssemblyWorkbenchRender() {
  if (assemblyLaunchInProgress) return;
  const focusSnapshot = captureAssemblyFieldFocus();
  if (assemblyDraftRenderTimer) {
    clearTimeout(assemblyDraftRenderTimer);
  }
  assemblyDraftRenderTimer = setTimeout(() => {
    assemblyDraftRenderTimer = null;
    shouldAnimateWorkspaceSurface = false;
    renderCurrentMainView();
    restoreAssemblyFieldFocus(focusSnapshot);
  }, 80);
}

async function syncAssemblyEnvironmentDraft(agent, draft, patch = {}, options = {}) {
  if (!agent?.id) return null;
  draft['assembly-form'] = normalizeAssemblyDraft({
    ...(draft['assembly-form'] || {}),
    ...patch,
  });
  saveWorkspaceFormDraft(agent.id, draft);
  if (options.persist) {
    const openDirectory = options.openDirectory !== undefined
      ? options.openDirectory
      : undefined;
    const form = draft['assembly-form'];
    const name = String(form?.assembly_name || '').trim();
    const currentConfigs = getSavedAssemblyConfigs(agent);
    const shouldSyncSavedEnv = name && currentConfigs.some((item) => item.id === name) && (
      Object.prototype.hasOwnProperty.call(patch, 'env_dir')
      || Object.prototype.hasOwnProperty.call(patch, 'env_status')
      || Object.prototype.hasOwnProperty.call(patch, 'env_status_message')
      || Object.prototype.hasOwnProperty.call(patch, 'env_configured_name')
      || Object.prototype.hasOwnProperty.call(patch, 'env_configured_features')
    );
    const persistOptions = openDirectory ? { openDirectory } : {};
    if (shouldSyncSavedEnv) {
      persistOptions.assemblyConfigs = currentConfigs.map((item) => item.id === name ? {
        ...item,
        envDir: String(form.env_dir || '').trim(),
        envConfiguredName: String(form.env_configured_name || '').trim(),
        envConfiguredFeatures: parseWorkspaceListField(form.env_configured_features),
        envStatus: String(form.env_status || '').trim(),
        envStatusMessage: String(form.env_status_message || '').trim(),
        updatedAt: new Date().toISOString(),
      } : item);
    }
    await persistWorkspaceState(agent, draft, persistOptions);
  }
  shouldAnimateWorkspaceSurface = false;
  scheduleAssemblyWorkbenchRender();
  return draft['assembly-form'];
}

async function requestAssemblyEnvironmentCreate(assemblyName, options = {}) {
  const currentAgent = getCurrentAgentRecord();
  const currentDraft = currentAgent?.id ? getWorkspaceFormDraft(currentAgent)?.['assembly-form'] : null;
  const selectedFeatures = Array.isArray(options.selectedFeatures)
    ? options.selectedFeatures
    : parseWorkspaceListField(currentDraft?.selected_features);
  const response = await fetch('/protoclaw/assembly_environment/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agentId: currentAgent?.id || 'agent-creator',
      assemblyName,
      force: options.force === true,
      selectedFeatures,
    }),
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const error = new Error(payload?.error || 'Failed to create environment');
    error.code = payload?.code || '';
    error.directory = payload?.directory || '';
    error.existed = payload?.existed === true;
    throw error;
  }

  return payload || {};
}

function updateAssemblyDraftWithoutRender(formId, fieldName, value) {
  const agent = getCurrentAgentRecord();
  if (!agent?.id) return;
  const draft = getWorkspaceFormDraft(agent);
  draft[formId] = draft[formId] || {};
  draft[formId][fieldName] = value;
  if (agent.id === 'agent-creator' && formId === 'assembly-form') {
    draft[formId] = normalizeAssemblyDraft(draft[formId]);
  }
  saveWorkspaceFormDraft(agent.id, draft);
}

window.updateAssemblyDraftField = (formId, fieldName, value) => {
  updateAssemblyDraftWithoutRender(formId, fieldName, value);
  if (fieldName === 'feature_query') {
    scheduleAssemblyWorkbenchRender();
  }
};

window.commitAssemblyDraftField = (formId, fieldName, value) => {
  updateAssemblyDraftWithoutRender(formId, fieldName, value);
  shouldAnimateWorkspaceSurface = false;
  renderCurrentMainView();
  const agent = getCurrentAgentRecord();
  if (!agent?.id) return;
  const draft = getWorkspaceFormDraft(agent);
  persistWorkspaceState(agent, draft).catch((error) => {
    console.error('Failed to persist assembly draft field:', error);
  });
};

window.toggleAssemblyStage = (formId, stageKey) => {
  const agent = getCurrentAgentRecord();
  if (!agent?.id) return;
  const draft = getWorkspaceFormDraft(agent);
  const currentStage = draft?.[formId]?.assembly_stage == null ? 'goal' : String(draft?.[formId]?.assembly_stage);
  const nextStage = currentStage === stageKey ? '' : stageKey;
  window.updateWorkspaceFormDraft(formId, 'assembly_stage', nextStage);
};

function scrollToLatest(behavior = 'smooth') {
  console.trace('[scroll-debug] scrollToLatest called, behavior:', behavior, 'followLatestEnabled:', followLatestEnabled);
  const targetTop = container.scrollHeight;
  if (behavior === 'auto') {
    followScrollSettleToken += 1;
    lastManualScrollIntentAt = 0;
    suppressFollowScrollEvent = true;
    container.scrollTop = targetTop;
    suppressFollowScrollEvent = false;
    return;
  }

  animateScrollTo(targetTop, 70);
}

function setFollowLatest(enabled, options = {}) {
  const { scroll = false, behavior = 'smooth' } = options;
  followLatestEnabled = enabled;
  if (enabled) {
    lastManualScrollIntentAt = 0;
  }
  updateFollowLatestButton();
  if (enabled && scroll && isChatSurfaceActive()) {
    scrollToLatest(behavior);
  }
}

let _scrollDebounceTimer = null;
let _scrollDebounceBehavior = 'smooth';

function scheduleScrollToLatest(behavior = 'smooth') {
  pendingFollowToBottom = true;
  _scrollDebounceBehavior = behavior;
  if (_scrollDebounceTimer != null) return;
  _scrollDebounceTimer = setTimeout(() => {
    _scrollDebounceTimer = null;
    if (!pendingFollowToBottom || !followLatestEnabled) return;
    pendingFollowToBottom = false;
    const b = _scrollDebounceBehavior;
    _scrollDebounceBehavior = 'smooth';
    scrollToLatest(b);
  }, 100);
}

function shortenSourcePath(value) {
  if (!value) return '';
  const normalized = String(value).replace(/\\/g, '/');
  const srcIndex = normalized.lastIndexOf('/src/');
  if (srcIndex >= 0) return normalized.slice(srcIndex + 1);
  const agentdevIndex = normalized.lastIndexOf('/AgentDev/');
  if (agentdevIndex >= 0) return normalized.slice(agentdevIndex + 10);
  return normalized;
}

const FULL_HOOK_LIFECYCLE_ORDER = [
  'AgentInitiate',
  'AgentDestroy',
  'CallStart',
  'CallFinish',
  'StepStart',
  'StepFinish',
  'ToolUse',
  'ToolFinished',
];

function getHookInspectorSignature(snapshot) {
  return JSON.stringify(snapshot || { lifecycleOrder: [], features: [], hooks: [] });
}

function getEmptyOverviewSnapshot() {
  return {
    updatedAt: 0,
    context: {
      messageCount: 0,
      charCount: 0,
      toolCallCount: 0,
      turnCount: 0,
    },
    usageStats: {
      totalUsage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      },
      calls: [],
      totalRequests: 0,
      totalCacheHitRequests: 0,
      lastRequestUsage: null,
    },
  };
}

function normalizeOverviewSnapshot(snapshot) {
  const empty = getEmptyOverviewSnapshot();
  if (!snapshot || typeof snapshot !== 'object') {
    return empty;
  }

  return {
    updatedAt: typeof snapshot.updatedAt === 'number' ? snapshot.updatedAt : 0,
    context: {
      messageCount: typeof snapshot.context?.messageCount === 'number' ? snapshot.context.messageCount : 0,
      charCount: typeof snapshot.context?.charCount === 'number' ? snapshot.context.charCount : 0,
      toolCallCount: typeof snapshot.context?.toolCallCount === 'number' ? snapshot.context.toolCallCount : 0,
      turnCount: typeof snapshot.context?.turnCount === 'number' ? snapshot.context.turnCount : 0,
    },
    usageStats: {
      totalUsage: {
        inputTokens: typeof snapshot.usageStats?.totalUsage?.inputTokens === 'number' ? snapshot.usageStats.totalUsage.inputTokens : 0,
        outputTokens: typeof snapshot.usageStats?.totalUsage?.outputTokens === 'number' ? snapshot.usageStats.totalUsage.outputTokens : 0,
        totalTokens: typeof snapshot.usageStats?.totalUsage?.totalTokens === 'number' ? snapshot.usageStats.totalUsage.totalTokens : 0,
        cacheCreationTokens: typeof snapshot.usageStats?.totalUsage?.cacheCreationTokens === 'number' ? snapshot.usageStats.totalUsage.cacheCreationTokens : 0,
        cacheReadTokens: typeof snapshot.usageStats?.totalUsage?.cacheReadTokens === 'number' ? snapshot.usageStats.totalUsage.cacheReadTokens : 0,
        reasoningTokens: typeof snapshot.usageStats?.totalUsage?.reasoningTokens === 'number' ? snapshot.usageStats.totalUsage.reasoningTokens : 0,
        audioTokens: typeof snapshot.usageStats?.totalUsage?.audioTokens === 'number' ? snapshot.usageStats.totalUsage.audioTokens : 0,
      },
      calls: Array.isArray(snapshot.usageStats?.calls) ? snapshot.usageStats.calls.map((call) => ({
        ...call,
        cacheHitRequests: typeof call?.cacheHitRequests === 'number' ? call.cacheHitRequests : 0,
      })) : [],
      totalRequests: typeof snapshot.usageStats?.totalRequests === 'number' ? snapshot.usageStats.totalRequests : 0,
      totalCacheHitRequests: typeof snapshot.usageStats?.totalCacheHitRequests === 'number' ? snapshot.usageStats.totalCacheHitRequests : 0,
      lastRequestUsage: snapshot.usageStats?.lastRequestUsage || null,
    },
  };
}

function getOverviewSignature(snapshot) {
  return JSON.stringify(normalizeOverviewSnapshot(snapshot));
}

function normalizeHookInspector(snapshot) {
  const raw = snapshot || { lifecycleOrder: [], features: [], hooks: [] };
  const hookMap = new Map((raw.hooks || []).map(group => [group.lifecycle, group]));
  return {
    lifecycleOrder: FULL_HOOK_LIFECYCLE_ORDER.slice(),
    features: (raw.features || []).map(feature => ({
      ...feature,
      tools: feature.tools || [],
    })),
    hooks: FULL_HOOK_LIFECYCLE_ORDER.map((lifecycle) => {
      const existing = hookMap.get(lifecycle);
      if (existing) return existing;
      return {
        lifecycle,
        kind: lifecycle === 'StepFinish' || lifecycle === 'ToolUse' ? 'decision' : 'notify',
        entries: [],
      };
    }),
  };
}

function setCurrentHookInspector(snapshot) {
  const normalized = normalizeHookInspector(snapshot);
  currentHookInspector = normalized;
  currentHookInspectorSignature = getHookInspectorSignature(normalized);
  if (selectedFeatureName && !normalized.features.some(feature => feature.name === selectedFeatureName)) {
    selectedFeatureName = null;
  }
}

function setCurrentOverviewSnapshot(snapshot) {
  const normalized = normalizeOverviewSnapshot(snapshot);
  currentOverviewSnapshot = normalized;
  currentOverviewSignature = getOverviewSignature(normalized);
}

function setCurrentLogs(logs) {
  currentLogs = Array.isArray(logs) ? logs : [];
  currentLogsSignature = JSON.stringify({
    count: currentLogs.length,
    last: currentLogs.length > 0 ? currentLogs[currentLogs.length - 1].id : null,
  });
}

function formatMetricNumber(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return '0';
  }
  return value.toLocaleString();
}

function formatRate(numerator, denominator) {
  if (!denominator) {
    return '0%';
  }
  return Math.round((numerator / denominator) * 100) + '%';
}

function getLatestCallSummary(overview) {
  const calls = Array.isArray(overview?.usageStats?.calls) ? overview.usageStats.calls : [];
  if (calls.length === 0) return null;
  return calls.slice().sort((a, b) => (a.callIndex || 0) - (b.callIndex || 0))[calls.length - 1];
}

function getUsageBreakdown(summary, fallbackRequests = 0) {
  const totalUsage = summary?.totalUsage || {};
  const totalTokens = totalUsage.totalTokens || 0;
  const inputTokens = totalUsage.inputTokens || 0;
  const outputTokens = totalUsage.outputTokens || 0;
  const requests = typeof summary?.stepCount === 'number'
    ? summary.stepCount
    : fallbackRequests;
  const cacheHitRequests = typeof summary?.cacheHitRequests === 'number'
    ? summary.cacheHitRequests
    : 0;

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    requests,
    cacheHitRequests,
    cacheMissRequests: Math.max(0, requests - cacheHitRequests),
    cacheHitRate: formatRate(cacheHitRequests, requests),
    avgPerRequest: requests > 0 ? Math.round(totalTokens / requests) : 0,
    cacheReadTokens: totalUsage.cacheReadTokens || 0,
    cacheCreationTokens: totalUsage.cacheCreationTokens || 0,
    inputShare: totalTokens > 0 ? Math.round((inputTokens / totalTokens) * 100) : 0,
    outputShare: totalTokens > 0 ? Math.round((outputTokens / totalTokens) * 100) : 0,
  };
}

function renderTokenBar(inputTokens, outputTokens) {
  const total = inputTokens + outputTokens;
  const inputWidth = total > 0 ? (inputTokens / total) * 100 : 50;
  const outputWidth = total > 0 ? (outputTokens / total) * 100 : 50;
  return [
    '<div class="usage-bar">',
    '<div class="usage-bar-fill input" style="width:' + inputWidth + '%"></div>',
    '<div class="usage-bar-fill output" style="width:' + outputWidth + '%"></div>',
    '</div>',
  ].join('');
}

function renderRateRing(percent, label, meta) {
  const safePercent = Math.max(0, Math.min(100, percent));
  return [
    '<div class="rate-ring-card">',
    '<div class="rate-ring" style="--ring-percent:' + safePercent + ';">',
    '<div class="rate-ring-inner">',
    '<div class="rate-ring-value">' + safePercent + '%</div>',
    '<div class="rate-ring-label">' + escapeHtml(label) + '</div>',
    '</div>',
    '</div>',
    '<div class="rate-ring-meta">' + escapeHtml(meta) + '</div>',
    '</div>',
  ].join('');
}

function renderUsageCard(title, summaryLabel, breakdown) {
  return [
    '<div class="usage-card">',
    '<div class="usage-card-header">',
    '<div>',
    '<div class="usage-card-title">' + escapeHtml(title) + '</div>',
    '<div class="usage-card-subtitle">' + escapeHtml(summaryLabel) + '</div>',
    '</div>',
    '<div class="usage-card-total">' + formatMetricNumber(breakdown.totalTokens) + '</div>',
    '</div>',
    renderTokenBar(breakdown.inputTokens, breakdown.outputTokens),
    '<div class="usage-split-legend">',
    '<span><i class="legend-dot input"></i>' + escapeHtml(t('metric_input_tokens')) + ' ' + formatMetricNumber(breakdown.inputTokens) + '</span>',
    '<span><i class="legend-dot output"></i>' + escapeHtml(t('metric_output_tokens')) + ' ' + formatMetricNumber(breakdown.outputTokens) + '</span>',
    '</div>',
    '<div class="usage-stat-grid">',
    '<div class="usage-stat-cell"><div class="usage-stat-cell-label">' + escapeHtml(t('metric_requests')) + '</div><div class="usage-stat-cell-value">' + formatMetricNumber(breakdown.requests) + '</div></div>',
    '<div class="usage-stat-cell"><div class="usage-stat-cell-label">' + escapeHtml(t('metric_avg_per_request')) + '</div><div class="usage-stat-cell-value">' + formatMetricNumber(breakdown.avgPerRequest) + '</div></div>',
    '<div class="usage-stat-cell"><div class="usage-stat-cell-label">' + escapeHtml(t('metric_input_share')) + '</div><div class="usage-stat-cell-value">' + breakdown.inputShare + '%</div></div>',
    '<div class="usage-stat-cell"><div class="usage-stat-cell-label">' + escapeHtml(t('metric_output_share')) + '</div><div class="usage-stat-cell-value">' + breakdown.outputShare + '%</div></div>',
    '</div>',
    '</div>',
  ].join('');
}

function renderCacheCard(title, breakdown) {
  const percent = breakdown.requests > 0
    ? Math.round((breakdown.cacheHitRequests / breakdown.requests) * 100)
    : 0;
  return [
    '<div class="usage-card cache-card">',
    '<div class="usage-card-header">',
    '<div class="usage-card-title">' + escapeHtml(title) + '</div>',
    '<div class="usage-card-subtitle">' + escapeHtml(t('metric_cache_hit_rate')) + '</div>',
    '</div>',
    renderRateRing(percent, t('metric_cache_hit_rate'), breakdown.cacheHitRequests + ' / ' + breakdown.requests),
    '<div class="usage-stat-grid">',
    '<div class="usage-stat-cell"><div class="usage-stat-cell-label">' + escapeHtml(t('metric_cache_hit_requests')) + '</div><div class="usage-stat-cell-value">' + formatMetricNumber(breakdown.cacheHitRequests) + '</div></div>',
    '<div class="usage-stat-cell"><div class="usage-stat-cell-label">' + escapeHtml(t('metric_cache_miss_requests')) + '</div><div class="usage-stat-cell-value">' + formatMetricNumber(breakdown.cacheMissRequests) + '</div></div>',
    '<div class="usage-stat-cell"><div class="usage-stat-cell-label">' + escapeHtml(t('metric_cache_read')) + '</div><div class="usage-stat-cell-value">' + formatMetricNumber(breakdown.cacheReadTokens) + '</div></div>',
    '<div class="usage-stat-cell"><div class="usage-stat-cell-label">' + escapeHtml(t('metric_cache_write')) + '</div><div class="usage-stat-cell-value">' + formatMetricNumber(breakdown.cacheCreationTokens) + '</div></div>',
    '</div>',
    '</div>',
  ].join('');
}

function renderContextChip(label, value, meta) {
  return [
    '<div class="context-chip">',
    '<div class="context-chip-label">' + escapeHtml(label) + '</div>',
    '<div class="context-chip-value">' + escapeHtml(value) + '</div>',
    '<div class="context-chip-meta">' + escapeHtml(meta) + '</div>',
    '</div>',
  ].join('');
}

function setCurrentMcpInfo(info) {
  currentMcpInfo = info || null;
}

function getLevelWeight(level) {
  const weights = { trace: 10, debug: 20, info: 30, warn: 40, error: 50 };
  return weights[level] || 0;
}

function formatLogTimestamp(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
  });
}

function safePrettyJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch (e) {
    return String(value);
  }
}

function getFilteredLogs() {
  const search = logFilters.search.trim().toLowerCase();
  const minLevel = logFilters.level;
  return currentLogs.filter((entry) => {
    if (minLevel !== 'all' && getLevelWeight(entry.level) < getLevelWeight(minLevel)) {
      return false;
    }
    if (logFilters.feature !== 'all' && (entry.context?.feature || 'none') !== logFilters.feature) {
      return false;
    }
    if (logFilters.lifecycle !== 'all' && (entry.context?.lifecycle || 'none') !== logFilters.lifecycle) {
      return false;
    }
    if (search) {
      const haystack = [
        entry.message,
        entry.namespace,
        entry.context?.feature,
        entry.context?.lifecycle,
        entry.context?.hookMethod,
        entry.context?.toolName,
        entry.context?.agentName,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(search)) {
        return false;
      }
    }
    return true;
  });
}

function renderLogsPanel() {
  const filteredLogs = getFilteredLogs().slice().reverse();
  const featureOptions = Array.from(new Set(currentLogs.map((entry) => entry.context?.feature).filter(Boolean))).sort();
  const lifecycleOptions = Array.from(new Set(currentLogs.map((entry) => entry.context?.lifecycle).filter(Boolean))).sort();

  const toolbar = [
    '<section class="log-toolbar">',
    '<div class="log-filter-row">',
    '<div class="log-filter-label">' + escapeHtml(t('logs_scope')) + '</div>',
    '<div class="log-chip-group">',
    '<button type="button" class="log-chip' + (logPanelScope === 'current' ? ' active' : '') + '" onclick="window.setLogPanelScope(&quot;current&quot;)">' + escapeHtml(t('logs_scope_current')) + '</button>',
    '<button type="button" class="log-chip' + (logPanelScope === 'all' ? ' active' : '') + '" onclick="window.setLogPanelScope(&quot;all&quot;)">' + escapeHtml(t('logs_scope_all')) + '</button>',
    '</div>',
    '</div>',
    '<div class="log-filter-row">',
    '<div class="log-filter-label">' + escapeHtml(t('logs_search')) + '</div>',
    '<input class="log-input" type="text" value="' + escapeHtml(logFilters.search) + '" placeholder="' + escapeHtml(t('logs_search_placeholder')) + '" oninput="window.updateLogFilter(&quot;search&quot;, this.value)">',
    '</div>',
    '<div class="log-filter-row">',
    '<div class="log-filter-label">' + escapeHtml(t('logs_level')) + '</div>',
    '<select class="log-select" onchange="window.updateLogFilter(&quot;level&quot;, this.value)">',
    '<option value="all"' + (logFilters.level === 'all' ? ' selected' : '') + '>' + escapeHtml(t('logs_level_all')) + '</option>',
    '<option value="debug"' + (logFilters.level === 'debug' ? ' selected' : '') + '>' + escapeHtml(t('logs_level_debug')) + '</option>',
    '<option value="info"' + (logFilters.level === 'info' ? ' selected' : '') + '>' + escapeHtml(t('logs_level_info')) + '</option>',
    '<option value="warn"' + (logFilters.level === 'warn' ? ' selected' : '') + '>' + escapeHtml(t('logs_level_warn')) + '</option>',
    '<option value="error"' + (logFilters.level === 'error' ? ' selected' : '') + '>' + escapeHtml(t('logs_level_error')) + '</option>',
    '</select>',
    '<select class="log-select" onchange="window.updateLogFilter(&quot;feature&quot;, this.value)">',
    '<option value="all"' + (logFilters.feature === 'all' ? ' selected' : '') + '>' + escapeHtml(t('logs_feature_all')) + '</option>',
    featureOptions.map((feature) => '<option value="' + escapeHtml(feature) + '"' + (logFilters.feature === feature ? ' selected' : '') + '>' + escapeHtml(feature) + '</option>').join(''),
    '</select>',
    '<select class="log-select" onchange="window.updateLogFilter(&quot;lifecycle&quot;, this.value)">',
    '<option value="all"' + (logFilters.lifecycle === 'all' ? ' selected' : '') + '>' + escapeHtml(t('logs_lifecycle_all')) + '</option>',
    lifecycleOptions.map((lifecycle) => '<option value="' + escapeHtml(lifecycle) + '"' + (logFilters.lifecycle === lifecycle ? ' selected' : '') + '>' + escapeHtml(lifecycle) + '</option>').join(''),
    '</select>',
    '</div>',
    '<div class="log-summary"><span>' + String(filteredLogs.length) + ' ' + escapeHtml(t('logs_total')) + '</span><span>' + escapeHtml(logPanelScope === 'current' ? getRuntimeAwareAgentName() : t('logs_scope_all')) + '</span></div>',
    '</section>',
  ].join('');

  if (filteredLogs.length === 0) {
    return '<div class="log-panel">' + toolbar + '<div class="feature-panel-empty"><div>' + escapeHtml(t('logs_empty')) + '</div></div></div>';
  }

  const rows = filteredLogs.map((entry) => {
    const metaPills = [
      entry.context?.agentName ? '<span class="log-pill">' + escapeHtml(entry.context.agentName) + '</span>' : '',
      entry.context?.feature ? '<span class="log-pill">feature:' + escapeHtml(entry.context.feature) + '</span>' : '',
      entry.context?.lifecycle ? '<span class="log-pill">hook:' + escapeHtml(entry.context.lifecycle) + '</span>' : '',
      entry.context?.hookMethod ? '<span class="log-pill">' + escapeHtml(entry.context.hookMethod) + '()</span>' : '',
      entry.context?.toolName ? '<span class="log-pill">tool:' + escapeHtml(entry.context.toolName) + '</span>' : '',
      typeof entry.context?.step === 'number' ? '<span class="log-pill">step ' + String(entry.context.step) + '</span>' : '',
      typeof entry.context?.callIndex === 'number' ? '<span class="log-pill">call ' + String(entry.context.callIndex) + '</span>' : '',
    ].filter(Boolean).join('');

    const detailBlock = entry.data !== undefined
      ? '<details class="log-details"><summary>' + escapeHtml(t('logs_details')) + '</summary><pre>' + escapeHtml(safePrettyJson(entry.data)) + '</pre></details>'
      : '';

    return [
      '<article class="log-card">',
      '<div class="log-card-head">',
      '<div class="log-card-main">',
      '<span class="log-level ' + escapeHtml(entry.level) + '">' + escapeHtml(entry.level) + '</span>',
      '<span class="log-namespace">' + escapeHtml(entry.namespace) + '</span>',
      '</div>',
      '<div class="log-timestamp">' + escapeHtml(formatLogTimestamp(entry.timestamp)) + '</div>',
      '</div>',
      '<div class="log-card-body">',
      '<div class="log-message">' + escapeHtml(entry.message) + '</div>',
      metaPills ? '<div class="log-meta">' + metaPills + '</div>' : '',
      detailBlock,
      '</div>',
      '</article>',
    ].join('');
  }).join('');

  return '<div class="log-panel">' + toolbar + '<section class="log-list">' + rows + '</section></div>';
}

function renderMcpItems(items, typeLabel) {
  if (!Array.isArray(items) || items.length === 0) {
    return '<div class="feature-panel-empty"><div>' + escapeHtml(t('active_none')) + '</div></div>';
  }

  return '<div class="mcp-list">' + items.map((item) => {
    const name = item.name || item.uri || '';
    return [
    '<article class="mcp-item">',
    '<div class="mcp-item-head">',
    '<div class="mcp-item-name">' + escapeHtml(name) + '</div>',
    '<div class="mcp-item-type">' + escapeHtml(typeLabel) + '</div>',
    '</div>',
      '<div class="mcp-item-desc">' + escapeHtml(item.description || '') + '</div>',
      '</article>',
    ].join('');
  }).join('') + '</div>';
}

function renderMcpPanel() {
  if (!currentMcpInfo) {
    return '<div class="feature-panel-empty"><div>' + escapeHtml(t('mcp_loading')) + '</div></div>';
  }

  const info = currentMcpInfo;
  return [
    '<div class="mcp-panel">',
    '<section class="mcp-hero">',
    '<div class="hooks-kicker">' + escapeHtml(t('mcp_section_kicker')) + '</div>',
    '<div class="hooks-hero-title">' + escapeHtml(t('mcp_hero_title')) + '</div>',
    '<div class="hooks-hero-subtitle">' + escapeHtml(t('mcp_subtitle')) + '</div>',
    '<div class="mcp-status-pill">' + escapeHtml(info.enabled ? t('mcp_enabled') : t('mcp_disabled')) + '</div>',
    '</section>',
    '<section class="feature-panel-section">',
    '<div class="feature-panel-section-title">' + escapeHtml(t('panel_inspector')) + '</div>',
    '<div class="mcp-grid">',
    '<div class="mcp-stat"><div class="mcp-stat-label">' + escapeHtml(t('mcp_endpoint')) + '</div><div class="mcp-stat-value">' + escapeHtml(info.endpoint || '') + '</div></div>',
    '<div class="mcp-stat"><div class="mcp-stat-label">' + escapeHtml(t('mcp_transport')) + '</div><div class="mcp-stat-value">' + escapeHtml(info.transport || '') + '</div></div>',
    '<div class="mcp-stat"><div class="mcp-stat-label">' + escapeHtml(t('mcp_tools')) + '</div><div class="mcp-stat-value">' + String((info.tools || []).length) + '</div></div>',
    '<div class="mcp-stat"><div class="mcp-stat-label">' + escapeHtml(t('mcp_resources')) + '</div><div class="mcp-stat-value">' + String((info.resources || []).length) + '</div></div>',
    '</div>',
    '</section>',
    '<section class="feature-panel-section">',
    '<div class="feature-panel-section-title">' + escapeHtml(t('mcp_client_config')) + '</div>',
    '<div class="mcp-item-desc" style="margin-bottom:8px;">' + escapeHtml(t('mcp_claude_desktop')) + '</div>',
    '<pre class="mcp-code">' + escapeHtml(safePrettyJson(info.commands?.claudeDesktop?.json || {})) + '</pre>',
    '<div class="mcp-item-desc" style="margin:12px 0 8px 0;">' + escapeHtml(t('mcp_codex')) + '</div>',
    '<pre class="mcp-code">' + escapeHtml(safePrettyJson(info.commands?.codex?.json || {})) + '</pre>',
    '<div class="mcp-item-desc" style="margin:12px 0 8px 0;">' + escapeHtml(t('mcp_manual')) + '</div>',
    '<pre class="mcp-code">' + escapeHtml(info.commands?.curlInitialize || '') + '</pre>',
    '</section>',
    '<section class="feature-panel-section">',
    '<div class="feature-panel-section-title">' + escapeHtml(t('mcp_tool_list')) + '</div>',
    renderMcpItems(info.tools || [], t('mcp_item_tool')),
    '</section>',
    '<section class="feature-panel-section">',
    '<div class="feature-panel-section-title">' + escapeHtml(t('mcp_resource_list')) + '</div>',
    renderMcpItems(info.resources || [], t('mcp_item_resource')),
    '</section>',
    '<section class="feature-panel-section">',
    '<div class="feature-panel-section-title">' + escapeHtml(t('mcp_prompt_list')) + '</div>',
    renderMcpItems(info.prompts || [], t('mcp_item_prompt')),
    '</section>',
    '</div>',
  ].join('');
}

const lifecycleDocs = {
  AgentInitiate: {
    title: { zh: 'Agent 初始化阶段', en: 'Agent initialization phase' },
    body: {
      zh: [
      '这个时机只会在 agent 第一次真正进入工作状态时触发一次，适合做长生命周期资源的准备工作，比如启动后台服务、建立连接、预热缓存，或者把框架级能力挂进运行环境。',
      '',
      '~~~ts',
      '@AgentInitiate',
      'async boot(ctx) {',
      '  await this.indexWorkspace();',
      '  await this.startObserver();',
      '}',
      '~~~',
      '',
      '如果某个 feature 要在整个会话期间维持状态，这里通常是它最稳妥的切入点。相比 CallStart，它不会被每次用户输入重复触发。',
    ].join('\n'),
      en: [
      'This moment fires only once when the agent truly enters its working state. It is the right place for long-lived setup such as booting background services, opening connections, warming caches, or mounting framework-level helpers.',
      '',
      '~~~ts',
      '@AgentInitiate',
      'async boot(ctx) {',
      '  await this.indexWorkspace();',
      '  await this.startObserver();',
      '}',
      '~~~',
      '',
      'If a feature needs to hold state across the whole session, this is usually the safest insertion point. Unlike CallStart, it is not repeated on every user request.',
    ].join('\n'),
    },
  },
  AgentDestroy: {
    title: { zh: 'Agent 销毁阶段', en: 'Agent destroy phase' },
    body: { zh: [
      '这是 agent 生命周期的收尾点，用来释放外部资源、停止后台线程、断开连接，以及把调试信息或缓存安全落盘。',
      '',
      '~~~ts',
      '@AgentDestroy',
      'async cleanup() {',
      '  await this.workerPool.stop();',
      '  await this.cache.flush();',
      '}',
      '~~~',
      '',
      '如果一个 feature 在 AgentInitiate 做了重量级初始化，就应该在这里成对地清理掉。',
    ].join('\n'),
      en: [
      'This is the closing stage of the agent lifecycle. Use it to release external resources, stop workers, close connections, and flush traces or caches safely to disk.',
      '',
      '~~~ts',
      '@AgentDestroy',
      'async cleanup() {',
      '  await this.workerPool.stop();',
      '  await this.cache.flush();',
      '}',
      '~~~',
      '',
      'If a feature performs heavyweight setup in AgentInitiate, it should usually tear that work down here.',
    ].join('\n') },
  },
  CallStart: {
    title: { zh: 'Call 开始前', en: 'Before call start' },
    body: { zh: [
      '这个时机发生在系统提示词之后、用户输入正式写入上下文之前。它非常适合做输入重写、前置注入和会话级别的轻量整理。',
      '',
      '~~~ts',
      '@CallStart',
      'async rewriteInput(ctx) {',
      '  const raw = ctx.agent?.getUserInput() ?? ctx.input;',
      '  ctx.agent?.setUserInput(raw.trim());',
      '}',
      '~~~',
      '',
      '如果你想观察 feature 如何“提前影响”一次调用，这里通常是最有解释力的节点。',
    ].join('\n'),
      en: [
      'This timing happens after the system prompt is ready but before the user input is committed into context. It is ideal for input rewriting, pre-injection, and lightweight call-level normalization.',
      '',
      '~~~ts',
      '@CallStart',
      'async rewriteInput(ctx) {',
      '  const raw = ctx.agent?.getUserInput() ?? ctx.input;',
      '  ctx.agent?.setUserInput(raw.trim());',
      '}',
      '~~~',
      '',
      'If you want to explain how a feature affects a call before the model sees it, this is usually the clearest node.',
    ].join('\n') },
  },
  CallFinish: {
    title: { zh: 'Call 结束后', en: 'After call finish' },
    body: { zh: [
      '这是一次完整调用结束后的结算点。适合做摘要、记录、指标更新、落日志，而不适合决定下一轮 ReAct 要不要继续。',
      '',
      '~~~ts',
      '@CallFinish',
      'async afterCall(ctx) {',
      '  this.metrics.track(ctx.completed, ctx.steps);',
      '}',
      '~~~',
      '',
      '它更像“回合总结”，而不是流程控制点。',
    ].join('\n'),
      en: [
      'This is the settlement point after a full call completes. It fits summarization, logging, and metrics updates, but it is not the place to decide whether the next ReAct turn should continue.',
      '',
      '~~~ts',
      '@CallFinish',
      'async afterCall(ctx) {',
      '  this.metrics.track(ctx.completed, ctx.steps);',
      '}',
      '~~~',
      '',
      'It behaves more like an end-of-call summary than a flow-control decision point.',
    ].join('\n') },
  },
  StepStart: {
    title: { zh: 'Step 开始前', en: 'Before step start' },
    body: { zh: [
      '每轮 ReAct 循环刚开始时都会进入这里。适合做上下文补丁、提醒注入、局部状态同步。这类钩子往往会高频出现。',
      '',
      '~~~ts',
      '@StepStart',
      'async injectReminder(ctx) {',
      '  if (this.shouldRemind()) {',
      '    ctx.context.add({ role: "system", content: this.reminder });',
      '  }',
      '}',
      '~~~',
      '',
      '因为它会在每一轮执行，所以调试器里把它单独看出来很重要，否则很难解释某些系统消息为什么总会出现。',
    ].join('\n'),
      en: [
      'Every ReAct iteration enters here right at the beginning. It is useful for context patching, reminder injection, and local state synchronization. These hooks often run at high frequency.',
      '',
      '~~~ts',
      '@StepStart',
      'async injectReminder(ctx) {',
      '  if (this.shouldRemind()) {',
      '    ctx.context.add({ role: "system", content: this.reminder });',
      '  }',
      '}',
      '~~~',
      '',
      'Because it runs every round, surfacing it clearly in the debugger is important; otherwise it is hard to explain why some system messages keep appearing.',
    ].join('\n') },
  },
  StepFinish: {
    title: { zh: 'Step 结束决策点', en: 'Step finish decision point' },
    body: { zh: [
      '这是 ReAct 循环里最关键的控制点之一。模型和工具都跑完后，feature 可以在这里决定“继续下一轮”还是“就地结束”。',
      '',
      '~~~ts',
      '@StepFinish',
      'async decide(ctx) {',
      '  if (this.hasPendingDelegates()) {',
      '    return Decision.Approve;',
      '  }',
      '  return Decision.Continue;',
      '}',
      '~~~',
      '',
      '如果某个 feature 能把 agent 的循环强行维持住，通常就是在这里介入。它解释的是“为什么这轮已经看起来结束了，但系统还在继续跑”。',
    ].join('\n'),
      en: [
      'This is one of the most important control points in the ReAct loop. After the model and tools finish, a feature can decide whether the loop should continue or end right away.',
      '',
      '~~~ts',
      '@StepFinish',
      'async decide(ctx) {',
      '  if (this.hasPendingDelegates()) {',
      '    return Decision.Approve;',
      '  }',
      '  return Decision.Continue;',
      '}',
      '~~~',
      '',
      'If a feature can keep the agent alive beyond what looks like a natural stopping point, it is usually intervening here.',
    ].join('\n') },
  },
  ToolUse: {
    title: { zh: '工具执行前决策点', en: 'Before tool execution decision point' },
    body: { zh: [
      '这是另一个高价值观察位点。工具真正执行前，feature 可以在这里批准、拒绝或者放行。所有安全策略、危险操作拦截都很适合在这里实现。',
      '',
      '~~~ts',
      '@ToolUse',
      'async guard(ctx) {',
      '  if (ctx.call.name === "run_shell_command") {',
      '    return Decision.Deny;',
      '  }',
      '  return Decision.Continue;',
      '}',
      '~~~',
      '',
      '调试器里只要看清楚这里挂了谁，很多“为什么工具没执行”或者“为什么执行路径被改写”就能直接定位。',
    ].join('\n'),
      en: [
      'This is another high-value inspection point. Before a tool actually runs, a feature can approve, deny, or pass it through. Security policy and dangerous-operation guards fit naturally here.',
      '',
      '~~~ts',
      '@ToolUse',
      'async guard(ctx) {',
      '  if (ctx.call.name === "run_shell_command") {',
      '    return Decision.Deny;',
      '  }',
      '  return Decision.Continue;',
      '}',
      '~~~',
      '',
      'As soon as you can see who is attached here, many "why did the tool not run?" questions become much easier to answer.',
    ].join('\n') },
  },
  ToolFinished: {
    title: { zh: '工具执行后通知点', en: 'After tool finished notify point' },
    body: { zh: [
      '工具已经返回结果以后，这里会收到纯通知。适合做后处理、索引、同步外部状态、记录审计信息，但不会改变刚刚那次工具调用本身的结果。',
      '',
      '~~~ts',
      '@ToolFinished',
      'async record(ctx) {',
      '  this.auditTrail.push({',
      '    tool: ctx.toolName,',
      '    duration: ctx.duration,',
      '  });',
      '}',
      '~~~',
      '',
      '这类钩子更偏“旁路观察”和“后续整理”，所以通常适合完整展开给开发者查链路。',
    ].join('\n'),
      en: [
      'Once a tool returns its result, this point receives a pure notification. It suits post-processing, indexing, external state sync, and audit recording, but it does not change the result of the tool call that already happened.',
      '',
      '~~~ts',
      '@ToolFinished',
      'async record(ctx) {',
      '  this.auditTrail.push({',
      '    tool: ctx.toolName,',
      '    duration: ctx.duration,',
      '  });',
      '}',
      '~~~',
      '',
      'These hooks are more about side-channel observation and cleanup, so they are usually worth showing in full detail to developers.',
    ].join('\n') },
  },
};

function selectOverviewLifecycle(lifecycle) {
  selectedOverviewLifecycle = lifecycle;
  if (activeFeaturePanel === 'workspace') {
    renderFeaturePanel();
  }
}

window.selectOverviewLifecycle = selectOverviewLifecycle;

function openFeatureDetails(featureName) {
  selectedFeatureName = featureName;
  if (activeFeaturePanel === 'hooks') {
    renderFeaturePanel();
  }
}

function closeFeatureDetails() {
  selectedFeatureName = null;
  if (activeFeaturePanel === 'hooks') {
    renderFeaturePanel();
  }
}

window.openFeatureDetails = openFeatureDetails;
window.closeFeatureDetails = closeFeatureDetails;

function openRepositoryPackageDetails(packageId) {
  selectedRepositoryPackageId = packageId;
  renderCurrentMainView();
}

function closeRepositoryPackageDetails() {
  selectedRepositoryPackageId = null;
  renderCurrentMainView();
}

window.openRepositoryPackageDetails = openRepositoryPackageDetails;
window.closeRepositoryPackageDetails = closeRepositoryPackageDetails;

let summaryPopupData = null;

function getOrCreateSummaryOverlay() {
  let overlay = document.getElementById('summary-popup-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'summary-popup-overlay';
    const mainContent = document.querySelector('.main-content');
    if (mainContent) {
      mainContent.appendChild(overlay);
    } else {
      document.body.appendChild(overlay);
    }
  }
  return overlay;
}

function renderSummaryBodyContent(data) {
  const { loading, generating, data: summaryData, error } = data;
  if (loading) {
    const msg = generating ? t('workspace_summary_generating') : t('workspace_summary_loading');
    return '<div class="summary-loading-state">' +
      '<div class="summary-spinner"></div>' +
      '<span>' + escapeHtml(msg) + '</span>' +
      '</div>';
  }
  if (error) {
    return '<div class="summary-error-state">' + escapeHtml(error) + '</div>';
  }
  if (!summaryData) return '';
  let bodyContent = '';

  // Session title & meta header
  const title = summaryData.sessionTitle || '';
  const createdAt = summaryData.createdAt ? new Date(summaryData.createdAt) : null;
  const timeStr = createdAt ? createdAt.toLocaleString(currentLanguage === 'zh' ? 'zh-CN' : 'en-US') : '';
  if (title || timeStr) {
    bodyContent += '<div class="summary-header">';
    if (title) bodyContent += '<div class="summary-title">' + escapeHtml(title) + '</div>';
    if (timeStr) bodyContent += '<div class="summary-time">' + escapeHtml(timeStr) + '</div>';
    bodyContent += '</div>';
  }

  // Summary body — rendered as markdown
  const summaryText = summaryData.summaryText || t('workspace_no_summary_content');
  bodyContent += '<div class="summary-body markdown-body">' + renderMarkdown(summaryText) + '</div>';

  // Important files — no icons, clean mono list
  if (summaryData.importantFiles && summaryData.importantFiles.length > 0) {
    bodyContent += '<div class="summary-section">';
    bodyContent += '<div class="summary-section-title">' + escapeHtml(t('workspace_important_files')) + '</div>';
    bodyContent += '<div class="summary-file-list">' + summaryData.importantFiles.map(f =>
      '<div class="summary-file-item">' + escapeHtml(f) + '</div>'
    ).join('') + '</div>';
    bodyContent += '</div>';
  }

  // Important skills
  if (summaryData.importantSkills && summaryData.importantSkills.length > 0) {
    bodyContent += '<div class="summary-section">';
    bodyContent += '<div class="summary-section-title">' + escapeHtml(t('workspace_important_skills')) + '</div>';
    bodyContent += '<div class="summary-tag-list">' + summaryData.importantSkills.map(s => '<span class="summary-tag">' + escapeHtml(s) + '</span>').join('') + '</div>';
    bodyContent += '</div>';
  }

  return bodyContent;
}

function updateSummaryOverlayDOM(data) {
  const overlay = getOrCreateSummaryOverlay();
  overlay.className = 'feature-detail-overlay';
  overlay.onclick = function(e) { if (e.target === overlay) closeSummaryPopup(); };
  const hasData = data && data.data && !data.loading && !data.error;
  overlay.innerHTML =
    '<div class="feature-detail-window summary-popup-window">' +
    '<div class="feature-detail-head">' +
    '<div><div class="feature-detail-title">' + escapeHtml(t('workspace_summary_title')) + '</div></div>' +
    '<button class="feature-detail-close" type="button" onclick="window.closeSummaryPopup()">×</button>' +
    '</div>' +
    '<div class="summary-popup-body">' +
    renderSummaryBodyContent(data) +
    '</div>' +
    (hasData ? '<div class="summary-popup-footer"><button class="summary-regenerate-btn" type="button" onclick="window.regenerateSummary()">' + escapeHtml(t('workspace_regenerate_summary')) + '</button></div>' : '') +
    '</div>';
  // Post-render: enhance math in summary markdown
  if (hasData) {
    requestAnimationFrame(() => {
      const md = overlay.querySelector('.summary-body.markdown-body');
      if (md) enhanceMathInElement(md);
    });
  }
}

function openSummaryPopup(agentId, sessionId) {
  summaryPopupData = { agentId, sessionId, loading: true, generating: false, data: null, error: null };
  updateSummaryOverlayDOM(summaryPopupData);
  fetch('/protoclaw/session_summary?agentId=' + encodeURIComponent(agentId) + '&sessionId=' + encodeURIComponent(sessionId))
    .then(r => {
      if (r.status === 404) {
        if (summaryPopupData && summaryPopupData.agentId === agentId && summaryPopupData.sessionId === sessionId) {
          summaryPopupData.generating = true;
          updateSummaryOverlayDOM(summaryPopupData);
        }
        return fetch('/protoclaw/session_generate_summary', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agentId, sessionId }),
        }).then(r2 => {
          if (!r2.ok) throw new Error('Generation failed');
          return r2.json();
        }).then(() => {
          return fetch('/protoclaw/session_summary?agentId=' + encodeURIComponent(agentId) + '&sessionId=' + encodeURIComponent(sessionId));
        }).then(r3 => {
          if (!r3.ok) throw new Error('Summary not found after generation');
          return r3.json();
        });
      }
      if (!r.ok) throw new Error(r.status);
      return r.json();
    })
    .then(data => {
      if (summaryPopupData && summaryPopupData.agentId === agentId && summaryPopupData.sessionId === sessionId) {
        summaryPopupData.loading = false;
        summaryPopupData.generating = false;
        summaryPopupData.data = data;
        updateSummaryOverlayDOM(summaryPopupData);
      }
      loadAgents().catch(() => {});
    })
    .catch(err => {
      if (summaryPopupData && summaryPopupData.agentId === agentId && summaryPopupData.sessionId === sessionId) {
        summaryPopupData.loading = false;
        summaryPopupData.generating = false;
        summaryPopupData.error = err.message;
        updateSummaryOverlayDOM(summaryPopupData);
      }
    });
}

function closeSummaryPopup() {
  summaryPopupData = null;
  const overlay = document.getElementById('summary-popup-overlay');
  if (overlay) overlay.remove();
}

window.openSummaryPopup = openSummaryPopup;
window.closeSummaryPopup = closeSummaryPopup;

function regenerateSummary() {
  if (!summaryPopupData) return;
  const { agentId, sessionId } = summaryPopupData;
  summaryPopupData = { agentId, sessionId, loading: true, generating: true, data: null, error: null };
  updateSummaryOverlayDOM(summaryPopupData);
  fetch('/protoclaw/session_generate_summary', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId, sessionId, force: true }),
  })
    .then(r => { if (!r.ok) throw new Error('Generation failed'); return r.json(); })
    .then(() => fetch('/protoclaw/session_summary?agentId=' + encodeURIComponent(agentId) + '&sessionId=' + encodeURIComponent(sessionId)))
    .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(data => {
      if (summaryPopupData && summaryPopupData.agentId === agentId && summaryPopupData.sessionId === sessionId) {
        summaryPopupData.loading = false;
        summaryPopupData.generating = false;
        summaryPopupData.data = data;
        updateSummaryOverlayDOM(summaryPopupData);
      }
      loadAgents().catch(() => {});
    })
    .catch(err => {
      if (summaryPopupData && summaryPopupData.agentId === agentId && summaryPopupData.sessionId === sessionId) {
        summaryPopupData.loading = false;
        summaryPopupData.generating = false;
        summaryPopupData.error = err.message;
        updateSummaryOverlayDOM(summaryPopupData);
      }
    });
}

window.regenerateSummary = regenerateSummary;

function setRepoSearchQuery(value) {
  repoSearchQuery = String(value || '').trim().toLowerCase();
  shouldAnimateWorkspaceSurface = false;
  renderCurrentMainView();
}

function setRepoSourceFilter(value) {
  repoSourceFilter = String(value || 'all');
  shouldAnimateWorkspaceSurface = false;
  renderCurrentMainView();
}

window.setRepoSearchQuery = setRepoSearchQuery;
window.setRepoSourceFilter = setRepoSourceFilter;

let featureUploadFile = null;

function openFeatureUploadDialog() {
  const dialog = document.getElementById('feature-upload-dialog');
  const input = document.getElementById('feature-upload-input');
  const status = document.getElementById('feature-upload-status');
  const submitBtn = document.getElementById('feature-upload-submit');
  const dropzone = document.getElementById('feature-upload-dropzone');
  
  dialog.style.display = 'flex';
  input.value = '';
  status.style.display = 'none';
  status.className = 'feature-upload-status';
  submitBtn.disabled = true;
  featureUploadFile = null;

  // 点击上传区域选择文件
  dropzone.onclick = () => input.click();
  
  // 文件选择变化
  input.onchange = (e) => {
    const file = e.target.files?.[0];
    handleFeatureUploadFile(file);
  };

  // 拖拽上传
  dropzone.ondragover = (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  };

  dropzone.ondragleave = () => {
    dropzone.classList.remove('dragover');
  };

  dropzone.ondrop = (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    const file = e.dataTransfer?.files?.[0];
    handleFeatureUploadFile(file);
  };
}

function closeFeatureUploadDialog() {
  const dialog = document.getElementById('feature-upload-dialog');
  dialog.style.display = 'none';
  featureUploadFile = null;
}

function handleFeatureUploadFile(file) {
  const status = document.getElementById('feature-upload-status');
  const submitBtn = document.getElementById('feature-upload-submit');
  
  if (!file) {
    status.style.display = 'none';
    submitBtn.disabled = true;
    featureUploadFile = null;
    return;
  }

  if (!file.name.toLowerCase().endsWith('.tgz')) {
    status.textContent = getRepoLocaleText('请选择 .tgz 格式的文件', 'Please select a .tgz file');
    status.className = 'feature-upload-status error';
    status.style.display = 'block';
    submitBtn.disabled = true;
    featureUploadFile = null;
    return;
  }

  featureUploadFile = file;
  status.textContent = getRepoLocaleText(`已选择: ${file.name}`, `Selected: ${file.name}`);
  status.className = 'feature-upload-status success';
  status.style.display = 'block';
  submitBtn.disabled = false;
}

async function submitFeatureUpload() {
  if (!featureUploadFile) return;

  const status = document.getElementById('feature-upload-status');
  const submitBtn = document.getElementById('feature-upload-submit');
  
  submitBtn.disabled = true;
  status.textContent = getRepoLocaleText('上传中...', 'Uploading...');
  status.className = 'feature-upload-status';
  status.style.display = 'block';

  try {
    const formData = new FormData();
    formData.append('file', featureUploadFile);

    const response = await fetch('/protoclaw/feature_repository/upload', {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      throw new Error(await response.text().catch(() => 'upload failed'));
    }

    status.textContent = getRepoLocaleText('上传成功!', 'Upload successful!');
    status.className = 'feature-upload-status success';
    
    setTimeout(() => {
      closeFeatureUploadDialog();
      renderCurrentMainView();
    }, 1000);
  } catch (e) {
    status.textContent = getRepoLocaleText('上传失败: ', 'Upload failed: ') + (e && e.message ? e.message : e);
    status.className = 'feature-upload-status error';
    submitBtn.disabled = false;
  }
}

window.openFeatureUploadDialog = openFeatureUploadDialog;
window.closeFeatureUploadDialog = closeFeatureUploadDialog;
window.submitFeatureUpload = submitFeatureUpload;

window.openSettings = openSettings;
window.closeSettings = closeSettings;
window.addSettingsPreset = addSettingsPreset;
window.editSettingsPreset = editSettingsPreset;
window.deleteSettingsPreset = deleteSettingsPreset;
window.saveSettingsPreset = saveSettingsPreset;
window.applySettingsPreset = applySettingsPreset;
window.cancelSettingsEdit = cancelSettingsEdit;

function renderStructurePanel() {
  const activeAgent = getRuntimeAwareAgentRecord();
  const connected = activeAgent ? (activeAgent.connected !== false ? t('status_connected') : t('status_disconnected')) : t('status_no_agent');
  const totalHooks = currentHookInspector.hooks.reduce((sum, group) => sum + group.entries.length, 0);
  const decisionHooks = currentHookInspector.hooks.reduce(
    (sum, group) => sum + group.entries.filter(entry => entry.kind === 'decision').length,
    0
  );
  const featureStatusCounts = currentHookInspector.features.reduce((acc, feature) => {
    const status = getFeatureStatus(feature);
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, { enabled: 0, partial: 0, disabled: 0, removed: 0 });
  const selectedDoc = lifecycleDocs[selectedOverviewLifecycle] || lifecycleDocs.StepFinish;
  const flowChips = currentHookInspector.lifecycleOrder
    .map(name => '<button class="hooks-chip' + (name === selectedOverviewLifecycle ? ' active' : '') + '" type="button" onclick="window.selectOverviewLifecycle(&quot;' + escapeHtml(name) + '&quot;)"><strong>' + escapeHtml(name) + '</strong></button>')
    .join('');
  return [
    '<div class="hooks-panel">',
    '<section class="hooks-hero">',
    '<div class="hooks-kicker">' + escapeHtml(t('structure_kicker')) + '</div>',
    '<div class="hooks-hero-title">' + escapeHtml(t('structure_hero_title')) + '</div>',
    '<div class="hooks-hero-subtitle">' + escapeHtml(t('structure_subtitle')) + '</div>',
    '<div class="hooks-stats">',
    '<div class="hooks-stat"><div class="hooks-stat-label">' + escapeHtml(t('stat_active_agent')) + '</div><div class="hooks-stat-value">' + escapeHtml(getRuntimeAwareAgentName()) + '</div></div>',
    '<div class="hooks-stat"><div class="hooks-stat-label">Hooks</div><div class="hooks-stat-value">' + String(totalHooks) + '</div></div>',
    '<div class="hooks-stat"><div class="hooks-stat-label">Decision</div><div class="hooks-stat-value">' + String(decisionHooks) + '</div></div>',
    '<div class="hooks-stat"><div class="hooks-stat-label">' + escapeHtml(t('panel_features_label')) + '</div><div class="hooks-stat-value">' + String(currentHookInspector.features.length) + '</div></div>',
    '</div>',
    '</section>',
    '<section class="hooks-section">',
    '<div class="hooks-section-header"><div class="hooks-section-title">' + escapeHtml(t('panel_inspector')) + '</div><div class="hooks-section-meta">' + escapeHtml(connected) + '</div></div>',
    '<div class="feature-grid">',
    '<div class="feature-card"><div class="feature-card-name">' + escapeHtml(t('panel_connection')) + '</div><div class="feature-card-detail"><span>' + escapeHtml(connected) + '</span><span>' + String(currentMessages.length) + ' ' + escapeHtml(t('feature_messages')) + '</span></div></div>',
    '<div class="feature-card"><div class="feature-card-name">' + escapeHtml(t('panel_features_label')) + '</div><div class="feature-card-detail"><span>' + String(currentHookInspector.features.length) + ' ' + escapeHtml(t('panel_total')) + '</span><span>' + String(featureStatusCounts.enabled) + ' ' + escapeHtml(t('panel_enabled')) + '</span><span>' + String(featureStatusCounts.partial) + ' ' + escapeHtml(t('panel_partial')) + '</span><span>' + String(featureStatusCounts.disabled) + ' ' + escapeHtml(t('panel_disabled')) + '</span><span>' + String(featureStatusCounts.removed) + ' ' + escapeHtml(t('panel_removed')) + '</span></div></div>',
    '</div>',
    '</section>',
    '<section class="hooks-section">',
    '<div class="hooks-section-header"><div class="hooks-section-title">' + escapeHtml(t('panel_loop_flow')) + '</div><div class="hooks-section-meta">' + escapeHtml(t('panel_select_lifecycle')) + '</div></div>',
    '<div class="hooks-strip">' + flowChips + '</div>',
    '</section>',
    '<section class="hooks-section">',
    '<div class="hooks-section-header"><div class="hooks-section-title">' + escapeHtml(selectedOverviewLifecycle) + '</div><div class="hooks-section-meta">' + escapeHtml(selectedDoc.title[currentLanguage] || selectedDoc.title.zh) + '</div></div>',
    '<div class="feature-panel-section overview-doc"><div class="markdown-body">' + renderMarkdown(selectedDoc.body[currentLanguage] || selectedDoc.body.zh) + '</div></div>',
    '</section>',
    '</div>',
  ].join('');
}

function renderMonitorPanel() {
  const activeAgent = getRuntimeAwareAgentRecord();
  const connected = activeAgent ? (activeAgent.connected !== false ? t('status_connected') : t('status_disconnected')) : t('status_no_agent');
  const overview = currentOverviewSnapshot || getEmptyOverviewSnapshot();
  const totalUsage = overview.usageStats?.totalUsage || {};
  const latestCall = getLatestCallSummary(overview);
  const currentBreakdown = getUsageBreakdown(latestCall, 0);
  const totalBreakdown = getUsageBreakdown({
    totalUsage,
    stepCount: overview.usageStats.totalRequests || 0,
    cacheHitRequests: overview.usageStats.totalCacheHitRequests || 0,
  }, overview.usageStats.totalRequests || 0);
  const contextLengthLabel = formatMetricNumber(overview.context.charCount) + ' chars';
  const latestTurnLabel = latestCall ? formatMetricNumber(currentBreakdown.totalTokens) : t('metric_no_calls');
  return [
    '<div class="hooks-panel">',
    '<section class="hooks-hero">',
    '<div class="hooks-kicker">' + escapeHtml(t('overview_kicker')) + '</div>',
    '<div class="hooks-hero-title">' + escapeHtml(t('overview_hero_title')) + '</div>',
    '<div class="hooks-hero-subtitle">' + escapeHtml(t('overview_subtitle')) + '</div>',
    '<div class="hooks-stats">',
    '<div class="hooks-stat"><div class="hooks-stat-label">' + escapeHtml(t('stat_active_agent')) + '</div><div class="hooks-stat-value">' + escapeHtml(getRuntimeAwareAgentName()) + '</div></div>',
    '<div class="hooks-stat"><div class="hooks-stat-label">' + escapeHtml(t('stat_context_length')) + '</div><div class="hooks-stat-value">' + escapeHtml(contextLengthLabel) + '</div></div>',
    '<div class="hooks-stat"><div class="hooks-stat-label">' + escapeHtml(t('stat_turn_tokens')) + '</div><div class="hooks-stat-value">' + escapeHtml(latestTurnLabel) + '</div></div>',
    '<div class="hooks-stat"><div class="hooks-stat-label">' + escapeHtml(t('stat_cache_hit_rate')) + '</div><div class="hooks-stat-value">' + escapeHtml(totalBreakdown.cacheHitRate) + '</div></div>',
    '</div>',
    '</section>',
    '<section class="hooks-section">',
    '<div class="hooks-section-header"><div class="hooks-section-title">' + escapeHtml(t('panel_runtime')) + '</div><div class="hooks-section-meta">' + escapeHtml(connected) + '</div></div>',
    '<div class="overview-usage-grid">',
    renderUsageCard(t('panel_current_turn'), latestCall ? t('metric_latest_turn') : t('metric_no_calls'), currentBreakdown),
    renderCacheCard(t('panel_current_turn'), currentBreakdown),
    renderUsageCard(t('panel_session_total'), t('metric_session_total'), totalBreakdown),
    renderCacheCard(t('panel_session_total'), totalBreakdown),
    '</div>',
    '</section>',
    '<section class="hooks-section">',
    '<div class="hooks-section-header"><div class="hooks-section-title">' + escapeHtml(t('panel_context')) + '</div><div class="hooks-section-meta">' + escapeHtml(t('panel_connection')) + ': ' + escapeHtml(connected) + '</div></div>',
    '<div class="context-chip-grid">',
    renderContextChip(t('metric_messages'), formatMetricNumber(overview.context.messageCount), t('panel_context')),
    renderContextChip(t('metric_chars'), formatMetricNumber(overview.context.charCount), t('stat_context_length')),
    renderContextChip(t('metric_turns'), formatMetricNumber(overview.context.turnCount), t('metric_session_total')),
    renderContextChip(t('metric_tool_calls'), formatMetricNumber(overview.context.toolCallCount), t('metric_latest_turn')),
    '</div>',
    '</section>',
    '</div>',
  ].join('');
}

function renderFeaturesPanel() {
  if (currentHookInspector.features.length === 0) {
    return '<div class="feature-panel-empty"><div class="feature-panel-section"><div class="feature-panel-section-title">' + escapeHtml(t('panel_no_features')) + '</div><div>' + escapeHtml(t('panel_no_feature_data')) + '</div></div></div>';
  }

  const selectedFeature = currentHookInspector.features.find(feature => feature.name === selectedFeatureName) || null;
  const featureCards = currentHookInspector.features
    .map(feature => {
      const status = getFeatureStatus(feature);
      return [
      '<div class="feature-card" role="button" tabindex="0" onclick="window.openFeatureDetails(&quot;' + escapeHtml(feature.name) + '&quot;)" title="' + escapeHtml(t('feature_open_details')) + '">',
      '<div class="feature-card-top">',
      '<div class="feature-card-main">',
      '<span class="feature-card-dot"></span>',
      '<div style="min-width:0;">',
      '<div class="feature-card-name">' + escapeHtml(feature.name) + '</div>',
      '<div class="feature-card-file">' + escapeHtml(shortenSourcePath(feature.source) || t('feature_source_missing')) + '</div>',
      '</div>',
      '</div>',
      '<div class="' + getStatusBadgeClass(status) + '">' + escapeHtml(getFeatureStatusLabel(status)) + '</div>',
      '</div>',
      '<div class="feature-card-detail">',
      '<span>' + String(feature.hookCount) + ' ' + escapeHtml(t('feature_hooks')) + '</span>',
      '<span>' + String(feature.enabledToolCount) + '/' + String(feature.toolCount) + ' ' + escapeHtml(t('feature_tools')) + '</span>',
      feature.description ? '<span>' + escapeHtml(feature.description) + '</span>' : '',
      '</div>',
      '</div>',
    ].join('');
    })
    .join('');

  const detailOverlay = selectedFeature ? [
    '<div class="feature-detail-overlay" onclick="if (event.target === this) window.closeFeatureDetails()">',
    '<div class="feature-detail-window">',
    '<div class="feature-detail-head">',
    '<div>',
    '<div class="feature-detail-title">' + escapeHtml(selectedFeature.name) + '</div>',
    '<div class="feature-detail-subtitle">' + escapeHtml(selectedFeature.description || '') + '</div>',
    '</div>',
    '<button class="feature-detail-close" type="button" title="' + escapeHtml(t('panel_close')) + '" onclick="window.closeFeatureDetails()">×</button>',
    '</div>',
    '<div class="feature-detail-stats">',
    '<div class="feature-detail-stat"><div class="feature-detail-stat-label">' + escapeHtml(t('feature_hooks')) + '</div><div class="feature-detail-stat-value">' + String(selectedFeature.hookCount) + '</div></div>',
    '<div class="feature-detail-stat"><div class="feature-detail-stat-label">' + escapeHtml(t('feature_active_tools')) + '</div><div class="feature-detail-stat-value">' + String(selectedFeature.enabledToolCount) + '/' + String(selectedFeature.toolCount) + '</div></div>',
    '<div class="feature-detail-stat"><div class="feature-detail-stat-label">' + escapeHtml(t('feature_status_label')) + '</div><div class="feature-detail-stat-value">' + escapeHtml(getFeatureStatusLabel(getFeatureStatus(selectedFeature))) + '</div></div>',
    '</div>',
    '<div class="feature-panel-section">',
    '<div class="feature-panel-section-title">' + escapeHtml(t('panel_feature_details')) + '</div>',
    '<div class="feature-detail-subtitle">' + escapeHtml(shortenSourcePath(selectedFeature.source) || t('feature_source_missing')) + '</div>',
    '</div>',
    '<div class="feature-panel-section">',
    '<div class="feature-panel-section-title">' + escapeHtml(t('panel_loaded_tools')) + '</div>',
    selectedFeature.tools && selectedFeature.tools.length > 0
      ? '<div class="feature-tool-list">' + selectedFeature.tools.map(tool => [
          '<div class="feature-tool-card">',
          '<div class="feature-tool-top">',
          '<div class="feature-tool-name">' + escapeHtml(tool.name) + '</div>',
          '<div class="' + getStatusBadgeClass(tool.state || (tool.enabled ? 'enabled' : 'disabled')) + '">' + escapeHtml(tool.state === 'removed' ? t('feature_tool_removed') : tool.state === 'disabled' || tool.enabled === false ? t('feature_tool_disabled') : t('feature_tool_enabled')) + '</div>',
          '</div>',
          '<div class="feature-tool-desc">' + escapeHtml(tool.description || '') + '</div>',
          '<div class="feature-tool-meta">',
          tool.renderCall ? '<span class="feature-tool-pill">' + escapeHtml(t('feature_tool_render')) + ': call/' + escapeHtml(tool.renderCall) + '</span>' : '',
          tool.renderResult ? '<span class="feature-tool-pill">' + escapeHtml(t('feature_tool_render')) + ': result/' + escapeHtml(tool.renderResult) + '</span>' : '',
          '</div>',
          '</div>',
        ].join('')).join('') + '</div>'
      : '<div class="feature-detail-subtitle">' + escapeHtml(t('panel_no_tools')) + '</div>',
    '</div>',
    '</div>',
    '</div>',
  ].join('') : '';

  return [
    '<div class="hooks-panel feature-detail-shell">',
    '<section class="hooks-section">',
    '<div class="hooks-section-header"><div class="hooks-section-title">' + escapeHtml(t('panel_all_features')) + '</div><div class="hooks-section-meta">' + String(currentHookInspector.features.length) + ' ' + escapeHtml(t('panel_registered')) + '</div></div>',
    '<div class="feature-grid">' + featureCards + '</div>',
    '</section>',
    detailOverlay,
    '</div>',
  ].join('');
}

function renderReverseHooksPanel() {
  const hookIcons = {
    AgentInitiate: 'A',
    AgentDestroy: 'D',
    CallStart: 'C',
    CallFinish: 'C',
    StepStart: 'S',
    StepFinish: 'R',
    ToolUse: 'T',
    ToolFinished: 'F',
  };

  const lifecycleCards = currentHookInspector.hooks
    .map(group => {
      const entriesHtml = group.entries.map((entry, index) => [
        '<div class="hook-step">',
        '<div class="hook-step-order">' + String(index + 1) + '</div>',
        '<div class="hook-step-card">',
        '<div class="hook-step-row">',
        '<div class="hook-step-feature">' + escapeHtml(entry.featureName) + '</div>',
        '<div class="hook-step-kind">' + escapeHtml(entry.kind) + '</div>',
        '</div>',
        '<div class="hook-step-method">' + escapeHtml(entry.methodName) + '()</div>',
        entry.source && entry.source.display ? '<div class="hook-step-location">' + escapeHtml(shortenSourcePath(entry.source.display)) + '</div>' : '',
        entry.description ? '<div class="hook-step-notes">' + escapeHtml(entry.description) + '</div>' : '',
        '</div>',
        '</div>',
      ].join('')).join('');

      return [
        '<section class="hook-lifecycle-card">',
        '<div class="hook-lifecycle-head">',
      '<div class="hook-lifecycle-name">',
      '<span class="hook-lifecycle-icon">' + escapeHtml(hookIcons[group.lifecycle] || 'H') + '</span>',
      '<div>',
      '<div>' + escapeHtml(group.lifecycle) + '</div>',
      '<div class="hook-lifecycle-type">' + escapeHtml(group.kind) + ' ' + escapeHtml(t('hook_kind')) + '</div>',
      '</div>',
      '</div>',
        '<div style="display:flex;align-items:center;gap:12px;">',
        '<div class="hooks-section-meta">' + String(group.entries.length) + ' ' + escapeHtml(t('panel_attached')) + '</div>',
        '</div>',
        '</div>',
        '<div class="hook-call-chain">',
        entriesHtml || '<div class="hooks-section-meta">' + escapeHtml(t('panel_no_handlers')) + '</div>',
        '</div>',
        '</section>',
      ].join('');
    })
    .join('');

  if (currentHookInspector.hooks.length === 0) {
    return '<div class="feature-panel-empty"><div class="feature-panel-section"><div class="feature-panel-section-title">' + escapeHtml(t('panel_no_hook_data')) + '</div><div>' + escapeHtml(t('panel_no_hook_data_desc')) + '</div></div></div>';
  }

  return [
    '<div class="hooks-panel">',
    '<section class="hooks-section">',
    '<div class="hooks-section-header"><div class="hooks-section-title">' + escapeHtml(t('panel_reverse_hooks')) + '</div><div class="hooks-section-meta">' + escapeHtml(t('panel_all_lifecycle_slots')) + '</div></div>',
    '<div class="hook-lifecycle-list">' + lifecycleCards + '</div>',
    '</section>',
    '</div>',
  ].join('');
}

const featurePanels = {
  workspace: {
    title: () => t('panel_structure'),
    render: () => renderStructurePanel(),
  },
  monitor: {
    title: () => t('panel_monitor'),
    render: () => renderMonitorPanel(),
  },
  hooks: {
    title: () => t('panel_features'),
    render: () => renderFeaturesPanel(),
  },
  inspector: {
    title: () => t('panel_reverse_hooks'),
    render: () => renderReverseHooksPanel(),
  },
  logs: {
    title: () => t('panel_logs'),
    render: () => renderLogsPanel(),
  },
  mcp: {
    title: () => t('panel_mcp'),
    render: () => renderMcpPanel(),
  },
};

// Sidebar Toggle
sidebarToggle.addEventListener('click', () => {
  sidebar.classList.toggle('collapsed');
});

const renderer = new marked.Renderer();
renderer.codespan = function(code) {
  const text = typeof code === 'string'
    ? code
    : (code && typeof code === 'object' && 'text' in code
      ? code.text
      : String(code ?? ''));
  return '<code class="inline-code-accent">' + escapeHtml(text) + '</code>';
};

marked.setOptions({
  renderer,
  highlight: function(code, lang) {
    if (lang && hljs.getLanguage(lang)) {
      return hljs.highlight(code, { language: lang }).value;
    }
    return hljs.highlightAuto(code).value;
  },
  breaks: true
});

function escapeHtml(text) {
  const str = String(text);
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return str.replace(/[&<>"']/g, m => map[m]);
}

function extractDisplayMathBlocks(text) {
  const source = String(text ?? '');
  const segments = source.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g);
  const blocks = [];
  let index = 0;

  const transformSegment = (segment) => {
    let output = '';
    let cursor = 0;

    while (cursor < segment.length) {
      const start = segment.indexOf('$$', cursor);
      if (start === -1) {
        output += segment.slice(cursor);
        break;
      }

      if (start > 0 && segment[start - 1] === '\\') {
        output += segment.slice(cursor, start + 2);
        cursor = start + 2;
        continue;
      }

      const end = segment.indexOf('$$', start + 2);
      if (end === -1) {
        output += segment.slice(cursor);
        break;
      }

      const latex = segment.slice(start + 2, end).trim();
      const token = `claw-display-math-${index++}`;
      blocks.push({ token, latex });
      output += segment.slice(cursor, start);
      output += `\n\n<claw-display-math data-token="${token}"></claw-display-math>\n\n`;
      cursor = end + 2;
    }

    return output;
  };

  const markdown = segments.map((segment) => {
    if (!segment) return '';
    if (segment.startsWith('```') || segment.startsWith('~~~')) {
      return segment;
    }
    return transformSegment(segment);
  }).join('');

  return { markdown, blocks };
}

function renderDisplayMathLatex(latex) {
  if (window.katex?.renderToString) {
    try {
      return katex.renderToString(latex, {
        displayMode: true,
        throwOnError: false,
        strict: 'ignore',
        output: 'htmlAndMathml',
      });
    } catch (error) {
      console.warn('Display math render failed:', error);
    }
  }
  return `<span class="math-render-fallback">${escapeHtml(latex)}</span>`;
}

function renderMarkdown(text) {
  const { markdown, blocks } = extractDisplayMathBlocks(text);
  let html = marked.parse(markdown);
  blocks.forEach(({ token, latex }) => {
    const rendered = `<div class="katex-display-block">${renderDisplayMathLatex(latex)}</div>`;
    const tagPattern = new RegExp(`<claw-display-math\\s+data-token="${token}"><\\/claw-display-math>`, 'g');
    const wrappedTagPattern = new RegExp(`<p><claw-display-math\\s+data-token="${token}"><\\/claw-display-math><\\/p>`, 'g');
    html = html.replace(wrappedTagPattern, rendered);
    html = html.replace(tagPattern, rendered);
  });
  return html;
}

function enhanceMathInElement(root) {
  if (!root || typeof renderMathInElement !== 'function') {
    return;
  }

  const markdownRoots = root.matches?.('.markdown-body')
    ? [root]
    : Array.from(root.querySelectorAll?.('.markdown-body') || []);

  markdownRoots.forEach((element) => {
    if (!element || element.dataset.mathEnhanced === 'true') {
      return;
    }
    try {
      renderMathInElement(element, {
        delimiters: [
          { left: '$$', right: '$$', display: true },
          { left: '\\[', right: '\\]', display: true },
          { left: '$', right: '$', display: false },
          { left: '\\(', right: '\\)', display: false },
        ],
        throwOnError: false,
        strict: 'ignore',
        output: 'htmlAndMathml',
        ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code'],
        ignoredClasses: ['katex'],
      });
      element.dataset.mathEnhanced = 'true';
    } catch (error) {
      console.warn('Math render failed:', error);
    }
  });
}

window.addEventListener('load', () => {
  enhanceMathInElement(document.body);
});

// 默认 fallback 模板（当动态加载失败时使用）
const RENDER_TEMPLATES = {
  'math': {
    call: (args) => {
      const expression = args?.expression ?? args?.input ?? JSON.stringify(args ?? {});
      return `<div class="bash-command">${escapeHtml(String(expression))}</div>`;
    },
    result: (data, success) => {
      if (!success) return formatError(data);
      const value = typeof data === 'object' && data !== null && 'result' in data ? data.result : data;
      if (typeof value === 'string') return `<pre class="bash-output">${escapeHtml(value)}</pre>`;
      return renderJsonHighlight(value);
    }
  },
  'user-input': {
    call: (args) => renderJsonHighlight(args),
    result: (data, success) => {
      if (!success) return formatError(data);
      if (typeof data === 'string') return `<pre class="bash-output">${escapeHtml(data)}</pre>`;
      return renderJsonHighlight(data);
    }
  },
  'json': {
    call: (args) => renderJsonHighlight(args),
    result: (data, success) => {
      if (!success) return formatError(data);
      return renderJsonHighlight(data);
    }
  }
};

// 模板缓存
const templateCache = new Map();

function renderJsonHighlight(data) {
  const displayData = typeof data === 'object' ? JSON.stringify(data, null, 2) : String(data);
  const lines = displayData.split('\n');
  return '<div class="code-read-container">' + lines.map((line, i) => {
    let highlighted;
    try { highlighted = hljs.highlight(line, { language: 'json' }).value; }
    catch (e) { highlighted = escapeHtml(line); }
    return '<div class="code-read-line"><span class="code-read-line-num">' + (i + 1) + '</span><span class="code-read-content">' + highlighted + '</span></div>';
  }).join('') + '</div>';
}

function getTemplateFallback(templateName) {
  return RENDER_TEMPLATES[templateName] || RENDER_TEMPLATES['json'] || null;
}

function setConnectionStatus(connected) {
  statusBadge.textContent = connected ? t('status_connected') : t('status_disconnected');
  statusBadge.classList.toggle('disconnected', !connected);
}

function showAgentStartError(error) {
  const message = error && error.message ? error.message : String(error || '');
  statusBadge.textContent = t('status_start_failed');
  statusBadge.classList.add('disconnected');
  window.alert(`${t('status_start_failed')}: ${message}`);
}

function renderThemeToggle() {
  const isLight = currentTheme === 'light';
  themeToggle.title = isLight ? t('theme_toggle_dark') : t('theme_toggle_light');
  themeToggle.innerHTML = isLight
    ? '<svg id="theme-toggle-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v2.2M12 19.8V22M4.93 4.93l1.56 1.56M17.51 17.51l1.56 1.56M2 12h2.2M19.8 12H22M4.93 19.07l1.56-1.56M17.51 6.49l1.56-1.56"></path></svg>'
    : '<svg id="theme-toggle-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"></path></svg>';
}

function applyLanguage() {
  localStorage.setItem('agentdev-language', currentLanguage);
  document.title = t('page_title');

  const sidebarToggleEl = document.getElementById('sidebar-toggle');
  const panelResizerEl = document.getElementById('feature-panel-resizer');
  const notificationCharLabel = document.querySelector('.notification-char-count')?.nextElementSibling;
  const workspaceButton = document.getElementById('rail-workspace');
  const monitorButton = document.getElementById('rail-monitor');
  const hooksButton = document.getElementById('rail-hooks');
  const inspectorButton = document.getElementById('rail-inspector');
  const logsButton = document.getElementById('rail-logs');
  const mcpButton = document.getElementById('rail-mcp');

  if (sidebarToggleEl) sidebarToggleEl.title = t('sidebar_toggle');
  if (panelResizerEl) panelResizerEl.title = t('resize_panel');
  if (notificationCharLabel) notificationCharLabel.textContent = t('chars');
  if (workspaceButton) workspaceButton.title = t('structure_tooltip');
  if (monitorButton) monitorButton.title = t('monitor_tooltip');
  if (hooksButton) hooksButton.title = t('features_tooltip');
  if (inspectorButton) inspectorButton.title = t('reverse_hooks_tooltip');
  if (logsButton) logsButton.title = t('logs_tooltip');
  if (mcpButton) mcpButton.title = t('mcp_tooltip');

  languageToggle.title = t('language_toggle');
  languageToggle.textContent = t('language_toggle_short');
  restartAgentAction.textContent = t('restart_agent_runtime');
  stopAgentAction.textContent = t('close_agent_runtime');
  deleteAgentAction.textContent = t('delete_agent');
  openSessionAction.textContent = currentLanguage === 'zh' ? '进入对话' : 'Enter Chat';
  compactedResumeSessionAction.textContent = t('workspace_light_resume');
  deleteSessionAction.textContent = t('delete_session');
  deleteProjectAction.textContent = t('delete_project');

  renderThemeToggle();
  renderAgentList();
  renderFeaturePanel();

  if (typeof updateCurrentAgentChrome === 'function') {
    updateCurrentAgentChrome();
  } else if (!currentAgentId) {
    currentAgentTitle.textContent = t('page_title');
    statusBadge.textContent = t('status_no_agent');
  }

  renderCurrentMainView();
}

function applyTheme(theme) {
  currentTheme = theme === 'light' ? 'light' : 'dark';
  document.body.dataset.theme = currentTheme;
  localStorage.setItem('agentdev-theme', currentTheme);
  renderThemeToggle();
}

function renderFeaturePanel() {
  const activeElement = document.activeElement;
  const preserveLogSearchFocus = activeFeaturePanel === 'logs' && activeElement && activeElement.classList && activeElement.classList.contains('log-input');
  const preservedSelectionStart = preserveLogSearchFocus && typeof activeElement.selectionStart === 'number'
    ? activeElement.selectionStart
    : null;
  const preservedSelectionEnd = preserveLogSearchFocus && typeof activeElement.selectionEnd === 'number'
    ? activeElement.selectionEnd
    : null;

  if (!activeFeaturePanel || !featurePanels[activeFeaturePanel]) {
    featurePanel.classList.remove('open');
    featurePanelTitle.textContent = t('panel_structure');
    featurePanelBody.innerHTML = getFeaturePanelEmptyHtml();
    railButtons.forEach(button => button.classList.remove('active'));
    return;
  }

  const panel = featurePanels[activeFeaturePanel];
  featurePanel.classList.add('open');
  featurePanel.style.setProperty('--feature-panel-width', featurePanelWidth + 'px');
  featurePanelTitle.textContent = typeof panel.title === 'function' ? panel.title() : panel.title;
  featurePanelBody.innerHTML = panel.render();
  enhanceMathInElement(featurePanelBody);
  railButtons.forEach(button => {
    button.classList.toggle('active', button.dataset.panel === activeFeaturePanel);
  });

  if (preserveLogSearchFocus) {
    const nextSearchInput = featurePanelBody.querySelector('.log-input');
    if (nextSearchInput) {
      nextSearchInput.focus();
      if (preservedSelectionStart !== null && preservedSelectionEnd !== null && typeof nextSearchInput.setSelectionRange === 'function') {
        nextSearchInput.setSelectionRange(preservedSelectionStart, preservedSelectionEnd);
      }
    }
  }
}

function toggleFeaturePanel(panelId) {
  activeFeaturePanel = activeFeaturePanel === panelId ? null : panelId;
  renderFeaturePanel();
}

window.setLogPanelScope = async (scope) => {
  logPanelScope = scope === 'all' ? 'all' : 'current';
  await loadLogs(true);
  renderFeaturePanel();
};

window.updateLogFilter = (key, value) => {
  logFilters[key] = value;
  renderFeaturePanel();
};

function closeAgentContextMenu() {
  agentContextMenu.classList.remove('open');
  contextMenuAgentId = null;
  contextMenuAgentMode = null;
}

function closeSessionContextMenu() {
  sessionContextMenu.classList.remove('open');
  contextMenuSessionAgentId = null;
  contextMenuSessionId = null;
  contextMenuSessionMode = null;
}

function closeProjectContextMenu() {
  projectContextMenu.classList.remove('open');
  contextMenuProjectAgentId = null;
  contextMenuProjectId = null;
}

function closeFeatureRepoContextMenu() {
  featureRepoContextMenu.classList.remove('open');
  contextMenuFeatureRepoPackageId = null;
}

function closeCompactMenu() {
  compactContextMenu.classList.remove('open');
  contextMenuCompactAction = null;
}

function openCompactMenu(action, x, y) {
  closeAgentContextMenu();
  closeSessionContextMenu();
  closeProjectContextMenu();
  contextMenuCompactAction = action;

  const margin = 8;
  compactContextMenu.classList.add('open');
  compactContextMenu.style.left = '0px';
  compactContextMenu.style.top = '0px';

  const rect = compactContextMenu.getBoundingClientRect();
  const maxLeft = window.innerWidth - rect.width - margin;
  const maxTop = window.innerHeight - rect.height - margin;
  compactContextMenu.style.left = Math.max(margin, Math.min(x, maxLeft)) + 'px';
  compactContextMenu.style.top = Math.max(margin, Math.min(y, maxTop)) + 'px';
}

function openFeatureRepoContextMenu(packageId, x, y) {
  closeAgentContextMenu();
  closeSessionContextMenu();
  closeProjectContextMenu();
  contextMenuFeatureRepoPackageId = packageId;

  const margin = 8;
  featureRepoContextMenu.classList.add('open');
  featureRepoContextMenu.style.left = '0px';
  featureRepoContextMenu.style.top = '0px';

  const rect = featureRepoContextMenu.getBoundingClientRect();
  const maxLeft = window.innerWidth - rect.width - margin;
  const maxTop = window.innerHeight - rect.height - margin;
  featureRepoContextMenu.style.left = Math.max(margin, Math.min(x, maxLeft)) + 'px';
  featureRepoContextMenu.style.top = Math.max(margin, Math.min(y, maxTop)) + 'px';
}

function openProjectContextMenu(agentId, projectId, x, y) {
  closeAgentContextMenu();
  closeSessionContextMenu();
  contextMenuProjectAgentId = agentId;
  contextMenuProjectId = projectId;

  const margin = 8;
  projectContextMenu.classList.add('open');
  projectContextMenu.style.left = '0px';
  projectContextMenu.style.top = '0px';

  const rect = projectContextMenu.getBoundingClientRect();
  const maxLeft = window.innerWidth - rect.width - margin;
  const maxTop = window.innerHeight - rect.height - margin;
  projectContextMenu.style.left = Math.max(margin, Math.min(x, maxLeft)) + 'px';
  projectContextMenu.style.top = Math.max(margin, Math.min(y, maxTop)) + 'px';
}

function openAgentContextMenu(agentId, x, y, mode) {
  closeSessionContextMenu();
  closeProjectContextMenu();
  contextMenuAgentId = agentId;
  contextMenuAgentMode = mode || null;
  const showRuntimeActions = mode === 'prebuilt-runtime' || mode === 'external-runtime' || mode === 'child-runtime';

  restartAgentAction.style.display = showRuntimeActions ? '' : 'none';
  restartAgentAction.disabled = !showRuntimeActions;
  stopAgentAction.style.display = showRuntimeActions ? '' : 'none';
  stopAgentAction.disabled = !showRuntimeActions;
  deleteAgentAction.style.display = mode === 'delete-only' ? '' : 'none';
  deleteAgentAction.disabled = mode !== 'delete-only';

  const margin = 8;
  agentContextMenu.classList.add('open');
  agentContextMenu.style.left = '0px';
  agentContextMenu.style.top = '0px';

  const rect = agentContextMenu.getBoundingClientRect();
  const maxLeft = window.innerWidth - rect.width - margin;
  const maxTop = window.innerHeight - rect.height - margin;
  agentContextMenu.style.left = Math.max(margin, Math.min(x, maxLeft)) + 'px';
  agentContextMenu.style.top = Math.max(margin, Math.min(y, maxTop)) + 'px';
}

function openSessionContextMenu(agentId, sessionId, x, y) {
  closeAgentContextMenu();
  closeProjectContextMenu();
  contextMenuSessionAgentId = agentId;
  contextMenuSessionId = sessionId;
  const agent = allAgents.find((item) => item.id === agentId) || null;
  const session = getWorkspaceSessionById(agent, sessionId);
  const isAssembly = isAssemblySession(session);
  contextMenuSessionMode = isAssembly ? 'assembly' : 'default';
  if (compactedResumeSessionAction) {
    compactedResumeSessionAction.style.display = isAssembly ? 'none' : '';
    compactedResumeSessionAction.disabled = isAssembly;
  }

  const margin = 8;
  sessionContextMenu.classList.add('open');
  sessionContextMenu.style.left = '0px';
  sessionContextMenu.style.top = '0px';

  const rect = sessionContextMenu.getBoundingClientRect();
  const maxLeft = window.innerWidth - rect.width - margin;
  const maxTop = window.innerHeight - rect.height - margin;
  sessionContextMenu.style.left = Math.max(margin, Math.min(x, maxLeft)) + 'px';
  sessionContextMenu.style.top = Math.max(margin, Math.min(y, maxTop)) + 'px';
}

railButtons.forEach(button => {
  button.addEventListener('click', () => {
    toggleFeaturePanel(button.dataset.panel);
    if (button.dataset.panel === 'logs' && activeFeaturePanel === 'logs') {
      loadLogs(true).catch((error) => console.error('Failed to load logs:', error));
    } else if (button.dataset.panel === 'mcp' && activeFeaturePanel === 'mcp') {
      loadMcpInfo(true).catch((error) => console.error('Failed to load MCP info:', error));
    }
  });
});

themeToggle.addEventListener('click', () => {
  applyTheme(currentTheme === 'light' ? 'dark' : 'light');
});

languageToggle.addEventListener('click', () => {
  currentLanguage = currentLanguage === 'zh' ? 'en' : 'zh';
  applyLanguage();
});

settingsToggle.addEventListener('click', () => {
  if (window.ClawFW.settingsOpen) {
    closeSettings();
  } else {
    openSettings();
  }
});

featurePanelResizer.addEventListener('mousedown', (event) => {
  if (!featurePanel.classList.contains('open')) return;

  event.preventDefault();

  const handleMouseMove = (moveEvent) => {
    const nextWidth = window.innerWidth - moveEvent.clientX - 56;
    featurePanelWidth = Math.max(400, Math.min(750, nextWidth));
    featurePanel.style.setProperty('--feature-panel-width', featurePanelWidth + 'px');
  };

  const handleMouseUp = () => {
    window.removeEventListener('mousemove', handleMouseMove);
    window.removeEventListener('mouseup', handleMouseUp);
  };

  window.addEventListener('mousemove', handleMouseMove);
  window.addEventListener('mouseup', handleMouseUp);
});


function formatError(data) {
   const text = typeof data === 'object' ? JSON.stringify(data, null, 2) : String(data);
   return `<div class="tool-error">
     <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>
     <span>${escapeHtml(text)}</span>
   </div>`;
}

function interpolateTemplate(template, data) {
  return template.replace(/{{(w+)}}/g, (_, key) => {
    const value = data[key];
    return value !== undefined ? String(value) : `{{${key}}}`;
  });
}

function applyTemplate(template, data, success = true, args = {}) {
  if (typeof template === 'function') {
    return template(data, success, args);
  }
  // 处理内联模板对象 { call: ..., result: ... }
  if (typeof template === 'object' && template !== null) {
    const fn = template.result || template.call;
    if (typeof fn === 'function') {
      return fn(data, success, args);
    }
    if (typeof fn === 'string') {
      return interpolateTemplate(fn, data);
    }
  }
  return interpolateTemplate(template, data);
}

function parseToolResult(content) {
  try {
    const json = JSON.parse(content);
    if (json && typeof json === 'object' && 'success' in json && 'result' in json) {
      let data = json.result;
      // Try to unwrap double-encoded JSON strings
      if (typeof data === 'string') {
         try {
            if (data.trim().startsWith('"') || data.trim().startsWith('{') || data.trim().startsWith('[')) {
               const parsed = JSON.parse(data);
               data = parsed;
            }
         } catch (e) {
            // Not a JSON string, keep as is
         }
      }
      return { success: json.success, data: data };
    }
    return { success: true, data: content };
  } catch (e) {
    return { success: true, data: content };
  }
}

/**
 * 根据模板名解析文件路径
 * 优先级：Feature 模板 > 系统模板 > 兜底
 */
const self = this;

// 系统默认模板映射（兜底）
// 格式：featureName/templateName
// 注意：这些映射仅在 FEATURE_TEMPLATE_MAP 中没有找到时使用
// 新增 feature 时应确保 feature 正确实现了 getPackageInfo() 和 getTemplateNames()
const SYSTEM_TEMPLATE_MAP = {
  // SubAgent Feature
  'agent-spawn': 'subagent/agent-spawn',
  'agent-list': 'subagent/agent-list',
  'agent-send': 'subagent/agent-send',
  'agent-close': 'subagent/agent-close',
  'wait': 'subagent/wait',
  // Skill Feature
  'skill': 'skill/skill',
  'invoke_skill': 'skill/skill',
  // OpencodeBasic Feature
  'read': 'opencode-basic/read',
  'write': 'opencode-basic/write',
  'edit': 'opencode-basic/edit',
  'ls': 'opencode-basic/ls',
  'glob': 'opencode-basic/glob',
  'grep': 'opencode-basic/grep',
  // Todo Feature
  'task-create': 'todo/task-create',
  'task-list': 'todo/task-list',
  'task-get': 'todo/task-get',
  'task-update': 'todo/task-update',
  'task-clear': 'todo/task-clear',
  // MCP Feature
  'mcp-tool': 'mcp/mcp-tool',
  'mcp-result': 'mcp/mcp-tool',
  // UserInput Feature
  'user-input': 'user-input/user-input',
};

function resolveTemplatePath(templateName) {
  // 1. 优先查找 Feature 模板（从后端注入的动态数据）
  if (FEATURE_TEMPLATE_MAP[templateName]) {
    return FEATURE_TEMPLATE_MAP[templateName];
  }

  // 2. 使用系统默认映射（统一 URL 格式）
  if (SYSTEM_TEMPLATE_MAP[templateName]) {
    const mapped = SYSTEM_TEMPLATE_MAP[templateName];
    // 系统内置模板使用 /template/agentdev/{feature}/{template}.render.js
    return '/template/agentdev/' + mapped + '.render.js';
  }

  // 3. 兜底：返回 null，让调用者等待或使用默认模板
  // 不再盲目生成错误的URL，而是等待 FEATURE_TEMPLATE_MAP 加载完成
  console.warn('[Viewer] Template "' + templateName + '" not found in FEATURE_TEMPLATE_MAP or SYSTEM_TEMPLATE_MAP, waiting...');
  return null;
}

/**
 * 异步加载模板
 * 支持从 Feature 目录或系统目录加载
 * 如果加载失败，回退到内置模板
 */
async function loadTemplate(templateName, retryCount = 0) {
  if (templateCache.has(templateName)) {
    return templateCache.get(templateName);
  }

  // 优先检查内置模板（json 是内置的）
  if (RENDER_TEMPLATES[templateName]) {
    templateCache.set(templateName, RENDER_TEMPLATES[templateName]);
    return RENDER_TEMPLATES[templateName];
  }

  try {
    const path = resolveTemplatePath(templateName);

    // 如果 path 为 null，说明 FEATURE_TEMPLATE_MAP 还未加载完成
    if (!path) {
      // 最多重试 3 次，每次等待 500ms
      if (retryCount < 3) {
        console.log('[Viewer] Waiting for FEATURE_TEMPLATE_MAP to load... (attempt ' + (retryCount + 1) + ')');
        await new Promise(resolve => setTimeout(resolve, 500));
        // 重新加载模板映射
        await loadFeatureTemplateMap();
        return loadTemplate(templateName, retryCount + 1);
      }
      console.warn('[Viewer] Template "' + templateName + '" not found after retries');
      const fallback = getTemplateFallback(templateName);
      if (fallback) {
        templateCache.set(templateName, fallback);
      }
      return fallback;
    }

    // 统一使用 URL 方式加载模板
    // Feature 模板: /template/agentdev/shell/bash.render.js
    const module = await import(path);

    // 1. 优先使用 default export（Feature 模板）
    let template = module.default;
    if (template) {
      templateCache.set(templateName, template);
      return template;
    }

    // 2. 尝试从 TEMPLATES 对象获取（系统模板）
    if (module.TEMPLATES && module.TEMPLATES[templateName]) {
      template = module.TEMPLATES[templateName];
      templateCache.set(templateName, template);
      return template;
    }

    console.warn('[Viewer Worker] 模板 "' + templateName + '" 在文件中未找到');
    return null;
  } catch (e) {
    console.warn('[Viewer Worker] 加载模板失败: ' + templateName, e);
    const fallback = getTemplateFallback(templateName);
    if (fallback) {
      templateCache.set(templateName, fallback);
    }
    return fallback;
  }
}

function collectTemplateNames(tools) {
  const templatesToLoad = new Set();

  for (const tool of tools) {
    const renderConfig = tool.render;
    if (!renderConfig) continue;

    if (typeof renderConfig === 'string') {
      templatesToLoad.add(renderConfig);
      continue;
    }

    if (typeof renderConfig === 'object') {
      if (renderConfig.call && renderConfig.call !== '__inline__') {
        templatesToLoad.add(renderConfig.call);
      }
      if (renderConfig.result && renderConfig.result !== '__inline__') {
        templatesToLoad.add(renderConfig.result);
      }
    }
  }

  return Array.from(templatesToLoad);
}

function warmTemplatesInBackground(templateNames, agentId) {
  if (!Array.isArray(templateNames) || templateNames.length === 0) {
    return;
  }

  const warmupToken = ++templateWarmupToken;
  Promise.all(templateNames.map(name => loadTemplate(name)))
    .then(() => {
      if (warmupToken !== templateWarmupToken || currentRuntimeAgentId !== agentId) {
        return;
      }
      renderCurrentMainView();
    })
    .catch((error) => {
      console.warn('[Viewer] Background template warmup failed:', error);
    });
}

function getToolRenderTemplate(toolName) {
  const config = toolRenderConfigs[toolName];
  const callTemplateName = (config?.render?.call) || 'json';
  const resultTemplateName = (config?.render?.result) || 'json';

  const callIsInline = callTemplateName === '__inline__';
  const resultIsInline = resultTemplateName === '__inline__';

  let callTemplate, resultTemplate;

  if (callIsInline) {
    callTemplate = config?.render?.inlineCall;
  } else {
    // 优先从缓存读取
    const cached = templateCache.get(callTemplateName);
    callTemplate = cached?.call || RENDER_TEMPLATES['json'].call;
  }

  if (resultIsInline) {
    resultTemplate = config?.render?.inlineResult;
  } else {
    const cached = templateCache.get(resultTemplateName);
    resultTemplate = cached?.result || RENDER_TEMPLATES['json'].result;
  }

  return {
    call: callTemplate,
    result: resultTemplate,
    isInlineCall: callIsInline,
    isInlineResult: resultIsInline,
  };
}

function getToolDisplayName(toolName) {
  if (!toolName) return 'Tool';
  return TOOL_NAMES[toolName] || toolName;
}

function getAgentRuntimeId(agent) {
  return agent.runtime_session_id || agent.runtimeSessionId || agent.id;
}

function getAgentDisplayId(agent) {
  if (isWorkspaceSurfaceUnit(agent)) {
    return '工作空间';
  }
  if (agent.source === 'prebuilt') {
    return agent.runtime_session_id ? '已启动' : '未启动';
  }
  return getAgentRuntimeId(agent);
}

// ── Session Title Double-Click Edit ──────────────────────────────────────────

window.handleSessionTitleDoubleClick = function(event) {
  event.preventDefault();
  event.stopPropagation();

  const titleDiv = event.currentTarget;
  const sessionItem = titleDiv.closest('[data-prebuilt-session-id]');
  if (!sessionItem) return;

  const sessionId = sessionItem.dataset.prebuiltSessionId;
  const agentId = sessionItem.dataset.prebuiltSessionAgentId;
  if (!sessionId || !agentId) return;

  const currentTitle = titleDiv.textContent.trim();
  const isSessionId = currentTitle.startsWith('session-');

  // Show AI generate button when entering edit mode
  const titleRow = titleDiv.closest('.workspace-history-title-row');
  const aiButton = titleRow ? titleRow.querySelector('.session-title-ai-btn') : null;
  if (aiButton) {
    aiButton.classList.remove('session-title-ai-btn-hidden');
  }

  titleDiv.innerHTML = '<input type="text" class="session-title-edit-input" value="' + escapeHtml(isSessionId ? '' : currentTitle) + '" placeholder="' + escapeHtml(currentLanguage === 'zh' ? '输入对话标题' : 'Enter session title') + '">';

  const input = titleDiv.querySelector('input');
  input.focus();
  input.select();

  let saved = false;
  let isGeneratingTitle = false;
  
  const saveTitle = async () => {
    if (saved || isGeneratingTitle) return;
    saved = true;
    const newTitle = input.value.trim();
    if (!newTitle || newTitle === currentTitle) {
      titleDiv.textContent = currentTitle || sessionId;
      // Hide AI button when exiting edit mode
      if (aiButton) {
        aiButton.classList.add('session-title-ai-btn-hidden');
      }
      return;
    }
    try {
      const resp = await fetch('/protoclaw/prebuilt_sessions/' + encodeURIComponent(sessionId) + '/title', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId, title: newTitle }),
      });
      const result = await resp.json();
      if (result.ok) {
        titleDiv.textContent = newTitle;
        const agent = allAgents.find(a => a.id === agentId);
        if (agent?.workspace_sessions?.sessions) {
          const session = agent.workspace_sessions.sessions.find(s => s.id === sessionId);
          if (session) session.title = newTitle;
        }
      } else {
        titleDiv.textContent = currentTitle || sessionId;
        console.error('Failed to update session title:', result.error);
      }
      // Hide AI button when exiting edit mode
      if (aiButton) {
        aiButton.classList.add('session-title-ai-btn-hidden');
      }
    } catch (error) {
      titleDiv.textContent = currentTitle || sessionId;
      console.error('Failed to update session title:', error);
      // Hide AI button when exiting edit mode
      if (aiButton) {
        aiButton.classList.add('session-title-ai-btn-hidden');
      }
    }
  };

  // Store the generating flag on the button for access from generateSessionTitle
  if (aiButton) {
    aiButton._isGeneratingTitle = false;
    aiButton._setGenerating = function(generating) {
      isGeneratingTitle = generating;
      aiButton._isGeneratingTitle = generating;
    };
  }

  input.addEventListener('blur', saveTitle);
  input.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveTitle();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (isGeneratingTitle) return; // Don't close while generating
      saved = true;
      titleDiv.textContent = currentTitle || sessionId;
      // Hide AI button when exiting edit mode
      if (aiButton) {
        aiButton.classList.add('session-title-ai-btn-hidden');
      }
    }
  });
};
