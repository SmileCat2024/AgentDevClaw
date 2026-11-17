import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Agent, WorkThreadRuntimeBridge, subscribeSessionEvents } from '@agentdevjs/core';
import { createThreadControl } from '../../server/thread-control/thread-controller.js';
import { buildSuccessionEvidence } from '../../server/thread-control/thread-integration.js';

async function world(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'claw-evidence-replay-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bridge = new WorkThreadRuntimeBridge({ enabled: true,
    submitTurn: async () => ({ success: true, delivery: 'queued' }),
    resolveRuntimeViewerId: () => 'isolated-transport' });
  const control = createThreadControl({ rootDir: root, bridge });
  const record = await control.core.start({ sessionRef: { agentId: 'evidence-host', sessionId: 'old' } });
  const threadId = record.threadId;
  const { command } = await control.core.appendCommand({ threadId, text: 'evidence payload' });
  const delivery = await control.core.deliverPendingCommands(threadId);
  assert.equal(delivery.delivered, 1);
  await control.core.beginSessionHandoff({ threadId, fromSessionId: 'old', reason: 'manual', seedContinuation: false });
  return { ...control, root, threadId, command };
}

async function commit(w, evidence) {
  return w.core.commitSessionSuccession({ threadId: w.threadId, fromSessionId: 'old',
    toSessionId: 'new', evidence, composeNotice: items => ({ text: `review ${items.map(i => i.commandId).join(',')}` }) });
}

function eventRecord(w, event) {
  return w.board.recordRuntimeEvent({ agentId: 'evidence-host', sessionId: 'old',
    runtimeInstanceId: 'evidence-runtime', event: { ...event, at: Date.now() } });
}

test('early turn reference plus failed snapshot is classified consumed by real succession transaction', async t => {
  const w = await world(t);
  const captured = [];
  const unsubscribe = subscribeSessionEvents(event => {
    if (event.type === 'turn.started' && event.sourceRef === w.command.commandId) captured.push(structuredClone(event));
  });
  t.after(unsubscribe);
  let saves = 0;
  let modelCalls = 0;
  let acks = 0;
  const agent = new Agent({ llm: { async chat() { modelCalls++; return { content: 'unused' }; } }, maxTurns: 1 });
  agent.enableStepAutoSave('old', { async save() { saves++; throw new Error('injected snapshot failure'); } });
  await assert.rejects(agent.onCallDetailed(w.command.text, [], [], undefined, {
    source: 'thread', sourceRef: w.command.commandId,
    inputReceipt: { commandId: w.command.commandId, threadId: w.threadId, headGeneration: 1,
      runtimeInstanceId: 'evidence-runtime', sessionId: 'old', leaseId: 'test-lease' },
    acknowledgeInputReceipt: async () => { acks++; },
  }), /injected snapshot failure/);
  assert.equal(captured.length, 1);
  assert.equal(saves, 1);
  assert.equal(modelCalls, 0);
  assert.equal(acks, 0);
  await eventRecord(w, captured[0]);
  const evidence = await buildSuccessionEvidence(w.board, w.threadId);
  assert.equal(evidence.integrity, 'ok');
  const result = await commit(w, evidence);
  assert.deepEqual(result.consumedCommandIds, [w.command.commandId]);
  assert.equal(result.unresolved.length, 0);
  console.log('OBSERVATION early evidence:', JSON.stringify({ successfulSnapshots: 0,
    modelCalls, acks, classifiedConsumed: result.consumedCommandIds.length, unresolved: result.unresolved.length }));
  if (process.env.REQUIRE_EVIDENCE_DURABILITY === '1') {
    assert.equal(result.consumedCommandIds.length, 0, 'a pre-save reference must not prove durable input ownership');
  }
});

test('evidence sampled before a late positive reference stays conservative and notice survives reload', async t => {
  const w = await world(t);
  const evidence = await buildSuccessionEvidence(w.board, w.threadId);
  await eventRecord(w, { type: 'turn.completed', turn: 0, sourceRef: w.command.commandId });
  const result = await commit(w, evidence);
  assert.equal(result.consumedCommandIds.length, 0);
  assert.equal(result.unresolved.length, 1);
  const independent = createThreadControl({ rootDir: w.root, bridge: new WorkThreadRuntimeBridge({ enabled: false }) });
  const reloaded = await independent.core.getThread(w.threadId);
  assert.equal(reloaded.headSessionId, 'new');
  assert.equal(reloaded.unresolvedCommands.length, 1);
  assert.ok(reloaded.commands.some(c => c.text === `review ${w.command.commandId}`));
});

test('missing/corrupt evidence creates unresolved; unreadable evidence rejects without changing head', async t => {
  for (const integrity of ['missing', 'corrupt', 'unreadable']) {
    const w = await world(t);
    const evidence = await buildSuccessionEvidence({ readStateDetailed: async () => {
      if (integrity === 'unreadable') throw new Error('injected read failure');
      return { integrity, error: 'injected corruption' };
    } }, w.threadId);
    assert.equal(evidence.integrity, integrity);
    if (integrity === 'unreadable') {
      await assert.rejects(commit(w, evidence), { code: 'evidence_unreadable' });
      const unchanged = await w.core.getThread(w.threadId);
      assert.equal(unchanged.headSessionId, 'old');
      assert.ok(unchanged.pendingSuccession);
    } else {
      const result = await commit(w, evidence);
      assert.equal(result.unresolved.length, 1);
      assert.equal(result.unresolved[0].reason, `evidence_${integrity}`);
    }
  }
});
