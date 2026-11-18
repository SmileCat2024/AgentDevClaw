/**
 * P4 T2 批次：聊天视口（chat-viewport）转 ESM 后的生命周期契约。
 *
 * 迁移前本文件钉住的是「chat-viewport 必须保持 classic 唯一实现」——P4 时序切换
 * 把首屏渲染链改由 `boot.js` 在模块相触发之后，那条约束解除，本批按配方常规转换
 * （审计见表头与 chat-viewport.js 头注）。本文件因此改写为钉住迁移后的等价契约：
 *
 *   1. 模块相首屏：chat-viewport 先于 boot 求值，重放首屏渲染链（app-ui /
 *      chat-renderer / chat-context-bar 的同步序列）必须留下真实的观察者 / 结算 /
 *      跟随状态——与迁移前 classic 相同一步到位的行为等价。
 *   2. 兼容面：仍 classic 的消费方（app-ui / app-core）与清单外的
 *      已迁 ESM 消费方经 `window.<fn>` 桥键晚绑定到同一实现；桥键转发到模块导出
 *      本文件逐个钉住。
 *   3. 手动滚动优先级、锚点族语义、过期结算 / 过期锚点保存拒绝、观察者静默窗、
 *      跟随按钮避让定位：行为逐条保持。
 *
 * 装载路线：`withP2EsmCase`（真实 classic 沙箱 + 真实 ESM 图，每个用例一份
 * window）。classic 相只装真实 app-core.js（视口状态 owner 与两套 bootstrap host
 * 工厂）；chat-viewport 走 async 相 `c.load` 真实 import，app-ui 侧只 stub 本域实际
 * 触达的两个判定函数（`isChatSurfaceActive` / `shouldRenderWorkspaceSurface`）与
 * escapeHtml。沙箱内计时器 / rAF / 时钟由本文件接成确定性队列（按真实时序驱动，
 * 不 sleep；`Date` 保留构造器，仅 mock `now`）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { t as realT } from '../public/src/i18n.js';

const APP_CORE = 'public/src/app-core.js';
const CHAT_VIEWPORT = 'public/src/modules/chat-viewport.js';
const BOOTSTRAP_DOM = 'public/src/modules/p2-bootstrap-dom.js';
const BOOTSTRAP_CHAT_SURFACE = 'public/src/modules/p2-bootstrap-chat-surface.js';

// ── 最小 DOM ───────────────────────────────────────────────────────

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
  };
}

function createStyle() {
  const props = new Map();
  return {
    setProperty(name, value) { props.set(name, String(value)); },
    removeProperty(name) { props.delete(name); },
    getPropertyValue(name) { return props.get(name) ?? ''; },
  };
}

function createElement(tagName = 'DIV') {
  const listeners = new Map();
  const el = {
    tagName: tagName.toUpperCase(),
    classList: createClassList(),
    style: createStyle(),
    dataset: {},
    children: [],
    offsetTop: 0,
    offsetHeight: 0,
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    clientWidth: 900,
    innerWidth: 1280,
    _html: '',
    get innerHTML() { return el._html; },
    set innerHTML(value) { el._html = String(value); },
    addEventListener(type, listener) {
      const map = listeners.get(type) || new Map();
      map.set(listener, true);
      listeners.set(type, map);
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    dispatch(type, event = {}) {
      for (const listener of [...(listeners.get(type)?.keys() || [])]) listener.call(el, event);
    },
    listenerCount(type) { return listeners.get(type)?.size ?? 0; },
    appendChild(child) { el.children.push(child); return child; },
    insertAdjacentHTML() {},
    setAttribute() {},
    removeAttribute() {},
    contains(node) { return node === el || el.children.includes(node); },
    closest() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getBoundingClientRect() {
      return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: el._rectHeight || 0 };
    },
  };
  return el;
}

/**
 * 视口容器：scrollTop 按浏览器语义钳制到 [0, scrollHeight-clientHeight]，
 * 行集合由用例显式挂载。
 */
