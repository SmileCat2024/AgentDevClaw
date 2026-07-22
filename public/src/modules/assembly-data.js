/**
 * assembly-data.js — Assembly 数据层模块（从 app-ui.js 域 E 提取）
 *
 * Phase 3b-1a：纯函数（无副作用），不包含状态读写和异步操作。
 *
 * 包含：
 *   Session 类型判断：
 *     - isAssemblySession, isAssemblySessionRunning
 *     - getAssemblySessionStatus, buildWorkspaceProjectKey
 *   校验/规范化：
 *     - sanitizeWorkspacePathFragment, isValidFeatureCreatorName
 *     - isValidAgentCreatorName, normalizeAssemblyDirectoryToken
 *     - findAssemblyConfigConflict
 *     - getFeatureCreatorOutputDirectory, getAgentCreatorOutputDirectory
 *     - normalizeFeatureCreatorStartupDraft, normalizeProgrammingHelperStartupDraft
 *     - normalizeWorkspaceStartupDraft, getExpectedAssemblyEnvDir
 *   Draft/Env 状态（纯函数）：
 *     - normalizeAssemblyDraft, getAssemblyDisplayName
 *     - getAssemblyEnvironmentState
 *     - getAssemblyEnvironmentStatusLabel, getAssemblyEnvironmentStatusTone
 *     - renderAssemblyStatusChip
 *     - getAssemblySavedConfigSummary, getAssemblyEditorMode
 *   配置聚合：
 *     - collectAssemblyProjectFeatureConfigs, buildAutoSavedAssemblyConfigs
 *
 * 外部依赖（全局作用域）：
 *   - currentLanguage, escapeHtml (app-core.js / markdown-utils.js)
 *   - getWorkspaceSessions, getAgentWorkspaceState, getWorkspaceBlockData,
 *     getWorkspaceFormStorageKey (project-data.js)
 *   - normalizeFeatureConfigMap, featureConfigKeyMatches,
 *     normalizeFeatureConfigEntry (feature-config.js)
 *   - parseWorkspaceListField (workspace-blocks.js)
 *   - getSavedAssemblyConfigs, canonicalizeAssemblyFeatureSelection (app-main.js)
 */

// ──────────────────────────────────────────────────────────────
// Session 类型判断
// ──────────────────────────────────────────────────────────────

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

// ──────────────────────────────────────────────────────────────
// 校验/规范化
// ──────────────────────────────────────────────────────────────

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
  return String(value || '').trim().replace(/[\\/]+/g, '/').toLowerCase();
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
  return parentDir.replace(/[\\/]+$/, '') + '\\' + featureName;
}

function getAgentCreatorOutputDirectory(agent, startupDraft = {}) {
  if (agent?.id !== 'agent-creator') return '';
  const agentName = String(startupDraft.agent_name || '').trim();
  const parentDir = String(startupDraft.target_dir || '').trim();
  if (!agentName || !parentDir) return '';
  return parentDir.replace(/[\\/]+$/, '') + '\\' + agentName;
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

// ──────────────────────────────────────────────────────────────
// Draft/Env 状态（纯函数）
// ──────────────────────────────────────────────────────────────

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

// ──────────────────────────────────────────────────────────────
// 配置聚合
// ──────────────────────────────────────────────────────────────

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

// ──────────────────────────────────────────────────────────────
// Draft 管理（状态读写）
// ──────────────────────────────────────────────────────────────

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

// ── Async / DOM / Timer ──

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

// ── onclick handlers ──

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
