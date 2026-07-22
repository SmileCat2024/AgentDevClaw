import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const mainSource = fs.readFileSync(new URL('../public/src/app-main.js', import.meta.url), 'utf8');
const uiSource = fs.readFileSync(new URL('../public/src/app-ui.js', import.meta.url), 'utf8');

function extractPollSource() {
  const start = mainSource.indexOf('// ── Runtime poll coordinator');
  const end = mainSource.indexOf('// 渲染输入请求', start);
  assert.notEqual(start, -1, 'poll start marker should exist');
  assert.notEqual(end, -1, 'poll end marker should exist');
  return mainSource.slice(start, end);
}

function extractLoadAgentDataSource() {
  const start = mainSource.indexOf('async function loadAgentData(agentId)');
  const end = mainSource.indexOf('\nasync function refreshCurrentRuntimeStatus', start);
  assert.notEqual(start, -1, 'loadAgentData start marker should exist');
  assert.notEqual(end, -1, 'loadAgentData end marker should exist');
  return mainSource.slice(start, end);
}

function extractRuntimeAwareAgentSource() {
  const start = uiSource.indexOf('function _mergeWorkspaceSessions');
  const end = uiSource.indexOf('\nfunction getRuntimeAwareAgentName', start);
  assert.notEqual(start, -1, 'runtime-aware merge start marker should exist');
  assert.notEqual(end, -1, 'runtime-aware merge end marker should exist');
  return uiSource.slice(start, end);
}

function createDeferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createPollSandbox({ blockStatus = true } = {}) {
  const events = [];
  const scheduledPollDelays = [];
  const statusBarrier = createDeferred();
  let fetchCount = 0;
  let statusCallCount = 0;

  const payloads = {
    A: {
      messages: { messages: [{ role: 'assistant', content: 'A' }] },
      overview: { modelName: 'model-a', usageStats: { lastRequestUsage: { inputTokens: 111 } } },
      input: [],
    },
    B: {
      messages: { messages: [{ role: 'assistant', content: 'B' }] },
      overview: { modelName: 'model-b', usageStats: { lastRequestUsage: { inputTokens: 999 } } },
      input: [{
        requestId: 'choice-b',
        mode: 'choices',
        questions: [{ id: 'q', options: [] }],
      }],
    },
  };

  const sandbox = {
    console,
    Date,
    JSON,
    Promise,
    Map,
    Set,
    clearTimeout: () => {},
    setTimeout: (_callback, delay) => {
      scheduledPollDelays.push(delay);
      return scheduledPollDelays.length;
    },
    window: { lastInputRequests: [], _lastWsSessionRefreshAt: Date.now() },
    prebuiltSessionSwitchInFlight: false,
    POLL_FAST_INTERVAL_MS: 1,
    POLL_INTERVAL_MS: 1,
    _switchEpoch: 1,
    _lastChoiceAlertCheckAt: Date.now(),
    lastFeatureTemplateReloadAt: Date.now(),
    FEATURE_TEMPLATE_MAP: { loaded: true },
    currentRuntimeAgentId: 'A',
    currentAgentId: 'programming-helper',
    currentRuntimeConnected: true,
    currentMessages: payloads.A.messages.messages,
    currentInputRequests: payloads.A.input,
    currentOverviewSnapshot: payloads.A.overview,
    currentOverviewSignature: JSON.stringify(payloads.A.overview),
    currentTodoPlan: {},
    currentTodoPlanSignature: '',
    currentHookInspector: {},
    currentHookInspectorSignature: '',
    activeFeaturePanel: null,
    logPanelScope: 'current',
    lastAgentListRefreshAt: Date.now(),
    allAgents: [],
    _partialCompactInFlight: false,
    _partialCompactRuntimeId: null,
    suppressSidebarRerender: false,
    _localQueuedInputPending: false,
    normalizeAgentIdentity: (value) => String(value || '').trim(),
    checkGlobalChoiceAlerts: async () => {},
    reloadFeatureTemplateMap: async () => {},
    updateNotificationStatus: () => {},
    loadAgents: async () => {},
    refreshAgentCallStates: async () => {},
    refreshCurrentRuntimeStatus: () => {
      statusCallCount += 1;
      return blockStatus ? statusBarrier.promise : Promise.resolve();
    },
    fetch: async (url) => {
      fetchCount += 1;
      const runtime = String(url).includes('/A/') ? 'A' : 'B';
      const payload = payloads[runtime];
      let body = {};
      if (String(url).endsWith('/messages')) body = payload.messages;
      else if (String(url).endsWith('/input-requests')) body = payload.input;
      else if (String(url).endsWith('/overview')) body = payload.overview;
      return {
        ok: !String(url).endsWith('/todo'),
        status: String(url).endsWith('/todo') ? 500 : 200,
        json: async () => structuredClone(body),
      };
    },
    clearPartialCompactState: () => {},
    getRuntimeRecord: () => null,
    resolveWorkspaceFallbackAgentId: () => null,
    selectWorkspaceSurface: () => {},
    getEmptyTodoPlan: () => ({}),
    renderCurrentMainView: () => {},
    renderInputRequests: (requests) => {
      sandbox.currentInputRequests = requests;
      events.push({
        kind: 'input-render',
        runtime: sandbox.currentRuntimeAgentId,
        requests: requests.map((item) => item.requestId),
      });
    },
    clearChatLoadingSession: () => {},
    markAutoTitleCandidate: () => {},
    findFirstChangedMessageIndex: () => -1,
    shouldRenderWorkspaceSurface: () => false,
    appendNewMessages: () => {},
    updateLastMessage: () => {},
    _syncPersistentActionButton: () => {},
    _syncPersistentInputUi: () => {},
    normalizeOverviewSnapshot: (value) => value,
    getOverviewSignature: (value) => JSON.stringify(value),
    renderFeaturePanel: () => {},
    updateChatContextBar: () => {
      events.push({
        kind: 'usage-render',
        runtime: sandbox.currentRuntimeAgentId,
        used: sandbox.currentOverviewSnapshot?.usageStats?.lastRequestUsage?.inputTokens || 0,
      });
    },
    normalizeTodoPlan: (value) => value,
    getTodoPlanSignature: (value) => JSON.stringify(value),
    getInterruptTargetId: () => null,
    setInterruptTargetId: () => {},
    updatePlanBadge: () => {},
    isChatSurfaceActive: () => true,
    updateRollbackActionVisibility: () => {},
    isRuntimeCalling: () => false,
    tryAutoTitleGeneration: () => {},
    loadedAgentDetailIds: new Set(),
    isWorkspaceHostUnit: () => false,
    loadLogs: async () => {},
    normalizeHookInspector: (value) => value,
    getHookInspectorSignature: (value) => JSON.stringify(value),
    saveCurrentRuntimeToCache: (runtime) => events.push({
      kind: 'cache-write',
      runtime,
      overviewUsed: sandbox.currentOverviewSnapshot?.usageStats?.lastRequestUsage?.inputTokens || 0,
      requests: sandbox.currentInputRequests.map((item) => item.requestId),
    }),
    _trackRecapSessionPresence: () => {},
    recheckAutoTitleCandidate: () => {},
  };

  vm.createContext(sandbox);
  vm.runInContext(`${extractPollSource()}\nglobalThis.__poll = poll;`, sandbox);

  return {
    sandbox,
    events,
    payloads,
    releaseStatus: statusBarrier.resolve,
    getFetchCount: () => fetchCount,
    getStatusCallCount: () => statusCallCount,
    getScheduledPollDelays: () => scheduledPollDelays.slice(),
  };
}

