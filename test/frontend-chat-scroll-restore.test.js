/**
 * Tests for the switchAgent → render-full reading-position restore handoff.
 *
 * Bug (fixed): switchAgent used to write the cached scrollTop directly to the
 * chat container before rendering the new session. At that moment the container
 * still holds the OUTGOING session's DOM, so a restore value taller than the
 * old content got clamped by the browser; render-full then read the clamped
 * value as preserveTop and the reading position was permanently destroyed
 * (switching back from a short session to a long one landed at the top).
 *
 * The fix routes the restore value through setPendingChatScrollRestore() /
 * consumePendingChatScrollRestore() in chat-viewport.js so the next full render
 * preserves the intended value regardless of the outgoing DOM's height.
 *
 * These tests load the real chat-viewport.js and the real switchAgent block
 * from app-main.js into a vm sandbox with a minimal fake DOM (clamping
 * scrollTop semantics), mirroring the harness style of
 * frontend-poll-session-consistency.test.js.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const mainSource = fs.readFileSync(new URL('../public/src/app-main.js', import.meta.url), 'utf8');
const rendererSource = fs.readFileSync(new URL('../public/src/modules/chat-renderer.js', import.meta.url), 'utf8');
const viewportSource = fs.readFileSync(new URL('../public/src/modules/chat-viewport.js', import.meta.url), 'utf8');

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(start, -1, `${startMarker} marker should exist`);
  assert.notEqual(end, -1, `${endMarker} marker should exist`);
  return source.slice(start, end);
}

function extractSwitchAgentSource() {
  return sourceBetween(
    mainSource,
    'window.switchAgent = async (newAgentId) => {',
    '\n// ── Context menu action handlers',
  );
}

/**
 * Minimal chat container with browser-style scrollTop clamping:
 * scrollTop is always clamped to [0, scrollHeight - clientHeight].
 */
function createFakeContainer() {
  const container = {
    _scrollTop: 0,
    _rows: [],
    clientHeight: 400,
    scrollHeight: 400,
    addEventListener() {},
    removeEventListener() {},
    querySelector() { return null; },
    querySelectorAll(selector) {
      return selector === '.message-row' ? container._rows : [];
    },
  };
  Object.defineProperty(container, 'scrollTop', {
    get() { return container._scrollTop; },
    set(value) {
      container._scrollTop = Math.max(
        0,
        Math.min(Number(value) || 0, container.scrollHeight - container.clientHeight),
      );
    },
  });
  return container;
}

