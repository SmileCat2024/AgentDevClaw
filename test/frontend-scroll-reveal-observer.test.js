/**
 * Scroll-path cost contract tests for the chat viewport reveal loop.
 *
 * Mechanism under test (public/src/modules/chat-viewport.js +
 * chat-row-visibility.js, Claw pipeline 1420):
 *
 * - Rows far from the viewport are hidden via content-visibility with a
 *   `--chat-row-height` placeholder equal to the LAST MEASURED height.
 *   Steady-state scrolling (row content unchanged) therefore swaps
 *   placeholder === real height on reveal/hide and dispatches NO
 *   ResizeObserver signal: the window advance is pure cached arithmetic.
 *
 * - A row whose content changed while hidden (streaming tail, collapse
 *   toggle, image load) has placeholder !== real height. Revealing it
 *   dispatches 'message-row-resize', which is DELIBERATELY exempt from the
 *   observer quiet window (chat-viewport.js: the reveal layout signal must
 *   not be discarded) and triggers a FULL refreshMeasuredChatRows pass:
 *   every row's offsetTop + getBoundingClientRect is re-read (layout flush
 *   when dirty).
 *
 * These tests pin both sides: steady scrolling must stay O(0) DOM reads,
 * and drifted rows must pay exactly one full pass per resize signal
 * (mutation echo from the same write is quiet-suppressed, resize is not).
 *
 * Fake-DOM notes: the harness models row effective height as
 *   hidden(class chat-row-distant + css var) ? placeholder : realHeight
 * with lazily accumulated offsetTop (counted per read). ResizeObserver is
 * stubbed with browser semantics: dispatch only when an observed target's
 * box height changed since the last dispatch.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const viewportSource = fs.readFileSync(
  new URL('../public/src/modules/chat-viewport.js', import.meta.url), 'utf8');
const rowVisibilitySource = fs.readFileSync(
  new URL('../public/src/modules/chat-row-visibility.js', import.meta.url), 'utf8');

function makeClassList(initial = []) {
  const set = new Set(initial);
  return {
    add: (...cs) => cs.forEach(c => set.add(c)),
    remove: (...cs) => cs.forEach(c => set.delete(c)),
    contains: c => set.has(c),
    toggle(c, force) {
      const next = force === undefined ? !set.has(c) : force;
      if (next) set.add(c); else set.delete(c);
      return next;
    },
  };
}

/**
 * Row stub whose layout answer is computed on demand:
 * effective height = chat-row-distant ? placeholder var : realH.
 */
  function makeRow({ index, realH }) {
    const row = {
      _index: index,
      realH,
      cssVars: {},
      classList: makeClassList(['message-row']),
    isConnected: true,
    contains: () => false,
    closest: sel => (sel === '.message-row' ? row : null),
    style: {
      setProperty: (k, v) => { row.cssVars[k] = v; },
      removeProperty: (k) => { delete row.cssVars[k]; },
    },
  };
  Object.defineProperty(row, 'offsetTop', {
    get() {
      harnessState.offsetTopReads += 1;
      return row._container.heightBefore(row._index);
    },
  });
  row.getBoundingClientRect = () => {
    harnessState.rectReads += 1;
    return { height: row._container.effectiveHeight(row), width: 800, top: 0, left: 0 };
  };
  return row;
}

const harnessState = { offsetTopReads: 0, rectReads: 0 };

