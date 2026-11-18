// 接续等待表面（挡板窗口）三契约：
//   1. openConversationTarget 等待分支 → enterThreadAwaitSurface：挂等待
//      身份（awaitSurface 标记）并从服务端只读出口拉上一棒消息渲染；
//   2. 消息注入竞态守卫：fetch 回来时等待表面已不在该会话（重绑/切走）
//      → 不注入；
//   3. 挡板死收敛（_reconcileConversationWithThreadHead）：等待表面挂着、
//      挡板过新鲜窗、head 未推进、无 runtime → 终结等待态 + 失败提示；
//      挡板仍在新鲜窗 → 继续等待（不误杀慢接续）。
//
// 装载路线（P2 配方第三节 + thread-store 交互域拆分）：交互入口
// （openConversationTarget / enterThreadAwaitView）已迁 thread-store-domain，
// 经 withP2EsmCase 的 `c.load` 真实 import；刷新引擎与事实对账仍是 classic，
// 用 `prepareThreadClassicSandbox` 装同一沙箱（真实先行脚本序提供宿主工厂）。
// 等待表面用到的会话视图原语（captureSessionViewToken / commitSessionViewPatch）
// 因此是**真实实现**：断言打在 currentMessages / SessionView identity /
// 聊天加载态这些公开状态上，不再对桩计数。
import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareThreadClassicSandbox, withThreadCaseEnv } from './p2-thread-case.js';

const DOMAIN = 'public/src/modules/thread-store-domain.js';
const VIEW_STORAGE = 'public/src/modules/session-view-storage.js';

const HANDOFF_MSGS = [
  { role: 'system', content: 'sys' },
  { role: 'user', turn: 1, content: '上一棒指令' },
];

function okJson(payload) {
  return { ok: true, json: async () => payload };
}

/** 用例观察面：真实宿主能力的夹具（谁被调了多少次 / 身份提交了什么）。 */
function createObservers() {
  return { renderAgentList: 0, reRender: 0, toasts: [], identities: [] };
}

/**
 * 一个用例 = 一份沙箱 + 一张 ESM 图。
 * @param {object} options
 * @param {Array} [options.threads] 线程事实（写入 ClawThreads 索引）
 * @param {Function} [options.fetchImpl] 网络夹具（session_messages / threads）
 */
async function withThreadCase({ threads = [], fetchImpl = async () => ({ ok: false }) } = {}, fn) {
  const calls = createObservers();
  return withThreadCaseEnv({
    label: 'frontend-thread-await-surface',
    fetch: fetchImpl,
    classic: (sandbox) => {
      const thread = String(threads[0]?.threadId || '');
      prepareThreadClassicSandbox(sandbox, {
        currentLanguage: 'zh',
        allAgents: [{ id: 'coder', source: 'prebuilt', kind: 'workspace', active_workspace_session_id: '' }],
        getCurrentHostAgentRecord: () => ({ id: 'coder', source: 'prebuilt' }),
        getRuntimeWorkspaceSessionId: () => '',
        setViewerSessionBinding: () => {},
        findSidebarOperation: () => null,
        renderAgentList: () => { calls.renderAgentList += 1; },
        renderCurrentMainView: () => { calls.reRender += 1; },
        updateQueueIndicator: () => {},
        updateThreadHeaderIndicator: () => {},
        lastRenderedWorkspaceHtml: '',
      });
      sandbox.run(`window.ClawThreads.threads = ${JSON.stringify(threads)}; (function(){ const s = window.ClawThreads; s.byId = {}; s.sessionIndex = {}; for (const t of s.threads) { s.byId[t.threadId] = t; for (const sid of (t.sessionIds || [])) { s.sessionIndex[t.agentId + '::' + sid] = t; } } })();`);
      sandbox.__threadId = thread;
    },
  }, async ({ c }) => {
    // 侧栏渲染自 P4 T2 起是 ESM（sidebar-render）：classic 相的裸名覆盖会被桥
    // 访问器顶掉，观察面改在模块相之后经同一 setter 写回（语义与 classic 顶层
    // 赋值一致，仍是「侧栏重渲被触发」这一个事实）。
    c.window.renderAgentList = () => { calls.renderAgentList += 1; };
    const domain = await c.load(DOMAIN);
    const view = await c.load(VIEW_STORAGE);
    // ESM 图求值期 toast-notify 会装自己的 window.ClawToast；观察记录必须在其后
    // 覆盖，否则接续失败提示记不到用例观察面。
    c.window.ClawToast = {
      show: (toast) => { calls.toasts.push(toast); },
      dismiss: () => {},
    };
    return fn({ c, domain, view, calls });
  });
}

