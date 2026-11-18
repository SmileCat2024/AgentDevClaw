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
 * 装载路线（P4 T2 批次）：chat-viewport 已迁 ESM，经 withP2EsmCase 的 `c.load`
 * 真实 import；classic 相仍装真实 switchAgent 宿主（app-main 的
 * createRuntimeSwitchHost）+ 分发器，并像 app-core 一样注册本夹具用到的桥键
 * （orchestration:currentRuntimeAgentId / session-view-storage:currentMessages）。
 * 视口状态仍是 app-core 的 owner 面：本夹具用 chatSurface 宿主把同一批字段
 * 转发到本地 bag，app-main 侧裸读写语义不变。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { installRuntimeSwitch } from './helpers/runtime-switch.js';

const mainSource = fs.readFileSync(new URL('../public/src/app-main.js', import.meta.url), 'utf8');
const rendererSource = fs.readFileSync(new URL('../public/src/modules/chat-renderer.js', import.meta.url), 'utf8');
const CHAT_VIEWPORT = 'public/src/modules/chat-viewport.js';

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(start, -1, `${startMarker} marker should exist`);
  assert.notEqual(end, -1, `${endMarker} marker should exist`);
  return source.slice(start, end);
}



/**
 * Minimal chat container with browser-style scrollTop clamping:
 * scrollTop is always clamped to [0, scrollHeight - clientHeight].
 */
