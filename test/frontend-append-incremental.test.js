/**
 * Tests for the incremental append/patch paths of "show process" mode.
 *
 * In the full-render tier (>200 rows), every streaming message event used to
 * trigger three full O(N) passes on the JS side: applyProcessDistance rebuilt
 * the rowCache (one subtree querySelectorAll per assistant row), and
 * refreshMeasuredChatRows re-measured every row (offsetTop +
 * getBoundingClientRect) while reallocating entries/byRow. On long
 * conversations that per-message full scan is the dominant cost of the
 * show-process mode.
 *
 * The incremental contract under test:
 *   - applyConversationProcessState(root, fromIndex) → applyProcessDistance
 *     only processes tail rows (append/patch); old cache entries and cv
 *     states are reused as-is. A DOM rebuild that slips through the fromIndex
 *     call must fall back to the full path (first-row identity guard).
 *   - refreshMeasuredChatRows('append') only measures appended rows (a tail
 *     insert does not move prior offsetTop values);
 *     refreshMeasuredChatRows('patch-last') only re-measures the tail row.
 *     Both keep the window semantics of the full path (apply(true) with a
 *     reset window) so far rows still get hidden.
 *   - New assistant rows get their pre-hidden process children revealed
 *     (display:none removal), keeping fold-at-birth measurable.
 *
 * Loads the real chat-viewport.js / input-helpers.js / lazy-tool-content.js /
 * chat-renderer.js / chat-row-visibility.js into a vm sandbox with a
 * layout-model DOM stub (mirroring frontend-tool-collapse-windowing.test.js).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const src = (p) => fs.readFileSync(new URL('../public/src/' + p, import.meta.url), 'utf8');

const VIEW_H = 800;

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

// Row stub with the DOM surface the windowing/incremental code touches.
// realH is the expanded content height. Counters expose offsetTop reads and
// subtree querySelectorAll calls so the tests can prove old rows are not
// rescanned by the incremental paths.
function makeRow({ role, realH, msgId = '' }) {
  const row = {
    role,
    realH,
    rememberedH: null,
    _msgId: msgId,
    classList: makeClassList(),
    dataset: {},
    contains: () => false, // chat-row-visibility hide() focus guard
    style: {
      _props: {},
      setProperty(k, v) { this._props[k] = String(v); },
      removeProperty(k) { delete this._props[k]; },
    },
  };
  row.classList.add(role);

  const content = {
    id: msgId,
    scrollHeight: realH,
    classList: makeClassList(),
    style: {},
    // Real DOM: .message-content always has children.
    get children() { return row._processChildren || []; },
  };

  const origQsa = (sel) => {
    if (sel === '.reasoning-block, .tool-call-container') return row._processChildren || [];
    return [];
  };
  let qsaCalls = 0;
  row.querySelectorAll = (sel) => { qsaCalls++; return origQsa(sel); };
  row._qsaCalls = () => qsaCalls;
  row.querySelector = (sel) => {
    if (sel === '.message-content') return content;
    return null;
  };
  row.appendChild = (child) => child;
  return { row, content };
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
    if (row.classList.contains('chat-row-distant')) return row.rememberedH ?? 150;
    return row.realH;
  }
  function rowHeightHidden(entry) {
    return entry.row.classList.contains('process-hidden')
      || entry.row.classList.contains('process-hidden-empty');
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

  container._markDirty = () => { cache.dirty = true; };
  Object.defineProperty(container, 'scrollHeight', {
    get() { return Math.max(layout().total, VIEW_H); },
  });
  container._entries = [];
  container.querySelectorAll = (sel) => {
    if (sel === '.message-row') return container._entries.map((e) => e.row);
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
    clientWidth: 1000,
    _scrollTop: 0,
  };
  const layout = installLayout(container);
  Object.defineProperty(container, 'scrollTop', {
    get() {
      const max = Math.max(0, container.scrollHeight - VIEW_H);
      return Math.min(container._scrollTop, max);
    },
    set(value) {
      layout();
      const next = Math.max(0, Math.min(Number(value) || 0, Math.max(0, container.scrollHeight - VIEW_H)));
      container._scrollTop = next;
    },
  });

  const timers = new Map();
  const rafCallbacks = new Map();
  const rafOrder = [];
  let seq = 1;

  const sandbox = {
    console, Date, JSON, Math, Promise, Map, Set, Number, Object, Array, Boolean, String, isNaN, parseInt,
    CSS: { supports: () => true }, // chat-row-visibility capability probe
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
      createElement: () => ({ style: {}, classList: makeClassList(), dataset: {}, setAttribute() {} }),
      body: { contains: () => true },
      activeElement: null,
    },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },

    container,
    followLatestButton: { classList: { toggle() {}, add() {}, remove() {} }, innerHTML: '' },
    workspaceTabsBar: null,
    currentMessages: messages || [],
    allAgents: [],
    toolRenderConfigs: {},
    _lastRenderedChatSig: '',
    _userExpandedReasoning: new Set(),
    _userExpandedMsgs: new Set(),
    _userCollapsedMsgs: new Set(),
    _userExpandedToolCalls: new Set(),
    _userCollapsedToolCalls: new Set(),
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
  vm.runInContext(src('modules/chat-row-visibility.js'), sandbox, { filename: 'chat-row-visibility.js' });

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
    Object.defineProperty(entry.row, 'offsetTop', {
      get: () => {
        entry._topReads = (entry._topReads || 0) + 1;
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
    Object.defineProperty(entry.row, 'getBoundingClientRect', {
      get: () => () => {
        const rec = container._layout().tops.get(entry.row);
        return { top: rec ? rec.top : 0, height: rec ? rec.h : 0 };
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

  function makeToolEntries({ realH = 600, from, to }) {
    const out = [];
    for (let i = from; i < to; i++) {
      out.push(addRow(makeRow({ role: 'tool', realH, msgId: `msg-${i}` })));
    }
    return out;
  }

  function makeAssistantEntries({ realH = 200, from, to }) {
    // Assistant rows carrying one tool-call-container process child, the
    // shape _buildRowCache caches.
    const out = [];
    for (let i = from; i < to; i++) {
      const e = makeRow({ role: 'assistant', realH, msgId: `msg-${i}` });
      const callCard = {
        classList: makeClassList(),
        style: { _props: {}, setProperty(k, v) { this._props[k] = String(v); }, removeProperty(k) { delete this._props[k]; } },
      };
      callCard.classList.add('tool-call-container');
      e.row._processChildren = [callCard];
      out.push(addRow(e));
    }
    return out;
  }

  return {
    sandbox, container, layout, flushTimers, pumpFrame, addRow,
    makeToolEntries, makeAssistantEntries,
  };
}

test('refreshMeasuredChatRows(append) measures only appended rows', () => {
  const h = createHarness();
  h.sandbox.showChatProcess = true;
  h.sandbox.followLatestEnabled = false;
  vm.runInContext('setProcessWindowingDisabled(true)', h.sandbox);

  const old = h.makeToolEntries({ realH: 600, from: 0, to: 205 });
  vm.runInContext('refreshMeasuredChatRows("render-full")', h.sandbox);

  const baseline = old.map((e) => e._topReads || 0);
  const hiddenBefore = old.map((e) => e.row.classList.contains('chat-row-distant'));

  const fresh = h.makeToolEntries({ realH: 600, from: 205, to: 210 });
  vm.runInContext('refreshMeasuredChatRows("append")', h.sandbox);
  h.flushTimers();
  h.pumpFrame();
  h.flushTimers();

  // Old rows: no re-measure, no state churn.
  old.forEach((e, i) => {
    assert.equal(e._topReads || 0, baseline[i],
      `old row ${i} must not be re-measured by the incremental append path`);
    assert.equal(e.row.classList.contains('chat-row-distant'), hiddenBefore[i],
      `old row ${i} window state must be unchanged`);
  });
  // New rows: measured (entry present) and windowed (viewport sits at the
  // top, so tail rows fall outside the [0, top+4h] window → hidden).
  fresh.forEach((e) => {
    assert.ok((e._topReads || 0) >= 1, 'appended row must be measured');
    assert.equal(e.row.classList.contains('chat-row-distant'), true,
      'appended far row must rejoin the hidden window');
    assert.ok(e.row.style._props['--chat-row-height'], 'hidden row keeps its measured height');
  });
});

test('refreshMeasuredChatRows(append) matches the full rebuild row-for-row', () => {
  const build = () => {
    const h = createHarness();
    h.sandbox.showChatProcess = true;
    h.sandbox.followLatestEnabled = false;
    vm.runInContext('setProcessWindowingDisabled(true)', h.sandbox);
    h.makeToolEntries({ realH: 600, from: 0, to: 205 });
    return h;
  };
  const hInc = build();
  vm.runInContext('refreshMeasuredChatRows("render-full")', hInc.sandbox);
  hInc.makeToolEntries({ realH: 600, from: 205, to: 210 });
  vm.runInContext('refreshMeasuredChatRows("append")', hInc.sandbox);
  hInc.flushTimers(); hInc.pumpFrame(); hInc.flushTimers();

  const hFull = build();
  vm.runInContext('refreshMeasuredChatRows("render-full")', hFull.sandbox);
  hFull.makeToolEntries({ realH: 600, from: 205, to: 210 });
  vm.runInContext('refreshMeasuredChatRows("force-full")', hFull.sandbox); // non-whitelisted → full path
  hFull.flushTimers(); hFull.pumpFrame(); hFull.flushTimers();

  hInc.container._entries.forEach((e, i) => {
    assert.equal(
      e.row.classList.contains('chat-row-distant'),
      hFull.container._entries[i].row.classList.contains('chat-row-distant'),
      `row ${i} window state diverged between incremental and full refresh`,
    );
  });
});

test('refreshMeasuredChatRows(patch-last) re-measures only the tail row', () => {
  const h = createHarness();
  h.sandbox.showChatProcess = true;
  h.sandbox.followLatestEnabled = false;
  vm.runInContext('setProcessWindowingDisabled(true)', h.sandbox);

  const rows = h.makeToolEntries({ realH: 600, from: 0, to: 205 });
  vm.runInContext('refreshMeasuredChatRows("render-full")', h.sandbox);

  const baseline = rows.map((e) => e._topReads || 0);
  // Tail patch: content grows (realH 600 → 900), layout invalidated.
  const tail = rows[rows.length - 1];
  tail.row.realH = 900;
  h.container._markDirty();

  vm.runInContext('refreshMeasuredChatRows("patch-last")', h.sandbox);
  h.flushTimers(); h.pumpFrame(); h.flushTimers();

  rows.slice(0, -1).forEach((e, i) => {
    assert.equal(e._topReads || 0, baseline[i],
      `non-tail row ${i} must not be re-measured by patch-last`);
  });
  assert.ok((tail._topReads || 0) > baseline[baseline.length - 1],
    'the patched tail row must be re-measured');
});

test('applyProcessDistance(root, fromIndex) scans only tail rows and keeps the rowCache alive', () => {
  const h = createHarness();
  h.sandbox.showChatProcess = true;
  h.sandbox.followLatestEnabled = false;
  vm.runInContext('setProcessWindowingDisabled(true)', h.sandbox);

  const old = h.makeAssistantEntries({ realH: 200, from: 0, to: 205 });
  vm.runInContext('applyProcessDistance(container)', h.sandbox); // landing → full pass
  const cacheBefore = vm.runInContext('_rowCache', h.sandbox);
  assert.ok(cacheBefore && cacheBefore.size === 205, 'landing builds the full rowCache');

  const baseline = old.map((e) => e.row._qsaCalls());

  // Append: assistant row with a pre-hidden call card (appendNewMessages
  // pre-hides fresh rows) plus a pre-hidden tool row.
  const appendedAssistant = makeRow({ role: 'assistant', realH: 200, msgId: 'msg-205' });
  const callCard = {
    classList: makeClassList(),
    style: { _props: {}, setProperty(k, v) { this._props[k] = String(v); }, removeProperty(k) { delete this._props[k]; } },
  };
  callCard.classList.add('tool-call-container');
  callCard.classList.add('process-hidden'); // append pre-hide
  appendedAssistant.row._processChildren = [callCard];
  h.addRow(appendedAssistant);
  const appendedTool = makeRow({ role: 'tool', realH: 600, msgId: 'msg-206' });
  appendedTool.row.classList.add('process-hidden'); // append pre-hide
  h.addRow(appendedTool);

  vm.runInContext('applyProcessDistance(container, 205)', h.sandbox);

  // Old rows untouched: no subtree queries, cache Map not rebuilt.
  old.forEach((e, i) => {
    assert.equal(e.row._qsaCalls(), baseline[i],
      `old assistant row ${i} must not be rescanned`);
  });
  const cacheAfter = vm.runInContext('_rowCache', h.sandbox);
  assert.equal(cacheAfter, cacheBefore, 'incremental append must reuse the same rowCache Map');
  assert.equal(cacheAfter.size, 206, 'appended assistant row joins the cache in place');

  // New rows revealed: pre-hidden elements visible again, cv state clear.
  assert.equal(appendedAssistant.row._processChildren[0].classList.contains('process-hidden'), false,
    'the pre-hidden call card must be revealed (fold-at-birth measurability)');
  assert.equal(appendedAssistant.row._processChildren[0].classList.contains('process-cv-hidden'), false,
    'full-render tier keeps appended process children out of cv-hidden');
  assert.equal(appendedTool.row.classList.contains('process-hidden'), false,
    'the pre-hidden tool row must be revealed');

  const cachedRows = vm.runInContext('_cachedRows', h.sandbox);
  assert.equal(cachedRows.length, 207, 'cached row list extends to the new tail');
});

test('applyProcessDistance(root, fromIndex) falls back to the full path after a DOM rebuild', () => {
  const h = createHarness();
  h.sandbox.showChatProcess = true;
  h.sandbox.followLatestEnabled = false;
  vm.runInContext('setProcessWindowingDisabled(true)', h.sandbox);

  h.makeAssistantEntries({ realH: 200, from: 0, to: 205 });
  vm.runInContext('applyProcessDistance(container)', h.sandbox);
  const cacheBefore = vm.runInContext('_rowCache', h.sandbox);

  // Simulate a full re-render: every row object replaced.
  h.container._entries = [];
  const rebuilt = [];
  for (let i = 0; i < 210; i++) {
    const e = makeRow({ role: 'assistant', realH: 200, msgId: `msg-r${i}` });
    const callCard = { classList: makeClassList(), style: { _props: {}, setProperty() {}, removeProperty() {} } };
    callCard.classList.add('tool-call-container');
    e.row._processChildren = [callCard];
    h.addRow(e);
    rebuilt.push(e);
  }
  h.container._markDirty();

  // A stale incremental call must detect the first-row mismatch and rerun
  // the full pass (new Map, correct coverage).
  vm.runInContext('applyProcessDistance(container, 205)', h.sandbox);

  const cacheAfter = vm.runInContext('_rowCache', h.sandbox);
  assert.notEqual(cacheAfter, cacheBefore, 'the guard must rebuild the cache after a DOM swap');
  assert.equal(cacheAfter.size, 210, 'the full pass covers every rebuilt row');
});

test('appendNewMessages forwards the start index to the incremental process-state sync', () => {
  const h = createHarness();
  h.sandbox.showChatProcess = true;
  h.sandbox.followLatestEnabled = false;
  h.addRow(makeRow({ role: 'user', realH: 80, msgId: 'msg-0' }));

  const stubQueue = [];
  const inserted = [];
  h.container.insertAdjacentHTML = () => { inserted.push(stubQueue.shift() || null); };
  Object.defineProperty(h.container, 'lastElementChild', {
    configurable: true,
    get: () => inserted[inserted.length - 1] || null,
  });
  const toolStub = makeRow({ role: 'tool', realH: 600, msgId: 'msg-2' });
  toolStub.row.matches = () => true;
  stubQueue.push(toolStub.row);

  h.sandbox.currentMessages = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'Grep', arguments: { q: 'x' } }] },
    { role: 'tool', toolCallId: 'c1', content: '{"ok":true}' },
  ];

  vm.runInContext(`
    var __calls = [];
    applyConversationProcessState = function (root, fromIndex) { __calls.push(fromIndex); };
    applyCollapseLogic = function () {};
    updateRollbackActionVisibility = function () {};
    updateFollowLatestButton = function () {};
    enhanceMarkdownTables = function () {};
  `, h.sandbox);
  vm.runInContext('appendNewMessages([currentMessages[2]], 2)', h.sandbox);

  const calls = [...vm.runInContext('__calls', h.sandbox)];
  assert.deepEqual(calls, [2],
    'appendNewMessages must pass the message start index so the process sync runs incrementally');
  assert.equal(toolStub.row.classList.contains('process-hidden'), true,
    'the append pre-hide itself must stay (display:none before any layout)');
});
