/**
 * P2 第二波批次 1：chat-nav-timeline（ESM 化后的真实行为与初始化时点）。
 *
 * 模块是纯副作用模块：零生产消费者 → 全部 helper 模块私有、零导出，因此本文件
 * 只用**真实事件**驱动（DOMContentLoaded / slot mouseenter / slot click /
 * timeline wheel / container scroll / timeline mouseleave），断言只看 DOM 侧可
 * 观察结果与 classic 晚绑定调用记录。
 *
 * 隔离纪律（每个 case 独立可跑，不依赖文件内顺序）：
 *   - 每个 case 新建容器、导航条带元素、消息元素与**全新模块实例**（唯一 query），
 *     私有 `_nav*` 状态天然独立；
 *   - case 结束（含抛错）在 finally 里把 document / window 监听注册表退回到 case
 *     开始前的长度、复位全局补丁与在飞计时器 / rAF 队列；
 *   - `node --test --test-name-pattern='<单个用例名>'` 亦必须通过。
 */
import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { installBrowserStubs, loadModuleOnce } from './helpers/esm-module-loader.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const NAV = 'public/src/modules/chat-nav-timeline.js';
const SESSION_VIEW_STORAGE = 'public/src/modules/session-view-storage.js';
const plainUrl = (relativePath) => pathToFileURL(path.resolve(REPO_ROOT, relativePath)).href;

// ── 最小 DOM 桩（记录监听，便于用真实事件驱动）─────────────────────

function createClassList(initial = []) {
  const set = new Set(initial);
  return {
    add(...names) { for (const name of names) set.add(name); },
    remove(...names) { for (const name of names) set.delete(name); },
    contains(name) { return set.has(name); },
    toggle(name, force) {
      const next = force === undefined ? !set.has(name) : !!force;
      if (next) set.add(name); else set.delete(name);
      return next;
    },
    values() { return [...set]; },
  };
}

