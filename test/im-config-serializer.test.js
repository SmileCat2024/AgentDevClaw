/**
 * Tests for two P2 concerns from the f09eb007..HEAD diff:
 *
 * 1. withIMWorkspaceConfig — serialized read-modify-write promise queue.
 *    The core guarantee is that concurrent mutators execute sequentially,
 *    not interleaved. A rejection in one mutator must not break the chain.
 *
 * 2. GroupAdminFeature gc_dispatch — self-dispatch guard prevents the
 *    admin from dispatching tasks to itself (feedback loop prevention).
 *
 * 3. gc inbox queue — enqueue + dequeue semantics for the long-poll bridge.
 *
 * Inline-replicated from server.js and local-features/group-admin/src/index.ts.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ══════════════════════════════════════════════════════════════════
// 1. withIMWorkspaceConfig serializer
// ══════════════════════════════════════════════════════════════════

/**
 * Creates a serializer instance that mirrors the server.js pattern:
 *   - reads from a backing store
 *   - passes config to mutator
 *   - writes back if mutator returns truthy
 *   - chains operations via promise queue
 *   - swallows rejections so chain never breaks
 */
function createSerializer(initialConfig) {
  let _store = JSON.parse(JSON.stringify(initialConfig));
  let _chain = Promise.resolve();

  // Track execution order for tests
  const executionLog = [];

  function read() {
    return Promise.resolve(JSON.parse(JSON.stringify(_store)));
  }

  function write(config) {
    _store = JSON.parse(JSON.stringify(config));
    return Promise.resolve();
  }

  function withConfig(mutator, label) {
    const run = _chain.then(async () => {
      executionLog.push(`${label}:start`);
      const config = JSON.parse(JSON.stringify(_store));
      const shouldWrite = await mutator(config);
      if (shouldWrite) {
        await write(config);
      }
      executionLog.push(`${label}:end`);
      return config;
    });
    _chain = run.catch(() => {});
    return run;
  }

  function getStore() { return _store; }
  function getLog() { return executionLog; }

  return { withConfig, getStore, getLog };
}

