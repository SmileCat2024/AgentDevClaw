// 工作空间设置（ADR-0025）：用户覆盖层存储 + on-demand Runtime 存活合流。
// 自动显示由实际存活的 managed Runtime 决定；持久线程历史本身不让左侧
// 运行态入口常驻。
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
import { managedAgents } from '../server/shared/agent-access.js';

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
// 自动显示取 managed runtime 的存活事实，不从持久线程状态推断运行态。

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

describe('workspace-settings: on-demand Runtime 存活合流（服务端）', () => {
  it('无覆盖且没有存活 Runtime → sidebarVisible=false', async () => {
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

  it('存活且绑定会话的 Runtime 显示入口；停止 Runtime 后普通线程不撑入口', async () => {
    const runtime = (sessionId, overrides = {}) => ({
      agentId: 'coder',
      selectedSessionId: sessionId,
      stopped: false,
      stopping: false,
      process: { exitCode: null, signalCode: null },
      ...overrides,
    });
    managedAgents.clear();
    try {
      const ordinaryThread = [{ threadId: 'wt-idle', agentId: 'coder', status: 'open' }];
      const noRuntime = await createQuery({}, ordinaryThread).getConnectedAgents();
      assert.equal(noRuntime.find((a) => a.id === 'coder').sidebarVisible, false,
        '普通可调度线程不代表 Runtime 正在运行');

      managedAgents.set('coder::live', runtime('session-live'));
      assert.equal((await createQuery({}).getConnectedAgents()).find((a) => a.id === 'coder').sidebarVisible, true);

      managedAgents.set('coder::stopping', runtime('session-stopping', { stopping: true }));
      assert.equal((await createQuery({}).getConnectedAgents()).find((a) => a.id === 'coder').sidebarVisible, true,
        '另一个仍存活的 Runtime 仍使入口显示');
      managedAgents.delete('coder::live');
      assert.equal((await createQuery({}, ordinaryThread).getConnectedAgents()).find((a) => a.id === 'coder').sidebarVisible, false,
        '仅剩 stopping Runtime 且无接续时不显示');

      managedAgents.set('coder::no-session', runtime(null));
      assert.equal((await createQuery({}).getConnectedAgents()).find((a) => a.id === 'coder').sidebarVisible, false,
        '未绑定 Session 的进程不构成运行会话');
    } finally {
      managedAgents.clear();
    }
  });

  it('真实 rotating 接续挡板在 Runtime 空窗期间保留入口；归档线程不保留', async () => {
    managedAgents.clear();
    const rotating = [{ threadId: 'wt-rotating', agentId: 'coder', status: 'rotating' }];
    const visible = await createQuery({}, rotating).getConnectedAgents();
    assert.equal(visible.find((a) => a.id === 'coder').sidebarVisible, true);

    const archived = await createQuery({}, rotating, { 'wt-rotating': { archivedAt: 1 } }).getConnectedAgents();
    assert.equal(archived.find((a) => a.id === 'coder').sidebarVisible, false);
  });
});
