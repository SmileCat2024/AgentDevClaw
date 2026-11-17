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
 * 装载路线（P4 T2）：chat-viewport / chat-renderer 已迁 ESM，改真实 import；
 * （沙箱内按 index.html 真实加载序执行：action-dispatcher → i18n → app-core →
 * chat-viewport → input-helpers → chat-renderer，顶层函数即生产入口）；
 * lazy-tool-content 已迁 ESM，经 withP2EsmCase 的 `c.load` 真实 import——七个
 * 窗口函数既是命名导出，也经生产兼容桥 p2-w2-1-chat-windowing-host 暴露给
 * classic 消费方。滚动链走真实的 container 'scroll' 监听 + rAF/scroll-stop
 * 计时器（不再直接调用私有 _onScrollForWindowing / _applyWindow）；冻结状态的
 * 写入一律走公开 freezeProcessWindowing / unfreezeProcessWindowing，仅用
 * processWindowingMode.frozen 读回释放后的状态（该字段无公开 getter）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { prepareClassicSandbox } from './p2-classic-hosts.js';

const LAZY_TOOL_CONTENT = 'public/src/modules/lazy-tool-content.js';
const WINDOWING_MODE = 'public/src/modules/p2-w2-1-process-windowing-mode.js';

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
    // 真实元素面：markdown 表格增强会给 wrap 挂 scroll 监听。
    addEventListener() {},
    removeEventListener() {},
  };
  row.classList.add(role);

  const content = {
    id: msgId,
    scrollHeight: realH,
    classList: makeClassList(),
    style: {},
    // Real DOM: .message-content always has children (the process children
    // live inside it). Map to this harness's row._processChildren convention
    // so syncAssistantProcessOnlyRows sees the same shape as a browser.
    get children() { return row._processChildren || []; },
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
    _scrollWrites: [],
    _listeners: new Map(),
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
  container.addEventListener = (type, listener) => {
    if (!container._listeners.has(type)) container._listeners.set(type, []);
    container._listeners.get(type).push(listener);
  };
  container.removeEventListener = (type, listener) => {
    const list = container._listeners.get(type);
    if (!list) return;
    const i = list.indexOf(listener);
    if (i >= 0) list.splice(i, 1);
  };

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
    container, document, layout, fakeTimers,
    addRow(entry) {
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
    },
    fireScroll() {
      for (const listener of (container._listeners.get('scroll') || []).slice()) {
        listener({ target: container });
      }
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
    makeToolEntries({ toolName, realH, from, to }) {
      const out = [];
      for (let i = from; i < to; i++) {
        const e = makeRow({ role: 'tool', realH, toolName, msgId: `msg-${container._entries.length}` });
        out.push(this.addRow(e));
      }
      return out;
    },
    viewportTopEntry() {
      layout();
      const st = container.scrollTop;
      return container._entries.find((e) => {
        const rec = container._layout().tops.get(e.row);
        return rec && rec.top + rec.h > st && !e.row.classList.contains('process-hidden');
      }) || null;
    },
    totalHeight() { return container.scrollHeight; },
  };
}

