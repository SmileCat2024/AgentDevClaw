// Workspace hosts open their home without starting a runtime. Plain prebuilt
// agents retain the launch transaction and navigation guard around completion.
export function createWorkspaceEntry(host) {
  async function handlePrebuiltAgentClick(agentId) {
    host.bumpNavigationGuard();
    host.closeContextMenu();
    const agent = host.findWorkspace(agentId);
    if (!agent) return;
    if (!host.isWorkspaceHost(agent)) host.preferHome(agent);
    if (host.isWorkspaceHost(agent)) {
      host.focus(agentId);
      host.renderAgents();
      if (!host.hasDetail(agentId)) host.showLoading();
      await host.loadDetail(agentId);
      host.markDetailLoaded(agentId);
      host.persistEntry(agentId);
      host.selectWorkspace(agent.id, { skipFeaturePanel: true });
      return;
    }
    if (host.isWorkspaceSurface(agent)) {
      host.focus(agentId);
      host.renderAgents();
      if (!host.hasDetail(agentId)) host.showLoading();
      await host.loadDetail(agent.id);
      host.selectWorkspace(agent.id, { skipFeaturePanel: true });
      return;
    }
    const runtimeId = agent.runtime_session_id || agent.runtimeSessionId;
    if (runtimeId) { await host.switchAgent(runtimeId); return; }
    if (host.isPending(agentId)) return;
    host.markPending(agentId);
    host.renderAgents();
    const epoch = host.navigationEpoch();
    try {
      await host.startAgent(agentId);
      const started = await host.waitRuntime(agentId);
      host.clearPending(agentId);
      host.renderAgents();
      if (epoch !== host.navigationEpoch()) return;
      const nextRuntime = started.runtime_session_id || started.runtimeSessionId || started.id;
      host.preferHome(host.findWorkspace(agentId) || started);
      await host.requestSwitch(nextRuntime, 'prebuilt-start');
    } catch (error) {
      host.clearPending(agentId);
      host.renderAgents();
      host.error('Failed to start prebuilt agent:', error);
      host.showStartError(error);
    }
  }
  return { handlePrebuiltAgentClick };
}

export function createWorkspaceSessionRequest(host) {
  async function openPrebuiltWorkspaceSession(agentId, rawAction) {
    const action = typeof rawAction === 'string' ? JSON.parse(rawAction) : (rawAction || {});
    const creating = action.type === 'create_session' || action.type === 'create_session_from_session';
    const payload = creating ? {
      agentId, sourceSessionId: action.sessionId || null, workspaceAgentId: action.workspaceAgentId,
      featureName: action.featureName || '', agentName: action.agentName || '', projectName: action.projectName || '',
      openDirectory: action.openDirectory || '',
      ...(String(action.projectId || '').trim() ? { projectId: String(action.projectId).trim() } : {}),
      ...(String(action.runtimeMode || '').trim() ? { runtimeMode: String(action.runtimeMode).trim() } : {}),
      studioFeatureIds: Array.isArray(action.studioFeatureIds) ? action.studioFeatureIds : [],
      targetDir: action.targetDir || '', operationId: action.operationId || '', responseMode: 'delta',
    } : { agentId, sessionId: action.sessionId, operationId: action.operationId || '', responseMode: 'delta' };
    const response = await host.fetch(creating ? '/protoclaw/prebuilt_sessions' : '/protoclaw/prebuilt_sessions/activate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    if (!response.ok) {
      // Callers distinguish handoff waiting from an ordinary activation error.
      if (response.status === 409) {
        const data = await response.json().catch(() => null);
        if (data?.code === 'thread_handoff_in_progress') {
          const error = new Error(data.message || 'thread handoff in progress');
          error.handoff = {
            threadId: String(data.threadId || data.target?.threadId || '').trim(),
            sessionId: String(data.headSessionId || data.target?.headSessionId || action.sessionId || '').trim(),
          };
          throw error;
        }
      }
      throw new Error(await response.text().catch(() => 'session operation failed'));
    }
    return response.json();
  }
  return { openPrebuiltWorkspaceSession };
}