function createChatContainer() {
  const container = createElement('DIV');
  container.classList.add('chat-container');
  container.clientHeight = 600;
  container._scrollHeight = 600;
  container.rows = [];
  container.dispatchFull = [];
  Object.defineProperty(container, 'scrollHeight', {
    get() { return container._scrollHeight; },
    set(value) { container._scrollHeight = Number(value) || 0; },
  });
  let _top = 0;
  Object.defineProperty(container, 'scrollTop', {
    get() { return _top; },
    set(value) {
      const max = Math.max(0, container._scrollHeight - container.clientHeight);
      _top = Math.max(0, Math.min(Number(value) || 0, max));
      if (container.onWrite) container.onWrite(_top);
    },
  });
  container.querySelectorAll = (selector) => (selector === '.message-row' ? container.rows : []);
  // 与真实调用一致地支持合并选择器（chat-viewport 用
  // `.empty-welcome, .chat-loading` 判断空态），按逗号拆分逐个匹配。
  container.querySelector = (selector) => {
    const classes = String(selector).split(',').map((part) => part.trim()).filter(Boolean);
    for (const cls of classes) {
      if ((cls === '.empty-welcome' || cls === '.chat-loading')
        && container._html.includes(cls.slice(1))) {
        return createElement('DIV');
      }
    }
    return null;
  };
  return container;
}

// ── observer / 时钟 / 计时器桩 ─────────────────────────────────────

class CapturingObserver {
  static instances = [];
  constructor(callback) {
    this.callback = callback;
    this.targets = [];
    CapturingObserver.instances.push(this);
  }
  observe(target) {
    if (!this.targets.includes(target)) this.targets.push(target);
  }
  unobserve(target) {
    this.targets = this.targets.filter((item) => item !== target);
  }
  disconnect() { this.targets = []; }
  fire(entries) { this.callback(entries, this); }
}

class CapturingMutationObserver extends CapturingObserver {}
class CapturingResizeObserver extends CapturingObserver {}

function createClock() {
  return { now: 1_000_000 };
}

/**
 * 确定性计时器队列：取代沙箱里的 setTimeout / requestAnimationFrame，
 * 用 `flush` 按到期顺序推进逻辑时钟并执行回调（rAF 视为 0 延迟）。
 */
/** 逻辑时钟 Date：classic 沙箱与 ESM 模块（经验证明 Date.now 是模块内唯一时间源）
 *  必须共用同一份，否则静默窗 / 结算超时类断言会读到真实时间。 */
function createFakeDate(clock) {
  const RealDate = Date;
  function FakeDate(...args) {
    return args.length ? new RealDate(...args) : new RealDate(clock.now);
  }
  FakeDate.prototype = RealDate.prototype;
  Object.setPrototypeOf(FakeDate, RealDate);
  FakeDate.now = () => clock.now;
  return FakeDate;
}

function installTimerQueue(sandbox, clock) {
  const queue = [];
  let seq = 0;
  const push = (callback, delay) => {
    const id = ++seq;
    queue.push({ id, callback, at: clock.now + Math.max(0, Number(delay) || 0) });
    return id;
  };
  const drop = (id) => {
    const index = queue.findIndex((timer) => timer.id === id);
    if (index >= 0) queue.splice(index, 1);
  };
  sandbox.setTimeout = push;
  sandbox.setInterval = push;
  sandbox.clearTimeout = drop;
  sandbox.clearInterval = drop;
  sandbox.requestAnimationFrame = (callback) => push(callback, 0);
  sandbox.cancelAnimationFrame = drop;
  // 保留 Date 构造器与静态方法，只把 now 换成逻辑时钟：视口代码当前只用
  // Date.now()，但夹具不能因此让 `new Date()` / Date.parse 在未来改动中抛错。
  sandbox.Date = createFakeDate(clock);
  return {
    pending: () => queue.length,
    /** 取出最早到期的回调（不执行、不出队后自动取消），用于验证代次守卫。 */
    takeNext() {
      if (!queue.length) return null;
      queue.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = queue.shift();
      clock.now = Math.max(clock.now, next.at);
      return next.callback;
    },
    /** 推进到 `advanceMs` 后执行所有到期的计时器；返回剩余数量。 */
    flush(advanceMs = 0, maxSteps = 200) {
      const target = clock.now + advanceMs;
      let steps = 0;
      while (steps < maxSteps) {
        if (!queue.length) break;
        queue.sort((a, b) => a.at - b.at || a.id - b.id);
        const next = queue[0];
        if (next.at > target) break;
        queue.shift();
        clock.now = Math.max(clock.now, next.at);
        steps += 1;
        next.callback();
      }
      clock.now = Math.max(clock.now, target);
      return queue.length;
    },
  };
}

// ── 夹具 ───────────────────────────────────────────────────────────

