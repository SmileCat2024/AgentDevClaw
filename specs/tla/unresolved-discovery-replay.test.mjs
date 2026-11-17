import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Agent, FileSessionStore, HandoffSeedFeature, WorkThreadRuntimeBridge,
  TrimTranscriptTransformation, SummaryTransformation, TrimTranscriptWithSummaryTransformation } from '@agentdevjs/core';
import { ViewerWorker } from '@agentdevjs/viewer';
import { createThreadControl, bridgeParamsToSubmitTurnArgs } from '../../server/thread-control/thread-controller.js';
import { createThreadIntegration } from '../../server/thread-control/thread-integration.js';
import { createThreadRestartResume } from '../../server/thread-control/thread-restart-resume.js';
import { applyContinuityToolPolicy } from '../../server/context-continuity/feature-continuity.js';

// All persistence is temporary; queue probes cannot reach the live service.
process.env.AGENTDEV_VIEWER_ORIGIN = 'http://127.0.0.1:1';
process.env.AGENTDEV_VIEWER_PORT = '1';

async function world(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'claw-discovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sent = [];
  const bridge = new WorkThreadRuntimeBridge({ enabled: true,
    resolveRuntimeViewerId: (_agentId, sessionId) => `viewer-${sessionId}`,
    submitTurn: async payload => { sent.push(bridgeParamsToSubmitTurnArgs(payload)); return { success: true }; } });
  const control = createThreadControl({ rootDir: path.join(root, 'threads'), bridge });
  const integration = createThreadIntegration({ control, publishThreadEvent() {} });
  const thread = await control.core.start({ sessionRef: { agentId: 'discovery-host', sessionId: 'old' } });
  await control.core.appendCommand({ threadId: thread.threadId, text: 'Check whether the deployment already happened before doing anything again.' });
  assert.equal((await control.core.deliverPendingCommands(thread.threadId)).delivered, 1);
  const advance = async (from, to, automatic = true) => {
    assert.equal((await integration.beginSessionSuccession({ agentId: thread.agentId, sessionId: from,
      reason: automatic ? 'automatic' : 'manual', seedContinuation: automatic })).applied, true);
    const result = await integration.applySessionSuccession({ agentId: thread.agentId,
      fromSessionId: from, toSessionId: to, reason: automatic ? 'automatic' : 'manual', seedContinuation: automatic });
    assert.equal(result.applied, true);
    return result;
  };
  const first = await advance('old', 'middle');
  assert.equal(first.unresolved.length, 1);
  return { root, control, threadId: thread.threadId, sent, advance,
    unresolvedId: first.unresolved[0].unresolvedId, store: new FileSessionStore(path.join(root, 'sessions')) };
}

async function runAgent(w, sessionId, seed, inputs) {
  const requests = [];
  const agent = new Agent({ llm: { async chat(messages) {
    requests.push(structuredClone(messages)); return { content: 'No recovery decision has been made.' };
  } }, maxTurns: 1 });
  agent.withContext(agent.getContext());
  if (seed) agent.use(new HandoffSeedFeature({ handoff: { packageId: `seed-${sessionId}`,
    sourceSessionId: 'middle', seedMessages: seed.seedMessages } }));
  for (const input of inputs) {
    await agent.onCallDetailed(input.text, [], [], undefined, {
      ...(input.kind ? { kind: input.kind } : {}), source: input.source || 'test', sourceRef: input.sourceRef,
    });
  }
  await agent.saveSession(sessionId, w.store);
  return { requests, snapshot: await new FileSessionStore(path.join(w.root, 'sessions')).load(sessionId) };
}

const includes = (messages, id) => messages.some(m => String(m.content).includes(id));
const middleInputs = w => w.sent.filter(p => p.sessionId === 'middle');