test('a poll response that becomes stale after its first guard cannot overwrite the new session', async () => {
  const harness = createPollSandbox();
  const oldPoll = harness.sandbox.__poll();
  await new Promise((resolve) => setImmediate(resolve));

  harness.sandbox.currentRuntimeAgentId = 'B';
  harness.sandbox._switchEpoch += 1;
  harness.sandbox.currentMessages = harness.payloads.B.messages.messages;
  harness.sandbox.currentInputRequests = harness.payloads.B.input;
  harness.sandbox.window.lastInputRequests = harness.payloads.B.input;
  harness.sandbox.currentOverviewSnapshot = harness.payloads.B.overview;
  harness.sandbox.currentOverviewSignature = JSON.stringify(harness.payloads.B.overview);

  harness.releaseStatus();
  await oldPoll;

  assert.equal(
    harness.sandbox.currentOverviewSnapshot.usageStats.lastRequestUsage.inputTokens,
    999,
    'old A overview must not overwrite B usage',
  );
  assert.deepEqual(
    harness.sandbox.currentInputRequests.map((item) => item.requestId),
    ['choice-b'],
    'old A input requests must not hide B choice UI',
  );
  assert.deepEqual(harness.events, [], 'stale A must not render or write B cache');
});

test('concurrent poll calls share one in-flight cycle', async () => {
  const harness = createPollSandbox();
  const first = harness.sandbox.__poll();
  const second = harness.sandbox.__poll();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.getStatusCallCount(), 1);
  assert.equal(harness.getFetchCount(), 4);

  harness.releaseStatus();
  await Promise.all([first, second]);
  assert.equal(
    harness.getScheduledPollDelays().at(-1),
    0,
    'an immediate refresh request during an in-flight cycle should run next',
  );
});

