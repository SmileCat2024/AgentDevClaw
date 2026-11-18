import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withThreadDomainCase } from './p2-thread-case.js';
import { withThreadEngineCase } from './helpers/thread-engine.js';

// 刷新引擎 `thread-store.js` 已迁 ESM（P4 T3）：本文件的全部用例都走真实 import。
//   - 交互域用例用 `withThreadDomainCase`（基座装 classic 先行链 + 引擎 + 交互域）；
//   - 只碰引擎的用例用本地 `withEngineCase`：最小 classic 夹具 + 同一基座的
//     case 级 ESM 图（每 case 一代实例，模块级状态不跨用例）。引擎的内部操作
//     （_syncActiveThreadSubscription / 事实对账重绑）是命名导出，不再有 window 面；
//     状态键按 app-core 的注册面显式上桥，ESM 活绑定与沙箱属性同一份真相。

/** 本地别名：只碰引擎的用例走「最小夹具 + case 级 ESM 图」（见 helpers/thread-engine）。 */
const withEngineCase = withThreadEngineCase;

const IDENTITY = 'public/src/modules/identity.js';

/**
 * 身份域（P4 T1 从 app-core 抽出）：会话身份与 viewer 侧 runtimeId → sessionId
 * 绑定都是**真实实现**。用例按生产语义（switchAgent 建立绑定）播种，不再用
 * 同名 window 桩替代——引擎已具名 import 该域。
 */
async function seedViewerBinding(c, runtimeId, sessionId) {
  const identity = await c.load(IDENTITY);
  identity.setViewerSessionBinding(runtimeId, sessionId);
  return identity;
}

/** 线程事实（与引擎 `_rebuildIndexes` 同形）写入唯一状态对象（模块相版本）。 */
function installThread(ctx, thread) {
  const state = ctx.window.ClawThreads;
  state.threads = [thread];
  state.byId = { [thread.threadId]: thread };
  state.sessionIndex = {};
  for (const sid of thread.sessionIds || []) state.sessionIndex[`${thread.agentId}::${sid}`] = thread;
  return thread;
}

describe('thread-store: successor view rebind', () => {
  it('rebinds the viewed runtime to the successor without opening another session', async () => {
    let eventHandler;
    let loadAgentsCount = 0;
    let loadedRuntime = '';
    let threadsFetchCount = 0;
    await withEngineCase({ fixtures: {
      currentLanguage: 'zh',
      focusedAgentId: 'coder',
      currentRuntimeAgentId: 'runtime-old',
      allAgents: [{
        id: 'runtime-new', source: 'child', parent_id: 'coder',
        active_workspace_session_id: 'session-new',
        runtime_session_id: 'runtime-new',
      }],
      getCurrentHostAgentRecord: () => ({ id: 'coder' }),
      loadAgents: async () => { loadAgentsCount += 1; },
      loadAgentData: async (runtimeId) => { loadedRuntime = runtimeId; },
      saveCurrentRuntimeToCache() {},
      _storeVisibleSessionInputDraft() {},
      resetRuntimeStatusForSwitch() {},
      setPendingChatScrollRestore() {},
      renderAgentList() {},
      renderCurrentMainView() {},
      _lastRenderedChatSig: '',
      readOnlyMode: false,
    },
      // 线程事实由真实 refreshThreads 拉取：第一拍旧 head 稳态，此后 head 已推进
      //（等价于迁移前用 window.refreshThreads 桩喂事实，但走生产网络路径）。
      fetch: async (url) => {
        if (!String(url).startsWith('/protoclaw/threads')) return { ok: false, status: 0, json: async () => ({}) };
        threadsFetchCount += 1;
        const advanced = threadsFetchCount > 1;
        const thread = {
          threadId: 'wt-viewed', agentId: 'coder',
          headSessionId: advanced ? 'session-new' : 'session-old',
          sessionIds: advanced ? ['session-old', 'session-new'] : ['session-old'],
          lifeState: 'executing',
        };
        // 不带 contentHash：条件刷新（?sinceContentHash=）由专门的用例覆盖，这里走全量拉取。
        return { ok: true, json: async () => ({ threads: [thread] }) };
      },
    }, async ({ c, ctx, engine }) => {
      const identity = await seedViewerBinding(c, 'runtime-old', 'session-old');
      ctx.window.ClawFW = { SseClient: { subscribeThreadEvents: (id, handler) => {
        assert.equal(id, '*');
        eventHandler = handler;
        return () => {};
      } } };
      await ctx.window.refreshThreads();
      engine._syncActiveThreadSubscription();
      await eventHandler({
        type: 'thread.head-advanced', threadId: 'wt-viewed',
        payload: { fromSessionId: 'session-old', toSessionId: 'session-new', agentId: 'coder' },
      });
      // 重绑收尾的事实刷新是 fire-and-forget：让链路跑完再断言。
      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(loadedRuntime, 'runtime-new');
      assert.equal(identity.getViewerSessionBinding('runtime-new'), 'session-new');
      assert.equal(ctx.currentRuntimeAgentId, 'runtime-new');
      assert.equal(ctx.window.ClawThreads.activeConversation.threadId, 'wt-viewed');
      assert.equal(ctx.window.ClawThreads.activeConversation.sessionId, 'session-new');
      assert.equal(ctx.window.ClawThreads.activeConversation.runtimeId, 'runtime-new');
      assert.equal(loadAgentsCount, 1);
      // 事实刷新三拍：首拉（建立冻结）+ head-advanced 处理器刷新 + 重绑收尾刷新
      assert.equal(threadsFetchCount, 3);
    });
  });
});

