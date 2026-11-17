/**
 * R1-09 F 项：前端会话 header 测试（P2 真实 ESM 图路线）。
 *
 * 锁定 R1-09 header 收敛后的四条行为：
 *   1. 远程形态：agent record 缺失（远程会话不在 allAgents，ADR-0010）不再清空
 *      header——模型名/用量从 overview 活源照常渲染，标题走目录 sessionTitle
 *      回退链，hover 弹窗元数据经远程 accessor 组装（_collectActiveSessionMeta
 *      非 null）。
 *   2. 切换隔离：session-view-state 的 token 绑定 runtimeId + _switchEpoch，
 *      旧 token 在切换推进后提交返回 false，bar 反映新 runtime 的数据。
 *   3. 本地回归：record 存在时输出与当前实现关键子串一致（golden，锚定现状）。
 *   4. 空态：真·空数据（模型名空 + 用量 0 + contextLength 0）→ 用量条以
 *      空态占位常驻（不再清空整条 bar）。
 *
 * 装载路线：classic 相跑真实生产源（app-core → runtime-status → todo-plan →
 * session-view-state → i18n → app-main → chat-context-bar，相对序同 index.html）；
 * overview-data 已迁 ESM，经 `withP2EsmCase` + `c.load` 真实 import，并继续经其
 * 桥键服务 classic 消费方。每个用例一张独立模块图，`_switchEpoch` 与快照状态
 * 不跨用例。宿主环境函数（shouldRenderWorkspaceSurface 等，实现在未加载的
 * app-ui.js / chat-viewport.js）以 stub 注入，状态写入一律经 ctx.run。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withP2EsmCase } from './helpers/p2-esm-case.js';

const OVERVIEW_DATA = 'public/src/modules/overview-data.js';

function makeElement(id) {
  const classNames = new Set();
  return {
    id,
    style: {},
    dataset: {},
    className: '',
    textContent: '',
    innerHTML: '',
    scrollTop: 0,
    classList: {
      add: (...names) => names.forEach((n) => classNames.add(n)),
      remove: (...names) => names.forEach((n) => classNames.delete(n)),
      toggle: (name, force) => {
        if (force === undefined) {
          if (classNames.has(name)) classNames.delete(name); else classNames.add(name);
        } else if (force) {
          classNames.add(name);
        } else {
          classNames.delete(name);
        }
      },
      contains: (name) => classNames.has(name),
    },
    addEventListener() {},
    removeEventListener() {},
    appendChild() {},
    remove() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
}

/**
 * 加载 header 渲染链的真实源码并执行 `fn`。
 * classic 相顺序：app-core → runtime-status → sidebar-render → session-view-state →
 * i18n → app-main；ESM 相装载 todo-plan / chat-context-bar / overview-data（P4 L1
 * 三件已迁 ESM）。
 */
