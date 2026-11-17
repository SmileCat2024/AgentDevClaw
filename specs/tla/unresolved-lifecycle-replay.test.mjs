import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkThreadRuntimeBridge } from '@agentdevjs/core';
import { createThreadControl } from '../../server/thread-control/thread-controller.js';
import { setupThreadRoutes } from '../../server/thread-control/thread-routes.js';
import { createThreadLifecycleService } from '../../server/thread-control/thread-lifecycle.js';
import { createThreadRestartResume } from '../../server/thread-control/thread-restart-resume.js';

async function setup(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'claw-unresolved-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sent = [];
  const bridge = new WorkThreadRuntimeBridge({ enabled: true, resolveRuntimeViewerId: () => 'isolated-viewer',
    submitTurn: async p => { sent.push(structuredClone(p)); return { success: true }; } });
  const control = createThreadControl({ rootDir: root, bridge });
  const thread = await control.core.start({ sessionRef: { agentId: 'unresolved-host', sessionId: 'old' } });
  const { command } = await control.core.appendCommand({ threadId: thread.threadId, text: 'uncertain intent',
    metadata: { sourceDetail: { value: 'keep' } }, capabilityActivations: ['test-capability'] });
  assert.equal((await control.core.deliverPendingCommands(thread.threadId)).delivered, 1);
  const advance = async (from, to, auto = true) => {
    await control.core.beginSessionHandoff({ threadId: thread.threadId, fromSessionId: from,
      seedContinuation: false, reason: auto ? 'automatic' : 'manual' });
    return control.core.commitSessionSuccession({ threadId: thread.threadId, fromSessionId: from, toSessionId: to,
      evidence: { integrity: 'missing', events: [] },
      ...(auto ? { composeNotice: items => ({ text: `review:${items.map(i => i.unresolvedId).join(',')}` }) } : {}) });
  };
  const routes = {};
  const app = { get(p, ...h) { routes[`GET ${p}`] = h; }, post(p, ...h) { routes[`POST ${p}`] = h; } };
  setupThreadRoutes(app, { json: () => () => {} }, { control, tryDeliver: async () => { throw new Error('injected transport failure'); } });
  const call = async (method, pattern, params, body = {}, query = {}) => {
    const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; },
      json(b) { this.body = b; return this; } };
    await routes[`${method} ${pattern}`].at(-1)({ params, body, query }, res);
    return res;
  };
  return { ...control, root, sent, advance, command, threadId: thread.threadId, call };
}

const listRoute = '/protoclaw/threads/:threadId/unresolved';
const resolveRoute = '/protoclaw/threads/:threadId/unresolved/:unresolvedId/resolve';

test('concurrent reissue creates one new durable input; conflicting decision rejected despite delivery failure', async t => {
  const w = await setup(t);
  const first = await w.advance('old', 'new');
  const unresolvedId = first.unresolved[0].unresolvedId;
  const params = { threadId: w.threadId, unresolvedId };
  const answers = await Promise.all([1, 2].map(() => w.call('POST', resolveRoute, params, { resolution: 'reissue' })));
  for (const answer of answers) {
    assert.equal(answer.statusCode, 200);
    assert.equal(answer.body.command.status, 'pending');
    assert.equal(answer.body.delivery.reason, 'error');
    assert.equal(answer.body.command.metadata.reissueOf, w.command.commandId);
  }
  assert.equal(answers[0].body.command.commandId, answers[1].body.command.commandId);
  assert.notEqual(answers[0].body.command.commandId, w.command.commandId);
  const conflict = await w.call('POST', resolveRoute, params, { resolution: 'discard' });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.body.code, 'unresolved_already_resolved');
  const independent = createThreadControl({ rootDir: w.root, bridge: new WorkThreadRuntimeBridge({ enabled: false }) });
  const record = await independent.core.getThread(w.threadId);
  assert.equal(record.commands.filter(c => c.metadata?.reissueOf === w.command.commandId).length, 1);
  assert.equal(record.unresolvedCommands.find(u => u.unresolvedId === unresolvedId).resolution, 'reissue');
  assert.deepEqual(record.commands.find(c => c.metadata?.reissueOf).capabilityActivations, ['test-capability']);
});

test('archive preserves open unresolved and API visibility without starting work; reissue while archived remains held', async t => {
  const w = await setup(t);
  const first = await w.advance('old', 'new', false);
  assert.equal(first.unresolved.length, 1);
  assert.equal(first.record.commands.some(c => c.kind === 'system_continuation'), false);
  assert.equal(w.sent.length, 1, 'manual succession must not submit a new model input');
  const lifecycle = createThreadLifecycleService({ control: w, stopSession: async () => {}, publishThreadEvent: () => {} });
  await lifecycle.archiveThread(w.threadId);
  const params = { threadId: w.threadId };
  const found = await w.call('GET', listRoute, params);
  assert.equal(found.body.unresolved.length, 1);
  assert.equal(found.body.unresolved[0].commandId, w.command.commandId);
  const answer = await w.call('POST', resolveRoute, { ...params, unresolvedId: first.unresolved[0].unresolvedId }, { resolution: 'reissue' });
  assert.equal(answer.statusCode, 200);
  assert.equal(answer.body.command.status, 'pending');
  const delivered = await w.core.deliverPendingCommands(w.threadId);
  assert.equal(delivered.delivered, 0);
  const record = await w.core.getThread(w.threadId);
  assert.equal(record.hold, true);
  assert.ok(record.commands.some(c => c.commandId === answer.body.command.commandId));
});