describe('thread-store: handoff-started visibility', () => {
  it('refreshes thread facts and the sidebar immediately, without rebinding the runtime', async () => {
    let eventHandler;
    let threadsFetchCount = 0;
    let renderCalls = 0;
    await withEngineCase({ fixtures: {
      currentLanguage: 'zh',
      focusedAgentId: 'coder',
      currentRuntimeAgentId: 'runtime-old',
      allAgents: [],
      getCurrentHostAgentRecord: () => ({ id: 'coder' }),
      renderAgentList() { renderCalls += 1; },
    },
      // 本用例只验证「事件到达即刷新 + 立即重渲」，不喂新事实：服务端不可达
      //（threads 内容不变，刷新不产生额外渲染）。
      fetch: async (url) => {
        if (String(url).startsWith('/protoclaw/threads')) threadsFetchCount += 1;
        return { ok: false, status: 0, json: async () => ({}) };
      },
    }, async ({ c, ctx, engine }) => {
      await seedViewerBinding(c, 'runtime-old', 'session-old');
      ctx.window.ClawFW = { SseClient: { subscribeThreadEvents: (id, handler) => {
        assert.equal(id, '*');
        eventHandler = handler;
        return () => {};
      } } };
      installThread(ctx, {
        threadId: 'wt-viewed', agentId: 'coder',
        headSessionId: 'session-old', sessionIds: ['session-old'], lifeState: 'executing',
      });
      engine._syncActiveThreadSubscription();

      await eventHandler({
        type: 'thread.handoff-started', threadId: 'wt-viewed',
        payload: { agentId: 'coder', fromSessionId: 'session-old', reason: 'trim' },
      });

      assert.equal(threadsFetchCount, 1);
      assert.equal(renderCalls, 1);
      // 只刷新状态，不触发换头重绑：runtime 绑定与活动会话保持原样
      assert.equal(ctx.currentRuntimeAgentId, 'runtime-old');
      assert.equal(ctx.window.ClawThreads.activeConversation.threadId, 'wt-viewed');
      assert.equal(ctx.window.ClawThreads.activeConversation.sessionId, 'session-old');
    });
  });
});

