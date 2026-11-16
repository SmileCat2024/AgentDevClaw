import assert from 'node:assert/strict';
import test from 'node:test';
import { createPollCycle } from '../public/src/modules/poll-cycle.js';

function fixture(overrides = {}) {
  const events = [];
  let choiceAt = 0, templateAt = 0;
  const host = {
    switching: () => false, schedule: delay => events.push(['schedule', delay]),
    fastInterval: () => 1000, interval: () => 3000, sseActive: () => false, now: () => 5000,
    lastChoiceCheck: () => choiceAt, setChoiceCheck: value => { choiceAt = value; },
    checkChoices: async () => { events.push('choices'); }, refreshRemote: () => events.push('remote'),
    templates: () => ({}), lastTemplateReload: () => templateAt, setTemplateReload: value => { templateAt = value; },
    reloadTemplates: async () => { events.push('templates'); }, runtimeId: () => 'rt',
    noFocus: async () => { events.push('no-focus'); }, runtime: async () => { events.push('runtime'); },
    warn: (...args) => events.push(['warn', ...args]), ...overrides,
  };
  return { ...createPollCycle(host), host, events };
}

test('active session switch postpones all poll IO', async () => {
  const f = fixture({ switching: () => true });
  await f.runPollCycle();
  assert.deepEqual(f.events, [['schedule', 1000]]);
});

test('global maintenance is throttled across cycles, while SSE suppresses choice polling', async () => {
  const f = fixture();
  await f.runPollCycle();
  await f.runPollCycle();
  assert.deepEqual(f.events, ['choices', 'remote', 'templates', 'runtime', 'remote', 'runtime']);
  const sse = fixture({ sseActive: () => true, runtimeId: () => null });
  await sse.runPollCycle();
  assert.deepEqual(sse.events, ['remote', 'templates', 'no-focus', ['schedule', 3000]]);
});

test('failed runtime logs and schedules recovery without starting an extra cycle', async () => {
  const error = new Error('offline');
  const f = fixture({ runtime: async () => { throw error; } });
  await f.runPollCycle();
  assert.deepEqual(f.events.at(-1), ['schedule', 3000]);
  assert.equal(f.events.at(-2)[0], 'warn');
  assert.equal(f.events.at(-2)[2], error);
});

test('template reload completes before branch selection observes a changed focus', async () => {
  let runtime = 'old';
  const f = fixture({ runtimeId: () => runtime, reloadTemplates: async () => { runtime = null; } });
  await f.runPollCycle();
  assert.ok(f.events.includes('no-focus'));
  assert.equal(f.events.includes('runtime'), false);
});
