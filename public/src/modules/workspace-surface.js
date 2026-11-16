// Synchronous navigation into a workspace or its waiting-conversation surface.
export function createWorkspaceSurface(host) {
  function selectWorkspaceSurface(agentId, options = {}) {
    host.bumpNavigationGuard();
    host.closeReadOnlySession();
    if (agentId && !host.hasDetail(agentId)) {
      host.loadDetail(agentId).then(() => {
        host.render();
        host.refreshPanels(host.findAgent(agentId));
      });
    }
    const target = host.findAgent(agentId);
    const agent = target || host.currentAgent();
    const key = host.preferenceKey(agent);
    const tabs = host.tabs(agent);
    const preferred = key ? host.surfacePreference(key) : null;
    let tab = host.defaultMode(agent);
    if (tab === 'chat') {
      tab = preferred && tabs.some(item => item.id === preferred) ? preferred
        : tabs.find(item => item.id !== 'chat')?.id || host.ui(agent)?.entry || 'home';
    }
    const previousAgent = host.focusedAgentId();
    const runtime = host.runtimeId();
    const context = host.contextKey(runtime);
    host.saveScroll();
    if (runtime && !host.readOnlyMode()) host.saveCache(runtime, context);
    host.bindWorkspace(agentId, tab, previousAgent, runtime);
    host.setFollowLatest(true);
    host.resetRuntimeState();
    if (options.awaitSession) {
      host.beginPending(agentId, options.awaitSession, 'committing');
      host.setTab('chat');
      host.beginLoading();
    } else host.clearPending();
    host.renderAgents();
    host.render();
    if (!options.skipFeaturePanel) host.renderPanel();
    host.refreshPanels(target);
  }
  return { selectWorkspaceSurface };
}