describe('thread-store: stable thread conversation input', () => {
  it('opens a thread by its stable identity and current head runtime', async () => {
    const thread = {
      threadId: 'wt-open', agentId: 'coder', headSessionId: 'session-new',
      sessionIds: ['session-old', 'session-new'],
    };
    await withThreadDomainCase({
      threads: [thread],
      fixtures: {
        focusedAgentId: 'coder',
        currentRuntimeAgentId: 'runtime-old',
        allAgents: [
          { id: 'coder', source: 'prebuilt', kind: 'workspace' },
          {
            id: 'runtime-new', source: 'child', parent_id: 'coder',
            active_workspace_session_id: 'session-new', runtime_session_id: 'runtime-new',
          },
        ],
        getCurrentHostAgentRecord: () => ({ id: 'coder', source: 'prebuilt', kind: 'workspace' }),
        renderAgentList: () => {},
        renderCurrentMainView: () => {},
        updateQueueIndicator: () => {},
      },
    }, async ({ c, domain }) => {
      const identity = await seedViewerBinding(c, 'runtime-old', 'session-old');
      const result = await domain.openConversationTarget({ agentId: 'coder', threadId: 'wt-open' });
      assert.equal(result.ok, true);
      assert.equal(identity.getViewerSessionBinding('runtime-new'), 'session-new');
      assert.equal(c.read('window.ClawThreads.activeConversation.threadId'), 'wt-open');
      assert.equal(c.read('window.ClawThreads.activeConversation.sessionId'), 'session-new');
    });
  });

  it('posts to the thread input endpoint without resolving a session or runtime target', async () => {
    const requests = [];
    await withThreadDomainCase({
      fixtures: {
        updateThreadHeaderIndicator: () => {},
      },
      fetch: async (url, init) => {
        requests.push({ url, init });
        return { ok: true, json: async () => ({ ok: true, threadId: 'wt-input', delivery: 'delivered' }) };
      },
    }, async ({ c, domain }) => {
      // 引擎的刷新入口经桥键取用（交互域按 window.refreshThreads 晚绑定调用）：
      // 用例体里替换即生效，网络面只保留本用例关心的 input 端点。
      c.window.refreshThreads = async () => null;
      const result = await domain.submitThreadInput('wt-input', {
        text: 'continue', images: [{ id: 'img-1' }], source: 'chat-composer',
        capabilityActivations: ['skill-x'], metadata: { note: 1 },
      });
      assert.equal(result.delivery, 'delivered');
      assert.equal(requests[0].url, '/protoclaw/threads/wt-input/input');
      const body = JSON.parse(requests[0].init.body);
      assert.equal(body.text, 'continue');
      assert.deepEqual(body.images, [{ id: 'img-1' }]);
      assert.deepEqual(body.capabilityActivations, ['skill-x']);
      assert.deepEqual(body.metadata, { note: 1 });
    });
  });
});

describe('T006 thread-store: Session→Thread 目标登记与只读事实', () => {
  const fixtures = () => ({
    renderAgentList: () => {},
    renderCurrentMainView: () => {},
    updateQueueIndicator: () => {},
    updateThreadHeaderIndicator: () => {},
  });

  it('历史成员 activate（browseOnly:true + target 为 thread）置位只读事实', async () => {
    await withThreadDomainCase({ fixtures: fixtures() }, async ({ c, domain }) => {
      domain.registerSessionActivateTarget({
        browseOnly: true,
        target: { type: 'thread', threadId: 'wt-9', headSessionId: 's-2' },
      });
      assert.equal(c.read('window.ClawThreads.browseOnly'), true);
      assert.equal(c.read('window.ClawThreads.browseOnlyThreadId'), 'wt-9');
    });
  });

  it('打开/创建 head（browseOnly 缺失）清除历史残留只读事实', async () => {
    await withThreadDomainCase({ fixtures: fixtures() }, async ({ c, domain }) => {
      c.sandbox.run("window.ClawThreads.browseOnly = true; window.ClawThreads.browseOnlyThreadId = 'wt-9';");
      domain.registerSessionActivateTarget({ target: { type: 'thread', threadId: 'wt-9', headSessionId: 's-3' } });
      assert.equal(c.read('window.ClawThreads.browseOnly'), false);
      assert.equal(c.read('window.ClawThreads.browseOnlyThreadId'), '');
    });
  });

  it('Session 入口返回 Thread 时刷新 Thread（而非只刷 Session）', async () => {
    let refreshes = 0;
    await withThreadDomainCase({
      fixtures: fixtures(),
    }, async ({ c, domain }) => {
      // 引擎已迁 ESM：classic 相的 fixtures.refreshThreads 会被模块桥键覆盖，
      // 夹具必须在引擎装载之后经桥键落定（交互域按 window.refreshThreads 调用）。
      c.window.refreshThreads = async () => { refreshes += 1; return null; };
      domain.registerSessionActivateTarget({ target: { type: 'thread', threadId: 'wt-1', headSessionId: 's-2' } });
      // refreshThreads 是异步触发；同步返回后此处已调用
      assert.equal(refreshes, 1);
    });
  });

  it('非 Thread 的普通 Session activate 不触发线程刷新', async () => {
    let refreshes = 0;
    await withThreadDomainCase({
      fixtures: fixtures(),
    }, async ({ c, domain }) => {
      c.window.refreshThreads = async () => { refreshes += 1; return null; };
      domain.registerSessionActivateTarget({ session: { id: 's-1' } });
      assert.equal(refreshes, 0);
    });
  });
});

