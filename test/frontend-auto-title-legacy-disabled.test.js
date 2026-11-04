/**
 * ADR-0041：壳层自动标题已硬屏蔽。
 *
 * 这些用例保护的承诺是：**无论会话处于什么状态、应用有没有声明 titlePolicy，
 * Web 壳层都不再自动起名、也不发标题请求**。三个对话型应用（编程小助手 /
 * coder / memo）都装配了 AutoTitlePolicyFeature 自行决定触发时机，壳层若同时
 * 触发，同一会话会被两条链路各起一次名。
 *
 * 历史实现的代码仍留在 auto-title.js 里作为行为参照，因此这里刻意用真实源码
 * 在沙箱中执行，验证的是「屏蔽确实生效」，而不是「相关函数已被删除」。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const autoTitleSource = fs.readFileSync(
  new URL('../public/src/modules/auto-title.js', import.meta.url),
  'utf8',
);

function createHarness(overrides = {}) {
  const fetchCalls = [];
  const host = {
    id: 'programming-helper',
    source: 'prebuilt',
    ...overrides,
    workspace_sessions: {
      activeSessionId: 'session-head',
      // 占位会话：按历史逻辑这正是"应该起名"的状态，用来证明屏蔽不依赖状态。
      sessions: [{ id: 'session-head', title: '新对话1', titleState: 'placeholder' }],
    },
  };
  const runtime = {
    id: 'runtime-head',
    source: 'child',
    parent_id: 'programming-helper',
    active_workspace_session_id: 'session-head',
    active_workspace_session_title: '',
    workspace_sessions: { sessions: [] },
  };
  const sandbox = {
    AbortController,
    ClawToast: { show() {} },
    Date,
    JSON,
    Math,
    Promise,
    Set,
    Map,
    String,
    Array,
    currentRuntimeAgentId: 'runtime-head',
    focusedAgentId: 'programming-helper',
    currentLanguage: 'zh',
    currentMessages: [],
    window: {},
    allAgents: [host, runtime],
    _autoTitleTriggered: new Set(),
    getCurrentAgentRecord: () => host,
    normalizeAgentIdentity: (value) => String(value || '').trim(),
    getLogicalAgentId: (record) => record.parent_id || record.id,
    getAgentRuntimeId: (record) => record.runtime_session_id || record.id,
    isRuntimeCalling: () => false,
    applySessionMutationDelta() {},
    fetch: async (url, options) => {
      fetchCalls.push({ url, options });
      return { ok: true, json: async () => ({ ok: true, title: '修复线程标题生成' }) };
    },
    setTimeout: () => 1,
    clearTimeout() {},
    console: { log() {}, warn() {} },
    crypto: { randomUUID: () => 'test-key' },
  };
  vm.createContext(sandbox);
  vm.runInContext(autoTitleSource, sandbox);
  return {
    sandbox,
    fetchCalls,
    pending: vm.runInContext('_autoTitlePending', sandbox),
    triggered: vm.runInContext('_autoTitleTriggered', sandbox),
  };
}

const FIRST_TURN = [
  { role: 'user', content: '请修复线程标题生成' },
  { role: 'assistant', content: '我来检查并修复。' },
];

test('shell registers no title candidate for a placeholder session', () => {
  const { sandbox, pending } = createHarness();
  sandbox.markAutoTitleCandidate([], FIRST_TURN);
  assert.equal(pending.has('session-head'), false,
    'a placeholder session must not become a shell candidate');
});

test('shell recheck registers no candidate either', () => {
  const { sandbox, pending } = createHarness();
  sandbox.currentMessages = FIRST_TURN;
  sandbox.recheckAutoTitleCandidate();
  assert.equal(pending.has('session-head'), false,
    'the post-load recheck must not resurrect the shell trigger');
});

test('shell dispatches no title request on the poll path', () => {
  const { sandbox, fetchCalls } = createHarness();
  sandbox.markAutoTitleCandidate([], FIRST_TURN);
  sandbox.tryAutoTitleGeneration(FIRST_TURN);
  assert.equal(fetchCalls.length, 0,
    'the shell must not request title generation');
});

test('direct call to the generator is blocked before any network effect', async () => {
  // 第二道闸：即使有调用方绕过三个入口直接调这个内部函数，也不能发请求。
  const { sandbox, fetchCalls, triggered } = createHarness();
  await sandbox.autoGenerateSessionTitle('programming-helper', 'session-head', true);
  assert.equal(fetchCalls.length, 0,
    'the generator must return before issuing the request');
  assert.equal(triggered.size, 0);
});

test('disablement does not depend on the application title policy declaration', () => {
  // 已声明与未声明的应用都不得由壳层起名——屏蔽是全局的，不是"让位"。
  for (const overrides of [{}, { titlePolicy: 'app' }]) {
    const { sandbox, pending, fetchCalls } = createHarness(overrides);
    sandbox.markAutoTitleCandidate([], FIRST_TURN);
    sandbox.tryAutoTitleGeneration(FIRST_TURN);
    assert.equal(pending.has('session-head'), false,
      `no candidate expected (titlePolicy=${String(overrides.titlePolicy)})`);
    assert.equal(fetchCalls.length, 0,
      `no request expected (titlePolicy=${String(overrides.titlePolicy)})`);
  }
});
