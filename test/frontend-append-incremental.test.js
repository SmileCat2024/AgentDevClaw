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
 * 装载路线（P2）：lazy-tool-content / chat-row-visibility 已迁 ESM，经
 * withP2EsmCase 的 `c.load` 真实 import（refreshMeasuredChatRows /
 * applyProcessDistance / setProcessWindowingDisabled 就是生产入口）；
 * classic 侧按 index.html 真实加载序跑 action-dispatcher → i18n → app-core →
 * chat-viewport → input-helpers → chat-renderer，两个 ESM 域的 classic 消费面
 * 由生产兼容桥 p2-w2-1-chat-windowing-host 提供。原用例对 `_rowCache` /
 * `_cachedRows` 的内部身份断言改写为同一语义的公开观测：旧行零重扫 = 缓存
 * 复用，DOM 重建后每行重扫 = 全量回退。
 *
 * 可接受边界（审核 #4）：缓存身份是模块私有，公开面只能观测「旧行是否被
 * 重扫」。这个双层 gate（增量路径复用缓存 / 全量路径因其他原因提前返回）无法
 * 区分「缓存确实复用」与「增量分支错误地零工作量返回」这类内部回归；补齐它
 * 需要为测试新增私有导出/内省面，因此有意不做。本文件改为同时钉住可观测的
 * 窗口结果（新旧行 cv 状态、第二次增量调用仍零重扫、回退结果与干净全量 pass
 * 逐行一致），内部短路类回归由这些结果间接兜住。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withP2EsmCase } from './helpers/p2-esm-case.js';

const LAZY_TOOL_CONTENT = 'public/src/modules/lazy-tool-content.js';
const ROW_VISIBILITY = 'public/src/modules/chat-row-visibility.js';
const WINDOWING_HOST = 'public/src/modules/p2-w2-1-chat-windowing-host.js';

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

function createRig() {
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

  const elements = new Map();
  const elementStub = (id) => ({
    id, innerHTML: '', textContent: '', style: {},
    classList: makeClassList(), dataset: {},
    clientHeight: 0, clientWidth: 0, scrollHeight: 0, scrollTop: 0, parentElement: null,
    addEventListener() {}, removeEventListener() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0 }; },
  });
  // app-core 的 container 引用 = document.getElementById('chat-container')。
  const document = {
    activeElement: null,
    readyState: 'complete',
    getElementById(id) {
      if (id === 'chat-container') return container;
      if (!elements.has(id)) elements.set(id, elementStub(id));
      return elements.get(id);
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    createElement: () => elementStub('created'),
    createTextNode: (text) => ({ textContent: text }),
    addEventListener() {}, removeEventListener() {},
    body: elementStub('body'), head: elementStub('head'), documentElement: elementStub('html'),
  };

  const fakeTimers = {
    setTimeout(callback) { const id = seq++; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
    setInterval(callback) { const id = seq++; timers.set(id, callback); return id; },
    clearInterval(id) { timers.delete(id); },
    requestAnimationFrame(callback) { const id = seq++; rafCallbacks.set(id, callback); rafOrder.push(id); return id; },
    cancelAnimationFrame(id) { rafCallbacks.delete(id); const i = rafOrder.indexOf(id); if (i >= 0) rafOrder.splice(i, 1); },
  };

  return {
    container, document, fakeTimers,
    addRow(entry) {
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
    },
    flushTimers() {
      const pending = [...timers.values()];
      timers.clear();
      pending.forEach((cb) => cb());
    },
    pumpFrame() {
      const ids = rafOrder.splice(0);
      ids.forEach((id) => {
        const cb = rafCallbacks.get(id);
        rafCallbacks.delete(id);
        if (cb) cb();
      });
    },
    makeToolEntries({ realH = 600, from, to }) {
      const out = [];
      for (let i = from; i < to; i++) {
        out.push(this.addRow(makeRow({ role: 'tool', realH, msgId: `msg-${i}` })));
      }
      return out;
    },
    makeAssistantEntries({ realH = 200, from, to }) {
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
        out.push(this.addRow(e));
      }
      return out;
    },
  };
}

