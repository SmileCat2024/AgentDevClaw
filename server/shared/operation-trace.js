import { randomUUID } from 'node:crypto';
import { recordSidebarDiagnosticEvent } from './sidebar-diagnostics.js';
import { createOperationMetadata, normalizeOperationMetadata } from './operation-contract.js';

const MAX_OPERATION_ID_LENGTH = 128;
const RESERVED_TRACE_FIELDS = new Set([
  'operationId', 'requestId', 'sourceRef', 'idempotencyKey', 'traceId',
  'operation', 'phase', 'agentId', 'sessionId',
  'elapsedMs', 'phaseDurationMs',
]);

export function normalizeOperationId(value, prefix = 'sidebar') {
  const normalized = typeof value === 'string'
    ? value.trim().replace(/[^a-zA-Z0-9._:-]/g, '').slice(0, MAX_OPERATION_ID_LENGTH)
    : '';
  return normalized || `${prefix}:${randomUUID()}`;
}

function safeTraceFields(fields = {}) {
  const result = {};
  for (const [key, value] of Object.entries(fields || {})) {
    if (RESERVED_TRACE_FIELDS.has(key)) continue;
    if (value == null) continue;
    if (typeof value === 'string') {
      result[key] = value.slice(0, 256);
      continue;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      result[key] = value;
    }
  }
  return result;
}

export function createOperationTrace({ operationId, operation, agentId, sessionId, requestId, sourceRef, idempotencyKey, traceId, diagnosticWriter } = {}) {
  const metadata = createOperationMetadata({
    operationId: normalizeOperationId(operationId, operation || 'sidebar'),
    requestId,
    sourceRef,
    idempotencyKey,
    traceId,
  }, { prefix: operation || 'sidebar' });
  const id = metadata.operationId;
  const startedAt = Date.now();
  let lastAt = startedAt;

  return {
    ...normalizeOperationMetadata(metadata),

    mark(phase, fields = {}) {
      const now = Date.now();
      const payload = {
        ...normalizeOperationMetadata(metadata),
        operation: String(operation || 'sidebar').slice(0, 64),
        phase: String(phase || 'unknown').slice(0, 64),
        agentId: String(agentId || '').slice(0, 128),
        sessionId: String(sessionId || '').slice(0, 128),
        elapsedMs: now - startedAt,
        phaseDurationMs: now - lastAt,
        ...safeTraceFields(fields),
      };
      lastAt = now;
      console.info(`[SIDEBAR_OPERATION] ${JSON.stringify(payload)}`);
      const persist = typeof diagnosticWriter === 'function'
        ? diagnosticWriter
        : recordSidebarDiagnosticEvent;
      try {
        Promise.resolve(persist({
          kind: 'operation_phase',
          source: 'server',
          timestamp: now,
          ...payload,
        }, { source: 'server' })).catch(e => console.warn(e));
      } catch {}
      return payload;
    },
  };
}
