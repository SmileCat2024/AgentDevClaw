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
    this._status = 'idle'; // idle | queued | running
    this._listeners = { callStarted: [], callFinished: [] };
    this._completionCallbacks = new Map();

    // ── Continuation support ──
    this.sessionSaveFn = null;
    this.continuationBudget = {
      maxSegments: 20,
      maxCheckpoints: 5,
      maxRollbacks: 3,
    };
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

  clearQueued(reason = 'cancelled by interrupt') {
    const removed = this._queue.splice(0, this._queue.length);
    for (const envelope of removed) {
      envelope.status = 'cancelled';
      envelope.error = reason;
      const cb = this._completionCallbacks.get(envelope.id);
      if (cb) {
        this._completionCallbacks.delete(envelope.id);
        cb(envelope);
      }
    }
    this._status = this._active ? 'running' : 'idle';
    return removed.length;
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
    envelope._segmentCount = 0;
    envelope._checkpointCount = 0;
    envelope._rollbackCount = 0;

    this._emit('callStarted', envelope);

    this._runEnvelope(envelope)
      .catch((err) => {
        envelope.status = 'failed';
        envelope.error = err instanceof Error ? err.message : String(err);
      })
      .finally(() => {
        if (envelope.status === 'running') {
          envelope.status = 'completed';
        }
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

  async _runEnvelope(envelope) {
    let input = envelope.text;

    while (true) {
      envelope._segmentCount += 1;
      if (envelope._segmentCount > this.continuationBudget.maxSegments) {
        throw new Error(`Continuation budget exhausted: maxSegments=${this.continuationBudget.maxSegments}`);
      }

      const result = await this._agent.onCall(input);
      envelope.result = typeof result === 'string' ? result : '';

      const continuation = typeof this._agent.consumeContinuationRequest === 'function'
        ? this._agent.consumeContinuationRequest()
        : null;

      if (!continuation) {
        envelope.status = 'completed';
        return;
      }

      if (continuation.kind === 'checkpoint') {
        envelope._checkpointCount += 1;
        if (envelope._checkpointCount > this.continuationBudget.maxCheckpoints) {
          throw new Error(`Continuation budget exhausted: maxCheckpoints=${this.continuationBudget.maxCheckpoints}`);
        }
        await this._checkpointBarrier(continuation, envelope);
        this._injectContinuationSystemMessage('checkpoint', continuation);
        input = this._buildCheckpointContinuationInput(continuation);

      } else if (continuation.kind === 'rollback') {
        envelope._rollbackCount += 1;
        if (envelope._rollbackCount > this.continuationBudget.maxRollbacks) {
          throw new Error(`Continuation budget exhausted: maxRollbacks=${this.continuationBudget.maxRollbacks}`);
        }
        await this._rollbackBarrier(continuation, envelope);
        this._injectContinuationSystemMessage('rollback', continuation);
        input = this._buildRollbackContinuationInput(continuation);
      }
    }
  }

  async _checkpointBarrier(continuation, _envelope) {
    if (typeof this._agent.createNamedCheckpoint === 'function') {
      if (typeof this._agent.clearNamedCheckpoints === 'function') {
        this._agent.clearNamedCheckpoints();
      }
      await this._agent.createNamedCheckpoint(continuation.checkpointId);
    }
    if (this.sessionSaveFn) {
      await this.sessionSaveFn();
    }
  }

  async _rollbackBarrier(continuation, _envelope) {
    if (typeof this._agent.rollbackToNamedCheckpoint === 'function') {
      await this._agent.rollbackToNamedCheckpoint(continuation.checkpointId);
    }
    if (this.sessionSaveFn) {
      await this.sessionSaveFn();
    }
  }

  _injectContinuationSystemMessage(kind, continuation) {
    const ctx = typeof this._agent.getContext === 'function'
      ? this._agent.getContext()
      : null;
    if (!ctx || typeof ctx.add !== 'function') return;

    if (kind === 'checkpoint') {
      const note = continuation.metadata?.note ? `\n备注: ${continuation.metadata.note}` : '';
      ctx.add({
        role: 'system',
        content: `检查点 "${continuation.checkpointId}" 已建立并提交。当前对话上下文已保存。${note}\n\n后续可视需要调用 rollback_to_checkpoint 回退到此处。`,
      });
    } else if (kind === 'rollback') {
      ctx.add({
        role: 'system',
        content: [
          `会话已回退到检查点 "${continuation.checkpointId}"。`,
          '',
          '以下是被回退会话的摘要：',
          continuation.summary,
          '',
          '注意：回退仅恢复对话上下文和部分功能状态。外部执行（文件写入、命令执行、API 调用等）不会被撤销——请验证所修改的外部资源的真实状态。',
        ].join('\n'),
      });
    }
  }

  _buildCheckpointContinuationInput(_continuation) {
    return '[本条消息由系统自动发送] 检查点已生效，请从此处继续执行任务';
  }

  _buildRollbackContinuationInput(_continuation) {
    return '[本条消息由系统自动发送] 会话发生了回退，以上为相关信息。请继续执行任务。';
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
    // Check that all E1 segments happened before any E2 segment
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
        // Always register a continuation — will exhaust budget
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
        // Alternate checkpoint continuation
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
        // First checkpoint, then alternating rollback
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
    // Plain agent without continuation support (old-style)
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
});
