/**
 * Tests for server/runtime-call-envelope.js
 *
 * Covers: CallEnvelope factory, RuntimeInbox operations, execution state,
 * status updates, and lookup helpers.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createCallEnvelope,
  ensureRuntimeInbox,
  enqueueRuntimeEnvelope,
  peekRuntimeEnvelope,
  dequeueRuntimeEnvelope,
  getRuntimeInboxSnapshot,
  updateEnvelopeStatus,
  getRuntimeExecutionState,
  refreshRuntimeExecutionState,
  listRuntimeExecutionStates,
  findEnvelopeById,
  findEnvelopesBySourceRef,
  resetAllInboxes,
  EnvelopeStatus,
  EnvelopeSource,
  DeliveryMode,
  ReplyPolicy,
} from '../server/runtime-call-envelope.js';

describe('CallEnvelope factory', () => {
  it('creates envelope with defaults', () => {
    const env = createCallEnvelope();
    assert.ok(env.id.startsWith('env-'));
    assert.equal(env.status, EnvelopeStatus.PENDING);
    assert.equal(env.source, EnvelopeSource.SYSTEM);
    assert.equal(env.deliveryMode, DeliveryMode.POLL);
    assert.equal(env.replyPolicy, ReplyPolicy.NONE);
    assert.equal(env.text, '');
    assert.equal(env.result, null);
    assert.equal(env.error, null);
  });

  it('creates envelope with provided params', () => {
    const env = createCallEnvelope({
      runtimeKey: 'agent1::sess1',
      agentId: 'agent1',
      sessionId: 'sess1',
      source: EnvelopeSource.DISPATCH,
      sourceRef: 'sched-123',
      text: 'hello world',
      deliveryMode: DeliveryMode.DIRECT,
      replyPolicy: ReplyPolicy.ORIGIN_ONLY,
    });
    assert.equal(env.runtimeKey, 'agent1::sess1');
    assert.equal(env.agentId, 'agent1');
    assert.equal(env.sessionId, 'sess1');
    assert.equal(env.source, EnvelopeSource.DISPATCH);
    assert.equal(env.sourceRef, 'sched-123');
    assert.equal(env.text, 'hello world');
    assert.equal(env.deliveryMode, DeliveryMode.DIRECT);
    assert.equal(env.replyPolicy, ReplyPolicy.ORIGIN_ONLY);
  });

  it('handles non-string text gracefully', () => {
    const env = createCallEnvelope({ text: undefined });
    assert.equal(env.text, '');
    const env2 = createCallEnvelope({ text: 42 });
    assert.equal(env2.text, '');
  });
});

describe('RuntimeInbox operations', () => {
  beforeEach(() => resetAllInboxes());

  it('ensureRuntimeInbox creates inbox on first access', () => {
    const inbox = ensureRuntimeInbox('rt::1');
    assert.deepEqual(inbox.queue, []);
    assert.equal(inbox.activeEnvelopeId, null);
    assert.ok(inbox.updatedAt);
  });

  it('ensureRuntimeInbox returns existing inbox', () => {
    const a = ensureRuntimeInbox('rt::1');
    a.queue.push('test');
    const b = ensureRuntimeInbox('rt::1');
    assert.equal(b.queue.length, 1);
  });

  it('enqueueRuntimeEnvelope sets status to queued', () => {
    const env = createCallEnvelope({ runtimeKey: 'rt::1' });
    const result = enqueueRuntimeEnvelope(env);
    assert.equal(result.status, EnvelopeStatus.QUEUED);
    const inbox = ensureRuntimeInbox('rt::1');
    assert.equal(inbox.queue.length, 1);
    assert.equal(inbox.queue[0], env);
  });

  it('peekRuntimeEnvelope returns front without removing', () => {
    const env1 = createCallEnvelope({ runtimeKey: 'rt::1', text: 'first' });
    const env2 = createCallEnvelope({ runtimeKey: 'rt::1', text: 'second' });
    enqueueRuntimeEnvelope(env1);
    enqueueRuntimeEnvelope(env2);

    const peeked = peekRuntimeEnvelope('rt::1');
    assert.equal(peeked.text, 'first');
    const inbox = ensureRuntimeInbox('rt::1');
    assert.equal(inbox.queue.length, 2); // nothing removed
  });

  it('peekRuntimeEnvelope returns null for empty or nonexistent inbox', () => {
    assert.equal(peekRuntimeEnvelope('rt::nonexistent'), null);
    ensureRuntimeInbox('rt::empty');
    assert.equal(peekRuntimeEnvelope('rt::empty'), null);
  });

  it('dequeueRuntimeEnvelope removes and tracks active', () => {
    const env1 = createCallEnvelope({ runtimeKey: 'rt::1', text: 'first' });
    const env2 = createCallEnvelope({ runtimeKey: 'rt::1', text: 'second' });
    enqueueRuntimeEnvelope(env1);
    enqueueRuntimeEnvelope(env2);

    const dequeued = dequeueRuntimeEnvelope('rt::1');
    assert.equal(dequeued.text, 'first');
    const inbox = ensureRuntimeInbox('rt::1');
    assert.equal(inbox.queue.length, 1);
    assert.equal(inbox.activeEnvelopeId, env1.id);
  });

  it('getRuntimeInboxSnapshot returns serialisable data', () => {
    const env = createCallEnvelope({
      runtimeKey: 'rt::1',
      source: EnvelopeSource.VIEWER_INPUT,
      text: 'a'.repeat(100),
    });
    enqueueRuntimeEnvelope(env);

    const snapshot = getRuntimeInboxSnapshot('rt::1');
    assert.equal(snapshot.runtimeKey, 'rt::1');
    assert.equal(snapshot.queueLength, 1);
    assert.ok(snapshot.envelopes[0].text.endsWith('...'));
    assert.ok(snapshot.updatedAt);
  });

  it('getRuntimeInboxSnapshot returns empty for nonexistent', () => {
    const snapshot = getRuntimeInboxSnapshot('rt::none');
    assert.equal(snapshot.queueLength, 0);
    assert.equal(snapshot.activeEnvelopeId, null);
    assert.equal(snapshot.updatedAt, null);
  });
});

describe('updateEnvelopeStatus', () => {
  beforeEach(() => resetAllInboxes());

  it('updates envelope in queue', () => {
    const env = createCallEnvelope({ runtimeKey: 'rt::1' });
    enqueueRuntimeEnvelope(env);

    const updated = updateEnvelopeStatus(env.id, {
      status: EnvelopeStatus.COMPLETED,
      result: 'done',
    });
    assert.ok(updated);
    assert.equal(updated.status, EnvelopeStatus.COMPLETED);
    assert.equal(updated.result, 'done');
  });

  it('updates active envelope and clears activeEnvelopeId', () => {
    const env = createCallEnvelope({ runtimeKey: 'rt::1' });
    enqueueRuntimeEnvelope(env);
    dequeueRuntimeEnvelope('rt::1');

    const inbox = ensureRuntimeInbox('rt::1');
    assert.equal(inbox.activeEnvelopeId, env.id);

    const updated = updateEnvelopeStatus(env.id, {
      status: EnvelopeStatus.COMPLETED,
    });
    assert.ok(updated);
    assert.equal(inbox.activeEnvelopeId, null);
  });

  it('returns null for unknown envelope', () => {
    assert.equal(updateEnvelopeStatus('nonexistent'), null);
  });
});

describe('Execution state', () => {
  beforeEach(() => resetAllInboxes());

  it('getRuntimeExecutionState defaults to idle', () => {
    const state = getRuntimeExecutionState('rt::1');
    assert.equal(state.status, 'idle');
    assert.equal(state.activeEnvelopeId, null);
    assert.equal(state.queueLength, 0);
  });

  it('refreshRuntimeExecutionState reflects queue', () => {
    const env = createCallEnvelope({ runtimeKey: 'rt::1' });
    enqueueRuntimeEnvelope(env);
    const state = refreshRuntimeExecutionState('rt::1');
    assert.equal(state.status, 'queued');
    assert.equal(state.queueLength, 1);
  });

  it('refreshRuntimeExecutionState reflects active envelope', () => {
    const env = createCallEnvelope({ runtimeKey: 'rt::1' });
    enqueueRuntimeEnvelope(env);
    dequeueRuntimeEnvelope('rt::1');
    const state = refreshRuntimeExecutionState('rt::1');
    assert.equal(state.status, 'running');
    assert.equal(state.activeEnvelopeId, env.id);
  });

  it('refreshRuntimeExecutionState returns to idle after completion', () => {
    const env = createCallEnvelope({ runtimeKey: 'rt::1' });
    enqueueRuntimeEnvelope(env);
    dequeueRuntimeEnvelope('rt::1');
    updateEnvelopeStatus(env.id, { status: EnvelopeStatus.COMPLETED });
    const state = refreshRuntimeExecutionState('rt::1');
    assert.equal(state.status, 'idle');
    assert.equal(state.queueLength, 0);
  });

  it('listRuntimeExecutionStates returns all states', () => {
    getRuntimeExecutionState('rt::1');
    getRuntimeExecutionState('rt::2');
    const all = listRuntimeExecutionStates();
    assert.ok(all.length >= 2);
    const keys = all.map(s => s.runtimeKey);
    assert.ok(keys.includes('rt::1'));
    assert.ok(keys.includes('rt::2'));
  });
});

describe('Lookup helpers', () => {
  beforeEach(() => resetAllInboxes());

  it('findEnvelopeById finds envelope across inboxes', () => {
    const env = createCallEnvelope({ runtimeKey: 'rt::1', text: 'target' });
    enqueueRuntimeEnvelope(env);
    const found = findEnvelopeById(env.id);
    assert.ok(found);
    assert.equal(found.text, 'target');
  });

  it('findEnvelopeById returns null for unknown', () => {
    assert.equal(findEnvelopeById('nonexistent'), null);
  });

  it('findEnvelopesBySourceRef finds matching envelopes', () => {
    const env1 = createCallEnvelope({ runtimeKey: 'rt::1', sourceRef: 'sched-A' });
    const env2 = createCallEnvelope({ runtimeKey: 'rt::1', sourceRef: 'sched-B' });
    const env3 = createCallEnvelope({ runtimeKey: 'rt::2', sourceRef: 'sched-A' });
    enqueueRuntimeEnvelope(env1);
    enqueueRuntimeEnvelope(env2);
    enqueueRuntimeEnvelope(env3);

    const results = findEnvelopesBySourceRef('sched-A');
    assert.equal(results.length, 2);
  });
});
