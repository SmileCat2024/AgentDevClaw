import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConnectedAgentsQuery } from '../server/routes/agent-connected.js';

// ── 会话操作事实的 wire 投影契约（ADR-0049，回归锚）──
// 历史事故：sessionOps 事实迁到 metadata 声明后，本投影（前端 allAgents
// 的主源）未同步携带该字段，前端 sessionOpsAllowed() 恒 false——全部 APP
// 的会话操作菜单静默消失（侧栏线程叶子降级线程语义 fallback、首页会话
// 列表右键为空、⋯ 按钮不开）。前端测试夹具手造 allAgents 测不到这一层，
// 断链只能在此处锚定：声明 APP 必须下发 sessionOps:true，未声明显式 false。

function buildQuery(agentsLight) {
  const { getConnectedAgents } = createConnectedAgentsQuery({
    getAgentsLight: async () => agentsLight,
    readActiveWorkspaceSessionMeta: async () => ({
      workspaceSessions: { activeSessionId: null, sessions: [] },
      sessionMeta: {},
    }),
    readWorkspaceSessionMeta: async () => ({}),
    readViewerJson: async () => ({ agents: [] }),
    getPendingInputCount: async () => 0,
    resolveAgentModelPresets: async () => [],
    resolveThreadControl: () => ({
      core: { listThreads: async () => [] },
      archive: { list: async () => ({}) },
    }),
  });
  return getConnectedAgents;
}

test('declared sessionOps app is projected with sessionOps:true on the wire', async () => {
  const getConnectedAgents = buildQuery([
    { id: 'programming-helper', name: '智能编码空间', description: '', status: {}, sessionOps: true },
  ]);
  const agents = await getConnectedAgents();
  const ph = agents.find((a) => a.id === 'programming-helper');
  assert.ok(ph, 'app record projected');
  assert.equal(ph.sessionOps, true, 'declared sessionOps fact must survive the wire projection');
});

test('undeclared app is projected with explicit sessionOps:false', async () => {
  const getConnectedAgents = buildQuery([
    { id: 'memo', name: 'Memo', description: '', status: {} },
  ]);
  const agents = await getConnectedAgents();
  const memo = agents.find((a) => a.id === 'memo');
  assert.ok(memo, 'app record projected');
  assert.equal(memo.sessionOps, false, 'undeclared apps get an explicit false, never an undefined');
});
