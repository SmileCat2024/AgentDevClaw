/**
 * Tests for server/routes/sse-events.js
 *
 * Covers:
 * 1. 启动探测 —— worker 无事件总线 API 时 501
 * 2. 首连握手 —— 头部契约、hello 帧（bell 扫描、agents 快照、通道参数）
 * 3. 事件发布 —— 各 kind 快照组装、messages/connection 信号直传
 * 4. 合并窗口 —— 同 (kind, agentId) 只发最后一帧、flush 时组装最新快照、
 *    不同 agent 互不阻塞
 * 5. 快照缺失 —— agent 不存在时跳过该帧
 * 6. Last-Event-ID 重放 —— 断线重连补帧、环形缓冲超界 resync、
 *    eid 大于当前值（服务端重启归零）resync
 * 7. 心跳帧、连接上限 503 与释放回收、closeAll 收口
 * 8. compression —— SSE 不压缩且逐帧送达，JSON 路由仍 gzip
 * 9. 真实 ViewerWorker API 契约 —— 防止框架版本回退静默破坏推送通道
 *
 * Uses node:test format per project convention (test/*.test.js).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import express from 'express';
import compression from 'compression';

import { createSseEventsModule, createSseCompressionFilter } from '../server/routes/sse-events.js';

// ── Test helpers ──────────────────────────────────────────────────

function makeFakeWorker() {
  let listener = null;
  const state = {
    agents: [],
    notification: new Map(),
    overview: new Map(),
    todo: new Map(),
    inputRequests: new Map(),
    queuedInputs: new Map(),
  };
  const worker = {
    onSessionEvent(cb) { listener = cb; return () => { listener = null; }; },
    listAgentStates: () => state.agents,
    getNotificationSnapshot: (id) => state.notification.get(id) ?? null,
    getOverviewSnapshot: (id) => state.overview.get(id) ?? null,
    getTodoSnapshot: (id) => state.todo.get(id) ?? null,
    getInputRequestsSnapshot: (id) => state.inputRequests.get(id) ?? null,
    getQueuedInputsSnapshot: (id) => state.queuedInputs.get(id) ?? null,
  };
  return { worker, state, emit: (e) => { if (listener) listener(e); } };
}

function makeHarness(t, { worker, useCompression = false, ...moduleOpts } = {}) {
  const app = express();
  if (useCompression) {
    app.use(compression({ filter: createSseCompressionFilter(compression.filter) }));
  }
  const mod = createSseEventsModule({
    viewerWorker: worker,
    coalesceMs: 5, heartbeatMs: 25, ringSize: 64, maxClients: 16,
    ...moduleOpts,
  });
  mod.setupRoutes(app);
  const server = http.createServer(app);
  const streams = [];
  const start = () => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = (p = '/protoclaw/events') => `http://127.0.0.1:${server.address().port}${p}`;
  /** 持久流：后台 pump 持续收字节，readUntil 轮询谓词（3ms tick）。 */
  const openStream = async (opts = {}) => {
    const s = await openRawStream(url(), opts);
    streams.push(s);
    return s;
  };
  t.after(() => {
    for (const s of streams) s.abort();
    mod.closeAll();
    server.close();
    server.closeAllConnections?.();
  });
  return { app, mod, server, start, url, openStream };
}

async function openRawStream(url, { lastEventId, headers = {} } = {}) {
  const controller = new AbortController();
  const res = await fetch(url, {
    headers: {
      ...(lastEventId !== undefined ? { 'last-event-id': String(lastEventId) } : {}),
      ...headers,
    },
    signal: controller.signal,
  });
  const state = { text: '', status: res.status, headers: res.headers, done: false };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (value) state.text += decoder.decode(value, { stream: true });
        if (done) break;
      }
    } catch { /* aborted or server closed */ }
    state.done = true;
  })();
  const readUntil = async (predicate, timeoutMs = 1000) => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate(state.text)) {
      if (state.done || Date.now() > deadline) return false;
      await new Promise((r) => setTimeout(r, 3));
    }
    return true;
  };
  return { state, readUntil, abort: () => controller.abort(), pump };
}

function parseFrames(text) {
  return text.split('\n\n')
    .filter(Boolean)
    .map((block) => {
      const frame = { id: null, event: null, data: null, comment: false };
      for (const line of block.split('\n')) {
        if (line.startsWith(':')) { frame.comment = true; continue; }
        if (line.startsWith('id: ')) frame.id = Number(line.slice(4));
        else if (line.startsWith('event: ')) frame.event = line.slice(7);
        else if (line.startsWith('data: ')) frame.data = JSON.parse(line.slice(6));
      }
      return frame;
    });
}