function createFakeContainer() {
  const container = {
    _scrollTop: 0,
    _rows: [],
    _listeners: new Map(),
    clientHeight: 400,
    scrollHeight: 400,
    addEventListener(type, listener) { container._listeners.set(type, listener); },
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

async function withHandoffHarness({ cache = {} } = {}, fn) {
  const container = createFakeContainer();
  // 跟随按钮：模块在求值期经 document.getElementById 取到它（避让定位 observer
  // 在本夹具里因缺少 .main-content 而保持空操作）。
  const followLatestButton = {
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
    style: { setProperty() {}, removeProperty() {}, getPropertyValue: () => '' },
    innerHTML: '',
  };
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

  // 晚绑定引用：globals 在 case 建立时就要就绪，而 sandbox / 模块命名空间
  // 要到 classic 相与 async 相才可得。
  const refs = { window: null, viewport: null };
  const viewportState = {
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
  };
  // chatSurface / assemblyUi 的宿主面：读写实时转发到本夹具的 bag（与 classic
  // 侧裸读写的沙箱属性是同一份存储）。
  const stateHost = new Proxy({}, {
    get: (_target, key) => viewportState[key],
    set: (_target, key, value) => { viewportState[key] = value; return true; },
    has: () => true,
  });

  // Chat height is driven by the message count (rows * 100px + no extra chrome):
  // renderCurrentMainView mirrors the real render() — the empty-state branch
  // rebuilds the DOM WITHOUT notifying (no lock), the full branch notifies
  // with the pending-restore-aware preserveTop.
  const renderChatFromMessages = () => {
    const sandbox = refs.window;
    const rows = sandbox.currentMessages.length;
    container._rows = Array.from({ length: rows }, () => ({
      classList: { contains: () => false },
    }));
    container.scrollHeight = rows > 0 ? rows * 100 : container.clientHeight;
    calls.renderMainView.push(sandbox.currentRuntimeAgentId);
    if (rows === 0) return; // real render() empty branch: no notify, no lock
    const savedScrollTop = refs.viewport.consumePendingChatScrollRestore() ?? container.scrollTop;
    refs.viewport.notifyChatViewportMutation({
      reason: 'render-full',
      shouldFollow: sandbox.followLatestEnabled,
      preserveTop: sandbox.followLatestEnabled ? null : savedScrollTop,
      forceSnap: sandbox.followLatestEnabled,
      allowChase: false,
    });
  };

  const fakeGlobals = {
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
      getElementById: (id) => {
        if (id === 'chat-container') return container;
        if (id === 'follow-latest-btn') return followLatestButton;
        return null;
      },
      body: { contains: () => true },
      createElement: () => ({ style: {}, classList: { add() {}, contains: () => false } }),
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
      createElementNS: () => ({ style: {}, classList: { add() {}, contains: () => false } }),
    },

    followLatestButton,
    createP2BootstrapChatSurfaceHost: () => stateHost,
    createP2BootstrapAssemblyHost: () => stateHost,
    // chat-row-visibility（chat-viewport 的 import 链）读 domRefs.container。
    createP2BootstrapDomHost: () => ({ container }),

    isChatSurfaceActive: () => true,
    shouldRenderWorkspaceSurface: () => false,
    escapeHtml: (value) => String(value),
    t: (key) => key,

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
    resetRuntimeStatusForSwitch: () => { calls.resetRuntimeStatusForSwitch += 1; },
    activateUserCollapseStateForContext: () => {},
    restoreRuntimeFromCache: (runtimeId) => {
      const sandbox = refs.window;
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
        refs.window.currentMessages = patch.messages.slice();
      }
    },
    getEmptyOverviewSnapshot: () => ({}),
    getEmptyTodoPlan: () => ({}),
    // setFollowLatest / beginFollowLatest* 由 chat-viewport 域的桥键提供（模块在
    // async 相装载后注册），switchAgent 的裸调用经 window 取到同一实现。
    renderAgentList: () => {},
    normalizeAgentIdentity: (value) => String(value || '').trim(),
    resolveNotificationCallingState: () => false,
    _markAgentCallStartedForNotify: () => {},
    _syncPersistentActionButton: () => {},
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    loadAgentData: async () => {},
    loadAgents: async () => {},
  };

  return withP2EsmCase({
    classic: (sandbox) => {
      // 计时器 / rAF 已在 globals 里（沙箱与主 realm 同一份队列）。
      // 本夹具不装载 app-core，但模块从这两个域读状态：按 app-core 同款初值与
      // 访问器注册，classic 侧裸读写语义不变（写点落在桥/storage 上）。
      // 初值取夹具的现场值（globals 已把它落到沙箱属性上，defineKey 换装访问器）。
      sandbox.KernelState.defineKey('orchestration', 'currentRuntimeAgentId', fakeGlobals.currentRuntimeAgentId ?? null);
      sandbox.KernelState.defineKey('session-view-storage', 'currentMessages', fakeGlobals.currentMessages ?? []);
      // 视口状态字段：classic 侧裸读写与 chatSurface 宿主共用 viewportState bag。
      for (const key of Object.keys(viewportState)) {
        Object.defineProperty(sandbox, key, {
          get: () => viewportState[key],
          set: (value) => { viewportState[key] = value; },
          configurable: true,
        });
      }
      refs.window = sandbox;
      // 分发器先于一切注册 data-action 的模块（markdown-utils 求值期注册动作）。
      sandbox.loadSource('public/src/modules/action-dispatcher.js');
      // 真实 switchAgent 宿主（app-main 的 createRuntimeSwitchHost）。
      installRuntimeSwitch(sandbox);
    },
    globals: fakeGlobals,
  }, async (c) => {
    const viewport = await c.load(CHAT_VIEWPORT);
    refs.viewport = viewport;
    const sandbox = c.window;
    refs.window = sandbox;

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
  const settleViewport = async (pendingSwitch = null) => {
    if (pendingSwitch) await pendingSwitch; // allow microtasks to drain
    flushTimers();
    for (let frame = 0; frame < 6; frame += 1) pumpFrame();
  };
  const switchAgent = (runtimeId) => sandbox.switchAgent(runtimeId);

  return fn({ sandbox, viewport, switchAgent, container, calls, settleViewport, flushTimers });
  });
}

test('reading anchor waits for a scroll pause and captures the latest position', async () => {
  await withHandoffHarness({}, (h) => {
  h.container.scrollHeight = 2000;
  h.container._rows = Array.from({ length: 5 }, (_, i) => ({
    offsetTop: i * 300, offsetHeight: 300,
    classList: { contains: () => false },
  }));
  let scans = 0;
  const query = h.container.querySelectorAll;
  h.container.querySelectorAll = selector => { scans++; return query(selector); };
  const onScroll = h.container._listeners.get('scroll');
  h.container.scrollTop = 320;
  onScroll();
  h.container.scrollTop = 620;
  onScroll();
  assert.equal(scans, 0, 'continuous scroll must not scan historical rows');
  h.flushTimers();
  assert.equal(scans, 1);
  const anchor = h.sandbox.getRememberedChatViewportAnchorForContext('runtime:A');
  assert.equal(anchor.rowIdx, 2);
  assert.equal(anchor.offset, 20);
  });
});

