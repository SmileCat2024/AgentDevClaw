import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// 线程直投路径（window.submitThreadInput）发送成功后，图片桶必须与 viewer
// 直投路径同语义清空（clearPendingInputImages），否则附件缩略图滞留输入框。
// 回归背景：PH 线程宿主会话图片发出后缩略图卡在输入框（2026-10-28）。
//
// ADR-0035 后普通发言只有 submitQueuedInput 一条入口，线程直投分支在其内部；
// 历史事故的另一份拷贝（input-helpers.js 的 slot 入口）已随 /input 文本编排
// 一并退役，本文件只锁定剩下的唯一入口。

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

const bucketBlock = sourceBetween(
  persistentInputSource,
  'const _pendingImageBuckets = new Map();',
  '\nlet _lastCallFinishTime',
);
const clearBlock = sourceBetween(
  persistentInputSource,
  'function clearPendingInputImages(bucketKey) {',
  '\n// ── window 导出',
);
const submitBlock = sourceBetween(
  persistentInputSource,
  'async function submitQueuedInput() {',
  '\nfunction updateQueueIndicator',
);

async function createThreadSubmitContext() {
  const textarea = { value: '看看这张图', dataset: { sessionKey: 'key-1' } };
  const submitCalls = [];
  const context = {
    // submitQueuedInput 自由变量（thread 直投路径触及的部分）
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
      getActiveThreadInputTarget: () => ({ threadId: 'th-1' }),
      submitThreadInput: async (threadId, payload) => {
        submitCalls.push({ threadId, payload });
        return { delivery: { delivered: 1 } };
      },
      SessionReference: { peek: () => [], consume: () => [] },
      ClawSlash: { consumeActivations: () => [] },
      ClawToast: { show() {} },
      refreshThreads() {},
    },
    captureSessionViewToken: () => 'view-token-1',
    isSessionViewTokenCurrent: () => true,
    _getSessionInputCacheKey: () => 'key-1',
    _requestNotifyPermission() {},
    _beginSubmitFeedbackWindow() {},
    _endSubmitFeedbackWindow() {},
    _nextPaint: async () => {},
    _resolvePendingImagesForTarget: async () => ({
      images: [{ path: '/uploads/attach.png', mediaType: 'image/png' }],
      failedCount: 0,
    }),
    _clearRecapForNewMessage() {},
    updateQueueIndicator() {},
    autoResize() {},
    // clearPendingInputImages 触达的渲染面：stub（DOM 渲染不在本测试范围）
    _renderAttachmentPreview() {},
  };
  vm.createContext(context);
  vm.runInContext(
    `${bucketBlock}
${clearBlock}
${submitBlock}
globalThis.__submit = submitQueuedInput;
globalThis.__bucket = _imageBucket;
globalThis.__bucketKey = _imageBucketKey;`,
    context,
  );
  // 预置一张待发图片（模拟用户粘贴后未发送状态）
  context.__bucket().push({ path: '/uploads/attach.png', mediaType: 'image/png', source: 'paste' });
  return { context, textarea, submitCalls };
}

test('thread direct-delivery submit clears pending images on success', async () => {
  const { context, submitCalls } = await createThreadSubmitContext();

  await context.__submit();

  assert.equal(submitCalls.length, 1, 'thread input should be submitted exactly once');
  assert.equal(submitCalls[0].threadId, 'th-1');
  assert.ok(Array.isArray(submitCalls[0].payload.images) && submitCalls[0].payload.images.length === 1,
    'image payload should reach the thread input submit call');
  assert.equal(context.__bucket().length, 0,
    'pending image bucket must be cleared after successful thread submit');
});

test('failed thread image upload aborts the submit and keeps the attachments', async () => {
  // 线程直投的唯一入口失败语义：任一附件上传失败都必须显式中止，输入文本与
  // 图片桶原样保留供重试——绝不静默丢弃附件，也不把半张图发进线程。
  const { context, submitCalls, textarea } = await createThreadSubmitContext();
  context._resolvePendingImagesForTarget = async () => ({
    images: [],
    failedCount: 1,
  });
  context.window.ClawToast = { show() {} };

  await context.__submit();

  assert.equal(submitCalls.length, 0, 'a failed attachment must abort the thread submit');
  assert.equal(context.__bucket().length, 1, 'the pending image stays available for retry');
  assert.equal(textarea.value, '看看这张图', 'the typed draft is preserved');
});

