/**
 * ph-search-locate 前端回归测试（工单 2026-10-21 定位与返回板块）。
 *
 * 装载路线（P2 W2-8 测试改造）：ph-search-locate 已迁 ESM → withP2EsmCase
 * 真实 import（`container` 经 p2-bootstrap-dom 取 app-core 的 #chat-container
 * 引用，搜索状态经 ph-session-list 的 `_phSearch` 命名导出共享，每 case 一张图）。
 * classic 侧仍真实执行：action-dispatcher / app-core / i18n 按真实加载序
 * loadSource，chat-renderer 的错误组权威判定（computeAssistantErrorGroups）
 * 按其真实 export 面 import（P4 T2 批次 chat-renderer 迁 ESM 后不再有源码切片）；
 * 模块经桥键服务 `window.computeAssistantErrorGroups`，与应用同一条晚绑定路径。`selectWorkspaceSurface` 在生产已改为
 * 直接 import（workspace-surface-host），其宿主契约的真实实现是 app-ui 的
 * createWorkspaceSurfaceHost：整文装载 app-ui 需要整套首屏脚本序，故按仓库
 * 既有做法执行该工厂的真实源码片段（非复刻、非空心面）；导航的渲染实现
 * （app-main / sidebar-render / debug-panel 等 classic 函数）按调用契约注入。
 *
 * 断言面：模块私有 `_locateBarEl` / `_locateActive` 不再直读——浮条经可观察
 * DOM（document.body 里 id=ph-locate-bar 的元素及 class）判定，定位会话的
 * 存活/放弃经观察器 disconnect 与后续滚动是否被改写判定。
 *
 * 远程 open_session 完整链路：workspace-actions 已迁 ESM（P2 本批），真实 import
 * 后以 window.runWorkspaceAction（桥键）驱动。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { sourceBetween } from './helpers/frontend-vm.js';
import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { prepareEsmModules, prepareSidebarDomain, SESSION_VIEW_DOMAIN } from './p2-classic-hosts.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHAT_RENDERER = 'public/src/modules/chat-renderer.js';
// selectWorkspaceSurface 已是 ESM 直接 import（workspace-surface-host），其宿主
// 契约的真实实现是 app-ui 的 createWorkspaceSurfaceHost：整文装载 app-ui 需要
// 整个首屏脚本序，故按仓库既有做法执行该工厂的真实源码片段（非复刻）。
const APP_UI_SRC = fs.readFileSync(
  join(__dirname, '..', 'public', 'src', 'app-ui.js'),
  'utf8',
);

// 宿主计时器在模块装载时取好：用例把 setTimeout 注入成受控版本后，本文件
// 自己的计时逻辑仍要落到真实宿主（否则相互递归）。
const hostSetTimeout = globalThis.setTimeout;
const hostClearTimeout = globalThis.clearTimeout;

const PH_SEARCH_LOCATE = 'public/src/modules/ph-search-locate.js';
const PH_SESSION_LIST = 'public/src/modules/ph-session-list.js';

function makeElement(overrides = {}) {
  const classes = new Set();
  return {
    id: '',
    className: '',
    innerHTML: '',
    isConnected: true,
    dataset: {},
    scrollTop: 0,
    scrollHeight: 0,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      // 真实 classList 的三参形态（force 省略即取反）：迁移后的 chat-viewport
      // 跟随按钮同步按真实语义调用。
      toggle: (c, force) => {
        const enable = force === undefined ? !classes.has(c) : Boolean(force);
        if (enable) classes.add(c); else classes.delete(c);
        return enable;
      },
    },
    appendChild() {},
    append() {},
    removeChild() {},
    insertBefore() {},
    remove() {},
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    removeAttribute() {},
    getAttribute() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
    getBoundingClientRect() { return { top: 0 }; },
    dispatchEvent() {},
    ...overrides,
  };
}

/** 可控 MutationObserver：notify() 触发全部存活实例回调。 */
class FakeMutationObserver {
  constructor(callback) {
    this.callback = callback;
    this.disconnected = false;
    FakeMutationObserver.instances.push(this);
  }
  observe() {}
  disconnect() { this.disconnected = true; }
  static notify() {
    for (const observer of FakeMutationObserver.instances) {
      if (!observer.disconnected) observer.callback([]);
    }
  }
  static reset() { FakeMutationObserver.instances = []; }
}

/**
 * 定位用例：classic 宿主面 + 真实 ph-search-locate ESM 图。
 * 返回值（probe 入参）是「可观察面」：滚动容器、浮条挂载结果、请求记录。
 */
