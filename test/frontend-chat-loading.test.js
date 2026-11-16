import assert from 'node:assert/strict';
import test from 'node:test';
import { createChatLoading } from '../public/src/modules/chat-loading.js';

function fixture() {
  let loading = false;
  let timer = null;
  let serial = 0;
  let renders = 0;
  const timers = new Map();
  return {
    ...createChatLoading({ loading: () => loading, timer: () => timer,
      setLoading: value => { loading = value; }, setTimer: value => { timer = value; },
      setTimeout: (callback, delay) => { const id = ++serial; timers.set(id, { callback, delay }); return id; },
      clearTimeout: id => timers.delete(id), render: () => { renders += 1; } }),
    timers, state: () => ({ loading, timer, renders }),
    expire() { const task = timers.get(timer); timers.delete(timer); task.callback(); },
  };
}

test('loading expires after ten seconds and repaints the welcome even with no message changes', () => {
  const f = fixture();
  f.beginChatLoadingSession();
  assert.equal(f.state().loading, true);
  assert.equal(f.timers.get(f.state().timer).delay, 10000);
  f.expire();
  assert.deepEqual(f.state(), { loading: false, timer: null, renders: 1 });
  assert.equal(f.timers.size, 0);
});

test('restarting loading replaces the old timeout, and accepting messages cancels it without another render', () => {
  const f = fixture();
  f.beginChatLoadingSession();
  const first = f.state().timer;
  f.beginChatLoadingSession();
  assert.equal(f.timers.has(first), false);
  assert.equal(f.timers.size, 1);
  f.clearChatLoadingSession();
  assert.deepEqual(f.state(), { loading: false, timer: null, renders: 0 });
  assert.equal(f.timers.size, 0);
  f.clearChatLoadingSession();
  assert.deepEqual(f.state(), { loading: false, timer: null, renders: 0 });
});
