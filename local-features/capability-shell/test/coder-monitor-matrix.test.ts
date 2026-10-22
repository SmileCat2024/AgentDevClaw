import { it } from 'node:test';
import assert from 'node:assert/strict';
import { BackgroundAccess } from '@agentdevjs/core';
import { CoderMonitor } from '../src/coder-monitor.js';
import type { CoderSnapshot } from '../src/coder-monitor.js';

const identity = { threadId: 'wt', commandId: 'cmd' };
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const done = (ref = 'cmd', extra: any = {}) => ({ type: 'turn.completed', sourceRef: ref, sessionId: 's1', turn: 0, ...extra });
const reply = (text = 'final', turn = 0, sessionId = 's1') => ({ type: 'item.completed', sessionId,
  item: { type: 'agent_message', text, turn } });
function snap(events: any[] = [], thread: any = {}): CoderSnapshot {
  return { thread: { threadId: 'wt', headSessionId: 's1', headRuntimeRunning: true, status: 'open', lifeState: 'idle',
    commands: [{ commandId: 'cmd', status: 'delivered' }], sessionChain: [{ sessionId: 's1' }], ...thread },
  events, cursor: events.length, baseOffset: 0 };
}
function harness(t: any, { read, deliver, onUpdate }: any = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let state = snap();
  let error: any;
  let reads = 0;
  const notices: any[] = [], updates: any[] = [];
  const access = new BackgroundAccess({ source: 'claw-coder-dispatch', sessionId: 'parent',
    deliver: async notice => { notices.push(notice); await deliver?.(notice); } });
  const monitor = new CoderMonitor({ access, intervalMs: 100,
    onUpdate: task => { updates.push(task); return onUpdate?.(task); },
    read: async (...args) => { reads++; if (error) throw error; return read ? read(...args) : state; } });
  t.after(async () => { await monitor.dispose(); access.dispose(); });
  return { access, monitor, notices, updates, set: (next: CoderSnapshot) => { state = next; },
    fail: (next: any) => { error = next; }, reads: () => reads,
    flush: async () => { t.mock.timers.tick(0); await flush(); } };
}

it('M9-READ-ERROR: first failure is explicit; initialized reads tolerate two errors, reset on success', async t => {
  const h = harness(t);
  h.fail(new Error('offline'));
  assert.match(await h.monitor.observe(identity), /reason=monitor_unreachable/);
  await h.flush();
  h.fail(null);
  assert.match(await h.monitor.observe(identity), /^monitoring/);
  for (let cycle = 0; cycle < 2; cycle++) {
    h.fail(new Error('offline'));
    for (let n = 0; n < 2; n++) assert.match(await h.monitor.observe(identity), /^monitoring/);
    if (cycle === 0) { h.fail(null); assert.match(await h.monitor.observe(identity), /^monitoring/); }
  }
  assert.match(await h.monitor.observe(identity), /reason=monitor_unreachable/);
  await h.flush();
  assert.equal(h.notices.length, 2);
  assert.equal(h.monitor.list()[0].status, 'monitor_lost');
});

for (const type of ['turn.completed', 'turn.failed', 'turn.cancelled']) {
  it(`M9-UNRELATED: unrelated ${type} cannot finish target`, async t => {
    const h = harness(t);
    h.set(snap([reply('wrong'), { ...done('other'), type }]));
    assert.match(await h.monitor.observe(identity), /^monitoring/);
    await h.flush();
    assert.equal(h.notices.length, 0);
    assert.equal(h.access.pendingWakeups().length, 1);
  });
}

