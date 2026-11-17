/* global window, document */
/**
 * P2 第二波 2（运行状态通知与 SSE）——本批 ESM 模块的真实行为与兼容面。
 *
 * 本批最终迁移面 = tool-progress + sse-client 两个模块（sse-client 的连接
 * 生命周期与事件分发在 p2-w2-2-sse-client.test.js）。本文件覆盖 tool-progress。
 *
 * 保持唯一 classic 实现、不计入本批迁移的模块：
 *   - runtime-status：写入 recap-hint 的 `_recapPendingTrigger`、
 *     persistent-input 的 `_lastCallFinishTime` / `_pendingQueuedCount` 三个
 *     classic 顶层 let，bootstrap 适配面未提供这些键（等输入域 owner 接口）；
 *   - desktop-notify：桌面壳原生 toast 激活入口必须在经典相同轮次可投递
 *     （见 p2-w2-2-classic-residual.test.js），ESM 侧的 sse-client 按既有
 *     window 函数协议消费；
 *   - generative-ui-panel：rail 面板注册必须先于 app-main 顶层
 *     applyLanguage → renderCurrentMainView 的首次 syncRailButtons。
 *   三者既有 classic 测试继续按原装载方式覆盖。
 *
 * 装载路线：test/helpers/esm-module-loader.js 的真实 import + window/document
 * 桩。tool-progress 的 ESM 依赖沿真实 import 链执行（session-view-storage /
 * markdown-utils），classic 依赖（readCurrentSessionViewState /
 * runWithSuppressedChatViewportObservers）按调用时点显式 window 晚绑定。
 *
 * 钉住三件事：
 *   1. 四个跨文件函数经桥暴露且与命名导出同址、不可枚举、claim 后双向转发；
 *   2. 进度表 / owner / DOM 块计数是模块私有状态（无桥键）；
 *   3. 原业务：入表、结果落地即清、终态全清、会话切换复位。
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserStubs, loadModuleOnce } from './helpers/esm-module-loader.js';

// ── window / document 桩 ────────────────────────────────────────────────

const intervals = [];
const timeouts = [];

function createElementStub() {
  return {
    id: '', className: '', innerHTML: '', textContent: '', title: '',
    style: {}, dataset: {}, children: [],
    classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    addEventListener() {}, removeEventListener() {},
    appendChild(child) { this.children.push(child); return child; },
    removeChild() {}, insertBefore() {}, remove() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    closest() { return null; }, focus() {}, blur() {}, offsetHeight: 0,
  };
}

// 会话视图状态（classic session-view-state 的面）：测试控制 identity / runtime
const sessionView = { identity: { agentId: 'agent-a', sessionId: 'session-a' }, runtimeId: 'rt-a' };

let cleanupGlobals;
let orchestration;
let sessionStorage;
let toolProgress;

before(async () => {
  cleanupGlobals = installBrowserStubs({
    window: {
      // markdown-bootstrap 的桥键值：ESM markdown-utils 顶层读取后 export escapeHtml
      escapeHtml: (text) => String(text ?? ''),
      renderer: {},
      marked: { parse: () => '', setOptions() {}, use() {}, Renderer: class {} },
      ClawFW: { actions: { registerMany() {} } },
      // classic 依赖（按调用时点 window 晚绑定）
      readCurrentSessionViewState: () => ({ ...sessionView }),
      runWithSuppressedChatViewportObservers: (work) => work(),
      setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
      setTimeout: (fn, ms) => { timeouts.push({ fn, ms }); return timeouts.length; },
      clearInterval() {},
      clearTimeout() {},
      fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    },
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: () => createElementStub(),
      createTextNode: (text) => ({ textContent: text }),
      addEventListener() {},
      removeEventListener() {},
      body: createElementStub(),
      documentElement: createElementStub(),
      activeElement: null,
      readyState: 'complete',
    },
  });

  await loadModuleOnce('public/src/modules/kernel-state.js', { installGlobals: false });
  // classic 相注册、ESM 相 claim 的内核状态键（与 app-core 的真实链路同构）
  window.KernelState.defineKey('i18n-environment', 'currentLanguage', 'zh');
  window.KernelState.defineKey('orchestration', 'currentRuntimeAgentId', 'rt-a');
  window.KernelState.defineKey('session-view-storage', 'currentMessages', []);

  await import('../public/src/modules/i18n-environment-state.js');
  orchestration = await import('../public/src/modules/orchestration-state.js');
  sessionStorage = await import('../public/src/modules/session-view-storage.js');

  // 桥键唯一注册制：规范 URL 装载，保证全文件单实例
  toolProgress = await import('../public/src/modules/tool-progress.js');
});

after(() => {
  cleanupGlobals();
});

function resetRuntime(runtimeId = 'rt-a', agentId = 'agent-a', sessionId = 'session-a') {
  orchestration.setCurrentRuntimeAgentId(runtimeId);
  sessionView.identity = { agentId, sessionId };
  sessionView.runtimeId = runtimeId;
}

// ── tool-progress：桥键 + 私有进度状态 ─────────────────────────────────

test('tool-progress：四个跨文件函数经桥暴露，且与命名导出同址', () => {
  for (const key of ['applyToolProgressNotification', 'clearToolProgressState',
    'resolveToolProgressForCall', 'syncToolProgressDom']) {
    assert.equal(typeof toolProgress[key], 'function', `缺少命名导出：${key}`);
    assert.equal(window[key], toolProgress[key], `${key} 的桥键必须指向同一实现`);
    assert.equal(Object.prototype.propertyIsEnumerable.call(window, key), false, `${key} 不得进入枚举面`);
  }
});

test('tool-progress：claim 之后 classic 写方经 setter 转发进桥值', () => {
  const key = 'resolveToolProgressForCall';
  const original = window[key];
  const sentinel = () => ({ startedAt: 1, elapsedMs: 1 });
  window[key] = sentinel;
  assert.equal(window[key], sentinel, 'claim 后的 setter 必须保留写值');
  window[key] = original;
  assert.equal(window[key], original, '恢复后读回原实现');
});

test('tool-progress：tool.progress 入表、终态信号清除、结果落地即清除', () => {
  resetRuntime();
  sessionStorage.setCurrentMessages([]);
  const startedAt = Date.now() - 12000;
  toolProgress.applyToolProgressNotification({
    state: {
      type: 'tool.progress',
      data: { callId: 'call-1', toolName: 'bash', startedAt, timeoutMs: 60000, outputTail: 'tail-1' },
    },
  });
  const resolved = toolProgress.resolveToolProgressForCall({ id: 'call-1' });
  assert.ok(resolved, '进度必须可按 callId 取回');
  assert.equal(resolved.timeoutMs, 60000);
  assert.equal(resolved.outputTail, 'tail-1');
  assert.ok(resolved.elapsedMs >= 12000, `elapsed 由 startedAt 本地插值：${resolved.elapsedMs}`);

  // 结果行落地（messages 出现对应 tool 行）→ 该 callId 立即清除
  sessionStorage.setCurrentMessages([{ role: 'tool', toolCallId: 'call-1' }]);
  toolProgress.applyToolProgressNotification({ state: { type: 'tool.progress', data: { callId: 'call-2' } } });
  assert.equal(toolProgress.resolveToolProgressForCall({ id: 'call-1' }), null, '已落地结果不得残留进度');
  assert.ok(toolProgress.resolveToolProgressForCall({ id: 'call-2' }), '新 callId 照常入表');

  // call 结束信号 → 全清
  toolProgress.applyToolProgressNotification({ callActive: false });
  assert.equal(toolProgress.resolveToolProgressForCall({ id: 'call-2' }), null);
  sessionStorage.setCurrentMessages([]);
});

test('tool-progress：会话视图切换（异步过期）清空旧 owner 的进度', () => {
  resetRuntime('rt-a', 'agent-a', 'session-a');
  toolProgress.applyToolProgressNotification({
    state: { type: 'tool.progress', data: { callId: 'call-owner', startedAt: Date.now() } },
  });
  assert.ok(toolProgress.resolveToolProgressForCall({ id: 'call-owner' }));

  // 切到另一会话：下一次进度推进先按 owner 变更复位
  resetRuntime('rt-b', 'agent-b', 'session-b');
  assert.equal(toolProgress.resolveToolProgressForCall({ id: 'call-owner' }), null, '切走后旧进度不得串会话');

  resetRuntime();
});
