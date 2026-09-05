/**
 * Tests for the tool-block collapse timing and windowing-reveal compensation.
 *
 * Two long-standing rendering defects in "show process" mode:
 *
 * 1. Flash-then-collapse on full render: the landing collapse scan inside
 *    applyProcessDistance runs against the pre-lock scrollTop, so it folds
 *    rows at a stale position while the viewport is about to lock to the
 *    bottom. The first paint then shows expanded tool blocks which fold only
 *    after the scroll-stop settle (~150ms later). Fix: render() locks to the
 *    bottom and runs runLandingCollapseScan() in the same task, before the
 *    first paint.
 *
 * 2. Viewport jitter during upward scroll: sliding the cv-hidden window
 *    reveals rows whose placeholder height (contain-intrinsic-size estimate)
 *    differs from the real height. The snap displaces every row below the
 *    revealed one — visible as jitter. Fix: _applyWindow captures placeholder
 *    heights, re-measures after reveal, and compensates scrollTop by the
 *    delta of rows fully above the viewport (follow mode skips compensation;
 *    the bottom-lock settlement absorbs height changes there).
 *
 * Loads the real chat-viewport.js / lazy-tool-content.js / chat-renderer.js /
 * input-helpers.js into a vm sandbox with a layout-model DOM stub
 * (classList trees + computed offsetTop/offsetHeight, mirroring
 * frontend-follow-smooth-append.test.js).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const src = (p) => fs.readFileSync(new URL('../public/src/' + p, import.meta.url), 'utf8');

const VIEW_H = 800;
const TOGGLE_BAR_H = 34; // .expand-toggle-bar added under collapsible rows

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

// A row stub with the DOM surface the collapse/windowing code touches.
// realH is the expanded content height; toolName drives auto-collapse rules.
function makeRow({ role, realH, toolName = '', msgId = '' }) {
  const row = {
    role,
    realH,
    rememberedH: null, // contain-intrinsic-size: auto memory
    _msgId: msgId,
    classList: makeClassList(),
    dataset: {},
  };
  row.classList.add(role);

  const content = {
    id: msgId,
    scrollHeight: realH,
    classList: makeClassList(),
    style: {},
  };

  const toggleSvg = { style: {} };
  let btnBar = null;
  const toolHeaderSpan = { textContent: toolName };

  row.querySelector = (sel) => {
    if (sel === '.message-content') return content;
    if (sel === '.tool-result-header span:last-child') return toolName ? toolHeaderSpan : null;
    if (sel === '.expand-toggle-bar') return btnBar;
    if (sel === '.message-meta .collapse-toggle svg') return toggleSvg;
    if (sel === '.process-hidden' || sel === '.process-cv-hidden') {
      // Assistant rows report their first matching process child; tool/system
      // rows report themselves (the row element carries the class).
      if (!row.classList.contains('assistant')) {
        return row.classList.contains(sel.slice(1)) ? {} : null;
      }
      return (row._processChildren || []).some((c) => c.classList.contains(sel.slice(1))) ? {} : null;
    }
    return null;
  };
  row.querySelectorAll = (sel) => {
    if (sel === '.reasoning-block, .tool-call-container') return row._processChildren || [];
    if (sel === '.process-cv-hidden' || sel === '.process-hidden') {
      const cls = sel.slice(1);
      if (!row.classList.contains('assistant')) {
        return row.classList.contains(cls) ? [{}] : [];
      }
      return (row._processChildren || []).filter((c) => c.classList.contains(cls));
    }
    return [];
  };
  row.appendChild = (child) => {
    if (child && child._isToggleBar) btnBar = child;
    return child;
  };
  return { row, content, getBtnBar: () => btnBar };
}

// Layout model: sequential offsetTop over container rows.
function installLayout(container) {
  function rowHeight(entry) {
    const row = entry.row;
    if (row.classList.contains('process-hidden') || row.classList.contains('process-hidden-empty')) return 0;
    const allCv = row.classList.contains('assistant')
      ? (row._processChildren || []).length > 0
        && (row._processChildren || []).every((c) => c.classList.contains('process-cv-hidden'))
      : row.classList.contains('process-cv-hidden');
    if (allCv) return row.rememberedH ?? 150;
    if (!row.classList.contains('assistant') && row.classList.contains('process-cv-hidden')) return row.rememberedH ?? 150;
    if (entry.content.classList.contains('collapsed')) return Math.min(row.realH, 160) + TOGGLE_BAR_H;
    return row.realH;
  }

  let cache = { dirty: true, tops: new Map(), total: 0 };
  function layout() {
    if (cache.dirty) {
      cache.tops.clear();
      let top = 0;
      for (const entry of container._entries) {
        const h = rowHeight(entry);
        const participates = !rowHeightHidden(entry);
        if (participates) entry.row.rememberedH = h;
        cache.tops.set(entry.row, { top, h });
        top += h;
      }
      cache.total = top;
      cache.dirty = false;
    }
    return cache;
  }
  function rowHeightHidden(entry) {
    return entry.row.classList.contains('process-hidden')
      || entry.row.classList.contains('process-hidden-empty');
  }

  container._markDirty = () => { cache.dirty = true; };
  Object.defineProperty(container, 'scrollHeight', {
    get() { return Math.max(layout().total, VIEW_H); },
  });
  container._entries = [];
  container._rows = new Proxy({}, {
    // Not used directly; querySelectorAll returns rows via selector below.
  });
  container.querySelectorAll = (sel) => {
    if (sel === '.message-row') {
      // No layout() here: in a real browser querySelectorAll does not force
      // layout, and applyProcessDistance queries rows BEFORE the cv-hidden
      // classes land — far rows must never get a full-height layout pass, or
      // their remembered height (contain-intrinsic-size: auto) would erase
      // the placeholder snap this suite is testing. Row offsetTop/offsetHeight
      // reads trigger layout lazily.
      return container._entries.map((e) => e.row);
    }
    return [];
  };
  container.querySelector = (sel) => (sel === '.message-row'
    ? (container.querySelectorAll('.message-row')[0] || null)
    : null);
  container.getBoundingClientRect = () => ({ top: 0, left: 0, width: 1000, height: VIEW_H });
  container.addEventListener = () => {};
  container.removeEventListener = () => {};
  Object.defineProperty(container, 'offsetTop', { get: () => 0 });
  Object.defineProperty(container, 'offsetHeight', { get: () => layout().total });
  container._layout = layout;
  return layout;
}

function createHarness({ messages } = {}) {
  const container = {
    clientHeight: VIEW_H,
    _scrollTop: 0,
    _scrollWrites: [],
  };
  const layout = installLayout(container);
  Object.defineProperty(container, 'scrollTop', {
    get() {
      // Real browsers clamp scrollTop to [0, scrollHeight - clientHeight]
      // dynamically — content shrinking (folds above the viewport) pulls an
      // out-of-range scrollTop back at read/paint time. Mirror that here.
      const max = Math.max(0, container.scrollHeight - VIEW_H);
      return Math.min(container._scrollTop, max);
    },
    set(value) {
      layout();
      const next = Math.max(0, Math.min(Number(value) || 0, Math.max(0, container.scrollHeight - VIEW_H)));
      if (next !== container._scrollTop) {
        container._scrollWrites.push({ from: container._scrollTop, to: next });
        container._scrollTop = next;
      }
    },
  });

  const timers = new Map();
  const rafCallbacks = new Map();
  const rafOrder = [];
  let seq = 1;

  const sandbox = {
    console,
    Date, JSON, Math, Promise, Map, Set, Number, Object, Array, Boolean, String, isNaN, parseInt,
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
      body: { contains: () => true },
    },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },

    container,
    followLatestButton: { classList: { toggle() {}, add() {}, remove() {} }, innerHTML: '', classList2: null },
    workspaceTabsBar: null,
    currentMessages: messages || [],
    allAgents: [],
    toolRenderConfigs: {},
    _lastRenderedChatSig: '',
    _userExpandedReasoning: new Set(),
    _userExpandedMsgs: new Set(),
    _userCollapsedMsgs: new Set(),
    currentInputRequests: [],
    currentRuntimeAgentId: 'rt-1',
    _agentCallActive: new Map(),
    lastRenderedInputSignature: '',
    chatProcessToggle: null,
    CHAT_PROCESS_VISIBILITY_KEY: 'k',
    readCurrentSessionViewState: () => ({ messages: sandbox.currentMessages, inputRequests: [] }),
    saveChatProcessVisibility() {},

    isChatSurfaceActive: () => true,
    shouldRenderWorkspaceSurface: () => false,
    escapeHtml: (v) => String(v ?? ''),
    t: (k) => k,
    renderMarkdown: (s) => '<p>' + String(s).slice(0, 20) + '</p>',
    parseToolResult: (content) => ({ success: true, data: content }),
    renderJsonHighlight: (d) => '<pre>' + String(d).slice(0, 20) + '</pre>',
    applyTemplate: () => '<div>args</div>',
    enhanceMathInElement() {},
    clearTruncatedHighlightData() {},
    getToolDisplayName: (n) => n || 'Tool',
    getToolRenderTemplate: () => ({}),
    resolveToolProgressForCall: () => null,
    canRollbackMessage: () => false,
    requestRollbackEdit() {},
    switchAgent() {},
    ensureChatRuntimeIndicator() {},
    getEmptyStateHtml: () => '<div class="empty-state">empty</div>',
    renderCurrentMainView() {},
    getCurrentHostAgentRecord: () => null,

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
  vm.runInContext(src('modules/chat-viewport.js'), sandbox, { filename: 'chat-viewport.js' });
  vm.runInContext(src('modules/input-helpers.js'), sandbox, { filename: 'input-helpers.js' });
  vm.runInContext(src('modules/lazy-tool-content.js'), sandbox, { filename: 'lazy-tool-content.js' });
  vm.runInContext(src('modules/chat-renderer.js'), sandbox, { filename: 'chat-renderer.js' });
  sandbox.__markDirty = () => container._markDirty();

  // Wire classList mutations to layout invalidation for every entry added later.
  container._onStructureChange = () => container._markDirty();

  function flushTimers() {
    const pending = [...timers.values()];
    timers.clear();
    pending.forEach((cb) => cb());
  }
  function pumpFrame() {
    const ids = rafOrder.splice(0);
    ids.forEach((id) => {
      const cb = rafCallbacks.get(id);
      rafCallbacks.delete(id);
      if (cb) cb();
    });
  }

  function addRow(entry) {
    container._entries.push(entry);
    container._markDirty();
    // Row-level layout accessors: the windowing/fold code reads offsetTop /
    // offsetHeight on rows (reveal compensation, binary-search scans). Back
    // them with the layout cache — without them every read yields undefined
    // and the compensation silently no-ops.
    Object.defineProperty(entry.row, 'offsetTop', {
      get: () => {
        const rec = container._layout().tops.get(entry.row);
        return rec ? rec.top : 0;
      },
    });
    Object.defineProperty(entry.row, 'offsetHeight', {
      get: () => {
        const rec = container._layout().tops.get(entry.row);
        return rec ? rec.h : 0;
      },
    });
    // Route classList mutations through layout invalidation.
    for (const target of [entry.row, entry.content, ...(entry.row._processChildren || [])]) {
      const list = target.classList;
      if (!list.__wired) {
        list.__wired = true;
        const add = list.add.bind(list);
        const remove = list.remove.bind(list);
        const toggle = list.toggle.bind(list);
        list.add = (...n) => { add(...n); container._markDirty(); };
        list.remove = (...n) => { remove(...n); container._markDirty(); };
        list.toggle = (name, force) => { const r = toggle(name, force); container._markDirty(); return r; };
      }
    }
    return entry;
  }

  function makeToolEntries({ toolName, realH, from, to }) {
    const out = [];
    for (let i = from; i < to; i++) {
      const e = makeRow({ role: 'tool', realH, toolName, msgId: `msg-${container._entries.length}` });
      out.push(addRow(e));
    }
    return out;
  }

  function viewportTopEntry() {
    layout();
    const st = container.scrollTop;
    return container._entries.find((e) => {
      const rec = container._layout().tops.get(e.row);
      return rec && rec.top + rec.h > st && !e.row.classList.contains('process-hidden');
    }) || null;
  }

  function totalHeight() { return container.scrollHeight; }

  return {
    sandbox, container, layout, flushTimers, pumpFrame, addRow, makeToolEntries,
    viewportTopEntry, totalHeight,
  };
}

test('landing: the show-mode landing sequence folds visible tool rows before the first paint', () => {
  const h = createHarness();
  h.sandbox.showChatProcess = true;
  h.sandbox.followLatestEnabled = true;

  for (let i = 0; i < 40; i++) {
    h.addRow(makeRow({ role: 'tool', realH: 600, toolName: 'Read', msgId: `msg-${i}` }));
  }

  // This is the exact sequence render() runs for a fresh show-mode render
  // (innerHTML rebuild → clearProcessDistance → applyConversationProcessState
  // → follow lock → landing scan). All of it is synchronous — no timer or
  // rAF may fire before the first paint.
  vm.runInContext(`
    clearProcessDistance(container);
    applyConversationProcessState(container);
    if (typeof lockChatViewportToBottomNow === 'function') lockChatViewportToBottomNow();
    if (typeof runLandingCollapseScan === 'function') runLandingCollapseScan();
  `, h.sandbox);

  assert.equal(h.container.scrollTop > 0, true, 'landing must lock to the bottom synchronously');
  const visibleEntries = h.container._entries.filter((e) => {
    const rec = h.layout().tops.get(e.row);
    return rec && !e.row.classList.contains('process-hidden')
      && rec.top < h.container.scrollTop + VIEW_H && rec.top + rec.h > h.container.scrollTop;
  });
  assert.ok(visibleEntries.length > 0, 'viewport should have visible rows');
  const expandedTools = visibleEntries.filter((e) =>
    e.row.role === 'tool' && !e.content.classList.contains('collapsed'));
  assert.equal(expandedTools.length, 0, 'no expanded tool row may be visible at first paint');
});

test('process-toggle: first paint after toggling show-process in follow mode shows collapsed tool rows', () => {
  const h = createHarness();
  h.sandbox.showChatProcess = false;
  h.sandbox.followLatestEnabled = true;

  // Mixed transcript: hide mode shows only the user rows (tool rows are
  // display:none), so the pre-toggle reading position sits at the bottom.
  for (let i = 0; i < 30; i++) {
    h.addRow(makeRow({ role: 'user', realH: 80, msgId: `msg-u${i}` }));
    h.addRow(makeRow({ role: 'tool', realH: 600, toolName: 'Read', msgId: `msg-${i}` }));
  }
  vm.runInContext('applyConversationProcessState(container)', h.sandbox);
  h.container.scrollTop = h.container.scrollHeight;
  assert.ok(h.container.scrollTop > 0, 'hide-mode viewport parked at the bottom');

  // The user clicks "显示过程" — toggleChatProcessVisibility must reveal AND
  // fold the incoming viewport in the same task. The landing scan must scan
  // the post-lock bottom position, not the stale pre-toggle scrollTop:
  // with the stale position it folds the wrong rows and the viewport rows
  // stay expanded until the scroll-stop settle (~150ms later) folds them
  // with a visible jump.
  vm.runInContext('toggleChatProcessVisibility()', h.sandbox);

  assert.ok(h.container.scrollTop > 0, 'follow toggle must lock to the bottom');
  const visibleEntries = h.container._entries.filter((e) => {
    const rec = h.layout().tops.get(e.row);
    return rec && !e.row.classList.contains('process-hidden')
      && rec.top < h.container.scrollTop + VIEW_H && rec.top + rec.h > h.container.scrollTop;
  });
  assert.ok(visibleEntries.length > 0, 'viewport should have visible rows');
  const expandedTools = visibleEntries.filter((e) =>
    e.row.role === 'tool' && !e.content.classList.contains('collapsed'));
  assert.equal(expandedTools.length, 0, 'no expanded tool row may be visible at first paint');
});

test('windowing: revealing above-viewport rows compensates scrollTop so the content anchor stays put', () => {
  const h = createHarness();
  h.sandbox.showChatProcess = true;
  h.sandbox.followLatestEnabled = false;

  // 600 tool rows of 600px each; landing reveals only the bottom window.
  for (let i = 0; i < 600; i++) {
    h.addRow(makeRow({ role: 'tool', realH: 600, toolName: 'Bash', msgId: `msg-${i}` }));
  }
  vm.runInContext('applyProcessDistance(container)', h.sandbox);
  h.flushTimers();

  // Scroll up into a position where the next window slide reveals a batch of
  // never-realized rows (placeholder 150px vs real 600px).
  const jumpTo = Math.max(0, h.totalHeight() * 0.5);
  h.container.scrollTop = jumpTo;
  vm.runInContext('applyProcessDistance(container)', h.sandbox);
  h.flushTimers();

  const anchor = h.viewportTopEntry();
  assert.ok(anchor, 'need a visible anchor row');
  const viewOffsetOf = (entry) => {
    h.layout();
    const rec = h.layout().tops.get(entry.row);
    return rec ? rec.top - h.container.scrollTop : null;
  };

  // Wheel up in small steps. Measure the anchor's viewport offset per frame:
  // after each step it must have moved exactly -STEP (no jitter). When the
  // anchor is hidden by a window slide or scrolls out of the measurable
  // band, re-pick and skip that frame (anchor-switch, not drift).
  let current = anchor;
  let pendingIn = viewOffsetOf(current);
  let measured = 0, joltFrames = 0, maxJolt = 0;
  for (let i = 0; i < 400; i++) {
    h.container.scrollTop -= 150;
    vm.runInContext('_onScrollForWindowing()', h.sandbox);
    h.flushTimers();
    h.pumpFrame();
    h.flushTimers();
    if (h.container.scrollTop <= 0) break;

    const hidden = current.row.classList.contains('process-hidden')
      || current.row.classList.contains('process-hidden-empty')
      || current.row.classList.contains('process-cv-hidden')
      || (current.row._processChildren || []).some((c) => c.classList.contains('process-cv-hidden'));
    h.layout();
    const rec = h.layout().tops.get(current.row);
    const gone = !rec || rec.top >= h.container.scrollTop + VIEW_H + 2000;
    if (hidden || gone) {
      const next = h.viewportTopEntry();
      if (!next) break;
      current = next;
      pendingIn = viewOffsetOf(current);
      continue;
    }
    const in1 = rec.top - h.container.scrollTop;
    // Scrolling UP by STEP moves the anchor DOWN in viewport coords: in1 ≈ pendingIn + STEP.
    const jolt = (in1 - pendingIn) - 150;
    measured++;
    if (Math.abs(jolt) > 2) {
      joltFrames++;
      maxJolt = Math.max(maxJolt, Math.abs(jolt));
    }
    pendingIn = in1;
  }

  assert.ok(h.container.scrollTop < jumpTo, 'should have scrolled upward');
  assert.ok(measured > 20, `should have measured enough frames (got ${measured})`);
  assert.equal(joltFrames, 0, `anchor must stay pixel-stable per frame (jolts=${joltFrames}, max=${maxJolt}px)`);
  assert.ok(h.container._scrollWrites.some((w) => w.to > w.from), 'reveal snap must be compensated by a scrollTop write');
});

test('windowing: follow mode skips the reveal compensation (bottom-lock settlement owns the scroll)', () => {
  const h = createHarness();
  h.sandbox.showChatProcess = true;
  h.sandbox.followLatestEnabled = true;

  for (let i = 0; i < 40; i++) {
    h.addRow(makeRow({ role: 'tool', realH: 600, toolName: 'Bash', msgId: `msg-${i}` }));
  }
  vm.runInContext('applyProcessDistance(container)', h.sandbox);
  h.flushTimers();

  const writesBefore = h.container._scrollWrites.length;
  // Force a window slide by pointing the viewport far above the window.
  h.container.scrollTop = Math.max(0, h.container.scrollTop - 30000);
  vm.runInContext('_lastWindowStart = -1', h.sandbox);
  vm.runInContext('_applyWindow()', h.sandbox);
  h.flushTimers();

  const writes = h.container._scrollWrites.slice(writesBefore);
  const positiveWrites = writes.filter((w) => w.to > w.from);
  assert.equal(positiveWrites.length, 0, 'no upward compensation writes may happen in follow mode');
});

test('scrollbar drag release: settle pins the release anchor so the reading frame does not jump', () => {
  const h = createHarness();
  h.sandbox.showChatProcess = true;
  h.sandbox.followLatestEnabled = false;

  // Interleaved transcript: user rows are always real (never cv-hidden), tool
  // rows above the landing window are 150px stubs vs 600px real. Any release
  // viewport then contains the bug geometry: stub(s) above a real row.
  // applyProcessDistance MUST run before any layout read: rows hidden before
  // their first layout keep the 150px placeholder (contain-intrinsic-size has
  // nothing remembered) — reading scrollHeight first would lay every row out
  // at 600px and the remembered height would erase the reveal snap.
  for (let i = 0; i < 300; i++) {
    h.addRow(makeRow({ role: 'user', realH: 80, msgId: `msg-u${i}` }));
    h.addRow(makeRow({ role: 'tool', realH: 600, toolName: 'Bash', msgId: `msg-${i}` }));
  }
  vm.runInContext('applyProcessDistance(container)', h.sandbox);
  h.container.scrollTop = h.container.scrollHeight;
  vm.runInContext('_onScrollForWindowing()', h.sandbox);
  h.flushTimers();

  // Scrollbar drag: two events with deltas far above the large-delta
  // threshold, landing ~20% into the document (deep in stub territory,
  // well above the landing window) → windowing must stay fully silent
  // until release.
  const dragTarget = Math.max(0, Math.round(h.container.scrollTop * 0.2));
  const heightDuringDrag = [];
  for (let e = 0; e < 2; e++) {
    const step = Math.round((h.container.scrollTop - dragTarget) / (2 - e));
    h.container.scrollTop = h.container.scrollTop - step;
    vm.runInContext('_onScrollForWindowing()', h.sandbox);
    h.pumpFrame();
    heightDuringDrag.push(h.container.scrollHeight);
  }
  assert.ok(heightDuringDrag.every((x) => x === heightDuringDrag[0]),
    'windowing must not reflow while the drag is in motion');

  // Park the viewport inside stub territory such that the release anchor —
  // the first REAL row at or below the viewport top (the capture rule in
  // _onScrollStop) — has at least one cv-hidden stub above it within the
  // view. Revealing that stub is the displacement the pin must absorb.
  const rowsNow = () => h.container.querySelectorAll('.message-row');
  const findRelease = (st) => {
    const rows = rowsNow();
    const real = rows.find((r) => !r.classList.contains('process-cv-hidden') && r.offsetTop >= st);
    if (!real || real.offsetTop >= st + VIEW_H) return null;
    const hasStubAbove = rows.some((r) => {
      const rec = h.layout().tops.get(r);
      return r.classList.contains('process-cv-hidden') && rec
        && rec.top >= st && rec.top < real.offsetTop;
    });
    return hasStubAbove ? { st, real } : null;
  };
  let release = null;
  for (let st = h.container.scrollTop; st > 0 && !release; st -= 40) {
    h.container.scrollTop = st;
    release = findRelease(st);
  }
  assert.ok(release, 'must find a release point with a stub above the release anchor in view');
  h.container.scrollTop = release.st;
  vm.runInContext('_onScrollForWindowing()', h.sandbox); // large delta → silent until release
  h.pumpFrame();

  const anchor = release.real;
  const offsetBefore = anchor.offsetTop - h.container.scrollTop;
  const scrollTopAtRelease = h.container.scrollTop;

  // Release: the 150ms scroll-stop settle runs reveal + collapse + pin in
  // one task. The anchor must stay at its release-time viewport offset —
  // the stub zone above it resolves into content around a fixed frame.
  h.flushTimers();

  assert.ok(!anchor.classList.contains('process-cv-hidden'), 'anchor row must be revealed after settle');
  assert.ok(h.container._scrollWrites.some((w) => w.to > w.from && w.from >= scrollTopAtRelease),
    'settle must have re-anchored scrollTop (reveal growth above the viewport top)');
  const offsetAfter = anchor.offsetTop - h.container.scrollTop;
  assert.ok(Math.abs(offsetAfter - offsetBefore) <= 1,
    `release anchor must keep its viewport offset (before=${Math.round(offsetBefore)}, after=${Math.round(offsetAfter)})`);
});

// Fold compensation near the bottom of the document: when a fold shrinks
// scrollHeight past the current scrollTop, the browser clamps the read-back
// (scrollTop getter returns maxScroll). Compensation must base on the
// PRE-fold scrollTop, otherwise the clamp poisons the baseline and the
// visible content jumps — the "sticky wheel" jolt felt while scrolling up
// from the bottom of a long show-process transcript.
test('windowing: fold compensation is clamp-safe when the collapse crosses maxScroll', () => {
  const h = createHarness();
  h.sandbox.showChatProcess = true;
  h.sandbox.followLatestEnabled = false;

  // Tool rows above, a short real tail below: the viewport parked at the
  // bottom sits just above the fold candidates, so the first fold's
  // shrinkage crosses maxScroll (the clamp boundary scenario).
  for (let i = 0; i < 200; i++) {
    h.addRow(makeRow({ role: 'tool', realH: 600, toolName: 'Read', msgId: `msg-t${i}` }));
  }
  for (let i = 0; i < 10; i++) {
    h.addRow(makeRow({ role: 'user', realH: 80, msgId: `msg-u${i}` }));
  }
  vm.runInContext('applyProcessDistance(container)', h.sandbox);
  h.flushTimers();
  h.container.scrollTop = h.container.scrollHeight;
  vm.runInContext('_onScrollForWindowing()', h.sandbox);
  h.flushTimers();

  // Wheel up from the bottom: the first motion frame collapses the first
  // fully-above row. Compensation must move scrollTop by exactly the fold
  // delta minus the wheel step — never short (clamp-poisoned baseline) and
  // never skipped (self-defeating guard).
  let anchor = h.viewportTopEntry();
  assert.ok(anchor, 'need anchor');
  const viewOffsetOf = (entry) => {
    h.layout();
    const rec = h.layout().tops.get(entry.row);
    return rec ? rec.top - h.container.scrollTop : null;
  };
  let pendingIn = viewOffsetOf(anchor);
  let measured = 0, joltFrames = 0, maxJolt = 0, folds = 0;
  for (let frame = 0; frame < 300; frame++) {
    if (h.container.scrollTop <= 0) break;
    h.container.scrollTop -= 53; // compositor wheel step
    vm.runInContext('_onScrollForWindowing()', h.sandbox);
    h.flushTimers();
    h.pumpFrame();
    h.flushTimers();
    if (h.container.scrollTop <= 0) break;

    const hidden = anchor.row.classList.contains('process-hidden')
      || anchor.row.classList.contains('process-cv-hidden')
      || (anchor.row._processChildren || []).some((c) => c.classList.contains('process-cv-hidden'));
    h.layout();
    const rec = h.layout().tops.get(anchor.row);
    if (hidden || !rec || rec.top + rec.h <= h.container.scrollTop) {
      const next = h.viewportTopEntry();
      if (!next) break;
      anchor = next;
      pendingIn = viewOffsetOf(anchor);
      continue;
    }
    const inNow = rec.top - h.container.scrollTop;
    const jolt = (inNow - pendingIn) - 53;
    if (Math.abs(jolt) > 2) {
      joltFrames++;
      maxJolt = Math.max(maxJolt, Math.abs(jolt));
    }
    pendingIn = inNow;
  }
  folds = vm.runInContext(
    '(function(){var n=0;var rows=container.querySelectorAll(".message-row");' +
    'for(var i=0;i<rows.length;i++){if(rows[i].querySelector(".message-content")' +
    '&&rows[i].querySelector(".message-content").classList.contains("collapsed"))n++;}return n;})()',
    h.sandbox);

  assert.ok(folds > 5, `compensation scenario requires folds to happen (got ${folds})`);
  assert.ok(h.container.scrollTop < h.totalHeight() * 0.95, 'should have scrolled upward');
  assert.equal(joltFrames, 0, 'fold compensation must keep the content anchor pixel-stable near the clamp boundary');
});

test('panel drag: freezeProcessWindowing silences the scroll chain during the drag; unfreeze settles once', () => {
  const h = createHarness();
  h.sandbox.showChatProcess = true;
  h.sandbox.followLatestEnabled = false;

  for (let i = 0; i < 300; i++) {
    h.addRow(makeRow({ role: 'user', realH: 80, msgId: `msg-u${i}` }));
    h.addRow(makeRow({ role: 'tool', realH: 600, toolName: 'Bash', msgId: `msg-${i}` }));
  }
  vm.runInContext('applyProcessDistance(container)', h.sandbox);

  // Park mid-document: the windowing window settles around this position so
  // the drag below has stub territory ahead (rows to reveal) — the geometry
  // where a live scroll chain would fight the drag anchor.
  h.container.scrollTop = Math.round(h.container.scrollHeight * 0.5);
  vm.runInContext('_onScrollForWindowing()', h.sandbox);
  h.pumpFrame();
  h.flushTimers();

  // Drag starts: windowing frozen.
  vm.runInContext('freezeProcessWindowing()', h.sandbox);

  // Drag frames: the panel-drag anchor writes scrollTop in small steps every
  // frame (well below the large-delta threshold — these would normally run
  // the rAF window update + reveal compensation mid-drag).
  const heightAtFreeze = h.container.scrollHeight;
  const cvStatesAtFreeze = h.container.querySelectorAll('.message-row')
    .map((r) => r.classList.contains('process-cv-hidden'));
  for (let e = 0; e < 6; e++) {
    h.container.scrollTop += 30;
    vm.runInContext('_onScrollForWindowing()', h.sandbox);
    h.pumpFrame();
  }
  assert.equal(h.container.scrollHeight, heightAtFreeze,
    'frozen windowing must not reveal/reflow during the drag');
  assert.deepEqual(
    h.container.querySelectorAll('.message-row').map((r) => r.classList.contains('process-cv-hidden')),
    cvStatesAtFreeze,
    'frozen windowing must not touch row visibility during the drag');

  // Release: unfreeze runs ONE comprehensive settle (fresh window + collapse,
  // same semantics as a scrollbar-drag release). Rows near the final viewport
  // must be revealed.
  vm.runInContext('unfreezeProcessWindowing()', h.sandbox);
  const rows = h.container.querySelectorAll('.message-row');
  const topIdx = rows.findIndex((r) => r.offsetTop + r.offsetHeight > h.container.scrollTop);
  const nearTool = rows.slice(topIdx, topIdx + 6).find((r) => r.classList.contains('tool'));
  assert.ok(nearTool && !nearTool.classList.contains('process-cv-hidden'),
    'unfreeze settle must reveal rows near the final viewport');

  // After unfreeze the normal chain serves scrolls again: a scrollbar-style
  // jump lands silently (large-delta deferral) and the 150ms settle reveals
  // the arrival viewport — the same semantics as a drag release.
  assert.equal(vm.runInContext('_windowingFrozen', h.sandbox), false,
    'unfreeze must clear the frozen flag');
  const farRow = rows.find((r) => r.classList.contains('tool')
    && r.classList.contains('process-cv-hidden')
    && r.offsetTop > h.container.scrollTop + 5000);
  assert.ok(farRow, 'need a far hidden tool row for the recovery check');
  h.container.scrollTop = farRow.offsetTop - 10; // single large jump
  vm.runInContext('_onScrollForWindowing()', h.sandbox);
  h.pumpFrame(); // rAF stays silent (large-delta deferral)
  h.flushTimers(); // scroll-stop settle: fresh window + reveal + collapse
  assert.ok(!farRow.classList.contains('process-cv-hidden'),
    'post-unfreeze jump settle must reveal the arrival viewport (chain recovered)');
});
