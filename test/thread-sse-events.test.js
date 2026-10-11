/**
 * Tests for ADR-0024 PR-2 — thread 事件源（SSE）
 *
 * 覆盖：
 * 1. 发布→订阅：?threads=id1,id2 服务端过滤路由（订阅者收对应事件、
 *    未订阅 threadId / 未带参数的连接不收）；
 * 2. thread 事件直发不经合并窗口（100ms 验收的结构性证明：coalesceMs
 *    调大后 thread 帧仍即时到达）；
 * 3. 无订阅者 / 无模块实例时发布 no-op 不报错；
 * 4. Last-Event-ID 重放按连接订阅集过滤 thread 帧；
 * 5. 四个事务发布点（真实 createThreadControl 落盘 + 注入发布 spy）：
 *    onSessionCreated / applySessionSuccession（advanceHead + 补投递后）/
 *    archiveThread / deleteThread（complete 才发，partial 重试收敛后补发，
 *    幂等早退不发）；
 * 6. 端到端：真实模块级发布入口 → 订阅连接收到 thread.head-advanced。
 *
 * node:test + node:assert/strict（项目约定）；等待用 3ms 轮询谓词，
 * 无真实 sleep > 500ms；after 钩子清理连接、定时器与临时目录。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

import { WorkThreadRuntimeBridge } from '@agentdevjs/core';
import { createSseEventsModule, publishThreadEvent } from '../server/routes/sse-events.js';
import { createThreadControl } from '../server/thread-control/thread-controller.js';
import { createThreadIntegration } from '../server/thread-control/thread-integration.js';
import { createThreadLifecycleService } from '../server/thread-control/thread-lifecycle.js';
import { createThreadDeleteService } from '../server/thread-control/thread-delete.js';

const AGENT = 'coder';

// ── SSE harness（与 test/sse-events.test.js 同源模式）────────────────

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

function makeSseHarness(t, { coalesceMs = 5 } = {}) {
  const app = express();
  const fake = makeFakeWorker();
  const mod = createSseEventsModule({
    viewerWorker: fake.worker,
    coalesceMs, heartbeatMs: 25, ringSize: 64, maxClients: 16,
  });
  mod.setupRoutes(app);
  const server = http.createServer(app);
  const streams = [];
  const start = () => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = (p = '/protoclaw/events') => `http://127.0.0.1:${server.address().port}${p}`;
  const openStream = async (p = '/protoclaw/events', opts = {}) => {
    const s = await openRawStream(url(p), opts);
    streams.push(s);
    return s;
  };
  t.after(() => {
    for (const s of streams) s.abort();
    mod.closeAll();
    server.close();
    server.closeAllConnections?.();
  });
  return { app, mod, fake, server, start, url, openStream };
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
  const state = { text: '', status: res.status, done: false };
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
  const readUntil = async (predicate, timeoutMs = 500) => {
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
const threadFrames = (text) => events(text).filter((f) => f.event?.startsWith('thread.'));

// ── 线程事务环境（真实 control 落盘 + 注入发布 spy）──────────────────

let base = null;
let counter = 0;

function makeControl() {
  const control = createThreadControl({
    rootDir: path.join(base, `tsse-${++counter}`),
    bridge: new WorkThreadRuntimeBridge(),
  });
  return { control };
}

function makePublishSpy() {
  const calls = [];
  return {
    calls,
    publishThreadEvent: (threadId, payload) => { calls.push({ threadId, payload }); },
  };
}

before(async () => { base = mkdtempSync(path.join(os.tmpdir(), 'claw-thread-sse-')); });
after(async () => { if (base) await fs.rm(base, { recursive: true, force: true }); });

// ── 1. 订阅路由 ────────────────────────────────────────────────────

describe('thread SSE: subscription routing', () => {
  it('delivers thread events only to connections subscribed via ?threads', async (t) => {
    const h = makeSseHarness(t);
    await h.start();

    const subbed = await h.openStream('/protoclaw/events?threads=t1,t9');
    const other = await h.openStream('/protoclaw/events?threads=t2');
    const plain = await h.openStream('/protoclaw/events');
    assert.ok(await subbed.readUntil(hasHello));
    assert.ok(await other.readUntil(hasHello));
    assert.ok(await plain.readUntil(hasHello));

    publishThreadEvent('t1', { kind: 'thread.created', agentId: AGENT, status: 'open' });
    publishThreadEvent('t2', { kind: 'thread.created', agentId: AGENT, status: 'open' });

    assert.ok(await subbed.readUntil((tx) => tx.includes('event: thread.created')),
      `subscribed connection missing thread.created:\n${subbed.state.text}`);
    const subbedFrames = threadFrames(subbed.state.text);
    assert.equal(subbedFrames.length, 1);
    assert.equal(subbedFrames[0].data.threadId, 't1');
    assert.equal(subbedFrames[0].data.kind, 'thread.created');
    assert.equal(subbedFrames[0].data.agentId, AGENT);

    assert.ok(await other.readUntil((tx) => tx.includes('event: thread.created')));
    const otherFrames = threadFrames(other.state.text);
    assert.equal(otherFrames.length, 1);
    assert.equal(otherFrames[0].data.threadId, 't2');

    // 未带 ?threads 的连接不收任何 thread 事件（opt-in）
    assert.equal(await plain.readUntil((tx) => tx.includes('event: thread.'), 60), false);
  });

  it('thread events bypass the coalescing window (100ms budget by construction)', async (t) => {
    const h = makeSseHarness(t, { coalesceMs: 5000 });
    await h.start();
    const s = await h.openStream('/protoclaw/events?threads=tc');
    assert.ok(await s.readUntil(hasHello));

    // 合并窗口内的普通事件（notification）被扣住不 flush……
    h.fake.emit({ kind: 'notification', agentId: 'a1' });
    // ……而 thread 事件直发即时到达
    publishThreadEvent('tc', { kind: 'thread.head-advanced', fromSessionId: 's1', toSessionId: 's2' });

    assert.ok(await s.readUntil((tx) => tx.includes('event: thread.head-advanced'), 300),
      `thread.head-advanced not delivered within 300ms despite coalesceMs=5000:\n${s.state.text}`);
    assert.equal(s.state.text.includes('event: notification'), false);
    const frame = threadFrames(s.state.text).at(-1);
    assert.equal(frame.data.fromSessionId, 's1');
    assert.equal(frame.data.toSessionId, 's2');
  });

  it('publishing with no subscribers or no module instance is a safe no-op', async (t) => {
    const h = makeSseHarness(t);
    await h.start();
    // 无订阅者：发布不报错
    assert.doesNotThrow(() => publishThreadEvent('t-x', { kind: 'thread.created' }));
    // 非法入参：no-op 不报错
    assert.doesNotThrow(() => publishThreadEvent('', { kind: 'thread.created' }));
    assert.doesNotThrow(() => publishThreadEvent('t-x', {}));
    // 实例收口反注册后：模块级入口 no-op
    h.mod.closeAll();
    assert.doesNotThrow(() => publishThreadEvent('t-x', { kind: 'thread.created' }));
  });

  it('Last-Event-ID replay filters thread frames by connection subscription', async (t) => {
    const h = makeSseHarness(t);
    await h.start();

    const first = await h.openStream('/protoclaw/events');
    assert.ok(await first.readUntil(hasHello)); // hello id = 0

    publishThreadEvent('r1', { kind: 'thread.created' }); // eid 1
    publishThreadEvent('r2', { kind: 'thread.created' }); // eid 2

    const back = await h.openStream('/protoclaw/events?threads=r2', { lastEventId: 0 });
    assert.ok(await back.readUntil((tx) => tx.includes('event: thread.created')));
    const replayed = threadFrames(back.state.text);
    assert.equal(replayed.length, 1);
    assert.equal(replayed[0].id, 2);
    assert.equal(replayed[0].data.threadId, 'r2');
    const hello = events(back.state.text).find((f) => f.event === 'hello');
    assert.equal(hello.data.resumed, true);
  });
});

// ── 2. 事务发布点 ──────────────────────────────────────────────────

describe('thread SSE: transaction publish points', () => {
  it('onSessionCreated publishes thread.created after start; non-host app sessions publish nothing', async () => {
    const { control } = makeControl();
    const spy = makePublishSpy();
    const integration = createThreadIntegration({ control, publishThreadEvent: spy.publishThreadEvent });

    const thread = await integration.onSessionCreated(AGENT, { id: 'c-s1', title: 'T' });
    assert.ok(thread);
    assert.equal(spy.calls.length, 1);
    assert.equal(spy.calls[0].threadId, thread.threadId);
    assert.deepEqual(spy.calls[0].payload, {
      kind: 'thread.created',
      agentId: AGENT,
      rootSessionId: 'c-s1',
      headSessionId: 'c-s1',
      status: 'open',
    });

    // 非线程宿主 APP 会话：不建线程、不发布
    const none = await integration.onSessionCreated('programming-helper', { id: 'c-main' });
    assert.equal(none, null);
    assert.equal(spy.calls.length, 1);

    // 重启恢复语义的对照：既有线程不经过 onSessionCreated（恢复不是创建），
    // 此处固定钩子语义——只有新建会话才可能发布 created。
  });

  it('applySessionSuccession publishes head-advanced after advanceHead and pending delivery', async () => {
    const { control } = makeControl();
    const order = [];
    const proxyCore = new Proxy(control.core, {
      get(target, prop, receiver) {
        if (prop === 'advanceHead') {
          return async (...args) => {
            const result = await target.advanceHead(...args);
            order.push('advanced');
            return result;
          };
        }
        if (prop === 'deliverPendingCommands') {
          return async (...args) => {
            const result = await target.deliverPendingCommands(...args);
            order.push('delivered');
            return result;
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const spy = makePublishSpy();
    const integration = createThreadIntegration({
      control: { ...control, core: proxyCore },
      publishThreadEvent: (threadId, payload) => {
        order.push(`publish:${payload?.kind}`);
        spy.publishThreadEvent(threadId, payload);
      },
    });

    const thread = await integration.onSessionCreated(AGENT, { id: 'a-s1' });

    const outcome = await integration.applySessionSuccession({
      agentId: AGENT, fromSessionId: 'a-s1', toSessionId: 'a-s2', reason: 'trim',
    });
    assert.equal(outcome.applied, true);
    // 发布在 advanceHead 与补投递都落定之后（created 在建线程时先行）
    assert.deepEqual(order, [
      'publish:thread.created', 'advanced', 'delivered', 'publish:thread.head-advanced',
    ]);
    assert.equal(spy.calls.length, 2); // created + head-advanced
    assert.equal(spy.calls[1].threadId, thread.threadId);
    assert.deepEqual(spy.calls[1].payload, {
      kind: 'thread.head-advanced',
      agentId: AGENT,
      fromSessionId: 'a-s1',
      toSessionId: 'a-s2',
      reason: 'trim',
    });

    // void 接力（from 已不是 head）：幂等作废，不发布
    const stale = await integration.applySessionSuccession({
      agentId: AGENT, fromSessionId: 'a-s1', toSessionId: 'a-s3', reason: 'trim',
    });
    assert.equal(stale.applied, false);
    assert.equal(stale.reason, 'no_thread_for_session');
    assert.equal(spy.calls.length, 2);
  });

  it('archiveThread publishes thread.archived with authoritative cleanup status', async () => {
    const { control } = makeControl();
    const spy = makePublishSpy();
    const stopped = [];
    const service = createThreadLifecycleService({
      control,
      stopSession: async (agentId, sessionId) => { stopped.push({ agentId, sessionId }); return { status: 'stopped' }; },
      publishThreadEvent: spy.publishThreadEvent,
    });

    const thread = await control.core.start({ sessionRef: { agentId: AGENT, sessionId: 'ar-s1' } });
    const result = await service.archiveThread(thread.threadId, { reason: 'user_archive' });

    assert.equal(result.cleanup.status, 'complete');
    assert.equal(spy.calls.length, 1);
    assert.equal(spy.calls[0].threadId, thread.threadId);
    assert.equal(spy.calls[0].payload.kind, 'thread.archived');
    assert.equal(spy.calls[0].payload.agentId, AGENT);
    assert.equal(spy.calls[0].payload.headSessionId, 'ar-s1');
    assert.equal(spy.calls[0].payload.cleanupStatus, 'complete');
    assert.ok(spy.calls[0].payload.archivedAt);

    // partial（stop 失败）同样是权威落定状态：发布 cleanupStatus=partial
    const partialSpy = makePublishSpy();
    const control2 = makeControl();
    const thread2 = await control2.control.core.start({ sessionRef: { agentId: AGENT, sessionId: 'ap-s1' } });
    const service2 = createThreadLifecycleService({
      control: control2.control,
      stopSession: async () => { throw new Error('stop timeout'); },
      publishThreadEvent: partialSpy.publishThreadEvent,
    });
    const partial = await service2.archiveThread(thread2.threadId, { reason: 'user_archive' });
    assert.equal(partial.cleanup.status, 'partial');
    assert.equal(partialSpy.calls.length, 1);
    assert.equal(partialSpy.calls[0].payload.cleanupStatus, 'partial');
  });

  it('deleteThread publishes thread.deleted only when fully deleted; retry converges then publishes', async () => {
    const { control } = makeControl();
    const spy = makePublishSpy();
    let failRemove = true; // 首次删除 partial，重试收敛
    const makeService = () => createThreadDeleteService({
      control,
      removeSessions: async () => {
        if (failRemove) { failRemove = false; throw new Error('session store unavailable'); }
        return { removed: true };
      },
      publishThreadEvent: spy.publishThreadEvent,
    });

    const thread = await control.core.start({ sessionRef: { agentId: AGENT, sessionId: 'd-s1' } });
    const threadId = thread.threadId;

    const partial = await makeService().deleteThread(threadId);
    assert.equal(partial.status, 'partial');
    assert.equal(partial.deleted, false);
    assert.equal(spy.calls.length, 0); // 未到达删除事实：不发布

    const complete = await makeService().deleteThread(threadId);
    assert.equal(complete.status, 'complete');
    assert.equal(complete.deleted, true);
    assert.equal(spy.calls.length, 1);
    assert.deepEqual(spy.calls[0], {
      threadId,
      payload: { kind: 'thread.deleted', agentId: AGENT, status: 'complete' },
    });

    // 幂等早退（record 已不存在）：无事务运行，不重复发布
    const idempotent = await makeService().deleteThread(threadId);
    assert.equal(idempotent.idempotent, true);
    assert.equal(spy.calls.length, 1);
  });
});

// ── 3. 端到端（真实模块级发布入口 → 订阅连接）───────────────────────

describe('thread SSE: end-to-end wiring', () => {
  it('succession completion reaches ?threads subscriber through module-level publishThreadEvent', async (t) => {
    const h = makeSseHarness(t, { coalesceMs: 5000 });
    await h.start();

    const { control } = makeControl();
    const integration = createThreadIntegration({ control }); // 缺省发布器 = 模块级入口
    const thread = await integration.onSessionCreated(AGENT, { id: 'e-s1' });

    const s = await h.openStream(`/protoclaw/events?threads=${encodeURIComponent(thread.threadId)}`);
    assert.ok(await s.readUntil(hasHello));

    const outcome = await integration.applySessionSuccession({
      agentId: AGENT, fromSessionId: 'e-s1', toSessionId: 'e-s2', reason: 'trim',
    });
    assert.equal(outcome.applied, true);

    assert.ok(await s.readUntil((tx) => tx.includes('event: thread.head-advanced'), 300),
      `thread.head-advanced not delivered:\n${s.state.text}`);
    const frame = threadFrames(s.state.text).at(-1);
    assert.equal(frame.data.threadId, thread.threadId);
    assert.equal(frame.data.kind, 'thread.head-advanced');
    assert.equal(frame.data.fromSessionId, 'e-s1');
    assert.equal(frame.data.toSessionId, 'e-s2');
    assert.equal(frame.data.agentId, AGENT);
  });
});