async function withLocate(probe) {
  FakeMutationObserver.reset();
  const phTabsEl = makeElement({
    dataset: {
      searchHostId: 'host-agent',
      searchDirectory: 'D:/proj',
      searchRemote: 'false',
      searchProjectId: 'dir:d/proj',
      searchHostIdAlias: undefined,
    },
  });
  const elementsById = new Map();
  const appended = [];
  const bodyEl = makeElement();
  bodyEl.appendChild = (child) => { appended.push(child); };
  const containerEl = makeElement({ scrollTop: 0, scrollHeight: 5000 });
  containerEl.getBoundingClientRect = () => ({ top: 0 });
  const byId = new Map();
  const document = {
    // 消息行 id 由用例按需登记（缺席 = 尚未渲染，定位必须继续等待）；
    // 其余宿主 id 返回稳定元素（其他前端模块装载期会绑定监听）。
    getElementById: (id) => {
      const key = String(id);
      if (key === 'chat-container') return containerEl;
      if (/^(msg-|eg-|reasoning-msg-)/.test(key)) return elementsById.get(key) || null;
      if (!byId.has(key)) byId.set(key, makeElement());
      return byId.get(key);
    },
    querySelector: (selector) => (selector === '.ph-session-tabs' ? phTabsEl : null),
    querySelectorAll: () => [],
    createElement: () => makeElement(),
    createTextNode: (text) => ({ textContent: text }),
    body: bodyEl,
    head: makeElement(),
    documentElement: makeElement(),
    // action-dispatcher 装载时在 document 绑定委托监听（真实形状补齐）。
    addEventListener() {},
    removeEventListener() {},
    readyState: 'complete',
    activeElement: null,
  };

  const viewState = {
    runtimeId: '',
    switchEpoch: 1,
    identity: { agentId: '', sessionId: '' },
    messages: [],
  };
  const calls = {
    manualScroll: [],
    followLatest: [],
    toggleErrorGroup: [],
    toggleMessage: [],
  };
  // 包装 setTimeout 记录句柄：定位成功的 flash class 定时器（2s）与等待
  // 兜底（8s）不应拖慢测试进程退出，cleanup 统一收割；flushTimers 支持用
  // 例手动推进兜底定时器（不真实等待 8s）。
  const pendingTimers = new Map();
  const wrappedSetTimeout = (callback, delay, ...args) => {
    const id = hostSetTimeout(() => { pendingTimers.delete(id); callback(...args); }, delay, ...args);
    pendingTimers.set(id, { callback, delay: Number(delay) || 0 });
    return id;
  };
  const wrappedClearTimeout = (id) => {
    pendingTimers.delete(id);
    hostClearTimeout(id);
  };
  const flushTimers = (minDelay) => {
    for (const [id, entry] of [...pendingTimers]) {
      if (entry.delay <= minDelay) {
        pendingTimers.delete(id);
        hostClearTimeout(id);
        entry.callback();
      }
    }
  };

  return withP2EsmCase({
    classic: (sandbox) => {
      sandbox.loadSource('public/src/modules/action-dispatcher.js');
      sandbox.loadSource('public/src/app-core.js');
      // i18n 已迁 ESM（P4）：t 桥键由 createFrontendSandbox 自动装载，见 test/helpers/install-i18n.js
      // 真实 workspace-surface 宿主工厂（classic app-ui）：selectWorkspaceSurface
      // 已改为直接 import，其宿主契约必须由真实工厂补全（不造空心面）。
      // 导航编排状态与调用契约（真实宿主工厂会读写它们；具体渲染实现分散在
      // app-main / app-ui / sidebar-render / debug-panel / chat-loading，本用例
      // 只消费 workspace-surface 的编排契约）。
      sandbox.loadedAgentDetailIds = new Set(['ph-host']);
      sandbox.unitModePreferences = {};
      sandbox.workspaceSurfaceModePreferences = {};
      sandbox.run(`
        window.getCurrentAgentRecord = function () { return null; };
        window.loadAgentDetail = async function () {};
        getUnitPreferenceKey = function (record) { return record && record.id ? record.id : null; };
        getUnitTabs = function () { return [{ id: 'home' }, { id: 'chat' }]; };
        getDefaultUnitMode = function () { return 'home'; };
        saveCurrentWorkspaceSurfaceScroll = function () {};
        saveCurrentRuntimeToCache = function () {};
        applySessionViewPatch = function () {};
        setFollowLatest = function () {};
        resetRuntimeBackedSurfaceState = function () {};
        beginChatLoadingSession = function () {};
        renderAgentList = function () {};
        renderCurrentMainView = function () {};
        renderFeaturePanel = function () {};
        refreshVisibleWorkspacePanelData = function () {};
      `);
      // 真实宿主工厂（app-ui 源码片段）：workspace-surface-host 在 ESM 求值期
      // 经 window.createWorkspaceSurfaceHost() 取用，因此必须先执行。
      sandbox.run(sourceBetween(APP_UI_SRC, 'function createWorkspaceSurfaceHost() {', 'function upsertConnectedAgent('));
      sandbox.run(`
        // ESM 图求值期读取的其余 loader host 工厂（最小契约替身）。
        createAgentSnapshotLoaderHost = () => ({ state: {} });
        createRuntimeSwitchHost = () => ({ state: {} });
        createCompactResumeHost = () => ({ state: {}, now: () => Date.now() });
        createAgentCallStatesHost = () => ({ state: {} });
        createSessionViewCommitHost = () => ({ state: {} });
        createP2BootstrapSidebarRenderHost = () => ({ lastAgentListRenderSignature: '' });
        // 轮询协调者宿主（owner: classic app-main；本链不加载其 boot）。真实
        // 刷新链（loadAgents → agent-data-loader → input-actions）会经它取轮询
        // 周期与定时器；本用例不断言轮询，按宿主缝给惰性实现。
        createPollCoordinatorHost = () => ({
          run: () => {},
          fastInterval: () => 0,
          setTimeout: (callback, delay) => window.setTimeout(callback, delay),
          clearTimeout: (id) => window.clearTimeout(id),
        });
      `);
    },
    globals: {
      document,
      MutationObserver: FakeMutationObserver,
      setTimeout: wrappedSetTimeout,
      clearTimeout: wrappedClearTimeout,
      requestAnimationFrame: (cb) => { cb(); return 0; },
      cancelAnimationFrame() {},
      URLSearchParams,
    },
  }, async (c) => {
    // 刷新引擎（P4 T3 起是真实 ESM）：交互域在**装载期**取它的窄宿主 createThreadStoreHost，
// 必须先于 thread-store-domain 进入同一张图。
    await c.load('public/src/modules/thread-store.js');
    await c.load(CHAT_RENDERER);
    const locate = await c.load(PH_SEARCH_LOCATE);
    const list = await c.load(PH_SESSION_LIST);
    // ESM 图求值会把 workspace-surface / chat-viewport 的宿主回调注册成
    // KernelState 访问器桥，覆盖 classic 相的同名赋值；宿主契约替身必须在整图
    // 装载后落到桥键上（模块按 window.<key> 晚绑定取用，每次读访问器）。
    // 侧栏整表重绘在本文件是副作用，不是断言面（classic 相的同名空实现会被
    // 模块求值的桥键覆盖，因此在整图装载后经桥键写回）。
    c.window.renderAgentList = () => {};
    c.window.readCurrentSessionViewState = () => viewState;
    c.window.registerManualScrollIntent = (options) => { calls.manualScroll.push(options); };
    c.window.requestFollowLatest = (options) => { calls.followLatest.push(options); };
    c.window.toggleErrorGroup = (gid) => { calls.toggleErrorGroup.push(gid); };
    c.window.toggleMessage = (id) => { calls.toggleMessage.push(id); };
    const barEl = () => appended.find((el) => el.id === 'ph-locate-bar') || null;
    let primaryError = null;
    try {
      return await probe({
        c,
        locate,
        list,
        document,
        containerEl,
        phTabsEl,
        elementsById,
        viewState,
        calls,
        barEl,
        setDataset(dataset) { Object.assign(phTabsEl.dataset, dataset); },
        addRow(id, { top = 100 } = {}) {
          const rowEl = makeElement();
          rowEl.getBoundingClientRect = () => ({ top });
          const el = makeElement();
          el.closest = () => rowEl;
          elementsById.set(id, el);
          return { el, rowEl };
        },
        barVisible() {
          const bar = barEl();
          return !!bar && bar.classList.contains('show');
        },
        flushTimers,
      });
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      // 清理悬挂的 abortTimer / flash 定时器（Back 是生产清理入口，不伪造、
      // 不直清模块私有状态）。清理失败必须可观测：用例本身通过时计为失败；
      // 用例已失败时只把清理错误挂到原错误上，绝不替换原断言错误。
      for (const id of pendingTimers.keys()) hostClearTimeout(id);
      pendingTimers.clear();
      try {
        locate.phSearchLocateBack();
      } catch (cleanupError) {
        if (!primaryError) throw cleanupError;
        if (primaryError && typeof primaryError === 'object') primaryError.cleanupError = cleanupError;
      }
    }
  });
}

