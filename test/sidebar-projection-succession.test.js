import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createConnectedAgentsQuery } from '../server/routes/agent-connected.js';
import { managedAgents } from '../server/shared/agent-access.js';

// ── 语境 ──────────────────────────────────────────────────────────────────
// thread-rotation.rotate 的真实顺序：beginSessionSuccession（立挡板）→
// stopManagedAgent（旧 head runtime 退役，stopping=true 当次轮询即从
// viewer 列表剔除）→ compactAndResumeCurrentSession（LLM 摘要，10s+）→
// startManagedAgent（successor runtime 进 managedAgents）→ commitSuccession。
//
// 退役到 successor 上线之间，runtime 层的三个存活来源（viewer child /
// managedAgents 进程 / 远程 catalog）全部落空。ADR-0025 之前 coder 面板
// 是「身份投影条目」，跟着存活来源消失——轮询采样到空窗帧时整树蒸发。
// APP 入口由 metadata 与 on-demand 策略控制；实际存活的 Runtime 决定
// 自动显示，Runtime 只产生 APP 之下的会话叶子。接续窗口（rotating 挡板
// 在途）是无感连续的一部分：挡板是持久化事务事实，空窗帧期间撑住入口，
// 让前端接续占位（disconnected 过渡条目）保持可见；普通未归档线程
// （无挡板、无 Runtime）不代表运行态，不撑入口。
//
// 本测试按接续时序逐帧驱动 getConnectedAgents，断言入口可见性跟随
// 「Runtime 存活或接续挡板在途」，且全库不再出现任何合成身份条目
// （'programming-helper:coder' 词汇退役）。

function phAgentLight() {
  return {
    id: 'programming-helper',
    name: '智能编码空间',
    kind: 'agent',
    status: { pid: null, viewerAgentId: null },
  };
}

function coderAgentLight() {
  return {
    id: 'coder',
    name: 'coder',
    kind: 'agent',
    host: 'programming-helper',
    visibility: 'on-demand',
    status: { pid: null, viewerAgentId: null },
  };
}

function coderRuntimeRecord({ key, viewerAgentId, stopping = false, stopped = false }) {
  return {
    key,
    id: 'coder',
    agentId: 'coder',
    selectedSessionId: `sess-${key}`,
    viewerAgentId,
    process: { exitCode: stopped ? 0 : null, pid: 424242 },
    stopped,
    stopping,
  };
}

function viewerAgent(id) {
  return { id, connected: true, name: 'coder-runtime' };
}

function createQuery({ viewerAgents = [], visibilityOverrides = {}, threadSummaries = [], archiveEntries = {} } = {}) {
  return createConnectedAgentsQuery({
    getAgentsLight: async () => [phAgentLight(), coderAgentLight()],
    readActiveWorkspaceSessionMeta: async () => ({
      workspaceSessions: { sessions: [] },
      sessionMeta: {},
    }),
    readWorkspaceSessionMeta: async () => ({}),
    readViewerJson: async (pathname) => (pathname === '/api/agents'
      ? { agents: viewerAgents }
      : {}),
    getPendingInputCount: async () => 0,
    resolveAgentModelPresets: async () => ({}),
    // 测试隔离：不读真实用户数据目录的 workspace-settings.json
    readVisibilityOverrides: async () => visibilityOverrides,
    // 测试隔离：线程控制面注入（listThreads 摘要 + 归档索引；生产形状：
    // deleting 只在全量记录上，摘要层经 getThread 复核）
    resolveThreadControl: () => ({
      core: {
        listThreads: async () => threadSummaries,
        getThread: async (threadId) => threadSummaries.find((thread) => thread.threadId === threadId) ?? null,
      },
      archive: { list: async () => archiveEntries },
    }),
  });
}

function coderAppEntry(list) {
  return list.find((entry) => entry.source === 'prebuilt' && entry.id === 'coder') || null;
}

function coderChildEntries(list) {
  return list.filter((entry) => entry.source === 'child' && entry.parent_id === 'coder');
}

function setManaged(...records) {
  managedAgents.clear();
  for (const record of records) managedAgents.set(record.key, record);
}

afterEach(() => {
  managedAgents.clear();
});

// ── 接续时序：默认 auto 下入口 = Runtime 存活 ∨ 接续挡板在途 ─────────────

