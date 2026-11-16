// Focused-runtime transaction shared by normal fallback and SSE reconciliation.
// The caller retains the global/no-focus work and the failure scheduling boundary.
export function createRuntimePoll(host) {
  async function runRuntimePoll() {
    const token = host.capture();
    const runtimeId = token.runtimeId;
    const forceFull = host.consumeForceFull();
    const sse = host.sseActive() && !forceFull;
    const statusTask = sse ? host.guard(runtimeId, token) : host.status(runtimeId, token);
    if (sse) {
      await statusTask;
      await host.refreshCalls(host.agents(), { reuseNotification: null });
      if (!host.commit(token, () => host.syncInput(runtimeId))) {
        host.schedule(host.fastInterval());
        return;
      }
      host.commit(token, () => host.title(runtimeId));
      const tailOk = await host.tail(token);
      host.schedule(tailOk ? host.interval() : host.fastInterval());
      return;
    }
    const [inputRes, overviewRes, todoRes] = await Promise.all([
      host.fetch(`/api/agents/${runtimeId}/input-requests`),
      host.fetch(`/api/agents/${runtimeId}/overview`),
      host.fetch(`/api/agents/${runtimeId}/todo`),
    ]);
    if (!host.isCurrent(token)) { host.schedule(host.fastInterval()); return; }
    if ([inputRes, overviewRes].some(response => response.status === 404)) {
      await host.notFound(token);
      return;
    }
    const overviewJson = await overviewRes.json();
    if (!host.isCurrent(token)) { host.schedule(host.fastInterval()); return; }
    const outcome = await host.messages(token, host.probe(overviewJson));
    if (outcome === 'handled404') { await host.notFound(token); return; }
    if (outcome !== 'committed') { host.schedule(host.fastInterval()); return; }
    // Messages have already painted before waiting for auxiliary status work.
    const focusedStatus = await statusTask;
    await host.refreshCalls(host.agents(), {
      includeSseLocals: forceFull,
      reuseNotification: focusedStatus?.notifData ? { runtimeId, payload: focusedStatus.notifData } : null,
    });
    if (!host.commit(token, () => host.syncInput(runtimeId))) {
      host.schedule(host.fastInterval());
      return;
    }
    const [todoRaw, inputRequestsRaw] = await Promise.all([
      todoRes.ok ? todoRes.json() : Promise.resolve(null), inputRes.json(),
    ]);
    if (!host.metadata(token, { todoRaw, overviewJson, inputRequestsRaw })) {
      host.schedule(host.fastInterval());
      return;
    }
    host.commit(token, () => host.title(runtimeId));
    if (!await host.tail(token)) { host.schedule(host.fastInterval()); return; }
    host.schedule(host.fastInterval());
  }
  return { runRuntimePoll };
}
