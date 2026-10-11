// T014：常驻会话（未经「切走再切回」）接续时顶栏接力徽标必须即时出现。
//
// 用户规律（2026-10-10 晚实测）：接续前会话若未经历点击切换（切走再切
// 回的状态重置），打断后「上下文接力中」徽标与暂存气泡不出现。本回路
// 加载真实 thread-store + app-core 绑定段，驱动完整序列：
// 常驻进入（runtime 视图身份就绪）→ 挡板立起（SSE handoff-started 事件
// → /protoclaw/threads 返回 rotating+handoffStartedAt）→ 断言徽标渲染。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const storeSource = fs.readFileSync(new URL('../public/src/modules/thread-store.js', import.meta.url), 'utf8');
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
  assert.notEqual(end, -1, 'binding segment end should exist');
  return coreSource.slice(start, end);
}

function makeElement(id) {
  return {
    id,
    className: '',
    textContent: '',
    title: '',
    onclick: null,
    parentElement: null,
    remove() {},
    insertBefore() {},
  };
}

function createHarness() {
  const elements = new Map();
  const anchor = makeElement('chat-context-bar');
  const anchorParent = makeElement('anchor-parent');
  anchor.parentElement = anchorParent;
  anchorParent.insertBefore = (el) => { el.remove = () => elements.delete(el.id); elements.set(el.id, el); };
  elements.set('chat-context-bar', anchor);
  elements.set('anchor-parent', anchorParent);

  const fetchLog = [];
  let threadsPayload = { ok: true, contentHash: 'h0', threads: [] };
  const sseHandlers = [];

  const sandbox = {
    console,
    Date,
    Number,
    String,
    Promise,
    JSON,
    Array,
    Object,
    Math,
    Map,
    Set,
    setTimeout: (fn) => { fn(); return 0; },
    setInterval: () => 0,
    clearTimeout: () => {},
    document: {
      visibilityState: 'visible',
      getElementById: (id) => elements.get(id) || null,
      createElement: (tag) => makeElement(''),
      addEventListener: () => {},
    },
    fetch: async (url) => {
      fetchLog.push(String(url));
      return { ok: true, json: async () => threadsPayload };
    },
    renderAgentList: () => {},
    updateQueueIndicator: () => {},
    focusedAgentId: 'programming-helper',
    currentRuntimeAgentId: 'rt-coder',
    allAgents: [
      { id: 'programming-helper', source: 'prebuilt', active_workspace_session_id: 'sess-main' },
      {
        id: 'rt-coder', source: 'child', parent_id: 'programming-helper',
        sessionType: 'coder', runtime_session_id: 'rt-coder',
        active_workspace_session_id: 'sess-old-head',
      },
    ],
    lastRenderedWorkspaceHtml: '',
    window: {},
    currentLanguage: 'zh',
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.getCurrentAgentRecord = () => sandbox.allAgents.find((a) => a.id === sandbox.currentRuntimeAgentId) || null;
  sandbox.ClawFW = {
    SseClient: {
      subscribeThreadEvents: (threadId, handler) => {
        sseHandlers.push({ threadId, handler });
        return () => {};
      },
    },
  };
  sandbox.__elements = elements;
  sandbox.__setThreadsPayload = (p) => { threadsPayload = p; };
  sandbox.__sseHandlers = sseHandlers;
  sandbox.__fetchLog = fetchLog;
  vm.createContext(sandbox);
  return sandbox;
}

function baseThread({ status = 'open', handoffStartedAt = 0 } = {}) {
  return {
    threadId: 'wt-live',
    agentId: 'programming-helper',
    status,
    lifeState: 'executing',
    handoffStartedAt,
    headSessionId: 'sess-old-head',
    sessionIds: ['sess-old-head'],
    title: 't',
    updatedAt: 1,
  };
}

test('T014-1: 常驻会话接续——SSE handoff-started → 徽标即时渲染', async () => {
  const sandbox = createHarness();
  vm.runInContext(extractHostResolverSource() + '\n' + extractBindingSource() + '\n' + storeSource, sandbox);

  // 常驻进入：runtime 视图身份就绪（switchAgent 已设绑定与焦点）
  vm.runInContext("setViewerSessionBinding('rt-coder', 'sess-old-head')", sandbox);
  // 线程数据首次加载（挡板未立）
  sandbox.__setThreadsPayload({ ok: true, contentHash: 'h1', threads: [baseThread()] });
  await vm.runInContext('window.refreshThreads(true)', sandbox);

  // 断言订阅已建立（常驻态必须有线程订阅，否则 SSE 接续事件无人听）
  const sub = sandbox.__sseHandlers.find((s) => s.threadId === 'wt-live');
  assert.ok(sub, '常驻态应建立线程 SSE 订阅');

  // 挡板立起：SSE 事件到达 → 拉取到 rotating + handoffStartedAt
  sandbox.__setThreadsPayload({
    ok: true, contentHash: 'h2',
    threads: [baseThread({ status: 'rotating', handoffStartedAt: Date.now() })],
  });
  await vm.runInContext(
    'window.ClawThreads && (async () => { for (const h of __sseHandlers) { if (h.threadId === "wt-live") await h.handler({ type: "thread.handoff-started" }); } })()',
    sandbox,
  );

  const el = sandbox.__elements.get('thread-header-indicator');
  assert.ok(el, '徽标元素应被创建');
  assert.ok(String(el.className).includes('relaying'), '徽标应为接力中样式，实际: ' + el.className);
  assert.ok(String(el.textContent).includes('接力'), '徽标文案：' + el.textContent);
});

test('T014-2: 切到非接续会话——徽标必须隐藏（真相源跟随当前视图）', async () => {
  const sandbox = createHarness();
  vm.runInContext(extractHostResolverSource() + '\n' + extractBindingSource() + '\n' + storeSource, sandbox);

  vm.runInContext("setViewerSessionBinding('rt-coder', 'sess-old-head')", sandbox);
  sandbox.__setThreadsPayload({
    ok: true, contentHash: 'h2',
    threads: [baseThread({ status: 'rotating', handoffStartedAt: Date.now() })],
  });
  await vm.runInContext('window.refreshThreads(true)', sandbox);
  assert.ok(sandbox.__elements.get('thread-header-indicator'), '前置：接续窗口内徽标在');

  // 用户切到普通 main 会话（视图身份换绑）：徽标必须消失
  vm.runInContext("setViewerSessionBinding('rt-coder', 'sess-main'); currentRuntimeAgentId = 'rt-coder'", sandbox);
  sandbox.__setThreadsPayload({
    ok: true, contentHash: 'h3',
    threads: [baseThread({ status: 'rotating', handoffStartedAt: Date.now() })],
  });
  await vm.runInContext('window.updateThreadHeaderIndicator()', sandbox);
  assert.ok(!sandbox.__elements.get('thread-header-indicator'), '非线程会话视图徽标应移除');
});

test('T014-3: switchAgent 绑定不得被宿主 active 兜底毒化（常驻徽标失联根因）', async () => {
  const sandbox = createHarness();
  const mainSourceT14 = fs.readFileSync(new URL('../public/src/app-main.js', import.meta.url), 'utf8');
  const start = mainSourceT14.indexOf('// 用户主动切换：立即冻结');
  const end = mainSourceT14.indexOf('if (typeof _syncActiveThreadSubscription === \'function\')', start);
  assert.notEqual(start, -1, 'switchAgent 绑定块应存在');
  const bindBlock = mainSourceT14.slice(start, end);
  vm.runInContext(extractHostResolverSource() + '\n' + extractBindingSource() + '\n' + storeSource, sandbox);

  // 点击时刻 allAgents 尚无该 runtime 的会话事实（runtime 刚起、轮询未跟上）
  vm.runInContext(`
    allAgents = [
      { id: 'programming-helper', source: 'prebuilt', active_workspace_session_id: 'sess-main' },
    ];
    var runtimeAgentId = 'rt-coder';
    var targetAgent = allAgents[0];
    ${bindBlock}
  `, sandbox);

  // 期望：派生为空时绑定缺席（不落宿主 active），allAgents 就绪后现值派生自愈
  assert.equal(
    vm.runInContext("getViewerSessionBinding('rt-coder')", sandbox),
    '',
    '派生为空时绑定必须缺席，不得写入宿主 active 会话',
  );
  vm.runInContext(`
    allAgents = [
      { id: 'programming-helper', source: 'prebuilt', active_workspace_session_id: 'sess-main' },
      { id: 'rt-coder', source: 'child', parent_id: 'programming-helper',
        sessionType: 'coder', runtime_session_id: 'rt-coder',
        active_workspace_session_id: 'sess-old-head' },
    ];
  `, sandbox);
  assert.equal(
    vm.runInContext("getRuntimeWorkspaceSessionId('rt-coder')", sandbox),
    'sess-old-head',
    '绑定缺席时按最新 allAgents 现值派生，自愈为正确会话',
  );
});

test('T014-4: 顶栏标题兜底优先视图绑定会话，不串宿主 active（顺带修复）', async () => {
  const mainSrc = fs.readFileSync(new URL('../public/src/app-main.js', import.meta.url), 'utf8');
  const start = mainSrc.indexOf('// 视图绑定会话自身的标题');
  const end = mainSrc.indexOf('function updateCurrentAgentChrome', start);
  assert.notEqual(start, -1, '标题辅助函数应存在');
  const sandbox = createHarness();
  const coreSeg = coreSource.slice(
    coreSource.indexOf('var _viewerSessionBindings = new Map()'),
    coreSource.indexOf('function getRuntimeContextKey'),
  );
  vm.runInContext(coreSeg + '\n' + mainSrc.slice(start, end), sandbox);
  vm.runInContext(`
    normalizeAgentIdentity = (v) => String(v || '').trim();
    getCurrentRuntimeRecord = () => null;
    getCurrentHostAgentRecord = () => allAgents.find((a) => a.id === focusedAgentId) || null;
    t = (k) => k;
    isRemoteNamespaceAgentId = () => false;
    currentRuntimeAgentId = 'rt-coder';
    focusedAgentId = 'programming-helper';
    allAgents = [
      {
        id: 'programming-helper', source: 'prebuilt',
        active_workspace_display_name: '宿主active标题（另一会话）',
        active_workspace_session_title: '宿主active标题（另一会话）',
        workspace_sessions: { sessions: [
          { id: 'sess-old-head', title: '当前查看的会话标题' },
        ] },
      },
    ];
    setViewerSessionBinding('rt-coder', 'sess-old-head');
  `, sandbox);
  // runtime 记录缺失（接续退役窗口）：标题应是绑定会话的标题，不是宿主 active
  const title = vm.runInContext('getCurrentVisualAgentTitle()', sandbox);
  assert.equal(title, '当前查看的会话标题', '标题应取视图绑定会话，实际: ' + title);
});

test('T014-5: 接续重绑后（focusedAgentId=coder APP）第二轮接续——徽标必须照常显示', async () => {
  const sandbox = createHarness();
  vm.runInContext(extractHostResolverSource() + '\n' + extractBindingSource() + '\n' + storeSource, sandbox);

  // 第一次接续重绑后的视图状态（ADR-0025）：focusedAgentId 为 coder APP id
  // （thread-store head-advanced 重绑按线程归属写入 'coder'），绑定已
  // 换到 successor runtime + successor 会话。
  vm.runInContext(`
    focusedAgentId = 'coder';
    currentRuntimeAgentId = 'rt-2';
    allAgents = [
      { id: 'programming-helper', source: 'prebuilt', active_workspace_session_id: 'sess-main' },
      { id: 'coder', agentId: 'coder', source: 'prebuilt', workspace_sessions: { sessions: [] } },
      { id: 'rt-2', source: 'child', parent_id: 'coder',
        sidebar_entry_id: 'coder', runtime_session_id: 'rt-2',
        active_workspace_session_id: 'sess-s2' },
    ];
    setViewerSessionBinding('rt-2', 'sess-s2');
  `, sandbox);

  // 第二轮接续：挡板立起，S2 仍是 head
  sandbox.__setThreadsPayload({
    ok: true, contentHash: 'h5',
    threads: [{
      threadId: 'wt-live', agentId: 'coder', status: 'rotating',
      lifeState: 'executing', handoffStartedAt: Date.now(),
      headSessionId: 'sess-s2', sessionIds: ['sess-old-head', 'sess-s2'],
      title: 't', updatedAt: 2,
    }],
  });
  await vm.runInContext('window.refreshThreads(true)', sandbox);

  const el = sandbox.__elements.get('thread-header-indicator');
  assert.ok(el, '重绑后的第二轮接续徽标必须渲染（APP 归属解析不得失效）');
  assert.ok(String(el.textContent).includes('接力'), '徽标文案：' + (el ? el.textContent : '(无)'));
});

test('T014-6: 退役窗口无撑存条目——徽标/气泡/标题由线程事实撑住', async () => {
  const sandbox = createHarness();
  vm.runInContext(extractHostResolverSource() + '\n' + extractBindingSource() + '\n' + storeSource, sandbox);

  // 第二轮接续的退役窗口（ADR-0025 形状）：successor runtime 条目已消失，
  // /api/agents 不再有「挡板撑存投影条目」——coder APP 条目是普通 prebuilt
  // 条目，focusedAgentId 是 coder APP id，线程事实（agentId='coder'）与
  // 视图身份一致，无身份链断裂。
  vm.runInContext(`
    focusedAgentId = 'coder';
    currentRuntimeAgentId = 'rt-2';
    allAgents = [
      { id: 'programming-helper', source: 'prebuilt', active_workspace_session_id: 'sess-main' },
      { id: 'coder', agentId: 'coder', source: 'prebuilt', workspace_sessions: { sessions: [] } },
    ];
    setViewerSessionBinding('rt-2', 'sess-s2');
    window.ClawThreads.activeConversation = {
      agentId: 'coder', threadId: 'wt-live',
      sessionId: 'sess-s2', runtimeId: 'rt-2',
    };
  `, sandbox);

  sandbox.__setThreadsPayload({
    ok: true, contentHash: 'h6',
    threads: [{
      threadId: 'wt-live', agentId: 'coder', status: 'rotating',
      lifeState: 'executing', handoffStartedAt: Date.now(),
      headSessionId: 'sess-s2', sessionIds: ['sess-old-head', 'sess-s2'],
      headSessionTitle: '（精简）A', title: 't', updatedAt: 2,
    }],
  });
  await vm.runInContext('window.refreshThreads(true)', sandbox);

  let el = sandbox.__elements.get('thread-header-indicator');
  assert.ok(el, '退役窗口徽标必须由线程事实撑住');
  assert.ok(String(el.textContent).includes('接力'), '徽标文案：' + (el ? el.textContent : '(无)'));

  // 变体：404 清理已清空 runtime 态——activeConversation 回退分支的
  // agentId 匹配依赖 APP 归属一致性。
  vm.runInContext("currentRuntimeAgentId = ''", sandbox);
  await vm.runInContext('window.updateThreadHeaderIndicator()', sandbox);
  el = sandbox.__elements.get('thread-header-indicator');
  assert.ok(el, 'runtime 态清空后徽标仍必须由 activeConversation 回退撑住');

  // 标题兜底经线程事实取 head 会话标题。
  const titleStart = mainSourceTop.indexOf('// 视图绑定会话自身的标题');
  const titleEnd = mainSourceTop.indexOf('function updateCurrentAgentChrome', titleStart);
  assert.notEqual(titleStart, -1, '标题辅助函数应存在');
  vm.runInContext(`
    ${mainSourceTop.slice(titleStart, titleEnd)}
    getCurrentRuntimeRecord = () => null;
    t = (k) => k;
    isRemoteNamespaceAgentId = () => false;
  `, sandbox);
  const title = vm.runInContext('getCurrentVisualAgentTitle()', sandbox);
  assert.equal(title, '（精简）A', '退役窗口标题应是 head 会话标题，实际: ' + title);
});
