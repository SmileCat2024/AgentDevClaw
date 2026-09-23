import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { FeatureCommunicationClient } from '../src/feature-communication.js';

describe('FeatureCommunicationClient', () => {
  it('publishes scoped snapshots and events to the host contract', async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init || {} });
      return new Response(JSON.stringify(calls.length === 3 ? { ok: false, code: 'invalid_request' } : { ok: true, revision: 1 }));
    }) as typeof fetch;
    try {
      const client = new FeatureCommunicationClient('http://127.0.0.1:1420', {
        agentId: 'agent-a', sessionId: 'session-a', featureId: 'shell', channelId: 'task-1',
      });
      await client.publishSnapshot({ status: 'running' });
      await client.publishEvent('output', { text: 'hello' });
      await assert.rejects(client.publishSnapshot({ bad: true }));
      assert.equal(calls.length, 3);
      assert.equal(calls[0].url, 'http://127.0.0.1:1420/protoclaw/feature-comms/publish');
      assert.equal(JSON.parse(String(calls[0].init.body)).kind, 'snapshot');
      assert.equal(JSON.parse(String(calls[1].init.body)).eventType, 'output');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