const events = (text) => parseFrames(text).filter((f) => !f.comment);
const hasHello = (tx) => tx.includes('event: hello');

/** 轮询 stats() 直到条件满足（合并窗口 flush 是异步定时器）。 */
async function waitStats(mod, predicate, timeoutMs = 300) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate(mod.stats())) return mod.stats();
    if (Date.now() > deadline) return mod.stats();
    await new Promise((r) => setTimeout(r, 2));
  }
}

// ── 1. 启动探测 ───────────────────────────────────────────────────

describe('sse-events: startup probe', () => {
  it('returns 501 when worker lacks onSessionEvent', async (t) => {
    const fake = makeFakeWorker();
    delete fake.worker.onSessionEvent;
    const h = makeHarness(t, { worker: fake.worker });
    await h.start();
    const res = await fetch(h.url());
    assert.equal(res.status, 501);
    assert.equal((await res.json()).error, 'sse-unsupported');
  });
});

// ── 2. 首连握手 ───────────────────────────────────────────────────

describe('sse-events: hello handshake', () => {
  it('sends headers + hello with choice alerts and agent summaries', async (t) => {
    const fake = makeFakeWorker();
    fake.state.agents = [
      { id: 'a1', name: 'Agent One', connected: true },
      { id: 'a2', name: 'Agent Two', connected: false },
    ];
    fake.state.inputRequests.set('a1', [{
      mode: 'choices', questions: [{ q: 'pick' }], requestId: 'req-1',
    }]);
    const h = makeHarness(t, { worker: fake.worker });
    await h.start();

    const s = await h.openStream();
    assert.ok(await s.readUntil(hasHello), `hello frame missing:\n${s.state.text}`);
    assert.equal(s.state.status, 200);
    assert.match(s.state.headers.get('content-type') || '', /^text\/event-stream/);
    assert.equal(s.state.headers.get('cache-control'), 'no-cache');
    assert.equal(s.state.headers.get('x-accel-buffering'), 'no');
    assert.ok(s.state.text.startsWith(': connected'));

    const hello = events(s.state.text).find((f) => f.event === 'hello');
    assert.equal(hello.id, 0);
    assert.equal(hello.data.hello, true);
    assert.equal(hello.data.heartbeatMs, 25);
    assert.deepEqual(hello.data.choiceAlerts, [
      { requestId: 'req-1', agentId: 'a1', agentName: 'Agent One' },
    ]);
    assert.deepEqual(hello.data.agents, [
      { id: 'a1', name: 'Agent One', connected: true },
      { id: 'a2', name: 'Agent Two', connected: false },
    ]);
  });
});

// ── 3. 事件发布 ───────────────────────────────────────────────────

describe('sse-events: event publishing', () => {
  it('notification event carries GET-shaped snapshot payload', async (t) => {
    const fake = makeFakeWorker();
    fake.state.notification.set('a1', {
      state: 'running', event: { type: 'step' }, runtime: { status: 'busy' }, callActive: true,
    });
    const h = makeHarness(t, { worker: fake.worker });
    await h.start();

    const s = await h.openStream();
    await s.readUntil(hasHello);
    fake.emit({ kind: 'notification', agentId: 'a1' });
    assert.ok(await s.readUntil((tx) => tx.includes('event: notification')), 'frame missing');

    const frame = events(s.state.text).find((f) => f.event === 'notification');
    assert.equal(frame.id, 1); // hello 是 id 0，首个发布事件 eid 1
    assert.equal(frame.data.kind, 'notification');
    assert.equal(frame.data.agentId, 'a1');
    assert.equal(frame.data.data.state, 'running');
    assert.equal(frame.data.data.callActive, true);
  });

  it('messages event passes probe inline', async (t) => {
    const fake = makeFakeWorker();
    const h = makeHarness(t, { worker: fake.worker });
    await h.start();
    const s = await h.openStream();
    await s.readUntil(hasHello);
    fake.emit({ kind: 'messages', agentId: 'a1', probe: { seq: 3, count: 10, changeKind: 'append', sinceIndex: 9, fakeFullBytes: 0 } });
    assert.ok(await s.readUntil((tx) => tx.includes('event: messages')));

    const frame = events(s.state.text).find((f) => f.event === 'messages');
    assert.equal(frame.data.probe.seq, 3);
    assert.equal(frame.data.probe.changeKind, 'append');
  });

  it('connection event passes state flags', async (t) => {
    const fake = makeFakeWorker();
    const h = makeHarness(t, { worker: fake.worker });
    await h.start();
    const s = await h.openStream();
    await s.readUntil(hasHello);
    fake.emit({ kind: 'connection', agentId: 'a1', connected: false, reconnected: false });
    assert.ok(await s.readUntil((tx) => tx.includes('event: connection')));

    const frame = events(s.state.text).find((f) => f.event === 'connection');
    assert.equal(frame.data.connected, false);
    assert.equal(frame.data.reconnected, false);
  });

  it('skips frames when snapshot is null (agent gone)', async (t) => {
    const fake = makeFakeWorker();
    const h = makeHarness(t, { worker: fake.worker });
    await h.start();
    const s = await h.openStream();
    await s.readUntil(hasHello);
    fake.emit({ kind: 'notification', agentId: 'ghost' });
    // 两个心跳周期足以证明 flush 已发生且未产生帧
    assert.ok(await s.readUntil((tx) => (tx.match(/: hb/g) || []).length >= 2));
    assert.ok(!s.state.text.includes('event: notification'));
    assert.equal(h.mod.stats().eidSeq, 0);
  });
});