// T014b：wasHead 冻结事实（ADR-0024 接续零感知）。app-main 的 404 等待重绑
// 豁免以 activeConversation.wasHead 为前提——冻结时视图挂在 head 上，此后
// head 被接管才进入豁免窗口；历史成员浏览冻结时即非 head，不占用接续语义。
describe('T014b thread-store: wasHead 冻结事实写入', () => {
  function baseOverrides(overrides = {}) {
    return {
      currentLanguage: 'zh',
      focusedAgentId: 'coder',
      currentRuntimeAgentId: 'runtime-old',
      getCurrentHostAgentRecord: () => ({ id: 'coder' }),
      ...overrides,
    };
  }

  it('视图冻结在 head 上（runtime 绑定 = headSessionId）→ wasHead=true', async () => {
    await withEngineCase({ fixtures: baseOverrides() }, async ({ c, ctx, engine }) => {
      await seedViewerBinding(c, 'runtime-old', 'session-old');
      installThread(ctx, {
        threadId: 'wt-was', agentId: 'coder',
        headSessionId: 'session-old', sessionIds: ['session-old'],
      });
      engine._syncActiveThreadSubscription();
      const conversation = ctx.window.ClawThreads.activeConversation;
      assert.equal(conversation.threadId, 'wt-was');
      assert.equal(conversation.sessionId, 'session-old');
      assert.equal(conversation.wasHead, true);
    });
  });

  it('浏览历史成员（runtime 绑定 ≠ headSessionId）→ wasHead=false', async () => {
    await withEngineCase({ fixtures: baseOverrides() }, async ({ c, ctx, engine }) => {
      await seedViewerBinding(c, 'runtime-old', 'session-old');
      installThread(ctx, {
        threadId: 'wt-was', agentId: 'coder',
        headSessionId: 'session-new', sessionIds: ['session-old', 'session-new'],
      });
      engine._syncActiveThreadSubscription();
      const conversation = ctx.window.ClawThreads.activeConversation;
      assert.equal(conversation.sessionId, 'session-old');
      assert.equal(conversation.wasHead, false, '历史成员冻结不得占用等待重绑豁免资格');
    });
  });

  it('handoff 窗口本地挂线程等待视图（openConversationTarget）→ wasHead=true', async () => {
    // 接续窗口的两个投影成对出现（服务端仅在 status='rotating' 时补读
    // handoffStartedAt）；只给 startedAt 的夹具有不出的状态。
    const thread = {
      threadId: 'wt-was', agentId: 'coder', headSessionId: 'session-old',
      sessionIds: ['session-old'], status: 'rotating', handoffStartedAt: Date.now(),
    };
    await withThreadDomainCase({
      threads: [thread],
      fixtures: {
        currentRuntimeAgentId: '',
        focusedAgentId: 'coder',
        allAgents: [{ id: 'coder', source: 'prebuilt', kind: 'workspace' }],
        getCurrentHostAgentRecord: () => ({ id: 'coder', source: 'prebuilt', kind: 'workspace' }),
        renderAgentList: () => {},
        renderCurrentMainView: () => {},
        updateQueueIndicator: () => {},
        updateThreadHeaderIndicator: () => {},
      },
      fetch: async () => ({ ok: true, json: async () => ({ ok: true, messages: [] }) }),
    }, async ({ c, domain }) => {
      const result = await domain.openConversationTarget({ agentId: 'coder', threadId: 'wt-was' });
      assert.equal(result.ok, true);
      assert.equal(c.read('window.ClawThreads.activeConversation.wasHead'), true,
        '接续中点击条目的本地等待视图必须保住等待重绑资格');
    });
  });

  it('head-advanced 重绑落定后 → wasHead=true（新 head 冻结）', async () => {
    let eventHandler;
    await withEngineCase({ fixtures: {
      currentLanguage: 'zh',
      focusedAgentId: 'coder',
      currentRuntimeAgentId: 'runtime-old',
      allAgents: [{
        id: 'runtime-new', source: 'child', parent_id: 'coder',
        active_workspace_session_id: 'session-new', runtime_session_id: 'runtime-new',
      }],
      getCurrentHostAgentRecord: () => ({ id: 'coder' }),
      loadAgents: async () => {},
      loadAgentData: async () => {},
      saveCurrentRuntimeToCache() {},
      _storeVisibleSessionInputDraft() {},
      resetRuntimeStatusForSwitch() {},
      setPendingChatScrollRestore() {},
      renderAgentList() {},
      _lastRenderedChatSig: '',
      readOnlyMode: false,
    },
      fetch: async () => ({ ok: false, status: 0, json: async () => ({}) }),
    }, async ({ c, ctx, engine }) => {
      await seedViewerBinding(c, 'runtime-old', 'session-old');
      ctx.window.ClawFW = { SseClient: { subscribeThreadEvents: (id, handler) => {
        eventHandler = handler;
        return () => {};
      } } };
      installThread(ctx, {
        threadId: 'wt-was', agentId: 'coder',
        headSessionId: 'session-new', sessionIds: ['session-old', 'session-new'],
      });
      engine._syncActiveThreadSubscription();
      await eventHandler({
        type: 'thread.head-advanced', threadId: 'wt-was',
        payload: { fromSessionId: 'session-old', toSessionId: 'session-new', agentId: 'coder' },
      });
      const conversation = ctx.window.ClawThreads.activeConversation;
      assert.equal(conversation.sessionId, 'session-new');
      assert.equal(conversation.runtimeId, 'runtime-new');
      assert.equal(conversation.wasHead, true, '重绑目标是新 head，冻结资格延续');
    });
  });
});

