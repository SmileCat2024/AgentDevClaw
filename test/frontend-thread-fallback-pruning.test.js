// T018：接续相关 fallback 路线修剪（用户指令：屏蔽理论上不该触发的 fallback）。
//
// 两个历史事故的根因都是 fallback 链把输入/视图身份串到无关会话：
// - bug2：main 会话发消息串到残留 coder 会话（activeConversation 回退在
//   有 runtime 态时生效 + 宿主 active 回退永生）——宿主 active 会被
//   IM/CLI/coder 接力改写，注释自己写明不可作输入目标，却是最后一级
//   fallback。
// - bug1：接力挡板中点击线程条目 → open_session → activate 无条件
//   startManagedAgent 给正在退役的 head 启动 runtime，与 rotation 打架。
import assert from 'node:assert/strict';
import test from 'node:test';
import { withThreadDomainCase } from './p2-thread-case.js';
import { withThreadEngineCase } from './helpers/thread-engine.js';

// 装载路线（P4 T3）：刷新引擎 thread-store.js 已迁 ESM，两条 fallback 断言走真实
// import（withThreadEngineCase：最小 classic 夹具 + case 级 ESM 图），
// `_currentActiveSession` 是命名导出；挡板点击用例走交互域基座。

test('T018-A1: 有 runtime 态但绑定缺席时——不得回退残留 activeConversation（main 输入串到 coder 会话的根因）', async () => {
  await withThreadEngineCase({
    fixtures: {
      currentLanguage: 'zh',
      focusedAgentId: 'programming-helper',
      currentRuntimeAgentId: 'rt-main',
      allAgents: [{ id: 'programming-helper', source: 'prebuilt' }],
      getCurrentHostAgentRecord: () => ({ id: 'programming-helper', source: 'prebuilt' }),
      // 绑定缺席（viewer 绑定表为空）：runtime 态解析不出会话
      getRuntimeWorkspaceSessionId: () => '',
      renderAgentList: () => {},
      updateQueueIndicator: () => {},
      lastRenderedWorkspaceHtml: '',
    },
  }, async ({ ctx, engine }) => {
    // 用户已切回 main 会话（runtime 态在），但绑定缺席 + 条目无会话字段
    // （宿主 active 已被 IM/接力改写成 coder 会话）→ runtime 态解析为空。
    // activeConversation 残留上一条 coder 线程会话——这不是「等待重绑」，
    // 回退它会把 main 输入串到 coder 会话并唤醒其 head runtime。
    ctx.window.ClawThreads.activeConversation = {
      agentId: 'programming-helper', threadId: 'wt-x',
      sessionId: 'sess-coder-old', runtimeId: 'rt-coder',
    };
    const active = engine._currentActiveSession();
    assert.equal(active, null, '有 runtime 态时 activeConversation 回退不得生效（等待重绑语义仅限退役窗口），实际: ' + JSON.stringify(active));
  });
});

test('T018-A2: 无 runtime 态且无 activeConversation——宿主 active 回退已删除（跨会话共享可变状态不可作输入目标）', async () => {
  await withThreadEngineCase({
    fixtures: {
      currentLanguage: 'zh',
      focusedAgentId: 'programming-helper',
      currentRuntimeAgentId: '',
      // 宿主记录带 active_workspace_session_id：旧的「宿主 active 回退」正是
      // 从这里取会话；该回退已删除，因此不得据此解析出目标。
      allAgents: [{ id: 'programming-helper', source: 'prebuilt', active_workspace_session_id: 'sess-main' }],
      getCurrentHostAgentRecord: () => ({
        id: 'programming-helper', source: 'prebuilt', active_workspace_session_id: 'sess-main',
      }),
      getRuntimeWorkspaceSessionId: () => '',
      renderAgentList: () => {},
      updateQueueIndicator: () => {},
      lastRenderedWorkspaceHtml: '',
    },
  }, async ({ engine }) => {
    const active = engine._currentActiveSession();
    assert.equal(active, null, '宿主 active 回退必须删除（被 IM/CLI/接力改写的共享状态），实际: ' + JSON.stringify(active));
  });
});

