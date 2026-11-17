import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ViewerWorker } from '@agentdevjs/viewer';

async function setup(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'claw-tlc-deep-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inherited = process.env.AGENTDEV_VIEWER_ADDR;
  delete process.env.AGENTDEV_VIEWER_ADDR;
  let viewer;
  try { viewer = new ViewerWorker(0, false, path.join(root, 'unused.sock'), { queuedInputStoreDir: root }); }
  finally { if (inherited !== undefined) process.env.AGENTDEV_VIEWER_ADDR = inherited; }
  const id = 'deep-agent';
  viewer.udsClients.set('client', { write() {}, destroy() {} });
  const register = (runtime, generation = 1) => viewer.handleRegisterAgent({
    type: 'register-agent', agentId: id, name: 'deep replay',
    runtimeInstanceId: runtime, threadId: 'thread', headGeneration: generation,
    workSessionId: 'session',
  }, 'client');
  register('runtime-1');
  const submit = (commandId, generation = 1) => viewer.submitUserTurn(id, {
    text: `payload:${commandId}`, source: 'thread', sourceRef: commandId,
    sessionId: 'session', commandIdentity: { commandId, threadId: 'thread', headGeneration: generation },
  });
  return { viewer, id, register, submit };
}

test('FIFO and lease fencing: repeated claim stable, new incarnation invalidates old ack, durable ack retry accepted', async t => {
  const w = await setup(t);
  for (const c of ['a', 'b', 'c']) assert.equal(w.submit(c).success, true);
  const first = w.viewer.claimCommandInput(w.id);
  assert.equal(first.inputLease.commandId, 'a');
  assert.deepEqual(w.viewer.claimCommandInput(w.id).inputLease, first.inputLease);
  w.register('runtime-2');
  assert.equal(w.viewer.acknowledgeCommandInput(w.id, first.inputLease), false);
  const replacement = w.viewer.claimCommandInput(w.id);
  assert.notEqual(replacement.inputLease.leaseId, first.inputLease.leaseId);
  assert.equal(w.viewer.acknowledgeCommandInput(w.id, replacement.inputLease), true);
  assert.equal(w.viewer.acknowledgeCommandInput(w.id, replacement.inputLease), true);
  for (const c of ['b', 'c']) {
    const input = w.viewer.claimCommandInput(w.id);
    assert.equal(input.inputLease.commandId, c);
    assert.equal(w.viewer.acknowledgeCommandInput(w.id, input.inputLease), true);
  }
  assert.equal(w.viewer.claimCommandInput(w.id), null);
});

test('identity change: already-consumed old receipt is rejected despite retained consumption history', async t => {
  const w = await setup(t);
  w.submit('a');
  const receipt = w.viewer.claimCommandInput(w.id).inputLease;
  assert.equal(w.viewer.acknowledgeCommandInput(w.id, receipt), true);
  w.register('runtime-2');
  assert.equal(w.viewer.acknowledgeCommandInput(w.id, receipt), false);
  assert.equal(w.submit('a').delivery, 'consumed');
  w.register('runtime-2', 2);
  assert.equal(w.submit('fresh-old-gen', 1).success, false);
  assert.equal(w.submit('fresh-new-gen', 2).success, true);
});

test('consumption retention boundary: 500 newer acks evict earlier receipt; delayed retry and admission differ', { timeout: 2000 }, async t => {
  const w = await setup(t);
  w.submit('first');
  const receipt = w.viewer.claimCommandInput(w.id).inputLease;
  assert.equal(w.viewer.acknowledgeCommandInput(w.id, receipt), true);
  for (let i = 0; i < 500; i++) {
    assert.equal(w.submit(`later-${i}`).success, true);
    assert.equal(w.viewer.acknowledgeCommandInput(w.id, w.viewer.claimCommandInput(w.id).inputLease), true);
    if (i === 498) {
      assert.equal(w.viewer.acknowledgeCommandInput(w.id, receipt), true);
      assert.equal(w.submit('first').delivery, 'consumed');
    }
  }
  assert.equal(w.viewer.acknowledgeCommandInput(w.id, receipt), false);
  const admission = w.submit('first');
  assert.equal(admission.success, true);
  assert.equal(admission.delivery, 'queued');
  assert.equal(w.viewer.claimCommandInput(w.id).inputLease.commandId, 'first');
  // Proves re-admission/claim, NOT duplicate business execution: Agent snapshot
  // dedup and upstream retry feasibility require their own evidence.
});

test('batch cancellation beyond retention: oldest cancelled command can be admitted again', { timeout: 2000 }, async t => {
  const w = await setup(t);
  for (let i = 0; i <= 500; i++) assert.equal(w.submit(`cancel-${i}`).success, true);
  const session = w.viewer.getOrCreateSession(w.id, 'deep replay');
  // Same primitive used by interrupt, not a claim to exercise the HTTP route.
  const cancelled = w.viewer.cancelDurableQueuedInputs(w.id, session);
  assert.equal(cancelled.length, 501);
  assert.equal(w.submit('cancel-500').code, 'command_cancelled');
  assert.equal(w.submit('cancel-1').code, 'command_cancelled');
  const oldest = w.submit('cancel-0');
  assert.equal(oldest.success, true);
  assert.equal(oldest.delivery, 'queued');
});