function createHandoffHarness({ cache = {} } = {}) {
  const container = createFakeContainer();
  const calls = {
    setFollowLatest: [],
    saveCurrentRuntimeToCache: [],
    resetRuntimeStatusForSwitch: 0,
    applySessionViewPatch: [],
    renderMainView: [],
  };

  // Timer / rAF capture so settlement can be pumped deterministically.
  const timers = new Map();
  let timerSeq = 1;
  const rafCallbacks = new Map();
  const rafOrder = [];
  let rafSeq = 1;

  // Chat height is driven by the message count (rows * 100px + no extra chrome):
  // renderCurrentMainView mirrors the real render() — the empty-state branch
  // rebuilds the DOM WITHOUT notifying (no lock), the full branch notifies
  // with the pending-restore-aware preserveTop.
  const renderChatFromMessages = () => {
    const rows = sandbox.currentMessages.length;
    container._rows = Array.from({ length: rows }, () => ({
      classList: { contains: () => false },
    }));
    container.scrollHeight = rows > 0 ? rows * 100 : container.clientHeight;
    calls.renderMainView.push(sandbox.currentRuntimeAgentId);
    if (rows === 0) return; // real render() empty branch: no notify, no lock
    const savedScrollTop = sandbox.__consumePendingChatScrollRestore() ?? container.scrollTop;
    sandbox.__notifyChatViewportMutation({
      reason: 'render-full',
      shouldFollow: sandbox.followLatestEnabled,
      preserveTop: sandbox.followLatestEnabled ? null : savedScrollTop,
      forceSnap: sandbox.followLatestEnabled,
      allowChase: false,
    });
  };

  const sandbox = {
    console,
    Date,
    JSON,
    Math,
    Promise,
    Map,
    Set,
    Number,
    Object,
    Array,
    window: { alert: () => {} },

    setTimeout(callback) {
      const id = timerSeq++;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    requestAnimationFrame(callback) {
      const id = rafSeq++;
      rafCallbacks.set(id, callback);
      rafOrder.push(id);
      return id;
    },
    cancelAnimationFrame(id) {
      rafCallbacks.delete(id);
      const index = rafOrder.indexOf(id);
      if (index >= 0) rafOrder.splice(index, 1);
    },

    MutationObserver: class {
      constructor(callback) { this.callback = callback; }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    ResizeObserver: class {
      constructor(callback) { this.callback = callback; }
      observe() {}
      unobserve() {}
      disconnect() {}
    },

    document: {
      getElementById: () => null,
      body: { contains: () => false },
      createElement: () => ({ style: {}, classList: { add() {}, contains: () => false } }),
    },

    container,
    followLatestButton: {
      classList: { toggle() {}, contains: () => false },
      innerHTML: '',
    },
    workspaceTabsBar: null,
    currentMessages: [],

    isChatSurfaceActive: () => true,
    shouldRenderWorkspaceSurface: () => false,
    escapeHtml: (value) => String(value),
    t: (key) => key,

    // ── chat-viewport.js module state (normally declared in app-core.js) ──
    followLatestEnabled: false,
    suppressFollowScrollEvent: false,
    lastManualScrollIntentAt: 0,
    _progScrollCooldownUntil: 0,
    followLatestEntryUntil: 0,
    chatViewportObserversReady: false,
    chatViewportObserverSuppressDepth: 0,
    chatViewportObserverQuietUntil: 0,
    chatViewportMutationObserver: null,
    chatViewportResizeObserver: null,
    chatViewportSettlementToken: 0,
    chatViewportSettlementRaf: 0,
    chatViewportSettlementTimer: null,
    chatViewportSettlementContext: null,
    chatViewportFollowRaf: 0,
    chatViewportFollowToken: 0,
    chatViewportFollowTransition: '',
    assemblySideRailRevealTimer: null,

    // ── app-main.js module state ──
    focusedAgentId: 'hostA',
    currentRuntimeAgentId: 'A',
    readOnlyMode: false,
    currentWorkspaceArtifactDetail: null,
    currentWorkspaceDocsetDetail: null,
    currentProjectDocsetOpen: false,
    currentProjectRequirementEdit: null,
    currentProjectDocsetPage: 'requirement',
    currentWorkspaceTab: 'chat',
    _lastRenderedChatSig: '',
    showChatProcess: false,
    lastRenderedWorkspaceHtml: '',
    _restoredScrollTop: null,
    _switchEpoch: 0,
    _navigationGuardEpoch: 0,
    pendingSwitchTarget: null,
    _recentlyFinishedRuntimes: new Set(),
    _agentCallActive: new Map(),

    // ── switchAgent dependencies ──
    bumpNavigationGuard: () => {},
    closeAgentContextMenu: () => {},
    findAgentByIdentity: () => null,
    // switchAgent's remote read-only branch (ADR-0008 Phase 1) consults this
    // namespace check when no local record matches the requested id.
    isRemoteNamespaceAgentId: (value) => String(value || '').startsWith('remote:'),
    getLogicalAgentId: (agent) => agent?.parent_id || agent?.id || null,
    isWorkspaceSurfaceUnit: () => false,
    isWorkspaceHostUnit: () => false,
    _storeVisibleSessionInputDraft: () => {},
    saveCurrentRuntimeToCache: (runtimeId) => {
      calls.saveCurrentRuntimeToCache.push(runtimeId);
    },
    setViewerSessionBinding: () => {},
    _deriveRuntimeSessionIdFromAgents: () => null,
    getActiveWorkspaceSessionId: () => null,
    resetRuntimeStatusForSwitch: () => { calls.resetRuntimeStatusForSwitch += 1; },
    activateUserCollapseStateForContext: () => {},
    getRuntimeContextKey: (runtimeId) => `ctx:${runtimeId}`,
    restoreRuntimeFromCache: (runtimeId) => {
      const cached = cache[runtimeId];
      if (!cached) {
        sandbox._restoredScrollTop = null;
        return null;
      }
      sandbox.followLatestEnabled = !!cached.followLatest;
      sandbox._restoredScrollTop = typeof cached.scrollTop === 'number' ? cached.scrollTop : null;
      sandbox.currentMessages = cached.messages ? cached.messages.slice() : [];
      return { ok: true };
    },
    // Simulates the real render()'s full-render scroll semantics (chat-renderer.js):
    // swap the DOM to the new session, then preserve either the pending
    // switch-restore value or the live scrollTop, exactly like the real code.
    renderCurrentMainView: renderChatFromMessages,
    renderFeaturePanel: () => {},
    applySessionViewPatch: (patch) => {
      calls.applySessionViewPatch.push(patch);
      if (patch && Array.isArray(patch.messages)) {
        sandbox.currentMessages = patch.messages.slice();
      }
    },
    getEmptyOverviewSnapshot: () => ({}),
    getEmptyTodoPlan: () => ({}),
    // setFollowLatest / beginFollowLatest* resolve to the REAL functions from
    // chat-viewport.js (loaded below) — vm top-level function declarations
    // overwrite same-named sandbox properties. Assert on followLatestEnabled.
    renderAgentList: () => {},
    normalizeAgentIdentity: (value) => String(value || '').trim(),
    resolveNotificationCallingState: () => false,
    _markAgentCallStartedForNotify: () => {},
    _syncPersistentActionButton: () => {},
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    loadAgentData: async () => {},
    loadAgents: async () => {},
  };

  vm.createContext(sandbox);
  vm.runInContext(`${viewportSource}\n${extractSwitchAgentSource()}\n`
    + 'globalThis.__notifyChatViewportMutation = notifyChatViewportMutation;\n'
    + 'globalThis.__setPendingChatScrollRestore = setPendingChatScrollRestore;\n'
    + 'globalThis.__consumePendingChatScrollRestore = consumePendingChatScrollRestore;\n'
    + 'globalThis.__switchAgent = window.switchAgent;', sandbox);

  const flushTimers = () => {
    const pending = [...timers.values()];
    timers.clear();
    pending.forEach((callback) => callback());
  };
  const pumpFrame = () => {
    const ids = rafOrder.splice(0);
    ids.forEach((id) => {
      const callback = rafCallbacks.get(id);
      rafCallbacks.delete(id);
      if (callback) callback();
    });
  };
  // notifyChatViewportMutation schedules setTimeout(0) → rAF(settle); settle
  // needs two stable metric frames before applying preserveTop / locking.
  const settleViewport = async () => {
    await sandbox.__switchAgent; // allow microtasks to drain
    flushTimers();
    for (let frame = 0; frame < 6; frame += 1) pumpFrame();
  };

  return { sandbox, container, calls, settleViewport };
}

test('switching back to a longer session preserves the cached reading position', async () => {
  const harness = createHandoffHarness({
    cache: { B: { followLatest: false, scrollTop: 1000, messages: Array.from({ length: 30 }) } },
  });
  // Outgoing session A is empty: its DOM cannot hold any scrollTop.

  await harness.sandbox.__switchAgent('B');
  await harness.settleViewport();

  assert.equal(
    harness.container.scrollTop,
    1000,
    'reading position must survive switching back from a shorter session',
  );
  assert.equal(harness.calls.renderMainView.at(-1), 'B');
});

test('switching back with follow enabled waits for data and lands once', async () => {
  // [F3 决策] 跟随切回：不落缓存底部（否则增长数据到达要二次跳），空态等待，
  // loadAgentData 首次渲染一次性锁到新底部。缓存 20 行（底 1600），新数据 40 行
  // （底 3600）—— 若仍乐观落缓存底，将出现 1600 → 3600 的中间跳变。
  const harness = createHandoffHarness({
    cache: { B: { followLatest: true, scrollTop: 100, messages: Array.from({ length: 20 }) } },
  });

  await harness.sandbox.__switchAgent('B');
  await harness.settleViewport();

  assert.equal(
    harness.calls.applySessionViewPatch.length,
    1,
    'follow switch-back should clear messages to the empty state',
  );
  assert.equal(
    harness.container.scrollHeight,
    harness.container.clientHeight,
    'chat should render empty while waiting for fresh data',
  );
  assert.equal(harness.container.scrollTop, 0, 'must not land on the cached bottom');

  // loadAgentData delivers the grown message list (20 → 40 rows).
  harness.sandbox.currentMessages = Array.from({ length: 40 });
  harness.sandbox.renderCurrentMainView();
  await harness.settleViewport();

  assert.equal(harness.container.scrollTop, 3600, 'single landing at the new bottom');
});

test('a pending restore never leaks into a cache-miss switch', async () => {
  const harness = createHandoffHarness({ cache: {} });
  // Simulate a stale pending value left by an earlier aborted switch.
  harness.sandbox.__setPendingChatScrollRestore(777);

  await harness.sandbox.__switchAgent('C'); // no cache entry for C
  await harness.settleViewport();

  assert.equal(
    harness.sandbox.followLatestEnabled,
    true,
    'cache-miss switch should enable follow-latest',
  );
  assert.equal(
    harness.calls.applySessionViewPatch.length,
    1,
    'cache-miss switch should clear stale messages',
  );
  assert.notEqual(
    harness.container.scrollTop,
    777,
    'a stale pending restore must not be applied to an unrelated session',
  );
});

test('wiring: render() consumes the pending restore instead of the live scrollTop', () => {
  assert.ok(
    rendererSource.includes('consumePendingChatScrollRestore() ?? container.scrollTop'),
    'chat-renderer.js render() must prefer the pending switch-restore value',
  );
});

test('wiring: switchAgent no longer writes the restore value into the outgoing DOM', () => {
  assert.ok(
    !mainSource.includes('container.scrollTop = _restoredScrollTop'),
    'switchAgent must hand the restore value to the renderer, not the live container',
  );
  assert.ok(
    mainSource.includes('setPendingChatScrollRestore(_restoredScrollTop)'),
    'switchAgent must pass the cached position through the pending handoff',
  );
});
