/**
 * 会话装载时序：新 transcript 首屏不等慢面板（P2 真实 ESM 图路线）。
 *
 * 装载路线：classic 相只跑仍是 classic 的真实生产源（app-core / session-view-state /
 * todo-plan / markdown-bootstrap，另由 runtime-view-cache 的共享 helper 挂真实缓存
 * 实现）；`agent-data-loader`、`session-data-loader`、`overview-data` 等已迁 ESM 的
 * 模块一律 `withP2EsmCase` + `await c.load(...)` 真实 import —— 不再使用
 * frontend-vm 的 `loadSource` 钩子，也不做源码切片。
 *
 * 装配面：`session-data-loader-host.js` 是生产装配点（它 spread agent-data-loader
 * 的稳定具名工厂 `createSessionDataLoaderHost`，并补齐 `refreshStatus` 等直连
 * ESM 成员），测试直接用它导出的 `loadAgentData`——不重建那份组合，也不经
 * frontend-vm 的 `loadSource` 钩子。装配模块将来若调整，这里会在 import 处立刻
 * 报错，而不是静默跑在与生产不一致的接线上。
 * 每个用例一张独立模块图：装载器的 in-flight 记账与缓存不跨用例。
 *
 * 被测编排：`loadAgentData(runtimeId)` → 消息先到先画，辅助面板（detail / hooks /
 * overview / todo / input-requests / tools）后到只做增量提交，不得回滚已经画出的
 * transcript。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Renderer } from 'marked';
import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { prepareClassicSandbox } from './p2-classic-hosts.js';
import { installRuntimeViewCache } from './helpers/runtime-view-cache.js';

const SESSION_DATA_LOADER_HOST = 'public/src/modules/session-data-loader-host.js';
const OVERVIEW_DATA = 'public/src/modules/overview-data.js';

/** vendor 桩：markdown-bootstrap 只在装载期需要 Renderer 与 setOptions。 */
const markedStub = { Renderer, setOptions() {} };

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const HOST = 'programming-helper';
const SELECTED = 'session-selected';
const FRESH = [{ role: 'user', content: 'question' }, { role: 'assistant', content: 'fresh answer' }];
const DETAIL = {
  workspace_sessions: {
    activeSessionId: 'session-other',
    sessions: [
      { id: SELECTED, sessionType: 'main', openDirectory: '/selected', messageCount: 2 },
      { id: 'session-other', sessionType: 'main', openDirectory: '/other', messageCount: 99 },
    ],
  },
};

/**
 * 一个用例 = 一张独立模块图 + 一个真实 classic 沙箱。
 * `fn(harness)` 在 case 体内执行，harness 暴露装载/视图/阻塞面。
 */