test('等待分支：挂 awaitSurface 身份并拉上一棒消息渲染（与 viewer 同形注入）', async () => {
  const now = Date.now();
  const thread = {
    threadId: 'wt-1', agentId: 'coder', headSessionId: 'sess-head', status: 'rotating',
    handoffStartedAt: now, sessionIds: ['sess-head'],
  };
  await withThreadCase({
    threads: [thread],
    fetchImpl: async () => okJson({ ok: true, messages: HANDOFF_MSGS, messageCount: HANDOFF_MSGS.length }),
  }, async ({ c, domain, calls }) => {
    const result = await domain.openConversationTarget({ threadId: 'wt-1' });
    assert.equal(result.ok, true);

    const selected = c.window.ClawThreads.activeConversation;
    assert.equal(selected.awaitSurface, true, '等待表面身份标记');
    assert.equal(selected.wasHead, true);
    assert.equal(selected.sessionId, 'sess-head');
    assert.equal(c.read('currentWorkspaceTab'), 'chat',
      '等待表面落在聊天表面（工作空间首页会显示 home）');
    assert.equal(c.read('_chatLoadingSession'), true, '等待表面进入聊天加载态（不落工作空间首页）');

    // fetch 异步链 flush 后注入
    await new Promise((resolve) => setImmediate(resolve));
    const injected = c.read('currentMessages');
    assert.equal(injected.length, 2, '上一棒消息注入 currentMessages');
    assert.equal(injected[1].content, '上一棒指令');
    assert.equal(c.read('readCurrentSessionViewState().identity.sessionId'), 'sess-head');
    assert.equal(c.read('_chatLoadingSession'), false, '有消息时解除加载 spinner');
    assert.ok(calls.reRender >= 1, '触发重渲');
  });
});

test('等待分支：挂 awaitSurface 身份后立即重渲侧栏（选中态收口）', async () => {
  // switchAgent 内部的侧栏渲染发生在 activeConversation 落定之前——那一刻
  // 宿主节点被判选中、占位条目判非（isAgentActive / isRuntimeItemActive 的
  // 等待分支都依赖 getActiveThreadInputTarget）。等待身份挂载后必须重渲
  // 侧栏纠正高亮，否则选中态永久停在宿主工作空间节点（历史 bug：接续条
  // 目点不选中）。
  const thread = {
    threadId: 'wt-1', agentId: 'coder', headSessionId: 'sess-head', status: 'rotating',
    handoffStartedAt: Date.now(), sessionIds: ['sess-head'],
  };
  await withThreadCase({
    threads: [thread],
    fetchImpl: async () => okJson({ ok: true, messages: [], messageCount: 0 }),
  }, async ({ domain, calls }) => {
    const before = calls.renderAgentList;
    await domain.openConversationTarget({ threadId: 'wt-1' });
    assert.ok(calls.renderAgentList > before,
      'enterThreadAwaitSurface 落定 activeConversation 后必须触发侧栏重渲');
  });
});

test('竞态守卫：fetch 回来时等待表面已换目标 → 不注入', async () => {
  const thread = {
    threadId: 'wt-1', agentId: 'coder', headSessionId: 'sess-head', status: 'rotating',
    handoffStartedAt: Date.now(), sessionIds: ['sess-head'],
  };
  let resolveFetch;
  await withThreadCase({
    threads: [thread],
    fetchImpl: () => new Promise((resolve) => { resolveFetch = resolve; }),
  }, async ({ c, domain }) => {
    await domain.openConversationTarget({ threadId: 'wt-1' });
    // 模拟重绑已发生：等待表面切到新 head 会话
    c.sandbox.run('window.ClawThreads.activeConversation.sessionId = "sess-next-head";');
    resolveFetch(okJson({ ok: true, messages: HANDOFF_MSGS }));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(c.read('currentMessages.length'), 0, '过期响应不得注入');
  });
});

test('SessionView 身份已切换时拒绝旧等待会话的迟到消息', async () => {
  let resolveFetch;
  const thread = {
    threadId: 'wt-1', agentId: 'coder', headSessionId: 'sess-head', status: 'rotating',
    handoffStartedAt: Date.now(), sessionIds: ['sess-head'],
  };
  await withThreadCase({
    threads: [thread],
    fetchImpl: () => new Promise((resolve) => { resolveFetch = resolve; }),
  }, async ({ c, domain }) => {
    await domain.openConversationTarget({ threadId: 'wt-1' });
    c.sandbox.run('applySessionViewPatch({ identity: { agentId: "coder", sessionId: "sess-other" } })');
    resolveFetch(okJson({ ok: true, messages: HANDOFF_MSGS }));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(c.read('currentMessages.length'), 0, '身份已变更后不得提交旧 Session 的内容');
  });
});

