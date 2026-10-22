import { it, describe } from 'node:test';
import assert from 'node:assert/strict';
import { BackgroundAccess } from '@agentdevjs/core';
import { CoderMonitor } from '../src/coder-monitor.js';
import { CapabilityShellFeature } from '../src/coder-shell-feature.js';
import type { CoderSnapshot } from '../src/coder-monitor.js';

const identity = { threadId: 'wt-1', commandId: 'cmd-1' };
function snapshot(events: any[] = [], overrides: any = {}): CoderSnapshot {
  return { thread: { threadId: 'wt-1', headSessionId: 's1', status: 'open', lifeState: 'idle',
    headRuntimeRunning: true, commands: [{ commandId: 'cmd-1', source: 'coder_shell', status: 'delivered' }],
    sessionChain: [{ sessionId: 's1' }], ...overrides },
    events: events.map((event) => ({ sessionId: 's1', ...event })), cursor: events.length, baseOffset: 0 };
}
function completed(ref = 'cmd-1', extra: any = {}) {
  return { type: 'turn.completed', sourceRef: ref, turn: 0, ...extra };
}
function harness(t: any, read: (after: number, signal: AbortSignal) => Promise<CoderSnapshot>) {
  const notices: any[] = [];
  const access = new BackgroundAccess({ source: 'claw-coder-dispatch', sessionId: 'parent-1',
    deliver: async (notice) => { notices.push(notice); } });
  const monitor = new CoderMonitor({ access, read: (_id, after, signal) => read(after, signal), intervalMs: 60_000 });
  t.after(async () => { await monitor.dispose(); access.dispose(); });
  return { monitor, access, notices };
}

