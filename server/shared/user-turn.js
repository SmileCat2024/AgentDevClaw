import { VIEWER_ORIGIN } from './constants.js';
import { RequestTargetError, resolveRuntimeTarget } from './request-target.js';
import {
  LocalOperationError,
  createOperationMetadata,
} from './operation-contract.js';

/**
 * Thin Claw-side client for AgentDev's atomic user-turn contract.
 * State arbitration remains owned by ViewerWorker; Claw producers only provide
 * a normalized turn and receive the authoritative delivery result.
 */
export class UserTurnDeliveryError extends LocalOperationError {
  constructor(message, {
    code = 'delivery_failed',
    status = 502,
    retryable = true,
    operationId,
    requestId,
    sourceRef,
    idempotencyKey,
    traceId,
    cause,
  } = {}) {
    super(message, {
      code,
      status,
      retryable,
      operationId,
      requestId,
      sourceRef,
      idempotencyKey,
      traceId,
      cause,
      transport: code === 'delivery_unavailable',
    });
    this.name = 'UserTurnDeliveryError';
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
  capabilityActivations,
  operationId,
  requestId,
  idempotencyKey,
  traceId,
}, {
  viewerOrigin = VIEWER_ORIGIN,
  fetchImpl = fetch,
} = {}) {
  const metadata = createOperationMetadata({ operationId, requestId, sourceRef, idempotencyKey, traceId }, { prefix: 'user-turn' });
  let target;
  try {
    target = resolveRuntimeTarget({ agentId }, { viewerOrigin });
  } catch (error) {
    if (error instanceof RequestTargetError) {
      throw new UserTurnDeliveryError(error.message, {
        code: error.code,
        status: error.status,
        retryable: error.retryable,
        ...metadata,
        cause: error,
      });
    }
    throw error;
  }
  if (typeof text !== 'string' || text.length === 0) {
    throw new UserTurnDeliveryError('text must be a non-empty string', {
      code: 'invalid_input',
      status: 400,
      retryable: false,
      ...metadata,
    });
  }

  let response;
  try {
    response = await fetchImpl(
      `${target.viewerOrigin}/api/agents/${encodeURIComponent(target.agentId)}/user-turn`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          ...(Array.isArray(images) && images.length > 0 ? { images } : {}),
          ...(source ? { source } : {}),
          ...(sourceRef ? { sourceRef } : {}),
          ...(Array.isArray(capabilityActivations) && capabilityActivations.length > 0
            ? { capabilityActivations }
            : {}),
        }),
      },
    );
  } catch (cause) {
    throw new UserTurnDeliveryError('Agent runtime delivery service is unavailable', {
      code: 'delivery_unavailable',
      status: 502,
      retryable: true,
      ...metadata,
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
      ...metadata,
    });
  }

  return {
    ...result,
    ...metadata,
    operationId: metadata.operationId || null,
  };
}
