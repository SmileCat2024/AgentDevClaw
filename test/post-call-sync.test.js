import test from 'node:test';
import assert from 'node:assert/strict';
import { enqueueOrderedProjection } from '../scripts/post-call-sync.js';
import { CallArbiter } from '../server/call-arbiter.js';

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

test('a slow post-call projection does not block the next turn', async () => {
  const projectionBlocked = deferred();
  const projectionStarted = deferred();
  const secondCallStarted = deferred();
  const calls = [];
  const owner = { syncChain: Promise.resolve() };
  const arbiter = new CallArbiter({
    async onCall(text) {
      calls.push(text);
      if (text === 'second') secondCallStarted.resolve();
      return '';
    },
  });

  arbiter.on('callFinished', (envelope) => {
    enqueueOrderedProjection(owner, 'syncChain', async () => {
      calls.push(`projection:${envelope.text}:start`);
      projectionStarted.resolve();
      await projectionBlocked.promise;
      calls.push(`projection:${envelope.text}:end`);
    }, (error) => { throw error; });
  });

  const first = arbiter.enqueue({ source: 'chat-composer', text: 'first' });
  await arbiter.waitForCompletion(first.id);
  await projectionStarted.promise;

  const second = arbiter.enqueue({ source: 'chat-composer', text: 'second' });
  await secondCallStarted.promise;
  assert.deepEqual(calls, ['first', 'projection:first:start', 'second']);

  projectionBlocked.resolve();
  await owner.syncChain;
  assert.deepEqual(calls, ['first', 'projection:first:start', 'second', 'projection:first:end']);
});

test('projection failures are reported and do not poison later ordered work', async () => {
  const owner = { syncChain: Promise.resolve() };
  const arbiter = new CallArbiter({ async onCall() { return ''; } });
  const errors = [];
  const completed = [];
  arbiter.on('callFinished', (envelope) => {
    enqueueOrderedProjection(owner, 'syncChain', async () => {
      if (envelope.text === 'first') throw new Error('offline');
      completed.push(envelope.text);
    }, (error) => errors.push(error.message));
  });

  await arbiter.waitForCompletion(arbiter.enqueue({ text: 'first' }).id);
  await arbiter.waitForCompletion(arbiter.enqueue({ text: 'second' }).id);
  await owner.syncChain;
  assert.deepEqual(errors, ['offline']);
  assert.deepEqual(completed, ['second']);
});
