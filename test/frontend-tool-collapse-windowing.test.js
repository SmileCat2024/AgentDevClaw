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
      layout();
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
