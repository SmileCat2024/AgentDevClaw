/**
 * Classic adapters for session-data-loader and runtime-status-loader ESM hosts.
 * First-paint state and rendering retain their original synchronous timing;
 * adapters resolve those dependencies only when the async loaders call them.
 */

// First-paint helpers retain classic timing. Async load orchestration is ESM.
function createSessionDataLoaderHost() {
  return {
    isUiOnly: (id) => isUiOnlyAgentId(id),
    setRuntime: (id) => { currentRuntimeAgentId = id; },
    apply: (patch) => applySessionViewPatch(patch),
    capture: (id) => captureSessionViewToken(id),
    isCurrent: (token) => isSessionViewTokenCurrent(token),
    messagesCurrent: (token) => isSessionViewMessagesCurrent(token),
    patch: (...args) => commitSessionViewPatch(...args),
    focused: () => focusedAgentId,
    activePanel: () => activeFeaturePanel,
    fetch: (...args) => fetch(...args),
    notify: (...args) => updateNotificationStatus(...args),
    resetSurface: () => resetRuntimeBackedSurfaceState(),
    render: (...args) => renderCurrentMainView(...args),
    renderPanel: () => renderFeaturePanel(),
    clearTemplates: () => {
      FEATURE_TEMPLATE_MAP = {};
      if (typeof clearFeatureTemplateCache === 'function') clearFeatureTemplateCache();
    },
    loadTemplates: () => window.loadFeatureTemplateMap(),
    refreshBadges: () => {
      if (window.GenUIPanel) window.GenUIPanel.forceRefresh();
      if (window.BgPanel) window.BgPanel.refreshBadge();
    },
    resetRuntimeStatus: () => resetRuntimeStatusForSwitch(),
    activateCollapse: (id) => activateUserCollapseStateForContext(getRuntimeContextKey(id)),
    clearRecap: () => { _currentRecapText = ''; _recapPendingTrigger = false; },
    emptyTodo: () => getEmptyTodoPlan(),
    attachTimestamps: (...args) => attachMessagesTimestamps(...args),
    recheckTitle: () => recheckAutoTitleCandidate(),
    clearLoading: () => clearChatLoadingSession(),
    updateRollback: () => updateRollbackActionVisibility(),
    templateNames: (tools) => collectTemplateNames(tools),
    warmTemplates: (...args) => warmTemplatesInBackground(...args),
    updateContext: (view) => { if (typeof updateChatContextBar === 'function') updateChatContextBar(view); },
    updateModel: () => { if (typeof updateInputModelSwitcher === 'function') updateInputModelSwitcher(); },
    updateThinking: () => { if (typeof updateThinkingEffortSwitcher === 'function') updateThinkingEffortSwitcher(); },
    updatePlan: () => { if (typeof updatePlanBadge === 'function') updatePlanBadge(); },
    loadDetail: (id) => window.loadAgentDetail(id),
    refreshStatus: (...args) => refreshCurrentRuntimeStatus(...args),
    loadLogs: (force) => loadLogs(force),
    warn: (...args) => console.warn(...args),
    error: (...args) => console.error(...args),
  };
}

// Async status requests use the ESM commit policy. Classic identity/render
// helpers are resolved when a refresh runs, not while modules initialize.
function createRuntimeStatusLoaderHost() {
  return {
    runtimeId: () => currentRuntimeAgentId,
    capture: (id) => captureSessionViewToken(id),
    isCurrent: (token) => isSessionViewTokenCurrent(token),
    commit: (token, apply) => commitSessionViewState(token, apply),
    patch: (...args) => commitSessionViewPatch(...args),
    fetch: (...args) => fetch(...args),
    guardAvailable: () => window.ContextGuardToggle?.isAvailable?.() === true,
    ownerRecord: () => getCurrentRuntimeRecord() || getCurrentAgentRecord(),
    logicalId: (record) => getLogicalAgentId(record),
    sessionId: (record) => getActiveSessionId(record),
    runtimeRecord: (id) => getRuntimeRecord(id),
    applyGuard: (data, id) => { if (typeof applyContextGuardStatus === 'function') applyContextGuardStatus(data, id); },
    notify: (...args) => updateNotificationStatus(...args),
    warn: (...args) => console.warn(...args),
  };
}
