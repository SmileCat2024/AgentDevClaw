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
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const storeSource = fs.readFileSync(new URL('../public/src/modules/thread-store.js', import.meta.url), 'utf8');
// ADR-0026：thread-store 的等待表面调用会话视图提交原语——装载真模块，
// 身份语义单一来源，不 inline 复刻。
const sessionViewStateSource = fs.readFileSync(new URL('../public/src/modules/session-view-state.js', import.meta.url), 'utf8');
const coreSource = fs.readFileSync(new URL('../public/src/app-core.js', import.meta.url), 'utf8');
const mainSourceTop = fs.readFileSync(new URL('../public/src/app-main.js', import.meta.url), 'utf8');

function extractHostResolverSource() {
  const start = mainSourceTop.indexOf('function normalizeAgentIdentity');
  const end = mainSourceTop.indexOf('function getCurrentRuntimeRecord()', start);
  assert.notEqual(start, -1, 'host resolver should exist');
  assert.notEqual(end, -1, 'host resolver end marker should exist');
  return mainSourceTop.slice(start, end);
}

function extractBindingSource() {
  const start = coreSource.indexOf('var _viewerSessionBindings = new Map()');
  const end = coreSource.indexOf('function getRuntimeContextKey', start);
  assert.notEqual(start, -1, 'binding segment start should exist');
  assert.notEqual(end, -1, 'binding segment end marker should exist');
  return coreSource.slice(start, end);
}