async function withHarness(fn) {
  const rig = createRig();
  const globals = {
    document: rig.document,
    // markdown-bootstrap 装载期需要 vendor 的 marked（renderer 由它自建）。
    marked: { Renderer: class { constructor() {} }, setOptions() {}, parse: (value) => String(value ?? '') },
    // input-actions 已 import 真实 poll 模块（poll-coordinator-host）：按生产
    // 宿主 seam 提供最小面，本文件不驱动轮询、不再保留 window.poll 桩。
    createPollCoordinatorHost: () => ({
      run: () => Promise.resolve(),
      fastInterval: () => 2000,
      setTimeout: (callback, delay) => setTimeout(callback, delay),
      clearTimeout: (id) => clearTimeout(id),
    }),
    isChatSurfaceActive: () => true,
    shouldRenderWorkspaceSurface: () => false,
    // 以下是仍需晚绑定的 classic 宿主函数；渲染依赖（markdown-utils /
    // template-engine / message-timeline / tool-progress）已由 chat-renderer 静态
    // import，夹具不再为它们留桩。
    escapeHtml: (v) => String(v ?? ''),
    t: (k) => k,
    switchAgent() {},
    ensureChatRuntimeIndicator() {},
    getEmptyStateHtml: () => '<div class="empty-state">empty</div>',
    renderCurrentMainView() {},
    getCurrentHostAgentRecord: () => null,
  };
  return withP2EsmCase({
    classic: (sandbox) => {
      // chat-renderer 的 import 链触达整条装载期宿主工厂链：按生产先行脚本序整链
      // 装载（boot 体与周期排程由基座关掉），再补 markdown-bootstrap
      // （markdown-utils 求值期捕获 escapeHtml / renderer / marked）。
      prepareClassicSandbox(sandbox);
      sandbox.loadSource('public/src/modules/markdown-bootstrap.js');
      // 夹具的确定性计时器 / rAF 必须晚于基座落位（基座会关闭 rAF 与周期排程）。
      Object.assign(sandbox, rig.fakeTimers);
    },
    globals,
  }, async (c) => {
    // 视口域先装载（桥键 + container 监听先就位），随后是渲染域。
    await c.load('public/src/modules/chat-viewport.js');
    const renderer = await c.load('public/src/modules/chat-renderer.js');
    // input-helpers 已迁 ESM（P4 T2）：真实 import 装载，桥键由模块自身注册。
    await c.load('public/src/modules/input-helpers.js');
    const surface = c.window.createP2BootstrapChatSurfaceHost();
    surface.showChatProcess = true;
    surface.followLatestEnabled = false;
    c.window.currentMessages = [];
    c.window.allAgents = [];
    c.window.toolRenderConfigs = {};
    c.window.currentInputRequests = [];
    c.window._lastRenderedChatSig = '';
    await c.load('public/src/modules/p2-w2-1-chat-windowing-host.js');
    // 输入面域（本批迁 ESM）：回退按钮可见性与过程显隐的真实实现
    await c.load('public/src/modules/input-actions.js');
    await c.load('public/src/modules/chat-process-visibility.js');
    const mod = await c.load(LAZY_TOOL_CONTENT);
    const mode = (await c.load(WINDOWING_MODE)).processWindowingMode;
    return fn(Object.assign(rig, {
      c, surface, mode,
      renderer,
      read: (expression) => c.read(expression),
      showChatProcess: (value) => { surface.showChatProcess = value; },
      followLatest: (value) => { surface.followLatestEnabled = value; },
      setWindowingDisabled: (value) => mod.setProcessWindowingDisabled(value),
      apply: (fromIndex) => mod.applyProcessDistance(rig.container, fromIndex),
      freeze: () => mod.freezeProcessWindowing(),
      unfreeze: () => mod.unfreezeProcessWindowing(),
      sendScroll(target) {
        if (target !== undefined) rig.container.scrollTop = target;
        rig.fireScroll();
      },
    }));
  });
}

