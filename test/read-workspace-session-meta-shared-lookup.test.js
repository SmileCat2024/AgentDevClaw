/**
 * readWorkspaceSessionMeta 的共享索引查找契约（ga 慢路径修复 + ADR-0036）：
 * ga 每轮对每个 runtime / 侧栏线程 head 调用本函数。历史上它每次
 * readSessionIndex（全量索引 structuredClone）+ 线性 find——PH 索引
 * 数千会话，clone × 调用次数曾实测打满事件循环（gaRuntime 段
 * p50 ~166ms）。修复后经 findPrebuiltSessionRecordShared（存储层共享
 * 索引 + 记录 Map）解析，且直接调用、不经 sessionApi 注入——隔离装配的
 * discovery 实例（sessionApi 为空引用对象，ph-project-frontend-projection
 * 契约）也必须能解析。
 *
 * 本测试锁定行为契约（经真实存储层验证，非 stub）：
 * - record 字段经 sessionRecordToWorkspaceMeta 正确透传（标题/归属/目录）
 * - 找不到记录 / 空 sessionId 时保持 emptyMeta 语义
 * - 空 sessionId 不产生存储副作用（不建库/不建目录）
 * - 索引写动后后续调用解析到新记录（本函数不做结果缓存）
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-rwss-meta-'));
process.env.AGENTDEV_DATA_DIR = DATA_ROOT;

const { createAgentDiscoveryModule } = await import('../server/routes/agent-discovery.js');
const {
  writeSessionIndex, updateSessionIndex, closeAllSessionDbs,
  getPrebuiltAgentSessionDir,
} = await import('../server/shared/session-access.js');

// sessionApi 传空引用对象：锁定"不经 sessionApi 注入"的装配契约。
const mod = createAgentDiscoveryModule({ sessionApi: {} });

before(async () => {
  await writeSessionIndex('programming-helper', {
    revision: 1,
    activeSessionId: 'sess-1',
    sessions: [{
      id: 'sess-1',
      title: '修复侧栏轮询',
      formId: null,
      agentName: '编程小助手',
      openDirectory: 'D:\\code\\AgentDevClaw',
      projectId: 'proj-42',
      sessionType: 'main',
      workspaceAgentId: 'main',
    }],
  });
});

after(() => {
  closeAllSessionDbs(); // Windows 下打开的 db 句柄会让 rmSync 报 EBUSY
  fs.rmSync(DATA_ROOT, { recursive: true, force: true });
});

describe('readWorkspaceSessionMeta: shared-index lookup contract', () => {
  it('resolves meta fields through findPrebuiltSessionRecordShared', async () => {
    const meta = await mod.readWorkspaceSessionMeta('programming-helper', 'sess-1');
    assert.equal(meta.active_workspace_session_id, 'sess-1');
    assert.equal(meta.active_workspace_session_title, '修复侧栏轮询');
    assert.equal(meta.active_workspace_agent_name, '编程小助手');
    assert.equal(meta.open_directory, 'D:\\code\\AgentDevClaw');
    assert.equal(meta.project_id, 'proj-42');
    assert.equal(meta.active_workspace_session_form_id, null);
  });

  it('returns the route emptyMeta after a missing lookup without throwing', async () => {
    const meta = await mod.readWorkspaceSessionMeta('coder', 'nope');
    assert.equal(meta.active_workspace_session_id, 'nope');
    assert.equal(meta.active_workspace_session_title, '');
    assert.equal(meta.project_id, '');
  });

  it('returns emptyMeta early for empty sessionId without storage side effects', async () => {
    // 空 sessionId 早退不触发索引查找：可观察副作用 = 不为该 agent 建目录/库
    const agent = 'empty-session-id-agent';
    const meta = await mod.readWorkspaceSessionMeta(agent, '');
    assert.equal(meta.active_workspace_session_id, null);
    assert.equal(meta.active_workspace_session_title, '');
    assert.equal(fs.existsSync(getPrebuiltAgentSessionDir(agent)), false, '空 sessionId 不得触发存储副作用');
  });

  it('reflects record changes across repeated calls (no result caching)', async () => {
    // ga 的 runtime 循环每轮对每个 runtime 各调一次；索引写动后
    // （readSessionIndexShared 返回新对象 → 新记录 Map），后续调用必须
    // 解析到新记录——本函数不得引入跨调用的结果缓存。
    await writeSessionIndex('coder', {
      revision: 1,
      activeSessionId: 'head-1',
      sessions: [{ id: 'head-1', title: '线程头会话', openDirectory: '', sessionType: 'main', workspaceAgentId: 'main' }],
    });
    const first = await mod.readWorkspaceSessionMeta('coder', 'head-1');
    assert.equal(first.active_workspace_session_title, '线程头会话');
    await updateSessionIndex('coder', (index) => ({
      ...index,
      sessions: index.sessions.map((s) => (s.id === 'head-1' ? { ...s, title: '线程头会话（新标题）' } : s)),
    }));
    const second = await mod.readWorkspaceSessionMeta('coder', 'head-1');
    assert.equal(second.active_workspace_session_title, '线程头会话（新标题）');
  });
});
