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

// ── updateChatContextBar: overview vs session priority ────

describe('updateChatContextBar: contextLength/compressRatio priority', () => {
  // Shared agent with session-level metadata (the old side-channel values).
  function makeAgent(sessionCl, sessionCr) {
    return {
      id: 'ph',
      workspace_sessions: {
        sessions: [{ id: 's1', contextLength: sessionCl, compressRatio: sessionCr }],
        activeSessionId: 's1',
      },
    };
  }

  it('overview values take priority over session metadata (hot-swap reflects immediately)', () => {
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

  it('falls back to session metadata when overview lacks values', () => {
    // Overview has no contextLength/compressRatio (e.g. older framework version
    // or preset without these fields). Must gracefully fall back to session.
    const agent = makeAgent(128000, 80);
    const ctx = loadContextBar({
      agent,
      overview: {},
    });

    ctx.run(`updateChatContextBar()`);
    const detail = ctx.run(`window._ccbDetailData`);

    assert.equal(detail.contextLength, 128000, 'should fall back to session value');
    assert.equal(detail.compressRatio, 80, 'should fall back to session value');
  });

  it('overview with null contextLength falls back to session (not treated as valid)', () => {
    // normalizeOverviewSnapshot converts missing/invalid → null.
    // null must NOT win over session metadata.
    const agent = makeAgent(128000, 80);
    const ctx = loadContextBar({
      agent,
      overview: { contextLength: null, compressRatio: null },
    });

    ctx.run(`updateChatContextBar()`);
    const detail = ctx.run(`window._ccbDetailData`);

    assert.equal(detail.contextLength, 128000, 'null overview → session fallback');
    assert.equal(detail.compressRatio, 80, 'null overview → session fallback');
  });

  it('partial overview: contextLength present but compressRatio missing', () => {
    // Some presets define contextLength but no compressRatio.
    // Each field must be resolved independently.
    const agent = makeAgent(128000, 80);
    const ctx = loadContextBar({
      agent,
      overview: { contextLength: 200000 },  // compressRatio absent
    });

    ctx.run(`updateChatContextBar()`);
    const detail = ctx.run(`window._ccbDetailData`);

    assert.equal(detail.contextLength, 200000, 'overview contextLength wins');
    assert.equal(detail.compressRatio, 80, 'compressRatio falls back to session');
  });

  it('falls back to hardcoded defaults when neither overview nor session provide values', () => {
    // No overview values, no session values, no cache → defaults 200000 / 80.
    const agent = {
      id: 'ph-fresh',
      workspace_sessions: {
        sessions: [{ id: 's1' }],  // no contextLength/compressRatio
        activeSessionId: 's1',
      },
    };
    const ctx = loadContextBar({
      agent,
      overview: {},
    });

    ctx.run(`updateChatContextBar()`);
    const detail = ctx.run(`window._ccbDetailData`);

    assert.equal(detail.contextLength, 200000, 'default contextLength');
    assert.equal(detail.compressRatio, 80, 'default compressRatio');
  });
});
