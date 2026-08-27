export function buildModelUsageMeta(resolvedModel, roleFallback = '') {
  return {
    modelName: resolvedModel?.modelName || resolvedModel?.llm?.modelName || '',
    provider: resolvedModel?.provider || resolvedModel?.protocol || '',
    providerName: resolvedModel?.providerName || '',
    protocol: resolvedModel?.protocol || resolvedModel?.provider || '',
    presetName: resolvedModel?.presetName || '',
    presetRole: resolvedModel?.presetRole || roleFallback || '',
    baseUrl: resolvedModel?.baseUrl || '',
  };
}

/**
 * call 汇总 → 按模型分段的待上报用量事件。
 *
 * 优先消费框架 UsageStats 的 modelSegments（每次 LLM 请求发出时刻的归因，
 * call 内轮换过 N 个模型即 N 个事件）；旧框架包无分段数据时回退为整 call
 * 单事件（按当前 agent meta 归因）。
 *
 * 分段只携带 modelName/presetName；provider/protocol 等未随段携带，不用
 * 当前 meta 兜底——兜底会把其他模型的 provider 错挂到本段。
 */
export function buildCallUsageEvents({ agentId, sessionId, runtimeInstanceId, callIndex, callSummary, llmMeta = {}, context }) {
  if (!callSummary?.totalUsage || callIndex === null || callIndex === undefined) return [];
  const segments = Array.isArray(callSummary.modelSegments) && callSummary.modelSegments.length > 0
    ? callSummary.modelSegments
    : [{
        modelName: llmMeta.modelName,
        presetName: llmMeta.presetName,
        usage: callSummary.totalUsage,
        requests: callSummary.stepCount || 1,
        cacheHitRequests: callSummary.cacheHitRequests || 0,
      }];
  const timestamp = callSummary.endTime || Date.now();
  return segments.map((segment) => ({
    eventId: [
      'agent-call',
      agentId,
      sessionId,
      runtimeInstanceId,
      callIndex,
      timestamp,
      segment.presetName || segment.modelName || 'default',
    ].join(':'),
    timestamp,
    source: 'agent-call',
    agentId: agentId || '',
    sessionId: sessionId || '',
    runtimeInstanceId: runtimeInstanceId || '',
    callIndex,
    requestCount: segment.requests || 1,
    cacheHitRequests: segment.cacheHitRequests || 0,
    model: buildModelUsageMeta(
      { modelName: segment.modelName, presetName: segment.presetName },
      'default',
    ),
    usage: segment.usage,
    context,
  }));
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const inputTokens = Number.isFinite(usage.inputTokens) ? usage.inputTokens : 0;
  const outputTokens = Number.isFinite(usage.outputTokens) ? usage.outputTokens : 0;
  const totalTokens = Number.isFinite(usage.totalTokens) ? usage.totalTokens : inputTokens + outputTokens;
  if (!inputTokens && !outputTokens && !totalTokens) return null;
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cacheReadTokens: Number.isFinite(usage.cacheReadTokens) ? usage.cacheReadTokens : 0,
    cacheCreationTokens: Number.isFinite(usage.cacheCreationTokens) ? usage.cacheCreationTokens : 0,
    reasoningTokens: Number.isFinite(usage.reasoningTokens) ? usage.reasoningTokens : 0,
    audioTokens: Number.isFinite(usage.audioTokens) ? usage.audioTokens : 0,
  };
}

export async function reportUsageEvent(serverOrigin, event) {
  const usage = normalizeUsage(event?.usage);
  if (!serverOrigin || !usage) return { skipped: true };
  try {
    const response = await fetch(`${serverOrigin}/protoclaw/usage/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...event, usage }),
    });
    if (!response.ok) {
      return { ok: false, status: response.status };
    }
    return await response.json();
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}
