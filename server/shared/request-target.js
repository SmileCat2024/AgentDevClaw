import { VIEWER_ORIGIN } from './constants.js';

const IDENTITY_FIELDS = {
  agentId: ['agentId', 'agent_id', 'logicalAgentId', 'logical_agent_id'],
  sessionId: ['sessionId', 'session_id'],
  runtimeId: ['runtimeId', 'runtime_id', 'runtimeSessionId', 'runtime_session_id'],
};

export class RequestTargetError extends Error {
  constructor(message, {
    code = 'invalid_target',
    status = 400,
    retryable = false,
    operationId,
    requestId,
    sourceRef,
    idempotencyKey,
    traceId,
    cause,
  } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'RequestTargetError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.operationId = operationId || '';
    this.requestId = requestId || '';
    this.sourceRef = sourceRef || '';
    this.idempotencyKey = idempotencyKey || '';
    this.traceId = traceId || '';
  }
}

function decodeIdentity(value, fieldName) {
  if (typeof value !== 'string') {
    throw new RequestTargetError(`${fieldName} must be a string`);
  }

  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch (cause) {
    throw new RequestTargetError(`${fieldName} is not valid URL encoding`, { cause });
  }

  const normalized = decoded.trim();
  if (!normalized) {
    throw new RequestTargetError(`${fieldName} is required`);
  }
  return normalized;
}

function readIdentity(input, fieldName) {
  const aliases = IDENTITY_FIELDS[fieldName];
  const present = aliases.filter((key) => input[key] !== undefined && input[key] !== null);
  if (present.length === 0) return null;

  const values = present.map((key) => decodeIdentity(input[key], fieldName));
  if (new Set(values).size > 1) {
    throw new RequestTargetError(`${fieldName} fields conflict`);
  }
  return values[0];
}

/**
 * Resolve a Claw request to the local ViewerWorker only.
 *
 * This function deliberately does not inspect UI focus, process state, agent
 * names, parentId, or any other ambient state. The caller must provide the
 * resource identity explicitly; agentId is required for the current local
 * ViewerWorker request surface.
 */
export function resolveRuntimeTarget(input = {}, { viewerOrigin = VIEWER_ORIGIN } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new RequestTargetError('runtime target must be an object');
  }

  const agentId = readIdentity(input, 'agentId');
  if (!agentId) {
    throw new RequestTargetError('agentId is required');
  }

  const sessionId = readIdentity(input, 'sessionId');
  const runtimeId = readIdentity(input, 'runtimeId');

  return {
    scope: 'local',
    agentId,
    sessionId,
    runtimeId,
    viewerOrigin,
  };
}

export function resolveProxyTarget(req, options = {}) {
  const explicitAgentId = req?.params?.agentId;
  const pathname = String(req?.originalUrl || '').split(/[?#]/, 1)[0];
  const match = pathname.match(/^\/api\/agents\/([^/]+)(?:\/|$)/);

  if (!match) {
    if (pathname.startsWith('/api/agents/')) {
      throw new RequestTargetError('agentId is required');
    }
    return explicitAgentId === undefined
      ? null
      : resolveRuntimeTarget({ agentId: explicitAgentId }, options);
  }

  const pathTarget = resolveRuntimeTarget({ agentId: match[1] }, options);
  if (explicitAgentId === undefined) return pathTarget;

  const parameterTarget = resolveRuntimeTarget({ agentId: explicitAgentId }, options);
  if (parameterTarget.agentId !== pathTarget.agentId) {
    throw new RequestTargetError('agentId fields conflict');
  }
  return parameterTarget;
}
