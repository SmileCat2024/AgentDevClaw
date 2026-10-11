// 工作空间设置（ADR-0025 收尾）：用户覆盖层存储 + on-demand 存在性合流。
//
// 语义锚（用户拍板）："自动" = 有运行中的会话（非终态且未归档的线程）才
// 显示；与该工作空间名下有哪些历史/已结束/已归档会话完全无关。closed 或
// 已归档的线程不撑显示；入口消失后的找回路径是「始终显示」覆盖。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import {
  readWorkspaceVisibilityOverrides,
  writeWorkspaceVisibilityOverride,
} from '../server/routes/workspace-settings.js';
import { createConnectedAgentsQuery } from '../server/routes/agent-connected.js';

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'claw-ws-settings-'));
const settingsPath = path.join(tmpRoot, 'workspace-settings.json');
after(async () => { await fs.rm(tmpRoot, { recursive: true, force: true }); });

describe('workspace-settings: 用户覆盖层存储', () => {
  it('缺省为空表（ENOENT 不抛错）；写入 always 后可读回；回 auto 即删除覆盖', async () => {
    assert.deepEqual(await readWorkspaceVisibilityOverrides({ settingsPath }), {});

    await writeWorkspaceVisibilityOverride('coder', 'always', { settingsPath });
    assert.deepEqual(await readWorkspaceVisibilityOverrides({ settingsPath }), { coder: 'always' });

    // auto = 回到作者默认（覆盖表删条），不是显式存储 'auto'
    await writeWorkspaceVisibilityOverride('coder', 'auto', { settingsPath });
    assert.deepEqual(await readWorkspaceVisibilityOverrides({ settingsPath }), {});
  });

  it('非法入参被拒绝（400 语义）', async () => {
    await assert.rejects(() => writeWorkspaceVisibilityOverride('', 'always', { settingsPath }), /agentId/);
    await assert.rejects(() => writeWorkspaceVisibilityOverride('coder', 'sometimes', { settingsPath }), /policy/);
  });
});

// ── 合流判定（wire 组装）─────────────────────────────────────────
// 线程事实经注入缝构造：open（运行中）/ closed（终态）/ archived（归档标记）
// 三类摘要驱动「有运行中的会话」判定。

function lightAgents() {
  return [
    { id: 'programming-helper', name: '智能编码空间', kind: 'agent', status: { pid: null, viewerAgentId: null } },
    { id: 'coder', name: 'coder', kind: 'agent', host: 'programming-helper', visibility: 'on-demand', status: { pid: null, viewerAgentId: null } },
  ];
}

function createQuery(overrides, threadSummaries = [], archiveEntries = {}) {
  return createConnectedAgentsQuery({
    getAgentsLight: async () => lightAgents(),
    readActiveWorkspaceSessionMeta: async () => ({ workspaceSessions: { sessions: [] }, sessionMeta: {} }),
    readWorkspaceSessionMeta: async () => ({}),
    readViewerJson: async (pathname) => (pathname === '/api/agents' ? { agents: [] } : {}),
    getPendingInputCount: async () => 0,
    resolveAgentModelPresets: async () => ({}),
    readVisibilityOverrides: async () => overrides,
    resolveThreadControl: () => ({
      core: { listThreads: async () => threadSummaries },
      archive: { list: async () => archiveEntries },
    }),
  });
}

describe('workspace-settings: on-demand 存在性合流（服务端）', () => {
  it('无覆盖（作者默认 auto）且无线程 → sidebarVisible=false', async () => {
    const agents = await createQuery({}).getConnectedAgents();
    const coder = agents.find((a) => a.id === 'coder');
    assert.equal(coder.visibilityPolicy, 'auto');
    assert.equal(typeof coder.hasRunningSessions, 'boolean');
    assert.equal(coder.sidebarVisible, coder.hasRunningSessions);
    // persistent 工作空间不带 on-demand 字段（恒显示）
    const ph = agents.find((a) => a.id === 'programming-helper');
    assert.equal(ph.sidebarVisible, undefined);
    assert.equal(ph.visibilityPolicy, undefined);
  });

  it('用户覆盖 always → sidebarVisible=true（入口找回路径）', async () => {
    const agents = await createQuery({ coder: 'always' }).getConnectedAgents();
    const coder = agents.find((a) => a.id === 'coder');
    assert.equal(coder.visibilityPolicy, 'always');
    assert.equal(coder.sidebarVisible, true);
  });

  it('open 线程 → 有运行中的会话；closed 与已归档不撑显示', async () => {
    const running = await createQuery({}, [
      { threadId: 'wt-open', workspaceId: 'coder', status: 'open' },
    ]).getConnectedAgents();
    assert.equal(running.find((a) => a.id === 'coder').sidebarVisible, true, 'open 线程 = 运行中');

    const closedOnly = await createQuery({}, [
      { threadId: 'wt-closed', workspaceId: 'coder', status: 'closed' },
    ]).getConnectedAgents();
    assert.equal(closedOnly.find((a) => a.id === 'coder').sidebarVisible, false, 'closed 线程不撑显示');

    const archivedOnly = await createQuery({}, [
      { threadId: 'wt-archived', workspaceId: 'coder', status: 'open' },
    ], { 'wt-archived': { archivedAt: 1 } }).getConnectedAgents();
    assert.equal(archivedOnly.find((a) => a.id === 'coder').sidebarVisible, false, '已归档线程不撑显示');

    const mixed = await createQuery({}, [
      { threadId: 'wt-closed-2', workspaceId: 'coder', status: 'closed' },
      { threadId: 'wt-archived-2', workspaceId: 'coder', status: 'open' },
      { threadId: 'wt-open-2', workspaceId: 'coder', status: 'open' },
    ], { 'wt-archived-2': { archivedAt: 1 } }).getConnectedAgents();
    assert.equal(mixed.find((a) => a.id === 'coder').sidebarVisible, true, '混集中有一条 open 未归档即运行中');
  });

  it('别的 workspace 的线程不算本 workspace 的运行中会话', async () => {
    const agents = await createQuery({}, [
      { threadId: 'wt-other', workspaceId: 'other-app', status: 'open' },
    ]).getConnectedAgents();
    assert.equal(agents.find((a) => a.id === 'coder').sidebarVisible, false);
  });
});
