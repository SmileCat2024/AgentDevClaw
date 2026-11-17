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
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

function setup() {
  const fetchCalls = [];
  const eventSources = [];
  const treeWalkerRoots = [];
  const animationFrames = [];
  const annotation = {
    id: 'anno-1', turn: 1, role: 'assistant',
    quote: '被标注的文本', occurrence: 0, createdAt: 1,
  };

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

  const fetchImpl = async (url, options) => {
    fetchCalls.push({ url: String(url), body: options ? JSON.parse(options.body) : null });
    return {
      ok: true,
      status: 200,
      json: async () => ({ result: { ok: true, annotations: [annotation] } }),
    };
  };

  // 一行消息：msg-1（标注锚位行）。replayAll 命中它时 createTreeWalker
  // 被调用——缓存非空且参与重放的可观察信号。
  const rowAnchored = { id: 'msg-1', querySelectorAll: () => [] };
  const chatContainer = {
    querySelectorAll: (sel) => (sel.startsWith('.message-content') ? [rowAnchored] : []),
    contains: () => false,
  };

  const ctx = createFrontendSandbox({
    fetch: fetchImpl,
    EventSource: FakeEventSource,
    URLSearchParams,
    Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
    NodeFilter: { SHOW_TEXT: 4 },
    requestAnimationFrame: (cb) => {
      animationFrames.push(cb);
      return animationFrames.length;
    },
    navigator: {},
    focusedAgentId: 'programming-helper',
    currentRuntimeAgentId: 'runtime-old',
    getRuntimeWorkspaceSessionId: (ref) =>
      (ref === 'runtime-old' || ref === 'runtime-new' ? 'sess-A' : ''),
    getActiveWorkspaceSessionId: () => 'sess-A',
    isRemoteNamespaceAgentId: () => false,
    currentMessages: [null, { turn: 1, role: 'assistant' }],
  });
  ctx.window.fetch = fetchImpl;
  ctx.window.EventSource = FakeEventSource;
  ctx.window.getSelection = () => ({ isCollapsed: true, rangeCount: 0, anchorNode: null });
  ctx.window.ClawToast = { show() {} };
  ctx.document.getElementById = (id) => (id === 'chat-container' ? chatContainer : null);
  ctx.document.addEventListener = () => {};
  ctx.document.createTreeWalker = (root) => {
    treeWalkerRoots.push(root);
    return { nextNode: () => null };
  };
  ctx.loadSource('public/src/modules/annotations.js');
  return { ctx, fetchCalls, eventSources, treeWalkerRoots, animationFrames };
}

function listRequestCount(fetchCalls) {
  return fetchCalls.filter((call) =>
    call.url.includes('/protoclaw/feature-comms/request')
    && call.body?.requestType === 'list').length;
}

// 确定性排空 rAF 与其触发的 Promise 链：手动 scheduleReplay →
// ensureSession 发起 loadList → resolve 后再次 scheduleReplay → 重放。
// 不用固定 sleep 猜测 Windows / 并行回归下的定时器调度时间；超过上限
// 仍未达到预期时直接失败，保留测试自身的诊断信息。
async function flushAsync(animationFrames, predicate = () => true) {
  for (let turn = 0; turn < 100; turn++) {
    while (animationFrames.length > 0) animationFrames.shift()();
    for (let i = 0; i < 6; i++) await Promise.resolve();
    if (animationFrames.length === 0 && predicate()) {
      // 再让一轮已触发的 Promise continuation 有机会排入 rAF 队列。
      await Promise.resolve();
      if (animationFrames.length === 0 && predicate()) return;
    }
  }
  throw new Error(`异步重放未收敛（待执行 rAF=${animationFrames.length}）`);
}

test('同会话 runtime 换代后 scheduleReplay 触发重同步并恢复标注', async () => {
  const { ctx, fetchCalls, eventSources, treeWalkerRoots, animationFrames } = setup();

  // 初始：runtime-old 在位，渲染触发首次同步，标注参与重放（锚点匹配路径命中）。
  ctx.window.ClawAnnotations.scheduleReplay();
  await flushAsync(animationFrames);
  assert.equal(listRequestCount(fetchCalls), 1);
  assert.equal(treeWalkerRoots.length, 1, '标注已拉回缓存并驱动重放');
  assert.match(eventSources[0].url, /sessionId=sess-A/);
  assert.match(eventSources[0].url, /featureId=conversation-annotations/);

  // 关闭对话：runtime 停止 → 服务端 closeSession → SSE closed → 前端清空缓存。
  eventSources[0].dispatch('closed');
  await flushAsync(animationFrames);
  ctx.window.ClawAnnotations.scheduleReplay();
  await flushAsync(animationFrames);
  assert.equal(treeWalkerRoots.length, 1, 'closed 后缓存清空，重放不再命中锚点匹配');
  assert.ok(eventSources[0].closed);

  // runtime 不在位（ref 空）期间渲染：不得重订阅（死会话不轮询）。
  ctx.currentRuntimeAgentId = '';
  ctx.window.ClawAnnotations.scheduleReplay();
  await flushAsync(animationFrames);
  assert.equal(listRequestCount(fetchCalls), 1, 'runtime 不在位时不应重新拉取');
  assert.equal(eventSources.length, 1, 'runtime 不在位时不应新建 EventSource');

  // 重开同一会话：新 runtime 在位 → 渲染触发换绑重同步，标注恢复。
  ctx.currentRuntimeAgentId = 'runtime-new';
  ctx.window.ClawAnnotations.scheduleReplay();
  await flushAsync(animationFrames);
  assert.equal(listRequestCount(fetchCalls), 2, 'runtime 换代后应重新拉取 list');
  assert.equal(eventSources.length, 2, 'runtime 换代后应重新订阅 SSE');
  assert.ok(!eventSources[1].closed);
  assert.equal(treeWalkerRoots.length, 2, '重同步后标注恢复重放');

  // 稳态：同 runtime 后续渲染不再重复拉取。
  ctx.window.ClawAnnotations.scheduleReplay();
  await flushAsync(animationFrames);
  assert.equal(listRequestCount(fetchCalls), 2);
  assert.equal(eventSources.length, 2);
});

test('会话切换（接续/分支场景）仍走键变化全量同步', async () => {
  const { ctx, fetchCalls, eventSources, treeWalkerRoots, animationFrames } = setup();

  ctx.window.ClawAnnotations.scheduleReplay();
  await flushAsync(animationFrames);
  assert.equal(listRequestCount(fetchCalls), 1);

  // 切到新会话（接续产物）：sessionId 变化 → 键变化 → 全量同步。
  ctx.getRuntimeWorkspaceSessionId = (ref) =>
    (ref === 'runtime-old' ? 'sess-A' : ref === 'runtime-new2' ? 'sess-B' : '');
  ctx.currentRuntimeAgentId = 'runtime-new2';
  ctx.window.ClawAnnotations.scheduleReplay();
  await flushAsync(animationFrames);
  assert.equal(listRequestCount(fetchCalls), 2);
  assert.equal(eventSources.length, 2);
  assert.match(eventSources[1].url, /sessionId=sess-B/);
  assert.equal(treeWalkerRoots.length, 2, '新会话同步后标注参与重放');
});