function createFixture() {
  CapturingObserver.instances = [];
  const clock = createClock();
  const container = createChatContainer();
  const followLatestButton = createElement('BUTTON');
  followLatestButton.classList.add('hidden');
  const inputHost = createElement('DIV');
  inputHost.id = 'user-input-container';
  const inputCard = createElement('DIV');
  inputCard.classList.add('user-input-card');
  inputCard._rectHeight = 140;
  inputCard.getBoundingClientRect = () => ({ top: 600, bottom: 740, left: 0, right: 900, width: 900, height: 140 });
  inputHost.querySelector = (selector) => (selector === '.user-input-card' ? inputCard : null);
  const mainContent = createElement('DIV');
  mainContent.classList.add('main-content');
  mainContent.clientWidth = 1200;
  mainContent.getBoundingClientRect = () => ({ top: 0, bottom: 740, left: 0, right: 1200, width: 1200, height: 740 });
  // chat-viewport 的 `followLatestButton.closest('.main-content')` 真实路径
  followLatestButton.closest = (selector) => (selector === '.main-content' ? mainContent : null);

  const byId = new Map([
    ['chat-container', container],
    ['follow-latest-btn', followLatestButton],
    ['user-input-container', inputHost],
  ]);
  const document = {
    hidden: false,
    readyState: 'complete',
    body: { ...createElement('BODY'), contains: (node) => node === container || node === followLatestButton },
    documentElement: createElement('HTML'),
    head: createElement('HEAD'),
    addEventListener() {},
    removeEventListener() {},
    createElement: (tag) => createElement(tag),
    getElementById(id) {
      if (!byId.has(id)) byId.set(id, createElement('DIV'));
      return byId.get(id);
    },
    querySelector(selector) {
      if (selector === '.main-content') return mainContent;
      return null;
    },
    querySelectorAll() { return []; },
  };

  const globals = {
    document,
    Date: createFakeDate(clock),
    navigator: { userAgent: '' },
    CSS: { supports: () => false },
    WheelEvent: { DOM_DELTA_LINE: 1, DOM_DELTA_PAGE: 2 },
    MutationObserver: CapturingMutationObserver,
    ResizeObserver: CapturingResizeObserver,
    getComputedStyle: () => ({ overflowY: 'visible', paddingTop: '0px' }),
    Element: class Element {},
  };

  return { clock, container, followLatestButton, inputHost, inputCard, mainContent, document, globals };
}

/**
 * classic 相：真实 app-core + chat-viewport，加上 app-ui / i18n 的两个判定 stub。
 * 计时器 / 时钟 / 视口状态读取按真实加载序固定。
 */
function loadClassicViewport(fixture) {
  return (sandbox) => {
    sandbox.currentMessages = [];
    sandbox.allAgents = [];
    sandbox.window.currentMessages = [];
    sandbox.isChatSurfaceActive = () => true;
    sandbox.shouldRenderWorkspaceSurface = () => false;
    sandbox.escapeHtml = (value) => String(value == null ? '' : value)
      .replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
    sandbox.t = (key) => key;
    // 分发器先于一切声明 data-action 的模块装载（markdown-utils 求值期注册动作）。
    sandbox.loadSource('public/src/modules/action-dispatcher.js');
    sandbox.loadSource(APP_CORE);
    // chat-viewport 已迁 ESM（P4 T2）：不再走 classic 标签，由 async 相 c.load 装载。
    fixture.timers = installTimerQueue(sandbox, fixture.clock);
    fixture.sandbox = sandbox;
    fixture.writes = [];
    fixture.container.onWrite = (top) => {
      // classic 顶层 let 是词法绑定（不是 window 属性），经 run 读取真实值。
      fixture.writes.push({ top, suppressed: sandbox.run('suppressFollowScrollEvent') });
    };
  };
}

/** 首屏调用序列（app-ui → chat 渲染 → chat-context-bar 在模块相的真实入口）。 */
function runFirstPaintChain(c, viewport) {
  viewport.ensureChatViewportObservers();
  viewport.cancelChatScrollSettlement();
  viewport.runWithSuppressedChatViewportObservers(() => {
    fixtureContainer(c).innerHTML = '<div class="empty-state empty-welcome">hi</div>';
  }, 180);
  viewport.updateFollowLatestButton();
  viewport.notifyChatViewportMutation({
    reason: 'context-bar',
    shouldFollow: c.read('followLatestEnabled') && c.read('isChatSurfaceActive()'),
    preserveTop: null,
    forceSnap: false,
    allowChase: false,
    preferSmooth: false,
  });
  return c.read(`({
    observersReady: chatViewportObserversReady,
    followEnabled: followLatestEnabled,
    transition: chatViewportFollowTransition,
    suppressDepth: chatViewportObserverSuppressDepth,
    quietRemaining: chatViewportObserverQuietUntil - Date.now(),
    token: chatViewportSettlementToken,
    hasContext: chatViewportSettlementContext !== null,
  })`);
}

