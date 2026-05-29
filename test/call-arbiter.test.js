/**
 * Tests for CallArbiter (defined in scripts/run-prebuilt-agent.js)
 *
 * Covers: serialization guarantee, enqueue/drain, waitForCompletion,
 * event listeners, error handling.
 *
 * We extract and test the CallArbiter class in isolation.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ── Inline CallArbiter (mirrors the class in run-prebuilt-agent.js) ──

class CallArbiter {
  constructor(agentInstance) {
    this._agent = agentInstance;
    this._queue = [];
    this._active = false;
    this._activeEnvelope = null;
    this._status = 'idle';
    this._listeners = { callStarted: [], callFinished: [] };
    this._completionCallbacks = new Map();
  }

  enqueue(envelope) {
    const entry = {
      id: envelope.id || `arbiter-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      source: envelope.source || 'unknown',
      sourceRef: envelope.sourceRef || '',
      text: envelope.text,
      status: 'queued',
      createdAt: Date.now(),
      result: null,
      error: null,
    };
    this._queue.push(entry);
    this._status = 'queued';
    this._kick();
    return entry;
  }

  on(event, fn) {
    if (this._listeners[event]) {
      this._listeners[event].push(fn);
    }
  }

  waitForCompletion(envelopeId) {
    return new Promise((resolve) => {
      this._completionCallbacks.set(envelopeId, resolve);
    });
  }

  getStatus() {
    return {
      status: this._status,
      queueLength: this._queue.length,
      activeEnvelopeId: this._activeEnvelope?.id || null,
    };
  }

  _emit(event, envelope) {
    for (const fn of this._listeners[event] || []) {
      try { fn(envelope); } catch (err) {
        console.error(`[CallArbiter] ${event} listener error:`, err);
      }
    }
  }

  _kick() {
    if (this._active || this._queue.length === 0) return;
    this._active = true;
    this._activeEnvelope = this._queue.shift();
    this._status = 'running';

    const envelope = this._activeEnvelope;
    envelope.status = 'running';

    this._emit('callStarted', envelope);

    Promise.resolve()
      .then(() => this._agent.onCall(envelope.text))
      .then((result) => {
        envelope.status = 'completed';
        envelope.result = typeof result === 'string' ? result : '';
      })
      .catch((err) => {
        envelope.status = 'failed';
        envelope.error = err instanceof Error ? err.message : String(err);
      })
      .finally(() => {
        this._active = false;
        this._status = this._queue.length > 0 ? 'queued' : 'idle';
        this._emit('callFinished', envelope);
        const cb = this._completionCallbacks.get(envelope.id);
        if (cb) {
          this._completionCallbacks.delete(envelope.id);
          cb(envelope);
        }
        this._activeEnvelope = null;
        this._kick();
      });
  }
}

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
});
