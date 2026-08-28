export function internalAuthHeaders(headers = {}, token = process.env.PROTOCLAW_INTERNAL_TOKEN) {
  const normalizedToken = typeof token === 'string' ? token.trim() : '';
  return normalizedToken
    ? { ...headers, Authorization: `Bearer ${normalizedToken}` }
    : { ...headers };
}
