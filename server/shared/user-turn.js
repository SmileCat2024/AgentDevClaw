import { VIEWER_ORIGIN } from './constants.js';
import { RequestTargetError, resolveRuntimeTarget } from './request-target.js';
import { forwardBase } from './remote-forward.js';
import { getProxyConnectionLookup, getProxyRemoteAuthSessions } from './proxy.js';
import {
  LocalOperationError,
  createOperationMetadata,
} from './operation-contract.js';

function readConnection(lookup, connectionId) {
  if (!lookup) return null;
  if (typeof lookup === 'function') return lookup(connectionId);
  return lookup.getConnection?.(connectionId) ?? null;
}

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
  // 远程命名空间 id 需要 ConnectionStore 才能解析出隧道 origin；默认复用
  // 宿主经 proxy.js 注册的同一张连接表，测试可注入替身（ADR-0011）。
  findConnection = getProxyConnectionLookup(),
  fetchImpl = fetch,
} = {}) {
  const metadata = createOperationMetadata({ operationId, requestId, sourceRef, idempotencyKey, traceId }, { prefix: 'user-turn' });
  let target;
  try {
    target = resolveRuntimeTarget({ agentId }, { viewerOrigin, findConnection });
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
    // 远程 target 的转发基址是隧道 origin（远程 target 上 viewerOrigin 为
    // undefined，直接拼接会产生 "undefined/…" URL，ADR-0011）；target.agentId
    // 已由 resolveRuntimeTarget 还原为裸 id。
    const url = `${forwardBase(target)}/api/agents/${encodeURIComponent(target.agentId)}/user-turn`;
    const init = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // 幂等键透传：远程端与本地代理闸共用同一套 operation 元数据头。
        ...(metadata.idempotencyKey ? { 'x-idempotency-key': metadata.idempotencyKey } : {}),
      },
      body: JSON.stringify({
        text,
        ...(Array.isArray(images) && images.length > 0 ? { images } : {}),
        ...(source ? { source } : {}),
        ...(sourceRef ? { sourceRef } : {}),
        ...(Array.isArray(capabilityActivations) && capabilityActivations.length > 0
          ? { capabilityActivations }
          : {}),
      }),
    };
    // 远程 target 经认证会话出站：远程开启单密码访问保护时请求必须携带
    // 登录会话（fetchWithAuth 附加 cookie 与 same-origin Origin，401 时
    // 重登录重试一次），与 proxy.js 的 remoteFetch 同构。裸转发会被远程
    // authMiddleware 以 401 拒绝。本地 target 与未装配认证会话的测试注入
    // 保持原有 fetchImpl 路径。
    const authSessions = target.scope === 'remote' ? getProxyRemoteAuthSessions() : null;
    const connection = authSessions ? readConnection(findConnection, target.connectionId) : null;
    response = connection
      ? await authSessions.fetchWithAuth(connection, url, init)
      : await fetchImpl(url, init);
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
