/**
 * thread-input-staging-toast.test.js — 线程寻址输入的反馈语义（前端沙箱）
 *
 * 锁定两条规则，防止「已发送，等待接续」类无条件提示回归：
 *   1. 本次投递尝试当场送达（deliveryAttempt.delivered > 0）→ 不弹任何常驻提示，
 *      正常对话的成功发送与普通会话一致（静默成功）。
 *   2. 未送达（交接挡板 / head runtime 未就绪）→ 提示「已暂存 · 新会话就绪后
 *      自动继续」。这是信息，不是失败：输入已在 Thread Inbox。
 *
 * 响应形状来自 POST /protoclaw/threads/:threadId/input：接受与否由 HTTP 状态
 * 表达，送达与否在 deliveryAttempt 字段（与 /commands 的 delivery 对象不同）。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const persistentInputSource = fs.readFileSync(
  new URL('../public/src/modules/persistent-input.js', import.meta.url),
  'utf8',
);

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(start, -1, `Missing marker: ${startMarker}`);
  assert.notEqual(end, -1, `Missing marker: ${endMarker}`);
  return source.slice(start, end);
}

const submitBlock = sourceBetween(
  persistentInputSource,
  'async function submitQueuedInput() {',
  '\nfunction updateQueueIndicator',
);

function createSubmitContext(deliveryAttempt) {
  const textarea = { value: '继续吧', dataset: { sessionKey: 'key-1' } };
  const toasts = [];
  const submitCalls = [];
  const context = {
    currentRuntimeAgentId: 'runtime-1',
    currentMessages: [],
    currentLanguage: 'zh',
    currentInputRequests: [],
    _submitInFlight: false,
    _sessionInputCache: {},
    document: {
      getElementById(id) { return id === 'input-persistent' ? textarea : null; },
      querySelector() { return null; },
    },
    window: {
      getActiveThreadInputTarget: () => ({ threadId: 'th-1', agentId: 'programming-helper' }),
      submitThreadInput: async (threadId, payload) => {
        submitCalls.push({ threadId, payload });
        return { ok: true, delivery: 'thread_queued', threadId, commandId: 'cmd-1', deliveryAttempt };
      },
      SessionReference: { peek: () => [], consume: () => [{ agentId: 'programming-helper', sessionId: 's-1' }] },
      ClawSlash: { consumeActivations: () => [] },
      ClawToast: { show: (value) => toasts.push(value) },
      refreshThreads() {},
      ClawFW: { requestImmediatePoll() {} },
    },
    captureSessionViewToken: () => 'view-token-1',
    isSessionViewTokenCurrent: () => true,
    _getSessionInputCacheKey: () => 'key-1',
    _requestNotifyPermission() {},
    _beginSubmitFeedbackWindow() {},
    _endSubmitFeedbackWindow() {},
    _nextPaint: async () => {},
    _resolvePendingImagesForTarget: async () => ({ images: [], failedCount: 0 }),
    _clearRecapForNewMessage() {},
    updateQueueIndicator() {},
    autoResize() {},
    clearInterruptSuppression() {},
    _markAgentCallStartedForNotify() {},
    _agentCallActive: new Map(),
    _syncPersistentActionButton() {},
    renderAgentList() {},
    beginFollowLatestEntryWindow() {},
    requestFollowLatest() {},
    clearPendingInputImages() {},
    _imageBucketKey() { return 'images-a'; },
    _imageBucket() { return []; },
    _renderAttachmentPreview() {},
  };
  vm.createContext(context);
  vm.runInContext(
    `${submitBlock}\nglobalThis.__submit = submitQueuedInput;`,
    context,
  );
  return { context, textarea, toasts, submitCalls };
}

test('当场送达的线程输入不弹常驻提示', async () => {
  const { context, toasts, submitCalls } = createSubmitContext({ attempted: 1, delivered: 1 });

  await context.__submit();

  assert.equal(submitCalls.length, 1, 'thread input should be submitted exactly once');
  assert.equal(submitCalls[0].threadId, 'th-1');
  assert.deepEqual(toasts, [], 'a delivered input must not raise a staging toast');
});

test('未送达的线程输入提示已暂存，且不当作失败', async () => {
  const { context, toasts } = createSubmitContext({
    attempted: 0,
    delivered: 0,
    reason: 'runtime_not_accepting',
  });

  await context.__submit();

  assert.equal(toasts.length, 1, 'a staged input should be announced once');
  assert.equal(toasts[0].status, 'info', 'staging is informational, not an error');
  assert.match(toasts[0].title, /已暂存/);
});

test('响应缺少 deliveryAttempt 时按未送达处理，不静默丢弃提示', async () => {
  const { context, toasts } = createSubmitContext(undefined);

  await context.__submit();

  assert.equal(toasts.length, 1, 'an absent delivery fact must not be read as delivered');
  assert.match(toasts[0].title, /已暂存/);
});