/** 视口容器：模块在求值期经 document.getElementById 等价重建（与本夹具同一节点）。 */
function fixtureContainer(c) {
  return c.document.getElementById('chat-container');
}

// ── 1. 同步首屏契约 ────────────────────────────────────────────────

test('模块相首屏链建立真实观察者 / 结算 / 跟随状态', async () => {
  const fixture = createFixture();
  await withP2EsmCase({ globals: fixture.globals, classic: loadClassicViewport(fixture) }, async (c) => {
    // 视口域在模块相求值（生产由 p4-entry 装载，早于 boot.js 的首屏渲染链）。
    const viewport = await c.load(CHAT_VIEWPORT);

    const state = runFirstPaintChain(c, viewport);

    assert.equal(state.observersReady, true, 'ensureChatViewportObservers 必须同步完成初始化');
    const observers = CapturingObserver.instances;
    assert.ok(observers.length >= 2, '必须建立 MutationObserver 与 ResizeObserver');
    const mutationObserver = observers.find((obs) => obs instanceof CapturingMutationObserver);
    const resizeObserver = observers.find((obs) => obs instanceof CapturingResizeObserver);
    assert.ok(mutationObserver, 'MutationObserver 已建立');
    assert.ok(resizeObserver, 'ResizeObserver 已建立');
    // 模块在求值期经 document.getElementById 等价重建 container（同一节点）
    assert.deepEqual(mutationObserver.targets, [fixture.container], '变异观察容器');
    assert.equal(mutationObserver.targets[0], c.read('container'), '模块的 container 与 app-core 顶层 const 是同一节点');
    assert.ok(resizeObserver.targets.includes(fixture.container), '尺寸观察容器');
    assert.ok(resizeObserver.targets.includes(fixture.inputHost), '尺寸观察输入容器');

    assert.equal(state.suppressDepth, 0, '同步抑制块退出后深度归零');
    assert.ok(state.quietRemaining > 0, '同步抑制留下观察者静默窗');
    assert.equal(state.followEnabled, true);
    assert.equal(state.transition, 'locked');
    assert.ok(state.token > 0, '同步通知推进结算代次');
    assert.equal(state.hasContext, true, '同步通知建立结算上下文');
    // 首屏无消息行但容器可滚：跟随开启时同步锁底（原行为）
    fixture.container.scrollHeight = 1600;
    fixture.writes.length = 0;
    viewport.lockChatViewportToBottomNow();
    assert.equal(fixture.container.scrollTop, 1000, '跟随模式同步锁底到 max scrollTop');
    assert.deepEqual(fixture.writes.map((w) => w.top), [1000]);
    assert.equal(fixture.writes[0].suppressed, true, '程序写 scrollTop 全程抑制跟随滚动事件');
    // 跟随按钮按真实状态渲染（不是空操作）：无消息时隐藏、跟随态 active、文案真实
    assert.equal(fixture.followLatestButton.classList.contains('hidden'), true);
    assert.equal(fixture.followLatestButton.classList.contains('active'), true);
    assert.ok(fixture.followLatestButton.innerHTML.includes('follow-latest-dot'));
    // 文案来自真实 i18n（模块 import 的 t 读 window.currentLanguage = zh）
    assert.ok(fixture.followLatestButton.innerHTML.includes(realT('follow_latest_on')));
    c.read('currentMessages = [{ role: "user", text: "x" }]');
    viewport.updateFollowLatestButton();
    // 空态守卫走真实合并选择器 `.empty-welcome, .chat-loading`：容器仍是首屏
    // 写入的欢迎态，因此即使有消息也隐藏（唯一能命中该守卫的路径）。
    assert.equal(fixture.followLatestButton.classList.contains('hidden'), true,
      '空态守卫：有消息但容器是欢迎态时按钮隐藏');
    fixture.container._html = '<div class="empty-state chat-loading">…</div>';
    viewport.updateFollowLatestButton();
    assert.equal(fixture.followLatestButton.classList.contains('hidden'), true,
      '空态守卫同样覆盖 chat-loading');
    fixture.container._html = '';
    viewport.updateFollowLatestButton();
    assert.equal(fixture.followLatestButton.classList.contains('hidden'), false, '有消息且非空态时按钮可见');

    // 结算定时器仍在队列里，可被取消（旧异步拒绝的基础）
    assert.ok(fixture.timers.pending() >= 1, '同步通知已入队 settle 定时器');
    viewport.cancelChatScrollSettlement();
    assert.equal(fixture.timers.pending(), 0, '取消结算必须清掉未触发计时器');
    assert.equal(c.read('chatViewportSettlementContext'), null);

    // 状态 owner 仍是 app-core（chatSurface 双向转发），模块按读写实时取用
    const { domRefs } = await c.load(BOOTSTRAP_DOM);
    const { chatSurface } = await c.load(BOOTSTRAP_CHAT_SURFACE);
    assert.equal(domRefs.container, c.read('container'), 'domRefs 持有 app-core 顶层 const 引用');
    assert.throws(() => { domRefs.container = null; }, TypeError,
      'const 引用只读：ESM 侧改不动唯一 owner');
    assert.equal(chatSurface.followLatestEnabled, true);
    chatSurface.followLatestEnabled = false;
    assert.equal(c.read('followLatestEnabled'), false, 'chatSurface 写回 classic 唯一 owner');
    c.read('followLatestEnabled = true;');
    assert.equal(chatSurface.followLatestEnabled, true, 'classic 写点对 ESM 立即可见');

    // 兼容面：桥键转发到模块导出（classic 与清单外 ESM 消费方的晚绑定协议）
    assert.equal(c.window.notifyChatViewportMutation, viewport.notifyChatViewportMutation);
    assert.equal(c.window.runWithSuppressedChatViewportObservers, viewport.runWithSuppressedChatViewportObservers);
    assert.equal(c.window.registerManualScrollIntent, viewport.registerManualScrollIntent);
    assert.equal(c.window.requestFollowLatest, viewport.requestFollowLatest);
    assert.equal(c.window.getToggleButtonLabel, viewport.getToggleButtonLabel);
    // classic 侧裸调用（app-ui 的形态）与模块调用命中同一实现
    const tokenBefore = c.read('chatViewportSettlementToken');
    c.read('notifyChatViewportMutation({ reason: "compat", shouldFollow: false, preserveTop: null, allowChase: false, preferSmooth: false, forceSnap: false })');
    assert.equal(c.read('chatViewportSettlementToken'), tokenBefore + 1,
      'classic 裸调用经同一实现推进结算代次');
  });
});

