/**
 * thread-input-staging-toast.test.js — 线程寻址输入的反馈语义（真实 classic 提交链）
 *
 * 锁定两条规则，防止「已发送，等待接续」类无条件提示回归：
 *   1. 本次投递尝试当场送达（deliveryAttempt.delivered > 0）→ 不弹任何常驻提示，
 *      正常对话的成功发送与普通会话一致（静默成功）。
 *   2. 未送达（交接挡板 / head runtime 未就绪）→ 提示「已暂存 · 新会话就绪后
 *      自动继续」。这是信息，不是失败：输入已在 Thread Inbox。
 *
 * 响应形状来自 POST /protoclaw/threads/:threadId/input：接受与否由 HTTP 状态
 * 表达，送达与否在 deliveryAttempt 字段（与 /commands 的 delivery 对象不同）。
 *
 * 装载路线（P4 输入面批次）：提交入口 `submitQueuedInput` 已随 persistent-input.js
 * 迁 ESM，本文件真实 import 装载**整份实现**——不再按
 * `function updateQueueIndicator` 一类标记切函数块（该入口已迁
 * p2-w2-3a-queue-projection，旧的结束标记不存在）。线程输入路由的响应形状是
 * 本用例的输入前提，`submitThreadInput` 按路由契约注入返回；提交链本身（提示
 * 分支、字段组装、清洗）跑的是生产实现。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { withP2EsmCase } from './helpers/p2-esm-case.js';

/**
 * 用例的浏览器面：只有 persistent 输入框是真实节点，动作按钮显式缺席
 * （本文件不渲染按钮，真实 _setActionBtn* 因此是空操作）。
 */