// ── 4. 合并窗口 ───────────────────────────────────────────────────

describe('sse-events: coalescing window', () => {
  it('same kind+agent within window emits one frame with latest snapshot', async (t) => {
    const fake = makeFakeWorker();
    fake.state.notification.set('a1', { state: 'running', event: null, runtime: {}, callActive: true });
    const h = makeHarness(t, { worker: fake.worker });
    await h.start();
    const s = await h.openStream();
    await s.readUntil(hasHello);

    fake.emit({ kind: 'notification', agentId: 'a1' });
    // 窗口内更新快照：flush 时应组装最新状态
    fake.state.notification.set('a1', { state: 'done', event: null, runtime: {}, callActive: false });
    fake.emit({ kind: 'notification', agentId: 'a1' });
    fake.emit({ kind: 'notification', agentId: 'a1' });

    assert.ok(await s.readUntil((tx) => (tx.match(/: hb/g) || []).length >= 2));
    const frames = events(s.state.text).filter((f) => f.event === 'notification');
    assert.equal(frames.length, 1);
    assert.equal(frames[0].data.data.state, 'done');
    assert.equal(frames[0].data.data.callActive, false);
  });

  it('different agents coalesce independently', async (t) => {
    const fake = makeFakeWorker();
    fake.state.notification.set('a1', { state: 'x', event: null, runtime: {}, callActive: false });
    fake.state.notification.set('a2', { state: 'y', event: null, runtime: {}, callActive: true });
    const h = makeHarness(t, { worker: fake.worker });
    await h.start();
    const s = await h.openStream();
    await s.readUntil(hasHello);
    fake.emit({ kind: 'notification', agentId: 'a1' });
    fake.emit({ kind: 'notification', agentId: 'a2' });
    assert.ok(await s.readUntil((tx) => (tx.match(/: hb/g) || []).length >= 2));
    const frames = events(s.state.text).filter((f) => f.event === 'notification');
    assert.equal(frames.length, 2);
    assert.deepEqual(frames.map((f) => f.data.agentId).sort(), ['a1', 'a2']);
  });

  it('messages keeps only the latest probe per agent', async (t) => {
    const fake = makeFakeWorker();
    const h = makeHarness(t, { worker: fake.worker });
    await h.start();
    const s = await h.openStream();
    await s.readUntil(hasHello);
    fake.emit({ kind: 'messages', agentId: 'a1', probe: { seq: 5, count: 1, changeKind: 'append', sinceIndex: 0, fakeFullBytes: 0 } });
    fake.emit({ kind: 'messages', agentId: 'a1', probe: { seq: 6, count: 2, changeKind: 'tail', sinceIndex: 1, fakeFullBytes: 0 } });
    assert.ok(await s.readUntil((tx) => (tx.match(/: hb/g) || []).length >= 2));
    const frames = events(s.state.text).filter((f) => f.event === 'messages');
    assert.equal(frames.length, 1);
    assert.equal(frames[0].data.probe.seq, 6);
  });

  it('connection merge keeps latest state and OR-merges reconnected', async (t) => {
    const fake = makeFakeWorker();
    const h = makeHarness(t, { worker: fake.worker });
    await h.start();
    const s = await h.openStream();
    await s.readUntil(hasHello);
    fake.emit({ kind: 'connection', agentId: 'a1', connected: true, reconnected: true });
    fake.emit({ kind: 'connection', agentId: 'a1', connected: false, reconnected: false });
    assert.ok(await s.readUntil((tx) => (tx.match(/: hb/g) || []).length >= 2));
    const frames = events(s.state.text).filter((f) => f.event === 'connection');
    assert.equal(frames.length, 1);
    assert.equal(frames[0].data.connected, false);
    assert.equal(frames[0].data.reconnected, true);
  });
});

