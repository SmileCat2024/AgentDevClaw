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

  it('forwards the reminder kind of mailbox items to the arbiter envelope', async () => {
    const arbiter = createMockArbiter();
    const harness = createHarness({
      arbiter,
      fetchImpl: async () => jsonResponse({
        input: { text: '[后台任务 bg-1 已完成]', kind: 'reminder', source: 'shell', sourceRef: 'bg-1' },
      }),
    });
    const running = harness.loop.run();

    assert.ok(await until(() => arbiter.calls.enqueued.length === 1));
    assert.equal(arbiter.calls.enqueued[0].kind, 'reminder');
    assert.equal(arbiter.calls.enqueued[0].source, 'shell');

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

describe('createPassiveMailboxLoop viewer HTTP face addressing (ADR-0037 decision 3)', () => {
  const savedOrigin = process.env.AGENTDEV_VIEWER_ORIGIN;
  const savedToken = process.env.PROTOCLAW_INTERNAL_TOKEN;

  async function restoreEnv() {
    if (savedOrigin === undefined) delete process.env.AGENTDEV_VIEWER_ORIGIN;
    else process.env.AGENTDEV_VIEWER_ORIGIN = savedOrigin;
    if (savedToken === undefined) delete process.env.PROTOCLAW_INTERNAL_TOKEN;
    else process.env.PROTOCLAW_INTERNAL_TOKEN = savedToken;
  }

  it('dequeues from AGENTDEV_VIEWER_ORIGIN when the env is injected (deployment override)', async () => {
    process.env.AGENTDEV_VIEWER_ORIGIN = 'http://192.0.2.10:2526';
    delete process.env.PROTOCLAW_INTERNAL_TOKEN;
    const dequeueUrls = [];
    const arbiter = createMockArbiter();
    const harness = createHarness({
      arbiter,
      fetchImpl: async (url) => {
        dequeueUrls.push(String(url));
        return jsonResponse({ input: { text: 'via-origin' } });
      },
    });
    const running = harness.loop.run();

    try {
      assert.ok(await until(() => arbiter.calls.enqueued.length === 1));
      assert.ok(
        dequeueUrls[0].startsWith('http://192.0.2.10:2526/api/agents/'),
        `dequeue must target the injected origin, got: ${dequeueUrls[0]}`,
      );
    } finally {
      harness.dispose();
      await running;
      await restoreEnv();
    }
  });

  it('explicit ctx.viewerOrigin wins over the env (test injection precedence)', async () => {
    process.env.AGENTDEV_VIEWER_ORIGIN = 'http://192.0.2.10:2526';
    delete process.env.PROTOCLAW_INTERNAL_TOKEN;
    const dequeueUrls = [];
    const arbiter = createMockArbiter();
    // viewerOrigin 在工厂调用时求值，必须在构造 ctx 时就位
    let disposed = false;
    const loop = createPassiveMailboxLoop({
      agent: { agentId: 'viewer-agent-1' },
      callArbiter: arbiter,
      isDisposed: () => disposed,
      pollIntervalMs: 1,
      viewerOrigin: 'http://198.51.100.7:3026',
      fetchImpl: async (url) => {
        dequeueUrls.push(String(url));
        return jsonResponse({ input: { text: 'via-ctx-origin' } });
      },
    });
    const running = loop.run();

    try {
      assert.ok(await until(() => arbiter.calls.enqueued.length === 1));
      assert.ok(dequeueUrls[0].startsWith('http://198.51.100.7:3026/api/agents/'));
    } finally {
      disposed = true;
      await running;
      await restoreEnv();
    }
  });

  it('sends Bearer from PROTOCLAW_INTERNAL_TOKEN when present, omits otherwise', async () => {
    process.env.AGENTDEV_VIEWER_ORIGIN = 'http://192.0.2.10:2526';
    process.env.PROTOCLAW_INTERNAL_TOKEN = 'tok-mailbox-internal';
    const seenHeaders = [];
    const arbiter = createMockArbiter();
    const harness = createHarness({
      arbiter,
      fetchImpl: async (url, init) => {
        seenHeaders.push(init?.headers);
        return jsonResponse({ input: { text: 'auth-check' } });
      },
    });
    const running = harness.loop.run();

    try {
      assert.ok(await until(() => arbiter.calls.enqueued.length === 1));
      assert.equal(seenHeaders.length, 1);
      assert.equal(seenHeaders[0].Authorization, 'Bearer tok-mailbox-internal');
      assert.equal(seenHeaders[0]['Content-Type'], 'application/json');
    } finally {
      harness.dispose();
      await running;
      await restoreEnv();
    }
  });

  it('omits the Authorization header when no internal token is set', async () => {
    process.env.AGENTDEV_VIEWER_ORIGIN = 'http://192.0.2.10:2526';
    delete process.env.PROTOCLAW_INTERNAL_TOKEN;
    const seenHeaders = [];
    const arbiter = createMockArbiter();
    const harness = createHarness({
      arbiter,
      fetchImpl: async (url, init) => {
        seenHeaders.push(init?.headers);
        return jsonResponse({ input: { text: 'no-auth-check' } });
      },
    });
    const running = harness.loop.run();

    try {
      assert.ok(await until(() => arbiter.calls.enqueued.length === 1));
      assert.equal(seenHeaders.length, 1);
      assert.equal('Authorization' in seenHeaders[0], false);
    } finally {
      harness.dispose();
      await running;
      await restoreEnv();
    }
  });
});
