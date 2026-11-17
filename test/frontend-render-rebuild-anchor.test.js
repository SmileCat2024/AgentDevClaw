/**
 * Acceptance tests for the once-per-switch viewport tremor when scrolling
 * right after a session switch.
 *
 * The restore pipeline has three layers, all exercised here against the REAL
 * production modules — chat-renderer 迁 ESM 后整条 render() 由真实 import 执行
 * （含锚点捕获 / 重建 / 应用与 notify），settlement 由真实 chat-viewport 结算链驱动：
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
 *
 * 装载路线（P4 T2 批次）：classic 相走真实先行脚本链（prepareClassicSandbox：
 * app-core 的宿主工厂与 `getRuntimeContextKey` 是生产实现），chat-renderer /
 * chat-viewport 走真实 import；容器是带序列布局（offsetTop / offsetHeight /
 * 钳制 scrollTop）的夹具，innerHTML 重建那一刻换行高以模拟模板重排。
 * 计时器：模块 realm 的 setTimeout / rAF 换成本用例自己的确定性队列，结算按
 * 队列排空推进（不真实等待）；classic 相仍是沙箱 tracked 计时器。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { prepareClassicSandbox } from './p2-classic-hosts.js';

const CHAT_RENDERER = 'public/src/modules/chat-renderer.js';
const CHAT_VIEWPORT = 'public/src/modules/chat-viewport.js';

const rendererSource = fs.readFileSync(new URL('../public/src/modules/chat-renderer.js', import.meta.url), 'utf8');
// 源码级 wiring 断言用（settle 必须咨询手动滚动意图）。
const viewportSource = fs.readFileSync(new URL('../public/src/modules/chat-viewport.js', import.meta.url), 'utf8');

const VIEW_H = 800;

// ── 夹具：带序列布局的聊天容器 ─────────────────────────────────────────

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

/** 行对象：布局由夹具注入的 eager top/height 提供（等价于已布局的真实行）。 */
function makeLayoutRow(top, height) {
  return {
    offsetTop: top,
    offsetHeight: height,
    dataset: {},
    style: {},
    classList: makeClassList(),
    id: '',
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null,
    matches: () => false,
    insertAdjacentHTML() {},
    remove() {},
    getBoundingClientRect: () => ({ top: 0, bottom: height, left: 0, right: 0, width: 0, height }),
  };
}

/**
 * 序列布局容器：`setRows` 决定行高，scrollHeight 由行高求和推导，scrollTop
 * 按浏览器语义钳制并记录写入。`innerHTML` 赋值触发 `_onInnerHtml`——渲染重建
 * 那一刻换上新行集，模拟「模板重排后同一行的位置变了」。
 */
