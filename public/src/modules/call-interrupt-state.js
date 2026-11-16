// Interrupting is a call lifecycle state, not a timeout-based debounce.
export function getNotificationCallStartedAt(payload) {
  const value = payload?.runtime?.callStartedAt ?? payload?.callStartedAt;
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : 0;
}

export function createCallInterruptState(pending, now = () => Date.now()) {
  function markInterruptPending(runtimeId, callStartedAt = 0) {
    if (!runtimeId) return;
    const normalized = Number(callStartedAt);
    pending.set(runtimeId, {
      requestedAt: now(),
      callStartedAt: Number.isFinite(normalized) && normalized > 0 ? normalized : 0,
    });
  }

  function isInterruptSuppressed(runtimeId, observedCallStartedAt = 0) {
    if (!runtimeId) return false;
    const interrupted = pending.get(runtimeId);
    if (!interrupted) return false;
    // Only a newer call may release an active observation. Missing identities
    // remain sticky until a terminal event or explicit request failure clears it.
    const interruptedAt = Number(interrupted.callStartedAt);
    const observed = Number(observedCallStartedAt);
    if (Number.isFinite(interruptedAt) && interruptedAt > 0
      && Number.isFinite(observed) && observed > interruptedAt) {
      pending.delete(runtimeId);
      return false;
    }
    return true;
  }

  function clearInterruptSuppression(runtimeId) {
    if (runtimeId) pending.delete(runtimeId);
  }

  return { getNotificationCallStartedAt, markInterruptPending, isInterruptSuppressed, clearInterruptSuppression };
}