function errorMessages() {
  return [
    { role: 'user', content: 'hi' }, // 0
    { role: 'assistant', execution: { status: 'failed', error: { category: 'rate_limit' } }, content: 'err-1' }, // 1
    { role: 'assistant', execution: { status: 'failed', error: { category: 'rate_limit' } }, content: 'err-2' }, // 2
    { role: 'assistant', execution: { status: 'failed', error: { category: 'rate_limit' } }, content: 'err-3' }, // 3
    { role: 'user', content: 'go' }, // 4
  ];
}

test('prepare 在进入前捕获搜索列表滚动与 dataset 项目身份', async () => {
  await withLocate(async ({ locate, list, containerEl, setDataset }) => {
    containerEl.scrollTop = 123;
    setDataset({ searchHostId: 'ph-host', searchRemote: 'false', searchProjectId: 'dir:a' });
    locate.phSearchLocatePrepare({ sessionId: 's1', messageIndex: 4 });
    // 搜索状态是 ph-session-list 的命名导出对象（跨模块共享，不再经 ClawFW 副本）
    assert.equal(list._phSearch.homeScrollTop, 123);
  });
});

test('无 messageIndex 的进入不产生定位（正常列表行为不变）', async () => {
  await withLocate(async ({ locate, containerEl, viewState, calls, addRow }) => {
    viewState.runtimeId = 'rt-1';
    viewState.identity = { agentId: 'ph-host', sessionId: 's1' };
    viewState.messages = [{ role: 'user', content: 'hi' }];
    addRow('msg-0');
    locate.phSearchLocateAfterOpen({ sessionId: 's1' });
    assert.equal(containerEl.scrollTop, 0);
    assert.equal(FakeMutationObserver.instances.length, 0);
    assert.equal(calls.manualScroll.length, 0);
  });
});

test('身份与数据已就绪时立即精确定位并显示浮条', async () => {
  await withLocate(async ({ locate, containerEl, viewState, calls, addRow, barVisible }) => {
    viewState.runtimeId = 'rt-1';
    viewState.identity = { agentId: 'ph-host', sessionId: 's1' };
    viewState.messages = errorMessages();
    const { rowEl } = addRow('msg-4', { top: 100 });
    locate.phSearchLocateAfterOpen({ sessionId: 's1', messageIndex: 4 });
    // Reserve room above the hit for the locate actions: 100 - 72 = 28.
    assert.equal(containerEl.scrollTop, 28);
    assert.ok(calls.manualScroll.some((c) => c.interrupt === true));
    assert.ok(barVisible());
    assert.ok(rowEl.classList.contains('chat-locate-flash'));
  });
});

