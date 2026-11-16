import assert from 'node:assert/strict';
import test from 'node:test';
import { createViewerReadiness } from '../public/src/modules/startup-readiness.js';
import { computeSerializedBytes, createMessageMetrics } from '../public/src/modules/message-metrics.js';

test('Viewer readiness retries unavailable transport with no-store and stops on success', async () => {
  let now = 0;
  const requests = [];
  const wait = createViewerReadiness({
    now: () => now, url: () => '/api/agents', wait: async delay => { now += delay; },
    fetch: async (...args) => {
      requests.push(args);
      if (requests.length === 1) throw new Error('not listening');
      return { ok: requests.length === 3 };
    },
  });
  assert.equal(await wait(), true);
  assert.equal(now, 600);
  assert.deepEqual(requests, Array.from({ length: 3 }, () => ['/api/agents', { cache: 'no-store' }]));
});

test('Viewer readiness returns false at deadline without a lingering timer or another request', async () => {
  let now = 0;
  let requests = 0;
  const wait = createViewerReadiness({ now: () => now, url: () => 'http://127.0.0.1:2026/api/agents',
    wait: async delay => { now += delay; }, fetch: async url => {
      assert.equal(url, 'http://127.0.0.1:2026/api/agents'); requests += 1; return { ok: false };
    } });
  assert.equal(await wait(600), false);
  assert.equal(requests, 2);
  assert.equal(await wait(0), false);
  assert.equal(requests, 2);
});

test('message metrics use UTF-8 bytes and remain opt-in with live query lookup', () => {
  assert.equal(computeSerializedBytes({ text: '中' }), Buffer.byteLength('{"text":"中"}'));
  const circular = {}; circular.self = circular;
  assert.equal(computeSerializedBytes(circular), 0);
  const events = [];
  let search = '';
  const emit = createMessageMetrics({ search: () => search, debug: (...args) => events.push(args) });
  const metrics = { actualBytes: 25, fakeFullBytes: 100, changeKind: 'tail', downgraded: false };
  emit(metrics);
  assert.deepEqual(events, []);
  search = '?msg_metrics=1'; emit(metrics);
  assert.deepEqual(events, [['[msg-metrics]', { ...metrics, savedRatio: 0.75 }]]);
  emit({ ...metrics, actualBytes: 200 });
  assert.equal(events[1][1].savedRatio, 0);
  emit({ ...metrics, fakeFullBytes: 0 });
  assert.equal(events[2][1].savedRatio, null);
});
