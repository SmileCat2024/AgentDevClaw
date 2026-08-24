function normalizeAgentIdentity(value) {
  return String(value || '').trim();
}

function getCurrentHostAgentRecord() {
  const hostId = normalizeAgentIdentity(focusedAgentId);
  if (!hostId) return null;
  return allAgents.find((agent) => normalizeAgentIdentity(agent?.id) === hostId) || null;
}

function getCurrentRuntimeRecord() {
  const runtimeId = normalizeAgentIdentity(currentRuntimeAgentId);
  if (!runtimeId) return null;
  const runtimeRecord = allAgents.find((agent) => {
    const agentId = normalizeAgentIdentity(agent?.id);
    const resolvedRuntimeId = normalizeAgentIdentity(getAgentRuntimeId(agent));
    return agentId === runtimeId || resolvedRuntimeId === runtimeId;
  }) || null;
  if (runtimeRecord) {
    return runtimeRecord;
  }
  const hostRecord = getCurrentHostAgentRecord();
  const hostRuntimeId = normalizeAgentIdentity(getRuntimeId(hostRecord));
  if (hostRecord && hostRuntimeId && hostRuntimeId === runtimeId) {
    return hostRecord;
  }
  return null;
}

function getCurrentVisualAgentTitle() {
  const runtimeRecord = getCurrentRuntimeRecord();
  const hostRecord = getCurrentHostAgentRecord();
  if (runtimeRecord && normalizeAgentIdentity(currentRuntimeAgentId)) {
    return runtimeRecord.active_workspace_display_name
      || runtimeRecord.active_workspace_agent_name
      || runtimeRecord.active_workspace_session_title
      || runtimeRecord.name
      || hostRecord?.active_workspace_display_name
      || hostRecord?.active_workspace_session_title
      || hostRecord?.name
      || currentRuntimeAgentId;
  }
  return hostRecord?.name || t('page_title');
}

function updateCurrentAgentChrome() {
  if (!currentAgentTitle || !statusBadge) return;
  const hasSelection = normalizeAgentIdentity(focusedAgentId) || normalizeAgentIdentity(currentRuntimeAgentId);
  if (!hasSelection) {
    currentAgentTitle.textContent = t('page_title');
    statusBadge.textContent = t('status_no_agent');
    statusBadge.classList.add('disconnected');
    return;
  }
  currentAgentTitle.textContent = getCurrentVisualAgentTitle();
  if (!normalizeAgentIdentity(currentRuntimeAgentId)) {
    statusBadge.textContent = currentLanguage === 'zh' ? '系统空间' : 'System';
    statusBadge.classList.remove('disconnected');
    return;
  }
  const runtimeRecord = getCurrentRuntimeRecord();
  const connected = runtimeRecord ? runtimeRecord.connected !== false : true;
  statusBadge.textContent = connected ? t('status_connected') : t('status_disconnected');
  statusBadge.classList.toggle('disconnected', !connected);
}

function isAgentActive(agent) {
  const agentId = normalizeAgentIdentity(agent?.id);
  const runtimeId = normalizeAgentIdentity(currentRuntimeAgentId);
  const hostId = normalizeAgentIdentity(focusedAgentId);
  if (!agentId) return false;
  if (runtimeId) {
    if (agent?.source === 'prebuilt' && agentId === hostId) {
      return false;
    }
    return agentId === runtimeId && agentId === hostId;
  }
  return agentId === hostId;
}

function getCurrentAgentRecord() {
  return getCurrentHostAgentRecord();
}

function groupConnectedAgents(agents) {
  // 左侧分类使用 sidebarGroup；agentId 只描述真实运行宿主。
  const TOOL_AGENT_IDS = new Set(['programming-helper']);
  const WORK_GROUP_IDS = new Set(['work-group']);
  const prebuiltIds = new Set(
    agents
      .filter((agent) => agent.source === 'prebuilt')
      .map((agent) => String(agent.id || '').trim())
      .filter(Boolean)
  );
  const orphanRuntimeAgents = agents.filter((agent) => {
    if (agent.source === 'prebuilt') return false;
    const parentId = String(getParentAgentId(agent) || '').trim();
    return !parentId || !prebuiltIds.has(parentId);
  });
  const allPrebuilt = agents.filter((agent) => agent.source === 'prebuilt');
  // 投影条目（id 形如 'programming-helper:coder'）按宿主 agentId 归组
  const groupKeyOf = (agent) => String(agent.sidebarGroup || '').trim();
  const legacyGroupKeyOf = (agent) => String(agent.agentId || agent.id || '').trim();
  return {
    prebuilt: allPrebuilt.filter((agent) => {
      const group = groupKeyOf(agent);
      const legacyGroup = legacyGroupKeyOf(agent);
      return !['tool', 'work-group'].includes(group)
        && !TOOL_AGENT_IDS.has(legacyGroup)
        && !WORK_GROUP_IDS.has(legacyGroup);
    }),
    workGroup: allPrebuilt.filter((agent) => groupKeyOf(agent) === 'work-group' || WORK_GROUP_IDS.has(legacyGroupKeyOf(agent))),
    tool: allPrebuilt.filter((agent) => groupKeyOf(agent) === 'tool' || TOOL_AGENT_IDS.has(legacyGroupKeyOf(agent))),
    external: orphanRuntimeAgents,
  };
}

function isRuntimeItemActive(runtimeId) {
  const normalizedRuntimeId = normalizeAgentIdentity(runtimeId);
  return normalizedRuntimeId !== '' && normalizeAgentIdentity(currentRuntimeAgentId) === normalizedRuntimeId;
}

function toEpochMs(value) {
  if (!value) return 0;
  if (typeof value === 'number') return value;
  const parsed = Date.parse(value);
  return isNaN(parsed) ? 0 : parsed;
}

function getInputSurfaceMode(requests = readCurrentSessionViewState().inputRequests) {
  const chatActive = isChatSurfaceActive();
  if (!chatActive) return 'hidden';
  if (readOnlyMode) return 'readonly';

  const hasRuntimeSelected = !!currentRuntimeAgentId;
  const hasRequests = Array.isArray(requests) && requests.some(req => !isChoiceInputRejected(req.requestId));
  const hasChoiceRequest = hasRequests && requests.some(req => isChoiceInputRequest(req) && !isChoiceInputRejected(req.requestId));
  if (hasChoiceRequest) {
    return 'requests';
  }

  const hasLocalQueuedInput = hasRuntimeSelected
    && (_localQueuedInputPending || _pendingQueuedCount > 0 || _queuedTexts.length > 0);

  if (hasLocalQueuedInput && hasRuntimeSelected) {
    return 'persistent';
  }
  if (hasRequests) {
    return 'requests';
  }
  if (hasRuntimeSelected && isRuntimeCalling(currentRuntimeAgentId)) {
    return 'persistent';
  }
  if (hasRuntimeSelected) {
    return 'persistent';
  }
  return 'hidden';
}

