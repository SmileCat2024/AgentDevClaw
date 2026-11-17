// 接续挡板 409 在 open_session 消费端的处理契约（workspace-actions）：
//   1. 侧栏操作必须结算——409 表示本次 activate 不会成立，滞留的 operation
//      会一直渲染成「正在启动新会话…」占位；
//   2. 不得经 openConversationTarget 再走一轮——那条路径会重新读本地线程
//      缓存判挡板并再次发起 activate，与服务端 409 构成循环（现象：点一次
//      线程条目就冒出大量「正在启动新会话…」占位）；
//   3. 直接进入等待表面，挂上服务端 409 指明的目标线程。
//
// 链路真实性：openPrebuiltWorkspaceSession 执行 workspace-entry.js 的真实实现
// （含 409 → error.handoff 的结构化解析），workspace-actions 与
// thread-store-domain 亦为真实源码；只有宿主全局与观察点用替身。
//
// 装载路线（P2 ESM 配方第三节 + thread-store 交互域拆分）：ESM 全部经
// withThreadCaseEnv 的 `c.load` 真实 import；classic 相装真实先行脚本序 +
// classic 刷新引擎（prepareThreadClassicSandbox），因此等待表面入口
// （enterThreadAwaitView）是真实实现，不再是可替换的 window 桩。该外壳同时
// 断言本用例零非预期 warn/error、且请求只落在已登记端点上。
//
// 观察点（迁移后重钉，均为真实 IO / 公开状态）：
//   - activate 请求体携带 operationId ⇒ 操作确实建立并绑定到该请求；
//   - 运行结束 getSidebarOperation(id) === null ⇒ 操作已离开在飞登记表；
//   - 全程零 alert ⇒ 走的是 settled 分支而非失败分支；
//   - 「进入等待表面」= ClawThreads.activeConversation 挂在 409 指明的线程上，
//     且会话消息只读出口被请求（等待表面的消息源）；
//   - 「不得再走一轮」= /activate 只出现一次（再走一轮必然再发一次 activate）。
import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareThreadClassicSandbox, seedThreadFacts, withThreadCaseEnv } from './p2-thread-case.js';

const OPS = 'public/src/modules/sidebar-operations.js';
const WORKSPACE_ACTIONS = 'public/src/modules/workspace-actions.js';
const THREAD_DOMAIN = 'public/src/modules/thread-store-domain.js';

async function withActionsCase(fn) {
  const requests = [];
  const events = { alerts: [] };
  const host = {
    id: 'coder',
    source: 'prebuilt',
    kind: 'workspace',
    runtime_session_id: '',
    active_workspace_session_id: 'sess-head',
    workspace_sessions: {
      revision: 1,
      activeSessionId: 'sess-head',
      sessions: [{ id: 'sess-head', title: 'T' }],
    },
  };
  // 409 指明的目标线程（服务端结论）：等待表面按 threadId 挂视图。
  const thread = {
    threadId: 'wt-1', agentId: 'coder', headSessionId: 'sess-head',
    sessionIds: ['sess-head'], status: 'rotating', handoffStartedAt: Date.now(),
  };
  const fetchStub = async (url, init) => {
    requests.push({ url: String(url), init });
    if (String(url).includes('/protoclaw/prebuilt_sessions/activate')) {
      return {
        ok: false,
        status: 409,
        json: async () => ({
          ok: false,
          code: 'thread_handoff_in_progress',
          message: 'Thread wt-1 正在接续，挂载已拒绝',
          threadId: 'wt-1',
          headSessionId: 'sess-head',
        }),
        text: async () => 'conflict',
      };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, messages: [] }), text: async () => '' };
  };

  return withThreadCaseEnv({
    label: 'frontend-session-open-handoff-409',
    fetch: fetchStub,
    classic: (sandbox) => {
      prepareThreadClassicSandbox(sandbox, {
        getCurrentAgentRecord: () => host,
        getCurrentHostAgentRecord: () => ({ id: 'coder', source: 'prebuilt', kind: 'workspace' }),
        getRuntimeWorkspaceSessionId: () => '',
        setViewerSessionBinding: () => {},
        renderAgentList: () => {},
        renderCurrentMainView: () => {},
        updateQueueIndicator: () => {},
        updateThreadHeaderIndicator: () => {},
        focusedAgentId: 'coder',
        currentRuntimeAgentId: '',
        allAgents: [host],
      });
      seedThreadFacts(sandbox, [thread]);
      sandbox.window.alert = (msg) => { events.alerts.push(String(msg)); };
      sandbox.run('window.ClawFW = window.ClawFW || {};'
        + ' window.ClawFW.workspaceAgents = { selectForNewSession: function (agent, action) { return action; } };');
    },
    globals: {
      t: (key) => key,
      escapeHtml: (value) => String(value ?? ''),
      getCurrentAgentRecord: () => host,
    },
  }, async ({ c }) => {
    const operations = await c.load(OPS);
    await c.load(WORKSPACE_ACTIONS);
    await c.load(THREAD_DOMAIN);
    return fn({ c, requests, events, operations });
  });
}

test('409 挡板：结算侧栏操作、只发起一次 activate、直接进等待表面', async () => {
  await withActionsCase(async ({ c, requests, events, operations }) => {
    await c.sandbox.run(`window.runWorkspaceAction(${JSON.stringify({ type: 'open_session', sessionId: 'sess-head' })}, null)`);

    const activates = requests.filter((r) => r.url.includes('/activate'));
    assert.equal(activates.length, 1, '409 后不得再次发起 activate（旧实现会循环）');

    // 等待表面确实挂着 409 指明的线程（真实入口，不是桩被调用）
    const conversation = c.read('window.ClawThreads.activeConversation');
    assert.equal(conversation?.threadId, 'wt-1', '等待目标是服务端 409 指明的线程');
    assert.equal(conversation?.sessionId, 'sess-head');
    assert.equal(conversation?.awaitSurface, true, '进入的是等待表面');
    // 等待表面的消息源：会话消息只读出口按该会话请求（真实 IO 证据）
    const messageReads = requests.filter((r) => r.url.includes('session_messages'));
    assert.equal(messageReads.length, 1, '等待表面恰好拉一次上一棒消息');
    assert.match(messageReads[0].url, /agentId=coder/);
    assert.match(messageReads[0].url, /sessionId=sess-head/);

    // 操作确实建立并绑到这次 activate：请求体里的 operationId 来自真实登记表。
    const operationId = String(JSON.parse(activates[0].init.body).operationId || '');
    assert.ok(operationId, 'activate 携带真实侧栏操作身份');
    // 结算证据：操作已离开在飞登记表（滞留会让侧栏一直显示启动占位）。
    assert.equal(operations.getSidebarOperation(operationId), null, '侧栏操作必须结算');
    assert.deepEqual(
      operations.listSidebarOperations().filter((op) => op.agentId === 'coder'),
      [],
      '不得留下未结算的占位操作',
    );
    assert.equal(events.alerts.length, 0, '挡板不是失败，不得弹 alert');
  });
});