test('远程定位身份来自目录 accessor，不依赖本机 allAgents 派生的空会话身份', async () => {
  await withLocate(async ({ c, locate, containerEl, viewState, addRow, barVisible }) => {
    c.window.isRemoteNamespaceAgentId = (id) => String(id).startsWith('remote:');
    c.window.RemoteConnections = { getEntryRuntimeSessionId: () => 'remote:a:s1' };
    viewState.runtimeId = 'remote:a:rt-1';
    viewState.identity.sessionId = '';
    viewState.messages = errorMessages();
    addRow('msg-4');
    locate.phSearchLocateAfterOpen({ sessionId: 'remote:a:s1', messageIndex: 4 });
    assert.ok(barVisible());
    assert.ok(containerEl.scrollTop > 0);
  });
});

test('加载提交之前不抢位：身份/数据/DOM 落定后经 observer 定位', async () => {
  await withLocate(async ({ locate, containerEl, viewState, addRow, barVisible }) => {
    // 落定后身份还没到（loadAgentData 未提交）：不滚、不显示浮条。
    locate.phSearchLocateAfterOpen({ sessionId: 's1', messageIndex: 4 });
    assert.equal(containerEl.scrollTop, 0);
    assert.ok(!barVisible());

    // 数据提交（messages 到位）+ 渲染 DOM + 身份落地。
    viewState.runtimeId = 'rt-9';
    viewState.identity = { agentId: 'ph-host', sessionId: 's1' };
    viewState.messages = errorMessages();
    addRow('msg-4');
    FakeMutationObserver.notify();
    assert.ok(containerEl.scrollTop > 0);
    assert.ok(barVisible());
  });
});

test('消息数据长度未覆盖目标索引时等待，不猜测滚动', async () => {
  await withLocate(async ({ locate, containerEl, viewState, addRow, barVisible }) => {
    viewState.runtimeId = 'rt-1';
    viewState.identity = { agentId: 'ph-host', sessionId: 's1' };
    viewState.messages = errorMessages().slice(0, 2); // 目标 index 4 未到
    addRow('msg-4');
    locate.phSearchLocateAfterOpen({ sessionId: 's1', messageIndex: 4 });
    assert.equal(containerEl.scrollTop, 0);
    assert.ok(!barVisible());

    viewState.messages = errorMessages();
    FakeMutationObserver.notify();
    assert.ok(containerEl.scrollTop > 0);
  });
});

test('错误组非首消息：精确映射到组首行并展开组（不回扫猜下标）', async () => {
  await withLocate(async ({ locate, containerEl, viewState, calls, addRow }) => {
    viewState.runtimeId = 'rt-1';
    viewState.identity = { agentId: 'ph-host', sessionId: 's1' };
    viewState.messages = errorMessages(); // 1..3 成组，组首 eg-1
    const { rowEl } = addRow('eg-1', { top: 200 });
    // 组内非首消息 msg-2 自身 id 在 DOM 中不存在（渲染层跳过）。
    locate.phSearchLocateAfterOpen({ sessionId: 's1', messageIndex: 2 });
    assert.equal(containerEl.scrollTop, 128); // 200 - 72
    assert.ok(rowEl.classList.contains('chat-locate-flash'));
    assert.deepEqual(calls.toggleErrorGroup, ['eg-1']);
  });
});

test('身份守卫：用户已切到别的会话时放弃定位', async () => {
  await withLocate(async ({ locate, containerEl, viewState, addRow, barVisible }) => {
    viewState.runtimeId = 'rt-1';
    viewState.identity = { agentId: 'ph-host', sessionId: 's1' };
    viewState.messages = errorMessages();
    addRow('msg-4');
    locate.phSearchLocateAfterOpen({ sessionId: 's1', messageIndex: 4 });
    assert.ok(barVisible());

    // 用户切走：身份漂移后 observer 触发 → 放弃且浮条不遗留（观察器全部断开，
    // 后续 notify 不再改写滚动位置）。
    viewState.runtimeId = 'rt-2';
    viewState.identity = { agentId: 'ph-host', sessionId: 'other' };
    containerEl.scrollTop = 0;
    FakeMutationObserver.notify();
    assert.ok(!barVisible());
    assert.ok(FakeMutationObserver.instances.every((o) => o.disconnected), 'locate observers are torn down');
    FakeMutationObserver.notify();
    assert.equal(containerEl.scrollTop, 0, 'no late scroll write after abandonment');
  });
});