describe('Coder execution observation (ADR-0031)', () => {
  it('projects real execution states and isolates a throwing presentation observer', async (t) => {
    const access = new BackgroundAccess({ source: 'test', deliver: async () => {} });
    let state = snapshot();
    const projected: any[] = [];
    const monitor = new CoderMonitor({ access, read: async () => state,
      onUpdate: (task) => { projected.push(task); throw new Error('panel offline'); } });
    t.after(async () => { await monitor.dispose(); access.dispose(); });
    await monitor.observe(identity);
    assert.equal(monitor.list()[0].status, 'submitted'); // idle is not completion
    state = snapshot([{ type: 'turn.started', sourceRef: 'cmd-1' }]);
    await monitor.observe(identity);
    assert.equal(monitor.list()[0].status, 'executing');
    state = snapshot([completed('cmd-1', { suspended: true, pendingWakeups: [{ source: 'shell', id: 'bg' }] })]);
    await monitor.observe(identity);
    assert.equal(monitor.list()[0].status, 'suspended');
    state = { ...snapshot([], { status: 'rotating' }), cursor: 1 };
    await monitor.observe(identity);
    assert.equal(monitor.list()[0].status, 'rotating');
    assert.ok(projected.length >= 4);
    assert.equal(monitor.list()[0].threadId, 'wt-1');
    state = snapshot([completed('wake')], { commands: [
      { commandId: 'cmd-1', status: 'delivered' },
      { commandId: 'wake', kind: 'reminder', source: 'shell', metadata: { shell: { taskIds: ['bg'] } } },
    ] });
    await monitor.observe(identity);
    assert.equal(monitor.list()[0].status, 'completed');
    assert.match(monitor.list()[0].summary, /已完成/);
    assert.ok(monitor.list()[0].endedAt);
  });

  it('fast completion is read from history, unrelated completion/idle never wins', async (t) => {
    let events = [completed('old-command')];
    const { monitor, access } = harness(t, async () => snapshot(events));
    assert.match(await monitor.observe(identity), /^monitoring/);
    assert.equal(access.pendingWakeups().length, 1);
    events = [completed()];
    assert.match(await monitor.observe(identity), /reason=completed/);
    assert.match(await monitor.observe(identity), /reason=completed/);
  });

  it('busy-time consumed command is associated even without its own turn', async (t) => {
    const { monitor } = harness(t, async () => snapshot([completed('other', { consumedSourceRefs: ['cmd-1'] })]));
    assert.match(await monitor.observe(identity), /reason=completed/);
  });

  it('M8D-SUSPEND-REF follows progress wakeups; progress completion still waiting is not final', async (t) => {
    const commands = [
      { commandId: 'cmd-1', status: 'delivered' },
      { commandId: 'wake-progress', kind: 'reminder', source: 'shell', metadata: { shell: { taskIds: ['bg-1'] } } },
      { commandId: 'wake-done', kind: 'reminder', source: 'shell', metadata: { shell: { taskIds: ['bg-1'] } } },
    ];
    const waiting = { suspended: true, pendingWakeups: [{ source: 'shell', id: 'bg-1' }] };
    let state = snapshot([completed('cmd-1', waiting), completed('wake-progress', waiting)], { commands: commands.slice(0, 2) });
    const { monitor } = harness(t, async () => state);
    assert.match(await monitor.observe(identity), /^monitoring/);
    state = { ...snapshot([completed('wake-done')], { commands }), cursor: 3 };
    assert.match(await monitor.observe(identity), /reason=completed/);
  });

  it('M8D-ROTATE-REF cancellation during rotation follows the explicit succession command', async (t) => {
    const cancel = { type: 'turn.cancelled', sourceRef: 'cmd-1', turn: 0 };
    let state = snapshot([cancel], { status: 'rotating' });
    const { monitor } = harness(t, async () => state);
    assert.match(await monitor.observe(identity), /^monitoring/);
    state = { ...snapshot([completed('next', { sessionId: 's2' })], {
      headSessionId: 's2', sessionChain: [{ sessionId: 's1' }, { sessionId: 's2' }],
      commands: [{ commandId: 'cmd-1', status: 'delivered' },
        { commandId: 'next', kind: 'system_continuation', idempotencyKey: 'succession:wt-1:s1' }],
    }), cursor: 2 };
    assert.match(await monitor.observe(identity), /reason=completed/);
  });

  it('ordinary interruption is not completed and does not wait forever', async (t) => {
    const { monitor } = harness(t, async () => snapshot([{ type: 'turn.cancelled', sourceRef: 'cmd-1' }]));
    assert.match(await monitor.observe(identity), /reason=execution_cancelled/);
    assert.equal(monitor.list()[0].status, 'cancelled');
  });

  it('different submissions in the same thread are not merged', async (t) => {
    const { monitor, access } = harness(t, async () => snapshot([completed()], {
      commands: [{ commandId: 'cmd-1' }, { commandId: 'cmd-2' }],
    }));
    assert.match(await monitor.observe(identity), /reason=completed/);
    assert.match(await monitor.observe({ ...identity, commandId: 'cmd-2' }), /^monitoring/);
    assert.equal(access.pendingWakeups().length, 2); // terminal notice is still queued
  });

  it('a reused background work ID in another session cannot complete this execution', async (t) => {
    const waiting = { suspended: true, pendingWakeups: [{ source: 'shell', id: 'bg-1' }] };
    const { monitor } = harness(t, async () => snapshot([
      completed('cmd-1', waiting), completed('wrong-wake', { sessionId: 's2' }),
    ], { commands: [{ commandId: 'cmd-1' }, { commandId: 'wrong-wake', kind: 'reminder',
      source: 'shell', metadata: { shell: { taskIds: ['bg-1'] } } }] }));
    assert.match(await monitor.observe(identity), /^monitoring/);
  });

  it('normal long tool activity does not trigger false failure', async (t) => {
    const { monitor } = harness(t, async () => snapshot([{ type: 'turn.started', sourceRef: 'cmd-1' }], {
      lifeState: 'executing', lastEventAt: 1,
    }));
    assert.match(await monitor.observe(identity), /^monitoring/);
  });

  for (const [overrides, expected] of [
    [{ status: 'rotation_failed' }, 'rotation_failed'],
    [{ headRuntimeRunning: false }, 'runtime_unavailable'],
    [{ lifeState: 'archived' }, 'thread_archived'],
    [{ status: 'closed' }, 'thread_closed'],
    [{ commands: [] }, 'association_lost'],
  ] as const) {
    it(`reports ${expected} explicitly`, async (t) => {
      const { monitor } = harness(t, async () => snapshot([], overrides));
      assert.match(await monitor.observe(identity), new RegExp(`reason=${expected}`));
    });
  }

  it('deleted thread is terminal; network failure is separately classified', async (t) => {
    const { monitor } = harness(t, async () => { throw Object.assign(new Error('gone'), { status: 404 }); });
    assert.match(await monitor.observe(identity), /reason=thread_deleted/);
    const other = harness(t, async () => { throw new Error('offline'); });
    await other.monitor.observe(identity);
    await other.monitor.observe(identity);
    assert.match(await other.monitor.observe(identity), /reason=monitor_unreachable/);
    assert.equal(other.monitor.list()[0].status, 'monitor_lost');
  });

  it('retained event gap is reported, not converted to idle completion', async (t) => {
    let state = snapshot([{ type: 'turn.started', sourceRef: 'cmd-1' }]);
    const { monitor } = harness(t, async () => state);
    await monitor.observe(identity);
    state = { ...snapshot(), baseOffset: 10, cursor: 10 };
    assert.match(await monitor.observe(identity), /reason=association_lost/);
  });

  it('can rebuild a failed monitor after catch-up without re-dispatching', async (t) => {
    let offline = true;
    const { monitor, access } = harness(t, async () => {
      if (offline) throw new Error('offline');
      return snapshot([completed()]);
    });
    assert.match(await monitor.observe(identity), /reason=monitor_unreachable/);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    t.mock.timers.tick(0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(access.hasUndelivered('wt-1/cmd-1'), false);
    offline = false;
    assert.match(await monitor.observe(identity), /reason=completed/);
  });

  it('preserves the final reply across an incremental polling boundary', async (t) => {
    let state = snapshot([{ type: 'item.completed', item: { type: 'agent_message', text: 'final report', turn: 0 } }]);
    const { monitor } = harness(t, async () => state);
    await monitor.observe(identity);
    state = { ...snapshot([completed()]), cursor: 2 };
    assert.match(await monitor.observe(identity), /final report/);
  });

  it('dispose aborts reads and removes only observation resources', async (t) => {
    let aborted = false;
    const { monitor, access } = harness(t, (_after, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true });
    }));
    const observing = monitor.observe(identity);
    await monitor.dispose();
    await observing;
    assert.equal(aborted, true);
    assert.equal(access.pendingWakeups().length, 0);
  });

  it('result excerpt belongs to matching session and turn, not the latest unrelated reply', async (t) => {
    const { monitor } = harness(t, async () => snapshot([
      { type: 'item.completed', item: { type: 'agent_message', text: 'correct report', turn: 0 } },
      { type: 'item.completed', sessionId: 's2', item: { type: 'agent_message', text: 'wrong report', turn: 0 } },
      completed(),
    ]));
    const result = await monitor.observe(identity);
    assert.match(result, /correct report/);
    assert.doesNotMatch(result, /wrong report/);
  });
});

