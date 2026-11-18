// 会话绝对隔离（ADR-0025 收尾续）：全局线程指向（activeConversation）不得
// 把别的会话的输入串到线程。三处防线：
//   1. getActiveThreadInputTarget：提交点消费的一致性校验入口——视图与
//      指向不符返回 null；
//   2. _syncActiveThreadSubscription 等待重绑豁免以宿主焦点为界：用户切
//      到别的工作空间后豁免失效，残留被重建清除；
//   3. openConversationTarget 接续等待分支传 awaitSessionId：点击侧栏接续
//      占位条目落在该会话的聊天加载表面，不落工作空间首页。
//
// 装载路线（P4 T3）：刷新引擎 thread-store.js 已迁 ESM，走真实 import
// （withThreadEngineCase：最小 classic 夹具 + case 级 ESM 图）。引擎内部操作
// （_syncActiveThreadSubscription）是命名导出，公开查询（getActiveThreadInputTarget）
// 经 thread-store-engine 桥键取用；状态键按 app-core 注册面上桥，夹具初值同一份真相。
import assert from 'node:assert/strict';
import test from 'node:test';
import { withThreadDomainCase } from './p2-thread-case.js';
import { withThreadEngineCase } from './helpers/thread-engine.js';

/** 经典夹具：宿主身份、运行时绑定、会话视图事实与渲染出口。 */
function fixturesFor({
  hostAgentId = 'programming-helper',
  runtimeId = 'rt-ph',
  runtimeSessionId = 'sess-A',
  viewIdentity = null,
} = {}) {
  return {
    currentLanguage: 'zh',
    getCurrentHostAgentRecord: () => ({ id: hostAgentId, source: 'prebuilt' }),
    readCurrentSessionViewState: () => ({ identity: viewIdentity }),
    applySessionViewPatch: () => {},
    captureSessionViewToken: () => ({}),
    commitSessionViewPatch: () => false,
    findSidebarOperation: () => null,
    switchAgent: () => Promise.resolve(),
    renderAgentList: () => {},
    updateQueueIndicator: () => {},
    lastRenderedWorkspaceHtml: '',
  };
}

const IDENTITY = 'public/src/modules/identity.js';

/**
 * 会话身份（P4 T1 起 owner 是 identity 域）：生产里 switchAgent 建立 viewer 侧
 * runtimeId → sessionId 绑定；用例按同一入口播种，不再给身份函数装同名桩。
 */
async function seedIdentity(c, runtimeId, sessionId) {
  if (!runtimeId || !sessionId) return null;
  const identity = await c.load(IDENTITY);
  identity.setViewerSessionBinding(runtimeId, sessionId);
  return identity;
}

/** 把全局线程指向写成用例给定的指向（状态写入只落唯一 ClawThreads）。 */
function setConversation(ctx, conversation) {
  ctx.window.ClawThreads.activeConversation = conversation;
}

// 接续窗口形态：服务端只在 status='rotating' 时补读 handoffStartedAt
// （thread-routes 的 _attachLifeState），两者在真实投影中始终成对出现。
// 不要写成 status='open' + 非零 startedAt——那不是任何真实状态。
const WT = {
  threadId: 'wt-1',
  agentId: 'coder',
  headSessionId: 'sess-head',
  status: 'rotating',
  handoffStartedAt: Date.now(),
  headViewerAgentId: 'viewer-1',
  sessionIds: ['sess-head', 'sess-old'],
};

test('getActiveThreadInputTarget：宿主已切走（残留指向他空间线程）→ null，输入不串线', async () => {
  await withThreadEngineCase({
    fixtures: fixturesFor({ hostAgentId: 'programming-helper' }),
    threads: [WT],
  }, async ({ c, ctx }) => {
    await seedIdentity(c, 'rt-ph', 'sess-A');
    setConversation(ctx, { agentId: 'coder', threadId: 'wt-1', sessionId: 'sess-head', runtimeId: '', wasHead: true });
    // 用户在 ph 会话 A 视图，全局残留指向 coder 线程
    ctx.currentRuntimeAgentId = 'rt-ph';
    ctx.focusedAgentId = 'programming-helper';
    assert.equal(ctx.window.getActiveThreadInputTarget(), null,
      '宿主不一致：残留不得作为输入目标');
  });
});

