import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ContextGuardFeature } from '../src/index.js';

describe('ContextGuardFeature', () => {
  it('blocks and interrupts when input usage reaches the configured threshold', () => {
    const feature = new ContextGuardFeature({ contextLength: 1000, compressRatio: 80 });
    let interrupted = 0;
    let cancelled = 0;
    feature.setCallArbiter({ blockQueued: () => { cancelled += 1; return 2; } });

    const blocked = feature.observeUsage({ inputTokens: 800 }, {
      interrupt: () => { interrupted += 1; },
    });

    assert.equal(blocked, true);
    assert.equal(feature.isBlocked(), true);
    assert.equal(feature.getState().thresholdTokens, 800);
    assert.equal(feature.getState().inputTokens, 800);
    assert.equal(interrupted, 1);
    assert.equal(cancelled, 1);
  });

  it('reports the blocked state to Claw immediately', async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string, init: any }> = [];
    globalThis.fetch = (async (url: string, init: any) => {
      calls.push({ url, init });
      return { ok: true } as Response;
    }) as typeof fetch;
    try {
      const feature = new ContextGuardFeature({
        contextLength: 1000,
        compressRatio: 80,
        agentId: 'programming-helper',
        sessionId: 'session-1',
        serverOrigin: 'http://127.0.0.1:1420/',
      });
      feature.observeUsage({ inputTokens: 800 });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, 'http://127.0.0.1:1420/protoclaw/context_guard_event');
      assert.equal(JSON.parse(calls[0].init.body).contextGuard.blocked, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('does not block when disabled or usage is below the threshold', () => {
    const disabled = new ContextGuardFeature({ enabled: false, contextLength: 1000, compressRatio: 80 });
    assert.equal(disabled.observeUsage({ inputTokens: 1000 }), false);
    assert.equal(disabled.isBlocked(), false);

    const active = new ContextGuardFeature({ contextLength: 1000, compressRatio: 80 });
    assert.equal(active.observeUsage({ inputTokens: 799 }), false);
    assert.equal(active.isBlocked(), false);
  });
});
