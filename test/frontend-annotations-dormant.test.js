/* global window */
/**
 * 会话标注前端模块：dormant（前身会话标注）契约回归测试。
 *
 * 背景：summary 系接续（summarized-* handoff）后 transcript 从 turn 0 重新
 * 编号，feature 端导入的旧标注一律降级 dormant（见
 * local-features/conversation-annotations）。前端契约：
 * - 重放匹配绝不让 dormant 参与——其 turn 与本会话消息的同值 turn 只是
 *   编号巧合，匹配即误高亮（本测试用 createTreeWalker 观察点区分：
 *   只有真正进入锚点匹配路径的行才会构建文本模型）。
 *
 * 装载路线（ESM 迁移配方第三节）：test/helpers/esm-module-loader.js 的真实
 * import。annotations.js 的全局裸引用面是 window/document + Node / NodeFilter /
 * requestAnimationFrame / EventSource / fetch——window/document 由 loader 装桩，
 * 其余浏览器内建由本测试显式安装并在 after() 还原（navigator 是 Node 内建只读
 * 全局，无需注入）。状态与 Toast 走已 ESM 化的模块（orchestration / agent-store /
 * session-view-storage / toast-notify 直接 import），测试用状态模块 setter 驱动，
 * 不再注入 sandbox 全局。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserStubs, loadModuleOnce } from './helpers/esm-module-loader.js';

const MODULE = 'public/src/modules/annotations.js';

const eventSources = [];
const rafQueue = [];
let treeWalkerRoots = [];
let chatRows = [];
let fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ result: { ok: true, annotations: [] } }) });

let cleanupGlobals;
let restoreBrowserGlobals;
let orchestration; // 状态模块实例（annotations.js 的 import 解析到同一份）
let agentStore;
let sessionStorage;
let i18n;

class FakeEventSource {
  constructor(url) {
    this.url = String(url);
    this.listeners = new Map();
    this.closed = false;
    eventSources.push(this);
  }
  addEventListener(type, cb) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(cb);
  }
  close() { this.closed = true; }
}

/** 浏览器全局（loader 只管 window/document）：安装 + 返回还原函数。 */
function installBrowserGlobals() {
  const previous = new Map();
  const set = (key, value) => {
    previous.set(key, globalThis[key]);
    globalThis[key] = value;
  };
  set('Node', { TEXT_NODE: 3, ELEMENT_NODE: 1 });
  set('NodeFilter', { SHOW_TEXT: 4 });
  // navigator 是 Node 内建只读全局（粘贴路径用 navigator.clipboard，本用例不触达）
  set('requestAnimationFrame', (cb) => { rafQueue.push(cb); return rafQueue.length; });
  set('EventSource', FakeEventSource);
  set('fetch', (...args) => fetchImpl(...args));
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  };
}

before(async () => {
  cleanupGlobals = installBrowserStubs({
    window: {
      escapeHtml: (text) => String(text ?? ''),
      getSelection: () => ({ isCollapsed: true, rangeCount: 0, anchorNode: null }),
    },
    document: {
      addEventListener() {},
      removeEventListener() {},
      getElementById: (id) => (id === 'chat-container'
        ? {
            querySelectorAll: (selector) => (selector.startsWith('.message-content') ? chatRows : []),
            contains: () => false,
          }
        : null),
      createTreeWalker(root) {
        treeWalkerRoots.push(root);
        return { nextNode: () => null }; // 空文本模型：锚点失配静默跳过，无需 Range/mark DOM
      },
    },
  });
  restoreBrowserGlobals = installBrowserGlobals();

  // 桥/状态模块的 canonical 实例（与 annotations.js 的 import 同一份）
  await loadModuleOnce('public/src/modules/kernel-state.js', { installGlobals: false });
  orchestration = await import('../public/src/modules/orchestration-state.js');
  agentStore = await import('../public/src/modules/agent-store-state.js');
  sessionStorage = await import('../public/src/modules/session-view-storage.js');
  i18n = await import('../public/src/modules/i18n-environment-state.js');
});

after(() => {
  restoreBrowserGlobals();
  cleanupGlobals();
});

/** 每个用例的固定状态（真实状态模块 setter 驱动）+ 全新 annotations 实例。 */
async function setup({ annotations }) {
  eventSources.length = 0;
  rafQueue.length = 0;
  treeWalkerRoots = [];
  // 两行消息：msg-1（live 标注锚位）、msg-3（与 dormant 标注 turn 数字碰撞的行）。
  const rowLive = { id: 'msg-1', querySelectorAll: () => [] };
  const rowCollide = { id: 'msg-3', querySelectorAll: () => [] };
  chatRows = [rowLive, rowCollide];

  i18n.setCurrentLanguage('zh');
  agentStore.setFocusedAgentId('programming-helper');
  orchestration.setCurrentRuntimeAgentId('runtime-old');
  sessionStorage.setCurrentMessages([
    null,
    { turn: 1, role: 'assistant' },
    null,
    { turn: 3, role: 'assistant' },
  ]);
  // 会话身份（P4 T1：owner 是 identity 域）：viewer 侧绑定由生产 switchAgent 建立
  const identity = await import('../public/src/modules/identity.js');
  identity.setViewerSessionBinding('runtime-old', 'sess-A');
  window.isRemoteNamespaceAgentId = () => false;

  fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ result: { ok: true, annotations } }),
  });

  const { module } = await loadModuleOnce(MODULE, { installGlobals: false });
  return { module, rowLive, rowCollide };
}

async function flushAsync() {
  for (let turn = 0; turn < 20 && rafQueue.length > 0; turn++) {
    while (rafQueue.length > 0) rafQueue.shift()();
    for (let i = 0; i < 6; i++) await Promise.resolve();
  }
}

test('dormant：不进入锚点匹配路径，与碰撞行同值 turn 只是编号巧合', async () => {
  const live = { id: 'live-1', turn: 1, role: 'assistant', quote: '本会话正文', occurrence: 0, createdAt: 2 };
  const dormant = {
    id: 'dorm-1', turn: 3, role: 'assistant', quote: '前身结论', occurrence: 0, createdAt: 1,
    dormant: true, originSession: 's-old',
  };
  const { module, rowLive } = await setup({ annotations: [dormant, live] });

  module.scheduleReplay();
  await flushAsync();

  // 重放：live（turn 1）匹配 msg-1 进入锚点匹配路径（观察点命中证明路径可达）；
  // dormant（turn 3）与 msg-3 的同值 turn 是编号巧合——绝不进入匹配路径。
  assert.deepEqual(treeWalkerRoots, [rowLive], '只有 live 行构建文本模型；dormant 行被跳过');
  // 消费方（chat-renderer）经既有命名空间协议拿到同一实现
  assert.equal(window.ClawAnnotations.scheduleReplay, module.scheduleReplay);
});
