/**
 * ClawDispatchFeature smoke test (node:test format)
 *
 * Validates the dual-mode injection state machine:
 * 1. Active call: buffer -> StepStart injection -> CallFinish piggyback
 * 2. Idle: arbiter fallback
 * 3. CallFinish with leftover: arbiter fallback
 * 4. StepStart empty buffer: no-op
 * 5. Multiple messages merged injection
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ClawDispatchFeature } from '../src/index.js';

describe('ClawDispatchFeature', () => {
  let fetchCalls: Array<{ url: string; method: string; body: any }>;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    fetchCalls = [];
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
      const urlStr = typeof input === 'string' ? input : String(input);
      let body: any = null;
      if (init?.body) {
        try { body = JSON.parse(init.body); } catch { body = init.body; }
      }
      fetchCalls.push({ url: urlStr, method: init?.method || 'GET', body });
      return { status: 200, ok: true, json: async () => ({ ok: true }) } as any;
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function countResponds() {
    return fetchCalls.filter(c => c.url.includes('/dispatch/respond')).length;
  }

  function lastRespond() {
    const responds = fetchCalls.filter(c => c.url.includes('/dispatch/respond'));
    return responds[responds.length - 1];
  }

  it('should buffer during active call, inject at StepStart, piggyback at CallFinish', async () => {
    const feature = new ClawDispatchFeature();
    const ctxAdds: any[] = [];
    const mockCtx = {
      context: { add: (msg: any) => ctxAdds.push(msg) },
      step: 1,
    };

    await (feature as any).onCallStartHook();
    assert.equal((feature as any).callActive, true);

    await (feature as any).handleMessage(
      { id: 'msg-1', text: 'Hello from dispatch' },
      'http://127.0.0.1:1420',
    );
    assert.equal((feature as any).pendingBuffer.length, 1);

    await (feature as any).onStepStartHook(mockCtx);
    assert.equal(ctxAdds.length, 1);
    assert.match(ctxAdds[0].content, /<system-reminder>/);
    assert.ok(ctxAdds[0].content.includes('Hello from dispatch'));
    assert.equal((feature as any).pendingBuffer.length, 0);
    assert.equal((feature as any).injectedThisCall.length, 1);

    const before = countResponds();
    await (feature as any).onCallFinishHook({ response: 'Final answer' });
    assert.equal(countResponds(), before + 1);
    assert.equal(lastRespond().body.response, 'Final answer');
    assert.equal((feature as any).callActive, false);
    assert.equal((feature as any).injectedThisCall.length, 0);
  });

  it('should use arbiter fallback when idle', async () => {
    const feature = new ClawDispatchFeature();
    let enqueueCalled = false;

    (feature as any).arbiterRef = {
      enqueue: () => {
        enqueueCalled = true;
        return { id: 'entry-1' };
      },
      waitForCompletion: async () => {
        return { status: 'completed', result: 'Arbiter result', error: null };
      },
    };

    const before = countResponds();
    await (feature as any).handleMessage(
      { id: 'msg-2', text: 'Idle dispatch' },
      'http://127.0.0.1:1420',
    );

    assert.ok(enqueueCalled);
    assert.equal(countResponds(), before + 1);
    assert.equal(lastRespond().body.response, 'Arbiter result');
  });

  it('should fallback leftover messages to arbiter at CallFinish', async () => {
    const feature = new ClawDispatchFeature();
    let arbiterCount = 0;

    (feature as any).arbiterRef = {
      enqueue: () => {
        arbiterCount++;
        return { id: `entry-${arbiterCount}` };
      },
      waitForCompletion: async () => {
        return { status: 'completed', result: 'ok', error: null };
      },
    };

    await (feature as any).onCallStartHook();
    await (feature as any).handleMessage(
      { id: 'left-1', text: 'Leftover 1' },
      'http://127.0.0.1:1420',
    );
    await (feature as any).handleMessage(
      { id: 'left-2', text: 'Leftover 2' },
      'http://127.0.0.1:1420',
    );
    assert.equal((feature as any).pendingBuffer.length, 2);

    arbiterCount = 0;
    await (feature as any).onCallFinishHook({ response: 'Done' });

    // Wait for async leftover dispatch
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(arbiterCount, 2);
  });

  it('should be a no-op when StepStart has empty buffer', async () => {
    const feature = new ClawDispatchFeature();
    const ctxAdds: any[] = [];
    const mockCtx = {
      context: { add: (msg: any) => ctxAdds.push(msg) },
      step: 1,
    };

    await (feature as any).onCallStartHook();
    await (feature as any).onStepStartHook(mockCtx);

    assert.equal(ctxAdds.length, 0);
  });

  it('should merge multiple messages into one injection', async () => {
    const feature = new ClawDispatchFeature();
    const ctxAdds: any[] = [];
    const mockCtx = {
      context: { add: (msg: any) => ctxAdds.push(msg) },
      step: 2,
    };

    await (feature as any).onCallStartHook();
    await (feature as any).handleMessage(
      { id: 'multi-1', text: 'First' },
      'http://127.0.0.1:1420',
    );
    await (feature as any).handleMessage(
      { id: 'multi-2', text: 'Second' },
      'http://127.0.0.1:1420',
    );

    await (feature as any).onStepStartHook(mockCtx);

    assert.equal(ctxAdds.length, 1);
    assert.ok(ctxAdds[0].content.includes('First'));
    assert.ok(ctxAdds[0].content.includes('Second'));
    assert.equal((feature as any).injectedThisCall.length, 2);

    const before = countResponds();
    await (feature as any).onCallFinishHook({ response: 'Merged answer' });
    assert.equal(countResponds(), before + 2);
  });

  it('should bound slow CallFinish network side effects', async () => {
    const feature = new ClawDispatchFeature();
    (feature as any).injectedThisCall = [{ id: 'slow-1', text: 'slow response' }];
    globalThis.fetch = (() => new Promise(() => {})) as unknown as typeof fetch;

    const startedAt = Date.now();
    await (feature as any).onCallFinishHook({ response: 'Interrupted' });
    const elapsed = Date.now() - startedAt;

    assert.ok(elapsed < 600, `CallFinish should not wait for an unbounded fetch (elapsed=${elapsed}ms)`);
    assert.equal((feature as any).injectedThisCall.length, 0);
    assert.equal((feature as any).callActive, false);
  });
});
