import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { proxyToViewer } from '../server/shared/proxy.js';

describe('proxyToViewer request headers', () => {
  it('drops hop-by-hop and content-length headers before fetch recalculates them', async () => {
    const originalFetch = globalThis.fetch;
    let forwarded = null;
    globalThis.fetch = async (_url, init) => {
      forwarded = init;
      return new Response('{"ok":true}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const req = {
      originalUrl: '/api/agents/example/input',
      method: 'POST',
      headers: {
        host: '127.0.0.1:1420',
        connection: 'keep-alive',
        'content-length': '15',
        'content-type': 'application/json',
        'x-request-id': 'test-request',
      },
      async *[Symbol.asyncIterator]() {
        yield Buffer.from('{"text":"hello"}');
      },
    };
    const responseHeaders = new Map();
    let statusCode = null;
    let responseBody = null;
    const res = {
      status(value) {
        statusCode = value;
        return this;
      },
      setHeader(key, value) {
        responseHeaders.set(key.toLowerCase(), value);
      },
      end(value) {
        responseBody = value;
      },
    };

    try {
      await proxyToViewer(req, res);
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(forwarded.headers.has('host'), false);
    assert.equal(forwarded.headers.has('connection'), false);
    assert.equal(forwarded.headers.has('content-length'), false);
    assert.equal(forwarded.headers.get('content-type'), 'application/json');
    assert.equal(forwarded.headers.get('x-request-id'), 'test-request');
    assert.equal(Buffer.from(forwarded.body).toString('utf8'), '{"text":"hello"}');
    assert.equal(statusCode, 200);
    assert.equal(responseHeaders.get('content-type'), 'application/json');
    assert.equal(Buffer.from(responseBody).toString('utf8'), '{"ok":true}');
  });
});
