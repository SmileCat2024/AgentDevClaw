// 会话绝对隔离（ADR-0025 收尾续）：全局线程指向（activeConversation）不得
// 把别的会话的输入串到线程。三处防线：
//   1. getActiveThreadInputTarget：提交点消费的一致性校验入口——视图与
//      指向不符返回 null；
//   2. _syncActiveThreadSubscription 等待重绑豁免以宿主焦点为界：用户切
//      到别的工作空间后豁免失效，残留被重建清除；
//   3. openConversationTarget 接续等待分支传 awaitSessionId：点击侧栏接续
//      占位条目落在该会话的聊天加载表面，不落工作空间首页。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

const threadStoreSource = fs.readFileSync(new URL('../public/src/modules/thread-store.js', import.meta.url), 'utf8');

function loadThreadStore({ hostAgentId = 'programming-helper', runtimeId = 'rt-ph', runtimeSessionId = 'sess-A', threads = [] } = {}) {
  const ctx = createFrontendSandbox({
    // 顶层启动的周期刷新在测试进程中不执行（VM timer stub）
    setTimeout: () => 0,
    setInterval: () => 0,
    clearInterval: () => {},
    clearTimeout: () => {},
    getCurrentHostAgentRecord: () => ({ id: hostAgentId, source: 'prebuilt' }),
    applySessionViewPatch: () => {},
    captureSessionViewToken: () => ({}),
    commitSessionViewPatch: () => false,
    getRuntimeWorkspaceSessionId: (rid) => (rid === runtimeId ? runtimeSessionId : ''),
    setViewerSessionBinding: () => {},
    findSidebarOperation: () => null,
    renderAgentList: () => {},
    updateQueueIndicator: () => {},
    lastRenderedWorkspaceHtml: '',
  });
  ctx.window.switchAgent = () => Promise.resolve();
  ctx.run(threadStoreSource);
  ctx.run(`window.ClawThreads.threads = ${JSON.stringify(threads)}; (function(){ const s = window.ClawThreads; s.byId = {}; s.sessionIndex = {}; for (const t of s.threads) { s.byId[t.threadId] = t; for (const sid of (t.sessionIds || [])) { s.sessionIndex[t.agentId + '::' + sid] = t; } } })();`);
  return ctx;
}

const WT = {
  threadId: 'wt-1',
  agentId: 'coder',
  headSessionId: 'sess-head',
  status: 'open',
  handoffStartedAt: Date.now(),
  headViewerAgentId: 'viewer-1',
  sessionIds: ['sess-head', 'sess-old'],
};

test('getActiveThreadInputTarget：宿主已切走（残留指向他空间线程）→ null，输入不串线', () => {
  const ctx = loadThreadStore({ hostAgentId: 'programming-helper', threads: [WT] });
  ctx.run(`window.ClawThreads.activeConversation = ${JSON.stringify({ agentId: 'coder', threadId: 'wt-1', sessionId: 'sess-head', runtimeId: '', wasHead: true })};`);
  // 用户在 ph 会话 A 视图，全局残留指向 coder 线程
  ctx.run('currentRuntimeAgentId = "rt-ph"; focusedAgentId = "programming-helper";');
  assert.equal(ctx.run('window.getActiveThreadInputTarget()'), null,
    '宿主不一致：残留不得作为输入目标');
});

test('getActiveThreadInputTarget：视图确属该线程（head 健康 / 等待重绑）→ 返回指向', () => {
  // head 健康：宿主 coder，runtime 绑定 head 会话
  const healthy = loadThreadStore({ hostAgentId: 'coder', runtimeId: 'rt-coder', runtimeSessionId: 'sess-head', threads: [WT] });
  healthy.run(`window.ClawThreads.activeConversation = ${JSON.stringify({ agentId: 'coder', threadId: 'wt-1', sessionId: 'sess-head', runtimeId: 'rt-coder', wasHead: true })};`);
  healthy.run('currentRuntimeAgentId = "rt-coder"; focusedAgentId = "coder";');
  const r1 = healthy.run('window.getActiveThreadInputTarget()');
  assert.ok(r1 && r1.threadId === 'wt-1', '视图一致：正常返回');

  // 等待重绑：runtime 态被 404 清空，宿主焦点仍在 coder（_currentActiveSession 回退为指向自身）
  const awaiting = loadThreadStore({ hostAgentId: 'coder', runtimeId: '', runtimeSessionId: '', threads: [WT] });
  awaiting.run(`window.ClawThreads.activeConversation = ${JSON.stringify({ agentId: 'coder', threadId: 'wt-1', sessionId: 'sess-head', runtimeId: '', wasHead: true })};`);
  awaiting.run('currentRuntimeAgentId = ""; focusedAgentId = "coder";');
  const r2 = awaiting.run('window.getActiveThreadInputTarget()');
  assert.ok(r2 && r2.threadId === 'wt-1', '等待重绑态：宿主一致 + 回退一致，返回指向');
});

test('_syncActiveThreadSubscription：等待重绑豁免以宿主焦点为界——切走即清残留', () => {
  // 宿主切走（ph）：豁免失效，activeConversation 重建为 threadId:''
  const away = loadThreadStore({ hostAgentId: 'programming-helper', runtimeId: 'rt-ph', runtimeSessionId: 'sess-A', threads: [WT] });
  away.run(`window.ClawThreads.activeConversation = ${JSON.stringify({ agentId: 'coder', threadId: 'wt-1', sessionId: 'sess-head', runtimeId: '', wasHead: true })};`);
  away.run('currentRuntimeAgentId = "rt-ph"; focusedAgentId = "programming-helper";');
  away.run('_syncActiveThreadSubscription();');
  assert.equal(away.run('String(window.ClawThreads.activeConversation.threadId || "")'), '',
    '宿主已切走：残留线程指向被清除');

  // 宿主仍是 coder（runtime 态清空的等待窗口）：豁免保留，等待 head-advanced 重绑
  const held = loadThreadStore({ hostAgentId: 'coder', runtimeId: '', runtimeSessionId: '', threads: [WT] });
  held.run(`window.ClawThreads.activeConversation = ${JSON.stringify({ agentId: 'coder', threadId: 'wt-1', sessionId: 'sess-head', runtimeId: '', wasHead: true })};`);
  held.run('currentRuntimeAgentId = ""; focusedAgentId = "coder";');
  held.run('_syncActiveThreadSubscription();');
  assert.equal(held.run('String(window.ClawThreads.activeConversation.threadId || "")'), 'wt-1',
    '宿主未切走：等待重绑豁免保留线程指向');
});

test('openConversationTarget 接续等待分支：switchAgent 收到 awaitSessionId（聊天加载表面，不落首页）', async () => {
  const ctx = loadThreadStore({ hostAgentId: 'programming-helper', runtimeId: 'rt-ph', runtimeSessionId: 'sess-A', threads: [WT] });
  ctx.run('currentRuntimeAgentId = "rt-ph"; focusedAgentId = "programming-helper";');
  const calls = [];
  ctx.window.switchAgent = (id, options) => { calls.push({ id, options }); return Promise.resolve(); };
  const result = await ctx.run(`window.openConversationTarget({ agentId: 'coder', threadId: 'wt-1' })`);
  assert.ok(result?.ok, '等待分支挂线程成功');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, 'coder');
  assert.equal(calls[0].options?.awaitSessionId, 'sess-head',
    '接续窗口点击：切换目标携带等待会话身份（awaitSessionId）');
});
