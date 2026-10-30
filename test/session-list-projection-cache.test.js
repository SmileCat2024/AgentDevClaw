/**
 * 侧栏投影缓存回归（本次修复：listPrebuiltSessionsFromIndex 双身份投影缓存
 * + readThreadMembership stat-first）。
 *
 * 背景：PH 索引数千会话、秒级轮询，全量 buildLight + 排序与线程成员表的
 * 重复解析是主线程 CPU 停顿主源（拖慢同进程创建请求的索引提交段）。修复以
 * 「共享索引对象 + 共享成员表对象」身份作 WeakMap 键实现 memoization。
 *
 * 本测试锁定的正确性契约：
 *  1. 同输入版本重复调用返回同一 sessions 引用（缓存生效）；
 *  2. 会话索引文件变化 → 新数据立即可见（缓存失效，不发布陈旧行）；
 *  3. 线程文件变化（归档状态）→ 计数口径立即可见（membership 失效）；
 *  4. readThreadMembership 同版本同引用、文件变化后新引用（身份键前提）。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// 数据根必须早于任何引用 constants.js 的模块求值，故先设环境变量再动态导入。
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'claw-sidebar-projcache-'));
process.env.AGENTDEV_DATA_DIR = dataRoot;

const { createSessionHelpers } = await import('../server/routes/session-helpers.js');
const { readThreadMembership } = await import('../server/shared/thread-membership.js');

const AGENT_ID = 'programming-helper';
const DIR = 'D:\\code\\demo-project';

const now = Date.now();
const iso = (offsetMs) => new Date(now - offsetMs).toISOString();

// 完整读模型记录：满足 isSidebarSessionReadModelReady 全部字段，避免触发
// 一次性迁移路径（迁移路径不走缓存，另由 sidebar-read-model-integration 覆盖）。
function readyRecord(id, title, updatedAtMs, extra = {}) {
  return {
    id, title, openDirectory: DIR,
    createdAt: iso(updatedAtMs + 1000), updatedAt: iso(updatedAtMs),
    sidebarMetaVersion: 1,
    archived: false, todo: false, hasSummary: false,
    messageCount: 0, preview: '',
    tokenUsage: {}, modelName: 'test-model',
    compressRatio: 80, contextLength: null,
    ...extra,
  };
}

const threadIndex = () => ({
  revision: 1,
  threads: [
    {
      threadId: 't-1', agentId: AGENT_ID, title: 'T1', status: 'open',
      rootSessionId: 's-root', headSessionId: 's-head',
      sessionIds: ['s-root', 's-head'],
      createdAt: now - 4000, updatedAt: now - 1000, revision: 1,
    },
  ],
});

const archiveIndex = (archivedThreadIds) => ({
  threads: Object.fromEntries(archivedThreadIds.map((id) => [id, { archivedAt: now }])),
});

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), 'utf8');
}

// 索引夹具经 writeSessionIndex API 写入（ADR-0036：持久层 index.db，运行期
// 直写 index.json 对 API 读取不可见）。仍保留 threads/archive-index 的直接
// 文件写入——线程存储不在本次迁移范围。
async function writeSessionIndexLocal(sessions, revision) {
  const { writeSessionIndex } = await import('../server/shared/session-access.js');
  await writeSessionIndex(AGENT_ID, { revision, activeSessionId: null, sessions });
}

function makeHelpers() {
  return createSessionHelpers({
    readWorkspaceState: async () => ({}),
    writeWorkspaceState: async () => {},
    discoverAgents: async () => [],
    enrichAgent: (agent) => agent,
    startManagedAgent: async () => null,
    waitForManagedRuntimeReady: async () => true,
  });
}

before(async () => {
  await writeSessionIndexLocal([
    readyRecord('s-root', 'A（精简前）', 3000),
    readyRecord('s-head', '(精简)A', 1000),
    readyRecord('s-solo', '独立', 500),
  ], 7);
  await writeJson(path.join(dataRoot, 'threads', 'index.json'), threadIndex());
  await writeJson(path.join(dataRoot, 'threads', 'archive-index.json'), archiveIndex([]));
});

after(async () => {
  const { closeAllSessionDbs } = await import('../server/shared/session-access.js');
  closeAllSessionDbs(); // Windows 下打开的 db 句柄会让 rmSync 报 EBUSY
  await fs.rm(dataRoot, { recursive: true, force: true });
});

describe('侧栏投影缓存', () => {
  it('同输入版本重复调用共享同一 sessions 引用（缓存生效）', async () => {
    const helpers = makeHelpers();
    const first = await helpers.listPrebuiltSessions(AGENT_ID, {
      recordDiagnostics: false, includeModelDefaults: false,
    });
    const second = await helpers.listPrebuiltSessions(AGENT_ID, {
      recordDiagnostics: false, includeModelDefaults: false,
    });
    assert.equal(second.sessions, first.sessions, '同版本应命中投影缓存');
    assert.equal(second.revision, first.revision);
  });

  it('会话索引文件变化后新数据立即可见（不发布陈旧行）', async () => {
    const helpers = makeHelpers();
    const before = await helpers.listPrebuiltSessions(AGENT_ID, {
      recordDiagnostics: false, includeModelDefaults: false,
    });
    assert.ok(!before.sessions.some((s) => s.id === 's-new'));

    await writeSessionIndexLocal([
      // s-root 保留在索引中：验证缓存重建后线程成员口径（历史代不 成行）
      // 依然生效，而不是因为记录被删而不出现
      readyRecord('s-root', 'A（精简前）', 3000),
      readyRecord('s-head', '(精简)A', 1000),
      readyRecord('s-solo', '独立', 500),
      readyRecord('s-new', '新建对话', 100),
    ], 8);

    const after = await helpers.listPrebuiltSessions(AGENT_ID, {
      recordDiagnostics: false, includeModelDefaults: false,
    });
    assert.ok(after.sessions.some((s) => s.id === 's-new'), '新会话应出现');
    assert.equal(after.revision, 8);
    assert.notEqual(after.sessions, before.sessions, '版本变化后不得复用旧投影');

    // 成员口径（历史代不成行）由分页/wire 投影承载：验证缓存重建后该口径
    // 依然生效（分页调用在缓存命中的全量投影之上现做切片）
    const paged = await helpers.listPrebuiltSessions(AGENT_ID, {
      sessionProjectDir: DIR, sessionOffset: 0, sessionLimit: 50,
    });
    const pagedIds = paged.sessions.map((s) => s.id);
    assert.ok(pagedIds.includes('s-new'), '新会话在分页口径成行');
    assert.ok(!pagedIds.includes('s-root'), '历史代成员在分页口径不 成行');
    assert.equal(paged.sessionTotal, 3, 's-head + s-solo + s-new');
  });

  it('线程归档状态变化后计数口径立即可见（membership 失效）', async () => {
    // 显式重置受控前置：本用例的预期依赖确切的索引与归档状态，不继承
    // 前序用例改写后的数据。
    await writeSessionIndexLocal([
      readyRecord('s-root', 'A（精简前）', 3000),
      readyRecord('s-head', '(精简)A', 1000),
      readyRecord('s-solo', '独立', 500),
    ], 9);
    await writeJson(path.join(dataRoot, 'threads', 'index.json'), threadIndex());
    await writeJson(path.join(dataRoot, 'threads', 'archive-index.json'), archiveIndex([]));

    const helpers = makeHelpers();
    const options = { sessionProjectDir: DIR, sessionOffset: 0, sessionLimit: 50 };
    const before = await helpers.listPrebuiltSessions(AGENT_ID, options);
    // s-head（活跃线程 head）+ s-solo = main 2；归档 0
    assert.equal(before.mainTotal, 2);
    assert.equal(before.archivedTotal, 0);

    // 归档线程 t-1：threads 文件变化（size 增），会话索引不动
    await writeJson(path.join(dataRoot, 'threads', 'archive-index.json'), archiveIndex(['t-1']));

    const after = await helpers.listPrebuiltSessions(AGENT_ID, options);
    assert.equal(after.archivedTotal, 1, '归档线程 head 应计入 archived');
    assert.equal(after.mainTotal, 1, 'main 计数应随归档状态下降');
  });

  it('分页/wireTrim 调用与全量调用共享缓存且互不污染', async () => {
    const helpers = makeHelpers();
    const full = await helpers.listPrebuiltSessions(AGENT_ID, {
      recordDiagnostics: false, includeModelDefaults: false,
    });
    const paged = await helpers.listPrebuiltSessions(AGENT_ID, {
      sessionProjectDir: DIR, sessionOffset: 0, sessionLimit: 1, wireTrim: true,
    });
    assert.equal(paged.sessions.length, 1, '分页切片生效');
    assert.equal(paged.sessionHasMore, true);
    // 分页产生新数组/新元素，不改动缓存中的全量投影
    const fullAgain = await helpers.listPrebuiltSessions(AGENT_ID, {
      recordDiagnostics: false, includeModelDefaults: false,
    });
    assert.equal(fullAgain.sessions, full.sessions, '全量投影缓存不受分页调用影响');
    assert.deepEqual(
      fullAgain.sessions.map((s) => s.id),
      full.sessions.map((s) => s.id),
    );
  });
});

describe('readThreadMembership stat-first 缓存', () => {
  it('同文件版本返回同一 Map 引用，文件变化后返回新引用并反映新状态', async () => {
    const m1 = await readThreadMembership(AGENT_ID);
    const m2 = await readThreadMembership(AGENT_ID);
    assert.equal(m2, m1, '同版本应共享成员表实例');

    await writeJson(path.join(dataRoot, 'threads', 'index.json'), {
      ...threadIndex(),
      threads: [
        ...threadIndex().threads,
        {
          threadId: 't-2', agentId: AGENT_ID, title: 'T2', status: 'open',
          rootSessionId: 's-solo2', headSessionId: 's-solo2',
          sessionIds: ['s-solo2'],
          createdAt: now - 500, updatedAt: now - 100, revision: 1,
        },
      ],
    });
    const m3 = await readThreadMembership(AGENT_ID);
    assert.notEqual(m3, m1, 'threads 文件变化后应重建成员表');
    assert.ok(m3.has('s-solo2'), '新线程成员可见');
    assert.equal(m1.has('s-solo2'), false, '旧实例保持旧事实（只读快照语义）');
  });

  it('其他 agent 的成员表互不驱逐', async () => {
    const ph = await readThreadMembership(AGENT_ID);
    const other = await readThreadMembership('coder');
    const phAgain = await readThreadMembership(AGENT_ID);
    assert.equal(phAgain, ph, '读取其他 agent 后 PH 成员表仍命中');
    assert.equal(other.size, 0, '无线程 agent 为空表');
  });
});
