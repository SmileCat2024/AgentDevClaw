import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ViewerWorker } from '@agentdevjs/viewer';
import { WorkThreadRuntimeBridge } from '@agentdevjs/core';
import { createThreadControl } from '../../server/thread-control/thread-controller.js';
import { CallArbiter } from '../../server/call-arbiter.js';

async function setup(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'claw-cancel-cutoff-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inherited = process.env.AGENTDEV_VIEWER_ADDR;
  delete process.env.AGENTDEV_VIEWER_ADDR;
  let viewer;
  try { viewer = new ViewerWorker(0, false, path.join(root, 'unused.sock'), { queuedInputStoreDir: root }); }
  finally { if (inherited !== undefined) process.env.AGENTDEV_VIEWER_ADDR = inherited; }
  const frames = [];
  viewer.udsClients.set('client', { write: text => { frames.push(JSON.parse(text)); }, destroy() {} });
  const bridge = new WorkThreadRuntimeBridge({ enabled: true, resolveRuntimeViewerId: () => 'cancel-agent',
    submitTurn: async p => {
      const { kind: _kind, ...input } = p;
      const result = viewer.submitUserTurn(p.agentId, input);
      assert.equal(result.success, true, JSON.stringify(result));
      return result;
    } });
  const control = createThreadControl({ rootDir: path.join(root, 'threads'), bridge });
  const thread = await control.core.start({ sessionRef: { agentId: 'cancel-host', sessionId: 'session' } });
  viewer.handleRegisterAgent({ type: 'register-agent', agentId: 'cancel-agent', name: 'cutoff replay',
    runtimeInstanceId: 'runtime', threadId: thread.threadId, headGeneration: 1, workSessionId: 'session' }, 'client');
  const interrupt = () => {
    let status;
    let body;
    viewer.handleInterrupt({}, { writeHead: s => { status = s; }, end: text => { body = JSON.parse(text); } }, 'cancel-agent');
    assert.equal(status, 200);
    assert.equal(body.success, true);
    return body;
  };
  return { root, viewer, frames, interrupt, ...control, threadId: thread.threadId };
}

test('Viewer cutoff does not cancel a pre-existing Inbox pending command absent from its queue', async t => {
  const w = await setup(t);
  const { command: pending } = await w.core.appendCommand({ threadId: w.threadId, text: 'before stop, not delivered yet' });
  const stopped = w.interrupt();
  assert.deepEqual(stopped.cancelledCommandIds, []);
  const result = await w.core.deliverPendingCommands(w.threadId);
  assert.equal(result.delivered, 1);
  const claim = w.viewer.claimCommandInput('cancel-agent');
  assert.equal(claim.inputLease.commandId, pending.commandId);
  console.log('OBSERVATION pending cutoff:', JSON.stringify({ acceptedStop: true, preStopPendingClaimable: true }));
  if (process.env.REQUIRE_GLOBAL_CANCEL_CUTOFF === '1') {
    assert.equal(claim, null, 'ADR-0047 6.2: pre-cutoff pending Inbox input must not be delivered after stop');
  }
});

test('local Viewer cutoff persists old cancellation and preserves a new post-cutoff input', async t => {
  const w = await setup(t);
  const { command: old } = await w.core.appendCommand({ threadId: w.threadId, text: 'before stop' });
  assert.equal((await w.core.deliverPendingCommands(w.threadId)).delivered, 1);
  const receipt = w.viewer.claimCommandInput('cancel-agent').inputLease;
  const stopped = w.interrupt();
  assert.deepEqual(stopped.cancelledCommandIds, [old.commandId]);
  assert.equal(w.viewer.acknowledgeCommandInput('cancel-agent', receipt), false);
  const { command: fresh } = await w.core.appendCommand({ threadId: w.threadId, text: 'after stop' });
  assert.equal((await w.core.deliverPendingCommands(w.threadId)).delivered, 1);
  assert.equal(w.viewer.claimCommandInput('cancel-agent').inputLease.commandId, fresh.commandId);
  const persisted = JSON.parse(await readFile(path.join(w.root, 'queued-inputs/cancel-agent.json'), 'utf8'));
  assert.ok(persisted.cancelledCommandIds.includes(old.commandId));
  assert.equal(persisted.cancelledCommandIds.includes(fresh.commandId), false);
  // Runtime has not received the frame. HTTP success is not Inbox cancellation completion.
  assert.equal((await w.core.getThread(w.threadId)).commands.find(c => c.commandId === old.commandId).status, 'delivered');
});

test('delayed interrupt frame clears an Arbiter input admitted after the Viewer checkpoint', async t => {
  const w = await setup(t);
  let release;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const arbiter = new CallArbiter({ async onCall() { entered(); await gate; return ''; } });
  const active = arbiter.enqueue({ source: 'test', text: 'already running' });
  t.after(async () => { release(); await arbiter.waitForCompletion(active.id); });
  await started;
  w.interrupt();
  const frame = w.frames.find(f => f.type === 'interrupt-agent');
  assert.ok(frame);
  const fresh = arbiter.enqueue({ source: 'external', text: 'submitted after Viewer cutoff' });
  const done = arbiter.waitForCompletion(fresh.id);
  arbiter.interruptActive('cancelled by interrupt', { clearQueue: frame.clearQueue });
  const ended = await done;
  assert.equal(ended.status, 'cancelled');
  console.log('OBSERVATION runtime cutoff:', JSON.stringify({ postCheckpointEnvelope: ended.status }));
  if (process.env.REQUIRE_GLOBAL_CANCEL_CUTOFF === '1') {
    assert.notEqual(ended.status, 'cancelled', 'post-cutoff input must survive an older delayed stop request');
  }
});