async function withLoadHarness(fn) {
  const paints = [];
  const errors = [];
  const requests = [];
  const gates = new Map();
  const failures = new Set();
  let sb = null;

  const fetchStub = async (url) => {
    const endpoint = String(url).includes('/agent_detail?') ? 'detail' : String(url).split('/').at(-1);
    requests.push(endpoint);
    const gate = gates.get(endpoint);
    if (gate?.phase === 'headers') await gate.promise;
    if (failures.has(endpoint)) throw new Error(`failed ${endpoint}`);
    return {
      ok: true,
      json: async () => {
        if (gate?.phase === 'body') await gate.promise;
        if (endpoint === 'messages') return { messages: structuredClone(FRESH) };
        if (endpoint === 'detail') return structuredClone(DETAIL);
        if (endpoint === 'overview') return { modelName: 'loaded-model', thinkingEffort: 'high' };
        if (endpoint === 'hooks') return { features: [{ name: 'loaded-feature' }] };
        if (endpoint === 'tools') return [{ name: 'read', render: { result: '__inline__', inlineResult: 'loaded' } }];
        if (endpoint === 'todo') return { tasks: [{ id: 'loaded-task' }] };
        return [];
      },
    };
  };

  await withP2EsmCase({
    classic: (sandbox) => {
      // 真实先行脚本序（test/p2-classic-hosts.js）：宿主工厂（runtime-switch /
      // poll / workspace-surface / 侧栏 call 状态）都是生产实现。基座不含
      // todo-plan / markdown-bootstrap（装载器编排要的 classic 实现），按 index.html
      // 顺序补真实文件。
      sb = sandbox;
      sandbox.marked = markedStub;
      sandbox.window.marked = markedStub;
      prepareClassicSandbox(sandbox);
      installRuntimeViewCache(sandbox);
      sandbox.loadSource('public/src/modules/todo-plan.js');
      sandbox.loadSource('public/src/modules/markdown-bootstrap.js');
      // 窄行为观察面（必须在真实链之后覆盖：app-main / app-ui 会定义同名入口）：
      // 本 harness 记录每次「主视图渲染」的会话视图快照，并把运行时/宿主记录固定成
      // 用例给定的投影；真实渲染需要整条页面 DOM（chat-viewport → input-render →
      // app-chat-input 槽位），不在装载时序的验收面。
      sandbox.getCurrentAgentRecord = () => sandbox.run('allAgents[0]');
      sandbox.getCurrentHostAgentRecord = () => sandbox.run('allAgents[0]');
      sandbox.getCurrentRuntimeRecord = () => null;
      sandbox.getRuntimeRecord = () => null;
      sandbox.renderCurrentMainView = () => paints.push(sandbox.run('readCurrentSessionViewState()'));
    },
    globals: {
      console: { ...console, error: (...args) => errors.push(args), warn: (...args) => errors.push(args) },
      fetch: fetchStub,
      // 经典持久输入面的动作按钮同步（生产 owner：persistent-input.js；本链不装
      // 输入面渲染）：本 harness 只关心装载时序，观察面为空实现。
      _syncPersistentActionButton() {},
      resetRuntimeStatusForSwitch() {},
      notifyInputSurfaceChanged() {},
      updateRollbackActionVisibility() {},
      renderFeaturePanel() {},
      updateInputModelSwitcher() {},
      updateThinkingEffortSwitcher() {},
      updateChatContextBar() {},
      updateNotificationStatus() {},
      getCurrentAgentRecord: () => sb.run('allAgents[0]'),
      getCurrentHostAgentRecord: () => sb.run('allAgents[0]'),
      // 生产由 app-main 提供（运行时记录投影）；本 harness 只关心装载时序，
      // 运行时状态刷新按"无记录"路径走（guardUrl 为空、不写 record）。
      getCurrentRuntimeRecord: () => null,
      getRuntimeRecord: () => null,
      renderCurrentMainView: () => paints.push(sb.run('readCurrentSessionViewState()')),
    },
  }, async (c) => {
    await c.load(OVERVIEW_DATA);
    // 生产装配点：session-data-loader-host 导出真实 loader（内部用 agent-data-loader
    // 的具名工厂取 adapter 面，并直连 ESM 的 setRuntime / isCurrent / refreshStatus）。
    const { loadAgentData } = await c.load(SESSION_DATA_LOADER_HOST);

    c.read(`focusedAgentId = '${HOST}';
      currentRuntimeAgentId = 'runtime-selected';
      allAgents = [{ id: '${HOST}', source: 'prebuilt', kind: 'workspace' }];
      setViewerSessionBinding(currentRuntimeAgentId, '${SELECTED}');
      applySessionViewPatch({ identity: { agentId: '${HOST}', sessionId: '${SELECTED}' } });
      refreshCurrentRuntimeStatus = async () => {};
      getPhSessionOwnershipParams = () => ({});
      mergeWorkspaceSessionSnapshots = (previous, fresh) => ({ ...previous, ...fresh });
    `);

    const harness = {
      ctx: sb,
      paints, errors, requests, failures,
      block(endpoint, phase = 'headers') {
        const gate = { ...deferred(), phase };
        gates.set(endpoint, gate);
        return gate;
      },
      load: () => loadAgentData('runtime-selected'),
      view: () => sb.run('readCurrentSessionViewState()'),
    };
    return fn(harness);
  });
}