test('getActiveThreadInputTarget：视图确属该线程（head 健康 / 等待重绑）→ 返回指向', async () => {
  // head 健康：宿主 coder，runtime 绑定 head 会话，SessionView identity 挂该会话
  await withThreadEngineCase({
    fixtures: fixturesFor({
      hostAgentId: 'coder', runtimeId: 'rt-coder', runtimeSessionId: 'sess-head',
      viewIdentity: { agentId: 'coder', sessionId: 'sess-head' },
    }),
    threads: [WT],
  }, async ({ c, ctx }) => {
    await seedIdentity(c, 'rt-coder', 'sess-head');
    setConversation(ctx, { agentId: 'coder', threadId: 'wt-1', sessionId: 'sess-head', runtimeId: 'rt-coder', wasHead: true });
    ctx.currentRuntimeAgentId = 'rt-coder';
    ctx.focusedAgentId = 'coder';
    const r1 = ctx.window.getActiveThreadInputTarget();
    assert.ok(r1 && r1.threadId === 'wt-1', '视图一致：正常返回');
  });

  // 等待重绑：runtime 态被 404 清空，宿主焦点仍在 coder（_currentActiveSession 回退为指向自身）
  await withThreadEngineCase({
    fixtures: fixturesFor({
      hostAgentId: 'coder', runtimeId: '', runtimeSessionId: '',
      viewIdentity: { agentId: 'coder', sessionId: 'sess-head' },
    }),
    threads: [WT],
  }, async ({ ctx }) => {
    setConversation(ctx, { agentId: 'coder', threadId: 'wt-1', sessionId: 'sess-head', runtimeId: '', wasHead: true });
    ctx.currentRuntimeAgentId = '';
    ctx.focusedAgentId = 'coder';
    const r2 = ctx.window.getActiveThreadInputTarget();
    assert.ok(r2 && r2.threadId === 'wt-1', '等待重绑态：宿主一致 + 回退一致，返回指向');
  });
});

test('getActiveThreadInputTarget：视图已回工作空间首页（identity 无会话）→ null，残留不占高亮', async () => {
  // 用户从 coder 会话切回 coder 工作空间首页：runtime 态与 SessionView 会话
  // 身份被清空，但 activeConversation 残留（同宿主，_currentActiveSession 回
  // 退仍指向旧会话）。残留不得作为目标——宿主节点照常高亮，旧会话条目不
  // 残留选中（历史 bug：首页上旧会话条目常亮、宿主节点让位）。
  await withThreadEngineCase({
    fixtures: fixturesFor({ hostAgentId: 'coder', runtimeId: '', runtimeSessionId: '', viewIdentity: null }),
    threads: [WT],
  }, async ({ ctx }) => {
    setConversation(ctx, { agentId: 'coder', threadId: 'wt-1', sessionId: 'sess-head', runtimeId: '', wasHead: true });
    ctx.currentRuntimeAgentId = '';
    ctx.focusedAgentId = 'coder';
    assert.equal(ctx.window.getActiveThreadInputTarget(), null,
      '视图不在该会话上（首页）：残留指向不得作为输入/高亮目标');
  });

  // identity 挂在别的会话（用户已切到另一会话）同样拒绝
  await withThreadEngineCase({
    fixtures: fixturesFor({
      hostAgentId: 'coder', runtimeId: '', runtimeSessionId: '',
      viewIdentity: { agentId: 'coder', sessionId: 'sess-other' },
    }),
    threads: [WT],
  }, async ({ ctx }) => {
    setConversation(ctx, { agentId: 'coder', threadId: 'wt-1', sessionId: 'sess-head', runtimeId: '', wasHead: true });
    ctx.currentRuntimeAgentId = '';
    ctx.focusedAgentId = 'coder';
    assert.equal(ctx.window.getActiveThreadInputTarget(), null,
      '视图已挂到别的会话：残留指向不得作为目标');
  });
});

