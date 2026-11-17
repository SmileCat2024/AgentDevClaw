/**
 * P2 第二波批次 1：chat-row-visibility / lazy-tool-content（ESM 化后的真实行为、
 * 异步过期语义与兼容桥面）。
 *
 * 隔离纪律（每个 case 独立可跑，不依赖文件内顺序）：
 *   - 两个实现模块与共享模式模块构成一张固定的真实模块图（host 装载时求值一次，
 *     defineKey 唯一注册制），因此不重装模块，改为每个 case 前后**完整 reset 真实
 *     私有状态**——lazy 的窗口缓存/滚动监听/定时器、rows 的 entries/byRow/raf、
 *     共享分级标志、注入容器 DOM 与记录数组全部复位；
 *   - 断言只走公开路径（导出函数 / 真实 DOM 事件 / 桥键），不读私有变量；
 *   - case 结束（含抛错）在 finally 里复原全局补丁、监听与在飞帧，
 *     无关数组不留残留。
 * `node --test --test-name-pattern='<单个用例名>'` 亦必须通过。
 *
 * 依赖注入面：window.createP2BootstrapDomHost / createP2BootstrapChatSurfaceHost
 * （bootstrap 适配对象）、window.runWithSuppressedChatViewportObservers /
 * syncRowCollapseState / settleAllRowCollapseStates / captureChatViewportAnchor /
 * applyChatViewportAnchor（classic 晚绑定函数）、globalThis 的 rAF / CSS。
 */
import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { installBrowserStubs, loadModuleOnce } from './helpers/esm-module-loader.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const HOST = 'public/src/modules/p2-w2-1-chat-windowing-host.js';
const LAZY = 'public/src/modules/lazy-tool-content.js';
const ROWS = 'public/src/modules/chat-row-visibility.js';
const MODE = 'public/src/modules/p2-w2-1-process-windowing-mode.js';
const plainUrl = (relativePath) => pathToFileURL(path.resolve(REPO_ROOT, relativePath)).href;

// ── 最小 DOM 桩 ────────────────────────────────────────────────────

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

function createStyle() {
  const props = new Map();
  return {
    setProperty(name, value) { props.set(name, String(value)); },
    removeProperty(name) { props.delete(name); },
    getPropertyValue(name) { return props.get(name) ?? ''; },
    has(name) { return props.has(name); },
  };
}

