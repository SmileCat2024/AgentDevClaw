/**
 * P2 第二波批次 4 二段「会话/运行时装载适配面」专属测试。
 *
 * agent-data-loader.js 现在是**纯 ESM 装配 seam**：两个 host 工厂作为具名导出，
 * 由 session-data-loader-host / runtime-status-loader-host 在各自模块顶层直接
 * import 并 spread。因此本文件验证的是「真实 import 图」而不是任何装载顺序约定：
 *   1. 接口面：两个工厂是具名导出，且**不再**出现在 window 上（不造桥、不留 loader 入口）；
 *   2. 两 host 真实求值：直接 c.load 消费方即可构造，无需手工先装 loader 或注入 window 工厂；
 *   3. 原厂商行为：真实 session-data-loader / runtime-status-loader 跑在真实图上，
 *      请求集合、快照提交、失败隔离与清理时点不变；
 *   4. clearRecap 精确语义：只清 recap 状态两键，不走 recap-hint 的
 *      `_clearRecapForNewMessage`（DOM 提示 + 会话记账）。
 *
 * 装载路线：withP2EsmCase（classic 沙箱 + 每 case 一份真实 ESM 图；计时器与全局
 * 描述符由 helper 记账/恢复，本文件另断言窗口全局已复原）。
 *
 * classic 侧装载的是本批真实依赖（app-core 宿主工厂与身份函数、session-view-state
 * 的 token/patch 机制、todo-plan 的计划快照 owner）；loader 会调用但**不属于本批**
 * 的 classic 能力（渲染入口、运行时状态复位、通知、回滚按钮、app-main 身份查询）
 * 用同形桩替代，并把调用记进 sink —— 生产里它们由各自 classic 文件提供。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { prepareClassicSandbox } from './p2-classic-hosts.js';

const LOADER = 'public/src/modules/agent-data-loader.js';
const SESSION_HOST = 'public/src/modules/session-data-loader-host.js';
const STATUS_HOST = 'public/src/modules/runtime-status-loader-host.js';
const W24_ENTRY = 'public/src/modules/p2-w2-4-title-timeline-bootstrap.js';
const RECAP_STATE = 'public/src/modules/p2-w2-3a-recap-state.js';

const jsonResponse = (value, ok = true) => ({
  ok,
  status: ok ? 200 : 404,
  json: async () => value,
});

const hljsStub = {
  highlight(line) {
    return {
      value: String(line).replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch])),
    };
  },
};

/** 与真实页面同形的平台/命名空间注入面（vendor 高亮/解析器、dispatcher、fetch）。 */
function baseGlobals(fetchImpl) {
  return {
    hljs: hljsStub,
    // markdown-bootstrap 装载期构造 Renderer（todo-plan 的 ESM 依赖链经 markdown-utils 取 escapeHtml）。
    marked: { Renderer: class { constructor() {} }, setOptions() {}, parse: () => '' },
    ClawFW: { actions: { handlers: {}, registerMany(map) { Object.assign(this.handlers, map); } } },
    fetch: fetchImpl || (async () => ({ ok: false, status: 0, json: async () => ({}) })),
  };
}

/** loader 会调用、但不属于本批验收面的 classic 能力的记录面（见文件头注）。 */
function makeSink() {
  return {
    renders: [],
    panelRenders: 0,
    resetStatus: 0,
    notifications: [],
    record: { id: 'rt-1', source: 'child' },
  };
}

/**
 * classic 侧装载：本批真实依赖文件（首屏同步机制）。
 * todo-plan 已迁 ESM（P4 L1），由用例在 async 相 c.load，不再从此处装载。
 */
function loadClassicDeps(sandbox) {
  // 真实先行脚本序（test/p2-classic-hosts.js）：宿主工厂（session 提交策略 /
  // runtime-switch / poll / workspace-surface / 侧栏 call 状态）都是生产实现，
  // 首屏 boot 与周期排程由基座关掉；todo-plan 是本文件被测链需要的 classic 实现。
  prepareClassicSandbox(sandbox);
}

