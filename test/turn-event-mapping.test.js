/**
 * Tests for turn-event mapping (scripts/turn-event-mapping.js)
 *
 * 锁死 envelope → turn.* 的宿主策略契约：
 * - completed → turn.completed（含 usage）
 * - completed + content_filter / refusal → turn.failed（不可重试，category=content_filter）
 * - cancelled → turn.cancelled（生命周期信号）
 * - 其余 → turn.failed（结构化 reason/category）
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mapEnvelopeToTurnEvent } from '../scripts/turn-event-mapping.js';

describe('mapEnvelopeToTurnEvent', () => {
  it('maps natural completion with usage', () => {
    const event = mapEnvelopeToTurnEvent(
      { status: 'completed', outcome: { status: 'completed', reason: 'completed', model: { providerStopReason: 'stop' } } },
      { turn: 3, usage: { inputTokens: 10, outputTokens: 5 } },
    );
    assert.equal(event.type, 'turn.completed');
    assert.equal(event.turn, 3);
    assert.deepEqual(event.usage, { inputTokens: 10, outputTokens: 5 });
    assert.equal(event.error, undefined);
  });

  it('treats content_filter completion as non-retryable failure', () => {
    const event = mapEnvelopeToTurnEvent(
      { status: 'completed', outcome: { status: 'completed', reason: 'completed', model: { providerStopReason: 'content_filter' } } },
      { turn: 1 },
    );
    assert.equal(event.type, 'turn.failed');
    assert.equal(event.error.reason, 'content_filter');
    assert.equal(event.error.category, 'content_filter');
    assert.equal(event.error.retryable, false);
    assert.match(event.error.message, /blocked by provider filter/);
  });

  it('treats anthropic refusal completion as non-retryable failure', () => {
    const event = mapEnvelopeToTurnEvent(
      { status: 'completed', outcome: { status: 'completed', reason: 'completed', model: { providerStopReason: 'refusal' } } },
      { turn: 1 },
    );
    assert.equal(event.type, 'turn.failed');
    assert.equal(event.error.reason, 'refusal');
    assert.equal(event.error.retryable, false);
  });

  it('truncation stop reasons stay natural completion (force-continuation owns them)', () => {
    // max_tokens / length 在 StepFinish 层由 force-continuation 处理；
    // 到达 envelope 终态时若仍是 completed，视为自然完成
    for (const stopReason of ['max_tokens', 'length']) {
      const event = mapEnvelopeToTurnEvent(
        { status: 'completed', outcome: { model: { providerStopReason: stopReason } } },
        { turn: 0 },
      );
      assert.equal(event.type, 'turn.completed');
    }
  });

  it('maps cancelled to lifecycle signal, not failure', () => {
    const event = mapEnvelopeToTurnEvent(
      { status: 'cancelled', error: 'Session blocked by the context guard', outcome: { reason: 'cancelled' } },
      { turn: 2 },
    );
    assert.equal(event.type, 'turn.cancelled');
    assert.equal(event.error.category, 'lifecycle');
    assert.equal(event.error.message, 'Session blocked by the context guard');
  });

  it('maps real failures with structured error', () => {
    const event = mapEnvelopeToTurnEvent(
      {
        status: 'failed',
        outcome: {
          status: 'failed',
          reason: 'limit_reached',
          error: { category: 'runtime' },
        },
      },
      { turn: 4 },
    );
    assert.equal(event.type, 'turn.failed');
    assert.equal(event.error.reason, 'limit_reached');
    assert.equal(event.error.category, 'runtime');
    assert.equal(event.error.message, 'call failed');
  });

  it('maps LLM API errors with category and retryable flag', () => {
    const event = mapEnvelopeToTurnEvent(
      {
        status: 'failed',
        outcome: {
          status: 'failed',
          reason: 'error',
          error: { message: 'rate limited', category: 'provider', retryable: true },
        },
      },
      { turn: 0 },
    );
    assert.equal(event.type, 'turn.failed');
    assert.equal(event.error.message, 'rate limited');
    assert.equal(event.error.category, 'provider');
    assert.equal(event.error.retryable, true);
  });

  it('handles missing outcome gracefully', () => {
    const event = mapEnvelopeToTurnEvent({ status: 'completed' }, { turn: null });
    assert.equal(event.type, 'turn.completed');
    assert.equal(event.turn, null);
  });
});