function createElementStub({ classes = [], tagName = 'DIV' } = {}) {
  const listeners = new Map();
  const el = {
    tagName,
    className: classes[0] || '',
    classList: createClassList(classes),
    style: { setProperty() {}, removeProperty() {} },
    dataset: {},
    children: [],
    rect: { top: 0, bottom: 0, height: 0 },
    isConnected: true,
    contains() { return false; },
    closest() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    appendChild(child) { el.children.push(child); return child; },
    getBoundingClientRect() { return { ...el.rect }; },
    addEventListener(type, listener, options) {
      const map = listeners.get(type) || new Map();
      map.set(listener, options);
      listeners.set(type, map);
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    listenerCount(type) { return listeners.get(type)?.size ?? 0; },
    listenerOptions(type) { return [...(listeners.get(type)?.values() || [])]; },
    dispatch(type, event = {}) {
      for (const listener of [...(listeners.get(type)?.keys() || [])]) listener(event);
    },
  };
  Object.defineProperty(el, 'innerHTML', {
    get() { return el._html || ''; },
    set(value) { el._html = value; if (value === '') el.children.length = 0; },
  });
  return el;
}

function createContainer() {
  const container = createElementStub({ classes: ['chat-container'] });
  container.clientHeight = 600;
  container.scrollHeight = 3000;
  container.scrollTop = 0;
  container.parentElement = createElementStub({ classes: ['main-content'] });
  container.parentElement.rect = { top: 0, bottom: 800, height: 800 };
  return container;
}

// ── 注入面 ──────────────────────────────────────────────────────────

let cleanupGlobals;
let domHost;
let documentListeners;
let windowListeners;
let documentState;
let currentElements;
let scrollIntents;
let rafQueue;

function installCaseGlobals() {
  domHost = { container: null };
  documentListeners = [];
  windowListeners = [];
  documentState = { readyState: 'interactive' };
  currentElements = new Map();
  rafQueue = [];

  cleanupGlobals = installBrowserStubs({
    window: {
      createP2BootstrapDomHost: () => domHost,
      registerManualScrollIntent: (options) => { scrollIntents.push(options ?? null); },
      addEventListener(type, listener) { windowListeners.push({ type, listener }); },
      removeEventListener() {},
      // vendor 面：markdown-utils 在求值期 new Renderer() / setOptions（escapeHtml 与
      // renderer 配置都是模块自身实现，不再经 window 预置）。
      marked: { parse: () => '', setOptions() {}, use() {}, Renderer: class {} },
      ClawFW: { actions: { registerMany() {} } },
    },
    document: {
      addEventListener(type, listener) { documentListeners.push({ type, listener }); },
      removeEventListener() {},
      getElementById: (id) => currentElements.get(id) ?? null,
      createElement: (tagName) => createElementStub({ tagName: String(tagName).toUpperCase() }),
      querySelectorAll() { return []; },
    },
  });
  globalThis.MutationObserver = class MutationObserver {
    observe() {}
    disconnect() {}
  };
  globalThis.requestAnimationFrame = (cb) => { rafQueue.push(cb); return rafQueue.length; };
  globalThis.cancelAnimationFrame = () => {};
}

function uninstallCaseGlobals() {
  cleanupGlobals();
  delete globalThis.MutationObserver;
  delete globalThis.requestAnimationFrame;
  delete globalThis.cancelAnimationFrame;
}

before(async () => {
  installCaseGlobals();
  await loadModuleOnce('public/src/modules/kernel-state.js', { installGlobals: false });
});

after(() => {
  uninstallCaseGlobals();
});

/** 构造一个 case 的 DOM 环境（容器 + 条带 + 卡片 + user 行/消息元素）。 */
function createNavCase({ rows = [], timelineHeight = 400 } = {}) {
  const container = createContainer();
  const timeline = createElementStub({ classes: ['chat-nav-timeline'] });
  timeline.rect = { top: 0, bottom: timelineHeight, height: timelineHeight };
  const card = createElementStub({ classes: ['chat-nav-card'] });
  const elements = new Map([
    ['chat-nav-timeline', timeline],
    ['chat-nav-card', card],
  ]);

  container.rows = rows.map(({ msgIndex, rowTop = 0 }) => {
    const row = createElementStub({ classes: ['message-row', 'user'] });
    row.rect = { top: rowTop, bottom: rowTop + 100, height: 100 };
    const content = createElementStub();
    content.id = `msg-${msgIndex}`;
    content.textContent = `message ${msgIndex}`;
    content.closest = (selector) => (selector === '.message-row' ? row : null);
    elements.set(`msg-${msgIndex}`, content);
    row.querySelector = (selector) => (selector === '[id^="msg-"]' ? content : null);
    row.closest = (selector) => (selector === '.message-row' ? row : null);
    return row;
  });
  container.querySelectorAll = (selector) => (selector === '.message-row.user' ? container.rows : []);
  return { container, timeline, card, elements };
}

/**
 * 每个 case 的完整夹具：新容器 + 新元素 + 新模块实例（唯一 query），
 * finally 里把监听注册表 / DOM 桩 / 计时器 / rAF 队列复原。
 */
async function withNavCase(options, fn) {
  const documentStart = documentListeners.length;
  const windowStart = windowListeners.length;
  const env = createNavCase(options);
  const readyState = options.readyState ?? 'interactive';

  scrollIntents = [];
  documentState.readyState = readyState;
  globalThis.document.readyState = readyState;
  currentElements = env.elements;
  domHost.container = env.container;

  const storage = await import(plainUrl(SESSION_VIEW_STORAGE));
  storage.setCurrentMessages(options.messages ?? []);

  // 计时器统一由 mock 托管：模块的 rebuild / 定位定时器在 case 内显式 tick，
  // case 结束 reset 时被丢弃，不会在夹具拆除后再跑（否则会读到已清空的容器）。
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { module } = await loadModuleOnce(NAV, { installGlobals: false });
    return await fn({
      ...env,
      module,
      tick: (ms) => mock.timers.tick(ms),
      /** 只触发本 case 新注册的 document 监听（旧 case 的已被裁掉）。 */
      fireDocument(type) {
        for (const entry of documentListeners.slice(documentStart)) {
          if (entry.type === type) entry.listener({ type });
        }
      },
      /** 触发本 case 新注册的 window 监听。 */
      fireWindow(type) {
        for (const entry of windowListeners.slice(windowStart)) {
          if (entry.type === type) entry.listener({ type });
        }
      },
    });
  } finally {
    mock.timers.reset();
    // 监听数组复原：本 case 注册的监听不得跨 case 存活（否则后续 fireDocument
    // 会重复驱动旧实例）
    documentListeners.length = documentStart;
    windowListeners.length = windowStart;
    rafQueue.length = 0;
    currentElements = new Map();
    domHost.container = null;
    documentState.readyState = 'interactive';
    globalThis.document.readyState = 'interactive';
  }
}

