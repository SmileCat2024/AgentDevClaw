import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkThread, WorkThreadBoard, WorkThreadRuntimeBridge, WorkThreadStore } from '@agentdevjs/core';
import { CapabilityShellFeature } from '../local-features/dist/capability-shell/src/coder-shell-feature.js';
import { setupThreadRoutes } from '../server/thread-control/thread-routes.js';
import { ThreadArchiveIndex } from '../server/thread-control/thread-archive.js';
import { createThreadLifecycleService } from '../server/thread-control/thread-lifecycle.js';

const flush = () => new Promise(resolve => setImmediate(resolve));

/** Real producers and consumers; only runtime execution and transport are controlled. */
async function harness(t, { started = false, deferred = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'coder-monitor-routes-'));
  const submitted = [];
  let runtime = true;
  let deferDelivery = deferred;
  const core = new WorkThread({
    store: new WorkThreadStore({ rootDir: join(root, 'threads') }),
    bridge: new WorkThreadRuntimeBridge({ enabled: true,
      resolveRuntimeViewerId: () => runtime ? 'coder-viewer' : null,
      submitTurn: async input => { submitted.push(input); return { enqueued: 'turn' }; },
    }),
  });
  const board = new WorkThreadBoard({ core, rootDir: root });
  const archive = new ThreadArchiveIndex({ rootDir: root });
  const thread = await core.start({ sessionRef: { agentId: 'coder', sessionId: 's1' } });
  assert.equal(await board.getState(thread.threadId), null);
  const lifecycle = createThreadLifecycleService({ control: { core, board, archive },
    stopSession: async () => { runtime = false; return { status: 'stopped' }; }, publishThreadEvent: () => {} });
  const routes = new Map();
  const app = {
    get: (path, ...handlers) => routes.set(`GET ${path}`, handlers.at(-1)),
    post: (path, ...handlers) => routes.set(`POST ${path}`, handlers.at(-1)),
  };
  let sequence = 0;
  async function record(event, sessionId) {
    const current = await core.getThread(thread.threadId);
    const result = await board.recordRuntimeEvent({ agentId: 'coder', sessionId: sessionId || current.headSessionId,
      event: { eventId: `event-${++sequence}`, ...event } });
    assert.equal(result.applied, true, JSON.stringify(result));
  }
  setupThreadRoutes(app, { json: () => () => {} }, {
    control: { core, board, archive, resolveSessionViewerId: () => runtime ? 'coder-viewer' : null }, lifecycle,
    publishThreadEvent: () => {},
    tryDeliver: async threadId => {
      if (deferDelivery) return { delivered: 0 };
      const delivery = await core.deliverPendingCommands(threadId);
      if (started) await record({ type: 'turn.started', sourceRef: submitted.at(-1).sourceRef, turn: 0 });
      return delivery;
    },
  });
  const reads = [], notices = [], panelUpdates = [], requests = [];
  let resolveNotice;
  const noticeDelivered = new Promise(resolve => { resolveNotice = resolve; });
  let resolveCompleted;
  const completedProjection = new Promise(resolve => { resolveCompleted = resolve; });
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.ok(String(url).startsWith('http://test/protoclaw/feature-comms/'));
    const body = JSON.parse(init.body);
    if (body.kind === 'event') {
      panelUpdates.push(body.data);
      if (body.data.status === 'completed') resolveCompleted(body.data);
    }
    return new Response(JSON.stringify({ ok: true }));
  });
  const feature = new CapabilityShellFeature({ serverOrigin: 'http://test', agentId: 'parent', sessionId: 'parent-session',
    panel: true, pollIntervalMs: 60_000, deliver: async notice => { notices.push(notice); resolveNotice(notice); },
    fetchImpl: async (url, init = {}) => {
      const parsed = new URL(url);
      const suffix = parsed.pathname.slice(`/protoclaw/threads/${thread.threadId}`.length);
      const handler = routes.get(`${init.method || 'GET'} /protoclaw/threads/:threadId${suffix}`);
      assert.ok(handler, `unexpected request: ${url}`);
      const response = { statusCode: 200, status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; } };
      requests.push({ suffix, method: init.method || 'GET' });
      await handler({ params: { threadId: thread.threadId }, query: Object.fromEntries(parsed.searchParams),
        body: init.body ? JSON.parse(init.body) : {} }, response);
      reads.push({ suffix, after: parsed.searchParams.get('after'), body: response.body });
      return { ok: response.statusCode < 400, status: response.statusCode, json: async () => response.body };
    },
  });
  t.after(async () => { await feature.onDestroy(); await rm(root, { recursive: true, force: true }); });
  const [tool] = await feature.getAsyncTools({ agentId: 'parent-viewer' });
  const execute = async command => String(await tool.execute({ command }));
  const providers = new Map();
  feature.registerBackground({ agent: { registerPendingWorkProvider: (id, fn) => {
    providers.set(id, fn); return () => providers.delete(id);
  } }, context: { addSystemMessage: () => {} } });
  const pending = () => [...providers.values()].flatMap(fn => fn());
  const send = key => execute(`send ${thread.threadId} ${key || 'key'} 'do work'`);
  const watch = commandId => execute(`watch ${thread.threadId}${commandId ? ` --command=${commandId}` : ''}`);
  const tasks = async () => (await feature.onHostRequest('list')).tasks;
  async function finish(commandId, text = 'verified report', turn = 0) {
    await record({ type: 'item.completed', turn, item: { type: 'agent_message', text, turn } });
    await record({ type: 'turn.completed', sourceRef: commandId, turn });
  }
  const boardFile = join(root, 'boards', `${thread.threadId}.board.json`);
  async function mutateBoard(change) {
    const state = JSON.parse(await readFile(boardFile, 'utf8'));
    change(state);
    await writeFile(boardFile, JSON.stringify(state));
  }
  return { root, core, board, thread, record, execute, send, watch, tasks, finish, submitted, reads, notices,
    pending, panelUpdates, requests, feature, boardFile, mutateBoard, noticeDelivered, completedProjection,
    allowDelivery: () => { deferDelivery = false; } };
}

