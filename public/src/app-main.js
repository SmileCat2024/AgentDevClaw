function getCurrentSessionHostAgentId() {
  return normalizeAgentIdentity(getCurrentHostAgentRecord()?.id || focusedAgentId);
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

// 视图绑定会话自身的标题（会话列表事实，不随 runtime 生命周期漂移）：
// 顶栏标题兜底链优先于此，避免落到宿主 active（跨会话共享可变状态，
// 接续退役窗口会串成另一个会话的标题）。
function _titleForBoundSession() {
  try {
    const runtimeId = normalizeAgentIdentity(currentRuntimeAgentId);
    const hostRecord = getCurrentHostAgentRecord();
    // 绑定会话解析：viewer 绑定优先；接续退役窗口 runtime 态被清时回退
    // activeConversation（视图身份仍指向线程会话，这是「等待重绑」不是离开）。
    const fallbackSessionId = normalizeAgentIdentity(window.ClawThreads?.activeConversation?.sessionId);
    const sessionId = (runtimeId && typeof getRuntimeWorkspaceSessionId === 'function'
      ? String(getRuntimeWorkspaceSessionId(runtimeId) || '').trim() : '')
      || (hostRecord && fallbackSessionId && normalizeAgentIdentity(window.ClawThreads?.activeConversation?.agentId) === normalizeAgentIdentity(hostRecord.id)
        ? fallbackSessionId
        : '');
    if (!hostRecord || !sessionId) return '';
    const sessions = Array.isArray(hostRecord.workspace_sessions?.sessions)
      ? hostRecord.workspace_sessions.sessions : [];
    const record = sessions.find((s) => normalizeAgentIdentity(s?.id) === sessionId);
    if (record?.title) return String(record.title).trim();
    // 线程宿主 APP（coder）的会话可能不在轻量会话切片（如接续退役窗口
    // 内索引尚未更新）：线程事实兜底——head 会话标题（threads wire 字段），
    // 不落宿主名（历史症状：顶栏串成 'coder'）。
    const thread = typeof window.getThreadForSession === 'function'
      ? window.getThreadForSession(hostRecord.id, sessionId) : null;
    return String(thread?.headSessionTitle || '').trim();
  } catch {
    return '';
  }
}

function getCurrentVisualAgentTitle() {
  const runtimeRecord = getCurrentRuntimeRecord();
  const hostRecord = getCurrentHostAgentRecord();
  if (runtimeRecord && normalizeAgentIdentity(currentRuntimeAgentId)) {
    return runtimeRecord.active_workspace_display_name
      || runtimeRecord.active_workspace_agent_name
      || runtimeRecord.active_workspace_session_title
      || runtimeRecord.name
      || _titleForBoundSession()
      || hostRecord?.active_workspace_display_name
      || hostRecord?.active_workspace_session_title
      || hostRecord?.name
      || currentRuntimeAgentId;
  }
  // 远程回退（T21-E）：本地 record 链全部落空且焦点是远程命名空间身份时，
  // 标题取目录条目回退链（sessionTitle → name）。按运行时引用查询（R3 裁决）：
  // 目录条目身份挂在 entry.runtimeId / entry.id 上，运行时引用才是条目匹配键，
  // 与 title popup 的查询键保持同源。标题跟随由 catalog 4s 轮询
  // （refreshRemoteCatalog → renderAgentList → updateCurrentAgentChrome）
  // 自然带动，不新增轮询。
  const focusedId = normalizeAgentIdentity(focusedAgentId) || normalizeAgentIdentity(currentRuntimeAgentId);
  if (typeof isRemoteNamespaceAgentId === 'function' && isRemoteNamespaceAgentId(focusedId)) {
    const runtimeRef = normalizeAgentIdentity(currentRuntimeAgentId);
    const runtimeTitle = runtimeRef
      ? (window.RemoteConnections?.getEntrySessionTitle?.(runtimeRef) || '')
      : '';
    if (runtimeTitle) return runtimeTitle;
  }
  return _titleForBoundSession() || hostRecord?.name || t('page_title');
}

function updateCurrentAgentChrome() {
  if (!currentAgentTitle) return;
  const hasSelection = normalizeAgentIdentity(focusedAgentId) || normalizeAgentIdentity(currentRuntimeAgentId);
  if (!hasSelection) {
    currentAgentTitle.textContent = t('page_title');
    return;
  }
  currentAgentTitle.textContent = getCurrentVisualAgentTitle();
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
  // 接续等待表面：视图挂在具体等待会话（占位条目高亮），宿主 APP 节点
  // 让位——与 runtime 态下 prebuilt 宿主让位给会话条目同构。
  const awaitTarget = typeof window.getActiveThreadInputTarget === 'function'
    ? window.getActiveThreadInputTarget()
    : null;
  if (awaitTarget && agent?.source === 'prebuilt'
    && agentId === normalizeAgentIdentity(awaitTarget.agentId)) {
    return false;
  }
  return agentId === hostId;
}

function getCurrentAgentRecord() {
  return getCurrentHostAgentRecord();
}

/**
 * APP 侧栏可见性（ADR-0025）：服务端合流作者默认、用户覆盖与有无存活且
 * 绑定 Session 的 Runtime，wire 以
 * sidebarVisible 下发，前端纯消费。persistent 直显。本机不保留任何粘性
 * 记忆：入口消失后的找回路径是设置 → 工作空间的「始终显示」。
 */
function isPrebuiltAppVisible(agent) {
  if (agent.visibility !== 'on-demand') return true;
  return agent.sidebarVisible === true;
}

/**
 * host 相邻排序（ADR-0025）：声明 host 的 APP 紧随其宿主之后（如 Coder
 * 紧随智能编码空间），表达同域绑定。宿主缺席或自身已隐藏时保持原序。
 * hosted 先于宿主出现在列表时（如字母序 coder < programming-helper 的
 * wire 顺序）必须等宿主落位再挂，不得按输入顺序直出。
 */
function orderPrebuiltByHost(list) {
  const result = [];
  const taken = new Set();
  const idsInList = new Set(list.map((agent) => String(agent.id || '').trim()).filter(Boolean));
  for (const agent of list) {
    if (taken.has(agent.id)) continue;
    const hostId = String(agent.host || '').trim();
    // 宿主在本列表且尚未处理：让宿主先落位（本条随后由宿主的内层挂载）
    if (hostId && hostId !== String(agent.id || '').trim() && idsInList.has(hostId) && !taken.has(hostId)) continue;
    result.push(agent);
    taken.add(agent.id);
    for (const hosted of list) {
      if (taken.has(hosted.id)) continue;
      if (String(hosted.host || '').trim() !== String(agent.id || '').trim()) continue;
      result.push(hosted);
      taken.add(hosted.id);
    }
  }
  // 兜底回补：host 链成环（互为宿主）或宿主自身被隐藏时，跳过的条目按
  // 原序直出，绝不丢弃。
  for (const agent of list) {
    if (taken.has(agent.id)) continue;
    result.push(agent);
    taken.add(agent.id);
  }
  return result;
}

function groupConnectedAgents(agents) {
  // 左侧分类使用 sidebarGroup。
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
  const allPrebuilt = orderPrebuiltByHost(
    agents.filter((agent) => agent.source === 'prebuilt' && isPrebuiltAppVisible(agent))
  );
  const prebuiltById = new Map(allPrebuilt.map((agent) => [String(agent.id || '').trim(), agent]));
  // 分组解析：自身声明优先，hosted APP（ADR-0025）跟随宿主分组——「紧随
  // 宿主」的相邻排序必须落在同一分组内才有意义（如 coder 紧随智能编码
  // 空间，同在工具与效率组）；host 链沿 parent 追溯并防环。
  const groupKeyOf = (agent, seen = null) => {
    const group = String(agent.sidebarGroup || '').trim();
    if (group) return group;
    const idKey = String(agent.id || '').trim();
    if (TOOL_AGENT_IDS.has(idKey)) return 'tool';
    if (WORK_GROUP_IDS.has(idKey)) return 'work-group';
    const hostId = String(agent.host || '').trim();
    const host = hostId && prebuiltById.has(hostId) ? prebuiltById.get(hostId) : null;
    if (!host || host === agent) return '';
    const nextSeen = seen || new Set([idKey]);
    if (nextSeen.has(hostId)) return '';
    nextSeen.add(hostId);
    return groupKeyOf(host, nextSeen);
  };
  return {
    prebuilt: allPrebuilt.filter((agent) => {
      const group = groupKeyOf(agent);
      return group !== 'tool' && group !== 'work-group';
    }),
    workGroup: allPrebuilt.filter((agent) => groupKeyOf(agent) === 'work-group'),
    tool: allPrebuilt.filter((agent) => groupKeyOf(agent) === 'tool'),
    external: orphanRuntimeAgents,
  };
}

function isRuntimeItemActive(runtimeId, entry = null) {
  const normalizedRuntimeId = normalizeAgentIdentity(runtimeId);
  if (normalizedRuntimeId === '') return false;
  const normalizedCurrent = normalizeAgentIdentity(currentRuntimeAgentId);
  // 停在 workspace surface 时无选中运行时。此时不做兜底比较：本地条目
  // resolveRuntimeRef 未命中返回 undefined，归一化后的空串会与空
  // currentRuntimeAgentId 对称相等，导致所有运行中会话被误判为选中态。
  if (normalizedCurrent === '') {
    // 接续等待表面例外（视图身份挂在等待会话，无 runtime 态可比较）：
    // 点击接续占位条目 / 接续退役窗口 404 清空 runtime 态时，高亮按
    // 会话身份对齐——getActiveThreadInputTarget 的一致性校验（宿主匹配
    // + 视图仍挂在该会话）保证只有当前等待会话的条目命中，用户切走后
    // 立即失效，不残留。
    const awaitTarget = typeof window.getActiveThreadInputTarget === 'function'
      ? window.getActiveThreadInputTarget()
      : null;
    const awaitSessionId = String(awaitTarget?.sessionId || '').trim();
    const entrySessionId = String(entry?.sessionId || '').trim();
    // 归属对齐：等待会话的宿主必须就是条目的呈现宿主（ownerId /
    // sidebarEntryId），远程或旁路条目即使 sessionId 巧合相同也不高亮。
    const entryOwnedByAwaitHost = String(entry?.ownerId || '').trim() === String(awaitTarget?.agentId || '').trim()
      || String(entry?.sidebarEntryId || '').trim() === String(awaitTarget?.agentId || '').trim();
    return awaitSessionId !== '' && entryOwnedByAwaitHost && entrySessionId === awaitSessionId;
  }
  if (normalizedCurrent === normalizedRuntimeId) return true;
  // 远程分组条目以命名空间运行时引用渲染，而 currentRuntimeAgentId 持有同一
  // 引用的解析结果（switchAgent 解析后是裸运行时 id）。两者归一化后比较；
  // 反向解析（裸 id → 命名空间引用）不可靠，直接比较原始值即可覆盖。
  const resolved = window.RemoteConnections?.resolveRuntimeRef?.(normalizedRuntimeId);
  return !!resolved && normalizeAgentIdentity(resolved) === normalizedCurrent;
}

function toEpochMs(value) {
  if (!value) return 0;
  if (typeof value === 'number') return value;
  const parsed = Date.parse(value);
  return isNaN(parsed) ? 0 : parsed;
}

function getInputSurfaceMode(requests = readCurrentSessionViewState().inputRequests) {
  // 输入面模式由 chat/runtime/choice 等显示状态决定；普通文本 lease
  // 不参与 composer 形态判定。
  return resolveInputSurfaceMode(readInputSurfaceModeState(requests, isChatSurfaceActive()));
}

// ── Sidebar rendering & agent list → modules/sidebar-render.js ──


function createWorkspaceEntryHost() {
  return {
    bumpNavigationGuard: () => bumpNavigationGuard(),
    closeContextMenu: () => closeAgentContextMenu(),
    findWorkspace: (id) => allAgents.find((agent) => agent.id === id && agent.source === 'prebuilt'),
    isWorkspaceHost: (agent) => isWorkspaceHostUnit(agent),
    isWorkspaceSurface: (agent) => isWorkspaceSurfaceUnit(agent),
    preferHome: (agent) => setPreferredUnitMode('home', agent),
    focus: (id) => { focusedAgentId = id; },
    renderAgents: () => renderAgentList(),
    hasDetail: (id) => loadedAgentDetailIds.has(id),
    markDetailLoaded: (id) => loadedAgentDetailIds.add(id),
    showLoading: () => {
      container.innerHTML = '<div class="workspace-surface" style="display:grid;place-items:center;color:var(--text-secondary);font-size:14px;">' + escapeHtml(currentLanguage === 'zh' ? '加载中...' : 'Loading...') + '</div>';
    },
    loadDetail: (id) => loadAgentDetail(id),
    persistEntry: (id) => { try { localStorage.setItem('claw:lastFocusedEntryId', id); } catch { /* ignore */ } },
    selectWorkspace: (id, options) => selectWorkspaceSurface(id, options),
    switchAgent: (id) => window.switchAgent(id),
    isPending: (id) => pendingPrebuiltAgentIds.has(id),
    markPending: (id) => pendingPrebuiltAgentIds.add(id),
    clearPending: (id) => pendingPrebuiltAgentIds.delete(id),
    navigationEpoch: () => _navigationGuardEpoch,
    startAgent: (id) => invoke('start_agent', { agentId: id }),
    waitRuntime: (id) => waitForPrebuiltRuntimeSession(id),
    requestSwitch: (id, source) => requestSwitch(id, source),
    error: (...args) => console.error(...args),
    showStartError: (error) => showAgentStartError(error),
  };
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

// ── 幂等键（ADR-0011）：写类提交统一携带（本地忽略、远程强制）───────────
function newIdempotencyKey() {
  const cryptoObj = (typeof crypto !== 'undefined') ? crypto : null;
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    return cryptoObj.randomUUID();
  }
  return `key-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function createCompactResumeHost() {
  return {
    isRemote: (id) => typeof isRemoteNamespaceAgentId === 'function' && isRemoteNamespaceAgentId(id),
    remote: () => window.RemoteConnections,
    createOperationId: (reason) => createSidebarOperationId(reason),
    now: () => sidebarDiagnosticNow(),
    observe: (id) => beginSidebarOperationMainThreadObservation(id),
    checkpoint: (...args) => recordSidebarOperationCheckpoint(...args),
    fetch: (...args) => fetch(...args),
    idempotencyKey: () => newIdempotencyKey(),
    refreshThreads: () => { if (typeof window.refreshThreads === 'function') window.refreshThreads(true).catch(() => {}); },
  };
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
function createWorkspaceSessionNavigationHost() {
  return {
    bumpNavigationGuard: () => bumpNavigationGuard(),
    navigationEpoch: () => _navigationGuardEpoch,
    focusedAgentId: () => focusedAgentId,
    runtimeId: () => currentRuntimeAgentId,
    readOnlyMode: () => readOnlyMode,
    findWorkspace: (id) => allAgents.find((agent) => agent.id === id && agent.source === 'prebuilt'),
    saveWorkspaceScroll: () => { if (typeof saveCurrentWorkspaceSurfaceScroll === 'function') saveCurrentWorkspaceSurfaceScroll(); },
    saveCache: (id, key) => saveCurrentRuntimeToCache(id, key),
    contextKey: (id) => getRuntimeContextKey(id),
    selectLoading: (agentId) => {
      focusedAgentId = agentId;
      currentRuntimeAgentId = null;
      applySessionViewPatch({ identity: { agentId, sessionId: '' } });
      readOnlyMode = false;
      currentWorkspaceArtifactDetail = null;
      currentWorkspaceDocsetDetail = null;
      currentProjectDocsetOpen = false;
      currentProjectRequirementEdit = null;
      currentWorkspaceTab = 'chat';
      _lastRenderedChatSig = '';
      resetRuntimeBackedSurfaceState();
      renderAgentList();
      container.innerHTML = '<div class="workspace-surface" style="display:grid;place-items:center;color:var(--text-secondary);font-size:14px;">' + escapeHtml(currentLanguage === 'zh' ? '加载中...' : 'Loading...') + '</div>';
    },
    loadDetail: (id) => window.loadAgentDetail(id),
    runAction: (action) => window.runWorkspaceAction(action),
    preferHome: (agent) => setPreferredUnitMode('home', agent),
    render: () => renderCurrentMainView(),
  };
}

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


// Synchronous UI dependencies for the ESM runtime switching transaction.
function createRuntimeSwitchHost() {
  return {
    state: {
      get pendingSwitchTarget() { return pendingSwitchTarget; },
      set pendingSwitchTarget(value) { pendingSwitchTarget = value; },
      get pendingSwitchSerial() { return pendingSwitchSerial; },
      set pendingSwitchSerial(value) { pendingSwitchSerial = value; },
      get navigationEpoch() { return _navigationGuardEpoch; },
      get switchEpoch() { return _switchEpoch; },
      set switchEpoch(value) { _switchEpoch = value; },
      get focusedAgentId() { return focusedAgentId; },
      set focusedAgentId(value) { focusedAgentId = value; },
      get runtimeId() { return currentRuntimeAgentId; },
      set runtimeId(value) { currentRuntimeAgentId = value; },
      get readOnlyMode() { return readOnlyMode; },
      set readOnlyMode(value) { readOnlyMode = value; },
      get lastRenderedWorkspaceHtml() { return lastRenderedWorkspaceHtml; },
      set lastRenderedWorkspaceHtml(value) { lastRenderedWorkspaceHtml = value; },
      get followLatest() { return followLatestEnabled; },
      get restoredScrollTop() { return _restoredScrollTop; },
      set restoredScrollTop(value) { _restoredScrollTop = value; },
    },
    switchAgent: (id) => window.switchAgent(id),
    setTimeout: (callback, delay) => setTimeout(callback, delay),
    hasPendingNavigation: (agent) => typeof hasPendingSessionNavigation === 'function' && hasPendingSessionNavigation(agent),
    bumpNavigationGuard: () => bumpNavigationGuard(),
    closeContextMenu: () => closeAgentContextMenu(),
    findAgent: (id) => findAgentByIdentity(id),
    isWorkspaceHost: (agent) => isWorkspaceHostUnit(agent),
    runtimeId: (agent) => getRuntimeId(agent),
    agentRuntimeId: (agent) => getAgentRuntimeId(agent),
    isRemote: (id) => isRemoteNamespaceAgentId(id),
    remote: () => window.RemoteConnections,
    closeReadOnlySession: () => {
      if (typeof window.getReadOnlySessionTarget === 'function' && window.getReadOnlySessionTarget()
        && typeof window.closeReadOnlySession === 'function') window.closeReadOnlySession();
    },
    isWorkspaceSurface: (agent) => isWorkspaceSurfaceUnit(agent),
    selectWorkspace: (id, options) => selectWorkspaceSurface(id, options),
    storeDraft: () => _storeVisibleSessionInputDraft(),
    saveWorkspaceScroll: () => { if (typeof saveCurrentWorkspaceSurfaceScroll === 'function') saveCurrentWorkspaceSurfaceScroll(); },
    saveCache: (id) => saveCurrentRuntimeToCache(id),
    logicalId: (agent) => getLogicalAgentId(agent),
    normalize: (id) => normalizeAgentIdentity(id),
    clearFinished: (id) => _recentlyFinishedRuntimes.delete(id),
    deriveSession: (id) => _deriveRuntimeSessionIdFromAgents(id),
    bindSession: (id, session) => setViewerSessionBinding(id, session),
    updateThreadIndicators: () => {
      if (typeof _syncActiveThreadSubscription === 'function') _syncActiveThreadSubscription();
      if (typeof window.updateThreadHeaderIndicator === 'function') window.updateThreadHeaderIndicator();
      if (typeof window.updateQueueIndicator === 'function') window.updateQueueIndicator();
    },
    browseOnly: () => window.ClawThreads?.browseOnly === true,
    resetSurface: () => {
      currentWorkspaceArtifactDetail = null;
      currentWorkspaceDocsetDetail = null;
      currentProjectDocsetOpen = false;
      currentProjectRequirementEdit = null;
      currentProjectDocsetPage = 'requirement';
      currentWorkspaceTab = 'chat';
      _lastRenderedChatSig = '';
    },
    resetScroll: () => {
      setPendingChatScrollRestore(null);
      if (typeof setPendingChatViewportAnchor === 'function') setPendingChatViewportAnchor(null);
      showChatProcess = false;
    },
    resetStatus: () => resetRuntimeStatusForSwitch(),
    activateCollapse: (key) => activateUserCollapseStateForContext(key),
    contextKey: (id) => getRuntimeContextKey(id),
    restoreCache: (id) => restoreRuntimeFromCache(id),
    setPendingScroll: (top) => setPendingChatScrollRestore(top),
    render: () => renderCurrentMainView(),
    renderPanel: () => renderFeaturePanel(),
    patch: (patch) => applySessionViewPatch(patch),
    emptyOverview: () => getEmptyOverviewSnapshot(),
    emptyTodo: () => getEmptyTodoPlan(),
    setFollowLatest: (value) => setFollowLatest(value),
    beginFollowWindows: () => { beginFollowLatestCooldown(); beginFollowLatestEntryWindow(); },
    renderAgents: () => renderAgentList(),
    fetch: (...args) => fetch(...args),
    isCalling: (data) => resolveNotificationCallingState(data),
    applyCalling: (id, calling) => {
      if (calling) { _markAgentCallStartedForNotify(id); _agentCallActive.set(id, true); }
      else _agentCallActive.delete(id);
    },
    syncActionButton: () => _syncPersistentActionButton(),
    persistFocus: (id) => {
      try { localStorage.setItem('claw:lastFocusedRuntimeId', id); localStorage.removeItem('claw:lastFocusedEntryId'); }
      catch { /* localStorage may be unavailable. */ }
    },
    loadData: (id) => loadAgentData(id),
    loadAgents: () => loadAgents(),
    clearLoading: () => clearChatLoadingSession(),
    warn: (...args) => console.warn(...args),
    error: (...args) => console.error(...args),
    alert: (message) => window.alert(message),
  };
}

// ── Context menu action handlers → modules/ctx-menu-handlers.js ──


// ── Data loading → modules/debug-logs.js, debug-mcp.js, agent-data-loader.js ──

// ── Auto session title generation + Choice alerts → modules/auto-title.js (Phase A-3, 2026-07-03) ──

// ── Runtime poll coordinator ───────────────────────────────────────────────
// There must be exactly one owner of the self-scheduling poll loop. Input
// submission paths may request an immediate refresh, but they must not create
// another recursive timer chain.
function createPollCoordinatorHost() {
  return {
    run: () => runPollCycle(),
    fastInterval: () => POLL_FAST_INTERVAL_MS,
    setTimeout: (callback, delay) => setTimeout(callback, delay),
    clearTimeout: (id) => clearTimeout(id),
  };
}
// Message sequence baselines now belong to message-probe.js (poll/SSE shared).

// Workspace revision baselines and refresh logic live in poll-maintenance.js.

// schedulePoll is provided by poll-coordinator-host.js after static ESM init.

// 发送成功等交互关键路径请求立即取数：poll() 自带 in-flight 合并（周期
// 在飞时记 _pollImmediateRequested，结束后 schedulePoll(0) 兜底），直接调
// 用即可，不会产生第二条递归定时链。
window.ClawFW = window.ClawFW || {};
window.ClawFW.requestImmediatePoll = function () {
  poll();
};

// ── SSE 全量对账钩子（§6.5 兜底闭环）────────────────────────────────
// 看门狗静默 30s、resync 帧（服务端重启 eid 归零 / 缓冲超界）、UDS 重连
// （connection{reconnected:true}）都经此触发一轮完整轮询：poll 的 SSE 分支
// 不拉 notification 等状态端点，对账能力只在全量形态存在。
let _forceFullPollNextCycle = false;
window.ClawFW.forceFullPollOnce = function () {
  _forceFullPollNextCycle = true;
  poll();
};

// ── dev 计量（ADR-0012，默认关闭）──────────────────────────────────────────
// URL 带 ?msg_metrics=1 时，每次消息刷新输出 actualBytes（本周期 /messages
// 数据序列化字节，未发请求为 0）/ fakeFullBytes（假想全量字节，随 probe 下发）/
// savedRatio / changeKind / downgraded。这份数据是将来评估 SSE 的依据。



// poll and its private scheduling state live in poll-coordinator.js.

// Exposed for feature panel toggle: after IPC tool-state change, trigger a
// delayed poll so inspector refreshes from the agent subprocess.
window._scheduleInspectorRefresh = function (delayMs) {
  schedulePoll(delayMs || 300);
};

// ── poll 与 SSE 事件共用的消费函数（§5.2：事件到达路径与 fetch 路径走同一实现）──

function createRuntimeNotFoundHost() {
  return {
    isCurrent: (token) => isSessionViewTokenCurrent(token),
    clearCompact: (id) => {
      if (_partialCompactInFlight && normalizeAgentIdentity(id) === normalizeAgentIdentity(_partialCompactRuntimeId)) clearPartialCompactState();
    },
    switching: () => prebuiltSessionSwitchInFlight || suppressSidebarRerender,
    schedule: (delay) => schedulePoll(delay),
    fastInterval: () => POLL_FAST_INTERVAL_MS,
    interval: () => POLL_INTERVAL_MS,
    sessionId: (id) => typeof getRuntimeWorkspaceSessionId === 'function' ? getRuntimeWorkspaceSessionId(id) : '',
    hostRecord: () => typeof getCurrentHostAgentRecord === 'function' ? getCurrentHostAgentRecord() : null,
    thread: (id, session) => typeof window.getThreadForSession === 'function' ? window.getThreadForSession(id, session) : null,
    canRefreshThreads: () => typeof window.refreshThreads === 'function',
    refreshThreads: (force) => window.refreshThreads(force),
    activeConversation: () => window.ClawThreads?.activeConversation || null,
    runtimeRecord: (id) => getRuntimeRecord(id),
    fallback: (record) => resolveWorkspaceFallbackAgentId(record),
    patch: (token, patch, effect) => commitSessionViewPatch(token, patch, effect),
    emptyTodo: () => getEmptyTodoPlan(),
    clearView: (id, failed, fallback) => {
      _agentCallActive.delete(id);
      clearInterruptSuppression(id);
      if (failed) { failed.callActive = false; failed.connected = false; }
      currentRuntimeAgentId = null;
      if (fallback) selectWorkspaceSurface(fallback, { skipFeaturePanel: true });
      else { focusedAgentId = null; currentWorkspaceTab = null; renderCurrentMainView(); }
    },
    loadAgents: () => loadAgents(),
  };
}

// Classic rendering dependencies for the shared ESM poll/SSE message probe.
function createMessageProbeHost(createRenderer, createMetrics, bytes) {
  return {
    messages: () => currentMessages,
    isCurrent: (token) => isSessionViewTokenCurrent(token),
    commit: (token, patch, effect) => commitSessionViewPatch(token, patch, effect),
    fetch: (url) => fetch(url),
    attachTimestamps: (messages, timestamps) => attachMessagesTimestamps(messages, timestamps),
    bytes,
    metrics: createMetrics({
      search: () => String((window.location && window.location.search) || ''),
      debug: (...args) => console.debug(...args),
    }),
    render: createRenderer(createCommittedViewRendererHost()).renderMessages,
  };
}

// Narrow UI adapter; selection and update policy live in the ESM renderer.
function createCommittedViewRendererHost() {
  return {
    clearLoading: () => clearChatLoadingSession(),
    // ADR-0041: this legacy title trigger is intentionally a no-op.
    markTitle: (previous, next) => markAutoTitleCandidate(previous, next),
    firstChanged: (next, previous) => findFirstChangedMessageIndex(next, previous),
    workspaceSurface: () => shouldRenderWorkspaceSurface(),
    render: (current) => renderCurrentMainView(current),
    append: (messages, offset) => appendNewMessages(messages, offset),
    updateLast: (message) => updateLastMessage(message),
    reconcile: (messages) => {
      if (typeof window.ClawFW?.reconcileOptimisticUserEchoes === 'function') window.ClawFW.reconcileOptimisticUserEchoes(messages);
    },
    panel: () => activeFeaturePanel,
    renderPanel: () => renderFeaturePanel(),
    updateContext: (current) => { if (typeof updateChatContextBar === 'function') updateChatContextBar(current); },
    updateModel: () => { if (typeof updateInputModelSwitcher === 'function') updateInputModelSwitcher(); },
    updateThinking: () => { if (typeof updateThinkingEffortSwitcher === 'function') updateThinkingEffortSwitcher(); },
    updatePlanBadge: () => updatePlanBadge(),
    clearCompletedCompact: (token, requests) => {
      if (_partialCompactInFlight && normalizeAgentIdentity(token.runtimeId) === normalizeAgentIdentity(_partialCompactRuntimeId)
        && requests && requests.length > 0) clearPartialCompactState();
    },
    updateRollback: () => updateRollbackActionVisibility(),
    chatSurface: () => isChatSurfaceActive(),
    syncInput: (id) => _syncPersistentInputUi(id),
  };
}

// Remaining classic normalization and UI dependencies for ESM metadata commits.
function createMetadataCommitHost(createRenderer) {
  return {
    inputCurrent: (token) => isSessionViewInputRequestsCurrent(token),
    commit: (token, patch, effect) => commitSessionViewPatch(token, patch, effect),
    normalizeOverview: (value) => normalizeOverviewSnapshot(value),
    overviewSignature: (value) => getOverviewSignature(value),
    normalizeTodo: (value) => normalizeTodoPlan(value),
    todoSignature: (value) => getTodoPlanSignature(value),
    currentOverviewSignature: () => currentOverviewSignature,
    currentTodoSignature: () => currentTodoPlanSignature,
    inputRequests: () => currentInputRequests,
    interruptTarget: () => getInterruptTargetId(),
    setInterruptTarget: (value) => setInterruptTargetId(value),
    now: () => Date.now(),
    lastInterruptAction: () => _lastInterruptUserActionAt,
    render: createRenderer(createCommittedViewRendererHost()).renderMetadata,
  };
}

function createPollMaintenanceHost() {
  return {
    agents: () => allAgents,
    focused: () => focusedAgentId,
    now: () => Date.now(),
    isPh: (record) => typeof isPhStyleWorkspaceAgent === 'function' && isPhStyleWorkspaceAgent(record),
    browsingTarget: (record) => typeof getPhBrowsingTarget === 'function' ? getPhBrowsingTarget(record) : null,
    workspaceState: (record) => typeof getAgentWorkspaceState === 'function' ? getAgentWorkspaceState(record) : null,
    fetch: (url) => fetch(url),
    isWorkspace: (record) => isWorkspaceHostUnit(record),
    detailLoaded: (id) => loadedAgentDetailIds.has(id),
    lastWorkspaceRefresh: () => window._lastWsSessionRefreshAt || 0,
    setWorkspaceRefresh: (value) => { window._lastWsSessionRefreshAt = value; },
    lastAgentRefresh: () => lastAgentListRefreshAt,
    setAgentRefresh: (value) => { lastAgentListRefreshAt = value; },
    sseActive: () => typeof isSseActive === 'function' && isSseActive(),
    loadAgents: () => loadAgents(),
    refreshCalls: (agents) => refreshAgentCallStates(agents),
    isCurrent: (token) => isSessionViewTokenCurrent(token),
    patch: (token, patch, effect) => commitSessionViewPatch(token, patch, effect),
    commit: (token, effect) => commitSessionViewState(token, effect),
    apply: (patch) => applySessionViewPatch(patch),
    notify: (value) => updateNotificationStatus(value),
    merge: (previous, fresh, id) => typeof mergeWorkspaceSessionSnapshots === 'function'
      ? mergeWorkspaceSessionSnapshots(previous, fresh, id) : fresh,
    renderWorkspace: (record, allowSoftRefresh) => {
      if (typeof shouldRenderWorkspaceSurface === 'function' && shouldRenderWorkspaceSurface(record)) {
        if (allowSoftRefresh && record.id === 'work-group' && window.WorkGroupUI?.softRefresh) window.WorkGroupUI.softRefresh();
        else renderCurrentMainView();
      } else if (typeof updateChatContextBar === 'function') updateChatContextBar();
    },
    updateComposer: () => {
      if (typeof updateChatContextBar === 'function') updateChatContextBar();
      if (typeof updateInputModelSwitcher === 'function') updateInputModelSwitcher();
      if (typeof updateThinkingEffortSwitcher === 'function') updateThinkingEffortSwitcher();
    },
    panel: () => activeFeaturePanel,
    loadLogs: () => loadLogs(),
    normalizeHooks: (value) => normalizeHookInspector(value),
    hookSignature: (value) => getHookInspectorSignature(value),
    currentHookSignature: () => currentHookInspectorSignature,
    renderPanel: () => renderFeaturePanel(),
    saveCache: (id) => saveCurrentRuntimeToCache(id),
    trackRecap: () => _trackRecapSessionPresence(),
  };
}

function createRuntimePollHost() {
  return {
    capture: () => captureSessionViewToken(),
    consumeForceFull: () => { const force = _forceFullPollNextCycle; _forceFullPollNextCycle = false; return force; },
    sseActive: () => typeof isSseActive === 'function' && isSseActive(),
    guard: (id, token) => refreshContextGuardStatus(id, token),
    status: (id, token) => refreshCurrentRuntimeStatus(id, token),
    refreshCalls: (agents, options) => refreshAgentCallStates(agents, options),
    agents: () => allAgents,
    commit: (token, effect) => commitSessionViewState(token, effect),
    isCurrent: (token) => isSessionViewTokenCurrent(token),
    syncInput: (id) => { _syncPersistentActionButton(); _syncPersistentInputUi(id); },
    title: (id) => { if (!isRuntimeCalling(id)) tryAutoTitleGeneration(currentMessages); },
    tail: (token) => _runPollTailLowFrequency(token),
    schedule: (delay) => schedulePoll(delay),
    fastInterval: () => POLL_FAST_INTERVAL_MS,
    interval: () => POLL_INTERVAL_MS,
    fetch: (url) => fetch(url),
    notFound: (token) => handleCoreResponsesNotFound(token),
    messages: (token, probe) => runMessagesProbeCycle(token, probe),
    probe: (overview) => typeof extractMessagesProbe === 'function' ? extractMessagesProbe(overview) : null,
    metadata: (token, parts) => commitMetadataUpdate(token, parts),
  };
}

function createPollCycleHost() {
  return {
    switching: () => prebuiltSessionSwitchInFlight,
    schedule: (delay) => schedulePoll(delay),
    fastInterval: () => POLL_FAST_INTERVAL_MS,
    interval: () => POLL_INTERVAL_MS,
    sseActive: () => typeof isSseActive === 'function' && isSseActive(),
    now: () => Date.now(),
    lastChoiceCheck: () => _lastChoiceAlertCheckAt,
    setChoiceCheck: (value) => { _lastChoiceAlertCheckAt = value; },
    checkChoices: () => checkGlobalChoiceAlerts(),
    refreshRemote: () => {
      if (typeof maybeRefreshRemoteCatalog === 'function') maybeRefreshRemoteCatalog();
      if (typeof maybeRefreshRemoteHistory === 'function') maybeRefreshRemoteHistory();
    },
    templates: () => FEATURE_TEMPLATE_MAP,
    lastTemplateReload: () => lastFeatureTemplateReloadAt,
    setTemplateReload: (value) => { lastFeatureTemplateReloadAt = value; },
    reloadTemplates: () => window.reloadFeatureTemplateMap(),
    runtimeId: () => currentRuntimeAgentId,
    noFocus: () => refreshUnfocusedPoll(),
    runtime: () => runRuntimePoll(),
    warn: (...args) => console.warn(...args),
  };
}
// ── Input request rendering → modules/input-render.js ──


// ── Persistent Input (常驻输入框/队列) → modules/persistent-input.js (Phase B-4, 2026-07-04) ──

// ── Choice Input 卡片交互 → modules/choice-input.js (Phase A-2, 2026-07-03) ──

// ── Input helpers (rollback/process/submit) → modules/input-helpers.js (Phase B-5, 2026-07-04) ──

// ── Partial Compact / Rollback Dialog → modules/rollback-dialog.js (Phase A-6, 2026-07-03) ──

// ── Chat Message Rendering → modules/chat-renderer.js (Phase D, 2026-07-05) ──

// ── Voice Input / ASR → modules/voice-input.js (Phase A-1, 2026-07-03) ──

// _getSessionInputCacheKey retained here — shared by many domains (poll, input-render, etc.)
// Use the same immutable runtime-context identity as rendering and optimistic data.
function _getSessionInputCacheKey() {
  // 一致性校验（getActiveThreadInputTarget）：线程键只在当前视图确属该
  // 线程时使用——残留指向不得把别的会话的草稿写进线程键（会话隔离）。
  const threadId = String(window.getActiveThreadInputTarget?.()?.threadId || '').trim();
  return threadId ? `thread:${threadId}` : getRuntimeContextKey();
}

applyTheme(currentTheme);
applyLanguage();

// When the page returns to foreground after being in a background tab,
// browser timer throttling may have caused us to miss state transitions.
// Force a full refresh to catch up.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  // Re-sync all agent calling states immediately（回前台是全量对账路径：
  // SSE 激活时本地条目也参与本轮对账，§5.3 includeSseLocals）
  refreshAgentCallStates(allAgents, { force: true, includeSseLocals: true });
  // Re-sync current runtime's notification status (button, status bar)
  if (currentRuntimeAgentId) {
    refreshCurrentRuntimeStatus(currentRuntimeAgentId);
  }
});

function createApplicationStartupHost() {
  return {
    loadTemplates: () => window.loadFeatureTemplateMap(),
    loadAgents: () => loadAgents(),
    consumeDesktopOpen: async () => { if (window.ClawDesktopOpen) await window.ClawDesktopOpen.consumeBootOpenRequest(); },
    reloadTemplates: () => window.reloadFeatureTemplateMap(),
    loadMcp: (force) => loadMcpInfo(force),
    poll: () => poll(),
    log: (...args) => console.log(...args),
  };
}

(async () => {
  await window.__clawAuthReady;
  await startApplication();
})();