function createBenchHarness({ rows = 1000, clientHeight = 400 } = {}) {
  const listeners = new Map();

  // ResizeObserver stub with "dispatch on size change" semantics.
  const roObserved = new Map(); // target -> lastDispatchedHeight
  const roHandlers = [];
  class FakeResizeObserver {
    constructor(handler) { roHandlers.push(handler); }
    observe(target) {
      if (!roObserved.has(target)) roObserved.set(target, null);
    }
    unobserve(target) { roObserved.delete(target); }
    disconnect() { roObserved.clear(); }
  }
  function flushResizeSignals() {
    // Browser semantics: one callback per frame with ALL changed entries.
    const batch = [];
    for (const [target, last] of Array.from(roObserved.entries())) {
      const now = target._container
        ? target._container.effectiveHeight(target)
        : target.clientHeight; // container-level target: constant box height
      if (last === null || last !== now) {
        roObserved.set(target, now);
        batch.push({ target, contentRect: { width: 800, height: now } });
      }
    }
    if (batch.length) {
      for (const h of roHandlers) h(batch);
    }
  }

  // MutationObserver stub — fired manually to simulate echo writes.
  let moHandler = null;
  class FakeMutationObserver {
    constructor(handler) { moHandler = handler; }
    observe() {}
    disconnect() {}
  }
  function fireMutationEcho() { if (moHandler) moHandler([]); }

  const containerRows = [];
  const container = {
    _rows: containerRows,
    clientHeight,
    clientWidth: 800,
    scrollTop: 0,
    scrollHeight: 0,
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    removeEventListener() {},
    querySelector: () => null,
    querySelectorAll(sel) {
      harnessState.selectorCalls += 1;
      return sel === '.message-row' ? containerRows.slice() : [];
    },
    // Layout model: height of row i = placeholder(css var) if distant else realH.
    effectiveHeight(row) {
      if (row.classList.contains('chat-row-distant') && row.cssVars['--chat-row-height']) {
        return parseFloat(row.cssVars['--chat-row-height']);
      }
      return row.realH;
    },
    heightBefore(index) {
      let top = 0;
      for (let i = 0; i < index; i++) top += container.effectiveHeight(containerRows[i]);
      return top;
    },
    recomputeScrollHeight() {
      let h = 0;
      for (const r of containerRows) h += container.effectiveHeight(r);
      container.scrollHeight = h;
    },
  };

  for (let i = 0; i < rows; i++) {
    const row = makeRow({ index: i, realH: 100 });
    row._container = container;
    containerRows.push(row);
  }
  container.recomputeScrollHeight();

  function fireScroll() {
    for (const l of listeners.get('scroll') || []) l({ target: container });
  }

  const rafQueue = [];
  const sandbox = {
    window: {},
    document: { activeElement: null, getElementById: () => null },
    console,
    CSS: { supports: () => true },
    ResizeObserver: FakeResizeObserver,
    MutationObserver: FakeMutationObserver,
    requestAnimationFrame: fn => { rafQueue.push(fn); return rafQueue.length; },
    cancelAnimationFrame: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
    Date,
    // Globals declared in app-core.js that chat-viewport.js mutates:
    container, followLatestEnabled: false, suppressFollowScrollEvent: false,
    lastManualScrollIntentAt: 0, _progScrollCooldownUntil: 0, followLatestEntryUntil: 0,
    chatViewportObserversReady: false, chatViewportObserverSuppressDepth: 0,
    chatViewportObserverQuietUntil: 0, chatViewportMutationObserver: null,
    chatViewportResizeObserver: null, chatViewportSettlementToken: 0,
    chatViewportSettlementRaf: 0, chatViewportSettlementTimer: null,
    chatViewportSettlementContext: null, chatViewportFollowRaf: 0,
    chatViewportFollowToken: 0, chatViewportFollowTransition: '',
    assemblySideRailRevealTimer: null, chatViewportAnchorSaveTimer: null,
    currentRuntimeAgentId: 'rt-bench',
    // Globals consumed by chat-row-visibility.js:
    showChatProcess: true, _windowingDisabled: true, _windowingFrozen: false,
    currentMessages: [],
    followLatestButton: { classList: makeClassList(), style: {}, textContent: '' },
    workspaceTabsBar: null,
    isChatSurfaceActive: () => true,
    shouldRenderWorkspaceSurface: () => false,
    escapeHtml: s => s, t: (a) => a,
    captureChatViewportAnchor: () => null,
    applyChatViewportAnchor: () => {},
    updateFollowLatestButton: () => {},
    isNearBottom: () => false,
    markManualScrollIntent: () => {},
    registerManualScrollIntent: () => {},
    scrollToLatest: () => {},
    Math, Number, String, Array, Object, Set, Map, Promise, isNaN, parseInt,
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(viewportSource, context);
  vm.runInContext(rowVisibilitySource, context);

  const refreshCalls = [];
  const rawRefresh = sandbox.refreshMeasuredChatRows;
  assert.equal(typeof rawRefresh, 'function', 'chat-row-visibility must export refreshMeasuredChatRows');
  sandbox.refreshMeasuredChatRows = function wrapped(reason) {
    refreshCalls.push(reason);
    return rawRefresh(reason);
  };

  function pumpFrames(n = 3) {
    for (let i = 0; i < n; i++) {
      const queue = rafQueue.splice(0, rafQueue.length);
      for (const fn of queue) fn();
    }
  }

  function scrollTo(top) {
    container.scrollTop = top;
    fireScroll();
    pumpFrames(2);
    flushResizeSignals();
    pumpFrames(3); // settlement settle frames
  }

  function countFullPasses() {
    // A full pass = refresh call that was NOT routed to the incremental
    // branches. Detect via measurement volume instead of internals: a full
    // pass re-reads offsetTop for every row.
    return refreshCalls.filter(r => r !== 'append' && r !== 'patch-last').length;
  }

  return {
    container, rows: containerRows, refreshCalls, pumpFrames, scrollTo,
    flushResizeSignals, fireMutationEcho,
    refresh: reason => sandbox.refreshMeasuredChatRows(reason),
    notify: reason => sandbox.notifyChatViewportMutation({
      reason, shouldFollow: false, preserveTop: null,
      allowChase: false, preferSmooth: false, forceSnap: false,
    }),
    stats: () => ({
      offsetTopReads: harnessState.offsetTopReads,
      rectReads: harnessState.rectReads,
      selectorCalls: harnessState.selectorCalls,
      refreshReasons: refreshCalls.slice(),
      fullPasses: countFullPasses(),
    }),
    resetStats() {
      harnessState.offsetTopReads = 0;
      harnessState.rectReads = 0;
      harnessState.selectorCalls = 0;
      refreshCalls.length = 0;
    },
  };
}

test('steady-state window scrolling performs no DOM measurement', () => {
  const bench = createBenchHarness({ rows: 1000 });
  // Land the initial full pass + observers (first-dispatch semantics).
  bench.refresh('render-full');
  bench.pumpFrames(3);
  bench.notify('render-full');
  bench.flushResizeSignals();
  bench.pumpFrames(3);
  assert.ok(bench.stats().fullPasses >= 1, 'initial render must build the measurement cache');

  bench.resetStats();
  // Scroll far down through many window advances (row heights never change).
  for (let top = 2000; top <= 90000; top += 2000) bench.scrollTo(top);

  const s = bench.stats();
  assert.equal(s.fullPasses, 0,
    `steady scrolling must not trigger a full refresh (got reasons: ${s.refreshReasons.join(',')})`);
  assert.equal(s.offsetTopReads, 0,
    `apply() must run on cached arithmetic, not DOM reads (got ${s.offsetTopReads})`);
});

test('revealing a drifted row pierces quiet and pays one full pass', () => {
  const bench = createBenchHarness({ rows: 1000 });
  bench.refresh('render-full');
  bench.pumpFrames(3);
  bench.notify('render-full');
  bench.flushResizeSignals();
  bench.pumpFrames(3);

  // Row 600 content changed while hidden: real height 100 -> 300,
  // its placeholder var still says 100.
  bench.rows[600].realH = 300;
  bench.container.recomputeScrollHeight();

  bench.resetStats();
  // Scroll the window across row 600.
  bench.scrollTo(600 * 100 - 800);
  bench.scrollTo(600 * 100);
  bench.scrollTo(600 * 100 + 1600);

  const s = bench.stats();
  assert.ok(s.fullPasses >= 1,
    'drifted-row reveal must dispatch message-row-resize and force a full pass');
  assert.ok(s.offsetTopReads >= 1000,
    `a full pass re-reads every row's offsetTop (got ${s.offsetTopReads})`);
  assert.ok(s.refreshReasons.includes('message-row-resize'),
    `expected a message-row-resize signal, got ${s.refreshReasons.join(',')}`);
});

test('collapse-height change pierces the quiet window set by an append notify', () => {
  const bench = createBenchHarness({ rows: 1000 });
  bench.refresh('render-full');
  bench.pumpFrames(3);
  bench.notify('render-full');
  bench.flushResizeSignals();
  bench.pumpFrames(3);

  // Simulate the streaming sequence: append notify (sets quiet 180ms),
  // then the born-collapse write shrinks a visible row's height.
  bench.notify('append');
  bench.resetStats();

  const visibleRow = 2; // inside the initial window
  bench.rows[visibleRow].realH = 40;
  bench.container.recomputeScrollHeight();
  bench.flushResizeSignals();
  bench.pumpFrames(3);

  const s = bench.stats();
  assert.ok(s.fullPasses >= 1,
    'row resize must pierce the quiet window (message-row-resize exemption)');
  // And the mutation echo of the same write is quiet-suppressed: only the
  // resize signal may show up.
  assert.ok(!s.refreshReasons.includes('dom-observer'),
    'mutation echo must stay quiet-suppressed');
});

test('mutation echo right after an append notify is quiet-suppressed', () => {
  const bench = createBenchHarness({ rows: 1000 });
  bench.refresh('render-full');
  bench.pumpFrames(3);
  bench.notify('render-full');
  bench.flushResizeSignals();
  bench.pumpFrames(3);

  bench.notify('append');
  bench.resetStats();

  // No height change: pure childList/characterData echo only.
  bench.fireMutationEcho();
  bench.pumpFrames(3);

  const s = bench.stats();
  assert.equal(s.fullPasses, 0,
    `mutation echo must be suppressed by the quiet window (got ${s.refreshReasons.join(',')})`);
});
