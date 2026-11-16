// Low-frequency reconciliation. Runtime views are token-guarded; the workspace
// surface retains its existing no-runtime refresh and soft group update rules.
export function createPollMaintenance(host) {
  const revisions = new Map();
  async function fetchWorkspaceSessionsForPoll(agentId, agentRecord = null) {
    const known = revisions.get(agentId);
    const params = new URLSearchParams({ agentId });
    if (Number.isFinite(known)) params.set('sinceRevision', String(known));
    const agents = host.agents();
    const record = agentRecord || (Array.isArray(agents) ? agents.find(item => item?.id === agentId) : null);
    if (record && host.isPh(record)) {
      let ownership = null;
      const target = host.browsingTarget(record);
      if (target?.type === 'project') ownership = { projectId: target.id };
      else if (target?.openDirectory) ownership = { projectDir: target.openDirectory };
      if (!ownership) {
        const directory = String(host.workspaceState(record)?.openDirectory || '').trim();
        if (directory) ownership = { projectDir: directory };
      }
      if (ownership?.projectId) params.set('projectId', ownership.projectId);
      else if (ownership?.projectDir) params.set('projectDir', ownership.projectDir);
      const count = Array.isArray(record?.workspace_sessions?.sessions) ? record.workspace_sessions.sessions.length : 0;
      params.set('offset', '0');
      params.set('limit', String(Math.max(count, 60)));
    }
    const response = await host.fetch('/protoclaw/prebuilt_sessions?' + params.toString());
    if (!response.ok) return null;
    const data = await response.json();
    if (!data || data.unchanged === true) return null;
    const revision = Number(data.revision);
    if (Number.isFinite(revision)) revisions.set(agentId, revision);
    return data;
  }

  async function refreshWorkspace(token = null) {
    if (host.now() - host.lastWorkspaceRefresh() <= 3000) return true;
    const record = host.agents().find(agent => agent.id === host.focused() && host.isWorkspace(agent));
    if (!record || !host.detailLoaded(record.id)) return true;
    host.setWorkspaceRefresh(host.now());
    try {
      const fresh = await fetchWorkspaceSessionsForPoll(record.id, record);
      if (!fresh) return true;
      if (token && !host.isCurrent(token)) return false;
      const previous = record.workspace_sessions;
      if (previous && Array.isArray(previous.sessions) && Array.isArray(fresh.sessions)) {
        const byId = new Map(previous.sessions.map(session => [session.id, session]));
        fresh.sessions = fresh.sessions.map(session => {
          const old = byId.get(session.id);
          return old && old.archived === true && session.archived !== true
            ? { ...session, archived: true, todo: false } : session;
        });
      }
      if (token) {
        // Runtime path compares before filling model values, matching the prior
        // rendering decision. Workspace-only path compares the merged snapshot.
        if (JSON.stringify(previous || {}) === JSON.stringify(fresh)) return true;
        const length = previous?.contextLength;
        const ratio = previous?.compressRatio;
        if (Number.isFinite(length) && length > 0 && !(Number.isFinite(fresh.contextLength) && fresh.contextLength > 0)) fresh.contextLength = length;
        if (Number.isFinite(ratio) && ratio > 0 && ratio <= 100 && !(Number.isFinite(fresh.compressRatio) && fresh.compressRatio > 0)) fresh.compressRatio = ratio;
        record.workspace_sessions = host.merge(previous, fresh, record.id);
      } else {
        const merged = host.merge(previous, fresh, record.id);
        if (JSON.stringify(previous || {}) === JSON.stringify(merged)) return true;
        record.workspace_sessions = merged;
      }
      host.renderWorkspace(record, !token);
    } catch { /* Preserve the previous best-effort workspace refresh semantics. */ }
    return true;
  }

  async function refreshUnfocusedPoll() {
    host.apply({ connected: true });
    host.notify(null);
    const interval = host.sseActive() ? 30000 : 3000;
    if (host.now() - host.lastAgentRefresh() > interval) {
      host.setAgentRefresh(host.now());
      await host.loadAgents();
    }
    await host.refreshCalls(host.agents());
    await refreshWorkspace();
  }

  async function _runPollTailLowFrequency(token) {
    const runtimeId = token.runtimeId;
    const interval = host.sseActive() ? 30000 : 3000;
    if (host.now() - host.lastAgentRefresh() > interval) {
      host.setAgentRefresh(host.now());
      await host.loadAgents();
      if (!host.isCurrent(token)) return false;
      host.updateComposer();
    }
    if (!await refreshWorkspace(token)) return false;
    const panel = host.panel();
    if (panel) {
      if (panel === 'logs') await host.loadLogs();
      else if (!['resources', 'viewer', 'settings', 'plan', 'session-controls', 'bg'].includes(panel)) {
        const response = await host.fetch(`/api/agents/${runtimeId}/hooks`);
        const inspector = host.normalizeHooks(await response.json());
        const changed = host.hookSignature(inspector) !== host.currentHookSignature();
        if (!host.patch(token, changed ? { hookInspector: inspector } : {}, () => {
          if (changed) host.renderPanel();
        })) return false;
      }
    }
    return host.commit(token, () => {
      host.saveCache(runtimeId);
      host.trackRecap();
    });
  }
  return { fetchWorkspaceSessionsForPoll, refreshUnfocusedPoll, _runPollTailLowFrequency };
}
