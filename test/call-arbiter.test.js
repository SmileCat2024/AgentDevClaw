/**
 * Tests for CallArbiter (server/call-arbiter.js)
 *
 * Covers: serialization guarantee, enqueue/drain, waitForCompletion,
 * event listeners, error handling, continuation (checkpoint/rollback),
 * budget enforcement, supplement buffer.
 *
 * Imports the REAL CallArbiter class — no inline mirror.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CallArbiter } from '../server/call-arbiter.js';

// ── Helpers ──

function makeSlowAgent(delayMs) {
  const callLog = [];
  return {
    onCall: async (text) => {
      callLog.push({ text, start: Date.now() });
      await new Promise(r => setTimeout(r, delayMs));
      callLog[callLog.length - 1].end = Date.now();
      return `result:${text}`;
    },
    callLog,
  };
}

/**
 * Agent mock that registers a checkpoint continuation on the first call,
 * then completes normally on subsequent calls.
 */
function makeCheckpointAgent(opts = {}) {
  const { checkpointId = 'cp-1', sessionSaveDelay = 0 } = opts;
  const calls = [];
  let _continuation = null;
  const checkpoints = [];
  const _ctxMessages = [];

  return {
    onCall: async (text) => {
      calls.push(text);
      if (calls.length === 1) {
        _continuation = { kind: 'checkpoint', checkpointId };
        return 'checkpoint requested';
      }
      return 'done after checkpoint';
    },
    consumeContinuationRequest: () => {
      const req = _continuation;
      _continuation = null;
      return req;
    },
    createNamedCheckpoint: async (id) => {
      checkpoints.push(id);
      if (sessionSaveDelay > 0) await new Promise(r => setTimeout(r, sessionSaveDelay));
    },
    rollbackToNamedCheckpoint: async (_id) => {},
    getContext: () => ({ add: (msg) => { _ctxMessages.push(msg); } }),
    calls,
    checkpoints,
    ctxMessages: _ctxMessages,
  };
}

/**
 * Agent mock that does checkpoint → explore → rollback → complete.
 * Segment 1: checkpoint(cp-1)
 * Segment 2: explore (returns normally, no continuation)
 * Segment 3: rollback(cp-1, summary)
 * Segment 4: final completion
 */
function makeCheckpointRollbackAgent() {
  const calls = [];
  let _continuation = null;
  const checkpoints = [];
  const rollbacks = [];
  const _ctxMessages = [];

  return {
    onCall: async (text) => {
      calls.push(text);
      const segmentIndex = calls.length;

      if (segmentIndex === 1) {
        // Original task: agent decides to checkpoint
        _continuation = { kind: 'checkpoint', checkpointId: 'cp-1' };
        return 'checkpoint established';
      }
      if (segmentIndex === 2) {
        // Continuation after checkpoint: agent explores
        _continuation = { kind: 'rollback', checkpointId: 'cp-1', summary: 'Tried approach A, failed because B.' };
        return 'exploration failed';
      }
      // After rollback: final completion
      return 'task completed after rollback';
    },
    consumeContinuationRequest: () => {
      const req = _continuation;
      _continuation = null;
      return req;
    },
    createNamedCheckpoint: async (id) => { checkpoints.push(id); },
    rollbackToNamedCheckpoint: async (id) => { rollbacks.push(id); },
    getContext: () => ({ add: (msg) => { _ctxMessages.push(msg); } }),
    calls,
    checkpoints,
    rollbacks,
    ctxMessages: _ctxMessages,
  };
}

// ── Tests ──

