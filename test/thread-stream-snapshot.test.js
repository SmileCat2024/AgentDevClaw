/**
 * 线程单流投影读取器 — GET /protoclaw/threads/:threadId/stream（ADR-0024 PR-3）
 *
 * fixture 为 5 棒链真实结构落盘（helpers/thread-stream-fixture.js，spike
 * 样本形态：每缝 seed 59 条 + handoff-seed 注入事实回写）。覆盖：
 *   1. 完整链：棒次 / 接缝事实 / 三方交叉校验数字对齐 / predecessor 可见
 *      消息从渲染边界起 / head 棒坐标（probe count 制边界索引）；
 *   2. incomplete 路径：seed_boundary_missing / seed_facts_missing /
 *      seed_count_mismatch / handoff_unlinked / handoff_unreadable /
 *      package_id_mismatch；
 *   3. 读取期间 head 变化 → 409 thread_stream_conflict；
 *   4. 路由层：404 / unchanged 短路 / 冲突映射。
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';

import { setupThreadRoutes } from '../server/thread-control/thread-routes.js';
import { buildThreadStreamFixture } from './helpers/thread-stream-fixture.js';

let base = null;
let counter = 0;

before(async () => {
  base = mkdtempSync(path.join(os.tmpdir(), 'claw-thread-stream-'));
});
after(async () => {
  if (base) await fsp.rm(base, { recursive: true, force: true });
});

async function makeFixture(options = {}) {
  return buildThreadStreamFixture(path.join(base, `fx-${++counter}`), options);
}

function makeMockApp() {
  const routes = {};
  const app = {
    get: (p, ...h) => { routes[`GET ${p}`] = h; },
    post: (p, ...h) => { routes[`POST ${p}`] = h; },
    put: (p, ...h) => { routes[`PUT ${p}`] = h; },
    delete: (p, ...h) => { routes[`DELETE ${p}`] = h; },
  };
  app._routes = routes;
  return app;
}

function makeMockExpress() {
  return { json: () => (_req, _res, next) => next?.() };
}

function makeMockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; },
  };
}

function setupRoutes({ fixture, publishThreadEvent } = {}) {
  const app = makeMockApp();
  setupThreadRoutes(app, makeMockExpress(), {
    control: { ...fixture.control, archive: { resolveCommandRejection: async () => null, list: async () => ({}) } },
    lifecycle: { archiveThread: async () => ({}), unarchiveThread: async () => ({}) },
    streamReader: fixture.reader,
    ...(publishThreadEvent ? { publishThreadEvent } : {}),
  });
  return app;
}

async function callStream(app, threadId, query = {}) {
  const handlers = app._routes['GET /protoclaw/threads/:threadId/stream'];
  assert.ok(Array.isArray(handlers), 'stream route must be registered');
  const res = makeMockRes();
  await handlers[handlers.length - 1]({ params: { threadId }, query }, res);
  return res;
}

// ── 1. 完整链 ──────────────────────────────────────────────────────

describe('thread stream: full five-stick chain (spike-shaped fixture)', () => {
  test('returns ordered sticks with aligned seam facts and correct visibility anchors', async () => {
    const fixture = await makeFixture();
    const result = await fixture.reader.readThreadStream(fixture.threadId);

    assert.equal(result.ok, undefined); // reader 原始返回不带 ok（路由层附加）
    assert.equal(result.threadId, fixture.threadId);
    assert.equal(result.agentId, fixture.agentId);
    assert.equal(result.headSessionId, 's4');
    assert.equal(result.segments.length, 5);

    // 棒次 = sessionChain 数组序；root 棒无注入事实
    const [s0, s1, s2, s3, s4] = result.segments;
    assert.deepEqual(result.segments.map((s) => s.sessionId), ['s0', 's1', 's2', 's3', 's4']);
    assert.equal(s0.index, 0);
    assert.equal(s0.seedInjection, undefined);
    assert.equal(s0.visibleStartIndex, 0);
    assert.equal(s0.role, 'predecessor');
    assert.equal(s0.endKind, 'context_rotation');
    assert.equal(s0.successorSessionId, 's1');
    assert.equal(s0.handoffId, fixture.handoffIds[0]);

    // 接缝完整：声明数 = 注入事实 = 数组区间长度（三方 59）
    for (const seg of [s0, s1, s2, s3]) {
      assert.equal(seg.incomplete, false, `stick ${seg.index} must be complete`);
      assert.equal(seg.incompleteReason, null);
      assert.equal(seg.seedBoundary.seedMessageCount, 59);
      assert.equal(seg.seedBoundary.appendedInjection.length, 1);
      assert.equal(seg.seedBoundary.appendedInjection[0].kind, 'summary');
      assert.equal(seg.seedBoundary.appendedInjection[0].messageIndex, 58);
      // 消息基线锚 enriched sequence/id
      assert.ok(seg.messages.length > 0);
      assert.ok(seg.messages.every((m) => typeof m.id === 'string' && Number.isInteger(m.sequence)));
    }
    // 注入事实只在经接续诞生的棒上（root 除外，上方已断言 s0 无）
    for (const seg of [s1, s2, s3]) {
      assert.equal(seg.seedInjection.seedCount, 59);
      assert.equal(seg.seedInjection.firstMessageSeq, 0);
      assert.equal(seg.seedInjection.lastMessageSeq, 58);
      assert.equal(seg.seedInjection.packageId, fixture.handoffIds[seg.index - 1]);
    }

    // predecessor 棒的可见消息从渲染边界起（seed 段不重复呈现）：
    // 棒 0 全量 130；棒 1..3 = 59 seed 之后的自有消息
    assert.equal(s0.messages.length, 130);
    assert.equal(s0.messages[0].sequence, 0);
    assert.equal(s1.messages.length, 40);
    assert.equal(s1.messages[0].sequence, 59, 'visible messages must start past the seed segment');
    assert.equal(s1.messages[0].content, 'own[s1][0]');
    assert.equal(s2.messages.length, 30);
    assert.equal(s3.messages.length, 20);

    // 每棒 seed 段坐标（count 制，双坐标边界）
    assert.equal(s1.seedSegment.startIndex, 0);
    assert.equal(s1.seedSegment.endIndex, 58);
    assert.equal(s1.visibleStartIndex, 59);
    assert.equal(s1.baseline.count, 99);
    assert.equal(s1.baseline.firstSequence, 0);
    assert.equal(s1.baseline.lastSequence, 98);

    // head 棒：无消息内容（走 probe/tail 通道），带 probe 坐标系边界索引
    assert.equal(s4.role, 'head');
    assert.equal(s4.messages, undefined);
    assert.equal(s4.seedSegment.startIndex, 0);
    assert.equal(s4.seedSegment.endIndex, 58);
    assert.equal(s4.visibleStartIndex, 59);
    assert.equal(s4.baseline.count, 59 + 15);
    assert.equal(s4.incomplete, false);

    // contentHash 稳定（同链重复读取签名一致）
    const again = await fixture.reader.readThreadStream(fixture.threadId);
    assert.equal(again.contentHash, result.contentHash);
    // 快照版本随链 revision
    assert.equal(typeof result.revision, 'number');
  });
});

// ── 2. incomplete 路径 ─────────────────────────────────────────────

describe('thread stream: incomplete seam reporting', () => {
  test('seed_boundary_missing when handoff predates the marker protocol', async () => {
    const fixture = await makeFixture({ dropSeedBoundarySeam: 1 });
    const result = await fixture.reader.readThreadStream(fixture.threadId);
    const seg = result.segments[1];
    assert.equal(seg.incomplete, true);
    assert.equal(seg.incompleteReason, 'seed_boundary_missing');
    assert.equal(seg.seedBoundary, undefined);
    // 其余接缝不受影响
    assert.equal(result.segments[0].incomplete, false);
    assert.equal(result.segments[2].incomplete, false);
    assert.equal(result.hasIncomplete ?? undefined, undefined); // reader 不派生，路由透传 segments
    assert.equal(result.segments.some((s) => s.incomplete), true);
  });

  test('seed_facts_missing when successor snapshot lacks handoff-seed injection facts', async () => {
    const fixture = await makeFixture({ dropFactsStick: 2 });
    const result = await fixture.reader.readThreadStream(fixture.threadId);
    // 接缝校验失败挂在声明侧棒（棒 1 产 handoff，棒 2 缺注入事实）
    assert.equal(result.segments[1].incomplete, true);
    assert.equal(result.segments[1].incompleteReason, 'seed_facts_missing');
    // 棒 2 自身仍有基线，但渲染边界保守归零（不伪装可切分）
    assert.equal(result.segments[2].seedInjection, undefined);
    assert.equal(result.segments[2].visibleStartIndex, 0);
  });

  test('seed_count_mismatch when declared count disagrees with injection facts', async () => {
    const fixture = await makeFixture({ breakSeedCountSeam: 2 });
    const result = await fixture.reader.readThreadStream(fixture.threadId);
    assert.equal(result.segments[2].incomplete, true);
    assert.equal(result.segments[2].incompleteReason, 'seed_count_mismatch');
  });

  test('handoff_unlinked when successor metadata carries no handoff reference', async () => {
    const fixture = await makeFixture({ unlinkHandoffSeam: 0 });
    const result = await fixture.reader.readThreadStream(fixture.threadId);
    assert.equal(result.segments[0].incomplete, true);
    assert.equal(result.segments[0].incompleteReason, 'handoff_unlinked');
    assert.equal(result.segments[0].handoffId, undefined);
  });

  test('handoff_unreadable when the handoff package file is gone', async () => {
    const fixture = await makeFixture({ removeHandoffFileSeam: 3 });
    const result = await fixture.reader.readThreadStream(fixture.threadId);
    assert.equal(result.segments[3].incomplete, true);
    assert.equal(result.segments[3].incompleteReason, 'handoff_unreadable');
  });

  test('package_id_mismatch when injection facts reference a different package', async () => {
    const fixture = await makeFixture({ mismatchPackageIdSeam: 1 });
    const result = await fixture.reader.readThreadStream(fixture.threadId);
    assert.equal(result.segments[1].incomplete, true);
    assert.equal(result.segments[1].incompleteReason, 'package_id_mismatch');
  });
});

// ── 3. 读取期间 head 变化 ──────────────────────────────────────────

describe('thread stream: snapshot consistency under head change', () => {
  test('throws an explicit conflict when the head advances mid-read', async () => {
    const fixture = await makeFixture();
    const record = await fixture.control.core.getThread(fixture.threadId);
    let calls = 0;
    const mutableCore = {
      getThread: async () => {
        calls += 1;
        if (calls <= 1) return { ...record, sessionChain: record.sessionChain };
        // 复核时链已推进（advanceHead 落定 + 新棒加入）
        return {
          ...record,
          headSessionId: 's5',
          revision: record.revision + 1,
          sessionChain: [...record.sessionChain, {
            sessionId: 's5', role: 'head', startedAt: 2, endedAt: null,
            endKind: null, successorSessionId: null,
          }],
        };
      },
    };
    const { createThreadStreamReader } = await import('../server/thread-control/thread-stream.js');
    const reader = createThreadStreamReader({
      core: mutableCore,
      readSessionIndex: async () => ({ revision: 1, sessions: [] }),
      readSessionFile: async () => null,
    });
    await assert.rejects(
      () => reader.readThreadStream(fixture.threadId),
      (err) => err.code === 'thread_stream_conflict' && err.status === 409 && err.currentHeadSessionId === 's5',
    );
  });
});

// ── 4. 路由层 ──────────────────────────────────────────────────────

describe('GET /protoclaw/threads/:threadId/stream route', () => {
  test('returns ok payload and short-circuits on matching sinceContentHash', async () => {
    const fixture = await makeFixture();
    const app = setupRoutes({ fixture });

    const first = await callStream(app, fixture.threadId);
    assert.equal(first.statusCode, 200);
    assert.equal(first.body.ok, true);
    assert.equal(first.body.segments.length, 5);

    const again = await callStream(app, fixture.threadId, { sinceContentHash: first.body.contentHash });
    assert.equal(again.statusCode, 200);
    assert.equal(again.body.unchanged, true);
    assert.equal(again.body.contentHash, first.body.contentHash);
    assert.equal(again.body.segments, undefined);
  });

  test('maps unknown thread to 404', async () => {
    const fixture = await makeFixture();
    const app = setupRoutes({ fixture });
    const res = await callStream(app, 'wt-does-not-exist');
    assert.equal(res.statusCode, 404);
    assert.equal(res.body.code, 'workthread_not_found');
  });

  test('maps stream conflict to 409 with current head fact', async () => {
    const fixture = await makeFixture();
    const record = await fixture.control.core.getThread(fixture.threadId);
    let calls = 0;
    const conflicting = {
      ...fixture,
      reader: (await import('../server/thread-control/thread-stream.js')).createThreadStreamReader({
        core: {
          getThread: async () => {
            calls += 1;
            if (calls <= 1) return record;
            return { ...record, headSessionId: 's9', sessionChain: [...record.sessionChain, {}] };
          },
        },
        readSessionIndex: async () => ({ revision: 1, sessions: [] }),
        readSessionFile: async () => null,
      }),
    };
    const app = setupRoutes({ fixture: conflicting });
    const res = await callStream(app, fixture.threadId);
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, 'thread_stream_conflict');
    assert.equal(res.body.currentHeadSessionId, 's9');
  });
});
