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
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

// ── Helpers ────────────────────────────────────────────────

function loadOverviewData(overrides = {}) {
  const ctx = createFrontendSandbox({
    currentLanguage: 'zh',
    ...overrides,
  });
  ctx.loadSource('public/src/modules/overview-data.js');
  return ctx;
}

/**
 * Load chat-context-bar.js with its dependency on session-ui.js,
 * mocking the host-environment functions that updateChatContextBar calls.
 */
function loadContextBar({ overview, agent, runtimeRecord }) {
  const ctx = createFrontendSandbox({
    currentLanguage: 'zh',
    setTimeout: () => 0,           // suppress _initCcbPopup / _initTitlePopup
    followLatestEnabled: false,
    container: { scrollTop: 0 },
    shouldRenderWorkspaceSurface: () => false,
    isChatSurfaceActive: () => false,
    getRuntimeAwareAgentRecord: () => agent,
    getCurrentRuntimeRecord: () => (runtimeRecord ?? null),
    readCurrentSessionViewState: () => ({ overview: overview || {} }),
    notifyChatViewportMutation: () => {},
  });
  // session-ui.js provides getSessionContextLength / getSessionCompressRatio
  ctx.loadSource('public/src/modules/session-ui.js');
  ctx.loadSource('public/src/modules/chat-context-bar.js');
  return ctx;
}

// ── normalizeOverviewSnapshot: field passthrough ──────────

describe('normalizeOverviewSnapshot: agent-injected model fields', () => {
  it('preserves contextLength and compressRatio when valid', () => {
    const ctx = loadOverviewData();
    const raw = JSON.stringify({
      modelName: 'gpt-4-test',
      presetName: 'big-ctx',
      thinkingEffort: 'high',
      contextLength: 200000,
      compressRatio: 70,
    });
    const out = ctx.run(`normalizeOverviewSnapshot(${raw})`);
    assert.equal(out.contextLength, 200000);
    assert.equal(out.compressRatio, 70);
    // sibling fields still present
    assert.equal(out.modelName, 'gpt-4-test');
    assert.equal(out.presetName, 'big-ctx');
    assert.equal(out.thinkingEffort, 'high');
  });

  it('preserves contextLength/compressRatio alongside full usageStats', () => {
    // Ensure adding these fields doesn't interfere with the heavy nested
    // structures (the original standaloneTools-style regression fear).
    const ctx = loadOverviewData();
    const raw = JSON.stringify({
      contextLength: 128000,
      compressRatio: 75,
      usageStats: {
        totalUsage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        calls: [],
        totalRequests: 1,
        totalCacheHitRequests: 0,
      },
    });
    const out = ctx.run(`normalizeOverviewSnapshot(${raw})`);
    assert.equal(out.contextLength, 128000);
    assert.equal(out.compressRatio, 75);
    assert.equal(out.usageStats.totalUsage.inputTokens, 100);
  });

  it('normalizes invalid contextLength/compressRatio to null', () => {
    const ctx = loadOverviewData();
    const cases = [
      { contextLength: -1, compressRatio: 0 },
      { contextLength: 0, compressRatio: -5 },
      { contextLength: '128000', compressRatio: '75' },
      { contextLength: null, compressRatio: null },
      { contextLength: undefined, compressRatio: undefined },
    ];
    for (const c of cases) {
      const out = ctx.run(`normalizeOverviewSnapshot(${JSON.stringify(c)})`);
      assert.equal(out.contextLength, null, `contextLength ${JSON.stringify(c.contextLength)} → null`);
      assert.equal(out.compressRatio, null, `compressRatio ${JSON.stringify(c.compressRatio)} → null`);
    }
  });

  it('getEmptyOverviewSnapshot defaults contextLength/compressRatio to null', () => {
    const ctx = loadOverviewData();
    const out = ctx.run(`getEmptyOverviewSnapshot()`);
    assert.equal(out.contextLength, null);
    assert.equal(out.compressRatio, null);
    // existing defaults unaffected
    assert.equal(out.modelName, '');
    assert.equal(out.presetName, '');
    assert.equal(out.thinkingEffort, null);
  });

  it('null/non-object snapshot returns empty with null fields', () => {
    const ctx = loadOverviewData();
    assert.equal(ctx.run(`normalizeOverviewSnapshot(null).contextLength`), null);
    assert.equal(ctx.run(`normalizeOverviewSnapshot(null).compressRatio`), null);
    assert.equal(ctx.run(`normalizeOverviewSnapshot(undefined).contextLength`), null);
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

  it('uses overview values directly, ignoring stale session metadata', () => {
    // Session says 128000/80 (old model), overview says 200000/70 (new model).
    const agent = makeAgent(128000, 80);
    const ctx = loadContextBar({
      agent,
      overview: { contextLength: 200000, compressRatio: 70 },
    });

    ctx.run(`updateChatContextBar()`);
    const detail = ctx.run(`window._ccbDetailData`);

    assert.equal(detail.contextLength, 200000, 'should use overview value, not session 128000');
    assert.equal(detail.compressRatio, 70, 'should use overview value, not session 80');
  });

  it('overview without contextLength → progress bar not rendered (no session fallback)', () => {
    // Overview has no contextLength. Session has 128000 — but that value is
    // stale (pre-hot-swap) and must NOT be used. contextLength resolves to 0,
    // so the bar is simply not shown.
    const agent = makeAgent(128000, 80);
    const ctx = loadContextBar({
      agent,
      overview: {},
    });

    ctx.run(`updateChatContextBar()`);
    const detail = ctx.run(`window._ccbDetailData`);

    assert.equal(detail.contextLength, 0, 'must not fall back to session 128000');
  });

  it('null overview contextLength → 0, not session value', () => {
    // normalizeOverviewSnapshot converts missing/invalid → null.
    // null must resolve to 0 (no bar), never to session metadata.
    const agent = makeAgent(128000, 80);
    const ctx = loadContextBar({
      agent,
      overview: { contextLength: null, compressRatio: null },
    });

    ctx.run(`updateChatContextBar()`);
    const detail = ctx.run(`window._ccbDetailData`);

    assert.equal(detail.contextLength, 0, 'null overview → 0, not session fallback');
  });

  it('partial overview: contextLength present, compressRatio absent → default 80', () => {
    // compressRatio is a percentage config with a constant default of 80
    // (same default used when creating a preset). This is a semantic default,
    // not a stale-data fallback. contextLength comes from overview.
    const agent = makeAgent(128000, 80);
    const ctx = loadContextBar({
      agent,
      overview: { contextLength: 200000 },  // compressRatio absent
    });

    ctx.run(`updateChatContextBar()`);
    const detail = ctx.run(`window._ccbDetailData`);

    assert.equal(detail.contextLength, 200000, 'overview contextLength used');
    assert.equal(detail.compressRatio, 80, 'compressRatio default 80, not session value');
  });

  it('session contextLength/compressRatio are never read even when overview is empty', () => {
    // Decoy: session carries explicit values. They must be completely ignored.
    const agent = makeAgent(999000, 99);
    const ctx = loadContextBar({
      agent,
      overview: {},
    });

    ctx.run(`updateChatContextBar()`);
    const detail = ctx.run(`window._ccbDetailData`);

    assert.equal(detail.contextLength, 0, 'session 999000 must not leak in');
    assert.equal(detail.compressRatio, 80, 'session 99 must not leak in; default 80 used');
  });
});

