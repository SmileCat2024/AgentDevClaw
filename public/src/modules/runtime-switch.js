// Navigation owns the synchronous view binding; network completion may only
// finish the switch whose epoch is still current.
export function createRuntimeSwitch(host) {
  const state = host.state;

  function flushPendingSwitch(serial, resolve) {
    if (!state.pendingSwitchTarget || state.pendingSwitchTarget.serial !== serial) {
      resolve({ switched: false, reason: 'superseded' });
      return;
    }
    const { runtimeId, navEpoch } = state.pendingSwitchTarget;
    state.pendingSwitchTarget = null;
    if (navEpoch !== state.navigationEpoch) {
      resolve({ switched: false, reason: 'nav-guard-stale' });
      return;
    }
    host.switchAgent(runtimeId).then(
      () => resolve({ switched: true }),
      error => resolve({ switched: false, reason: error?.message }),
    );
  }

  function requestSwitch(runtimeId, source) {
    const serial = ++state.pendingSwitchSerial;
    state.pendingSwitchTarget = { runtimeId, serial, source, navEpoch: state.navigationEpoch };
    return new Promise(resolve => host.setTimeout(() => flushPendingSwitch(serial, resolve), 0));
  }

  async function switchAgent(newAgentId, options = {}) {
    const hadPendingNavigation = host.hasPendingNavigation();
    host.bumpNavigationGuard();
    state.pendingSwitchTarget = null;
    const epoch = ++state.switchEpoch;
    host.closeContextMenu();
    const target = host.findAgent(newAgentId);
    const requestedRuntime = !!(target && host.isWorkspaceHost(target) && newAgentId
      && newAgentId !== target.id && host.runtimeId(target) === newAgentId);
    const runtimeId = requestedRuntime ? newAgentId : (target ? host.agentRuntimeId(target)
      : (host.isRemote(newAgentId) ? (host.remote()?.resolveRuntimeRef?.(newAgentId) || newAgentId) : newAgentId));

    // Leaving a historical record precedes even the already-at-home early return.
    host.closeReadOnlySession();
    if (host.isWorkspaceSurface(target) && !requestedRuntime) {
      const awaitingSame = options.awaitSessionId && target?.id === state.focusedAgentId
        && !state.runtimeId && host.hasPendingNavigation(target);
      if (awaitingSame) return;
      if (target?.id === state.focusedAgentId && !state.runtimeId && !options.awaitSessionId) return;
      host.selectWorkspace(target.id, options.awaitSessionId ? { awaitSession: options.awaitSessionId } : undefined);
      return;
    }
    if (!runtimeId) return;
    if (target?.id === state.focusedAgentId && runtimeId === state.runtimeId) return;
    host.storeDraft();
    host.saveWorkspaceScroll();
    if (state.runtimeId && !state.readOnlyMode) host.saveCache(state.runtimeId);

    try {
      state.focusedAgentId = target ? (host.logicalId(target) || runtimeId)
        : (host.isRemote(newAgentId) ? (host.remote()?.getEntryHostNamespaceId?.(runtimeId) || newAgentId) : runtimeId);
      if (state.runtimeId && host.normalize(state.runtimeId) !== host.normalize(runtimeId)) {
        host.clearFinished(state.runtimeId);
      }
      state.runtimeId = runtimeId;
      // Derive before binding: an unknown session must stay absent, not freeze
      // a host's unrelated active session into the selected runtime.
      const sessionId = host.deriveSession(runtimeId);
      const hostId = String(target?.parent_id || target?.id || state.focusedAgentId || runtimeId).trim();
      host.bindSession(runtimeId, sessionId);
      host.updateThreadIndicators();
      state.readOnlyMode = target ? target.input_accepted === false
        : (host.isRemote(newAgentId) || host.isRemote(runtimeId))
          && host.remote()?.isRemoteWriteEnabled?.(newAgentId) !== true;
      if (host.browseOnly()) state.readOnlyMode = true;
      host.resetSurface();
      host.resetScroll();
      host.resetStatus();
      host.activateCollapse(host.contextKey(runtimeId));
      const restored = host.restoreCache(runtimeId);
      if (restored) {
        state.lastRenderedWorkspaceHtml = '';
        if (!state.followLatest && state.restoredScrollTop != null) host.setPendingScroll(state.restoredScrollTop);
        host.render();
        state.restoredScrollTop = null;
        host.renderPanel();
      } else {
        host.patch({ identity: { agentId: hostId, sessionId }, messages: [],
          overview: host.emptyOverview(), todoPlan: host.emptyTodo(), sessionMeta: undefined });
        host.render();
        host.setFollowLatest(true);
      }
      host.beginFollowWindows();
      host.renderAgents();

      // Pre-warm independently; preserve the runtime check and original error
      // semantics rather than making the switch wait for this request.
      host.fetch(`/api/agents/${encodeURIComponent(runtimeId)}/notification`)
        .then(res => res.ok ? res.json() : null)
        .then(data => {
          if (!data || host.normalize(state.runtimeId) !== host.normalize(runtimeId)) return;
          host.applyCalling(runtimeId, host.isCalling(data));
          host.syncActionButton();
          host.renderAgents();
        })
        .catch(error => host.warn(error));
      host.persistFocus(host.isRemote(newAgentId) ? newAgentId : runtimeId);
      await host.loadData(runtimeId);
      if (epoch === state.switchEpoch) {
        host.loadAgents().catch(error => host.error('Failed to refresh agents after switch:', error));
      }
      if (hadPendingNavigation && epoch === state.switchEpoch) {
        host.clearLoading();
        host.render();
      }
    } catch (error) {
      host.error('Failed to switch agent:', error);
      host.alert(`Switch failed: ${error && error.message ? error.message : error}`);
    }
  }

  return { switchAgent, requestSwitch };
}
