/**
 * runtime-mode-menu（「新建对话」运行模式悬停菜单）行为测试。
 *
 * 装载路线：esm-module-loader 的真实 import + 自定义 document/window 桩
 * （模块无导出面，行为只能经 document 级委托监听驱动）。依赖链
 * markdown-utils / toast-notify / i18n-environment-state 的全局需求
 * （renderer / escapeHtml / marked / ClawToast / KernelState）按
 * p2-w1-1-batch1 的同配方装桩。
 *
 * 重点覆盖「锚点失活」防线（页面切换重渲染移除入口按钮时的竞争）：
 * 浏览器不会为 detached 元素派发 pointerout，菜单挂在 body 上既收不起、
 * pending 展开到期还会对着全零 rect 弹出并卡在旧视口位置。
 *
 * 时钟控制：node:test mock.timers（禁真实 sleep）；OPEN_DELAY_MS=220、
 * CLOSE_DELAY_MS=250，tick 值各留 10ms 余量。每个用例装载全新模块实例
 * （唯一 query 绕缓存）并清空监听表与 body 子元素，旧实例闭包的
 * handler / 定时器不跨用例泄漏。
 */

import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserStubs, loadModuleOnce } from './helpers/esm-module-loader.js';

const MENU_CLASS = 'ph-runtime-mode-menu';
const OPEN_TICK = 230;   // > OPEN_DELAY_MS(220)
const CLOSE_TICK = 260;  // > CLOSE_DELAY_MS(250)

/** document 级委托监听表：type → handlers（驱动点，也是清旧实例的复位面）。 */
const docHandlers = new Map();
/** body.appendChild 捕获表：菜单元素的唯一落点。 */
const bodyChildren = [];

function makeElement({ isEntry = false } = {}) {
  const el = {
    className: '',
    style: {},
    dataset: {},
    tabIndex: 0,
    disabled: false,
    isConnected: true,
    children: [],
    listeners: {},
    removed: false,
    parent: null,
    setAttribute() {},
    addEventListener(type, fn) { (el.listeners[type] ??= []).push(fn); },
    removeEventListener() {},
    appendChild(child) { child.parent = el; el.children.push(child); },
    getBoundingClientRect() {
      return { left: 200, top: 100, right: 320, bottom: 140, width: 120, height: 40 };
    },
    querySelectorAll() { return [...el.children]; },
    focus() {},
    remove() { el.removed = true; },
    closest(selector) {
      let node = el;
      while (node) {
        if (selector === '[data-runtime-mode-entry]' && node.isEntry) return node;
        if (selector.includes(MENU_CLASS) && node.className === MENU_CLASS) return node;
        node = node.parent;
      }
      return null;
    },
  };
  if (isEntry) el.isEntry = true;
  return el;
}

/** 入口按钮（带运行模式菜单需要的 data-workspace-action 载荷）。 */
function makeEntryButton() {
  const button = makeElement({ isEntry: true });
  // 载荷形态对齐真实渲染（escapeHtml(JSON.stringify(action)) 的产物，
  // 路径分隔符已是合法 JSON 转义）；choose 会 JSON.parse 它。
  button.dataset.workspaceAction = '{"kind":"open-directory","path":"D:/proj"}';
  return button;
}

/** 装载一个全新模块实例，同时复位监听表 / body / mock 时钟（隔离旧实例）。 */
async function loadFresh() {
  docHandlers.clear();
  bodyChildren.length = 0;
  // reset 同时恢复原实现并清掉旧实例泄漏的 pending 定时器，重新 enable 拿干净时钟。
  mock.timers.reset();
  mock.timers.enable({ apis: ['setTimeout'] });
  return (await loadModuleOnce('public/src/modules/runtime-mode-menu.js', {
    installGlobals: false,
  })).module;
}

/** 以捕获顺序触发 document 级监听。 */
function dispatch(type, event) {
  for (const fn of [...(docHandlers.get(type) || [])]) fn(event);
}

function hover(target) { dispatch('pointerover', { target, relatedTarget: null }); }
function leave(target, relatedTarget = makeElement()) { dispatch('pointerout', { target, relatedTarget }); }
function press(target) { dispatch('pointerdown', { target }); }
/** 当前展开的菜单元素（body 最后一个子元素），未展开时为 undefined。 */
function currentMenu() {
  return bodyChildren.filter((el) => !el.removed).at(-1);
}

let cleanupGlobals;

before(async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  cleanupGlobals = installBrowserStubs({
    window: {
      innerWidth: 1280,
      innerHeight: 800,
      scrollX: 0,
      scrollY: 0,
      escapeHtml: (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
      renderer: {},
      marked: { parse: () => '', setOptions() {}, use() {}, Renderer: class {} },
      ClawFW: { actions: { registerMany() {} } },
      ClawToast: { show() {} },
    },
    document: {
      addEventListener(type, fn) { (docHandlers.get(type) ?? docHandlers.set(type, []).get(type)).push(fn); },
      removeEventListener(type, fn) {
        const arr = docHandlers.get(type) || [];
        const index = arr.indexOf(fn);
        if (index !== -1) arr.splice(index, 1);
      },
      createElement: () => makeElement(),
      body: {
        appendChild(el) { bodyChildren.push(el); },
        removeChild(el) {
          const index = bodyChildren.indexOf(el);
          if (index !== -1) bodyChildren.splice(index, 1);
        },
      },
      querySelectorAll() { return []; },
      activeElement: null,
    },
  });
  await loadModuleOnce('public/src/modules/kernel-state.js', { installGlobals: false });
  window.KernelState.defineKey('i18n-environment', 'currentLanguage', 'zh');
  window.KernelState.defineKey('i18n-environment', 'currentTheme', 'dark');
});

