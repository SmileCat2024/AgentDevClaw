/**
 * Frontend incremental message polling (ADR-0012 probe + tail).
 *
 * Locks the poll data-fetch contract introduced by ticket 08:
 *
 *   probe (rides /overview) → classify → fetch delta or skip →
 *   splice back a full array → commit through the untouched render
 *   state machine (appendNewMessages / updateLastMessage /
 *   renderCurrentMainView).
 *
 * Covered here:
 *   - four fetch paths: unchanged (zero /messages requests), append
 *     (?since=N spliced onto the known prefix), tail (?tail=1 replacing
 *     the last entry), rewrite (full refetch)
 *   - degradations to a full baseline rebuild: delta length mismatch,
 *     probe.count regression, probe missing
 *   - the probe never pollutes getOverviewSignature
 *   - dev metrics stay silent unless ?msg_metrics=1 is present
 *
 * Follows the vm-sandbox pattern of frontend-poll-session-consistency.test.js:
 * the real poll coordinator source is extracted from app-main.js and executed
 * against real session-view-state.js + overview-data.js sources.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const mainSource = fs.readFileSync(new URL('../public/src/app-main.js', import.meta.url), 'utf8');
const sessionViewStateSource = fs.readFileSync(
  new URL('../public/src/modules/session-view-state.js', import.meta.url),
  'utf8',
);
const overviewDataSource = fs.readFileSync(
  new URL('../public/src/modules/overview-data.js', import.meta.url),
  'utf8',
);

function extractPollSource() {
  const start = mainSource.indexOf('// ── Runtime poll coordinator');
  const end = mainSource.indexOf('// ── Input request rendering → modules/input-render.js', start);
  assert.notEqual(start, -1, 'poll start marker should exist');
  assert.notEqual(end, -1, 'poll end marker should exist');
  return mainSource.slice(start, end);
}

function msg(content) {
  return { role: 'assistant', content };
}

// Values crossing the vm realm carry a foreign Array/Object prototype, which
// deepStrictEqual rejects; round-trip through JSON before structural compares.
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function createSandbox({
  initialMessages = [],
  overview = {},
  messagesResponder,
  search = '',
} = {}) {
  const fetchCalls = [];
  const scheduledDelays = [];
  const consoleRecords = { debug: [], warn: [], error: [] };
  const renders = { append: [], updateLast: [], fullRender: 0 };
  const sandbox = {
    console: {
      debug: (...args) => consoleRecords.debug.push(args),
      warn: (...args) => consoleRecords.warn.push(args),
      error: (...args) => consoleRecords.error.push(args),
      log: () => {},
    },
    Date,
    JSON,
    Promise,
    Map,
    Set,
    URLSearchParams,
    TextEncoder,
    clearTimeout: () => {},
    setTimeout: (_callback, delay) => {
      scheduledDelays.push(delay);
      return scheduledDelays.length;
    },
    window: {
      lastInputRequests: [],
      _lastWsSessionRefreshAt: Date.now(),
      location: { search },
    },
    prebuiltSessionSwitchInFlight: false,
    POLL_FAST_INTERVAL_MS: 1,
    POLL_INTERVAL_MS: 1,
    _switchEpoch: 1,
    _lastChoiceAlertCheckAt: Date.now(),
    lastFeatureTemplateReloadAt: Date.now(),
    FEATURE_TEMPLATE_MAP: { loaded: true },
    currentRuntimeAgentId: 'rt',
    focusedAgentId: 'programming-helper',
    currentRuntimeConnected: true,
    currentWorkspaceTab: null,
    currentMessages: initialMessages,
    currentInputRequests: [],
    toolRenderConfigs: {},
    TOOL_NAMES: {},
    currentOverviewSnapshot: {},
    currentOverviewSignature: '',
    currentTodoPlan: {},
    currentTodoPlanSignature: '',
    currentHookInspector: {},
    currentHookInspectorSignature: '',
    selectedFeatureName: null,
    activeFeaturePanel: null,
    logPanelScope: 'current',
    lastAgentListRefreshAt: Date.now(),
    allAgents: [],
    _partialCompactInFlight: false,
    _partialCompactRuntimeId: null,
    _lastInterruptUserActionAt: Date.now(),
    _lastTodoForceContinueUserActionAt: Date.now(),
    suppressSidebarRerender: false,
    _localQueuedInputPending: false,
    loadedAgentDetailIds: new Set(),
    normalizeAgentIdentity: (value) => String(value || '').trim(),
    checkGlobalChoiceAlerts: async () => {},
    reloadFeatureTemplateMap: async () => {},
    updateNotificationStatus: () => {},
    loadAgents: async () => {},
    refreshAgentCallStates: async () => {},
    refreshCurrentRuntimeStatus: async () => {},
    fetch: async (url) => {
      const path = String(url);
      fetchCalls.push(path);
      const respond = (body, status = 200) => ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => JSON.parse(JSON.stringify(body)),
      });
      if (path.endsWith('/input-requests')) return respond([]);
      if (path.endsWith('/todo')) return respond({}, 500);
      if (path.endsWith('/overview')) return respond(overview);
      if (path.includes('/messages')) {
        const result = messagesResponder
          ? messagesResponder(path)
          : { status: 200, body: { messages: JSON.parse(JSON.stringify(initialMessages)) } };
        return respond(result.body, result.status);
      }
      return respond({});
    },
    clearPartialCompactState: () => {},
    getRuntimeRecord: () => null,
    resolveWorkspaceFallbackAgentId: () => null,
    selectWorkspaceSurface: () => {},
    getEmptyTodoPlan: () => ({}),
    renderCurrentMainView: () => { renders.fullRender += 1; },
    renderInputRequests: () => {},
    clearChatLoadingSession: () => {},
    markAutoTitleCandidate: () => {},
    findFirstChangedMessageIndex: (next, prev) => {
      const length = Math.min(next.length, prev.length);
      for (let i = 0; i < length; i++) {
        if (JSON.stringify(next[i]) !== JSON.stringify(prev[i])) return i;
      }
      return next.length === prev.length ? -1 : length;
    },
    shouldRenderWorkspaceSurface: () => false,
    appendNewMessages: (newMessages) => { renders.append.push(newMessages); },
    updateLastMessage: (message) => { renders.updateLast.push(message); },
    _syncPersistentActionButton: () => {},
    _syncPersistentInputUi: () => {},
    normalizeTodoPlan: (value) => value,
    getTodoPlanSignature: (value) => JSON.stringify(value),
    setCurrentTodoPlan: (value) => {
      sandbox.currentTodoPlan = value;
      sandbox.currentTodoPlanSignature = JSON.stringify(value);
    },
    getTodoForceContinue: () => null,
    setTodoForceContinue: () => {},
    getInterruptTargetId: () => null,
    setInterruptTargetId: () => {},
    updatePlanBadge: () => {},
    renderFeaturePanel: () => {},
    isChatSurfaceActive: () => true,
    updateRollbackActionVisibility: () => {},
    isRuntimeCalling: () => false,
    tryAutoTitleGeneration: () => {},
    isWorkspaceHostUnit: () => false,
    loadLogs: async () => {},
    saveCurrentRuntimeToCache: () => {},
    _trackRecapSessionPresence: () => {},
    recheckAutoTitleCandidate: () => {},
  };

  vm.createContext(sandbox);
  vm.runInContext(
    `${sessionViewStateSource}\n${overviewDataSource}\n${extractPollSource()}\n`
      + 'globalThis.__poll = poll;',
    sandbox,
  );

  return { sandbox, fetchCalls, consoleRecords, renders, scheduledDelays };
}

function messageCalls(fetchCalls) {
  return fetchCalls.filter((url) => url.includes('/messages'));
}

// ── Four fetch paths ──────────────────────────────────────────

test('unchanged probe skips the /messages request and reuses the known array', async () => {
  const initial = [msg('m1'), msg('m2')];
  const harness = createSandbox({
    initialMessages: initial,
    overview: {
      modelName: 'model-a',
      _messagesProbe: { count: 2, changeKind: null, sinceIndex: 2, fakeFullBytes: 500 },
    },
  });

  await harness.sandbox.__poll();

  assert.equal(messageCalls(harness.fetchCalls).length, 0, 'unchanged cycle must not fetch /messages');
  assert.deepEqual(plain(harness.sandbox.currentMessages), [msg('m1'), msg('m2')]);
  assert.deepEqual(harness.renders.append, []);
  assert.deepEqual(harness.renders.updateLast, []);
  assert.equal(harness.renders.fullRender, 0, 'unchanged cycle must not repaint the transcript');
});

test('append fetches ?since=<known count> and splices onto the known prefix', async () => {
  const m3 = msg('m3');
  const harness = createSandbox({
    initialMessages: [msg('m1'), msg('m2')],
    overview: {
      modelName: 'model-a',
      _messagesProbe: { seq: 1, count: 3, changeKind: 'append', sinceIndex: 2, fakeFullBytes: 600 },
    },
    messagesResponder: (path) => {
      assert.ok(path.endsWith('/messages?since=2'), `unexpected messages url: ${path}`);
      return { status: 200, body: { messages: [m3], baseCount: 2 } };
    },
  });

  await harness.sandbox.__poll();

  assert.equal(messageCalls(harness.fetchCalls).length, 1);
  assert.deepEqual(plain(harness.sandbox.currentMessages), [msg('m1'), msg('m2'), m3]);
  assert.deepEqual(plain(harness.renders.append), [[m3]], 'render state machine must take the append branch');
  assert.deepEqual(harness.renders.updateLast, []);
  assert.equal(harness.renders.fullRender, 0);
});

test('tail fetches ?tail=1 and replaces only the last entry', async () => {
  const m2v2 = msg('m2-streamed');
  const harness = createSandbox({
    initialMessages: [msg('m1'), msg('m2-streaming')],
    overview: {
      modelName: 'model-a',
      _messagesProbe: { seq: 1, count: 2, changeKind: 'tail', sinceIndex: 1, fakeFullBytes: 700 },
    },
    messagesResponder: (path) => {
      assert.ok(path.endsWith('/messages?tail=1'), `unexpected messages url: ${path}`);
      return { status: 200, body: { messages: [m2v2] } };
    },
  });

  await harness.sandbox.__poll();

  assert.equal(messageCalls(harness.fetchCalls).length, 1);
  assert.deepEqual(plain(harness.sandbox.currentMessages), [msg('m1'), m2v2]);
  assert.deepEqual(plain(harness.renders.updateLast), [m2v2], 'render state machine must take the update-last branch');
  assert.deepEqual(harness.renders.append, []);
  assert.equal(harness.renders.fullRender, 0);
});

test('rewrite falls back to a full fetch and rebuilds the array', async () => {
  const rewritten = [msg('r1'), msg('r2')];
  const harness = createSandbox({
    initialMessages: [msg('m1'), msg('m2'), msg('m3')],
    overview: {
      modelName: 'model-a',
      _messagesProbe: { seq: 1, count: 2, changeKind: 'rewrite', sinceIndex: 0, fakeFullBytes: 800 },
    },
    messagesResponder: (path) => {
      assert.ok(path.endsWith('/messages'), `rewrite must fetch without query: ${path}`);
      return { status: 200, body: { agentId: 'rt', messages: rewritten } };
    },
  });

  await harness.sandbox.__poll();

  assert.equal(messageCalls(harness.fetchCalls).length, 1);
  assert.deepEqual(plain(harness.sandbox.currentMessages), rewritten);
  assert.equal(harness.renders.fullRender, 1, 'render state machine must take the full rebuild branch');
});

// ── Degradation: full fetch rebuilds the baseline ─────────────

test('append delta length mismatch degrades to a full fetch and rebuilds the baseline', async () => {
  const full = [msg('f1'), msg('f2'), msg('f3')];
  const harness = createSandbox({
    initialMessages: [msg('m1'), msg('m2')],
    overview: {
      modelName: 'model-a',
      _messagesProbe: { seq: 1, count: 4, changeKind: 'append', sinceIndex: 2, fakeFullBytes: 900 },
    },
    messagesResponder: (path) => {
      if (path.endsWith('/messages?since=2')) {
        // Server classified append but returned fewer deltas than promised.
        return { status: 200, body: { messages: [msg('m3')], baseCount: 2 } };
      }
      assert.ok(path.endsWith('/messages'), `degradation must fetch full: ${path}`);
      return { status: 200, body: { messages: full } };
    },
  });

  await harness.sandbox.__poll();

  assert.deepEqual(
    messageCalls(harness.fetchCalls),
    ['/api/agents/rt/messages?since=2', '/api/agents/rt/messages'],
    'cycle must fetch the delta, fail validation, then fetch full',
  );
  assert.deepEqual(plain(harness.sandbox.currentMessages), full);
});

test('probe.count regression skips the delta fetch and rebuilds the baseline', async () => {
  const full = [msg('f1')];
  const harness = createSandbox({
    initialMessages: [msg('m1'), msg('m2'), msg('m3')],
    overview: {
      modelName: 'model-a',
      _messagesProbe: { seq: 1, count: 1, changeKind: 'append', sinceIndex: 0, fakeFullBytes: 100 },
    },
    messagesResponder: (path) => {
      assert.ok(path.endsWith('/messages'), `count regression must fetch full directly: ${path}`);
      return { status: 200, body: { messages: full } };
    },
  });

  await harness.sandbox.__poll();

  assert.deepEqual(messageCalls(harness.fetchCalls), ['/api/agents/rt/messages']);
  assert.deepEqual(plain(harness.sandbox.currentMessages), full);
});

test('missing probe keeps the legacy full-fetch path', async () => {
  const full = [msg('m1'), msg('m2')];
  const harness = createSandbox({
    initialMessages: [],
    overview: { modelName: 'model-a' },
    messagesResponder: (path) => {
      assert.ok(path.endsWith('/messages'), `probe-less cycle must fetch full: ${path}`);
      return { status: 200, body: { messages: full } };
    },
  });

  await harness.sandbox.__poll();

  assert.deepEqual(messageCalls(harness.fetchCalls), ['/api/agents/rt/messages']);
  assert.deepEqual(plain(harness.sandbox.currentMessages), full);
});

// ── Probe isolation from the overview signature ───────────────

test('probe fields are stripped from the snapshot and do not change the signature', () => {
  const sandbox = { Set };
  vm.createContext(sandbox);
  vm.runInContext(overviewDataSource, sandbox);

  const base = { modelName: 'model-a', updatedAt: 1, context: { messageCount: 3 } };
  const withProbe = {
    ...base,
    _messagesProbe: { seq: 2, count: 3, changeKind: 'tail', sinceIndex: 2, fakeFullBytes: 4321 },
  };

  const sigWithout = vm.runInContext(
    `getOverviewSignature(${JSON.stringify(base)})`,
    sandbox,
  );
  const sigWith = vm.runInContext(
    `getOverviewSignature(${JSON.stringify(withProbe)})`,
    sandbox,
  );
  assert.equal(sigWith, sigWithout, 'probe must not pollute the overview signature');

  const normalized = vm.runInContext(
    `normalizeOverviewSnapshot(${JSON.stringify(withProbe)})`,
    sandbox,
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(normalized, '_messagesProbe'),
    false,
    'probe must not enter the view snapshot',
  );
});

test('extractMessagesProbe validates fields and returns null when unusable', () => {
  const sandbox = { Set };
  vm.createContext(sandbox);
  vm.runInContext(overviewDataSource, sandbox);

  const run = (expr) => vm.runInContext(expr, sandbox);

  assert.deepEqual(plain(run('extractMessagesProbe({ _messagesProbe: { seq: 5, count: 3, changeKind: "tail", sinceIndex: 2, fakeFullBytes: 12 } })')), {
    seq: 5,
    count: 3,
    changeKind: 'tail',
    sinceIndex: 2,
    fakeFullBytes: 12,
  });
  assert.deepEqual(plain(run('extractMessagesProbe({ _messagesProbe: { seq: 0, count: 0, changeKind: null, fakeFullBytes: 0 } })')), {
    seq: 0,
    count: 0,
    changeKind: null,
    sinceIndex: null,
    fakeFullBytes: 0,
  });
  assert.equal(run('extractMessagesProbe({})'), null, 'absent probe must read as unavailable');
  assert.equal(run('extractMessagesProbe(null)'), null);
  assert.equal(run('extractMessagesProbe({ _messagesProbe: { count: -1, changeKind: "append" } })'), null,
    'negative count must read as unavailable');
  assert.equal(run('extractMessagesProbe({ _messagesProbe: { count: 2, changeKind: "bogus" } })'), null,
    'unknown changeKind must read as unavailable');
});

// ── Dev metrics ───────────────────────────────────────────────

test('metrics stay silent when the URL switch is off', async () => {
  const harness = createSandbox({
    initialMessages: [msg('m1')],
    overview: {
      modelName: 'model-a',
      _messagesProbe: { count: 1, changeKind: null, sinceIndex: 1, fakeFullBytes: 100 },
    },
    search: '',
  });

  await harness.sandbox.__poll();

  assert.equal(harness.consoleRecords.debug.length, 0, 'no [msg-metrics] output without ?msg_metrics=1');
});

test('metrics emit actual/fake bytes, savedRatio, changeKind and downgraded flag', async () => {
  const harness = createSandbox({
    initialMessages: [msg('m1'), msg('m2')],
    overview: {
      modelName: 'model-a',
      _messagesProbe: { count: 2, changeKind: null, sinceIndex: 2, fakeFullBytes: 500 },
    },
    search: '?msg_metrics=1',
  });

  await harness.sandbox.__poll();

  assert.equal(harness.consoleRecords.debug.length, 1);
  const [tag, payload] = harness.consoleRecords.debug[0];
  assert.equal(tag, '[msg-metrics]');
  assert.deepEqual(plain(payload), {
    actualBytes: 0, // zero-request cycle
    fakeFullBytes: 500,
    savedRatio: 1,
    changeKind: null,
    downgraded: false,
  });
});

test('metrics record a downgraded cycle with accumulated bytes from both fetches', async () => {
  const harness = createSandbox({
    initialMessages: [msg('m1'), msg('m2')],
    overview: {
      modelName: 'model-a',
      _messagesProbe: { seq: 1, count: 4, changeKind: 'append', sinceIndex: 2, fakeFullBytes: 1000 },
    },
    search: '?msg_metrics=1',
    messagesResponder: (path) => {
      if (path.endsWith('/messages?since=2')) {
        return { status: 200, body: { messages: [msg('m3')], baseCount: 2 } };
      }
      return { status: 200, body: { messages: [msg('f1'), msg('f2'), msg('f3')] } };
    },
  });

  await harness.sandbox.__poll();

  assert.equal(harness.consoleRecords.debug.length, 1);
  const [, payload] = harness.consoleRecords.debug[0];
  assert.equal(payload.downgraded, true);
  assert.equal(payload.changeKind, 'append');
  assert.ok(payload.actualBytes > 0, 'bytes from both the delta and the full fetch must be counted');
  assert.ok(payload.savedRatio < 1, 'a downgraded cycle cannot claim savings');
});

// ── Seq reconciliation (ADR-0012 v2) ──────────────────────────
// probe.seq is the sync version number; changeKind is only a fetch-strategy
// hint for the LAST real change. These tests lock the fix for the
// first-message-delay regression: a no-op push after the user message enters
// the transcript must NOT hide the pending change from the frontend.

test('seq advance triggers the delta fetch even when changeKind is null', async () => {
  // Regression shape: user message landed (append, seq=1), then a no-op push
  // (old viewer cleared changeKind to null). The seq gate must still see the
  // pending change because count advanced past the known baseline.
  const m3 = msg('m3');
  const harness = createSandbox({
    initialMessages: [msg('m1'), msg('m2')],
    overview: {
      modelName: 'model-a',
      // changeKind null = the no-op push overwrote the classification hint
      _messagesProbe: { seq: 1, count: 3, changeKind: null, sinceIndex: 3, fakeFullBytes: 600 },
    },
    messagesResponder: (path) => {
      assert.ok(path.endsWith('/messages?since=2'), `unexpected messages url: ${path}`);
      return { status: 200, body: { messages: [m3], baseCount: 2 } };
    },
  });

  await harness.sandbox.__poll();

  assert.equal(messageCalls(harness.fetchCalls).length, 1, 'count advance with stale hint must still fetch');
  assert.deepEqual(plain(harness.sandbox.currentMessages), [msg('m1'), msg('m2'), m3]);
  assert.deepEqual(plain(harness.renders.append), [[m3]]);
});

test('same count with equal seq skips the fetch even when changeKind lingers', async () => {
  // changeKind is a last-real-change hint, not a sync signal: an applied
  // append (seq already consumed) must not re-fetch on every cycle.
  const harness = createSandbox({
    initialMessages: [msg('m1'), msg('m2')],
    overview: {
      modelName: 'model-a',
      _messagesProbe: { seq: 1, count: 2, changeKind: 'append', sinceIndex: 1, fakeFullBytes: 500 },
    },
  });

  // First cycle: baseline never applied for this seq → full fetch is expected
  // via the prevKnownCount===0 gate? No — initialMessages pre-populates the
  // array, and this harness starts with no applied seq, so the first cycle
  // sees seq advance (0 → 1) with equal count and changeKind append. The
  // since-fetch validation (delta.length === count - since) fails → full.
  await harness.sandbox.__poll();
  const firstCycleCalls = messageCalls(harness.fetchCalls).length;
  assert.ok(firstCycleCalls >= 1, 'first cycle must reconcile the unseen seq');

  // Second cycle: seq already applied → zero /messages requests.
  harness.fetchCalls.length = 0;
  await harness.sandbox.__poll();
  assert.equal(messageCalls(harness.fetchCalls).length, 0,
    'applied seq with unchanged count must skip /messages entirely');
});

test('same count with advanced seq and tail hint takes the tail path once', async () => {
  // rewrite/tail with unchanged count: the seq gate ensures the change is
  // applied exactly once, then subsequent cycles skip.
  const m2v2 = msg('m2-streamed');
  let tailServed = 0;
  const harness = createSandbox({
    initialMessages: [msg('m1'), msg('m2-streaming')],
    overview: {
      modelName: 'model-a',
      _messagesProbe: { seq: 1, count: 2, changeKind: 'tail', sinceIndex: 1, fakeFullBytes: 700 },
    },
    messagesResponder: (path) => {
      assert.ok(path.endsWith('/messages?tail=1'), `unexpected messages url: ${path}`);
      tailServed += 1;
      return { status: 200, body: { messages: [m2v2] } };
    },
  });

  await harness.sandbox.__poll();
  assert.equal(tailServed, 1);
  assert.deepEqual(plain(harness.sandbox.currentMessages), [msg('m1'), m2v2]);

  // Next cycle: seq consumed → no fetch, applied tail stays.
  harness.fetchCalls.length = 0;
  await harness.sandbox.__poll();
  assert.equal(messageCalls(harness.fetchCalls).length, 0, 'applied tail must not refetch');
  assert.deepEqual(plain(harness.sandbox.currentMessages), [msg('m1'), m2v2]);
});

test('count equal but seq advanced without a usable hint degrades to full once', async () => {
  // count unchanged, seq advanced, changeKind null (hint overwritten by a
  // no-op): content changed somewhere unknown → full fetch to stay correct.
  const full = [msg('m1'), msg('m2-REPLACED')];
  const harness = createSandbox({
    initialMessages: [msg('m1'), msg('m2')],
    overview: {
      modelName: 'model-a',
      _messagesProbe: { seq: 1, count: 2, changeKind: null, sinceIndex: 2, fakeFullBytes: 500 },
    },
    messagesResponder: (path) => {
      assert.ok(path.endsWith('/messages'), `unknown-content change must fetch full: ${path}`);
      return { status: 200, body: { messages: full } };
    },
  });

  await harness.sandbox.__poll();

  assert.deepEqual(messageCalls(harness.fetchCalls), ['/api/agents/rt/messages']);
  assert.deepEqual(plain(harness.sandbox.currentMessages), full);

  // Applied → subsequent cycles skip.
  harness.fetchCalls.length = 0;
  await harness.sandbox.__poll();
  assert.equal(messageCalls(harness.fetchCalls).length, 0);
});
