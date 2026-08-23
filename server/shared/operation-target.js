/**
 * Local operation target boundaries for Claw-owned /protoclaw routes.
 *
 * Host targets are always this process and never derive an agent from page
 * focus. Session and runtime observations require both logical agent and
 * session identities supplied by the caller.
 */

export class OperationTargetError extends Error {
  constructor(message, { code = 'invalid_target', status = 400 } = {}) {
    super(message);
    this.name = 'OperationTargetError';
    this.code = code;
    this.status = status;
  }
}

function requiredText(value, fieldName) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new OperationTargetError(`${fieldName} is required`);
  }
  return value.trim();
}

/**
 * Resolve a local Host/Global operation. The result intentionally contains no
 * page-focus fallback or remote/connection target.
 */
export function resolveHostTarget(input = {}) {
  return {
    scope: 'local-host',
    agentId: typeof input?.agentId === 'string' && input.agentId.trim()
      ? input.agentId.trim()
      : null,
  };
}

/** Resolve an explicitly named logical Agent without scanning other agents. */
export function resolveAgentTarget(input = {}) {
  return {
    scope: 'agent',
    agentId: requiredText(input?.agentId, 'agentId'),
  };
}

/** Resolve a Session-owned Claw operation without scanning other agents. */
export function resolveSessionTarget(input = {}) {
  return {
    scope: 'session',
    agentId: requiredText(input?.agentId, 'agentId'),
    sessionId: requiredText(input?.sessionId, 'sessionId'),
  };
}

/** Resolve a runtime observation owned by one explicit session. */
export function resolveRuntimeObservationTarget(input = {}) {
  return {
    scope: 'runtime',
    agentId: requiredText(input?.agentId, 'agentId'),
    sessionId: requiredText(input?.sessionId, 'sessionId'),
  };
}

/** Resolve a runtime control request addressed by runtimeId or sessionId. */
export function resolveRuntimeControlTarget(input = {}) {
  const agentId = requiredText(input?.agentId, 'agentId');
  const runtimeId = typeof input?.runtimeId === 'string' && input.runtimeId.trim()
    ? input.runtimeId.trim()
    : null;
  const sessionId = typeof input?.sessionId === 'string' && input.sessionId.trim()
    ? input.sessionId.trim()
    : null;
  if (!runtimeId && !sessionId) {
    throw new OperationTargetError('runtimeId or sessionId is required');
  }
  return { scope: 'runtime', agentId, runtimeId, sessionId };
}
