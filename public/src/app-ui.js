
function selectWorkspaceSurface(agentId, options = {}) {
  bumpNavigationGuard();
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
  const previousRuntimeId = currentRuntimeAgentId;
  const previousRuntimeContextKey = getRuntimeContextKey(previousRuntimeId);
  saveCurrentWorkspaceSurfaceScroll();
  if (previousRuntimeId && !readOnlyMode) {
    saveCurrentRuntimeToCache(previousRuntimeId, previousRuntimeContextKey);
  }
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

function getWorkspaceSurfaceScrollKey(agent = getCurrentAgentRecord(), mode = currentWorkspaceTab) {
  const key = getUnitPreferenceKey(agent);
  if (!key) return '';
  const safeMode = mode || getPassiveWorkspaceSurfaceMode(agent) || 'home';
  const workspaceState = getAgentWorkspaceState(agent);
  const forms = typeof getWorkspaceFormDraft === 'function'
    ? getWorkspaceFormDraft(agent)
    : (workspaceState?.forms || {});
  const startupForm = forms?.['startup-form'] || workspaceState?.forms?.['startup-form'] || {};
  const assemblyForm = forms?.['assembly-form'] || workspaceState?.forms?.['assembly-form'] || {};
  const scopeParts = [
    workspaceState?.openDirectory,
    startupForm.openDirectory,
    startupForm.open_directory,
    startupForm.target_dir,
    startupForm.feature_name,
    startupForm.agent_name,
    assemblyForm.editing_config_id,
    assemblyForm.assembly_name,
    assemblyForm.env_dir,
  ].map((value) => String(value || '').trim()).filter(Boolean);
  const scope = scopeParts.join('|').replace(/\\/g, '/').toLowerCase();
  return [key, safeMode, scope].join('|');
}

function saveCurrentWorkspaceSurfaceScroll() {
  if (!container || !container.querySelector('.workspace-surface')) return;
  const agent = getCurrentAgentRecord();
  if (!agent || !shouldRenderWorkspaceSurface(agent)) return;
  const key = getWorkspaceSurfaceScrollKey(agent);
  if (!key) return;
  workspaceSurfaceScrollCache.set(key, container.scrollTop || 0);
  lastRenderedWorkspaceScrollKey = key;
}

container.addEventListener('scroll', () => {
  if (workspaceSurfaceScrollSaveRaf || !container.querySelector('.workspace-surface')) return;
  workspaceSurfaceScrollSaveRaf = requestAnimationFrame(() => {
    workspaceSurfaceScrollSaveRaf = 0;
    saveCurrentWorkspaceSurfaceScroll();
  });
}, { passive: true });

/**
 * Merge two workspace_sessions objects at the property level, ensuring
 * contextLength / compressRatio are always preserved from whichever source
 * has a valid value. Without this, `||` can pick the runtime child's light
 * snapshot (which lacks contextLength) over the host's rich data, causing
 * the context bar to flash defaults on every loadAgents cycle.
 */
function _mergeWorkspaceSessions(primary, fallback) {
  if (!primary) return fallback || null;
  if (!fallback) return primary;
  let cl = Number.isFinite(primary.contextLength) && primary.contextLength > 0
    ? primary.contextLength
    : (Number.isFinite(fallback.contextLength) && fallback.contextLength > 0 ? fallback.contextLength : null);
  let cr = Number.isFinite(primary.compressRatio) && primary.compressRatio > 0
    ? primary.compressRatio
    : (Number.isFinite(fallback.compressRatio) && fallback.compressRatio > 0 ? fallback.compressRatio : null);
  return {
    ...fallback,
    ...primary,
    // Ensure model info survives even when the primary source lacks it
    ...(cl != null ? { contextLength: cl } : {}),
    ...(cr != null ? { compressRatio: cr } : {}),
  };
}

function getRuntimeAwareAgentRecord() {
  let hostRecord = typeof getCurrentAgentRecord === 'function' ? getCurrentAgentRecord() : null;
  if (typeof getCurrentRuntimeRecord === 'function') {
    const runtimeRecord = getCurrentRuntimeRecord();
    if (runtimeRecord) {
      const runtimeHasWorkspaceState = !!(
        runtimeRecord.workspace_sessions
        || runtimeRecord.active_workspace_session_id
        || runtimeRecord.active_workspace_session_title
        || runtimeRecord.active_workspace_display_name
      );
      if (runtimeHasWorkspaceState || !hostRecord) {
        // Runtime child records have active_workspace_session_id etc. but never
        // workspace_sessions.sessions (that only comes from the host record via
        // GET /protoclaw/prebuilt_sessions). Always merge in host's sessions so
        // context bar can find activeSession and read correct contextLength.
        //
        // Also carry modelPresets from host — runtime child records don't have
        // it, but getConnectedAgents populates it on the prebuilt host record
        // via resolveAgentModelPresets() on every refresh.
        const hostExtras = {
          ...(!runtimeRecord.modelPresets && hostRecord?.modelPresets
            ? { modelPresets: hostRecord.modelPresets }
            : {}),
        };
        if (hostRecord && hostRecord.workspace_sessions) {
          const mergedWorkspaceSessions = _mergeWorkspaceSessions(runtimeRecord.workspace_sessions, hostRecord.workspace_sessions);
          const runtimeSessionId = runtimeRecord.active_workspace_session_id || null;
          return {
            ...runtimeRecord,
            ...hostExtras,
            // The session list belongs to the host, but the selected chat view
            // belongs to the concrete runtime. A host snapshot may still point
            // at another concurrently running session, so never let its
            // activeSessionId override the runtime identity.
            workspace_sessions: runtimeSessionId
              ? { ...mergedWorkspaceSessions, activeSessionId: runtimeSessionId }
              : mergedWorkspaceSessions,
          };
        }
        return { ...runtimeRecord, ...hostExtras };
      }
      return {
        ...runtimeRecord,
        ...(!runtimeRecord.modelPresets && hostRecord?.modelPresets
          ? { modelPresets: hostRecord.modelPresets }
          : {}),
        workspace_sessions: _mergeWorkspaceSessions(hostRecord.workspace_sessions, runtimeRecord.workspace_sessions),
        active_workspace_session_id: hostRecord.active_workspace_session_id || runtimeRecord.active_workspace_session_id,
        active_workspace_session_title: hostRecord.active_workspace_session_title || runtimeRecord.active_workspace_session_title,
        active_workspace_display_name: hostRecord.active_workspace_display_name || runtimeRecord.active_workspace_display_name,
      };
    }
  }
  return hostRecord;
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

// 域 C (updateChatContextBar + CCB popup + Title popup) -> modules/chat-context-bar.js

// 域 D (ensurePhModelConfigHost, renderPhModelConfigOverlay) -> modules/ph-model-config.js

// 域 E 纯函数 (isAssemblySession ~ buildAutoSavedAssemblyConfigs) -> modules/assembly-data.js
// 域 E 状态管理 (getWorkspaceFormDraft ~ resetWorkspaceFormDraft) -> modules/assembly-data.js
// 域 E 异步操作 (persistWorkspaceState) -> modules/assembly-data.js

// ── QQBot Config Data -> modules/im-ui.js ──

// ── IM Workspace Data -> modules/im-ui.js ──

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

// ── Workspace Block Rendering → modules/workspace-blocks.js ──

// ── IM Rendering Helpers -> modules/im-ui.js ──

// ── IM Main Rendering -> modules/im-ui.js ──

// ── Schedule Console -> modules/dispatch-ui.js ──────────────────────
// isDispatchConfigEditor, DISPATCH_WORKSPACE_IDS, renderDispatchConfigEditor,
// renderDispatchDetailModal, renderDispatchModal -> modules/dispatch-ui.js

// --- FW Config Panel functions extracted to modules/fw-config-panel.js ---
//     window.ClawFW, drift dialog, renderProjectListBlock, fwRerender,
//     slash picker, feature import, project/create/confirm/prompt dialogs


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
        return '<div class="workspace-history-item" data-prebuilt-session-agent-id="' + escapeHtml(agent.id) + '" data-prebuilt-session-id="' + escapeHtml(item.id) + '"><div class="workspace-history-main"><div class="assembly-card-head"><div class="assembly-card-copy"><div class="workspace-history-title">' + escapeHtml(item.agentName || item.title || item.id) + (isCurrent ? ' <span class="workspace-history-active">' + escapeHtml(currentLanguage === 'zh' ? '当前' : 'Current') + '</span>' : '') + '</div><div class="assembly-card-meta">'
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

function renderWorkGroupChatBlock(agent, block) {
  if (!window.WorkGroupUI) return '';
  _ensureWorkGroupEventDelegation();
  if (window.WorkGroupUI.init && !window._workGroupInitialized) {
    window._workGroupInitialized = true;
    window.WorkGroupUI.init();
  }
  return window.WorkGroupUI.render();
}

function _ensureWorkGroupEventDelegation() {
  if (_workGroupEventsWired) return;
  _workGroupEventsWired = true;
  container.addEventListener('click', (e) => {
    if (window.WorkGroupUI && e.target.closest('.wg-app')) {
      window.WorkGroupUI.onContainerClick(e);
    }
  });
  container.addEventListener('input', (e) => {
    if (window.WorkGroupUI && e.target.closest('.wg-app')) {
      window.WorkGroupUI.onContainerInput(e);
    }
  });
  container.addEventListener('change', (e) => {
    if (window.WorkGroupUI && e.target.closest('.wg-app')) {
      window.WorkGroupUI.onContainerChange(e);
    }
  });
  container.addEventListener('keydown', (e) => {
    if (window.WorkGroupUI && e.target.closest('.wg-app')) {
      window.WorkGroupUI.onContainerKeyDown(e);
    }
  });
  container.addEventListener('contextmenu', (e) => {
    if (window.WorkGroupUI && window.WorkGroupUI.onContainerContextMenu && e.target.closest('.wg-app')) {
      window.WorkGroupUI.onContainerContextMenu(e);
    }
  });
  // 拖拽事件：从 Files 面板拖文件到输入区
  container.addEventListener('dragover', (e) => {
    if (window.WorkGroupUI && e.target.closest('.wg-app')) {
      window.WorkGroupUI.onContainerDragOver(e);
    }
  });
  container.addEventListener('dragleave', (e) => {
    if (window.WorkGroupUI && e.target.closest('.wg-app')) {
      window.WorkGroupUI.onContainerDragLeave(e);
    }
  });
  container.addEventListener('drop', (e) => {
    if (window.WorkGroupUI && e.target.closest('.wg-app')) {
      window.WorkGroupUI.onContainerDrop(e);
    }
  });
  container.addEventListener('mouseover', (e) => {
    if (window.WorkGroupUI && window.WorkGroupUI.onContainerMouseOver && e.target.closest('.wg-app')) {
      window.WorkGroupUI.onContainerMouseOver(e);
    }
  });
  container.addEventListener('mouseout', (e) => {
    if (window.WorkGroupUI && window.WorkGroupUI.onContainerMouseOut && e.target.closest('.wg-app')) {
      window.WorkGroupUI.onContainerMouseOut(e);
    }
  });
}

function renderWorkspaceBlock(agent, block) {
  if (!shouldRenderBlock(block)) return '';
  if (block.type === 'hero') return renderWorkspaceHero(agent, block);
  if (block.type === 'launcher-grid') return renderWorkspaceLauncherGrid(agent, block);
  if (block.type === 'action-group') return renderWorkspaceActionGroup(block);
  if (block.type === 'session-list') return renderWorkspaceSessionList(agent, block);
  if (block.type === 'studio-projects') return renderStudioProjectsBlock(agent, block);
  if (block.type === 'form') return renderWorkspaceForm(agent, block);
  if (block.type === 'status-grid') return renderWorkspaceStatusGrid(agent, block);
  if (block.type === 'assembly-library') return renderAssemblyLibraryBlock(agent, block);
  if (block.type === 'assembly-workbench') return renderAssemblyWorkbenchBlock(agent, block);
  if (block.type === 'project-list') return renderProjectListBlock(agent, block);
  if (block.type === 'feature-repository') return renderFeatureRepositoryBlock(agent, block);
  if (block.type === 'workspace-artifacts') return renderWorkspaceArtifactsBlock(agent, block);
  if (block.type === 'project-docset') return renderProjectDocsetBlock(agent, block);
  if (block.type === 'config-editor') return isIMWorkspaceConfigEditor(block) ? renderIMWorkspaceConfigEditor(block) : isDispatchConfigEditor(block) ? renderDispatchConfigEditor(block) : '';
  if (block.type === 'system-feature-config') return isSystemFeatureConfigBlock(block) ? renderSystemFeatureConfigBlock(block) : '';
  if (block.type === 'flow-editor') return renderFlowEditorBlock(agent, block);
  if (block.type === 'work-group-chat') return renderWorkGroupChatBlock(agent, block);
  return '';
}

function renderWorkspaceSurface(agent = getCurrentAgentRecord()) {
  // Home agent — render the new Dashboard instead of legacy blocks
  if (agent?.id === 'home' && typeof renderHomeDashboard === 'function') {
    return renderHomeDashboard();
  }

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

function isEditingWorkspaceForm() {
  const active = document.activeElement;
  if (!(active instanceof Element)) {
    return false;
  }
  return Boolean(active.closest('.workspace-form') || active.closest('.project-docset-requirement-form'));
}

function renderCurrentMainView(viewState = readCurrentSessionViewState()) {
  const agent = getCurrentAgentRecord();
  // ── 根据表面类型控制 rail button 可见性 ──
  const isWorkGroup = !!(agent && agent.id === 'work-group');
  const inChat = isChatSurfaceActive(agent);
  // 调试类面板（workspace/monitor/hooks/inspector/logs/mcp）只在 AI 对话时显示
  // resources/viewer/settings 面板只在群聊工作空间显示
  railButtons.forEach(btn => {
    const panel = btn.dataset.panel;
    if (!panel) return; // 工具按钮（语言/主题/设置）始终显示
    if (panel === 'resources' || panel === 'viewer' || panel === 'settings' || panel === 'threads') {
      btn.style.display = isWorkGroup ? '' : 'none';
    } else {
      btn.style.display = inChat ? '' : 'none';
    }
  });
  // 离开 group chat workspace 时清理状态
  if (!isWorkGroup) {
    if (activeFeaturePanel === 'resources' || activeFeaturePanel === 'viewer' || activeFeaturePanel === 'settings' || activeFeaturePanel === 'threads') activeFeaturePanel = null;
    if (window._wgActive && typeof window.WorkGroupUI?.deactivate === 'function') {
      window.WorkGroupUI.deactivate();
      window._wgActive = false;
    }
    // 清空资源/文档面板缓存
    if (typeof window.resetResourcesViewerState === 'function') {
      window.resetResourcesViewerState();
    }
  } else {
    // 重新进入 group chat workspace 时恢复轮询
    if (!window._wgActive && window.WorkGroupUI) {
      window._wgActive = true;
      if (typeof window.WorkGroupUI.startPolling === 'function') {
        window.WorkGroupUI.startPolling();
      }
    } else {
      window._wgActive = true;
    }
  }
  ensureChatViewportObservers();
  renderWorkspaceTabs(agent);
  renderInputRequests(viewState.inputRequests);
  if (shouldRenderWorkspaceSurface(agent)) {
    cancelChatScrollSettlement();
    // Capture before renderWorkspaceSurface consumes and resets it
    const isNewWorkspaceSurface = shouldAnimateWorkspaceSurface;
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
      const workspaceScrollKey = getWorkspaceSurfaceScrollKey(agent);
      const isSameWorkspaceScrollSurface =
        containerIsWorkspace
        && workspaceScrollKey
        && lastRenderedWorkspaceScrollKey === workspaceScrollKey
        && !isNewWorkspaceSurface;
      if (containerIsWorkspace && lastRenderedWorkspaceScrollKey && !isSameWorkspaceScrollSurface) {
        workspaceSurfaceScrollCache.set(lastRenderedWorkspaceScrollKey, container.scrollTop || 0);
      }
      const savedWsScrollTop = isSameWorkspaceScrollSurface
        ? container.scrollTop
        : (workspaceScrollKey ? (workspaceSurfaceScrollCache.get(workspaceScrollKey) || 0) : 0);
      const prevScrollBehavior = container.style.scrollBehavior;
      runWithSuppressedChatViewportObservers(() => {
        container.style.scrollBehavior = 'auto';
        container.style.visibility = 'hidden';
        container.innerHTML = newHtml;
      }, 220);
      lastRenderedWorkspaceHtml = newHtml;
      lastRenderedWorkspaceScrollKey = workspaceScrollKey;
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
      requestAnimationFrame(() => {
        container.scrollTop = savedWsScrollTop;
        container.style.visibility = '';
        container.style.scrollBehavior = prevScrollBehavior;
        requestAnimationFrame(() => {
          if (lastRenderedWorkspaceScrollKey === workspaceScrollKey && shouldRenderWorkspaceSurface(agent)) {
            container.scrollTop = savedWsScrollTop;
          }
        });
      });
    }
    updateProjectDocsetChrome(agent);
    updateChatContextBar(viewState);
    if (typeof updateChatProcessToggle === 'function') {
      updateChatProcessToggle(viewState.messages);
    }
    updateFollowLatestButton();
    requestAnimationFrame(updateAssemblySideRailPosition);
    return;
  }

  // Keep lastRenderedWorkspaceHtml intact so returning from chat to workspace
  // can skip re-render if workspace data hasn't changed.
  if (viewState.messages.length === 0) {
    renderChatEmptyState();
    updateProjectDocsetChrome(agent);
    updateChatContextBar(viewState);
    if (typeof updateChatProcessToggle === 'function') {
      updateChatProcessToggle(viewState.messages);
    }
    updateFollowLatestButton();
    return;
  }

  render(viewState.messages);
  updateChatContextBar(viewState);
  updateProjectDocsetChrome(agent);
  if (typeof updateChatProcessToggle === 'function') {
    updateChatProcessToggle(viewState.messages);
  }
  requestAnimationFrame(updateAssemblySideRailPosition);
}

// --- chat-viewport functions extracted to modules/chat-viewport.js ---
//     updateAssemblySideRailPosition

function resetRuntimeBackedSurfaceState() {
  applySessionViewPatch({
    messages: [],
    inputRequests: [],
    hookInspector: { lifecycleOrder: [], features: [], hooks: [] },
    overview: getEmptyOverviewSnapshot(),
    todoPlan: getEmptyTodoPlan(),
  });
  renderInputRequests([]);
  setCurrentLogs([]);
  setConnectionStatus(false);
  updateNotificationStatus({});
  lastRenderedWorkspaceHtml = '';
  _lastRenderedChatSig = '';
  clearChatLoadingSession();
  currentWorkspaceArtifactDetail = null;
  currentWorkspaceDocsetDetail = null;
  currentProjectDocsetOpen = false;
  currentProjectRequirementEdit = null;
  currentProjectDocsetPage = 'requirement';
  resetUserCollapseStateForContext();
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

// --- chat-viewport functions extracted to modules/chat-viewport.js ---
//     getToggleButtonLabel, isNearBottom, updateFollowLatestButton, markManualScrollIntent,
//     getChatViewportMetrics, getChatViewportBottomTop, setChatViewportTop,
//     lockChatViewportToBottomNow, suppressChatViewportObservers, resumeChatViewportObservers,
//     shouldIgnoreChatViewportObserverEvent, runWithSuppressedChatViewportObservers,
//     cancelFollowLatestAnimation, startFollowLatestAnimation, ensureChatViewportObservers,
//     interruptFollowLatest, registerManualScrollIntent, hasRecentManualScrollIntent,
//     beginFollowLatestCooldown, isFollowLatestCooldownActive,
//     beginFollowLatestEntryWindow, isFollowLatestEntryWindowActive,
//     cancelChatScrollSettlement, notifyChatViewportMutation

// 域 E env 操作 + onclick handlers (captureAssemblyFieldFocus ~ window.toggleAssemblyStage) -> modules/assembly-data.js

// --- chat-viewport functions extracted to modules/chat-viewport.js ---
//     scrollToLatest, setFollowLatest, scheduleFollowLatestSettlePass,
//     requestFollowLatest, scheduleScrollToLatest, scheduleScrollToLatestWithVersion

// --- overview-data functions extracted to modules/overview-data.js ---
//     shortenSourcePath, FULL_HOOK_LIFECYCLE_ORDER, getHookInspectorSignature,
//     getEmptyOverviewSnapshot, normalizeRuntimeSnapshot, normalizeOverviewSnapshot,
//     getOverviewSignature, normalizeHookInspector, setCurrentHookInspector,
//     setCurrentOverviewSnapshot, setCurrentLogs

// --- Todo Plan functions extracted to modules/todo-plan.js ---
//     getEmptyTodoPlan, normalizeTodoPlan, setCurrentTodoPlan,
//     updatePlanBadge, renderPlanTask, renderPlanPanel, sendTodoControl


// ── Feature Panels 注册 ──────────────────────────────────────────

const featurePanels = {
  workspace: {
    title: () => t('panel_structure'),
    render: () => renderStructurePanel(),
  },
  plan: {
    title: () => t('panel_plan'),
    render: () => renderPlanPanel(),
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
  preflight: {
    title: () => '装配预检',
    render: () => renderPreflightPanel(),
  },
  mcp: {
    title: () => t('panel_mcp'),
    render: () => renderMcpPanel(),
  },
  genui: {
    title: () => '交互页面',
    render: () => window.GenUIPanel ? window.GenUIPanel.getHtml() : '<div class="feature-panel-empty"><div>加载中...</div></div>',
    preserveOnReRender: true,
  },
  'force-continuation': {
    title: () => currentLanguage === 'zh' ? '强制继续' : 'Force Continuation',
    render: () => window.ForceContinuationPanel
      ? window.ForceContinuationPanel.render()
      : '<div class="feature-panel-empty"><div>加载中...</div></div>',
  },

  settings: {
    title: () => '群聊设置',
    render: () => window._wgGetSettingsHtml ? window._wgGetSettingsHtml() : '<div class="feature-panel-empty"><div>加载中...</div></div>',
  },
  threads: {
    title: () => '工作线程',
    render: () => window._wgGetThreadsHtml ? window._wgGetThreadsHtml() : '<div class="feature-panel-empty"><div>加载中...</div></div>',
  },
};

// Sidebar Toggle + narrow-width drawer backdrop
let _sidebarBackdrop = null;
function _ensureSidebarBackdrop() {
  if (_sidebarBackdrop) return _sidebarBackdrop;
  _sidebarBackdrop = document.createElement('div');
  _sidebarBackdrop.className = 'sidebar-backdrop';
  _sidebarBackdrop.addEventListener('click', () => {
    sidebar.classList.add('collapsed');
    _updateSidebarBackdrop();
  });
  document.body.insertBefore(_sidebarBackdrop, document.querySelector('.main-content'));
  return _sidebarBackdrop;
}
function _isNarrowScreen() { return window.innerWidth <= 860; }
function _updateSidebarBackdrop() {
  if (!_sidebarBackdrop) return;
  const show = _isNarrowScreen() && !sidebar.classList.contains('collapsed');
  _sidebarBackdrop.classList.toggle('visible', show);
}
sidebarToggle.addEventListener('click', () => {
  sidebar.classList.toggle('collapsed');
  if (_isNarrowScreen()) {
    _ensureSidebarBackdrop();
    _updateSidebarBackdrop();
  }
});
window.addEventListener('resize', () => {
  if (!_isNarrowScreen()) {
    // Wide screen: hide backdrop, ensure sidebar visible
    if (_sidebarBackdrop) _sidebarBackdrop.classList.remove('visible');
  } else {
    _updateSidebarBackdrop();
  }
});

// Sidebar Resize
(function initSidebarResizer() {
  const SIDEBAR_MIN = 200;
  const SIDEBAR_MAX = 480;
  // 收回区硬下限：保证"松开以收起面板"提示单行显示，不被挤压换行（与右侧面板一致）
  const SIDEBAR_COLLAPSE_FLOOR = 180;
  const STORAGE_KEY = 'agentdev-sidebar-width';

  // Restore saved width
  try {
    const saved = parseInt(localStorage.getItem(STORAGE_KEY));
    if (saved >= SIDEBAR_MIN && saved <= SIDEBAR_MAX) {
      document.documentElement.style.setProperty('--sidebar-width', saved + 'px');
    }
  } catch (_) { /* ignore */ }

  sidebarResizer.addEventListener('mousedown', (e) => {
    e.preventDefault();
    sidebarResizer.classList.add('dragging');
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';

    // 收回区提示文案随当前语言刷新（提示仅在拖拽期间可见）
    if (sidebarCollapseHint) {
      sidebarCollapseHint.querySelector('.sidebar-collapse-hint-title').textContent = t('panel_collapse_hint_title');
    }

    // 记录拖拽开始时的正常宽度：松手收起后恢复，避免重新展开时宽度异常
    let lastStableWidth = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX,
      parseInt(getComputedStyle(sidebar).width) || 280));
    let shouldCollapse = false;
    let inCollapseZone = false;

    const handleMouseMove = (ev) => {
      const enterThreshold = SIDEBAR_MIN - 60;
      const exitThreshold = SIDEBAR_MIN - 10;

      // Hysteresis: 用不同阈值进出收回区，避免边界抖动（与右侧面板机制一致）
      if (!inCollapseZone && ev.clientX < enterThreshold) {
        inCollapseZone = true;
      } else if (inCollapseZone && ev.clientX > exitThreshold) {
        inCollapseZone = false;
      }

      if (inCollapseZone) {
        shouldCollapse = true;
        sidebar.classList.add('drag-collapsing');
        document.documentElement.style.setProperty('--sidebar-width',
          Math.max(ev.clientX, SIDEBAR_COLLAPSE_FLOOR) + 'px');
      } else {
        shouldCollapse = false;
        sidebar.classList.remove('drag-collapsing');
        const w = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, ev.clientX));
        lastStableWidth = w;
        document.documentElement.style.setProperty('--sidebar-width', w + 'px');
      }
    };

    const handleMouseUp = () => {
      sidebarResizer.classList.remove('dragging');
      sidebar.classList.remove('drag-collapsing');
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      if (shouldCollapse) {
        sidebar.classList.add('collapsed');
        _updateSidebarBackdrop();
      }
      // 无论是否收起，宽度都回到最后一个正常值并持久化（收起时恢复，未收起时保持当前值）
      document.documentElement.style.setProperty('--sidebar-width', lastStableWidth + 'px');
      try { localStorage.setItem(STORAGE_KEY, lastStableWidth + 'px'); } catch (_) { /* ignore */ }
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  });
})();

// [Phase 2d-1] Markdown / 数学公式渲染 → modules/markdown-utils.js

// [Phase 2f-2] renderFeaturePanel / toggleFeaturePanel → modules/debug-panels.js

let _logSearchRenderTimer = 0;
window.updateLogFilter = (key, value) => {
  logFilters[key] = value;
  if (key === 'search') {
    // 搜索输入防抖：避免每个键程触发整列表重渲染
    clearTimeout(_logSearchRenderTimer);
    _logSearchRenderTimer = setTimeout(() => {
      _logSearchRenderTimer = 0;
      renderFeaturePanel();
    }, 180);
    return;
  }
  renderFeaturePanel();
};

// [工作项 D] 装配预检面板动作（模块函数声明于 modules/debug-preflight.js）
window.loadPreflight = loadPreflight;

// Domain P (context-menu functions) → modules/context-menu.js

railButtons.forEach(button => {
  if (!button.dataset.panel) return; // 工具按钮（语言/主题/设置）不参与面板切换
  button.addEventListener('click', () => {
    toggleFeaturePanel(button.dataset.panel);
    if (button.dataset.panel === 'logs' && activeFeaturePanel === 'logs') {
      loadLogs(true).catch((error) => console.error('Failed to load logs:', error));
    } else if (button.dataset.panel === 'mcp' && activeFeaturePanel === 'mcp') {
      loadMcpInfo(true).catch((error) => console.error('Failed to load MCP info:', error));
    } else if (button.dataset.panel === 'resources' && activeFeaturePanel === 'resources') {
      window._rvLoadData().catch((error) => console.error('Failed to load resources:', error));
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

// Settings flyout menu — click gear to toggle, click item to act + close
const settingsFlyout = document.getElementById('settings-flyout-menu');

settingsToggle.addEventListener('click', (e) => {
  e.stopPropagation();
  settingsFlyout.classList.toggle('open');
});

document.getElementById('settings-flyout-config').addEventListener('click', () => {
  settingsFlyout.classList.remove('open');
  if (window.ClawFW.settingsOpen) {
    closeSettings();
  } else {
    openSettings();
  }
});

document.getElementById('settings-flyout-proxy')?.addEventListener('click', () => {
  settingsFlyout.classList.remove('open');
  if (typeof openProxySettings === 'function') {
    openProxySettings();
  }
});

document.getElementById('settings-flyout-remote')?.addEventListener('click', () => {
  settingsFlyout.classList.remove('open');
  if (typeof openRemoteClawSettings === 'function') {
    openRemoteClawSettings();
  }
});

document.getElementById('settings-flyout-usage').addEventListener('click', () => {
  settingsFlyout.classList.remove('open');
  if (typeof openUsageInfo === 'function') {
    openUsageInfo();
  }
});

document.getElementById('settings-flyout-mcp-gateway')?.addEventListener('click', () => {
  settingsFlyout.classList.remove('open');
  if (typeof openMcpGateway === 'function') {
    openMcpGateway();
  }
});

document.getElementById('settings-flyout-exit').addEventListener('click', () => {
  settingsFlyout.classList.remove('open');
  if (!confirm(currentLanguage === 'zh' ? '确定要退出程序吗？' : 'Are you sure you want to quit?')) return;
  fetch('/protoclaw/shutdown', { method: 'POST' }).catch(e => console.warn(e));
});

featurePanelResizer.addEventListener('mousedown', (event) => {
  if (!featurePanel.classList.contains('open')) return;

  event.preventDefault();

  // 收回区提示文案随当前语言刷新（提示仅在拖拽期间可见）
  if (featurePanelCollapseHint) {
    featurePanelCollapseHint.querySelector('.feature-panel-collapse-hint-title').textContent = t('panel_collapse_hint_title');
  }

  // ── 拖动期间滚动位置保持 ──
  // 宽度变化时用行级锚定保持阅读位置（跟随模式锁底），实现见 chat-viewport.js。
  // 时序关键：mousemove 只记录目标 clientX；改宽度样式 → forced layout 读
  // offsetTop → 设 scrollTop 收敛进同一个 rAF 回调，paint 时布局与滚动一致。
  // 拖动期间抑制 viewport observers，防止 settlement 的 preserveTop 与锚定打架。
  const _anchor = (typeof captureChatViewportAnchor === 'function')
    ? captureChatViewportAnchor() : null;
  let _suppressApplied = false;
  if (_anchor && typeof suppressChatViewportObservers === 'function') {
    suppressChatViewportObservers(120000);
    _suppressApplied = true;
  }

  let shouldCollapse = false;
  let inCollapseZone = false;
  let _pendingClientX = null;
  let _dragRaf = 0;

  const _dragFrame = () => {
    _dragRaf = 0;
    if (_pendingClientX == null) return;
    const clientX = _pendingClientX;
    _pendingClientX = null;

    // 1) 宽度 + collapse 判定（写样式，标记 layout dirty）
    const nextWidth = window.innerWidth - clientX - 56;
    const minWidth = window.innerWidth <= 1100 ? 300 : 400;
    const enterThreshold = minWidth - 60;
    const exitThreshold = minWidth - 10;

    // Hysteresis: 用不同阈值进出收回区，避免边界抖动
    if (!inCollapseZone && nextWidth < enterThreshold) {
      inCollapseZone = true;
    } else if (inCollapseZone && nextWidth > exitThreshold) {
      inCollapseZone = false;
    }

    if (inCollapseZone) {
      shouldCollapse = true;
      featurePanel.classList.add('drag-collapsing');
      // 硬下限：保证收回区提示文案单行显示，不被挤压换行
      featurePanel.style.setProperty('--feature-panel-width', Math.max(nextWidth, 180) + 'px');
    } else {
      shouldCollapse = false;
      featurePanel.classList.remove('drag-collapsing');
      featurePanelWidth = Math.max(minWidth, Math.min(750, nextWidth));
      featurePanel.style.setProperty('--feature-panel-width', featurePanelWidth + 'px');
    }

    // 2) 同步锚定：样式已 dirty，读 offsetTop 触发 forced layout 拿到新宽度
    //    下的位置，立即设 scrollTop，同帧 paint 一致。
    if (_anchor && typeof applyChatViewportAnchor === 'function') {
      applyChatViewportAnchor(_anchor);
    }
  };

  const handleMouseMove = (moveEvent) => {
    // 只记录目标位置，实际改动统一交给 rAF，避免与读位置产生相位差
    _pendingClientX = moveEvent.clientX;
    if (!_dragRaf) _dragRaf = requestAnimationFrame(_dragFrame);
  };

  const handleMouseUp = () => {
    window.removeEventListener('mousemove', handleMouseMove);
    window.removeEventListener('mouseup', handleMouseUp);
    if (_dragRaf) { cancelAnimationFrame(_dragRaf); _dragRaf = 0; }
    featurePanel.classList.remove('drag-collapsing');
    if (_suppressApplied && typeof resumeChatViewportObservers === 'function') {
      resumeChatViewportObservers();
    }
    if (_anchor && _anchor.mode === 'follow' &&
        typeof scheduleFollowLatestSettlePass === 'function') {
      scheduleFollowLatestSettlePass();
    }
    if (shouldCollapse) {
      activeFeaturePanel = null;
      renderFeaturePanel();
    }
  };

  window.addEventListener('mousemove', handleMouseMove);
  window.addEventListener('mouseup', handleMouseUp);
});

/* ── 面板宽度变化时切换 .narrow class，驱动 feature-grid 列数 ── */
const _fpNarrowObserver = new ResizeObserver(entries => {
  for (const entry of entries) {
    featurePanelBody.classList.toggle('narrow', entry.contentRect.width < 380);
  }
});
_fpNarrowObserver.observe(featurePanelBody);

/* ══════════════════════════════════════
   Generic ctx-menu system
   ══════════════════════════════════════ */

let _ctxTarget = null;

function escapeHtmlCtx(s) {
  const d = document.createElement('div');
  d.textContent = String(s);
  return d.innerHTML;
}

function renderCtxItems(items) {
  return items.map((item, i) => {
    if (item.type === 'separator') return '<div class="ctx-menu-sep"></div>';
    if (item.submenu) {
      return '<div class="ctx-menu-item has-submenu">'
        + escapeHtmlCtx(item.label)
        + '<span class="ctx-menu-arrow">›</span>'
        + '<div class="ctx-sub">' + renderCtxItems(item.submenu) + '</div>'
        + '</div>';
    }
    const cls = ['ctx-menu-item'];
    if (item.danger) cls.push('danger');
    if (item.disabled) cls.push('disabled');
    return '<button class="' + cls.join(' ') + '" type="button" data-ctx-action="' + escapeHtmlCtx(item.action) + '">'
      + escapeHtmlCtx(item.label)
      + '</button>';
  }).join('');
}

function showCtxMenu(x, y, items, target) {
  _ctxTarget = target;
  window._ctxTarget = target;
  ctxMenu.innerHTML = renderCtxItems(items);
  ctxMenu.classList.add('open');
  ctxMenu.style.left = '0px';
  ctxMenu.style.top = '0px';
  const rect = ctxMenu.getBoundingClientRect();
  const margin = 8;
  const maxLeft = window.innerWidth - rect.width - margin;
  const maxTop = window.innerHeight - rect.height - margin;
  ctxMenu.style.left = Math.max(margin, Math.min(x, maxLeft)) + 'px';
  ctxMenu.style.top = Math.max(margin, Math.min(y, maxTop)) + 'px';

  // Flip submenus to the left when there's not enough space on the right
  const submenuWidth = 160;
  const placedRect = ctxMenu.getBoundingClientRect();
  if (placedRect.right + submenuWidth > window.innerWidth - margin) {
    ctxMenu.classList.add('flip-submenu');
  } else {
    ctxMenu.classList.remove('flip-submenu');
  }
}

function closeCtxMenu() {
  ctxMenu.classList.remove('open');
  ctxMenu.classList.remove('flip-submenu');
  ctxMenu.innerHTML = '';
  _ctxTarget = null;
  window._ctxTarget = null;
}

window.showCtxMenu = showCtxMenu;
window.closeCtxMenu = closeCtxMenu;