for (const started of [false, true]) {
  it(`M9-EMPTY: first runtime event ${started ? 'already recorded' : 'not yet recorded'} → completion`, async t => {
    const h = await harness(t, { started });
    const receipt = await h.send();
    assert.match(receipt, /sent cmd-/);
    assert.doesNotMatch(receipt, /monitor_unreachable|缺少执行关联契约/);
    assert.equal(h.submitted.length, 1);
    const stream = h.reads.find(read => read.suffix === '/events').body;
    assert.equal(stream.baseOffset, 0);
    assert.equal(stream.cursor, started ? 1 : 0);
    assert.equal((await h.tasks())[0].status, started ? 'executing' : 'submitted');
    assert.equal(h.notices.length, 0);
    await h.finish(h.submitted[0].sourceRef);
    assert.match(await h.watch(), /reason=completed[\s\S]*verified report/);
    await flush();
    assert.equal(h.panelUpdates.at(-1).status, 'completed');
    assert.equal(h.panelUpdates.some(task => task.status === 'monitor_lost'), false);
    assert.equal(h.submitted.length, 1);
  });
}

it('M9-IDEMPOTENT: autonomous poll delivers one final notice without a model watch query', { timeout: 2000 }, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = await harness(t);
  await h.send();
  await h.finish(h.submitted[0].sourceRef);
  const before = h.requests.length;
  t.mock.timers.tick(60_000);
  // Wait for real IO to reach the publication boundary, not a guessed delay.
  await h.completedProjection;
  t.mock.timers.tick(0);
  const notice = await h.noticeDelivered;
  await flush();
  assert.equal(notice.sessionId, 'parent-session');
  assert.match(notice.text, /completed[\s\S]*verified report/);
  assert.equal(h.notices.length, 1);
  assert.equal(h.requests.length - before, 2, 'one events/detail read pair, no model query');
  assert.equal(h.submitted.length, 1);
  assert.deepEqual(h.pending(), []);
  assert.equal(h.panelUpdates.at(-1).status, 'completed');
});