async function withHeaderSandbox(fn) {
  const elements = new Map();
  const getEl = (id) => {
    if (!elements.has(id)) elements.set(id, makeElement(id));
    return elements.get(id);
  };
  const documentStub = {
    getElementById: (id) => getEl(id),
    querySelector() { return null; },
    querySelectorAll() { return []; },
    createElement: (tag) => makeElement(tag),
    createTextNode: (text) => ({ textContent: text }),
    addEventListener() {},
    body: makeElement('body'),
    head: makeElement('head'),
    documentElement: makeElement('html'),
    readyState: 'complete',
  };

  await withP2EsmCase({
    globals: {
      document: documentStub,
      // vendor 解析器 / 高亮库：markdown-utils 求值期构造 Renderer，渲染期查 hljs。
      marked: { Renderer: class { constructor() {} }, setOptions() {}, parse: () => '' },
      hljs: { getLanguage: () => null, highlight: () => ({ value: '' }) },
    },
    classic: (ctx) => {
      // 抑制 chat-context-bar.js 顶层 setTimeout(_initCcbPopup/_initTitlePopup)
      // 与 runtime-status 顶层 ensureNotificationClockTimer() 的计时器。
      ctx.window.setInterval = () => 0;
      ctx.window.clearInterval = () => {};
      ctx.window.setTimeout = () => 0;
      // action-dispatcher：markdown-utils（ESM）求值期登记 markdown.* 动作需要 ClawFW。
      ctx.loadSource('public/src/modules/action-dispatcher.js');
      ctx.loadSource('public/src/app-core.js');
      ctx.loadSource('public/src/modules/runtime-status.js');
      // app-main 的 classic 同步引擎在装载期组合 sidebar-render 的
      // createAgentCallStatesHost：按生产先行脚本序装真链，不造宿主桩。
      ctx.loadSource('public/src/modules/sidebar-render.js');
      ctx.loadSource('public/src/modules/session-view-state.js');
      // todo-plan / chat-context-bar 已迁 ESM（P4 L1）：classic 相只补 markdown-utils
      // 的 classic 实现（escapeHtml / renderer），两个模块在 async 相 c.load。
      // i18n 已迁 ESM（P4）：t 桥键由 createFrontendSandbox 装好（install-i18n.js）
      // app-main.js 底部的启动序列在沙箱里不执行；主题/语言应用与渲染函数以 stub 替身
      ctx.run(`
        window.__clawAuthReady = new Promise(() => {});
        applyTheme = () => {};
        applyLanguage = () => {};
        shouldRenderWorkspaceSurface = () => false;
        isChatSurfaceActive = () => true;
        getRuntimeAwareAgentRecord = () => null;
        notifyChatViewportMutation = () => {};
        isRemoteNamespaceAgentId = (value) => typeof value === 'string' && value.startsWith('remote:');
      `);
      ctx.loadSource('public/src/app-main.js');
    },
  }, async (c) => {
    // 首屏链两件（P4 L1 已迁 ESM）：模块相装载，classic 侧经桥键调用同名入口。
    await c.load('public/src/modules/todo-plan.js');
    const contextBar = await c.load('public/src/modules/chat-context-bar.js');
    await c.load(OVERVIEW_DATA);
    return fn({ ctx: c.window, contextBar, bar: getEl('chat-context-bar'), titleEl: getEl('current-agent-name') });
  });
}

const REMOTE_OVERVIEW = JSON.stringify({
  modelName: 'glm-remote',
  contextLength: 100000,
  compressRatio: 80,
  usageStats: {
    lastRequestUsage: { inputTokens: 25000 },
    totalUsage: { inputTokens: 50000, outputTokens: 1000 },
    totalRequests: 4,
  },
});

// ── 场景 1：远程形态 ─────────────────────────────────────────

describe('frontend session header: remote form', () => {
  it('renders all three header items from the catalog stub with no agent record', async () => {
    await withHeaderSandbox(async ({ ctx, contextBar, bar, titleEl }) => {
      ctx.run(`
        currentRuntimeAgentId = 'remote:server-a:rt-1';
        focusedAgentId = 'remote:server-a:programming-helper';
        window.RemoteConnections = {
          getEntrySessionTitle: (ref) => (ref === 'remote:server-a:rt-1' ? '远程主会话' : ''),
          getEntryRuntimeSessionId: (ref) => (ref === 'remote:server-a:rt-1' ? 'remote:server-a:session-main' : ''),
          getEntryHostNamespaceId: (ref) => (ref === 'remote:server-a:rt-1' ? 'remote:server-a:programming-helper' : null),
          resolveRuntimeRef: (ref) => (ref === 'remote:server-a:rt-1' ? ref : null),
        };
        applySessionViewPatch({
          overview: ${REMOTE_OVERVIEW},
          sessionMeta: { sessionId: 'remote:server-a:session-main', sessionType: 'main', createdAt: '2026-08-30T01:00:00Z', updatedAt: '2026-08-30T02:00:00Z', openDirectory: '/srv/project-c', messageCount: 7 },
        });
      `);
      ctx.run('updateCurrentAgentChrome(); updateChatContextBar();');

      // 顶部标题：本地 record 链落空 → 目录 sessionTitle 回退链
      assert.equal(titleEl.textContent, '远程主会话');

      // 模型名 + 用量进度条照常渲染（record 缺失不清空整条 bar）
      assert.ok(bar.innerHTML.includes('ccb-model'), 'model name should render');
      assert.ok(bar.innerHTML.includes('glm-remote'), 'overview model name should surface');
      assert.ok(bar.innerHTML.includes('ccb-token'), 'usage progress bar should render');
      assert.ok(bar.innerHTML.includes('25%'), 'usage percentage from lastRequestUsage');

      // hover 弹窗元数据：远程分支经 accessor + sessionMeta 组装，非 null
      const meta = contextBar._collectActiveSessionMeta();
      assert.notEqual(meta, null);
      assert.equal(meta.session.title, '远程主会话');
      assert.equal(meta.activeSessionId, 'remote:server-a:session-main');
      assert.equal(meta.agent.name, '远程主会话');
      assert.equal(meta.session.createdAt, '2026-08-30T01:00:00Z');
      assert.equal(meta.session.openDirectory, '/srv/project-c');
      assert.equal(meta.session.messageCount, 7);
    });
  });
});

