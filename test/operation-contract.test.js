import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LOCAL_OPERATION_ERROR_CODES,
  LocalOperationError,
  buildLocalFailureResponse,
  createOperationMetadata,
  normalizeOperationMetadata,
} from '../server/shared/operation-contract.js';

test('normalizes operation metadata without conflating identifiers', () => {
  assert.deepEqual(normalizeOperationMetadata({
    operationId: ' op-1 ',
    requestId: 'request-1',
    sourceRef: 'event-1',
    idempotencyKey: 'write-1',
    traceId: 'trace-1',
    focusedAgentId: 'ui-only',
  }), {
    operationId: 'op-1',
    requestId: 'request-1',
    sourceRef: 'event-1',
    idempotencyKey: 'write-1',
    traceId: 'trace-1',
  });

  const generated = createOperationMetadata({ operation: 'user-turn' }, { prefix: 'user-turn' });
  assert.match(generated.operationId, /^user-turn:/);
  assert.equal(Object.hasOwn(generated, 'focusedAgentId'), false);
});

test('builds a stable local failure while retaining the legacy error field', () => {
  const response = buildLocalFailureResponse(new LocalOperationError(
    'runtime is not connected',
    {
      code: 'runtime_not_ready',
      status: 503,
      retryable: true,
      operationId: 'input:1',
    },
  ));

  assert.deepEqual(response, {
    ok: false,
    code: 'runtime_not_ready',
    retryable: true,
    operationId: 'input:1',
    message: 'runtime is not connected',
    error: 'runtime is not connected',
  });
  assert.equal(Object.hasOwn(response, 'focusedAgentId'), false);
});

test('maps legacy local failures to the stable machine-readable codes', () => {
  const mappings = [
    ['agent_not_found', 'target_not_found', false],
    ['runtime_not_accepting_input', 'runtime_not_ready', true],
    ['input_mode_conflict', 'operation_rejected', false],
    ['delivery_unavailable', 'transport_unavailable', true],
  ];
  for (const [legacyCode, code, retryable] of mappings) {
    const response = buildLocalFailureResponse({
      message: legacyCode,
      code: legacyCode,
      status: 409,
    }, { operationId: `op:${legacyCode}` });
    assert.equal(response.code, code);
    assert.equal(response.retryable, retryable);
    assert.equal(response.operationId, `op:${legacyCode}`);
    assert.equal(response.legacyCode, legacyCode);
  }

  assert.deepEqual(Object.keys(LOCAL_OPERATION_ERROR_CODES).sort(), [
    'INVALID_TARGET',
    'OPERATION_REJECTED',
    'OPERATION_RESULT_UNKNOWN',
    'REQUEST_TIMEOUT',
    'RUNTIME_NOT_READY',
    'TARGET_NOT_FOUND',
    'TRANSPORT_UNAVAILABLE',
  ]);
});
