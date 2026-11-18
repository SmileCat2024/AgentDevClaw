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
  getTopicGroups,
  resetRelationsMemo,
} from '../server/session-relations/projection.js';
import { saveTopicNote } from '../server/session-relations/topic-notes.js';

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
    assert.equal(cached.schemaVersion, 2);
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

describe('getTopicGroups', () => {
  it('returns every connected topic group in recent activity order from session indexes', async () => {
    resetRelationsMemo();
    const result = await getTopicGroups({ agentId: 'programming-helper', dataRoot, force: true });
    assert.equal(result.partial, false);
    assert.deepEqual(result.groups.map((group) => group.threadIds), [
      ['wt-dst', 'wt-dst2', 'wt-dst3', 'wt-dst4', 'wt-src'],
    ]);
    assert.equal(result.groups[0].threads[0].threadId, 'wt-src');
    assert.equal(result.groups[0].memberCount, 5);
  });

  it('filters groups by the current directory without reading group chats', async () => {
    resetRelationsMemo();
    const result = await getTopicGroups({
      agentId: 'programming-helper',
      openDirectory: 'D:/current',
      dataRoot,
      force: true,
    });
    assert.deepEqual(result.groups, []);
  });

  it('merges exact-match topic notes into group title and summary', async () => {
    resetRelationsMemo();
    const before = await getTopicGroups({ agentId: 'programming-helper', dataRoot, force: true });
    const clusterId = before.groups[0].id;
    await saveTopicNote({
      dataRoot, agentId: 'programming-helper', clusterId,
      title: '自定义主题名', summary: '一句话简介',
      docs: ['docs/adr/0002-continuity.md — 连续性决策'],
      commits: ['55f981a6 标注风格落成技能'],
      threadIds: before.groups[0].threadIds,
    });
    const after = await getTopicGroups({ agentId: 'programming-helper', dataRoot, force: true });
    const merged = after.groups.find(group => group.id === clusterId);
    assert.equal(merged.title, '自定义主题名');
    assert.equal(merged.summary, '一句话简介');
    assert.equal(merged.customTitle, true);
    assert.deepEqual(merged.docs, ['docs/adr/0002-continuity.md — 连续性决策']);
    assert.deepEqual(merged.commits, ['55f981a6 标注风格落成技能']);
  });

  it('inherits notes from a subset snapshot when the cluster grows, never from diverged ones', async () => {
    resetRelationsMemo();
    const before = await getTopicGroups({ agentId: 'programming-helper', dataRoot, force: true });
    const { id: clusterId, threadIds } = before.groups[0];
    // 隔离上一用例写入的精确标注：本用例考察的是「当前簇 id 无精确命中
    // 时」的继承行为。
    await fs.rm(path.join(dataRoot, 'workspaces', 'programming-helper', 'topic-notes.json'), { force: true });
    // 簇早期快照（成员真子集）带标注：簇增长换 id 后标注应被继承
    // （docs / commits 随标注整体继承）。
    await saveTopicNote({
      dataRoot, agentId: 'programming-helper', clusterId: 'relation_earlysubset',
      title: '早期标注', summary: '', docs: ['docs/early.md'],
      threadIds: threadIds.slice(0, 2),
    });
    const inherited = await getTopicGroups({ agentId: 'programming-helper', dataRoot, force: true });
    const inheritedGroup = inherited.groups.find(group => group.id === clusterId);
    assert.equal(inheritedGroup.title, '早期标注');
    assert.deepEqual(inheritedGroup.docs, ['docs/early.md']);
    // 分裂快照（含簇外成员）不继承。
    await fs.rm(path.join(dataRoot, 'workspaces', 'programming-helper', 'topic-notes.json'));
    await saveTopicNote({
      dataRoot, agentId: 'programming-helper', clusterId: 'relation_diverged',
      title: '误贴标注', summary: '',
      threadIds: [threadIds[0], 'wt-outside'],
    });
    const diverged = await getTopicGroups({ agentId: 'programming-helper', dataRoot, force: true });
    const group = diverged.groups.find(entry => entry.id === clusterId);
    assert.notEqual(group.title, '误贴标注');
    assert.equal(group.customTitle, false);
  });

  it('falls back to the head session title when the thread record has none', async () => {
    resetRelationsMemo();
    // 独立数据根：本用例要改写线程与会话索引形态，不复用全局夹具，
    // 避免影响其他用例的标题预期。
    const localRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'claw-relations-fallback-'));
    try {
      await writeThreads(localRoot, [
        { threadId: 'wt-src', workspaceId: 'programming-helper', title: '', sessionIds: ['s-src'] },
        { threadId: 'wt-dst', workspaceId: 'programming-helper', title: '', sessionIds: ['s-dst'] },
      ]);
      await writeIndex(localRoot, [
        { id: 's-src', title: '源会话的AI标题', updatedAt: '2026-11-14T10:00:00.000Z' },
        { id: 's-dst', title: '下游会话标题', updatedAt: '2026-11-14T09:00:00.000Z' },
      ]);
      await writeSnapshot(localRoot, 's-src', [refReminder(['- s-dst「下游会话」 — agentId: programming-helper（身份: main）'])]);
      await writeSnapshot(localRoot, 's-dst', []);
      const result = await getTopicGroups({ agentId: 'programming-helper', dataRoot: localRoot, force: true });
      const group = result.groups[0];
      const src = group.threads.find(thread => thread.threadId === 'wt-src');
      assert.equal(src.title, '源会话的AI标题');
      // 簇展示标题回退到簇内最新有标题线程（wt-src 的会话标题）。
      assert.equal(group.title, '源会话的AI标题');
    } finally {
      resetRelationsMemo();
      await fs.rm(localRoot, { recursive: true, force: true }).catch(() => {});
    }
  });
});

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
    // 建立确定性基线：s-src 单次引用 s-dst，水位 T1。先构建落盘再清备忘
    // （模拟重启）：冷启动磁盘种子让重启后的首个查询直接服务落盘基线，
    // 而不是阻塞一次全量重建。
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
    // 基线用 force 同步强建：普通查询会先服务磁盘上的遗留缓存（种子路径）
    // 而不是构建当前数据，基线值就不可控了。强建落盘后再清备忘模拟重启。
    await buildRelationsSnapshot({ dataRoot, force: true });
    resetRelationsMemo(); // 模拟重启：备忘清空，磁盘缓存保留
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

