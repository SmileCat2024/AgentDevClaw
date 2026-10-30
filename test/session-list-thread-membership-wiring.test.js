/**
 * 接线测试：会话列表的索引读模型必须应用线程成员口径（ADR-0032）。
 *
 * 背景（本次修复）：`sliceSessionsForWire` 的 threadMembership 口径早已交付，
 * rich 降级路径也接了，但 PH 正常走的 `listPrebuiltSessionsFromIndex` 漏传——
 * 历史代成员以普通会话行返回、main/archived 计数失真（真实数据实测 2116 vs
 * 应有 1717）。纯函数测试覆盖不到这种「调用点漏传」，故在此用隔离数据目录
 * 驱动真实列表函数断言接线结果。
 *
 * 断言面：head 行保留、历史代成员不出现、计数按线程归档状态分桶。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// 数据根必须早于任何引用 constants.js 的模块求值，故先设环境变量再动态导入。
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'claw-sidebar-thread-'));
process.env.AGENTDEV_DATA_DIR = dataRoot;

const { createSessionHelpers } = await import('../server/routes/session-helpers.js');

const AGENT_ID = 'programming-helper';
const now = Date.now();
const iso = (offsetMs) => new Date(now - offsetMs).toISOString();

// 目录会话（无 projectId）——PH 列表按目录过滤
const DIR = 'D:\\code\\demo-project';

// 会话形态：
//   s-root / s-mid / s-head  —— 一条活跃线程的三代（只有 head 应成行）
//   s-arch-root / s-arch-head —— 一条已归档线程的两代（head 成行且归入已归档）
//   s-solo —— 无线程独立会话（成行，按 session.archived 归桶）
const sessions = [
  { id: 's-root', title: 'A（精简前）', openDirectory: DIR, updatedAt: iso(3000), createdAt: iso(4000) },
  { id: 's-mid', title: '(精简)A', openDirectory: DIR, updatedAt: iso(2000), createdAt: iso(2500) },
  { id: 's-head', title: '(精简)A 二', openDirectory: DIR, updatedAt: iso(1000), createdAt: iso(1500) },
  { id: 's-arch-root', title: 'B（精简前）', openDirectory: DIR, updatedAt: iso(9000), createdAt: iso(9500) },
  { id: 's-arch-head', title: 'B 归档', openDirectory: DIR, updatedAt: iso(8000), createdAt: iso(8500) },
  { id: 's-solo', title: '独立对话', openDirectory: DIR, updatedAt: iso(500), createdAt: iso(600) },
];

const threadIndex = {
  revision: 1,
  threads: [
    {
      threadId: 't-active', agentId: AGENT_ID, title: 'A', status: 'open',
      rootSessionId: 's-root', headSessionId: 's-head',
      sessionIds: ['s-root', 's-mid', 's-head'],
      createdAt: now - 4000, updatedAt: now - 1000, revision: 3,
    },
    {
      threadId: 't-archived', agentId: AGENT_ID, title: 'B', status: 'open',
      rootSessionId: 's-arch-root', headSessionId: 's-arch-head',
      sessionIds: ['s-arch-root', 's-arch-head'],
      createdAt: now - 9500, updatedAt: now - 8000, revision: 2,
    },
  ],
};

const archiveIndex = { threads: { 't-archived': { archivedAt: now - 8000 } } };

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), 'utf8');
}

before(async () => {
  const sessionsDir = path.join(dataRoot, 'workspaces', AGENT_ID, 'sessions');
  await writeJson(path.join(sessionsDir, 'index.json'), {
    revision: 7,
    activeSessionId: null,
    sessions,
  });
  await writeJson(path.join(dataRoot, 'threads', 'index.json'), threadIndex);
  await writeJson(path.join(dataRoot, 'threads', 'archive-index.json'), archiveIndex);
});

after(async () => {
  // 释放 SQLite 连接句柄，Windows 下未关闭句柄会让 rmSync 目录 EBUSY
  const { closeAllSessionDbs } = await import('../server/shared/session-access.js');
  await closeAllSessionDbs();
  await fs.rm(dataRoot, { recursive: true, force: true });
});

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

const idsOf = (result) => (result.sessions || []).map((session) => session.id).sort();

describe('会话列表线程成员口径（索引读模型接线）', () => {
  it('历史代成员不进入切片，仅 head 与无线程会话成行', async () => {
    const helpers = makeHelpers();
    const result = await helpers.listPrebuiltSessions(AGENT_ID, {
      sessionProjectDir: DIR,
      sessionOffset: 0,
      sessionLimit: 50,
    });
    assert.deepEqual(idsOf(result), ['s-arch-head', 's-head', 's-solo']);
    for (const hidden of ['s-root', 's-mid', 's-arch-root']) {
      assert.ok(!idsOf(result).includes(hidden), `历史代 ${hidden} 不应成行`);
    }
  });

  it('计数按线程归档状态分桶：归档线程 head 计入 archived', async () => {
    const helpers = makeHelpers();
    const result = await helpers.listPrebuiltSessions(AGENT_ID, {
      sessionProjectDir: DIR,
      sessionOffset: 0,
      sessionLimit: 50,
    });
    // 活跃线程 head + 无线程独立会话 = 2；已归档线程 head = 1
    assert.equal(result.mainTotal, 2, 'mainTotal 只数未归档对话');
    assert.equal(result.archivedTotal, 1, 'archivedTotal 只数已归档对话');
    assert.equal(result.sessionTotal, 3, 'sessionTotal 与切片口径一致');
  });

  it('archived 过滤与线程归档状态一致（活跃 head 不出现在归档页）', async () => {
    const helpers = makeHelpers();
    const archived = await helpers.listPrebuiltSessions(AGENT_ID, {
      sessionProjectDir: DIR,
      sessionArchived: 'archived',
      sessionOffset: 0,
      sessionLimit: 50,
    });
    assert.deepEqual(idsOf(archived), ['s-arch-head']);

    const main = await helpers.listPrebuiltSessions(AGENT_ID, {
      sessionProjectDir: DIR,
      sessionArchived: 'main',
      sessionOffset: 0,
      sessionLimit: 50,
    });
    assert.deepEqual(idsOf(main), ['s-head', 's-solo']);
  });
});
