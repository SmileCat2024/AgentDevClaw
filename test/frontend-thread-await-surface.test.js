// 接续等待表面（挡板窗口）三契约：
//   1. openConversationTarget 等待分支 → enterThreadAwaitSurface：挂等待
//      身份（awaitSurface 标记）并从服务端只读出口拉上一棒消息渲染；
//   2. 消息注入竞态守卫：fetch 回来时等待表面已不在该会话（重绑/切走）
//      → 不注入；
//   3. 挡板死收敛（_reconcileConversationWithThreadHead）：等待表面挂着、
//      挡板过新鲜窗、head 未推进、无 runtime → 终结等待态 + 失败提示；
//      挡板仍在新鲜窗 → 继续等待（不误杀慢接续）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

const threadStoreSource = fs.readFileSync(new URL('../public/src/modules/thread-store.js', import.meta.url), 'utf8');

function loadThreadStore({ threads = [], fetchImpl = async () => ({ ok: false }) } = {}) {
  const calls = { clearChatLoading: 0, reRender: 0, renderAgentList: 0, toasts: [] };
  let ctx;
  ctx = createFrontendSandbox({
    setTimeout: () => 0,
    setInterval: () => 0,
    clearInterval: () => {},
    clearTimeout: () => {},
    fetch: fetchImpl,
    getCurrentHostAgentRecord: () => ({ id: 'coder', source: 'prebuilt' }),
    applySessionViewPatch: (patch) => {
      if (patch?.identity) ctx.run(`globalThis.__viewIdentity = ${JSON.stringify(patch.identity)};`);
    },
    captureSessionViewToken: (_runtimeId, identity) => ({ identity }),
    commitSessionViewPatch: (token, patch, afterCommit) => {
      const current = ctx.run('globalThis.__viewIdentity');
      if (!current || current.agentId !== token.identity?.agentId || current.sessionId !== token.identity?.sessionId) return false;
      ctx.__pendingMessages = patch.messages;
      ctx.run('currentMessages = globalThis.__pendingMessages;');
      afterCommit?.();
      return true;
    },
    getRuntimeWorkspaceSessionId: () => '',
    setViewerSessionBinding: () => {},
    findSidebarOperation: () => null,
    renderAgentList: () => { calls.renderAgentList += 1; },
    updateQueueIndicator: () => {},
    clearChatLoadingSession: () => { calls.clearChatLoading += 1; },
    renderCurrentMainView: () => { calls.reRender += 1; },
    lastRenderedWorkspaceHtml: '',
  });
  ctx.run('globalThis.__toasts = [];');
  ctx.__toastsRef = ctx.run('globalThis.__toasts');
  ctx.window.ClawToast = { show: (t) => { ctx.__toastsRef.push(t); } };
  ctx.window.switchAgent = () => Promise.resolve();
  ctx.window.updateThreadHeaderIndicator = () => {};
  ctx.run(threadStoreSource);
  ctx.run(`window.ClawThreads.threads = ${JSON.stringify(threads)}; (function(){ const s = window.ClawThreads; s.byId = {}; s.sessionIndex = {}; for (const t of s.threads) { s.byId[t.threadId] = t; for (const sid of (t.sessionIds || [])) { s.sessionIndex[t.agentId + '::' + sid] = t; } } })();`);
  ctx.__calls = calls;
  return ctx;
}

const HANDOFF_MSGS = [
  { role: 'system', content: 'sys' },
  { role: 'user', turn: 1, content: '上一棒指令' },
];

function okJson(payload) {
  return {
    ok: true,
    json: async () => payload,
  };
}

test('等待分支：挂 awaitSurface 身份并拉上一棒消息渲染（与 viewer 同形注入）', async () => {
  const now = Date.now();
  const thread = {
    threadId: 'wt-1', agentId: 'coder', headSessionId: 'sess-head', status: 'rotating',
    handoffStartedAt: now, sessionIds: ['sess-head'],
  };
  const ctx = loadThreadStore({
    threads: [thread],
    fetchImpl: async () => okJson({ ok: true, messages: HANDOFF_MSGS, messageCount: HANDOFF_MSGS.length }),
  });

  const result = await ctx.run('window.openConversationTarget({ threadId: "wt-1" })');
  assert.equal(result.ok, true);

  const selected = ctx.run('window.ClawThreads.activeConversation');
  assert.equal(selected.awaitSurface, true, '等待表面身份标记');
  assert.equal(selected.wasHead, true);
  assert.equal(selected.sessionId, 'sess-head');

  // fetch 异步链 flush 后注入
  await new Promise((resolve) => setImmediate(resolve));
  const injected = ctx.run('currentMessages');
  assert.equal(injected.length, 2, '上一棒消息注入 currentMessages');
  assert.equal(injected[1].content, '上一棒指令');
  assert.equal(ctx.run('globalThis.__viewIdentity.sessionId'), 'sess-head');
  assert.ok(ctx.__calls.clearChatLoading >= 1, '有消息时解除加载 spinner');
  assert.ok(ctx.__calls.reRender >= 1, '触发重渲');
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
  const ctx = loadThreadStore({
    threads: [thread],
    fetchImpl: async () => okJson({ ok: true, messages: [], messageCount: 0 }),
  });

  const before = ctx.__calls.renderAgentList;
  await ctx.run('window.openConversationTarget({ threadId: "wt-1" })');
  assert.ok(ctx.__calls.renderAgentList > before,
    'enterThreadAwaitSurface 落定 activeConversation 后必须触发侧栏重渲');
});