for (const endpoint of ['detail', 'hooks', 'overview', 'todo', 'input-requests', 'tools']) {
  for (const phase of ['headers', 'body']) {
    test(`fresh transcript paints without waiting for ${endpoint} ${phase}`, async () => {
      await withLoadHarness(async (h) => {
        const gate = h.block(endpoint, phase);
        h.ctx.run("applySessionViewPatch({ messages: [{ role: 'assistant', content: 'cached old answer' }] })");
        const loading = h.load();
        try {
          await flush();
          assert.equal(h.paints.at(-1)?.messages.at(-1)?.content, 'fresh answer');
          assert.equal(h.view().identity.sessionId, SELECTED);
        } finally {
          gate.resolve();
          await loading;
        }
        assert.deepEqual(h.errors, []);
        assert.equal(h.view().messages.at(-1).content, 'fresh answer');
        assert.equal(h.view().overview.modelName, 'loaded-model');
      });
    });
  }
}

test('cold host detail enriches the selected session without invalidating its message load', async () => {
  await withLoadHarness(async (h) => {
    const gate = h.block('messages', 'body');
    const token = h.ctx.run('captureSessionViewToken()');
    const loading = h.load();
    try {
      await flush();
      assert.equal(h.view().sessionMeta.sessionId, SELECTED);
      assert.equal(h.view().sessionMeta.openDirectory, '/selected');
      assert.equal(h.ctx.isSessionViewTokenCurrent(token), true);
    } finally {
      gate.resolve();
      await loading;
    }
    assert.equal(h.view().messages.at(-1)?.content, 'fresh answer');
    assert.deepEqual(h.errors, []);
  });
});

test('a detail slice missing the selected session never borrows the host active session', async () => {
  await withLoadHarness(async (h) => {
    const originalFetch = h.ctx.fetch;
    h.ctx.fetch = async (url) => String(url).includes('/agent_detail?')
      ? { ok: true, json: async () => ({ workspace_sessions: {
        activeSessionId: 'session-other', sessions: [DETAIL.workspace_sessions.sessions[1]],
      } }) }
      : originalFetch(url);
    await h.load();
    assert.equal(h.view().identity.sessionId, SELECTED);
    assert.equal(h.view().sessionMeta.sessionId, '');
    assert.equal(h.view().messages.at(-1)?.content, 'fresh answer');
    assert.deepEqual(h.errors, []);
  });
});

test('late auxiliary responses cannot repaint or write into another visit', async () => {
  await withLoadHarness(async (h) => {
    const gate = h.block('hooks', 'body');
    const loading = h.load();
    await flush();
    h.ctx.run(`
      _switchEpoch += 1;
      currentRuntimeAgentId = 'runtime-new';
      applySessionViewPatch({ identity: { agentId: '${HOST}', sessionId: 'session-new' } });
      applySessionViewPatch({ messages: [{ role: 'assistant', content: 'new visit' }] });
    `);
    const paintCount = h.paints.length;
    gate.resolve();
    await loading;
    assert.equal(h.view().messages.at(-1).content, 'new visit');
    assert.equal(h.paints.length, paintCount);
    assert.deepEqual(h.errors, []);
  });
});

test('a live message update wins over an older initial full response', async () => {
  await withLoadHarness(async (h) => {
    const gate = h.block('messages', 'body');
    const loading = h.load();
    await flush();
    h.ctx.run(`commitSessionViewPatch(captureSessionViewToken(), {
      messages: [{ role: 'assistant', content: 'newer live answer' }],
    }); renderCurrentMainView();`);
    gate.resolve();
    await loading;
    assert.equal(h.view().messages.at(-1).content, 'newer live answer');
    assert.equal(h.paints.at(-1).messages.at(-1).content, 'newer live answer');
    assert.equal(h.view().overview.modelName, 'loaded-model', 'only stale transcript is discarded');
    assert.deepEqual(h.errors, []);
  });
});