// ── Sidebar rendering & agent list → modules/sidebar-render.js ──


window.handlePrebuiltAgentClick = async (agentId) => {
  bumpNavigationGuard();
  closeAgentContextMenu();
  const prebuiltAgent = allAgents.find((agent) => agent.id === agentId && agent.source === 'prebuilt');
  if (!prebuiltAgent) return;
  if (!isWorkspaceHostUnit(prebuiltAgent)) {
    setPreferredUnitMode('home', prebuiltAgent);
  }

  if (isWorkspaceHostUnit(prebuiltAgent)) {
    // 投影条目（如 programming-helper:coder）：详情数据挂宿主命名空间，
    // surface 键挂条目自身（entry id），侧栏高亮与记忆也按条目记录。
    const hostAgentId = prebuiltAgent.agentId || prebuiltAgent.id;
    focusedAgentId = agentId;
    renderAgentList();
    if (!loadedAgentDetailIds.has(hostAgentId)) {
      container.innerHTML = '<div class="workspace-surface" style="display:grid;place-items:center;color:var(--text-secondary);font-size:14px;">' + escapeHtml(currentLanguage === 'zh' ? '加载中...' : 'Loading...') + '</div>';
    }
    await loadAgentDetail(hostAgentId);
    loadedAgentDetailIds.add(agentId);
    if (prebuiltAgent.agentId) {
      try { localStorage.setItem('claw:lastFocusedEntryId', agentId); } catch { /* ignore */ }
    }
    selectWorkspaceSurface(prebuiltAgent.id, { skipFeaturePanel: true });
    return;
  }

  if (isWorkspaceSurfaceUnit(prebuiltAgent)) {
    focusedAgentId = agentId;
    renderAgentList();
    if (!loadedAgentDetailIds.has(agentId)) {
      container.innerHTML = '<div class="workspace-surface" style="display:grid;place-items:center;color:var(--text-secondary);font-size:14px;">' + escapeHtml(currentLanguage === 'zh' ? '加载中...' : 'Loading...') + '</div>';
    }
    await loadAgentDetail(prebuiltAgent.id);
    selectWorkspaceSurface(prebuiltAgent.id, { skipFeaturePanel: true });
    return;
  }

  const runtimeSessionId = prebuiltAgent.runtime_session_id || prebuiltAgent.runtimeSessionId;
  if (runtimeSessionId) {
    await window.switchAgent(runtimeSessionId);
    return;
  }

  if (pendingPrebuiltAgentIds.has(agentId)) {
    return;
  }

  pendingPrebuiltAgentIds.add(agentId);
  statusBadge.textContent = t('status_starting');
  statusBadge.classList.remove('disconnected');
  renderAgentList();

  const _startNavGuard = _navigationGuardEpoch;
  try {
    await invoke('start_agent', { agentId });
    const startedAgent = await waitForPrebuiltRuntimeSession(agentId);
    pendingPrebuiltAgentIds.delete(agentId);
    renderAgentList();
    if (_startNavGuard !== _navigationGuardEpoch) return;
    const nextRuntimeId = startedAgent.runtime_session_id || startedAgent.runtimeSessionId || startedAgent.id;
    setPreferredUnitMode('home', allAgents.find((agent) => agent.id === agentId && agent.source === 'prebuilt') || startedAgent);
    await requestSwitch(nextRuntimeId, 'prebuilt-start');
  } catch (e) {
    pendingPrebuiltAgentIds.delete(agentId);
    renderAgentList();
    console.error('Failed to start prebuilt agent:', e);
    showAgentStartError(e);
  }
};

async function openPrebuiltWorkspaceSession(agentId, rawAction) {
  const action = typeof rawAction === 'string' ? JSON.parse(rawAction) : (rawAction || {});
  const endpoint = (action.type === 'create_session' || action.type === 'create_session_from_session')
    ? '/protoclaw/prebuilt_sessions'
    : '/protoclaw/prebuilt_sessions/activate';
  const payload = (action.type === 'create_session' || action.type === 'create_session_from_session')
    ? {
        agentId,
        sourceSessionId: action.sessionId || null,
        featureName: action.featureName || '',
        agentName: action.agentName || '',
        projectName: action.projectName || '',
        openDirectory: action.openDirectory || '',
        targetDir: action.targetDir || '',
        operationId: action.operationId || '',
        responseMode: 'delta',
      }
    : { agentId, sessionId: action.sessionId, operationId: action.operationId || '', responseMode: 'delta' };
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(await response.text().catch(() => 'session operation failed'));
  }
  return response.json();
}

function applyOptimisticWorkspaceSession(agentId, session) {
  if (!agentId || !session?.id) return null;
  const hostAgent = allAgents.find((agent) => agent.id === agentId) || null;
  const existingSessions = Array.isArray(hostAgent?.workspace_sessions?.sessions)
    ? hostAgent.workspace_sessions.sessions
    : [];
  const nextSessions = [session, ...existingSessions.filter((item) => item?.id !== session.id)];
  return updateAgentRecord(agentId, {
    workspace_sessions: {
      ...(hostAgent?.workspace_sessions || {}),
      activeSessionId: session.id,
      sessions: nextSessions,
    },
    active_workspace_session_id: session.id,
    active_workspace_session_form_id: session.formId || null,
    active_workspace_session_title: session.title || '',
    active_workspace_agent_name: session.agentName || '',
    active_workspace_display_name: session.formId === 'assembly-form'
      ? (session.agentName || session.title || '')
      : (hostAgent?.active_workspace_display_name || ''),
  });
}

