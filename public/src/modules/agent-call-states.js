// Sidebar call-state reconciliation. SSE-owned locals are not absent/idle;
// online remote runtimes still require polling. Maps are shared with classic UI.
export function createAgentCallStates(host) {
  let inProgress = false;
  const { calling, suspended, interrupting, finished } = host;

  function collectActiveCallRuntimeIds(agents) {
    const ids = (Array.isArray(agents) ? agents : []).filter((agent) => agent?.connected)
      .map((agent) => host.runtimeId(agent)).filter(Boolean);
    for (const entry of host.remoteEntries()) {
      if (entry.status === 'connected' && entry.runtimeId) ids.push(entry.runtimeId);
    }
    return Array.from(new Set(ids));
  }

  function applyAgentCallStateFromNotification(runtimeId, data) {
    const payload = data && typeof data === 'object' ? data : null;
    const backendCalling = host.resolveCalling(payload) === true;
    const prevCalling = calling.get(runtimeId) === true;
    const prevSuspended = suspended.get(runtimeId) === true;
    const effectiveCalling = backendCalling && !host.isInterruptSuppressed(runtimeId, host.callStartedAt(payload));
    let nextSuspended = prevSuspended;
    if (effectiveCalling) {
      host.markStarted(runtimeId);
      calling.set(runtimeId, true);
      suspended.delete(runtimeId);
      nextSuspended = false;
    } else {
      calling.delete(runtimeId);
      nextSuspended = host.isSuspended(payload);
      if (nextSuspended) suspended.set(runtimeId, true);
      else suspended.delete(runtimeId);
    }
    if (!backendCalling) host.clearInterrupt(runtimeId);
    if (prevCalling && !effectiveCalling && host.normalize(runtimeId) !== host.normalize(host.currentRuntimeId())) {
      finished.add(runtimeId);
    }
    if (prevCalling !== effectiveCalling && host.normalize(runtimeId) === host.normalize(host.currentRuntimeId())) {
      host.syncActionButton();
    }
    return prevCalling !== effectiveCalling || prevSuspended !== nextSuspended;
  }

  function applyCallStateToAgentRecords(runtimeId, active, agents = host.agents()) {
    let changed = false;
    for (const agent of Array.isArray(agents) ? agents : []) {
      if (agent?.source === 'prebuilt' || host.runtimeId(agent) !== runtimeId) continue;
      const next = active === true;
      if (agent.callActive !== next) { agent.callActive = next; changed = true; }
    }
    return changed;
  }

  function cleanupOrphanCallStates(activeIds) {
    let changed = false;
    for (const key of Array.from(calling.keys())) {
      if (!activeIds.has(key)) {
        calling.delete(key); interrupting.delete(key); finished.delete(key); suspended.delete(key);
        changed = true;
      }
    }
    for (const key of Array.from(suspended.keys())) {
      if (!activeIds.has(key)) { suspended.delete(key); changed = true; }
    }
    return changed;
  }

  function cleanPrebuiltHostRows(agents) {
    let changed = false;
    for (const agent of Array.isArray(agents) ? agents : []) {
      if (agent?.source === 'prebuilt' && agent.callActive) { agent.callActive = false; changed = true; }
    }
    return changed;
  }

  async function refreshAgentCallStates(agents = host.agents(), options = {}) {
    const { force = false, reuseNotification = null, includeSseLocals = false } = options;
    if (inProgress) return;
    const now = host.now();
    if (!force && now - host.lastRefresh() < 1000) return;
    inProgress = true;
    host.setLastRefresh(now);
    try {
      const ids = collectActiveCallRuntimeIds(agents);
      const skipLocal = host.isSseActive() && !includeSseLocals;
      const polled = skipLocal ? ids.filter((id) => host.isRemote(id)) : ids;
      if (!polled.length) {
        if (skipLocal) {
          let changed = cleanupOrphanCallStates(new Set(ids));
          changed = cleanPrebuiltHostRows(agents) || changed;
          if (changed) host.render();
          return;
        }
        let changed = false;
        for (const key of Array.from(calling.keys())) {
          calling.delete(key); interrupting.delete(key); suspended.delete(key); changed = true;
        }
        for (const key of Array.from(suspended.keys())) { suspended.delete(key); changed = true; }
        if (changed) host.render();
        return;
      }
      const payloads = new Map();
      await Promise.all(polled.map(async (id) => {
        try {
          if (reuseNotification?.payload && host.normalize(reuseNotification.runtimeId) === host.normalize(id)) {
            payloads.set(id, reuseNotification.payload);
            return;
          }
          const response = await host.fetch(`/api/agents/${encodeURIComponent(id)}/notification`);
          if (response.ok) payloads.set(id, await response.json());
        } catch {
          // Existing contract: a failed observation is applied as a null payload.
        }
      }));
      let changed = false;
      for (const id of polled) changed = applyAgentCallStateFromNotification(id, payloads.get(id) || null) || changed;
      changed = cleanupOrphanCallStates(new Set(ids)) || changed;
      const byPolled = new Map();
      for (const id of polled) {
        const payload = payloads.get(id) || null;
        byPolled.set(id, host.resolveCalling(payload) === true
          && !host.isInterruptSuppressed(id, host.callStartedAt(payload)));
      }
      const activeIds = new Set(ids);
      for (const agent of Array.isArray(agents) ? agents : []) {
        if (agent?.source === 'prebuilt') continue;
        const id = host.runtimeId(agent);
        if (!id || (skipLocal && activeIds.has(id) && !host.isRemote(id))) continue;
        changed = applyCallStateToAgentRecords(id, byPolled.get(id) === true, agents) || changed;
      }
      changed = cleanPrebuiltHostRows(agents) || changed;
      if (changed) host.render();
    } finally {
      inProgress = false;
    }
  }

  return { collectActiveCallRuntimeIds, applyAgentCallStateFromNotification,
    applyCallStateToAgentRecords, cleanupOrphanCallStates, cleanPrebuiltHostRows, refreshAgentCallStates };
}
