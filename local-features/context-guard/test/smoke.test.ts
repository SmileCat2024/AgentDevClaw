import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ContextGuardFeature, ContextRotationTriggerFeature } from '../src/index.js';

function makeAgent() {
  const calls: string[] = [];
  return {
    calls,
    llm: { chat: async () => ({ content: 'ok' }) },
    interrupt() { calls.push('interrupt'); },
  };
}

function makeArbiter() {
  const calls: string[] = [];
  return {
    calls,
    interruptActive(reason: string) { calls.push(`interruptActive:${reason}`); },
  };
}

describe('ContextGuardFeature (interactive shell)', () => {
  it('trips once when input tokens cross the threshold', () => {
    const feature = new ContextGuardFeature({ contextLength: 1000, compressRatio: 80 });
    const agent = makeAgent();
    const arbiter = makeArbiter();
    feature.setCallArbiter(arbiter);

    assert.equal(feature.getStatus().armed, true);
    assert.equal(feature.observeUsage({ inputTokens: 500 }, agent), false);
    assert.equal(feature.observeUsage({ inputTokens: 800 }, agent), true);

    const status = feature.getStatus();
    assert.equal(status.armed, false);
    assert.equal(status.trip?.inputTokens, 800);
    assert.equal(status.trip?.thresholdTokens, 800);
    assert.deepEqual(agent.calls, ['interrupt']);
    assert.equal(arbiter.calls.length, 1);

    // fuse consumed: crossing again does nothing
    assert.equal(feature.observeUsage({ inputTokens: 900 }, agent), false);
    assert.deepEqual(agent.calls, ['interrupt']);
  });

  it('re-arms via setArmed and trips again', () => {
    const feature = new ContextGuardFeature({ contextLength: 1000, compressRatio: 80 });
    const agent = makeAgent();
    feature.observeUsage({ inputTokens: 800 }, agent);
    assert.equal(feature.getStatus().armed, false);

    feature.setArmed(true);
    assert.equal(feature.getStatus().armed, true);
    assert.equal(feature.observeUsage({ inputTokens: 850 }, agent), true);
    assert.deepEqual(agent.calls, ['interrupt', 'interrupt']);
  });

  it('enabled:false starts disarmed', () => {
    const feature = new ContextGuardFeature({ enabled: false, contextLength: 1000, compressRatio: 80 });
    const agent = makeAgent();
    assert.equal(feature.getStatus().armed, false);
    assert.equal(feature.observeUsage({ inputTokens: 900 }, agent), false);
  });

  it('recomputes the threshold when the model changes', () => {
    const feature = new ContextGuardFeature({ contextLength: 1000, compressRatio: 80 });
    const agent = makeAgent();
    assert.equal(feature.observeUsage({ inputTokens: 800 }, agent), true);

    feature.setArmed(true);
    feature.updateThreshold(10_000, 80);
    assert.equal(feature.getStatus().thresholdTokens, 8000);
    assert.equal(feature.observeUsage({ inputTokens: 800 }, agent), false);
    assert.equal(feature.observeUsage({ inputTokens: 8000 }, agent), true);
  });

  it('exposes the manifest for the runtime config panel', () => {
    const feature = new ContextGuardFeature({});
    const manifest = feature.getFeatureManifest();
    const enabled = manifest.settings.properties.enabled as { type: string; default: boolean };
    assert.equal(enabled.type, 'boolean');
    assert.equal(enabled.default, true);
  });
});

describe('ContextRotationTriggerFeature (automation shell)', () => {
  let originalFetch: any;
  let posted: Array<{ url: string, body: any }>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    posted = [];
    globalThis.fetch = (async (url: any, init: any) => {
      posted.push({ url: String(url), body: JSON.parse(init.body) });
      return { ok: true, json: async () => ({}) };
    }) as any;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('fires once and reports the rotation event', async () => {
    const feature = new ContextRotationTriggerFeature({
      contextLength: 1000,
      compressRatio: 80,
      agentId: 'coder',
      sessionId: 's1',
      serverOrigin: 'http://127.0.0.1:1420',
    });
    const agent = makeAgent();
    const arbiter = makeArbiter();
    feature.setCallArbiter(arbiter);

    assert.equal(feature.observeUsage({ inputTokens: 900 }, agent), true);
    assert.deepEqual(agent.calls, ['interrupt']);
    assert.equal(arbiter.calls.length, 1);

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(posted.length, 1);
    assert.equal(posted[0].url, 'http://127.0.0.1:1420/protoclaw/context_guard_event');
    assert.equal(posted[0].body.agentId, 'coder');
    assert.equal(posted[0].body.contextGuard.blocked, true);

    // one-shot lock: no further triggers or reports
    assert.equal(feature.observeUsage({ inputTokens: 950 }, agent), false);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(posted.length, 1);
  });
});