test('landing: the show-mode landing sequence folds visible tool rows before the first paint', async () => {
  await withHarness((h) => {
    h.showChatProcess(true);
    h.followLatest(true);

    for (let i = 0; i < 40; i++) {
      h.addRow(makeRow({ role: 'tool', realH: 600, toolName: 'Read', msgId: `msg-${i}` }));
    }

    // This is the exact sequence render() runs for a fresh show-mode render
    // (innerHTML rebuild → clearProcessDistance → applyConversationProcessState
    // → follow lock → landing scan). All of it is synchronous — no timer or
    // rAF may fire before the first paint.
    h.read(`
      clearProcessDistance(container);
      applyConversationProcessState(container);
      if (typeof lockChatViewportToBottomNow === 'function') lockChatViewportToBottomNow();
      if (typeof runLandingCollapseScan === 'function') runLandingCollapseScan();
    `);

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
});

test('process-toggle: first paint after toggling show-process in follow mode shows collapsed tool rows', async () => {
  await withHarness((h) => {
    h.showChatProcess(false);
    h.followLatest(true);

    // Mixed transcript: hide mode shows only the user rows (tool rows are
    // display:none), so the pre-toggle reading position sits at the bottom.
    for (let i = 0; i < 30; i++) {
      h.addRow(makeRow({ role: 'user', realH: 80, msgId: `msg-u${i}` }));
      h.addRow(makeRow({ role: 'tool', realH: 600, toolName: 'Read', msgId: `msg-${i}` }));
    }
    h.read('applyConversationProcessState(container)');
    h.container.scrollTop = h.container.scrollHeight;
    assert.ok(h.container.scrollTop > 0, 'hide-mode viewport parked at the bottom');

    // The user clicks "显示过程" — toggleChatProcessVisibility must reveal AND
    // fold the incoming viewport in the same task. The landing scan must scan
    // the post-lock bottom position, not the stale pre-toggle scrollTop:
    // with the stale position it folds the wrong rows and the viewport rows
    // stay expanded until the scroll-stop settle (~150ms later) folds them
    // with a visible jump.
    h.read('toggleChatProcessVisibility()');

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
});

test('windowing: revealing above-viewport rows compensates scrollTop so the content anchor stays put', async () => {
  await withHarness((h) => {
    h.showChatProcess(true);
    h.followLatest(false);

    // 600 tool rows of 600px each; landing reveals only the bottom window.
    for (let i = 0; i < 600; i++) {
      h.addRow(makeRow({ role: 'tool', realH: 600, toolName: 'Bash', msgId: `msg-${i}` }));
    }
    // 工具结果默认折叠后 Bash 行也会折叠。本用例隔离验证 reveal 占位→实测的
    // scrollTop 补偿，将行固定为用户展开（不参与折叠）；折叠+补偿的组合语义由
    // clamp-safe 用例（Read 行）与 scrollbar-drag 用例覆盖。
    h.read('for (var __i = 0; __i < 600; __i++) _userExpandedMsgs.add(__i)');
    h.apply();
    h.flushTimers();

    // Scroll up into a position where the next window slide reveals a batch of
    // never-realized rows (placeholder 150px vs real 600px).
    const jumpTo = Math.max(0, h.totalHeight() * 0.5);
    h.sendScroll(jumpTo);
    h.apply();
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
      h.sendScroll();
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
});

test('windowing: follow mode skips the reveal compensation (bottom-lock settlement owns the scroll)', async () => {
  await withHarness((h) => {
    h.showChatProcess(true);
    h.followLatest(true);

    for (let i = 0; i < 320; i++) {
      h.addRow(makeRow({ role: 'tool', realH: 600, toolName: 'Bash', msgId: `msg-${i}` }));
    }
    h.apply();
    h.flushTimers();
    const hiddenAtLanding = h.container._entries.filter((e) =>
      e.row.classList.contains('process-cv-hidden')).length;
    assert.ok(hiddenAtLanding > 0, 'landing window is a strict subset of the transcript');

    const writesBefore = h.container._scrollWrites.length;
    // Force a fresh window by a large upward jump: the scroll-stop settle
    // reruns windowing against the arrival viewport (large-delta release).
    h.sendScroll(0);
    h.pumpFrame(); // rAF stays silent (large-delta deferral)
    h.flushTimers(); // scroll-stop settle: fresh window + reveal + collapse

    // The reveal really happened (otherwise "no compensation" would be vacuous)…
    const hiddenAtArrival = h.container._entries.filter((e) =>
      e.row.classList.contains('process-cv-hidden')).length;
    assert.ok(hiddenAtArrival < hiddenAtLanding, 'the settle must slide the window to the arrival viewport');
    // …and follow mode still left every compensation write to the bottom-lock
    // settlement: reveal growth above the viewport produces no upward writes.
    const writes = h.container._scrollWrites.slice(writesBefore);
    const positiveWrites = writes.filter((w) => w.to > w.from);
    assert.equal(positiveWrites.length, 0, 'no upward compensation writes may happen in follow mode');
  });
});

test('scrollbar drag release: settle pins the release anchor so the reading frame does not jump', async () => {
  await withHarness((h) => {
    h.showChatProcess(true);
    h.followLatest(false);

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
    h.apply();
    h.container.scrollTop = h.container.scrollHeight;
    h.sendScroll();
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
      h.sendScroll();
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
    h.sendScroll(); // large delta → silent until release
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
});

// Fold compensation near the bottom of the document: when a fold shrinks
// scrollHeight past the current scrollTop, the browser clamps the read-back
// (scrollTop getter returns maxScroll). Compensation must base on the
// PRE-fold scrollTop, otherwise the clamp poisons the baseline and the
// visible content jumps — the "sticky wheel" jolt felt while scrolling up
// from the bottom of a long show-process transcript.
test('windowing: fold compensation is clamp-safe when the collapse crosses maxScroll', async () => {
  await withHarness((h) => {
    h.showChatProcess(true);
    h.followLatest(false);

    // Tool rows above, a short real tail below: the viewport parked at the
    // bottom sits just above the fold candidates, so the first fold's
    // shrinkage crosses maxScroll (the clamp boundary scenario).
    for (let i = 0; i < 200; i++) {
      h.addRow(makeRow({ role: 'tool', realH: 600, toolName: 'Read', msgId: `msg-t${i}` }));
    }
    for (let i = 0; i < 10; i++) {
      h.addRow(makeRow({ role: 'user', realH: 80, msgId: `msg-u${i}` }));
    }
    h.apply();
    h.flushTimers();
    h.container.scrollTop = h.container.scrollHeight;
    h.sendScroll();
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
    let measured = 0, joltFrames = 0, maxJolt = 0;
    for (let frame = 0; frame < 300; frame++) {
      if (h.container.scrollTop <= 0) break;
      h.container.scrollTop -= 53; // compositor wheel step
      h.sendScroll();
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
      measured++;
    }
    const folds = Number(h.read(
      '(function(){var n=0;var rows=container.querySelectorAll(".message-row");'
      + 'for(var i=0;i<rows.length;i++){if(rows[i].querySelector(".message-content")'
      + '&&rows[i].querySelector(".message-content").classList.contains("collapsed"))n++;}return n;})()'));

    assert.ok(measured > 0, 'should have measured frames');
    assert.ok(folds > 5, `compensation scenario requires folds to happen (got ${folds})`);
    assert.ok(h.container.scrollTop < h.totalHeight() * 0.95, 'should have scrolled upward');
    assert.equal(joltFrames, 0, 'fold compensation must keep the content anchor pixel-stable near the clamp boundary');
  });
});

test('panel drag: freezeProcessWindowing silences the scroll chain during the drag; unfreeze settles once', async () => {
  await withHarness((h) => {
    h.showChatProcess(true);
    h.followLatest(false);

    for (let i = 0; i < 300; i++) {
      h.addRow(makeRow({ role: 'user', realH: 80, msgId: `msg-u${i}` }));
      h.addRow(makeRow({ role: 'tool', realH: 600, toolName: 'Bash', msgId: `msg-${i}` }));
    }
    h.apply();

    // Park mid-document: the windowing window settles around this position so
    // the drag below has stub territory ahead (rows to reveal) — the geometry
    // where a live scroll chain would fight the drag anchor.
    h.container.scrollTop = Math.round(h.container.scrollHeight * 0.5);
    h.sendScroll();
    h.pumpFrame();
    h.flushTimers();

    // Drag starts: windowing frozen.
    h.freeze();

    // Drag frames: the panel-drag anchor writes scrollTop in small steps every
    // frame (well below the large-delta threshold — these would normally run
    // the rAF window update + reveal compensation mid-drag).
    const heightAtFreeze = h.container.scrollHeight;
    const cvStatesAtFreeze = h.container.querySelectorAll('.message-row')
      .map((r) => r.classList.contains('process-cv-hidden'));
    for (let e = 0; e < 6; e++) {
      h.container.scrollTop += 30;
      h.sendScroll();
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
    h.unfreeze();
    const rows = h.container.querySelectorAll('.message-row');
    const topIdx = rows.findIndex((r) => r.offsetTop + r.offsetHeight > h.container.scrollTop);
    const nearTool = rows.slice(topIdx, topIdx + 6).find((r) => r.classList.contains('tool'));
    assert.ok(nearTool && !nearTool.classList.contains('process-cv-hidden'),
      'unfreeze settle must reveal rows near the final viewport');

    // After unfreeze the normal chain serves scrolls again: a scrollbar-style
    // jump lands silently (large-delta deferral) and the 150ms settle reveals
    // the arrival viewport — the same semantics as a drag release.
    assert.equal(h.mode.frozen, false, 'unfreeze must clear the frozen flag');
    const farRow = rows.find((r) => r.classList.contains('tool')
      && r.classList.contains('process-cv-hidden')
      && r.offsetTop > h.container.scrollTop + 5000);
    assert.ok(farRow, 'need a far hidden tool row for the recovery check');
    h.sendScroll(farRow.offsetTop - 10); // single large jump
    h.pumpFrame(); // rAF stays silent (large-delta deferral)
    h.flushTimers(); // scroll-stop settle: fresh window + reveal + collapse
    assert.ok(!farRow.classList.contains('process-cv-hidden'),
      'post-unfreeze jump settle must reveal the arrival viewport (chain recovered)');
  });
});

test('tiering: full-render mode (setProcessWindowingDisabled) lays out every row and folds visible tools without reveal writes', async () => {
  await withHarness((h) => {
    h.showChatProcess(true);
    h.followLatest(true);

    // 600 tall Read rows: far beyond the window, well within a node budget.
    for (let i = 0; i < 600; i++) {
      h.addRow(makeRow({ role: 'tool', realH: 600, toolName: 'Read', msgId: `msg-${i}` }));
    }

    // render()'s landing sequence with the full-render tier active: the budget
    // check in render() calls setProcessWindowingDisabled BEFORE
    // clearProcessDistance, so the pre-hide must be skipped entirely.
    h.read(`
      setProcessWindowingDisabled(true);
      clearProcessDistance(container);
      applyConversationProcessState(container);
      if (typeof lockChatViewportToBottomNow === 'function') lockChatViewportToBottomNow();
      if (typeof runLandingCollapseScan === 'function') runLandingCollapseScan();
    `);

    // Full-render contract: every row stays laid out — no cv-hidden, no
    // process-hidden, anywhere.
    for (const e of h.container._entries) {
      assert.equal(e.row.classList.contains('process-cv-hidden'), false,
        'full-render tier must not cv-hide rows');
      assert.equal(e.row.classList.contains('process-hidden'), false,
        'full-render tier must not pre-hide rows');
    }

    // Landing fold still collapses the visible tool rows before first paint.
    const visibleEntries = h.container._entries.filter((e) => {
      const rec = h.layout().tops.get(e.row);
      return rec && !e.row.classList.contains('process-hidden')
        && rec.top < h.container.scrollTop + VIEW_H && rec.top + rec.h > h.container.scrollTop;
    });
    assert.ok(visibleEntries.length > 0, 'viewport should have visible rows');
    const expandedTools = visibleEntries.filter((e) =>
      e.row.role === 'tool' && !e.content.classList.contains('collapsed'));
    assert.equal(expandedTools.length, 0, 'no expanded tool row may be visible at first paint');

    // Far-jump upward (large delta). Nothing may reveal and nothing may
    // compensate scrollTop: with every row already laid out there is no
    // placeholder-to-real snap, so the wheel position must survive the settle.
    h.sendScroll(0);
    h.pumpFrame(); // rAF stays silent (large-delta deferral)
    h.flushTimers(); // scroll-stop settle
    assert.equal(h.container.scrollTop, 0,
      'full-render settle must not move scrollTop (nothing to reveal or compensate)');
    let hiddenCount = 0;
    for (const e of h.container._entries) {
      if (e.row.classList.contains('process-cv-hidden')) hiddenCount++;
    }
    assert.equal(hiddenCount, 0, 'no row may become cv-hidden while the tier is active');

    // Re-enabling the virtualization tier (next render above budget) must
    // re-grade: the next render's applyProcessDistance puts far rows back to
    // cv-hidden.
    h.setWindowingDisabled(false);
    h.apply();
    let rehidden = 0;
    for (const e of h.container._entries) {
      if (e.row.classList.contains('process-cv-hidden')) rehidden++;
    }
    assert.ok(rehidden > 0, 're-enabling windowing must cv-hide far rows again');
  });
});

// Streaming append contract: new tail rows arrive pre-hid (process-hidden,
// display:none — scrollHeight unreadable), so the fold-at-birth scan can only
// measure them AFTER applyConversationProcessState has revealed them. In the
// full-render tier every post-landing collapse scan is skipped by design
// ("new streaming rows settle via the append path"), so appends that run the
// collapse scan while the rows are still hidden leave long tool blocks
// expanded forever — until the user toggles hide/show process, whose landing
// settle folds them. The pair of tests below pins the fixed append sequence.
function makeCallCard({ contentH, id }) {
  const card = { classList: makeClassList(), _bar: null };
  const content = { id, scrollHeight: contentH, classList: makeClassList() };
  card.querySelector = (sel) => {
    if (sel === '.tool-content') return content;
    if (sel === '.tool-call-toggle-bar') return card._bar;
    return null;
  };
  card.appendChild = (child) => {
    if (child && child._isToggleBar) card._bar = child;
    return child;
  };
  return { card, content };
}

test('streaming append: new tool rows and card-bearing assistant rows fold at birth in the full-render tier', async () => {
  await withHarness((h) => {
    h.showChatProcess(true);
    h.followLatest(true);

    // Landing on a settled transcript in the full-render tier (windowing
    // disabled — the tier regular sessions run in).
    for (let i = 0; i < 10; i++) {
      h.addRow(makeRow({ role: 'user', realH: 80, msgId: `msg-u${i}` }));
      h.addRow(makeRow({ role: 'tool', realH: 600, toolName: 'Read', msgId: `msg-t${i}` }));
    }
    h.read(`
      setProcessWindowingDisabled(true);
      clearProcessDistance(container);
      applyConversationProcessState(container);
      if (typeof lockChatViewportToBottomNow === 'function') lockChatViewportToBottomNow();
      if (typeof runLandingCollapseScan === 'function') runLandingCollapseScan();
    `);
    assert.ok(
      h.container._entries.some((e) => e.content.classList.contains('collapsed')),
      'landing must fold the long tool rows');

    // A tool call arrives mid-stream: an assistant row carrying a long call
    // card, then a long tool result row. appendNewMessages pre-hides both
    // process elements before any layout. The row height includes the card —
    // folding is row-level (toggle outside the block), cards never fold alone.
    const startIndex = h.container._entries.length;
    const callCard = makeCallCard({ contentH: 600, id: `tcallc-msg-${startIndex}-0` });
    const assistantEntry = h.addRow(makeRow({ role: 'assistant', realH: 660, msgId: `msg-${startIndex}` }));
    assistantEntry.row._processChildren = [callCard.card];
    const origRowQsa = assistantEntry.row.querySelectorAll;
    assistantEntry.row.querySelectorAll = (sel) =>
      sel === '.tool-call-container'
        ? assistantEntry.row._processChildren
        : origRowQsa(sel);
    const origRowQs = assistantEntry.row.querySelector;
    assistantEntry.row.querySelector = (sel) =>
      sel === '.tool-call-container'
        ? assistantEntry.row._processChildren[0] || null
        : origRowQs(sel);
    const toolEntry = h.addRow(makeRow({ role: 'tool', realH: 600, toolName: 'Grep', msgId: `msg-${startIndex + 1}` }));

    // The exact pre-hide appendNewMessages applies to freshly inserted rows.
    assistantEntry.row._processChildren.forEach((c) => c.classList.add('process-hidden'));
    toolEntry.row.classList.add('process-hidden');

    // applyProcessDistance reveals assistant process children through this
    // combined selector; route it to the real children so the reveal behaves
    // like the browser DOM.
    const origContainerQsa = h.container.querySelectorAll;
    h.container.querySelectorAll = (sel) => {
      if (sel === '.reasoning-block.process-hidden, .tool-call-container.process-hidden') {
        const out = [];
        for (const e of h.container._entries) {
          for (const c of (e.row._processChildren || [])) {
            if (c.classList.contains('process-hidden')) out.push(c);
          }
        }
        return out;
      }
      return origContainerQsa(sel);
    };

    // appendNewMessages' post-fix sequence: reveal first, fold at birth second.
    // The harness createElement stub does not flag toggle bars, so record the
    // row-level bar via appendChild to assert the single outside control.
    const appendedBars = [];
    const origRowAppend = assistantEntry.row.appendChild;
    assistantEntry.row.appendChild = (child) => {
      if (child && String(child.className || '').includes('expand-toggle-bar')) appendedBars.push(child);
      return origRowAppend(child);
    };
    h.read('applyConversationProcessState(container);');
    // applyCollapseLogic 未上桥（生产只经 appendNewMessages 内部调用）——用例直接
    // 用命名导出，避免依赖不存在的 window 面。
    h.renderer.applyCollapseLogic(h.container, startIndex);

    assert.equal(toolEntry.content.classList.contains('collapsed'), true,
      'new long tool result row must fold at birth');
    assert.equal(assistantEntry.content.classList.contains('collapsed'), true,
      'tall card-bearing assistant row must fold at birth (row-level control)');
    assert.equal(callCard.content.classList.contains('collapsed'), false,
      'call cards no longer carry their own collapsed state');
    assert.ok(appendedBars.length > 0,
      'the single toggle is the row-level bar outside the block');
    assert.equal(toolEntry.row.classList.contains('process-hidden'), false,
      'the fold must have happened on revealed (measurable) rows');
  });
});

test('appendNewMessages runs the process-state reveal before the fold-at-birth scan', async () => {
  await withHarness((h) => {
    h.showChatProcess(true);
    h.followLatest(false);
    h.addRow(makeRow({ role: 'user', realH: 80, msgId: 'msg-0' }));

    // Minimal append bridge: appendNewMessages inserts HTML via
    // insertAdjacentHTML and pre-hides via lastElementChild. Back both with a
    // pre-made row stub (order recording only — semantics live in the test above).
    const stubQueue = [];
    const inserted = [];
    h.container.insertAdjacentHTML = () => {
      const row = stubQueue.shift() || null;
      // 真实 append 会把新行挂进容器：登记到 entries，折叠/过程扫描才能看见它。
      if (row) h.container._entries.push({ row });
      inserted.push(row);
    };
    Object.defineProperty(h.container, 'lastElementChild', {
      configurable: true,
      get: () => inserted[inserted.length - 1] || null,
    });
    const toolStub = makeRow({ role: 'tool', realH: 600, toolName: 'Grep', msgId: 'msg-2' });
    toolStub.row.matches = () => true; // '.message-row.tool, .message-row.system'
    stubQueue.push(toolStub.row);

    h.c.window.currentMessages = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'Grep', arguments: { q: 'x' } }] },
      { role: 'tool', toolCallId: 'c1', content: '{"ok":true}' },
    ];

    // 契约：折叠出生扫描必须在过程可见性揭示之后执行——否则新行仍是
    // display:none（scrollHeight=0 不可测），长工具行永远不会在出生时折叠。
    // 迁 ESM 后 applyConversationProcessState / applyCollapseLogic 都是模块内部
    // 导入，无法再用 window 同名包装记录调用顺序，改为断言可观测结果：
    // 追加后新工具行处于 collapsed（折叠成立即证明扫描发生在揭示之后）。
    h.read('appendNewMessages([currentMessages[2]], 2)');

    assert.equal(toolStub.content.classList.contains('collapsed'), true,
      'fold-at-birth runs after the reveal: the appended long tool row is collapsed');
    // show 模式下 reveal 会摘掉 append 时的预隐藏（预隐藏本身的语义由 hide 模式
    // 用例钉住；这里断言 reveal 确实发生在新行上）。
    assert.equal(toolStub.row.classList.contains('process-hidden'), false,
      'show process: the reveal clears the append-time pre-hide on the new row');
  });
});
