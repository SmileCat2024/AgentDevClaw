import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConnectedAgentsQuery } from '../server/routes/agent-connected.js';

// ── 会话操作事实的 wire 投影契约（ADR-0049，回归锚）──
// 历史事故：sessionOps 事实迁到 metadata 声明后，本投影（前端 allAgents
// 的主源）未同步携带该字段，前端 sessionOpsAllowed() 恒 false——全部 APP
// 的会话操作菜单静默消失（侧栏线程叶子降级线程语义 fallback、首页会话
// 列表右键为空、⋯ 按钮不开）。前端测试夹具手造 allAgents 测不到这一层，
// 断链只能在此处锚定：声明 APP 必须下发 sessionOps:true，未声明显式 false。

function buildQuery(agentsLight, { sidebarSessionsOverrides = {} } = {}) {
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
    // ADR-0050 测试缝：注入隔离覆盖表（默认空表，不读真实用户数据目录）
    readSidebarSessionsOverrides: async () => sidebarSessionsOverrides,
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

// ── 侧栏会话区呈现策略的 wire 投影契约（ADR-0050，回归锚）──
// 与 sessionOps 同层断链风险：ctx-menu-items 的 workspace 菜单与
// sidebar-render 的呈现过滤都消费这两字段，投影缺字段 = 声明 APP 的
// 菜单项与隐藏能力静默消失。三形态必须在此锚定。

test('declared sidebarSessions app projects effective policy and user override fields', async () => {
  // 无覆盖：生效值 = 作者声明，用户覆盖为 null（菜单三态的「未覆盖」档）
  const getConnectedAgents = buildQuery([
    { id: 'memo', name: 'Memo', description: '', status: {}, sidebarSessions: 'visible' },
    { id: 'declared-hidden', name: 'Hidden', description: '', status: {}, sidebarSessions: 'hidden' },
  ]);
  const agents = await getConnectedAgents();
  assert.equal(agents.find((a) => a.id === 'memo').sidebarSessionsPolicy, 'visible',
    'declared visible with no override: effective policy follows the author default');
  assert.equal(agents.find((a) => a.id === 'memo').sidebarSessionsUserOverride, null);
  assert.equal(agents.find((a) => a.id === 'declared-hidden').sidebarSessionsPolicy, 'hidden');
  assert.equal(agents.find((a) => a.id === 'declared-hidden').sidebarSessionsUserOverride, null);
});

test('user override wins over author default in the projected effective policy', async () => {
  const getConnectedAgents = buildQuery(
    [{ id: 'memo', name: 'Memo', description: '', status: {}, sidebarSessions: 'visible' }],
    { sidebarSessionsOverrides: { memo: 'hidden' } },
  );
  const agents = await getConnectedAgents();
  const memo = agents.find((a) => a.id === 'memo');
  assert.equal(memo.sidebarSessionsPolicy, 'hidden', 'override drives the effective policy');
  assert.equal(memo.sidebarSessionsUserOverride, 'hidden', 'explicit override is surfaced for menu tri-state');
});

test('undeclared or invalid sidebarSessions apps project no policy fields', async () => {
  const getConnectedAgents = buildQuery([
    { id: 'programming-helper', name: '智能编码空间', description: '', status: {} },
    { id: 'broken', name: 'Broken', description: '', status: {}, sidebarSessions: 'sometimes' },
  ]);
  const agents = await getConnectedAgents();
  for (const id of ['programming-helper', 'broken']) {
    const record = agents.find((a) => a.id === id);
    assert.ok(record, `${id} projected`);
    assert.equal(record.sidebarSessionsPolicy, undefined, `${id} must not project policy fields`);
    assert.equal(record.sidebarSessionsUserOverride, undefined, `${id} must not project override fields`);
  }
});
