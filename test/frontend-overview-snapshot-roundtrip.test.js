/**
 * Round-trip tests for the overview snapshot normalization + context bar
 * model-field pipeline.
 *
 * Locks down the invariant that agent-injected model fields
 * (modelName, presetName, thinkingEffort, contextLength, compressRatio)
 * flow through the entire frontend pipeline without being silently dropped:
 *
 *   Agent.buildOverviewSnapshot()
 *     → API → setCurrentOverviewSnapshot() → normalizeOverviewSnapshot()
 *     → currentOverviewSnapshot
 *     → readCurrentSessionViewState().overview
 *     → updateChatContextBar() reads overview.contextLength / compressRatio
 *
 * Historically contextLength/compressRatio were never emitted by
 * buildOverviewSnapshot(), so the context bar relied on a session-metadata
 * side-channel that doesn't update on model hot-swap. These tests guard the
 * real-time overview path so the two values stay in sync with modelName.
 *
 * 装载路线（P2 测试改造 + P4 L1）：overview-data / chat-context-bar 均已迁 ESM
 * → withP2EsmCase + 真实 import（classic 侧先跑 action-dispatcher / app-core /
 * session-view-state 真实 bootstrap，它们的宿主工厂与
 * normalizeSessionModelState 在装载期被取用）；session-view-state 仍 classic →
 * 照旧 loadSource，overview 经真实 applySessionViewPatch 提交（不再替换
 * readCurrentSessionViewState）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { APP_CORE_DOMAIN, prepareEsmModules, SESSION_VIEW_DOMAIN } from './p2-classic-hosts.js';

const OVERVIEW_DATA = 'public/src/modules/overview-data.js';

/** overview-data / session-view-state 的 classic 前置（生产装载顺序）。 */
const CLASSIC_STACK = [
  'public/src/modules/action-dispatcher.js',
  // session-view-state 自 P4 T2 起是 ESM：由 prepareEsmModules(sandbox, SESSION_VIEW_DOMAIN)
  // / prepareClassicSandbox 在模块相装载，classic 链里不再有它。
];

/** vendor 解析器 / 高亮库：markdown-utils 求值期构造 Renderer，渲染期查 hljs。 */
const VENDOR_STUBS = {
  marked: { Renderer: class { constructor() {} }, setOptions() {}, parse: () => '' },
  hljs: { getLanguage: () => null, highlight: () => ({ value: '' }) },
};

function loadOverviewDataCase(probe) {
  return withP2EsmCase({
    classic: (sandbox) => {
      for (const file of CLASSIC_STACK) sandbox.loadSource(file);
      prepareEsmModules(sandbox, APP_CORE_DOMAIN);
      prepareEsmModules(sandbox, SESSION_VIEW_DOMAIN);
    },
    globals: VENDOR_STUBS,
  }, async (c) => {
    const mod = await c.load(OVERVIEW_DATA);
    return probe(mod, c);
  });
}

/**
 * 装载真实 chat-context-bar（classic）与它的 overview 来源：overview 经真实
 * applySessionViewPatch 提交进会话视图状态，context bar 从默认参数读出来。
 * 宿主面（视图环境、agent 记录、视口通知）经 window 注入——这些正是
 * chat-context-bar 的 classic 依赖面。
 */
function loadContextBarCase({ overview, agent }, probe) {
  return withP2EsmCase({
    classic: (sandbox) => {
      sandbox.setTimeout = () => 0;   // 抑制 _initCcbPopup / _initTitlePopup 的定时器
      for (const file of CLASSIC_STACK) sandbox.loadSource(file);
      prepareEsmModules(sandbox, APP_CORE_DOMAIN);
      sandbox.followLatestEnabled = false;
      sandbox.container = { scrollTop: 0 };
      sandbox.shouldRenderWorkspaceSurface = () => false;
      sandbox.isChatSurfaceActive = () => false;
      sandbox.getRuntimeAwareAgentRecord = () => agent;
      sandbox.notifyChatViewportMutation = () => {};
      prepareEsmModules(sandbox, SESSION_VIEW_DOMAIN);
    },
    globals: VENDOR_STUBS,
  }, async (c) => {
    // 视图 patch 走会话视图桥键（模块相才有）：classic 回调里调不到。
    c.sandbox.applySessionViewPatch({ overview });
    // chat-context-bar 已迁 ESM（P4 L1）：模块相装载，classic 侧经桥键调用同名入口。
    const contextBar = await c.load('public/src/modules/chat-context-bar.js');
    return probe(c, contextBar);
  });
}

// ── normalizeOverviewSnapshot: field passthrough ──────────

