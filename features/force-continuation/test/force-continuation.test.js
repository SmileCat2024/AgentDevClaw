import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Decision } from 'agentdev';
import { ForceContinuation } from '../dist/index.js';

function createStepContext({ stopReason = 'max_tokens', toolCallsCount = 0 } = {}) {
  const added = [];
  return {
    ctx: {
      llmResponse: { stopReason },
      toolCallsCount,
      context: {
        add(message) {
          added.push(message);
        },
      },
    },
    added,
  };
}

describe('ForceContinuation', () => {
  it('exposes no tools; the side panel is the only control surface', () => {
    const feature = new ForceContinuation();
    assert.deepEqual(feature.getTools(), []);
  });

  it('is opt-in and does nothing while disabled', async () => {
    const feature = new ForceContinuation();
    const { ctx, added } = createStepContext();

    const result = await feature.decideContinuation(ctx);

    assert.equal(result, Decision.Continue);
    assert.equal(added.length, 0);
    assert.equal(feature.getStatus().enabled, false);
  });

  it('approves a bounded extra step only for a no-tool truncated response', async () => {
    const feature = new ForceContinuation({ enabled: true, maxConsecutiveContinuations: 2 });
    const { ctx, added } = createStepContext({ stopReason: 'length' });

    const result = await feature.decideContinuation(ctx);

    assert.equal(result, Decision.Approve);
    assert.equal(added.length, 1);
    assert.equal(added[0].role, 'system');
    assert.match(added[0].content, /provider stop reason=length/);
    assert.deepEqual(feature.getStatus(), {
      enabled: true,
      triggers: { providerMaxTokens: true, providerLength: true, frameworkLimitReached: true },
      maxConsecutiveContinuations: 2,
      consecutiveContinuations: 1,
      lastProviderStopReason: 'length',
      lastFinishReason: null,
      lastOutcomeStatus: null,
      lastAction: 'continued',
    });
  });

  it('does not continue ordinary completions or steps that used a tool', async () => {
    const feature = new ForceContinuation({ enabled: true });

    assert.equal(
      await feature.decideContinuation(createStepContext({ stopReason: 'end_turn' }).ctx),
      Decision.Continue,
    );
    assert.equal(
      await feature.decideContinuation(createStepContext({ stopReason: 'max_tokens', toolCallsCount: 1 }).ctx),
      Decision.Continue,
    );
    assert.equal(feature.getStatus().consecutiveContinuations, 0);
  });

  it('lets each provider truncation candidate be disabled independently beneath the master switch', async () => {
    const feature = new ForceContinuation({ enabled: true });
    feature.setTriggers({ providerMaxTokens: false, providerLength: true });

    assert.equal(await feature.decideContinuation(createStepContext({ stopReason: 'max_tokens' }).ctx), Decision.Continue);
    assert.equal(await feature.decideContinuation(createStepContext({ stopReason: 'length' }).ctx), Decision.Approve);
    assert.deepEqual(feature.getStatus().triggers, {
      providerMaxTokens: false,
      providerLength: true,
      frameworkLimitReached: true,
    });
  });

  it('requests a bounded host continuation for framework limit_reached only when that candidate and the master switch are enabled', () => {
    const feature = new ForceContinuation({ enabled: true, maxConsecutiveContinuations: 1 });

    assert.match(feature.requestFrameworkLimitContinuation({ status: 'failed', reason: 'limit_reached' }), /步数上限/);
    assert.equal(feature.requestFrameworkLimitContinuation({ status: 'failed', reason: 'limit_reached' }), null);

    feature.setTriggers({ frameworkLimitReached: false });
    assert.equal(feature.requestFrameworkLimitContinuation({ status: 'failed', reason: 'limit_reached' }), null);
    feature.setTriggers({ frameworkLimitReached: true });
    feature.setEnabled(false);
    assert.equal(feature.requestFrameworkLimitContinuation({ status: 'failed', reason: 'limit_reached' }), null);
  });

  it('stops approving after the configured consecutive-continuation budget', async () => {
    const feature = new ForceContinuation({ enabled: true, maxConsecutiveContinuations: 1 });

    assert.equal(await feature.decideContinuation(createStepContext().ctx), Decision.Approve);
    assert.equal(await feature.decideContinuation(createStepContext().ctx), Decision.Continue);
    assert.equal(feature.getStatus().lastAction, 'limit_reached');
  });

  it('records structured CallFinish semantics and resets a finished call budget', async () => {
    const feature = new ForceContinuation({ enabled: true });
    await feature.decideContinuation(createStepContext().ctx);

    await feature.recordCallFinish({
      finishReason: 'completed',
      outcome: {
        status: 'completed',
        model: { providerStopReason: 'end_turn' },
      },
    });

    assert.deepEqual(feature.getStatus(), {
      enabled: true,
      triggers: { providerMaxTokens: true, providerLength: true, frameworkLimitReached: true },
      maxConsecutiveContinuations: 5,
      consecutiveContinuations: 0,
      lastProviderStopReason: 'end_turn',
      lastFinishReason: 'completed',
      lastOutcomeStatus: 'completed',
      lastAction: 'completed',
    });
  });

  it('adjusts the auto-resume cap with clamping and keeps the running count', async () => {
    const feature = new ForceContinuation({ enabled: true, maxConsecutiveContinuations: 1 });
    assert.equal(await feature.decideContinuation(createStepContext().ctx), Decision.Approve);
    assert.equal(feature.getStatus().consecutiveContinuations, 1);

    // Cap reached: the next decision falls back to the default rule.
    assert.equal(await feature.decideContinuation(createStepContext().ctx), Decision.Continue);
    assert.equal(feature.getStatus().lastAction, 'limit_reached');

    // Raising the cap lets the in-flight task resume again.
    assert.equal(feature.setMaxConsecutive(99).maxConsecutiveContinuations, 10);
    assert.equal(feature.getStatus().consecutiveContinuations, 1);
    assert.equal(await feature.decideContinuation(createStepContext().ctx), Decision.Approve);

    // Out-of-range numbers clamp to the 1–10 boundary (same rule as parseConfig);
    // non-numeric input keeps the current cap.
    assert.equal(feature.setMaxConsecutive(0).maxConsecutiveContinuations, 1);
    assert.equal(feature.setMaxConsecutive(Number.NaN).maxConsecutiveContinuations, 1);
  });

  it('restores session-local switch state without accepting invalid status values', () => {
    const feature = new ForceContinuation();
    feature.restoreState({
      config: { enabled: true, maxConsecutiveContinuations: 100 },
      consecutiveContinuations: 99,
      lastProviderStopReason: 'MAX_TOKENS',
      lastFinishReason: 'limit_reached',
      lastOutcomeStatus: 'continued',
      lastAction: 'invalid-action',
    });

    assert.deepEqual(feature.getStatus(), {
      enabled: true,
      triggers: { providerMaxTokens: true, providerLength: true, frameworkLimitReached: true },
      maxConsecutiveContinuations: 10,
      consecutiveContinuations: 10,
      lastProviderStopReason: 'max_tokens',
      lastFinishReason: 'limit_reached',
      lastOutcomeStatus: 'continued',
      lastAction: 'idle',
    });
  });
});
