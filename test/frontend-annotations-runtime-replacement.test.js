/**
 * 会话标注前端模块：runtime 换代（关闭对话 → 重开同一会话）后的重同步回归测试。
 *
 * 背景（历史 bug）：runtime 停止时服务端 closeSession 会让前端收到 SSE closed，
 * annotations.js 据此清空缓存并断开事件流；重开同一会话时 sessionId 不变，
 * ensureSession 只按 agentId/sessionId 去重 → 永远跳过重同步，标注不再显示。
 * 接续（sessionId 变化）不受影响。修复：同会话出现新 runtime ref 时强制重同步。
 *
 * 驱动路径必须是 scheduleReplay（chat-renderer 渲染后的真实触发源），
 * 不能用 refresh（无条件 loadList，测不出 ensureSession 的去重缺陷）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

function setup() {
  const fetchCalls = [];
  const eventSources = [];
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
    getRuntimeWorkspaceSessionId: (ref) =>
      (ref === 'runtime-old' || ref === 'runtime-new' ? 'sess-A' : ''),
    getActiveWorkspaceSessionId: () => 'sess-A',
    isRemoteNamespaceAgentId: () => false,
  });
  ctx.window.fetch = fetchImpl;
  ctx.window.EventSource = FakeEventSource;
  ctx.window.getSelection = () => ({ isCollapsed: true, rangeCount: 0, anchorNode: null });
  ctx.window.ClawHost = { panels: { register() {} } };
  ctx.window.ClawToast = { show() {} };
  ctx.loadSource('public/src/modules/annotations.js');
  return { ctx, fetchCalls, eventSources };
}

function listRequestCount(fetchCalls) {
  return fetchCalls.filter((call) =>
    call.url.includes('/protoclaw/feature-comms/request')
    && call.body?.requestType === 'list').length;
}

async function flushAsync() {
  for (let i = 0; i < 6; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 5));
}

test('同会话 runtime 换代后 scheduleReplay 触发重同步并恢复标注', async () => {
  const { ctx, fetchCalls, eventSources } = setup();

  // 初始：runtime-old 在位，渲染触发首次同步，标注可见。
  ctx.window.ClawAnnotations.scheduleReplay();
  await flushAsync();
  assert.equal(listRequestCount(fetchCalls), 1);
  assert.match(ctx.window.ClawAnnotations.getPanelHtml(), /被标注的文本/);
  assert.match(eventSources[0].url, /sessionId=sess-A/);
  assert.match(eventSources[0].url, /featureId=conversation-annotations/);

  // 关闭对话：runtime 停止 → 服务端 closeSession → SSE closed → 前端清空缓存。
  eventSources[0].dispatch('closed');
  assert.doesNotMatch(ctx.window.ClawAnnotations.getPanelHtml(), /被标注的文本/);
  assert.ok(eventSources[0].closed);

  // runtime 不在位（ref 空）期间渲染：不得重订阅（死会话不轮询）。
  ctx.currentRuntimeAgentId = '';
  ctx.window.ClawAnnotations.scheduleReplay();
  await flushAsync();
  assert.equal(listRequestCount(fetchCalls), 1, 'runtime 不在位时不应重新拉取');
  assert.equal(eventSources.length, 1, 'runtime 不在位时不应新建 EventSource');

  // 重开同一会话：新 runtime 在位 → 渲染触发换绑重同步，标注恢复。
  ctx.currentRuntimeAgentId = 'runtime-new';
  ctx.window.ClawAnnotations.scheduleReplay();
  await flushAsync();
  assert.equal(listRequestCount(fetchCalls), 2, 'runtime 换代后应重新拉取 list');
  assert.equal(eventSources.length, 2, 'runtime 换代后应重新订阅 SSE');
  assert.ok(!eventSources[1].closed);
  assert.match(ctx.window.ClawAnnotations.getPanelHtml(), /被标注的文本/);

  // 稳态：同 runtime 后续渲染不再重复拉取。
  ctx.window.ClawAnnotations.scheduleReplay();
  await flushAsync();
  assert.equal(listRequestCount(fetchCalls), 2);
  assert.equal(eventSources.length, 2);
});

test('会话切换（接续/分支场景）仍走键变化全量同步', async () => {
  const { ctx, fetchCalls, eventSources } = setup();

  ctx.window.ClawAnnotations.scheduleReplay();
  await flushAsync();
  assert.equal(listRequestCount(fetchCalls), 1);

  // 切到新会话（接续产物）：sessionId 变化 → 键变化 → 全量同步。
  ctx.getRuntimeWorkspaceSessionId = (ref) =>
    (ref === 'runtime-old' ? 'sess-A' : ref === 'runtime-new2' ? 'sess-B' : '');
  ctx.currentRuntimeAgentId = 'runtime-new2';
  ctx.window.ClawAnnotations.scheduleReplay();
  await flushAsync();
  assert.equal(listRequestCount(fetchCalls), 2);
  assert.equal(eventSources.length, 2);
  assert.match(eventSources[1].url, /sessionId=sess-B/);
  assert.match(ctx.window.ClawAnnotations.getPanelHtml(), /被标注的文本/);
});
