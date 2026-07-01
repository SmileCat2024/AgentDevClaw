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
