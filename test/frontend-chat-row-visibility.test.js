/**
 * 长会话整行可见性窗口（chat-row-visibility，P2 已迁 ESM）行为契约。
 *
 * 装载路线：classic 按 index.html 真实顺序（action-dispatcher → i18n → app-core）
 * 在 vm 沙箱里跑，提供 container 引用与聊天表面状态 host；ESM 侧经
 * withP2EsmCase 的 `c.load` 真实 import，每个用例一张独立模块图，桥键/模块
 * 私有状态互不残留。
 *
 * 状态入口（不再直写原 classic 全局，也不直写共享状态对象的字段）：
 *   - 过程可见性 / 跟随滚动 → createP2BootstrapChatSurfaceHost()（app-core 的
 *     唯一状态 owner，真实 host seam）
 *   - 窗口分级 / 冻结 → lazy-tool-content 的公开写入函数
 *     setProcessWindowingDisabled / freezeProcessWindowing /
 *     unfreezeProcessWindowing（processWindowingMode 是共享状态，写入口只有这些）
 *   - 对外动作 → chat-row-visibility 命名导出（clearMeasuredChatRows /
 *     refreshMeasuredChatRows / revealMeasuredChatRow 就是生产入口）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { APP_CORE_DOMAIN, prepareEsmModules } from './p2-classic-hosts.js';

const ROW_VISIBILITY = 'public/src/modules/chat-row-visibility.js';
const LAZY_TOOL_CONTENT = 'public/src/modules/lazy-tool-content.js';
const distant = 'chat-row-distant';

function createRig({ count = 300, supported = true } = {}) {
  const reads = { geometry: 0, queries: 0 };
  let writes = 0, sequence = 0, captureCount = 0, restoreCount = 0;
  const frames = new Map(), listeners = new Map();
  const container = {
    scrollTop: 10000, clientHeight: 600, clientWidth: 1200,
    querySelectorAll() { reads.queries++; return rows; },
    addEventListener(name, callback) { listeners.set(name, callback); },
  };
  const rows = Array.from({ length: count }, (_, i) => {
    const classes = new Set(), properties = new Map();
    return {
      actualHeight: 30 + (i % 7) * 11, isConnected: true,
      classList: {
        contains: name => classes.has(name),
        add(name) { writes++; classes.add(name); },
        remove(name) { writes++; classes.delete(name); },
      },
      style: {
        setProperty(name, value) { writes++; properties.set(name, value); },
        removeProperty(name) { writes++; properties.delete(name); },
        getPropertyValue: name => properties.get(name) || '',
      },
      contains: element => element === rows[i],
      getBoundingClientRect() { reads.geometry++; return { height: this.actualHeight }; },
      get offsetTop() { reads.geometry++; return topOf(i); },
    };
  });
  function heightOf(row) {
    return row.classList.contains(distant)
      ? parseFloat(row.style.getPropertyValue('--chat-row-height')) : row.actualHeight;
  }
  function topOf(index) {
    return rows.slice(0, index).reduce((sum, row) => sum + heightOf(row) + 8, 0);
  }
  function geometry() {
    return rows.map((row, i) => [topOf(i), heightOf(row)]);
  }

  // app-core 的 container 是 document.getElementById('chat-container') 的结果：
  // 按真实 DOM seam 交出本用例的布局模型容器，其余 id 给通用元素桩。
  const elements = new Map();
  const elementStub = (id) => ({
    id, innerHTML: '', textContent: '', style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    dataset: {}, clientHeight: 0, clientWidth: 0, scrollHeight: 0, scrollTop: 0,
    parentElement: null,
    addEventListener() {}, removeEventListener() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0 }; },
  });
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

  const timers = new Map();
  const fakeTimers = {
    setTimeout(callback) { const id = ++sequence; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
    requestAnimationFrame(callback) { const id = ++sequence; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
  };

  return {
    rows, container, document, frames, fakeTimers,
    geometry, topOf,
    captureAnchor() {
      captureCount++;
      const index = rows.findIndex((row, i) => topOf(i) + heightOf(row) > container.scrollTop);
      return { index, offset: container.scrollTop - topOf(index) };
    },
    applyAnchor(anchor) {
      restoreCount++;
      container.scrollTop = topOf(anchor.index) + anchor.offset;
    },
    pump() {
      const pending = [...frames.values()]; frames.clear();
      pending.forEach(callback => callback());
    },
    queueScroll(top) { container.scrollTop = top; listeners.get('scroll')(); },
    scroll(top) { this.queueScroll(top); this.pump(); },
    emitLoad(target) { listeners.get('load')({ target }); },
    counters: () => ({ ...reads, writes, captureCount, restoreCount }),
    resetCounters() { reads.geometry = 0; reads.queries = 0; writes = 0; },
    supported,
  };
}

/**
 * 建立一次「classic bootstrap + ESM 域」用例：app-core 先装载（container 引用、
 * 聊天表面状态 host、KernelState 桥），再真实 import 窗口模块。
 */