test('T018-D1: 接力挡板中点击线程条目——本地挂线程等待视图，不得 open_session 启动 runtime（与 rotation 打架的根因）', async () => {
  // 交互入口已迁 ESM（thread-store-domain）：真实模块 + 真实 classic 引擎。
  // 「不得 open_session」的观察点改为真实网络面（open_session 的实体请求是
  // activate），不再依赖 window.runWorkspaceAction 桩。
  const requests = [];
  const now = Date.now();
  const thread = {
    threadId: 'wt-relay', agentId: 'programming-helper', status: 'rotating',
    handoffStartedAt: now, headSessionId: 'sess-head-old',
    sessionIds: ['sess-head-old'], title: 't', updatedAt: 2,
  };
  await withThreadDomainCase({
    threads: [thread],
    fixtures: {
      focusedAgentId: 'programming-helper',
      currentRuntimeAgentId: '',
      allAgents: [{ id: 'programming-helper', source: 'prebuilt', kind: 'workspace', active_workspace_session_id: 'sess-main' }],
      getCurrentHostAgentRecord: () => ({ id: 'programming-helper', source: 'prebuilt', kind: 'workspace' }),
      getRuntimeWorkspaceSessionId: () => '',
      renderAgentList: () => {},
      renderCurrentMainView: () => {},
      updateQueueIndicator: () => {},
      updateThreadHeaderIndicator: () => {},
    },
    fetch: async (url) => {
      requests.push(String(url));
      return { ok: true, json: async () => ({ ok: true, messages: [] }) };
    },
  }, async ({ c, domain }) => {
    const result = await domain.openConversationTarget({ threadId: 'wt-relay' });
    assert.equal(result?.ok, true, '挡板窗口点击应成功挂线程等待视图: ' + JSON.stringify(result));
    assert.deepEqual(
      requests.filter((url) => url.includes('/activate')),
      [],
      '不得触发 open_session / activate（会给退役中的 head 启动 runtime）',
    );
    assert.equal(c.read('window.ClawThreads.activeConversation?.threadId'), 'wt-relay', '视图身份应挂到线程');
    assert.equal(c.read('window.ClawThreads.activeConversation?.sessionId'), 'sess-head-old', '会话指向挡板中的 head');
  });
});

test('T018-D2（守卫）: 无挡板照常走 runtime 激活路径', async () => {
  const thread = {
    threadId: 'wt-open', agentId: 'programming-helper', status: 'open',
    handoffStartedAt: 0, headSessionId: 'sess-head',
    sessionIds: ['sess-head'], title: 't', updatedAt: 2,
  };
  await withThreadDomainCase({
    threads: [thread],
    fixtures: {
      focusedAgentId: 'programming-helper',
      currentRuntimeAgentId: '',
      allAgents: [
        { id: 'programming-helper', source: 'prebuilt' },
        {
          id: 'rt-live', source: 'child', parent_id: 'programming-helper',
          sessionType: 'coder', runtime_session_id: 'rt-live',
          active_workspace_session_id: 'sess-head',
        },
      ],
      getCurrentHostAgentRecord: () => ({ id: 'programming-helper', source: 'prebuilt' }),
      getRuntimeWorkspaceSessionId: (runtimeId) => (runtimeId === 'rt-live' ? 'sess-head' : ''),
      setViewerSessionBinding: () => {},
      renderAgentList: () => {},
      renderCurrentMainView: () => {},
      updateQueueIndicator: () => {},
      updateThreadHeaderIndicator: () => {},
    },
    fetch: async () => ({ ok: true, json: async () => ({ ok: true, messages: [] }) }),
  }, async ({ c, domain }) => {
    const result = await domain.openConversationTarget({ threadId: 'wt-open' });
    assert.equal(result?.ok, true, '无挡板时导航成功');
    assert.equal(c.read('currentRuntimeAgentId'), 'rt-live', '无挡板时照常切到 head runtime');
    assert.equal(c.read('window.ClawThreads.activeConversation?.runtimeId'), 'rt-live');
  });
});
