// One authoritative connected snapshot plus Viewer liveness. Empty or rejected
// reads must not erase previously confirmed workspace identities.
export function createAgentSnapshotLoader(host) {
  const { state } = host;

  async function loadAgents() {
    if (state.inFlight) return state.inFlight;
    const started = host.now();
    const token = host.captureToken();
    const task = (async () => {
      try {
        const ownership = host.ownership((Array.isArray(state.agents) ? state.agents : [])
          .find((agent) => agent.id === 'programming-helper') || null);
        const [connected, response] = await Promise.all([
          host.connected(ownership), host.viewer(), host.loadLayout(),
        ]);
        const data = response.ok ? await response.json().catch(() => ({ agents: [] })) : { agents: [] };
        if (connected.some((agent) => agent.id === 'programming-helper')) await host.loadProjects();
        if (token && !host.isTokenCurrent(token)) {
          host.schedule(() => loadAgents().catch((error) => host.warn(error)), 25);
          return { stale: true };
        }
        if (connected.__sidebarDiagnostic) {
          host.warn('[sidebar] retaining snapshot after failed authoritative read', connected.__sidebarDiagnostic);
          return { unavailable: true };
        }
        const runtimes = data.agents || [];
        const runtimeById = new Map(runtimes.map((agent) => [agent.id, agent]));
        const previousById = new Map(state.agents.map((agent) => [agent.id, agent]));
        if (connected.length === 0) {
          const previous = Array.isArray(state.agents) ? state.agents : [];
          const diagnose = (phase) => {
            host.diagnostic({ kind: 'system', operation: 'sidebar_snapshot',
              phase: `empty-connected-${phase}`, errorCode: 'empty-connected-snapshot', result: 'degraded',
              agentCount: previous.length, runtimeCount: runtimes.length });
            host.warn(`[sidebar] empty connected snapshot (${phase}): prev=${previous.length} viewerRuntime=${runtimes.length}`);
          };
          if (runtimes.length === 0) {
            diagnose('both-sources-empty');
          } else if (previous.some((agent) => agent?.source === 'prebuilt')) {
            state.agents = previous.map((agent) => {
              const runtimeId = host.runtimeId(agent);
              const runtime = runtimeById.get(runtimeId || agent.id);
              const connected = runtime?.connected ?? agent.connected ?? false;
              return { ...agent, status: connected ? 'running' : 'stopped',
                message_count: runtime?.messageCount ?? agent.message_count ?? 0, connected };
            });
            diagnose('preserved-identity');
          } else {
            state.agents = runtimes.map((agent) => ({
              id: agent.id, name: agent.name, description: agent.description || '',
              status: agent.connected ? 'running' : 'stopped', source: 'external',
              parent_id: agent.parentAgentId || null,
              connection_info: agent.connectionInfo || 'viewer://127.0.0.1:2026',
              pid: agent.pid || null, runtime_session_id: agent.id, message_count: agent.messageCount ?? 0,
              created_at: agent.createdAt || null, connected: agent.connected ?? false,
            }));
            diagnose('external-fallback-no-history');
          }
        } else {
          host.reconcileStops(connected);
          state.agents = connected.map((agent) => {
            const runtimeId = host.runtimeId(agent);
            const runtime = runtimeById.get(runtimeId || agent.id);
            const connected = runtime?.connected ?? agent.connected ?? false;
            const previous = previousById.get(agent.id);
            const detailLoaded = host.detailIds.has(agent.id);
            let detail = {};
            if (previous && detailLoaded) {
              detail = { workspace_data: previous.workspace_data,
                workspace_state: { ...previous.workspace_state,
                  ...(agent.workspace_state?.gcChats ? { gcChats: agent.workspace_state.gcChats } : {}) },
                workspace_sessions: host.mergeSessions(previous.workspace_sessions, agent.workspace_sessions, agent.id) };
            } else if (previous?.workspace_sessions?.sessions?.length > 0
              && !(agent.workspace_sessions?.sessions?.length > 0)) {
              detail = { workspace_sessions: previous.workspace_sessions };
            }
            if (!detailLoaded && agent.workspace_sessions?.sessions?.length > 0 && previous?.workspace_sessions) {
              const current = agent.workspace_sessions;
              const prior = previous.workspace_sessions;
              const needLength = !(Number.isFinite(current.contextLength) && current.contextLength > 0)
                && Number.isFinite(prior.contextLength) && prior.contextLength > 0;
              const needRatio = !(Number.isFinite(current.compressRatio) && current.compressRatio > 0 && current.compressRatio <= 100)
                && Number.isFinite(prior.compressRatio) && prior.compressRatio > 0 && prior.compressRatio <= 100;
              if (needLength || needRatio) detail.workspace_sessions = { ...current,
                ...(needLength ? { contextLength: prior.contextLength } : {}),
                ...(needRatio ? { compressRatio: prior.compressRatio } : {}) };
            }
            return { ...agent, status: connected ? 'running' : (agent.status || 'stopped'),
              message_count: runtime?.messageCount ?? agent.message_count ?? 0, connected, ...detail };
          });
        }
        host.pruneCallStates(state.agents);
        if (!state.suppressRender) {
          host.renderList();
          if (!['resources', 'viewer', 'settings'].includes(state.activePanel)) host.renderPanel();
        }
        await host.refreshCalls(state.agents);
        if (state.focused && !host.isRemote(state.focused)
          && !state.agents.some((agent) => agent.id === state.focused || host.agentRuntimeId(agent) === state.focused)) {
          const fallback = host.fallback();
          if (fallback) {
            await host.loadDetail(fallback);
            host.selectSurface(fallback, { skipFeaturePanel: true });
            return;
          }
        }
        if (!state.focused) {
          const home = state.agents.find((agent) => agent.id === 'home' && agent.source === 'prebuilt');
          if (home) {
            host.preferHome(home);
            await host.loadDetail(home.id);
            host.selectSurface(home.id, { skipFeaturePanel: true });
            return;
          }
          if (!state.focused) {
            const restore = host.resolveFocus(state.agents);
            if (restore) {
              if (restore.agentId && restore.source === 'prebuilt') {
                void host.clickPrebuilt(restore.id);
              } else {
                state.focused = host.logicalId(restore) || null;
                await host.loadData(host.agentRuntimeId(restore));
              }
            }
          }
        }
      } catch (error) {
        host.error('Failed to load agents:', error);
      }
    })();
    state.inFlight = task;
    try {
      return await task;
    } finally {
      if (state.inFlight === task) {
        state.inFlight = null;
        host.log(`[PERF-CLIENT] loadAgents complete (${(host.now() - started).toFixed(0)}ms)`);
      }
    }
  }
  return { loadAgents };
}