async function createCompactedResumeSession(agentId, sessionId, strategy = 'summarized-nine-section', keepRecentTurns = null, fullPreserveFromTurn = null, extraPolicy = null, options = {}) {
  const currentAgent = getCurrentAgentRecord();
  const activeSessionId = String(getActiveSessionId(currentAgent) || '').trim();
  const runtimeAgentId = getRuntimeId(currentRuntimeAgentId) || getRuntimeId(currentAgent) || '';
  const policy = strategy ? { strategy } : {};
  if (keepRecentTurns != null && keepRecentTurns >= 1) {
    policy.keepRecentTurns = keepRecentTurns;
  }
  if (fullPreserveFromTurn != null && fullPreserveFromTurn >= 0) {
    policy.fullPreserveFromTurn = fullPreserveFromTurn;
  }
  if (extraPolicy && typeof extraPolicy === 'object') {
    Object.assign(policy, extraPolicy);
  }
  const operationId = options.operationId || createSidebarOperationId(options.reason === 'trim' ? 'trim' : 'summary');
  const requestStartedAt = sidebarDiagnosticNow();
  const stopMainThreadObservation = beginSidebarOperationMainThreadObservation(operationId);
  recordSidebarOperationCheckpoint(operationId, 'request_dispatched');
  try {
    const resumeResponse = await fetch('/protoclaw/context_handoffs/compact_and_resume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId,
        sessionId,
        detached: false,
        policy,
        ...(options.archiveOriginal ? { archiveOriginal: true } : {}),
        ...(options.reason ? { reason: options.reason } : {}),
        ...(options.trimCutRounds != null ? { trimCutRounds: options.trimCutRounds } : {}),
        ...(options.appendSummary ? { appendSummary: true } : {}),
        operationId,
        responseMode: 'delta',
      }),
    });
    const headersReceivedAt = sidebarDiagnosticNow();
    const responseBytes = Number(resumeResponse.headers?.get?.('content-length')) || 0;
    recordSidebarOperationCheckpoint(operationId, 'response_headers_received', {
      requestWaitMs: headersReceivedAt - requestStartedAt,
      responseBytes,
    });
    if (!resumeResponse.ok) {
      throw new Error(await resumeResponse.text().catch(() => 'compacted resume failed'));
    }

    const result = await resumeResponse.json();
    recordSidebarOperationCheckpoint(operationId, 'response_body_parsed', {
      bodyParseMs: sidebarDiagnosticNow() - headersReceivedAt,
      responseBytes,
    });
    // 线程宿主（coder）：compact 接力在服务端响应前已完成 head 推进，
    // 强制刷新线程状态，使导航落地时徽标/承接指示器立即就位。
    if (typeof window.refreshThreads === 'function') {
      window.refreshThreads(true).catch(() => {});
    }
    return result;
  } finally {
    stopMainThreadObservation();
  }
}


// PH session list helpers (switchPhSessionTab, phToggleSessionSort, _buildPhSearchPanelHtml,
// phOnSearchInput, phClearSearch, phShowSessionCtxMenu) moved to modules/ph-session-list.js
// runWorkspaceAction moved to modules/workspace-actions.js

/**
 * Unified cross-workspace session navigation.
 *
 * Combines workspace switch + session activation into a single smooth flow,
 * avoiding the intermediate workspace-surface render that handlePrebuiltAgentClick
 * + runWorkspaceAction would produce when called serially.
 *
 * Used by: group chat "jump to session", home dashboard "open session", etc.
 *
 * @param {string} agentId  Target workspace agent ID (e.g. 'programming-helper')
 * @param {string} sessionId  Session ID to activate (empty = just switch workspace)
 * @param {object} [options]
 * @param {object} [options.actionOverride]  Custom action object to pass to
 *   runWorkspaceAction instead of { type: 'open_session', sessionId }.
 *   Used by navigateToSessionRecord which needs { type: 'view_session_record', ... }.
 */
window.navigateToWorkspaceSession = async (agentId, sessionId, options = {}) => {
  if (!agentId) return;
  bumpNavigationGuard();
  const _navGuard = _navigationGuardEpoch;
  const actionOverride = options.actionOverride || null;

  // Build the action to execute after workspace switch.
  const action = actionOverride
    || (sessionId ? { type: 'open_session', sessionId } : null);

  // Already in the target workspace — delegate directly to runWorkspaceAction.
  if (focusedAgentId === agentId) {
    if (action) {
      await window.runWorkspaceAction(JSON.stringify(action));
    }
    return;
  }

  const prebuiltAgent = allAgents.find((agent) => agent.id === agentId && agent.source === 'prebuilt');
  if (!prebuiltAgent) return;

  // Step 1: synchronously switch the sidebar highlight + show loading placeholder.
  // This mirrors what handlePrebuiltAgentClick does for workspace host units,
  // but WITHOUT calling selectWorkspaceSurface (which would render the workspace
  // home page unnecessarily).
  if (typeof saveCurrentWorkspaceSurfaceScroll === 'function') {
    saveCurrentWorkspaceSurfaceScroll();
  }
  if (currentRuntimeAgentId && !readOnlyMode) {
    saveCurrentRuntimeToCache(currentRuntimeAgentId, getRuntimeContextKey(currentRuntimeAgentId));
  }

  focusedAgentId = agentId;
  currentRuntimeAgentId = null;
  readOnlyMode = false;
  currentWorkspaceArtifactDetail = null;
  currentWorkspaceDocsetDetail = null;
  currentProjectDocsetOpen = false;
  currentProjectRequirementEdit = null;
  currentWorkspaceTab = 'chat';
  _lastRenderedChatSig = '';
  resetRuntimeBackedSurfaceState();
  renderAgentList();

  // Show a loading placeholder in the main area so the user sees immediate feedback.
  container.innerHTML = '<div class="workspace-surface" style="display:grid;place-items:center;color:var(--text-secondary);font-size:14px;">' + escapeHtml(currentLanguage === 'zh' ? '加载中...' : 'Loading...') + '</div>';

  // Step 2: load agent detail (sessions list, workspace config, etc.) if not cached.
  await loadAgentDetail(agentId);

  // Guard: user may have navigated away during loadAgentDetail.
  if (_navGuard !== _navigationGuardEpoch) return;

  // Step 3: delegate to runWorkspaceAction which handles session activation,
  // optimistic render, runtime switch, and polling — all in one flow.
  if (action) {
    await window.runWorkspaceAction(JSON.stringify(action));
  } else {
    // No specific session requested — just render the workspace surface.
    setPreferredUnitMode('home', prebuiltAgent);
    renderCurrentMainView();
  }
};

// ── Docset & material actions → modules/workspace-docset.js ──


window.runWorkspaceActionFromEvent = async (event, rawAction) => {
  const btn = event?.target instanceof Element ? event.target.closest('button[data-workspace-action]') : null;
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }
  await window.runWorkspaceAction(rawAction, btn || undefined);
};

document.addEventListener('click', (event) => {
  const actionButton = event.target instanceof Element
    ? event.target.closest('button[data-workspace-action]')
    : null;
  if (!actionButton) return;
  if (actionButton.classList.contains('compact-trigger')) return;
  event.preventDefault();
  event.stopPropagation();
  if (typeof event.stopImmediatePropagation === 'function') {
    event.stopImmediatePropagation();
  }
  const rawAction = actionButton.dataset?.workspaceAction || '';
  window.runWorkspaceAction(rawAction, actionButton).catch((error) => {
    console.error('Failed to handle delegated workspace action:', error);
  });
}, true);

