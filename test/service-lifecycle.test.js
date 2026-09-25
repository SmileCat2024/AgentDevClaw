import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServiceLifecycle, SERVICE_STATES } from '../server/service-lifecycle.js';

describe('service lifecycle', () => {
  it('reports starting until startup is complete', () => {
    const lifecycle = createServiceLifecycle();
    assert.equal(lifecycle.getState(), SERVICE_STATES.STARTING);
    lifecycle.markReady();
    assert.equal(lifecycle.getState(), SERVICE_STATES.READY);
  });

  it('rejects invalid readiness transitions', () => {
    const lifecycle = createServiceLifecycle();
    lifecycle.markReady();
    assert.throws(() => lifecycle.markReady(), /Cannot mark service ready/);
  });

  it('runs shutdown once and exposes stopping/stopped states', async () => {
    const lifecycle = createServiceLifecycle();
    lifecycle.markReady();
    let finishCleanup;
    let cleanupCalls = 0;
    const cleanup = () => {
      cleanupCalls += 1;
      return new Promise((resolve) => { finishCleanup = resolve; });
    };

    const first = lifecycle.shutdown(cleanup);
    const second = lifecycle.shutdown(cleanup);
    assert.equal(first, second);
    assert.equal(lifecycle.getState(), SERVICE_STATES.STOPPING);
    await Promise.resolve();
    assert.equal(cleanupCalls, 1);
    finishCleanup();
    await first;
    assert.equal(lifecycle.getState(), SERVICE_STATES.STOPPED);
  });

  it('settles to stopped when cleanup fails', async () => {
    const lifecycle = createServiceLifecycle();
    await assert.rejects(lifecycle.shutdown(async () => { throw new Error('cleanup failed'); }), /cleanup failed/);
    assert.equal(lifecycle.getState(), SERVICE_STATES.STOPPED);
  });
});