// ── 5. Last-Event-ID 重放 ─────────────────────────────────────────

describe('sse-events: Last-Event-ID replay', () => {
  it('replays missed frames after hello boundary, then continues live', async (t) => {
    const fake = makeFakeWorker();
    fake.state.notification.set('a1', { state: 'x', event: null, runtime: {}, callActive: false });
    fake.state.todo.set('a1', { items: [] });
    const h = makeHarness(t, { worker: fake.worker });
    await h.start();

    const s1 = await h.openStream();
    await s1.readUntil(hasHello);
    assert.equal(events(s1.state.text).find((f) => f.event === 'hello').id, 0);

    // 发布 eid 1、2（不同 kind 互不合并，各等 flush 落入环形缓冲）
    fake.emit({ kind: 'notification', agentId: 'a1' });
    await waitStats(h.mod, (st) => st.eidSeq >= 1);
    fake.emit({ kind: 'connection', agentId: 'a1', connected: false, reconnected: false });
    await waitStats(h.mod, (st) => st.eidSeq >= 2);
    s1.abort();

    // 断线期间再发布 eid 3
    fake.emit({ kind: 'todo', agentId: 'a1' });
    await waitStats(h.mod, (st) => st.eidSeq >= 3);

    // 重连：Last-Event-ID=0（hello 边界）→ 重放 1、2、3，hello(id=3, resumed)
    const s2 = await h.openStream({ lastEventId: 0 });
    await s2.readUntil(hasHello);
    let prev = -1;
    for (const marker of ['id: 1\n', 'id: 2\n', 'id: 3\n', 'event: hello']) {
      const idx = s2.state.text.indexOf(marker);
      assert.ok(idx > prev, `expected ${JSON.stringify(marker)} after previous marker in:\n${s2.state.text}`);
      prev = idx;
    }
    const hello = events(s2.state.text).find((f) => f.event === 'hello');
    assert.equal(hello.id, 3);
    assert.equal(hello.data.resumed, true);
    assert.equal(hello.data.resynced, false);

    // 重放完成后新事件继续实时到达
    fake.emit({ kind: 'notification', agentId: 'a1' });
    assert.ok(await s2.readUntil((tx) => tx.includes('id: 4')));
    assert.ok(s2.state.text.indexOf('id: 4') > s2.state.text.indexOf('event: hello'));
  });

  it('ring overflow sends resync instead of partial replay', async (t) => {
    const fake = makeFakeWorker();
    for (const id of ['a1', 'a2', 'a3']) {
      fake.state.notification.set(id, { state: 'x', event: null, runtime: {}, callActive: false });
    }
    const h = makeHarness(t, { worker: fake.worker, ringSize: 2 });
    await h.start();
    const s1 = await h.openStream();
    await s1.readUntil(hasHello);
    s1.abort();

    let expected = 0;
    for (const id of ['a1', 'a2', 'a3']) {
      fake.emit({ kind: 'notification', agentId: id });
      expected += 1;
      await waitStats(h.mod, (st) => st.eidSeq >= expected);
    }
    assert.equal(h.mod.stats().eidSeq, 3);
    assert.equal(h.mod.stats().ringFrames, 2); // 只剩 eid 2、3

    // Last-Event-ID=0：需要 (0,3]，缓冲从 2 开始 → 不完整 → resync
    const s2 = await h.openStream({ lastEventId: 0 });
    await s2.readUntil(hasHello);
    assert.ok(s2.state.text.includes('event: resync'));
    const resync = events(s2.state.text).find((f) => f.event === 'resync');
    assert.equal(resync.data.reason, 'ring-overflow');
    assert.equal(events(s2.state.text).find((f) => f.event === 'hello').data.resynced, true);
    // 不做部分重放
    assert.ok(!s2.state.text.includes('event: notification'));
  });

  it('eid newer than server (restart) sends resync', async (t) => {
    const fake = makeFakeWorker();
    const h = makeHarness(t, { worker: fake.worker });
    await h.start();
    const s = await h.openStream({ lastEventId: 999999 });
    await s.readUntil(hasHello);
    const resync = events(s.state.text).find((f) => f.event === 'resync');
    assert.equal(resync.data.reason, 'eid-from-newer-server');
    assert.ok(events(s.state.text).find((f) => f.event === 'hello').data.resynced);
  });
});

