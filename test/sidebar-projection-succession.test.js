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
// 升格后该风险结构消解：coder 条目 = APP 条目（metadata 驱动，恒在），
// runtime 只产生 APP 之下的叶子；接续窗口消失的只是叶子，不是面板。
//
// 本测试按接续时序逐帧驱动 getConnectedAgents，断言 APP 条目全程存续、
// 全库不再出现任何合成身份条目（'programming-helper:coder' 词汇退役）。

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

function createQuery({ viewerAgents = [] } = {}) {
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

// ── 接续时序：APP 条目全程存续，叶子随生命周期涨落 ────────────────────────

describe('coder APP 条目在接续窗口的存续', () => {
  it('稳态 → 旧 head 退役 → successor 生成 → ready，APP 条目每帧都在', async () => {
    // F0 稳态：旧 head runtime 在线（viewer child + managed 记录）。
    setManaged(coderRuntimeRecord({ key: 'old', viewerAgentId: 'agent-old' }));
    const f0 = await createQuery({
      viewerAgents: [viewerAgent('agent-old')],
    }).getConnectedAgents();
    assert.ok(coderAppEntry(f0), 'F0 稳态：APP 条目应在');
    assert.equal(coderAppEntry(f0).visibility, 'on-demand');
    assert.equal(coderAppEntry(f0).host, 'programming-helper');
    assert.equal(coderChildEntries(f0).length, 1, 'F0 稳态：旧 head 是 coder 名下叶子');
    assert.equal(coderChildEntries(f0)[0].sidebar_entry_id, 'coder');

    // F1 旧 head 退役中：stopManagedAgent 已置 stopping，viewer 列表剔除该
    // runtime；接续挡板已立（rotate 先 begin 后 stop）。叶子消失，面板在。
    setManaged(coderRuntimeRecord({ key: 'old', viewerAgentId: 'agent-old', stopping: true }));
    const f1 = await createQuery({
      viewerAgents: [viewerAgent('agent-old')],
    }).getConnectedAgents();
    assert.ok(coderAppEntry(f1), 'F1 退役中：APP 条目不应消失');
    assert.equal(coderChildEntries(f1).length, 0, 'F1 退役中：runtime 叶子已剔除');

    // F2 空窗：旧 runtime 已停，successor 尚在 compact/摘要中未进
    // managedAgents——旧模型下用户看到「啪一下就没了」的帧。
    setManaged();
    const f2 = await createQuery({ viewerAgents: [] }).getConnectedAgents();
    assert.ok(coderAppEntry(f2), 'F2 空窗：APP 条目由 metadata 驱动，不随 runtime 消失');
    assert.equal(coderChildEntries(f2).length, 0);

    // F3 successor 已 spawn 未注册 viewer：managedAgents 新记录（第二来源）。
    setManaged(coderRuntimeRecord({ key: 'new', viewerAgentId: 'agent-new' }));
    const f3 = await createQuery({ viewerAgents: [] }).getConnectedAgents();
    assert.ok(coderAppEntry(f3), 'F3 successor spawn：APP 条目应在');

    // F4 successor ready：viewer child 上线，回到稳态形态。
    const f4 = await createQuery({
      viewerAgents: [viewerAgent('agent-new')],
    }).getConnectedAgents();
    assert.ok(coderAppEntry(f4), 'F4 ready：APP 条目应在');
    assert.equal(coderChildEntries(f4).length, 1, 'F4 ready：successor 成为 coder 名下叶子');
    assert.equal(coderChildEntries(f4)[0].sidebar_entry_id, 'coder');

    // 全程不出现任何合成身份条目（ADR-0025 词汇退役）
    for (const frame of [f0, f1, f2, f3, f4]) {
      assert.ok(!frame.some((e) => e.id === 'programming-helper:coder'),
        '不得出现 programming-helper:coder 合成条目');
    }
  });

  it('闲置（无线程挡板且无存活 runtime）时 APP 条目仍在（存在性不再依赖运行态）', async () => {
    setManaged();
    const list = await createQuery({ viewerAgents: [] }).getConnectedAgents();
    const entry = coderAppEntry(list);
    assert.ok(entry, 'APP 条目恒在：显示与否由前端 visibility 策略决定，服务端不下发存在性摇摆');
    assert.ok('hasThreadDomain' in entry, 'on-demand 条目携带线程域判定事实字段');
    assert.equal(coderChildEntries(list).length, 0);
  });

  it('宿主（编程小助手）条目不再携带并列身份投影', async () => {
    setManaged();
    const list = await createQuery({ viewerAgents: [] }).getConnectedAgents();
    const ph = list.find((entry) => entry.source === 'prebuilt' && entry.id === 'programming-helper');
    assert.ok(ph);
    assert.equal(ph.identities, undefined, '会话身份投影机制已退役');
  });
});
