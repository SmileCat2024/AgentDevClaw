/**
 * 轮询与会话视图的一致性（P2 真实 ESM 图路线）。
 *
 * 装载路线（相对旧版的唯一变化）：旧版把 app-main.js 的轮询片段、app-ui.js 的
 * 运行时会话投影片段、agent-data-loader.js 的 host 片段、以及已迁 ESM 的
 * overview-data.js 源码切片塞进原始 vm；现在 classic 相按真实加载序跑**整份**
 * classic 源，ESM 侧（overview-data / 轮询域 factory / 会话数据与状态 loader）
 * 经 `withP2EsmCase` + `c.load` 真实 import。宿主工厂仍是被测的真实生产 seam
 * （app-main / agent-data-loader / app-ui 里的 createXxxHost），每个用例一张
 * 独立模块图（probe seq 基线、token 代次不跨用例）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { Renderer } from 'marked';
import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { prepareClassicSandbox, prepareEsmModules, prepareSidebarDomain, SESSION_VIEW_DOMAIN } from './p2-classic-hosts.js';

const OVERVIEW_DATA = 'public/src/modules/overview-data.js';
const POLL_COORDINATOR = 'public/src/modules/poll-coordinator.js';
const MESSAGE_PROBE = 'public/src/modules/message-probe.js';
const MESSAGE_METRICS = 'public/src/modules/message-metrics.js';
const COMMITTED_VIEW_RENDERER = 'public/src/modules/committed-view-renderer.js';
const METADATA_COMMIT = 'public/src/modules/metadata-commit.js';
const RUNTIME_POLL = 'public/src/modules/runtime-poll.js';
const POLL_CYCLE = 'public/src/modules/poll-cycle.js';
const POLL_MAINTENANCE = 'public/src/modules/poll-maintenance.js';
const RUNTIME_NOT_FOUND = 'public/src/modules/runtime-not-found.js';
const RUNTIME_STATUS_LOADER = 'public/src/modules/runtime-status-loader.js';
const SESSION_DATA_LOADER_HOST = 'public/src/modules/session-data-loader-host.js';
const AGENT_DATA_LOADER = 'public/src/modules/agent-data-loader.js';

/** vendor 桩：markdown-utils 在求值期需要 Renderer 与 setOptions。 */
const markedStub = { Renderer, setOptions() {} };

const indexSource = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

function createDeferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

/** 浏览器宿主能力桩：app-ui 的顶层投影/面板注册需要，业务语义不依赖它们。 */
const DOM_HOST_STUBS = {
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
  MutationObserver: class { observe() {} disconnect() {} },
  requestIdleCallback: () => 0,
  CustomEvent: class {},
};

/** 只装载会话视图所有权（classic 真源）。 */
function loadSessionViewClassic(sandbox) {
  // 真实先行脚本序（test/p2-classic-hosts.js）：宿主工厂都是生产实现。
  prepareClassicSandbox(sandbox);
}

test('session view token rejects an older visit to the same runtime', async () => {
  await withP2EsmCase({ classic: loadSessionViewClassic }, async (c) => {
    c.read("currentRuntimeAgentId = 'A'; _switchEpoch = 7;");
    const oldVisit = c.read("captureSessionViewToken('A')");
    c.window.__oldVisit = oldVisit;

    c.read('_switchEpoch = 8;');
    c.window.__applied = false;
    c.window.__effect = () => { c.window.__applied = true; };
    assert.equal(c.read('commitSessionViewState(__oldVisit, __effect)'), false);
    assert.equal(c.window.__applied, false);

    c.read('__oldVisit = captureSessionViewToken("A")');
    assert.equal(c.read('commitSessionViewState(__oldVisit, __effect)'), true);
    assert.equal(c.window.__applied, true);
  });
});

test('session view read snapshots are frozen and identity-bound', async () => {
  await withP2EsmCase({ classic: loadSessionViewClassic }, async (c) => {
    c.read(`
      currentRuntimeAgentId = 'A';
      _switchEpoch = 7;
      currentMessages = [{ role: 'assistant', content: 'old' }];
      currentInputRequests = [{ requestId: 'old-request' }];
      toolRenderConfigs = {};
      TOOL_NAMES = {};
      currentHookInspector = {};
      currentOverviewSnapshot = {};
      currentTodoPlan = {};
      currentRuntimeConnected = true;
      window.lastInputRequests = [];
    `);

    const previous = c.read('readCurrentSessionViewState()');
    c.read(`applySessionViewPatch({
      messages: [{ role: 'assistant', content: 'new' }],
      inputRequests: [{ requestId: 'new-request' }],
    })`);
    const current = c.read('readCurrentSessionViewState()');

    assert.equal(Object.isFrozen(previous), true);
    assert.equal(previous.runtimeId, 'A');
    assert.equal(previous.switchEpoch, 7);
    assert.equal(previous.messages[0].content, 'old');
    assert.equal(current.messages[0].content, 'new');
    assert.equal(current.inputRequests[0].requestId, 'new-request');
    assert.equal(c.window.lastInputRequests[0].requestId, 'new-request');
  });
});

