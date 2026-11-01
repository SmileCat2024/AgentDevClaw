import { VIEWER_ORIGIN } from './constants.js';
import { viewerFetch } from './viewer-fetch.js';

/** Deliver a targeted request to a runtime without a local child-process IPC channel. */
export async function deliverViaHostRequestChannel(viewerAgentId, payload) {
  try {
    const response = await viewerFetch(VIEWER_ORIGIN, `/api/agents/${encodeURIComponent(viewerAgentId)}/host-request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await response.json().catch(() => null);
    if (response.ok && body?.success === true) return { ok: true, result: body.result ?? null };
    return {
      ok: false,
      code: response.status === 504 ? 'runtime_request_timeout' : 'delivery_failed',
      error: body?.error || `Viewer host-request failed (HTTP ${response.status})`,
    };
  } catch (error) {
    return { ok: false, code: 'delivery_failed', error: String(error?.message || error) };
  }
}