// ── 2. 手动滚动优先级（清单外 ESM 消费方经桥键进入同一实现）────────

test('手动滚动中断跟随 / 回底恢复的优先级经兼容面保持', async () => {
  const fixture = createFixture();
  await withP2EsmCase({ globals: fixture.globals, classic: loadClassicViewport(fixture) }, async (c) => {
    const viewport = await c.load(CHAT_VIEWPORT);
    runFirstPaintChain(c, viewport);
    const surface = c.window.createP2BootstrapChatSurfaceHost();
    fixture.timers.flush(0);
    assert.equal(c.read('followLatestEnabled'), true);

    // 已迁消费方（chat-scroll 的 wheel 监听 / chat-nav-timeline / ph-search-locate）
    // 经 window 晚绑定调用同一实现：向上滚动 → 立即中断跟随。
    c.read('registerManualScrollIntent({ interrupt: true });');
    assert.equal(c.read('followLatestEnabled'), false, '向上滚动手动中断跟随');
    assert.equal(surface.followLatestEnabled, false, '宿主面读到同一 owner');
    assert.equal(c.read('chatViewportFollowTransition'), 'locked');
    assert.ok(c.read('Date.now() - lastManualScrollIntentAt') < 1500, '手动意图窗口内');
    assert.equal(fixture.followLatestButton.classList.contains('active'), false);

    // 向下滚回底部 + 近期手动意图 → chat-scroll 的 scroll 判定恢复跟随
    fixture.container.scrollHeight = 1600;
    fixture.container.scrollTop = 1000;
    assert.equal(viewport.isNearBottom(), true);
    assert.equal(viewport.hasRecentManualScrollIntent(), true);
    viewport.setFollowLatest(true);
    assert.equal(c.read('followLatestEnabled'), true, '回底恢复跟随');
    assert.equal(surface.followLatestEnabled, true);
    fixture.timers.flush(0);
    assert.equal(fixture.container.scrollTop, 1000, '恢复跟随锁底');

    // 程序写 scrollTop 必须压住跟随滚动事件（suppressFollowScrollEvent）
    fixture.writes.length = 0;
    viewport.setChatViewportTop(0);
    assert.equal(fixture.writes.length, 1);
    assert.equal(fixture.writes[0].top, 0);
    assert.equal(fixture.writes[0].suppressed, true, '写入瞬间 suppression 生效');
    assert.equal(c.read('suppressFollowScrollEvent'), false, '写入完成后抑制标志复位');
    assert.equal(surface.suppressFollowScrollEvent, false);
  });
});