/** classic 真实 bootstrap + ESM 真实 import 的一次用例环境。 */
async function withHarness(options, fn) {
  const rig = createRig();
  // currentMessages 的唯一真源是 app-core 装载期注册的桥键；会话视图读取面
  // 必须在装载后绑定到同一 owner（不能读一份初始数组的副本）。
  const live = { readMessages: () => [] };
  const globals = {
    document: rig.document,
    // input-actions 已 import 真实 poll 模块（poll-coordinator-host）：按生产
    // 宿主 seam 提供最小面，本文件不驱动轮询、不再保留 window.poll 桩。
    createPollCoordinatorHost: () => ({
      run: () => Promise.resolve(),
      fastInterval: () => 2000,
      setTimeout: (callback, delay) => setTimeout(callback, delay),
      clearTimeout: (id) => clearTimeout(id),
    }),
    CSS: { supports: () => true }, // chat-row-visibility 能力探测
    isChatSurfaceActive: () => true,
    shouldRenderWorkspaceSurface: () => false,
    escapeHtml: (v) => String(v ?? ''),
    t: (k) => k,
    renderMarkdown: (s) => '<p>' + String(s).slice(0, 20) + '</p>',
    parseToolResult: (content) => ({ success: true, data: content }),
    renderJsonHighlight: (d) => '<pre>' + String(d).slice(0, 20) + '</pre>',
    applyTemplate: () => '<div>args</div>',
    enhanceMathInElement() {},
    enhanceMarkdownTables() {},
    clearTruncatedHighlightData() {},
    getToolDisplayName: (n) => n || 'Tool',
    getToolRenderTemplate: () => ({}),
    resolveToolProgressForCall: () => null,
    requestRollbackEdit() {},
    switchAgent() {},
    ensureChatRuntimeIndicator() {},
    getEmptyStateHtml: () => '<div class="empty-state">empty</div>',
    renderCurrentMainView() {},
    getCurrentHostAgentRecord: () => null,
    readCurrentSessionViewState: () => ({ messages: live.readMessages(), inputRequests: [] }),
    prependTimeSeparatorHtml: (_messages, _index, rowHtml) => rowHtml,
  };
  return withP2EsmCase({
    classic: (sandbox) => {
      Object.assign(sandbox, rig.fakeTimers);
      // index.html 真实加载序：分发器先于一切声明 data-action 的模块装载，
      // 随后 i18n、app-core，最后是各业务 classic 模块。
      sandbox.loadSource('public/src/modules/action-dispatcher.js');
      // i18n 已迁 ESM（P4）：t 桥键由 createFrontendSandbox 自动装载，见 test/helpers/install-i18n.js
      sandbox.loadSource('public/src/app-core.js');
      sandbox.loadSource('public/src/modules/chat-viewport.js');
      sandbox.loadSource('public/src/modules/input-helpers.js');
      // 会话视图同步实现：input-actions 的 token/提交策略经宿主要求它（生产加载序）
      sandbox.loadSource('public/src/modules/session-view-state.js');
      sandbox.loadSource('public/src/modules/chat-renderer.js');
    },
    globals,
  }, async (c) => {
    const surface = c.window.createP2BootstrapChatSurfaceHost();
    surface.showChatProcess = true;
    surface.followLatestEnabled = false;
    // app-core 装载期注册的桥键 / 会话视图状态（初始值不是用例现场值）。
    c.window.currentMessages = options?.messages || [];
    live.readMessages = () => c.window.currentMessages;
    c.window.allAgents = [];
    c.window.toolRenderConfigs = {};
    c.window.currentInputRequests = [];
    c.window._lastRenderedChatSig = '';
    // 生产兼容桥 + ESM 域（窗口函数与整行实测窗口）。
    await c.load(WINDOWING_HOST);
    // 输入面域（本批迁 ESM）：回退按钮可见性与过程显隐的真实实现
    await c.load('public/src/modules/input-actions.js');
    await c.load('public/src/modules/chat-process-visibility.js');
    const mod = await c.load(LAZY_TOOL_CONTENT);
    const rowVisibility = await c.load(ROW_VISIBILITY);
    mod.setProcessWindowingDisabled(true);
    return fn(Object.assign(rig, {
      c,
      refresh: (reason) => rowVisibility.refreshMeasuredChatRows(reason),
      apply: (fromIndex) => mod.applyProcessDistance(rig.container, fromIndex),
      setCurrentMessages: (messages) => { c.window.currentMessages = messages; },
    }));
  });
}

