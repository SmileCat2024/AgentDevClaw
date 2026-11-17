/**
 * 显示/隐藏过程切换的滚动锚定契约（lazy-tool-content + input-helpers 真实代码路径）：
 *   - 顶部切换：锚定首条 user 行（系统行揭示后落在其上方）
 *   - 中途切换：保持当前阅读行相对位置
 *   - 锚定只移动 scrollTop，不吞行：滚回 0 时系统行可达
 *     （「显示过程后顶部看不到系统消息」类报告的对照基线——
 *     锚定行为本身不构成内容缺失）
 *
 * 装载路线（P2）：lazy-tool-content 与过程显隐编排已迁 ESM，经 withP2EsmCase 的
 * `c.load` 真实 import；classic 侧按 index.html 真实加载序跑 action-dispatcher →
 * i18n → app-core → input-helpers（仅留 updateChatProcessToggle 首屏实现），
 * 窗口函数的 classic 消费面由生产兼容桥 p2-w2-1-chat-windowing-host 提供
 * （与浏览器同一条桥，不在测试里另造转发）。container 引用与过程可见性
 * 仍来自 app-core 的真实 seam。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { withP2EsmCase } from './helpers/p2-esm-case.js';

const WINDOWING_HOST = 'public/src/modules/p2-w2-1-chat-windowing-host.js';
const LAZY_TOOL_CONTENT = 'public/src/modules/lazy-tool-content.js';

function createView(roles = ['system', 'system', 'user', 'assistant']) {
  const rows = [];
  const listeners = new Map();
  const container = {
    scrollTop: 0, clientHeight: 600,
    querySelectorAll(selector) {
      if (selector === '.message-row') return rows;
      if (selector.includes('.message-row.system')) return rows.filter(row => row.role === 'system');
      return [];
    },
    addEventListener(name, callback) { listeners.set(name, callback); },
    removeEventListener(name) { listeners.delete(name); },
  };
  for (const role of roles) {
    const classes = new Set(['message-row', role]);
    const row = {
      role,
      classList: {
        contains: name => classes.has(name),
        add: name => classes.add(name),
        remove: name => classes.delete(name),
        toggle(name, force) {
          const enabled = force ?? !classes.has(name);
          if (enabled) classes.add(name); else classes.delete(name);
        },
      },
      get offsetHeight() { return classes.has('process-hidden') ? 0 : 200; },
      get offsetTop() {
        return rows.slice(0, rows.indexOf(row)).reduce((sum, item) => sum + item.offsetHeight, 0);
      },
      querySelector() { return null; },
      querySelectorAll() { return []; },
    };
    rows.push(row);
  }

  const elements = new Map();
  const elementStub = (id) => ({
    id, innerHTML: '', textContent: '', style: {},
    classList: {
      add() {}, remove() {}, toggle() {}, contains() { return false; },
    },
    dataset: {}, clientHeight: 0, clientWidth: 0, scrollHeight: 0, scrollTop: 0, parentElement: null,
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

  return { rows, container, document };
}

async function withView(roles, fn) {
  const rig = createView(roles);
  const counters = { fullRenders: 0 };
  const globals = {
    document: rig.document,
    syncCollapseStates() {},
    syncRowCollapseState() {},
    settleAllRowCollapseStates() {},
    isChatSurfaceActive: () => true,
    notifyChatViewportMutation() {},
    shouldRenderWorkspaceSurface: () => false,
    ensureChatRuntimeIndicator() {},
    // 全量渲染入口（生产：chat-renderer 的 render）；本用例只计数。
    render: () => { counters.fullRenders += 1; },
  };
  return withP2EsmCase({
    classic: (sandbox) => {
      // index.html 真实加载序：分发器 → i18n → app-core → 业务 classic。
      sandbox.loadSource('public/src/modules/action-dispatcher.js');
      // i18n 已迁 ESM（P4）：t 桥键由 createFrontendSandbox 自动装载，见 test/helpers/install-i18n.js
      sandbox.loadSource('public/src/app-core.js');
      // input-helpers 已迁 ESM（P4 T2）：classic 标签删除，改由 async 相 c.load 装载。
    },
    globals,
  }, async (c) => {
    // input-helpers 已迁 ESM（P4 T2）：真实 import 装载，桥键由模块自身注册；
    // chat-process-visibility 的 toggle 入口经 window.updateChatProcessToggle 取用。
    await c.load('public/src/modules/input-helpers.js');
    const surface = c.window.createP2BootstrapChatSurfaceHost();
    surface.showChatProcess = false;
    surface.followLatestEnabled = false;
    // currentMessages 是 app-core 在装载期注册的桥键（初始 []），装载后写入。
    c.window.currentMessages = rig.rows.map(row => ({ role: row.role, content: row.role }));
    // 生产兼容桥：input-helpers 的 applyProcessDistance / clearProcessDistance /
    // precomputeViewportIdx 等 classic 调用经它转发到 ESM 实现。
    await c.load(WINDOWING_HOST);
    // 过程显隐（本批迁 ESM，原 input-helpers.js 的非首屏实现）
    await c.load('public/src/modules/chat-process-visibility.js');
    // 显式 window 调用不等于永久外部协议：入口按配方经 KernelState 桥注册
    // （访问器 + 可写转发），而不是散装 window 赋值。
    const toggleDescriptor = Object.getOwnPropertyDescriptor(c.window, 'toggleChatProcessVisibility');
    assert.equal(typeof toggleDescriptor?.get, 'function', '过程显隐入口已上桥');
    assert.equal(typeof toggleDescriptor?.set, 'function', '桥键保持可写转发');
    const mod = await c.load(LAZY_TOOL_CONTENT);
    mod.setProcessWindowingDisabled(true);
    c.read('applyConversationProcessState(container)');
    return fn({
      rows: rig.rows,
      container: rig.container,
      surface,
      toggle: () => c.read('toggleChatProcessVisibility()'),
      showChatProcess: () => surface.showChatProcess,
      fullRenders: () => counters.fullRenders,
    });
  });
}

test('control: toggle anchor leaves existing system rows reachable by scrolling to zero', async () => {
  await withView(undefined, ({ rows, container, toggle }) => {
    assert.equal(container.scrollTop, 0);
    assert.equal(rows[0].offsetHeight, 0);
    toggle();
    assert.equal(rows[0].classList.contains('process-hidden'), false);
    assert.equal(container.scrollTop, rows[2].offsetTop, 'toggle preserves the user row anchor');
    container.scrollTop = 0;
    assert.equal(rows[0].offsetTop, 0);
    assert.equal(rows[0].offsetHeight, 200, 'anchoring alone cannot explain missing system messages at absolute top');
  });
});

test('showing process away from the top preserves the reading anchor', async () => {
  await withView(undefined, ({ rows, container, toggle }) => {
    container.scrollTop = 80;
    toggle();
    assert.equal(container.scrollTop - rows[2].offsetTop, 80);
  });
});

test('continuation session (system + assistant, no user) toggles via CSS classes, not full re-render', async () => {
  await withView(['system', 'system', 'assistant', 'assistant'], ({ rows, toggle, showChatProcess, fullRenders }) => {
    assert.equal(rows[0].classList.contains('process-hidden'), true,
      'hide mode keeps system rows hidden before the toggle');
    toggle();
    assert.equal(showChatProcess(), true);
    assert.equal(fullRenders(), 0,
      'content-bearing transcript must toggle with CSS classes only (no welcome-page switch)');
    assert.equal(rows[0].classList.contains('process-hidden'), false,
      'system rows are revealed through the class toggle');
  });
});
