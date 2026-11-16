// ADR-0013: poll and SSE share one sequence baseline and one commit path.
export function createMessageProbe(host) {
  const appliedSequences = new Map();
  async function runMessagesProbeCycle(token, probe) {
    const runtimeId = token.runtimeId;
    const known = host.messages();
    const previous = Array.isArray(known) ? known : [];
    const count = previous.length;
    const metrics = { actualBytes: 0, fakeFullBytes: probe ? probe.fakeFullBytes : 0,
      changeKind: probe ? probe.changeKind : null, downgraded: false };
    const key = token.identity ? `${token.identity.agentId}::${token.identity.sessionId}` : runtimeId;
    const applied = appliedSequences.get(key) || 0;
    const advanced = probe ? probe.seq > applied : true;
    const fetchJson = async (query) => {
      const response = await host.fetch(`/api/agents/${runtimeId}/messages${query}`);
      if (response.status === 404) return { handled404: true };
      return { data: await response.json() };
    };
    let messages;
    if (!probe || probe.seq < applied || probe.seq > applied + 1
      || probe.count < count || (probe.count > 0 && count === 0)) {
      if (probe && probe.count < count) metrics.downgraded = true;
      const result = await fetchJson('');
      if (result.handled404) return 'handled404';
      if (!host.isCurrent(token)) return 'stale';
      messages = host.attachTimestamps(result.data.messages || [], result.data.timestamps);
      metrics.actualBytes += host.bytes(result.data);
    } else if (!advanced) {
      messages = previous;
    } else if (probe.count > count || probe.changeKind === 'append') {
      const result = await fetchJson(`?since=${count}`);
      if (result.handled404) return 'handled404';
      if (!host.isCurrent(token)) return 'stale';
      const delta = Array.isArray(result.data.messages) ? result.data.messages : [];
      if (delta.length === probe.count - count) {
        messages = [...previous.slice(0, count), ...host.attachTimestamps(delta, result.data.timestamps)];
      } else {
        metrics.downgraded = true;
        const full = await fetchJson('');
        if (full.handled404) return 'handled404';
        if (!host.isCurrent(token)) return 'stale';
        messages = host.attachTimestamps(full.data.messages || [], full.data.timestamps);
        metrics.actualBytes += host.bytes(full.data);
      }
      metrics.actualBytes += host.bytes(result.data);
    } else if (probe.changeKind === 'tail') {
      const result = await fetchJson('?tail=1');
      if (result.handled404) return 'handled404';
      if (!host.isCurrent(token)) return 'stale';
      const tail = Array.isArray(result.data.messages) ? result.data.messages : [];
      if (tail.length === 1 && probe.count === count && count > 0) {
        messages = [...previous.slice(0, -1), host.attachTimestamps(tail, result.data.timestamps)[0]];
      } else {
        metrics.downgraded = true;
        const full = await fetchJson('');
        if (full.handled404) return 'handled404';
        if (!host.isCurrent(token)) return 'stale';
        messages = host.attachTimestamps(full.data.messages || [], full.data.timestamps);
        metrics.actualBytes += host.bytes(full.data);
      }
      metrics.actualBytes += host.bytes(result.data);
    } else {
      const result = await fetchJson('');
      if (result.handled404) return 'handled404';
      if (!host.isCurrent(token)) return 'stale';
      messages = host.attachTimestamps(result.data.messages || [], result.data.timestamps);
      metrics.actualBytes += host.bytes(result.data);
    }
    // A still-current identity token does not guarantee its message prefix is
    // current: another SSE/poll response may already have committed a newer one.
    if (!host.isCurrent(token)) return 'stale';
    const latest = appliedSequences.get(key) || 0;
    if (probe && latest !== applied && probe.seq <= latest) return 'stale';
    if (host.messages() !== previous) {
      if (probe && probe.seq <= latest) return 'stale';
      return runMessagesProbeCycle(token, probe);
    }
    if (!host.commit(token, { messages }, host.render)) return 'stale';
    appliedSequences.set(key, probe ? probe.seq : 0);
    host.metrics(metrics);
    return 'committed';
  }
  return { runMessagesProbeCycle };
}
