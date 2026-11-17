/**
 * 聊天导航时间线点击 → 「先中断跟随」的跨模块契约
 * （chat-nav-timeline 点击 → chat-viewport 的 registerManualScrollIntent）。
 *
 * 装载路线（P4 T2 批次）：chat-viewport 已迁 ESM，与本模块同在 async 相经
 * withP2EsmCase 的 `c.load` 真实 import（视口先装载，其桥键
 * `registerManualScrollIntent` 供 chat-nav-timeline 的 window 晚绑定取用）。
 * classic 相只剩分发器与 app-core（视口状态的 classic owner）。
 *
 * 公开入口：不再直接调用私有 `_onBarClick` 或注入 `_navUserIndices`；
 * 用例构建真实 DOM（container 行 + `#msg-7` + `#chat-nav-timeline`），
 * 让模块自己重建 slot 结构，然后派发 slot 的 click 事件。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withP2EsmCase } from './helpers/p2-esm-case.js';

const CHAT_VIEWPORT = 'public/src/modules/chat-viewport.js';
const NAV_TIMELINE = 'public/src/modules/chat-nav-timeline.js';

function makeClassList(initial = []) {
  const set = new Set(initial);
  return {
    add: (...names) => names.forEach(n => set.add(n)),
    remove: (...names) => names.forEach(n => set.delete(n)),
    toggle(name, force) {
      const enable = force === undefined ? !set.has(name) : Boolean(force);
      if (enable) set.add(name); else set.delete(name);
      return enable;
    },
    contains: name => set.has(name),
  };
}

/** 记录监听器的元素桩：导航 slot 的 click 需要真实派发。 */
function makeElement(tag = 'div', { height = 600, top = 0 } = {}) {
  const listeners = new Map();
  const children = [];
  return {
    tagName: String(tag).toUpperCase(),
    id: '', className: '', innerHTML: '', textContent: '',
    style: { props: {}, setProperty(k, v) { this.props[k] = v; }, removeProperty(k) { delete this.props[k]; } },
    classList: makeClassList(),
    dataset: {},
    children,
    appendChild(child) { children.push(child); return child; },
    addEventListener(type, callback) { listeners.set(type, callback); },
    removeEventListener(type) { listeners.delete(type); },
    dispatch(type, event = {}) {
      const callback = listeners.get(type);
      if (callback) callback(event);
      return Boolean(callback);
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getBoundingClientRect() { return { top, left: 0, width: 800, height }; },
  };
}

function createRig() {
  const timers = new Map();
  const cancelledRafs = [];
  const targetRow = {
    classList: makeClassList(['message-row', 'user']),
    closest(selector) { return selector === '.message-row' ? targetRow : null; },
    querySelector(selector) { return selector === '[id^="msg-"]' ? targetMessage : null; },
    querySelectorAll() { return []; },
    getBoundingClientRect() { return { top: 180 }; },
  };
  const targetMessage = {
    id: 'msg-7',
    textContent: 'target',
    closest(selector) { return selector === '.message-row' ? targetRow : null; },
    getBoundingClientRect() { return { top: 180 }; },
  };
  const container = {
    _scrollTop: 900,
    clientHeight: 600,
    clientWidth: 1000,
    scrollHeight: 3000,
    parentElement: {
      getBoundingClientRect() { return { top: 0 }; },
    },
    querySelector() { return null; },
    querySelectorAll(selector) {
      return selector === '.message-row.user' ? [targetRow] : [];
    },
    getBoundingClientRect() { return { top: 100 }; },
    addEventListener() {},
    removeEventListener() {},
  };
  Object.defineProperty(container, 'scrollTop', {
    get() { return container._scrollTop; },
    set(value) { container._scrollTop = Number(value); },
  });

  const navTimeline = makeElement('div', { height: 600 });
  const navCard = makeElement('div');
  const elementStub = () => makeElement('div');

  const document = {
    activeElement: null,
    readyState: 'complete',
    getElementById(id) {
      if (id === 'chat-nav-timeline') return navTimeline;
      if (id === 'chat-nav-card') return navCard;
      if (id === 'chat-container') return container;
      if (id === 'msg-7') return targetMessage;
      return null;
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    createElement: (tag) => elementStub(tag),
    createTextNode: (text) => ({ textContent: text }),
    addEventListener() {}, removeEventListener() {},
    body: makeElement('body'),
    head: makeElement('head'),
    documentElement: makeElement('html'),
  };

  const fakeTimers = {
    setTimeout(callback) {
      const id = timers.size + 1;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    requestAnimationFrame() { return 99; },
    cancelAnimationFrame(id) { cancelledRafs.push(id); },
  };

  return { container, navTimeline, document, fakeTimers, cancelledRafs };
}

test('clicking the conversation navigation cancels follow-latest before jumping', async () => {
  const rig = createRig();
  const globals = {
    document: rig.document,
    currentMessages: [{ role: 'user', content: 'target' }],
    t: (key) => key,
    escapeHtml: (value) => String(value),
    isChatSurfaceActive: () => true,
    shouldRenderWorkspaceSurface: () => false,
    MutationObserver: class { observe() {} disconnect() {} },
    ResizeObserver: class { observe() {} disconnect() {} },
  };

  await withP2EsmCase({
    classic: (sandbox) => {
      Object.assign(sandbox, rig.fakeTimers);
      // index.html 真实加载序：分发器 → i18n → app-core → 业务 classic。
      sandbox.loadSource('public/src/modules/action-dispatcher.js');
      // i18n 已迁 ESM（P4）：t 桥键由 createFrontendSandbox 自动装载，见 test/helpers/install-i18n.js
      sandbox.loadSource('public/src/app-core.js');
    },
    globals,
  }, async (c) => {
    // 跟随状态与未完成的 settlement / follow 动画帧（生产由 app-core 持有）。
    // 这些键都有 chatSurface host 的成对 get/set —— 与未迁移 classic 消费方
    // 读写同一份状态，不直接触碰 app-core 的词法绑定。
    const surface = c.window.createP2BootstrapChatSurfaceHost();
    surface.followLatestEnabled = true;
    surface.suppressFollowScrollEvent = false;
    surface.lastManualScrollIntentAt = 0;
    surface._progScrollCooldownUntil = 0;
    surface.followLatestEntryUntil = 0;
    surface.chatViewportObserversReady = false;
    surface.chatViewportSettlementToken = 0;
    surface.chatViewportSettlementRaf = 41;
    surface.chatViewportSettlementTimer = 42;
    surface.chatViewportSettlementContext = { reasons: new Set(['append']) };
    surface.chatViewportFollowRaf = 43;
    surface.chatViewportFollowToken = 0;
    surface.chatViewportFollowTransition = 'smooth';
    assert.equal(surface.followLatestEnabled, true, 'precondition: follow-latest is on');
    c.window.currentMessages = [{ role: 'user', content: 'target' }];

    // chat-viewport 已迁 ESM：先装载（注册桥键与 container 滚动监听）。
    await c.load(CHAT_VIEWPORT);
    await c.load(NAV_TIMELINE);
    // 模块初始化后时间线里恰有一个 user 消息 slot；点击它 = 用户点击导航条。
    assert.equal(rig.navTimeline.children.length, 1, 'one nav slot per user message');
    const slot = rig.navTimeline.children[0];
    slot.dispatch('click', {});

    assert.equal(surface.followLatestEnabled, false, 'navigation click must turn off follow-latest');
    assert.deepEqual(
      rig.cancelledRafs.sort((a, b) => a - b),
      [41, 43],
      'navigation click must cancel both settlement and follow animation frames',
    );
    assert.equal(
      c.read('chatViewportSettlementContext'),
      null,
      'navigation click must clear the pending settlement context',
    );
    assert.equal(
      rig.container.scrollTop,
      964,
      'navigation click must still place the target row at the navigation offset',
    );
  });
});