function createElement({ classes = [] } = {}) {
  return {
    classList: createClassList(classes),
    style: createStyle(),
    tagName: 'DIV',
    isConnected: true,
    offsetTop: 0,
    offsetHeight: 0,
    contains() { return false; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getBoundingClientRect() {
      return { top: this.offsetTop, bottom: this.offsetTop + this.offsetHeight, height: this.offsetHeight };
    },
  };
}

/** 消息行桩：过程元素挂在 els 上（行缓存面），tool 行直接挂行。 */
function createRow({ top = 0, height = 100, classes = ['message-row', 'assistant'], els = [] } = {}) {
  const row = createElement({ classes });
  row.offsetTop = top;
  row.offsetHeight = height;
  row.querySelector = (selector) => (selector === '.message-content' ? createElement() : null);
  row.querySelectorAll = (selector) => (selector === '.reasoning-block, .tool-call-container' ? els : []);
  row.closest = (selector) => (selector === '.message-row' ? row : null);
  row.getBoundingClientRect = () => ({ top: row.offsetTop, bottom: row.offsetTop + row.offsetHeight, height: row.offsetHeight });
  return row;
}

function createContainer() {
  const listeners = new Map();
  const container = createElement({ classes: ['chat-container'] });
  container.rows = [];
  container.extraEls = [];
  container.scrollTop = 0;
  container.scrollHeight = 0;
  container.clientHeight = 600;
  container.clientWidth = 900;
  container.parentElement = null;
  container.addEventListener = (type, listener, options) => {
    const map = listeners.get(type) || new Map();
    map.set(listener, options);
    listeners.set(type, map);
  };
  container.removeEventListener = (type, listener) => { listeners.get(type)?.delete(listener); };
  container.listenerCount = (type) => listeners.get(type)?.size ?? 0;
  container.dispatch = (type, event = {}) => {
    for (const listener of [...(listeners.get(type)?.keys() || [])]) listener(event);
  };
  container.querySelector = (selector) => (selector === '.message-row' ? (container.rows[0] || null) : null);
  // 复刻实现用到的四类查询：整行列表、预隐藏元素、过程元素集合、system/tool 行。
  container.querySelectorAll = (selector) => {
    if (selector === '.message-row') return container.rows;
    if (selector.includes('process-hidden')) {
      return container.extraEls.filter((el) => el.classList.contains('process-hidden'));
    }
    if (selector.includes('.reasoning-block')) {
      const rows = container.rows.filter((row) => row.classList.contains('system') || row.classList.contains('tool'));
      return [...rows, ...container.extraEls.filter((el) => el.classList.contains('reasoning-block'))];
    }
    return [];
  };
  return container;
}

function resetContainer(container) {
  container.rows = [];
  container.extraEls = [];
  container.scrollTop = 0;
  container.scrollHeight = 0;
  container.clientHeight = 600;
  container.clientWidth = 900;
}

/**
 * process-cv-hidden / process-hidden 的实际承载者：tool 行挂在行上，assistant
 * 行挂在过程子元素上（lazy-tool-content 的 rowCache 面）。断言按同口径读。
 */
function cvClass(row, className) {
  if (row.classList.contains('tool')) return row.classList.contains(className);
  const els = row.querySelectorAll('.reasoning-block, .tool-call-container');
  return els.length > 0 && els.every((el) => el.classList.contains(className));
}
const cvHidden = (row) => cvClass(row, 'process-cv-hidden');

function fillRows(container, count, { height = 100 } = {}) {
  container.rows = Array.from({ length: count }, (_, index) => createRow({
    top: index * height,
    height,
    els: [createElement({ classes: ['reasoning-block'] })],
  }));
  container.scrollHeight = count * height;
  container.extraEls = container.rows.flatMap((row) => row.querySelectorAll('.reasoning-block, .tool-call-container'));
  return container.rows;
}

// ── 注入面与 case 生命周期 ──────────────────────────────────────────

let cleanupGlobals;
let domHost;
let surfaceHost;
let windowingContainer;
let rafQueue;
let foldedRows;
let settledRoots;
let appliedAnchors;
let capturedAnchor;
let lazy;
let rows;
let mode;

function installCaseGlobals() {
  domHost = {
    container: null,
    followLatestButton: null,
    chatProcessToggle: null,
  };
  surfaceHost = {
    CHAT_PROCESS_VISIBILITY_KEY: 'agentdev-chat-process',
    showChatProcess: true,
    followLatestEnabled: false,
    suppressFollowScrollEvent: false,
  };
  rafQueue = [];
  foldedRows = [];
  settledRoots = [];
  appliedAnchors = [];
  capturedAnchor = null;

  cleanupGlobals = installBrowserStubs({
    window: {
      createP2BootstrapDomHost: () => domHost,
      createP2BootstrapChatSurfaceHost: () => surfaceHost,
      // classic 晚绑定面（chat-viewport / chat-renderer 顶层函数）
      runWithSuppressedChatViewportObservers(work) { work(); },
      syncRowCollapseState(row) { foldRow(row); },
      settleAllRowCollapseStates(root) { settledRoots.push(root); },
      captureChatViewportAnchor() { capturedAnchor = { top: domHost.container.scrollTop }; return capturedAnchor; },
      applyChatViewportAnchor(anchor) { appliedAnchors.push(anchor); },
    },
  });
  globalThis.requestAnimationFrame = (cb) => { rafQueue.push(cb); return rafQueue.length; };
  globalThis.cancelAnimationFrame = () => {};
  globalThis.CSS = { supports: () => true };
}

function uninstallCaseGlobals() {
  cleanupGlobals();
  delete globalThis.requestAnimationFrame;
  delete globalThis.cancelAnimationFrame;
  delete globalThis.CSS;
}

let foldTargetByRow = new Map();

/**
 * 折叠桩：只折叠本 case 显式登记的行（真实实现里手动展开 / 已折叠的行高度不变，
 * 折叠动作由 chat-renderer 同步完成）。
 */
function foldRow(row) {
  foldedRows.push(row);
  const target = foldTargetByRow.get(row);
  if (target !== undefined) row.offsetHeight = target;
}

/**
 * 完整复位真实私有状态：两个实现模块的窗口缓存/entries/监听/定时器、共享分级
 * 标志、注入容器 DOM、记录数组与在飞帧。case 前后各跑一次，失败也不留残留。
 */
function resetWindowingState() {
  surfaceHost.showChatProcess = true;
  surfaceHost.followLatestEnabled = false;
  mode.processWindowingMode.disabled = false;
  mode.processWindowingMode.frozen = false;
  // 释放 lazy 的缓存与滚动监听（幂等），并消费掉可能残留的 pre-toggle 视口索引，
  // 否则残留值会让下一个 case 的 landing 窗口锚错行。
  lazy.clearProcessDistance(windowingContainer);
  lazy.precomputeViewportIdx();
  lazy.applyProcessDistance(windowingContainer);
  lazy.clearProcessDistance(windowingContainer);
  rows.clearMeasuredChatRows();
  resetContainer(windowingContainer);
  rafQueue.length = 0;
  foldedRows.length = 0;
  settledRoots.length = 0;
  appliedAnchors.length = 0;
  capturedAnchor = null;
  foldTargetByRow = new Map();
}

/** 每个 case 的完整夹具：reset → 跑 → finally 复位。 */
async function withP2EsmCase(fn) {
  resetWindowingState();
  try {
    return await fn({ container: windowingContainer, lazy, rows, mode, domHost, surfaceHost });
  } finally {
    resetWindowingState();
  }
}

before(async () => {
  installCaseGlobals();
  windowingContainer = createContainer();
  domHost.container = windowingContainer;
  await loadModuleOnce('public/src/modules/kernel-state.js', { installGlobals: false });
  // host 只装载一次：7 个桥键的 defineKey 唯一注册制（实现模块本身零桥）
  await loadModuleOnce(HOST, { installGlobals: false });
  lazy = await import(plainUrl(LAZY));
  rows = await import(plainUrl(ROWS));
  mode = await import(plainUrl(MODE));
});

after(() => {
  uninstallCaseGlobals();
});

// ── chat-row-visibility ────────────────────────────────────────────

test('chat-row-visibility：< 200 行时不启用整行窗口（既有阈值语义）', async () => {
  await withP2EsmCase(async ({ container, rows: rowApi, mode: modeApi }) => {
    modeApi.processWindowingMode.disabled = true;
    const list = fillRows(container, 10);
    rowApi.refreshMeasuredChatRows('render-full');
    assert.equal(list.some((row) => row.classList.contains('chat-row-distant')), false);
  });
});

test('chat-row-visibility：滚动窗口隐藏远处行并保留实测行高，滚回后揭示', async () => {
  await withP2EsmCase(async ({ container, rows: rowApi, mode: modeApi }) => {
    modeApi.processWindowingMode.disabled = true;
    const list = fillRows(container, 250);
    container.scrollTop = 0;

    rowApi.refreshMeasuredChatRows('render-full');
    assert.equal(list[0].classList.contains('chat-row-distant'), false);
    assert.equal(list[40].classList.contains('chat-row-distant'), true, '远处行必须隐藏');
    assert.equal(list[40].style.getPropertyValue('--chat-row-height'), '100px',
      '隐藏前写入实测高度，避免滚动条失真');

    container.scrollTop = 20000;
    container.dispatch('scroll');
    assert.equal(rafQueue.length, 1, '滚动帧必须合并到单个 rAF');
    rafQueue.shift()();
    assert.equal(list[200].classList.contains('chat-row-distant'), false, '进入窗口的行必须揭示');
    assert.equal(list[200].style.has('--chat-row-height'), false, '揭示时清掉实测高度覆盖');
    assert.equal(list[0].classList.contains('chat-row-distant'), true, '离开窗口的行必须隐藏');
    assert.equal(list[40].classList.contains('chat-row-distant'), true, '窗口外行保持隐藏');
  });
});

test('chat-row-visibility：revealMeasuredChatRow 按行元素查表揭示并清除高度样式', async () => {
  await withP2EsmCase(async ({ container, rows: rowApi, mode: modeApi }) => {
    modeApi.processWindowingMode.disabled = true;
    const list = fillRows(container, 250);
    container.scrollTop = 0;
    rowApi.refreshMeasuredChatRows('render-full');
    const hidden = list[100];
    assert.equal(hidden.classList.contains('chat-row-distant'), true, '前置：该行必须处于隐藏态');
    assert.equal(hidden.style.has('--chat-row-height'), true, '前置：隐藏态带实测高度覆盖');

    // chat-renderer 的真实调用形态：传行元素（el.closest('.message-row')）
    rowApi.revealMeasuredChatRow(hidden);
    assert.equal(hidden.classList.contains('chat-row-distant'), false, '按行揭示必须移除隐藏类');
    assert.equal(hidden.style.has('--chat-row-height'), false, '按行揭示必须清掉高度覆盖');

    // 未知行（未建 entry）是 no-op，不得抛错
    assert.doesNotThrow(() => rowApi.revealMeasuredChatRow(createRow({ top: 999999 })));

    // 重复揭示幂等
    assert.doesNotThrow(() => rowApi.revealMeasuredChatRow(hidden));
    assert.equal(hidden.classList.contains('chat-row-distant'), false);
  });
});

test('chat-row-visibility：焦点所在行永不隐藏；hide 模式与冻结态不参与窗口', async () => {
  await withP2EsmCase(async ({ container, rows: rowApi, mode: modeApi, surfaceHost: surface }) => {
    modeApi.processWindowingMode.disabled = true;
    const list = fillRows(container, 250);
    const focused = list[200];
    const activeElement = { id: 'focused' };
    globalThis.document.activeElement = activeElement;
    focused.contains = (node) => node === activeElement;

    rowApi.refreshMeasuredChatRows('render-full');
    assert.equal(focused.classList.contains('chat-row-distant'), false, '焦点行不得隐藏');

    const snapshot = list.map((row) => row.classList.contains('chat-row-distant'));
    modeApi.processWindowingMode.frozen = true;
    rowApi.refreshMeasuredChatRows('append');
    assert.deepEqual(list.map((row) => row.classList.contains('chat-row-distant')), snapshot,
      '冻结期间 refresh 必须整段返回');

    modeApi.processWindowingMode.frozen = false;
    surface.showChatProcess = false;
    rowApi.refreshMeasuredChatRows('render-full');
    assert.equal(list.some((row) => row.classList.contains('chat-row-distant')), false,
      'hide 模式走 clear()：已隐藏行全部揭示，且不再藏新行');
  });
});

test('chat-row-visibility：append 只测新增行的几何（不重建全量 entries）', async () => {
  await withP2EsmCase(async ({ container, rows: rowApi, mode: modeApi }) => {
    modeApi.processWindowingMode.disabled = true;
    const list = fillRows(container, 250);
    const measured = new Map();
    for (const [index, row] of list.entries()) {
      const original = row.getBoundingClientRect;
      row.getBoundingClientRect = () => { measured.set(index, (measured.get(index) || 0) + 1); return original(); };
    }

    rowApi.refreshMeasuredChatRows('render-full');
    measured.clear();
    const appended = createRow({ top: 250 * 100, height: 100 });
    let appends = 0;
    appended.getBoundingClientRect = () => {
      appends += 1;
      return { top: appended.offsetTop, bottom: appended.offsetTop + 100, height: 100 };
    };
    container.rows = [...list, appended];
    container.scrollHeight = 251 * 100;
    rowApi.refreshMeasuredChatRows('append');

    assert.equal(appends, 1, '追加行必须测量一次');
    assert.equal(measured.size, 0, '既有行在 append 路径上不得重新测量');
  });
});

test('chat-row-visibility：宽度变化在非跟随模式按行锚点恢复', async () => {
  await withP2EsmCase(async ({ container, rows: rowApi, mode: modeApi }) => {
    modeApi.processWindowingMode.disabled = true;
    fillRows(container, 250);
    rowApi.refreshMeasuredChatRows('render-full');

    container.clientWidth = 640;
    rowApi.refreshMeasuredChatRows('width-settled');
    assert.deepEqual(capturedAnchor, { top: 0 }, '宽度变化必须捕获行锚点');
    assert.equal(appliedAnchors.length, 1, '锚点必须在测量写回后应用');
  });
});

// ── lazy-tool-content ──────────────────────────────────────────────

test('lazy-tool-content：虚拟化分级按视口开窗，滚动监听只挂一次，clear 后还原 hide 预隐藏', async () => {
  await withP2EsmCase(async ({ container, lazy: lazyApi, mode: modeApi }) => {
    modeApi.processWindowingMode.disabled = false;
    const list = fillRows(container, 400);

    const baseline = container.listenerCount('scroll');
    lazyApi.applyProcessDistance(container);
    assert.equal(cvHidden(list[0]), true, '窗口外上方行必须 cv 隐藏');
    assert.equal(cvHidden(list[399]), false, '落位视口（末行）必须可见');
    assert.equal(container.listenerCount('scroll'), baseline + 1, 'windowing 滚动监听只挂一次');
    lazyApi.applyProcessDistance(container);
    assert.equal(container.listenerCount('scroll'), baseline + 1);

    lazyApi.clearProcessDistance(container);
    assert.equal(container.listenerCount('scroll'), baseline, 'clear 必须摘除滚动监听');
    assert.equal(list.every((row) => !cvHidden(row)), true);
    assert.equal(cvClass(list[0], 'process-hidden'), true, '虚拟化分级 clear 走 hide 预隐藏');
  });
});

test('lazy-tool-content：全渲染分级揭示全部行并在落位时做一次整会话折叠', async () => {
  await withP2EsmCase(async ({ container, lazy: lazyApi, mode: modeApi }) => {
    modeApi.processWindowingMode.disabled = false;
    const list = fillRows(container, 120);

    lazyApi.setProcessWindowingDisabled(true);
    lazyApi.applyProcessDistance(container);
    assert.equal(modeApi.processWindowingMode.disabled, true, '分级开关经共享哑状态生效');
    assert.equal(list.some((row) => cvHidden(row)), false);
    assert.deepEqual(settledRoots, [container], '全渲染落位必须 settle 整会话一次');
  });
});

test('lazy-tool-content：视口上方折叠按高度差补偿 scrollTop（跟随模式不补偿）', async () => {
  await withP2EsmCase(async ({ container, lazy: lazyApi, mode: modeApi, surfaceHost: surface }) => {
    modeApi.processWindowingMode.disabled = false;
    const list = [0, 300, 600, 900, 1200].map((top) => createRow({ top, height: 300 }));
    container.rows = list;
    container.extraEls = [];
    container.scrollHeight = 1500;
    container.scrollTop = 0;
    lazyApi.applyProcessDistance(container); // 落位

    // 两小步滚到 300（每步 delta 150 < clientHeight*0.4，走 motion 帧而非大跳挂起）
    foldTargetByRow.set(list[0], 40);
    container.scrollTop = 150;
    container.dispatch('scroll');
    rafQueue.splice(0).forEach((cb) => cb());
    container.scrollTop = 300;
    container.dispatch('scroll');
    rafQueue.splice(0).forEach((cb) => cb());

    assert.equal(list[0].offsetHeight, 40, '视口上方行必须折叠');
    assert.equal(foldedRows.includes(list[0]), true);
    assert.equal(container.scrollTop, 40, '折叠移除的内容高度必须从 scrollTop 里扣回');

    // 跟随模式：底部锁定会吸收高度变化，不做补偿
    resetWindowingState();
    const followList = [0, 300, 600, 900, 1200].map((top) => createRow({ top, height: 300 }));
    container.rows = followList;
    container.extraEls = [];
    container.scrollHeight = 1500;
    container.scrollTop = 0;
    lazyApi.applyProcessDistance(container);
    surface.followLatestEnabled = true;
    foldTargetByRow.set(followList[0], 40);
    container.scrollTop = 150;
    container.dispatch('scroll');
    rafQueue.splice(0).forEach((cb) => cb());
    container.scrollTop = 300;
    container.dispatch('scroll');
    rafQueue.splice(0).forEach((cb) => cb());
    assert.equal(followList[0].offsetHeight, 40, '前置：跟随模式下同样折叠');
    assert.equal(container.scrollTop, 300, '跟随模式不得改写 scrollTop');
  });
});

test('lazy-tool-content：append 增量路径不重建旧行缓存（全路径才清 process-hidden）', async () => {
  await withP2EsmCase(async ({ container, lazy: lazyApi, mode: modeApi }) => {
    modeApi.processWindowingMode.disabled = true;
    const staleReasoning = createElement({ classes: ['reasoning-block', 'process-hidden'] });
    const first = createRow({ top: 0, els: [staleReasoning] });
    container.rows = [first];
    container.extraEls = [staleReasoning];
    container.scrollHeight = 100;

    lazyApi.applyProcessDistance(container);
    assert.equal(staleReasoning.classList.contains('process-hidden'), false, '全量路径清掉预隐藏');

    const second = createRow({ top: 100 });
    const staleAgain = createElement({ classes: ['reasoning-block', 'process-hidden'] });
    first.querySelectorAll = (selector) => (selector === '.reasoning-block, .tool-call-container' ? [staleAgain] : []);
    container.rows = [first, second];
    container.scrollHeight = 200;

    lazyApi.applyProcessDistance(container, 1);
    assert.equal(staleAgain.classList.contains('process-hidden'), true,
      'append 增量路径只处理 [fromIndex, end)，不回头改旧行');
  });
});

test('lazy-tool-content：clear 取消在飞 scroll-stop 定时器（过期 settle 不得回写）', async () => {
  await withP2EsmCase(async ({ container, lazy: lazyApi, mode: modeApi }) => {
    modeApi.processWindowingMode.disabled = false;
    fillRows(container, 400);
    lazyApi.applyProcessDistance(container);
    const foldedBefore = foldedRows.length;

    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      container.scrollTop = 30000;
      container.dispatch('scroll'); // 大跳 → 只在 release（150ms 后）settle
      lazyApi.clearProcessDistance(container);
      mock.timers.tick(400);
      assert.equal(foldedRows.length, foldedBefore, 'clear 后的过期 settle 不得再折叠/写回');
      assert.equal(container.scrollTop, 30000, 'clear 不得因过期 settle 改写 scrollTop');
    } finally {
      mock.timers.reset();
    }
  });
});