for (const mode of ['trim', 'summary', 'trim-summary', 'preserved-system-control']) {
  test(`unresolved discovery through real ${mode} seed and successor model request`, async t => {
    const w = await world(t);
    assert.ok(middleInputs(w).some(p => p.kind === 'reminder' && p.text.includes(w.unresolvedId)));
    const middle = await runAgent(w, 'middle', null, middleInputs(w));
    assert.ok(middle.requests.some(r => includes(r, w.unresolvedId)), 'middle really saw the notice');
    assert.ok(includes(middle.snapshot.runtime.context.messages, w.unresolvedId), 'notice was saved');
    const summaryRequests = [];
    const ctx = { llm: { async chat(messages) {
      summaryRequests.push(structuredClone(messages));
      // A deterministic omission probes whether discovery relies only on LLM summary fidelity.
      return { content: 'The conversation is continuing. The current task remains in progress.' };
    } } };
    const policy = applyContinuityToolPolicy(mode === 'preserved-system-control' ? { includeSystemMessages: true } : {});
    const transform = mode === 'summary' ? new SummaryTransformation()
      : mode === 'trim-summary' ? new TrimTranscriptWithSummaryTransformation({ trimPolicy: policy })
        : new TrimTranscriptTransformation();
    const seed = await transform.transform({ sourceSnapshot: middle.snapshot, policy }, ctx);
    const second = await w.advance('middle', 'last');
    assert.equal(second.unresolved.length, 0, 'no new ambiguity is needed for this scenario');
    const nextInputs = w.sent.filter(p => p.sessionId === 'last');
    assert.ok(nextInputs.find(p => p.text.includes(w.unresolvedId))?.text.includes('来源会话 old'),
      'a carried item must retain its actual origin rather than attributing it to the most recent session');
    const last = await runAgent(w, 'last', seed, nextInputs.length ? nextInputs : [{ text: 'Continue the current work.' }]);
    const visible = last.requests.some(r => includes(r, w.unresolvedId));
    assert.equal(includes(seed.seedMessages, w.unresolvedId), mode === 'preserved-system-control');
    assert.equal(nextInputs.filter(p => p.text.includes(w.unresolvedId)).length, 1,
      'automatic succession must deliver the current open item independently of historical seed content');
    assert.equal(visible, true, 'the actual successor model request must contain the unresolved item');
    if (summaryRequests.length) assert.ok(summaryRequests.some(r => includes(r, w.unresolvedId)), 'summary input contains the notice; omission is in the injected summary result');
    const reloaded = createThreadControl({ rootDir: path.join(w.root, 'threads'), bridge: new WorkThreadRuntimeBridge({}) });
    assert.equal((await reloaded.core.listUnresolved(w.threadId))[0].unresolvedId, w.unresolvedId);
    console.log('OBSERVATION discovery:', JSON.stringify({ mode, openOnDisk: true,
      noticeInSuccessorSeed: includes(seed.seedMessages, w.unresolvedId), noticeInSuccessorRequest: visible }));
  });
}

test('a dequeued machine notice is absent after Viewer recreation before a session snapshot', async t => {
  const w = await world(t);
  const queueDir = path.join(w.root, 'viewer');
  const inherited = process.env.AGENTDEV_VIEWER_ADDR;
  delete process.env.AGENTDEV_VIEWER_ADDR;
  let viewer;
  let restored;
  try {
    viewer = new ViewerWorker(0, false, path.join(w.root, 'unused.sock'), { queuedInputStoreDir: queueDir });
    const session = viewer.getOrCreateSession('isolated-middle', 'isolated');
    session.clientId = 'isolated-client';
    viewer.udsClients.set('isolated-client', { write() {}, destroy() {} });
    const notice = middleInputs(w).find(p => p.text.includes(w.unresolvedId));
    const submitted = viewer.submitUserTurn('isolated-middle', notice);
    assert.equal(submitted.success, true, JSON.stringify(submitted));
    let response;
    viewer.handleDequeueInput({}, { writeHead(code) { assert.equal(code, 200); },
      end(body) { response = JSON.parse(body); } }, 'isolated-middle');
    assert.ok(response.input.text.includes(w.unresolvedId), 'actual dequeue response carries the item');
    // The runtime disappears after receiving the response but before adding/saving it.
    restored = new ViewerWorker(0, false, path.join(w.root, 'unused-restored.sock'), { queuedInputStoreDir: queueDir });
  } finally {
    if (inherited !== undefined) process.env.AGENTDEV_VIEWER_ADDR = inherited;
  }
  assert.equal(restored.getOrCreateSession('isolated-middle', 'recreated').queuedInputs.length, 0);
  assert.equal((await w.control.core.listUnresolved(w.threadId))[0].unresolvedId, w.unresolvedId);
  console.log('OBSERVATION machine notice crash boundary:', JSON.stringify({
    dequeued: true, restoredViewerQueueEmpty: true, unresolvedStillOpen: true,
    limitation: 'same viewer id, reconstructed worker, no actual process kill or complete startup' }));
});

test('delivered notice absent from session is not recovered by a fresh startup scan', async t => {
  const w = await world(t);
  assert.ok(middleInputs(w).some(p => p.text.includes(w.unresolvedId)));
  // An input received by transport but not consumed has no corresponding session message.
  const empty = await runAgent(w, 'middle', null, [{ text: 'Earlier unrelated work.' }]);
  assert.equal(includes(empty.snapshot.runtime.context.messages, w.unresolvedId), false);
  const control = createThreadControl({ rootDir: path.join(w.root, 'threads'), bridge: new WorkThreadRuntimeBridge({}) });
  const wakes = [];
  const recovery = createThreadRestartResume({ control: { ...control, resolveSessionViewerId: () => 'isolated-viewer' },
    ensureHeadRuntime: async (...args) => { wakes.push(args); return { ok: true }; },
    submitUserTurn: async () => { throw new Error('not expected'); } });
  const report = await recovery.resumeInterruptedThreads();
  assert.equal((await control.core.listUnresolved(w.threadId))[0].unresolvedId, w.unresolvedId);
  assert.equal(report.resumed.length, 0);
  assert.equal(report.skipped[0].reason, 'board_missing');
  assert.equal(wakes.length, 0);
  console.log('OBSERVATION restart:', JSON.stringify({ openOnDisk: true, sessionHasNotice: false, wakes: 0,
    limitation: 'Viewer transport acceptance is captured, not a full host crash; old Viewer queue recovery is not exercised' }));
});