// T014c：事实对账重绑（ADR-0024 接续零感知）。SSE head-advanced 只是加速
// 信号；事件丢失（断连 / 后台标签）时 threads 轮询拉到 head 已推进的快照即
// 是重绑的正当时刻——refreshThreads 收尾对账驱动 _rebindConversationToThreadHead
// 唯一实现原地换绑。不依赖任何事件或独立触发器。
describe('T014c thread-store: 事实对账重绑（SSE 丢帧自愈）', () => {
  it('不发事件，threads 轮询推进快照后原地重绑到新 head', async () => {
    let loadedRuntime = '';
    let threadsFetchCount = 0;
    const allAgents = [{
      id: 'runtime-new', source: 'child', parent_id: 'coder',
      active_workspace_session_id: 'session-new', runtime_session_id: 'runtime-new',
    }];
    await withEngineCase({ fixtures: {
      currentLanguage: 'zh',
      focusedAgentId: 'coder',
      currentRuntimeAgentId: 'runtime-old',
      allAgents,
      getCurrentHostAgentRecord: () => ({ id: 'coder' }),
      loadAgents: async () => {},
      loadAgentData: async (runtimeId) => { loadedRuntime = runtimeId; },
      saveCurrentRuntimeToCache() {},
      _storeVisibleSessionInputDraft() {},
      resetRuntimeStatusForSwitch() {},
      setPendingChatScrollRestore() {},
      renderAgentList: () => {},
      _lastRenderedChatSig: '',
      readOnlyMode: false,
    },
      fetch: async () => {
        threadsFetchCount += 1;
        // 第一次拉取：旧 head 稳态（建立视图冻结）；此后拉取：head 已推进
        // （模拟服务端 advanceHead 落定后、SSE 事件丢失的轮询发现）。
        const advanced = threadsFetchCount > 1;
        const thread = {
          threadId: 'wt-recon', agentId: 'coder',
          headSessionId: advanced ? 'session-new' : 'session-old',
          sessionIds: ['session-old', 'session-new'],
          status: 'open',
        };
        // 不带 contentHash：条件刷新（?sinceContentHash=）由专门的用例覆盖，这里走全量拉取。
        return { ok: true, json: async () => ({ threads: [thread] }) };
      },
    }, async ({ c, ctx, engine }) => {
      const identity = await seedViewerBinding(c, 'runtime-old', 'session-old');
      // 第一拍：稳态快照，视图冻结在旧 head（wasHead=true）
      await ctx.window.refreshThreads(true);
      engine._syncActiveThreadSubscription();
      let conversation = ctx.window.ClawThreads.activeConversation;
      assert.equal(conversation.sessionId, 'session-old');
      assert.equal(conversation.wasHead, true);

      // 第二拍：无任何 SSE 事件，轮询推进快照 → 收尾对账原地重绑
      await ctx.window.refreshThreads(true);
      await new Promise((resolve) => setImmediate(resolve));
      conversation = ctx.window.ClawThreads.activeConversation;
      assert.equal(conversation.sessionId, 'session-new', '对账后视图身份应换到新 head');
      assert.equal(conversation.runtimeId, 'runtime-new');
      assert.equal(conversation.wasHead, true);
      assert.equal(ctx.currentRuntimeAgentId, 'runtime-new');
      assert.equal(loadedRuntime, 'runtime-new', '重绑后应加载新 runtime 数据');
      assert.equal(identity.getViewerSessionBinding('runtime-new'), 'session-new');
    });
  });

  it('wasHead=false（历史成员浏览）时快照推进不触发重绑（不静默跳转）', async () => {
    let threadsFetchCount = 0;
    let loadedRuntime = '';
    await withEngineCase({ fixtures: {
      currentLanguage: 'zh',
      focusedAgentId: 'coder',
      currentRuntimeAgentId: 'runtime-old',
      getCurrentHostAgentRecord: () => ({ id: 'coder' }),
      loadAgents: async () => {},
      loadAgentData: async (runtimeId) => { loadedRuntime = runtimeId; },
      resetRuntimeStatusForSwitch() {},
      setPendingChatScrollRestore() {},
      renderAgentList: () => {},
    },
      fetch: async () => {
        threadsFetchCount += 1;
        const thread = {
          threadId: 'wt-hist', agentId: 'coder',
          headSessionId: threadsFetchCount > 1 ? 'session-new' : 'session-old',
          sessionIds: ['session-history', 'session-old', 'session-new'],
          status: 'open',
        };
        // 不带 contentHash：条件刷新（?sinceContentHash=）由专门的用例覆盖，这里走全量拉取。
        return { ok: true, json: async () => ({ threads: [thread] }) };
      },
    }, async ({ c, ctx, engine }) => {
      // 视图绑在历史成员上（生产里是 openConversationTarget 的绑定）
      await seedViewerBinding(c, 'runtime-old', 'session-history');
      // 注意：_syncActiveThreadSubscription 的既有行为会把挂在本线程的记账
      // sessionId 对齐 head（不动视图）。判断「是否被拉走」看 runtime 态与
      // 数据加载，不看记账字段漂移。
      await ctx.window.refreshThreads(true);
      engine._syncActiveThreadSubscription();
      assert.equal(ctx.window.ClawThreads.activeConversation.threadId, 'wt-hist');

      await ctx.window.refreshThreads(true);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(ctx.currentRuntimeAgentId, 'runtime-old', '历史成员浏览不得被对账拉走');
      assert.equal(loadedRuntime, '', '不得加载新 runtime 数据（无静默跳转）');
      assert.equal(threadsFetchCount, 2);
    });
  });
});
