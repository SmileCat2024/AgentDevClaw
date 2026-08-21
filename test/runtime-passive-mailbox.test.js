/**
 * Tests for the passive mailbox loop (scripts/runtime-passive-mailbox.js).
 *
 * Regression coverage for the "delivered but never consumed" bug: agents
 * without UserInputFeature never open an input lease, so external user-turns
 * land in ViewerWorker's mailbox with no idle consumer. The loop must
 * dequeue idle-time mailbox messages into the CallArbiter, transparently
 * forwarding source identity.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createPassiveMailboxLoop } from '../scripts/runtime-passive-mailbox.js';

function jsonResponse(body, ok = true) {
  return {
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  };
}

function createMockArbiter({
  status = 'idle',
  enqueueResult = { id: 'arb-1', status: 'queued' },
  completionDelayMs = 0,
} = {}) {
  const calls = { enqueued: [], waits: [], statusQueries: 0 };
  let statusOverride = status;
  return {
    calls,
    setStatus(next) { statusOverride = next; },
    getStatus() {
      calls.statusQueries++;
      return { status: statusOverride, queueLength: 0, activeEnvelopeId: null };
    },
    enqueue(envelope) {
      calls.enqueued.push(envelope);
      return { ...enqueueResult, ...envelope, id: `arb-${calls.enqueued.length}` };
    },
    async waitForCompletion(id) {
      calls.waits.push(id);
      if (completionDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, completionDelayMs));
      }
    },
  };
}

function createHarness({ fetchImpl, arbiter } = {}) {
  let disposed = false;
  const ctx = {
    agent: { agentId: 'viewer-agent-1' },
    callArbiter: arbiter,
    isDisposed: () => disposed,
    pollIntervalMs: 1,
    viewerPort: '2026',
    ...(fetchImpl ? { fetchImpl } : {}),
  };
  const loop = createPassiveMailboxLoop(ctx);
  return {
    loop,
    dispose() { disposed = true; },
    ctx,
  };
}

// Wait until predicate() returns truthy or timeout (ms) elapses.
async function until(predicate, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  return predicate();
}

describe('createPassiveMailboxLoop', () => {
  it('dequeues an idle-time mailbox message and enqueues it with original source identity', async () => {
    const dequeueUrls = [];
    const arbiter = createMockArbiter();
    const harness = createHarness({
      arbiter,
      fetchImpl: async (url) => {
        dequeueUrls.push(String(url));
        return jsonResponse({ input: { text: 'ticket-002 指令', source: 'thread', sourceRef: 'cmd-f76896b3' } });
      },
    });
    const running = harness.loop.run();

    assert.ok(await until(() => arbiter.calls.enqueued.length === 1 && arbiter.calls.waits.length === 1));
    assert.match(dequeueUrls[0], /\/api\/agents\/viewer-agent-1\/dequeue-input$/);
    assert.equal(arbiter.calls.enqueued[0].source, 'thread');
    assert.equal(arbiter.calls.enqueued[0].sourceRef, 'cmd-f76896b3');
    assert.equal(arbiter.calls.enqueued[0].text, 'ticket-002 指令');

    harness.dispose();
    await running;
  });

  it('falls back to source "queued-input" when the mailbox item has no source', async () => {
    const arbiter = createMockArbiter();
    const harness = createHarness({
      arbiter,
      fetchImpl: async () => jsonResponse({ input: { text: 'plain message' }, remaining: 0 }),
    });
    const running = harness.loop.run();

    assert.ok(await until(() => arbiter.calls.enqueued.length === 1));
    assert.equal(arbiter.calls.enqueued[0].source, 'queued-input');
    assert.equal('sourceRef' in arbiter.calls.enqueued[0], false);

    harness.dispose();
    await running;
  });

  it('does not dequeue while the arbiter is busy', async () => {
    const arbiter = createMockArbiter({ status: 'running' });
    const fetchCalls = [];
    const harness = createHarness({
      arbiter,
      fetchImpl: async () => {
        fetchCalls.push(1);
        return jsonResponse({ input: { text: 'should not be consumed' } });
      },
    });
    const running = harness.loop.run();

    assert.ok(await until(() => arbiter.calls.statusQueries >= 3));
    assert.equal(fetchCalls.length, 0, 'busy arbiter must not trigger dequeues');

    harness.dispose();
    await running;
  });

  it('consumes serially: no further dequeue until the previous envelope settles', async () => {
    let releaseEnvelope;
    const gate = new Promise((resolve) => { releaseEnvelope = resolve; });
    const arbiter = createMockArbiter();
    arbiter.waitForCompletion = async (id) => {
      arbiter.calls.waits.push(id);
      await gate; // hold the envelope open
    };
    let mailbox = [{ text: 'first' }, { text: 'second' }];
    const harness = createHarness({
      arbiter,
      fetchImpl: async () => jsonResponse({ input: mailbox.shift() ?? null, remaining: mailbox.length }),
    });
    const running = harness.loop.run();

    assert.ok(await until(() => arbiter.calls.waits.length === 1));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(arbiter.calls.enqueued.length, 1, 'must not dequeue the next message while waiting');

    releaseEnvelope();
    assert.ok(await until(() => arbiter.calls.enqueued.length === 2));

    harness.dispose();
    await running;
  });

  it('keeps polling after transient fetch failures and skips empty mailboxes', async () => {
    const arbiter = createMockArbiter();
    let attempt = 0;
    const harness = createHarness({
      arbiter,
      fetchImpl: async () => {
        attempt++;
        if (attempt === 1) throw new Error('ECONNREFUSED');
        if (attempt === 2) return jsonResponse(null, false); // HTTP 500
        if (attempt === 3) return jsonResponse({ input: null });
        return jsonResponse({ input: { text: 'recovered', source: 'cli' } });
      },
    });
    const running = harness.loop.run();

    assert.ok(await until(() => arbiter.calls.enqueued.length === 1));
    assert.equal(arbiter.calls.enqueued[0].text, 'recovered');
    assert.equal(attempt, 4);

    harness.dispose();
    await running;
  });

  it('exits promptly once the session is disposed', async () => {
    const arbiter = createMockArbiter();
    const harness = createHarness({
      arbiter,
      fetchImpl: async () => jsonResponse({ input: { text: 'late' } }),
    });
    const running = harness.loop.run();
    harness.dispose();
    await running; // resolves without consuming anything

    assert.equal(arbiter.calls.enqueued.length, 0);
    assert.equal(arbiter.calls.statusQueries, 0);
  });

  it('skips iterations while agent or arbiter are not yet attached', async () => {
    const arbiter = createMockArbiter();
    const fetchCalls = [];
    const ctx = {
      agent: null,
      callArbiter: arbiter,
      isDisposed: () => false,
      pollIntervalMs: 1,
      viewerPort: '2026',
      fetchImpl: async () => {
        fetchCalls.push(1);
        return jsonResponse({ input: { text: 'x' } });
      },
    };
    const loop = createPassiveMailboxLoop(ctx);
    const running = loop.run();

    assert.ok(await until(() => arbiter.calls.statusQueries === 0 && fetchCalls.length === 0 && Date.now() > 0));
    // status is never queried because agentId is missing → no fetch, no crash
    assert.equal(arbiter.calls.statusQueries, 0);

    ctx.agent = { agentId: 'viewer-agent-late' };
    assert.ok(await until(() => arbiter.calls.enqueued.length === 1));
    ctx.isDisposed = () => true;
    await running;
  });
});