test('防迟到抢位：新一次定位使旧 observer 回调失效', async () => {
  await withLocate(async ({ locate, containerEl, viewState, addRow }) => {
    addRow('msg-4', { top: 100 });
    // 第一次定位进入等待：身份尚未落定（loadAgentData 未提交），保持观察。
    assert.equal(viewState.identity.sessionId, '');
    locate.phSearchLocateAfterOpen({ sessionId: 's1', messageIndex: 4 });
    assert.equal(containerEl.scrollTop, 0);
    const firstObservers = [...FakeMutationObserver.instances];

    // 第二次定位接管：身份立即就绪（目标换成普通行，避免错误组路径）。
    viewState.runtimeId = 'rt-1';
    viewState.identity = { agentId: 'ph-host', sessionId: 's1' };
    viewState.messages = errorMessages();
    addRow('msg-0', { top: 300 });
    locate.phSearchLocateAfterOpen({ sessionId: 's1', messageIndex: 0 });
    assert.ok(containerEl.scrollTop > 0);
    assert.ok(firstObservers.every((o) => o.disconnected));
    const scrollTopAfterSecond = containerEl.scrollTop;

    // 旧 observer 实例若被人为再次触发也不应再改动滚动位置。
    for (const observer of firstObservers) {
      observer.disconnected = false;
      observer.callback([]);
    }
    assert.equal(containerEl.scrollTop, scrollTopAfterSecond);
  });
});

test('定位尚未锁定身份时切走：取消观察且超时后不显示失败浮条', async () => {
  await withLocate(async ({ locate, viewState, flushTimers, barVisible }) => {
    locate.phSearchLocateAfterOpen({ sessionId: 's1', messageIndex: 4 });
    viewState.switchEpoch += 1;
    FakeMutationObserver.notify();
    flushTimers(8000);
    assert.ok(FakeMutationObserver.instances.every((o) => o.disconnected), 'observation cancelled');
    assert.ok(!barVisible());
  });
});

test('回最新：复用 follow-latest 强制跟随并收起浮条', async () => {
  await withLocate(async ({ locate, viewState, calls, addRow, barVisible }) => {
    viewState.runtimeId = 'rt-1';
    viewState.identity = { agentId: 'ph-host', sessionId: 's1' };
    viewState.messages = errorMessages();
    addRow('msg-4');
    locate.phSearchLocateAfterOpen({ sessionId: 's1', messageIndex: 4 });
    assert.ok(barVisible());
    locate.phSearchLocateLatest();
    assert.equal(calls.followLatest.length, 1);
    assert.equal(calls.followLatest[0].forceEnable, true);
    assert.ok(!barVisible());
  });
});

test('返回搜索：回宿主 home surface、恢复远程项目视图与列表滚动', async () => {
  await withLocate(async ({ c, locate, list, containerEl, viewState, addRow, setDataset, barVisible }) => {
    containerEl.scrollTop = 321;
    setDataset({ searchHostId: 'ph-host', searchRemote: 'true', searchProjectId: 'dir:remote-p' });
    locate.phSearchLocatePrepare({ sessionId: 's1', messageIndex: 4 });
    viewState.runtimeId = 'rt-1';
    viewState.identity = { agentId: 'ph-host', sessionId: 's1' };
    viewState.messages = errorMessages();
    addRow('msg-4');
    locate.phSearchLocateAfterOpen({ sessionId: 's1', messageIndex: 4 });
    assert.ok(barVisible());

    containerEl.scrollTop = 0;
    locate.phSearchLocateBack();
    // 真实 selectWorkspaceSurface（ESM import）已完成工作区导航：宿主记录被设为
    // 焦点，并落到 home surface（宿主工厂来自 app-ui 真实源码片段）。
    assert.equal(c.read('focusedAgentId'), 'ph-host', 'Back navigates to the host workspace');
    assert.equal(c.read('currentWorkspaceTab'), 'home', 'lands on the home surface');
    // 远程视图恢复：目标状态是 ph-session-list 的命名导出（session-list-render
    // 直接 import 消费，不再经 window.ClawFW 副本）。
    assert.equal(list.getPhSurfaceViewProjectId(), 'dir:remote-p');
    assert.ok(!barVisible());
    // home 骨架重渲染（rAF）后恢复搜索列表滚动位置。
    assert.equal(containerEl.scrollTop, 321);
  });
});

test('用户折叠的消息定位时经真实 toggle 展开以可见命中原文', async () => {
  await withLocate(async ({ locate, containerEl, viewState, calls, addRow }) => {
    viewState.runtimeId = 'rt-1';
    viewState.identity = { agentId: 'ph-host', sessionId: 's1' };
    viewState.messages = errorMessages();
    const { el } = addRow('msg-4');
    el.classList.add('collapsed');
    locate.phSearchLocateAfterOpen({ sessionId: 's1', messageIndex: 4 });
    assert.deepEqual(calls.toggleMessage, ['msg-4']);
    assert.ok(containerEl.scrollTop > 0);
    // 未折叠的消息不触发多余 toggle。
    locate.phSearchLocateAfterOpen({ sessionId: 's1', messageIndex: 0 });
    assert.equal(calls.toggleMessage.length, 1);
  });
});

test('定位超时/索引失效不静默：显示可关闭失败说明并支持返回搜索', async () => {
  await withLocate(async ({ locate, viewState, addRow, flushTimers, barEl, barVisible }) => {
    // 身份永远不落位（目标会话从未成为当前视图）→ 等待至兜底超时。
    viewState.runtimeId = 'rt-other';
    viewState.identity = { agentId: 'ph-host', sessionId: 'other' };
    viewState.messages = errorMessages();
    addRow('msg-4');
    locate.phSearchLocateAfterOpen({ sessionId: 's1', messageIndex: 4 });
    assert.ok(!barVisible());
    flushTimers(8000); // 推进 8s 兜底（不真实等待）
    const bar = barEl();
    assert.ok(bar.classList.contains('show'));
    assert.ok(String(bar.innerHTML).includes('data-action="phSearch.back"'));
    assert.ok(String(bar.innerHTML).includes('data-action="phSearch.dismiss"'));
    // 返回搜索可用且收起失败说明。
    locate.phSearchLocateBack();
    assert.ok(!bar.classList.contains('show'));
  });
});

