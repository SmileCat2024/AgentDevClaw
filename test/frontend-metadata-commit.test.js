import assert from 'node:assert/strict';
import test from 'node:test';
import { createMetadataCommit } from '../public/src/modules/metadata-commit.js';

function fixture({ now = 5000, lastAction = 0, target = 'task' } = {}) {
  let interrupt = target;
  let currentInput = [];
  let currentTodo = '';
  const effects = [];
  const writes = [];
  const policy = createMetadataCommit({
    inputCurrent: token => !token.oldInput,
    normalizeOverview: value => value,
    overviewSignature: JSON.stringify,
    normalizeTodo: value => value,
    todoSignature: JSON.stringify,
    currentOverviewSignature: () => '',
    currentTodoSignature: () => currentTodo,
    inputRequests: () => currentInput,
    interruptTarget: () => interrupt,
    setInterruptTarget: value => { interrupt = value; writes.push(value); },
    now: () => now,
    lastInterruptAction: () => lastAction,
    commit: (token, patch, effect) => {
      if (token.stale) return false;
      if ('inputRequests' in patch) currentInput = patch.inputRequests;
      if ('todoPlan' in patch) currentTodo = JSON.stringify(patch.todoPlan);
      effect({ current: patch });
      return true;
    },
    render: event => effects.push(event),
  });
  return { ...policy, effects, writes, target: () => interrupt };
}

test('terminal target clears immediately even inside manual-action grace, while stale transactions have no effects', () => {
  const f = fixture({ now: 5000, lastAction: 4999 });
  const todo = { tasks: [{ id: 'task', status: 'completed' }], interruptTargetId: 'other' };
  assert.equal(f.commitMetadataUpdate({ stale: true }, { todoRaw: todo }), false);
  assert.equal(f.target(), 'task');
  assert.deepEqual(f.effects, []);
  assert.deepEqual(f.writes, []);
  assert.equal(f.commitMetadataUpdate({}, { todoRaw: todo }), true);
  assert.equal(f.target(), null);
  assert.deepEqual(f.writes, [null], 'server target cannot override a recent manual action');
  assert.equal(f.effects[0].interruptCleared, true);
});

for (const [elapsed, expected] of [[3000, 'task'], [3001, 'server']]) {
  test(`server interrupt target sync respects the 3000ms manual-action boundary (${elapsed})`, () => {
    const f = fixture({ now: 10000, lastAction: 10000 - elapsed });
    f.commitMetadataUpdate({}, { todoRaw: { tasks: [], interruptTargetId: 'server' } });
    assert.equal(f.target(), expected);
  });
}

test('unchanged input is still published, but an older input version is excluded from a mixed metadata commit', () => {
  const f = fixture();
  f.commitMetadataUpdate({}, { inputRequestsRaw: [] });
  assert.equal(Object.hasOwn(f.effects[0].current, 'inputRequests'), true);
  assert.equal(f.effects[0].inputChanged, false);
  f.commitMetadataUpdate({ oldInput: true }, { inputRequestsRaw: [{ requestId: 'old' }], overviewJson: { modelName: 'new' } });
  assert.equal(Object.hasOwn(f.effects[1].current, 'inputRequests'), false);
  assert.deepEqual(f.effects[1].current.overview, { modelName: 'new' });
});
