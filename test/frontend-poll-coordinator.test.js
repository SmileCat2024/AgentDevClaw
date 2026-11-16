import assert from 'node:assert/strict';
import test from 'node:test';
import { createPollCoordinator } from '../public/src/modules/poll-coordinator.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(run) {
  const timers = new Map();
  let nextId = 0;
  const coordinator = createPollCoordinator({
    run,
    fastInterval: () => 1000,
    setTimeout(callback, delay) {
      const id = ++nextId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
  });
  return {
    ...coordinator,
    timers,
    fire() {
      assert.equal(timers.size, 1, 'only one recursive timer chain may exist');
      const [id, { callback }] = timers.entries().next().value;
      timers.delete(id);
      callback();
    },
  };
}

test('scheduled refresh is replaceable and direct refresh cancels the pending timer', async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; });
  f.schedulePoll();
  assert.equal([...f.timers.values()][0].delay, 1000);
  f.schedulePoll(120);
  assert.equal(f.timers.size, 1);
  assert.equal([...f.timers.values()][0].delay, 120);
  await f.poll();
  assert.equal(calls, 1);
  assert.equal(f.timers.size, 0, 'the superseded timer cannot start a duplicate cycle');
  f.schedulePoll(-10);
  assert.equal([...f.timers.values()][0].delay, 0);
  f.fire();
  assert.equal(calls, 2, 'the remaining timer reaches the real cycle');
});

test('concurrent refreshes share one cycle and replace its normal timer with one immediate follow-up', async () => {
  const first = deferred();
  let calls = 0;
  const f = fixture(() => {
    calls++;
    return calls === 1 ? first.promise : Promise.resolve('next');
  });
  const a = f.poll();
  const b = f.poll();
  const c = f.poll();
  assert.equal(calls, 1);
  f.schedulePoll(5000); // the running cycle's normal recursive schedule
  first.resolve('done');
  assert.deepEqual(await Promise.all([a, b, c]), ['done', 'done', 'done']);
  assert.equal(f.timers.size, 1);
  assert.equal([...f.timers.values()][0].delay, 0);
  f.fire();
  assert.equal(calls, 2);
  await f.poll();
  assert.equal(calls, 2, 'a request while the follow-up runs must not overlap it');
});

test('failed shared cycle rejects every caller but unlocks and preserves the requested follow-up', async () => {
  const first = deferred();
  let calls = 0;
  const f = fixture(() => ++calls === 1 ? first.promise : Promise.resolve('recovered'));
  const settled = Promise.allSettled([f.poll(), f.poll()]);
  const failure = new Error('offline');
  first.reject(failure);
  const results = await settled;
  assert.deepEqual(results.map((result) => result.status), ['rejected', 'rejected']);
  assert.ok(results.every((result) => result.reason === failure));
  assert.equal(f.timers.size, 1);
  assert.equal([...f.timers.values()][0].delay, 0);
  assert.equal(await f.poll(), 'recovered');
  assert.equal(calls, 2);
  assert.equal(f.timers.size, 0);
});