for (const mismatch of ['source', 'workId', 'session', 'kind', 'taskIds', 'workIds']) {
  it(`M9-WAKE-IDENTITY: ${mismatch} distinguishes related wakeups`, async t => {
    const h = harness(t);
    const command: any = { commandId: 'wake', source: 'shell', kind: 'reminder',
      metadata: { shell: { [mismatch === 'workIds' ? 'workIds' : 'taskIds']: [mismatch === 'workId' ? 'other' : 'bg'] } } };
    if (mismatch === 'source') command.source = 'other';
    if (mismatch === 'kind') command.kind = 'user_message';
    h.set(snap([done('cmd', { suspended: true, pendingWakeups: [{ source: 'shell', id: 'bg' }] }),
      done('wake', { sessionId: mismatch === 'session' ? 's2' : 's1' })],
    { commands: [{ commandId: 'cmd' }, command] }));
    const result = await h.monitor.observe(identity);
    assert.match(result, /taskIds|workIds/.test(mismatch) ? /reason=completed/ : /^monitoring/);
  });
}

it('M9-WAKE-MISSING: suspended without wake references is lost association, not endless waiting', async t => {
  const h = harness(t);
  h.set(snap([done('cmd', { suspended: true })]));
  assert.match(await h.monitor.observe(identity), /reason=association_lost/);
  assert.equal(h.monitor.list()[0].status, 'monitor_lost');
});

for (const mode of ['split', 'other-turn', 'other-session', 'absent']) {
  it(`M9-REPORT: ${mode} report is associated by session and turn`, async t => {
    const h = harness(t);
    h.set(snap(mode === 'absent' ? [] : [reply('correct', 0),
      ...(mode === 'other-turn' ? [reply('wrong', 1)] : mode === 'other-session' ? [reply('wrong', 0, 's2')] : [])]));
    await h.monitor.observe(identity);
    h.set({ ...snap([done()]), cursor: 3 });
    const result = await h.monitor.observe(identity);
    if (mode === 'absent') assert.match(result, /缺少可关联的最终回复/);
    else { assert.match(result, /correct/); assert.doesNotMatch(result, /wrong/); }
  });
}

/** Every bit controls one poll boundary; equivalent histories must have equivalent outcomes. */
for (const scenario of ['suspend', 'rotate']) {
  it(`M9-PARTITIONS M9-SUSPEND M9-ROTATE: ${scenario} every adjacent event partition`, async t => {
    const events = scenario === 'suspend' ? [
      done('cmd', { suspended: true, pendingWakeups: [{ source: 'shell', id: 'bg' }] }),
      { type: 'turn.started', sourceRef: 'wake', sessionId: 's1', turn: 1 }, reply('final', 1), done('wake', { turn: 1 }),
    ] : [
      { type: 'turn.cancelled', sourceRef: 'cmd', sessionId: 's1', turn: 0 },
      { type: 'turn.started', sourceRef: 'next', sessionId: 's2', turn: 0 }, reply('final', 0, 's2'), done('next', { sessionId: 's2' }),
    ];
    // Model handoff facts at their actual temporal boundary, not before the cancellation.
    for (let mask = 0; mask < 1 << (events.length - 1); mask++) {
      await t.test(`partition-${mask}`, async st => {
        let visible = 0;
        const h = harness(st, { read: async (_id, after) => {
          const commands = [{ commandId: 'cmd' }, scenario === 'suspend'
            ? { commandId: 'wake', kind: 'reminder', source: 'shell', metadata: { shell: { taskIds: ['bg'] } } }
            : { commandId: 'next', kind: 'system_continuation', idempotencyKey: 'succession:wt:s1' }];
          return { ...snap(events.slice(after, visible), { commands,
            ...(scenario === 'rotate' ? { status: visible === 1 ? 'rotating' : 'open',
              headSessionId: visible === 1 ? 's1' : 's2', sessionChain: [{ sessionId: 's1' }, { sessionId: 's2' }] } : {}) }), cursor: visible };
        } });
        for (let end = 1; end <= events.length; end++) {
          if (end !== events.length && !(mask & (1 << (end - 1)))) continue;
          visible = end;
          await h.monitor.observe(identity);
          if (end !== events.length) assert.equal(h.monitor.isObserving(identity), true);
        }
        assert.equal(h.monitor.list()[0].status, 'completed');
        assert.match(h.monitor.list()[0].summary, /final/);
        await h.flush();
        assert.equal(h.notices.length, 1);
        assert.equal(h.access.pendingWakeups().length, 0);
      });
    }
  });
}