it('M9-DISPATCH: dispatch-only creates no observation; explicit watch does not send again', async t => {
  const h = await harness(t);
  assert.match(await h.execute(`send ${h.thread.threadId} key 'do work' --dispatch-only`), /dispatch-only/);
  assert.deepEqual(await h.tasks(), []);
  assert.deepEqual(h.pending(), []);
  assert.equal(h.reads.some(read => read.suffix === '/events'), false);
  assert.match(await h.watch(h.submitted[0].sourceRef), /^monitoring/);
  assert.equal(h.pending().length, 1);
  assert.equal(h.submitted.length, 1);
});

it('M9-IDEMPOTENT: same submission and repeated observation stay singular through notification', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = await harness(t);
  await h.send();
  assert.match(await h.send(), /duplicate=true/);
  await h.watch();
  assert.equal((await h.core.getThread(h.thread.threadId)).commands.length, 1);
  assert.equal(h.submitted.length, 1);
  assert.equal((await h.tasks()).length, 1);
  await h.finish(h.submitted[0].sourceRef);
  await h.watch();
  await h.watch();
  t.mock.timers.tick(0);
  await flush();
  assert.equal(h.notices.length, 1);
  assert.deepEqual(h.pending(), []);
  await h.watch();
  t.mock.timers.tick(0);
  await flush();
  assert.equal(h.notices.length, 1);
});

it('M9-PENDING: delayed delivery keeps original identity and only completes from its event', async t => {
  const h = await harness(t, { deferred: true });
  assert.match(await h.send(), /delivered=0/);
  const commandId = (await h.core.getThread(h.thread.threadId)).commands[0].commandId;
  assert.equal((await h.tasks())[0].status, 'submitted');
  h.allowDelivery();
  assert.match(await h.execute(`deliver ${h.thread.threadId}`), /delivered=1/);
  assert.equal(h.submitted[0].sourceRef, commandId);
  await h.finish(commandId);
  assert.match(await h.watch(), /reason=completed/);
});

for (const [type, expected] of [['turn.completed', 'completed'], ['turn.failed', 'failed'], ['turn.cancelled', 'cancelled']]) {
  it(`M9-TERMINAL: ${type} crosses board/routes with correct classification`, async t => {
    const h = await harness(t);
    await h.send();
    const ref = h.submitted[0].sourceRef;
    await h.record({ type: 'turn.started', sourceRef: ref, turn: 0 });
    await h.record({ type, sourceRef: ref, turn: 0, error: { message: 'fixture failure' } });
    await h.watch();
    assert.equal((await h.tasks())[0].status, expected);
    assert.equal(h.submitted.length, 1);
  });
}

it('M9-BUSY: consumedSourceRefs on a different turn owns the queued instruction result', async t => {
  const h = await harness(t);
  await h.send();
  await h.finish('other', 'other report');
  assert.match(await h.watch(), /^monitoring/);
  await h.record({ type: 'turn.completed', sourceRef: 'other', consumedSourceRefs: [h.submitted[0].sourceRef], turn: 1 });
  assert.match(await h.watch(), /reason=completed/);
  assert.equal((await h.tasks())[0].status, 'completed');
});

for (const field of ['taskIds', 'workIds']) {
  it(`M9-SUSPEND: ${field} progress wakeup remains pending until final wakeup across real polls`, async t => {
    const h = await harness(t);
    await h.send();
    const pendingWakeups = [{ source: 'shell', id: 'bg-1' }];
    await h.record({ type: 'turn.completed', sourceRef: h.submitted[0].sourceRef, turn: 0, suspended: true, pendingWakeups });
    assert.match(await h.watch(), /^monitoring/);
    assert.equal((await h.tasks())[0].status, 'suspended');
    for (const [index, suspended] of [[1, true], [2, false]]) {
      const { command } = await h.core.appendCommand({ threadId: h.thread.threadId, kind: 'reminder', source: 'shell',
        text: 'background notice', idempotencyKey: `wake-${index}`, metadata: { shell: { [field]: ['bg-1'] } } });
      await h.core.deliverPendingCommands(h.thread.threadId);
      await h.record({ type: 'turn.started', sourceRef: command.commandId, turn: index });
      await h.record({ type: 'item.completed', turn: index, item: { type: 'agent_message', turn: index, text: `report-${index}` } });
      await h.record({ type: 'turn.completed', sourceRef: command.commandId, turn: index, suspended,
        pendingWakeups: suspended ? pendingWakeups : [] });
      const result = await h.watch(h.submitted[0].sourceRef);
      if (suspended) {
        assert.match(result, /^monitoring/);
        assert.equal(h.notices.length, 0);
        assert.equal((await h.tasks())[0].status, 'suspended');
      } else assert.match(result, /reason=completed[\s\S]*report-2/);
    }
  });
}