test('loadAgentData discards response bodies that finish after a newer switch', async () => {
  const toolsBarrier = createDeferred();
  const renders = [];
  const sandbox = {
    console,
    Promise,
    currentAgentId: 'programming-helper',
    currentRuntimeAgentId: 'A',
    currentMessages: [{ role: 'assistant', content: 'A' }],
    currentInputRequests: [],
    currentOverviewSnapshot: { modelName: 'model-a' },
    currentTodoPlan: {},
    currentWorkspaceArtifactDetail: null,
    currentWorkspaceDocsetDetail: null,
    currentProjectDocsetOpen: false,
    currentProjectRequirementEdit: null,
    currentProjectDocsetPage: 'requirement',
    currentWorkspaceTab: 'chat',
    currentHookInspector: {},
    currentHookInspectorSignature: '',
    toolRenderConfigs: {},
    TOOL_NAMES: {},
    activeFeaturePanel: null,
    _switchEpoch: 1,
    _lastCallFinishTime: 0,
    _currentRecapText: '',
    _recapPendingTrigger: false,
    window: { lastInputRequests: [] },
    isUiOnlyAgentId: () => false,
    normalizeAgentIdentity: (value) => String(value || '').trim(),
    activateUserCollapseStateForContext: () => {},
    getRuntimeContextKey: (value) => `runtime:${value}`,
    fetch: async (url) => {
      const path = String(url);
      let json;
      if (path.endsWith('/messages')) json = async () => ({ messages: [{ role: 'assistant', content: 'A response' }] });
      else if (path.endsWith('/tools')) json = async () => { await toolsBarrier.promise; return []; };
      else if (path.endsWith('/hooks')) json = async () => ({ owner: 'A' });
      else if (path.endsWith('/overview')) json = async () => ({ modelName: 'model-a-response' });
      else if (path.endsWith('/input-requests')) json = async () => [];
      else json = async () => ({});
      return { ok: !path.endsWith('/todo'), json };
    },
    loadAgentDetail: async () => {},
    setCurrentHookInspector: (value) => { sandbox.currentHookInspector = value; },
    setCurrentOverviewSnapshot: (value) => { sandbox.currentOverviewSnapshot = value; },
    setCurrentTodoPlan: (value) => { sandbox.currentTodoPlan = value; },
    getEmptyTodoPlan: () => ({}),
    recheckAutoTitleCandidate: () => {},
    clearChatLoadingSession: () => {},
    renderInputRequests: (value) => {
      sandbox.currentInputRequests = value;
      renders.push('input');
    },
    updateRollbackActionVisibility: () => {},
    renderCurrentMainView: () => { renders.push('main'); },
    refreshCurrentRuntimeStatus: async () => {},
    loadLogs: async () => {},
    renderFeaturePanel: () => { renders.push('feature'); },
    warmTemplatesInBackground: () => {},
    collectTemplateNames: () => [],
    updateNotificationStatus: () => {},
    resetRuntimeBackedSurfaceState: () => {},
  };

  vm.createContext(sandbox);
  vm.runInContext(`${extractLoadAgentDataSource()}\nglobalThis.__loadAgentData = loadAgentData;`, sandbox);

  const oldLoad = sandbox.__loadAgentData('A');
  await new Promise((resolve) => setImmediate(resolve));

  sandbox.currentRuntimeAgentId = 'B';
  sandbox._switchEpoch += 1;
  sandbox.currentMessages = [{ role: 'assistant', content: 'B' }];
  sandbox.currentInputRequests = [{ requestId: 'choice-b' }];
  sandbox.window.lastInputRequests = sandbox.currentInputRequests;
  sandbox.currentOverviewSnapshot = { modelName: 'model-b' };

  toolsBarrier.resolve();
  await oldLoad;

  assert.equal(sandbox.currentOverviewSnapshot.modelName, 'model-b');
  assert.equal(sandbox.currentMessages[0].content, 'B');
  assert.deepEqual(sandbox.currentInputRequests.map((item) => item.requestId), ['choice-b']);
  assert.deepEqual(renders, []);
});

test('runtime-aware session projection uses the selected runtime session over stale host active metadata', () => {
  const host = {
    id: 'programming-helper',
    active_workspace_session_id: 'B',
    workspace_sessions: {
      activeSessionId: 'B',
      sessions: [
        { id: 'A', tokenUsage: { lastRequestUsage: { inputTokens: 111 } } },
        { id: 'B', tokenUsage: { lastRequestUsage: { inputTokens: 999 } } },
      ],
    },
  };
  const runtime = {
    id: 'runtime-a',
    parent_id: 'programming-helper',
    active_workspace_session_id: 'A',
  };
  const sandbox = {
    getCurrentAgentRecord: () => host,
    getCurrentRuntimeRecord: () => runtime,
  };
  vm.createContext(sandbox);
  vm.runInContext(`${extractRuntimeAwareAgentSource()}\nglobalThis.__record = getRuntimeAwareAgentRecord();`, sandbox);

  assert.equal(sandbox.__record.active_workspace_session_id, 'A');
  assert.equal(sandbox.__record.workspace_sessions.activeSessionId, 'A');
});
