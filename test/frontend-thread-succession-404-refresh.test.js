// T013a：404 接续豁免不得依赖可能过期的线程缓存。
//
// 真实事故（2026-10-10 21:16 接续#1）：SSE handoff-started 丢失 / 刷新竞态
// 导致客户端 threads 缓存无挡板事实，旧 head 退役引发的 /responses 404
// 直接走踢出路径（视图退回工作空间）。豁免判定必须建立在决策时刻的
// 权威数据上：会话映射到线程但挡板不新鲜时，先强制刷新线程事实再重判。
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

function createSandbox({ threadForSession, refreshImpl } = {}) {
  const calls = { refresh: [], commit: 0, selectSurface: 0, renderMainView: 0, schedulePoll: [] };
  const sandbox = {
    console,
    Date,
    Number,
    String,
    Promise,
    window: {},
    _partialCompactInFlight: false,
    _partialCompactRuntimeId: null,
    clearPartialCompactState() {},
    normalizeAgentIdentity: (x) => x,
    prebuiltSessionSwitchInFlight: false,
    suppressSidebarRerender: false,
    schedulePoll(delay) { calls.schedulePoll.push(delay); },
    POLL_FAST_INTERVAL_MS: 1000,
    POLL_INTERVAL_MS: 5000,
    getRuntimeWorkspaceSessionId: () => 'sess-old-head',
    getCurrentHostAgentRecord: () => ({ id: 'programming-helper' }),
    getRuntimeRecord: () => null,
    resolveWorkspaceFallbackAgentId: () => 'fallback-ws',
    commitSessionViewPatch: () => { calls.commit += 1; return true; },
    selectWorkspaceSurface() { calls.selectSurface += 1; },
    renderCurrentMainView() { calls.renderMainView += 1; },
    loadAgents: async () => {},
    _agentCallActive: new Set(),
    clearInterruptSuppression() {},
    focusedAgentId: 'some-agent',
    currentWorkspaceTab: null,
    currentRuntimeAgentId: 'rt-old',
  };
  sandbox.window.getThreadForSession = threadForSession || (() => null);
  sandbox.window.refreshThreads = async (force = false) => {
    calls.refresh.push(force);
    if (refreshImpl) await refreshImpl();
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  return { sandbox, calls };
}

test('T013a-1: 404 时线程缓存过期 → 强制刷新线程事实后豁免，不踢出', async () => {
  const store = { 'sess-old-head': { id: 'wt-1', handoffStartedAt: 0 } };
  const { sandbox, calls } = createSandbox({
    threadForSession: (_agentId, sid) => store[sid] || null,
    // 强制刷新拉到服务端挡板事实（刷新前缓存过期，刷新后挡板新鲜）
    refreshImpl: () => { store['sess-old-head'].handoffStartedAt = Date.now(); },
  });
  vm.runInContext(extractNotFoundHandler(), sandbox);
  const handled = await vm.runInContext('handleCoreResponsesNotFound({ runtimeId: "rt-old" })', sandbox);
  assert.equal(handled, true);
  assert.ok(calls.refresh.includes(true), '应对过期缓存发起强制线程刷新');
  assert.equal(calls.commit, 0, '挡板确认为新鲜后不得走踢出提交');
});

test('T013a-2: 刷新后仍无挡板 → 正常踢出（真实会话死亡语义不变）', async () => {
  const store = { 'sess-old-head': { id: 'wt-1', handoffStartedAt: 0 } };
  const { sandbox, calls } = createSandbox({
    threadForSession: (_agentId, sid) => store[sid] || null,
    refreshImpl: () => { store['sess-old-head'].handoffStartedAt = 0; },
  });
  vm.runInContext(extractNotFoundHandler(), sandbox);
  await vm.runInContext('handleCoreResponsesNotFound({ runtimeId: "rt-old" })', sandbox);
  assert.equal(calls.commit, 1, '刷新后仍无新鲜挡板 → 踢出语义保持');
});

test('T013a-3: 会话不隶属任何线程 → 不发起刷新，直接正常处理', async () => {
  const { sandbox, calls } = createSandbox({
    threadForSession: () => null,
  });
  vm.runInContext(extractNotFoundHandler(), sandbox);
  await vm.runInContext('handleCoreResponsesNotFound({ runtimeId: "rt-old" })', sandbox);
  assert.equal(calls.refresh.length, 0, '非线程会话不应触发线程强制刷新');
  assert.equal(calls.commit, 1);
});
