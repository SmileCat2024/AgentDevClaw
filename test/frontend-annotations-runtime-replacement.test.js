/* global window */
/**
 * 会话标注前端模块：runtime 换代（关闭对话 → 重开同一会话）后的重同步回归测试。
 *
 * 背景（历史 bug）：runtime 停止时服务端 closeSession 会让前端收到 SSE closed，
 * annotations.js 据此清空缓存并断开事件流；重开同一会话时 sessionId 不变，
 * ensureSession 只按 agentId/sessionId 去重 → 永远跳过重同步，标注不再显示。
 * 接续（sessionId 变化）不受影响。修复：同会话出现新 runtime ref 时强制重同步。
 *
 * 驱动路径必须是 scheduleReplay（chat-renderer 渲染后的真实触发源），
 * 经 ensureSession 的按需去重路径触发同步。
 *
 * 观察点：createTreeWalker 调用记录——只有缓存中的标注匹配到消息行、
 * 真正进入锚点匹配路径时才会构建文本模型；list 请求与 EventSource 计数
 * 验证同步行为本身。
 *
 * 装载路线（ESM 迁移配方第三节）：真实 import。状态依赖（焦点 / runtime ref /
 * 当前消息）由已 ESM 化的状态模块 setter 驱动；window 上的寻址函数
 * （getRuntimeWorkspaceSessionId 等）已迁 identity 域（P4 T1），本用例按生产
 * switchAgent 的同一入口（viewer 侧绑定）播种。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserStubs, loadModuleOnce } from './helpers/esm-module-loader.js';

const MODULE = 'public/src/modules/annotations.js';

const eventSources = [];
const fetchCalls = [];
const rafQueue = [];
let treeWalkerRoots = [];
let sessionByRuntime = new Map();
let fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ result: { ok: true, annotations: [] } }) });

let cleanupGlobals;
let restoreBrowserGlobals;
let orchestration;
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
  dispatch(type, payload = {}) {
    for (const cb of this.listeners.get(type) || []) {
      cb({ data: JSON.stringify(payload) });
    }
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
  // 确定性 rAF：用例自己排空队列，不依赖定时器精度
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
  const rowAnchored = { id: 'msg-1', querySelectorAll: () => [] };
  cleanupGlobals = installBrowserStubs({
    window: {
      escapeHtml: (text) => String(text ?? ''),
      ClawToast: { show() {} },
      getSelection: () => ({ isCollapsed: true, rangeCount: 0, anchorNode: null }),
    },
    document: {
      addEventListener() {},
      removeEventListener() {},
      getElementById: (id) => (id === 'chat-container'
        ? {
            querySelectorAll: (selector) => (selector.startsWith('.message-content') ? [rowAnchored] : []),
            contains: () => false,
          }
        : null),
      createTreeWalker(root) {
        treeWalkerRoots.push(root);
        return { nextNode: () => null };
      },
    },
  });
  restoreBrowserGlobals = installBrowserGlobals();

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

async function setup() {
  fetchCalls.length = 0;
  eventSources.length = 0;
  rafQueue.length = 0;
  treeWalkerRoots = [];
  const annotation = {
    id: 'anno-1', turn: 1, role: 'assistant',
    quote: '被标注的文本', occurrence: 0, createdAt: 1,
  };

  i18n.setCurrentLanguage('zh');
  agentStore.setFocusedAgentId('programming-helper');
  orchestration.setCurrentRuntimeAgentId('runtime-old');
  sessionStorage.setCurrentMessages([null, { turn: 1, role: 'assistant' }]);
  sessionByRuntime = new Map([['runtime-old', 'sess-A'], ['runtime-new', 'sess-A'], ['runtime-new2', 'sess-B']]);
  // 会话身份（P4 T1 起 owner 是 identity 域）：生产里 switchAgent 建立 viewer 侧
  // runtimeId → sessionId 绑定；本用例按同一入口播种全部 runtime 的绑定。
  const identity = await import('../public/src/modules/identity.js');
  for (const [ref, sessionId] of sessionByRuntime) identity.setViewerSessionBinding(ref, sessionId);
  window.isRemoteNamespaceAgentId = () => false;

  fetchImpl = async (url, options) => {
    fetchCalls.push({ url: String(url), body: options ? JSON.parse(options.body) : null });
    return {
      ok: true,
      status: 200,
      json: async () => ({ result: { ok: true, annotations: [annotation] } }),
    };
  };

  const { module } = await loadModuleOnce(MODULE, { installGlobals: false });
  return { module };
}

function listRequestCount() {
  return fetchCalls.filter((call) =>
    call.url.includes('/protoclaw/feature-comms/request')
    && call.body?.requestType === 'list').length;
}

// 确定性排空 rAF 与其触发的 Promise 链：手动 scheduleReplay →
// ensureSession 发起 loadList → resolve 后再次 scheduleReplay → 重放。
async function flushAsync(predicate = () => true) {
  for (let turn = 0; turn < 100; turn++) {
    while (rafQueue.length > 0) rafQueue.shift()();
    for (let i = 0; i < 6; i++) await Promise.resolve();
    if (rafQueue.length === 0 && predicate()) {
      // 再让一轮已触发的 Promise continuation 有机会排入 rAF 队列。
      await Promise.resolve();
      if (rafQueue.length === 0 && predicate()) return;
    }
  }
  throw new Error(`异步重放未收敛（待执行 rAF=${rafQueue.length}）`);
}

test('同会话 runtime 换代后 scheduleReplay 触发重同步并恢复标注', async () => {
  const { module } = await setup();

  // 初始：runtime-old 在位，渲染触发首次同步，标注参与重放（锚点匹配路径命中）。
  module.scheduleReplay();
  await flushAsync();
  assert.equal(listRequestCount(), 1);
  assert.equal(treeWalkerRoots.length, 1, '标注已拉回缓存并驱动重放');
  assert.match(eventSources[0].url, /sessionId=sess-A/);
  assert.match(eventSources[0].url, /featureId=conversation-annotations/);

  // 关闭对话：runtime 停止 → 服务端 closeSession → SSE closed → 前端清空缓存。
  eventSources[0].dispatch('closed');
  await flushAsync();
  module.scheduleReplay();
  await flushAsync();
  assert.equal(treeWalkerRoots.length, 1, 'closed 后缓存清空，重放不再命中锚点匹配');
  assert.ok(eventSources[0].closed);

  // runtime 不在位（ref 空）期间渲染：不得重订阅（死会话不轮询）。
  orchestration.setCurrentRuntimeAgentId('');
  module.scheduleReplay();
  await flushAsync();
  assert.equal(listRequestCount(), 1, 'runtime 不在位时不应重新拉取');
  assert.equal(eventSources.length, 1, 'runtime 不在位时不应新建 EventSource');

  // 重开同一会话：新 runtime 在位 → 渲染触发换绑重同步，标注恢复。
  orchestration.setCurrentRuntimeAgentId('runtime-new');
  module.scheduleReplay();
  await flushAsync();
  assert.equal(listRequestCount(), 2, 'runtime 换代后应重新拉取 list');
  assert.equal(eventSources.length, 2, 'runtime 换代后应重新订阅 SSE');
  assert.ok(!eventSources[1].closed);
  assert.equal(treeWalkerRoots.length, 2, '重同步后标注恢复重放');

  // 稳态：同 runtime 后续渲染不再重复拉取。
  module.scheduleReplay();
  await flushAsync();
  assert.equal(listRequestCount(), 2);
  assert.equal(eventSources.length, 2);
});

test('会话切换（接续/分支场景）仍走键变化全量同步', async () => {
  const { module } = await setup();

  module.scheduleReplay();
  await flushAsync();
  assert.equal(listRequestCount(), 1);

  // 切到新会话（接续产物）：sessionId 变化 → 键变化 → 全量同步。
  orchestration.setCurrentRuntimeAgentId('runtime-new2');
  module.scheduleReplay();
  await flushAsync();
  assert.equal(listRequestCount(), 2);
  assert.equal(eventSources.length, 2);
  assert.match(eventSources[1].url, /sessionId=sess-B/);
  assert.equal(treeWalkerRoots.length, 2, '新会话同步后标注参与重放');
});