test('switch boundary can capture immediately; an outgoing idle save cannot overwrite the new context', async () => {
  await withHandoffHarness({}, (h) => {
  h.container.scrollHeight = 2000;
  h.container._rows = [{ offsetTop: 0, offsetHeight: 1600, classList: { contains: () => false } }];
  h.container.scrollTop = 400;
  h.container._listeners.get('scroll')();
  const saved = h.sandbox.rememberChatViewportAnchorForContext();
  assert.equal(saved.offset, 400, 'switch boundary does not have to await the idle timer');
  h.sandbox.currentRuntimeAgentId = 'B';
  h.container.scrollTop = 900;
  h.flushTimers();
  assert.equal(h.sandbox.getRememberedChatViewportAnchorForContext('runtime:A').offset, 400);
  assert.equal(h.sandbox.getRememberedChatViewportAnchorForContext('runtime:B'), null);
  });
});

test('switching back to a longer session preserves the cached reading position', async () => {
  // Outgoing session A is empty: its DOM cannot hold any scrollTop.
  await withHandoffHarness({
    cache: { B: { followLatest: false, scrollTop: 1000, messages: Array.from({ length: 30 }) } },
  }, async (harness) => {
    await harness.settleViewport(harness.switchAgent('B'));

    assert.equal(
      harness.container.scrollTop,
      1000,
      'reading position must survive switching back from a shorter session',
    );
    assert.equal(harness.calls.renderMainView.at(-1), 'B');
  });
});

test('switching back with follow enabled lands on the cached bottom, then the new bottom', async () => {
  // 跟随切回与阅读模式同走乐观渲染：缓存消息立即呈现并由 forceSnap 锁到缓存
  // 底部，loadAgentData 到达后签名未变则 dedup 跳过（零跳动），有增长才重
  // 渲染落新底部 —— 与跟随模式正常收新消息同形。缓存 20 行（底 1600），新
  // 数据 40 行（底 3600）：中间态是缓存底而非空态，增长数据到达后落新底。
  await withHandoffHarness({
    cache: { B: { followLatest: true, scrollTop: 100, messages: Array.from({ length: 20 }) } },
  }, async (harness) => {
  await harness.settleViewport(harness.switchAgent('B'));

  assert.equal(
    harness.calls.applySessionViewPatch.length,
    0,
    'follow switch-back must keep the cached messages instead of clearing to the empty state',
  );
  assert.equal(
    harness.container.scrollHeight,
    2000,
    'chat should render the cached messages optimistically',
  );
  assert.equal(
    harness.container.scrollTop,
    1600,
    'optimistic render locks to the cached bottom before fresh data arrives',
  );

  // loadAgentData delivers the grown message list (20 → 40 rows).
  harness.sandbox.currentMessages = Array.from({ length: 40 });
  harness.sandbox.renderCurrentMainView();
  await harness.settleViewport();

  assert.equal(harness.container.scrollTop, 3600, 'single landing at the new bottom');
  });
});

test('a pending restore never leaks into a cache-miss switch', async () => {
  await withHandoffHarness({ cache: {} }, async (harness) => {
  // Simulate a stale pending value left by an earlier aborted switch.
  harness.viewport.setPendingChatScrollRestore(777);

  await harness.settleViewport(harness.switchAgent('C')); // no cache entry for C

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
    // 编排域迁 ESM（P4 T3 收尾）后该交接点是显式 window 晚绑定（chat-viewport 的
    // 桥键）；语义不变：缓存位置经 pending 通道交给渲染器。
    mainSource.includes('setPendingScroll: (top) => window.setPendingChatScrollRestore(top)'),
    'switchAgent must pass the cached position through the pending handoff',
  );
});
