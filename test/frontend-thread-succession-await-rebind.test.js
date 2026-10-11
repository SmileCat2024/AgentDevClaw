// T014a：等待重绑窗口（ADR-0024 接续零感知）——挡板已清与重绑落定之间的
// poll 404 不得踢出视图。
//
// 机制背景（真实事故：接续直接断掉、啥也没有直到新会话诞生）：
// 服务端 advanceHead 原子清挡板后毫秒级发布 head-advanced；前端重绑要等
// threads 事实对账 / 事件处理器完成网络往返才落定。此间隙的 poll 404 若
// 落回原生清理（清 currentRuntimeAgentId / focusedAgentId），重绑守卫的
// host 解析失败 → 重绑静默中断。
//
// 豁免扩展的事实锚：视图身份冻结在本线程且冻结时是 head（wasHead），此后
// head 被 successor 接管。历史成员浏览（wasHead=false）、用户已离开线程、
// 终态线程均不占用该窗口，保持原 404 踢出语义。豁免是纯保持：重绑由
// thread-store 的 threads 事实对账（唯一实现）驱动，此处不做任何主动动作。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const mainSource = fs.readFileSync(new URL('../public/src/app-main.js', import.meta.url), 'utf8');

function extractNotFoundHandler() {
  const start = mainSource.indexOf('async function handleCoreResponsesNotFound(pollToken)');
  const end = mainSource.indexOf('async function runMessagesProbeCycle', start);
  assert.notEqual(start, -1, 'handleCoreResponsesNotFound should exist');
  assert.notEqual(end, -1, 'runMessagesProbeCycle marker should exist');
  return mainSource.slice(start, end);
}

function createSandbox({
  thread,
  activeConversation,
} = {}) {
  const calls = { refresh: [], commit: 0, selectSurface: 0, renderMainView: 0, schedulePoll: [] };
  const sandbox = {
    console,
    Date,
    Number,
    String,
    Promise,
    Array,
    window: {},
    normalizeAgentIdentity: (x) => String(x || '').trim(),
    prebuiltSessionSwitchInFlight: false,
    suppressSidebarRerender: false,
    schedulePoll(delay) { calls.schedulePoll.push(delay); },
    POLL_FAST_INTERVAL_MS: 1000,
    POLL_INTERVAL_MS: 5000,
    getRuntimeWorkspaceSessionId: () => 'session-old',
    getCurrentHostAgentRecord: () => ({ id: 'coder' }),
    getRuntimeRecord: () => null,
    resolveWorkspaceFallbackAgentId: () => 'fallback-ws',
    commitSessionViewPatch: () => { calls.commit += 1; return true; },
    // ADR-0026 迁移后 handleCoreResponsesNotFound 以会话视图令牌守卫入口；
    // 令牌新鲜度语义由 frontend-poll-session-consistency.test.js 覆盖，
    // 本文件只考察 404 豁免的接续决策，守卫恒放行。
    isSessionViewTokenCurrent: () => true,
    selectWorkspaceSurface() { calls.selectSurface += 1; },
    renderCurrentMainView() { calls.renderMainView += 1; },
    loadAgents: async () => {},
    allAgents: [],
    _agentCallActive: new Set(),
    clearInterruptSuppression() {},
    focusedAgentId: 'coder',
    currentWorkspaceTab: null,
    currentRuntimeAgentId: 'rt-old',
    _partialCompactInFlight: false,
    _partialCompactRuntimeId: null,
    clearPartialCompactState() {},
  };
  sandbox.window.getThreadForSession = (_agentId, sid) => (thread && sid === 'session-old' ? thread : null);
  sandbox.window.refreshThreads = async (force = false) => { calls.refresh.push(force); };
  sandbox.window.ClawThreads = { activeConversation: activeConversation || null };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(extractNotFoundHandler(), sandbox);
  return { sandbox, calls };
}

// 等待重绑窗口的标准线程事实：挡板已清（advanceHead 落定）、head 已推进。
function advancedThread() {
  return {
    threadId: 'wt-1', agentId: 'coder', status: 'open',
    handoffStartedAt: 0,
    headSessionId: 'session-new', sessionIds: ['session-old', 'session-new'],
  };
}

