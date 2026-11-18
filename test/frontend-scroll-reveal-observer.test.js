/**
 * Scroll-path cost contract tests for the chat viewport reveal loop.
 *
 * Mechanism under test (public/src/modules/chat-viewport.js +
 * chat-row-visibility.js, Claw pipeline 14200):
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
 * 装载路线（P4 T2 批次）：chat-viewport 已迁 ESM，经 withP2EsmCase 的 `c.load`
 * 真实 import（其桥键供 classic 侧晚绑定）；
 * chat-row-visibility 已迁 ESM，经 withP2EsmCase 的 `c.load` 真实 import。
 * chat-viewport 对 refreshMeasuredChatRows 的调用走生产兼容桥
 * （p2-w2-1-chat-windowing-host 注册的 KernelState 访问器）：测试对它的
 * 计量包装是往桥键写入 wrapper（桥的 setter 转发语义），classic 消费方读到的
 * 就是 wrapper —— 与浏览器里同一路径，不改任何源码。
 *
 * Fake-DOM notes: the harness models row effective height as
 *   hidden(class chat-row-distant + css var) ? placeholder : realHeight
 * with lazily accumulated offsetTop (counted per read). ResizeObserver is
 * stubbed with browser semantics: dispatch only when an observed target's
 * box height changed since the last dispatch.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { APP_CORE_DOMAIN, prepareEsmModules } from './p2-classic-hosts.js';

const WINDOWING_HOST = 'public/src/modules/p2-w2-1-chat-windowing-host.js';
const ROW_VISIBILITY = 'public/src/modules/chat-row-visibility.js';
const LAZY_TOOL_CONTENT = 'public/src/modules/lazy-tool-content.js';

function makeClassList(initial = []) {
  const set = new Set(initial);
  return {
    add: (...cs) => cs.forEach(c => set.add(c)),
    remove: (...cs) => cs.forEach(c => set.delete(c)),
    toggle(c, force) {
      const next = force === undefined ? !set.has(c) : force;
      if (next) set.add(c); else set.delete(c);
      return next;
    },
    contains: c => set.has(c),
  };
}

const harnessState = { offsetTopReads: 0, rectReads: 0, selectorCalls: 0 };

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

function createBenchRig({ rows = 1000, clientHeight = 400 } = {}) {
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

  const rafQueue = [];
  const fakeTimers = {
    setTimeout: () => 0,
    clearTimeout: () => {},
    requestAnimationFrame: fn => { rafQueue.push(fn); return rafQueue.length; },
    cancelAnimationFrame: () => {},
  };

  return {
    container, rows: containerRows, document, fireScroll, flushResizeSignals,
    fireMutationEcho, rafQueue, fakeTimers,
    FakeResizeObserver, FakeMutationObserver,
  };
}

async function withBench(options, fn) {
  const rig = createBenchRig(options);
  const globals = {
    document: rig.document,
    CSS: { supports: () => true },
    ResizeObserver: rig.FakeResizeObserver,
    MutationObserver: rig.FakeMutationObserver,
    escapeHtml: s => s,
    t: (a) => a,
    isChatSurfaceActive: () => true,
    shouldRenderWorkspaceSurface: () => false,
  };
  return withP2EsmCase({
    classic: (sandbox) => {
      Object.assign(sandbox, rig.fakeTimers);
      // index.html 真实加载序：分发器 → i18n → app-core → 业务 classic。
      sandbox.loadSource('public/src/modules/action-dispatcher.js');
      // i18n 已迁 ESM（P4）：t 桥键由 createFrontendSandbox 自动装载，见 test/helpers/install-i18n.js
      prepareEsmModules(sandbox, APP_CORE_DOMAIN);
    },
    globals,
  }, async (c) => {
    await c.load('public/src/modules/chat-viewport.js');
    const surface = c.window.createP2BootstrapChatSurfaceHost();
    surface.showChatProcess = true;
    surface.followLatestEnabled = false;
    // 全渲染分级（实测整行窗口生效）经公开写入函数打开，不直写共享状态字段。
    (await c.load(LAZY_TOOL_CONTENT)).setProcessWindowingDisabled(true);
    c.window.currentRuntimeAgentId = 'rt-bench';
    // 生产兼容桥 → chat-viewport 的 classic 调用拿到 ESM 实现。
    await c.load(WINDOWING_HOST);
    const mod = await c.load(ROW_VISIBILITY);
    assert.equal(c.window.refreshMeasuredChatRows, mod.refreshMeasuredChatRows,
      '桥键必须转发到 chat-row-visibility 的命名导出');

    const refreshCalls = [];
    const rawRefresh = c.window.refreshMeasuredChatRows;
    // 桥键写入 = 生产桥的 setter 转发；classic 消费方随后读到的就是 wrapper。
    c.window.refreshMeasuredChatRows = function wrapped(reason) {
      refreshCalls.push(reason);
      return rawRefresh(reason);
    };

    function pumpFrames(n = 3) {
      for (let i = 0; i < n; i++) {
        const queue = rig.rafQueue.splice(0, rig.rafQueue.length);
        for (const fn2 of queue) fn2();
      }
    }
    function scrollTo(top) {
      rig.container.scrollTop = top;
      rig.fireScroll();
      pumpFrames(2);
      rig.flushResizeSignals();
      pumpFrames(3); // settlement settle frames
    }
    function countFullPasses() {
      // chat-viewport 已转 ESM 并直接 import 实现，桥 key 后的 wrapper 不再参与
      // 观察者驱动的刷新；全量 pass 改按真实测量工作量计量：一次全量刷新对每行读
      // 一次 offsetTop（增量分支只测尾部 / 单行）。
      return Math.floor(harnessState.offsetTopReads / rig.rows.length);
    }

    return fn({
      ...rig,
      pumpFrames, scrollTo,
      refreshCalls,
      refresh: reason => {
        // 用例自己驱动的刷新（reason 由本文件给定，不依赖桥 wrapper 观察）
        refreshCalls.push(reason);
        return c.window.refreshMeasuredChatRows(reason);
      },
      notify: reason => {
        // 本路径必然经 notifyChatViewportMutation → refreshMeasuredChatRows(reason)
        refreshCalls.push(reason);
        return c.window.notifyChatViewportMutation({
          reason, shouldFollow: false, preserveTop: null,
          allowChase: false, preferSmooth: false, forceSnap: false,
        });
      },
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
    });
  });
}

test('steady-state window scrolling performs no DOM measurement', async () => {
  await withBench({ rows: 1000 }, (bench) => {
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
});

test('revealing a drifted row pierces quiet and pays one full pass', async () => {
  await withBench({ rows: 1000 }, (bench) => {
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
    // reason 文案（message-row-resize）是 chat-viewport 内部回调的入参，迁移后不再
    // 经桥 wrapper 可观测；等价契约由上一条钉住：静默窗内只有行高度变化能触发全量 pass。
  });
});

test('collapse-height change pierces the quiet window set by an append notify', async () => {
  await withBench({ rows: 1000 }, (bench) => {
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
    assert.equal(s.fullPasses, 1,
      `row resize must pierce the quiet window exactly once (got ${s.fullPasses})`);
    // And the mutation echo of the same write stays quiet-suppressed: 若普通噪声也穿透，
    // 这里会看到第二次全量 pass。
  });
});

test('mutation echo right after an append notify is quiet-suppressed', async () => {
  await withBench({ rows: 1000 }, (bench) => {
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
});