test('挡板死收敛：等待表面 + head 未推进 + 挡板过窗 + 无 runtime → 终结等待 + 失败提示', async () => {
  // 挡板已收敛：线程记录落 open（服务端事务结论），head 仍是等待的旧会话
  const deadThread = {
    threadId: 'wt-1', agentId: 'coder', headSessionId: 'sess-head', status: 'open',
    handoffStartedAt: Date.now() - 6 * 60 * 1000, sessionIds: ['sess-head'],
  };
  await withThreadCase({
    threads: [deadThread],
    fetchImpl: async () => okJson({ threads: [deadThread], contentHash: 'h2' }),
  }, async ({ c, calls }) => {
    c.sandbox.run(`window.ClawThreads.activeConversation = ${JSON.stringify({ agentId: 'coder', threadId: 'wt-1', sessionId: 'sess-head', runtimeId: '', wasHead: true, awaitSurface: true })};`);
    c.sandbox.run('currentRuntimeAgentId = ""; focusedAgentId = "coder";');

    await c.sandbox.run('window.refreshThreads(true)');
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(c.read('window.ClawThreads.activeConversation'), null, '等待态终结');
    assert.equal(calls.toasts.length, 1, '接续失败提示');
    assert.equal(calls.toasts[0].status, 'error');
  });
});

test('挡板仍在新鲜窗（慢接续）→ 不误杀，继续等待', async () => {
  const slowThread = {
    threadId: 'wt-1', agentId: 'coder', headSessionId: 'sess-head', status: 'rotating',
    handoffStartedAt: Date.now() - 60 * 1000, sessionIds: ['sess-head'],
  };
  await withThreadCase({
    threads: [slowThread],
    fetchImpl: async () => okJson({ threads: [slowThread], contentHash: 'h2' }),
  }, async ({ c, calls }) => {
    c.sandbox.run(`window.ClawThreads.activeConversation = ${JSON.stringify({ agentId: 'coder', threadId: 'wt-1', sessionId: 'sess-head', runtimeId: '', wasHead: true, awaitSurface: true })};`);
    c.sandbox.run('currentRuntimeAgentId = ""; focusedAgentId = "coder";');

    await c.sandbox.run('window.refreshThreads(true)');
    await new Promise((resolve) => setImmediate(resolve));

    const selected = c.read('window.ClawThreads.activeConversation');
    assert.ok(selected && selected.awaitSurface === true, '新鲜窗内等待保持');
    assert.equal(calls.toasts.length, 0);
  });
});

test('挡板长时间未收敛（status 仍 rotating）→ 继续等待，不得判成失败', async () => {
  // 这是「接续卡住」在线程记录上的实际形态：挡板立起后服务端迟迟没有
  // commit / fail，status 一直是 rotating。前端曾按本地 5 分钟窗口判
  // 「窗口已过」：视图终结等待态 + 提示失败，而服务端仍按 rotating 拒绝
  // 挂载（409），用户再点又进同一路径——判定分歧本身就是循环的来源。
  // 挡板该不该算结束只有服务端事务能决定，前端只读 status。
  const stuckThread = {
    threadId: 'wt-1', agentId: 'coder', headSessionId: 'sess-head', status: 'rotating',
    handoffStartedAt: Date.now() - 45 * 60 * 1000, sessionIds: ['sess-head'],
  };
  await withThreadCase({
    threads: [stuckThread],
    fetchImpl: async () => okJson({ threads: [stuckThread], contentHash: 'h2' }),
  }, async ({ c, calls }) => {
    c.sandbox.run(`window.ClawThreads.activeConversation = ${JSON.stringify({ agentId: 'coder', threadId: 'wt-1', sessionId: 'sess-head', runtimeId: '', wasHead: true, awaitSurface: true })};`);
    c.sandbox.run('currentRuntimeAgentId = ""; focusedAgentId = "coder";');

    await c.sandbox.run('window.refreshThreads(true)');
    await new Promise((resolve) => setImmediate(resolve));

    const selected = c.read('window.ClawThreads.activeConversation');
    assert.ok(selected && selected.awaitSurface === true, '挡板未收敛时等待表面保持');
    assert.equal(calls.toasts.length, 0, '不得因本地时间窗误报接续失败');
  });
});

test('enterThreadAwaitView：按 threadId 直接挂等待表面，不发起 activate 请求', async () => {
  // 409 分支的专用入口：服务端已判定接续中，前端只挂视图。若此处再走
  // openConversationTarget，会重新读本地线程缓存判挡板并再次发起请求，
  // 与 409 构成循环（一次点击堆出大量「正在启动新会话…」占位）。
  const thread = {
    threadId: 'wt-1', agentId: 'coder', headSessionId: 'sess-head', status: 'rotating',
    handoffStartedAt: Date.now(), sessionIds: ['sess-head'],
  };
  const requests = [];
  await withThreadCase({
    threads: [thread],
    fetchImpl: async (url) => {
      requests.push(String(url));
      return okJson({ ok: true, messages: HANDOFF_MSGS });
    },
  }, async ({ c, domain }) => {
    const result = await domain.enterThreadAwaitView({ threadId: 'wt-1' });
    assert.equal(result.ok, true);

    const selected = c.window.ClawThreads.activeConversation;
    assert.equal(selected.awaitSurface, true, '进入等待表面');
    assert.equal(selected.threadId, 'wt-1');
    assert.equal(selected.sessionId, 'sess-head');
    assert.deepEqual(
      requests.filter((url) => url.includes('/activate')),
      [],
      '不得触发 open_session / activate（再次请求会与 409 循环）',
    );
  });
});