function createLayoutContainer() {
  const container = {
    _scrollTop: 0,
    _writes: [],
    _rows: [],
    _onInnerHtml: null,
    clientHeight: VIEW_H,
    dataset: {},
    style: {},
    id: 'chat-container',
    className: '',
    classList: makeClassList(),
    addEventListener() {},
    removeEventListener() {},
    getBoundingClientRect: () => ({ top: 0, bottom: VIEW_H, left: 0, right: 0, width: 1000, height: VIEW_H }),
    querySelector(sel) {
      if (sel === '.message-row') return container._rows[0] || null;
      return null;
    },
    querySelectorAll(sel) {
      if (sel === '.message-row' || sel.endsWith('.message-row')) return container._rows.slice();
      return [];
    },
    getElementsByTagName: () => [],
    getElementsByClassName: () => [],
    setRows(heights) {
      let top = 0;
      container._rows = heights.map((height) => {
        const row = makeLayoutRow(top, height);
        top += height;
        return row;
      });
    },
  };
  Object.defineProperty(container, 'innerHTML', {
    set() { if (container._onInnerHtml) container._onInnerHtml(); },
    get() { return ''; },
  });
  Object.defineProperty(container, 'scrollHeight', {
    get() {
      const total = container._rows.reduce((sum, row) => sum + row.offsetHeight, 0);
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
  return container;
}

function makeFollowLatestButton() {
  return {
    innerHTML: '',
    style: {},
    classList: makeClassList(),
    dataset: {},
    closest: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }),
  };
}

function makeDocument(container, followLatestButton) {
  const generic = () => ({
    style: {}, dataset: {}, children: [], innerHTML: '', textContent: '', id: '',
    classList: makeClassList(),
    addEventListener() {}, removeEventListener() {}, appendChild() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    closest() { return null; }, matches() { return false; }, remove() {},
    insertAdjacentHTML() {},
    getBoundingClientRect() { return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }; },
  });
  return {
    addEventListener() {}, removeEventListener() {},
    getElementById: (id) => {
      if (id === 'chat-container') return container;
      if (id === 'follow-latest-btn') return followLatestButton;
      return generic();
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => generic(),
    createTextNode: (text) => ({ textContent: text }),
    // applyChatViewportAnchor 检查旧行是否仍挂载：重建后的行都是新对象，
    // 「已脱离」正是真实重建走的 walk-forward-from-rowIdx 路径。
    body: { contains: () => false, appendChild() {}, classList: makeClassList() },
    head: generic(), documentElement: generic(),
  };
}

// ── 用例上下文：classic 先行链 + 真实模块 + 确定性计时器 ──────────────

async function withRenderHarness({ domContextKey = null } = {}, fn) {
  const container = createLayoutContainer();
  const followLatestButton = makeFollowLatestButton();
  const document = makeDocument(container, followLatestButton);

  // 模块 realm 的计时器队列（结算 / 跟随动画）：排空即推进，不真实等待。
  const timers = new Map();
  let seq = 1;
  const fakeTimers = {
    setTimeout: (callback) => { const id = seq++; timers.set(id, callback); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    setInterval: () => 0,
    clearInterval: () => {},
    requestAnimationFrame: (callback) => fakeTimers.setTimeout(() => callback(Date.now())),
    cancelAnimationFrame: (id) => fakeTimers.clearTimeout(id),
  };
  const drain = (limit = 40) => {
    for (let round = 0; round < limit && timers.size > 0; round += 1) {
      const pending = [...timers.values()];
      timers.clear();
      pending.forEach((callback) => callback());
    }
  };

  return withP2EsmCase({
    classic: (sandbox) => {
      prepareClassicSandbox(sandbox);
      sandbox.loadSource('public/src/modules/markdown-bootstrap.js');
    },
    globals: {
      document,
      ...fakeTimers,
      MutationObserver: class { observe() {} disconnect() {} takeRecords() { return []; } },
      ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
      updateChatProcessToggle: () => {},
      marked: {
        Renderer: class { constructor() {} },
        setOptions() {},
        parse: (value) => String(value ?? ''),
      },
      createPollCoordinatorHost: () => ({
        run: () => Promise.resolve(),
        fastInterval: () => 2000,
        setTimeout: (callback, delay) => setTimeout(callback, delay),
        clearTimeout: (id) => clearTimeout(id),
      }),
    },
  }, async (c) => {
    const renderer = await c.load(CHAT_RENDERER);
    const viewport = await c.load(CHAT_VIEWPORT);
    const surface = c.window.createP2BootstrapChatSurfaceHost();
    // 生产默认跟随开启；本文件的观察面是非跟随路径。
    surface.followLatestEnabled = false;
    surface.showChatProcess = true;
    c.window.currentRuntimeAgentId = 'rt-1';
    const contextKey = c.window.getRuntimeContextKey('rt-1');
    container.dataset.chatRenderContext = domContextKey === null ? contextKey : domContextKey;
    return fn({
      c, renderer, viewport, surface, container, followLatestButton, contextKey, drain,
    });
  });
}

const MESSAGES = Array.from({ length: 30 }, (_, i) => ({ role: 'user', content: `m${i}` }));

// ── Fix A: settlement respects manual scroll intent ─────────────────────

test('settle(): a recent manual scroll suppresses the preserveTop write-back', async () => {
  await withRenderHarness({}, (h) => {
    h.container.setRows(Array.from({ length: 30 }, () => 100));
    h.container.scrollTop = 1500;
    h.container._writes.length = 0;

    // The user is mid-scroll when the settlement fires.
    h.viewport.registerManualScrollIntent();
    h.viewport.notifyChatViewportMutation({
      reason: 'render-full', shouldFollow: false, preserveTop: 500,
      forceSnap: false, allowChase: false,
    });
    h.drain();

    assert.equal(h.container.scrollTop, 1500, 'user position must win over the stale pixel');
    assert.deepEqual(h.container._writes, [], 'no scroll write may yank the viewport back');
  });
});

test('settle(): without manual intent the preserveTop write-back still applies', async () => {
  await withRenderHarness({}, (h) => {
    h.container.setRows(Array.from({ length: 30 }, () => 100));
    h.container.scrollTop = 1500;
    h.container._writes.length = 0;

    h.viewport.notifyChatViewportMutation({
      reason: 'render-full', shouldFollow: false, preserveTop: 500,
      forceSnap: false, allowChase: false,
    });
    h.drain();

    assert.equal(h.container.scrollTop, 500, 'switch restore must still be applied');
  });
});

// ── Fix B: same-context rebuild restores by row anchor ───────────────────

test('same-context rebuild: row anchor keeps the reading row under the viewport top across a layout shift', async () => {
  await withRenderHarness({}, (h) => {
    // 30 rows × 100px. Reading position: row 15 exactly at the viewport top.
    h.container.setRows(Array.from({ length: 30 }, () => 100));
    h.container.scrollTop = 1500;
    assert.equal(h.container.scrollTop, 1500);
    h.container._writes.length = 0;

    // Rebuild lands: row 0 grows 100 → 400 (tool template swap above the
    // viewport). Everything below shifts down 300px.
    h.container._onInnerHtml = () => h.container.setRows([400, ...Array.from({ length: 29 }, () => 100)]);
    h.renderer.render(MESSAGES);

    // Pixel restore would keep scrollTop 1500 — pointing 300px into the wrong
    // content. The anchor restore must land on the SAME row at its new top.
    assert.equal(h.container.scrollTop, 1800, 'viewport must follow the anchored row to its new offsetTop');
    const topRow = h.container._rows.find((r) => r.offsetTop + r.offsetHeight > h.container.scrollTop);
    assert.equal(topRow.offsetTop, 1800, 'the row at the viewport top must be the pre-rebuild reading row');

    // 结算重放同一锚点（不是重建前的像素值）。
    h.drain();
    assert.equal(h.container.scrollTop, 1800, 'settlement must re-assert the anchored position, not the stale pixel');
    assert.deepEqual(h.container._writes, [1800], 'the pre-rebuild pixel must never be written back');
  });
});

test('cross-context DOM: no anchor is captured, the pixel path stays', async () => {
  await withRenderHarness({ domContextKey: 'runtime:previous-session' }, (h) => {
    h.container.setRows(Array.from({ length: 30 }, () => 100));
    h.container.scrollTop = 1500;
    h.container._writes.length = 0;

    // e.g. pendingChatScrollRestore handoff value from switchAgent
    h.viewport.setPendingChatScrollRestore(777);
    h.container._onInnerHtml = () => h.container.setRows(Array.from({ length: 30 }, () => 100));
    h.renderer.render(MESSAGES);

    assert.equal(h.container.scrollTop, 1500, 'no synchronous anchor apply may run for a foreign DOM');
    assert.equal(h.container.dataset.chatRenderContext, h.contextKey,
      'the rebuild must stamp the incoming context for the next same-context render');

    h.drain();
    assert.equal(h.container.scrollTop, 777, 'the pixel restore value must flow to the settlement unchanged');
  });
});

test('A+B together: anchor lands, user keeps scrolling, settlement does not yank back', async () => {
  await withRenderHarness({}, (h) => {
    h.container.setRows(Array.from({ length: 30 }, () => 100));
    h.container.scrollTop = 1500;

    h.container._onInnerHtml = () => h.container.setRows([400, ...Array.from({ length: 29 }, () => 100)]);
    h.renderer.render(MESSAGES);
    assert.equal(h.container.scrollTop, 1800);

    // Between the rebuild and the settlement (~280ms window) the user scrolls on.
    h.container.scrollTop = 2000;
    h.viewport.registerManualScrollIntent();
    h.drain();

    assert.equal(h.container.scrollTop, 2000, 'the settlement must not overwrite the user\'s live position');
  });
});

// ── Wiring: the real render() source must contain the fixed paths ───────
// 行为已由上面的真实 render() 用例覆盖；这两条是「将来有人删掉修复路径」的
// 文本级护栏，成本近零，保留。

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
