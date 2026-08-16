/**
 * zen-helpers.js — OpenCode Zen API gateway utilities.
 *
 * OpenCode exposes Zen and Go gateways. Users create their API key and
 * manage any Go subscription in the OpenCode Console; this project only
 * connects the selected model to one of the two official fixed gateways.
 * Both gateways expose three endpoint surfaces depending on model family:
 *
 *   • GPT / Grok     → /responses        (OpenAI Responses SDK)
 *   • Claude         → /messages          (Anthropic Messages SDK)
 *   • Everything else → /chat/completions (OpenAI-compatible SDK)
 *
 * All three share the same base URL, so callers only need to pick the
 * right protocol + apiSurface pair. This module centralises that mapping.
 */

// ── Constants ────────────────────────────────────────────────────

export const ZEN_BASE_URL = 'https://opencode.ai/zen/v1';
export const OPENCODE_GO_BASE_URL = 'https://opencode.ai/zen/go/v1';

/**
 * Resolve an OpenCode service tier to its official fixed gateway URL.
 * Unknown values deliberately fall back to Zen rather than accepting a
 * caller-provided URL.
 *
 * @param {string} tier
 * @returns {string}
 */
export function resolveOpenCodeBaseUrl(tier) {
  return tier === 'go' ? OPENCODE_GO_BASE_URL : ZEN_BASE_URL;
}

// ── Protocol mapping ─────────────────────────────────────────────

/**
 * Determine the protocol and API surface for a Zen model ID.
 *
 * @param {string} modelId - e.g. "gpt-5.6-terra", "claude-sonnet-5"
 * @returns {{ protocol: 'openai' | 'anthropic', apiSurface: 'chat' | 'responses' }}
 */
export function resolveZenModelProtocol(modelId) {
  const id = (typeof modelId === 'string' ? modelId : '').trim().toLowerCase();

  if (!id) return { protocol: 'openai', apiSurface: 'chat' };

  // GPT / Grok → OpenAI Responses surface
  if (id.startsWith('gpt-') || id.startsWith('grok-')) {
    return { protocol: 'openai', apiSurface: 'responses' };
  }

  // Claude → Anthropic Messages surface
  if (id.startsWith('claude-')) {
    return { protocol: 'anthropic', apiSurface: 'chat' };
  }

  // GLM, DeepSeek, Kimi, MiniMax, Mimo, Gemini, and all others →
  // OpenAI-compatible chat completions surface (safest default for Zen)
  return { protocol: 'openai', apiSurface: 'chat' };
}

// ── Preset template ──────────────────────────────────────────────

/**
 * Build a flat preset object for a Zen model, ready to be inserted into
 * the presets array sent to PUT /protoclaw/model_config.
 *
 * @param {string} modelId - Zen model ID (e.g. "gpt-5.6-terra")
 * @param {string} apiKey - User's Zen API key
 * @returns {object} Flat preset compatible with buildStructuredModelPresets
 */
export function buildZenPresetTemplate(modelId, apiKey) {
  const { protocol, apiSurface } = resolveZenModelProtocol(modelId);
  return {
    name: `Zen ${modelId}`,
    providerName: 'OpenCode Zen',
    provider: protocol,
    apiSurface,
    authType: '',
    clientId: '',
    model: modelId,
    baseUrl: ZEN_BASE_URL,
    apiKey: apiKey || '',
    thinkingEffort: null,
    thinkingBudgetTokens: null,
    maxTokens: null,
    temperature: null,
    vision: false,
    contextLength: 200000,
    compressRatio: 80,
    countTokenPath: null,
    customHeaders: [],
  };
}

// ── Model list parsing ───────────────────────────────────────────

/**
 * Parse the response from Zen's GET /v1/models endpoint (OpenAI-format)
 * into a list of { id, protocol, apiSurface } objects.
 *
 * @param {{ data?: Array<{ id: string }> } | null | undefined} raw
 * @returns {Array<{ id: string, protocol: string, apiSurface: string }>}
 */
export function parseZenModelsResponse(raw) {
  if (!raw || !Array.isArray(raw.data)) return [];

  const seen = new Set();
  const models = [];

  for (const entry of raw.data) {
    const id = typeof entry?.id === 'string' ? entry.id.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const { protocol, apiSurface } = resolveZenModelProtocol(id);
    models.push({ id, protocol, apiSurface });
  }

  return models;
}
