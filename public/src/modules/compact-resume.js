// The server owns succession. This client preserves request policy, remote
// identity conversion and operation diagnostics without a live-command shortcut.
export function createCompactResume(host) {
  async function createCompactedResumeSession(agentId, sessionId, strategy = 'summarized-nine-section',
    keepRecentTurns = null, fullPreserveFromTurn = null, extraPolicy = null, options = {}) {
    const policy = strategy ? { strategy } : {};
    if (keepRecentTurns != null && keepRecentTurns >= 1) policy.keepRecentTurns = keepRecentTurns;
    if (fullPreserveFromTurn != null && fullPreserveFromTurn >= 0) policy.fullPreserveFromTurn = fullPreserveFromTurn;
    if (extraPolicy && typeof extraPolicy === 'object') Object.assign(policy, extraPolicy);
    const remote = host.isRemote(sessionId) || host.isRemote(agentId);
    const requestAgentId = remote ? (host.remote()?.getHostNamespaceIdForSession?.(sessionId, agentId) || agentId) : agentId;
    const operationId = options.operationId || host.createOperationId(options.reason === 'trim' ? 'trim' : 'summary');
    const startedAt = host.now();
    const stopObservation = host.observe(operationId);
    host.checkpoint(operationId, 'request_dispatched');
    try {
      const response = await host.fetch('/protoclaw/context_handoffs/compact_and_resume', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-idempotency-key': host.idempotencyKey() },
        body: JSON.stringify({ agentId: requestAgentId, sessionId, detached: false, policy,
          ...(options.archiveOriginal ? { archiveOriginal: true } : {}),
          ...(options.reason ? { reason: options.reason } : {}),
          ...(options.trimCutRounds != null ? { trimCutRounds: options.trimCutRounds } : {}),
          ...(options.appendSummary ? { appendSummary: true } : {}), operationId, responseMode: 'delta',
        }),
      });
      const headersAt = host.now();
      const responseBytes = Number(response.headers?.get?.('content-length')) || 0;
      host.checkpoint(operationId, 'response_headers_received', { requestWaitMs: headersAt - startedAt, responseBytes });
      if (!response.ok) throw new Error(await response.text().catch(() => 'compacted resume failed'));
      const result = await response.json();
      const converted = remote ? (host.remote()?.namespaceMutationResult?.(sessionId, result) || result) : result;
      host.checkpoint(operationId, 'response_body_parsed', { bodyParseMs: host.now() - headersAt, responseBytes });
      host.refreshThreads();
      return converted;
    } finally {
      stopObservation();
    }
  }
  return { createCompactedResumeSession };
}
