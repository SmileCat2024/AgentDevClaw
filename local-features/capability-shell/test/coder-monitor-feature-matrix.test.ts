import { it } from 'node:test';
import assert from 'node:assert/strict';
import { CapabilityShellFeature } from '../src/coder-shell-feature.js';

const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const identity = { threadId: 'wt', commandId: 'cmd' };
const complete = { type: 'turn.completed', sourceRef: 'cmd', sessionId: 's1', turn: 0 };

async function harness(t: any, { panel = true, malformed, panelFails = false, restored, readGate }: any = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let events: any[] = [];
  let failed = false;
  const publications: any[] = [], notices: any[] = [], requests: any[] = [], reminders: string[] = [];
  const providers = new Map<string, () => any[]>();
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.ok(String(url).startsWith('http://test/protoclaw/feature-comms/'));
    if (panelFails) throw new Error('panel offline');
    publications.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ ok: true }));
  });
  const config = { serverOrigin: 'http://test', agentId: 'parent', sessionId: 'parent-session', panel,
    pollIntervalMs: 100, deliver: async notice => { notices.push(notice); },
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      if (url.includes('/commands')) return { ok: true, status: 200, json: async () => ({ ok: true, command: { commandId: 'cmd' }, delivery: { delivered: 1 } }) };
      if (failed && url.includes('/events')) throw new Error('server offline');
      if (readGate && url.includes('/events')) await readGate(init.signal);
      let body: any = url.includes('/events') ? { ok: true, events, cursor: events.length, baseOffset: 0 }
        : { ok: true, thread: { threadId: 'wt', headSessionId: 's1', status: 'open', headRuntimeRunning: true,
          commands: [{ commandId: 'cmd', source: 'coder_shell', status: 'delivered' }] } };
      if (malformed && ((malformed === 'thread') === !url.includes('/events'))) {
        body = { ...body }; delete body[malformed];
      }
      return { ok: true, status: 200, json: async () => body };
    } };
  const feature = new CapabilityShellFeature(config);
  t.after(() => feature.onDestroy());
  if (restored) feature.restoreState({ observations: restored });
  const [tool] = await feature.getAsyncTools({ agentId: 'parent-viewer' } as any);
  const context = { agent: { registerPendingWorkProvider: (key, fn) => {
    providers.set(key, fn); return () => providers.delete(key);
  } }, context: { addSystemMessage: text => reminders.push(text) } } as any;
  feature.registerBackground(context);
  return { feature, config, context, reminders, publications, notices, requests, providers,
    execute: async (command: string) => String(await tool.execute({ command })),
    set: (value: any[]) => { events = value; }, fail: (value: boolean) => { failed = value; },
    pending: () => [...providers.values()].flatMap(fn => fn()),
    flush: async () => { t.mock.timers.tick(0); await flush(); } };
}

for (const malformed of ['events', 'cursor', 'baseOffset', 'thread']) {
  it(`M9-PROTOCOL: missing ${malformed} preserves submission and exposes actual monitor loss`, async t => {
    const h = await harness(t, { malformed });
    const receipt = await h.execute("send wt key 'work'");
    assert.match(receipt, /sent cmd[\s\S]*reason=monitor_unreachable[\s\S]*缺少执行关联契约/);
    assert.equal((await h.feature.onHostRequest('list')).tasks[0].status, 'monitor_lost');
    await h.flush();
    assert.equal(h.notices.length, 1);
    assert.equal(h.requests.filter(r => r.init?.method === 'POST').length, 1);
    assert.deepEqual(h.pending(), []);
  });
}

it('M9-STANDBY: send keeps working; watch is one-shot; completed target and next input never empty-wait', async t => {
  const h = await harness(t);
  await h.execute("send wt key 'work'");
  assert.equal(await h.feature.standby(), 'continue');
  assert.equal(h.pending().length, 1);
  await h.execute('watch wt');
  assert.equal(await h.feature.standby(), 'deny');
  assert.equal(await h.feature.standby(), 'continue');
  await h.execute('watch wt');
  h.feature.registerBackground(h.context);
  assert.equal(await h.feature.standby(), 'continue');
  h.set([complete]);
  await h.execute('watch wt');
  assert.equal(await h.feature.standby(), 'continue');
  await h.flush();
  assert.equal(h.pending().length, 0);
});

