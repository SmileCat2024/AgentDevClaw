import fs from 'node:fs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox, sourceBetween } from './helpers/frontend-vm.js';

/**
 * 线程寻址输入的前端契约（frontend 沙箱）：
 * - submitThreadInput 的字段透传：合法 metadata / 激活进入序列化 body，非法形态不产生字段
 * - submitInput 线程分支失败：已 consume 的会话引用与激活归还（P1 回归锁）
 */

function loadSubmitThreadInput(ctx) {
  const source = fs.readFileSync('public/src/modules/thread-store.js', 'utf8');
  ctx.run(sourceBetween(source, 'window.submitThreadInput = async (threadId, payload = {}) => {', 'window.threadAdvanceHead'));
}

describe('submitThreadInput field passthrough (frontend sandbox)', () => {
  it('serializes valid metadata and activations into the input route body', async () => {
    const bodies = [];
    const ctx = createFrontendSandbox({
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(init.body));
        return { ok: true, json: async () => ({ ok: true, threadId: 'th-1', commandId: 'cmd-1', deliveryAttempt: { delivered: 1 } }) };
      },
    });
    loadSubmitThreadInput(ctx);

    const metadata = { 'session-reference': [{ agentId: 'programming-helper', sessionId: 'session-1' }] };
    await ctx.run(`window.submitThreadInput('th-1', {
      text: '带引用',
      images: [{ path: '/uploads/a.png', mediaType: 'image/png' }],
      source: 'chat-composer',
      capabilityActivations: ['skill.grill-me'],
      metadata: ${JSON.stringify(metadata)},
    })`);

    assert.equal(bodies.length, 1);
    assert.equal(bodies[0].text, '带引用');
    assert.deepEqual(bodies[0].images, [{ path: '/uploads/a.png', mediaType: 'image/png' }],
      'images must reach the thread input route (the commands route does not accept them)');
    assert.deepEqual(bodies[0].capabilityActivations, ['skill.grill-me']);
    assert.deepEqual(bodies[0].metadata, metadata);
  });

  it('omits the metadata field for non-object shapes', async () => {
    const bodies = [];
    const ctx = createFrontendSandbox({
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(init.body));
        return { ok: true, json: async () => ({ ok: true, threadId: 'th-1', commandId: 'cmd-2' }) };
      },
    });
    loadSubmitThreadInput(ctx);

    await ctx.run(`window.submitThreadInput('th-1', { text: '纯文本', metadata: ['not', 'an', 'object'] })`);

    assert.equal(bodies.length, 1);
    assert.equal('metadata' in bodies[0], false);
  });
});

describe('thread direct delivery restores consumed pills on failure (frontend sandbox)', () => {
  function buildThreadRouteContext({ submitRejects }) {
    const restoredRefs = [];
    const restoredActivations = [];
    const toasts = [];
    const textarea = { value: '继续', dataset: { sessionKey: 'sk-1' }, isConnected: true };
    const ctx = createFrontendSandbox({
      document: {
        getElementById: (id) => (id === 'input-persistent' ? textarea : null),
        querySelector: () => textarea,
      },
      currentLanguage: 'zh',
      ClawToast: { show: (v) => toasts.push(v) },
      _sessionInputCache: {},
      autoResize: () => {},
      _getSessionInputCacheKey: () => 'sk-1',
      captureSessionViewToken: () => ({ runtimeId: 'rt-1' }),
      isSessionViewTokenCurrent: () => true,
      window: {
        ClawToast: { show: (v) => toasts.push(v) },
        getActiveThreadInputTarget: () => ({ threadId: 'wt-9' }),
        ClawSlash: {
          consumeActivations: () => ['skill.grill-me'],
          restoreActivations: (refs) => restoredActivations.push(refs),
        },
        SessionReference: {
          peek: () => [{ agentId: 'programming-helper', sessionId: 'session-7', title: '引用' }],
          consume: () => [{ agentId: 'programming-helper', sessionId: 'session-7', title: '引用' }],
          restore: (refs) => restoredRefs.push(refs),
        },
        submitThreadInput: async () => {
          if (submitRejects) throw new Error('thread input unavailable');
          return { ok: true, deliveryAttempt: { delivered: 1 } };
        },
      },
      clearPendingInputImages: () => {},
      _renderAttachmentPreview: () => {},
      currentRuntimeAgentId: 'rt-1',
      updateQueueIndicator: () => {},
    });
    return { ctx, restoredRefs, restoredActivations, toasts, textarea };
  }

  // ADR-0035：普通发言只有 submitQueuedInput 一条路径，线程直投分支在其内部。
  function loadSubmitQueuedInput(ctx) {
    const source = fs.readFileSync('public/src/modules/persistent-input.js', 'utf8');
    ctx.run(sourceBetween(source, 'const _pendingImageBuckets = new Map();', '\nlet _lastCallFinishTime'));
    ctx.run(sourceBetween(source, 'function clearPendingInputImages(bucketKey) {', '\n// ── window 导出'));
    ctx.run(sourceBetween(source, 'async function submitQueuedInput() {', '\nfunction updateQueueIndicator'));
    ctx.run(`var _submitInFlight = false;
      function _requestNotifyPermission() {}
      function _beginSubmitFeedbackWindow() {}
      function _endSubmitFeedbackWindow() {}
      async function _nextPaint() {}
      async function _resolvePendingImagesForTarget() { return { images: [], failedCount: 0 }; }
      function _clearRecapForNewMessage() {}
      function clearInterruptSuppression() {}
      function _markAgentCallStartedForNotify() {}
      var _agentCallActive = new Map();
      function _syncPersistentActionButton() {}
      function renderAgentList() {}
      function beginFollowLatestEntryWindow() {}
      function requestFollowLatest() {}`);
  }

  it('restores session references and activations when the thread delivery fails', async () => {
    const env = buildThreadRouteContext({ submitRejects: true });
    loadSubmitQueuedInput(env.ctx);

    await env.ctx.run('submitQueuedInput()');

    // 失败路径：引用与激活归还（P1 回归锁），输入保留
    assert.equal(env.restoredRefs.length, 1);
    assert.equal(env.restoredRefs[0].length, 1);
    assert.equal(env.restoredActivations.length, 1);
    assert.equal(env.textarea.value, '继续');
    assert.ok(env.toasts.some((t) => t.status === 'error'));
  });

  it('keeps references consumed (no restore) when the thread delivery succeeds', async () => {
    const env = buildThreadRouteContext({ submitRejects: false });
    loadSubmitQueuedInput(env.ctx);

    await env.ctx.run('submitQueuedInput()');

    assert.equal(env.restoredRefs.length, 0);
    assert.equal(env.restoredActivations.length, 0);
    assert.equal(env.textarea.value, '');
  });
});
