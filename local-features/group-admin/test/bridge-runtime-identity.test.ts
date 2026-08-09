import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { GroupChatBridgeFeature } from '../src/bridge.js';

describe('GroupChatBridgeFeature runtime identity', () => {
  let originalFetch: typeof fetch;
  let requests: Array<{ url: string; body: any }>;

  beforeEach(() => {
    requests = [];
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
      requests.push({
        url: String(input),
        body: init?.body ? JSON.parse(init.body) : null,
      });
      return { ok: true, status: 200, json: async () => ({ ok: true }) } as any;
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('writes back using the owning session rather than process.env', async () => {
    const feature = new GroupChatBridgeFeature({
      agentId: 'programming-helper',
      sessionId: 'second-session',
      serverOrigin: 'http://runtime.test',
    });

    await (feature as any).postWriteback('http://runtime.test', {
      id: 'message-1',
      text: 'hello',
      gcChatId: 'chat-1',
      gcIdentityRef: 'member-1',
    }, 'done', null);

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'http://runtime.test/protoclaw/gc/writeback');
    assert.equal(requests[0].body.sessionId, 'second-session');
  });
});
