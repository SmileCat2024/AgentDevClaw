// A retired runtime during handoff is not a disappeared conversation. Thread
// facts own successor rebinding; this policy only preserves or clears the view.
export function createRuntimeNotFound(host) {
  async function handleCoreResponsesNotFound(token) {
    if (!host.isCurrent(token)) return true;
    const runtimeId = token.runtimeId;
    host.clearCompact(runtimeId);
    if (host.switching()) { host.schedule(host.fastInterval()); return true; }
    const sessionId = String(host.sessionId(runtimeId) || '').trim();
    const record = host.hostRecord();
    const lookup = () => sessionId && record?.id ? host.thread(record.id, sessionId) : null;
    const rotating = thread => !!thread && String(thread.status || '') === 'rotating';
    let thread = lookup();
    if (thread && !rotating(thread) && host.canRefreshThreads()) {
      await host.refreshThreads(true).catch(() => {});
      if (!host.isCurrent(token)) return true;
      thread = lookup();
    }
    if (rotating(thread)) { host.schedule(host.fastInterval()); return true; }
    const frozen = host.activeConversation();
    if (thread && frozen && thread.status !== 'closed' && sessionId
      && String(thread.threadId || '') !== ''
      && String(thread.headSessionId || '') !== sessionId
      && frozen.threadId === thread.threadId
      && String(frozen.sessionId || '') === sessionId && frozen.wasHead === true) {
      host.schedule(host.fastInterval());
      return true;
    }
    const failed = host.runtimeRecord(runtimeId);
    const fallback = host.fallback(failed);
    if (!host.patch(token, fallback ? {} : { messages: [], inputRequests: [], todoPlan: host.emptyTodo() },
      () => host.clearView(runtimeId, failed, fallback))) {
      host.schedule(host.fastInterval());
      return true;
    }
    await host.loadAgents();
    host.schedule(host.interval());
    return true;
  }
  return { handleCoreResponsesNotFound };
}