for (const oldState of ['cancelled', 'suspended']) {
  it(`M9-ROTATE: ${oldState} old head → real succession command → successor report`, async t => {
    const h = await harness(t);
    await h.send();
    const ref = h.submitted[0].sourceRef;
    await h.record({ type: 'turn.started', sourceRef: ref, turn: 0 });
    await h.core.beginSessionHandoff({ threadId: h.thread.threadId, fromSessionId: 's1' });
    await h.record({ type: oldState === 'cancelled' ? 'turn.cancelled' : 'turn.completed', sourceRef: ref, turn: 0,
      ...(oldState === 'suspended' ? { suspended: true, pendingWakeups: [{ source: 'shell', id: 'bg-old' }] } : {}) });
    assert.match(await h.watch(ref), /^monitoring/);
    assert.equal((await h.tasks())[0].status, 'rotating');
    assert.equal(h.notices.length, 0);
    const next = await h.core.advanceHead({ threadId: h.thread.threadId, fromSessionId: 's1', toSessionId: 's2' });
    const continuation = next.commands.find(command => command.kind === 'system_continuation');
    assert.ok(continuation);
    await h.core.deliverPendingCommands(h.thread.threadId);
    await h.finish(continuation.commandId, 'successor report');
    assert.match(await h.watch(ref), /reason=completed[\s\S]*successor report/);
    assert.equal((await h.tasks())[0].status, 'completed');
  });
}

it('M9-PENDING-ROTATE: send behind handoff barrier follows original command to new head', async t => {
  const h = await harness(t);
  await h.core.beginSessionHandoff({ threadId: h.thread.threadId, fromSessionId: 's1' });
  assert.match(await h.send(), /delivered=0/);
  const commandId = (await h.core.getThread(h.thread.threadId)).commands.find(command => command.source === 'coder_shell').commandId;
  assert.equal((await h.tasks())[0].status, 'rotating');
  await h.core.advanceHead({ threadId: h.thread.threadId, fromSessionId: 's1', toSessionId: 's2' });
  await h.core.deliverPendingCommands(h.thread.threadId);
  assert.ok(h.submitted.some(input => input.sourceRef === commandId));
  await h.finish(commandId, 'pending successor report');
  assert.match(await h.watch(commandId), /reason=completed[\s\S]*pending successor report/);
});

for (const action of ['archive', 'close', 'delete']) {
  it(`M9-CLOSED: ${action} during observation is not business success`, async t => {
    if (action === 'delete') t.mock.timers.enable({ apis: ['setTimeout'] });
    const h = await harness(t);
    await h.send();
    const ref = h.submitted[0].sourceRef;
    if (action === 'archive') await h.execute(`archive ${h.thread.threadId}`);
    else if (action === 'close') await h.core.closeThread(h.thread.threadId);
    else t.mock.method(h.core, 'getThread', async () => null);
    if (action === 'delete') {
      // Background observer, unlike watch's initial detail lookup, owns this 404.
      // The 404 path crosses timer tick → events read → detail read → projection, so
      // drain the event loop until the observer settles instead of counting rounds.
      t.mock.timers.tick(60_000);
      for (let i = 0; i < 50 && (await h.tasks())[0]?.status === 'submitted'; i++) await flush();
    } else assert.match(await h.watch(ref), new RegExp(`reason=thread_${action === 'archive' ? 'archived' : 'closed'}`));
    assert.equal((await h.tasks())[0].status, action === 'delete' ? 'monitor_lost' : 'blocked');
    assert.equal(h.submitted.length, 1);
  });
}

