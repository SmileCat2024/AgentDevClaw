import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Decision } from '@agentdevjs/core';
import { ForceContinuation } from '../dist/index.js';

function step({ stopReason = 'max_tokens', content = 'partial body', toolCallsCount = 0 } = {}) {
  const added = [];
  return { ctx: { llmResponse: { stopReason, content }, toolCallsCount, context: { add: m => added.push(m) } }, added };
}
const network = { status: 'failed', reason: 'error', error: { category: 'connection_timeout', retryable: true } };

describe('API retry', () => {
  it('defaults both policies on without a master switch or step recovery API', () => {
    const f = new ForceContinuation();
    assert.deepEqual(f.getStatus().triggers, { outputTruncation: true, apiErrorRetry: true });
    assert.equal(f.getStatus().maxConsecutiveContinuations, 5);
    assert.equal('enabled' in f.getStatus(), false);
    assert.equal(f.setEnabled, undefined);
    assert.equal(f.requestFrameworkLimitContinuation, undefined);
    assert.deepEqual(f.getTools(), []);
    assert.deepEqual(Object.keys(f.getFeatureManifest().settings.properties), ['outputTruncation', 'apiErrorRetry', 'maxConsecutiveContinuations']);
  });
  for (const stopReason of ['max_tokens', 'length']) {
    it(`continues body truncation for ${stopReason}`, async () => {
      const f = new ForceContinuation();
      const { ctx, added } = step({ stopReason });
      assert.equal(await f.decideContinuation(ctx), Decision.Approve);
      assert.match(added[0].content, /API 重试：正文输出达到上限/);
      assert.equal(f.getStatus().consecutiveContinuations, 1);
    });
  }
  it('never handles thinking-only, ordinary completion or unfiltered tools', async () => {
    const f = new ForceContinuation();
    for (const input of [{ content: '' }, { content: '  ' }, { stopReason: 'stop' }, { toolCallsCount: 1 }]) {
      const { ctx, added } = step(input);
      assert.equal(await f.decideContinuation(ctx), Decision.Continue);
      assert.deepEqual(added, []);
    }
  });
  it('controls the two policies independently', async () => {
    const f = new ForceContinuation({ outputTruncation: false });
    assert.equal(await f.decideContinuation(step().ctx), Decision.Continue);
    assert.equal(f.requestApiErrorContinuation(network), true);
    f.setTriggers({ outputTruncation: true, apiErrorRetry: false });
    assert.equal(f.requestApiErrorContinuation(network), false);
    assert.equal(await f.decideContinuation(step().ctx), Decision.Approve);
  });
  it('accepts only retryable network categories, never other runtime errors or cancellation', () => {
    const f = new ForceContinuation();
    for (const category of ['connection_error', 'connection_timeout', 'rate_limit', 'server_overload', 'server_error']) {
      assert.ok(f.requestApiErrorContinuation({ ...network, error: { category, retryable: true } }));
    }
    for (const outcome of [
      { ...network, status: 'cancelled' }, { ...network, reason: 'limit_reached' },
      { ...network, error: { category: 'output_truncated', retryable: true } },
      { ...network, error: { category: 'runtime_error', retryable: true } },
      { ...network, error: { category: 'auth_error', retryable: false } },
    ]) assert.equal(f.requestApiErrorContinuation(outcome), false);
  });
  it('shares the budget between output and network retries across CallFinish', async () => {
    const f = new ForceContinuation({ maxConsecutiveContinuations: 2 });
    await f.decideContinuation(step().ctx);
    await f.recordCallFinish({ outcome: network });
    assert.ok(f.requestApiErrorContinuation(network));
    await f.recordCallFinish({ outcome: network });
    assert.equal(f.requestApiErrorContinuation(network), false);
    assert.equal(f.getStatus().lastAction, 'limit_reached');
    await f.recordCallFinish({ outcome: { status: 'completed', reason: 'completed' } });
    assert.equal(f.getStatus().consecutiveContinuations, 0);
  });
  it('clamps budget and preserves the active count when configuring', async () => {
    const f = new ForceContinuation({ maxConsecutiveContinuations: 1 });
    await f.decideContinuation(step().ctx);
    f.setTriggers({ apiErrorRetry: false });
    assert.equal(f.getStatus().consecutiveContinuations, 1);
    assert.equal(await f.decideContinuation(step().ctx), Decision.Continue);
    assert.equal(f.setMaxConsecutive(99).maxConsecutiveContinuations, 10);
    assert.equal(await f.decideContinuation(step().ctx), Decision.Approve);
    assert.equal(f.setMaxConsecutive(0).maxConsecutiveContinuations, 1);
    assert.equal(f.setMaxConsecutive(NaN).maxConsecutiveContinuations, 1);
  });
  it('restores snapshot and capability uses the same flat config as the manifest', async () => {
    const f = new ForceContinuation();
    const cap = f.getCapabilities()[0];
    assert.equal(cap.title, '配置 API 重试');
    assert.deepEqual(cap.entryPoints, ['slash', 'feature']);
    await cap.execute({ outputTruncation: false, maxConsecutiveContinuations: 7 }, {});
    assert.equal(cap.readCurrentValues().apiErrorRetry, true);
    const copy = new ForceContinuation();
    copy.restoreState(f.captureState());
    assert.deepEqual(copy.getStatus(), f.getStatus());
  });
  it('initialization honors explicit true overrides and false values', async () => {
    const f = new ForceContinuation({ outputTruncation: false });
    await f.onInitiate({ featureConfig: { outputTruncation: true, apiErrorRetry: false } });
    assert.deepEqual(f.getStatus().triggers, { outputTruncation: true, apiErrorRetry: false });
  });
});