// ── assembly actions → modules/assembly-actions.js (Phase C, 2026-07-04) ──


// ── PH 项目操作 / Model Config → modules/ph-project-actions.js (Phase A-4, 2026-07-03) ──

// ── ctx-menu items / dispatcher → modules/ctx-menu-items.js (Phase B-2, 2026-07-04) ──

window.showCompactMenu = (event, buttonElement) => {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }

  const rawAction = buttonElement?.dataset?.workspaceAction;
  let action = {};
  try {
    action = typeof rawAction === 'string' ? JSON.parse(rawAction) : rawAction;
  } catch {
    return;
  }

  if (!action.sessionId) return;

  const rect = buttonElement.getBoundingClientRect();
  openCompactMenu(action, rect.left, rect.bottom + 4);
};


function markSessionLoading(agentId, sessionId) {
  const el = document.querySelector(
    `.workspace-history-item[data-prebuilt-session-agent-id="${CSS.escape(agentId)}"][data-prebuilt-session-id="${CSS.escape(sessionId)}"]`
  );
  if (el) el.classList.add('session-loading');
}

function markActionLoading(buttonEl) {
  if (buttonEl) buttonEl.classList.add('action-loading');
}

function clearSessionLoading(agentId) {
  document.querySelectorAll(`.workspace-history-item.session-loading[data-prebuilt-session-agent-id="${CSS.escape(agentId)}"]`)
    .forEach(el => el.classList.remove('session-loading'));
  document.querySelectorAll('.workspace-action.action-loading')
    .forEach(el => el.classList.remove('action-loading'));
}

 // ── assembly session operations → modules/assembly-actions.js (Phase C, 2026-07-04) ──


/**
 * Flush the pending switch slot: if the serial still matches, execute the
 * actual switchAgent call and clear the slot.  Only the most recent
 * requestSwitch() call wins; stale flushes are silently discarded.
 *
 * Navigation guard: if the user navigated between requestSwitch() and this
 * flush (the setTimeout(0) gap), the epoch won't match and the switch is
 * aborted.  This closes the race where a user click event fires between
 * the guard check at the call-site and the deferred execution here.
 */
function flushPendingSwitch(serial, resolve) {
  if (!pendingSwitchTarget || pendingSwitchTarget.serial !== serial) {
    resolve({ switched: false, reason: 'superseded' });
    return;
  }
  const runtimeId = pendingSwitchTarget.runtimeId;
  const navEpoch = pendingSwitchTarget.navEpoch;
  pendingSwitchTarget = null;
  if (navEpoch !== _navigationGuardEpoch) {
    resolve({ switched: false, reason: 'nav-guard-stale' });
    return;
  }
  window.switchAgent(runtimeId).then(
    () => resolve({ switched: true }),
    (e) => resolve({ switched: false, reason: e?.message }),
  );
}

/**
 * Request a deferred agent switch.  The call-site is an async operation
 * that has just completed (B-class).  The target is written to the
 * "pending switch slot"; only the most recent caller's serial wins.
 *
 * Returns a Promise so callers can still `await` it; resolves with
 * { switched: true } or { switched: false, reason }.
 *
 * @param {string} runtimeId  The runtime agent id to switch to.
 * @param {string} source     A short label for debugging (e.g. 'launch', 'restart').
 */
function requestSwitch(runtimeId, source) {
  pendingSwitchSerial += 1;
  const serial = pendingSwitchSerial;
  pendingSwitchTarget = { runtimeId, serial, source, navEpoch: _navigationGuardEpoch };
  return new Promise((resolve) => {
    setTimeout(() => flushPendingSwitch(serial, resolve), 0);
  });
}

