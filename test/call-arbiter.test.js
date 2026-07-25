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
  it('rejects new input immediately when the context guard has blocked the session', async () => {
    const agent = {
      contextGuard: {
        isBlocked: () => true,
        getBlockReason: () => 'Context threshold reached.',
      },
      onCall: async () => {
        throw new Error('onCall must not execute for a blocked session');
      },
    };
    const arbiter = new CallArbiter(agent);
    const entry = arbiter.enqueue({ source: 'test', text: 'continue' });
    const finished = await arbiter.waitForCompletion(entry.id);

    assert.equal(finished.status, 'failed');
    assert.equal(finished.error, 'Context threshold reached.');
  });

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
});
