import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntimeNotFound } from '../public/src/modules/runtime-not-found.js';

function fixture(overrides = {}) {
  const effects = [];
  const record = { connected: true, callActive: true };
  const host = {
    isCurrent: () => true, clearCompact: id => effects.push(['compact', id]), switching: () => false,
    schedule: delay => effects.push(['schedule', delay]), fastInterval: () => 1000, interval: () => 5000,
    sessionId: () => 'old', hostRecord: () => ({ id: 'host' }), thread: () => null,
    canRefreshThreads: () => true, refreshThreads: async () => {}, activeConversation: () => null,
    runtimeRecord: () => record, fallback: () => null, emptyTodo: () => ({ tasks: [] }),
    patch: (_token, patch, effect) => { effects.push(['patch', patch]); effect(); return true; },
    clearView: (...args) => effects.push(['clear', ...args]),
    loadAgents: async () => effects.push('load'), ...overrides,
  };
  return { ...createRuntimeNotFound(host), effects, record };
}

test('stale response performs no cleanup, refresh or scheduling', async () => {
  const f = fixture({ isCurrent: () => false });
  assert.equal(await f.handleCoreResponsesNotFound({ runtimeId: 'old' }), true);
  assert.deepEqual(f.effects, []);
});

test('navigation while refreshing thread facts cannot clear the newly selected view', async () => {
  let current = true;
  const f = fixture({ thread: () => ({ status: 'open' }), isCurrent: () => current,
    refreshThreads: async () => { current = false; } });
  await f.handleCoreResponsesNotFound({ runtimeId: 'old' });
  assert.deepEqual(f.effects, [['compact', 'old']]);
});

for (const fallback of [null, 'workspace']) {
  test(`real disappearance publishes only the correct cleanup patch (fallback=${fallback})`, async () => {
    const f = fixture({ fallback: () => fallback });
    await f.handleCoreResponsesNotFound({ runtimeId: 'old' });
    assert.deepEqual(f.effects[1], ['patch', fallback ? {} : { messages: [], inputRequests: [], todoPlan: { tasks: [] } }]);
    assert.deepEqual(f.effects[2], ['clear', 'old', f.record, fallback]);
    assert.deepEqual(f.effects.slice(3), ['load', ['schedule', 5000]]);
  });
}

test('rejected disappearance transaction retries without clearing view or refreshing agents', async () => {
  const f = fixture({ patch: () => false });
  await f.handleCoreResponsesNotFound({ runtimeId: 'old' });
  assert.deepEqual(f.effects, [['compact', 'old'], ['schedule', 1000]]);
});