test('lazy-tool-content：freeze 期间滚动链静默，unfreeze 一次收敛到新窗口', async () => {
  await withP2EsmCase(async ({ container, lazy: lazyApi, mode: modeApi }) => {
    modeApi.processWindowingMode.disabled = false;
    const list = fillRows(container, 400);
    lazyApi.applyProcessDistance(container);
    assert.equal(cvHidden(list[399]), false);

    lazyApi.freezeProcessWindowing();
    container.scrollTop = 20000;
    container.dispatch('scroll');
    rafQueue.splice(0).forEach((cb) => cb());
    assert.equal(cvHidden(list[399]), false, '冻结期间窗口不得移动');

    lazyApi.unfreezeProcessWindowing();
    assert.equal(cvHidden(list[399]), true, '解冻后窗口收敛到新位置');
    assert.equal(cvHidden(list[200]), false);
  });
});

test('lazy-tool-content：precomputeViewportIdx 作为落位窗口的视口锚（不是末行锚定）', async () => {
  await withP2EsmCase(async ({ container, lazy: lazyApi, mode: modeApi }) => {
    modeApi.processWindowingMode.disabled = false;
    const list = fillRows(container, 400);
    container.scrollTop = 2500;

    lazyApi.precomputeViewportIdx(); // 视口首行 = 25（bottom 2600 > 2500）
    lazyApi.applyProcessDistance(container);
    assert.equal(cvHidden(list[25]), false, '记录的视口行必须在落位窗口内');
    assert.equal(cvHidden(list[300]), true, '窗口外的远下方行必须隐藏');

    lazyApi.clearProcessDistance(container);
    lazyApi.applyProcessDistance(container);
    assert.equal(cvHidden(list[399]), false, '无记录点时落位锚定末行');
    assert.equal(cvHidden(list[25]), true);
  });
});