for (const mode of ['missing', 'long-tool', 'rotating', 'completed']) {
  it(`M9-RUNTIME: ${mode} uses execution evidence, not elapsed silence`, async t => {
    const h = harness(t);
    h.set(snap(mode === 'completed' ? [done()] : [], { headRuntimeRunning: mode === 'long-tool',
      ...(mode === 'rotating' ? { status: 'rotating' } : {}) }));
    const result = await h.monitor.observe(identity);
    assert.match(result, mode === 'missing' ? /reason=runtime_unavailable/ : mode === 'completed' ? /reason=completed/ : /^monitoring/);
  });
}
for (const status of ['failed', 'cancelled']) {
  it(`M9-COMMAND: ${status} is not monitor loss`, async t => {
    const h = harness(t);
    h.set(snap([], { commands: [{ commandId: 'cmd', status, lastReason: 'rejected' }] }));
    assert.match(await h.monitor.observe(identity), new RegExp(`reason=command_${status}[\\s\\S]*rejected`));
    assert.equal(h.monitor.list()[0].status, status);
  });
}

it('M9-CONCURRENT: concurrent reads for one identity share one operation and terminal notice', async t => {
  let release: (value: CoderSnapshot) => void;
  const gate = new Promise<CoderSnapshot>(resolve => { release = resolve; });
  const h = harness(t, { read: () => gate });
  const a = h.monitor.observe(identity), b = h.monitor.observe(identity);
  assert.equal(h.reads(), 1);
  assert.equal(h.access.pendingWakeups().length, 1);
  release!(snap([done()]));
  await Promise.all([a, b]);
  await h.flush();
  assert.equal(h.notices.length, 1);
});

it('M9-CONCURRENT: distinct command and thread identities never share completion', async t => {
  const h = harness(t, { read: async threadId => snap([done()], {
    threadId, commands: [{ commandId: 'cmd' }, { commandId: 'cmd-2' }],
  }) });
  await Promise.all([h.monitor.observe(identity), h.monitor.observe({ threadId: 'wt', commandId: 'cmd-2' }),
    h.monitor.observe({ threadId: 'wt-other', commandId: 'cmd' })]);
  assert.equal(h.reads(), 3);
  assert.deepEqual(h.monitor.list().map(task => [task.id, task.status]), [
    ['wt/cmd', 'completed'], ['wt/cmd-2', 'submitted'], ['wt-other/cmd', 'completed'],
  ]);
  await h.flush();
  assert.equal(h.notices.length, 1, 'same-recipient facts may aggregate');
  assert.deepEqual(h.notices[0].workIds, ['wt/cmd', 'wt-other/cmd']);
  assert.deepEqual(h.access.pendingWakeups().map(work => work.id), ['wt/cmd-2']);
});

it('M9-ROTATE: failed handoff remains blocked even when a stale barrier and runtime absence coexist', async t => {
  const h = harness(t);
  h.set(snap([], { status: 'rotation_failed', pendingSuccession: { startedAt: 1 }, headRuntimeRunning: false }));
  assert.match(await h.monitor.observe(identity), /reason=rotation_failed/);
  assert.equal(h.monitor.list()[0].status, 'blocked');
  await h.flush();
  assert.equal(h.notices.length, 1);
});

