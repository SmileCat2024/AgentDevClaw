import assert from 'node:assert/strict';
import test from 'node:test';
import { createCommittedViewRenderer } from '../public/src/modules/committed-view-renderer.js';

function fixture(options = {}) {
  const events = [];
  const record = name => (...args) => events.push([name, ...args]);
  const renderer = createCommittedViewRenderer({
    clearLoading: record('clear'), markTitle() {}, firstChanged: () => options.changed ?? 1,
    workspaceSurface: () => options.workspace ?? false, render: record('full'),
    append: record('append'), updateLast: record('tail'), reconcile: record('echo'),
    panel: () => options.panel || 'plan', renderPanel: record('panel'),
    updateContext: record('context'), updateModel: record('model'), updateThinking: record('thinking'),
    updatePlanBadge: record('badge'), clearCompletedCompact: record('compact'),
    updateRollback: record('rollback'), chatSurface: () => true, syncInput: record('input'),
  });
  return { ...renderer, events };
}

test('accepted append paints only new messages before removing optimistic echoes', () => {
  const f = fixture();
  const messages = [{ content: 'old' }, { content: 'new' }];
  f.renderMessages({ previous: { messages: messages.slice(0, 1) }, current: { messages } });
  assert.deepEqual(f.events, [['clear'], ['append', [messages[1]], 1], ['echo', messages]]);
});

test('middle rewrite and workspace transcript rebuild; ordinary tail edit preserves the viewport', () => {
  const before = { messages: [{ content: 'a' }, { content: 'b' }] };
  const current = { messages: [{ content: 'changed' }, { content: 'tail' }] };
  const middle = fixture({ changed: 0 });
  middle.renderMessages({ previous: before, current });
  assert.deepEqual(middle.events, [['clear'], ['full', current], ['echo', current.messages]]);
  const tail = fixture({ changed: 1 });
  tail.renderMessages({ previous: before, current });
  assert.deepEqual(tail.events, [['clear'], ['tail', current.messages[1]], ['echo', current.messages]]);
  const workspace = fixture({ workspace: true });
  workspace.renderMessages({ previous: before, current });
  assert.deepEqual(workspace.events, [['clear'], ['full', current], ['echo', current.messages]]);
});

test('unchanged transcript does not rebuild and an emptied transcript clears the rendered body', () => {
  const f = fixture({ changed: -1 });
  const previous = { messages: [{ content: 'a' }] };
  f.renderMessages({ previous, current: previous });
  assert.deepEqual(f.events, [['clear'], ['echo', previous.messages]]);
  f.events.length = 0;
  const current = { messages: [] };
  f.renderMessages({ previous, current });
  assert.deepEqual(f.events, [['full', current], ['echo', []]]);
});

test('changed input updates rollback controls without replaying the input notification', () => {
  const f = fixture();
  const token = { runtimeId: 'runtime' };
  f.renderMetadata({ token, inputChanged: true, inputRequests: [{ id: 'new' }], interruptCleared: true });
  assert.deepEqual(f.events, [['panel'], ['compact', token, [{ id: 'new' }]], ['rollback']]);
});

test('overview refresh updates context and model controls; unchanged input resynchronizes the current composer', () => {
  const f = fixture({ panel: 'workspace' });
  const current = { overview: { model: 'new' } };
  const token = { runtimeId: 'runtime' };
  f.renderMetadata({ token, current, overviewChanged: true, todoChanged: true, inputRequests: [] });
  assert.deepEqual(f.events, [['panel'], ['context', current], ['model'], ['thinking'], ['badge'],
    ['compact', token, []], ['input', 'runtime']]);
});
