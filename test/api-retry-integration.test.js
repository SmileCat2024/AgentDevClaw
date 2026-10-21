import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '@agentdevjs/core';
import { createServer } from 'node:http';
import { createOpenAILLM, createOpenAIResponsesLLM } from '@agentdevjs/llm';
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

for (const [protocol, factory] of [['chat', createOpenAILLM], ['responses', createOpenAIResponsesLLM]]) {
  for (const phase of ['headers', 'stream']) {
    for (const policy of ['recover', 'disabled', 'exhausted', 'cancel']) {
      test(`${protocol}: real HTTP ${phase} timeout with ${policy} network retry policy`, async t => {
        let requests = 0;
        let firstRequest;
        const received = new Promise(resolve => { firstRequest = resolve; });
        const server = createServer((req, res) => {
          req.resume();
          requests++;
          firstRequest();
          if (policy !== 'recover' || requests === 1) {
            if (phase === 'stream') {
              res.writeHead(200, { 'content-type': 'text/event-stream' });
              res.flushHeaders();
            }
            return;
          }
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          const data = protocol === 'chat'
            ? { id: 'chat-test', choices: [{ index: 0, delta: { content: 'recovered' }, finish_reason: 'stop' }] }
            : { type: 'response.completed', response: { id: 'resp-test', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'recovered', annotations: [] }] }] } };
          const created = protocol === 'responses'
            ? `data: ${JSON.stringify({ type: 'response.created', response: { id: 'resp-test', status: 'in_progress', output: [] } })}\n\n` : '';
          res.end(`${created}data: ${JSON.stringify(data)}\n\ndata: [DONE]\n\n`);
        });
        t.after(() => new Promise(resolve => {
          server.close(resolve);
          server.closeAllConnections();
        }));
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const llm = factory({
          apiKey: 'test', model: 'test', baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
          timeoutMs: policy === 'cancel' ? 1000 : 100, maxRetries: 3,
        });
        const feature = new ForceContinuation({ apiErrorRetry: policy !== 'disabled', maxConsecutiveContinuations: 2 });
        const agent = new Agent({ llm, maxTurns: 3 }).use(feature);
        const arbiter = new CallArbiter(agent);
        const entry = arbiter.enqueue({ source: 'test', text: 'go' });
        if (policy === 'cancel') {
          await received;
          arbiter.interruptActive('user stop');
          agent.interrupt();
        }
        const finished = await arbiter.waitForCompletion(entry.id);
        assert.equal(requests, policy === 'recover' ? 2 : policy === 'exhausted' ? 3 : 1);
        if (policy === 'recover') {
          assert.equal(finished.status, 'completed');
          assert.ok(agent.getContext().getAll().some(message => message.content === 'recovered'));
        } else if (policy === 'cancel') {
          assert.equal(finished.status, 'cancelled');
          assert.equal(feature.getStatus().consecutiveContinuations, 0);
        } else {
          assert.equal(finished.status, 'failed');
          assert.equal(finished.outcome.error.category, 'connection_timeout');
          assert.equal(finished.outcome.error.retryable, true);
        }
      });
    }
  }
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