// ── 3. 锚点 / 阅读位置 / DOM 引用 ─────────────────────────────────

function installRows(fixture, heights) {
  const rows = heights.map((height, index) => {
    const row = createElement('DIV');
    row.classList.add('message-row');
    row.offsetTop = index === 0 ? 0 : heights.slice(0, index).reduce((sum, h) => sum + h, 0);
    row.offsetHeight = height;
    return row;
  });
  fixture.container.rows = rows;
  fixture.container._scrollHeight = heights.reduce((sum, h) => sum + h, 0);
  return rows;
}

test('锚点捕获/应用与阅读位置恢复保持原语义', async () => {
  const fixture = createFixture();
  await withP2EsmCase({ globals: fixture.globals, classic: loadClassicViewport(fixture) }, async (c) => {
    const viewport = await c.load(CHAT_VIEWPORT);
    runFirstPaintChain(c, viewport);
    const rows = installRows(fixture, [200, 200, 200, 200]);
    fixture.container.clientHeight = 300;
    c.read('followLatestEnabled = false; currentRuntimeAgentId = "rt-a";');
    // 隐藏行不参与锚定
    rows[1].classList.add('process-hidden');
    fixture.container.scrollTop = 250;
    const anchor = viewport.captureChatViewportAnchor();
    assert.equal(anchor.mode, 'anchor');
    assert.equal(anchor.rowIdx, 2, '跳过 process-hidden 行');
    assert.equal(anchor.offset, 250 - rows[2].offsetTop);
    assert.equal(anchor.scrollTop, 250);

    // 序列化锚点在重建后的行集上按 rowIdx 解析（跨 realm 对象逐字段断言）
    const serialized = viewport.serializeChatViewportAnchor(viewport.captureChatViewportAnchor());
    assert.equal(serialized.mode, 'anchor');
    assert.equal(serialized.rowIdx, 2);
    assert.equal(serialized.offset, anchor.offset);
    assert.equal(serialized.scrollTop, 250);
    assert.deepEqual(Object.keys(serialized).sort(), ['mode', 'offset', 'rowIdx', 'scrollTop']);
    const rebuilt = installRows(fixture, [300, 300, 300, 300]);
    viewport.applyChatViewportAnchor(serialized);
    assert.equal(fixture.container.scrollTop, rebuilt[2].offsetTop + serialized.offset,
      '重建后按 rowIdx + offset 恢复');

    // follow 模式锚点直接到底
    c.read('followLatestEnabled = true;');
    viewport.applyChatViewportAnchor({ mode: 'follow' });
    assert.equal(fixture.container.scrollTop, fixture.container.scrollHeight - fixture.container.clientHeight);

    // 像素回退
    c.read('followLatestEnabled = false;');
    viewport.applyChatViewportAnchor({ mode: 'pixel', scrollTop: 120 });
    assert.equal(fixture.container.scrollTop, 120);

    // pending 阅读位置一次性消费
    viewport.setPendingChatScrollRestore(333);
    assert.equal(viewport.consumePendingChatScrollRestore(), 333);
    assert.equal(viewport.consumePendingChatScrollRestore(), null, '消费即清空');
    viewport.setPendingChatScrollRestore(NaN);
    assert.equal(viewport.consumePendingChatScrollRestore(), null, '非有限值不入队');

    // pending 锚点一次性消费
    viewport.setPendingChatViewportAnchor({ mode: 'pixel', scrollTop: 42 });
    assert.equal(viewport.consumePendingChatViewportAnchor()?.scrollTop, 42);
    assert.equal(viewport.consumePendingChatViewportAnchor(), null);

    // 按上下文记住 / 读取 / 遗忘（模块私有 Map，公开读面唯一）
    viewport.rememberChatViewportAnchorForContext('runtime:rt-a');
    const remembered = viewport.getRememberedChatViewportAnchorForContext('runtime:rt-a');
    assert.equal(remembered.mode, 'anchor');
    viewport.forgetChatViewportAnchorForContext('runtime:rt-a');
    assert.equal(viewport.getRememberedChatViewportAnchorForContext('runtime:rt-a'), null);
  });
});

// ── 4. 旧异步拒绝 ─────────────────────────────────────────────────