describe('withIMWorkspaceConfig serializer', () => {

  describe('sequential execution', () => {
    it('executes mutators in submission order', async () => {
      const ser = createSerializer({ counter: 0 });

      // Submit 3 operations concurrently
      const promises = [
        ser.withConfig((c) => { c.counter += 1; return true; }, 'A'),
        ser.withConfig((c) => { c.counter += 1; return true; }, 'B'),
        ser.withConfig((c) => { c.counter += 1; return true; }, 'C'),
      ];

      await Promise.all(promises);

      // All three increments should be applied
      assert.equal(ser.getStore().counter, 3);

      // Execution should be strictly sequential: A fully completes before B starts
      const log = ser.getLog();
      const aStart = log.indexOf('A:start');
      const aEnd = log.indexOf('A:end');
      const bStart = log.indexOf('B:start');
      assert.ok(aEnd < bStart, 'A:end should come before B:start');
    });

    it('no interleaving: each mutator sees the result of the previous', async () => {
      const ser = createSerializer({ lines: [] });

      await Promise.all([
        ser.withConfig((c) => {
          c.lines.push({ id: 'line1', value: 'A' });
          return true;
        }, 'op1'),
        ser.withConfig((c) => {
          // Should see line1 added by op1
          c.lines.push({ id: 'line2', value: 'B' });
          return true;
        }, 'op2'),
      ]);

      const store = ser.getStore();
      assert.equal(store.lines.length, 2);
      assert.equal(store.lines[0].id, 'line1');
      assert.equal(store.lines[1].id, 'line2');
    });
  });

  describe('write gating', () => {
    it('writes when mutator returns true', async () => {
      const ser = createSerializer({ x: 0 });
      await ser.withConfig((c) => { c.x = 10; return true; }, 'op');
      assert.equal(ser.getStore().x, 10);
    });

    it('does not write when mutator returns false', async () => {
      const ser = createSerializer({ x: 0 });
      await ser.withConfig((c) => { c.x = 10; return false; }, 'op');
      assert.equal(ser.getStore().x, 0);
    });

    it('does not write when mutator returns undefined', async () => {
      const ser = createSerializer({ x: 0 });
      await ser.withConfig((c) => { c.x = 10; }, 'op');
      assert.equal(ser.getStore().x, 0);
    });
  });

  describe('error resilience', () => {
    it('chain survives mutator rejection', async () => {
      const ser = createSerializer({ counter: 0 });

      // First operation throws
      const failingPromise = ser.withConfig(() => {
        throw new Error('mutator failed');
      }, 'fail');

      // The failing promise should reject
      await assert.rejects(failingPromise, /mutator failed/);

      // But subsequent operations should still work
      await ser.withConfig((c) => { c.counter += 1; return true; }, 'after');
      assert.equal(ser.getStore().counter, 1);
    });

    it('chain survives mutator returning rejected promise', async () => {
      const ser = createSerializer({ counter: 0 });

      await assert.rejects(
        ser.withConfig(async () => { throw new Error('async fail'); }, 'fail'),
        /async fail/,
      );

      await ser.withConfig((c) => { c.counter += 1; return true; }, 'after');
      assert.equal(ser.getStore().counter, 1);
    });

    it('multiple failures in a row do not break chain', async () => {
      const ser = createSerializer({ counter: 0 });

      for (let i = 0; i < 3; i++) {
        try {
          await ser.withConfig(() => { throw new Error(`fail ${i}`); }, `fail${i}`);
        } catch {}
      }

      await ser.withConfig((c) => { c.counter = 42; return true; }, 'success');
      assert.equal(ser.getStore().counter, 42);
    });
  });

  describe('read-only mutators', () => {
    it('mutator can read config without modifying', async () => {
      const ser = createSerializer({ lines: [{ id: 'l1', carrier: 'qq' }] });
      let observed = null;

      await ser.withConfig((c) => {
        observed = c.lines.length;
        return false;
      }, 'read');

      assert.equal(observed, 1);
      assert.equal(ser.getStore().lines.length, 1);
    });
  });
});

// ══════════════════════════════════════════════════════════════════
// 2. GroupAdminFeature gc_dispatch self-dispatch guard
// ══════════════════════════════════════════════════════════════════

/**
 * Inline replication of the gc_dispatch guard logic.
 * Mirrors local-features/group-admin/src/index.ts gc_dispatch.execute.
 *
 * chatId is no longer a parameter — it is auto-resolved from the environment.
 * Tests only the validation/guard portion — the actual API call is mocked.
 */
function gcDispatchGuard(args) {
  const { text, identityRef, title } = args || {};
  if (!text || !identityRef || !title?.trim()) {
    return { error: 'text, identityRef, title are required' };
  }
  // 禁止向自己派发（防止反馈循环）
  if (identityRef === 'work-group:admin') {
    return { error: '不能向管理员自身派发任务' };
  }
  return { wouldDispatch: true };
}

describe('gc_dispatch self-dispatch guard', () => {

  it('allows dispatch to other identities', () => {
    const result = gcDispatchGuard({
      text: 'do something',
      identityRef: 'programming-helper:main',
      title: '测试任务',
    });
    assert.equal(result.wouldDispatch, true);
  });

  it('blocks dispatch to work-group:admin (self)', () => {
    const result = gcDispatchGuard({
      text: 'do something',
      identityRef: 'work-group:admin',
      title: '测试任务',
    });
    assert.ok(result.error);
    assert.match(result.error, /不能向管理员自身派发/);
    assert.equal(result.wouldDispatch, undefined);
  });

  it('requires text', () => {
    const result = gcDispatchGuard({ identityRef: 'helper:main', title: 't' });
    assert.ok(result.error);
    assert.match(result.error, /required/);
  });

  it('requires identityRef', () => {
    const result = gcDispatchGuard({ text: 'x', title: 't' });
    assert.ok(result.error);
    assert.match(result.error, /required/);
  });

  it('requires title', () => {
    const result = gcDispatchGuard({ text: 'x', identityRef: 'helper:main' });
    assert.ok(result.error);
    assert.match(result.error, /required/);
  });

  it('handles null args', () => {
    const result = gcDispatchGuard(null);
    assert.ok(result.error);
  });

  it('handles empty string values', () => {
    const result = gcDispatchGuard({ text: '', identityRef: '', title: '' });
    assert.ok(result.error);
  });
});