function installClassicSeams(sandbox, sink) {
  sandbox.renderCurrentMainView = (view) => { sink.renders.push(view); };
  sandbox.renderFeaturePanel = () => { sink.panelRenders += 1; };
  sandbox.resetRuntimeStatusForSwitch = () => { sink.resetStatus += 1; };
  sandbox.updateNotificationStatus = (payload, runtimeId) => { sink.notifications.push({ payload, runtimeId }); };
  // 回滚按钮刷新已迁 ESM（input-actions 的具名导出）：不再注入同名桩，
  // 改用真实实现扫过的 DOM 面记账（生产中它遍历 .message-row）。
  sandbox.run(`
    window.__rollbackScans = 0;
    container.querySelectorAll = () => { window.__rollbackScans += 1; return []; };
  `);
  sandbox.getCurrentRuntimeRecord = () => sink.record;
  sandbox.getCurrentAgentRecord = () => sink.record;
}

describe('P2-4L 接口面：具名导出且不造 bridge', () => {
  it('两个工厂是具名导出，window 上没有对应键（含已取消的 loader 入口）', async () => {
    const sink = makeSink();
    await withP2EsmCase({
      classic: (sandbox) => { loadClassicDeps(sandbox); installClassicSeams(sandbox, sink); },
      globals: baseGlobals(),
    }, async (c) => {
      const mod = await c.load(LOADER);
      assert.equal(typeof mod.createSessionDataLoaderHost, 'function');
      assert.equal(typeof mod.createRuntimeStatusLoaderHost, 'function');

      for (const key of ['createSessionDataLoaderHost', 'createRuntimeStatusLoaderHost']) {
        assert.equal(Object.getOwnPropertyDescriptor(c.window, key), undefined,
          `${key} 不应再经 KernelState 造桥（消费方直接 import）`);
      }

      const host = mod.createSessionDataLoaderHost();
      for (const key of ['isUiOnly', 'setRuntime', 'apply', 'capture', 'isCurrent',
        'messagesCurrent', 'patch', 'focused', 'activePanel', 'fetch', 'notify',
        'resetSurface', 'render', 'renderPanel', 'clearTemplates', 'loadTemplates',
        'refreshBadges', 'resetRuntimeStatus', 'activateCollapse', 'clearRecap',
        'emptyTodo', 'attachTimestamps', 'recheckTitle', 'clearLoading', 'updateRollback',
        'templateNames', 'warmTemplates', 'updateContext', 'updateModel', 'updateThinking',
        'updatePlan', 'loadDetail', 'loadLogs', 'warn', 'error']) {
        assert.equal(typeof host[key], 'function', `session host 缺少 ${key}`);
      }
      // refreshStatus 由 session host 用自身 import 覆盖，本工厂不再保留冗余成员
      assert.equal(host.refreshStatus, undefined);

      const statusHost = mod.createRuntimeStatusLoaderHost();
      for (const key of ['runtimeId', 'capture', 'isCurrent', 'commit', 'patch', 'fetch',
        'guardAvailable', 'ownerRecord', 'logicalId', 'sessionId', 'runtimeRecord',
        'applyGuard', 'notify', 'warn']) {
        assert.equal(typeof statusHost[key], 'function', `status host 缺少 ${key}`);
      }
    });
  });
});

describe('P2-4L 两 host 真实求值（真实 import 图）', () => {
  it('直接装载两个消费方即可构造（无需先装 loader、无需 window 工厂）', async () => {
    const sink = makeSink();
    await withP2EsmCase({
      classic: (sandbox) => { loadClassicDeps(sandbox); installClassicSeams(sandbox, sink); },
      globals: baseGlobals(),
    }, async (c) => {
      const sessionHost = await c.load(SESSION_HOST);
      const statusHost = await c.load(STATUS_HOST);
      assert.equal(typeof sessionHost.loadAgentData, 'function');
      assert.equal(typeof statusHost.refreshCurrentRuntimeStatus, 'function');
      assert.equal(typeof statusHost.refreshContextGuardStatus, 'function');
      // 消费方确实跑在真实实现上（同一实例图内的 bridge 键仍由各自模块注册）
      assert.equal(typeof c.window.loadAgentData, 'function');
      assert.equal(typeof c.window.refreshCurrentRuntimeStatus, 'function');
    });
  });
});