test('过期结算与过期锚点保存都不落盘', async () => {
  const fixture = createFixture();
  await withP2EsmCase({ globals: fixture.globals, classic: loadClassicViewport(fixture) }, async (c) => {
    const viewport = await c.load(CHAT_VIEWPORT);
    runFirstPaintChain(c, viewport);
    fixture.timers.flush(0);
    installRows(fixture, [200, 200, 200]);
    fixture.container.clientHeight = 200;
    c.read('followLatestEnabled = false;');
    c.read('currentRuntimeAgentId = "rt-a";');

    const notifyPreserve = (preserveTop) => viewport.notifyChatViewportMutation({
      reason: 'render-full', shouldFollow: false, preserveTop, forceSnap: false, allowChase: false, preferSmooth: false,
    });

    // 结算代次守卫（真实执行旧回调，不是只靠 clearTimeout）：
    // 1) 旧代次计时器回调在新通知之后执行 → token 不匹配，直接返回且不排新帧。
    notifyPreserve(200);
    const staleTimerCallback = fixture.timers.takeNext();
    assert.equal(typeof staleTimerCallback, 'function', '取到旧 settle 计时器回调');
    notifyPreserve(100);
    const pendingBeforeStale = fixture.timers.pending();
    staleTimerCallback();
    assert.equal(fixture.timers.pending(), pendingBeforeStale,
      '旧计时器回调被 token 守卫拒绝，不得排入新 settle 帧');

    // 2) 旧代次的 settle 帧回调在新代次之后执行 → 同样被拒，不改 scrollTop。
    const timerCallback = fixture.timers.takeNext();
    assert.equal(typeof timerCallback, 'function');
    timerCallback(); // 旧代次计时器（当前代次）→ 排出 settle 帧
    const staleSettleFrame = fixture.timers.takeNext();
    assert.equal(typeof staleSettleFrame, 'function', '取到 settle 帧回调');
    notifyPreserve(100);
    // 推进逻辑时钟越过 settle 的 280ms 超时阈值：若 token 守卫缺失，旧帧会
    // 立刻走到写 scrollTop（断言可失败），而不是停在 stableFrames 重排。
    fixture.clock.now += 400;
    fixture.writes.length = 0;
    staleSettleFrame();
    assert.deepEqual(fixture.writes, [], '旧 settle 帧不得写 scrollTop');
    assert.notEqual(c.read('chatViewportSettlementContext'), null, '旧回调不得清掉新代次上下文');

    // 新代次正常结算到最新 preserveTop
    fixture.timers.flush(0);
    assert.equal(fixture.container.scrollTop, 100, '最新代次生效');
    assert.ok(fixture.writes.every((w) => w.top === 100), '只写入最新 preserveTop');

    // 锚点保存定时器：上下文在 150ms 窗口内切换 → 旧上下文不得写入
    fixture.container.scrollTop = 250;
    viewport.forgetChatViewportAnchorForContext('runtime:rt-a');
    viewport.forgetChatViewportAnchorForContext('runtime:rt-b');
    fixture.container.dispatch('scroll');
    assert.ok(fixture.timers.pending() >= 1, '滚动后排队锚点保存定时器');
    c.read('currentRuntimeAgentId = "rt-b";');
    fixture.timers.flush(200);
    assert.equal(viewport.getRememberedChatViewportAnchorForContext('runtime:rt-a'), null,
      '上下文已切换，过期保存被拒绝');
    assert.equal(viewport.getRememberedChatViewportAnchorForContext('runtime:rt-b'), null);

    // 同上下文内正常保存
    fixture.container.dispatch('scroll');
    fixture.timers.flush(200);
    assert.equal(viewport.getRememberedChatViewportAnchorForContext('runtime:rt-b')?.mode, 'anchor');

    // 跟随开启时滚动不保存（与原行为一致）
    c.read('followLatestEnabled = true;');
    viewport.forgetChatViewportAnchorForContext('runtime:rt-b');
    fixture.container.dispatch('scroll');
    fixture.timers.flush(200);
    assert.equal(viewport.getRememberedChatViewportAnchorForContext('runtime:rt-b'), null);
  });
});

// ── 5. 观察者静默 / 帧回调生命周期 ────────────────────────────────