test('竞态守卫：fetch 回来时等待表面已换目标 → 不注入', async () => {
  const thread = {
    threadId: 'wt-1', agentId: 'coder', headSessionId: 'sess-head', status: 'rotating',
    handoffStartedAt: Date.now(), sessionIds: ['sess-head'],
  };
  let resolveFetch;
  const ctx = loadThreadStore({
    threads: [thread],
    fetchImpl: () => new Promise((resolve) => { resolveFetch = resolve; }),
  });

  await ctx.run('window.openConversationTarget({ threadId: "wt-1" })');
  // 模拟重绑已发生：等待表面切到新 head 会话
  ctx.run('window.ClawThreads.activeConversation.sessionId = "sess-next-head";');
  resolveFetch(okJson({ ok: true, messages: HANDOFF_MSGS }));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(ctx.run('currentMessages.length'), 0, '过期响应不得注入');
});

test('SessionView 身份已切换时拒绝旧等待会话的迟到消息', async () => {
  let resolveFetch;
  const thread = {
    threadId: 'wt-1', agentId: 'coder', headSessionId: 'sess-head', status: 'rotating',
    handoffStartedAt: Date.now(), sessionIds: ['sess-head'],
  };
  const ctx = loadThreadStore({
    threads: [thread],
    fetchImpl: () => new Promise((resolve) => { resolveFetch = resolve; }),
  });

  await ctx.run('window.openConversationTarget({ threadId: "wt-1" })');
  ctx.run('globalThis.__viewIdentity = { agentId: "coder", sessionId: "sess-other" };');
  resolveFetch(okJson({ ok: true, messages: HANDOFF_MSGS }));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(ctx.run('currentMessages.length'), 0, '身份已变更后不得提交旧 Session 的内容');
});

test('挡板死收敛：等待表面 + head 未推进 + 挡板过窗 + 无 runtime → 终结等待 + 失败提示', async () => {
  // 挡板早已死：handoffStartedAt 远超 5min，线程回 open，head 仍是等待的旧会话
  const deadThread = {
    threadId: 'wt-1', agentId: 'coder', headSessionId: 'sess-head', status: 'open',
    handoffStartedAt: Date.now() - 6 * 60 * 1000, sessionIds: ['sess-head'],
  };
  const ctx = loadThreadStore({
    threads: [deadThread],
    fetchImpl: async () => okJson({ threads: [deadThread], contentHash: 'h2' }),  });
  ctx.run(`window.ClawThreads.activeConversation = ${JSON.stringify({ agentId: 'coder', threadId: 'wt-1', sessionId: 'sess-head', runtimeId: '', wasHead: true, awaitSurface: true })};`);
  ctx.run('currentRuntimeAgentId = ""; focusedAgentId = "coder";');

  await ctx.run('window.refreshThreads(true)');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(ctx.run('window.ClawThreads.activeConversation'), null, '等待态终结');
  assert.equal(ctx.__toastsRef.length, 1, '接续失败提示');
  assert.equal(ctx.__toastsRef[0].status, 'error');
});

test('挡板仍在新鲜窗（慢接续）→ 不误杀，继续等待', async () => {
  const slowThread = {
    threadId: 'wt-1', agentId: 'coder', headSessionId: 'sess-head', status: 'rotating',
    handoffStartedAt: Date.now() - 60 * 1000, sessionIds: ['sess-head'],
  };
  const ctx = loadThreadStore({
    threads: [slowThread],
    fetchImpl: async () => okJson({ threads: [slowThread], contentHash: 'h2' }),
  });
  ctx.run(`window.ClawThreads.activeConversation = ${JSON.stringify({ agentId: 'coder', threadId: 'wt-1', sessionId: 'sess-head', runtimeId: '', wasHead: true, awaitSurface: true })};`);
  ctx.run('currentRuntimeAgentId = ""; focusedAgentId = "coder";');

  await ctx.run('window.refreshThreads(true)');
  await new Promise((resolve) => setImmediate(resolve));

  const selected = ctx.run('window.ClawThreads.activeConversation');
  assert.ok(selected && selected.awaitSurface === true, '新鲜窗内等待保持');
  assert.equal(ctx.__toastsRef.length, 0);
});
