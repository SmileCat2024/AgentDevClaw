import assert from 'node:assert/strict';
import test from 'node:test';
import { createCompactResume } from '../public/src/modules/compact-resume.js';

function fixture(overrides = {}) {
  const requests = [];
  const events = [];
  const host = {
    isRemote: id => String(id).startsWith('remote:'), remote: () => null,
    createOperationId: reason => `op-${reason}`, now: () => 0,
    observe: id => { events.push(['observe', id]); return () => events.push(['stop']); },
    checkpoint: (_id, phase) => events.push([phase]), idempotencyKey: () => 'unique-key',
    fetch: async (url, options) => { requests.push({ url, ...options, body: JSON.parse(options.body) });
      return { ok: true, json: async () => ({ sessionId: 'next' }) }; },
    refreshThreads: () => events.push(['threads']), ...overrides,
  };
  return { ...createCompactResume(host), requests, events };
}

test('trim preserves archive/reason/policy fields and sends one idempotent synchronous delta request', async () => {
  const f = fixture();
  const result = await f.createCompactedResumeSession('host', 'source', 'trim', 3, 2, { custom: true },
    { archiveOriginal: true, reason: 'trim', trimCutRounds: 0, appendSummary: true });
  assert.deepEqual(result, { sessionId: 'next' });
  assert.deepEqual(f.requests, [{ url: '/protoclaw/context_handoffs/compact_and_resume', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-idempotency-key': 'unique-key' }, body: {
      agentId: 'host', sessionId: 'source', detached: false,
      policy: { strategy: 'trim', keepRecentTurns: 3, fullPreserveFromTurn: 2, custom: true },
      archiveOriginal: true, reason: 'trim', trimCutRounds: 0, appendSummary: true,
      operationId: 'op-trim', responseMode: 'delta',
    } }]);
  assert.deepEqual(f.events.slice(-2), [['threads'], ['stop']]);
});

test('remote requests use host ownership while preserving namespaced session and result conversion', async () => {
  const conversions = [];
  const f = fixture({ remote: () => ({ getHostNamespaceIdForSession: () => 'remote:server:host',
    namespaceMutationResult: (session, result) => { conversions.push([session, result]); return { sessionId: 'remote:server:next' }; } }) });
  const result = await f.createCompactedResumeSession('old-host', 'remote:server:source');
  assert.equal(f.requests[0].body.agentId, 'remote:server:host');
  assert.equal(f.requests[0].body.sessionId, 'remote:server:source');
  assert.deepEqual(result, { sessionId: 'remote:server:next' });
  assert.deepEqual(conversions, [['remote:server:source', { sessionId: 'next' }]]);
});

for (const failure of ['network', 'http', 'json']) {
  test(`${failure} failure propagates and closes diagnostics without refreshing thread facts`, async () => {
    const f = fixture({ fetch: async () => {
      if (failure === 'network') throw new Error('network');
      return { ok: failure !== 'http', text: async () => 'http', json: async () => { throw new Error('json'); } };
    } });
    await assert.rejects(f.createCompactedResumeSession('host', 'source'), new RegExp(failure));
    assert.deepEqual(f.events.at(-1), ['stop']);
    assert.equal(f.events.some(e => e[0] === 'threads'), false);
  });
}