window.switchAgent = async (newAgentId) => {
  // A-class (direct) calls cancel any pending deferred switch.
  bumpNavigationGuard();
  pendingSwitchTarget = null;
  const epoch = ++_switchEpoch;
  closeAgentContextMenu();
  const targetAgent = findAgentByIdentity(newAgentId);
  const requestedRuntimeOfWorkspaceHost = !!(
    targetAgent
    && isWorkspaceHostUnit(targetAgent)
    && newAgentId
    && newAgentId !== targetAgent.id
    && getRuntimeId(targetAgent) === newAgentId
  );
  const runtimeAgentId = requestedRuntimeOfWorkspaceHost
    ? newAgentId
    : (targetAgent ? getAgentRuntimeId(targetAgent) : newAgentId);
  if (!runtimeAgentId) return;
  if (isWorkspaceSurfaceUnit(targetAgent) && !requestedRuntimeOfWorkspaceHost) {
    if (targetAgent?.id === focusedAgentId && !currentRuntimeAgentId) return;
    selectWorkspaceSurface(targetAgent.id);
    return;
  }
  if (targetAgent?.id === focusedAgentId && runtimeAgentId === currentRuntimeAgentId) return;
  _storeVisibleSessionInputDraft();
  if (typeof saveCurrentWorkspaceSurfaceScroll === 'function') {
    saveCurrentWorkspaceSurfaceScroll();
  }
  if (currentRuntimeAgentId && !readOnlyMode) {
    saveCurrentRuntimeToCache(currentRuntimeAgentId);
  }
  try {
    // Set global state and do optimistic render IMMEDIATELY — before the PUT.
    // This lets the user see cached data without waiting for a network round trip.
    focusedAgentId = getLogicalAgentId(targetAgent) || runtimeAgentId;
    currentRuntimeAgentId = runtimeAgentId;
    // 用户主动切换：立即冻结 viewer 侧会话身份。必须在此之前用 allAgents
    // 派生值（此时绑定尚未写入，读到的是用户点击时刻列表展示的会话），
    // 之后 getRuntimeContextKey 不再随外部入口抢占的 host activeSessionId 漂移。
    setViewerSessionBinding(
      runtimeAgentId,
      _deriveRuntimeSessionIdFromAgents(runtimeAgentId) || getActiveWorkspaceSessionId(targetAgent),
    );
    _recentlyFinishedRuntimes.delete(runtimeAgentId);
    // 沙盒等不接受外部输入的 runtime（input_accepted=false）以只读视图打开
    readOnlyMode = targetAgent?.input_accepted === false;
    currentWorkspaceArtifactDetail = null;
    currentWorkspaceDocsetDetail = null;
    currentProjectDocsetOpen = false;
    currentProjectRequirementEdit = null;
    currentProjectDocsetPage = 'requirement';
    currentWorkspaceTab = 'chat';
    // Clear chat render dedup so the new agent's messages always rebuild the DOM
    _lastRenderedChatSig = '';
    // A pending scroll restore is only valid within the switch that set it;
    // clear any stale one from an earlier switch that never reached a full render.
    setPendingChatScrollRestore(null);
    // Reset process visibility: every session entry starts in hidden-process mode
    showChatProcess = false;
    // 立即清空上一会话的运行状态显示（顶栏 + 对话区指示块）。
    // 旧会话快照要等 loadAgentData 的 notification 刷新才会被替换，
    // 期间渲染会把旧快照重建为新会话的"模型正在思考…"残留。
    resetRuntimeStatusForSwitch();
    activateUserCollapseStateForContext(getRuntimeContextKey(runtimeAgentId));
    // Optimistic restore: show cached data immediately if available
    const _restored = restoreRuntimeFromCache(runtimeAgentId);
    if (_restored) {
      lastRenderedWorkspaceHtml = '';
      if (followLatestEnabled) {
        // [F3 决策 2026-08-19] 跟随模式切回：不乐观渲染缓存消息、不落缓存底部 ——
        // 离开期间有增长时 loadAgentData 到达后要二次跳到新底部（切回闪跳主因）。
        // 清空消息渲染空态，等首次全量渲染直接锁到新底部，一步到位。
        // render() 的空态分支不 notify / 不锁底，不会产生中间落位。
        applySessionViewPatch({ messages: [] });
        renderCurrentMainView();
      } else {
        // 阅读模式切回：乐观渲染缓存内容并恢复阅读位置（F2 修复）。恢复值经
        // pending 通道交给渲染器作为 preserveTop，不直接写容器 —— 此刻容器仍是
        // 旧会话 DOM，直接写会被浏览器钳制，短→长会话切换时阅读位置被销毁。
        if (_restoredScrollTop != null) {
          setPendingChatScrollRestore(_restoredScrollTop);
        }
        renderCurrentMainView();
      }
      _restoredScrollTop = null;
      renderFeaturePanel();
    } else {
      // No cache: clear stale messages to prevent poll race mixing old/new agent content
      applySessionViewPatch({
        messages: [],
        overview: getEmptyOverviewSnapshot(),
        todoPlan: getEmptyTodoPlan(),
      });
      renderCurrentMainView();
      setFollowLatest(true);
    }
    beginFollowLatestCooldown();
    beginFollowLatestEntryWindow();
    renderAgentList();

    // Pre-warm calling status for the new runtime in parallel with PUT + loadAgentData.
    // For dispatched agents not yet tracked by refreshAgentCallStates, this eliminates
    // the window where the send button incorrectly shows because _agentCallActive has
    // no entry for this runtime yet.
    fetch(`/api/agents/${encodeURIComponent(runtimeAgentId)}/notification`)
      .then((res) => res.ok ? res.json() : null)
      .then((data) => {
        if (!data) return;
        if (normalizeAgentIdentity(currentRuntimeAgentId) !== normalizeAgentIdentity(runtimeAgentId)) return;
        const isCalling = resolveNotificationCallingState(data);
        if (isCalling) {
          _markAgentCallStartedForNotify(runtimeAgentId);
          _agentCallActive.set(runtimeAgentId, true);
        } else {
          _agentCallActive.delete(runtimeAgentId);
        }
        _syncPersistentActionButton();
        renderAgentList();
      })
      .catch(e => console.warn(e));

    // 焦点已前端化（服务端 current agent 语义已移除）：持久化记忆本次焦点，
    // 供下次打开页面时恢复（sidebar-render.js 读取）。进入会话浏览时投影
    // 入口记忆让位（claw:lastFocusedEntryId 只保留「停留在入口首页」的语义）。
    try {
      localStorage.setItem('claw:lastFocusedRuntimeId', runtimeAgentId);
      localStorage.removeItem('claw:lastFocusedEntryId');
    } catch { /* localStorage 不可用时静默忽略 */ }

    await loadAgentData(runtimeAgentId);
    // Only refresh the agent list if no newer switch has happened — a stale
    // switchAgent continuation could otherwise trigger loadAgentData for the
    // wrong agent via the loadAgents() initialization path.
    if (epoch === _switchEpoch) {
      loadAgents().catch((error) => console.error('Failed to refresh agents after switch:', error));
    }
  } catch (e) {
    console.error('Failed to switch agent:', e);
    window.alert(`Switch failed: ${e && e.message ? e.message : e}`);
  }
};

// ── Context menu action handlers → modules/ctx-menu-handlers.js ──


// ── Data loading → modules/debug-logs.js, debug-mcp.js, agent-data-loader.js ──

// ── Auto session title generation + Choice alerts → modules/auto-title.js (Phase A-3, 2026-07-03) ──

// ── Runtime poll coordinator ───────────────────────────────────────────────
// There must be exactly one owner of the self-scheduling poll loop. Input
// submission paths may request an immediate refresh, but they must not create
// another recursive timer chain.
let _pollTimerId = null;
let _pollCycleInFlight = null;
let _pollImmediateRequested = false;

function schedulePoll(delayMs = POLL_FAST_INTERVAL_MS) {
  if (_pollTimerId !== null) {
    clearTimeout(_pollTimerId);
  }
  _pollTimerId = setTimeout(() => {
    _pollTimerId = null;
    poll();
  }, Math.max(0, Number(delayMs) || 0));
}

async function poll() {
  if (_pollCycleInFlight) {
    _pollImmediateRequested = true;
    return _pollCycleInFlight;
  }

  if (_pollTimerId !== null) {
    clearTimeout(_pollTimerId);
    _pollTimerId = null;
  }

  const cycle = runPollCycle();
  _pollCycleInFlight = cycle;
  try {
    return await cycle;
  } finally {
    if (_pollCycleInFlight === cycle) {
      _pollCycleInFlight = null;
    }
    if (_pollImmediateRequested) {
      _pollImmediateRequested = false;
      schedulePoll(0);
    }
  }
}

// Exposed for feature panel toggle: after IPC tool-state change, trigger a
// delayed poll so inspector refreshes from the agent subprocess.
window._scheduleInspectorRefresh = function (delayMs) {
  schedulePoll(delayMs || 300);
};

