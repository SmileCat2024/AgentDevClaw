// 会话只读浏览（session-readonly-view.js）合同：
//   1. 打开时不启动、不绑定 runtime：currentRuntimeAgentId 置空，
//      readOnlyMode 置位，activeConversation 冻结在该会话（wasHead=false,
//      readOnly=true）——这是接续重绑与事实对账的排除依据；
//   2. 消息按服务端 session_record 的完整字段落地（toolCalls / display /
//      reasoning 等不被裁剪），时间锚按 timestamps 平行投影合并；
//   3. 同一只读态下，接续重绑与线程指向对账都不改写视图（归档/历史存档
//      不会被自动跳回最新 head）；
//   4. 关闭只读态清标记与指示器，后续正常会话不被压痛。
//
// 装载路线（P2 测试改造）：session-readonly-view / message-timeline 已迁 ESM
// → withP2EsmCase + 真实 import（每 case 整图隔离）；session-view-state /
// thread-store / app-core / app-main 仍 classic → 按真实加载序 loadSource。
// 宿主面（渲染入口、加载占位、导航守卫等 classic 函数）经 window 注入——这
// 正是被模块读取的 classic 依赖面。toast 经真实 ClawToast 模块对象观察。
import assert from 'node:assert/strict';
import test from 'node:test';
import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { APP_MAIN_DOMAIN, prepareEsmModules, prepareSidebarDomain, SESSION_VIEW_DOMAIN } from './p2-classic-hosts.js';

const READONLY_VIEW = 'public/src/modules/session-readonly-view.js';
const TOAST_NOTIFY = 'public/src/modules/toast-notify.js';
const THREAD_STORE = 'public/src/modules/thread-store.js';


const SESSION_ID = 'session-1793000000000-ab12cd';

function recordPayload(overrides = {}) {
  return {
    sessionId: SESSION_ID,
    archived: true,
    title: '归档对话',
    timestamps: [1000, 2000, 3000],
    messages: [
      { role: 'user', turn: 1, content: '请修一下这个 bug' },
      {
        role: 'assistant',
        turn: 1,
        content: '',
        reasoning: '先看代码',
        toolCalls: [{ id: 'call-1', name: 'read', arguments: { file_path: 'src/a.js' } }],
      },
      { role: 'tool', turn: 1, toolCallId: 'call-1', content: '{"ok":true}', display: { diff: '+x' } },
    ],
    ...overrides,
  };
}

/**
 * 一次只读用例：真实 classic bootstrap（action-dispatcher / app-core /
 * session-view-state / thread-store）+ 真实 ESM 图。
 */
