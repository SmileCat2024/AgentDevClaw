/**
 * IM 接线员线程事务测试（ADR-0042 决策 5：qqbot 业务单对话模型）
 *
 * 全内存 deps：不触真实用户数据目录、不起真实 runtime。
 * 直接驱动 setupIMOperatorThreadRoutes 返回的 controller 方法，
 * 不经过 HTTP 层（路由注册本身无分支逻辑）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupIMOperatorThreadRoutes, resolveOperatorHeadSessionId } from '../server/routes/im-operator-thread.js';

const OPERATOR = 'qqbot';

function createHarness(overrides = {}) {
  const state = {
    config: {},
    sessions: [],          // createPrebuiltSession 计数
    threads: new Map(),    // threadId → { threadId, headSessionId, status }
    sessionToThread: new Map(), // sessionId → threadId（onSessionCreated 建）
    archivedThreads: [],
    deletedThreads: [],
    started: [],
    stopped: [],
    runtimeReady: true,
    findThreadFails: false,
    legacyArchives: [],
  };

  const harness = {
    state,
    // thread core 桩：findThreadByHeadSession 按 onSessionCreated 建立的映射查
    threadControl: {
      core: {
        getThread: async (threadId) => {
          const thread = state.threads.get(threadId);
          if (!thread) return null;
          return { ...thread };
        },
        findThreadByHeadSession: async (agentId, sessionId) => {
          if (state.findThreadFails) return null;
          const threadId = state.sessionToThread.get(sessionId);
          return threadId ? { ...state.threads.get(threadId) } : null;
        },
      },
      archive: {
        isArchived: async (threadId) => state.archivedThreads.includes(threadId),
      },
    },
    threadIntegration: {
      onSessionCreated: async (agentId, session) => {
        // 模拟宿主钩子：qqbot（threadHost）会话自动锚定为新线程初始 head
        const threadId = `wt-test-${session.id}`;
        state.threads.set(threadId, {
          threadId,
          headSessionId: session.id,
          status: 'active',
          agentId,
        });
        state.sessionToThread.set(session.id, threadId);
      },
    },
    threadLifecycle: {
      archiveThread: async (threadId) => {
        state.archivedThreads.push(threadId);
        const thread = state.threads.get(threadId);
        if (thread) thread.status = 'closed';
      },
    },
    threadDelete: {
      deleteThread: async (threadId) => {
        state.deletedThreads.push(threadId);
        return { status: 'complete' };
      },
    },
    requireAgentLight: async (agentId) => ({ id: agentId }),
    createPrebuiltSession: async (agentId) => {
      state.sessions.push(agentId);
      return { id: `s-${state.sessions.length}` };
    },
    startManagedAgent: async (agent, sessionId) => {
      state.started.push(sessionId);
    },
    stopManagedAgent: async (agentId, sessionId) => {
      state.stopped.push(sessionId);
    },
    waitForManagedRuntimeReady: async () => state.runtimeReady,
    readConfig: async () => ({ ...state.config }),
    mutateConfig: async (mutator) => {
      const shouldWrite = await mutator(state.config);
      return shouldWrite ? { ...state.config } : { ...state.config };
    },
    archiveLegacySession: async (agentId, sessionId, archived) => {
      state.legacyArchives.push({ agentId, sessionId, archived });
    },
    ...overrides,
  };

  harness.controller = setupIMOperatorThreadRoutes(
    { post: () => {} }, // express app 桩：仅注册路由，不驱动
    { json: () => {} },
    {
      requireAgentLight: harness.requireAgentLight,
      createPrebuiltSession: harness.createPrebuiltSession,
      startManagedAgent: harness.startManagedAgent,
      stopManagedAgent: harness.stopManagedAgent,
      waitForManagedRuntimeReady: harness.waitForManagedRuntimeReady,
      threadControl: harness.threadControl,
      threadIntegration: harness.threadIntegration,
      threadLifecycle: harness.threadLifecycle,
      threadDelete: harness.threadDelete,
      readConfig: harness.readConfig,
      mutateConfig: harness.mutateConfig,
      archiveLegacySession: harness.archiveLegacySession,
    },
  );
  return harness;
}

test('resolveOperatorHeadSessionId：引用存活返回 head 会话', async () => {
  const harness = createHarness();
  const thread = { threadId: 'wt-1', headSessionId: 's-9', status: 'active' };
  harness.state.threads.set('wt-1', thread);
  harness.state.config = { operatorThreadId: 'wt-1', receptionistSessionId: 's-old' };
  const sessionId = await resolveOperatorHeadSessionId({
    integration: { core: harness.threadControl.core, archive: harness.threadControl.archive },
    readConfig: harness.readConfig,
  });
  assert.equal(sessionId, 's-9');
});

test('resolveOperatorHeadSessionId：无引用 / 线程终态 / 归档均返回 null（不回退 receptionistSessionId）', async () => {
  const base = createHarness();
  const integration = { core: base.threadControl.core, archive: base.threadControl.archive };

  // 无引用
  assert.equal(await resolveOperatorHeadSessionId({ integration, readConfig: async () => ({ receptionistSessionId: 's-old' }) }), null);

  // 引用悬空（线程不存在）
  const h1 = createHarness();
  h1.state.config = { operatorThreadId: 'wt-gone' };
  assert.equal(await resolveOperatorHeadSessionId({ integration: { core: h1.threadControl.core, archive: h1.threadControl.archive }, readConfig: h1.readConfig }), null);

  // 线程终态 / 已归档
  const h2 = createHarness();
  h2.state.threads.set('wt-closed', { threadId: 'wt-closed', headSessionId: 's-1', status: 'closed' });
  h2.state.config = { operatorThreadId: 'wt-closed' };
  assert.equal(await resolveOperatorHeadSessionId({ integration: { core: h2.threadControl.core, archive: h2.threadControl.archive }, readConfig: h2.readConfig }), null);

  const h3 = createHarness();
  h3.state.threads.set('wt-arch', { threadId: 'wt-arch', headSessionId: 's-1', status: 'active' });
  h3.state.archivedThreads.push('wt-arch');
  h3.state.config = { operatorThreadId: 'wt-arch' };
  assert.equal(await resolveOperatorHeadSessionId({ integration: { core: h3.threadControl.core, archive: h3.threadControl.archive }, readConfig: h3.readConfig }), null);
});

test('conversation/start：无引用 → 新建一代（会话→runtime→线程锚定→写引用）', async () => {
  const harness = createHarness();
  const result = await harness.controller.ensureOperatorConversation();
  assert.equal(result.created, true);
  assert.equal(result.sessionId, 's-1');
  assert.match(result.threadId, /^wt-test-s-1$/);
  assert.equal(harness.state.config.operatorThreadId, result.threadId);
  assert.equal(harness.state.started.length, 1);
});

test('conversation/start：引用存活 → 复用 head 不新建', async () => {
  const harness = createHarness();
  const first = await harness.controller.ensureOperatorConversation();
  const second = await harness.controller.ensureOperatorConversation();
  assert.equal(second.created, false);
  assert.equal(second.threadId, first.threadId);
  assert.equal(second.sessionId, first.sessionId);
  assert.equal(harness.state.sessions.length, 1);
});

test('conversation/new：换代归档旧线程，引用指向新线程', async () => {
  const harness = createHarness();
  const first = await harness.controller.ensureOperatorConversation();

  const second = await harness.controller.replaceOperatorConversation();
  // 新一代已建并落引用
  assert.equal(second.created, true);
  assert.notEqual(second.threadId, first.threadId);
  assert.equal(harness.state.config.operatorThreadId, second.threadId);
  // 旧线程归档（打断收纳），旧会话保留
  assert.deepEqual(second.archive, { archived: true, threadId: first.threadId });
  assert.ok(harness.state.archivedThreads.includes(first.threadId));
});

test('conversation/new：旧线程归档失败不回滚新引用', async () => {
  const harness = createHarness();
  const first = await harness.controller.ensureOperatorConversation();
  harness.threadLifecycle.archiveThread = async () => {
    throw new Error('archive backend down');
  };

  const second = await harness.controller.replaceOperatorConversation();
  assert.equal(second.archive.archived, false);
  assert.equal(second.archive.threadId, first.threadId);
  // 引用仍指向新线程——唯一活动语义不被归档失败破坏
  assert.equal(harness.state.config.operatorThreadId, second.threadId);
});

test('升级迁移：首建线程后归档旧 receptionist 会话并清引用（ADR-0042 决策 6）', async () => {
  const harness = createHarness();
  harness.state.config = { receptionistSessionId: 's-legacy' };

  const result = await harness.controller.ensureOperatorConversation();
  assert.equal(result.created, true);
  // 旧会话归档且引用清除
  assert.deepEqual(harness.state.legacyArchives,
    [{ agentId: 'qqbot', sessionId: 's-legacy', archived: true }]);
  assert.equal(harness.state.config.receptionistSessionId, undefined);
  // 新引用落定
  assert.equal(harness.state.config.operatorThreadId, result.threadId);
});

test('升级迁移：旧会话归档失败不破坏首建线程', async () => {
  // 经 overrides 注入失败桩（controller 构造时捕获引用，事后替换无效）
  const harness = createHarness({
    archiveLegacySession: async () => {
      throw new Error('index write failed');
    },
  });
  harness.state.config = { receptionistSessionId: 's-legacy' };

  const result = await harness.controller.ensureOperatorConversation();
  assert.equal(result.created, true);
  assert.equal(result.legacy.archived, false);
  // 新线程引用已落定，receptionistSessionId 保留待下次重试
  assert.equal(harness.state.config.operatorThreadId, result.threadId);
  assert.equal(harness.state.config.receptionistSessionId, 's-legacy');
});

test('创建失败（线程未锚定）→ 回滚：停 runtime，引用不写', async () => {
  const harness = createHarness();
  // 线程锚定失败：会话已建、runtime 已起，但宿主钩子后的对账查不到线程
  harness.threadControl.core.findThreadByHeadSession = async () => null;
  await assert.rejects(
    () => harness.controller.ensureOperatorConversation(),
    (err) => err.code === 'thread_missing',
  );
  assert.equal(harness.state.stopped.length, 1);
  assert.equal(harness.state.config.operatorThreadId, undefined);
});

test('runtime 未 ready → 504 并回滚（停 runtime + 线程级联删）', async () => {
  const harness = createHarness();
  harness.state.runtimeReady = false;
  await assert.rejects(
    () => harness.controller.ensureOperatorConversation(),
    (err) => err.status === 504 && err.code === 'runtime_ready_timeout',
  );
  assert.equal(harness.state.stopped.length, 1);
  // 线程已锚定（onSessionCreated 先于 ready 检查）→ 回滚必须级联删线程
  assert.equal(harness.state.deletedThreads.length, 1);
  assert.equal(harness.state.config.operatorThreadId, undefined);
});

test('boot：引用存在唤起 head，无引用不动', async () => {
  const harness = createHarness();
  const none = await harness.controller.bootIMOperatorOnServerReady();
  assert.equal(none.booted, false);
  assert.equal(harness.state.started.length, 0);

  const first = await harness.controller.ensureOperatorConversation();
  harness.state.started.length = 0;
  const booted = await harness.controller.bootIMOperatorOnServerReady();
  assert.equal(booted.booted, true);
  assert.equal(booted.threadId, first.threadId);
  assert.equal(harness.state.started.length, 1);
});
