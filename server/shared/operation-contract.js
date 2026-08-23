import { randomUUID } from 'node:crypto';

export const LOCAL_OPERATION_ERROR_CODES = Object.freeze({
  INVALID_TARGET: 'invalid_target',
  TARGET_NOT_FOUND: 'target_not_found',
  RUNTIME_NOT_READY: 'runtime_not_ready',
  TRANSPORT_UNAVAILABLE: 'transport_unavailable',
  REQUEST_TIMEOUT: 'request_timeout',
  OPERATION_REJECTED: 'operation_rejected',
  OPERATION_RESULT_UNKNOWN: 'operation_result_unknown',
});

const STABLE_CODES = new Set(Object.values(LOCAL_OPERATION_ERROR_CODES));
const LEGACY_CODE_MAP = new Map([
  ['agent_not_found', LOCAL_OPERATION_ERROR_CODES.TARGET_NOT_FOUND],
  ['session_not_found', LOCAL_OPERATION_ERROR_CODES.TARGET_NOT_FOUND],
  ['runtime_not_found', LOCAL_OPERATION_ERROR_CODES.TARGET_NOT_FOUND],
  ['runtime_not_accepting_input', LOCAL_OPERATION_ERROR_CODES.RUNTIME_NOT_READY],
  ['local_runtime_not_ready', LOCAL_OPERATION_ERROR_CODES.RUNTIME_NOT_READY],
  ['delivery_unavailable', LOCAL_OPERATION_ERROR_CODES.TRANSPORT_UNAVAILABLE],
  ['transport_unavailable', LOCAL_OPERATION_ERROR_CODES.TRANSPORT_UNAVAILABLE],
  ['input_mode_conflict', LOCAL_OPERATION_ERROR_CODES.OPERATION_REJECTED],
  ['invalid_input', LOCAL_OPERATION_ERROR_CODES.OPERATION_REJECTED],
  ['thread_handoff_images_unsupported', LOCAL_OPERATION_ERROR_CODES.OPERATION_REJECTED],
  ['timeout', LOCAL_OPERATION_ERROR_CODES.REQUEST_TIMEOUT],
]);

const RETRYABLE_CODES = new Set([
  LOCAL_OPERATION_ERROR_CODES.RUNTIME_NOT_READY,
  LOCAL_OPERATION_ERROR_CODES.TRANSPORT_UNAVAILABLE,
  LOCAL_OPERATION_ERROR_CODES.REQUEST_TIMEOUT,
]);

const MAX_ID_LENGTH = 256;

function cleanId(value) {
  return typeof value === 'string' ? value.trim().slice(0, MAX_ID_LENGTH) : '';
}

function normalizeCode(error, status) {
  const rawCode = cleanId(error?.code || error?.errorCode);
  if (STABLE_CODES.has(rawCode)) return rawCode;
  if (LEGACY_CODE_MAP.has(rawCode)) return LEGACY_CODE_MAP.get(rawCode);
  if (error?.resultUnknown === true) return LOCAL_OPERATION_ERROR_CODES.OPERATION_RESULT_UNKNOWN;
  if (status === 408 || error?.timedOut === true) return LOCAL_OPERATION_ERROR_CODES.REQUEST_TIMEOUT;
  if (status === 404) return LOCAL_OPERATION_ERROR_CODES.TARGET_NOT_FOUND;
  if (status === 502 || status === 503 || error?.transport === true) {
    return LOCAL_OPERATION_ERROR_CODES.TRANSPORT_UNAVAILABLE;
  }
  return LOCAL_OPERATION_ERROR_CODES.OPERATION_REJECTED;
}

export function normalizeOperationMetadata(input = {}, { prefix = 'operation' } = {}) {
  const operationId = cleanId(input.operationId);
  const requestId = cleanId(input.requestId);
  const sourceRef = cleanId(input.sourceRef);
  const idempotencyKey = cleanId(input.idempotencyKey);
  const traceId = cleanId(input.traceId);
  return {
    ...(operationId ? { operationId } : {}),
    ...(requestId ? { requestId } : {}),
    ...(sourceRef ? { sourceRef } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
    ...(traceId ? { traceId } : {}),
    ...(input.createOperationId === true
      ? { operationId: operationId || `${String(prefix || 'operation').replace(/[^a-zA-Z0-9._:-]/g, '').slice(0, 64) || 'operation'}:${randomUUID()}` }
      : {}),
  };
}

export function createOperationMetadata(input = {}, options = {}) {
  return normalizeOperationMetadata({ ...input, createOperationId: true }, options);
}

export function attachOperationMetadata(error, metadata = {}) {
  if (!error || typeof error !== 'object') return error;
  const normalized = normalizeOperationMetadata(metadata);
  for (const [key, value] of Object.entries(normalized)) {
    if (value && !error[key]) error[key] = value;
  }
  return error;
}

export class LocalOperationError extends Error {
  constructor(message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'LocalOperationError';
    this.code = options.code;
    this.status = options.status;
    this.retryable = options.retryable;
    this.operationId = cleanId(options.operationId);
    this.requestId = cleanId(options.requestId);
    this.sourceRef = cleanId(options.sourceRef);
    this.idempotencyKey = cleanId(options.idempotencyKey);
    this.traceId = cleanId(options.traceId);
    this.resultUnknown = options.resultUnknown === true;
    this.timedOut = options.timedOut === true;
    this.transport = options.transport === true;
  }
}

export function buildLocalFailureResponse(error, metadata = {}) {
  const status = Number(error?.statusCode || error?.status) || 500;
  const normalizedMetadata = normalizeOperationMetadata({
    ...metadata,
    operationId: error?.operationId || metadata.operationId,
    requestId: error?.requestId || metadata.requestId,
    sourceRef: error?.sourceRef || metadata.sourceRef,
    idempotencyKey: error?.idempotencyKey || metadata.idempotencyKey,
    traceId: error?.traceId || metadata.traceId,
  });
  const code = normalizeCode(error, status);
  const message = String(error?.message || error?.error || 'Local operation failed');
  const retryable = typeof error?.retryable === 'boolean'
    ? error.retryable
    : RETRYABLE_CODES.has(code);
  return {
    ok: false,
    code,
    retryable,
    operationId: normalizedMetadata.operationId || null,
    message,
    // Keep the legacy field so existing clients continue to render failures.
    error: message,
    ...(cleanId(error?.code) && !STABLE_CODES.has(cleanId(error.code))
      ? { legacyCode: cleanId(error.code) }
      : {}),
    ...Object.fromEntries(Object.entries(normalizedMetadata).filter(([key]) => key !== 'operationId')),
  };
}

export function readOperationMetadata(input = {}) {
  const headers = input?.headers || {};
  const headerValue = (name) => headers[name] || headers[name.toLowerCase()] || '';
  return normalizeOperationMetadata({
    ...(input?.body && typeof input.body === 'object' ? input.body : {}),
    ...(input?.query && typeof input.query === 'object' ? input.query : {}),
    operationId: input?.operationId || input?.body?.operationId || input?.query?.operationId || headerValue('x-operation-id'),
    requestId: input?.requestId || input?.body?.requestId || input?.query?.requestId || headerValue('x-request-id'),
    traceId: input?.traceId || input?.body?.traceId || input?.query?.traceId || headerValue('x-trace-id'),
    idempotencyKey: input?.idempotencyKey || input?.body?.idempotencyKey || input?.query?.idempotencyKey || headerValue('x-idempotency-key'),
  });
}

export function localOperationStatus(error) {
  return Number(error?.statusCode || error?.status) || 500;
}