async function withReadonlyView({ payload = recordPayload(), threads = [], loadMain = false } = {}, probe) {
  const calls = { renders: 0, agentList: 0, rebinds: 0 };
  // fetch 走可变夹具（ESM 模块裸引用跑在主 realm，不能从沙箱改 globalThis）
  const fetchBox = {
    impl: async () => ({
      ok: true,
      status: 200,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    }),
  };
  return withP2EsmCase({
    classic: (sandbox) => {
      sandbox.setTimeout = () => 0;
      sandbox.setInterval = () => 0;
      sandbox.clearTimeout = () => {};
      sandbox.clearInterval = () => {};
      sandbox.loadSource('public/src/modules/action-dispatcher.js');
      sandbox.loadSource('public/src/app-core.js');
      prepareEsmModules(sandbox, SESSION_VIEW_DOMAIN);
      // app-main 的 classic 同步引擎在装载期组合 sidebar-render 的
      // createAgentCallStatesHost（读 runtime-status 的 _agentSuspended）：
      // 按生产先行脚本序装真链，随后再覆盖本用例关心的宿主 stub。
      prepareSidebarDomain(sandbox);
      // 宿主注入：只读模块读取的 classic 依赖面（渲染入口、加载占位、
      // 导航守卫、视口缓存、工具模板）。断言只关心只读逻辑本身。
      sandbox.getCurrentHostAgentRecord = () => ({ id: 'programming-helper', source: 'prebuilt' });
      sandbox.currentWorkspaceTab = 'sessions';
      sandbox.bumpNavigationGuard = () => {};
      sandbox.saveCurrentWorkspaceSurfaceScroll = () => {};
      sandbox._storeVisibleSessionInputDraft = () => {};
      sandbox.getRuntimeContextKey = () => 'ctx';
      sandbox.resetRuntimeStatusForSwitch = () => {};
      sandbox.renderAgentList = () => { calls.agentList += 1; };
      sandbox.renderCurrentMainView = () => { calls.renders += 1; };
      sandbox.isChatSurfaceActive = () => true;
      sandbox.toolRenderConfigs = { read: { name: 'read', render: { call: 'read-call', result: 'read-result' } } };
      sandbox.TOOL_NAMES = { read: 'Read' };

      if (loadMain) {
        // 真实 switchAgent 的离开只读路径（早退分支与清理顺序是契约本身）
        sandbox.run(`
          closeAgentContextMenu = () => {};
          bumpNavigationGuard = () => {};
          _storeVisibleSessionInputDraft = () => {};
          saveCurrentWorkspaceSurfaceScroll = () => {};
          saveCurrentRuntimeToCache = () => {};
          getRuntimeContextKey = () => 'ctx';
          getAgentRuntimeId = (agent) => agent?.id || '';
          findAgentByIdentity = (agentId) => allAgents.find((a) => a.id === agentId) || null;
          isWorkspaceSurfaceUnit = (agent) => !!agent && agent.source === 'prebuilt';
          isWorkspaceHostUnit = (agent) => !!agent && agent.kind === 'workspace';
          selectWorkspaceSurface = () => {};
          loadAgentData = async () => {};
          loadAgents = async () => {};
          loadMcpInfo = async () => {};
          // The test exercises switch cleanup, not the independent page boot chain.
          window.__clawAuthReady = new Promise(() => {});
          setViewerSessionBinding = () => {};
          renderAgentList = () => {};
          renderCurrentMainView = () => {};
          resetRuntimeStatusForSwitch = () => {};
          applyLanguage = () => {};
          applyTheme = () => {};
          shouldRenderWorkspaceSurface = () => false;
          isChatSurfaceActive = () => true;
          getRuntimeAwareAgentRecord = () => null;
          notifyChatViewportMutation = () => {};
          isRemoteNamespaceAgentId = (value) => typeof value === 'string' && value.startsWith('remote:');
          getEmptyOverviewSnapshot = () => ({ empty: true });
          getEmptyTodoPlan = () => ({ tasks: [] });
          notifyInputSurfaceChanged = () => {};
        `);
        // 编排域（app-main）迁 ESM（P4 T3 收尾）：本体进模块相且最先求值。
        // runtime-switch-host 一并显式装载：它是 `window.switchAgent` 的真实 owner
        // （迁移前由 frontend-vm 的 app-main 装载钩子经 installRuntimeSwitch 带进来，
        // 该钩子随 app-main 迁 ESM 退役）。
        prepareEsmModules(sandbox, [...APP_MAIN_DOMAIN, 'public/src/modules/runtime-switch-host.js']);
      }

    },
    globals: { fetch: (...args) => fetchBox.impl(...args) },
  }, async (c) => {
    // 刷新引擎（P4 T3 起是真实 ESM）：交互域在**装载期**取它的窄宿主
    // createThreadStoreHost，必须先于 thread-store-domain 进同一张图。
    const engine = await c.load(THREAD_STORE);
    // 线程夹具：真实索引结构（byId / sessionIndex 由 threads 重建）
    const threadsState = c.window.ClawThreads;
    threadsState.threads = JSON.parse(JSON.stringify(threads));
    threadsState.byId = {};
    threadsState.sessionIndex = {};
    for (const thread of threadsState.threads) {
      threadsState.byId[thread.threadId] = thread;
      for (const sid of (thread.sessionIds || [])) threadsState.sessionIndex[thread.agentId + '::' + sid] = thread;
    }
    const toastModule = await c.load(TOAST_NOTIFY);
    const toasts = [];
    const realShow = toastModule.ClawToast.show;
    // toast 观察面：只读模块调用本模块对象的 show（不触达 DOM 呈现）
    toastModule.ClawToast.show = (opts) => { toasts.push(opts); };
    try {
      const readonly = await c.load(READONLY_VIEW);
      return await probe({
        c,
        engine,
        readonly,
        calls,
        toasts,
        setFetch: (impl) => { fetchBox.impl = impl; },
      });
    } finally {
      toastModule.ClawToast.show = realShow;
    }
  });
}

test('打开归档会话：只读挂载、不绑定 runtime、消息字段完整', async () => {
  await withReadonlyView({}, async ({ c, readonly }) => {
    const result = await readonly.openReadOnlySession({ agentId: 'programming-helper', sessionId: SESSION_ID, archived: true });
    assert.equal(result.ok, true);
    // 无 runtime 态：只读视图不启动运行
    assert.equal(c.read('currentRuntimeAgentId'), null);
    assert.equal(c.read('readOnlyMode'), true);
    // 视图身份落在目标会话
    const identity = c.read('readCurrentSessionViewState().identity');
    assert.deepEqual({ agentId: identity.agentId, sessionId: identity.sessionId },
      { agentId: 'programming-helper', sessionId: SESSION_ID });

    // 消息完整字段保留（渲染管线同形，不做有损映射）
    const messages = c.read('readCurrentSessionViewState().messages');
    assert.equal(messages.length, 3);
    assert.deepEqual(messages[1].toolCalls, [{ id: 'call-1', name: 'read', arguments: { file_path: 'src/a.js' } }]);
    assert.equal(messages[1].reasoning, '先看代码');
    assert.deepEqual(messages[2].display, { diff: '+x' });
    assert.equal(messages[2].toolCallId, 'call-1');
    // 时间锚并行合并
    assert.equal(messages[0]._ts, 1000);
    assert.equal(messages[2]._ts, 3000);
    // 工具模板沿用最近已加载配置（无 runtime 也可渲染卡片）
    assert.equal(c.read('readCurrentSessionViewState().toolRenderConfigs.read.render.call'), 'read-call');
  });
});

