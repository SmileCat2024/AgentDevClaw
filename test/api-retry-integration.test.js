import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '@agentdevjs/core';
import { ForceContinuation } from '../features/force-continuation/dist/index.js';
import { CallArbiter } from '../server/call-arbiter.js';

for (const stopReason of ['max_tokens', 'length']) {
  test(`${stopReason}: real framework and Feature preserve text/thinking and never execute truncated tools`, async () => {
    const requests = [];
    let executions = 0;
    const feature = new ForceContinuation();
    const agent = new Agent({ llm: { chat: async messages => {
      requests.push(structuredClone(messages));
      return requests.length === 1
        ? { content: 'partial', reasoning: 'thought', stopReason, toolCalls: [{ id: 'a', name: 'write', arguments: { path: 'x' } }] }
        : { content: 'done', stopReason: 'stop' };
    } }, maxTurns: 3, tools: [{ name: 'write', description: 'write', parameters: {}, execute: async () => { executions++; return { success: true }; } }] }).use(feature);
    await agent.onCall('go');
    assert.equal(executions, 0);
    assert.equal(requests.length, 2);
    const partial = requests[1].find(m => m.content === 'partial');
    assert.equal(partial.reasoning, 'thought');
    assert.equal(partial.toolCalls, undefined);
    assert.equal(agent.getLastCallOutcome().status, 'completed');
  });

  test(`${stopReason}: thinking-only failure never re-enters through network recovery`, async () => {
    let requests = 0;
    const agent = new Agent({ llm: { chat: async () => {
      requests++;
      return { content: '', reasoning: 'thought', stopReason };
    } }, maxTurns: 3 }).use(new ForceContinuation());
    const arbiter = new CallArbiter(agent);
    const entry = arbiter.enqueue({ source: 'test', text: 'go' });
    const finished = await arbiter.waitForCompletion(entry.id);
    assert.equal(requests, 1);
    assert.equal(finished.status, 'failed');
    assert.equal(finished.outcome.error.category, 'output_truncated');
    assert.equal(finished.outcome.error.retryable, false);
  });
}

test('real Feature and host share the configured network retry budget', async () => {
  let calls = 0;
  const feature = new ForceContinuation({ maxConsecutiveContinuations: 5 });
  const outcome = { status: 'failed', reason: 'error', error: { category: 'connection_timeout', retryable: true } };
  const arbiter = new CallArbiter({
    features: new Map([['force-continuation', feature]]),
    onCall: async () => { calls++; await feature.recordCallFinish({ outcome }); return ''; },
    getLastCallOutcome: () => outcome,
  });
  const entry = arbiter.enqueue({ source: 'test', text: 'go' });
  const finished = await arbiter.waitForCompletion(entry.id);
  assert.equal(calls, 6, 'initial attempt plus five retries');
  assert.equal(finished.status, 'failed');
  assert.equal(feature.getStatus().lastAction, 'limit_reached');
});
