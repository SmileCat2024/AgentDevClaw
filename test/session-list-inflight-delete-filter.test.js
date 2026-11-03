/**
 * 会话列表出口过滤「删除事务进行中」的线程成员（幽灵重现修复回归）。
 *
 * 契约：删除事务（drain 等待 + 级联清理）完成前，会话索引里成员仍在；
 * listPrebuiltSessions 的出口必须把 in-flight 成员从 sessions 移除，
 * activeSessionId 指向被过滤成员时回退到剩余首个——否则前端乐观移除后，
 * 侧栏轮询会把已删会话重新投回（先消失、再以「正在删除」虚状态重现）。
 * 无 in-flight 成员时列表行为不变（对照，证明过滤不是恒等偶然）。
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const DATA_ROOT = mkdtempSync(join(tmpdir(), 'claw-inflight-del-'));
process.env.AGENTDEV_DATA_DIR = DATA_ROOT;

after(() => {
  closeAllSessionDbs(); // Windows 下打开的 db 句柄会让 rmSync 报 EBUSY
  rmSync(DATA_ROOT, { recursive: true, force: true });
});

// 先设 env 再 import：模块链在 import 时解析数据根
const { createSessionHelpers, excludeInflightDeleteSessions } = await import('../server/routes/session-helpers.js');
const { writeSessionIndex, closeAllSessionDbs } = await import('../server/shared/session-access.js');

const AGENT = 'programming-helper';

function sessionRecord(id) {
  return {
    id,
    title: id,
    openDirectory: 'D:\\diag\\dir',
    sessionType: 'main',
    workspaceAgentId: 'main',
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
    messageCount: 1,
    preview: 'p',
    fileSize: 10,
    fileMtimeMs: 1,
    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    modelName: 'm',
    contextLength: null,
    compressRatio: 80,
    hasSummary: false,
    sidebarMetaVersion: 1,
  };
}

let helpers;

before(async () => {
  await writeSessionIndex(AGENT, {
    revision: 1,
    activeSessionId: 's2',
    sessions: [sessionRecord('s1'), sessionRecord('s2'), sessionRecord('s3')],
  });
});

describe('listPrebuiltSessions 出口过滤 in-flight 删除成员', () => {
  test('事务进行中：成员被移除，activeSessionId 回退到剩余首个', async () => {
    helpers = createSessionHelpers({
      readWorkspaceState: async () => ({}),
      writeWorkspaceState: async () => {},
      discoverAgents: async () => [{ id: AGENT }],
      enrichAgent: async (agent) => agent,
      startManagedAgent: async () => ({ ok: true }),
      waitForManagedRuntimeReady: async () => true,
      getInflightDeleteSessionIds: (agentId) => (agentId === AGENT ? ['s2'] : []),
    });
    const result = await helpers.listPrebuiltSessions(AGENT);
    assert.deepEqual(result.sessions.map((s) => s.id).sort(), ['s1', 's3']);
    assert.equal(result.activeSessionId, result.sessions[0].id,
      'active 指向被过滤成员时回退到剩余首个（列表顺序本身不是本测试契约）');
  });

  test('无 in-flight 成员：列表完整、activeSessionId 保持（对照）', async () => {
    helpers = createSessionHelpers({
      readWorkspaceState: async () => ({}),
      writeWorkspaceState: async () => {},
      discoverAgents: async () => [{ id: AGENT }],
      enrichAgent: async (agent) => agent,
      startManagedAgent: async () => ({ ok: true }),
      waitForManagedRuntimeReady: async () => true,
      getInflightDeleteSessionIds: () => [],
    });
    const result = await helpers.listPrebuiltSessions(AGENT);
    assert.deepEqual(result.sessions.map((s) => s.id).sort(), ['s1', 's2', 's3']);
    assert.equal(result.activeSessionId, 's2');
  });

  test('rich 读路径同样过滤（forceRich 走另一条分支）', async () => {
    helpers = createSessionHelpers({
      readWorkspaceState: async () => ({}),
      writeWorkspaceState: async () => {},
      discoverAgents: async () => [{ id: AGENT }],
      enrichAgent: async (agent) => agent,
      startManagedAgent: async () => ({ ok: true }),
      waitForManagedRuntimeReady: async () => true,
      getInflightDeleteSessionIds: () => ['s1', 's3'],
    });
    const result = await helpers.listPrebuiltSessions(AGENT, { forceRich: true });
    assert.deepEqual(result.sessions.map((s) => s.id).sort(), ['s2']);
    assert.equal(result.activeSessionId, 's2', 'active 不在被过滤集时保持原值');
  });

  test('未注入 getInflightDeleteSessionIds：不过滤（向后兼容最小装配）', async () => {
    helpers = createSessionHelpers({
      readWorkspaceState: async () => ({}),
      writeWorkspaceState: async () => {},
      discoverAgents: async () => [{ id: AGENT }],
      enrichAgent: async (agent) => agent,
      startManagedAgent: async () => ({ ok: true }),
      waitForManagedRuntimeReady: async () => true,
    });
    const result = await helpers.listPrebuiltSessions(AGENT);
    assert.equal(result.sessions.length, 3);
  });
});

describe('excludeInflightDeleteSessions 纯函数边界', () => {
  const base = {
    revision: 7,
    activeSessionId: 'a',
    sessionTotal: 3,
    sessions: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
  };

  test('空数组 / 非数组 / 全空 id：列表内容与字段原样', () => {
    assert.deepEqual(excludeInflightDeleteSessions(base, []).sessions, base.sessions);
    assert.deepEqual(excludeInflightDeleteSessions(base, null).sessions, base.sessions);
    assert.deepEqual(excludeInflightDeleteSessions(base, ['', '  ']).sessions, base.sessions);
    assert.equal(excludeInflightDeleteSessions(base, []).revision, 7);
  });

  test('无交集：列表与 activeSessionId 不变；命中：仅移除命中的成员', () => {
    const untouched = excludeInflightDeleteSessions(base, ['zz']);
    assert.deepEqual(untouched.sessions.map((s) => s.id), ['a', 'b', 'c']);
    assert.equal(untouched.activeSessionId, 'a');

    const filtered = excludeInflightDeleteSessions(base, ['b', 'zz']);
    assert.deepEqual(filtered.sessions.map((s) => s.id), ['a', 'c']);
    assert.equal(filtered.activeSessionId, 'a');
    assert.equal(filtered.sessionTotal, 3, '分页计数保持原值（瞬时偏 1 由事务完成恢复）');
  });
});