// ── 场景 2：切换隔离 ─────────────────────────────────────────

describe('frontend session header: switch isolation', () => {
  it('rejects a stale token after the switch epoch advances and the bar reflects runtime B', async () => {
    await withHeaderSandbox(async ({ ctx, bar }) => {
      ctx.run(`
        isRemoteNamespaceAgentId = (value) => typeof value === 'string' && value.startsWith('remote:');
        currentRuntimeAgentId = 'runtime-a';
        focusedAgentId = 'runtime-a';
        var tokenA = captureSessionViewToken('runtime-a');
        var committedA = commitSessionViewPatch(tokenA, {
          sessionMeta: { sessionId: 'session-a', messageCount: 3 },
          overview: { modelName: 'model-a', contextLength: 100000, compressRatio: 80, usageStats: { lastRequestUsage: { inputTokens: 10000 }, totalUsage: {}, totalRequests: 1 } },
        });
        updateChatContextBar();
      `);
      assert.equal(ctx.run('committedA'), true, 'setup commit for runtime A should apply');
      assert.ok(bar.innerHTML.includes('model-a'));

      const result = ctx.run(`
        // 推进切换纪元：模拟用户切走再切回（同 runtime 也要拒绝旧 token）
        _switchEpoch += 1;
        var staleAfterEpoch = commitSessionViewPatch(tokenA, { sessionMeta: { sessionId: 'stale', messageCount: 99 } });
        // 换 runtime 后旧 token 同样失效
        currentRuntimeAgentId = 'runtime-b';
        var staleAfterRuntime = commitSessionViewPatch(tokenA, { sessionMeta: { sessionId: 'stale-again' } });
        var staleOverview = commitSessionViewPatch(tokenA, { overview: { modelName: 'stale-model' } });
        JSON.stringify({ staleAfterEpoch, staleAfterRuntime: staleAfterRuntime, staleOverview, meta: readCurrentSessionViewState().sessionMeta });
      `);
      const outcome = JSON.parse(result);
      assert.equal(outcome.staleAfterEpoch, false, 'stale token must be rejected after epoch bump');
      assert.equal(outcome.staleAfterRuntime, false, 'stale token must be rejected after runtime change');
      assert.equal(outcome.staleOverview, false);
      assert.equal(outcome.meta.sessionId, 'session-a', 'stale commit must not touch the slot');

      // B 提交后 bar 反映 B
      ctx.run(`
        var tokenB = captureSessionViewToken('runtime-b');
        commitSessionViewPatch(tokenB, {
          sessionMeta: { sessionId: 'session-b', messageCount: 5 },
          overview: { modelName: 'model-b', contextLength: 50000, compressRatio: 80, usageStats: { lastRequestUsage: { inputTokens: 20000 }, totalUsage: {}, totalRequests: 2 } },
        });
        updateChatContextBar();
      `);
      assert.ok(bar.innerHTML.includes('model-b'), 'bar should reflect runtime B after switch');
      assert.ok(!bar.innerHTML.includes('stale-model'), 'stale overview must not leak into the bar');
      assert.equal(ctx.run('readCurrentSessionViewState().sessionMeta.sessionId'), 'session-b');
    });
  });
});

