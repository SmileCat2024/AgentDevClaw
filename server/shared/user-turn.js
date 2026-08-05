import { VIEWER_ORIGIN } from './constants.js';

/**
 * Thin Claw-side client for AgentDev's atomic user-turn contract.
 * State arbitration remains owned by ViewerWorker; Claw producers only provide
 * a normalized turn and receive the authoritative delivery result.
 */
export class UserTurnDeliveryError extends Error {
  constructor(message, {
    code = 'delivery_failed',
    status = 502,
    retryable = true,
    cause,
  } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'UserTurnDeliveryError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export async function submitUserTurn({
  agentId,
  text,
  images,
  source,
  sourceRef,
}, {
  viewerOrigin = VIEWER_ORIGIN,
  fetchImpl = fetch,
} = {}) {
  if (typeof agentId !== 'string' || agentId.length === 0) {
    throw new UserTurnDeliveryError('agentId is required', {
      code: 'invalid_input',
      status: 400,
      retryable: false,
    });
  }
  if (typeof text !== 'string' || text.length === 0) {
    throw new UserTurnDeliveryError('text must be a non-empty string', {
      code: 'invalid_input',
      status: 400,
      retryable: false,
    });
  }

  let response;
  try {
    response = await fetchImpl(
      `${viewerOrigin}/api/agents/${encodeURIComponent(agentId)}/user-turn`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          ...(Array.isArray(images) && images.length > 0 ? { images } : {}),
          ...(source ? { source } : {}),
          ...(sourceRef ? { sourceRef } : {}),
        }),
      },
    );
  } catch (cause) {
    throw new UserTurnDeliveryError('Agent runtime delivery service is unavailable', {
      code: 'delivery_unavailable',
      status: 502,
      retryable: true,
      cause,
    });
  }
  const result = await readJson(response);

  if (!response.ok || !result?.success) {
    const code = result?.code || 'delivery_failed';
    throw new UserTurnDeliveryError(result?.error || `User turn delivery failed: HTTP ${response.status}`, {
      code,
      status: response.status || 502,
      retryable: code !== 'invalid_input' && code !== 'input_mode_conflict',
    });
  }

  return result;
}