// ── 远程 open_session 完整链路（workspace-actions 远程分支）────────────────

/**
 * 真实加载 remote-connections.js（splitRemoteNamespaceId /
 * getEntryHostNamespaceId 真实行为）+ workspace-actions.js（激活分支，已迁 ESM
 * 真实 import）。catalog 不含目标会话：宿主只能来自显式 action.agentId（搜索召回
 * 场景）。
 *
 * 观察面（迁移后重钉，不用产品可替换钩子）：
 *   - 进入前捕获：ph-search-locate 的真实 prepare 会读 `.ph-session-tabs`
 *     并把容器滚动位置写进 ph-session-list 的 `_phSearch.homeScrollTop`——
 *     前者以 document.querySelector 记录顺序，后者直接读命名导出状态；
 *   - 落定接定位：真实 afterOpen 在身份未落定时注册 MutationObserver 观察
 *     滚动容器（DOM 边界可观测），且必须发生在 switchAgent 之后；
 *   - 动作透传（messageIndex 原样交给定位钩子）由本文件末尾的源码契约兜住。
 */
const WORKSPACE_ACTIONS = 'public/src/modules/workspace-actions.js';

function makeLocateContainer() {
  // 定位滚动容器（#chat-container）的等价替身。真实切换收尾的 loadAgentData
  // 会在这棵子树里同步回退按钮（querySelectorAll），因此除滚动面外还要给出
  // 最小 DOM 查询面——这不是被测契约。
  return {
    scrollTop: 0,
    scrollHeight: 5000,
    clientHeight: 600,
    innerHTML: '',
    children: [],
    dataset: {},
    getBoundingClientRect: () => ({ top: 0 }),
    dispatchEvent: () => {},
    classList: { add() {}, remove() {}, contains: () => false },
    querySelector: () => null,
    querySelectorAll: () => [],
    appendChild(child) { this.children.push(child); return child; },
    removeChild() {},
    addEventListener() {},
    removeEventListener() {},
  };
}

