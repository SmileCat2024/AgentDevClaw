/**
 * 会话列表 sessionId 精确过滤（字段透传往返）：
 *
 * 背景：PH 移动弹窗单条入口从会话记录解析归属（projectId / openDirectory）。
 * 前端切片缓存（分页 60 条）与项目实体缓存都不是归属事实源——会话不在
 * 当前切片、或实体缓存未加载时，前端解析返回 null，历史上表现为弹窗报
 * 「无法确定该会话的归属目录，不能移动」，而会话在服务端索引里归属明确。
 *
 * 修复：既有列表接口（索引读模型）增加 sessionId 精确过滤；本测试驱动
 * 真实列表函数（隔离数据目录）断言接线与字段往返：
 *  - 项目会话 head：返回记录带 projectId + openDirectory，与切片记录
 *    同一条 wire 投影管线产出（字段名逐一对得上）
 *  - 历史代成员（非 head，ADR-0032 列表口径不进切片）：单查同样返回
 *    （绕过线程分桶——点名要这条记录）
 *  - 目录会话：projectId 空、openDirectory 有值
 *  - 未知 sessionId：空切片，不报错
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// 数据根必须早于任何引用 constants.js 的模块求值，故先设环境变量再动态导入。
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'claw-session-record-wire-'));
process.env.AGENTDEV_DATA_DIR = dataRoot;

const { createSessionHelpers } = await import('../server/routes/session-helpers.js');

const AGENT_ID = 'programming-helper';
const now = Date.now();
const iso = (offsetMs) => new Date(now - offsetMs).toISOString();

const PROJECT_DIR = 'D:\\proj-a';

// 会话形态（同一条线程的三代 + 独立目录会话）：
//   s-proj-root / s-proj-head —— 项目 prj_move01 会话的旧代与 head
//   s-dir —— 目录会话（无 projectId）
const sessions = [
  {
    id: 's-proj-root', title: 'A（精简前）', projectId: 'prj_move01',
    openDirectory: PROJECT_DIR, updatedAt: iso(3000), createdAt: iso(4000),
  },
  {
    id: 's-proj-head', title: '(精简)A', projectId: 'prj_move01',
    openDirectory: PROJECT_DIR, updatedAt: iso(1000), createdAt: iso(1500),
  },
  {
    id: 's-dir', title: '目录对话',
    openDirectory: PROJECT_DIR, updatedAt: iso(500), createdAt: iso(600),
  },
];

const threadIndex = {
  revision: 1,
  threads: [
    {
      threadId: 't-proj', agentId: AGENT_ID, title: 'A', status: 'open',
      rootSessionId: 's-proj-root', headSessionId: 's-proj-head',
      sessionIds: ['s-proj-root', 's-proj-head'],
      createdAt: now - 4000, updatedAt: now - 1000, revision: 3,
    },
  ],
};

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

describe('会话列表 sessionId 精确过滤（归属字段往返）', () => {
  it('项目会话 head：返回 projectId 与 openDirectory，与切片记录字段一致', async () => {
    const helpers = makeHelpers();
    const single = await helpers.listPrebuiltSessions(AGENT_ID, { sessionId: 's-proj-head' });
    // length === 1 同时守住 pageActive 接线：sessionId 漏传激活判定时会走
    // 全量路径返回 3 条
    assert.equal(single.sessions.length, 1, '单查命中一条');
    const record = single.sessions[0];
    assert.equal(record.id, 's-proj-head');
    assert.equal(record.projectId, 'prj_move01', 'projectId 字段往返');
    assert.equal(record.openDirectory, PROJECT_DIR, 'openDirectory 字段往返');

    // 字段同构：同一 wire 管线的 projectId 过滤切片中，同 id 记录逐字段一致
    const paged = await helpers.listPrebuiltSessions(AGENT_ID, {
      sessionProjectId: 'prj_move01', sessionOffset: 0, sessionLimit: 50,
    });
    const pagedRecord = (paged.sessions || []).find((s) => s.id === 's-proj-head');
    assert.ok(pagedRecord, '切片对照记录存在');
    for (const field of ['id', 'title', 'projectId', 'openDirectory']) {
      assert.equal(
        String(record[field] ?? ''), String(pagedRecord[field] ?? ''),
        `字段 ${field} 单查与切片一致`,
      );
    }
  });

  it('历史代成员（非 head）单查同样返回——绕过线程分桶', async () => {
    const helpers = makeHelpers();
    // 切片口径：历史代成员不成行（对照断言）
    const paged = await helpers.listPrebuiltSessions(AGENT_ID, {
      sessionProjectId: 'prj_move01', sessionOffset: 0, sessionLimit: 50,
    });
    assert.ok(!(paged.sessions || []).some((s) => s.id === 's-proj-root'),
      '对照：切片不含历史代成员');
    // 单查口径：点名要这条记录，返回
    const single = await helpers.listPrebuiltSessions(AGENT_ID, { sessionId: 's-proj-root' });
    assert.equal(single.sessions.length, 1, '历史代成员单查命中');
    assert.equal(single.sessions[0].projectId, 'prj_move01');
    assert.equal(single.sessions[0].openDirectory, PROJECT_DIR);
  });

  it('目录会话：projectId 空、openDirectory 有值', async () => {
    const helpers = makeHelpers();
    const single = await helpers.listPrebuiltSessions(AGENT_ID, { sessionId: 's-dir' });
    assert.equal(single.sessions.length, 1);
    assert.ok(!single.sessions[0].projectId, '目录会话 projectId 为空');
    assert.equal(single.sessions[0].openDirectory, PROJECT_DIR);
  });

  it('未知 sessionId：空切片不报错', async () => {
    const helpers = makeHelpers();
    const single = await helpers.listPrebuiltSessions(AGENT_ID, { sessionId: 's-none' });
    assert.equal(single.sessions.length, 0);
  });
});
