/**
 * 会话标注前端模块：dormant（前身会话标注）契约回归测试。
 *
 * 背景：summary 系接续（summarized-* handoff）后 transcript 从 turn 0 重新
 * 编号，feature 端导入的旧标注一律降级 dormant（见
 * local-features/conversation-annotations）。前端契约：
 * - 重放匹配绝不让 dormant 参与——其 turn 与本会话消息的同值 turn 只是
 *   编号巧合，匹配即误高亮（本测试用 createTreeWalker 观察点区分：
 *   只有真正进入锚点匹配路径的行才会构建文本模型）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

function setup({ annotations }) {
  const toasts = [];
  const treeWalkerRoots = [];

  class FakeEventSource {
    constructor(url) { this.url = String(url); this.closed = false; }
    addEventListener() {}
    close() { this.closed = true; }
  }

  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ result: { ok: true, annotations } }),
  });

  // 两行消息：msg-1（live 标注锚位）、msg-3（与 dormant 标注 turn 数字碰撞的行）。
  const rowLive = { id: 'msg-1', querySelectorAll: () => [] };
  const rowCollide = { id: 'msg-3', querySelectorAll: () => [] };
  const chatContainer = {
    querySelectorAll: (sel) => (sel.startsWith('.message-content') ? [rowLive, rowCollide] : []),
    contains: () => false,
  };

  const ctx = createFrontendSandbox({
    fetch: fetchImpl,
    EventSource: FakeEventSource,
    URLSearchParams,
    Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
    NodeFilter: { SHOW_TEXT: 4 },
    requestAnimationFrame: (cb) => setTimeout(cb, 0),
    navigator: {},
    focusedAgentId: 'programming-helper',
    currentRuntimeAgentId: 'runtime-old',
    getRuntimeWorkspaceSessionId: () => 'sess-A',
    getActiveWorkspaceSessionId: () => 'sess-A',
    isRemoteNamespaceAgentId: () => false,
    currentMessages: [
      null,
      { turn: 1, role: 'assistant' },
      null,
      { turn: 3, role: 'assistant' },
    ],
  });
  ctx.window.fetch = fetchImpl;
  ctx.window.EventSource = FakeEventSource;
  ctx.window.getSelection = () => ({ isCollapsed: true, rangeCount: 0, anchorNode: null });
  ctx.window.ClawToast = { show(record) { toasts.push(record); } };
  // document 扩展：聊天容器 / TreeWalker 观察点。
  ctx.document.getElementById = (id) => (id === 'chat-container' ? chatContainer : null);
  ctx.document.addEventListener = () => {};
  ctx.document.createTreeWalker = (root) => {
    treeWalkerRoots.push(root);
    return { nextNode: () => null }; // 空文本模型：锚点失配静默跳过，无需 Range/mark DOM
  };
  ctx.loadSource('public/src/modules/annotations.js');
  return { ctx, toasts, treeWalkerRoots, rowLive, rowCollide };
}

async function flushAsync() {
  for (let i = 0; i < 6; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 20)); // 20ms：覆盖两跳 rAF（Windows 定时器精度 ~15.6ms）
}

test('dormant：不进入锚点匹配路径，与碰撞行同值 turn 只是编号巧合', async () => {
  const live = { id: 'live-1', turn: 1, role: 'assistant', quote: '本会话正文', occurrence: 0, createdAt: 2 };
  const dormant = {
    id: 'dorm-1', turn: 3, role: 'assistant', quote: '前身结论', occurrence: 0, createdAt: 1,
    dormant: true, originSession: 's-old',
  };
  const { ctx, treeWalkerRoots, rowLive } = setup({ annotations: [dormant, live] });

  ctx.window.ClawAnnotations.scheduleReplay();
  await flushAsync();

  // 重放：live（turn 1）匹配 msg-1 进入锚点匹配路径（观察点命中证明路径可达）；
  // dormant（turn 3）与 msg-3 的同值 turn 是编号巧合——绝不进入匹配路径。
  assert.deepEqual(treeWalkerRoots, [rowLive], '只有 live 行构建文本模型；dormant 行被跳过');
});
