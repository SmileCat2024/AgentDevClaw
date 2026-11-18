/**
 * 虚拟化分级下流式背景补丁的窗口锚定回归（"空 assistant 消息"泄漏）。
 *
 * 历史 bug：applyProcessDistance 的全量路径把 viewportIdx 硬编码为末行，
 * 而增量守卫（_applyIncrementalProcessRows）只在全渲染分级
 * （_windowingDisabled）生效。超节点预算的长会话走虚拟化分级，流式
 * append / updateLastMessage（fromIndex > 0、非 landing）每条消息事件都
 * 落全量路径 → 窗口被强行搬到末行，用户上翻阅读中的区域被 cv 隐藏：
 * 工具-only 的 assistant 行只剩徽标 + 灰色占位（"空 assistant 消息"
 * 成片泄漏），正文行不受影响（markdown-body 不参与 cv 窗口化）——与"长会话、
 * 成片、正文行夹杂、刷新（landing 全量重算）/显隐切换
 * （preToggleViewportIdx 锚定用户位置）恢复"的现场特征一致。
 *
 * 契约：背景补丁保持 background patch 语义——窗口跟随用户真实视口
 * （与 _applyWindow 同源的 _findViewportTopRowIdx），不得锚定末行；
 * 底部流式（跟随模式 / 用户在底部）时新末行必须保持揭示。
 *
 * 装载路线（P2）：lazy-tool-content 已迁 ESM，用例经 withP2EsmCase 的
 * `c.load` 真实 import 命名导出（applyProcessDistance /
 * setProcessWindowingDisabled 就是生产入口）；classic 真实 bootstrap
 * （action-dispatcher → i18n → app-core）提供 container 引用与聊天表面状态。滚动链走真实
 * container 'scroll' 监听，不再直接调用私有 _onScrollForWindowing。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { APP_CORE_DOMAIN, prepareEsmModules } from './p2-classic-hosts.js';

const LAZY_TOOL_CONTENT = 'public/src/modules/lazy-tool-content.js';

const VIEW_H = 800;
const USER_H = 80;
const ASSISTANT_H = 120;

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

// 奇数行 = 带两张调用卡的 assistant（工具-only，正文为空）；偶数行 = user。
function makeEntry(i) {
  const isAssistant = i % 2 === 1;
  const row = {
    classList: makeClassList(),
    dataset: {},
    realH: isAssistant ? ASSISTANT_H : USER_H,
    _processChildren: [],
  };
  row.classList.add('message-row', isAssistant ? 'assistant' : 'user');
  if (isAssistant) {
    for (let k = 0; k < 2; k++) {
      const card = { classList: makeClassList() };
      card.classList.add('tool-call-container');
      row._processChildren.push(card);
    }
  }
  const content = {
    id: 'msg-' + i,
    classList: makeClassList(),
    get children() { return row._processChildren; },
  };
  row.querySelector = (sel) => (sel === '.message-content' ? content : null);
  row.querySelectorAll = (sel) =>
    (sel === '.reasoning-block, .tool-call-container' ? [...row._processChildren] : []);
  return { row, cards: row._processChildren };
}

function createRig() {
  const entries = [];
  const listeners = new Map();
  const timers = new Map();
  const rafs = [];
  let seq = 1;
  let tops = [];
  let total = 0;

  function relayout() {
    tops = [];
    let top = 0;
    for (const e of entries) {
      tops.push(top);
      top += e.row.realH;
    }
    total = top;
  }
  relayout();

  const container = {
    clientHeight: VIEW_H,
    clientWidth: 1000,
    _scrollTop: 0,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const l = listeners.get(type);
      if (l) {
        const i = l.indexOf(fn);
        if (i >= 0) l.splice(i, 1);
      }
    },
    querySelectorAll(sel) {
      return sel === '.message-row' ? entries.map((e) => e.row) : [];
    },
    querySelector(sel) {
      return sel === '.message-row' ? (entries[0] && entries[0].row) || null : null;
    },
  };
  Object.defineProperty(container, 'scrollTop', {
    get() { return Math.min(container._scrollTop, Math.max(0, total - VIEW_H)); },
    set(v) {
      container._scrollTop = Math.max(0, Math.min(Number(v) || 0, Math.max(0, total - VIEW_H)));
    },
  });
  Object.defineProperty(container, 'scrollHeight', { get() { return Math.max(total, VIEW_H); } });

  // app-core 的 container 引用 = document.getElementById('chat-container')。
  const elements = new Map();
  const elementStub = (id) => ({
    id, innerHTML: '', textContent: '', style: {},
    classList: makeClassList(), dataset: {},
    clientHeight: 0, clientWidth: 0, scrollHeight: 0, scrollTop: 0, parentElement: null,
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

  const fakeTimers = {
    setTimeout(callback) { const id = seq++; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
    requestAnimationFrame(callback) { const id = seq++; rafs.push({ id, callback }); return id; },
    cancelAnimationFrame(id) {
      const i = rafs.findIndex((r) => r.id === id);
      if (i >= 0) rafs.splice(i, 1);
    },
  };

  return {
    entries, container, document, fakeTimers,
    addEntry(e) {
      const idx = entries.length;
      entries.push(e);
      Object.defineProperty(e.row, 'offsetTop', { get: () => tops[idx] });
      Object.defineProperty(e.row, 'offsetHeight', { get: () => e.row.realH });
      relayout();
    },
    rowTop: (i) => tops[i],
    scrollHeight: () => Math.max(total, VIEW_H),
    fireScroll() {
      (listeners.get('scroll') || []).slice().forEach((fn) => fn());
    },
    pumpFrame() {
      const queued = rafs.splice(0);
      queued.forEach(({ callback }) => callback());
    },
    flushTimers() {
      const pending = [...timers.values()];
      timers.clear();
      pending.forEach((cb) => cb());
    },
    cardsCvHidden: (e) => e.cards.length > 0 && e.cards.every((c) => c.classList.contains('process-cv-hidden')),
  };
}

/**
 * classic bootstrap 提供 container / 聊天表面状态；ESM 侧真实 import。
 * `followLatestEnabled` 是 app-core 的状态 owner，经真实 host 写入。
 */
