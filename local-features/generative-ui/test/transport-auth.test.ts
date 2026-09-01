/**
 * HttpSurfaceTransport 认证行为测试
 *
 * Claw server 开启登录保护后 /protoclaw 路径要求 Bearer 认证；
 * transport 必须随请求出示 PROTOCLAW_INTERNAL_TOKEN。
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { HttpSurfaceTransport } from '../src/transport.js';

describe('HttpSurfaceTransport internal auth', () => {
  let fetchCalls: Array<{ url: string; init: any }>;
  let originalFetch: typeof fetch;
  let originalToken: string | undefined;

  beforeEach(() => {
    fetchCalls = [];
    originalFetch = globalThis.fetch;
    originalToken = process.env.PROTOCLAW_INTERNAL_TOKEN;
    globalThis.fetch = (async (input: any, init?: any) => {
      fetchCalls.push({
        url: typeof input === 'string' ? input : String(input),
        init: init || {},
      });
      return {
        status: 200,
        ok: true,
        json: async () => ({ ok: true, surface: { surfaceId: 's', revision: 1, status: 'active' } }),
      } as any;
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.PROTOCLAW_INTERNAL_TOKEN;
    else process.env.PROTOCLAW_INTERNAL_TOKEN = originalToken;
  });

  it('presents the internal token as a Bearer header on write requests', async () => {
    process.env.PROTOCLAW_INTERNAL_TOKEN = 'secret-internal-token';
    const transport = new HttpSurfaceTransport('http://127.0.0.1:1420');

    await transport.upsert('agent-1', { surfaceId: 'release', spec: {} as any });

    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].init.headers.Authorization, 'Bearer secret-internal-token');
    assert.equal(fetchCalls[0].init.headers['Content-Type'], 'application/json');
  });

  it('presents the token on poll-style read and delete requests', async () => {
    process.env.PROTOCLAW_INTERNAL_TOKEN = 'secret-internal-token';
    const transport = new HttpSurfaceTransport('http://127.0.0.1:1420');

    await transport.list('agent-1');
    await transport.close('agent-1', 'release');

    assert.equal(fetchCalls.length, 2);
    assert.equal(fetchCalls[0].init.headers.Authorization, 'Bearer secret-internal-token');
    assert.equal(fetchCalls[1].init.headers.Authorization, 'Bearer secret-internal-token');
    assert.equal(fetchCalls[1].init.method, 'DELETE');
  });

  it('omits the Authorization header when no internal token is injected', async () => {
    delete process.env.PROTOCLAW_INTERNAL_TOKEN;
    const transport = new HttpSurfaceTransport('http://127.0.0.1:1420');

    await transport.list('agent-1');

    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].init.headers.Authorization, undefined);
  });
});