it('restored intent projects lost monitoring, never fake activity, and rejects controls', async (t) => {
  const previous = globalThis.fetch;
  const published: any[] = [];
  globalThis.fetch = (async (_url, init) => {
    published.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ ok: true }));
  }) as typeof fetch;
  const feature = new CapabilityShellFeature({ agentId: 'parent', sessionId: 'next', panel: true });
  t.after(async () => { await feature.onDestroy(); globalThis.fetch = previous; });
  feature.restoreState({ observations: [identity] });
  await new Promise<void>(resolve => setImmediate(resolve));
  const list = await feature.onHostRequest('list');
  assert.equal((list.tasks as any[])[0].status, 'monitor_lost');
  assert.match((list.tasks as any[])[0].summary, /重新 watch/);
  assert.equal(published[0].presentation.protocol, 'claw.background.agent');
  assert.equal(published.find(body => body.kind === 'event').data.status, 'monitor_lost');
  assert.equal((await feature.onHostRequest('kill')).ok, false);
});

it('feature send returns receipt; watch standby is one-shot; continuity warns without redispatch', async (t) => {
  const requests: any[] = [];
  const feature = new CapabilityShellFeature({ sessionId: 'parent-1', serverOrigin: 'http://test',
    deliver: async () => {}, fetchImpl: async (url, init) => {
      requests.push({ url, init });
      const body = url.endsWith('/commands') ? { ok: true, command: { commandId: 'cmd-1' }, delivery: { delivered: 1 } }
        : url.includes('/events') ? { ok: true, events: [], cursor: 0, baseOffset: 0 }
          : { ok: true, thread: snapshot().thread };
      return { ok: true, status: 200, json: async () => body };
    } });
  t.after(() => feature.onDestroy());
  const [tool] = await feature.getAsyncTools({ agentId: 'viewer-1' } as any);
  const providers = new Map();
  const host = { registerPendingWorkProvider: (key, fn) => { providers.set(key, fn); return () => providers.delete(key); } };
  const reminders: string[] = [];
  const ctx = { agent: host, context: { addSystemMessage: (text) => reminders.push(text) } } as any;
  feature.registerBackground(ctx);
  assert.match(String(await tool.execute({ command: "send wt-1 key 'work'" })), /sent cmd-1/);
  assert.equal([...providers.values()][0]().length, 1);
  assert.equal(await feature.standby(), 'continue');
  assert.match(String(await tool.execute({ command: 'watch wt-1 --command=cmd-1' })), /monitoring/);
  assert.equal(await feature.standby(), 'deny');
  assert.equal(await feature.standby(), 'continue');
  const saved = feature.captureState();
  const restored = new CapabilityShellFeature();
  restored.restoreState(saved);
  restored.registerBackground(ctx);
  restored.registerBackground(ctx);
  assert.equal(reminders.length, 1);
  assert.match(reminders[0], /watch wt-1 --command=cmd-1/);
  assert.equal(requests.filter((r) => r.init?.method === 'POST').length, 1);
  await restored.onDestroy();
});