it('M9-RESTORE: fresh start has no loss; unreconstructed intent survives reminder and a second handoff', async t => {
  const h = await harness(t, { restored: [identity] });
  assert.equal(h.reminders.length, 1);
  h.feature.registerBackground(h.context);
  assert.equal(h.reminders.length, 1);
  assert.deepEqual(h.feature.captureState().observations, [identity]);
  assert.equal(h.pending().length, 0, 'restored intent is not a live observer');
  const next = new CapabilityShellFeature(h.config);
  t.after(() => next.onDestroy());
  next.restoreState(h.feature.captureState());
  assert.equal((await next.onHostRequest('list')).tasks[0].status, 'monitor_lost');
  const messages: string[] = [];
  next.registerBackground({ ...h.context, context: { addSystemMessage: text => messages.push(text) } } as any);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /watch wt --command=cmd/);
  assert.equal(h.requests.length, 0, 'restoring never reconnects or re-dispatches');
});

for (const completed of [false, true]) {
  it(`M9-RESTORE M9-REBUILD: explicit watch replaces restored loss with ${completed ? 'completed' : 'active'} facts`, async t => {
    const h = await harness(t, { restored: [identity] });
    if (completed) h.set([complete]);
    await h.execute('watch wt --command=cmd');
    const tasks = (await h.feature.onHostRequest('list')).tasks as any[];
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].status, completed ? 'completed' : 'submitted');
    await h.flush();
    assert.equal(h.publications.filter(p => p.kind === 'event').at(-1).data.status, tasks[0].status);
    assert.equal(h.requests.filter(r => r.init?.method === 'POST').length, 0);
    assert.equal(h.feature.captureState().observations.length, completed ? 0 : 1);
  });
}

it('M9-RESTORE: fresh feature and malformed snapshot do not create false lost intent', async t => {
  const h = await harness(t);
  assert.equal(h.reminders.length, 0);
  assert.deepEqual((await h.feature.onHostRequest('list')).tasks, []);
  h.feature.restoreState({ observations: [null, {}, { threadId: 5, commandId: 'cmd' }] });
  h.feature.registerBackground(h.context);
  assert.equal(h.reminders.length, 0);
});

for (const mode of ['disabled', 'offline', 'healthy']) {
  it(`M9-PANEL-FAIL: ${mode} panel never owns execution or notification`, async t => {
    const h = await harness(t, { panel: mode !== 'disabled', panelFails: mode === 'offline' });
    await h.execute("send wt key 'work'");
    h.set([complete]);
    assert.match(await h.execute('watch wt'), /reason=completed/);
    await h.flush();
    assert.equal(h.notices.length, 1);
    assert.equal(h.notices[0].sessionId, 'parent-session');
    assert.deepEqual(h.pending(), []);
    if (mode === 'disabled') assert.equal((await h.feature.onHostRequest('list')).ok, false);
    else assert.equal((await h.feature.onHostRequest('list')).tasks[0].status, 'completed');
    for (const operation of ['kill', 'report']) assert.equal((await h.feature.onHostRequest(operation)).ok, false);
  });
}

it('M9-DISPOSE: destroying feature aborts observer read, removes provider, and ignores late projection', async t => {
  let release: () => void;
  let entered: () => void;
  let signal: AbortSignal;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const reading = new Promise<void>(resolve => { entered = resolve; });
  const h = await harness(t, { readGate: input => { signal = input; entered(); return gate; } });
  const call = h.execute("send wt key 'work'");
  await reading;
  await flush();
  const before = h.publications.length;
  const destroying = h.feature.onDestroy();
  assert.equal(signal!.aborted, true);
  release!();
  await Promise.all([destroying, call]);
  await h.flush();
  assert.equal(h.providers.size, 0);
  assert.equal(h.publications.length, before);
  assert.equal(h.notices.length, 0);
  assert.equal(h.requests.filter(r => r.init?.method === 'POST').length, 1);
});