async function runPollCycle() {
  try {
    if (prebuiltSessionSwitchInFlight) {
      schedulePoll(POLL_FAST_INTERVAL_MS);
      return;
    }

    // 全局 choice 请求提醒（跨所有 agent，不限于当前焦点）
    if (Date.now() - _lastChoiceAlertCheckAt > 3000) {
      _lastChoiceAlertCheckAt = Date.now();
      checkGlobalChoiceAlerts().catch(e => console.warn(e));
    }

    // 定期检查并重新加载 Feature 模板映射（如果为空）
    if (Object.keys(FEATURE_TEMPLATE_MAP).length === 0 && Date.now() - lastFeatureTemplateReloadAt > 3000) {
      lastFeatureTemplateReloadAt = Date.now();
      await reloadFeatureTemplateMap();
    }

    if (!currentRuntimeAgentId) {
      applySessionViewPatch({ connected: true });
      updateNotificationStatus(null);
      await loadAgents();
      await refreshAgentCallStates(allAgents);
      // Incrementally refresh workspace session data when viewing workspace surface.
      if (Date.now() - (window._lastWsSessionRefreshAt || 0) > 3000) {
        const wsHostAgent = allAgents.find((a) => a.id === focusedAgentId && isWorkspaceHostUnit(a));
        if (wsHostAgent && loadedAgentDetailIds.has(wsHostAgent.id)) {
          window._lastWsSessionRefreshAt = Date.now();
          try {
            const freshRes = await fetch('/protoclaw/prebuilt_sessions?agentId=' + encodeURIComponent(wsHostAgent.id));
            if (freshRes.ok) {
              const freshSessions = await freshRes.json();
              // Preserve optimistic archived state (same logic as runtime-connected path)
              const currentWs = wsHostAgent.workspace_sessions;
              if (currentWs && Array.isArray(currentWs.sessions) && Array.isArray(freshSessions.sessions)) {
                const currentById = new Map(currentWs.sessions.map(s => [s.id, s]));
                freshSessions.sessions = freshSessions.sessions.map(s => {
                  const cur = currentById.get(s.id);
                  if (cur && cur.archived === true && s.archived !== true) {
                    return { ...s, archived: true, todo: false };
                  }
                  return s;
                });
              }
              const mergedSessions = typeof mergeWorkspaceSessionSnapshots === 'function'
                ? mergeWorkspaceSessionSnapshots(currentWs, freshSessions, wsHostAgent.id)
                : freshSessions;
              const prevSig = JSON.stringify(currentWs || {});
              const nextSig = JSON.stringify(mergedSessions);
              if (prevSig !== nextSig) {
                wsHostAgent.workspace_sessions = mergedSessions;
                if (typeof shouldRenderWorkspaceSurface === 'function' && shouldRenderWorkspaceSurface(wsHostAgent)) {
                  // 群聊工作空间：避免整个 workspace DOM 重建导致输入框失焦/内容丢失，
                  // 改用轻量刷新（只更新左侧群聊列表）
                  if (wsHostAgent.id === 'work-group' && window.WorkGroupUI?.softRefresh) {
                    window.WorkGroupUI.softRefresh();
                  } else {
                    renderCurrentMainView();
                  }
                } else {
                  // Chat mode: only refresh context bar, avoid full re-render that resets scroll
                  if (typeof updateChatContextBar === 'function') {
                    updateChatContextBar();
                  }
                }
              }
            }
          } catch {}
        }
      }
      schedulePoll(POLL_INTERVAL_MS);
      return;
    }

    // 先单独刷新轻量运行态，再并行请求较重的数据，避免状态栏被慢接口拖住
    const pollToken = captureSessionViewToken();
    const pollRuntimeId = pollToken.runtimeId;
    const statusTask = refreshCurrentRuntimeStatus(pollRuntimeId, pollToken);

    const [msgsRes, inputRes, overviewRes, todoRes] = await Promise.all([
      fetch(`/api/agents/${pollRuntimeId}/messages`),
      fetch(`/api/agents/${pollRuntimeId}/input-requests`),
      fetch(`/api/agents/${pollRuntimeId}/overview`),
      fetch(`/api/agents/${pollRuntimeId}/todo`),
    ]);

    // 如果在 fetch 期间已经切换了 agent，丢弃过时的响应，避免旧数据覆盖新会话
    if (!isSessionViewTokenCurrent(pollToken)) {
      schedulePoll(POLL_FAST_INTERVAL_MS);
      return;
    }

    const coreResponses = [msgsRes, inputRes, overviewRes];
    if (coreResponses.some(res => res.status === 404)) {
      // In-session partial compact doesn't create a new session, so if we get 404
      // while compact is in flight, just clear the flag and fall through to normal handling
      if (_partialCompactInFlight && normalizeAgentIdentity(pollRuntimeId) === normalizeAgentIdentity(_partialCompactRuntimeId)) {
        clearPartialCompactState();
      }
      if (prebuiltSessionSwitchInFlight || suppressSidebarRerender) {
        schedulePoll(POLL_FAST_INTERVAL_MS);
        return;
      }
      const failedRuntimeRecord = getRuntimeRecord(pollRuntimeId);
      const fallbackId = resolveWorkspaceFallbackAgentId(failedRuntimeRecord);
      const failureCommitted = commitSessionViewPatch(
        pollToken,
        fallbackId ? {} : {
          messages: [],
          inputRequests: [],
          todoPlan: getEmptyTodoPlan(),
        },
        ({ current }) => {
          _agentCallActive.delete(pollRuntimeId);
          clearInterruptSuppression(pollRuntimeId);
          if (failedRuntimeRecord) {
            failedRuntimeRecord.callActive = false;
            failedRuntimeRecord.connected = false;
          }
          currentRuntimeAgentId = null;
          if (fallbackId) {
            selectWorkspaceSurface(fallbackId, { skipFeaturePanel: true });
          } else {
            focusedAgentId = null;
            currentWorkspaceTab = null;
            renderCurrentMainView();
            renderInputRequests(current.inputRequests);
          }
        },
      );
      if (!failureCommitted) {
        schedulePoll(POLL_FAST_INTERVAL_MS);
        return;
      }
      await loadAgents();
      schedulePoll(POLL_INTERVAL_MS);
      return;
    }

    const data = await msgsRes.json();
    if (!isSessionViewTokenCurrent(pollToken)) {
      schedulePoll(POLL_FAST_INTERVAL_MS);
      return;
    }
    const messages = data.messages || [];

    const messagesCommitted = commitSessionViewPatch(pollToken, { messages }, ({ previous, current }) => {
      // Clear session loading indicator once messages are available
      if (current.messages.length > 0) clearChatLoadingSession();

      // Render messages immediately — before non-critical async ops
      // (status refresh, call states, queue sync) that add visible latency.
      const previousMessages = previous.messages;
      const nextMessages = current.messages;
      markAutoTitleCandidate(previousMessages, nextMessages);
      const firstChangedIndex = findFirstChangedMessageIndex(nextMessages, previousMessages);
      if (nextMessages.length !== previousMessages.length) {
        if (nextMessages.length > previousMessages.length && firstChangedIndex === previousMessages.length) {
          // 有新消息：只追加新的
          const newMessages = nextMessages.slice(previousMessages.length);
          if (shouldRenderWorkspaceSurface()) {
            renderCurrentMainView(current);
          } else {
            appendNewMessages(newMessages, nextMessages.length - newMessages.length);
          }
        } else {
          // 消息减少，或消息变多但前缀已变化：完全重建。
          renderCurrentMainView(current);
        }
      } else {
        if (firstChangedIndex >= 0) {
          // Rollback + partial compact can replace the middle of the transcript while
          // keeping the same length after the summary reminder is inserted.
          if (shouldRenderWorkspaceSurface() || firstChangedIndex < nextMessages.length - 1) {
            renderCurrentMainView(current);
          } else {
            // 最后一条消息变化：替换最后一条（避免滚动重置）
            updateLastMessage(nextMessages[nextMessages.length - 1]);
          }
        }
      }
    });
    if (!messagesCommitted) {
      schedulePoll(POLL_FAST_INTERVAL_MS);
      return;
    }

    await statusTask;
    await refreshAgentCallStates(allAgents);
    const statusUiCommitted = commitSessionViewState(pollToken, () => {
      _syncPersistentActionButton();
      _syncPersistentInputUi(pollRuntimeId);
    });
    if (!statusUiCommitted) {
      schedulePoll(POLL_FAST_INTERVAL_MS);
      return;
    }

    // Parse the lightweight view metadata together and publish it in one
    // synchronous transaction. The transcript remains latency-first above,
    // while usage/todo/input UI never paints a mixed poll generation.
    const [overviewRaw, todoRaw, inputRequestsRaw] = await Promise.all([
      overviewRes.json(),
      todoRes.ok ? todoRes.json() : Promise.resolve(null),
      inputRes.json(),
    ]);
    const nextOverview = normalizeOverviewSnapshot(overviewRaw);
    const nextOverviewSignature = getOverviewSignature(nextOverview);
    const nextTodoPlan = todoRaw === null ? null : normalizeTodoPlan(todoRaw);
    const nextTodoSignature = nextTodoPlan === null ? null : getTodoPlanSignature(nextTodoPlan);
    const inputRequests = Array.isArray(inputRequestsRaw) ? inputRequestsRaw : [];
    const overviewChanged = nextOverviewSignature !== currentOverviewSignature;
    const todoChanged = nextTodoPlan !== null && nextTodoSignature !== currentTodoPlanSignature;
    const inputChanged = JSON.stringify(inputRequests) !== JSON.stringify(window.lastInputRequests || []);
    const metadataPatch = {};
    if (overviewChanged) metadataPatch.overview = nextOverview;
    if (todoChanged) metadataPatch.todoPlan = nextTodoPlan;
    if (inputChanged) metadataPatch.inputRequests = inputRequests;
    const metadataCommitted = commitSessionViewPatch(pollToken, metadataPatch, ({ current }) => {

      // 当目标任务进入终态时，自动清除中断标记
      let interruptCleared = false;
      let interruptSynced = false;
      if (nextTodoPlan !== null) {
        const currentInterruptTarget = getInterruptTargetId();
        if (currentInterruptTarget) {
          const target = nextTodoPlan.tasks.find(tk => tk.id === currentInterruptTarget);
          if (target && (target.status === 'completed' || target.status === 'deleted')) {
            setInterruptTargetId(null);
            interruptCleared = true;
          }
        }

        // 从 server 同步 interruptTargetId 到本地缓存。
        // 仅在用户最近未手动操作时同步（避免覆盖乐观更新）。
        const userActionGraceExpired = (Date.now() - _lastInterruptUserActionAt) > 3000;
        if (userActionGraceExpired) {
          const serverTarget = nextTodoPlan.interruptTargetId || null;
          if (serverTarget !== currentInterruptTarget) {
            setInterruptTargetId(serverTarget);
            interruptSynced = true;
          }
        }

        // 从 server 同步"任务未完自动继续"开关到本地缓存（同样遵循用户操作宽限期）。
        if ((Date.now() - _lastTodoForceContinueUserActionAt) > 3000) {
          const serverForceContinue = nextTodoPlan.forceContinue?.enabled === true;
          if (serverForceContinue !== getTodoForceContinue()) {
            setTodoForceContinue(serverForceContinue);
          }
        }
      }

      // All logical values are assigned before any renderer observes them.
      if (overviewChanged) {
        if (activeFeaturePanel === 'workspace') {
          renderFeaturePanel();
        }
        if (typeof updateChatContextBar === 'function') {
          updateChatContextBar(current);
        }
      }
      if (todoChanged) {
        if (activeFeaturePanel === 'plan') {
          renderFeaturePanel();
        }
        updatePlanBadge();
      } else if ((interruptCleared || interruptSynced) && activeFeaturePanel === 'plan') {
        renderFeaturePanel();
      }

      // If partial compact was in flight but runtime is back to accepting input,
      // compact is done (or failed) — clear the flag so normal input is shown.
      if (
        _partialCompactInFlight
        && normalizeAgentIdentity(pollRuntimeId) === normalizeAgentIdentity(_partialCompactRuntimeId)
        && inputRequests.length > 0
      ) {
        clearPartialCompactState();
      }
      if (inputChanged) {
        renderInputRequests(current.inputRequests);
        updateRollbackActionVisibility();
      } else if (isChatSurfaceActive()) {
        _syncPersistentInputUi(pollRuntimeId);
      }
    });
    if (!metadataCommitted) {
      schedulePoll(POLL_FAST_INTERVAL_MS);
      return;
    }

    // Generate only after this session's first assistant response was newly observed and completed.
    commitSessionViewState(pollToken, () => {
      if (!isRuntimeCalling(pollRuntimeId)) {
        tryAutoTitleGeneration(currentMessages);
      }
    });

    // Refresh the Claw-composed agent list occasionally.
    // Do not overwrite `allAgents` with the raw viewer session list,
    // otherwise prebuilt/managed grouping disappears.
     if (Date.now() - lastAgentListRefreshAt > 3000) {
        lastAgentListRefreshAt = Date.now();
        await loadAgents();
        if (!isSessionViewTokenCurrent(pollToken)) {
          schedulePoll(POLL_FAST_INTERVAL_MS);
          return;
        }
        if (typeof updateChatContextBar === 'function') {
          updateChatContextBar();
        }
        if (typeof updateInputModelSwitcher === 'function') {
          updateInputModelSwitcher();
        }
        if (typeof updateThinkingEffortSwitcher === 'function') {
          updateThinkingEffortSwitcher();
        }
     }

    // Incrementally refresh workspace session data for the active workspace host.
    // This keeps the UI in sync when sessions are created/deleted via CLI.
    if (Date.now() - (window._lastWsSessionRefreshAt || 0) > 3000) {
      const wsHostAgent = allAgents.find((a) => a.id === focusedAgentId && isWorkspaceHostUnit(a));
      if (wsHostAgent && loadedAgentDetailIds.has(wsHostAgent.id)) {
        window._lastWsSessionRefreshAt = Date.now();
        try {
          const freshRes = await fetch('/protoclaw/prebuilt_sessions?agentId=' + encodeURIComponent(wsHostAgent.id));
          if (freshRes.ok) {
            const freshSessions = await freshRes.json();
            if (!isSessionViewTokenCurrent(pollToken)) {
              schedulePoll(POLL_FAST_INTERVAL_MS);
              return;
            }
            // Preserve optimistic archived state: during compact+archive operations,
            // markSessionArchivedForMutation sets archived=true before the server
            // actually archives (which happens inside compact_and_resume response).
            // Without this, the 3-second refresh would overwrite the optimistic
            // state with the server's not-yet-archived data, causing visual flicker.
            const currentWs = wsHostAgent.workspace_sessions;
            if (currentWs && Array.isArray(currentWs.sessions) && Array.isArray(freshSessions.sessions)) {
              const currentById = new Map(currentWs.sessions.map(s => [s.id, s]));
              freshSessions.sessions = freshSessions.sessions.map(s => {
                const cur = currentById.get(s.id);
                if (cur && cur.archived === true && s.archived !== true) {
                  return { ...s, archived: true, todo: false };
                }
                return s;
              });
            }
            const prevSig = JSON.stringify(currentWs || {});
            const nextSig = JSON.stringify(freshSessions);
            if (prevSig !== nextSig) {
              // Preserve contextLength/compressRatio when the fresh data from
              // listPrebuiltSessions returns null (e.g. resolveSessionModelInfo
              // couldn't resolve a preset). Without this, the 3-second refresh
              // would wipe out previously valid model info and cause the context
              // bar to flash defaults.
              const prevCl = currentWs?.contextLength;
              const prevCr = currentWs?.compressRatio;
              if (Number.isFinite(prevCl) && prevCl > 0
                  && !(Number.isFinite(freshSessions.contextLength) && freshSessions.contextLength > 0)) {
                freshSessions.contextLength = prevCl;
              }
              if (Number.isFinite(prevCr) && prevCr > 0 && prevCr <= 100
                  && !(Number.isFinite(freshSessions.compressRatio) && freshSessions.compressRatio > 0)) {
                freshSessions.compressRatio = prevCr;
              }
              wsHostAgent.workspace_sessions = typeof mergeWorkspaceSessionSnapshots === 'function'
                ? mergeWorkspaceSessionSnapshots(currentWs, freshSessions, wsHostAgent.id)
                : freshSessions;
              if (typeof shouldRenderWorkspaceSurface === 'function' && shouldRenderWorkspaceSurface(wsHostAgent)) {
                renderCurrentMainView();
              } else {
                // Chat mode: only refresh context bar, avoid full re-render that resets scroll
                if (typeof updateChatContextBar === 'function') {
                  updateChatContextBar();
                }
              }
            }
          }
        } catch {}
      }
    }

    if (activeFeaturePanel) {
      if (activeFeaturePanel === 'logs') {
        await loadLogs();
      } else if (activeFeaturePanel !== 'resources' && activeFeaturePanel !== 'viewer' && activeFeaturePanel !== 'settings' && activeFeaturePanel !== 'plan' && activeFeaturePanel !== 'session-controls') {
        // resources/viewer 面板数据独立管理，不需要 hooks 数据，跳过以避免无谓渲染
        // session-controls 面板状态由模块自身的请求-应答链路维护，轮询重渲染会打断开关交互
        const hooksRes = await fetch(`/api/agents/${pollRuntimeId}/hooks`);
        const nextHookInspector = normalizeHookInspector(await hooksRes.json());
        const nextSignature = getHookInspectorSignature(nextHookInspector);
        const hookInspectorChanged = nextSignature !== currentHookInspectorSignature;
        const hooksCommitted = commitSessionViewPatch(
          pollToken,
          hookInspectorChanged ? { hookInspector: nextHookInspector } : {},
          () => {
            if (hookInspectorChanged) {
              renderFeaturePanel();
            }
          },
        );
        if (!hooksCommitted) {
          schedulePoll(POLL_FAST_INTERVAL_MS);
          return;
        }
      }
    }

    const finalStateCommitted = commitSessionViewState(pollToken, () => {
      // Write-through: keep cache fresh so switching back is instant.
      // Cache capture and recap tracking observe one synchronous view state.
      saveCurrentRuntimeToCache(pollRuntimeId);
      _trackRecapSessionPresence();
    });
    if (!finalStateCommitted) {
      schedulePoll(POLL_FAST_INTERVAL_MS);
      return;
    }

  } catch (e) {
    console.warn('Polling failed, keeping last known connection state:', e);
    schedulePoll(POLL_INTERVAL_MS);
    return;
  }
  schedulePoll(POLL_FAST_INTERVAL_MS);
}
// ── Input request rendering → modules/input-render.js ──


