/**
 * sidebar-thread-anchor（docs/plans/2026-10-10-sidebar-thread-anchor.md）
 *
 * 覆盖方案 A 的前端三块：
 *   1. 条目映射（S2）：collectRuntimeEntriesForPrebuilt 的 coder 分支双源
 *      合并——主源线程记录（threadId 锚），属性源 head runtime；接续空窗
 *      / rotation_failed / 休眠 / 终态的状态矩阵；
 *   2. 渲染态（S2/S4）：thread-continuing / thread-failed 的类名、过渡
 *      标签、禁用属性与 data-ctx-* 形状；
 *   3. SSE 事件（S3/§6）：rotation-begun / head-advanced 到达 → 强制刷新
 *      线程快照 + 订阅集同步 + 视图硬切换守卫。
 *
 * 测试用真实事务形状驱动（GET /protoclaw/threads 载荷字段 + 框架挡板
 * 事实：status=rotating / handoffStartedAt / rotation_failed）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

// ── S2：条目映射 ────────────────────────────────────────────────────

function loadRuntimeStatusForThreads({ threads = [], allAgents = [] } = {}) {
  const ctx = createFrontendSandbox({
    t: (key) => key,
    currentLanguage: 'zh',
    currentMessages: [],
    allAgents,
    normalizeAgentIdentity: (x) => String(x || '').trim(),
    getPathLeaf: (value) => String(value || '').replace(/\\/g, '/').split('/').filter(Boolean).pop() || '',
    toEpochMs: (value) => (typeof value === 'number' && Number.isFinite(value) ? value : Date.parse(value || '') || 0),
    _agentCallActive: new Map(),
  });
  ctx.window.setInterval = () => 0;
  ctx.window.SIDEBAR_TODO_COLORS = new Set(['white']);
  ctx.window.ClawThreads = { threads };
  ctx.loadSource('public/src/modules/sidebar-operations.js');
  ctx.loadSource('public/src/modules/runtime-status.js');
  return ctx;
}

const CODER_PROJECTION = {
  id: 'programming-helper:coder',
  agentId: 'programming-helper',
  sessionType: 'coder',
  source: 'prebuilt',
  workspace_sessions: { sessions: [] },
};

function childRuntime(sessionId, runtimeId = `rt-${sessionId}`) {
  return {
    id: runtimeId,
    source: 'child',
    parent_id: 'programming-helper',
    sessionType: 'coder',
    sidebar_entry_id: 'programming-helper:coder',
    runtime_session_id: runtimeId,
    active_workspace_session_id: sessionId,
    connected: true,
  };
}

function collectIn(ctx, agents) {
  ctx.projection = CODER_PROJECTION;
  ctx.agents = agents;
  return ctx.run('collectRuntimeEntriesForPrebuilt(projection, agents)');
}

describe('sidebar thread anchor: entry mapping (S2)', () => {
  it('merges a live head runtime into the thread-anchored entry', () => {
    const ctx = loadRuntimeStatusForThreads({
      threads: [{
        threadId: 'wt-1', agentId: 'programming-helper', identity: 'coder',
        title: '修复登录页', status: 'open', headSessionId: 'sess-a',
        sessionIds: ['sess-a'], lifeState: 'idle', failed: false,
        handoffStartedAt: 0, headProjectDir: 'D:/code/proj-a', createdAt: 1700000000000,
      }],
    });
    const entries = collectIn(ctx, [childRuntime('sess-a', 'rt-head')]);
    assert.equal(entries.length, 1);
    const [entry] = entries;
    assert.equal(entry.threadId, 'wt-1');
    assert.equal(entry.id, 'wt-1');
    // 属性源：runtime 寻址与运行态字段保留
    assert.equal(entry.runtimeId, 'rt-head');
    assert.equal(entry.sessionId, 'sess-a');
    assert.equal(entry.source, 'child');
    assert.notEqual(entry.threadContinuing, true);
    assert.notEqual(entry.threadFailed, true);
  });

  it('keeps the entry through the rotation window with a continuing state', () => {
    // 真实事务形状：beginSessionHandoff 原子写 status=rotating + startedAt；
    // 旧 head runtime 已退役（agents 列表无记录）。
    const ctx = loadRuntimeStatusForThreads({
      threads: [{
        threadId: 'wt-2', agentId: 'programming-helper', identity: 'coder',
        title: '接续中的线程', status: 'rotating', headSessionId: 'sess-old',
        sessionIds: ['sess-old'], lifeState: 'executing', failed: false,
        handoffStartedAt: Date.now() - 1000, headProjectDir: 'D:/code/proj-b',
        createdAt: 1700000000000,
      }],
    });
    const entries = collectIn(ctx, []);
    assert.equal(entries.length, 1);
    const [entry] = entries;
    assert.equal(entry.threadId, 'wt-2');
    assert.equal(entry.threadContinuing, true);
    assert.equal(entry.runtimeId, 'thread:wt-2');
    assert.equal(entry.source, 'thread-record');
    assert.equal(entry.status, 'connected');
    assert.equal(entry.projectDir, 'D:/code/proj-b');
    assert.notEqual(entry.threadDormant, true);
  });

  it('maps rotation_failed threads to the failure state', () => {
    const ctx = loadRuntimeStatusForThreads({
      threads: [{
        threadId: 'wt-3', agentId: 'programming-helper', identity: 'coder',
        title: '失败的线程', status: 'rotation_failed', headSessionId: 'sess-old',
        sessionIds: ['sess-old'], lifeState: 'idle', failed: true,
        handoffStartedAt: 0, headProjectDir: '', createdAt: 1700000000000,
      }],
    });
    const entries = collectIn(ctx, []);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].threadFailed, true);
    assert.notEqual(entries[0].threadContinuing, true);
  });

  it('shows dormant (not continuing) when the runtime is absent without a live barrier', () => {
    // S5 验收要求：runtime 崩溃 / 停止不得显示「接续中」。
    const ctx = loadRuntimeStatusForThreads({
      threads: [{
        threadId: 'wt-4', agentId: 'programming-helper', identity: 'coder',
        title: '休眠线程', status: 'open', headSessionId: 'sess-a',
        sessionIds: ['sess-a'], lifeState: 'idle', failed: false,
        handoffStartedAt: 0, headProjectDir: '', createdAt: 1700000000000,
      }],
    });
    const entries = collectIn(ctx, []);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].threadDormant, true);
    assert.equal(entries[0].status, 'disconnected');
    assert.notEqual(entries[0].threadContinuing, true);
  });

  it('treats a stale rotating barrier as dormant (crashed mid-rotation residue)', () => {
    const ctx = loadRuntimeStatusForThreads({
      threads: [{
        threadId: 'wt-5', agentId: 'programming-helper', identity: 'coder',
        title: '残留挡板', status: 'rotating', headSessionId: 'sess-a',
        sessionIds: ['sess-a'], lifeState: 'executing', failed: false,
        handoffStartedAt: Date.now() - 6 * 60 * 1000, headProjectDir: '',
        createdAt: 1700000000000,
      }],
    });
    const entries = collectIn(ctx, []);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].threadDormant, true);
    assert.notEqual(entries[0].threadContinuing, true);
  });

  it('removes terminal threads (closed / archived life state)', () => {
    const ctx = loadRuntimeStatusForThreads({
      threads: [
        { threadId: 'wt-c', agentId: 'programming-helper', identity: 'coder', lifeState: 'closed', status: 'closed', headSessionId: 's1' },
        { threadId: 'wt-a', agentId: 'programming-helper', identity: 'coder', lifeState: 'archived', status: 'open', headSessionId: 's2' },
      ],
    });
    assert.equal(collectIn(ctx, []).length, 0);
  });

  it('removes threads whose head session is archived', () => {
    const ctx = loadRuntimeStatusForThreads({
      threads: [{
        threadId: 'wt-6', agentId: 'programming-helper', identity: 'coder',
        title: 'head 已归档', status: 'open', headSessionId: 'sess-arch',
        sessionIds: ['sess-arch'], lifeState: 'idle', failed: false,
        handoffStartedAt: 0, createdAt: 1700000000000,
      }],
      allAgents: [{
        id: 'programming-helper',
        workspace_sessions: { sessions: [{ id: 'sess-arch', openDirectory: 'D:/p', archived: true }] },
      }],
    });
    assert.equal(collectIn(ctx, []).length, 0);
  });

  it('falls back to runtime-anchored entries when the runtime has no thread record yet', () => {
    // 线程快照滞后（新会话已起 / 提交前 successor）：新会话仍即时可见。
    const ctx = loadRuntimeStatusForThreads({
      threads: [{
        threadId: 'wt-7', agentId: 'programming-helper', identity: 'coder',
        title: '换头前', status: 'rotating', headSessionId: 'sess-old',
        sessionIds: ['sess-old'], lifeState: 'executing', failed: false,
        handoffStartedAt: Date.now() - 500, headProjectDir: '', createdAt: 1700000000000,
      }],
    });
    const entries = collectIn(ctx, [childRuntime('sess-new', 'rt-successor')]);
    assert.equal(entries.length, 2);
    const byAnchor = new Map(entries.map((e) => [e.id, e]));
    assert.equal(byAnchor.get('wt-7').threadContinuing, true);
    const successor = byAnchor.get('rt-successor');
    assert.ok(successor, 'pre-commit successor runtime keeps a runtime-anchored entry');
    assert.notEqual(successor.threadId, 'wt-7');
  });

  it('ignores threads of other agents or identities', () => {
    const ctx = loadRuntimeStatusForThreads({
      threads: [
        { threadId: 'wt-x', agentId: 'other-workspace', identity: 'coder', lifeState: 'idle', status: 'open', headSessionId: 's1' },
        { threadId: 'wt-y', agentId: 'programming-helper', identity: 'main', lifeState: 'idle', status: 'open', headSessionId: 's2' },
      ],
    });
    assert.equal(collectIn(ctx, []).length, 0);
  });
});

// ── S2/S4：渲染态 ───────────────────────────────────────────────────

function loadRenderer() {
  const ctx = createFrontendSandbox({
    t: (key) => key,
    currentLanguage: 'zh',
    currentMessages: [],
    allAgents: [],
    normalizeAgentIdentity: (x) => String(x || '').trim(),
    getPathLeaf: () => '',
    toEpochMs: () => 0,
    _agentCallActive: new Map(),
    restartingRuntimeIds: new Set(),
    _recentlyFinishedRuntimes: new Set(),
    isRuntimeItemActive: (rid) => rid === 'rt-focused',
    isRuntimeCalling: () => false,
    getRuntimeWorkspaceSessionId: (rid) => (rid === 'rt-focused' ? 'sess-focused' : ''),
  });
  ctx.window.setInterval = () => 0;
  ctx.agentList = { addEventListener() {} };
  ctx.loadSource('public/src/modules/sidebar-operations.js');
  ctx.loadSource('public/src/modules/runtime-status.js');
  ctx.loadSource('public/src/modules/sidebar-render.js');
  return ctx;
}

function renderEntriesIn(ctx, entries) {
  ctx.entries = entries;
  return ctx.run('renderSidebarChildItems(entries, "programming-helper", "programming-helper")');
}

describe('sidebar thread anchor: rendering states (S2/S4)', () => {
  it('renders the continuing state with label, class, and disabled interaction', () => {
    const ctx = loadRenderer();
    const html = renderEntriesIn(ctx, [{
      id: 'wt-1', threadId: 'wt-1', ownerId: 'programming-helper',
      runtimeId: 'thread:wt-1', sessionId: 'sess-a', sessionType: 'coder',
      name: '接续中的线程', status: 'connected', source: 'thread-record',
      contextMenuEnabled: true, createdAt: null, threadContinuing: true,
    }]);
    assert.match(html, /thread-continuing/);
    assert.match(html, /接续中/);
    assert.match(html, /data-agent-disabled="true"/);
    assert.match(html, /data-agent-id="thread:wt-1"/);
    assert.match(html, /data-ctx-variant="thread-record"/);
    assert.match(html, /data-ctx-session-id="sess-a"/);
  });

  it('renders a failed thread with a live head as failed but clickable', () => {
    const ctx = loadRenderer();
    const html = renderEntriesIn(ctx, [{
      id: 'wt-live-failed', threadId: 'wt-live-failed', ownerId: 'programming-helper',
      runtimeId: 'rt-live', sessionId: 'sess-a', sessionType: 'coder',
      name: '失败但仍运行的线程', status: 'connected', source: 'child',
      contextMenuEnabled: true, createdAt: null, threadFailed: true, threadHasRuntime: true,
    }]);
    assert.match(html, /thread-failed/);
    assert.match(html, /接续失败/);
    assert.ok(html.includes('data-agent-disabled="false"'));
    assert.ok(html.includes('data-agent-id="rt-live"'));
  });

  it('renders a failed thread without a head runtime as disabled', () => {
    const ctx = loadRenderer();
    const html = renderEntriesIn(ctx, [{
      id: 'wt-placeholder-failed', threadId: 'wt-placeholder-failed', ownerId: 'programming-helper',
      runtimeId: 'thread:wt-placeholder-failed', sessionId: 'sess-a', sessionType: 'coder',
      name: '失败的线程', status: 'connected', source: 'thread-record',
      contextMenuEnabled: true, createdAt: null, threadFailed: true,
    }]);
    assert.match(html, /thread-failed/);
    assert.match(html, /接续失败/);
    assert.ok(html.includes('data-agent-disabled="true"'));
    assert.doesNotMatch(html, /thread-continuing/);
  });

  it('keeps live thread entries clickable and marks activity by thread ownership', () => {
    const ctx = loadRenderer();
    // 焦点 runtime 已退役（接续空窗后视图仍指向旧会话）：选中态按焦点会话
    // 的线程归属判定，而不是 runtimeId 相等。
    ctx.run('window.getThreadForSession = (agentId, sessionId) => (sessionId === "sess-focused" ? { threadId: "wt-3" } : null)');
    ctx.run('currentRuntimeAgentId = "rt-focused"');
    renderEntriesIn(ctx, [{ threadId: 'other', runtimeId: 'rt-other', ownerId: 'programming-helper' }]); // 缓存焦点会话后模拟接续空窗
    ctx.run('currentRuntimeAgentId = "rt-dead"');
    const html = renderEntriesIn(ctx, [{
      id: 'wt-3', threadId: 'wt-3', ownerId: 'programming-helper',
      runtimeId: 'rt-head', sessionId: 'sess-b', sessionType: 'coder',
      name: '运行中的线程', status: 'connected', source: 'child',
      contextMenuEnabled: true, createdAt: null,
    }]);
    assert.match(html, /class="agent-item agent-runtime-item active/);
    assert.match(html, /data-agent-disabled="false"/);
  });
});

// ── S3/§6：SSE 事件刷新与视图硬切换 ─────────────────────────────────

function loadThreadStore({ responses, focusSessionId = 'sess-a' } = {}) {
  const calls = { fetch: [], actions: [], renderAgentList: 0, unsub: 0 };
  const subscriptions = [];
  let responseQueue = [...responses];
  const ctx = createFrontendSandbox({
    fetch: async (url) => {
      calls.fetch.push(String(url));
      const body = responseQueue.length > 0
        ? responseQueue.shift()
        : { ok: true, threads: [], contentHash: 'empty' };
      return { ok: true, json: async () => body };
    },
    setTimeout: () => 0,
    setInterval: () => 0,
    currentLanguage: 'zh',
    getCurrentHostAgentRecord: () => ({ id: 'programming-helper' }),
    currentRuntimeAgentId: 'rt-old',
    getRuntimeWorkspaceSessionId: (rid) => (rid === 'rt-old' ? focusSessionId : ''),
    renderAgentList: () => { calls.renderAgentList += 1; },
  });
  ctx.window.runWorkspaceAction = async (payload) => { calls.actions.push(JSON.parse(payload)); };
  ctx.window.ClawFW = {
    SseClient: {
      subscribeThreadEvents: (ids, handler) => {
        subscriptions.push({ ids: [...ids], handler });
        return () => { calls.unsub += 1; };
      },
    },
  };
  ctx.loadSource('public/src/modules/thread-store.js');
  return { ctx, calls, subscriptions };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('sidebar thread anchor: SSE refresh and view rebind (S3/§6)', () => {
  it('subscribes to thread events and re-renders the sidebar on thread refresh', async () => {
    const { ctx, calls, subscriptions } = loadThreadStore({
      responses: [{
        ok: true,
        contentHash: 'h1',
        threads: [
          { threadId: 'wt-1', agentId: 'programming-helper', headSessionId: 'sess-a', status: 'open', sessionIds: ['sess-a'] },
          { threadId: 'wt-2', agentId: 'programming-helper', headSessionId: 'sess-b', status: 'open', sessionIds: ['sess-b'] },
        ],
      }],
    });
    await ctx.run('window.refreshThreads(true)');
    assert.equal(subscriptions.length, 1);
    assert.deepEqual(subscriptions[0].ids, ['wt-1', 'wt-2']);
    assert.ok(calls.renderAgentList >= 1, 'sidebar re-renders when thread facts change');
    // 共享陈旧线常量（runtime-status.threadHandoffStaleMs 消费）
    assert.equal(ctx.window.ClawFW.THREAD_HANDOFF_STALE_MS, 5 * 60 * 1000);
  });

  it('forces a thread refresh when rotation-begun arrives', async () => {
    const { ctx, calls, subscriptions } = loadThreadStore({
      responses: [
        { ok: true, contentHash: 'h1', threads: [{ threadId: 'wt-1', agentId: 'programming-helper', headSessionId: 'sess-a', status: 'open', sessionIds: ['sess-a'] }] },
        { ok: true, contentHash: 'h2', threads: [{ threadId: 'wt-1', agentId: 'programming-helper', headSessionId: 'sess-a', status: 'rotating', sessionIds: ['sess-a'] }] },
      ],
    });
    await ctx.run('window.refreshThreads(true)');
    const fetchCount = calls.fetch.length;
    subscriptions[0].handler({ type: 'thread.rotation-begun', threadId: 'wt-1', payload: { kind: 'thread.rotation-begun', agentId: 'programming-helper', fromSessionId: 'sess-a', reason: 'trim' } });
    await flush();
    await flush();
    assert.ok(calls.fetch.length > fetchCount, 'rotation-begun forces an immediate refresh');
    assert.equal(ctx.window.ClawThreads.threads[0].status, 'rotating');
  });

  it('hard-switches the view to the new head when the user is viewing the old head', async () => {
    const { ctx, calls, subscriptions } = loadThreadStore({
      focusSessionId: 'sess-a',
      responses: [
        { ok: true, contentHash: 'h1', threads: [{ threadId: 'wt-1', agentId: 'programming-helper', headSessionId: 'sess-a', status: 'open', sessionIds: ['sess-a'] }] },
        { ok: true, contentHash: 'h2', threads: [{ threadId: 'wt-1', agentId: 'programming-helper', headSessionId: 'sess-b', status: 'open', sessionIds: ['sess-a', 'sess-b'] }] },
      ],
    });
    await ctx.run('window.refreshThreads(true)');
    subscriptions[0].handler({
      type: 'thread.head-advanced',
      threadId: 'wt-1',
      payload: { kind: 'thread.head-advanced', agentId: 'programming-helper', fromSessionId: 'sess-a', toSessionId: 'sess-b', reason: 'trim' },
    });
    await flush();
    await flush();
    await flush();
    assert.equal(calls.actions.length, 1);
    assert.deepEqual(calls.actions[0], { type: 'open_session', sessionId: 'sess-b' });
  });

  it('does not navigate when the user is not viewing the advancing thread', async () => {
    const { ctx, calls, subscriptions } = loadThreadStore({
      focusSessionId: 'sess-other',
      responses: [
        { ok: true, contentHash: 'h1', threads: [{ threadId: 'wt-1', agentId: 'programming-helper', headSessionId: 'sess-a', status: 'open', sessionIds: ['sess-a'] }] },
        { ok: true, contentHash: 'h2', threads: [{ threadId: 'wt-1', agentId: 'programming-helper', headSessionId: 'sess-b', status: 'open', sessionIds: ['sess-a', 'sess-b'] }] },
      ],
    });
    await ctx.run('window.refreshThreads(true)');
    subscriptions[0].handler({
      type: 'thread.head-advanced',
      threadId: 'wt-1',
      payload: { kind: 'thread.head-advanced', agentId: 'programming-helper', fromSessionId: 'sess-a', toSessionId: 'sess-b', reason: 'trim' },
    });
    await flush();
    await flush();
    await flush();
    assert.equal(calls.actions.length, 0);
  });
});
