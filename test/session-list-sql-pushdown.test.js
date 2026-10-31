/**
 * 会话列表 SQLite 查询下推（ADR-0036 后续）差分测试
 *
 * Oracle = 旧 JS 实现（sortSidebarSessions + sliceSessionsForWire，
 * session-helpers-pure.js）。对同一批夹具与参数组合，逐项断言 SQL 查询
 * （querySessionIndexPage）与 oracle 在以下维度一致：
 *   - 切片顺序与成员（id 序列，含排序 tie-break）
 *   - total / mainTotal / archivedTotal 计数（含线程 head 归档分桶）
 *   - offset/limit 边界（负值、超界、limit 超上限、无 limit 全量）
 *   - 精确 sessionId 查询绕过归属过滤与线程分桶，且遵守 offset/limit
 *
 * 夹具刻意覆盖：项目/目录归属互斥、目录归一化（反斜杠/大小写/尾斜杠）、
 * 线程 head 与历史代成员、会话级与线程级归档不一致、标题/目录搜索、
 * updatedAt 与 createdAt tie-break。病态输入（空时间戳等）不进夹具：
 * 真实数据审计（2785 条）为零，旧实现对病态值的回退本就无契约。
 *
 * AGENTDEV_DATA_DIR 隔离数据目录（session-access 在 import 时解析数据根）。
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_ROOT = mkdtempSync(join(tmpdir(), 'claw-list-pushdown-'));
process.env.AGENTDEV_DATA_DIR = DATA_ROOT;

const { writeSessionIndex, querySessionIndexPage, closeAllSessionDbs } =
  await import('../server/shared/session-access.js');
const {
  sortSidebarSessions,
  sliceSessionsForWire,
  buildLightPrebuiltSessionRecord,
} = await import('../server/routes/session-helpers-pure.js');

const AGENT_ID = 'ph-pushdown-agent';

// 时间戳递增但刻意制造 tie：t2 相同 updatedAt 不同 createdAt；
// t4 相同 updatedAt+createdAt 不同 id（id tie-break）。
const T = {
  t1: '2026-10-20T10:00:00.000Z',
  t2: '2026-10-21T10:00:00.000Z',
  t2b: '2026-10-21T09:00:00.000Z',
  t3: '2026-10-22T10:00:00.000Z',
  t4: '2026-10-23T10:00:00.000Z',
  t5: '2026-10-24T10:00:00.000Z',
  t6: '2026-10-25T10:00:00.000Z',
};

const FIXTURE_SESSIONS = [
  { id: 's-proj-a1', projectId: 'proj-1', openDirectory: 'D:\\Work\\ProjA', title: '项目会话 A1', createdAt: T.t1, updatedAt: T.t3 },
  { id: 's-proj-a2', projectId: 'proj-1', openDirectory: 'D:\\Work\\ProjA', title: '项目会话 A2', createdAt: T.t1, updatedAt: T.t2b },
  { id: 's-proj-other', projectId: 'proj-2', openDirectory: 'D:\\Work\\ProjA', title: '别项目同目录', createdAt: T.t1, updatedAt: T.t5 },
  { id: 's-dir-alpha1', openDirectory: 'D:\\Work\\Alpha', title: '目录会话 alpha1', createdAt: T.t1, updatedAt: T.t5 },
  { id: 's-dir-alpha2', openDirectory: 'D:/work/alpha/', title: '目录会话 alpha2', createdAt: T.t2b, updatedAt: T.t2 },
  { id: 's-dir-beta', openDirectory: 'D:\\Work\\Beta', title: 'Regression FIX in beta', createdAt: T.t1, updatedAt: T.t4 },
  { id: 's-dir-beta2', openDirectory: 'D:\\Work\\Beta', title: '同目录第二条', createdAt: T.t1, updatedAt: T.t4 },
  { id: 's-thread-head', openDirectory: 'D:\\Work\\Gamma', title: '线程 head（线程已归档）', createdAt: T.t1, updatedAt: T.t4, archived: false },
  { id: 's-thread-old', openDirectory: 'D:\\Work\\Gamma', title: '线程历史代成员', createdAt: T.t1, updatedAt: T.t6 },
  { id: 's-archived-plain', openDirectory: 'D:\\Work\\Alpha', title: '普通归档会话', createdAt: T.t1, updatedAt: T.t1, archived: true },
  { id: 's-search-mixed', openDirectory: 'D:\\Work\\Delta', title: 'MiXeD CaSe Title', createdAt: T.t1, updatedAt: T.t3 },
];

// 线程成员事实（模拟 readThreadMembership 输出）：
// head 线程已归档（分桶归线程）；s-thread-old 是历史代（不进列表与计数）。
const FIXTURE_MEMBERSHIP = new Map([
  ['s-thread-head', { isHead: true, archived: true }],
  ['s-thread-old', { isHead: false, archived: false }],
]);

const PARAM_COMBOS = [
  { name: '无过滤全量（排序总校验）', options: {} },
  { name: '项目归属', options: { projectId: 'proj-1' } },
  { name: '项目归属+归档 tab', options: { projectId: 'proj-1', archived: 'archived' } },
  { name: '目录归属（反斜杠原文）', options: { projectDir: 'D:\\Work\\Alpha' } },
  { name: '目录归一化（正斜杠+大小写+尾斜杠）', options: { projectDir: 'd:/work/alpha/' } },
  { name: '目录归属+main tab', options: { projectDir: 'D:\\Work\\Beta', archived: 'main' } },
  { name: '标题搜索（大小写不敏感）', options: { query: 'fix' } },
  { name: '标题搜索（混合大小写）', options: { query: 'MIXED' } },
  { name: '目录搜索', options: { query: 'beta' } },
  { name: '搜索无命中', options: { query: 'zzz-nomatch' } },
  { name: 'archived=main 全量', options: { archived: 'main' } },
  { name: 'archived=archived 全量', options: { archived: 'archived' } },
  { name: 'tab+搜索叠加', options: { archived: 'main', query: 'fix' } },
  { name: 'offset 单独（到末尾）', options: { offset: 2 } },
  { name: 'offset+limit', options: { offset: 2, limit: 3 } },
  { name: 'limit 首页', options: { offset: 0, limit: 3 } },
  { name: 'offset 超界', options: { offset: 100 } },
  { name: 'offset=0 显式', options: { offset: 0 } },
  { name: 'limit 超上限钳制', options: { limit: 600 } },
  { name: 'offset 负值钳 0', options: { offset: -5, limit: 4 } },
  { name: '精确查询（历史代成员绕过）', options: { sessionId: 's-thread-old' } },
  { name: '精确查询（线程 head）', options: { sessionId: 's-thread-head' } },
  { name: '精确查询不存在', options: { sessionId: 'missing-id' } },
  { name: '精确查询+offset 越过', options: { sessionId: 's-thread-old', offset: 1 } },
];

function runOracle(options) {
  const light = sortSidebarSessions(
    FIXTURE_SESSIONS.map((record) => buildLightPrebuiltSessionRecord(AGENT_ID, record)),
  );
  return sliceSessionsForWire(light, { ...options, threadMembership: FIXTURE_MEMBERSHIP });
}

function expectedArchivedFor(record) {
  const membership = FIXTURE_MEMBERSHIP.get(String(record.id || ''));
  if (membership) return membership.archived === true;
  return record.archived === true;
}

describe('会话列表 SQL 查询下推：与旧 JS 切片差分一致', () => {
  test('夹具装载', async () => {
    await writeSessionIndex(AGENT_ID, {
      revision: 1,
      activeSessionId: 's-dir-alpha1',
      sessions: FIXTURE_SESSIONS,
    });
  });

  for (const combo of PARAM_COMBOS) {
    test(`参数组合：${combo.name}`, async () => {
      const oracle = runOracle(combo.options);
      const sql = await querySessionIndexPage(AGENT_ID, {
        ...combo.options,
        threadMembership: FIXTURE_MEMBERSHIP,
      });

      assert.deepEqual(
        sql.slice.map((entry) => entry.record.id),
        oracle.slice.map((session) => session.id),
        `切片成员/顺序不一致`,
      );
      // 分桶归档口径按路径区分：普通列表 = 线程感知（head 以线程事实为准）；
      // 精确 sessionId 查询绕过线程分桶，wire 级归档保持会话级标志。
      const exactQuery = Boolean(combo.options.sessionId);
      assert.deepEqual(
        sql.slice.map((entry) => entry.archived),
        oracle.slice.map((session) => {
          const record = FIXTURE_SESSIONS.find((r) => r.id === session.id);
          if (exactQuery) return record?.archived === true;
          return expectedArchivedFor(record);
        }),
        '归档分桶不一致',
      );
      assert.equal(sql.total, oracle.total, 'total 不一致');
      assert.equal(sql.mainTotal, oracle.mainTotal, 'mainTotal 不一致');
      assert.equal(sql.archivedTotal, oracle.archivedTotal, 'archivedTotal 不一致');
      const expectedOffset = Number.isFinite(Number(combo.options.offset)) && Number(combo.options.offset) > 0
        ? Math.floor(Number(combo.options.offset)) : 0;
      assert.equal(sql.offset, expectedOffset, 'offset 不一致');
    });
  }

  test('全量顺序 = JS localeCompare 排序序（真实形态 id/时间戳）', async () => {
    // 无过滤无分页：SQL 全量顺序必须与 oracle（排序+线程 head 过滤）一致，
    // 锁定 localeCompare 与 COLLATE BINARY 在真实数据形态下同序。
    const oracle = runOracle({});
    const sql = await querySessionIndexPage(AGENT_ID, { threadMembership: FIXTURE_MEMBERSHIP });
    assert.deepEqual(
      sql.slice.map((entry) => entry.record.id),
      oracle.slice.map((session) => session.id),
    );
  });
});

after(async () => {
  await closeAllSessionDbs();
  rmSync(DATA_ROOT, { recursive: true, force: true });
});
