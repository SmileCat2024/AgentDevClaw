// 工作空间设置（ADR-0025）：用户覆盖层存储 + on-demand 入口可见性合流。
// Coder 未归档线程资产与存活 Runtime 都能支撑入口显示。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import {
  readWorkspaceVisibilityOverrides,
  writeWorkspaceVisibilityOverride,
  writeWorkspacePermissionValue,
} from '../server/routes/workspace-settings.js';
import { createConnectedAgentsQuery } from '../server/routes/agent-connected.js';
import { managedAgents } from '../server/shared/agent-access.js';

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'claw-ws-settings-'));
const settingsPath = path.join(tmpRoot, 'workspace-settings.json');
after(async () => { await fs.rm(tmpRoot, { recursive: true, force: true }); });

describe('workspace-settings: 用户覆盖层存储', () => {
  it('permission-item writer updates and clears the shared Coder policy value', async () => {
    const { readWorkspaceResourcePolicies } = await import('../server/routes/workspace-settings.js');
    await writeWorkspacePermissionValue('coder', 'maxLiveThreads', 5, { settingsPath });
    assert.deepEqual(await readWorkspaceResourcePolicies({ settingsPath }), {
      coder: { maxLiveThreads: 5 },
    });
    await writeWorkspacePermissionValue('coder', 'maxLiveThreads', null, { settingsPath });
    assert.deepEqual(await readWorkspaceResourcePolicies({ settingsPath }), {});
  });

  it('rejects unknown permission items and invalid typed values', async () => {
    await assert.rejects(
      writeWorkspacePermissionValue('coder', 'unknown', true, { settingsPath }),
      (error) => error.status === 400,
    );
    await assert.rejects(
      writeWorkspacePermissionValue('coder', 'maxLiveThreads', '5', { settingsPath }),
      (error) => error.status === 400,
    );
  });
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
// 自动显示由 managed runtime 存活事实或未归档线程资产支撑。

function lightAgents() {
  return [
    { id: 'programming-helper', name: '智能编码空间', kind: 'agent', status: { pid: null, viewerAgentId: null } },
    { id: 'coder', name: 'coder', kind: 'agent', host: 'programming-helper', visibility: 'on-demand', permissions: ['maxLiveThreads'], status: { pid: null, viewerAgentId: null } },
  ];
}

function createQuery(overrides, threadSummaries = [], archiveEntries = {}, threadRecords = {}) {
  return createConnectedAgentsQuery({
    getAgentsLight: async () => lightAgents(),
    readActiveWorkspaceSessionMeta: async () => ({ workspaceSessions: { sessions: [] }, sessionMeta: {} }),
    readWorkspaceSessionMeta: async () => ({}),
    readViewerJson: async (pathname) => (pathname === '/api/agents' ? { agents: [] } : {}),
    getPendingInputCount: async () => 0,
    resolveAgentModelPresets: async () => ({}),
    readVisibilityOverrides: async () => overrides,
    resolveThreadControl: () => ({
      // 生产形状：listThreads 返回 index 摘要（不含 deleting），deleting 只在全量记录上
      core: {
        listThreads: async () => threadSummaries,
        getThread: async (threadId) => threadRecords[threadId]
          ?? threadSummaries.find((thread) => thread.threadId === threadId)
          ?? null,
      },
      archive: { list: async () => archiveEntries },
    }),
  });
}

describe('workspace-settings: on-demand Runtime 存活合流（服务端）', () => {
  it('无覆盖且没有存活 Runtime → sidebarVisible=false', async () => {
    const agents = await createQuery({}).getConnectedAgents();
    const coder = agents.find((a) => a.id === 'coder');
    assert.deepEqual(coder.permissions, ['maxLiveThreads']);
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

  it('存活且绑定会话的 Runtime 显示入口；未归档线程资产不撑入口', async () => {
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
      const threadAsset = await createQuery({}, ordinaryThread).getConnectedAgents();
      assert.equal(threadAsset.find((a) => a.id === 'coder').sidebarVisible, false,
        '未归档的 open 线程资产不代表运行态，不撑入口（ADR-0025 回摆）');

      managedAgents.set('coder::live', runtime('session-live'));
      assert.equal((await createQuery({}).getConnectedAgents()).find((a) => a.id === 'coder').sidebarVisible, true);

      managedAgents.set('coder::stopping', runtime('session-stopping', { stopping: true }));
      assert.equal((await createQuery({}).getConnectedAgents()).find((a) => a.id === 'coder').sidebarVisible, true,
        '另一个仍存活的 Runtime 仍使入口显示');
      managedAgents.delete('coder::live');
      assert.equal((await createQuery({}, []).getConnectedAgents()).find((a) => a.id === 'coder').sidebarVisible, false,
        '仅剩 stopping Runtime 且无线程资产时不显示');

      managedAgents.set('coder::no-session', runtime(null));
      assert.equal((await createQuery({}).getConnectedAgents()).find((a) => a.id === 'coder').sidebarVisible, false,
        '未绑定 Session 的进程不构成运行会话');
    } finally {
      managedAgents.clear();
    }
  });

  it('仅 rotating 接续挡板撑入口；其余资产态（open/hold）、归档、deleting、closed 均不显示', async () => {
    managedAgents.clear();
    const thread = (threadId, overrides = {}) => ({ threadId, agentId: 'coder', status: 'open', ...overrides });

    // 资产态不撑入口：open / hold 都不代表运行态
    for (const candidate of [
      thread('wt-open'),
      thread('wt-hold', { hold: true }),
    ]) {
      const hidden = await createQuery({}, [candidate]).getConnectedAgents();
      assert.equal(hidden.find((a) => a.id === 'coder').sidebarVisible, false, `${candidate.threadId} 不显示入口`);
    }

    // deleting 只写在全量记录（index 摘要与普通 open 线程无异），经 getThread 排除
    const deletingRecords = { 'wt-deleting': thread('wt-deleting', { deleting: true }) };
    const hiddenCases = [
      { threads: [thread('wt-archived')], archives: { 'wt-archived': { archivedAt: 1 } } },
      { threads: [thread('wt-deleting')], records: deletingRecords },
      { threads: [thread('wt-closed', { status: 'closed' })] },
    ];
    for (const { threads, archives = {}, records = {} } of hiddenCases) {
      const result = await createQuery({}, threads, archives, records).getConnectedAgents();
      assert.equal(result.find((a) => a.id === 'coder').sidebarVisible, false);
    }

    const rotating = [thread('wt-barrier', { status: 'rotating' })];
    const visible = await createQuery({}, rotating).getConnectedAgents();
    assert.equal(visible.find((a) => a.id === 'coder').sidebarVisible, true, 'rotating 接续挡板保留入口');

    // 删除事务窗口内的 rotating 挡板不撑入口
    const deletingRotating = { 'wt-barrier': thread('wt-barrier', { deleting: true }) };
    const result = await createQuery({}, rotating, {}, deletingRotating).getConnectedAgents();
    assert.equal(result.find((a) => a.id === 'coder').sidebarVisible, false, 'deleting 的 rotating 挡板不撑入口');
  });
});