test('观察者静默窗零变化：抑制期间的变异/尺寸事件不触发结算', async () => {
  const fixture = createFixture();
  await withP2EsmCase({ globals: fixture.globals, classic: loadClassicViewport(fixture) }, async (c) => {
    const viewport = await c.load(CHAT_VIEWPORT);
    runFirstPaintChain(c, viewport);
    fixture.timers.flush(0);
    const tokenBefore = c.read('chatViewportSettlementToken');
    const resizeObserver = CapturingObserver.instances.find((obs) => obs instanceof CapturingResizeObserver);

    // 抑制深度 > 0 时任何尺寸事件都被丢弃
    viewport.suppressChatViewportObservers(160);
    resizeObserver.fire([{ target: fixture.inputHost }]);
    assert.equal(c.read('chatViewportSettlementToken'), tokenBefore);
    viewport.resumeChatViewportObservers();

    // 只剩静默窗（深度 0）时：普通噪声丢弃，消息行高度变化语义穿透
    resizeObserver.fire([{ target: fixture.inputHost }]);
    assert.equal(c.read('chatViewportSettlementToken'), tokenBefore, '静默窗内普通噪声不结算');
    const row = createElement('DIV');
    row.classList.add('message-row');
    resizeObserver.fire([{ target: row }]);
    const tokenAfterRow = c.read('chatViewportSettlementToken');
    assert.ok(tokenAfterRow > tokenBefore, '行尺寸变化即使静默也要结算');

    // 静默到期后普通 resize 才参与结算
    fixture.timers.flush(200);
    const beforePlain = c.read('chatViewportSettlementToken');
    resizeObserver.fire([{ target: fixture.inputHost }]);
    assert.ok(c.read('chatViewportSettlementToken') > beforePlain, '静默到期后普通 resize 参与结算');

    // ensure 幂等：重复调用不新建 observer，只重扫消息行
    const observerCount = CapturingObserver.instances.length;
    viewport.ensureChatViewportObservers();
    viewport.ensureChatViewportObservers();
    assert.equal(CapturingObserver.instances.length, observerCount, '重复 ensure 不新建 observer');

    // 真实生命周期：非抑制的变异回调 → 结算 → 跟随开启时锁底
    const mutationObserver = CapturingObserver.instances.find(
      (obs) => obs instanceof CapturingMutationObserver,
    );
    fixture.container.scrollHeight = 1600;
    fixture.container.scrollTop = 200;
    fixture.timers.flush(200);
    mutationObserver.fire([{ type: 'childList' }]);
    assert.ok(c.read('chatViewportSettlementContext !== null'), '变异建立结算上下文');
    fixture.timers.flush(0);
    assert.equal(fixture.container.scrollTop, 1000, '跟随开启时变异结算锁底');
  });
});

// ── 6. 跟随按钮定位（closest('.main-content') + 输入卡真实夹具）──────

test('避让定位：closest 主区与输入卡高度驱动 --follow-latest-bottom', async () => {
  const fixture = createFixture();
  await withP2EsmCase({ globals: fixture.globals, classic: loadClassicViewport(fixture) }, async (c) => {
    const viewport = await c.load(CHAT_VIEWPORT);
    runFirstPaintChain(c, viewport);
    fixture.timers.flush(0);

    // 首屏 updateFollowLatestButton → ensureFollowLatestAvoidObserver 已建立并观察主区/输入容器
    const avoidObserver = CapturingObserver.instances
      .filter((obs) => obs instanceof CapturingResizeObserver)
      .find((obs) => obs.targets.includes(fixture.mainContent));
    assert.ok(avoidObserver, '避让 ResizeObserver 观察 .main-content');
    assert.ok(avoidObserver.targets.includes(fixture.inputHost), '并观察输入容器');

    // 中央区变窄（<=1100）→ 贴输入卡顶边：740 - 600 + 10 = 150px
    fixture.mainContent.clientWidth = 1000;
    viewport.updateFollowLatestButtonPosition();
    assert.equal(fixture.followLatestButton.style.getPropertyValue('--follow-latest-bottom'), '150px');

    // 宽屏且无面板 → 移除避让值
    fixture.mainContent.clientWidth = 1200;
    viewport.updateFollowLatestButtonPosition();
    assert.equal(fixture.followLatestButton.style.getPropertyValue('--follow-latest-bottom'), '');

    // 面板打开 → ResizeObserver → rAF → 重新定位（真实帧路径）
    fixture.mainContent.classList.add('panel-open');
    avoidObserver.fire([]);
    fixture.timers.flush(0);
    assert.equal(fixture.followLatestButton.style.getPropertyValue('--follow-latest-bottom'), '150px');

    // 输入卡不存在时保持空操作（不抛错、不写值）
    fixture.mainContent.classList.remove('panel-open');
    fixture.mainContent.clientWidth = 1200;
    fixture.inputHost.querySelector = () => null;
    viewport.updateFollowLatestButtonPosition();
    assert.equal(fixture.followLatestButton.style.getPropertyValue('--follow-latest-bottom'), '');
  });
});
