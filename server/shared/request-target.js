import { VIEWER_ORIGIN } from './constants.js';

const IDENTITY_FIELDS = {
  agentId: ['agentId', 'agent_id', 'logicalAgentId', 'logical_agent_id'],
  sessionId: ['sessionId', 'session_id'],
  runtimeId: ['runtimeId', 'runtime_id', 'runtimeSessionId', 'runtime_session_id'],
};

// Query parameter names that address an agent and therefore carry the remote
// namespace when a request targets a remote connection.
const AGENT_QUERY_KEYS = new Set([
  ...IDENTITY_FIELDS.agentId,
  'agent',
]);

/**
 * Reserved identity prefix for remote-connection namespacing (ADR-0008 #4).
 * Server-side code composes `remote:<connectionId>:<agentId>`; the frontend
 * and Features treat the composed string as opaque.
 */
export const REMOTE_NAMESPACE_PREFIX = 'remote:';

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
 * Split a decoded agent identity into the remote namespace form. Returns null
 * for plain local identities. Connection ids cannot contain colons (the
 * ConnectionStore charset forbids them), so the second colon is an
 * unambiguous separator; the original agent id keeps everything after it.
 */
function parseRemoteNamespace(agentId) {
  if (!agentId.startsWith(REMOTE_NAMESPACE_PREFIX)) return null;

  const rest = agentId.slice(REMOTE_NAMESPACE_PREFIX.length);
  const separator = rest.indexOf(':');
  if (separator <= 0) {
    throw new RequestTargetError('remote agentId must be remote:<connectionId>:<agentId>');
  }
  const originalAgentId = rest.slice(separator + 1);
  if (!originalAgentId) {
    throw new RequestTargetError('remote agentId must be remote:<connectionId>:<agentId>');
  }
  return { connectionId: rest.slice(0, separator), agentId: originalAgentId };
}

function readConnection(findConnection, connectionId) {
  if (typeof findConnection === 'function') return findConnection(connectionId);
  return findConnection.getConnection(connectionId);
}

/**
 * Resolve a connection reference to a forwarding origin. The routing layer
 * stops at the local tunnel port (ADR-0008 #3): whatever backs the port —
 * SSH, Tailscale, or anything else — is invisible here.
 */
function resolveRemoteConnection(connectionId, findConnection) {
  const connection = findConnection ? readConnection(findConnection, connectionId) : null;
  if (!connection) {
    throw new RequestTargetError(`unknown remote connection: ${connectionId}`, {
      code: 'target_not_found',
      status: 404,
    });
  }
  if (connection.enabled !== true) {
    throw new RequestTargetError(`remote connection is disabled: ${connectionId}`, {
      code: 'transport_unavailable',
      status: 503,
      retryable: true,
    });
  }
  return connection;
}

function remoteOrigin(connection) {
  return `http://127.0.0.1:${connection.localPort}`;
}

function decodeSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

function decodeQueryValue(value) {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    return null;
  }
}

/**
 * Resolve a runtime request target. Plain identities resolve to the local
 * ViewerWorker exactly as before (ADR-0006); an identity carrying the reserved
 * `remote:` namespace resolves against the injected connection lookup and
 * yields the connection's local tunnel-port origin (ADR-0008 #3).
 *
 * This function deliberately does not inspect UI focus, process state, agent
 * names, parentId, or any other ambient state. The caller must provide the
 * resource identity explicitly; agentId is required for the current local
 * ViewerWorker request surface. `findConnection` may be a
 * `(connectionId) => connection | null` function or a store-like object
 * exposing `getConnection(id)`; it is injected so this module stays a pure,
 * testable routing layer with no singletons or I/O. Remote identities never
 * fall back to local resolution — an unresolved connection fails explicitly.
 */
export function resolveRuntimeTarget(input = {}, { viewerOrigin = VIEWER_ORIGIN, findConnection = null } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new RequestTargetError('runtime target must be an object');
  }

  const agentId = readIdentity(input, 'agentId');
  if (!agentId) {
    throw new RequestTargetError('agentId is required');
  }

  const sessionId = readIdentity(input, 'sessionId');
  const runtimeId = readIdentity(input, 'runtimeId');

  const namespace = parseRemoteNamespace(agentId);
  if (!namespace) {
    return {
      scope: 'local',
      agentId,
      sessionId,
      runtimeId,
      viewerOrigin,
    };
  }

  const connection = resolveRemoteConnection(namespace.connectionId, findConnection);
  return {
    scope: 'remote',
    connectionId: namespace.connectionId,
    agentId: namespace.agentId,
    sessionId,
    runtimeId,
    origin: remoteOrigin(connection),
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
  if (parameterTarget.agentId !== pathTarget.agentId
    || parameterTarget.scope !== pathTarget.scope
    || parameterTarget.connectionId !== pathTarget.connectionId) {
    throw new RequestTargetError('agentId fields conflict');
  }
  return parameterTarget;
}

/**
 * Restore original resource identities in a proxied URL before it leaves for
 * a remote origin: every path segment and every agent-addressing query
 * parameter carrying the target's `remote:<connectionId>:<agentId>` namespace
 * is rewritten to the plain agentId. Non-addressing query values and URLs for
 * local (or absent) targets pass through unchanged. Pure string rewriting —
 * no network, no I/O — ready for proxy integration (R1-06).
 */
export function rewriteProxyUrl(originalUrl, target) {
  const url = String(originalUrl);
  if (!target || target.scope !== 'remote') return url;

  const namespace = `${REMOTE_NAMESPACE_PREFIX}${target.connectionId}:${target.agentId}`;
  const [rawPath, ...queryParts] = url.split('?');
  const rewrittenPath = rawPath
    .split('/')
    .map((segment) => (decodeSegment(segment) === namespace
      ? encodeURIComponent(target.agentId)
      : segment))
    .join('/');

  const rawQuery = queryParts.join('?');
  if (!rawQuery) return rewrittenPath;

  const rewrittenQuery = rawQuery
    .split('&')
    .map((pair) => {
      const separator = pair.indexOf('=');
      if (separator === -1) return pair;
      const key = pair.slice(0, separator);
      if (!AGENT_QUERY_KEYS.has(key)) return pair;
      return decodeQueryValue(pair.slice(separator + 1)) === namespace
        ? `${key}=${encodeURIComponent(target.agentId)}`
        : pair;
    })
    .join('&');
  return `${rewrittenPath}?${rewrittenQuery}`;
}

/**
 * Resolve a host-scoped request target. Host operations stay local unless the
 * caller names a connection explicitly (ADR-0008 #5); UI focus and list
 * position never select the destination. Parsing capability only — no host
 * endpoint consumes this yet (reserved for R1-05).
 */
export function resolveHostTarget(input = {}, { findConnection = null } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new RequestTargetError('host target must be an object');
  }

  if (input.connectionId === undefined || input.connectionId === null) {
    return { scope: 'local' };
  }

  const connectionId = decodeIdentity(input.connectionId, 'connectionId');
  const connection = resolveRemoteConnection(connectionId, findConnection);
  return {
    scope: 'remote',
    connectionId,
    origin: remoteOrigin(connection),
  };
}
