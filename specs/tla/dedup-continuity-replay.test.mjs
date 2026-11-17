import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Agent, TrimTranscriptTransformation, SummaryTransformation } from '@agentdevjs/core';
import { createPassiveMailboxLoop } from '../../scripts/runtime-passive-mailbox.js';
import { CallArbiter } from '../../server/call-arbiter.js';

// Never let framework queue probes inherit the live service address.
process.env.AGENTDEV_VIEWER_ORIGIN = 'http://127.0.0.1:1';
process.env.AGENTDEV_VIEWER_PORT = '1';

const receipt = { commandId: 'old-command', threadId: 'thread', headGeneration: 1,
  sessionId: 'session', runtimeInstanceId: 'runtime', leaseId: 'lease' };
const messages = [{ role: 'user', content: 'already processed intent', turn: 0, inputReceipt: receipt },
  { role: 'assistant', content: 'processed', turn: 0 }];
const snapshot = { runtime: { context: { messages } } };

test('receipt metadata differs across default trim, preserved trim and summary seeds', async () => {
  const input = { sourceSnapshot: snapshot };
  const trim = await new TrimTranscriptTransformation().transform(input, {});
  const preserved = await new TrimTranscriptTransformation().transform({ ...input, policy: { fullPreserveFromTurn: 0 } }, {});
  const summary = await new SummaryTransformation().transform(input, { llm: { chat: async () => ({ content: 'summary of completed work' }) } });
  assert.equal(trim.seedMessages.some(m => m.content === messages[0].content), true);
  assert.equal(trim.seedMessages.some(m => m.inputReceipt), false);
  assert.equal(preserved.seedMessages.some(m => m.inputReceipt?.commandId === receipt.commandId), true);
  assert.equal(summary.seedMessages.some(m => m.inputReceipt), false);
  console.log('OBSERVATION transformed receipts:', JSON.stringify({ trim: false, preservedTrim: true, summary: false }));
});

test('same-generation delayed input reaches model when caller supplies a transformed context with no receipt', async () => {
  const trim = await new TrimTranscriptTransformation().transform({ sourceSnapshot: snapshot }, {});
  const modelInputs = [];
  const agent = new Agent({ llm: { async chat(input) { modelInputs.push(structuredClone(input)); return { content: 'done' }; } }, maxTurns: 1 });
  const context = agent.getContext();
  agent.withContext(context);
  for (const message of trim.seedMessages) {
    if (message.role === 'user') context.addUserMessage(message.content, message.turn);
    else if (message.role === 'assistant') context.addAssistantMessage(message.content, message.turn);
  }
  const saved = [];
  agent.enableStepAutoSave('session', { async save(_id, state) { saved.push(structuredClone(state)); return 'memory://replay'; } });
  let disposed = false;
  let claimed = false;
  let acks = 0;
  const arbiter = new CallArbiter(agent);
  arbiter.on('callFinished', () => { disposed = true; });
  const loop = createPassiveMailboxLoop({
    agent: { agentId: 'agent', getRuntimeInputIdentity: () => ({ threadId: 'thread', headGeneration: 1 }), getContext: () => context },
    callArbiter: arbiter,
    isDisposed: () => disposed, pollIntervalMs: 1, viewerOrigin: 'http://replay.invalid',
    fetchImpl: async url => {
      if (url.endsWith('/claim')) { assert.equal(claimed, false); claimed = true; return { ok: true, status: 200,
        json: async () => ({ input: { text: messages[0].content, inputLease: receipt } }) }; }
      acks++; return { ok: true, status: 200 };
    },
  });
  await loop.run();
  assert.equal(acks, 1);
  assert.ok(saved.length > 0);
  assert.equal(modelInputs.length, 1);
  assert.equal(modelInputs[0].filter(m => m.role === 'user' && m.content === messages[0].content).length, 2);
});
