/**
 * Deterministic implementation replay of ReceiptBoundary counterexamples.
 * Outside test/*.test.js: observations are NOT approval of the current policy.
 * REQUIRE_RECEIPT_DURABILITY=1 turns the observed durability violation into red.
 * No server/socket/model network: real Viewer methods behind injected transport.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Agent } from '@agentdevjs/core';
import { ViewerWorker } from '@agentdevjs/viewer';
import { createPassiveMailboxLoop } from '../../scripts/runtime-passive-mailbox.js';
import { CallArbiter } from '../../server/call-arbiter.js';

// This process never sends queue probes to the running Claw service.
process.env.AGENTDEV_VIEWER_ORIGIN = 'http://127.0.0.1:1';
process.env.AGENTDEV_VIEWER_PORT = '1';

const receiptIdentity = {
  commandId: 'tlc-command-1', threadId: 'tlc-thread-1', headGeneration: 1,
};

class SnapshotStore {
  fail = false;
  snapshots = [];
  async save(_id, snapshot) {
    if (this.fail) throw new Error('injected receipt disk failure');
    this.snapshots.push(structuredClone(snapshot));
    return 'memory://receipt-replay';
  }
  async load() { throw new Error('unused'); }
  async list() { return []; }
  async delete() {}
}

async function world(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'claw-tlc-replay-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  // Constructor does not bind; never call start(), so no real service is touched.
  const inherited = process.env.AGENTDEV_VIEWER_ADDR;
  delete process.env.AGENTDEV_VIEWER_ADDR;
  let viewer;
  try {
    viewer = new ViewerWorker(0, false, path.join(root, 'unused.sock'), { queuedInputStoreDir: root });
  } finally {
    if (inherited !== undefined) process.env.AGENTDEV_VIEWER_ADDR = inherited;
  }
  const id = 'tlc-viewer-agent';
  const runtimeIdentity = { runtimeInstanceId: 'tlc-runtime-1', ...receiptIdentity, sessionId: 'tlc-session-1' };
  const session = viewer.getOrCreateSession(id, 'TLC replay');
  const clientId = 'tlc-client';
  session.clientId = clientId;
  viewer.udsClients.set(clientId, { write() {}, destroy() {} });
  viewer.handleRegisterAgent({
    type: 'register-agent', agentId: id, name: 'TLC replay',
    runtimeInstanceId: runtimeIdentity.runtimeInstanceId,
    threadId: runtimeIdentity.threadId, headGeneration: runtimeIdentity.headGeneration,
    workSessionId: runtimeIdentity.sessionId,
  }, clientId);
  const submitted = viewer.submitUserTurn(id, {
    text: 'TLC-CANCELLED-PAYLOAD', sessionId: runtimeIdentity.sessionId,
    source: 'thread', sourceRef: receiptIdentity.commandId, commandIdentity: receiptIdentity,
  });
  assert.equal(submitted.success, true);
  const claimed = viewer.claimCommandInput(id);
  assert.ok(claimed?.inputLease);
  const store = new SnapshotStore();
  const modelInputs = [];
  const agent = new Agent({
    llm: { async chat(messages) { modelInputs.push(structuredClone(messages)); return { content: 'done' }; } },
    maxTurns: 1,
  });
  agent.enableStepAutoSave(runtimeIdentity.sessionId, store);
  agent.setRuntimeInputIdentity(runtimeIdentity);
  const ack = async identity => {
    if (!viewer.acknowledgeCommandInput(id, identity)) throw new Error('Command input acknowledgement failed: 409');
  };
  return { viewer, id, session, store, agent, claimed, modelInputs, ack, root };
}

const containsReceipt = snapshot => snapshot?.runtime.context?.messages?.some(
  message => message.inputReceipt?.commandId === receiptIdentity.commandId,
) === true;

test('TLC durability trace: failed save -> retained Context -> idle shortcut ack without durable snapshot', { timeout: 2000 }, async t => {
  const w = await world(t);
  // Include the real Arbiter and its production-style post-call save effect.
  // Keep the store unavailable through both save attempts, then retain the
  // volatile Context while the mailbox loop reaches its retry shortcut.
  w.store.fail = true;
  const arbiter = new CallArbiter(w.agent);
  let finishSave;
  const finishSaved = new Promise(resolve => { finishSave = resolve; });
  arbiter.on('callFinished', async () => {
    try { await w.agent.saveSession('tlc-session-1', w.store); }
    catch { /* production listener also logs and retains the failed save */ }
    finally { finishSave(); }
  });
  const entry = arbiter.enqueue({
    source: 'thread', text: w.claimed.text,
    inputReceipt: w.claimed.inputLease, acknowledgeInputReceipt: w.ack,
  });
  const ended = await arbiter.waitForCompletion(entry.id);
  await finishSaved;
  assert.equal(ended.status, 'failed');
  assert.equal(w.store.snapshots.length, 0);
  assert.equal(w.modelInputs.length, 0);
  assert.equal(arbiter.getStatus().status, 'idle');
  let disposed = false;
  let prematureAck = false;
  const enqueued = [];
  const loop = createPassiveMailboxLoop({
    agent: { agentId: w.id, getRuntimeInputIdentity: () => w.agent.getRuntimeInputIdentity(), getContext: () => w.agent.getContext() },
    callArbiter: {
      getStatus: () => ({ status: 'idle' }),
      enqueue: envelope => { enqueued.push(envelope); return { id: 'observed-resume' }; },
      waitForCompletion: async () => {},
    },
    isDisposed: () => disposed,
    pollIntervalMs: 1,
    viewerOrigin: 'http://tlc-replay.invalid',
    fetchImpl: async (url, init) => {
      if (url.endsWith('/command-input/claim')) {
        const input = w.viewer.claimCommandInput(w.id);
        assert.ok(input);
        return { ok: true, status: 200, json: async () => ({ input }) };
      }
      assert.ok(url.endsWith('/command-input/ack'), `unexpected transport ${url}`);
      prematureAck = !w.store.snapshots.some(containsReceipt);
      const accepted = w.viewer.acknowledgeCommandInput(w.id, JSON.parse(init.body).receipt);
      assert.equal(accepted, true);
      disposed = true;
      return { ok: true, status: 200, json: async () => ({ acknowledged: true }) };
    },
  });
  t.signal.addEventListener('abort', () => { disposed = true; loop.poke(); }, { once: true });
  await loop.run();
  assert.equal(w.viewer.claimCommandInput(w.id), null, 'real Viewer removed the durable queue item');
  // Read the persisted queue state from disk (store dir root, file queued-inputs/<agentId>.json)
  // to prove this is a durable dequeue, not only an in-memory array edit.
  const persisted = JSON.parse(await readFile(path.join(w.root, 'queued-inputs', `${w.id}.json`), 'utf8'));
  assert.equal(persisted.items.length, 0);
  assert.equal(persisted.consumedSourceRefs.includes(receiptIdentity.commandId), true);
  assert.equal(w.store.snapshots.length, 0);
  assert.equal(enqueued[0]?.kind, 'resume');
  console.log('OBSERVATION durability:', JSON.stringify({ prematureAck, durableSnapshots: w.store.snapshots.length, viewerQueueLength: w.session.queuedInputs.length }));
  if (process.env.REQUIRE_RECEIPT_DURABILITY === '1') {
    assert.equal(prematureAck, false, 'ADR-0047: ack must not precede a durable identity-bearing snapshot');
  } else {
    assert.equal(prematureAck, true, 'baseline changed: investigate rather than accepting a stale counterexample');
  }
});