function frozenOnOldHead() {
  return {
    agentId: 'coder', threadId: 'wt-1', sessionId: 'session-old',
    runtimeId: 'rt-old', wasHead: true,
  };
}

test('T014a-1: 挡板已清 + head 已推进 + 视图冻结在本线程旧 head → 不踢出', async () => {
  const { sandbox, calls } = createSandbox({
    thread: advancedThread(),
    activeConversation: frozenOnOldHead(),
  });
  const handled = await vm.runInContext('handleCoreResponsesNotFound({ runtimeId: "rt-old" })', sandbox);
  assert.equal(handled, true);
  assert.equal(calls.commit, 0, '等待重绑窗口不得走踢出提交');
  assert.ok(calls.schedulePoll.includes(1000), '保持快轮询等待重绑落定');
});

test('T014a-2: 豁免纯保持——不做任何主动切换（重绑归 threads 事实对账唯一实现）', async () => {
  const { sandbox, calls } = createSandbox({
    thread: advancedThread(),
    activeConversation: frozenOnOldHead(),
    // successor 已可见时豁免分支也不得自行切换：那是事实对账的职责，
    // 双路径会产生行为分叉（历史教训：fallback 造成虚假的正确）。
  });
  await vm.runInContext('handleCoreResponsesNotFound({ runtimeId: "rt-old" })', sandbox);
  assert.equal(calls.commit, 0);
  assert.equal(sandbox.currentRuntimeAgentId, 'rt-old', '豁免分支不得改动 runtime 态');
  assert.equal(sandbox.focusedAgentId, 'coder', '豁免分支不得改动焦点');
  assert.equal(calls.renderMainView, 0, '豁免分支不得重渲主视图');
});

test('T014a-4: 历史成员浏览（wasHead=false）→ 保持原 404 踢出语义', async () => {
  const { sandbox, calls } = createSandbox({
    thread: advancedThread(),
    activeConversation: {
      agentId: 'coder', threadId: 'wt-1', sessionId: 'session-old',
      runtimeId: 'rt-old', wasHead: false,
    },
  });
  await vm.runInContext('handleCoreResponsesNotFound({ runtimeId: "rt-old" })', sandbox);
  assert.equal(calls.commit, 1, '历史成员 runtime 消失仍是真实会话死亡语义');
});

test('T014a-5: 视图身份已不在线程（用户离开）→ 踢出语义保持', async () => {
  const { sandbox, calls } = createSandbox({
    thread: advancedThread(),
    activeConversation: {
      agentId: 'coder', threadId: 'wt-other', sessionId: 'session-other',
      runtimeId: '', wasHead: true,
    },
  });
  await vm.runInContext('handleCoreResponsesNotFound({ runtimeId: "rt-old" })', sandbox);
  assert.equal(calls.commit, 1, '用户已离开线程时 404 不得豁免');
});

test('T014a-6: 终态线程（closed）→ 踢出语义保持（豁免不得永久循环）', async () => {
  const thread = advancedThread();
  thread.status = 'closed';
  const { sandbox, calls } = createSandbox({
    thread,
    activeConversation: frozenOnOldHead(),
  });
  await vm.runInContext('handleCoreResponsesNotFound({ runtimeId: "rt-old" })', sandbox);
  assert.equal(calls.commit, 1, 'closed 线程不得进入等待重绑豁免');
});

test('T014a-7: head 未推进（挡板清了但 head 未换代，如 rotation 失败收敛后）→ 踢出语义保持', async () => {
  const { sandbox, calls } = createSandbox({
    thread: {
      threadId: 'wt-1', agentId: 'coder', status: 'open',
      handoffStartedAt: 0,
      headSessionId: 'session-old', sessionIds: ['session-old'],
    },
    activeConversation: frozenOnOldHead(),
  });
  await vm.runInContext('handleCoreResponsesNotFound({ runtimeId: "rt-old" })', sandbox);
  assert.equal(calls.commit, 1, 'head 未换代时等待重绑前提不成立');
});
