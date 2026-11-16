export function computeSerializedBytes(data) {
  try { return new TextEncoder().encode(JSON.stringify(data)).length; }
  catch { return 0; }
}

export function createMessageMetrics(host) {
  return function emitMsgMetrics(metrics) {
    try {
      if (new URLSearchParams(host.search()).get('msg_metrics') !== '1') return;
    } catch { return; }
    const savedRatio = metrics.fakeFullBytes > 0
      ? Math.max(0, 1 - metrics.actualBytes / metrics.fakeFullBytes) : null;
    host.debug('[msg-metrics]', {
      actualBytes: metrics.actualBytes, fakeFullBytes: metrics.fakeFullBytes,
      savedRatio, changeKind: metrics.changeKind, downgraded: metrics.downgraded,
    });
  };
}
