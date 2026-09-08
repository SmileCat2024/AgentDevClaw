/**
 * Remote image attachment tests (ADR-0006 / ADR-0011).
 *
 * Covers:
 *   1. /r/<connId>/protoclaw/images/<file> asset forwarding — remote message
 *      attachments live in the remote host's image store, so GET must pass
 *      through the connection proxy (history rendering / attachment preview).
 *   2. Upload route remote branch — an agentId carrying the remote namespace
 *      is forwarded to the remote host's own upload route (the message path
 *      must resolve on the agent's machine); the response url is rewritten to
 *      the /r/<connId> asset route and the agentId itself never crosses the
 *      tunnel.
 *   3. Upload route local branch — legacy behavior (content hash dedup,
 *      absolute path + local url).
 *   4. GET /protoclaw/images/:filename — serves stored bytes, rejects traversal.
 *
 * All file I/O is directed at an injected temp directory — the real user data
 * root is never touched.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { setupImageRoutes } from '../server/routes/images.js';
import { proxyToViewer, setProxyConnectionLookup } from '../server/shared/proxy.js';

const CONNECTIONS = [
  { id: 'server-a', name: 'Server A', enabled: true, mode: 'manual', localPort: 22101 },
  { id: 'server-a-disabled', name: 'Server A (disabled)', enabled: false, mode: 'manual', localPort: 22102 },
];
const FIND_CONNECTION = (() => {
  const byId = new Map(CONNECTIONS.map((connection) => [connection.id, connection]));
  return (connectionId) => byId.get(connectionId) || null;
})();
const REMOTE_ORIGIN = 'http://127.0.0.1:22101';

// PNG 1x1 transparent pixel
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function startImageServer(imagesDir) {
  const app = express();
  setupImageRoutes(app, { imagesDir });
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

// ── 1. Asset route forwarding (/r/<connId>/protoclaw/images/…) ───────────

describe('remote image asset read-through', () => {
  it('forwards /r/<connId>/protoclaw/images/<file> to the remote origin', async () => {
    const calls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      return {
        status: 200,
        headers: new Headers({ 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' }),
        arrayBuffer: async () => Buffer.from('PNGBYTES'),
      };
    };
    setProxyConnectionLookup(FIND_CONNECTION);
    try {
      const res = {
        statusCode: null,
        headers: [],
        status(code) { this.statusCode = code; return this; },
        setHeader(key, value) { (this.headers = this.headers || []).push([key, value]); },
        end() {},
      };
      await proxyToViewer(
        { originalUrl: '/r/server-a/protoclaw/images/abc123.png', method: 'GET', headers: {} },
        res,
        { findConnection: FIND_CONNECTION },
      );
      assert.equal(res.statusCode, 200);
      assert.deepEqual(calls, [`${REMOTE_ORIGIN}/protoclaw/images/abc123.png`],
        'asset route must forward to the remote origin with the /r/<connId> prefix stripped');
    } finally {
      setProxyConnectionLookup(null);
      globalThis.fetch = originalFetch;
    }
  });

  it('keeps rejecting non-asset remote host paths', async () => {
    const res = {
      statusCode: null,
      jsonPayload: null,
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.jsonPayload = payload; },
      setHeader() {},
      end() {},
    };
    await proxyToViewer(
      { originalUrl: '/r/server-a/protoclaw/something-else', method: 'GET', headers: {} },
      res,
      { findConnection: FIND_CONNECTION },
    );
    assert.equal(res.statusCode, 403);
  });
});

// ── 2. Upload route: local vs remote branch ──────────────────────────────

describe('image upload route host addressing', () => {
  let tempDir;
  let server;
  let baseUrl;

  before(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'claw-images-test-'));
    server = await startImageServer(tempDir);
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => {
    server.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('stores locally for plain identities and keeps the legacy response shape', async () => {
    const res = await fetch(`${baseUrl}/protoclaw/images/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base64: PNG_BASE64, mediaType: 'image/png', source: 'shot.png' }),
    });
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.ok(data.path.startsWith(tempDir), `path must live in the injected dir: ${data.path}`);
    assert.match(data.path, /\.png$/);
    assert.equal(data.mediaType, 'image/png');
    assert.equal(data.source, 'shot.png');
    assert.match(data.url, /^\/protoclaw\/images\/[0-9a-f]{32}\.png$/);
  });

  it('dedups identical content to the same stored file', async () => {
    const upload = (source) => fetch(`${baseUrl}/protoclaw/images/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base64: PNG_BASE64, mediaType: 'image/png', source }),
    }).then((res) => res.json());
    const first = await upload('first.png');
    const second = await upload('second.png');
    assert.equal(first.url, second.url, 'same content must map to the same stored file');
  });

  it('forwards remote-namespace uploads to the connection and rewrites the url', async () => {
    const calls = [];
    const originalFetch = globalThis.fetch;
    // Only the server-side forward is mocked; the browser-side request uses a
    // raw http client so it reaches the real route while global fetch is mocked.
    globalThis.fetch = async (url, init) => {
      calls.push({
        url: String(url),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json; charset=utf-8' }),
        json: async () => ({
          path: '/home/remote-user/.agentdev/AgentDevClaw/images/abc.png',
          mediaType: 'image/png',
          source: 'shot.png',
          size: 70,
          url: '/protoclaw/images/abc.png',
        }),
      };
    };
    setProxyConnectionLookup(FIND_CONNECTION);
    try {
      const raw = await new Promise((resolve, reject) => {
        const req = http.request({
          port: server.address().port,
          path: '/protoclaw/images/upload',
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        }, (res) => {
          let body = '';
          res.on('data', (chunk) => { body += chunk; });
          res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        req.on('error', reject);
        req.end(JSON.stringify({
          base64: PNG_BASE64,
          mediaType: 'image/png',
          source: 'shot.png',
          agentId: 'remote:server-a:agent-1',
        }));
      });
      const data = JSON.parse(raw.body);
      assert.equal(raw.status, 200);
      assert.equal(calls.length, 1, 'remote upload must cross the tunnel');
      assert.equal(calls[0].url, `${REMOTE_ORIGIN}/protoclaw/images/upload`);
      assert.equal(calls[0].body.agentId, undefined,
        'agentId is resolved locally and must not cross the tunnel');
      assert.equal(calls[0].body.base64, PNG_BASE64);
      // path 引用远程主机的存储（agent 端可解析），url 指回本机的资产路由
      assert.equal(data.path, '/home/remote-user/.agentdev/AgentDevClaw/images/abc.png');
      assert.equal(data.url, '/r/server-a/protoclaw/images/abc.png');
    } finally {
      setProxyConnectionLookup(null);
      globalThis.fetch = originalFetch;
    }
  });

  it('fails explicitly for an unknown remote connection', async () => {
    const res = await fetch(`${baseUrl}/protoclaw/images/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base64: PNG_BASE64, agentId: 'remote:no-such:agent-1' }),
    });
    assert.equal(res.status, 404);
    const data = await res.json();
    assert.equal(data.code, 'target_not_found');
  });

  it('answers 503 transport_unavailable when the tunnel fetch rejects', async () => {
    const originalFetch = globalThis.fetch;
    // 浏览器侧请求走 raw http（globalThis.fetch 被拦截为转发失败）；
    // server 端 forward 的 fetch 才是被 mock 的对象。
    globalThis.fetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    setProxyConnectionLookup(FIND_CONNECTION);
    try {
      const raw = await new Promise((resolve, reject) => {
        const req = http.request({
          port: server.address().port,
          path: '/protoclaw/images/upload',
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        }, (res) => {
          let body = '';
          res.on('data', (chunk) => { body += chunk; });
          res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        req.on('error', reject);
        req.end(JSON.stringify({ base64: PNG_BASE64, agentId: 'remote:server-a:agent-1' }));
      });
      assert.equal(raw.status, 503);
      const data = JSON.parse(raw.body);
      assert.equal(data.code, 'transport_unavailable');
      assert.equal(data.retryable, true);
    } finally {
      setProxyConnectionLookup(null);
      globalThis.fetch = originalFetch;
    }
  });

  it('answers 503 retryable for a disabled remote connection', async () => {
    setProxyConnectionLookup(FIND_CONNECTION);
    try {
      const res = await fetch(`${baseUrl}/protoclaw/images/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base64: PNG_BASE64, agentId: 'remote:server-a-disabled:agent-1' }),
      });
      assert.equal(res.status, 503);
      const data = await res.json();
      assert.equal(data.code, 'transport_unavailable');
      assert.equal(data.retryable, true);
    } finally {
      setProxyConnectionLookup(null);
    }
  });

  it('rejects uploads without base64', async () => {
    const res = await fetch(`${baseUrl}/protoclaw/images/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mediaType: 'image/png' }),
    });
    assert.equal(res.status, 400);
  });
});

// ── 3. Local serving route ───────────────────────────────────────────────

describe('local image serving', () => {
  let tempDir;
  let server;
  let baseUrl;

  before(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'claw-images-serve-'));
    writeFileSync(join(tempDir, 'stored.png'), Buffer.from(PNG_BASE64, 'base64'));
    const app = express();
    setupImageRoutes(app, { imagesDir: tempDir });
    server = await new Promise((resolve) => {
      const listener = app.listen(0, () => resolve(listener));
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => {
    server.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('serves stored bytes with the matching mime', async () => {
    const res = await fetch(`${baseUrl}/protoclaw/images/stored.png`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.equal(Buffer.from(await res.arrayBuffer()).toString('base64'), PNG_BASE64);
  });

  it('rejects path traversal (encoded dot segments)', async () => {
    // Raw HTTP client: fetch/URL would normalize ../ out of the path.
    const status = await new Promise((resolve, reject) => {
      const req = http.get({ port: server.address().port, path: '/protoclaw/images/%2e%2e%2fsecret.png' }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      req.on('error', reject);
    });
    assert.equal(status, 400);
  });

  it('answers 404 for missing files', async () => {
    const res = await fetch(`${baseUrl}/protoclaw/images/missing.png`);
    assert.equal(res.status, 404);
  });
});