async function withView(options, fn) {
  const rig = createRig(options);
  const globals = {
    document: rig.document,
    CSS: { supports: () => rig.supported },
    // classic 晚绑定面（生产：chat-viewport.js 顶层函数），本用例按调用计数。
    captureChatViewportAnchor: () => rig.captureAnchor(),
    applyChatViewportAnchor: (anchor) => rig.applyAnchor(anchor),
    runWithSuppressedChatViewportObservers: callback => callback(),
  };
  return withP2EsmCase({
    classic: (sandbox) => {
      Object.assign(sandbox, rig.fakeTimers);
      sandbox.loadSource('public/src/modules/action-dispatcher.js');
      // i18n 已迁 ESM（P4）：t 桥键由 createFrontendSandbox 自动装载，见 test/helpers/install-i18n.js
      prepareEsmModules(sandbox, APP_CORE_DOMAIN);
    },
    globals,
  }, async (c) => {
    const surface = c.window.createP2BootstrapChatSurfaceHost();
    surface.showChatProcess = true;
    surface.followLatestEnabled = false;
    // 窗口分级的公开写入口（lazy-tool-content 的命名导出；同图内共享
    // processWindowingMode，不在此直写字段）。
    const windowing = await c.load(LAZY_TOOL_CONTENT);
    windowing.setProcessWindowingDisabled(true);
    const mod = await c.load(ROW_VISIBILITY);
    return fn({
      ...rig, surface, mod,
      refresh: reason => mod.refreshMeasuredChatRows(reason),
      clear: () => mod.clearMeasuredChatRows(),
      freeze: () => windowing.freezeProcessWindowing(),
      unfreeze: () => windowing.unfreezeProcessWindowing(),
      setWindowingDisabled: (value) => windowing.setProcessWindowingDisabled(value),
    });
  });
}

test('distant rows keep measured heights and DOM identities across window changes', async () => {
  await withView({}, (view) => {
    const originalGeometry = view.geometry(), originalRows = [...view.rows];
    view.refresh('render-full');
    assert.deepEqual(view.geometry(), originalGeometry);
    assert(view.rows.filter(row => row.classList.contains(distant)).length > 200);
    const nearby = view.rows.findIndex((row, i) => view.topOf(i) >= view.container.scrollTop);
    assert.equal(view.rows[nearby].classList.contains(distant), false);
    view.scroll(3000);
    assert.deepEqual(view.geometry(), originalGeometry);
    view.rows.forEach((row, i) => assert.equal(row, originalRows[i]));
    assert.equal(view.rows[nearby].classList.contains(distant), true);
  });
});

test('ordinary scrolling within the buffered window reads no row geometry and writes no styles', async () => {
  await withView({}, (view) => {
    view.refresh('render-full'); view.resetCounters();
    for (let i = 1; i <= 10; i++) view.scroll(10000 + i * 35);
    assert.deepEqual(view.counters(), { geometry: 0, queries: 0, writes: 0, captureCount: 0, restoreCount: 0 });
    view.scroll(3000);
    assert.equal(view.counters().geometry, 0);
    assert.equal(view.counters().queries, 0);
    assert(view.counters().writes > 0);
  });
});

