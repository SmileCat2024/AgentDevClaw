import fs from 'node:fs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox, sourceBetween } from './helpers/frontend-vm.js';

/**
 * 线程域提交入口的字段透传与失败归还（frontend 沙箱）：
 * - submitThreadCommand：合法 metadata 进入序列化 body；数组形态不产生字段
 * - submitInput 线程分支失败：已 consume 的会话引用与激活归还（P1 回归锁）
 */

function loadSubmitThreadCommand(ctx) {
  const source = fs.readFileSync('public/src/modules/thread-store.js', 'utf8');
  ctx.run(sourceBetween(source, 'window.submitThreadCommand = async (threadId, text, options = {}) => {', 'window.threadAdvanceHead'));
}

describe('submitThreadCommand metadata passthrough (frontend sandbox)', () => {
  it('serializes valid metadata into the commands route body', async () => {
    const bodies = [];
    const ctx = createFrontendSandbox({
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(init.body));
        return { ok: true, json: async () => ({ ok: true, command: { commandId: 'cmd-1' }, duplicate: false }) };
      },
    });
    loadSubmitThreadCommand(ctx);

    const metadata = { 'session-reference': [{ agentId: 'programming-helper', sessionId: 'session-1' }] };
    await ctx.run(`window.submitThreadCommand('wt-1', '带引用', {
      capabilityActivations: ['skill.grill-me'],
      metadata: ${JSON.stringify(metadata)},
    })`);

    assert.equal(bodies.length, 1);
    assert.deepEqual(bodies[0].capabilityActivations, ['skill.grill-me']);
    assert.deepEqual(bodies[0].metadata, metadata);
  });

  it('omits the metadata field for non-object shapes', async () => {
    const bodies = [];
    const ctx = createFrontendSandbox({
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(init.body));
        return { ok: true, json: async () => ({ ok: true, command: { commandId: 'cmd-2' }, duplicate: false }) };
      },
    });
    loadSubmitThreadCommand(ctx);

    await ctx.run(`window.submitThreadCommand('wt-1', '纯文本', { metadata: ['not', 'an', 'object'] })`);

    assert.equal(bodies.length, 1);
    assert.equal('metadata' in bodies[0], false);
  });
});

describe('submitInput thread-branch failure restores consumed pills (frontend sandbox)', () => {
  function buildThreadRouteContext({ submitRejects }) {
    const restoredRefs = [];
    const restoredActivations = [];
    const toasts = [];
    const textarea = { value: '继续', dataset: { sessionKey: 'sk-1' }, isConnected: true };
    const ctx = createFrontendSandbox({
      document: {
        getElementById: (id) => (id === 'input-req-1' ? textarea : null),
        querySelector: () => textarea,
      },
      currentLanguage: 'zh',
      ClawToast: { show: (v) => toasts.push(v) },
      _sessionInputCache: {},
      autoResize: () => {},
      _getSessionInputCacheKey: () => 'sk-1',
      window: {
        resolveThreadInputRoute: () => ({ route: 'thread', thread: { threadId: 'wt-9' } }),
        ClawSlash: {
          consumeActivations: () => ['skill.grill-me'],
          restoreActivations: (refs) => restoredActivations.push(refs),
        },
        SessionReference: {
          consume: () => [{ agentId: 'programming-helper', sessionId: 'session-7', title: '引用' }],
          restore: (refs) => restoredRefs.push(refs),
        },
        submitThreadCommand: async () => {
          if (submitRejects) throw new Error('thread inbox unavailable');
          return { ok: true, delivery: { delivered: 1 } };
        },
      },
      clearPendingInputImages: () => {},
      beginFollowLatestEntryWindow: () => {},
      requestFollowLatest: () => {},
      applySessionViewPatch: () => {},
      currentRuntimeAgentId: 'rt-1',
      clearInterruptSuppression: () => {},
      _markAgentCallStartedForNotify: () => {},
      _agentCallActive: new Map(),
      _syncPersistentActionButton: () => {},
      renderAgentList: () => {},
      poll: () => {},
      _notifyThreadImageUnsupported: () => {},
    });
    return { ctx, restoredRefs, restoredActivations, toasts, textarea };
  }

  function loadSubmitInput(ctx) {
    const source = fs.readFileSync('public/src/modules/input-helpers.js', 'utf8');
    // 覆盖 submitInput + _notifyThreadImageUnsupported + _submitInputViaThread 三个函数
    ctx.run(sourceBetween(source, 'async function submitInput(requestId, boundRuntimeId = currentRuntimeAgentId) {', 'function getPrimaryInputRequest'));
    ctx.run('var _voiceTranscribing = false; var _voiceRecording = false;');
  }

  it('restores session references and activations when the thread command fails', async () => {
    const env = buildThreadRouteContext({ submitRejects: true });
    loadSubmitInput(env.ctx);

    await env.ctx.run('submitInput("req-1", "rt-1")');

    // 失败路径：引用与激活归还（P1 回归锁），输入保留
    assert.equal(env.restoredRefs.length, 1);
    assert.equal(env.restoredRefs[0].length, 1);
    assert.equal(env.restoredActivations.length, 1);
    assert.equal(env.textarea.value, '继续');
    assert.ok(env.toasts.some((t) => t.status === 'error'));
  });

  it('keeps references consumed (no restore) when the thread command succeeds', async () => {
    const env = buildThreadRouteContext({ submitRejects: false });
    loadSubmitInput(env.ctx);

    await env.ctx.run('submitInput("req-1", "rt-1")');

    assert.equal(env.restoredRefs.length, 0);
    assert.equal(env.restoredActivations.length, 0);
    assert.equal(env.textarea.value, '');
  });
});
