/**
 * ContextHandoffSeedFeature smoke test (node:test format)
 *
 * Validates seed injection and _callIndex advancement.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Context } from 'agentdev';
import { ContextHandoffSeedFeature } from '../src/index.js';

function createFeature() {
  return new ContextHandoffSeedFeature({
    handoff: {
      packageId: 'pkg-1',
      sourceSessionId: 'session-1',
      mode: 'trim-transcript',
      seedMessages: [
        { role: 'system', content: 'Folded tool activity', turn: 1 },
        { role: 'user', content: 'Please continue the task.', turn: 2 },
        { role: 'assistant', content: 'I will continue from the trimmed transcript.', turn: 2 },
      ],
    },
  });
}

function createContextRecorder() {
  const messages: Array<{ role: string; content: string }> = [];
  const context = {
    add(msg: any): void {
      messages.push({ role: msg.role, content: msg.content });
    },
    addSystemMessage(content: string): void {
      messages.push({ role: 'system', content });
    },
    addUserMessage(content: string): void {
      messages.push({ role: 'user', content });
    },
    addAssistantMessage(response: { content: string }): void {
      messages.push({ role: 'assistant', content: response.content });
    },
  };
  return { messages, context };
}

describe('ContextHandoffSeedFeature', () => {

  it('should inject seed messages on first call', async () => {
    const feature = createFeature();
    const { messages, context } = createContextRecorder();
    const agent = { _callIndex: 0 };

    await feature.injectHandoffSummary({
      input: 'hello',
      isFirstCall: true,
      context,
      agent,
    } as any);

    assert.equal(messages.length, 3);
  });

  it('should advance _callIndex past seed turns', async () => {
    const feature = createFeature();
    const { context } = createContextRecorder();
    const agent = { _callIndex: 0 };

    await feature.injectHandoffSummary({
      input: 'hello',
      isFirstCall: true,
      context,
      agent,
    } as any);

    // seedMessages have turns 1, 2, 2 -> injectionTurn = max(0, 1+1, 2+1, 2+1) = 3
    assert.equal(agent._callIndex, 3);
  });

  it('should inject only once (skip on subsequent calls)', async () => {
    const feature = createFeature();
    const { messages, context } = createContextRecorder();

    await feature.injectHandoffSummary({
      input: 'hello',
      isFirstCall: true,
      context,
      agent: { _callIndex: 0 },
    } as any);

    await feature.injectHandoffSummary({
      input: 'again',
      isFirstCall: false,
      context,
      agent: { _callIndex: 1 },
    } as any);

    assert.equal(messages.length, 3);
  });
});