// ── 兼容桥（classic 消费面）─────────────────────────────────────────

test('桥：7 个键注册并被认领，classic 写入经 setter 转发、读回同一实现', async () => {
  await withP2EsmCase(async ({ lazy: lazyApi, rows: rowApi }) => {
    assert.equal(window.clearProcessDistance, lazyApi.clearProcessDistance);
    assert.equal(window.freezeProcessWindowing, lazyApi.freezeProcessWindowing);
    assert.equal(window.unfreezeProcessWindowing, lazyApi.unfreezeProcessWindowing);
    assert.equal(window.runLandingCollapseScan, lazyApi.runLandingCollapseScan);
    assert.equal(window.setProcessWindowingDisabled, lazyApi.setProcessWindowingDisabled);
    assert.equal(window.refreshMeasuredChatRows, rowApi.refreshMeasuredChatRows);
    assert.equal(window.revealMeasuredChatRow, rowApi.revealMeasuredChatRow);
    assert.deepEqual(window.KernelState.stats(), { registeredKeys: 7, claimedKeys: 7 });

    try {
      // classic 写方经 setter 转发；桥的 getter 是 live 的——写一个函数后，
      // 后续经 window 的调用必须调到新函数（不是注册时的快照）
      const calls = [];
      const replacement = (reason) => { calls.push(reason); };
      window.refreshMeasuredChatRows = replacement;
      assert.equal(window.refreshMeasuredChatRows, replacement, 'claim 后的写必须落进桥状态');
      window.refreshMeasuredChatRows('classic-write');
      assert.deepEqual(calls, ['classic-write'], '桥读必须取到 classic 写入的 live 值');
    } finally {
      window.refreshMeasuredChatRows = rowApi.refreshMeasuredChatRows;
    }
    assert.equal(window.refreshMeasuredChatRows, rowApi.refreshMeasuredChatRows, '还原后读回实现');
  });
});

