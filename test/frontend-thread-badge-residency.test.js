// T014：常驻会话（未经「切走再切回」）接续时顶栏接力徽标必须即时出现。
//
// 用户规律（2026-10-10 晚实测）：接续前会话若未经历点击切换（切走再切
// 回的状态重置），打断后「上下文接力中」徽标与暂存气泡不出现。本回路
// 加载真实 thread-store + app-core 绑定段，驱动完整序列：
// 常驻进入（runtime 视图身份就绪）→ 挡板立起（SSE handoff-started 事件
// → /protoclaw/threads 返回 rotating+handoffStartedAt）→ 断言徽标渲染。
//
// 装载路线（P4 T3）：刷新引擎 thread-store.js 已迁 ESM，走真实 import
// （withThreadEngineCase：最小 classic 夹具 + case 级 ESM 图）。宿主侧仍是真实
// classic 实现切片——app-core 的 viewer 绑定段与 app-main 的宿主记录 / 标题兜底，
// 它们就是顶栏指示器读取的事实源（不写同形替身）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { installRuntimeSwitch } from './helpers/runtime-switch.js';
import { withThreadEngineCase } from './helpers/thread-engine.js';

const coreSource = fs.readFileSync(new URL('../public/src/app-core.js', import.meta.url), 'utf8');
const mainSourceTop = fs.readFileSync(new URL('../public/src/app-main.js', import.meta.url), 'utf8');

function extractHostResolverSource() {
  const normalizeStart = coreSource.indexOf('function normalizeAgentIdentity');
  const normalizeEnd = coreSource.indexOf('const VIEWER_BASE_URL', normalizeStart);
  const start = mainSourceTop.indexOf('function getCurrentSessionHostAgentId()');
  const end = mainSourceTop.indexOf('function getCurrentRuntimeRecord()', start);
  assert.notEqual(normalizeStart, -1, 'identity normalizer should exist in app-core');
  assert.notEqual(normalizeEnd, -1, 'identity normalizer end marker should exist');
  assert.notEqual(start, -1, 'host resolver should exist');
  assert.notEqual(end, -1, 'host resolver end marker should exist');
  return coreSource.slice(normalizeStart, normalizeEnd) + '\n' + mainSourceTop.slice(start, end);
}

function extractBindingSource() {
  const start = coreSource.indexOf('var _viewerSessionBindings = new Map()');
  const end = coreSource.indexOf('function getRuntimeContextKey', start);
  assert.notEqual(start, -1, 'binding segment start should exist');
  assert.notEqual(end, -1, 'binding segment end should exist');
  return coreSource.slice(start, end);
}

/** app-main 的顶栏标题兜底（视图绑定会话优先，不串宿主 active）。 */
function extractTitleHelperSource() {
  const start = mainSourceTop.indexOf('// 视图绑定会话自身的标题');
  const end = mainSourceTop.indexOf('function updateCurrentAgentChrome', start);
  assert.notEqual(start, -1, 'title helper should exist');
  return mainSourceTop.slice(start, end);
}

function makeElement(id) {
  return {
    id,
    className: '',
    textContent: '',
    title: '',
    onclick: null,
    parentElement: null,
    remove() { this.removed = true; },
    insertBefore() {},
  };
}

/**
 * 每个用例一份 DOM 夹具：顶栏锚点 + 指示器元素的增删。引擎按 id 现取元素，
 * 因此这里只需维持 elements 表；`insertBefore` 落到父节点上（与生产同构）。
 */
function createDocumentFixture() {
  const elements = new Map();
  const anchorParent = makeElement('anchor-parent');
  anchorParent.insertBefore = (element) => {
    element.parentElement = anchorParent;
    element.remove = () => { elements.delete(element.id); };
    elements.set(element.id, element);
  };
  const anchor = makeElement('chat-context-bar');
  anchor.parentElement = anchorParent;
  elements.set('chat-context-bar', anchor);
  elements.set('anchor-parent', anchorParent);
  const document = {
    visibilityState: 'visible',
    getElementById: (id) => elements.get(id) || null,
    createElement: (tag) => makeElement(`<${tag}>`),
    addEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    body: makeElement('body'),
    documentElement: makeElement('html'),
    contains: () => false,
  };
  return { elements, document };
}