describe('CallArbiter', () => {
  it('enqueues and processes a single call', async () => {
    const agent = makeSlowAgent(10);
    const arbiter = new CallArbiter(agent);
    const entry = arbiter.enqueue({ source: 'test', text: 'hello' });
    // Entry may be 'running' immediately since _kick() runs synchronously
    assert.ok(['queued', 'running'].includes(entry.status));
    const finished = await arbiter.waitForCompletion(entry.id);
    assert.equal(finished.status, 'completed');
    assert.equal(finished.result, 'result:hello');
  });

  it('serializes multiple calls', async () => {
    const agent = makeSlowAgent(50);
    const arbiter = new CallArbiter(agent);

    const e1 = arbiter.enqueue({ source: 'test', text: 'first' });
    const e2 = arbiter.enqueue({ source: 'test', text: 'second' });
    const e3 = arbiter.enqueue({ source: 'test', text: 'third' });

    const [f1, f2, f3] = await Promise.all([
      arbiter.waitForCompletion(e1.id),
      arbiter.waitForCompletion(e2.id),
      arbiter.waitForCompletion(e3.id),
    ]);

    assert.equal(f1.result, 'result:first');
    assert.equal(f2.result, 'result:second');
    assert.equal(f3.result, 'result:third');

    // Verify serialization: each call should have non-overlapping execution window
    assert.ok(f1.start !== undefined || agent.callLog[0].end !== undefined);
    assert.ok(
      agent.callLog[0].end <= agent.callLog[1].start + 5, // allow 5ms tolerance
      'Second call should start after first finishes'
    );
    assert.ok(
      agent.callLog[1].end <= agent.callLog[2].start + 5,
      'Third call should start after second finishes'
    );
  });

  it('handles onCall errors gracefully', async () => {
    const agent = {
      onCall: async () => { throw new Error('boom'); },
    };
    const arbiter = new CallArbiter(agent);
    const entry = arbiter.enqueue({ source: 'test', text: 'fail' });
    const finished = await arbiter.waitForCompletion(entry.id);
    assert.equal(finished.status, 'failed');
    assert.equal(finished.error, 'boom');
  });

  // ── Structured call outcome consumption ──
  // onCall() returning without throwing does NOT imply completion: model
  // request failures / interrupts / step limits surface only via the
  // structured CallOutcome. The envelope must honor it.

  function makeOutcomeAgent(outcome, continuation = null) {
    let _continuation = continuation;
    return {
      onCall: async (text) => `result:${text}`,
      getLastCallOutcome: () => outcome,
      consumeContinuationRequest: () => {
        const req = _continuation;
        _continuation = null;
        return req;
      },
    };
  }

  it('marks envelope failed when the call outcome reports a model failure', async () => {
    const agent = makeOutcomeAgent({
      status: 'failed',
      reason: 'error',
      response: 'result:hello',
      steps: 3,
      error: { category: 'rate_limit', message: 'rate limited', retryable: true },
    }, { kind: 'checkpoint', checkpointId: 'cp-leak' });
    const arbiter = new CallArbiter(agent);
    const entry = arbiter.enqueue({ source: 'test', text: 'hello' });
    const finished = await arbiter.waitForCompletion(entry.id);

    assert.equal(finished.status, 'failed');
    assert.equal(finished.error, 'rate limited');
    assert.equal(finished.outcome.status, 'failed');
    assert.equal(finished.outcome.reason, 'error');
    assert.equal(finished.outcome.error.category, 'rate_limit');
    // A continuation registered just before termination must not leak
    assert.equal(agent.consumeContinuationRequest(), null);
  });

  it('marks envelope cancelled when the call outcome reports a user interrupt', async () => {
    const agent = makeOutcomeAgent({
      status: 'cancelled',
      reason: 'cancelled',
      response: 'result:hello',
      steps: 2,
    });
    const arbiter = new CallArbiter(agent);
    const entry = arbiter.enqueue({ source: 'test', text: 'hello' });
    const finished = await arbiter.waitForCompletion(entry.id);

    assert.equal(finished.status, 'cancelled');
    assert.equal(finished.outcome.status, 'cancelled');
  });

  it('records the outcome summary on normally completed envelopes', async () => {
    const agent = makeOutcomeAgent({
      status: 'completed',
      reason: 'completed',
      response: 'result:hello',
      steps: 5,
      model: { providerStopReason: 'end_turn' },
    });
    const arbiter = new CallArbiter(agent);
    const entry = arbiter.enqueue({ source: 'test', text: 'hello' });
    const finished = await arbiter.waitForCompletion(entry.id);

    assert.equal(finished.status, 'completed');
    assert.equal(finished.outcome.status, 'completed');
    assert.equal(finished.outcome.steps, 5);
    assert.deepEqual(finished.outcome.model, { providerStopReason: 'end_turn' });
  });

  it('falls back to completed for agents without structured outcomes', async () => {
    const agent = makeSlowAgent(5);
    const arbiter = new CallArbiter(agent);
    const entry = arbiter.enqueue({ source: 'test', text: 'hello' });
    const finished = await arbiter.waitForCompletion(entry.id);
    assert.equal(finished.status, 'completed');
    assert.equal(finished.outcome, undefined);
  });

  it('emits callStarted and callFinished events', async () => {
    const agent = makeSlowAgent(10);
    const arbiter = new CallArbiter(agent);
    const started = [];
    const finished = [];
    arbiter.on('callStarted', (env) => started.push(env));
    arbiter.on('callFinished', (env) => finished.push(env));

    const entry = arbiter.enqueue({ source: 'test', text: 'event-test' });
    await arbiter.waitForCompletion(entry.id);

    assert.equal(started.length, 1);
    assert.equal(started[0].text, 'event-test');
    assert.equal(finished.length, 1);
    assert.equal(finished[0].status, 'completed');
  });

  it('getStatus reflects current state', async () => {
    const agent = makeSlowAgent(50);
    const arbiter = new CallArbiter(agent);

    assert.equal(arbiter.getStatus().status, 'idle');

    const e1 = arbiter.enqueue({ source: 'test', text: 's1' });
    // May be 'running' or 'queued' depending on async scheduling
    const s = arbiter.getStatus();
    assert.ok(['queued', 'running'].includes(s.status));
    assert.ok(s.activeEnvelopeId === e1.id || s.queueLength > 0);

    await arbiter.waitForCompletion(e1.id);
    assert.equal(arbiter.getStatus().status, 'idle');
  });

  it('never runs two calls concurrently', async () => {
    let concurrentCount = 0;
    let maxConcurrent = 0;
    const agent = {
      onCall: async (text) => {
        concurrentCount++;
        maxConcurrent = Math.max(maxConcurrent, concurrentCount);
        await new Promise(r => setTimeout(r, 30));
        concurrentCount--;
        return 'ok';
      },
    };
    const arbiter = new CallArbiter(agent);

    const entries = [];
    for (let i = 0; i < 5; i++) {
      entries.push(arbiter.enqueue({ source: 'test', text: `c${i}` }));
    }
    await Promise.all(entries.map(e => arbiter.waitForCompletion(e.id)));

    assert.equal(maxConcurrent, 1, 'Should never have more than 1 concurrent onCall');
  });

  // ── Continuation (multi-segment envelope) tests ──

  it('runs multi-segment envelope with checkpoint continuation', async () => {
    const agent = makeCheckpointAgent({ checkpointId: 'cp-test' });
    const arbiter = new CallArbiter(agent);

    const entry = arbiter.enqueue({ source: 'test', text: 'do task with checkpoint' });
    const finished = await arbiter.waitForCompletion(entry.id);

    assert.equal(finished.status, 'completed');
    assert.equal(finished.result, 'done after checkpoint');
    assert.equal(agent.calls.length, 2, 'should have 2 segments (checkpoint + continuation)');
    // System message should be injected before the user input
    assert.equal(agent.ctxMessages.length, 1, 'should have 1 system message for checkpoint continuation');
    assert.equal(agent.ctxMessages[0].role, 'system', 'continuation system message should have system role');
    assert.deepEqual(agent.checkpoints, ['cp-test'], 'checkpoint should be committed');
    assert.equal(finished._segmentCount, 2);
    assert.equal(finished._checkpointCount, 1);
  });

  it('runs checkpoint → explore → rollback → complete', async () => {
    const agent = makeCheckpointRollbackAgent();
    const arbiter = new CallArbiter(agent);

    const entry = arbiter.enqueue({ source: 'test', text: 'complex task' });
    const finished = await arbiter.waitForCompletion(entry.id);

    assert.equal(finished.status, 'completed');
    assert.equal(finished.result, 'task completed after rollback');
    assert.equal(agent.calls.length, 3, 'should have 3 onCall segments');
    assert.deepEqual(agent.checkpoints, ['cp-1'], 'checkpoint cp-1 should be created');
    assert.deepEqual(agent.rollbacks, ['cp-1'], 'rollback to cp-1 should be executed');

    // Verify system messages are injected for both checkpoint and rollback
    assert.equal(agent.ctxMessages.length, 2, 'should have 2 system messages (checkpoint + rollback)');
    assert.equal(agent.ctxMessages[0].role, 'system', 'checkpoint continuation should have system role');
    assert.equal(agent.ctxMessages[1].role, 'system', 'rollback continuation should have system role');
  });

  it('does not start E2 while E1 has pending continuation', async () => {
    const agent = makeCheckpointAgent({ sessionSaveDelay: 20 });
    const arbiter = new CallArbiter(agent);

    const e1 = arbiter.enqueue({ source: 'test', text: 'E1 with checkpoint' });
    const e2 = arbiter.enqueue({ source: 'test', text: 'E2 should wait' });

    const [f1, f2] = await Promise.all([
      arbiter.waitForCompletion(e1.id),
      arbiter.waitForCompletion(e2.id),
    ]);

    assert.equal(f1.status, 'completed');
    assert.equal(f2.status, 'completed');
    assert.equal(f1.result, 'done after checkpoint');
    assert.equal(f2.result, 'done after checkpoint');

    // E1 should have 2 segments, E2 should have 1
    assert.equal(f1._segmentCount, 2, 'E1 should have 2 segments');
    assert.equal(f2._segmentCount, 1, 'E2 should have 1 segment');

    // E1 should fully complete before E2 starts
    const e1CallsEnd = 2; // E1 used calls[0] and calls[1]
    assert.ok(agent.calls.length >= 3, 'E1 + E2 should produce at least 3 calls');
  });

  it('fires callStarted/callFinished once per envelope, not per segment', async () => {
    const agent = makeCheckpointRollbackAgent();
    const arbiter = new CallArbiter(agent);
    const started = [];
    const finished = [];
    arbiter.on('callStarted', (env) => started.push(env));
    arbiter.on('callFinished', (env) => finished.push(env));

    const entry = arbiter.enqueue({ source: 'test', text: 'multi-segment' });
    await arbiter.waitForCompletion(entry.id);

    assert.equal(started.length, 1, 'callStarted should fire once per envelope');
    assert.equal(finished.length, 1, 'callFinished should fire once per envelope');
    assert.equal(finished[0].status, 'completed');
  });

  it('enforces maxSegments budget', async () => {
    let _continuation = null;
    const agent = {
      onCall: async () => {
        _continuation = { kind: 'checkpoint', checkpointId: 'cp-loop' };
        return 'looping';
      },
      consumeContinuationRequest: () => {
        const req = _continuation;
        _continuation = null;
        return req;
      },
      createNamedCheckpoint: async () => {},
    };

    const arbiter = new CallArbiter(agent);
    arbiter.continuationBudget = { maxSegments: 3, maxCheckpoints: 10, maxRollbacks: 10 };

    const entry = arbiter.enqueue({ source: 'test', text: 'infinite checkpoint loop' });
    const finished = await arbiter.waitForCompletion(entry.id);

    assert.equal(finished.status, 'failed');
    assert.ok(finished.error.includes('maxSegments'), 'should fail with maxSegments budget error');
    assert.equal(finished._segmentCount, 4, 'should have tried 4 segments (3 max + 1 check)');
  });

  it('never retries framework step limits even when a feature is mounted', async () => {
    // Step-limit failures remain terminal; the API retry feature must not be consulted.
    const calls = [];
    let outcome = null;
    const agent = {
      onCall: async (text) => {
        calls.push(text);
        if (calls.length === 1) {
          outcome = { status: 'failed', reason: 'limit_reached', response: '', steps: 40 };
          return '';
        }
        outcome = { status: 'completed', reason: 'completed', response: 'done', steps: 2 };
        return 'done';
      },
      getLastCallOutcome: () => outcome,
      consumeContinuationRequest: () => null,
      features: {
        get: (name) => {
          if (name !== 'force-continuation') return null;
          return { requestApiErrorContinuation: () => { assert.fail('step limit is not a network error'); } };
        },
      },
    };

    const arbiter = new CallArbiter(agent);
    const entry = arbiter.enqueue({ source: 'test', text: 'long task' });
    const finished = await arbiter.waitForCompletion(entry.id);

    assert.equal(finished.status, 'failed');
    assert.equal(calls.length, 1);
    assert.equal(finished.outcome.reason, 'limit_reached');
  });

  it('closes envelope as failed on framework step limit without API retry', async () => {
    const calls = [];
    let outcome = null;
    const agent = {
      onCall: async (text) => {
        calls.push(text);
        outcome = { status: 'failed', reason: 'limit_reached', response: '', steps: 40 };
        return '';
      },
      getLastCallOutcome: () => outcome,
      consumeContinuationRequest: () => null,
      features: { get: () => null },
    };

    const arbiter = new CallArbiter(agent);
    const entry = arbiter.enqueue({ source: 'test', text: 'long task' });
    const finished = await arbiter.waitForCompletion(entry.id);

    assert.equal(finished.status, 'failed', 'no continuation → envelope fails honestly');
    assert.equal(calls.length, 1, 'no extra segment without continuation approval');
    assert.match(finished.error, /limit_reached/);
  });

  it('enforces maxCheckpoints budget', async () => {
    let _continuation = null;
    let segmentIdx = 0;
    const agent = {
      onCall: async () => {
        segmentIdx++;
        if (segmentIdx <= 4) {
          _continuation = { kind: 'checkpoint', checkpointId: `cp-${segmentIdx}` };
        }
        return 'ok';
      },
      consumeContinuationRequest: () => {
        const req = _continuation;
        _continuation = null;
        return req;
      },
      createNamedCheckpoint: async () => {},
    };

    const arbiter = new CallArbiter(agent);
    arbiter.continuationBudget = { maxSegments: 20, maxCheckpoints: 2, maxRollbacks: 10 };

    const entry = arbiter.enqueue({ source: 'test', text: 'too many checkpoints' });
    const finished = await arbiter.waitForCompletion(entry.id);

    assert.equal(finished.status, 'failed');
    assert.ok(finished.error.includes('maxCheckpoints'), 'should fail with maxCheckpoints budget error');
    assert.equal(finished._checkpointCount, 3, 'should have tried 3 checkpoints (2 max + 1 check)');
  });

  it('enforces maxRollbacks budget', async () => {
    let _continuation = null;
    let segmentIdx = 0;
    const agent = {
      onCall: async () => {
        segmentIdx++;
        if (segmentIdx === 1) {
          _continuation = { kind: 'checkpoint', checkpointId: 'cp-1' };
        } else if (segmentIdx <= 5) {
          _continuation = { kind: 'rollback', checkpointId: 'cp-1', summary: 'failed again' };
        }
        return 'ok';
      },
      consumeContinuationRequest: () => {
        const req = _continuation;
        _continuation = null;
        return req;
      },
      createNamedCheckpoint: async () => {},
      rollbackToNamedCheckpoint: async () => {},
    };

    const arbiter = new CallArbiter(agent);
    arbiter.continuationBudget = { maxSegments: 20, maxCheckpoints: 10, maxRollbacks: 2 };

    const entry = arbiter.enqueue({ source: 'test', text: 'rollback loop' });
    const finished = await arbiter.waitForCompletion(entry.id);

    assert.equal(finished.status, 'failed');
    assert.ok(finished.error.includes('maxRollbacks'), 'should fail with maxRollbacks budget error');
  });

  it('calls sessionSaveFn during barriers', async () => {
    const agent = makeCheckpointRollbackAgent();
    let saveCount = 0;
    const arbiter = new CallArbiter(agent);
    arbiter.sessionSaveFn = async () => { saveCount++; };

    const entry = arbiter.enqueue({ source: 'test', text: 'task' });
    await arbiter.waitForCompletion(entry.id);

    // checkpoint barrier saves once, rollback barrier saves once
    assert.equal(saveCount, 2, 'sessionSaveFn should be called for each barrier');
  });

  it('backward-compatible with agents lacking consumeContinuationRequest', async () => {
    const agent = {
      onCall: async (text) => `processed: ${text}`,
    };
    const arbiter = new CallArbiter(agent);
    const entry = arbiter.enqueue({ source: 'test', text: 'simple' });
    const finished = await arbiter.waitForCompletion(entry.id);

    assert.equal(finished.status, 'completed');
    assert.equal(finished.result, 'processed: simple');
    assert.equal(finished._segmentCount, 1);
  });

  // ── Queued-input routing tests (post-supplement-removal) ──
  // After the useArbiterQueue / supplement mechanism was removed,
  // queued-input source envelopes go through the normal queue path,
  // NOT the supplement buffer. They wait for the active call to finish
  // and then execute as a new onCall. Mid-call injection is handled
  // by the react-loop HTTP dequeue path, not by CallArbiter.

  it('routes queued-input to normal queue when agent is busy', async () => {
    const agent = makeSlowAgent(50);
    const arbiter = new CallArbiter(agent);

    // First call starts immediately (agent idle)
    const e1 = arbiter.enqueue({ source: 'test', text: 'main task' });

    // Wait a tick so agent is definitely active
    await new Promise(r => setTimeout(r, 5));

    // queued-input while agent is busy — should be queued, NOT supplemented
    const entry = arbiter.enqueue({ source: 'queued-input', text: 'additional info' });

    assert.equal(entry.status, 'queued', 'queued-input should be queued, not supplemented');
    assert.ok(!entry.id.startsWith('supp-'), 'should not use supplement id prefix');

    // drainSupplements should always return empty (mechanism removed)
    assert.equal(arbiter.drainSupplements().length, 0);

    // Both should complete
    await arbiter.waitForCompletion(e1.id);
    await arbiter.waitForCompletion(entry.id);
  });

  it('clearQueued removes all queued envelopes including queued-input source', async () => {
    const agent = makeSlowAgent(100);
    const arbiter = new CallArbiter(agent);

    const e1 = arbiter.enqueue({ source: 'test', text: 'main' });
    await new Promise(r => setTimeout(r, 5));

    // Queue a queued-input envelope (would have been supplemented before)
    const q1 = arbiter.enqueue({ source: 'queued-input', text: 'supp1' });
    // Queue a regular call
    const e2 = arbiter.enqueue({ source: 'test', text: 'next' });

    // Register waitForCompletion BEFORE clearQueued (clearQueued resolves it)
    const q1Promise = arbiter.waitForCompletion(q1.id);
    const e2Promise = arbiter.waitForCompletion(e2.id);

    const cleared = arbiter.clearQueued('test cancel');
    // 2 queued envelopes (queued-input + regular)
    assert.equal(cleared, 2, 'should clear all queued envelopes');

    // Both should be cancelled
    const fq1 = await q1Promise;
    const f2 = await e2Promise;
    assert.equal(fq1.status, 'cancelled');
    assert.equal(f2.status, 'cancelled');
    assert.equal(f2.error, 'test cancel');

    await arbiter.waitForCompletion(e1.id);
  });

  it('does not launch a continuation after the active envelope is interrupted', async () => {
    let releaseFirstCall;
    let continuation = null;
    const calls = [];
    const agent = {
      onCall: async (text) => {
        calls.push(text);
        await new Promise((resolve) => { releaseFirstCall = resolve; });
        continuation = { kind: 'checkpoint', checkpointId: 'late-checkpoint' };
        return 'interrupted segment result';
      },
      consumeContinuationRequest: () => {
        const value = continuation;
        continuation = null;
        return value;
      },
      createNamedCheckpoint: async () => {},
      getContext: () => ({ add() {} }),
    };
    const arbiter = new CallArbiter(agent);
    const envelope = arbiter.enqueue({ source: 'test', text: 'main' });
    await new Promise((resolve) => setTimeout(resolve, 5));

    const interruption = arbiter.interruptActive('user stopped', { clearQueue: true });
    assert.equal(interruption.active, true);
    releaseFirstCall();

    const finished = await arbiter.waitForCompletion(envelope.id);
    assert.equal(finished.status, 'cancelled');
    assert.equal(finished.error, 'user stopped');
    assert.deepEqual(calls, ['main'], 'continuation must not become a second onCall');
    assert.equal(continuation, null, 'late continuation request should be consumed and discarded');
  });

  it('queued-input arriving during interrupt is processed after call finishes', async () => {
    let releaseMain;
    const calls = [];
    const agent = {
      onCall: async (text) => {
        calls.push(text);
        if (calls.length === 1) {
          // First call blocks until released
          await new Promise((resolve) => { releaseMain = resolve; });
        }
        return 'done';
      },
    };
    const arbiter = new CallArbiter(agent);
    const envelope = arbiter.enqueue({ source: 'test', text: 'main' });
    await new Promise((resolve) => setTimeout(resolve, 5));

    // Interrupt with clearQueue=true — clears any pending items
    arbiter.interruptActive('user stopped', { clearQueue: true });

    // queued-input arrives while interrupt is unwinding — goes to normal queue
    const entry = arbiter.enqueue({ source: 'queued-input', text: 'late arrival' });
    assert.equal(entry.status, 'queued', 'queued-input should be queued normally');
    releaseMain();

    // The interrupted call should be cancelled
    const finished = await arbiter.waitForCompletion(envelope.id);
    assert.equal(finished.status, 'cancelled');

    // The late-arrival queued-input should execute after the interrupted call finishes
    const entryResult = await arbiter.waitForCompletion(entry.id);
    assert.equal(entryResult.status, 'completed');
    assert.deepEqual(calls, ['main', 'late arrival']);

    assert.equal(arbiter.getStatus().status, 'idle');
  });

  it('queued-input auto-processes after current call finishes', async () => {
    const agent = makeSlowAgent(30);
    const arbiter = new CallArbiter(agent);

    const e1 = arbiter.enqueue({ source: 'test', text: 'task1' });
    await new Promise(r => setTimeout(r, 5));

    // queued-input while busy — goes to normal queue
    const q1 = arbiter.enqueue({ source: 'queued-input', text: 'follow-up' });

    // Wait for e1 to complete
    await arbiter.waitForCompletion(e1.id);

    // The queued-input should be auto-processed by _kick in finally
    // Wait for it to complete
    const q1Result = await arbiter.waitForCompletion(q1.id);
    assert.equal(q1Result.status, 'completed');

    // Everything settled
    await new Promise(r => setTimeout(r, 50));
    assert.equal(arbiter.getStatus().status, 'idle');
  });

  it('drainSupplements always returns empty array (mechanism removed)', () => {
    const arbiter = new CallArbiter({ onCall: async () => '' });
    const result = arbiter.drainSupplements();
    assert.deepEqual(result, []);
  });

  it('_drainViewerQueuedInputs: picks up leftover messages after call completion', async () => {
    // Simulates: call completes, react-loop missed a queued message (e.g. maxTurns),
    // CallArbiter's safety net drains it from ViewerWorker and enqueues as new call.
    //
    // We stand up a tiny HTTP server that mimics the ViewerWorker dequeue endpoint.
    const http = await import('node:http');
    const queue = [
      { text: 'leftover-1' },
      { text: 'leftover-2', images: [{ type: 'image', source_type: 'base64', media_type: 'image/png', data: 'AAAA' }] },
    ];

    const server = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url?.includes('/dequeue-input')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (queue.length > 0) {
          res.end(JSON.stringify({ input: queue.shift() }));
        } else {
          res.end(JSON.stringify({ input: null }));
        }
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise(resolve => server.listen(0, resolve));
    const port = server.address().port;
    process.env.AGENTDEV_VIEWER_PORT = String(port);

    const agent = makeSlowAgent(10);
    agent.agentId = 'test-drain-agent';
    const arbiter = new CallArbiter(agent);

    // Run a normal call first
    const e1 = arbiter.enqueue({ source: 'test', text: 'main-task' });
    await arbiter.waitForCompletion(e1.id);

    // After the call, _drainViewerQueuedInputs should have run in .finally()
    // and enqueued the 2 leftover messages. Wait for them to complete.
    await new Promise(r => setTimeout(r, 100));

    // The agent should have processed all 3 messages: main-task + 2 leftovers
    assert.equal(agent.callLog.length, 3, 'agent should have processed main + 2 drained messages');
    assert.equal(agent.callLog[0].text, 'main-task');
    assert.equal(agent.callLog[1].text, 'leftover-1');
    assert.equal(agent.callLog[2].text, 'leftover-2');

    assert.equal(arbiter.getStatus().status, 'idle');

    server.close();
    delete process.env.AGENTDEV_VIEWER_PORT;
  });

  it('passes reminder identity to onCall and drops it on continuation segments', async () => {
    const onCallArgs = [];
    const agent = {
      onCall: async (text, images, activations, metadata, options) => {
        onCallArgs.push({ text, options });
        return 'ok';
      },
    };
    const arbiter = new CallArbiter(agent);

    const reminder = arbiter.enqueue({ source: 'shell', text: '[后台任务 bg-1 已完成]', kind: 'reminder' });
    await arbiter.waitForCompletion(reminder.id);
    const plain = arbiter.enqueue({ source: 'viewer-input', text: 'hello' });
    await arbiter.waitForCompletion(plain.id);

    assert.equal(onCallArgs.length, 2);
    // reminder envelope：身份只随首段传给 onCall（kind + source）
    assert.deepEqual(onCallArgs[0].options, { kind: 'reminder', source: 'shell' });
    // 普通 envelope：不传身份，框架走缺省 user 分支
    assert.equal(onCallArgs[1].options, undefined);
  });

  it('drain preserves the reminder kind of leftover mailbox items', async () => {
    const http = await import('node:http');
    const queue = [
      { text: '[后台任务 bg-3 已完成]', kind: 'reminder', source: 'shell', sourceRef: 'bg-3' },
    ];
    const server = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url?.includes('/dequeue-input')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (queue.length > 0) {
          res.end(JSON.stringify({ input: queue.shift() }));
        } else {
          res.end(JSON.stringify({ input: null }));
        }
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise(resolve => server.listen(0, resolve));
    process.env.AGENTDEV_VIEWER_PORT = String(server.address().port);

    const onCallArgs = [];
    const agent = {
      agentId: 'test-drain-reminder-agent',
      onCall: async (text, images, activations, metadata, options) => {
        onCallArgs.push({ text, options });
        return 'ok';
      },
    };
    const arbiter = new CallArbiter(agent);

    const e1 = arbiter.enqueue({ source: 'test', text: 'main-task' });
    await arbiter.waitForCompletion(e1.id);
    await new Promise(r => setTimeout(r, 100));

    // busy 期间积压的 reminder 在 call 结束后被安全网捞起时必须保住身份，
    // 不能退化成 user 消息落账
    assert.equal(onCallArgs.length, 2);
    assert.equal(onCallArgs[1].text, '[后台任务 bg-3 已完成]');
    assert.deepEqual(onCallArgs[1].options, { kind: 'reminder', source: 'shell' });

    server.close();
    delete process.env.AGENTDEV_VIEWER_PORT;
  });

  // ── Interrupt timing matrix (state-kernel 迁移基线，计划 §1.4 清单 8) ──
  // 特征测试：锁死 _interruptRequested 布尔 + 3 处检查点（段首 / onCall 返回后 /
  // 障碍后）+ 无 active envelope 的现状裁决。只记录现状、不判断对错；
  // 阶段 2 中断检查点收敛时以本矩阵为对照基线。
  // 落点全部用受控 Promise / fake agent 钩子精确编排，不依赖 sleep 竞态。

  function makeGate() {
    let open;
    const closed = new Promise((resolve) => { open = resolve; });
    return { closed, open };
  }

  it('interrupt before the segment-start check cancels without starting the next onCall segment', async () => {
    // 落点：多段 envelope 的"障碍后检查"已放行、下一段"段首检查"尚未执行
    // （下一段 onCall 尚未开始）。编排：continuation 系统消息注入发生在两个
    // 检查点之间（同步、无 await），在其 ctx.add 钩子里置位中断即可精确落点。
    const calls = [];
    let _continuation = null;
    let arbiter;
    const ctxMessages = [];
    const checkpoints = [];
    const agent = {
      onCall: async (text) => {
        calls.push(text);
        if (calls.length === 1) {
          _continuation = { kind: 'checkpoint', checkpointId: 'cp-seg-start' };
          return 'checkpoint registered';
        }
        return 'segment 2 (must never run)';
      },
      consumeContinuationRequest: () => {
        const req = _continuation;
        _continuation = null;
        return req;
      },
      createNamedCheckpoint: async (id) => { checkpoints.push(id); },
      getContext: () => ({
        add: (msg) => {
          ctxMessages.push(msg);
          // 此刻障碍后检查已通过、段首检查未到——中断恰好落在段首检查前
          arbiter.interruptActive('interrupt before segment start');
        },
      }),
    };
    arbiter = new CallArbiter(agent);
    const started = [];
    const finishedEvents = [];
    arbiter.on('callStarted', (env) => started.push(env));
    arbiter.on('callFinished', (env) => finishedEvents.push(env));

    const entry = arbiter.enqueue({ source: 'test', text: 'task' });
    const finished = await arbiter.waitForCompletion(entry.id);

    assert.equal(finished.status, 'cancelled');
    assert.equal(finished.error, 'interrupt before segment start');
    assert.deepEqual(calls, ['task'], 'second segment must never start');
    assert.equal(finished._segmentCount, 1);
    assert.deepEqual(checkpoints, ['cp-seg-start'], 'barrier fully completed before the interrupt landed');
    assert.equal(ctxMessages.length, 1, 'interrupt landed during the continuation system-message injection');
    assert.equal(started.length, 1, 'callStarted fires exactly once per envelope');
    assert.equal(finishedEvents.length, 1, 'callFinished fires exactly once per envelope');
    assert.equal(finishedEvents[0].status, 'cancelled');
  });

  it('interrupt while onCall is pending cancels after onCall returns without starting any continuation', async () => {
    const calls = [];
    let _continuation = null;
    const onCallEntered = makeGate();
    const releaseOnCall = makeGate();
    const agent = {
      onCall: async (text) => {
        calls.push(text);
        onCallEntered.open();
        await releaseOnCall.closed; // onCall 悬挂期间置位中断
        _continuation = { kind: 'checkpoint', checkpointId: 'late-registration' };
        return 'segment result';
      },
      consumeContinuationRequest: () => {
        const req = _continuation;
        _continuation = null;
        return req;
      },
    };
    const arbiter = new CallArbiter(agent);
    const entry = arbiter.enqueue({ source: 'test', text: 'main' });
    await onCallEntered.closed; // 确认 onCall 已开始并悬挂，此刻置位中断

    arbiter.interruptActive('interrupt mid-call');
    releaseOnCall.open(); // onCall 返回 → "onCall 返回后"检查点裁决

    const finished = await arbiter.waitForCompletion(entry.id);
    assert.equal(finished.status, 'cancelled');
    assert.equal(finished.error, 'interrupt mid-call');
    assert.deepEqual(calls, ['main'], 'no continuation segment may start');
    assert.equal(finished._segmentCount, 1);
    assert.equal(agent.consumeContinuationRequest(), null, 'late-registered continuation must be consumed and discarded');
    assert.equal(arbiter.getStatus().status, 'idle');
  });

  it('interrupt between onCall return and the outcome branch outranks the outcome terminal state', async () => {
    // 落点：onCall 已返回、结构化 outcome 正在观察（第二个检查点之前）。
    // 编排：getLastCallOutcome 在 onCall 的 await 恢复后同步调用——在其内部
    // 置位中断，使中断标志与 outcome=cancelled 同时在场，锁定裁决优先级：
    // 中断检查点先于 outcome 终态分支生效。
    const calls = [];
    let _continuation = null;
    let arbiter;
    const agent = {
      onCall: async (text) => {
        calls.push(text);
        _continuation = { kind: 'checkpoint', checkpointId: 'pre-outcome' };
        return 'segment result';
      },
      consumeContinuationRequest: () => {
        const req = _continuation;
        _continuation = null;
        return req;
      },
      getLastCallOutcome: () => {
        arbiter.interruptActive('interrupt at outcome observation');
        return {
          status: 'cancelled',
          reason: 'cancelled',
          steps: 2,
          error: { message: 'cancelled by user stop' },
        };
      },
    };
    arbiter = new CallArbiter(agent);
    const entry = arbiter.enqueue({ source: 'test', text: 'main' });
    const finished = await arbiter.waitForCompletion(entry.id);

    assert.equal(finished.status, 'cancelled');
    // 关键裁决：error 是中断理由而非 outcome.error.message——
    // 若 outcome 终态分支胜出，这里会是 'cancelled by user stop'
    assert.equal(finished.error, 'interrupt at outcome observation');
    // outcome 仍被完整记录（观察先于检查点），证明中断介入点在其后
    assert.equal(finished.outcome.status, 'cancelled');
    assert.equal(finished.outcome.error.message, 'cancelled by user stop');
    assert.equal(finished._segmentCount, 1);
    assert.equal(agent.consumeContinuationRequest(), null, 'continuation must not leak past the interrupt checkpoint');
  });

  it('interrupt inside the checkpoint barrier await cancels after the barrier without entering the next segment', async () => {
    const calls = [];
    let _continuation = null;
    const barrierEntered = makeGate();
    const releaseBarrier = makeGate();
    const agent = {
      onCall: async (text) => {
        calls.push(text);
        _continuation = { kind: 'checkpoint', checkpointId: 'cp-barrier' };
        return 'checkpoint registered';
      },
      consumeContinuationRequest: () => {
        const req = _continuation;
        _continuation = null;
        return req;
      },
      createNamedCheckpoint: async () => {
        barrierEntered.open();
        await releaseBarrier.closed; // 障碍悬挂期间置位中断
      },
    };
    const arbiter = new CallArbiter(agent);
    const entry = arbiter.enqueue({ source: 'test', text: 'main' });
    await barrierEntered.closed; // 确认障碍已进入并悬挂，此刻置位中断

    arbiter.interruptActive('interrupt during barrier');
    releaseBarrier.open(); // 障碍完成 → 障碍后检查点裁决

    const finished = await arbiter.waitForCompletion(entry.id);
    assert.equal(finished.status, 'cancelled');
    assert.equal(finished.error, 'interrupt during barrier');
    assert.deepEqual(calls, ['main'], 'must not enter the next segment');
    assert.equal(finished._segmentCount, 1);
    assert.equal(finished._checkpointCount, 1, 'the barrier itself completed (checkpoint committed)');
    assert.equal(arbiter.getStatus().status, 'idle');
  });

  it('interruptActive with no active envelope reports inactive and cancels the entire queue', async () => {
    const calls = [];
    const agent = {
      onCall: async (text) => { calls.push(text); return `done:${text}`; },
    };
    const arbiter = new CallArbiter(agent);

    // 完全空闲：无 active、无积压
    assert.deepEqual(arbiter.interruptActive('idle interrupt'), { active: false, cleared: 0 });

    // 构造"无 active envelope 但队列非空"的唯一窗口：E1 收口的 finally 里
    // _activeEnvelope 已置 null，而 drain → _kick 的微任务尚未运行；
    // waitForCompletion(E1) 的 await 恰好恢复在该窗口内（微任务 FIFO 保证）。
    const e1 = arbiter.enqueue({ source: 'test', text: 'first' });
    const e2 = arbiter.enqueue({ source: 'test', text: 'second' });
    const e3 = arbiter.enqueue({ source: 'test', text: 'third' });
    const e2Promise = arbiter.waitForCompletion(e2.id);
    const e3Promise = arbiter.waitForCompletion(e3.id);

    const f1 = await arbiter.waitForCompletion(e1.id);
    assert.equal(f1.status, 'completed');

    // 窗口内：E1 已收口，E2/E3 仍在队列等待被推迟的 _kick 拾起
    assert.equal(arbiter.getStatus().activeEnvelopeId, null);
    assert.equal(arbiter.getStatus().queueLength, 2);

    const result = arbiter.interruptActive('no active interrupt');
    assert.deepEqual(result, { active: false, cleared: 2 });

    const [f2, f3] = await Promise.all([e2Promise, e3Promise]);
    assert.equal(f2.status, 'cancelled');
    assert.equal(f2.error, 'no active interrupt');
    assert.equal(f3.status, 'cancelled');
    assert.equal(f3.error, 'no active interrupt');
    assert.deepEqual(calls, ['first'], 'queued envelopes must never execute');

    // 被推迟的 _kick 在空队列上空转
    await new Promise(r => setTimeout(r, 5));
    assert.equal(arbiter.getStatus().status, 'idle');
  });

  // ── _status 三态观察（计划 §1.4 清单 9）──
  // 特征测试：只锁现状。注意现状与计划措辞有出入——
  // 空闲 enqueue 后 getStatus() 观察到的是 running（enqueue 内先置 queued，
  // _kick 同步接管即改写为 running，'queued' 不可从空闲态外部观察）；
  // 运行中再 enqueue 反而落到 queued（enqueue 无条件置 queued，_kick 因
  // active 直接返回）——queued 在此的语义是"有积压"，与"是否已启动"正交。

  it('_status transitions: idle->running takeover, queued backlog while running, clearQueued fallback', async () => {
    const calls = [];
    const firstCallGate = makeGate();
    const agent = {
      onCall: async (text) => {
        calls.push(text);
        if (calls.length === 1) await firstCallGate.closed; // E1 悬挂以观察运行中状态
        return `done:${text}`;
      },
    };
    const arbiter = new CallArbiter(agent);

    // 空闲态
    assert.equal(arbiter.getStatus().status, 'idle');

    // 空闲时 enqueue：_kick 同步接管，观察值直接是 running
    const e1 = arbiter.enqueue({ source: 'test', text: 'first' });
    assert.equal(arbiter.getStatus().status, 'running');
    assert.equal(arbiter.getStatus().activeEnvelopeId, e1.id);
    assert.equal(arbiter.getStatus().queueLength, 0);

    // 运行中再 enqueue：状态变为 queued（积压标志），active 不变
    arbiter.enqueue({ source: 'test', text: 'second' });
    assert.equal(arbiter.getStatus().status, 'queued');
    assert.equal(arbiter.getStatus().activeEnvelopeId, e1.id, 'E1 remains the active envelope');
    assert.equal(arbiter.getStatus().queueLength, 1);

    // clearQueued 回落：active 存在 → running
    //（active 不存在 → idle 的分支由上方"无 active envelope"用例覆盖）
    assert.equal(arbiter.clearQueued('status probe'), 1);
    assert.equal(arbiter.getStatus().status, 'running');
    assert.equal(arbiter.getStatus().queueLength, 0);

    // E1 完成、队列已空 → finally 回落 idle
    firstCallGate.open();
    await arbiter.waitForCompletion(e1.id);
    assert.equal(arbiter.getStatus().status, 'idle');
    assert.deepEqual(calls, ['first'], 'cleared envelope must never execute');
  });
});