// ── 6. 心跳、上限、收口 ──────────────────────────────────────────

describe('sse-events: heartbeat, cap and shutdown', () => {
  it('emits comment heartbeat frames', async (t) => {
    const fake = makeFakeWorker();
    const h = makeHarness(t, { worker: fake.worker });
    await h.start();
    const s = await h.openStream();
    assert.ok(await s.readUntil((tx) => tx.includes(': hb')));
  });

  it('rejects connections beyond cap and recovers after disconnect', async (t) => {
    const fake = makeFakeWorker();
    const h = makeHarness(t, { worker: fake.worker, maxClients: 1 });
    await h.start();
    const s1 = await h.openStream();
    await s1.readUntil(hasHello);

    const res2 = await fetch(h.url());
    assert.equal(res2.status, 503);
    assert.equal((await res2.json()).error, 'sse_unavailable');

    s1.abort();
    await waitStats(h.mod, (st) => st.clients === 0);
    const res3 = await fetch(h.url());
    assert.equal(res3.status, 200);
    await res3.body.cancel();
  });

  it('closeAll notifies shutdown, clears state and unsubscribes', async (t) => {
    const fake = makeFakeWorker();
    fake.state.notification.set('a1', { state: 'x', event: null, runtime: {}, callActive: false });
    const h = makeHarness(t, { worker: fake.worker });
    await h.start();
    const s = await h.openStream();
    await s.readUntil(hasHello);

    // 留一个未 flush 的合并窗口条目，closeAll 应清掉定时器
    fake.emit({ kind: 'notification', agentId: 'a1' });
    h.mod.closeAll();
    assert.ok(await s.readUntil((tx) => tx.includes('event: shutdown')));

    const stats = h.mod.stats();
    assert.equal(stats.clients, 0);
    assert.equal(stats.pending, 0);
    // 退订后 emit 不再推进 eid
    fake.emit({ kind: 'notification', agentId: 'a1' });
    assert.equal(h.mod.stats().eidSeq, stats.eidSeq);
  });
});

// ── 7. compression 兼容 ──────────────────────────────────────────

describe('sse-events: compression interplay', () => {
  it('never compresses SSE but still gzips JSON', async (t) => {
    const fake = makeFakeWorker();
    const h = makeHarness(t, { worker: fake.worker, useCompression: true });
    h.app.get('/json', (_req, res) => res.json({ ok: true, pad: 'x'.repeat(2048) }));
    await h.start();

    // SSE：无 content-encoding，且连接保持打开期间 hello 已送达（未被压缩缓冲滞留）
    const s = await h.openStream({ headers: { 'accept-encoding': 'gzip' } });
    assert.ok(await s.readUntil(hasHello), 'hello must arrive while stream stays open');
    assert.equal(s.state.headers.get('content-encoding'), null);
    s.abort();

    // JSON 路由仍走 gzip
    const res = await fetch(h.url('/json'), { headers: { 'accept-encoding': 'gzip' } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-encoding'), 'gzip');
    await res.text();
  });
});

// ── 8. 真实 ViewerWorker API 契约 ─────────────────────────────────

describe('sse-events: ViewerWorker API contract', () => {
  it('real worker exposes the event bus and snapshot methods', async () => {
    const { ViewerWorker } = await import('@agentdevjs/viewer');
    // 构造函数不绑定端口/UDS（start 才 bind），不与运行中的服务冲突；
    // 路径写法与 dist 集成测试同源契约：Windows 走命名管道
    const udsPath = process.platform === 'win32'
      ? `\\\\.\\pipe\\agentdev-sse-contract-${process.pid}`
      : join(tmpdir(), `sse-contract-${process.pid}.sock`);
    const worker = new ViewerWorker(0, false, udsPath);
    assert.equal(typeof worker.onSessionEvent, 'function');
    assert.equal(typeof worker.listAgentStates, 'function');
    for (const m of [
      'getNotificationSnapshot', 'getOverviewSnapshot', 'getTodoSnapshot',
      'getInputRequestsSnapshot', 'getQueuedInputsSnapshot', 'isAgentConnected',
    ]) {
      assert.equal(typeof worker[m], 'function', `${m} missing — framework too old for SSE`);
    }
  });
});