function createDocumentStub(elements) {
  const element = () => ({
    style: {},
    dataset: {},
    children: [],
    className: '',
    innerHTML: '',
    value: '',
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    appendChild() {},
    insertBefore() {},
    remove() {},
    addEventListener() {},
    removeEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    setAttribute() {},
    removeAttribute() {},
    closest() { return null; },
  });
  return {
    getElementById(id) {
      if (id === 'persistent-action-btn') return null;
      return elements[id] ?? element();
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    createElement: element,
    createTextNode: (text) => ({ textContent: text }),
    addEventListener() {},
    removeEventListener() {},
    body: element(),
    documentElement: element(),
    activeElement: null,
    hidden: false,
    readyState: 'complete',
  };
}

/** 捕获 console warn / error（沙箱里的 console 就是宿主 console 对象）。 */
function captureConsoleLogs() {
  const entries = [];
  const original = { warn: console.warn, error: console.error };
  console.warn = (...args) => entries.push({ kind: 'warn', args });
  console.error = (...args) => entries.push({ kind: 'error', args });
  return {
    entries,
    restore() {
      console.warn = original.warn;
      console.error = original.error;
    },
  };
}

function describeLogs(entries) {
  return entries.map((entry) => `${entry.kind}: ${String(entry.args[0])}`).join(' | ');
}

/**
 * 跑一次真实提交链：一份 window + 整份 persistent-input.js。
 *
 * 夹具语义（生产来源注释；本文件只测反馈提示，不驱动界面副作用）：
 * - `submitThreadInput`：线程输入路由的响应形状就是本用例的输入前提；
 * - `SessionReference` / `ClawSlash` / `ClawToast`：产品协作面；
 * - `autoResize`（input-actions）/ `updateQueueIndicator`
 *   （p2-w2-3a-queue-projection）/ `_clearRecapForNewMessage`（recap-hint）/
 *   `clearInterruptSuppression`（runtime-status）/ `_markAgentCallStartedForNotify`
 *   （desktop-notify）/ `renderAgentList`（sidebar-render）与跟随入口：
 *   首屏后段能力，用例不消费其渲染结果；
 * - `fetch`：本文件只走线程输入分支，任何请求都是意外。
 */
async function submitQueuedInputWith(deliveryAttempt) {
  const textarea = { value: '继续吧', dataset: { sessionKey: 'key-1' }, style: {}, scrollHeight: 40 };
  const toasts = [];
  const submitCalls = [];
  const logs = captureConsoleLogs();
  try {
    await withP2EsmCase({
      label: 'thread-input-staging-toast',
      globals: {
        document: createDocumentStub({ 'input-persistent': textarea }),
        currentRuntimeAgentId: 'runtime-1',
        currentMessages: [],
        currentInputRequests: [],
        getActiveThreadInputTarget: () => ({ threadId: 'th-1', agentId: 'programming-helper' }),
        submitThreadInput: async (threadId, payload) => {
          submitCalls.push({ threadId, payload });
          return { ok: true, delivery: 'thread_queued', threadId, commandId: 'cmd-1', deliveryAttempt };
        },
        SessionReference: { peek: () => [], consume: () => [{ agentId: 'programming-helper', sessionId: 's-1' }] },
        ClawSlash: { consumeActivations: () => [] },
        ClawToast: { show: (value) => toasts.push(value) },
        ClawFW: { actions: { registerMany() {} }, requestImmediatePoll() {} },
        _requestNotifyPermission() {},
        // 会话视图 token：真实判定按 token 字段比较（空身份 token 以 runtimeId 为准）
        captureSessionViewToken: () => ({ runtimeId: 'runtime-1', identity: null, switchEpoch: 0, generation: undefined }),
        _getSessionInputCacheKey: () => 'key-1',
        _sessionInputCache: {},
        autoResize() {},
        updateQueueIndicator() {},
        clearInterruptSuppression() {},
        _markAgentCallStartedForNotify() {},
        _agentCallActive: new Map(),
        // 输入面静态图的 classic 宿主工厂（生产由 app-core / app-main 提供）：
        // 本用例只测反馈提示，不驱动这些 seam 的界面副作用。
        createSessionViewCommitHost: () => ({
          identity: () => null,
          read: () => ({}),
          apply: () => {},
          normalizeModel: () => ({}),
        }),
        createP2BootstrapCallActivityHost: () => ({ _agentCallActive: new Map() }),
        createP2BootstrapDomHost: () => ({}),
        createPollCoordinatorHost: () => ({}),
        _clearRecapForNewMessage() {},
        isRuntimeCalling: () => false,
        isInterruptSuppressed: () => false,
        renderAgentList() {},
        beginFollowLatestEntryWindow() {},
        requestFollowLatest() {},
        fetch: async () => { throw new Error('unexpected fetch'); },
      },
      classic: (sandbox) => {
        sandbox.loadSource('public/src/modules/kernel-state.js');
        // 桥接期真初值（生产由 app-core 在 classic 相注册，ESM owner 认领时吸收）
        sandbox.KernelState.defineKey('i18n-environment', 'currentLanguage', 'zh');
        sandbox.KernelState.defineKey('orchestration', 'currentRuntimeAgentId', 'runtime-1');
        sandbox.KernelState.defineKey('orchestration', '_switchEpoch', 0);
      },
    }, async (c) => {
      // 焦点 runtime / 会话视图快照：生产由切换链与轮询写入各自 owner
      const orchestration = await c.load('public/src/modules/orchestration-state.js');
      orchestration.setCurrentRuntimeAgentId('runtime-1');
      const storage = await c.load('public/src/modules/session-view-storage.js');
      storage.setCurrentMessages([]);
      storage.setCurrentInputRequests([]);
      // 输入面实现（P4 输入面批次起是 ESM）
      const persistent = await c.load('public/src/modules/persistent-input.js');
      // toast-notify 在模块求值期把自己挂上 window.ClawToast（夹具桩会被覆盖）：
      // 本用例只断言提示内容，按记录器落位。
      c.window.ClawToast = { show: (value) => toasts.push(value), update() {} };
      await persistent.submitQueuedInput();
    });
  } finally {
    logs.restore();
  }
  return { textarea, toasts, submitCalls, logs: logs.entries };
}

test('当场送达的线程输入不弹常驻提示', async () => {
  const { toasts, submitCalls, logs } = await submitQueuedInputWith({ attempted: 1, delivered: 1 });

  assert.equal(submitCalls.length, 1, 'thread input should be submitted exactly once');
  assert.equal(submitCalls[0].threadId, 'th-1');
  assert.deepEqual(toasts, [], 'a delivered input must not raise a staging toast');
  assert.deepEqual(logs, [], `unexpected console output: ${describeLogs(logs)}`);
});

test('未送达的线程输入提示已暂存，且不当作失败', async () => {
  const { toasts, logs } = await submitQueuedInputWith({
    attempted: 0,
    delivered: 0,
    reason: 'runtime_not_accepting',
  });

  assert.equal(toasts.length, 1, 'a staged input should be announced once');
  assert.equal(toasts[0].status, 'info', 'staging is informational, not an error');
  assert.match(toasts[0].title, /已暂存/);
  assert.deepEqual(logs, [], `unexpected console output: ${describeLogs(logs)}`);
});

test('响应缺少 deliveryAttempt 时按未送达处理，不静默丢弃提示', async () => {
  const { toasts, logs } = await submitQueuedInputWith(undefined);

  assert.equal(toasts.length, 1, 'an absent delivery fact must not be read as delivered');
  assert.match(toasts[0].title, /已暂存/);
  assert.deepEqual(logs, [], `unexpected console output: ${describeLogs(logs)}`);
});