test('an unchanged probe reusing the cached array does not invalidate initial message loading', async () => {
  await withLoadHarness(async (h) => {
    const gate = h.block('messages', 'body');
    const loading = h.load();
    await flush();
    h.ctx.run('commitSessionViewPatch(captureSessionViewToken(), { messages: currentMessages })');
    gate.resolve();
    await loading;
    assert.equal(h.view().messages.at(-1)?.content, 'fresh answer');
    assert.deepEqual(h.errors, []);
  });
});

test('returning to a cached conversation paints fresh messages before slow panels finish', async () => {
  await withLoadHarness(async (h) => {
    h.ctx.run(`
      applySessionViewPatch({
        sessionMeta: { sessionId: '${SELECTED}' },
        messages: [{ role: 'assistant', content: 'cached old answer' }],
      });
      saveCurrentRuntimeToCache('runtime-selected');
      _switchEpoch += 1;
      currentRuntimeAgentId = 'runtime-other';
      applySessionViewPatch({ identity: { agentId: '${HOST}', sessionId: 'session-other' } });
      _switchEpoch += 1;
      currentRuntimeAgentId = 'runtime-selected';
    `);
    assert.equal(h.ctx.run("restoreRuntimeFromCache('runtime-selected')"), true);
    assert.equal(h.view().messages.at(-1).content, 'cached old answer');
    const gate = h.block('hooks', 'body');
    const loading = h.load();
    try {
      await flush();
      assert.equal(h.paints.at(-1)?.messages.at(-1)?.content, 'fresh answer');
      assert.equal(h.view().identity.sessionId, SELECTED);
    } finally {
      gate.resolve();
      await loading;
    }
    assert.deepEqual(h.errors, []);
  });
});

test('late tool configuration repaints current messages without restoring a stale transcript', async () => {
  await withLoadHarness(async (h) => {
    const gate = h.block('tools', 'body');
    const loading = h.load();
    await flush();
    h.ctx.run(`commitSessionViewPatch(captureSessionViewToken(), {
      messages: [{ role: 'assistant', content: 'newer live answer', toolCalls: [{ id: 'call-read', name: 'read' }] }],
    }); renderCurrentMainView();`);
    const previousPaints = h.paints.length;
    gate.resolve();
    await loading;
    assert.equal(h.paints.length, previousPaints + 1);
    assert.equal(h.paints.at(-1).messages.at(-1).content, 'newer live answer');
    assert.equal(h.paints.at(-1).toolRenderConfigs.read.render.inlineResult, 'loaded');
    assert.deepEqual(h.errors, []);
  });
});

test('late detail from an earlier visit cannot overwrite the selected session metadata', async () => {
  await withLoadHarness(async (h) => {
    const gate = h.block('detail', 'body');
    const loading = h.load();
    await flush();
    h.ctx.run(`
      _switchEpoch += 1;
      currentRuntimeAgentId = 'runtime-other';
      applySessionViewPatch({ identity: { agentId: '${HOST}', sessionId: 'session-other' } });
      _switchEpoch += 1;
      currentRuntimeAgentId = 'runtime-selected';
      applySessionViewPatch({ identity: { agentId: '${HOST}', sessionId: '${SELECTED}' } });
      applySessionViewPatch({ sessionMeta: { sessionId: '${SELECTED}', openDirectory: '/newer' } });
    `);
    gate.resolve();
    await loading;
    assert.equal(h.view().sessionMeta.openDirectory, '/newer');
    assert.deepEqual(h.errors, []);
  });
});

test('failed auxiliary requests do not prevent the transcript from painting', async () => {
  await withLoadHarness(async (h) => {
    h.failures.add('hooks');
    await h.load();
    assert.equal(h.paints.at(-1)?.messages.at(-1)?.content, 'fresh answer');
    assert.equal(h.errors.length, 1, 'the failed auxiliary request remains observable');
  });
});
