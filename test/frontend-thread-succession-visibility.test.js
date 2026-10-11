/**
 * 接续窗口的即时可见性（frontend-vm 沙箱）
 *
 * 用户症状：打断后顶栏「上下文接力中…」指示器与输入暂存气泡要等几十秒
 * （successor 上线重绑后）才同时出现。两者都在 refreshThreads 的 finally
 * 里同步刷新——同时出现/熄灭，指向同一数据到达时刻滞后。
 *
 * 断点一（in-flight 短路）：refreshThreads(force) 撞上慢的周期请求时直接
 * return 旧 promise，SSE handoff-started 触发的强制刷新丢失，挡板新事实
 * 延迟到下个 20s 轮询周期。
 * 断点二（会话身份失准）：退役清空 runtime 态后 _currentActiveSession 落到
 * 宿主 main 会话——getThreadForSession 不得命中，指示器/气泡/输入路由全部
 * 失准（徽标中途熄灭）。
 * 断点三（占位条目点击）：占位条目携带的 runtimeId 已不在 allAgents，
 * 点击走 threadId 分支时 agentId 解析为 undefined → openConversationTarget
 * 静默 return agent_missing——接续中切走后切不回来。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

function unrefTimer(handle) { if (handle && typeof handle.unref === 'function') handle.unref(); return handle; }

function baseCtx(overrides = {}) {
  const ctx = createFrontendSandbox({
    currentLanguage: 'zh',
    focusedAgentId: 'coder',
    currentRuntimeAgentId: 'runtime-old',
    allAgents: [],
    getCurrentHostAgentRecord: () => ({
      id: 'coder',
      active_workspace_session_id: 'session-main',
    }),
    getRuntimeWorkspaceSessionId: () => '',
    setTimeout: (fn, ms) => unrefTimer(globalThis.setTimeout(fn, ms)),
    setInterval: (fn, ms) => unrefTimer(globalThis.setInterval(fn, ms)),
    ...overrides,
  });
  ctx.loadSource('public/src/modules/thread-store.js');
  return ctx;
}

function installThread(ctx, thread) {
  ctx.window.ClawThreads.threads = [thread];
  ctx.window.ClawThreads.byId[thread.threadId] = thread;
  for (const sid of thread.sessionIds || []) {
    ctx.window.ClawThreads.sessionIndex[`${thread.agentId}::${sid}`] = thread;
  }
}

describe('thread-store: handoff visibility during the succession window', () => {
  it('force refresh chains a new fetch when a slow in-flight request holds stale data', async () => {
    let fetchCalls = 0;
    const gate = [];
    const threadBefore = {
      threadId: 'wt-vis', agentId: 'coder',
      headSessionId: 'session-old', sessionIds: ['session-old'],
      status: 'open', lifeState: 'executing', handoffStartedAt: 0,
    };
    const threadAfter = { ...threadBefore, status: 'rotating', handoffStartedAt: Date.now() };
    const ctx = baseCtx({
      fetch: async () => {
        fetchCalls += 1;
        if (fetchCalls === 1) {
          // 周期请求正在网络中（挡板立起前发出，响应不含新事实）
          await new Promise((resolve) => gate.push(resolve));
          return { ok: true, json: async () => ({ ok: true, threads: [threadBefore], contentHash: 'h1' }) };
        }
        return { ok: true, json: async () => ({ ok: true, threads: [threadAfter], contentHash: 'h2' }) };
      },
    });

    const slow = ctx.window.refreshThreads();     // 周期轮询（慢，挂起中）
    const forced = ctx.window.refreshThreads(true); // SSE handoff-started 语义
    await Promise.resolve();
    gate[0]();                                     // 周期响应到达（旧数据）
    await Promise.all([slow, forced]);

    // force 不得被 in-flight 短路：必须串联一次新拉取拿到挡板事实
    assert.equal(fetchCalls, 2, 'force 刷新必须在 in-flight 完成后再拉一次');
    const thread = ctx.window.getThreadById('wt-vis');
    assert.ok(Number(thread.handoffStartedAt) > 0, 'threads 状态含挡板事实');
  });

  it('current session falls back to the thread conversation when runtime state was cleared', () => {
    const ctx = baseCtx();
    installThread(ctx, {
      threadId: 'wt-vis', agentId: 'coder',
      headSessionId: 'session-old', sessionIds: ['session-old'],
      status: 'rotating', lifeState: 'executing', handoffStartedAt: Date.now(),
    });
    // 退役窗口：runtime 态被清空，但视图身份（activeConversation）仍指向线程
    ctx.currentRuntimeAgentId = '';
    ctx.window.ClawThreads.activeConversation = {
      agentId: 'coder', threadId: 'wt-vis', sessionId: 'session-old', runtimeId: '',
    };

    const active = ctx.run('_currentActiveSession()');
    // 不得落到宿主 main 会话（getThreadForSession 不得命中 → 指示器熄灭）
    assert.equal(active?.agentId, 'coder');
    assert.equal(active?.sessionId, 'session-old', '会话身份回退到线程会话，而非宿主 main');
  });

  it('placeholder entry click resolves agent and head from thread facts when the runtime is gone', async () => {
    const actions = [];
    const ctx = baseCtx({
      currentRuntimeAgentId: '',
      switchAgent: async () => {},
    });
    ctx.window.runWorkspaceAction = async (payload) => { actions.push(JSON.parse(payload)); };
    installThread(ctx, {
      threadId: 'wt-vis', agentId: 'coder',
      headSessionId: 'session-old', sessionIds: ['session-old'],
      status: 'rotating', lifeState: 'executing', handoffStartedAt: Date.now(),
    });
    ctx.window.ClawThreads.activeConversation = {
      agentId: 'coder', threadId: 'wt-vis', sessionId: 'session-old', runtimeId: '',
    };

    // 占位条目点击：只有 threadId 可用（runtimeId 已不在 allAgents）。
    // T018：挡板窗口（rotating + fresh handoff）本地挂线程等待视图——
    // open_session 会给退役中的 head 启动 runtime（与 rotation 竞态），
    // 服务端 activate 同样拒绝（thread_handoff_in_progress）。
    const result = await ctx.window.openConversationTarget({ threadId: 'wt-vis' });

    assert.equal(actions.length, 0, '挡板窗口不得发出 open_session（runtime 竞态根因）');
    assert.equal(result?.ok, true, '点击成功挂线程等待视图');
    assert.equal(ctx.window.ClawThreads.activeConversation?.threadId, 'wt-vis');
    assert.equal(ctx.window.ClawThreads.activeConversation?.sessionId, 'session-old');
  });

  it('guard: leaving the thread clears the conversation fallback', () => {
    const ctx = baseCtx();
    installThread(ctx, {
      threadId: 'wt-vis', agentId: 'coder',
      headSessionId: 'session-old', sessionIds: ['session-old'],
      status: 'open', lifeState: 'idle', handoffStartedAt: 0,
    });
    ctx.currentRuntimeAgentId = '';
    // 用户已切到宿主 main 会话：activeConversation 无线程指向。
    // T018：宿主 active 回退已删除（IM/CLI/接力改写的共享状态是串扰源）——
    // 解析失败宁 null（输入降级 direct），不得猜测，也不得黏线程会话。
    ctx.window.ClawThreads.activeConversation = {
      agentId: 'coder', threadId: '', sessionId: 'session-main', runtimeId: '',
    };
    const active = ctx.run('_currentActiveSession()');
    assert.equal(active, null, '无线程指向且 runtime 态清空：返回 null，不回退宿主 active，不黏线程会话');
  });
});
