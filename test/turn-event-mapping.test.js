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
    // 非 suspended 完成不带挂起标志（老消费方兼容形状）
    assert.equal(event.suspended, undefined);
    assert.equal(event.pendingWakeups, undefined);
  });

  it('marks suspended completion with pendingWakeups (ADR-0019)', () => {
    const wakeups = [{ source: 'shell', id: 'bg-1', summary: 'npm test' }];
    const event = mapEnvelopeToTurnEvent(
      { status: 'completed', outcome: { status: 'continued', reason: 'suspended', pendingWakeups: wakeups } },
      { turn: 2 },
    );
    assert.equal(event.type, 'turn.completed');
    assert.equal(event.suspended, true);
    assert.deepEqual(event.pendingWakeups, wakeups);
  });

  it('suspended completion without wakeups carries flag only', () => {
    const event = mapEnvelopeToTurnEvent(
      { status: 'completed', outcome: { status: 'continued', reason: 'suspended' } },
      { turn: 0 },
    );
    assert.equal(event.type, 'turn.completed');
    assert.equal(event.suspended, true);
    assert.equal(event.pendingWakeups, undefined);
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

  it('maps unhandled output truncation to a failed turn', () => {
    for (const stopReason of ['max_tokens', 'length']) {
      const event = mapEnvelopeToTurnEvent(
        {
          status: 'failed',
          outcome: {
            status: 'failed', reason: 'error',
            error: { category: 'output_truncated', message: 'output budget exhausted', retryable: false },
            model: { providerStopReason: stopReason },
          },
        },
        { turn: 0 },
      );
      assert.equal(event.type, 'turn.failed');
      assert.equal(event.error.category, 'output_truncated');
      assert.equal(event.error.retryable, false);
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

  it('turn=0 is a valid first turn, not coerced to null (0-based contract)', () => {
    // turn 号 = Agent._callIndex，0-based：首个 turn 为 0，不得把 0 当 falsy
    // 误判为"无 turn 号"。跨 runtime 接力后低 turn 号会再次出现，是合法值。
    const event = mapEnvelopeToTurnEvent(
      { status: 'completed', outcome: { model: { providerStopReason: 'stop' } } },
      { turn: 0 },
    );
    assert.equal(event.type, 'turn.completed');
    assert.equal(event.turn, 0);
  });
});

describe('mapEnvelopeToTurnEvent source identity (ADR-0031 step 1)', () => {
  it('carries envelope source/sourceRef on turn.completed', () => {
    const event = mapEnvelopeToTurnEvent(
      {
        status: 'completed',
        source: 'thread',
        sourceRef: 'cmd-1',
        outcome: { status: 'completed', reason: 'completed', model: { providerStopReason: 'stop' } },
      },
      { turn: 1 },
    );
    assert.equal(event.type, 'turn.completed');
    assert.equal(event.source, 'thread');
    assert.equal(event.sourceRef, 'cmd-1');
    assert.equal(event.consumedSourceRefs, undefined);
  });

  it('carries consumedSourceRefs from outcome on turn.completed', () => {
    const event = mapEnvelopeToTurnEvent(
      {
        status: 'completed',
        source: 'thread',
        sourceRef: 'cmd-1',
        outcome: {
          status: 'completed',
          reason: 'completed',
          consumedSourceRefs: ['cmd-2', 'cmd-3'],
        },
      },
      { turn: 2 },
    );
    assert.deepEqual(event.consumedSourceRefs, ['cmd-2', 'cmd-3']);
  });

  it('falls back to outcome.sourceRef when envelope lacks it', () => {
    const event = mapEnvelopeToTurnEvent(
      {
        status: 'completed',
        outcome: { status: 'completed', reason: 'completed', sourceRef: 'cmd-from-outcome' },
      },
      { turn: 0 },
    );
    assert.equal(event.sourceRef, 'cmd-from-outcome');
  });

  it('omits identity fields when envelope carries none (old consumers unaffected)', () => {
    const event = mapEnvelopeToTurnEvent(
      { status: 'completed', outcome: { status: 'completed', reason: 'completed' } },
      { turn: 1 },
    );
    assert.equal('source' in event, false);
    assert.equal('sourceRef' in event, false);
    assert.equal('consumedSourceRefs' in event, false);
  });

  it('carries identity on suspended completion', () => {
    const event = mapEnvelopeToTurnEvent(
      {
        status: 'completed',
        sourceRef: 'cmd-1',
        outcome: { status: 'continued', reason: 'suspended', pendingWakeups: [{ source: 'shell', id: 'bg-1' }] },
      },
      { turn: 3 },
    );
    assert.equal(event.type, 'turn.completed');
    assert.equal(event.suspended, true);
    assert.equal(event.sourceRef, 'cmd-1');
  });

  it('carries identity on turn.cancelled and turn.failed', () => {
    const cancelled = mapEnvelopeToTurnEvent(
      { status: 'cancelled', source: 'thread', sourceRef: 'cmd-1', outcome: { reason: 'cancelled' } },
      { turn: 2 },
    );
    assert.equal(cancelled.type, 'turn.cancelled');
    assert.equal(cancelled.sourceRef, 'cmd-1');

    const failed = mapEnvelopeToTurnEvent(
      {
        status: 'failed',
        sourceRef: 'cmd-2',
        outcome: { status: 'failed', reason: 'error', error: { category: 'runtime' } },
      },
      { turn: 4 },
    );
    assert.equal(failed.type, 'turn.failed');
    assert.equal(failed.sourceRef, 'cmd-2');
  });

  it('carries consumedSourceRefs on cancelled and failed (consumed identity never dropped)', () => {
    const cancelled = mapEnvelopeToTurnEvent(
      {
        status: 'cancelled',
        sourceRef: 'cmd-1',
        outcome: { reason: 'cancelled', consumedSourceRefs: ['cmd-q1'] },
      },
      { turn: 2 },
    );
    assert.equal(cancelled.type, 'turn.cancelled');
    assert.deepEqual(cancelled.consumedSourceRefs, ['cmd-q1']);

    const failed = mapEnvelopeToTurnEvent(
      {
        status: 'failed',
        sourceRef: 'cmd-2',
        outcome: {
          status: 'failed', reason: 'error',
          consumedSourceRefs: ['cmd-q1', 'cmd-q2'],
          error: { category: 'runtime' },
        },
      },
      { turn: 4 },
    );
    assert.equal(failed.type, 'turn.failed');
    assert.deepEqual(failed.consumedSourceRefs, ['cmd-q1', 'cmd-q2']);
  });
});