describe('P2-4L 原厂商行为（真实 ESM 整图）', () => {
  it('loadAgentData 的请求集合、快照提交与清理时点不变', async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      const target = String(url);
      calls.push(target);
      if (target.endsWith('/messages')) {
        return jsonResponse({ messages: [{ role: 'user', content: 'hi' }], timestamps: [1700000000000] });
      }
      if (target.endsWith('/tools')) return jsonResponse([]);
      if (target.endsWith('/hooks')) return jsonResponse({ lifecycleOrder: [], features: [], hooks: [] });
      if (target.endsWith('/overview')) return jsonResponse({ updatedAt: 7, context: { messageCount: 1 } });
      if (target.endsWith('/todo')) return jsonResponse(null, false); // 404 → host.emptyTodo()
      if (target.endsWith('/input-requests')) return jsonResponse([]);
      if (target.includes('/api/templates/feature')) return jsonResponse({});
      if (target.includes('/protoclaw/agent_detail')) return jsonResponse({});
      if (target.endsWith('/notification')) return jsonResponse({ unread: 0 });
      if (target.endsWith('/connection')) return jsonResponse({ connected: true });
      return jsonResponse(null, false);
    };
    const sink = makeSink();
    const descriptorBefore = Object.getOwnPropertyDescriptor(globalThis, 'window');

    await withP2EsmCase({
      classic: (sandbox) => {
        loadClassicDeps(sandbox);
        // todo-plan（P4 L1 已迁 ESM）的 classic 前置：markdown-utils 的 escapeHtml / renderer。
        sandbox.loadSource('public/src/modules/markdown-bootstrap.js');
        installClassicSeams(sandbox, sink);
      },
      globals: baseGlobals(fetchImpl),
    }, async (c) => {
      // plan 快照归一（已迁 ESM，P4 L1）：todo 404 时 host.emptyTodo 经桥键取空计划。
      await c.load('public/src/modules/todo-plan.js');
      sink.record = { id: 'runtime-a', source: 'child', name: 'PH' };
      c.window.allAgents = [sink.record];
      c.window.focusedAgentId = 'runtime-a';

      // 真实 ESM 图：overview 快照桥（W2-4 一段）+ 真实消费方 host（自己 import loader 工厂）
      await c.load(W24_ENTRY);
      const { loadAgentData } = await c.load(SESSION_HOST);
      const recap = await c.load(RECAP_STATE);
      recap.setCurrentRecapText('旧摘要');
      recap.setRecapPendingTrigger(true);

      await loadAgentData('runtime-a');

      // 请求集合：正文 + 辅助面板 + 详情 + 运行时状态 + 切换后的模板映射
      for (const suffix of ['/messages', '/tools', '/hooks', '/overview', '/todo', '/input-requests',
        '/notification', '/connection']) {
        assert.ok(calls.some((url) => url.endsWith(suffix)), `缺少请求 ${suffix}`);
      }
      assert.ok(calls.some((url) => url.includes('/api/templates/feature?agentId=runtime-a')));
      assert.ok(calls.some((url) => url.includes('/protoclaw/agent_detail?agentId=runtime-a')));

      // 提交结果：运行时 identity、时间戳合并、overview、todo 404 → 空计划
      assert.equal(c.window.currentRuntimeAgentId, 'runtime-a');
      assert.equal(c.window.currentMessages.length, 1);
      assert.equal(c.window.currentMessages[0]._ts, 1700000000000);
      assert.equal(c.window.currentOverviewSnapshot.context.messageCount, 1);
      assert.equal(c.window.currentTodoPlan.feature, 'todo');
      assert.deepEqual(Array.from(c.window.currentTodoPlan.tasks), []);
      // 切换清理时点：模板映射经真实 setter 重置、状态复位、recap 两键被清
      assert.deepEqual(Object.assign({}, c.window.FEATURE_TEMPLATE_MAP), {});
      assert.equal(sink.resetStatus, 1);
      assert.equal(recap.currentRecapText, '');
      assert.equal(recap.recapPendingTrigger, false);
      // 渲染/通知副作用仍经 classic 入口（这里由同形桩记录）
      assert.ok(sink.renders.length >= 1, '正文到达后应重绘主视图');
      assert.ok(sink.panelRenders >= 1, '辅助面板到达后应重绘面板');
      assert.ok(sink.notifications.length >= 1, '运行时状态应回传通知');
      assert.ok(c.read('window.__rollbackScans') >= 1, '正文与输入快照提交后应刷新回滚按钮');
      assert.equal(c.timerCount(), 0, '用例结束不应残留计时器');
    });
    assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, 'window'), descriptorBefore);
  });

  it('辅助面板失败不丢弃正文', async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      const target = String(url);
      calls.push(target);
      if (target.endsWith('/messages')) {
        return jsonResponse({ messages: [{ role: 'user', content: 'body' }], timestamps: [1700000001000] });
      }
      if (target.endsWith('/hooks')) throw new Error('hooks boom');
      if (target.endsWith('/notification')) return jsonResponse({});
      if (target.endsWith('/connection')) return jsonResponse({ connected: true });
      return jsonResponse({}, false);
    };
    const sink = makeSink();
    await withP2EsmCase({
      classic: (sandbox) => {
        loadClassicDeps(sandbox);
        // todo-plan（P4 L1 已迁 ESM）的 classic 前置：markdown-utils 的 escapeHtml / renderer。
        sandbox.loadSource('public/src/modules/markdown-bootstrap.js');
        installClassicSeams(sandbox, sink);
      },
      globals: baseGlobals(fetchImpl),
    }, async (c) => {
      // plan 快照归一（已迁 ESM，P4 L1）：辅助面板失败路径同样要维护空计划。
      await c.load('public/src/modules/todo-plan.js');
      sink.record = { id: 'runtime-a', source: 'child' };
      c.window.allAgents = [sink.record];
      await c.load(W24_ENTRY);
      const { loadAgentData } = await c.load(SESSION_HOST);
      await loadAgentData('runtime-a');
      assert.ok(calls.some((url) => url.endsWith('/hooks')), 'hooks 请求确实发出过');
      assert.equal(c.window.currentMessages.length, 1, '正文必须在辅助面板失败时仍然上屏');
      assert.equal(c.window.currentMessages[0]._ts, 1700000001000);
      assert.ok(sink.renders.length >= 1);
    });
  });

  it('refreshCurrentRuntimeStatus 走真实状态请求并提交连接态', async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      const target = String(url);
      calls.push(target);
      if (target.endsWith('/notification')) return jsonResponse({ unread: 1 });
      if (target.endsWith('/connection')) return jsonResponse({ connected: true });
      return jsonResponse(null, false);
    };
    const sink = makeSink();
    await withP2EsmCase({
      classic: (sandbox) => { loadClassicDeps(sandbox); installClassicSeams(sandbox, sink); },
      globals: baseGlobals(fetchImpl),
    }, async (c) => {
      sink.record = { id: 'runtime-a', source: 'child', connected: false };
      c.window.allAgents = [sink.record];
      c.window.currentRuntimeAgentId = 'runtime-a';
      const { refreshCurrentRuntimeStatus } = await c.load(STATUS_HOST);
      const result = await refreshCurrentRuntimeStatus('runtime-a');
      assert.ok(calls.some((url) => url.endsWith('/api/agents/runtime-a/notification')));
      assert.ok(calls.some((url) => url.endsWith('/api/agents/runtime-a/connection')));
      assert.equal(c.read('readCurrentSessionViewState().connected'), true);
      assert.equal(sink.record.connected, true);
      assert.ok(result);
    });
  });
});

