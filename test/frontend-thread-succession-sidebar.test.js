/**
 * 接续窗口的侧栏单条目不变量（frontend-vm 沙箱）
 *
 * 事故机制：successor runtime 上线早于 commit（框架 advanceHead 才把
 * successor session 写进 sessionChain），窗口内 collectRuntimeEntriesForPrebuilt
 * 的线程锚定 get(newHead) 未命中 → successor 作为普通新条目渲染，与旧
 * 占位条目平行——用户看到「一个会话变成两个」。
 *
 * 修复语义：锚定未命中时，若存在 fresh 接续挡板（handoffStartedAt 在窗
 * 口内）的同身份线程，则把该条目归到换头线程——非 head 成员不渲染叶子，
 * 由占位条目兜底；commit 后 sessionChain 补上成员，锚定自然收敛。
 * 不变量：接续全程（挡板立起 → successor 上线 → head 推进）同一线程在
 * 侧栏只有一个条目。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

function unrefTimer(handle) { if (handle && typeof handle.unref === 'function') handle.unref(); return handle; }

function loadRuntimeStatus() {
  const ctx = createFrontendSandbox({
    t: (key) => key,
    currentLanguage: 'zh',
    currentMessages: [],
    normalizeAgentIdentity: (x) => String(x || '').trim(),
    getPathLeaf: (value) => String(value || '').replace(/\\/g, '/').split('/').filter(Boolean).pop() || '',
    toEpochMs: (value) => Date.parse(value || '') || 0,
    _agentCallActive: new Map(),
  });
  ctx.window.setInterval = () => 0;
  ctx.loadSource('public/src/modules/sidebar-operations.js');
  ctx.loadSource('public/src/modules/runtime-status.js');
  return ctx;
}

const HOST = {
  id: 'coder', agentId: 'coder', source: 'prebuilt', workspace_sessions: { sessions: [] },
};

function child(sessionId, runtimeId, name) {
  return {
    id: runtimeId, source: 'child', parent_id: 'coder',
    sidebar_entry_id: 'coder',
    runtime_session_id: runtimeId, active_workspace_session_id: sessionId,
    active_workspace_display_name: name, connected: true,
    created_at: '2026-10-10T09:05:00.000Z',
  };
}

const CHILD_OLD = child('old-head', 'old-runtime', '旧会话标题');
const CHILD_NEW = child('new-head', 'new-runtime', '新会话标题');

function runCollect(ctx, agentsLiteral) {
  return ctx.run(`(() => {
    const host = ${JSON.stringify(HOST)};
    const agents = ${agentsLiteral};
    return collectRuntimeEntriesForPrebuilt(host, agents);
  })()`);
}

describe('runtime-status: single sidebar entry across the succession window', () => {
  it('successor online before commit does not render as a parallel plain entry', () => {
    const ctx = loadRuntimeStatus();
    ctx.window.ClawThreads = {
      threads: [{
        threadId: 'wt-relay', agentId: 'coder',
        title: '工作对话', headSessionId: 'old-head', sessionIds: ['old-head'],
        status: 'open', lifeState: 'executing', handoffStartedAt: Date.now(),
      }],
      sessionIndex: {},
    };
    ctx.window.ClawThreads.sessionIndex['coder::old-head'] = ctx.window.ClawThreads.threads[0];

    // 先在稳态下渲染一次，建立线程条目缓存（占位渲染的锚）
    const steady = runCollect(ctx, JSON.stringify([CHILD_OLD]));
    const steadyThreadEntries = steady.filter((e) => e.threadId === 'wt-relay');
    assert.equal(steadyThreadEntries.length, 1, '稳态下单条目');

    // 换代窗口：旧 runtime 退役（不在 agents），successor 已上线未 commit
    const gap = runCollect(ctx, JSON.stringify([CHILD_NEW]));
    // 核心断言：窗口内 successor 不得以普通新条目出现（无双条目平行）
    const parallelNew = gap.filter((e) => e.runtimeId === 'new-runtime');
    assert.equal(parallelNew.length, 0, 'successor 在 commit 前不得渲染为平行普通条目');
    // 旧条目以占位形式存续（单条目连续性）
    const placeholders = gap.filter((e) => e.transitionPending === true);
    assert.equal(placeholders.length, 1, '换代窗口由占位条目兜底');
    assert.equal(placeholders[0].threadId, 'wt-relay');
  });

  it('after commit the successor renders as the anchored thread entry (converged single entry)', () => {
    const ctx = loadRuntimeStatus();
    const thread = {
      threadId: 'wt-relay', agentId: 'coder',
      title: '工作对话', headSessionId: 'old-head', sessionIds: ['old-head'],
      status: 'open', lifeState: 'executing', handoffStartedAt: Date.now(),
    };
    ctx.window.ClawThreads = { threads: [thread], sessionIndex: { 'coder::old-head': thread } };

    runCollect(ctx, JSON.stringify([CHILD_OLD]));

    // commit：head 推进、sessionChain 补上 successor、挡板清除
    thread.headSessionId = 'new-head';
    thread.sessionIds = ['old-head', 'new-head'];
    thread.handoffStartedAt = 0;
    ctx.window.ClawThreads.sessionIndex['coder::new-head'] = thread;

    const entries = runCollect(ctx, JSON.stringify([CHILD_NEW]));
    const threadEntries = entries.filter((e) => e.threadId === 'wt-relay');
    assert.equal(threadEntries.length, 1, 'commit 后收敛为单条目');
    assert.equal(threadEntries[0].runtimeId, 'new-runtime');
    assert.notEqual(threadEntries[0].transitionPending, true, '收敛后条目为实态');
  });

  it('non-thread coder session without an active barrier still renders as its own entry', () => {
    const ctx = loadRuntimeStatus();
    // 无挡板：普通新 coder 会话（用户/调度新建）必须照常渲染为独立条目
    ctx.window.ClawThreads = {
      threads: [{
        threadId: 'wt-idle', agentId: 'coder',
        title: '另一线程', headSessionId: 'idle-head', sessionIds: ['idle-head'],
        status: 'open', lifeState: 'idle', handoffStartedAt: 0,
      }],
      sessionIndex: {},
    };
    ctx.window.ClawThreads.sessionIndex['coder::idle-head'] = ctx.window.ClawThreads.threads[0];

    const entries = runCollect(ctx, JSON.stringify([CHILD_NEW]));
    assert.ok(entries.some((e) => e.runtimeId === 'new-runtime' && !e.threadId),
      '无挡板时未命中会话仍渲染为普通条目');
  });
});