async function withRemoteActionsCase({ bumpEpochDuringWait = false } = {}, probe) {
  const requests = [];
  const events = { switchAgent: [], alerts: [], order: [], locateObserved: 0 };
  const container = makeLocateContainer();
  class RecordingMutationObserver {
    constructor(callback) { this.callback = callback; }
    observe(target) {
      if (target !== container) return;
      events.locateObserved += 1;
      events.order.push('locate');
    }
    disconnect() {}
  }
  return withP2EsmCase({
    classic: (sandbox) => {
      sandbox.loadSource('public/src/modules/action-dispatcher.js');
      // i18n 已迁 ESM（P4）：t 桥键由 createFrontendSandbox 自动装载，见 test/helpers/install-i18n.js
      sandbox.loadSource('public/src/app-core.js');
      prepareEsmModules(sandbox, SESSION_VIEW_DOMAIN);
      // runtime-status 是 classic 唯一实现：真实切换收尾的 loadAgentData 经
      // resetRuntimeStatusForSwitch 复位运行期状态。
      prepareSidebarDomain(sandbox);
      // ESM 图求值期需要的 classic 宿主工厂（owner: app-main / app-ui /
      // sidebar-render；本链不加载其首屏实现）：按宿主缝给最小面。
      sandbox.window.createCompactResumeHost = () => ({});
      // 真实 ESM switchAgent（runtime-switch）的宿主面：切换落点经 persistFocus
      // 宿主缝记录；不放 window.switchAgent 替身（那会绕开真实切换实现）。
      const onSwitch = (runtimeId) => { events.switchAgent.push(runtimeId); events.order.push('switch'); };
      const noop = () => {};
      const falsy = () => false;
      sandbox.window.createRuntimeSwitchHost = () => ({
        state: {
          pendingSwitchTarget: null, pendingSwitchSerial: 0, navigationEpoch: 0, switchEpoch: 0,
          focusedAgentId: null, runtimeId: null, readOnlyMode: false, lastRenderedWorkspaceHtml: '',
          followLatest: false, restoredScrollTop: 0,
        },
        switchAgent: async (runtimeId) => { onSwitch(String(runtimeId)); },
        setTimeout: (callback, delay) => sandbox.window.setTimeout(callback, delay),
        hasPendingNavigation: falsy, bumpNavigationGuard: noop, closeContextMenu: noop,
        findAgent: () => null, isWorkspaceHost: falsy,
        runtimeId: (agent) => agent?.runtime_session_id || agent?.id || '',
        agentRuntimeId: (agent) => agent?.runtime_session_id || agent?.id || '',
        isRemote: falsy, remote: () => sandbox.window.RemoteConnections || null,
        closeReadOnlySession: noop, isWorkspaceSurface: falsy, selectWorkspace: noop,
        storeDraft: noop, saveWorkspaceScroll: noop, saveCache: noop,
        logicalId: (agent) => agent?.id || '', normalize: (value) => String(value || ''),
        clearFinished: noop, deriveSession: () => '', bindSession: noop, updateThreadIndicators: noop,
        browseOnly: falsy, resetSurface: noop, resetScroll: noop, resetStatus: noop,
        activateCollapse: noop, contextKey: () => '', restoreCache: () => null, setPendingScroll: noop,
        render: noop, renderPanel: noop, patch: noop,
        emptyOverview: () => ({}), emptyTodo: () => ({}),
        setFollowLatest: noop, beginFollowWindows: noop, renderAgents: noop,
        fetch: (...args) => sandbox.window.fetch(...args),
        applyCalling: noop, syncActionButton: noop, isCalling: falsy,
        persistFocus: (runtimeId) => { onSwitch(String(runtimeId)); },
        warn: noop, error: noop, alert: noop, clearLoading: noop,
      });
      sandbox.window.createWorkspaceEntryHost = () => ({});
      sandbox.window.createWorkspaceSurfaceHost = () => ({});
      sandbox.window.createAgentSnapshotLoaderHost = () => ({ state: {} });
      sandbox.window.createAgentCallStatesHost = () => ({});
      sandbox.window.createPollCoordinatorHost = () => ({
        run: () => {},
        fastInterval: () => 0,
        setTimeout: (callback, delay) => sandbox.window.setTimeout(callback, delay),
        clearTimeout: (id) => sandbox.window.clearTimeout(id),
      });
      sandbox.window.createP2BootstrapSidebarRenderHost = () => {
        let signature = '';
        return Object.freeze({
          get lastAgentListRenderSignature() { return signature; },
          set lastAgentListRenderSignature(value) { signature = value; },
        });
      };
      // 定位滚动容器：真实 domRefs.container（#chat-container）的等价替身。
      const realDomHost = sandbox.window.createP2BootstrapDomHost;
      sandbox.window.createP2BootstrapDomHost = () => ({ ...realDomHost(), container });
      // 远程激活成功会经真实 toast-notify 弹提示：它的 buildToastElement 用
      // createElement 造节点、再用 querySelector 取子节点挂监听，默认元素桩的
      // querySelector 返回 null 会在提示渲染上抛错（宿主 DOM 边界，非被测契约）。
      const makeToastNode = () => ({
        style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        children: [], innerHTML: '', textContent: '', title: '', className: '', type: '',
        scrollTop: 0, scrollHeight: 0, offsetHeight: 0, clientHeight: 0, isConnected: true,
        appendChild(child) { this.children.push(child); return child; },
        insertBefore(child) { this.children.push(child); return child; },
        removeChild() {}, remove() {},
        addEventListener() {}, removeEventListener() {},
        setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
        querySelector() { return makeToastNode(); },
        querySelectorAll() { return []; },
        focus() {}, blur() {},
      });
      // 就地补面（不整体替换 document）：ESM 侧读到的是 case 开始时注入的同一个
      // document 对象（浏览器里 window.document 恒在、模块不会拿到旧对象）。
      sandbox.document.createElement = () => makeToastNode();
      sandbox.document.createElementNS = () => makeToastNode();
      sandbox.document.createTextNode = (text) => ({ textContent: String(text) });
      // prepare 的 DOM 读取边界（进入前捕获）与串行顺序观测。
      const realQuerySelector = sandbox.document.querySelector;
      sandbox.document.querySelector = (selector) => {
        if (String(selector) === '.ph-session-tabs') events.order.push('prepare');
        return typeof realQuerySelector === 'function' ? realQuerySelector(selector) : null;
      };
      sandbox.window.alert = (msg) => { events.alerts.push(String(msg)); };
      sandbox.window.markActionLoading = () => {};
      sandbox.window.renderCurrentMainView = () => {};
      // 真实切换 / 状态刷新链读的 classic 宿主面（owner: app-core / app-main /
      // app-ui / persistent-input）：本用例世界没有可渲染视图与运行中 runtime。
      sandbox.window.renderFeaturePanel = () => {};
      sandbox.window.getCurrentRuntimeRecord = () => null;
      sandbox.window.getCurrentAgentRecord = () => null;
      sandbox.window._syncPersistentActionButton = () => {};
      // 宿主 IPC 回执真实 wire 形状：连接快照是数组，其余命令是对象。
      sandbox.window.invoke = async (command) => (command === 'get_connected_agents' ? [] : {});
    },
    globals: {
      navigator: undefined,
      MutationObserver: RecordingMutationObserver,
      fetch: async (url, init) => {
        requests.push({ url: String(url), init });
        const path = String(url).split('?')[0];
        if (path === '/protoclaw/prebuilt_sessions/activate') {
          events.order.push('activate');
          return {
            ok: true,
            status: 200,
            json: async () => ({ ok: true, session: { id: 'session-x', title: 'T' } }),
            text: async () => '',
          };
        }
        return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
      },
    },
  }, async (c) => {
    // 刷新引擎（P4 T3 起是真实 ESM）：交互域在**装载期**取它的窄宿主
    // createThreadStoreHost，必须先于 thread-store-domain 进入同一张图。
    await c.load('public/src/modules/thread-store.js');
    // 远程目录 accessor（已迁 ESM，P4 T3）：真实 import 后 window.RemoteConnections
    // 才存在；就绪观察的覆盖与 workspace-actions 的取用都在它之后。
    await c.load('public/src/modules/remote-connections.js');
    const list = await c.load(PH_SESSION_LIST);
    await c.load(WORKSPACE_ACTIONS);
    // 就绪观察：不真实轮询；等待期间可选模拟用户切走（bump 代次）。
    c.window.RemoteConnections.waitForRuntimeForSession = async () => {
      if (bumpEpochDuringWait) c.window.bumpNavigationGuard();
      return 'remote:server-a:rt-x';
    };
    return probe({ c, requests, events, container, list });
  });
}