describe('P2-4L clearRecap 精确语义', () => {
  it('只清 recap 两键，不触发 recap-hint 的 DOM 清理与会话记账', async () => {
    const sink = makeSink();
    await withP2EsmCase({
      classic: (sandbox) => { loadClassicDeps(sandbox); installClassicSeams(sandbox, sink); },
      globals: baseGlobals(),
    }, async (c) => {
      let cleanupCalls = 0;
      c.window._cleanupInputMetaBar = () => { cleanupCalls += 1; };
      const mod = await c.load(LOADER);
      const recap = await c.load(RECAP_STATE);
      recap.setCurrentRecapText('旧摘要');
      recap.setRecapPendingTrigger(true);
      recap.setRecapShownForSession(new Set(['session-key-a']));
      recap.setRecapDismissedForSession(new Set(['session-key-b']));

      mod.createSessionDataLoaderHost().clearRecap();

      assert.equal(recap.currentRecapText, '');
      assert.equal(recap.recapPendingTrigger, false);
      // recap-hint 的 _clearRecapForNewMessage 会清会话记账并调用 _cleanupInputMetaBar
      assert.deepEqual(Array.from(recap.recapShownForSession), ['session-key-a']);
      assert.deepEqual(Array.from(recap.recapDismissedForSession), ['session-key-b']);
      assert.equal(cleanupCalls, 0);
    });
  });
});