describe('coder APP 条目在接续窗口的存续', () => {
  it('稳态 → 旧 head 退役 → successor 生成 → ready，接续空窗不隐藏入口', async () => {
    const rotatingBarrier = [{ threadId: 'wt-a', agentId: 'coder', status: 'rotating' }];
    // F0 稳态：旧 head runtime 在线（viewer child + managed 记录）。
    setManaged(coderRuntimeRecord({ key: 'old', viewerAgentId: 'agent-old' }));
    const f0 = await createQuery({
      viewerAgents: [viewerAgent('agent-old')],
    }).getConnectedAgents();
    assert.ok(coderAppEntry(f0), 'F0 稳态：存活 Runtime 对应入口应在');
    assert.equal(coderAppEntry(f0).sidebarVisible, true);
    assert.equal(coderAppEntry(f0).visibility, 'on-demand');
    assert.equal(coderAppEntry(f0).host, 'programming-helper');
    assert.equal(coderChildEntries(f0).length, 1, 'F0 稳态：旧 head 是 coder 名下叶子');
    assert.equal(coderChildEntries(f0)[0].sidebar_entry_id, 'coder');

    // F1 旧 head 退役中：rotate 先 begin（挡板立，status=rotating）后 stop
    // （stopping=true，viewer 列表剔除该 runtime）。runtime 叶子消失，但
    // 接续挡板是持久化事务事实——入口保持，无感连续不被打破。
    setManaged(coderRuntimeRecord({ key: 'old', viewerAgentId: 'agent-old', stopping: true }));
    const f1 = await createQuery({
      viewerAgents: [viewerAgent('agent-old')],
      threadSummaries: rotatingBarrier,
    }).getConnectedAgents();
    assert.equal(coderAppEntry(f1).sidebarVisible, true, 'F1 退役中：接续挡板在途撑住入口');
    assert.equal(coderChildEntries(f1).length, 0, 'F1 退役中：runtime 叶子已剔除');

    // F2 空窗：旧 runtime 已停，successor 尚在 compact/摘要中未进
    // managedAgents——三个存活来源全部落空。挡板仍在途，入口不闪失，
    // 前端接续占位（disconnected 过渡条目）保持可见。
    setManaged();
    const f2 = await createQuery({ viewerAgents: [], threadSummaries: rotatingBarrier }).getConnectedAgents();
    assert.equal(coderAppEntry(f2).sidebarVisible, true, 'F2 空窗：接续挡板在途，入口不隐藏');
    assert.equal(coderChildEntries(f2).length, 0);

    // F3 successor 已 spawn 未注册 viewer：managedAgents 新记录（第二来源）。
    setManaged(coderRuntimeRecord({ key: 'new', viewerAgentId: 'agent-new' }));
    const f3 = await createQuery({ viewerAgents: [] }).getConnectedAgents();
    assert.equal(coderAppEntry(f3).sidebarVisible, true, 'F3 successor 已存活且绑定 Session，入口显示');

    // F4 successor ready：viewer child 上线，回到稳态形态（挡板已清，
    // thread status 离开 rotating，入口由 successor Runtime 撑住）。
    const settledThread = [{ threadId: 'wt-a', agentId: 'coder', status: 'executing' }];
    setManaged(coderRuntimeRecord({ key: 'new', viewerAgentId: 'agent-new' }));
    const f4 = await createQuery({
      viewerAgents: [viewerAgent('agent-new')],
      threadSummaries: settledThread,
    }).getConnectedAgents();
    assert.equal(coderAppEntry(f4).sidebarVisible, true, 'F4 ready：入口显示');
    assert.equal(coderChildEntries(f4).length, 1, 'F4 ready：successor 成为 coder 名下叶子');
    assert.equal(coderChildEntries(f4)[0].sidebar_entry_id, 'coder');

    // F5 终态对照：runtime 全停且挡板已清——未归档线程是资产，仍撑住入口；
    // 真正无资产（无线程）时 auto 隐藏。
    setManaged();
    const f5 = await createQuery({ viewerAgents: [], threadSummaries: settledThread }).getConnectedAgents();
    assert.equal(coderAppEntry(f5).sidebarVisible, true, 'F5：runtime 全停但未归档线程在，入口保留（资产驱动）');
    const f5empty = await createQuery({ viewerAgents: [], threadSummaries: [] }).getConnectedAgents();
    assert.equal(coderAppEntry(f5empty).sidebarVisible, false, 'F5：无线程无挡板无 runtime，auto 入口隐藏');

    // 全程不出现任何合成身份条目（ADR-0025 词汇退役）
    for (const frame of [f0, f1, f2, f3, f4, f5]) {
      assert.ok(!frame.some((e) => e.id === 'programming-helper:coder'),
        '不得出现 programming-helper:coder 合成条目');
    }
  });

  it('无 Runtime 无线程资产时 auto 隐藏入口；未归档线程资产保留入口；always 覆盖仍可找回 APP', async () => {
    setManaged();
    const autoList = await createQuery({
      viewerAgents: [],
      threadSummaries: [],
    }).getConnectedAgents();
    const autoEntry = coderAppEntry(autoList);
    assert.ok(autoEntry);
    assert.equal(autoEntry.sidebarVisible, false, '无任何线程资产时 auto 隐藏');
    assert.equal(coderChildEntries(autoList).length, 0);

    // 未归档线程是可寻址资产（C4）：入口必须保留，用户才能发现并唤醒它
    const assetList = await createQuery({
      viewerAgents: [],
      threadSummaries: [{ threadId: 'wt-idle', agentId: 'coder', status: 'open' }],
    }).getConnectedAgents();
    assert.equal(coderAppEntry(assetList).sidebarVisible, true, '存在未归档线程资产时入口保留');

    const alwaysList = await createQuery({ viewerAgents: [], visibilityOverrides: { coder: 'always' } }).getConnectedAgents();
    assert.equal(coderAppEntry(alwaysList).sidebarVisible, true);
    assert.equal(coderChildEntries(alwaysList).length, 0, '显示 APP 不会凭空创建运行会话叶子');
  });

  it('宿主（编程小助手）条目不再携带并列身份投影', async () => {
    setManaged();
    const list = await createQuery({ viewerAgents: [] }).getConnectedAgents();
    const ph = list.find((entry) => entry.source === 'prebuilt' && entry.id === 'programming-helper');
    assert.ok(ph);
    assert.equal(ph.identities, undefined, '会话身份投影机制已退役');
  });
});