after(() => {
  mock.timers.reset();
  cleanupGlobals();
});

// ── 既有交互契约回归 ────────────────────────────────────────────────

test('悬停约 220ms 展开菜单，离开联合区域约 250ms 后收起', async () => {
  await loadFresh();
  const button = makeEntryButton();
  hover(button);
  assert.equal(currentMenu(), undefined, '延迟展开期内菜单不应出现');
  mock.timers.tick(OPEN_TICK);
  const menu = currentMenu();
  assert.ok(menu, '悬停 220ms 后菜单应挂在 body 下');
  assert.equal(menu.className, MENU_CLASS);
  assert.equal(menu.children.length, 2, '普通 / 容器两个菜单项');

  leave(button);
  mock.timers.tick(CLOSE_TICK);
  assert.equal(menu.removed, true, '离开 250ms 后菜单应移除');
  assert.equal(currentMenu(), undefined);
});

test('菜单展开期间点击页面其他位置立即收起，点击菜单内部不收起', async () => {
  await loadFresh();
  const button = makeEntryButton();
  hover(button);
  mock.timers.tick(OPEN_TICK);
  const menu = currentMenu();
  assert.ok(menu);

  press(menu.children[0]); // 菜单项上按下：不收起（联合区域语义）
  assert.equal(menu.removed, false);

  press(makeElement()); // 菜单外任意位置按下：立即收起
  assert.equal(menu.removed, true);
});

test('选中菜单项：注入 runtimeMode 后走 runWorkspaceAction，菜单收起', async () => {
  await loadFresh();
  const button = makeEntryButton();
  hover(button);
  mock.timers.tick(OPEN_TICK);
  const menu = currentMenu();
  assert.ok(menu);

  const calls = [];
  window.runWorkspaceAction = (raw, anchor) => { calls.push({ raw, anchor }); };
  try {
    menu.children[1].listeners.click[0](); // 容器模式菜单项
    assert.equal(menu.removed, true, '选中后菜单应收起');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].anchor, button, '动作锚点是入口按钮');
    const action = JSON.parse(calls[0].raw);
    assert.equal(action.kind, 'open-directory', '原动作字段保留');
    assert.equal(action.runtimeMode, 'container', 'runtimeMode 已注入');
  } finally {
    delete window.runWorkspaceAction;
  }
});

// ── 锚点失活防线（本次修复目标） ───────────────────────────────────

test('展开计时期内锚点被视图切换移除：到期不弹出菜单', async () => {
  await loadFresh();
  const button = makeEntryButton();
  hover(button);
  button.isConnected = false; // 页面切换重渲染，入口按钮 detached
  mock.timers.tick(OPEN_TICK);
  assert.equal(currentMenu(), undefined, '锚点已离开文档时不得展开菜单');
});

test('悬停计时期内点击别处（打开已有对话路径）：pending 展开取消', async () => {
  await loadFresh();
  const button = makeEntryButton();
  hover(button);
  press(makeElement()); // 点击会话条目等任意位置（pointerdown 时菜单尚未展开）
  button.isConnected = false; // 点击伴随的页面切换移除按钮
  mock.timers.tick(OPEN_TICK);
  assert.equal(currentMenu(), undefined, '点击后到期计时器不得再弹出菜单');
});

test('悬停计时期内点击入口本身（默认创建路径）：不再弹菜单', async () => {
  await loadFresh();
  const button = makeEntryButton();
  hover(button);
  press(button); // 直接点击入口 = 选择默认模式，悬停展开失去意义
  mock.timers.tick(OPEN_TICK);
  assert.equal(currentMenu(), undefined, '点击入口后 pending 展开应被取消');
});

test('菜单已展开后锚点被移除：任一 pointerover 直接收起', async () => {
  await loadFresh();
  const button = makeEntryButton();
  hover(button);
  mock.timers.tick(OPEN_TICK);
  const menu = currentMenu();
  assert.ok(menu);

  button.isConnected = false; // detached 元素不会收到 pointerout（收起路径失效）
  hover(makeElement()); // 鼠标移动到普通元素
  assert.equal(menu.removed, true, '锚点失活后鼠标一动菜单应收起');
});

test('菜单已展开后锚点被移除：滚动/resize 收起而不是按全零 rect 甩位', async () => {
  await loadFresh();
  const button = makeEntryButton();
  hover(button);
  mock.timers.tick(OPEN_TICK);
  const menu = currentMenu();
  assert.ok(menu);
  const leftBefore = menu.style.left;

  button.isConnected = false;
  dispatch('scroll', {});
  assert.equal(menu.removed, true, '锚点失活时滚动应收起菜单');
  assert.equal(menu.style.left, leftBefore, '收起前不得按 detached 锚点重定位');
});
