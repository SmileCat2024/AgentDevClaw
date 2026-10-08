/**
 * Tests for the streaming ASR WS proxy (server/routes/speech-stream.js).
 *
 * Spawns a real proxy (http server + setupSpeechStreamProxy with injected
 * config reader) and a real mock upstream (ws WebSocketServer speaking the
 * Qwen-ASR WS protocol), then drives a real ws client through the full
 * protocol: ready → start/binary/stop upstream passthrough → normalized
 * partial/committed/final events → close-code contract.
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';

import { setupSpeechStreamProxy, SPEECH_STREAM_PATH } from '../server/routes/speech-stream.js';

const UPSTREAM_TIMEOUT_MS = 2000;

// ── harness ──

function startUpstreamMock(handler) {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0 });
    wss.on('connection', (ws) => handler(ws));
    wss.on('listening', () => resolve({ wss, port: wss.address().port }));
  });
}

function startProxy(speechModel) {
  const server = createServer();
  setupSpeechStreamProxy(server, { readSpeechConfig: async () => ({ speechModel }) });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function connect(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${SPEECH_STREAM_PATH}`);
    attachBuffer(ws);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

// On loopback the server's first frames (ready / error+close) can arrive in
// the same TCP segment as the 101 handshake response, so 'message'/'close'
// fire synchronously inside the same event-loop turn as 'open'. Listeners
// attached after `await connect()` would miss them — buffer every socket
// event up front and let the waiters drain the buffer.
function attachBuffer(ws) {
  ws.__frames = [];
  ws.__closed = null;
  ws.on('message', (data, isBinary) => ws.__frames.push([Buffer.from(data), isBinary]));
  ws.on('close', (code, reason) => { ws.__closed = { code, reason: reason.toString() }; });
  return ws;
}

async function nextJson(ws) {
  const frame = await nextFrame(ws, (isBinary) => !isBinary, 'message timeout');
  return JSON.parse(frame.toString());
}

async function nextBinary(ws) {
  return nextFrame(ws, (isBinary) => isBinary, 'binary timeout');
}

async function nextFrame(ws, accept, timeoutLabel) {
  for (;;) {
    const idx = ws.__frames.findIndex(([, isBinary]) => accept(isBinary));
    if (idx >= 0) {
      const [data] = ws.__frames.splice(idx, 1)[0];
      return data;
    }
    if (ws.__closed) throw new Error(`${timeoutLabel}: socket closed (${ws.__closed.code})`);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(timeoutLabel)), UPSTREAM_TIMEOUT_MS);
      const onData = () => {
        clearTimeout(timer);
        ws.off('message', onData);
        ws.off('close', onClose);
        resolve();
      };
      const onClose = () => {
        clearTimeout(timer);
        ws.off('message', onData);
        ws.off('close', onClose);
        resolve();
      };
      ws.on('message', onData);
      ws.on('close', onClose);
    });
  }
}

async function waitClose(ws) {
  if (ws.__closed) return ws.__closed;
  return new Promise((resolve) => ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
}

const activeResources = [];
function track(resource) { activeResources.push(resource); return resource; }
afterEach(async () => {
  const resources = activeResources.splice(0);
  // Sockets first: server.close() waits for open connections, so tracked
  // clients must be terminated before the servers can actually shut down.
  for (const r of resources) {
    if (r instanceof WebSocket) {
      r.removeAllListeners();
      try { r.terminate(); } catch { /* already closed */ }
    }
  }
  for (const r of resources) {
    if (r instanceof WebSocket) continue;
    await new Promise((res) => r.close(res));
  }
});

// ── tests ──