test('session view ownership module is an ESM entry, evaluated before first paint', () => {
  // 迁移前的断言是「classic 标签排在 app-main 之前」。P4 T2 起它不再占 classic 标签
  // （classic 相解析 export 会 SyntaxError，gate 也会拦），时序保证改钉装载图：
  // kernel-entry 的首条 import 即 session-view-commit-host（具名 import 会话视图边界），
  // 而首屏 boot.js 是 index.html 的最后一条 module 标签——桥键必先于首屏渲染就位。
  assert.equal(
    /<script\b[^>]*\bsrc=["']\.\/src\/modules\/session-view-state\.js["']/.test(indexSource),
    false,
    'session-view-state 不得回到 classic 标签',
  );
  const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
  const kernelEntry = read('public/src/modules/kernel-entry.js');
  const staticImports = [...kernelEntry.matchAll(/^import\s+'([^']+)';/gm)].map((match) => match[1]);
  assert.equal(staticImports[0], './session-view-commit-host.js', '会话视图边界是 ESM 图的首个求值点');
  assert.match(
    read('public/src/modules/session-view-commit-host.js'),
    /import \{ createSessionViewCommitHost \} from '\.\/session-view-state\.js';/,
    '提交策略宿主改具名 import（不再经 window 晚抓 classic 实现）',
  );
  assert.match(read('public/src/modules/p4-entry.js'), /import '\.\/session-view-state\.js';/);
});

test('runtime status cannot commit after the same runtime is re-entered', async () => {
  const notificationBody = createDeferred();
  const effects = [];
  const runtimeRecord = { connected: true };

  await withP2EsmCase({
    globals: {
      normalizeAgentIdentity: (value) => String(value || '').trim(),
      getCurrentRuntimeRecord: () => ({
        parent_id: 'programming-helper',
        active_workspace_session_id: 'session-a',
      }),
      getCurrentAgentRecord: () => null,
      getLogicalAgentId: (record) => record?.parent_id || record?.id || null,
      getActiveSessionId: (record) => record?.active_workspace_session_id || null,
      getActiveWorkspaceSessionId: () => 'session-a',
      getRuntimeRecord: () => runtimeRecord,
      applyContextGuardStatus: () => effects.push('guard'),
      updateNotificationStatus: () => effects.push('notification'),
      fetch: async (url) => ({
        ok: true,
        json: String(url).endsWith('/notification')
          ? async () => notificationBody.promise
          : async () => String(url).endsWith('/connection')
            ? { connected: false }
            : { blocked: true },
      }),
    },
    classic: (sandbox) => {
      // 真实先行脚本序：宿主工厂都是生产实现。用例夹具的 runtime 记录覆盖必须写在
      // 真实声明之后（app-core 自带真实 getRuntimeRecord，读 allAgents）。
      loadLoaderClassic(sandbox);
      sandbox.getRuntimeRecord = () => runtimeRecord;
    },
  }, async (c) => {
    c.read(`
      currentRuntimeAgentId = 'A';
      focusedAgentId = 'programming-helper';
      currentRuntimeConnected = true;
      currentMessages = [];
      currentInputRequests = [];
      toolRenderConfigs = {};
      TOOL_NAMES = {};
      currentHookInspector = {};
      currentOverviewSnapshot = {};
      currentTodoPlan = {};
      window.lastInputRequests = [];
      _switchEpoch = 11;
    `);
    // 装配面 = 生产装配点：agent-data-loader 的稳定具名工厂 + runtime-status-loader
    // 纯工厂（该 host 工厂未被子 loader 拆分，组合即生产 wiring 的同款）。
    const { createRuntimeStatusLoaderHost } = await c.load(AGENT_DATA_LOADER);
    const { createRuntimeStatusLoader } = await c.load(RUNTIME_STATUS_LOADER);
    const refreshCurrentRuntimeStatus = createRuntimeStatusLoader(createRuntimeStatusLoaderHost()).refreshCurrentRuntimeStatus;

    const oldVisit = c.read("captureSessionViewToken('A')");
    const refresh = refreshCurrentRuntimeStatus('A', oldVisit);
    await flush();
    c.read('_switchEpoch = 12;');
    notificationBody.resolve({ calling: false });

    assert.equal(await refresh, null);
    assert.equal(c.window.currentRuntimeConnected, true);
    assert.equal(runtimeRecord.connected, true);
    assert.deepEqual(effects, []);
  });
});

/** 当前用例的 classic 沙箱：`globals` 里的宿主 seam 需要它做晚绑定。 */
let caseSandbox = null;

/**
 * 用例包装：p2 case 结束后断开模块级沙箱引用。
 * `caseSandbox` 只服务宿主桩的晚绑定（globals 在沙箱创建前就绪），不承担状态，
 * 但仍必须在每个用例结束时清空，避免跨用例残留引用。
 */
async function withCaseSandbox(options, fn) {
  try {
    return await withP2EsmCase(options, fn);
  } finally {
    caseSandbox = null;
  }
}

/** 一个用例 = 一张独立模块图 + 真实 classic 轮询宿主。 */
async function withPollHarness({ blockStatus = true } = {}, fn) {
  const events = [];
  const scheduledPollDelays = [];
  const statusBarrier = createDeferred();
  let fetchCount = 0;
  let statusCallCount = 0;

  const payloads = {
    A: {
      messages: { messages: [{ role: 'assistant', content: 'A' }] },
      overview: { modelName: 'model-a', usageStats: { lastRequestUsage: { inputTokens: 111 } } },
      input: [],
    },
    B: {
      messages: { messages: [{ role: 'assistant', content: 'B' }] },
      overview: { modelName: 'model-b', usageStats: { lastRequestUsage: { inputTokens: 999 } } },
      input: [{
        requestId: 'choice-b',
        mode: 'choices',
        questions: [{ id: 'q', options: [] }],
      }],
    },
  };

  const fetchStub = async (url) => {
    fetchCount += 1;
    const runtime = String(url).includes('/A/') ? 'A' : 'B';
    const payload = payloads[runtime];
    let body = {};
    if (String(url).endsWith('/messages')) body = payload.messages;
    else if (String(url).endsWith('/input-requests')) body = payload.input;
    else if (String(url).endsWith('/overview')) body = payload.overview;
    return {
      ok: !String(url).endsWith('/todo'),
      status: String(url).endsWith('/todo') ? 500 : 200,
      json: async () => structuredClone(body),
    };
  };

  await withCaseSandbox({
    globals: {
      console,
      fetch: fetchStub,
      attachMessagesTimestamps: (messages) => messages,
      reloadFeatureTemplateMap: async () => {},
      updateNotificationStatus: () => {},
      loadAgents: async () => {},
      refreshAgentCallStates: async () => {},
      refreshCurrentRuntimeStatus: () => {
        statusCallCount += 1;
        return blockStatus ? statusBarrier.promise : Promise.resolve();
      },
      clearPartialCompactState: () => {},
      resolveWorkspaceFallbackAgentId: () => null,
      selectWorkspaceSurface: () => {},
      getEmptyTodoPlan: () => ({ state: {} }),
      renderCurrentMainView: () => {},
      renderInputRequests: (requests) => {
        caseSandbox.currentInputRequests = requests;
        events.push({
          kind: 'input-render',
          runtime: caseSandbox.currentRuntimeAgentId,
          requests: requests.map((item) => item.requestId),
        });
      },
      clearChatLoadingSession: () => {},
      markAutoTitleCandidate: () => {},
      findFirstChangedMessageIndex: () => -1,
      shouldRenderWorkspaceSurface: () => false,
      appendNewMessages: () => {},
      updateLastMessage: () => {},
      _syncPersistentActionButton: () => {},
      _syncPersistentInputUi: () => {},
      renderFeaturePanel: () => {},
      updateChatContextBar: () => {
        events.push({
          kind: 'usage-render',
          runtime: caseSandbox.currentRuntimeAgentId,
          used: caseSandbox.currentOverviewSnapshot?.usageStats?.lastRequestUsage?.inputTokens || 0,
          requests: caseSandbox.currentInputRequests.map((item) => item.requestId),
        });
      },
      updateInputModelSwitcher: () => events.push({
        kind: 'model-render',
        runtime: caseSandbox.currentRuntimeAgentId,
        model: caseSandbox.currentOverviewSnapshot?.modelName,
      }),
      updateThinkingEffortSwitcher: () => events.push({
        kind: 'thinking-render',
        runtime: caseSandbox.currentRuntimeAgentId,
        effort: caseSandbox.currentOverviewSnapshot?.thinkingEffort,
      }),
      normalizeTodoPlan: (value) => value,
      getTodoPlanSignature: (value) => JSON.stringify(value),
      setCurrentTodoPlan: (value) => {
        caseSandbox.currentTodoPlan = value;
        caseSandbox.currentTodoPlanSignature = JSON.stringify(value);
      },
      updatePlanBadge: () => {},
      isChatSurfaceActive: () => true,
      updateRollbackActionVisibility: () => {},
      isRuntimeCalling: () => false,
      tryAutoTitleGeneration: () => {},
      loadLogs: async () => {},
      saveCurrentRuntimeToCache: (runtime) => events.push({
        kind: 'cache-write',
        runtime,
        overviewUsed: caseSandbox.currentOverviewSnapshot?.usageStats?.lastRequestUsage?.inputTokens || 0,
        requests: caseSandbox.currentInputRequests.map((item) => item.requestId),
      }),
      _trackRecapSessionPresence: () => {},
      recheckAutoTitleCandidate: () => {},
    },
    classic: (sandbox) => {
      caseSandbox = sandbox;
      // 轮询原语不落真实定时器：所有周期都由 __poll() 显式驱动。
      sandbox.setTimeout = (_callback, delay) => {
        scheduledPollDelays.push(delay);
        return scheduledPollDelays.length;
      };
      sandbox.clearTimeout = () => {};
      sandbox.window.setTimeout = sandbox.setTimeout;
      sandbox.window.clearTimeout = sandbox.clearTimeout;
      sandbox.loadSource('public/src/modules/action-dispatcher.js');
      // i18n 已迁 ESM（P4）：t 桥键由 createFrontendSandbox 自动装载，见 test/helpers/install-i18n.js
      sandbox.loadSource('public/src/app-core.js');
      prepareEsmModules(sandbox, SESSION_VIEW_DOMAIN);
      // app-main 的 classic 同步引擎在装载期组合 sidebar-render 的
      // createAgentCallStatesHost（读 runtime-status 的 _agentSuspended）：按生产
      // 先行脚本序装真链，不给它造宿主桩。
      prepareSidebarDomain(sandbox);
      sandbox.run(`
        window.__clawAuthReady = new Promise(() => {});
        applyTheme = () => {};
        applyLanguage = () => {};
      `);
      sandbox.loadSource('public/src/app-main.js');
    },
  }, async (c) => {
    await c.load(OVERVIEW_DATA);
    const coordinatorMod = await c.load(POLL_COORDINATOR);
    const probeMod = await c.load(MESSAGE_PROBE);
    const metricsMod = await c.load(MESSAGE_METRICS);
    const rendererMod = await c.load(COMMITTED_VIEW_RENDERER);
    const metadataMod = await c.load(METADATA_COMMIT);
    const runtimePollMod = await c.load(RUNTIME_POLL);
    const pollCycleMod = await c.load(POLL_CYCLE);
    const pollMaintenanceMod = await c.load(POLL_MAINTENANCE);
    const runtimeNotFoundMod = await c.load(RUNTIME_NOT_FOUND);

    c.window.createCommittedViewRenderer = rendererMod.createCommittedViewRenderer;
    c.window.createMessageMetrics = metricsMod.createMessageMetrics;
    c.window.computeSerializedBytes = metricsMod.computeSerializedBytes;

    Object.assign(c.window, coordinatorMod.createPollCoordinator(c.read('createPollCoordinatorHost()')));
    Object.assign(c.window, probeMod.createMessageProbe(
      c.read('createMessageProbeHost(createCommittedViewRenderer, createMessageMetrics, computeSerializedBytes)'),
    ));
    Object.assign(c.window, metadataMod.createMetadataCommit(c.read('createMetadataCommitHost(createCommittedViewRenderer)')));
    Object.assign(c.window, runtimePollMod.createRuntimePoll(c.read('createRuntimePollHost()')));
    Object.assign(c.window, pollCycleMod.createPollCycle(c.read('createPollCycleHost()')));
    Object.assign(c.window, pollMaintenanceMod.createPollMaintenance(c.read('createPollMaintenanceHost()')));
    Object.assign(c.window, runtimeNotFoundMod.createRuntimeNotFound(c.read('createRuntimeNotFoundHost()')));
    c.window.__poll = c.window.poll;

    c.window.__seedPayloads = payloads;
    c.read(`
      prebuiltSessionSwitchInFlight = false;
      _switchEpoch = 1;
      _lastChoiceAlertCheckAt = Date.now();
      lastFeatureTemplateReloadAt = Date.now();
      FEATURE_TEMPLATE_MAP = { loaded: true };
      currentRuntimeAgentId = 'A';
      focusedAgentId = 'programming-helper';
      currentRuntimeConnected = true;
      currentMessages = __seedPayloads.A.messages.messages;
      currentInputRequests = __seedPayloads.A.input;
      toolRenderConfigs = {};
      TOOL_NAMES = {};
      currentOverviewSnapshot = __seedPayloads.A.overview;
      currentOverviewSignature = JSON.stringify(__seedPayloads.A.overview);
      currentTodoPlan = {};
      currentTodoPlanSignature = '';
      currentHookInspector = {};
      currentHookInspectorSignature = '';
      activeFeaturePanel = null;
      selectedFeatureName = null;
      logPanelScope = 'current';
      lastAgentListRefreshAt = Date.now();
      allAgents = [];
      _partialCompactInFlight = false;
      _partialCompactRuntimeId = null;
      suppressSidebarRerender = false;
      _localQueuedInputPending = false;
      window.lastInputRequests = [];
      window._lastWsSessionRefreshAt = Date.now();
    `);

    return fn({
      sandbox: c.window,
      events,
      payloads,
      releaseStatus: statusBarrier.resolve,
      getFetchCount: () => fetchCount,
      getStatusCallCount: () => statusCallCount,
      getScheduledPollDelays: () => scheduledPollDelays.slice(),
    });
  });
}


test('a poll response that becomes stale after its first guard cannot overwrite the new session', async () => {
  await withPollHarness({}, async (harness) => {
    const oldPoll = harness.sandbox.__poll();
    await flush();

    harness.sandbox.currentRuntimeAgentId = 'B';
    harness.sandbox._switchEpoch += 1;
    harness.sandbox.currentMessages = harness.payloads.B.messages.messages;
    harness.sandbox.currentInputRequests = harness.payloads.B.input;
    harness.sandbox.window.lastInputRequests = harness.payloads.B.input;
    harness.sandbox.currentOverviewSnapshot = harness.payloads.B.overview;
    harness.sandbox.currentOverviewSignature = JSON.stringify(harness.payloads.B.overview);

    harness.releaseStatus();
    await oldPoll;

    assert.equal(
      harness.sandbox.currentOverviewSnapshot.usageStats.lastRequestUsage.inputTokens,
      999,
      'old A overview must not overwrite B usage',
    );
    assert.deepEqual(
      harness.sandbox.currentInputRequests.map((item) => item.requestId),
      ['choice-b'],
      'old A input requests must not hide B choice UI',
    );
    assert.deepEqual(harness.events, [], 'stale A must not render or write B cache');
  });
});

test('poll response for an old Session is rejected when the runtime id stays the same', async () => {
  await withPollHarness({}, async (harness) => {
    harness.sandbox.applySessionViewPatch({ identity: { agentId: 'programming-helper', sessionId: 'session-a' } });
    const oldPoll = harness.sandbox.__poll();
    await flush();

    harness.sandbox.applySessionViewPatch({ identity: { agentId: 'programming-helper', sessionId: 'session-b' } });
    harness.sandbox.currentMessages = [{ role: 'assistant', content: 'Session B' }];
    harness.sandbox.currentInputRequests = [{ requestId: 'choice-b' }];
    harness.sandbox.window.lastInputRequests = harness.sandbox.currentInputRequests;
    harness.sandbox.currentOverviewSnapshot = { modelName: 'model-b' };
    harness.sandbox.currentOverviewSignature = JSON.stringify(harness.sandbox.currentOverviewSnapshot);

    harness.releaseStatus();
    await oldPoll;

    assert.deepEqual(harness.sandbox.currentMessages, [{ role: 'assistant', content: 'Session B' }]);
    assert.deepEqual(harness.sandbox.currentInputRequests.map((item) => item.requestId), ['choice-b']);
    assert.equal(harness.sandbox.currentOverviewSnapshot.modelName, 'model-b');
    assert.deepEqual(harness.events, [], 'stale same-runtime response must not render or write cache');
  });
});

test('concurrent poll calls share one in-flight cycle', async () => {
  await withPollHarness({}, async (harness) => {
    const first = harness.sandbox.__poll();
    const second = harness.sandbox.__poll();
    await flush();

    assert.equal(harness.getStatusCallCount(), 1);
    assert.equal(harness.getFetchCount(), 4);

    harness.releaseStatus();
    await Promise.all([first, second]);
    assert.equal(
      harness.getScheduledPollDelays().at(-1),
      0,
      'an immediate refresh request during an in-flight cycle should run next',
    );
  });
});

test('poll metadata render observes one overview and input generation', async () => {
  await withPollHarness({ blockStatus: false }, async (harness) => {
    harness.sandbox.currentOverviewSnapshot = {
      modelName: 'old',
      usageStats: { lastRequestUsage: { inputTokens: 1 } },
    };
    harness.sandbox.currentOverviewSignature = JSON.stringify(harness.sandbox.currentOverviewSnapshot);
    harness.sandbox.currentInputRequests = [{ requestId: 'old-choice' }];
    harness.sandbox.window.lastInputRequests = harness.sandbox.currentInputRequests;

    await harness.sandbox.__poll();

    const usageRender = harness.events.find((event) => event.kind === 'usage-render');
    assert.deepEqual(usageRender, {
      kind: 'usage-render',
      runtime: 'A',
      used: 111,
      requests: [],
    });
  });
});

test('overview updates refresh the composer in the same committed view', async () => {
  await withPollHarness({ blockStatus: false }, async (harness) => {
    const overview = {
      modelName: 'new-model',
      thinkingEffort: 'high',
      usageStats: { lastRequestUsage: { inputTokens: 42 } },
    };
    assert.equal(harness.sandbox.commitMetadataUpdate(
      harness.sandbox.captureSessionViewToken('A'), { overviewJson: overview },
    ), true);
    assert.deepEqual(harness.events.map(({ kind }) => kind), [
      'usage-render', 'model-render', 'thinking-render',
    ]);
    assert.equal(harness.events[1].model, 'new-model');
    assert.equal(harness.events[2].effort, 'high');

    harness.events.length = 0;
    harness.sandbox.commitMetadataUpdate(
      harness.sandbox.captureSessionViewToken('A'), { overviewJson: overview },
    );
    assert.deepEqual(harness.events, [], 'unchanged overview should not repaint the composer');

    harness.sandbox.currentRuntimeAgentId = 'B';
    harness.sandbox._switchEpoch += 1;
    harness.events.length = 0;
    assert.equal(harness.sandbox.commitMetadataUpdate(
      { runtimeId: 'A', switchEpoch: 1 }, { overviewJson: { modelName: 'stale' } },
    ), false);
    assert.deepEqual(harness.events, [], 'stale overview cannot update the new session');
  });
});

/**
 * 装载器宿主的 classic 装配：app-core（桥键初值 / 身份与宿主工厂）、
 * session-view-state（会话视图提交器 + createSessionViewCommitHost）。
 * agent-data-loader 已迁 ESM，不再走 loadSource —— 由用例在 async 阶段 c.load。
 */
function loadLoaderClassic(sandbox) {
  sandbox.marked = markedStub;
  sandbox.window.marked = markedStub;
  // 真实先行脚本序 + 基座之外的 classic 实现（会话提交策略与 markdown 引导）。
  prepareClassicSandbox(sandbox);
}


/**
 * loadAgentData 用例的 classic 装配：loader 宿主链 + **真实运行时记录投影**。
 * `getCurrentRuntimeRecord` / `getCurrentAgentRecord` 不设桩——装 app-main，让
 * 真实查询按 allAgents 命中下面种子的 host/runtime 记录；todo-plan 提供真实 plan
 * setter（todo 响应 500 时走 emptyTodo 分支，不是错误路径）。
 * overview-data 属 ESM，由用例在 async 相 c.load。
 */
function loadAgentDataClassic(sandbox, caseGlobals = {}) {
  // 真实先行脚本序已含 app-main（boot 由基座挡住）。todo-plan 已迁 ESM（P4 L1）：
  // 由用例在 async 相 c.load，classic 相不再装载它。
  loadLoaderClassic(sandbox);
  // 用例夹具的行为汇点（渲染入口 / 通知出口等）在真源之后重放：真实 app-ui 会定义
  // 同名入口，而本文件只把这些入口当观察面。宿主工厂不在此列（宿主取真实链）。
  for (const [key, value] of Object.entries(caseGlobals)) {
    if (/^create[A-Za-z0-9]+Host$/.test(key)) continue;
    if (typeof value !== 'function' && typeof value !== 'object') continue;
    if (/^(render|update|notify|attach|load|reset|isUiOnly|get|set|apply|consume|_)/.test(key)) sandbox[key] = value;
  }
  // 窄行为观察面：持久输入面的动作按钮同步（生产 owner：persistent-input.js；
  // 本文件不装输入面）。runtime-status 的提交链会调用它，这里只做空实现。
  sandbox._syncPersistentActionButton = () => {};
  // 视口观察器与主视图渲染（生产 owner：chat-viewport / app-ui）：本文件只验证
  // loadAgentData 的请求集合与提交时点，DOM 落地用观察面。
  sandbox.ensureChatViewportObservers = () => {};
  sandbox.notifyInputSurfaceChanged = () => {};
  // 主视图渲染会同步快记输入槽（app-ui 的 syncAppChatInputSlot）：本 fixture 没有该
  // 槽位元素，按生产语义让它走「槽位不存在 → 早退」分支。
  const getById = sandbox.document.getElementById;
  sandbox.document.getElementById = (id) => (id === 'app-chat-input-slot'
    ? null : getById.call(sandbox.document, id));
}

/** 真实投影种子：宿主记录 + 当前 runtime child（app-main 的查询按这两条命中）。 */
function runtimeRecords() {
  return {
    host: {
      id: 'programming-helper', source: 'prebuilt', kind: 'workspace',
      active_workspace_session_id: 'session-a',
    },
    child: {
      id: 'A', source: 'child', parent_id: 'programming-helper',
      active_workspace_session_id: 'session-a', connected: false,
    },
  };
}

const AGENT_DATA_SEED = `
  focusedAgentId = 'programming-helper';
  currentRuntimeAgentId = 'A';
  currentRuntimeConnected = true;
  currentMessages = [];
  currentInputRequests = [];
  currentOverviewSnapshot = {};
  currentTodoPlan = {};
  currentHookInspector = {};
  currentHookInspectorSignature = '';
  toolRenderConfigs = {};
  TOOL_NAMES = {};
  activeFeaturePanel = null;
  currentWorkspaceTab = 'chat';
  _switchEpoch = 1;
  window.lastInputRequests = [];
`;

test('loadAgentData discards response bodies that finish after a newer switch', async () => {
  const toolsBarrier = createDeferred();
  const renders = [];
  const requests = [];
  const consoleRecords = { warn: [], error: [] };

  await withCaseSandbox({
    globals: {
      // 非预期 loader warning/error 一律进断言（见用例末尾）。
      console: {
        ...console,
        warn: (...args) => consoleRecords.warn.push(args),
        error: (...args) => consoleRecords.error.push(args),
      },
      isUiOnlyAgentId: () => false,
      // loadAgentData calls this early (runtime-status 域)；未装载时以宿主桩声明。
      resetRuntimeStatusForSwitch: () => {},
      renderInputRequests: (value) => {
        caseSandbox.currentInputRequests = value;
        renders.push('input');
      },
      updateRollbackActionVisibility: () => {},
      renderCurrentMainView: () => { renders.push('main'); },
      loadLogs: async () => {},
      renderFeaturePanel: () => { renders.push('feature'); },
      // 运行时通知出口（runtime-status 域）未装载。
      updateNotificationStatus: () => {},
      resetRuntimeBackedSurfaceState: () => {},
      fetch: async (url) => {
        const path = String(url);
        requests.push(path);
        let json;
        if (path.endsWith('/messages')) json = async () => ({ messages: [{ role: 'assistant', content: 'A response' }] });
        else if (path.endsWith('/tools')) json = async () => { await toolsBarrier.promise; return []; };
        else if (path.endsWith('/hooks')) json = async () => ({ owner: 'A' });
        else if (path.endsWith('/overview')) json = async () => ({ modelName: 'model-a-response' });
        else if (path.endsWith('/input-requests')) json = async () => [];
        else json = async () => ({});
        return { ok: !path.endsWith('/todo'), json };
      },
    },
    classic: (sandbox) => {
      caseSandbox = sandbox;
      loadAgentDataClassic(sandbox);
      // 窄行为观察面（真源之后覆盖：app-ui 定义了同名渲染入口）：本用例只断言
      // 「正文提交后先重绘主视图」这件事本身，不做主视图 DOM 落地。
      sandbox.renderCurrentMainView = () => { renders.push('main'); };
      // 真实更新器的 DOM 落点：模型名 / 思考档位两个 name 节点稳定可断言
      sandbox.__modelNameEl = { textContent: '', style: {} };
      sandbox.__thinkingNameEl = { textContent: '', style: {} };
      sandbox.document.querySelector = (selector) => {
        if (selector === '.input-model-name') return sandbox.__modelNameEl;
        if (selector === '.input-thinking-name') return sandbox.__thinkingNameEl;
        return null;
      };
    },
  }, async (c) => {
    const records = runtimeRecords();
    c.window.__records = records;
    c.read(`${AGENT_DATA_SEED}
      allAgents = [__records.host, __records.child];
      currentMessages = [{ role: 'assistant', content: 'A' }];
      currentOverviewSnapshot = { modelName: 'model-a' };
      currentWorkspaceArtifactDetail = null;
      currentWorkspaceDocsetDetail = null;
      currentProjectDocsetOpen = false;
      currentProjectRequirementEdit = null;
      currentProjectDocsetPage = 'requirement';
      _lastCallFinishTime = 0;
      _recapPendingTrigger = false;
      _lastTemplateRuntimeId = null;
    `);
    // plan 快照归一 / 成对签名（已迁 ESM，P4 L1）：todo 响应 500 时走 emptyTodo 分支。
    await c.load('public/src/modules/todo-plan.js');
    // 真实接线：overview-data（快照/hook 规范化的唯一实现）+ 生产装配点的 loader。
    await c.load(OVERVIEW_DATA);
    const { loadAgentData } = await c.load(SESSION_DATA_LOADER_HOST);

    const oldLoad = loadAgentData('A');
    await flush();

    c.read(`
      currentRuntimeAgentId = 'B';
      _switchEpoch += 1;
      currentMessages = [{ role: 'assistant', content: 'B' }];
      currentInputRequests = [{ requestId: 'choice-b' }];
      window.lastInputRequests = currentInputRequests;
      currentOverviewSnapshot = { modelName: 'model-b' };
    `);
    // Ready fields may paint A before navigation; only late fields are forbidden
    // from rendering after B becomes current.
    renders.length = 0;

    toolsBarrier.resolve();
    await oldLoad;

    assert.equal(c.window.currentOverviewSnapshot.modelName, 'model-b');
    assert.equal(c.window.currentMessages[0].content, 'B');
    assert.deepEqual(Array.from(c.window.currentInputRequests, (item) => item.requestId), ['choice-b']);
    assert.deepEqual(renders, []);

    // 运行时状态刷新走的是真实链路（不是被桩跳过），并写回真实运行时记录。
    assert.ok(requests.some((path) => path.endsWith('/api/agents/A/notification')),
      'runtime status refresh must request /notification');
    assert.ok(requests.some((path) => path.endsWith('/api/agents/A/connection')),
      'runtime status refresh must request /connection');
    assert.equal(records.child.connected, true, '真实状态刷新把连接态写回运行时记录');
    // 预期路径只有 todo 的 500（走 emptyTodo 业务分支），不得有任何 warning/error。
    assert.deepEqual(consoleRecords.warn, [], 'loadAgentData 不得产生非预期 warning');
    assert.deepEqual(consoleRecords.error, [], 'loadAgentData 不得产生非预期 error');
  });
});

test('loadAgentData refreshes composer metadata after committing the initial overview', async () => {
  const renders = [];
  const requests = [];
  const consoleRecords = { warn: [], error: [] };

  await withCaseSandbox({
    globals: {
      console: {
        ...console,
        warn: (...args) => consoleRecords.warn.push(args),
        error: (...args) => consoleRecords.error.push(args),
      },
      isUiOnlyAgentId: () => false,
      resetRuntimeStatusForSwitch: () => {},
      updateRollbackActionVisibility: () => {},
      renderCurrentMainView: () => renders.push('main'),
      // 模型 / 思考档位更新器已迁 ESM（agent-data-loader 具名 import）：不再注入
      // 同名桩，改用真实实现写到的 DOM 节点观测刷新顺序。
      renderFeaturePanel: () => {},
      updateNotificationStatus: () => {},
      fetch: async (url) => {
        requests.push(String(url));
        return {
          ok: true,
          json: async () => String(url).endsWith('/overview')
            ? { modelName: 'initial-model', thinkingEffort: 'high' }
            : String(url).endsWith('/messages') ? { messages: [] } : [],
        };
      },
    },
    classic: (sandbox) => {
      caseSandbox = sandbox;
      loadAgentDataClassic(sandbox);
      // 窄行为观察面（真源之后覆盖：app-ui 定义了同名渲染入口）：本用例只断言
      // 「正文提交后先重绘主视图」这件事本身，不做主视图 DOM 落地。
      sandbox.renderCurrentMainView = () => { renders.push('main'); };
      // 真实更新器的 DOM 落点：模型名 / 思考档位两个 name 节点稳定可断言
      sandbox.__modelNameEl = { textContent: '', style: {} };
      sandbox.__thinkingNameEl = { textContent: '', style: {} };
      sandbox.document.querySelector = (selector) => {
        if (selector === '.input-model-name') return sandbox.__modelNameEl;
        if (selector === '.input-thinking-name') return sandbox.__thinkingNameEl;
        return null;
      };
    },
  }, async (c) => {
    const records = runtimeRecords();
    c.window.__records = records;
    c.read(`${AGENT_DATA_SEED}
      allAgents = [__records.host, __records.child];
      _lastTemplateRuntimeId = 'A';
      _lastCallFinishTime = 0;
      _runCapsuleStartAt = 0;
      _runCapsuleStartConfirmed = false;
      _recapPendingTrigger = false;
    `);
    await c.load('public/src/modules/todo-plan.js');
    await c.load(OVERVIEW_DATA);
    const { loadAgentData } = await c.load(SESSION_DATA_LOADER_HOST);

    await loadAgentData('A');
    assert.deepEqual(renders, ['main'], '正文提交后先重绘主视图');
    assert.equal(c.read('__modelNameEl.textContent'), 'initial-model', '提交后刷新模型名');
    assert.equal(c.read('__thinkingNameEl.textContent'), 'high', '提交后刷新思考档位');

    // 运行时状态刷新真实执行，并把连接态写回运行时记录（不是被桩跳过）。
    assert.ok(requests.some((path) => path.endsWith('/api/agents/A/notification')),
      'runtime status refresh must request /notification');
    assert.ok(requests.some((path) => path.endsWith('/api/agents/A/connection')),
      'runtime status refresh must request /connection');
    assert.equal(records.child.connected, true, '真实状态刷新把连接态写回运行时记录');
    assert.deepEqual(consoleRecords.warn, [], 'loadAgentData 不得产生非预期 warning');
    assert.deepEqual(consoleRecords.error, [], 'loadAgentData 不得产生非预期 error');
  });
});

test('runtime-aware session projection uses the selected runtime session over stale host active metadata', async () => {
  const host = {
    id: 'programming-helper',
    active_workspace_session_id: 'B',
    workspace_sessions: {
      activeSessionId: 'B',
      sessions: [
        { id: 'A', tokenUsage: { lastRequestUsage: { inputTokens: 111 } } },
        { id: 'B', tokenUsage: { lastRequestUsage: { inputTokens: 999 } } },
      ],
    },
  };
  const runtime = {
    id: 'runtime-a',
    parent_id: 'programming-helper',
    active_workspace_session_id: 'A',
  };

  await withP2EsmCase({
    globals: {
      ...DOM_HOST_STUBS,
      marked: markedStub,
      hljs: { getLanguage: () => null, highlight: () => ({ value: '' }) },
      getCurrentAgentRecord: () => host,
      getCurrentRuntimeRecord: () => runtime,
    },
    classic: (sandbox) => {
      Object.assign(sandbox.window, DOM_HOST_STUBS);
      sandbox.loadSource('public/src/modules/claw-host.js');
      sandbox.loadSource('public/src/modules/action-dispatcher.js');
      // i18n 已迁 ESM（P4）：t 桥键由 createFrontendSandbox 自动装载，见 test/helpers/install-i18n.js
      sandbox.loadSource('public/src/app-core.js');
      prepareEsmModules(sandbox, SESSION_VIEW_DOMAIN);
      sandbox.loadSource('public/src/modules/right-panel-registry.js');
      // app-ui 已迁 ESM（P4 T2 末件）：整图装载需要 index.html 整套 classic 先行
      // 脚本序（app-main 的 runtime-switch / poll 等宿主工厂），本夹具只关心
      // getRuntimeAwareAgentRecord 的合并规则——切取该段真实源码（自包含，只经
      // window 取两条记录），与其它用例的片段路线一致。
      const appUiSource = fs.readFileSync(new URL('../public/src/app-ui.js', import.meta.url), 'utf8');
      sandbox.run(appUiSource
        .slice(
          appUiSource.indexOf('function _mergeWorkspaceSessions'),
          appUiSource.indexOf('function getRuntimeAwareAgentName'),
        )
        .replace(/^export /gm, ''));
    },
  }, async (c) => {
    // plugin-manifest 已迁 ESM（P4 T3）：真实 import（桥键 resolveAgentPlugin 供 app-ui 解析插件）。
    await c.load('public/src/modules/plugin-manifest.js');
    await c.load('public/src/modules/todo-plan.js');
    const record = c.read('getRuntimeAwareAgentRecord()');
    assert.equal(record.active_workspace_session_id, 'A');
    assert.equal(record.workspace_sessions.activeSessionId, 'A');
  });
});
