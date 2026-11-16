// Cross-workspace navigation keeps the loading surface mounted while detail
// arrives; a later navigation invalidates its deferred action.
export function createWorkspaceSessionNavigation(host) {
  async function navigateToWorkspaceSession(agentId, sessionId, options = {}) {
    if (!agentId) return;
    host.bumpNavigationGuard();
    const epoch = host.navigationEpoch();
    const action = options.actionOverride || (sessionId ? { type: 'open_session', sessionId } : null);
    if (host.focusedAgentId() === agentId) {
      if (action) await host.runAction(JSON.stringify(action));
      return;
    }
    const agent = host.findWorkspace(agentId);
    if (!agent) return;
    host.saveWorkspaceScroll();
    if (host.runtimeId() && !host.readOnlyMode()) host.saveCache(host.runtimeId(), host.contextKey(host.runtimeId()));
    host.selectLoading(agentId);
    await host.loadDetail(agentId);
    if (epoch !== host.navigationEpoch()) return;
    if (action) await host.runAction(JSON.stringify(action));
    else {
      host.preferHome(agent);
      host.render();
    }
  }
  return { navigateToWorkspaceSession };
}