function slotCount(timeline) {
  return timeline.children.filter((child) => child.className === 'chat-nav-slot').length;
}

function slotOf(timeline, index) {
  return timeline.children.filter((child) => child.className === 'chat-nav-slot')[index];
}

function barOf(timeline, index) {
  return slotOf(timeline, index)?.children[0];
}

// ── 初始化时点（R4 精确核对）──────────────────────────────────────

test('chat-nav-timeline：readyState=interactive 时等 DOMContentLoaded 再初始化（保持原时点）', async () => {
  await withNavCase({ readyState: 'interactive', rows: [] }, async ({ timeline, fireDocument }) => {
    assert.equal(documentListeners.filter((entry) => entry.type === 'DOMContentLoaded').length, 1,
      '未完成装载时必须注册 DOMContentLoaded');
    assert.equal(timeline.classList.contains('hidden'), false, '装载相不得提前初始化');

    fireDocument('DOMContentLoaded');
    assert.equal(timeline.classList.contains('hidden'), true, '初始化后（无 user 行）隐藏条带');
  });
});

test('chat-nav-timeline：readyState=complete 时装载即初始化（DOMContentLoaded 已过）', async () => {
  await withNavCase({ readyState: 'complete', rows: [] }, async ({ timeline }) => {
    assert.equal(documentListeners.filter((entry) => entry.type === 'DOMContentLoaded').length, 0,
      '已完整装载时不得再挂 DOMContentLoaded');
    assert.equal(timeline.classList.contains('hidden'), true, '装载即初始化');
  });
});

// ── 真实事件路径 ──────────────────────────────────────────────────