describe('getThreadRelations cold-start disk seed', () => {
  // 服务重启 = 进程内备忘清空、磁盘缓存仍在。首个查询不得降级 partial：
  // 先以磁盘快照服务（builtAt 如实披露陈旧度），后台增量刷新自然追上
  // （历史事故：重启后分钟级窗口内关联群看板误报空）。
  it('serves the persisted snapshot immediately after a simulated restart', async () => {
    resetRelationsMemo();
    // 契约锚点：服务的是「落盘的那份投影」——响应 builtAt 必须等于落盘
    // builtAt。小数据根上无种子实现也能靠竞速赢（全量重建 <500ms）返回
    // partial=false；只有 builtAt 相等能区分「陈旧即服务」与「阻塞重建」。
    const persisted = JSON.parse(await fs.readFile(path.join(dataRoot, 'session-relations', 'cache.json'), 'utf8'));
    assert.ok(persisted.builtAt, '前置：磁盘缓存已由前序测试落盘');
    const result = await getThreadRelations({ threadId: 'wt-src', dataRoot });
    assert.equal(result.partial, false, '磁盘种子是完整投影，不是 partial');
    assert.equal(result.builtAt, persisted.builtAt, '种子响应如实携带落盘数据时点');
    assert.ok(result.neighbors.some(n => n.threadId === 'wt-dst'));

    // 等种子触发的后台增量刷新落地（写盘推进 builtAt），避免与 after() 清理竞态。
    let rebuilt = false;
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
      const cached = JSON.parse(await fs.readFile(path.join(dataRoot, 'session-relations', 'cache.json'), 'utf8'));
      if (String(cached.builtAt) > String(persisted.builtAt)) { rebuilt = true; break; }
    }
    assert.ok(rebuilt, '种子触发的后台增量刷新应在预算内完成');
    await new Promise(resolve => setTimeout(resolve, 50));
  });

  it('still degrades gracefully when no persisted cache exists', async () => {
    resetRelationsMemo();
    const emptyRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'claw-relations-cold-'));
    try {
      await writeThreads(emptyRoot, [
        { threadId: 'wt-x', workspaceId: 'programming-helper', title: 'X', sessionIds: ['s-x'] },
      ]);
      // 无会话索引、无缓存：竞速窗口内小数据根可能快也可能慢，partial 由
      // 时序决定（不锁定）；但无论输赢，身份与关联形状必须确定：孤立线程
      // found=false、无邻居、群大小 1，不抛错。
      const result = await getThreadRelations({ threadId: 'wt-x', dataRoot: emptyRoot });
      assert.equal(result.resolvedThreadId, 'wt-x');
      assert.equal(result.resolvedThreadTitle, 'X');
      assert.equal(result.found, false);
      assert.deepEqual(result.neighbors, []);
      assert.equal(result.component.size, 1);
    } finally {
      resetRelationsMemo();
      await new Promise(resolve => setTimeout(resolve, 50));
      await fs.rm(emptyRoot, { recursive: true, force: true });
    }
  });
});
