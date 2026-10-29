import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const autoTitleSource = fs.readFileSync(
  new URL('../public/src/modules/auto-title.js', import.meta.url),
  'utf8',
);

function createHarness() {
  const fetchCalls = [];
  const host = {
    id: 'programming-helper',
    source: 'prebuilt',
    workspace_sessions: {
      activeSessionId: 'session-head',
      sessions: [],
    },
  };
  const runtime = {
    id: 'runtime-head',
    source: 'child',
    parent_id: 'programming-helper',
    active_workspace_session_id: 'session-head',
    // A transient connected-agents snapshot can have the current Session ID
    // before its title metadata is available.
    active_workspace_session_title: '' /* deliberately unavailable during this snapshot */,
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
      return {
        ok: true,
        json: async () => ({ ok: true, title: '修复线程标题生成' }),
      };
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
    host,
    pending: vm.runInContext('_autoTitlePending', sandbox),
  };
}

test('new thread head remains a title candidate when runtime title metadata is temporarily empty', () => {
  const { sandbox, fetchCalls, pending, host } = createHarness();
  const previous = [];
  const next = [
    { role: 'user', content: '请修复线程标题生成' },
    { role: 'assistant', content: '我来检查并修复。' },
  ];

  sandbox.markAutoTitleCandidate(previous, next);
  assert.equal(pending.has('session-head'), true,
    'the 0→1 user/assistant transition must remain pending until title metadata resolves');

  // Simulate the next connected-agents snapshot carrying the authoritative
  // title after a transient empty projection. The pending idle head must dispatch.
  host.workspace_sessions.sessions.push({ id: 'session-head', title: '新对话1' });
  sandbox.tryAutoTitleGeneration(next);

  assert.equal(fetchCalls.length, 1, 'a completed first response must dispatch title generation');
  assert.equal(fetchCalls[0].url, '/protoclaw/generate_session_title');
  assert.deepEqual(JSON.parse(fetchCalls[0].options.body), {
    agentId: 'programming-helper',
    sessionId: 'session-head',
  });
});
