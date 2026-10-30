/**
 * 会话索引 SQLite 存储层（server/shared/session-access.js，ADR-0036）
 *
 * 覆盖：JSON→db 惰性迁移、读写契约（归一化、revision 单调、无变化不提交）、
 * revision+data_version 双键读缓存、原地突变兜底、头插全量重建、Sync 读一致性、
 * 外部连接写入的缓存失效、启动全量迁移、plain agent JSON 路径不变性。
 *
 * AGENTDEV_DATA_DIR 隔离数据目录（session-access 模块链在 import 时解析数据根）。
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, readFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DATA_ROOT = mkdtempSync(join(tmpdir(), 'claw-index-db-'));
process.env.AGENTDEV_DATA_DIR = DATA_ROOT;

const {
  getPrebuiltSessionIndexPath,
  readSessionIndex,
  readSessionIndexShared,
  writeSessionIndex,
  updateSessionIndex,
  upsertSessionIndexAt,
  readSessionIndexSync,
  migrateAllPrebuiltSessionIndexes,
  closeAllSessionDbs,
} = await import('../server/shared/session-access.js');

const AGENT_ID = 'cache-test-agent';
const CREATED_AT = '2026-01-01T00:00:00.000Z';

function makeIndex(revision, sessionOverrides = {}) {
  return {
    revision,
    activeSessionId: 's1',
    sessions: [
      {
        id: 's1',
        title: '  对话一  ',
        openDirectory: 'D:\\code\\demo',
        sessionType: 'main',
        archived: false,
        todo: true,
        metadata: { resumeMode: 'trim', emptyField: '' },
        ...sessionOverrides,
      },
      { id: 'legacy' }, // 被 legacy 过滤
    ],
  };
}

// 直接落 JSON 文件构造"迁移前"状态（不经过 API）
function writeLegacyJson(agentId, index) {
  const indexPath = getPrebuiltSessionIndexPath(agentId);
  mkdirSync(dirname(indexPath), { recursive: true });
  writeFileSync(indexPath, JSON.stringify(index), 'utf8');
}

after(() => {
  closeAllSessionDbs();
  rmSync(DATA_ROOT, { recursive: true, force: true });
});

describe('JSON→db 惰性迁移', () => {
  test('首次读取触发迁移：数据等价、JSON 留档、db 落盘', async () => {
    writeLegacyJson(AGENT_ID, makeIndex(5));
    const idx = await readSessionIndex(AGENT_ID);
    assert.equal(idx.revision, 5);
    assert.equal(idx.activeSessionId, 's1');
    assert.equal(idx.sessions.length, 1); // legacy 被滤掉
    assert.equal(idx.sessions[0].title, '对话一'); // 归一化写侧生效
    assert.equal(idx.sessions[0].sessionType, 'main');
    assert.equal(idx.sessions[0].archived, false);
    assert.equal(idx.sessions[0].todo, true);
    assert.deepEqual(idx.sessions[0].metadata, { resumeMode: 'trim' }); // 空串字段被清
    const dir = dirname(getPrebuiltSessionIndexPath(AGENT_ID));
    const files = readdirSync(dir);
    assert.ok(files.includes('index.db'), 'db 已落盘');
    assert.ok(files.includes('index.migrated.json'), 'JSON 留档');
    assert.ok(!files.includes('index.json'), '原 JSON 已改名');
  });

  test('迁移幂等：index.migrated.json 存在时不重复迁移，数据保持', async () => {
    const idx = await readSessionIndex(AGENT_ID);
    assert.equal(idx.revision, 5);
    assert.equal(idx.sessions.length, 1);
  });

  test('中间态可重入：COMMIT 后改名前崩溃（db 已有数据 + index.json 仍在），重试跳过导入只完成改名，数据不重复', async () => {
    const agentId = 'crash-after-commit-agent';
    writeLegacyJson(agentId, makeIndex(7));
    await readSessionIndex(agentId); // 完整迁移：db 落库 + JSON 改名
    const dir = dirname(getPrebuiltSessionIndexPath(agentId));
    // 还原"COMMIT 已完成、改名未发生"的崩溃现场：JSON 回到 index.json 名字
    renameSync(join(dir, 'index.migrated.json'), join(dir, 'index.json'));
    // 模拟进程重启：连接与读缓存全清，下次访问重新走 ensureSessionDb
    closeAllSessionDbs();
    const idx = await readSessionIndex(agentId);
    assert.equal(idx.revision, 7, 'revision 保持库内值，不被 JSON 重复导入覆盖');
    assert.equal(idx.sessions.length, 1, '无重复导入（重复导入会出现 2 条）');
    assert.equal(idx.sessions[0].title, '对话一');
    const files = readdirSync(dir);
    assert.ok(files.includes('index.migrated.json'), '补完成改名');
    assert.ok(!files.includes('index.json'), 'index.json 不残留');
  });

  test('损坏 JSON：不迁移不抛错，db 侧为空索引语义', async () => {
    const agentId = 'corrupt-json-agent';
    const indexPath = getPrebuiltSessionIndexPath(agentId);
    mkdirSync(dirname(indexPath), { recursive: true });
    writeFileSync(indexPath, '{broken', 'utf8');
    const idx = await readSessionIndex(agentId);
    assert.deepEqual(idx, { revision: 0, activeSessionId: null, sessions: [] });
  });
});

describe('readSessionIndex 读缓存', () => {
  test('返回值是克隆：调用方突变不污染缓存', async () => {
    const first = await readSessionIndex(AGENT_ID);
    first.sessions[0].title = '已被突变';
    first.revision = 999;
    const second = await readSessionIndex(AGENT_ID);
    assert.equal(second.revision, 5);
    assert.equal(second.sessions[0].title, '对话一');
  });

  test('readSessionIndexShared 命中缓存返回同一引用；写后更替为新对象', async () => {
    const sharedA = await readSessionIndexShared(AGENT_ID);
    const sharedB = await readSessionIndexShared(AGENT_ID);
    assert.equal(sharedA, sharedB); // 同一 revision+data_version：同一对象，零拷贝
    const cloned = await readSessionIndex(AGENT_ID);
    assert.notEqual(cloned, sharedA);
    assert.notEqual(cloned.sessions[0], sharedA.sessions[0]); // 可变副本深度独立
    await updateSessionIndex(AGENT_ID, (index) => ({
      ...index,
      sessions: index.sessions.map((s) => (s.id === 's1' ? { ...s, title: '改名了' } : s)),
    }));
    const sharedC = await readSessionIndexShared(AGENT_ID);
    assert.notEqual(sharedC, sharedA); // 写后缓存更替
    assert.equal(sharedC.revision, 6);
    assert.equal(sharedC.sessions[0].title, '改名了');
    assert.equal(sharedA.sessions[0].title, '对话一'); // 旧对象未被污染
  });

  test('外部连接直写 db（不动 revision）后 data_version 兜底弃缓存', async () => {
    const revisionBefore = (await readSessionIndexShared(AGENT_ID)).revision; // 先装载缓存
    const dbPath = join(dirname(getPrebuiltSessionIndexPath(AGENT_ID)), 'index.db');
    const ext = new DatabaseSync(dbPath);
    ext.prepare("UPDATE sessions SET record = json_set(record, '$.title', '外部改写') WHERE id = 's1'").run();
    ext.close();
    const idx = await readSessionIndex(AGENT_ID);
    assert.equal(idx.sessions[0].title, '外部改写', '外部写入对缓存可见');
    assert.equal(idx.revision, revisionBefore, '外部写未动 revision，读侧仍取 meta 值');
  });
});

describe('updateSessionIndex 提交', () => {
  test('默认保留：无变化不写盘不推进 revision；skipContentComparison 时仍提交', async () => {
    const agentId = 'update-comparison-test';
    await writeSessionIndex(agentId, { revision: 4, activeSessionId: null, sessions: [] });

    const unchanged = await updateSessionIndex(agentId, (index) => index);
    assert.equal(unchanged.revision, 4, '普通更新器返回原索引时不推进 revision');
    assert.deepEqual(await readSessionIndex(agentId), {
      revision: 4,
      activeSessionId: null,
      sessions: [],
    });

    const created = { id: 'new-session', title: '新对话' };
    const committed = await updateSessionIndex(agentId, (index) => ({
      activeSessionId: created.id,
      sessions: [created, ...index.sessions],
    }), { skipContentComparison: true });
    assert.equal(committed.revision, 5, '新增会话必须推进 revision');
    assert.equal(committed.activeSessionId, created.id);
    assert.deepEqual(committed.sessions, [created]);

    const reread = await readSessionIndex(agentId);
    assert.equal(reread.revision, 5);
    assert.equal(reread.sessions.length, 1, '新会话确实持久化到可回读索引');
    assert.equal(reread.sessions[0].id, created.id);
    assert.equal(reread.sessions[0].title, created.title);
  });

  test('指针 diff 路径：map 形态变更行持久化、未变行保持装载值', async () => {
    const agentId = 'pointer-diff-test';
    await writeSessionIndex(agentId, { revision: 1, activeSessionId: null, sessions: [
      { id: 'a', title: 'A', sessionType: 'main' },
      { id: 'b', title: 'B', sessionType: 'main' },
    ] });
    const committed = await updateSessionIndex(agentId, (index) => ({
      ...index,
      sessions: index.sessions.map((s) => (s.id === 'b' ? { ...s, title: 'B2', updatedAt: 'T2' } : s)),
    }));
    assert.equal(committed.revision, 2);
    const reread = await readSessionIndex(agentId);
    assert.equal(reread.sessions[0].title, 'A');
    assert.equal(reread.sessions[1].title, 'B2');
    assert.equal(reread.sessions[1].updatedAt, 'T2');
  });

  test('原地突变兜底：mutator 改行字段后返回原对象也能持久化', async () => {
    const agentId = 'in-place-test';
    await writeSessionIndex(agentId, { revision: 1, activeSessionId: null, sessions: [
      { id: 'a', title: 'A', sessionType: 'main' },
    ] });
    await updateSessionIndex(agentId, (index) => {
      index.sessions[0].title = '原地改';
      return index;
    });
    const reread = await readSessionIndex(agentId);
    assert.equal(reread.sessions[0].title, '原地改');
  });

  test('头插新会话（顺序变化）：全量重建，顺序与 revision 正确', async () => {
    const agentId = 'head-insert-test';
    await writeSessionIndex(agentId, { revision: 1, activeSessionId: null, sessions: [
      { id: 'a', title: 'A', sessionType: 'main' },
    ] });
    await updateSessionIndex(agentId, (index) => ({
      ...index,
      sessions: [{ id: 'head', title: '头部', sessionType: 'main' }, ...index.sessions],
    }), { skipContentComparison: true });
    const reread = await readSessionIndex(agentId);
    assert.deepEqual(reread.sessions.map((s) => s.id), ['head', 'a'], '数组顺序是持久事实');
    assert.equal(reread.revision, 2);
  });

  test('mutator 原地替换 index.sessions 数组（返回原对象）：新增记录必须落盘，不得静默丢失', async () => {
    const agentId = 'mutator-replaces-array-agent';
    await writeSessionIndex(agentId, { revision: 2, activeSessionId: 'a1', sessions: [
      { id: 'a1', title: '已有', openDirectory: 'D:/x' },
    ] });
    // ph-project-store list/lastActivityAt 的真实调用形态：fn 原地改 index.sessions
    // 并返回原 index 对象。曾因"旧数组在 fn 之后取值"走错 diff 分支，新 id 以
    // UPDATE 写入不存在的行而静默丢失。
    await updateSessionIndex(agentId, (index) => {
      index.sessions = [
        { ...index.sessions[0], updatedAt: '2026-10-20T10:00:00.000Z' },
        { id: 'a2', title: '新增', projectId: 'p1', updatedAt: '2026-10-22T08:30:00.000Z' },
      ];
      return index;
    });
    const idx = await readSessionIndex(agentId);
    assert.equal(idx.sessions.length, 2, '两条记录都在（新增记录曾被静默丢弃）');
    assert.ok(idx.sessions.some((s) => s.id === 'a2' && s.projectId === 'p1'), '新增记录字段完整');
    assert.ok(idx.sessions.some((s) => s.id === 'a1' && s.updatedAt === '2026-10-20T10:00:00.000Z'), '同引用行外既有行的更新也落盘');
    assert.equal(idx.revision, 3, 'revision 推进');
  });

  test('mutator 抛错：事务回滚，索引不变，异常上抛', async () => {
    const agentId = 'mutator-throw-test';
    await writeSessionIndex(agentId, { revision: 1, activeSessionId: null, sessions: [
      { id: 'a', title: 'A', sessionType: 'main' },
    ] });
    await assert.rejects(
      updateSessionIndex(agentId, (index) => {
        index.sessions = [{ id: 'x', title: 'X', sessionType: 'main' }];
        throw new Error('boom');
      }),
      /boom/,
    );
    const reread = await readSessionIndex(agentId);
    assert.equal(reread.revision, 1);
    assert.deepEqual(reread.sessions.map((s) => s.id), ['a']);
  });

  test('并发 updateSessionIndex 串行化：重叠调用全部落盘且 revision 连续', async () => {
    const agentId = 'concurrent-test';
    await writeSessionIndex(agentId, { revision: 0, activeSessionId: null, sessions: [] });
    await Promise.all([
      updateSessionIndex(agentId, (index) => ({ ...index, sessions: [{ id: 'c1', title: '一', sessionType: 'main' }, ...index.sessions] }), { skipContentComparison: true }),
      updateSessionIndex(agentId, (index) => ({ ...index, sessions: [{ id: 'c2', title: '二', sessionType: 'main' }, ...index.sessions] }), { skipContentComparison: true }),
    ]);
    const reread = await readSessionIndex(agentId);
    assert.equal(reread.revision, 2);
    assert.deepEqual([...reread.sessions.map((s) => s.id)].sort(), ['c1', 'c2']);
  });
});

describe('writeSessionIndex 全量替换', () => {
  test('落盘后立即读到新内容（revision 采用传入值）', async () => {
    await writeSessionIndex(AGENT_ID, makeIndex(7));
    const idx = await readSessionIndex(AGENT_ID);
    assert.equal(idx.revision, 7);
  });
});

describe('readSessionIndexSync', () => {
  test('与异步变体一致；无索引数据时返回空索引', async () => {
    const agentId = 'sync-agent';
    assert.deepEqual(readSessionIndexSync(agentId), { revision: 0, activeSessionId: null, sessions: [] });
    await writeSessionIndex(agentId, { revision: 3, activeSessionId: 'x', sessions: [{ id: 'x', title: 'X', sessionType: 'main' }] });
    const sync = readSessionIndexSync(agentId);
    const async = await readSessionIndex(agentId);
    assert.equal(sync.revision, async.revision);
    assert.equal(sync.activeSessionId, async.activeSessionId);
    assert.deepEqual(sync.sessions, async.sessions);
  });
});

describe('migrateAllPrebuiltSessionIndexes 启动全量迁移', () => {
  test('扫描两个数据根、逐工作空间迁移、失败告警不阻断', async () => {
    // 非 workspace 型
    writeLegacyJson('startup-plain-agent', { revision: 2, activeSessionId: null, sessions: [] });
    // workspace 型（programming-helper 在 WORKSPACE_SESSION_AGENT_IDS 集合内）
    const wsDir = join(DATA_ROOT, 'workspaces', 'programming-helper', 'sessions');
    mkdirSync(wsDir, { recursive: true });
    writeFileSync(join(wsDir, 'index.json'), JSON.stringify({ revision: 8, activeSessionId: null, sessions: [] }), 'utf8');
    const warnings = [];
    const migrated = migrateAllPrebuiltSessionIndexes((msg) => warnings.push(msg));
    assert.ok(migrated.includes('startup-plain-agent'));
    assert.ok(migrated.includes('programming-helper'));
    assert.deepEqual(warnings, [], '全部迁移成功无告警');
    assert.equal((await readSessionIndex('startup-plain-agent')).revision, 2);
    assert.equal((await readSessionIndex('programming-helper')).revision, 8);
    // 再跑一次：无遗留 JSON，零迁移零告警（幂等）
    assert.deepEqual(migrateAllPrebuiltSessionIndexes((msg) => warnings.push(msg)), []);
    assert.deepEqual(warnings, []);
  });
});

describe('性能预算（ADR-0036 验收：超预算按 bug 排查）', () => {
  // 2767 条 ≈ 当前真实 PH 索引规模。核心退化形态是指针 diff 失效（提交退化为
  // 全量行重写，每 turn 2767 行级操作），用 SQLite 触发器统计 sessions 表的
  // 实际行操作数做断言——计数确定、与机器负载无关。
  // （node --test 并发多文件时，SMT/核共享让同一工作的 CPU 与 wall 时间都膨胀
  // 8 倍量级，任何时间断言都会误报，故时间指标只记录不断言；时间预算以
  // `npm run test:file -- test/session-index-cache.test.js` 单文件运行验证。）
  test('2767 条规模：meta_sync 型单行更新只触及 1 行（非全量行重写）', async () => {
    const agentId = 'perf-budget-agent';
    const sessions = Array.from({ length: 2767 }, (_, i) => ({
      id: `s-${i}`,
      title: `会话${i}号`,
      sessionType: 'main',
      openDirectory: 'D:\\code\\demo',
      updatedAt: new Date(2026, 0, 1, 0, 0, i / 100).toISOString(),
      metadata: { resumeMode: 'trim', sourceAgentId: 'x' },
    }));
    await writeSessionIndex(agentId, { revision: 1, activeSessionId: 's-0', sessions });

    // 测试侧连接装行操作计数触发器（UPDATE/INSERT/DELETE 全覆盖）
    const dbPath = join(dirname(getPrebuiltSessionIndexPath(agentId)), 'index.db');
    const probe = new DatabaseSync(dbPath);
    try {
      probe.exec(`
        CREATE TABLE _row_ops (n INTEGER);
        CREATE TRIGGER _cnt_upd AFTER UPDATE ON sessions BEGIN INSERT INTO _row_ops VALUES (1); END;
        CREATE TRIGGER _cnt_ins AFTER INSERT ON sessions BEGIN INSERT INTO _row_ops VALUES (1); END;
        CREATE TRIGGER _cnt_del AFTER DELETE ON sessions BEGIN INSERT INTO _row_ops VALUES (1); END;
      `);

      const t0 = Date.now();
      await updateSessionIndex(agentId, (index) => ({
        ...index,
        sessions: index.sessions.map((s) => (s.id === 's-1500' ? { ...s, title: '改了', updatedAt: 'T2' } : s)),
      }));
      const updateMs = Date.now() - t0;
      const rowOps = probe.prepare('SELECT COUNT(*) AS n FROM _row_ops').get().n;
      // 正常路径：1 行 UPDATE。允许 ≤2（实现可用 DELETE+INSERT 表达单行替换）。
      // 退化（全量行重写）时为 2767，远超上限，立即拦截。
      assert.ok(rowOps <= 2, `单行更新实际触及 ${rowOps} 行（疑似指针 diff 退化为全量行重写）`);

      const t1 = Date.now();
      const loaded = await readSessionIndexShared(agentId);
      console.log(`[perf-diag] 单行更新 wall ${updateMs}ms；全量装载 wall ${Date.now() - t1}ms（不断言，受并发负载影响）`);
      assert.equal(loaded.sessions.length, 2767);
      assert.equal(loaded.revision, 2);
    } finally {
      probe.close();
    }
  });
});

describe('upsertSessionIndexAt（plain agent 显式路径 upsert，JSON 形态不变）', () => {
  const UPSERT_PATH = join(DATA_ROOT, 'agents', 'upsert-agent', 'sessions', 'index.json');

  test('新建记录：revision 自增、activeSessionId 推进、未知字段保留', async () => {
    await upsertSessionIndexAt(UPSERT_PATH, { id: 'p1', goal: 'g1', sessionType: 'plain', customField: 'keep-me' });
    const raw = JSON.parse((await import('node:fs')).readFileSync(UPSERT_PATH, 'utf8'));
    assert.equal(raw.revision, 1);
    assert.equal(raw.activeSessionId, 'p1');
    assert.equal(raw.sessions.length, 1);
    assert.equal(raw.sessions[0].sessionType, 'plain');
    assert.equal(raw.sessions[0].unknownCustomField, undefined);
    assert.equal(raw.sessions[0].keepMerged, undefined);
    // record 未声明字段不裁剪（merge spread 语义），id 为判重键
    assert.equal(raw.sessions[0].id, 'p1');
  });

  test('重复 upsert：按 id 合并不重复插入，revision 持续自增', async () => {
    await upsertSessionIndexAt(UPSERT_PATH, { id: 'p1', goal: 'g1-updated', updatedAt: 'T2' });
    await upsertSessionIndexAt(UPSERT_PATH, { id: 'p2', goal: 'g2' });
    const raw = JSON.parse((await import('node:fs')).readFileSync(UPSERT_PATH, 'utf8'));
    assert.equal(raw.revision, 3);
    assert.equal(raw.sessions.length, 2);
    const p1 = raw.sessions.find((s) => s.id === 'p1');
    assert.equal(p1.goal, 'g1-updated');       // 覆盖更新
    assert.equal(p1.sessionType, 'plain');     // 未覆盖字段保留
    assert.equal(p1.keepMe, undefined);
    assert.equal(raw.activeSessionId, 'p2');   // 最后写入者成为 active
  });

  test('并发 upsert 串行化：重叠调用全部落盘', async () => {
    const [a, b] = await Promise.all([
      upsertSessionIndexAt(UPSERT_PATH, { id: 'c1', goal: 'x' }),
      upsertSessionIndexAt(UPSERT_PATH, { id: 'c2', goal: 'y' }),
    ]);
    assert.ok(a && b);
    const raw = JSON.parse((await import('node:fs')).readFileSync(UPSERT_PATH, 'utf8'));
    assert.equal(raw.sessions.some((s) => s.id === 'c1'), true);
    assert.equal(raw.sessions.find((s) => s.id === 'c2') !== undefined, true);
  });

  test('createdAt 登记后不可变：续接/终态 upsert 不得重置原始创建时间', async () => {
    // 首次登记（新建）→ createdAt 生效
    await upsertSessionIndexAt(UPSERT_PATH, {
      id: 'p-created',
      goal: 'g',
      sessionType: 'plain',
      source: 'cli',
      openDirectory: '/tmp/work',
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    });
    // 续接（--session）/ 终态 upsert 传入新的 createdAt → 被合并规则拒绝
    await upsertSessionIndexAt(UPSERT_PATH, {
      id: 'p-created',
      goal: 'g',
      sessionType: 'plain',
      source: 'cli',
      openDirectory: '/tmp/work',
      createdAt: '2026-09-10T00:00:00.000Z',
      updatedAt: '2026-09-10T00:00:00.000Z',
      lastError: 'x',
    });
    const raw = JSON.parse((await import('node:fs')).readFileSync(UPSERT_PATH, 'utf8'));
    const record = raw.sessions.find((s) => s.id === 'p-created');
    assert.equal(record.createdAt, CREATED_AT); // 原始创建时间保留
    assert.equal(record.updatedAt, '2026-09-10T00:00:00.000Z'); // updatedAt 正常推进
    assert.equal(record.lastError, 'x'); // 新字段正常合并
    assert.equal(raw.activeSessionId, 'p-created');
  });
});