describe('normalizeOverviewSnapshot: agent-injected model fields', () => {
  it('preserves contextLength and compressRatio when valid', async () => {
    await loadOverviewDataCase((overview) => {
      const raw = {
        modelName: 'gpt-4-test',
        presetName: 'big-ctx',
        thinkingEffort: 'high',
        contextLength: 200000,
        compressRatio: 70,
      };
      const out = overview.normalizeOverviewSnapshot(raw);
      assert.equal(out.contextLength, 200000);
      assert.equal(out.compressRatio, 70);
      // sibling fields still present
      assert.equal(out.modelName, 'gpt-4-test');
      assert.equal(out.presetName, 'big-ctx');
      assert.equal(out.thinkingEffort, 'high');
    });
  });

  it('preserves contextLength/compressRatio alongside full usageStats', async () => {
    // Ensure adding these fields doesn't interfere with the heavy nested
    // structures (the original standaloneTools-style regression fear).
    await loadOverviewDataCase((overview) => {
      const raw = {
        contextLength: 128000,
        compressRatio: 75,
        usageStats: {
          totalUsage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
          calls: [],
          totalRequests: 1,
          totalCacheHitRequests: 0,
        },
      };
      const out = overview.normalizeOverviewSnapshot(raw);
      assert.equal(out.contextLength, 128000);
      assert.equal(out.compressRatio, 75);
      assert.equal(out.usageStats.totalUsage.inputTokens, 100);
    });
  });

  it('normalizes invalid contextLength/compressRatio to null', async () => {
    await loadOverviewDataCase((overview) => {
      const cases = [
        { contextLength: -1, compressRatio: 0 },
        { contextLength: 0, compressRatio: -5 },
        { contextLength: '128000', compressRatio: '75' },
        { contextLength: null, compressRatio: null },
        { contextLength: undefined, compressRatio: undefined },
      ];
      for (const c of cases) {
        const out = overview.normalizeOverviewSnapshot(c);
        assert.equal(out.contextLength, null, `contextLength ${JSON.stringify(c.contextLength)} → null`);
        assert.equal(out.compressRatio, null, `compressRatio ${JSON.stringify(c.compressRatio)} → null`);
      }
    });
  });

  it('getEmptyOverviewSnapshot defaults contextLength/compressRatio to null', async () => {
    await loadOverviewDataCase((overview) => {
      const out = overview.getEmptyOverviewSnapshot();
      assert.equal(out.contextLength, null);
      assert.equal(out.compressRatio, null);
      // existing defaults unaffected
      assert.equal(out.modelName, '');
      assert.equal(out.presetName, '');
      assert.equal(out.thinkingEffort, null);
    });
  });

  it('null/non-object snapshot returns empty with null fields', async () => {
    await loadOverviewDataCase((overview) => {
      assert.equal(overview.normalizeOverviewSnapshot(null).contextLength, null);
      assert.equal(overview.normalizeOverviewSnapshot(null).compressRatio, null);
      assert.equal(overview.normalizeOverviewSnapshot(undefined).contextLength, null);
    });
  });
});

// ── updateChatContextBar: overview-only (no session fallback) ──

describe('updateChatContextBar: contextLength/compressRatio overview-only', () => {
  // The context bar must read contextLength/compressRatio exclusively from
  // the overview realtime snapshot. Session metadata is a stale side-channel
  // (written at session creation, never updated on model hot-swap) and must
  // NOT be consulted — even when present with plausible values.
  function makeAgent(sessionCl, sessionCr) {
    return {
      id: 'ph',
      workspace_sessions: {
        sessions: [{ id: 's1', contextLength: sessionCl, compressRatio: sessionCr }],
        activeSessionId: 's1',
      },
    };
  }

  it('uses overview values directly, ignoring stale session metadata', async () => {
    // Session says 128000/80 (old model), overview says 200000/70 (new model).
    const agent = makeAgent(128000, 80);
    await loadContextBarCase({
      agent,
      overview: { contextLength: 200000, compressRatio: 70 },
    }, (c, contextBar) => {
      c.read('updateChatContextBar()');
      const detail = contextBar._ccbDetailData;

      assert.equal(detail.contextLength, 200000, 'should use overview value, not session 128000');
      assert.equal(detail.compressRatio, 70, 'should use overview value, not session 80');
    });
  });

  it('overview without contextLength → progress bar not rendered (no session fallback)', async () => {
    // Overview has no contextLength. Session has 128000 — but that value is
    // stale (pre-hot-swap) and must NOT be used. contextLength resolves to 0,
    // so the bar is simply not shown.
    const agent = makeAgent(128000, 80);
    await loadContextBarCase({ agent, overview: {} }, (c, contextBar) => {
      c.read('updateChatContextBar()');
      const detail = contextBar._ccbDetailData;

      assert.equal(detail.contextLength, 0, 'must not fall back to session 128000');
    });
  });

  it('null overview contextLength → 0, not session value', async () => {
    // normalizeOverviewSnapshot converts missing/invalid → null.
    // null must resolve to 0 (no bar), never to session metadata.
    const agent = makeAgent(128000, 80);
    await loadContextBarCase({
      agent,
      overview: { contextLength: null, compressRatio: null },
    }, (c, contextBar) => {
      c.read('updateChatContextBar()');
      const detail = contextBar._ccbDetailData;

      assert.equal(detail.contextLength, 0, 'null overview → 0, not session fallback');
    });
  });

  it('partial overview: contextLength present, compressRatio absent → default 80', async () => {
    // compressRatio is a percentage config with a constant default of 80
    // (same default used when creating a preset). This is a semantic default,
    // not a stale-data fallback. contextLength comes from overview.
    const agent = makeAgent(128000, 80);
    await loadContextBarCase({ agent, overview: { contextLength: 200000 } }, (c, contextBar) => {
      c.read('updateChatContextBar()');
      const detail = contextBar._ccbDetailData;

      assert.equal(detail.contextLength, 200000, 'overview contextLength used');
      assert.equal(detail.compressRatio, 80, 'compressRatio default 80, not session value');
    });
  });

  it('session contextLength/compressRatio are never read even when overview is empty', async () => {
    // Decoy: session carries explicit values. They must be completely ignored.
    const agent = makeAgent(999000, 99);
    await loadContextBarCase({ agent, overview: {} }, (c, contextBar) => {
      c.read('updateChatContextBar()');
      const detail = contextBar._ccbDetailData;

      assert.equal(detail.contextLength, 0, 'session 999000 must not leak in');
      assert.equal(detail.compressRatio, 80, 'session 99 must not leak in; default 80 used');
    });
  });
});