test('_syncActiveThreadSubscription：等待重绑豁免以宿主焦点为界——切走即清残留', async () => {
  // 宿主切走（ph）：豁免失效，activeConversation 重建为 threadId:''
  await withThreadEngineCase({
    fixtures: fixturesFor({ hostAgentId: 'programming-helper', runtimeId: 'rt-ph', runtimeSessionId: 'sess-A' }),
    threads: [WT],
  }, async ({ c, ctx, engine }) => {
    await seedIdentity(c, 'rt-ph', 'sess-A');
    setConversation(ctx, { agentId: 'coder', threadId: 'wt-1', sessionId: 'sess-head', runtimeId: '', wasHead: true });
    ctx.currentRuntimeAgentId = 'rt-ph';
    ctx.focusedAgentId = 'programming-helper';
    engine._syncActiveThreadSubscription();
    assert.equal(String(ctx.window.ClawThreads.activeConversation.threadId || ''), '',
      '宿主已切走：残留线程指向被清除');
  });

  // 宿主仍是 coder（runtime 态清空的等待窗口）：豁免保留，等待 head-advanced 重绑
  await withThreadEngineCase({
    fixtures: fixturesFor({ hostAgentId: 'coder', runtimeId: '', runtimeSessionId: '' }),
    threads: [WT],
  }, async ({ ctx, engine }) => {
    setConversation(ctx, { agentId: 'coder', threadId: 'wt-1', sessionId: 'sess-head', runtimeId: '', wasHead: true });
    ctx.currentRuntimeAgentId = '';
    ctx.focusedAgentId = 'coder';
    engine._syncActiveThreadSubscription();
    assert.equal(String(ctx.window.ClawThreads.activeConversation.threadId || ''), 'wt-1',
      '宿主未切走：等待重绑豁免保留线程指向');
  });
});

test('openConversationTarget 接续等待分支：切换落在该会话的聊天加载表面（不落首页）', async () => {
  // 迁移后 switchAgent 是具名 import（不再是可替换的 window 桩）：观察点改到
  // runtime-switch 的宿主缝在公共状态上的结果——工作空间 surface 分支以
  // `awaitSession` 进入聊天加载表面（挂起导航 + 聊天 tab + 加载态），而不是
  // 停在宿主首页。
  await withThreadDomainCase({
    threads: [WT],
    fixtures: {
      focusedAgentId: 'programming-helper',
      currentRuntimeAgentId: 'rt-ph',
      allAgents: [
        { id: 'coder', source: 'prebuilt', kind: 'workspace' },
        { id: 'programming-helper', source: 'prebuilt' },
      ],
      getCurrentHostAgentRecord: () => ({ id: 'programming-helper', source: 'prebuilt' }),
      renderAgentList: () => {},
      renderCurrentMainView: () => {},
      updateQueueIndicator: () => {},
      updateThreadHeaderIndicator: () => {},
    },
    fetch: async () => ({ ok: true, json: async () => ({ ok: true, messages: [] }) }),
  }, async ({ c, domain }) => {
    const result = await domain.openConversationTarget({ agentId: 'coder', threadId: 'wt-1' });
    assert.ok(result?.ok, '等待分支挂线程成功');
    assert.equal(c.read('focusedAgentId'), 'coder', '切换到线程宿主工作空间');
    assert.equal(c.read('currentWorkspaceTab'), 'chat', '落在聊天表面，不落宿主首页');
    const pending = c.read('_pendingSessionNavigation');
    assert.equal(pending?.sessionId, 'sess-head',
      '接续窗口点击：切换目标携带等待会话身份（awaitSessionId）');
    assert.equal(pending?.phase, 'committing');
  });
});