test('远程搜索结果进入：action.agentId 优先（同连接校验）→ activate → 落定接定位', async () => {
  await withRemoteActionsCase({}, async ({ c, requests, events, container, list }) => {
    container.scrollTop = 321;
    await c.read(`window.runWorkspaceAction(${JSON.stringify({
      type: 'open_session',
      sessionId: 'remote:server-a:session-x',
      agentId: 'remote:server-a:programming-helper',
      messageIndex: 3,
    })}, null)`);
    // 进入前捕获：真实 prepare 读搜索面 dataset，并把列表滚动位置交给
    // ph-session-list 的搜索状态（返回搜索时恢复）。
    assert.equal(list._phSearch.homeScrollTop, 321, '进入前捕获搜索列表滚动');
    assert.ok(events.order.includes('prepare'), '进入前捕获已执行');
    assert.ok(
      events.order.indexOf('prepare') < events.order.indexOf('activate'),
      '捕获先于远程分支（activate）',
    );
    // activate 以显式宿主命名空间寻址（目录未含该会话，查找本会落空）。
    const activate = requests.find((r) => r.url.includes('/protoclaw/prebuilt_sessions/activate'));
    assert.ok(activate, 'activate requested');
    assert.equal(JSON.parse(activate.init.body).agentId, 'remote:server-a:programming-helper');
    // 落定：switchAgent 后接定位（真实 afterOpen 开始观察滚动容器等待身份）。
    assert.deepEqual(events.switchAgent, ['remote:server-a:rt-x']);
    assert.equal(events.locateObserved, 1, '落定后定位机制启动（观察滚动容器）');
    assert.ok(
      events.order.indexOf('switch') < events.order.indexOf('locate'),
      '定位在切换落定之后',
    );
  });
});

test('远程等待期间用户已切走：导航代次守卫放弃切换，不抢焦点', async () => {
  await withRemoteActionsCase({ bumpEpochDuringWait: true }, async ({ c, events }) => {
    await c.read(`window.runWorkspaceAction(${JSON.stringify({
      type: 'open_session',
      sessionId: 'remote:server-a:session-x',
      agentId: 'remote:server-a:programming-helper',
      messageIndex: 3,
    })}, null)`);
    assert.equal(events.switchAgent.length, 0, 'must not steal focus after user navigated away');
    assert.equal(events.locateObserved, 0, '不得启动定位');
  });
});

test('跨连接的显式宿主不被采用，目录也无该会话时显式失败', async () => {
  await withRemoteActionsCase({}, async ({ c, requests, events }) => {
    await c.read(`window.runWorkspaceAction(${JSON.stringify({
      type: 'open_session',
      sessionId: 'remote:server-a:session-x',
      agentId: 'remote:server-b:programming-helper',
      messageIndex: 1,
    })}, null)`);
    assert.equal(requests.filter((r) => r.url.includes('/activate')).length, 0, 'no activate for cross-connection host');
    assert.equal(events.switchAgent.length, 0);
    assert.equal(events.alerts.length, 1);
  });
});

test('远程激活链把原始 action（含 messageIndex）原样交给定位钩子', async () => {
  // 行为面观测退化为「定位机制已启动」（动作透传在真实模块内部，无产品可替换
  // 接缝）；消息下标原样透传由源码契约钉住，避免重构时静默丢失定位参数。
  const source = fs.readFileSync(
    join(__dirname, '..', 'public', 'src', 'modules', 'workspace-actions.js'),
    'utf8',
  );
  assert.match(source, /phSearchLocateAfterOpen\(locateAction\)/);
});

test('返回搜索的滚动恢复有防迟到守卫：已离开搜索面不再写滚动', async () => {
  await withLocate(async ({ locate, document, containerEl, viewState, addRow, setDataset, barVisible }) => {
    containerEl.scrollTop = 321;
    setDataset({ searchHostId: 'ph-host', searchRemote: 'true', searchProjectId: 'dir:remote-p' });
    locate.phSearchLocatePrepare({ sessionId: 's1', messageIndex: 4 });
    viewState.runtimeId = 'rt-1';
    viewState.identity = { agentId: 'ph-host', sessionId: 's1' };
    viewState.messages = errorMessages();
    addRow('msg-4');
    locate.phSearchLocateAfterOpen({ sessionId: 's1', messageIndex: 4 });
    assert.ok(barVisible());

    // 恢复 rAF 回调执行时用户已不在搜索面（.ph-session-tabs 缺席）。
    const realQuerySelector = document.querySelector;
    document.querySelector = () => null;
    containerEl.scrollTop = 0;
    try {
      locate.phSearchLocateBack();
      assert.equal(containerEl.scrollTop, 0);
    } finally {
      document.querySelector = realQuerySelector;
    }
  });
});