// ══════════════════════════════════════════════════════════════════
// 3. gc inbox queue (enqueue + long-poll wake)
// ══════════════════════════════════════════════════════════════════

/**
 * Inline replication of the gc inbox queue pattern from server.js.
 * Maps: runtimeKey → message[] and runtimeKey → pending callback.
 */
function createGcInbox() {
  const queue = new Map();       // runtimeKey → message[]
  const pendingPolls = new Map(); // runtimeKey → callback

  function enqueue(runtimeKey, msg) {
    if (!queue.has(runtimeKey)) queue.set(runtimeKey, []);
    queue.get(runtimeKey).push(msg);
    const cb = pendingPolls.get(runtimeKey);
    if (cb) {
      pendingPolls.delete(runtimeKey);
      cb(msg);
    }
  }

  function poll(runtimeKey) {
    const q = queue.get(runtimeKey);
    if (q && q.length > 0) {
      return Promise.resolve(q.shift());
    }
    return new Promise((resolve) => {
      pendingPolls.set(runtimeKey, resolve);
    });
  }

  function hasPending(runtimeKey) {
    return pendingPolls.has(runtimeKey);
  }

  function getQueueLength(runtimeKey) {
    return queue.get(runtimeKey)?.length || 0;
  }

  return { enqueue, poll, hasPending, getQueueLength };
}

describe('gc inbox queue', () => {
  let inbox;

  beforeEach(() => {
    inbox = createGcInbox();
  });

  it('enqueue then poll returns message immediately', async () => {
    inbox.enqueue('key1', { id: 'm1', text: 'hello' });
    const msg = await inbox.poll('key1');
    assert.equal(msg.id, 'm1');
  });

  it('poll then enqueue wakes the waiter', async () => {
    const pollPromise = inbox.poll('key1');
    assert.ok(inbox.hasPending('key1'));

    inbox.enqueue('key1', { id: 'm2', text: 'world' });

    const msg = await pollPromise;
    assert.equal(msg.id, 'm2');
    assert.ok(!inbox.hasPending('key1'));
  });

  it('multiple enqueues queue up before poll', async () => {
    inbox.enqueue('key1', { id: 'm1' });
    inbox.enqueue('key1', { id: 'm2' });
    inbox.enqueue('key1', { id: 'm3' });

    assert.equal(inbox.getQueueLength('key1'), 3);

    const m1 = await inbox.poll('key1');
    assert.equal(m1.id, 'm1');
    const m2 = await inbox.poll('key1');
    assert.equal(m2.id, 'm2');
    const m3 = await inbox.poll('key1');
    assert.equal(m3.id, 'm3');
  });

  it('different runtimeKeys are independent', async () => {
    inbox.enqueue('keyA', { id: 'a1' });
    inbox.enqueue('keyB', { id: 'b1' });

    const a = await inbox.poll('keyA');
    const b = await inbox.poll('keyB');
    assert.equal(a.id, 'a1');
    assert.equal(b.id, 'b1');
  });

  it('enqueue to non-pending key just queues', () => {
    inbox.enqueue('lonely', { id: 'x' });
    assert.equal(inbox.getQueueLength('lonely'), 1);
    assert.ok(!inbox.hasPending('lonely'));
  });

  it('enqueue wakes exactly one pending poll (FIFO)', async () => {
    // Only one poll can be pending per key (server.js pattern)
    const poll1 = inbox.poll('key1');
    assert.ok(inbox.hasPending('key1'));

    inbox.enqueue('key1', { id: 'wake1' });

    const msg = await poll1;
    assert.equal(msg.id, 'wake1');
    // After wake, no pending poll remains
    assert.ok(!inbox.hasPending('key1'));
  });
});