for (const delivery of ['success', 'failure', 'inflight']) {
  it(`M9-NOTICE: ${delivery} retains pending until delivery or explicit catchup`, async t => {
    let release: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const h = harness(t, { deliver: async () => {
      if (delivery === 'failure') throw new Error('recipient offline');
      if (delivery === 'inflight') await gate;
    } });
    h.set(snap([done()]));
    await h.monitor.observe(identity);
    assert.equal(h.access.pendingWakeups().length, 1);
    await h.flush();
    assert.equal(h.notices.length, 1);
    if (delivery !== 'success') {
      assert.equal(h.access.pendingWakeups().length, 1);
      assert.deepEqual(h.monitor.identities(), [identity]);
    }
    if (delivery === 'failure') {
      assert.match(await h.monitor.observe(identity), /reason=completed/);
      assert.equal(h.notices.length, 1);
    }
    release!();
    await flush();
    assert.equal(h.access.pendingWakeups().length, 0);
    assert.deepEqual(h.monitor.identities(), []);
  });
}

it('M9-REBUILD: retryable loss rebuilds after notice delivery with increasing projection revision', async t => {
  const h = harness(t);
  h.fail(new Error('offline'));
  await h.monitor.observe(identity);
  const lost = h.monitor.list()[0];
  await h.flush();
  h.fail(null);
  await h.monitor.observe(identity);
  const rebuilt = h.monitor.list()[0];
  assert.equal(rebuilt.status, 'submitted');
  assert.equal(rebuilt.startedAt, lost.startedAt);
  assert.ok(rebuilt.revision > lost.revision);
  assert.equal(rebuilt.endedAt, undefined);
  h.set(snap([done()]));
  await h.monitor.observe(identity);
  await h.flush();
  assert.equal(h.notices.length, 2);
});

it('M9-REBUILD: undelivered loss is returned before rebuilding, never duplicates work registration', async t => {
  const h = harness(t, { deliver: async () => { throw new Error('offline recipient'); } });
  h.fail(new Error('offline server'));
  await h.monitor.observe(identity);
  await h.flush();
  h.fail(null);
  assert.match(await h.monitor.observe(identity), /reason=monitor_unreachable/);
  assert.match(await h.monitor.observe(identity), /^monitoring/);
  assert.equal(h.access.pendingWakeups().length, 1);
});

it('M9-DISPOSE: late read is ignored and no timer restarts after disposal', async t => {
  let release: (value: CoderSnapshot) => void;
  let signal: AbortSignal;
  const gate = new Promise<CoderSnapshot>(resolve => { release = resolve; });
  const h = harness(t, { read: (_id, _after, input) => { signal = input; return gate; } });
  const observing = h.monitor.observe(identity);
  const disposing = h.monitor.dispose();
  assert.equal(signal!.aborted, true);
  release!(snap([done()]));
  await Promise.all([observing, disposing]);
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(h.updates.length, 1);
  assert.equal(h.notices.length, 0);
  assert.equal(h.access.pendingWakeups().length, 0);
  assert.equal(h.reads(), 1);
  await assert.rejects(h.monitor.observe(identity), /disposed/);
});

it('M9-REWIND: initialized event cursor never silently moves backwards', async t => {
  const h = harness(t);
  h.set(snap([{ type: 'turn.started', sourceRef: 'cmd', sessionId: 's1' }]));
  await h.monitor.observe(identity);
  h.set(snap());
  assert.match(await h.monitor.observe(identity), /reason=association_lost/);
});

for (const mode of ['edge', 'gap', 'identity-missing']) {
  it(`M9-WINDOW: ${mode} retained event boundary is classified`, async t => {
    const h = harness(t);
    if (mode !== 'identity-missing') {
      h.set(snap([{ type: 'turn.started', sourceRef: 'cmd', sessionId: 's1' }]));
      await h.monitor.observe(identity);
    }
    h.set({ ...snap(mode === 'identity-missing' ? [] : [done()]), baseOffset: mode === 'gap' ? 2 : 1, cursor: 3 });
    assert.match(await h.monitor.observe(identity), mode === 'edge' ? /reason=completed/ : /reason=association_lost/);
  });
}