// ── Persistent Input (常驻输入框/队列) → modules/persistent-input.js (Phase B-4, 2026-07-04) ──

// ── Choice Input 卡片交互 → modules/choice-input.js (Phase A-2, 2026-07-03) ──

// ── Input helpers (rollback/process/submit) → modules/input-helpers.js (Phase B-5, 2026-07-04) ──

// ── Partial Compact / Rollback Dialog → modules/rollback-dialog.js (Phase A-6, 2026-07-03) ──

// ── Chat Message Rendering → modules/chat-renderer.js (Phase D, 2026-07-05) ──

// ── Voice Input / ASR → modules/voice-input.js (Phase A-1, 2026-07-03) ──

// _getSessionInputCacheKey retained here — shared by many domains (poll, renderInputRequests, etc.)
// Use the same immutable runtime-context identity as rendering and optimistic data.
function _getSessionInputCacheKey() {
  return getRuntimeContextKey();
}

applyTheme(currentTheme);
applyLanguage();

// When the page returns to foreground after being in a background tab,
// browser timer throttling may have caused us to miss state transitions.
// Force a full refresh to catch up.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  // Re-sync all agent calling states immediately
  refreshAgentCallStates(allAgents, { force: true });
  // Re-sync current runtime's notification status (button, status bar)
  if (currentRuntimeAgentId) {
    refreshCurrentRuntimeStatus(currentRuntimeAgentId);
  }
});

(async () => {
  await waitForViewerReady();
  const success = await loadFeatureTemplateMap();
  await loadAgents();
  if (!success) {
    console.log('[Viewer] Retrying to load feature templates after agent loaded...');
    await reloadFeatureTemplateMap();
  }
  await loadMcpInfo(false);
  poll();
})();
