// 会话只读浏览（session-readonly-view.js）合同：
//   1. 打开时不启动、不绑定 runtime：currentRuntimeAgentId 置空，
//      readOnlyMode 置位，activeConversation 冻结在该会话（wasHead=false,
//      readOnly=true）——这是接续重绑与事实对账的排除依据；
//   2. 消息按服务端 session_record 的完整字段落地（toolCalls / display /
//      reasoning 等不被裁剪），时间锚按 timestamps 平行投影合并；
//   3. 同一只读态下，接续重绑与线程指向对账都不改写视图（归档/历史存档
//      不会被自动跳回最新 head）；
//   4. 关闭只读态清标记与指示器，后续正常会话不被压痛。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

const readonlySource = fs.readFileSync(new URL('../public/src/modules/session-readonly-view.js', import.meta.url), 'utf8');
const threadStoreSource = fs.readFileSync(new URL('../public/src/modules/thread-store.js', import.meta.url), 'utf8');
const timelineSource = fs.readFileSync(new URL('../public/src/modules/message-timeline.js', import.meta.url), 'utf8');

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

function loadReadonly({ payload = recordPayload(), threads = [], loadMain = false } = {}) {
  const calls = { renders: 0, agentList: 0, rebinds: 0, toasts: [] };
  let ctx;
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  });
  ctx = createFrontendSandbox({
    setTimeout: () => 0,
    setInterval: () => 0,
    clearTimeout: () => {},
    clearInterval: () => {},
    fetch: fetchImpl,
    getCurrentHostAgentRecord: () => ({ id: 'programming-helper', source: 'prebuilt' }),
    readOnlyMode: false,
    currentWorkspaceTab: 'sessions',
    _navigationGuardEpoch: 0,
    bumpNavigationGuard: () => {},
    saveCurrentWorkspaceSurfaceScroll: () => {},
    _storeVisibleSessionInputDraft: () => {},
    saveCurrentRuntimeToCache: () => {},
    getRuntimeContextKey: () => 'ctx',
    resetRuntimeStatusForSwitch: () => {},
    beginChatLoadingSession: () => {},
    clearChatLoadingSession: () => {},
    renderAgentList: () => { calls.agentList += 1; },
    renderCurrentMainView: () => { calls.renders += 1; },
    isChatSurfaceActive: () => true,
    toolRenderConfigs: { read: { name: 'read', render: { call: 'read-call', result: 'read-result' } } },
    TOOL_NAMES: { read: 'Read' },
  });
  ctx.window.ClawToast = { show: (toast) => { calls.toasts.push(toast); } };
  ctx.window.updateThreadHeaderIndicator = () => {};
  ctx.run('globalThis.__toasts = [];');

  // 真实视图状态模块 + 时间线合并（只读模块依赖的权威实现）
  ctx.loadSource('public/src/modules/session-view-state.js');
  ctx.run(timelineSource);
  ctx.run(readonlySource);
  ctx.run(threadStoreSource);
  if (loadMain) {
    ctx.loadSource('public/src/app-core.js');
    // 真实 switchAgent 的离开只读路径（早退分支与清理顺序是契约本身）
    ctx.run(`
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
    ctx.loadSource('public/src/app-main.js');
  }
  ctx.run(`window.ClawThreads.threads = ${JSON.stringify(threads)};
    (function(){ const s = window.ClawThreads; s.byId = {}; s.sessionIndex = {};
      for (const t of s.threads) { s.byId[t.threadId] = t;
        for (const sid of (t.sessionIds || [])) s.sessionIndex[t.agentId + '::' + sid] = t; } })();`);
  ctx.__calls = calls;
  return ctx;
}

test('打开归档会话：只读挂载、不绑定 runtime、消息字段完整', async () => {
  const ctx = loadReadonly();
  const result = await ctx.run(
    `window.openReadOnlySession({ agentId: 'programming-helper', sessionId: '${SESSION_ID}', archived: true })`,
  );
  assert.equal(result.ok, true);
  // 无 runtime 态：只读视图不启动运行
  assert.equal(ctx.run('currentRuntimeAgentId'), null);
  assert.equal(ctx.run('readOnlyMode'), true);
  // 视图身份落在目标会话
  const identity = ctx.run('readCurrentSessionViewState().identity');
  assert.deepEqual({ agentId: identity.agentId, sessionId: identity.sessionId },
    { agentId: 'programming-helper', sessionId: SESSION_ID });

  // 消息完整字段保留（渲染管线同形，不做有损映射）
  const messages = ctx.run('readCurrentSessionViewState().messages');
  assert.equal(messages.length, 3);
  assert.deepEqual(messages[1].toolCalls, [{ id: 'call-1', name: 'read', arguments: { file_path: 'src/a.js' } }]);
  assert.equal(messages[1].reasoning, '先看代码');
  assert.deepEqual(messages[2].display, { diff: '+x' });
  assert.equal(messages[2].toolCallId, 'call-1');
  // 时间锚并行合并
  assert.equal(messages[0]._ts, 1000);
  assert.equal(messages[2]._ts, 3000);
  // 工具模板沿用最近已加载配置（无 runtime 也可渲染卡片）
  assert.equal(ctx.run('readCurrentSessionViewState().toolRenderConfigs.read.render.call'), 'read-call');
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
  const ctx = loadReadonly({ threads: [thread] });
  await ctx.run(
    `window.openReadOnlySession({ agentId: 'programming-helper', sessionId: '${SESSION_ID}', threadId: 'wt-1', archived: true })`,
  );
  // 只读目标冻结在该历史会话，且不是 head
  const conversation = ctx.run('window.ClawThreads.activeConversation');
  assert.equal(conversation.sessionId, SESSION_ID);
  assert.equal(conversation.readOnly, true);
  assert.equal(conversation.wasHead, false);
  assert.equal(conversation.runtimeId, '');
  assert.equal(ctx.run('currentRuntimeAgentId'), null, '只读浏览不得绑定 runtime');

  // 构造「若没有只读守卫就一定会完成重绑」的条件：successor runtime 已上线、
  // 线程 head 已推进。守卫缺席时这条路径会把视图换到新 head。
  ctx.run(`
    allAgents.push({
      id: 'runtime-new', source: 'child', parent_id: 'programming-helper',
      runtime_session_id: 'runtime-new', active_workspace_session_id: 'session-new-head',
    });
    const t = window.ClawThreads.byId['wt-1'];
    t.headSessionId = 'session-new-head';
    t.sessionIds.push('session-new-head');
  `);
  await ctx.run(`_rebindConversationToThreadHead('wt-1', '${SESSION_ID}', 'session-new-head')`);
  ctx.run('_reconcileConversationWithThreadHead()');

  const after = ctx.run('window.ClawThreads.activeConversation');
  assert.equal(after.sessionId, SESSION_ID, '只读视图不得被重绑到新 head');
  assert.equal(after.readOnly, true);
  assert.equal(ctx.run('readCurrentSessionViewState().identity.sessionId'), SESSION_ID);
  assert.equal(ctx.run('currentRuntimeAgentId'), null, '只读浏览不得绑定 runtime');
});

test('关闭只读态：清除标记与只读输入，不残留到下一个会话', async () => {
  const ctx = loadReadonly();
  await ctx.run(
    `window.openReadOnlySession({ agentId: 'programming-helper', sessionId: '${SESSION_ID}', archived: true })`,
  );
  assert.equal(ctx.run('readOnlyMode'), true);
  ctx.run('window.closeReadOnlySession()');
  assert.equal(ctx.run('readOnlyMode'), false);
  assert.equal(ctx.run('window.getReadOnlySessionTarget()'), null);
  const conversation = ctx.run('window.ClawThreads.activeConversation');
  assert.equal(conversation, null);
});

test('读取失败：不残留只读空壳，给出可见错误', async () => {
  const ctx = loadReadonly();
  ctx.run(`globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => 'session not found' });`);
  const result = await ctx.run(
    `window.openReadOnlySession({ agentId: 'programming-helper', sessionId: '${SESSION_ID}', archived: true })`,
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'load_failed');
  assert.equal(ctx.__calls.toasts.length, 1);
  assert.match(ctx.__calls.toasts[0].title, /无法读取会话记录/);
});

test('从只读视图切走（点同宿主首页）必须清除只读态', async () => {
  // 真实 switchAgent：只读浏览下 currentRuntimeAgentId 为空，点同一宿主首页
  // 命中「已在宿主首页」早退。只读清理必须前置于该早退，否则标记残留会把
  // 随后的正常会话压痛（输入框仍禁用、顶栏仍挂「只读」）。
  const ctx = loadReadonly({ loadMain: true });
  ctx.run(`
    allAgents = [{ id: 'programming-helper', source: 'prebuilt', kind: 'workspace', launchMode: 'ui-only' }];
    getAgentRuntimeId = (agent) => agent?.id || '';
    findAgentByIdentity = (agentId) => allAgents.find((a) => a.id === agentId) || null;
    isWorkspaceSurfaceUnit = (agent) => !!agent && agent.source === 'prebuilt';
    selectWorkspaceSurface = () => { globalThis.__leftToHome = true; };
    closeAgentContextMenu = () => {};
  `);
  await ctx.run(
    `window.openReadOnlySession({ agentId: 'programming-helper', sessionId: '${SESSION_ID}', archived: true })`,
  );
  assert.equal(ctx.run('readOnlyMode'), true);
  assert.equal(ctx.run('currentRuntimeAgentId'), null);

  await ctx.run("window.switchAgent('programming-helper')");

  assert.equal(ctx.run('window.getReadOnlySessionTarget()'), null, '只读目标必须清空');
  assert.equal(ctx.run('readOnlyMode'), false, '只读标记不得残留');
  assert.equal(ctx.run('window.ClawThreads.activeConversation'), null);
});
