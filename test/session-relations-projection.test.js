/**
 * session-relations 投影模块单测：引用行解析（四种历史/现役形态）、
 * 投影构建（边聚合 + 增量水位复用）、一跳邻居方向与关联群规模、
 * 身份反查与无线程/无邻居的降级。全部跑在隔离临时数据根上，不读真实
 * 用户数据目录。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  parseReferenceLine,
  extractReferenceObservations,
  buildRelationsSnapshot,
  getThreadRelations,
  resetRelationsMemo,
} from '../server/session-relations/projection.js';

// ── 测试数据根构造 ────────────────────────────────────────────────
// workspaces/programming-helper/sessions：JSON 索引形态（无 index.db 时
// 的回退路径，也是测试数据根的天然形态）。

const REF_HEADER = '[会话引用] 用户在本条消息中引用了以下会话（标题由 AI 自动生成，仅供参考）：';

function refReminder(lines) {
  return { role: 'system', source: 'session-reference', content: [REF_HEADER, ...lines, '建议先用 session_read_overview 阅读概览。'].join('\n') };
}

function snapshot(messages) {
  return { runtime: { context: { messages } } };
}

let dataRoot;

async function writeIndex(root, sessions) {
  const dir = path.join(root, 'workspaces', 'programming-helper', 'sessions');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'index.json'), JSON.stringify({ sessions }));
}

async function writeSnapshot(root, sessionId, messages) {
  const dir = path.join(root, 'workspaces', 'programming-helper', 'sessions');
  await fs.writeFile(path.join(dir, `${sessionId}.json`), JSON.stringify(snapshot(messages)));
}

async function writeThreads(root, threads) {
  const dir = path.join(root, 'threads');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'index.json'), JSON.stringify({ threads }));
}

async function buildFixture() {
  // 线程：src 是被查询对象；dst / dst2 被 src 引用；dst3 反向引用 src；
  // dst4 与 src 互相引用（both 方向）；iso 孤立。
  await writeThreads(dataRoot, [
    { threadId: 'wt-src', workspaceId: 'programming-helper', title: '源线程', sessionIds: ['s-src'] },
    { threadId: 'wt-dst', workspaceId: 'programming-helper', title: '下游', sessionIds: ['s-dst'] },
    { threadId: 'wt-dst2', workspaceId: 'programming-helper', title: '线程二', sessionIds: ['s-dst2'] },
    { threadId: 'wt-dst3', workspaceId: 'programming-helper', title: '上游', sessionIds: ['s-dst3'] },
    { threadId: 'wt-dst4', workspaceId: 'programming-helper', title: '互引', sessionIds: ['s-dst4'] },
    { threadId: 'wt-iso', workspaceId: 'programming-helper', title: '孤立', sessionIds: ['s-iso'] },
  ]);
  await writeIndex(dataRoot, [
    { id: 's-src', updatedAt: '2026-11-14T10:00:00.000Z' },
    { id: 's-dst', updatedAt: '2026-11-14T09:00:00.000Z' },
    { id: 's-dst2', updatedAt: '2026-11-14T09:10:00.000Z' },
    { id: 's-dst3', updatedAt: '2026-11-14T09:20:00.000Z' },
    { id: 's-dst4', updatedAt: '2026-11-14T09:30:00.000Z' },
    { id: 's-iso', updatedAt: '2026-11-14T08:00:00.000Z' },
  ]);
  await writeSnapshot(dataRoot, 's-src', [
    refReminder([
      '- s-dst「下游会话」 — agentId: programming-helper（身份: main）', // 会话引用（现役形态）
      '- wt-dst2「线程二」 — agentId: programming-helper（身份: main，线程对话 · 被引一代: s-dst2「t」）', // 线程引用（新形态）
      '- s-dst4「互引会话」 — agentId: programming-helper（身份: main）',
      '- s-ghost「已散失」 — agentId: programming-helper（身份: main）', // 目标无线程归属 → unresolved
    ]),
    // 账本 reminder：前缀不同，不命中内容门
    { role: 'system', source: 'session-reference', content: '[会话引用账本] 本对话累计引用过：\n- s-dst — agentId: programming-helper（身份: main，用户引用）' },
    // 其他来源的引用样式消息：不命中 source 门
    { role: 'system', source: 'time-awareness', content: `${REF_HEADER}\n- s-dst — agentId: programming-helper（身份: main）` },
  ]);
  await writeSnapshot(dataRoot, 's-dst3', [refReminder(['- s-src「源会话」 — agentId: programming-helper（身份: main）'])]);
  await writeSnapshot(dataRoot, 's-dst4', [refReminder(['- s-src「源会话」 — agentId: programming-helper（身份: main）'])]);
  await writeSnapshot(dataRoot, 's-dst', []);
  await writeSnapshot(dataRoot, 's-dst2', []);
  await writeSnapshot(dataRoot, 's-iso', []);
}

before(async () => {
  dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'claw-relations-test-'));
  await buildFixture();
});

after(async () => {
  resetRelationsMemo();
  await fs.rm(dataRoot, { recursive: true, force: true }).catch(() => {});
  // Windows 下后台刷新写缓存可能与首删竞态（ENOTEMPTY）：静置后重试一次。
  await new Promise(resolve => setTimeout(resolve, 100));
  await fs.rm(dataRoot, { recursive: true, force: true });
});

// ── parseReferenceLine（行解析） ─────────────────────────────────

describe('parseReferenceLine', () => {
  it('parses current session form and new thread form (agentId verbatim)', () => {
    assert.deepEqual(
      parseReferenceLine('- s-1「修复登录超时」 — agentId: programming-helper（身份: main）'),
      { kind: 'session', id: 's-1', agentId: 'programming-helper', titleHint: '修复登录超时' },
    );
    assert.deepEqual(
      parseReferenceLine('- wt-abc「线程二」 — agentId: programming-helper（身份: main，线程对话 · 被引一代: s-2「t」）'),
      { kind: 'thread', id: 'wt-abc', agentId: 'programming-helper', titleHint: '线程二' },
    );
  });

  it('parses legacy agent: prefix and legacy parenthesized forms', () => {
    assert.deepEqual(
      parseReferenceLine('- s-1「t」 — agent: agent-studio/main（身份: main）'),
      { kind: 'session', id: 's-1', agentId: 'agent-studio', titleHint: 't' },
    );
    assert.deepEqual(
      parseReferenceLine('- s-1「t」 (coder/main, 3条)'),
      { kind: 'session', id: 's-1', agentId: 'coder', titleHint: 't' },
    );
  });

  it('ignores guidance and unparsed lines', () => {
    assert.equal(parseReferenceLine('[会话引用] 用户在本条消息中引用了以下会话（标题…）：'), null);
    assert.equal(parseReferenceLine('建议先用 session_read_overview 阅读概览。'), null);
    assert.equal(parseReferenceLine('随便一行普通文本'), null);
  });
});

// ── extractReferenceObservations（内容门） ────────────────────────

describe('extractReferenceObservations', () => {
  it('gates by source and [会话引用] prefix; ledger and other sources never count', () => {
    const messages = [
      refReminder(['- s-1「a」 — agentId: ph（身份: main）']),
      { role: 'system', source: 'session-reference', content: '[会话引用账本] …\n- s-2 — agentId: ph（身份: main）' },
      { role: 'system', source: 'time-awareness', content: `${REF_HEADER}\n- s-3 — agentId: ph（身份: main）` },
      { role: 'user', content: '- s-4 — agentId: ph（身份: main）' },
    ];
    const refs = extractReferenceObservations(messages);
    assert.equal(refs.length, 1);
    assert.equal(refs[0].id, 's-1');
  });
});

// ── buildRelationsSnapshot（投影构建） ────────────────────────────

describe('buildRelationsSnapshot', () => {
  it('aggregates thread edges from explicit references only and writes the cache', async () => {
    const snap = await buildRelationsSnapshot({ dataRoot });
    // s-src: dst / dst2 / dst4 / ghost(不成边)；dst3→src；dst4→src。
    // 边顺序不是契约（Map 迭代序），逐边断言 count。
    const edgeCounts = new Map(snap.edges.map(e => [`${e.source}>${e.target}`, e.count]));
    assert.equal(snap.edges.length, 5);
    assert.deepEqual([...edgeCounts.entries()].sort(), [
      ['wt-dst3>wt-src', 1],
      ['wt-dst4>wt-src', 1],
      ['wt-src>wt-dst', 1],
      ['wt-src>wt-dst2', 1],
      ['wt-src>wt-dst4', 1],
    ]);
    assert.equal(snap.unresolvedTargets, 1);
    assert.ok(snap.builtAt);
    assert.equal(snap.threadTitles['wt-src'], '源线程');
    // 缓存落盘（原子写后的最终名）
    const cached = JSON.parse(await fs.readFile(path.join(dataRoot, 'session-relations', 'cache.json'), 'utf8'));
    assert.equal(cached.schemaVersion, 1);
    assert.equal(cached.edges.length, 5);
  });

  it('reuses cached observations by updatedAt watermark and rescans changed sessions', async () => {
    // 场景 A：快照内容变了但索引 updatedAt 未变 → 水位复用，观察不更新。
    await writeSnapshot(dataRoot, 's-src', [
      refReminder([
        '- s-dst「下游会话」 — agentId: programming-helper（身份: main）',
        '- wt-dst2「线程二」 — agentId: programming-helper（身份: main，线程对话 · 被引一代: s-dst2「t」）',
        '- s-dst4「互引会话」 — agentId: programming-helper（身份: main）',
        '- s-ghost「已散失」 — agentId: programming-helper（身份: main）',
        '- s-dst「再次引用」 — agentId: programming-helper（身份: main）', // 新增行，水位未变不应生效
      ]),
    ]);
    const unchanged = await buildRelationsSnapshot({ dataRoot });
    assert.equal(unchanged.edges.find(e => e.source === 'wt-src' && e.target === 'wt-dst').count, 1);

    // 场景 B：索引 updatedAt 推进 → 重扫生效，重复引用计入 count。
    await writeIndex(dataRoot, [
      { id: 's-src', updatedAt: '2026-11-14T11:00:00.000Z' },
      { id: 's-dst', updatedAt: '2026-11-14T09:00:00.000Z' },
      { id: 's-dst2', updatedAt: '2026-11-14T09:10:00.000Z' },
      { id: 's-dst3', updatedAt: '2026-11-14T09:20:00.000Z' },
      { id: 's-dst4', updatedAt: '2026-11-14T09:30:00.000Z' },
      { id: 's-iso', updatedAt: '2026-11-14T08:00:00.000Z' },
    ]);
    const refreshed = await buildRelationsSnapshot({ dataRoot });
    assert.equal(refreshed.edges.find(e => e.source === 'wt-src' && e.target === 'wt-dst').count, 2);
  });
});

// ── getThreadRelations（邻居方向 / 分量 / 身份反查 / 降级） ────────

describe('getThreadRelations', () => {
  it('returns one-hop neighbors with directions and component size', async () => {
    resetRelationsMemo();
    const result = await getThreadRelations({ threadId: 'wt-src', dataRoot });
    assert.equal(result.resolvedThreadId, 'wt-src');
    assert.equal(result.resolvedThreadTitle, '源线程');
    assert.equal(result.generations, 1);
    assert.equal(result.partial, false);
    assert.deepEqual(result.component, {
      size: 5,
      memberThreadIds: ['wt-dst', 'wt-dst2', 'wt-dst3', 'wt-dst4', 'wt-src'],
    });
    // 方向：dst4 双向（count 2 排最前）；dst / dst2 由 src 引出；dst3 反向。
    // 增量测试已把 s-src 写成重复引用 s-dst（@11:00）：wt-dst 的观察权重 2
    // 传导到邻居 count（契约：count 含跨代重复观察）。并列 count 按线程号排序。
    assert.deepEqual(
      result.neighbors.map(n => ({ id: n.threadId, direction: n.direction, count: n.count })),
      [
        { id: 'wt-dst', direction: 'references', count: 2 },
        { id: 'wt-dst4', direction: 'both', count: 2 },
        { id: 'wt-dst2', direction: 'references', count: 1 },
        { id: 'wt-dst3', direction: 'referenced-by', count: 1 },
      ],
    );
    assert.equal(result.neighbors.find(n => n.threadId === 'wt-dst').title, '下游');
  });

  it('resolves thread identity from agentId+sessionId (injection lookup path)', async () => {
    resetRelationsMemo();
    const result = await getThreadRelations({ agentId: 'programming-helper', sessionId: 's-src', dataRoot });
    assert.equal(result.resolvedThreadId, 'wt-src');
    assert.equal(result.neighbors.length, 4);
  });

  it('returns empty-but-valid shapes for isolated threads and unknown sessions', async () => {
    resetRelationsMemo();
    const isolated = await getThreadRelations({ threadId: 'wt-iso', dataRoot });
    assert.equal(isolated.resolvedThreadId, 'wt-iso');
    assert.equal(isolated.found, false); // 无任何边
    assert.deepEqual(isolated.neighbors, []);
    assert.equal(isolated.component.size, 1); // 孤立线程群大小为 1

    const unknown = await getThreadRelations({ agentId: 'programming-helper', sessionId: 's-nope', dataRoot });
    assert.equal(unknown.resolvedThreadId, '');
    assert.equal(unknown.found, false);
    assert.equal(unknown.component.size, 0);
    assert.equal(unknown.partial, true); // 无身份可查关联，投影未消费
  });

  it('returns identity with absent relations when stores are unreadable', async () => {
    resetRelationsMemo();
    // 索引 JSON 损坏 → 该存储被跳过，投影构建"成功但无边"：身份仍来自
    // threads/index.json（可读），邻居缺席而非报错——注入侧只降级关联节。
    const brokenRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'claw-relations-broken-'));
    try {
      await writeThreads(brokenRoot, [
        { threadId: 'wt-x', workspaceId: 'programming-helper', title: 'X', sessionIds: ['s-x'] },
      ]);
      await fs.mkdir(path.join(brokenRoot, 'workspaces', 'programming-helper', 'sessions'), { recursive: true });
      await fs.writeFile(
        path.join(brokenRoot, 'workspaces', 'programming-helper', 'sessions', 'index.json'),
        '{not json',
      );
      const result = await getThreadRelations({ threadId: 'wt-x', dataRoot: brokenRoot });
      assert.equal(result.resolvedThreadId, 'wt-x');
      assert.equal(result.resolvedThreadTitle, 'X');
      assert.equal(result.found, false);
      assert.equal(result.neighbors.length, 0);
      assert.equal(result.component.size, 1); // 无边投影：孤立线程群
    } finally {
      resetRelationsMemo();
      await fs.rm(brokenRoot, { recursive: true, force: true });
    }
  });
});

describe('getThreadRelations stale-while-revalidate', () => {
  // 新鲜度窗口从构建时刻起算：窗口内数据变化不重验证（成本控制，真实数据
  // 上每次刷新要枚举全部存储目录）。freshnessMs: 0 模拟窗口过期后的查询。
  it('serves the stale snapshot immediately; revalidation lands as new values', async () => {
    // 建立确定性基线：s-src 单次引用 s-dst，水位 T1。
    resetRelationsMemo();
    await writeSnapshot(dataRoot, 's-src', [
      refReminder(['- s-dst「下游会话」 — agentId: programming-helper（身份: main）']),
    ]);
    await writeIndex(dataRoot, [
      { id: 's-src', updatedAt: '2026-11-14T12:00:00.000Z' },
      { id: 's-dst', updatedAt: '2026-11-14T09:00:00.000Z' },
      { id: 's-dst2', updatedAt: '2026-11-14T09:10:00.000Z' },
      { id: 's-dst3', updatedAt: '2026-11-14T09:20:00.000Z' },
      { id: 's-dst4', updatedAt: '2026-11-14T09:30:00.000Z' },
      { id: 's-iso', updatedAt: '2026-11-14T08:00:00.000Z' },
    ]);
    const first = await getThreadRelations({ threadId: 'wt-src', dataRoot, freshnessMs: 0 });
    assert.equal(first.partial, false);
    assert.equal(first.neighbors.find(n => n.threadId === 'wt-dst').count, 1);

    // 数据变化：重复引用 + 水位推进 T2。窗口过期后的立即查询必须返回旧值
    // （陈旧即服务，不等增量刷新——真实数据上刷新要枚举全部存储目录）。
    await writeSnapshot(dataRoot, 's-src', [
      refReminder([
        '- s-dst「下游会话」 — agentId: programming-helper（身份: main）',
        '- s-dst「再次引用」 — agentId: programming-helper（身份: main）',
      ]),
    ]);
    await writeIndex(dataRoot, [
      { id: 's-src', updatedAt: '2026-11-14T13:00:00.000Z' },
      { id: 's-dst', updatedAt: '2026-11-14T09:00:00.000Z' },
      { id: 's-dst2', updatedAt: '2026-11-14T09:10:00.000Z' },
      { id: 's-dst3', updatedAt: '2026-11-14T09:20:00.000Z' },
      { id: 's-dst4', updatedAt: '2026-11-14T09:30:00.000Z' },
      { id: 's-iso', updatedAt: '2026-11-14T08:00:00.000Z' },
    ]);
    const stale = await getThreadRelations({ threadId: 'wt-src', dataRoot, freshnessMs: 0 });
    assert.equal(stale.partial, false, '陈旧快照是完整投影，不是 partial');
    assert.equal(stale.neighbors.find(n => n.threadId === 'wt-dst').count, 1, '立即查询返回旧值');

    // 后台重验证落地：轮询可观察条件（预算 1s，间隔 25ms）。
    let landed = false;
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
      const current = await getThreadRelations({ threadId: 'wt-src', dataRoot, freshnessMs: 0 });
      const neighbor = current.neighbors.find(n => n.threadId === 'wt-dst');
      if (neighbor && neighbor.count === 2) { landed = true; break; }
    }
    assert.ok(landed, '后台增量刷新应在预算内让新值可见（count 2）');
    // 静置等最后一笔 fire 完成，避免 after() 清理与缓存写盘竞态（Windows ENOTEMPTY）。
    await new Promise(resolve => setTimeout(resolve, 50));
  });
});
