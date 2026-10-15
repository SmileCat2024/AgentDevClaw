// Shared retry policy for outbound provider requests (OAuth login/refresh,
// model catalogs). Retries transient network-layer failures and retryable
// HTTP statuses with per-attempt backoff.
//
// 429 is deliberately NOT retried here — each endpoint attaches its own
// semantics to it (device-code backoff loop, poll protocol tolerance,
// refresh surfaced to the caller).
//
// AGENTDEV_FETCH_RETRY_BASE_DELAY_MS overrides the backoff base delay
// (tests set it to 0 so simulated-failure loops stay instantaneous).

const TRANSIENT_NETWORK_CODES = new Set([
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
]);

export function getNetworkErrorCode(error) {
  return error?.cause?.code || error?.code || '';
}

export function isTransientNetworkError(error) {
  if (TRANSIENT_NETWORK_CODES.has(getNetworkErrorCode(error))) return true;
  return error instanceof TypeError && /fetch failed/i.test(error.message || '');
}

// Upstream statuses worth another attempt: request timeout (408) and
// gateway/origin unavailability (5xx except 501, plus the Cloudflare
// origin-down family 521-524).
const RETRYABLE_STATUS = new Set([408, 500, 502, 503, 504, 521, 522, 523, 524]);

function retryBaseDelayMs() {
  const override = Number(process.env.AGENTDEV_FETCH_RETRY_BASE_DELAY_MS);
  if (Number.isFinite(override) && override >= 0) return override;
  return 400;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function wrapFetchError(operation, error, transient, timedOut, timeoutMs) {
  const code = getNetworkErrorCode(error) || (timedOut ? 'ETIMEDOUT' : 'FETCH_NETWORK_ERROR');
  const causeMessage = timedOut
    ? `timed out after ${timeoutMs}ms`
    : error?.cause?.message || error?.message || String(error);
  const detail = code ? `${code}: ${causeMessage}` : causeMessage;
  const wrapped = new Error(`${operation} failed: ${detail}`);
  wrapped.code = code;
  wrapped.transient = transient;
  wrapped.cause = error;
  return wrapped;
}

/**
 * fetch() with bounded automatic retries.
 *
 * - Retries transient network errors and RETRYABLE_STATUS responses;
 *   backoff delay = base × attempt.
 * - Applies a per-attempt timeout through its own AbortController when
 *   timeoutMs > 0; a timeout counts as transient and is retried. The
 *   request's signal is owned by this helper (options.signal is ignored).
 * - Returns the final Response whatever its status; throws only for
 *   network-layer failures, wrapped as an Error with `.code`, `.transient`
 *   and `.cause` (`.transient` is true when the failure was retried to
 *   exhaustion, false when it was non-transient and thrown immediately).
 *
 * @param {string} url
 * @param {RequestInit} [options]
 * @param {{ attempts?: number, timeoutMs?: number, operation?: string, fetchImpl?: typeof fetch }} [opts]
 */
export async function fetchWithRetry(url, options = {}, opts = {}) {
  const attempts = opts.attempts ?? 3;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const operation = opts.operation || 'request';
  const fetchImpl = opts.fetchImpl || globalThis.fetch;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;
    let response = null;
    try {
      response = await fetchImpl(url, { ...options, signal: controller.signal });
    } catch (error) {
      const timedOut = timer !== null && controller.signal.aborted && error?.name === 'AbortError';
      const transient = timedOut || isTransientNetworkError(error);
      if (!transient || attempt >= attempts) {
        throw wrapFetchError(operation, error, transient, timedOut, timeoutMs);
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (response) {
      if (!RETRYABLE_STATUS.has(response.status) || attempt >= attempts) return response;
      // Drain the discarded body so the socket is released before retrying.
      try { await response.body?.cancel(); } catch { /* body already consumed */ }
    }
    await sleep(retryBaseDelayMs() * attempt);
  }
}
