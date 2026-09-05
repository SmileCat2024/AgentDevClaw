/**
 * Acceptance tests for the once-per-switch viewport tremor when scrolling
 * right after a session switch.
 *
 * The restore pipeline has three layers, all exercised here against the REAL
 * production sources (extracted from chat-renderer.js / chat-viewport.js):
 *   1. Settlement: the post-render stabilization must not write back a stale
 *      pixel while the user is mid-scroll (manual scroll intent wins).
 *   2. Same-context rebuild: a row anchor (rowIdx + offset) captured on the
 *      outgoing DOM must land the SAME row under the viewport top after the
 *      rebuild, even when content above it changed height.
 *   3. Cross-context DOM: an outgoing DOM from another session captures no
 *      anchor; a pixel handoff travels through the pendingChatScrollRestore
 *      channel and flows to settlement unchanged.
 *
 * Bug: switchAgent renders the session optimistically from the runtime
 * cache, the user starts scrolling, and 1-2s later loadAgentData's fresh
 * render lands. If the message signature changed (drift / tool template
 * reload), render() rebuilt the DOM and the settlement wrote a scrollTop
 * PIXEL captured on the pre-rebuild layout back onto the post-rebuild
 * layout — landing on different content — and did so without checking
 * whether the user had scrolled in the meantime, yanking the viewport out
 * from under them. Exactly one tremor per switch, felt only when the user
 * had scrolled.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const rendererSource = fs.readFileSync(new URL('../public/src/modules/chat-renderer.js', import.meta.url), 'utf8');
const viewportSource = fs.readFileSync(new URL('../public/src/modules/chat-viewport.js', import.meta.url), 'utf8');

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(start, -1, `${startMarker} marker should exist`);
  assert.notEqual(end, -1, `${endMarker} marker should exist`);
  return source.slice(start, end);
}

// The tail of render(): anchor capture → innerHTML rebuild → process state
// → follow lock / anchor apply → notify. Ends before render()'s closing
// brace (trimmed), so it can run as a vm snippet body.
function extractRenderScrollBlock() {
  const block = sourceBetween(
    rendererSource,
    'const chatContextKey = typeof getChatScrollContextKey === \'function\'',
    'function stableSerializeForChatSignature',
  );
  return block.replace(/\r?\n\}\s*$/, '');
}

function makeClassList() {
  const set = new Set();
  return {
    add: (...names) => names.forEach((n) => set.add(n)),
    remove: (...names) => names.forEach((n) => set.delete(n)),
    toggle: (name, force) => {
      const enable = force === undefined ? !set.has(name) : Boolean(force);
      if (enable) set.add(name); else set.delete(name);
      return enable;
    },
    contains: (name) => set.has(name),
  };
}

function createBaseSandbox({ container }) {
  const timers = new Map();
  const rafCallbacks = new Map();
  const rafOrder = [];
  let seq = 1;

  const sandbox = {
    console, Date, JSON, Math, Promise, Map, Set, Number, Object, Array, Boolean, String, isNaN, parseInt,
    window: {},
    setTimeout(callback) { const id = seq++; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
    requestAnimationFrame(callback) { const id = seq++; rafCallbacks.set(id, callback); rafOrder.push(id); return id; },
    cancelAnimationFrame(id) { rafCallbacks.delete(id); const i = rafOrder.indexOf(id); if (i >= 0) rafOrder.splice(i, 1); },
    MutationObserver: class { observe() {} disconnect() {} },
    ResizeObserver: class { observe() {} disconnect() {} },
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: () => ({ style: {}, classList: makeClassList(), setAttribute() {} }),
      // applyChatViewportAnchor checks attachment; rows rebuilt by the
      // render block are always new objects, so "detached" drives the
      // walk-forward-from-rowIdx path — the path a real rebuild takes.
      body: { contains: () => false },
    },

    container,
    followLatestButton: { classList: { toggle() {}, add() {}, remove() {} }, innerHTML: '' },
    workspaceTabsBar: null,
    currentMessages: [],

    isChatSurfaceActive: () => true,
    shouldRenderWorkspaceSurface: () => false,
    escapeHtml: (v) => String(v ?? ''),
    t: (k) => k,

    // chat-viewport.js module state (app-core.js declarations)
    followLatestEnabled: false,
    suppressFollowScrollEvent: false,
    lastManualScrollIntentAt: 0,
    _progScrollCooldownUntil: 0,
    followLatestEntryUntil: 0,
    chatViewportObserversReady: true,
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
    chatViewportFollowTransition: 'locked',
    assemblySideRailRevealTimer: null,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(viewportSource, sandbox, { filename: 'chat-viewport.js' });

  const flushTimers = () => {
    const pending = [...timers.values()];
    timers.clear();
    pending.forEach((cb) => cb());
  };
  const pumpFrame = () => {
    const ids = rafOrder.splice(0);
    ids.forEach((id) => {
      const cb = rafCallbacks.get(id);
      rafCallbacks.delete(id);
      if (cb) cb();
    });
  };
  // notify schedules setTimeout(0) → rAF(settle); settle applies after two
  // stable metric frames.
  const settleViewport = () => {
    flushTimers();
    for (let frame = 0; frame < 6; frame += 1) pumpFrame();
  };
  return { sandbox, settleViewport };
}

/** Minimal clamped-scrollTop container for settlement-level tests. */
function createBareContainer() {
  const container = {
    _scrollTop: 0,
    clientHeight: 400,
    scrollHeight: 4000,
    _writes: [],
    addEventListener() {},
    removeEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  Object.defineProperty(container, 'scrollTop', {
    get() { return container._scrollTop; },
    set(value) {
      const next = Math.max(0, Math.min(Number(value) || 0, container.scrollHeight - container.clientHeight));
      if (next !== container._scrollTop) {
        container._writes.push(next);
        container._scrollTop = next;
      }
    },
  });
  return container;
}

// ── Fix A: settlement respects manual scroll intent ─────────────────────

test('settle(): a recent manual scroll suppresses the preserveTop write-back', () => {
  const container = createBareContainer();
  const { sandbox, settleViewport } = createBaseSandbox({ container });
  container.scrollTop = 1200; // user's live reading position

  // The user is mid-scroll when the settlement fires.
  sandbox.lastManualScrollIntentAt = Date.now();
  container._writes.length = 0; // drop the setup write
  vm.runInContext(`
    notifyChatViewportMutation({
      reason: 'render-full', shouldFollow: false, preserveTop: 500,
      forceSnap: false, allowChase: false,
    });
  `, sandbox);
  settleViewport();

  assert.equal(container.scrollTop, 1200, 'user position must win over the stale pixel');
  assert.deepEqual(container._writes, [], 'no scroll write may yank the viewport back');
});

test('settle(): without manual intent the preserveTop write-back still applies', () => {
  const container = createBareContainer();
  const { sandbox, settleViewport } = createBaseSandbox({ container });
  container.scrollTop = 1200;
  sandbox.lastManualScrollIntentAt = 0;

  vm.runInContext(`
    notifyChatViewportMutation({
      reason: 'render-full', shouldFollow: false, preserveTop: 500,
      forceSnap: false, allowChase: false,
    });
  `, sandbox);
  settleViewport();

  assert.equal(container.scrollTop, 500, 'switch restore must still be applied');
});

// ── Fix B: same-context rebuild restores by row anchor ───────────────────

const VIEW_H = 800;

/** Sequential-layout container: rows are plain objects with eager tops. */
function createLayoutContainer() {
  const container = {
    _scrollTop: 0,
    _writes: [],
    clientHeight: VIEW_H,
    dataset: {},
    _rows: [],
    addEventListener() {},
    removeEventListener() {},
    getBoundingClientRect: () => ({ top: 0 }),
    querySelector(sel) { return sel === '.message-row' ? (container._rows[0] || null) : null; },
    querySelectorAll(sel) { return sel === '.message-row' ? container._rows : []; },
    // The render block assigns innerHTML; the test swaps the row set here to
    // simulate the DOM rebuild between anchor capture and apply.
    _onInnerHtml: null,
  };
  Object.defineProperty(container, 'innerHTML', {
    set() { if (container._onInnerHtml) container._onInnerHtml(); },
    get() { return ''; },
  });
  Object.defineProperty(container, 'scrollHeight', {
    get() {
      const total = container._rows.reduce((sum, r) => sum + r.offsetHeight, 0);
      return Math.max(total, VIEW_H);
    },
  });
  Object.defineProperty(container, 'scrollTop', {
    get() {
      const max = Math.max(0, container.scrollHeight - VIEW_H);
      return Math.min(container._scrollTop, max);
    },
    set(value) {
      const max = Math.max(0, container.scrollHeight - VIEW_H);
      const next = Math.max(0, Math.min(Number(value) || 0, max));
      if (next !== container._scrollTop) {
        container._writes.push(next);
        container._scrollTop = next;
      }
    },
  });
  container.setRows = (heights) => {
    let top = 0;
    container._rows = heights.map((h) => {
      const row = { offsetTop: top, offsetHeight: h, classList: makeClassList() };
      top += h;
      return row;
    });
  };
  return container;
}

function createRenderHarness({ contextKey = 'ctx:rt-1', domContextKey = contextKey } = {}) {
  const container = createLayoutContainer();
  const { sandbox, settleViewport } = createBaseSandbox({ container });

  // render() dependencies outside chat-viewport.js (all no-ops for the
  // scroll block; the real render calls them around the rebuild).
  sandbox.getChatScrollContextKey = () => contextKey;
  sandbox.getRememberedChatScrollForContext = () => null;
  sandbox.enhanceMathInElement = () => {};
  sandbox.updateRollbackActionVisibility = () => {};
  sandbox.applyConversationProcessState = () => {};
  sandbox.restoreUserCollapseState = () => {};
  sandbox.ensureChatRuntimeIndicator = () => {};
  sandbox.showChatProcess = false;

  // The outgoing DOM was rendered for `domContextKey` by a previous render.
  container.dataset.chatRenderContext = domContextKey;

  // Spy on notify calls without disturbing the real settlement machinery.
  vm.runInContext(`
    globalThis.__notifyCalls = [];
    globalThis.__recordAndNotify = (opts) => {
      __notifyCalls.push(JSON.parse(JSON.stringify(opts)));
      return notifyChatViewportMutation(opts);
    };
  `, sandbox);

  /**
   * Runs the REAL render() scroll block: capture anchor on the outgoing
   * rows → innerHTML (fires rowSwap) → anchor apply → notify (recorded).
   * savedScrollTop goes through the real pendingChatScrollRestore channel
   * (setPendingChatScrollRestore), matching the production handoff.
   * Wrapped in an IIFE: the block declares const/let and may be re-run.
   */
  const runRenderScrollBlock = ({ nextHeights, savedScrollTop = null } = {}) => {
    container._onInnerHtml = () => container.setRows(nextHeights);
    const snippet = extractRenderScrollBlock()
      .replace('notifyChatViewportMutation({', '__recordAndNotify({');
    vm.runInContext(`
      setPendingChatScrollRestore(${JSON.stringify(savedScrollTop)});
      ;(function (html, shouldFollowAfterMutation) {
        ${snippet}
      })('', false);
    `, sandbox, { filename: 'render-scroll-block.js' });
  };
  return { container, sandbox, runRenderScrollBlock, settleViewport };
}

test('same-context rebuild: row anchor keeps the reading row under the viewport top across a layout shift', () => {
  const h = createRenderHarness();
  // 30 rows × 100px. Reading position: row 15 exactly at the viewport top.
  h.container.setRows(Array.from({ length: 30 }, () => 100));
  h.container.scrollTop = 1500;
  assert.equal(h.container.scrollTop, 1500);

  // Rebuild lands: row 0 grows 100 → 400 (tool template swap above the
  // viewport). Everything below shifts down 300px.
  h.runRenderScrollBlock({ nextHeights: [400, ...Array.from({ length: 29 }, () => 100)] });

  // Pixel restore would keep scrollTop 1500 — pointing 300px into the wrong
  // content. The anchor restore must land on the SAME row at its new top.
  assert.equal(h.container.scrollTop, 1800, 'viewport must follow the anchored row to its new offsetTop');
  const topRow = h.container._rows.find((r) => r.offsetTop + r.offsetHeight > h.container.scrollTop);
  assert.equal(topRow.offsetTop, 1800, 'the row at the viewport top must be the pre-rebuild reading row');
  const notify = h.sandbox.__notifyCalls.at(-1);
  assert.equal(notify.preserveTop, 1800, 'settlement must re-assert the anchored position, not the stale pixel');
});

test('cross-context DOM: no anchor is captured, the pixel path stays', () => {
  const h = createRenderHarness({ domContextKey: 'ctx:previous-session' });
  h.container.setRows(Array.from({ length: 30 }, () => 100));
  h.container.scrollTop = 1500;

  h.runRenderScrollBlock({
    nextHeights: Array.from({ length: 30 }, () => 100),
    savedScrollTop: 777, // e.g. pendingChatScrollRestore handoff value
  });

  assert.equal(h.container.scrollTop, 1500, 'no synchronous anchor apply may run for a foreign DOM');
  const notify = h.sandbox.__notifyCalls.at(-1);
  assert.equal(notify.preserveTop, 777, 'the pixel restore value must flow to the settlement unchanged');
  assert.equal(h.container.dataset.chatRenderContext, 'ctx:rt-1',
    'the rebuild must stamp the incoming context for the next same-context render');
});

test('A+B together: anchor lands, user keeps scrolling, settlement does not yank back', () => {
  const h = createRenderHarness();
  h.container.setRows(Array.from({ length: 30 }, () => 100));
  h.container.scrollTop = 1500;

  h.runRenderScrollBlock({ nextHeights: [400, ...Array.from({ length: 29 }, () => 100)] });
  assert.equal(h.container.scrollTop, 1800);

  // Between the rebuild and the settlement (~280ms window) the user scrolls on.
  h.container.scrollTop = 2000;
  h.sandbox.lastManualScrollIntentAt = Date.now();
  h.settleViewport();

  assert.equal(h.container.scrollTop, 2000, 'the settlement must not overwrite the user\'s live position');
});

// ── Wiring: the real render() source must contain the fixed paths ───────

test('wiring: render() captures/applies the anchor and stamps the render context', () => {
  assert.ok(rendererSource.includes('captureChatViewportAnchor()'),
    'render() must capture a row anchor on the outgoing DOM');
  assert.ok(rendererSource.includes('applyChatViewportAnchor(rebuildAnchor)'),
    'render() must apply the anchor after the rebuild');
  assert.ok(rendererSource.includes('chatRenderContext'),
    'render() must stamp the render context for same-context detection');
});

test('wiring: settle() consults manual scroll intent before writing preserveTop', () => {
  assert.ok(viewportSource.includes('hasRecentManualScrollIntent()'),
    'the settlement must skip the stale-pixel write-back when the user scrolled');
});
