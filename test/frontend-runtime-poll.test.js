import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntimePoll } from '../public/src/modules/runtime-poll.js';

function fixture(overrides = {}) {
  const events = [];
  const requested = [];
  const host = {
    capture: () => ({ runtimeId: 'rt' }), consumeForceFull: () => false, sseActive: () => true,
    guard: async () => { events.push('guard'); },
    status: async () => { events.push('status'); return { notifData: { calling: true } }; },
    refreshCalls: async (_agents, options) => events.push(['calls', options]), agents: () => [],
    commit: (_token, effect) => { effect(); return true; }, isCurrent: () => true,
    syncInput: () => events.push('input'), title: () => events.push('title'), tail: async () => true,
    schedule: delay => events.push(['schedule', delay]), fastInterval: () => 1000, interval: () => 3000,
    fetch: async url => { requested.push(url); return { status: 200, ok: true, json: async () => ({}) }; },
    notFound: async () => events.push('404'), messages: async () => 'committed',
    probe: () => null, metadata: () => true, ...overrides,
  };
  return { ...createRuntimePoll(host), host, events, requested };
}

test('healthy SSE cycle does not request full metadata and schedules the slow reconciliation cadence', async () => {
  const f = fixture();
  await f.runRuntimePoll();
  assert.deepEqual(f.requested, []);
  assert.deepEqual(f.events, ['guard', ['calls', { reuseNotification: null }], 'input', 'title', ['schedule', 3000]]);
});

test('forced reconciliation covers local call state and reuses its focused notification', async () => {
  const f = fixture({ consumeForceFull: () => true });
  await f.runRuntimePoll();
  assert.deepEqual(f.requested, ['/api/agents/rt/input-requests', '/api/agents/rt/overview', '/api/agents/rt/todo']);
  assert.deepEqual(f.events[1], ['calls', { includeSseLocals: true,
    reuseNotification: { runtimeId: 'rt', payload: { calling: true } } }]);
  assert.deepEqual(f.events.at(-1), ['schedule', 1000]);
});

for (const lostAt of ['fetch', 'json']) {
  test(`departed view during ${lostAt} cannot reach message or metadata commit`, async () => {
    let current = true;
    const f = fixture({
      sseActive: () => false,
      isCurrent: () => current,
      fetch: async () => {
        if (lostAt === 'fetch') current = false;
        return { status: 200, ok: true, json: async () => { current = false; return {}; } };
      },
      messages: async () => { assert.fail('stale view reached messages'); },
      metadata: () => { assert.fail('stale view reached metadata'); },
    });
    await f.runRuntimePoll();
    assert.deepEqual(f.events.at(-1), ['schedule', 1000]);
  });
}

for (const messages404 of [false, true]) {
  test(`core disappearance uses the shared recovery path (messages404=${messages404})`, async () => {
    const f = fixture({
      sseActive: () => false,
      fetch: async () => ({ status: messages404 ? 200 : 404, ok: true, json: async () => ({}) }),
      messages: async () => 'handled404',
      metadata: () => { assert.fail('404 must not publish metadata'); },
    });
    await f.runRuntimePoll();
    assert.ok(f.events.includes('404'));
    assert.equal(f.events.some(event => event === 'input'), false);
  });
}