// ── C3 增量特征：中断事件队列 + _drainInterrupts（阶段 2 收敛）──
// interruptActive 不再写 envelope 任何字段：中断事件进 arbiter 级队列，
// 由 _runEnvelope 的三个 drain 点（段首 / onCall settle 后 / barrier settle 后）
// 收口。以下用例只锁增量语义；既有 36 用例是更全面的对照基线。

describe('CallArbiter interrupt event queue (C3)', () => {
  function makeGate() {
    let open;
    const closed = new Promise((resolve) => { open = resolve; });
    return { closed, open };
  }

  it('takes the last reason when multiple interrupt events queue for the same envelope', async () => {
    // 末值语义：旧机制下每次 interruptActive 都覆盖 envelope.error，最后
    // 一次的 reason 胜出；事件队列等价映射为取末条事件的 reason。
    const onCallEntered = makeGate();
    const releaseOnCall = makeGate();
    const agent = {
      onCall: async () => {
        onCallEntered.open();
        await releaseOnCall.closed; // onCall 悬挂期间排队多条中断事件
        return 'segment result';
      },
    };
    const arbiter = new CallArbiter(agent);
    const entry = arbiter.enqueue({ source: 'test', text: 'main' });
    await onCallEntered.closed;

    arbiter.interruptActive('first stop');
    arbiter.interruptActive('second stop');
    releaseOnCall.open(); // onCall 返回 → drain 点 1 裁决

    const finished = await arbiter.waitForCompletion(entry.id);
    assert.equal(finished.status, 'cancelled');
    assert.equal(finished.error, 'second stop', 'the last queued reason wins');
    assert.equal(finished._segmentCount, 1);
    assert.equal(arbiter.getStatus().status, 'idle');
  });

  it('silently drops interrupt events whose target envelope has already closed', async () => {
    // D6 宽容分支：E1 已终态、_activeEnvelope 尚未置 null 的 finally 窗口内
    // 到达的中断事件，目标已收口——后续 envelope 的 drain 必须静默丢弃，
    // 不得影响后续 envelope 的裁决，也不得对已收口 envelope 补写任何字段。
    const calls = [];
    const agent = {
      onCall: async (text) => { calls.push(text); return `done:${text}`; },
    };
    const arbiter = new CallArbiter(agent);
    let lateInterruptResult = null;
    arbiter.on('callFinished', (env) => {
      if (env.text === 'E1' && lateInterruptResult === null) {
        // 此刻 env 已 completed（终态），_activeEnvelope 仍指向它
        lateInterruptResult = arbiter.interruptActive('late for E1');
      }
    });

    const e1 = arbiter.enqueue({ source: 'test', text: 'E1' });
    const f1 = await arbiter.waitForCompletion(e1.id);
    assert.equal(f1.status, 'completed');
    assert.equal(f1.error, null, 'a closed envelope must not be mutated by a late interrupt event');
    assert.deepEqual(lateInterruptResult, { active: true, cleared: 0 });
    assert.equal(arbiter._interruptEvents.length, 1, 'late event sits in the queue until the next drain');

    // E2 正常执行：drain 在队列中找不到指向自己的事件，迟到条目被静默丢弃
    const e2 = arbiter.enqueue({ source: 'test', text: 'E2' });
    const f2 = await arbiter.waitForCompletion(e2.id);
    assert.equal(f2.status, 'completed');
    assert.equal(f2.result, 'done:E2');
    assert.equal(f2.error, null);
    assert.deepEqual(calls, ['E1', 'E2'], 'the late event must not affect the next envelope');
    assert.equal(arbiter._interruptEvents.length, 0, 'unmatched late entries are dropped by the drain');
  });

  it('does not enqueue interrupt events when there is no active envelope', async () => {
    const agent = { onCall: async () => 'ok' };
    const arbiter = new CallArbiter(agent);

    // 完全空闲：无 active、无积压
    assert.deepEqual(arbiter.interruptActive('idle interrupt'), { active: false, cleared: 0 });
    assert.equal(arbiter._interruptEvents.length, 0, 'idle interrupt must not leave residue in the event queue');

    // 跑完一个 envelope 回到 idle 后再中断：同样不入队
    const e1 = arbiter.enqueue({ source: 'test', text: 'main' });
    await arbiter.waitForCompletion(e1.id);
    await new Promise((resolve) => setTimeout(resolve, 5)); // 等 finally 链落定（_activeEnvelope 置 null）
    assert.deepEqual(arbiter.interruptActive('idle again'), { active: false, cleared: 0 });
    assert.equal(arbiter._interruptEvents.length, 0, 'no residual garbage after a completed envelope');
  });
});
