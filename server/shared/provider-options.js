const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

const RESERVED_KEYS = {
  anthropic: new Set(['model', 'messages', 'tools', 'stream', 'max_tokens', 'system', 'thinking']),
  openaiChat: new Set([
    'model', 'messages', 'tools', 'tool_choice', 'stream', 'stream_options',
    'max_tokens', 'max_completion_tokens', 'reasoning_effort', 'parallel_tool_calls',
  ]),
  openaiResponses: new Set([
    'model', 'input', 'tools', 'tool_choice', 'stream', 'instructions', 'store',
    'previous_response_id', 'max_output_tokens', 'reasoning', 'parallel_tool_calls',
  ]),
};

const MAX_DEPTH = 32;

function protocolKind(protocol, apiSurface) {
  if (protocol === 'anthropic') return 'anthropic';
  if (protocol === 'openai-oauth') return 'openaiResponses';
  if (protocol === 'openai' || protocol === 'openai-responses') {
    return apiSurface === 'responses' || protocol === 'openai-responses' ? 'openaiResponses' : 'openaiChat';
  }
  return null;
}

export function findProviderOptionsUnsafeKey(value, path = '', visited = new Set(), depth = 0) {
  if (!value || typeof value !== 'object') return null;
  if (depth >= MAX_DEPTH) return `${path} (nesting exceeds ${MAX_DEPTH})`;
  if (visited.has(value)) return `${path} (circular reference)`;
  visited.add(value);
  for (const key of Object.getOwnPropertyNames(value)) {
    const child = value[key];
    const keyPath = path ? `${path}.${key}` : key;
    if (DANGEROUS_KEYS.has(key)) return keyPath;
    const nested = findProviderOptionsUnsafeKey(child, keyPath, visited, depth + 1);
    if (nested) return nested;
  }
  visited.delete(value);
  return null;
}

export function validateProviderOptions(value, protocol, apiSurface = 'chat') {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = value.trim() ? JSON.parse(value) : {};
    } catch {
      return { valid: false, error: 'Provider options must be a valid JSON object.' };
    }
  }
  if (parsed == null) parsed = {};
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.getPrototypeOf(parsed) !== Object.prototype && Object.getPrototypeOf(parsed) !== null) {
    return { valid: false, error: 'Provider options must be a JSON object, not an array or primitive.' };
  }

  const kind = protocolKind(protocol, apiSurface);
  if (Object.keys(parsed).length && !kind) {
    return { valid: false, error: `Provider options are not supported for protocol ${protocol || 'unspecified'}.` };
  }
  const reservedKeys = kind ? RESERVED_KEYS[kind] : new Set();
  const conflict = kind ? Object.getOwnPropertyNames(parsed).find((key) => reservedKeys.has(key)) : null;
  if (conflict) return { valid: false, error: `Provider options cannot override runtime-owned protocol field ${conflict}.` };

  const unsafeKey = findProviderOptionsUnsafeKey(parsed);
  if (unsafeKey) return { valid: false, error: `Provider options contain unsafe key ${unsafeKey}.` };

  return { valid: true, value: { ...parsed } };
}

export function normalizeProviderOptions(value, protocol, apiSurface = 'chat') {
  const result = validateProviderOptions(value, protocol, apiSurface);
  if (!result.valid) throw new TypeError(result.error);
  return result.value;
}

export function normalizeCodexProviderOptions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return value.service_tier === 'fast' ? { ...value, service_tier: 'priority' } : value;
}