async function withHarness(fn) {
  const rig = createRig();
  const globals = {
    document: rig.document,
    // classic 晚绑定面（生产：chat-viewport / chat-renderer 顶层函数）。
    runWithSuppressedChatViewportObservers: (callback) => callback(),
    syncRowCollapseState() {},
  };
  return withP2EsmCase({
    classic: (sandbox) => {
      Object.assign(sandbox, rig.fakeTimers);
      // index.html 真实加载序：分发器 → i18n → app-core。
      sandbox.loadSource('public/src/modules/action-dispatcher.js');
      // i18n 已迁 ESM（P4）：t 桥键由 createFrontendSandbox 自动装载，见 test/helpers/install-i18n.js
      prepareEsmModules(sandbox, APP_CORE_DOMAIN);
    },
    globals,
  }, async (c) => {
    const surface = c.window.createP2BootstrapChatSurfaceHost();
    surface.showChatProcess = true;
    surface.followLatestEnabled = false;
    const mod = await c.load(LAZY_TOOL_CONTENT);
    return fn({
      ...rig, c, surface, mod,
      setWindowingDisabled: (disabled) => mod.setProcessWindowingDisabled(disabled),
      apply: (fromIndex) => mod.applyProcessDistance(rig.container, fromIndex),
    });
  });
}

test('background streaming patch keeps the cv window at the user viewport (virtualized tier)', async () => {
  await withHarness((h) => {
    const N = 320;
    for (let i = 0; i < N; i++) h.addEntry(makeEntry(i));
    h.setWindowingDisabled(false); // 虚拟化分级（超节点预算的长会话）
    h.apply(); // landing：窗口锚定末行

    // 前提：landing 后远离末行的调用卡处于 cv 占位态
    assert.equal(h.cardsCvHidden(h.entries[21]), true);

    // 用户大跳上翻到第 20 行：scroll → rAF（大跳静默）→ scroll-stop settle 全量重开窗
    h.container.scrollTop = h.rowTop(20);
    h.fireScroll();
    h.pumpFrame();
    h.flushTimers();
    assert.equal(h.cardsCvHidden(h.entries[21]), false, '用户视口附近的调用卡应被揭示');
    assert.equal(h.cardsCvHidden(h.entries[251]), true, '末行区域此时是远处，保持 cv 占位');

    // 流式追加（probe 事件 → appendNewMessages → applyProcessDistance(root, fromIndex)）
    const appended = makeEntry(N + 1); // 新末行附近的 assistant（奇数 → 带调用卡）
    h.addEntry(makeEntry(N));
    h.addEntry(appended);
    h.apply(N);

    assert.equal(h.cardsCvHidden(h.entries[21]), false,
      '背景补丁不得把窗口搬到末行：用户正在阅读的行被 cv 隐藏即"空 assistant 消息"泄漏');
    assert.equal(h.cardsCvHidden(appended), true,
      '远离用户视口的新末行按窗口化契约保持占位态');
  });
});

test('background patch at the bottom keeps new tail rows revealed (streaming follow)', async () => {
  await withHarness((h) => {
    const N = 320;
    for (let i = 0; i < N; i++) h.addEntry(makeEntry(i));
    h.setWindowingDisabled(false);
    h.container.scrollTop = h.scrollHeight(); // 会话打开在底部（跟随）
    h.apply(); // landing：窗口锚定末行
    assert.equal(h.cardsCvHidden(h.entries[N - 1]), false, 'landing 后末行可见');

    // 流式追加 + 跟随滚动到新底部，再触发背景补丁
    const appended = makeEntry(N + 1); // assistant（奇数 → 带调用卡）
    h.addEntry(makeEntry(N));
    h.addEntry(appended);
    h.container.scrollTop = h.scrollHeight();
    h.apply(N);

    assert.equal(h.cardsCvHidden(appended), false,
      '底部流式时新末行必须保持揭示（跟随模式不得退化为占位态）');
  });
});