/** 常驻线程宿主的经典夹具（宿主记录来自 app-main 的真实现切片）。 */
function hostFixtures({ allAgents, focusedAgentId, currentRuntimeAgentId, document }) {
  return {
    currentLanguage: 'zh',
    focusedAgentId,
    currentRuntimeAgentId,
    allAgents,
    lastRenderedWorkspaceHtml: '',
    document,
    renderAgentList: () => {},
    renderCurrentMainView: () => {},
    updateQueueIndicator: () => {},
  };
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

/** 常驻线程宿主的两条 agent 记录（ph 宿主 + 其 child runtime）。 */
const residentAgents = () => ([
  { id: 'programming-helper', source: 'prebuilt', active_workspace_session_id: 'sess-main' },
  {
    id: 'rt-coder', source: 'child', parent_id: 'programming-helper',
    sessionType: 'coder', runtime_session_id: 'rt-coder',
    active_workspace_session_id: 'sess-old-head',
  },
]);

test('T014-1: 常驻会话接续——SSE handoff-started → 徽标即时渲染', async () => {
  const { elements, document } = createDocumentFixture();
  let threadsPayload = { ok: true, contentHash: 'h0', threads: [] };
  const sseHandlers = [];
  await withThreadEngineCase({
    fixtures: {
      ...hostFixtures({
        focusedAgentId: 'programming-helper',
        currentRuntimeAgentId: 'rt-coder',
        document,
        allAgents: residentAgents(),
      }),
      ClawFW: { SseClient: { subscribeThreadEvents: (threadId, handler) => {
        sseHandlers.push({ threadId, handler });
        return () => {};
      } } },
      fetch: async () => ({ ok: true, json: async () => threadsPayload }),
    },
    classicExtra: (sandbox) => sandbox.run(extractHostResolverSource() + '\n' + extractBindingSource()),
  }, async ({ ctx }) => {
    // 常驻进入：runtime 视图身份就绪（switchAgent 已设绑定与焦点）
    ctx.run("setViewerSessionBinding('rt-coder', 'sess-old-head')");
    // 线程数据首次加载（挡板未立）
    threadsPayload = { ok: true, contentHash: 'h1', threads: [baseThread()] };
    await ctx.window.refreshThreads(true);

    // 断言订阅已建立（常驻态必须有线程订阅，否则 SSE 接续事件无人听）
    const sub = sseHandlers.find((s) => s.threadId === '*');
    assert.ok(sub, '常驻态应建立线程 SSE 订阅');

    // 挡板立起：SSE 事件到达 → 拉取到 rotating + handoffStartedAt
    threadsPayload = {
      ok: true, contentHash: 'h2',
      threads: [baseThread({ status: 'rotating', handoffStartedAt: Date.now() })],
    };
    await sub.handler({ type: 'thread.handoff-started', threadId: 'wt-live' });

    const el = elements.get('thread-header-indicator');
    assert.ok(el, '徽标元素应被创建');
    assert.ok(String(el.className).includes('relaying'), '徽标应为接力中样式，实际: ' + el.className);
    assert.ok(String(el.textContent).includes('接力'), '徽标文案：' + el.textContent);
  });
});

test('T014-2: 切到非接续会话——徽标必须隐藏（真相源跟随当前视图）', async () => {
  const { elements, document } = createDocumentFixture();
  let threadsPayload = { ok: true, contentHash: 'h0', threads: [] };
  await withThreadEngineCase({
    fixtures: {
      ...hostFixtures({
        focusedAgentId: 'programming-helper',
        currentRuntimeAgentId: 'rt-coder',
        document,
        allAgents: residentAgents(),
      }),
      fetch: async () => ({ ok: true, json: async () => threadsPayload }),
    },
    classicExtra: (sandbox) => sandbox.run(extractHostResolverSource() + '\n' + extractBindingSource()),
  }, async ({ ctx }) => {
    ctx.run("setViewerSessionBinding('rt-coder', 'sess-old-head')");
    threadsPayload = {
      ok: true, contentHash: 'h2',
      threads: [baseThread({ status: 'rotating', handoffStartedAt: Date.now() })],
    };
    await ctx.window.refreshThreads(true);
    assert.ok(elements.get('thread-header-indicator'), '前置：接续窗口内徽标在');

    // 用户切到普通 main 会话（视图身份换绑）：徽标必须消失
    ctx.run("setViewerSessionBinding('rt-coder', 'sess-main'); currentRuntimeAgentId = 'rt-coder'");
    threadsPayload = {
      ok: true, contentHash: 'h3',
      threads: [baseThread({ status: 'rotating', handoffStartedAt: Date.now() })],
    };
    await ctx.run('window.updateThreadHeaderIndicator()');
    assert.ok(!elements.get('thread-header-indicator'), '非线程会话视图徽标应移除');
  });
});

test('T014-3: switchAgent 绑定不得被宿主 active 兜底毒化（常驻徽标失联根因）', async () => {
  const { document } = createDocumentFixture();
  await withThreadEngineCase({
    fixtures: hostFixtures({
      focusedAgentId: 'programming-helper',
      currentRuntimeAgentId: 'rt-coder',
      document,
      allAgents: [{ id: 'programming-helper', source: 'prebuilt', active_workspace_session_id: 'sess-main' }],
    }),
    classicExtra: (sandbox) => {
      sandbox.run(extractHostResolverSource() + '\n' + extractBindingSource());
      // 真实切换实现（runtime-switch 模块 + app-main 的 classic 宿主适配器）
      installRuntimeSwitch(sandbox);
    },
  }, async ({ ctx }) => {
    // 点击时刻 allAgents 尚无该 runtime 的会话事实（runtime 刚起、轮询未跟上）
    ctx.run(`
      allAgents = [
        { id: 'programming-helper', source: 'prebuilt', active_workspace_session_id: 'sess-main' },
      ];
      currentRuntimeAgentId = 'previous-runtime';
      var _switchEpoch = 0, _navigationGuardEpoch = 0, pendingSwitchTarget = null;
      var readOnlyMode = false, _recentlyFinishedRuntimes = new Set();
      bumpNavigationGuard = closeAgentContextMenu = _storeVisibleSessionInputDraft = saveCurrentRuntimeToCache = () => {};
      findAgentByIdentity = () => allAgents[0];
      isWorkspaceHostUnit = isWorkspaceSurfaceUnit = isRemoteNamespaceAgentId = () => false;
      getAgentRuntimeId = () => 'rt-coder';
      getLogicalAgentId = () => 'programming-helper';
    `);
    // Stop at the observable binding boundary, before rendering or network IO.
    let bindingReached = false;
    const bound = new Error('binding observed');
    ctx._syncActiveThreadSubscription = () => { bindingReached = true; throw bound; };
    ctx.console = { error: () => {} };
    ctx.alert = () => {};
    await ctx.window.switchAgent('rt-coder');
    assert.equal(bindingReached, true, '真实切换必须经过绑定后再同步订阅');

    // 期望：派生为空时绑定缺席（不落宿主 active），allAgents 就绪后现值派生自愈
    assert.equal(
      ctx.run("getViewerSessionBinding('rt-coder')"),
      '',
      '派生为空时绑定必须缺席，不得写入宿主 active 会话',
    );
    ctx.run(`
      allAgents = [
        { id: 'programming-helper', source: 'prebuilt', active_workspace_session_id: 'sess-main' },
        { id: 'rt-coder', source: 'child', parent_id: 'programming-helper',
          sessionType: 'coder', runtime_session_id: 'rt-coder',
          active_workspace_session_id: 'sess-old-head' },
      ];
    `);
    assert.equal(
      ctx.run("getRuntimeWorkspaceSessionId('rt-coder')"),
      'sess-old-head',
      '绑定缺席时按最新 allAgents 现值派生，自愈为正确会话',
    );
  });
});

test('T014-4: 顶栏标题兜底优先视图绑定会话，不串宿主 active（顺带修复）', async () => {
  const { document } = createDocumentFixture();
  const titleAgents = [{
    id: 'programming-helper', source: 'prebuilt',
    active_workspace_display_name: '宿主active标题（另一会话）',
    active_workspace_session_title: '宿主active标题（另一会话）',
    workspace_sessions: { sessions: [{ id: 'sess-old-head', title: '当前查看的会话标题' }] },
  }];
  await withThreadEngineCase({
    fixtures: {
      ...hostFixtures({
        focusedAgentId: 'programming-helper',
        currentRuntimeAgentId: 'rt-coder',
        document,
        allAgents: titleAgents,
      }),
      getCurrentRuntimeRecord: () => null,
      isRemoteNamespaceAgentId: () => false,
    },
    classicExtra: (sandbox) => sandbox.run(extractHostResolverSource() + '\n' + extractBindingSource()
      + '\n' + extractTitleHelperSource()),
  }, async ({ ctx }) => {
    ctx.run("setViewerSessionBinding('rt-coder', 'sess-old-head')");
    // runtime 记录缺失（接续退役窗口）：标题应是绑定会话的标题，不是宿主 active
    const title = ctx.run('getCurrentVisualAgentTitle()');
    assert.equal(title, '当前查看的会话标题', '标题应取视图绑定会话，实际: ' + title);
  });
});

test('T014-5: 接续重绑后（focusedAgentId=coder APP）第二轮接续——徽标必须照常显示', async () => {
  const { elements, document } = createDocumentFixture();
  let threadsPayload = { ok: true, contentHash: 'h0', threads: [] };
  await withThreadEngineCase({
    fixtures: {
      ...hostFixtures({
        focusedAgentId: 'coder',
        currentRuntimeAgentId: 'rt-2',
        document,
        allAgents: [
          { id: 'programming-helper', source: 'prebuilt', active_workspace_session_id: 'sess-main' },
          { id: 'coder', agentId: 'coder', source: 'prebuilt', workspace_sessions: { sessions: [] } },
          {
            id: 'rt-2', source: 'child', parent_id: 'coder',
            sidebar_entry_id: 'coder', runtime_session_id: 'rt-2',
            active_workspace_session_id: 'sess-s2',
          },
        ],
      }),
      fetch: async () => ({ ok: true, json: async () => threadsPayload }),
    },
    classicExtra: (sandbox) => sandbox.run(extractHostResolverSource() + '\n' + extractBindingSource()),
  }, async ({ ctx }) => {
    // 第一次接续重绑后的视图状态（ADR-0025）：focusedAgentId 为 coder APP id
    // （thread-store head-advanced 重绑按线程归属写入 'coder'），绑定已
    // 换到 successor runtime + successor 会话。
    ctx.run("setViewerSessionBinding('rt-2', 'sess-s2')");

    // 第二轮接续：挡板立起，S2 仍是 head
    threadsPayload = {
      ok: true, contentHash: 'h5',
      threads: [{
        threadId: 'wt-live', agentId: 'coder', status: 'rotating',
        lifeState: 'executing', handoffStartedAt: Date.now(),
        headSessionId: 'sess-s2', sessionIds: ['sess-old-head', 'sess-s2'],
        title: 't', updatedAt: 2,
      }],
    };
    await ctx.window.refreshThreads(true);

    const el = elements.get('thread-header-indicator');
    assert.ok(el, '重绑后的第二轮接续徽标必须渲染（APP 归属解析不得失效）');
    assert.ok(String(el.textContent).includes('接力'), '徽标文案：' + (el ? el.textContent : '(无)'));
  });
});

test('T014-6: 退役窗口无撑存条目——徽标/气泡/标题由线程事实撑住', async () => {
  const { elements, document } = createDocumentFixture();
  let threadsPayload = { ok: true, contentHash: 'h0', threads: [] };
  await withThreadEngineCase({
    fixtures: {
      ...hostFixtures({
        focusedAgentId: 'coder',
        currentRuntimeAgentId: 'rt-2',
        document,
        allAgents: [
          { id: 'programming-helper', source: 'prebuilt', active_workspace_session_id: 'sess-main' },
          { id: 'coder', agentId: 'coder', source: 'prebuilt', workspace_sessions: { sessions: [] } },
        ],
      }),
      getCurrentRuntimeRecord: () => null,
      isRemoteNamespaceAgentId: () => false,
      fetch: async () => ({ ok: true, json: async () => threadsPayload }),
    },
    classicExtra: (sandbox) => sandbox.run(extractHostResolverSource() + '\n' + extractBindingSource()
      + '\n' + extractTitleHelperSource()),
  }, async ({ ctx }) => {
    // 第二轮接续的退役窗口（ADR-0025 形状）：successor runtime 条目已消失，
    // /api/agents 不再有「挡板撑存投影条目」——coder APP 条目是普通 prebuilt
    // 条目，focusedAgentId 是 coder APP id，线程事实（agentId='coder'）与
    // 视图身份一致，无身份链断裂。
    ctx.run("setViewerSessionBinding('rt-2', 'sess-s2')");
    ctx.window.ClawThreads.activeConversation = {
      agentId: 'coder', threadId: 'wt-live',
      sessionId: 'sess-s2', runtimeId: 'rt-2',
    };

    threadsPayload = {
      ok: true, contentHash: 'h6',
      threads: [{
        threadId: 'wt-live', agentId: 'coder', status: 'rotating',
        lifeState: 'executing', handoffStartedAt: Date.now(),
        headSessionId: 'sess-s2', sessionIds: ['sess-old-head', 'sess-s2'],
        headSessionTitle: '（精简）A', title: 't', updatedAt: 2,
      }],
    };
    await ctx.window.refreshThreads(true);

    let el = elements.get('thread-header-indicator');
    assert.ok(el, '退役窗口徽标必须由线程事实撑住');
    assert.ok(String(el.textContent).includes('接力'), '徽标文案：' + (el ? el.textContent : '(无)'));

    // 变体：404 清理已清空 runtime 态——activeConversation 回退分支的
    // agentId 匹配依赖 APP 归属一致性。
    ctx.run("currentRuntimeAgentId = ''");
    await ctx.run('window.updateThreadHeaderIndicator()');
    el = elements.get('thread-header-indicator');
    assert.ok(el, 'runtime 态清空后徽标仍必须由 activeConversation 回退撑住');

    // 标题兜底经线程事实取 head 会话标题。
    const title = ctx.run('getCurrentVisualAgentTitle()');
    assert.equal(title, '（精简）A', '退役窗口标题应是 head 会话标题，实际: ' + title);
  });
});

// 指示器点击：接续换头跳转。引擎里 jumpToThreadHead 是模块私有实现，唯一调用方
// 就是顶栏指示器的 click（P4 T3 后不再有 window 面）——行为在这里钉住。
test('T014-7: 历史成员指示器点击 → open_session 到线程 head（jumpToThreadHead 唯一调用方）', async () => {
  const { elements, document } = createDocumentFixture();
  let threadsPayload = { ok: true, contentHash: 'h0', threads: [] };
  const actions = [];
  const switches = [];
  const thread = {
    threadId: 'wt-hist', agentId: 'coder', status: 'open',
    lifeState: 'idle', handoffStartedAt: 0,
    headSessionId: 'sess-head', sessionIds: ['sess-head', 'sess-old'],
    title: 't', updatedAt: 3,
  };
  await withThreadEngineCase({
    fixtures: {
      ...hostFixtures({
        focusedAgentId: 'coder',
        currentRuntimeAgentId: 'rt-old',
        document,
        allAgents: [
          { id: 'coder', agentId: 'coder', source: 'prebuilt', workspace_sessions: { sessions: [] } },
          {
            id: 'rt-old', source: 'child', parent_id: 'coder',
            sidebar_entry_id: 'coder', runtime_session_id: 'rt-old',
            active_workspace_session_id: 'sess-old',
          },
        ],
      }),
      runWorkspaceAction: async (payload) => { actions.push(JSON.parse(payload)); return { ok: true }; },
      switchAgent: async (agentId) => { switches.push(String(agentId)); },
      fetch: async () => ({ ok: true, json: async () => threadsPayload }),
    },
    threads: [thread],
    classicExtra: (sandbox) => sandbox.run(extractHostResolverSource() + '\n' + extractBindingSource()),
  }, async ({ ctx }) => {
    // 历史成员浏览：视图绑旧会话，线程 head 已推进 → 只读横幅 + 显式前往入口
    ctx.run("setViewerSessionBinding('rt-old', 'sess-old')");
    threadsPayload = { ok: true, contentHash: 'h7', threads: [thread] };
    await ctx.window.refreshThreads(true);

    const el = elements.get('thread-header-indicator');
    assert.ok(el, '历史成员必须出现只读·前往入口');
    assert.ok(String(el.className).includes('historical'), '徽标应为历史成员样式，实际: ' + el.className);
    assert.equal(typeof el.onclick, 'function', '指示器必须挂点击跳转（jumpToThreadHead 的唯一入口）');

    await el.onclick();
    assert.deepEqual(actions, [{ type: 'open_session', sessionId: 'sess-head' }],
      '点击必须经工作空间动作打开线程 head 会话');
    assert.deepEqual(switches, [], '同宿主（coder）内跳转不得触发工作空间切换');
  });
});
