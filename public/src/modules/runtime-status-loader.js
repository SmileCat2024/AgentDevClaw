// Requests and JSON parsing can each span a navigation; check view ownership
// after both boundaries, before any record, guard or notification UI writes.
export function createRuntimeStatusLoader(host) {
  function guardUrl(supported = host.guardAvailable()) {
    const record = host.ownerRecord();
    const agentId = String(host.logicalId(record) || '').trim();
    const sessionId = String(host.sessionId(record) || '').trim();
    return supported && agentId && sessionId
      ? `/protoclaw/context_guard_status?agentId=${encodeURIComponent(agentId)}&sessionId=${encodeURIComponent(sessionId)}`
      : null;
  }

  async function refreshContextGuardStatus(runtimeId = host.runtimeId(), viewToken = host.capture(runtimeId)) {
    const expectedRuntimeId = String(runtimeId || '').trim();
    if (!expectedRuntimeId || !host.guardAvailable()) return null;
    const url = guardUrl(true);
    if (!url) return null;
    try {
      const response = await host.fetch(url).catch(() => null);
      if (!host.isCurrent(viewToken)) return null;
      const data = response?.ok ? await response.json() : null;
      if (!host.isCurrent(viewToken)) return null;
      host.commit(viewToken, () => host.applyGuard(data, expectedRuntimeId));
      return data;
    } catch (error) {
      host.warn('Failed to refresh context guard status:', error);
      return null;
    }
  }

  async function refreshCurrentRuntimeStatus(runtimeId = host.runtimeId(), viewToken = host.capture(runtimeId)) {
    const expectedRuntimeId = String(runtimeId || '').trim();
    if (!expectedRuntimeId) return null;
    try {
      const url = guardUrl();
      const [notification, connection, guard] = await Promise.all([
        host.fetch(`/api/agents/${expectedRuntimeId}/notification`),
        host.fetch(`/api/agents/${expectedRuntimeId}/connection`),
        url ? host.fetch(url).catch(() => null) : Promise.resolve(null),
      ]);
      if (!host.isCurrent(viewToken)) return null;
      if (!notification.ok || !connection.ok) return null;
      const [notifData, connectionData, guardData] = await Promise.all([
        notification.json(), connection.json(), guard?.ok ? guard.json() : Promise.resolve(null),
      ]);
      if (!host.isCurrent(viewToken)) return null;
      const committed = host.patch(viewToken, { connected: connectionData?.connected !== false }, ({ current }) => {
        const record = host.runtimeRecord(expectedRuntimeId);
        if (record) record.connected = current.connected;
        host.applyGuard(guardData, expectedRuntimeId);
        host.notify(notifData, expectedRuntimeId, viewToken);
      });
      return committed ? { notifData, connectionData } : null;
    } catch (error) {
      host.warn('Failed to refresh runtime status:', error);
      return null;
    }
  }
  return { refreshCurrentRuntimeStatus, refreshContextGuardStatus };
}