function createHarness() {
  const elements = new Map();
  const anchor = { id: 'chat-context-bar', className: '', textContent: '', title: '', onclick: null, parentElement: { insertBefore: () => {} }, remove() {} };
  elements.set('chat-context-bar', anchor);
  const actionLog = [];
  const switchLog = [];
  const sandbox = {
    console, Date, Number, String, Promise, JSON, Array, Object, Math, Map, Set,
    setTimeout: (fn) => { fn(); return 0; },
    setInterval: () => 0,
    clearTimeout: () => {},
    document: {
      visibilityState: 'visible',
      getElementById: (id) => elements.get(id) || null,
      createElement: () => ({ id: '', className: '', textContent: '', title: '', onclick: null, remove() {}, parentElement: { insertBefore() {} } }),
      addEventListener: () => {},
    },
    // unchanged：周期刷新（harness 的 setTimeout 同步执行回调）不产生新
    // 线程事实——否则挂起的 refreshThreads 会把测试内联 threads 清空并
    // 重建 activeConversation，与断言竞态（时序脆弱，非生产行为）。
    fetch: async () => ({ ok: true, json: async () => ({ unchanged: true }) }),
    renderAgentList: () => {},
    updateQueueIndicator: () => {},
    focusedAgentId: 'programming-helper',
    currentRuntimeAgentId: 'rt-main',
    allAgents: [],
    lastRenderedWorkspaceHtml: '',
    currentLanguage: 'zh',
    // session-view-state.js 模块级依赖（生产中由 app-core.js 声明）：
    // 最小可写占位，令牌与提交语义由真模块提供。
    _switchEpoch: 0,
    currentMessages: [],
    currentInputRequests: [],
    currentOverviewSnapshot: {},
    setCurrentHookInspector(value) { sandbox.currentHookInspector = value || {}; },
    setCurrentOverviewSnapshot(value) { sandbox.currentOverviewSnapshot = value || {}; },
    setCurrentTodoPlan(value) { sandbox.currentTodoPlan = value || {}; },
    // 工作空间动作 / agent 切换探针
    runWorkspaceAction: (payload) => { actionLog.push(JSON.parse(payload)); return Promise.resolve({ ok: true }); },
    switchAgent: (id) => { switchLog.push(String(id)); return Promise.resolve(); },
    window: {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.ClawFW = { SseClient: { subscribeThreadEvents: () => ({ unsubscribe: () => {} }) } };
  sandbox.__actionLog = actionLog;
  sandbox.__switchLog = switchLog;
  sandbox.__elements = elements;
  vm.createContext(sandbox);
  return sandbox;
}

function loadStore(sandbox) {
  vm.runInContext(extractHostResolverSource() + '\n' + extractBindingSource() + '\n' + sessionViewStateSource + '\n' + storeSource, sandbox);
}

test('T018-A1: 有 runtime 态但绑定缺席时——不得回退残留 activeConversation（main 输入串到 coder 会话的根因）', async () => {
  const sandbox = createHarness();
  loadStore(sandbox);
  // 用户已切回 main 会话（runtime 态在），但绑定缺席 + 条目无会话字段
  // （宿主 active 已被 IM/接力改写成 coder 会话）→ runtime 态解析为空。
  // activeConversation 残留上一条 coder 线程会话——这不是「等待重绑」，
  // 回退它会把 main 输入串到 coder 会话并唤醒其 head runtime。
  vm.runInContext(`
    focusedAgentId = 'programming-helper';
    currentRuntimeAgentId = 'rt-main';
    allAgents = [{ id: 'programming-helper', source: 'prebuilt' }];
    window.ClawThreads.activeConversation = {
      agentId: 'programming-helper', threadId: 'wt-x',
      sessionId: 'sess-coder-old', runtimeId: 'rt-coder',
    };
  `, sandbox);
  const active = vm.runInContext('_currentActiveSession()', sandbox);
  assert.equal(active, null, '有 runtime 态时 activeConversation 回退不得生效（等待重绑语义仅限退役窗口），实际: ' + JSON.stringify(active));
});

test('T018-A2: 无 runtime 态且无 activeConversation——宿主 active 回退已删除（跨会话共享可变状态不可作输入目标）', async () => {
  const sandbox = createHarness();
  loadStore(sandbox);
  vm.runInContext(`
    focusedAgentId = 'programming-helper';
    currentRuntimeAgentId = '';
    allAgents = [{ id: 'programming-helper', source: 'prebuilt', active_workspace_session_id: 'sess-main' }];
  `, sandbox);
  const active = vm.runInContext('_currentActiveSession()', sandbox);
  assert.equal(active, null, '宿主 active 回退必须删除（被 IM/CLI/接力改写的共享状态），实际: ' + JSON.stringify(active));
});

test('T018-D1: 接力挡板中点击线程条目——本地挂线程等待视图，不得 open_session 启动 runtime（与 rotation 打架的根因）', async () => {
  const sandbox = createHarness();
  loadStore(sandbox);
  const now = Date.now();
  vm.runInContext(`
    focusedAgentId = 'programming-helper';
    currentRuntimeAgentId = '';
    allAgents = [{ id: 'programming-helper', source: 'prebuilt', active_workspace_session_id: 'sess-main' }];
    window.ClawThreads.threads = [{
      threadId: 'wt-relay', agentId: 'programming-helper', status: 'rotating',
      handoffStartedAt: ${now}, headSessionId: 'sess-head-old',
      sessionIds: ['sess-head-old'], title: 't', updatedAt: 2,
    }];
    _rebuildIndexes();
  `, sandbox);
  const result = await vm.runInContext(
    'window.openConversationTarget({ threadId: "wt-relay" })', sandbox,
  );
  assert.equal(result?.ok, true, '挡板窗口点击应成功挂线程等待视图: ' + JSON.stringify(result));
  assert.equal(sandbox.__actionLog.length, 0, '不得触发 open_session（activate 会给退役中的 head 启动 runtime）');
  const conv = vm.runInContext('window.ClawThreads.activeConversation', sandbox);
  assert.equal(conv?.threadId, 'wt-relay', '视图身份应挂到线程');
  assert.equal(conv?.sessionId, 'sess-head-old', '会话指向挡板中的 head');
});

test('T018-D2（守卫）: 无挡板照常走 runtime 激活路径', async () => {
  const sandbox = createHarness();
  loadStore(sandbox);
  vm.runInContext(`
    focusedAgentId = 'programming-helper';
    currentRuntimeAgentId = '';
    allAgents = [
      { id: 'programming-helper', source: 'prebuilt' },
      { id: 'rt-live', source: 'child', parent_id: 'programming-helper',
        sessionType: 'coder', runtime_session_id: 'rt-live',
        active_workspace_session_id: 'sess-head' },
    ];
    window.ClawThreads.threads = [{
      threadId: 'wt-open', agentId: 'programming-helper', status: 'open',
      handoffStartedAt: 0, headSessionId: 'sess-head',
      sessionIds: ['sess-head'], title: 't', updatedAt: 2,
    }];
    _rebuildIndexes();
  `, sandbox);
  await vm.runInContext('window.openConversationTarget({ threadId: "wt-open" })', sandbox);
  assert.equal(sandbox.__switchLog.includes('rt-live'), true, '无挡板时照常切到 head runtime');
});
