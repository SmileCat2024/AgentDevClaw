
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
 * 更新聊天界面顶部的 context bar（模型名 + token 占比）。
 * 从 currentOverviewSnapshot 取 lastRequestUsage，从当前 agent/session 取模型名和 contextLength。
 */
function getRuntimeAwareAgentRecord() {
  var hostRecord = typeof getCurrentAgentRecord === 'function' ? getCurrentAgentRecord() : null;
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
        if (hostRecord && hostRecord.workspace_sessions) {
          return {
            ...runtimeRecord,
            workspace_sessions: runtimeRecord.workspace_sessions || hostRecord.workspace_sessions,
          };
        }
        return runtimeRecord;
      }
      return {
        ...runtimeRecord,
        workspace_sessions: hostRecord.workspace_sessions || runtimeRecord.workspace_sessions,
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
    '<div class="feature-detail-overlay">',
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

// settings-overlay extracted to modules/settings-overlay.js
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
    '<div class="feature-detail-overlay">',
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
    '<div class="feature-detail-overlay">',
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
    '<div class="feature-detail-overlay">',
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
    '<div class="feature-detail-overlay">',
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

function renderCurrentMainView() {
  const agent = getCurrentAgentRecord();
  // ── 根据表面类型控制 rail button 可见性 ──
  const isWorkGroup = !!(agent && agent.id === 'work-group');
  const inChat = isChatSurfaceActive(agent);
  // 调试类面板（workspace/monitor/hooks/inspector/logs/mcp）只在 AI 对话时显示
  // resources/viewer/settings 面板只在群聊工作空间显示
  railButtons.forEach(btn => {
    const panel = btn.dataset.panel;
    if (!panel) return; // 工具按钮（语言/主题/设置）始终显示
    if (panel === 'resources' || panel === 'viewer' || panel === 'settings') {
      btn.style.display = isWorkGroup ? '' : 'none';
    } else {
      btn.style.display = inChat ? '' : 'none';
    }
  });
  // 离开 AI 对话时关闭调试类面板
  if (!inChat && activeFeaturePanel && activeFeaturePanel !== 'resources' && activeFeaturePanel !== 'viewer' && activeFeaturePanel !== 'settings') {
    activeFeaturePanel = null;
  }
  // 离开 group chat workspace 时清理状态
  if (!isWorkGroup) {
    if (activeFeaturePanel === 'resources' || activeFeaturePanel === 'viewer' || activeFeaturePanel === 'settings') activeFeaturePanel = null;
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
  renderInputRequests(currentInputRequests);
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
    cancelChatScrollSettlement();
    runWithSuppressedChatViewportObservers(() => {
      container.innerHTML = getEmptyStateHtml();
    }, 180);
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

// --- chat-viewport functions extracted to modules/chat-viewport.js ---
//     updateAssemblySideRailPosition

function resetRuntimeBackedSurfaceState() {
  currentMessages = [];
  currentInputRequests = [];
  window.lastInputRequests = [];
  renderInputRequests([]);
  setCurrentLogs([]);
  setCurrentHookInspector({ lifecycleOrder: [], features: [], hooks: [] });
  setCurrentOverviewSnapshot(getEmptyOverviewSnapshot());
  setCurrentTodoPlan(getEmptyTodoPlan());
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

function getEmptyTodoPlan() {
  return {
    feature: 'todo',
    updatedAt: 0,
    counter: 0,
    tasks: [],
    summary: { total: 0, pending: 0, inProgress: 0, completed: 0, cancelled: 0, blocked: 0 },
  };
}

function normalizeTodoPlan(snapshot) {
  const empty = getEmptyTodoPlan();
  if (!snapshot || typeof snapshot !== 'object') return empty;
  const tasks = Array.isArray(snapshot.tasks) ? snapshot.tasks.map(task => ({
    id: String(task?.id || ''),
    subject: String(task?.subject || ''),
    description: String(task?.description || ''),
    activeForm: String(task?.activeForm || ''),
    status: ['pending', 'in_progress', 'completed', 'deleted'].includes(task?.status) ? task.status : 'pending',
    owner: typeof task?.owner === 'string' ? task.owner : '',
    blocks: Array.isArray(task?.blocks) ? task.blocks.map(String) : [],
    blockedBy: Array.isArray(task?.blockedBy) ? task.blockedBy.map(String) : [],
    metadata: task?.metadata && typeof task.metadata === 'object' ? task.metadata : {},
    createdAt: typeof task?.createdAt === 'number' ? task.createdAt : 0,
    updatedAt: typeof task?.updatedAt === 'number' ? task.updatedAt : 0,
  })).filter(task => task.id) : [];
  const summary = snapshot.summary || {};
  return {
    feature: 'todo',
    updatedAt: typeof snapshot.updatedAt === 'number' ? snapshot.updatedAt : 0,
    counter: typeof snapshot.counter === 'number' ? snapshot.counter : tasks.length,
    tasks,
    summary: {
      total: typeof summary.total === 'number' ? summary.total : tasks.length,
      pending: typeof summary.pending === 'number' ? summary.pending : tasks.filter(task => task.status === 'pending').length,
      inProgress: typeof summary.inProgress === 'number' ? summary.inProgress : tasks.filter(task => task.status === 'in_progress').length,
      completed: typeof summary.completed === 'number' ? summary.completed : tasks.filter(task => task.status === 'completed').length,
      cancelled: typeof summary.cancelled === 'number' ? summary.cancelled : tasks.filter(task => task.status === 'deleted').length,
      blocked: typeof summary.blocked === 'number' ? summary.blocked : tasks.filter(task => (task.status === 'pending' || task.status === 'in_progress') && task.blockedBy.length > 0).length,
    },
    interruptTargetId: typeof snapshot.interruptTargetId === 'string' ? snapshot.interruptTargetId : null,
  };
}

function getTodoPlanSignature(snapshot) {
  return JSON.stringify(normalizeTodoPlan(snapshot));
}

function setCurrentTodoPlan(snapshot) {
  const normalized = normalizeTodoPlan(snapshot);
  currentTodoPlan = normalized;
  currentTodoPlanSignature = getTodoPlanSignature(normalized);
  updatePlanBadge();
}

function updatePlanBadge() {
  const badge = document.getElementById('rail-plan-badge');
  if (!badge) return;
  const tasks = Array.isArray(currentTodoPlan?.tasks) ? currentTodoPlan.tasks : [];
  const incomplete = tasks.filter(t => t.status === 'pending' || t.status === 'in_progress').length;
  if (incomplete > 0) {
    badge.textContent = incomplete > 99 ? '99+' : String(incomplete);
    badge.classList.add('visible');
  } else {
    badge.classList.remove('visible');
    badge.textContent = '';
  }
}

// [Phase 2f-2] Usage/Token 渲染 + 日志面板 + MCP 面板 + 生命周期选择器 + Summary + Upload + 结构/监控/特性/Hook 面板 + renderFeaturePanel → modules/debug-panels.js

function getTodoStatusLabel(status) {
  const labels = {
    pending: t('plan_pending'),
    in_progress: t('plan_in_progress'),
    completed: t('plan_completed'),
    deleted: t('plan_cancelled'),
  };
  return labels[status] || status || t('metric_unavailable');
}

function renderPlanTask(task) {
  const status = String(task?.status || 'pending');
  const isTerminal = status === 'completed' || status === 'deleted';
  const blocked = !isTerminal && Array.isArray(task?.blockedBy) && task.blockedBy.length > 0;
  const taskId = String(task?.id || '');
  const isInterruptTarget = !isTerminal && getInterruptTargetId() === taskId;
  const meta = [
    '#' + escapeHtml(taskId),
    getTodoStatusLabel(status),
    blocked ? t('plan_blocked') : '',
  ].filter(Boolean).join(' · ');
  const detail = isTerminal ? '' : (task?.description || task?.activeForm || '');
  const marker = status === 'in_progress'
    ? '<div class="plan-task-spinner"></div>'
    : '<div class="plan-task-dot"></div>';
  const actionBtn = isTerminal ? '' : (isInterruptTarget
    ? '<button class="plan-task-action" data-todo-interrupt data-action="cancel" data-task-id="' + escapeHtml(taskId) + '">' + (currentLanguage === 'zh' ? '取消停止' : 'Cancel stop') + '</button>'
    : '<button class="plan-task-action" data-todo-interrupt data-action="set" data-task-id="' + escapeHtml(taskId) + '">' + (currentLanguage === 'zh' ? '完成后停止' : 'Stop after done') + '</button>');
  const interruptLabel = isInterruptTarget ? '<span class="plan-task-interrupt-label">' + (currentLanguage === 'zh' ? '停止点' : 'Stop point') + '</span>' : '';
  return [
    '<article class="plan-task status-' + escapeHtml(status.replace(/[^a-z0-9_-]/gi, '-')) + (blocked ? ' is-blocked' : '') + (isTerminal ? ' is-terminal' : '') + (isInterruptTarget ? ' is-interrupt-target' : '') + '">',
    '<div class="plan-task-marker">' + marker + '</div>',
    '<div class="plan-task-main">',
    '<div class="plan-task-title">' + escapeHtml(task?.subject || '') + interruptLabel + '</div>',
    detail ? '<div class="plan-task-desc">' + escapeHtml(detail) + '</div>' : '',
    isTerminal ? '' : '<div class="plan-task-meta">' + escapeHtml(meta) + '</div>',
    actionBtn,
    '</div>',
    '</article>',
  ].join('');
}

function renderPlanPanel() {
  const plan = currentTodoPlan || {};
  const tasks = Array.isArray(plan.tasks) ? plan.tasks : [];
  const summary = plan.summary || {};
  const stats = [
    [t('plan_total'), summary.total ?? tasks.length],
    [t('plan_in_progress'), summary.inProgress ?? tasks.filter(task => task.status === 'in_progress').length],
    [t('plan_pending'), summary.pending ?? tasks.filter(task => task.status === 'pending').length],
    [t('plan_completed'), summary.completed ?? tasks.filter(task => task.status === 'completed').length],
    [t('plan_cancelled'), summary.cancelled ?? tasks.filter(task => task.status === 'deleted').length],
  ];

  if (tasks.length === 0) {
    return [
      '<div class="plan-panel">',
      '<section class="plan-summary">',
      '<div class="plan-summary-line">',
      stats.map(([label, value]) => '<span><strong>' + escapeHtml(String(value)) + '</strong> ' + escapeHtml(label) + '</span>').join(''),
      '</div>',
      '</section>',
      '<div class="plan-empty">',
      '<div class="plan-empty-title">' + escapeHtml(t('plan_empty')) + '</div>',
      '<div class="plan-empty-desc">' + escapeHtml(t('plan_empty_desc')) + '</div>',
      '</div>',
      '</div>',
    ].join('');
  }

  return [
    '<div class="plan-panel">',
    '<section class="plan-summary">',
    '<div class="plan-summary-line">',
    stats.map(([label, value]) => '<span><strong>' + escapeHtml(String(value)) + '</strong> ' + escapeHtml(label) + '</span>').join(''),
    '</div>',
    '</section>',
    '<section class="plan-task-list">',
    tasks.map(task => renderPlanTask(task)).join(''),
    '</section>',
    '</div>',
  ].join('');
}

// ── TODO 中断控制（完成后停止）──────────────────────────────────

async function sendTodoControl(taskId) {
  if (!currentRuntimeAgentId) return;
  const agent = (allAgents || []).find(a => a.id === currentRuntimeAgentId || a.id === currentAgentId);
  const sessionId = agent?.active_workspace_session_id || agent?.workspace_sessions?.activeSessionId || undefined;
  try {
    await fetch('/protoclaw/todo_control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: currentAgentId, sessionId, taskId }),
    });
  } catch (e) {
    console.error('[TodoControl] request failed:', e);
  }
}

featurePanelBody.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-todo-interrupt]');
  if (!btn) return;
  e.preventDefault();
  e.stopPropagation();
  const action = btn.dataset.action;
  const taskId = btn.dataset.taskId;
  // 立即更新前端变量并重新渲染
  setInterruptTargetId(action === 'set' ? taskId : null);
  if (activeFeaturePanel === 'plan') {
    renderFeaturePanel();
  }
  if (action === 'set') {
    sendTodoControl(taskId);
  } else if (action === 'cancel') {
    sendTodoControl(null);
  }
});

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
  mcp: {
    title: () => t('panel_mcp'),
    render: () => renderMcpPanel(),
  },
  settings: {
    title: () => '群聊设置',
    render: () => window._wgGetSettingsHtml ? window._wgGetSettingsHtml() : '<div class="feature-panel-empty"><div>加载中...</div></div>',
  },
};

// Sidebar Toggle
sidebarToggle.addEventListener('click', () => {
  sidebar.classList.toggle('collapsed');
});

// [Phase 2d-1] Markdown / 数学公式渲染 → modules/markdown-utils.js

// [Phase 2f-2] renderFeaturePanel / toggleFeaturePanel → modules/debug-panels.js

window.setLogPanelScope = async (scope) => {
  logPanelScope = scope === 'all' ? 'all' : 'current';
  await loadLogs(true);
  renderFeaturePanel();
};

window.updateLogFilter = (key, value) => {
  logFilters[key] = value;
  renderFeaturePanel();
};

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

document.getElementById('settings-flyout-usage').addEventListener('click', () => {
  settingsFlyout.classList.remove('open');
  if (typeof openUsageInfo === 'function') {
    openUsageInfo();
  }
});

document.getElementById('settings-flyout-exit').addEventListener('click', () => {
  settingsFlyout.classList.remove('open');
  if (!confirm(currentLanguage === 'zh' ? '确定要退出程序吗？' : 'Are you sure you want to quit?')) return;
  fetch('/protoclaw/shutdown', { method: 'POST' }).catch(() => {});
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