for (const mode of ['retained', 'edge', 'gap']) {
  it(`M9-WINDOW: persisted ${mode} window preserves absolute cursor and loss detection`, async t => {
    const h = await harness(t);
    if (mode === 'retained') await h.execute(`send ${h.thread.threadId} key 'do work' --dispatch-only`);
    else await h.send();
    const ref = h.submitted[0].sourceRef;
    await h.record({ type: 'turn.started', sourceRef: ref, turn: 0 });
    if (mode !== 'retained') await h.watch(ref);
    await h.mutateBoard(state => {
      state.executionEventBaseOffset = mode === 'gap' ? 2 : 1;
      if (mode !== 'retained') state.executionEvents = [];
    });
    await h.finish(ref);
    if (mode === 'gap') assert.match(await h.watch(ref), /reason=association_lost/);
    else assert.match(await h.watch(ref), /reason=completed/);
    const stream = h.reads.filter(read => read.suffix === '/events').at(-1).body;
    assert.equal(stream.cursor, mode === 'retained' ? 4 : mode === 'gap' ? 4 : 3);
  });
}

it('M9-WATCH-LATEST M9-RESULT-TURN: successive real commands do not replay old reports or select progress text', async t => {
  const h = await harness(t);
  await h.send('first');
  const first = h.submitted[0].sourceRef;
  await h.finish(first, 'old report', 0);
  await h.watch(first);
  await h.send('second');
  const second = h.submitted[1].sourceRef;
  const waiting = await h.watch();
  assert.doesNotMatch(waiting, /old report|reason=completed/);
  assert.match(waiting, new RegExp(`commandId=${second}`));
  await h.record({ type: 'item.completed', turn: 1, item: { type: 'agent_message', text: 'progress text', turn: 1 } });
  await h.finish(second, 'final second report', 1);
  assert.match(await h.watch(), /final second report/);
  assert.match(await h.watch(first), /old report/);
  const result = await h.execute(`result ${h.thread.threadId} --turn=1`);
  assert.match(result, /final second report/);
  assert.doesNotMatch(result, /progress text/);
  assert.equal(h.submitted.length, 2);
});

it('M9-CLOSED: archived submission rejects before Inbox; unarchive allows original rejected key without reviving cancelled work', async t => {
  const h = await harness(t, { deferred: true });
  await h.send('pending');
  await h.execute(`archive ${h.thread.threadId}`);
  const denied = await h.send('new-key');
  assert.match(denied, /thread_archived/);
  assert.equal((await h.core.getThread(h.thread.threadId)).commands.length, 1);
  await h.execute(`unarchive ${h.thread.threadId}`);
  assert.equal(h.submitted.length, 0);
  assert.equal((await h.core.getThread(h.thread.threadId)).commands[0].status, 'cancelled');
  assert.match(await h.send('new-key'), /duplicate=false/);
  assert.equal((await h.core.getThread(h.thread.threadId)).commands.length, 2);
});

it('M9-WINDOW: real board append trims full retained window and exposes unread gap', async t => {
  const h = await harness(t, { started: true });
  await h.send();
  await h.mutateBoard(state => {
    state.executionEvents = Array.from({ length: 500 }, (_, index) => ({
      eventId: `seed-${index}`, receivedAt: index, sessionId: 's1',
      event: { type: 'item.completed', item: { type: 'reasoning', id: `item-${index}` } },
    }));
  });
  await h.record({ type: 'item.completed', item: { type: 'reasoning', id: 'overflow-1' } });
  await h.record({ type: 'item.completed', item: { type: 'reasoning', id: 'overflow-2' } });
  const persisted = await h.board.getState(h.thread.threadId);
  assert.equal(persisted.executionEvents.length, 500);
  assert.equal(persisted.executionEventBaseOffset, 2);
  assert.match(await h.watch(), /reason=association_lost/);
  const stream = h.reads.filter(read => read.suffix === '/events').at(-1).body;
  assert.equal(stream.cursor, 502);
  assert.equal(stream.baseOffset, 2);
});

it('M9-REWIND: loss of persisted board after initialized cursor ends observation explicitly', async t => {
  const h = await harness(t, { started: true });
  await h.send();
  await rm(h.boardFile);
  assert.match(await h.watch(h.submitted[0].sourceRef), /reason=association_lost/);
  assert.equal((await h.tasks())[0].status, 'monitor_lost');
});