test('chat-nav-timeline：按 user 行重建条带，hover 用转义后的消息预览填充卡片', async () => {
  // _navUserIndices 取的是 msg-<下标> 里的消息下标，fixture 必须与 messages 对齐
  const rows = [{ msgIndex: 0, rowTop: 100 }, { msgIndex: 1, rowTop: 500 }];
  const messages = [
    { role: 'user', content: '<b>first</b>' },
    { role: 'user', content: 'second' },
  ];
  await withNavCase({ rows, messages }, async ({ timeline, card, fireDocument }) => {
    fireDocument('DOMContentLoaded');
    assert.equal(timeline.classList.contains('hidden'), false);
    const slots = timeline.children.filter((child) => child.className === 'chat-nav-slot');
    assert.equal(slots.length, 2, '一条 user 消息一个 slot');
    assert.equal(timeline.children.filter((child) => String(child.className).startsWith('chat-nav-edge-band')).length, 0,
      '窗口未溢出时不建感应带');
    assert.equal(slots[0].children.length, 1, 'slot 内只有一个可视 bar');

    slots[0].dispatch('mouseenter');
    assert.equal(card.classList.contains('show'), true, 'hover 必须显示预览卡片');
    assert.match(card.innerHTML, /&lt;b&gt;first&lt;\/b&gt;/, '预览必须经 escapeHtml 转义');
    assert.match(card.innerHTML, /#1/, '编号按窗口序号');
  });
});

test('chat-nav-timeline：点击条带先中断跟随再暴力跳转，并短暂高亮目标行', async () => {
  await withNavCase({
    rows: [{ msgIndex: 7, rowTop: 500 }],
    messages: [{ role: 'user', content: 'target' }],
  }, async ({ container, timeline, fireDocument, tick }) => {
    fireDocument('DOMContentLoaded');
    container.scrollTop = 200;

    slotOf(timeline, 0).dispatch('click');
    assert.deepEqual(scrollIntents, [{ interrupt: true }], '跳转前必须中断跟随动画');
    // 目标行相对容器顶部 500；scrollTop 200 + delta → 减去 16px 留白
    assert.equal(container.scrollTop, 684);

    const row = container.rows[0];
    assert.equal(row.classList.contains('nav-flash'), true, '跳转后目标行短暂高亮');
    tick(800);
    assert.equal(row.classList.contains('nav-flash'), false, '高亮在 700ms 后自动移除');
  });
});

test('chat-nav-timeline：滚动高亮按 rAF 合并，滚轮滑窗后 scroll spy 不拉回窗口', async () => {
  const rows = Array.from({ length: 20 }, (_, index) => ({ msgIndex: index + 1, rowTop: index * 100 }));
  const messages = rows.map((_, index) => ({ role: 'user', content: `m${index}` }));
  await withNavCase({ rows, messages }, async ({ container, timeline, fireDocument }) => {
    fireDocument('DOMContentLoaded');
    const slotsBefore = slotCount(timeline);

    container.dispatch('scroll');
    container.dispatch('scroll');
    assert.equal(rafQueue.length, 1, '连续滚动必须合并成单个 rAF 高亮更新');
    rafQueue.shift()();
    assert.equal(barOf(timeline, 0).classList.contains('active'), true, '首条（视口顶行）高亮');

    // 滚轮只滑窗、不落到聊天区
    const wheelEvent = {
      deltaY: 120,
      prevented: false,
      stopped: false,
      preventDefault() { this.prevented = true; },
      stopPropagation() { this.stopped = true; },
    };
    timeline.dispatch('wheel', wheelEvent);
    assert.equal(wheelEvent.prevented, true, '滚轮必须阻止页面滚动');
    assert.equal(wheelEvent.stopped, true, '滚轮不得冒泡到聊天区');
    assert.equal(slotCount(timeline), slotsBefore, '滑窗重建后 slot 数不变');

    // 手动滑窗后 scroll spy 不得把窗口拉回（无重建）
    const beforeSpy = slotCount(timeline);
    container.dispatch('scroll');
    rafQueue.splice(0).forEach((cb) => cb());
    assert.equal(slotCount(timeline), beforeSpy, '手动滑窗期间 scroll spy 不得重建窗口');
  });
});

test('chat-nav-timeline：鼠标离开条带复位波形与卡片', async () => {
  await withNavCase({
    rows: [{ msgIndex: 1, rowTop: 0 }],
    messages: [{ role: 'user', content: 'only' }],
  }, async ({ timeline, card, fireDocument }) => {
    fireDocument('DOMContentLoaded');
    slotOf(timeline, 0).dispatch('mouseenter');
    assert.equal(card.classList.contains('show'), true);
    assert.equal(barOf(timeline, 0).classList.contains('hover-focus'), true);

    timeline.dispatch('mouseleave');
    assert.equal(card.classList.contains('show'), false, '离开后隐藏卡片');
    assert.equal(barOf(timeline, 0).classList.contains('hover-focus'), false, '离开后复位波形');
  });
});

test('chat-nav-timeline：模块零导出，私有 helper 不进模块导出面', async () => {
  await withNavCase({ rows: [], messages: [] }, async ({ module }) => {
    assert.deepEqual(Object.keys(module), [], '纯副作用模块不得导出内部 helper');
    for (const key of ['_navTimelineEl', '_navWindowStart', '_initChatNavTimeline',
      '_rebuildNavTimeline', '_onBarClick', '_slideNavWindow', '_updateActiveNavBar']) {
      assert.equal(key in window, false, `${key} 不得挂在 window 上`);
    }
  });
});