test('只读态不被接续重绑与线程指向对账改写', async () => {
  const thread = {
    threadId: 'wt-1',
    agentId: 'programming-helper',
    headSessionId: SESSION_ID,
    sessionIds: [SESSION_ID, 'session-head'],
    status: 'active',
    updatedAt: new Date().toISOString(),
  };
  await withReadonlyView({ threads: [thread] }, async ({ c, engine, readonly }) => {
    await readonly.openReadOnlySession({ agentId: 'programming-helper', sessionId: SESSION_ID, threadId: 'wt-1', archived: true });
    // 只读目标冻结在该历史会话，且不是 head
    const conversation = c.read('window.ClawThreads.activeConversation');
    assert.equal(conversation.sessionId, SESSION_ID);
    assert.equal(conversation.readOnly, true);
    assert.equal(conversation.wasHead, false);
    assert.equal(conversation.runtimeId, '');
    assert.equal(c.read('currentRuntimeAgentId'), null, '只读浏览不得绑定 runtime');

    // 构造「若没有只读守卫就一定会完成重绑」的条件：successor runtime 已上线、
    // 线程 head 已推进。守卫缺席时这条路径会把视图换到新 head。
    c.read(`
      allAgents.push({
        id: 'runtime-new', source: 'child', parent_id: 'programming-helper',
        runtime_session_id: 'runtime-new', active_workspace_session_id: 'session-new-head',
      });
      const t = window.ClawThreads.byId['wt-1'];
      t.headSessionId = 'session-new-head';
      t.sessionIds.push('session-new-head');
    `);
    // 引擎内部操作是模块私有实现（P4 T3 后经命名导出取用，不再有 window 面）。
    await engine._rebindConversationToThreadHead('wt-1', SESSION_ID, 'session-new-head');
    engine._reconcileConversationWithThreadHead();

    const after = c.read('window.ClawThreads.activeConversation');
    assert.equal(after.sessionId, SESSION_ID, '只读视图不得被重绑到新 head');
    assert.equal(after.readOnly, true);
    assert.equal(c.read('readCurrentSessionViewState().identity.sessionId'), SESSION_ID);
    assert.equal(c.read('currentRuntimeAgentId'), null, '只读浏览不得绑定 runtime');
  });
});

test('关闭只读态：清除标记与只读输入，不残留到下一个会话', async () => {
  await withReadonlyView({}, async ({ c, readonly }) => {
    await readonly.openReadOnlySession({ agentId: 'programming-helper', sessionId: SESSION_ID, archived: true });
    assert.equal(c.read('readOnlyMode'), true);
    readonly.closeReadOnlySession();
    assert.equal(c.read('readOnlyMode'), false);
    assert.equal(readonly.getReadOnlySessionTarget(), null);
    const conversation = c.read('window.ClawThreads.activeConversation');
    assert.equal(conversation, null);
  });
});

test('读取失败：不残留只读空壳，给出可见错误', async () => {
  await withReadonlyView({}, async ({ readonly, calls, toasts, setFetch }) => {
    setFetch(async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => 'session not found' }));
    const result = await readonly.openReadOnlySession({ agentId: 'programming-helper', sessionId: SESSION_ID, archived: true });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'load_failed');
    assert.equal(toasts.length, 1);
    assert.match(toasts[0].title, /无法读取会话记录/);
    assert.equal(calls.renders > 0, true, '加载占位与重绘仍被执行');
  });
});

test('从只读视图切走（点同宿主首页）必须清除只读态', async () => {
  // 真实 switchAgent：只读浏览下 currentRuntimeAgentId 为空，点同一宿主首页
  // 命中「已在宿主首页」早退。只读清理必须前置于该早退，否则标记残留会把
  // 随后的正常会话压痛（输入框仍禁用、顶栏仍挂「只读」）。
  await withReadonlyView({ loadMain: true }, async ({ c, readonly }) => {
    c.read(`
      allAgents = [{ id: 'programming-helper', source: 'prebuilt', kind: 'workspace', launchMode: 'ui-only' }];
      getAgentRuntimeId = (agent) => agent?.id || '';
      findAgentByIdentity = (agentId) => allAgents.find((a) => a.id === agentId) || null;
      isWorkspaceSurfaceUnit = (agent) => !!agent && agent.source === 'prebuilt';
      selectWorkspaceSurface = () => { globalThis.__leftToHome = true; };
      closeAgentContextMenu = () => {};
    `);
    await readonly.openReadOnlySession({ agentId: 'programming-helper', sessionId: SESSION_ID, archived: true });
    assert.equal(c.read('readOnlyMode'), true);
    assert.equal(c.read('currentRuntimeAgentId'), null);

    await c.read("window.switchAgent('programming-helper')");

    assert.equal(readonly.getReadOnlySessionTarget(), null, '只读目标必须清空');
    assert.equal(c.read('readOnlyMode'), false, '只读标记不得残留');
    assert.equal(c.read('window.ClawThreads.activeConversation'), null);
  });
});