test('refreshMeasuredChatRows(append) measures only appended rows', async () => {
  await withHarness({}, (h) => {
    const old = h.makeToolEntries({ realH: 600, from: 0, to: 205 });
    h.refresh('render-full');

    const baseline = old.map((e) => e._topReads || 0);
    const hiddenBefore = old.map((e) => e.row.classList.contains('chat-row-distant'));

    const fresh = h.makeToolEntries({ realH: 600, from: 205, to: 210 });
    h.refresh('append');
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
});

test('refreshMeasuredChatRows(append) matches the full rebuild row-for-row', async () => {
  const inc = await withHarness({}, (h) => {
    h.makeToolEntries({ realH: 600, from: 0, to: 205 });
    h.refresh('render-full');
    h.makeToolEntries({ realH: 600, from: 205, to: 210 });
    h.refresh('append');
    h.flushTimers(); h.pumpFrame(); h.flushTimers();
    return h.container._entries.map((e) => e.row.classList.contains('chat-row-distant'));
  });
  const full = await withHarness({}, (h) => {
    h.makeToolEntries({ realH: 600, from: 0, to: 205 });
    h.refresh('render-full');
    h.makeToolEntries({ realH: 600, from: 205, to: 210 });
    h.refresh('force-full'); // non-whitelisted → full path
    h.flushTimers(); h.pumpFrame(); h.flushTimers();
    return h.container._entries.map((e) => e.row.classList.contains('chat-row-distant'));
  });
  inc.forEach((hidden, i) => {
    assert.equal(hidden, full[i],
      `row ${i} window state diverged between incremental and full refresh`);
  });
});

test('refreshMeasuredChatRows(patch-last) re-measures only the tail row', async () => {
  await withHarness({}, (h) => {
    const rows = h.makeToolEntries({ realH: 600, from: 0, to: 205 });
    h.refresh('render-full');

    const baseline = rows.map((e) => e._topReads || 0);
    // Tail patch: content grows (realH 600 → 900), layout invalidated.
    const tail = rows[rows.length - 1];
    tail.row.realH = 900;
    h.container._markDirty();

    h.refresh('patch-last');
    h.flushTimers(); h.pumpFrame(); h.flushTimers();

    rows.slice(0, -1).forEach((e, i) => {
      assert.equal(e._topReads || 0, baseline[i],
        `non-tail row ${i} must not be re-measured by patch-last`);
    });
    assert.ok((tail._topReads || 0) > baseline[baseline.length - 1],
      'the patched tail row must be re-measured');
  });
});

test('applyProcessDistance(root, fromIndex) scans only tail rows and keeps the row cache alive', async () => {
  await withHarness({}, (h) => {
    const old = h.makeAssistantEntries({ realH: 200, from: 0, to: 205 });
    h.apply(); // landing → full pass
    const landedScans = old.map((e) => e.row._qsaCalls());
    assert.ok(landedScans.every((n) => n >= 1), 'landing builds the full row cache');

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

    h.apply(205);

    // Old rows untouched: no subtree queries (the cached Map is reused
    // instead of being rebuilt by a full pass).
    old.forEach((e, i) => {
      assert.equal(e.row._qsaCalls(), baseline[i],
        `old assistant row ${i} must not be rescanned`);
    });

    // New rows revealed: pre-hidden elements visible again, cv state clear.
    assert.equal(appendedAssistant.row._processChildren[0].classList.contains('process-hidden'), false,
      'the pre-hidden call card must be revealed (fold-at-birth measurability)');
    assert.equal(appendedAssistant.row._processChildren[0].classList.contains('process-cv-hidden'), false,
      'full-render tier keeps appended process children out of cv-hidden');
    assert.equal(appendedTool.row.classList.contains('process-hidden'), false,
      'the pre-hidden tool row must be revealed');

    // The cache still describes the extended tail: another incremental patch
    // from the new tail index reuses it (old rows stay unscanned).
    h.apply(206);
    old.forEach((e, i) => {
      assert.equal(e.row._qsaCalls(), baseline[i],
        `old assistant row ${i} must stay cached after a second incremental patch`);
    });
    assert.equal(appendedAssistant.row._qsaCalls(), 1,
      'the appended assistant row is scanned exactly once by its own incremental pass');
  });
});

test('applyProcessDistance(root, fromIndex) falls back to the full path after a DOM rebuild', async () => {
  const staleStates = await withHarness({}, (h) => {
    h.makeAssistantEntries({ realH: 200, from: 0, to: 205 });
    h.apply();

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
    // the full pass (every rebuilt row scanned).
    h.apply(205);
    rebuilt.forEach((e, i) => {
      assert.ok(e.row._qsaCalls() >= 1, `rebuilt row ${i} must be covered by the fallback full pass`);
    });
    return h.container._entries.map((e) => e.row.classList.contains('process-cv-hidden'));
  });

  // The fallback result must equal a clean full pass over the same DOM shape.
  const cleanStates = await withHarness({}, (h) => {
    for (let i = 0; i < 210; i++) {
      const e = makeRow({ role: 'assistant', realH: 200, msgId: `msg-r${i}` });
      const callCard = { classList: makeClassList(), style: { _props: {}, setProperty() {}, removeProperty() {} } };
      callCard.classList.add('tool-call-container');
      e.row._processChildren = [callCard];
      h.addRow(e);
    }
    h.container._markDirty();
    h.apply();
    return h.container._entries.map((e) => e.row.classList.contains('process-cv-hidden'));
  });
  assert.deepEqual(staleStates, cleanStates,
    'the stale-incremental fallback must produce the same window as a clean full pass');
});

test('appendNewMessages forwards the DOM row start to the incremental process-state sync', async () => {
  await withHarness({}, (h) => {
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

    h.setCurrentMessages([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'Grep', arguments: { q: 'x' } }] },
      { role: 'tool', toolCallId: 'c1', content: '{"ok":true}' },
    ]);

    // 生产装配点：appendNewMessages 的增量过程同步是 classic 全局调用，
    // 这里用同名全局包装记录它收到的 DOM 行起点（原用例同样做法）。
    const processCalls = [];
    h.c.window.applyConversationProcessState = (root, fromIndex) => { processCalls.push(fromIndex); };
    h.c.window.applyCollapseLogic = () => {};
    h.c.window.updateRollbackActionVisibility = () => {};
    h.c.window.updateFollowLatestButton = () => {};
    h.c.window.enhanceMarkdownTables = () => {};

    h.c.read('appendNewMessages([currentMessages[2]], 2)');

    assert.deepEqual(processCalls, [1],
      'process sync starts after the existing DOM rows, independently of the message start index');
    assert.equal(toolStub.row.classList.contains('process-hidden'), true,
      'the append pre-hide itself must stay (display:none before any layout)');
  });
});