test('桥：applyProcessDistance / precomputeViewportIdx 已注销——只经命名导出可达', async () => {
  await withP2EsmCase(async ({ lazy: lazyApi }) => {
    // 两个键的唯一消费方 chat-process-visibility 已 import 命名导出，classic 侧
    // 零消费面 → 桥键撤除；不恢复同名 window 桥，也不复制第二实现。
    for (const key of ['applyProcessDistance', 'precomputeViewportIdx']) {
      assert.equal(Object.getOwnPropertyDescriptor(window, key), undefined,
        `${key} 的桥已注销，不得留在 window 上`);
      assert.equal(key in window, false, `${key} 不得以任何形态挂在 window 上`);
      assert.equal(typeof lazyApi[key], 'function', `${key} 必须仍是命名导出`);
    }
  });
});

test('桥：私有 helper 与已收敛键不上桥（无新增散装 window 暴露）', async () => {
  await withP2EsmCase(async ({ lazy: lazyApi, rows: rowApi, mode: modeApi }) => {
    for (const privateKey of ['_applyWindow', '_runCollapseScan', '_onScrollForWindowing', '_cachedRows',
      '_windowingDisabled', '_windowingFrozen', 'entries', 'WINDOW_ABOVE', 'processWindowingMode',
      'clearMeasuredChatRows']) {
      assert.equal(privateKey in window, false, `${privateKey} 不得挂在 window 上`);
    }
    // 导出面固定：模块只暴露显式命名导出
    assert.equal(typeof lazyApi.applyProcessDistance, 'function');
    assert.equal(typeof rowApi.revealMeasuredChatRow, 'function');
    assert.equal(typeof modeApi.processWindowingMode, 'object');
  });
});