test('patching an offscreen tail updates its real height without realizing all history', async () => {
  await withView({}, (view) => {
    view.refresh('render-full');
    const tail = view.rows.at(-1), before = view.geometry();
    assert(tail.classList.contains(distant));
    tail.actualHeight += 420;
    view.refresh('patch-last');
    assert.equal(view.geometry().at(-1)[1], tail.actualHeight);
    assert.deepEqual(view.geometry().slice(0, -1), before.slice(0, -1));
    assert(tail.classList.contains(distant));
    assert(view.rows.filter(row => row.classList.contains(distant)).length > 200);
  });
});

test('width changes wait for unfreeze and preserve the same reading anchor', async () => {
  await withView({}, (view) => {
    view.refresh('render-full');
    view.freeze();
    view.container.clientWidth = 900;
    view.rows.forEach(row => { row.actualHeight += 20; });
    view.resetCounters(); view.refresh('resize');
    assert.equal(view.counters().geometry, 0);
    // Visible content can already wrap while dragging; preserve the anchor
    // at release when removing distant rows' old width-dependent height locks.
    const index = view.geometry().findIndex(([top, height]) => top + height > view.container.scrollTop);
    const offset = view.container.scrollTop - view.topOf(index);
    // 生产释放路径：unfreeze 自己做一次 settle 并调 refreshMeasuredChatRows(
    // 'width-settled')，用例不再额外直调 refresh。
    view.unfreeze();
    assert.equal(view.counters().captureCount, 1);
    assert.equal(view.counters().restoreCount, 1);
    assert.equal(view.container.scrollTop - view.topOf(index), offset);
    view.geometry().forEach(([, height], i) => assert.equal(height, view.rows[i].actualHeight));
  });
});

test('explicit expansion and image load can reveal and remeasure a distant row', async () => {
  await withView({}, (view) => {
    view.refresh('render-full');
    const row = view.rows[2];
    assert(row.classList.contains(distant));
    view.mod.revealMeasuredChatRow(row);
    assert.equal(row.classList.contains(distant), false);
    row.actualHeight += 80;
    view.refresh('toggle-message');
    assert.equal(view.geometry()[2][1], row.actualHeight);
    row.actualHeight += 120;
    view.emitLoad({ tagName: 'IMG', closest: () => row });
    assert.equal(view.geometry()[2][1], row.actualHeight);
  });
});

test('focused content remains available outside the window', async () => {
  await withView({}, (view) => {
    view.document.activeElement = view.rows[0];
    view.refresh('render-full'); view.scroll(18000);
    assert.equal(view.rows[0].classList.contains(distant), false);
    assert.equal(view.rows[1].classList.contains(distant), true);
  });
});

test('process off and estimated window mode release height locks and pending scroll work', async () => {
  for (const flag of ['showChatProcess', '_windowingDisabled']) {
    await withView({}, async (view) => {
      const original = view.geometry(); view.refresh('render-full');
      view.queueScroll(view.container.scrollTop + 5000);
      assert.equal(view.frames.size, 1);
      if (flag === 'showChatProcess') view.surface.showChatProcess = false;
      else view.setWindowingDisabled(false);
      view.refresh('mode-change');
      assert.equal(view.frames.size, 0);
      assert.deepEqual(view.geometry(), original);
      view.rows.forEach(row => {
        assert.equal(row.classList.contains(distant), false);
        assert.equal(row.style.getPropertyValue('--chat-row-height'), '');
      });
      view.resetCounters(); view.scroll(0);
      assert.equal(view.counters().writes, 0);
    });
  }
});

test('unsupported browsers and short conversations keep their normal layout', async () => {
  for (const options of [{ supported: false }, { count: 100 }]) {
    await withView(options, (view) => {
      const original = view.geometry();
      view.refresh('render-full');
      assert.deepEqual(view.geometry(), original);
      assert.equal(view.counters().geometry, 0);
      assert.equal(view.counters().writes, 0);
    });
  }
});