test('automatic succession notifies the new head of existing open items even when no new ambiguity is created', async t => {
  const w = await setup(t);
  const first = await w.advance('old', 'middle');
  const id = first.unresolved[0].unresolvedId;
  assert.equal((await w.core.deliverPendingCommands(w.threadId)).delivered, 1);
  assert.ok(w.sent.some(p => p.sessionId === 'middle' && p.text.includes(id)));
  const second = await w.advance('middle', 'last');
  assert.equal(second.unresolved.length, 0, 'no newly ambiguous ordinary command');
  const after = await w.core.deliverPendingCommands(w.threadId);
  assert.equal(after.delivered, 1);
  const listed = await w.call('GET', listRoute, { threadId: w.threadId });
  assert.equal(listed.body.unresolved.some(u => u.unresolvedId === id), true);
  assert.equal(w.sent.filter(p => p.sessionId === 'last' && p.text.includes(id)).length, 1);
  assert.equal((await w.core.deliverPendingCommands(w.threadId)).delivered, 0, 'repeat delivery must not create another notice');
  console.log('OBSERVATION second head:', JSON.stringify({ openQueryable: true, newNotice: true }));
});

test('legacy delivered command without deliveredAt is recreated as unresolved after explicit discard and another succession', async t => {
  const w = await setup(t);
  // Historical records without deliveredAt are explicitly supported as unattributable.
  // Only the fixture is edited; classification, resolution and both commits execute normally.
  await w.store.update(w.threadId, draft => {
    delete draft.commands.find(c => c.commandId === w.command.commandId).deliveredAt;
    return draft;
  });
  const first = await w.advance('old', 'middle', false);
  assert.equal(first.unresolved[0].reason, 'unattributable');
  const firstId = first.unresolved[0].unresolvedId;
  const discarded = await w.call('POST', resolveRoute, { threadId: w.threadId, unresolvedId: firstId }, { resolution: 'discard' });
  assert.equal(discarded.statusCode, 200);
  assert.equal((await w.core.listUnresolved(w.threadId)).length, 0);
  const second = await w.advance('middle', 'last', false);
  assert.equal(second.unresolved.length, 1);
  assert.equal(second.unresolved[0].commandId, w.command.commandId);
  assert.notEqual(second.unresolved[0].unresolvedId, firstId);
  const independent = createThreadControl({ rootDir: w.root, bridge: new WorkThreadRuntimeBridge({ enabled: false }) });
  const all = await independent.core.listUnresolved(w.threadId, { includeResolved: true });
  assert.equal(all.filter(u => u.commandId === w.command.commandId).length, 2);
  console.log('OBSERVATION legacy resolution:', JSON.stringify({ explicitlyDiscarded: true, reopenedOnNextSuccession: true }));
  if (process.env.REQUIRE_UNRESOLVED_RESOLUTION_FINALITY === '1') {
    assert.equal(second.unresolved.length, 0, 'an explicit discard must not be reopened solely because another head retires');
  }
});

test('closed thread rejects reissue but permits durable audit resolution', async t => {
  const w = await setup(t);
  const first = await w.advance('old', 'new', false);
  const params = { threadId: w.threadId, unresolvedId: first.unresolved[0].unresolvedId };
  await w.core.closeThread(w.threadId);
  const rejected = await w.call('POST', resolveRoute, params, { resolution: 'reissue' });
  assert.equal(rejected.statusCode, 409);
  assert.equal(rejected.body.code, 'thread_closed');
  assert.equal((await w.core.listUnresolved(w.threadId)).length, 1);
  const accepted = await w.call('POST', resolveRoute, params, { resolution: 'discard', note: 'explicit decision' });
  assert.equal(accepted.statusCode, 200);
  const independent = createThreadControl({ rootDir: w.root, bridge: new WorkThreadRuntimeBridge({ enabled: false }) });
  const record = await independent.core.getThread(w.threadId);
  assert.equal(record.status, 'closed');
  assert.equal(record.unresolvedCommands[0].resolution, 'discard');
  assert.equal(record.commands.some(c => c.metadata?.reissueOf === w.command.commandId), false);
});

test('restart scan does not wake for open unresolved alone; pending notice is a positive control', async t => {
  const w = await setup(t);
  await w.advance('old', 'new');
  const wakes = [];
  const recovery = createThreadRestartResume({ control: { ...w, resolveSessionViewerId: () => 'isolated-viewer' },
    ensureHeadRuntime: async (...args) => { wakes.push(args); return { ok: true }; },
    submitUserTurn: async () => { throw new Error('not expected'); } });
  const before = await recovery.resumeInterruptedThreads();
  assert.equal(before.resumed[0].action, 'wake_pending_commands');
  assert.equal(wakes.length, 1);
  assert.equal((await w.core.deliverPendingCommands(w.threadId)).delivered, 1);
  wakes.length = 0;
  const after = await recovery.resumeInterruptedThreads();
  assert.equal(after.resumed.length, 0);
  assert.equal(after.skipped[0].reason, 'board_missing');
  assert.equal(wakes.length, 0);
  assert.equal((await w.core.listUnresolved(w.threadId)).length, 1);
});