// ── 场景 3：本地回归（golden，锚定当前行为） ────────────────

describe('frontend session header: local regression', () => {
  it('keeps live model fields empty until overview arrives, retaining historical usage', async () => {
    await withHeaderSandbox(async ({ ctx, contextBar, bar }) => {
      ctx.run(`
        currentRuntimeAgentId = 'ph-1';
        focusedAgentId = 'ph';
        getRuntimeAwareAgentRecord = () => ({
          id: 'ph',
          workspace_sessions: {
            activeSessionId: 's1',
            sessions: [{
              id: 's1',
              modelName: 'glm-5.3-flash',
              contextLength: 128000,
              compressRatio: 80,
              tokenUsage: { lastRequestUsage: { inputTokens: 3000 } },
            }],
          },
        });
        applySessionViewPatch({
          overview: getEmptyOverviewSnapshot(),
          sessionMeta: { sessionId: 's1', sessionType: 'main', createdAt: '2026-08-30T01:00:00Z', updatedAt: '2026-08-30T02:00:00Z', openDirectory: '/work', messageCount: 7 },
        });
        updateChatContextBar();
      `);

      // 模型名与窗口同源：运行时未到时均为空态，历史用量仍可显示。
      assert.equal(
        bar.innerHTML,
        '<span class="ccb-token ccb-token-empty"><span class="ccb-bar" data-ccb-trigger="1"></span><span class="ccb-label" data-ccb-trigger="1">—</span></span>',
      );
      const detail = contextBar._ccbDetailData;
      assert.equal(detail.modelName, '');
      assert.equal(detail.used, 3000);
      assert.equal(detail.isLastRequest, true);
      assert.equal(detail.contextLength, 0, 'contextLength must not fall back to session metadata');

      // 本地分支的 hover 元数据与远程分支三键同构
      const meta = contextBar._collectActiveSessionMeta();
      assert.equal(meta.activeSessionId, 's1');
      assert.equal(meta.agent.id, 'ph');
      assert.equal(meta.session.id, 's1');
      assert.equal(meta.session.modelName, 'glm-5.3-flash');
    });
  });
});

// ── 场景 4：空态 ─────────────────────────────────────────────

describe('frontend session header: empty state', () => {
  it('keeps an empty-state usage placeholder when there is no record, no overview content, and no sessionMeta', async () => {
    await withHeaderSandbox(async ({ ctx, contextBar, bar }) => {
      ctx.run(`
        isRemoteNamespaceAgentId = (value) => typeof value === 'string' && value.startsWith('remote:');
        currentRuntimeAgentId = 'ph-1';
        focusedAgentId = 'ph';
        getRuntimeAwareAgentRecord = () => null;
        applySessionViewPatch({
          overview: getEmptyOverviewSnapshot(),
          sessionMeta: undefined,
        });
        updateChatContextBar();
      `);

      assert.ok(bar.innerHTML.includes('ccb-token-empty'), '真·空数据时用量条以空态占位常驻');
      assert.ok(!bar.innerHTML.includes('ccb-model'), '模型名槽位无数据时不渲染');
      const view = ctx.run('({ sessionMeta: readCurrentSessionViewState().sessionMeta })');
      assert.equal(view.sessionMeta.sessionId, '');
      assert.equal(view.sessionMeta.messageCount, 0);
      // 无活跃会话 → hover 弹窗元数据为 null（远程分支需要 runtimeRef，本地分支需要 record）
      assert.equal(contextBar._collectActiveSessionMeta(), null);
    });
  });
});
