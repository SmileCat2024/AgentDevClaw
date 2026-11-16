// Runtime snapshots are keyed by the selected conversation, not just runtime id.
// Synchronous restore is deliberate: navigation renders cached content before I/O.
export function getRuntimeCacheTodoPlanFallback() {
  return { feature: 'todo', updatedAt: 0, counter: 0, tasks: [],
    summary: { total: 0, pending: 0, inProgress: 0, completed: 0, cancelled: 0, blocked: 0 } };
}

export function getRuntimeCacheTodoPlanSignature(plan, signature) {
  return typeof signature === 'function' ? signature(plan)
    : JSON.stringify(plan || getRuntimeCacheTodoPlanFallback());
}

export function createRuntimeViewCache(host) {
  const cache = host.cache;
  const fallbackTodo = getRuntimeCacheTodoPlanFallback;

  function saveCurrentRuntimeToCache(agentId, contextKey = host.contextKey(agentId)) {
    if (!agentId || !contextKey) return;
    const view = host.readView();
    const signatures = host.signatures();
    const todo = view.todoPlan || fallbackTodo();
    cache.delete(contextKey);
    cache.set(contextKey, {
      runtimeId: agentId, messages: view.messages, inputRequests: view.inputRequests,
      toolRenderConfigs: view.toolRenderConfigs, TOOL_NAMES: view.toolNames,
      hookInspector: view.hookInspector, hookInspectorSignature: signatures.hookInspector,
      overviewSnapshot: view.overview, overviewSignature: signatures.overview,
      todoPlan: todo, todoPlanSignature: signatures.todo !== undefined ? signatures.todo
        : getRuntimeCacheTodoPlanSignature(todo, host.todoSignature),
      sessionMeta: view.sessionMeta, connected: view.connected,
      followLatest: host.followLatest(), scrollAnchor: host.captureAnchor(contextKey),
      scrollTop: host.scrollTop(),
    });
    if (cache.size > host.capacity) {
      const evicted = cache.keys().next().value;
      cache.delete(evicted);
      if (evicted && evicted !== host.activeCollapseContext()) host.forgetContext(evicted);
    }
  }

  function restoreRuntimeFromCache(agentId, contextKey = host.contextKey(agentId)) {
    if (!agentId || !contextKey) return false;
    const cached = cache.get(contextKey);
    if (!cached) return false;
    if (cached.runtimeId && String(cached.runtimeId).trim() !== String(agentId).trim()) {
      cache.delete(contextKey);
      return false;
    }
    host.activateCollapse(contextKey);
    // Input patch notifications read follow mode synchronously.
    host.setFollowLatest(cached.followLatest !== undefined ? cached.followLatest : true);
    const restorePatch = {
      messages: cached.messages, inputRequests: cached.inputRequests,
      toolRenderConfigs: cached.toolRenderConfigs, toolNames: cached.TOOL_NAMES,
      hookInspector: cached.hookInspector, overview: cached.overviewSnapshot,
      todoPlan: cached.todoPlan || host.emptyTodo() || fallbackTodo(), sessionMeta: cached.sessionMeta, connected: cached.connected,
    };
    const match = /^host:([^|]+)\|session:(.+)$/.exec(String(contextKey || '').trim());
    const agent = match?.[1].trim();
    const session = match?.[2].trim();
    if (agent && session) host.patch({ identity: host.normalizeIdentity({ agentId: agent, sessionId: session }) });
    // Identity changes clear previous content. Restore the snapshot separately.
    host.patch(restorePatch);
    host.setRestoredScrollTop(typeof cached.scrollTop === 'number' ? cached.scrollTop : null);
    if (cached.scrollAnchor) host.restoreAnchor(cached.scrollAnchor);
    host.updatePlanBadge();
    return true;
  }

  function clearAgentRuntimeCache(agentId) {
    if (!agentId) { cache.clear(); return; }
    for (const [key, cached] of cache) {
      if (cached?.runtimeId === agentId || key === `runtime:${agentId}`) cache.delete(key);
    }
  }
  return { saveCurrentRuntimeToCache, restoreRuntimeFromCache, clearAgentRuntimeCache };
}