describe('speech-stream proxy', () => {

  it('rejects the handshake with 4400 when apiType is not audio-stream', async () => {
    const proxy = track((await startProxy({ baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', model: 'm', language: 'auto', apiType: 'audio' })).server);
    const port = proxy.address().port;

    const client = track(await connect(port));
    const msg = await nextJson(client);
    assert.equal(msg.type, 'error');
    const closed = await waitClose(client);
    assert.equal(closed.code, 4400);
  });

  it('rejects with 4400 when speech model is not configured', async () => {
    const proxy = track((await startProxy(null)).server);
    const client = track(await connect(proxy.address().port));
    const closed = await waitClose(client);
    assert.equal(closed.code, 4400);
  });

  it('proxies the full protocol: start/binary/stop upstream, normalized events downstream', async () => {
    const received = { texts: [], binaries: [] };
    const upstream = track((await startUpstreamMock((ws) => {
      attachBuffer(ws);
      ws.on('message', (data, isBinary) => {
        if (isBinary) {
          received.binaries.push(Buffer.from(data));
          ws.send(JSON.stringify({ event: 'partial', text: '你好' }));
          return;
        }
        const cmd = JSON.parse(data.toString());
        received.texts.push(cmd);
        if (cmd.op === 'start') ws.send(JSON.stringify({ event: 'ready' })); // upstream ready is NOT remapped
        if (cmd.op === 'stop') {
          ws.send(JSON.stringify({ event: 'ack', audio_s: 1.2 })); // ack is not forwarded
          ws.send(JSON.stringify({ event: 'committed', text: '你好 ' }));
          ws.send(JSON.stringify({ event: 'final', text: '世界' }));
        }
      });
    })).wss);
    const upstreamPort = upstream.address().port;

    const proxy = track((await startProxy({
      baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: 'k', model: 'm', language: 'auto', apiType: 'audio-stream',
    })).server);
    const client = track(await connect(proxy.address().port));

    // pipeline ready (upstream connected) — the single Claw-side ready
    assert.deepEqual(await nextJson(client), { type: 'ready' });

    client.send(JSON.stringify({ op: 'start' }));
    const upstreamClient = upstream.clients.values().next().value;
    assert.deepEqual(await nextJson(upstreamClient), { op: 'start' });

    client.send(Buffer.from([1, 0, 2, 0]), { binary: true });
    const frame = await nextBinary(upstreamClient);
    assert.deepEqual([...frame], [1, 0, 2, 0]);

    assert.deepEqual(await nextJson(client), { type: 'partial', text: '你好' });

    client.send(JSON.stringify({ op: 'stop' }));
    assert.deepEqual(await nextJson(client), { type: 'committed', text: '你好 ' });
    assert.deepEqual(await nextJson(client), { type: 'final', text: '世界' });

    client.close();
    assert.deepEqual(received.texts, [{ op: 'start' }, { op: 'stop' }]);
    assert.equal(received.binaries.length, 1);
  });

  it('closes with 4001 when the upstream is unreachable', async () => {
    // reserve then release a port so nothing listens on it
    const dummy = track(createServer());
    await new Promise((res) => dummy.listen(0, '127.0.0.1', res));
    const deadPort = dummy.address().port;
    await new Promise((res) => dummy.close(res));

    const proxy = track((await startProxy({
      baseUrl: `http://127.0.0.1:${deadPort}/v1`, apiKey: 'k', model: 'm', language: 'auto', apiType: 'audio-stream',
    })).server);
    const client = track(await connect(proxy.address().port));
    const closed = await waitClose(client);
    assert.equal(closed.code, 4001);
  });

  it('propagates upstream mid-stream disconnect as error + 4001 close', async () => {
    const upstream = track((await startUpstreamMock((ws) => {
      ws.on('message', () => ws.close());
    })).wss);
    const proxy = track((await startProxy({
      baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiKey: 'k', model: 'm', language: 'auto', apiType: 'audio-stream',
    })).server);

    const client = track(await connect(proxy.address().port));
    assert.deepEqual(await nextJson(client), { type: 'ready' });
    client.send(JSON.stringify({ op: 'start' }));

    const msg = await nextJson(client);
    assert.equal(msg.type, 'error');
    const closed = await waitClose(client);
    assert.equal(closed.code, 4001);
  });

  it('drops non-JSON client messages instead of forwarding them', async () => {
    let upstreamGotMessage = false;
    const upstream = track((await startUpstreamMock((ws) => {
      ws.on('message', () => { upstreamGotMessage = true; });
    })).wss);
    const proxy = track((await startProxy({
      baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiKey: 'k', model: 'm', language: 'auto', apiType: 'audio-stream',
    })).server);

    const client = track(await connect(proxy.address().port));
    assert.deepEqual(await nextJson(client), { type: 'ready' });
    client.send('this is not json');

    await new Promise((res) => setTimeout(res, 100));
    assert.equal(upstreamGotMessage, false);
    // connection stays usable afterwards
    assert.equal(client.readyState, WebSocket.OPEN);
  });
});
