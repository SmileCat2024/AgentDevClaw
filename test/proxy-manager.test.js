import { createServer } from 'node:http';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { testProxyConnectivity } from '../server/shared/proxy-manager.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('proxy connectivity diagnostics', () => {
  it('tests the actual ChatGPT Codex endpoint by default', async () => {
    let requestedUrl = '';
    globalThis.fetch = async (url) => {
      requestedUrl = String(url);
      return { status: 405 };
    };

    const result = await testProxyConnectivity();
    assert.equal(requestedUrl, 'https://chatgpt.com/backend-api/codex/responses');
    assert.equal(result.ok, true);
    assert.equal(result.statusCode, 405);
  });

  it('identifies a response-header timeout separately from connect failures', async () => {
    globalThis.fetch = async () => {
      const error = new TypeError('fetch failed');
      error.cause = Object.assign(new Error('Headers timeout'), { code: 'UND_ERR_HEADERS_TIMEOUT' });
      throw error;
    };

    const result = await testProxyConnectivity();
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'UND_ERR_HEADERS_TIMEOUT');
    assert.equal(result.phase, 'response_headers');
  });

  describe('testing a specific proxy address', () => {
    it('routes the probe through the given proxy address', async () => {
      const received = [];
      // Stub proxy: undici tunnels through it via CONNECT, and example.invalid
      // does not resolve — so a 200 can only come through this stub.
      const server = createServer();
      server.on('connect', (req, clientSocket) => {
        received.push({ method: 'CONNECT', url: req.url });
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        // Answer once the tunneled request arrives, not before
        clientSocket.once('data', () => {
          clientSocket.end('HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 2\r\n\r\n{}');
        });
      });
      server.on('clientError', (_err, socket) => socket.destroy());
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        const proxyUrl = `http://127.0.0.1:${server.address().port}`;
        const result = await testProxyConnectivity('http://example.invalid/', proxyUrl);

        assert.equal(result.ok, true);
        assert.equal(result.statusCode, 200);
        assert.equal(received[0].url, 'example.invalid:80');
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });

    it('reports a failure when the proxy address is unreachable', async () => {
      // Reserve a port, release it, then target it — nothing listens there.
      const probe = createServer();
      await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
      const port = probe.address().port;
      await new Promise((resolve) => probe.close(resolve));

      const result = await testProxyConnectivity('http://example.invalid/', `http://127.0.0.1:${port}`);
      assert.equal(result.ok, false);
      assert.equal(result.statusCode, 0);
      assert.equal(result.errorCode, 'ECONNREFUSED');
    });
  });
});