test('TLC cancellation question: cancel wins -> ack rejected -> later ordinary model call still sees payload', async t => {
  const w = await world(t);
  // Cancel precisely after the identity-bearing snapshot is saved, before ack.
  await assert.rejects(w.agent.onCallDetailed(w.claimed.text, [], [], undefined, {
    inputReceipt: w.claimed.inputLease,
    acknowledgeInputReceipt: async identity => {
      assert.equal(containsReceipt(w.store.snapshots.at(-1)), true);
      // Real Viewer interrupt's persistent cancellation primitive, no UDS/network.
      const cancelled = w.viewer.cancelDurableQueuedInputs(w.id, w.session);
      assert.deepEqual(cancelled.map(item => item.commandId), [receiptIdentity.commandId]);
      await w.ack(identity);
    },
  }), /acknowledgement failed: 409/);
  assert.equal(w.modelInputs.length, 0, 'cancelled call itself does not reach the model');
  assert.equal(w.viewer.acknowledgeCommandInput(w.id, w.claimed.inputLease), false, 'late ack cannot resurrect consumption');
  await w.agent.onCallDetailed('A new independent user request');
  assert.equal(w.modelInputs.length, 1);
  const leaked = w.modelInputs[0].some(message => message.role === 'user' && message.content === w.claimed.text);
  assert.equal(leaked, true, 'baseline observation changed; reconsider the policy question');
  console.log('OBSERVATION cancellation:', JSON.stringify({ lateAckRejected: true, cancelledPayloadInLaterModelInput: leaked }));
});
