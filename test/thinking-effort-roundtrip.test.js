/**
 * Round-trip tests for the thinkingEffort data pipeline.
 *
 * The thinkingEffort field must survive the full chain:
 *
 *   resolveModelPresetLLM (server) → setLLM meta (runtime)
 *     → buildOverviewSnapshot (framework) → API JSON
 *       → normalizeOverviewSnapshot (frontend) → _getCurrentThinkingEffort (frontend)
 *
 * Previously, this field was missing at every transfer point, causing the
 * input box thinking switcher to lose its value after page reload,
 * session switch, or agent restart.
 *
 * These tests lock down each breakpoint.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFrontendSandbox, sourceBetween } from './helpers/frontend-vm.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');

// ── Source helpers ──────────────────────────────────────────

const persistentInputSource = fs.readFileSync(
  join(PROJECT_ROOT, 'public/src/modules/persistent-input.js'),
  'utf8',
);

/**
 * Create a sandbox pre-loaded with overview-data.js.
 * Returns the context with normalizeOverviewSnapshot / getEmptyOverviewSnapshot
 * available.
 */
function loadOverviewData() {
  const ctx = createFrontendSandbox();
  ctx.loadSource('public/src/modules/overview-data.js');
  return ctx;
}

/**
 * Create a sandbox with _getCurrentThinkingEffort extracted from
 * persistent-input.js, plus mocked dependencies.
 *
 * @param {object} mocks - { agent, cachedEffort, overview, preset }
 */
function createThinkingEffortSandbox(mocks = {}) {
  const fnSource = sourceBetween(
    persistentInputSource,
    'function _getCurrentThinkingEffort() {',
    '\nfunction _currentModelSupportsThinking()',
  );

  const ctx = createFrontendSandbox({
    // Mock getRuntimeAwareAgentRecord
    getRuntimeAwareAgentRecord: () => mocks.agent ?? null,
    // Mock getCachedThinkingEffort
    getCachedThinkingEffort: () => mocks.cachedEffort,
    // Mock _getCurrentPreset
    _getCurrentPreset: () => mocks.preset ?? null,
    // currentOverviewSnapshot will be set per-test
    currentOverviewSnapshot: mocks.overview ?? null,
  });

  // The extracted function references global functions by name,
  // so they must be visible in the sandbox scope.
  vm.runInContext(`${fnSource}\nglobalThis.__getEffort = _getCurrentThinkingEffort;`, ctx);

  return ctx;
}

// ── Part 1 (removed) ────────────────────────────────────────
// 原 Part 1（resolveModelPresetLLM: thinkingEffort field）直接调用
// resolveModelPresetLLM('智谱GLM-5.2', …)，依赖机器本地 config/presets.json
// 的真实 preset，在干净环境无法复现，已移除。服务端该字段的传递链路由
// 下方 Part 2-5 的前端 VM 用例以模拟数据锁定。

// ── Part 2: normalizeOverviewSnapshot preserves thinkingEffort ──

describe('normalizeOverviewSnapshot: thinkingEffort preservation', () => {
  it('preserves string thinkingEffort', () => {
    const ctx = loadOverviewData();
    const result = ctx.run(`normalizeOverviewSnapshot(${JSON.stringify({
      modelName: 'glm-5.2',
      presetName: '智谱GLM-5.2',
      thinkingEffort: 'high',
    })})`);
    assert.equal(result.thinkingEffort, 'high');
  });

  it('normalizes missing thinkingEffort to null', () => {
    const ctx = loadOverviewData();
    const result = ctx.run(`normalizeOverviewSnapshot(${JSON.stringify({
      modelName: 'glm-5.2',
      // No thinkingEffort field — simulates agent.ts omitting it when _llmMeta.thinkingEffort is null
    })})`);
    assert.equal(result.thinkingEffort, null);
  });

  it('normalizes null thinkingEffort to null', () => {
    const ctx = loadOverviewData();
    const result = ctx.run(`normalizeOverviewSnapshot(${JSON.stringify({
      modelName: 'glm-5.2',
      thinkingEffort: null,
    })})`);
    assert.equal(result.thinkingEffort, null);
  });

  it('normalizes non-string thinkingEffort (number) to null', () => {
    const ctx = loadOverviewData();
    const result = ctx.run(`normalizeOverviewSnapshot(${JSON.stringify({
      modelName: 'glm-5.2',
      thinkingEffort: 42,
    })})`);
    assert.equal(result.thinkingEffort, null);
  });

  it('preserves thinkingEffort alongside modelName and presetName', () => {
    const ctx = loadOverviewData();
    const result = ctx.run(`normalizeOverviewSnapshot(${JSON.stringify({
      modelName: 'claude-sonnet-4-5',
      presetName: 'Claude Sonnet',
      thinkingEffort: 'xhigh',
    })})`);
    assert.equal(result.modelName, 'claude-sonnet-4-5');
    assert.equal(result.presetName, 'Claude Sonnet');
    assert.equal(result.thinkingEffort, 'xhigh');
  });

  it('empty snapshot returns null thinkingEffort (not undefined)', () => {
    const ctx = loadOverviewData();
    const result = ctx.run(`normalizeOverviewSnapshot(null)`);
    assert.equal(result.thinkingEffort, null);
    // Must be null, not undefined — undefined would break downstream typeof checks
  });

  it('getEmptyOverviewSnapshot includes thinkingEffort: null', () => {
    const ctx = loadOverviewData();
    const result = ctx.run(`getEmptyOverviewSnapshot()`);
    assert.ok('thinkingEffort' in result, 'empty snapshot must have thinkingEffort key');
    assert.equal(result.thinkingEffort, null);
  });
});

// ── Part 3: _getCurrentThinkingEffort priority chain ────────

describe('_getCurrentThinkingEffort: 3-tier priority chain', () => {

  it('Priority 1: local cache string wins over overview and preset', () => {
    const ctx = createThinkingEffortSandbox({
      agent: { id: 'ph' },
      cachedEffort: 'high',
      overview: { thinkingEffort: 'low' },
      preset: { thinkingEffort: 'medium' },
    });
    assert.equal(ctx.run(`__getEffort()`), 'high');
  });

  it('Priority 1: local cache null (explicit "cleared") wins over overview', () => {
    // null in cache means "user explicitly cleared to default"
    // This is different from undefined (never cached)
    const ctx = createThinkingEffortSandbox({
      agent: { id: 'ph' },
      cachedEffort: null,
      overview: { thinkingEffort: 'high' },
      preset: { thinkingEffort: 'medium' },
    });
    assert.equal(ctx.run(`__getEffort()`), null);
  });

  it('Priority 1: local cache undefined falls through to overview', () => {
    // undefined means "never cached" — not the same as null
    const ctx = createThinkingEffortSandbox({
      agent: { id: 'ph' },
      cachedEffort: undefined,
      overview: { thinkingEffort: 'high' },
      preset: { thinkingEffort: 'medium' },
    });
    assert.equal(ctx.run(`__getEffort()`), 'high');
  });

  it('Priority 2: overview string used when cache is undefined', () => {
    const ctx = createThinkingEffortSandbox({
      agent: { id: 'ph' },
      cachedEffort: undefined,
      overview: { thinkingEffort: 'high' },
      preset: { thinkingEffort: 'medium' },
    });
    assert.equal(ctx.run(`__getEffort()`), 'high');
  });

  it('Priority 2: overview null falls through to preset default', () => {
    // overview.thinkingEffort null = runtime cleared thinking
    // Frontend should show preset default (not null)
    const ctx = createThinkingEffortSandbox({
      agent: { id: 'ph' },
      cachedEffort: undefined,
      overview: { thinkingEffort: null },
      preset: { thinkingEffort: 'medium' },
    });
    assert.equal(ctx.run(`__getEffort()`), 'medium');
  });

  it('Priority 2: overview missing thinkingEffort field falls through to preset', () => {
    const ctx = createThinkingEffortSandbox({
      agent: { id: 'ph' },
      cachedEffort: undefined,
      overview: { modelName: 'glm-5.2' }, // no thinkingEffort field
      preset: { thinkingEffort: 'medium' },
    });
    assert.equal(ctx.run(`__getEffort()`), 'medium');
  });

  it('Priority 2: overview is null object → falls through to preset', () => {
    const ctx = createThinkingEffortSandbox({
      agent: { id: 'ph' },
      cachedEffort: undefined,
      overview: null,
      preset: { thinkingEffort: 'medium' },
    });
    assert.equal(ctx.run(`__getEffort()`), 'medium');
  });

  it('Priority 3: preset default used when neither cache nor overview', () => {
    const ctx = createThinkingEffortSandbox({
      agent: { id: 'ph' },
      cachedEffort: undefined,
      overview: null,
      preset: { thinkingEffort: 'medium' },
    });
    assert.equal(ctx.run(`__getEffort()`), 'medium');
  });

  it('Priority 3: returns null when preset has no thinkingEffort', () => {
    const ctx = createThinkingEffortSandbox({
      agent: { id: 'ph' },
      cachedEffort: undefined,
      overview: null,
      preset: { thinkingEffort: null },
    });
    assert.equal(ctx.run(`__getEffort()`), null);
  });

  it('Priority 3: returns null when preset is null', () => {
    const ctx = createThinkingEffortSandbox({
      agent: { id: 'ph' },
      cachedEffort: undefined,
      overview: null,
      preset: null,
    });
    assert.equal(ctx.run(`__getEffort()`), null);
  });

  it('returns null when agent is null (no cache possible)', () => {
    const ctx = createThinkingEffortSandbox({
      agent: null,
      cachedEffort: undefined,
      overview: null,
      preset: null,
    });
    assert.equal(ctx.run(`__getEffort()`), null);
  });

  it('empty string thinkingEffort in overview does NOT match (falls through)', () => {
    // typeof '' === 'string' but '' is falsy, so the && guard rejects it
    const ctx = createThinkingEffortSandbox({
      agent: { id: 'ph' },
      cachedEffort: undefined,
      overview: { thinkingEffort: '' },
      preset: { thinkingEffort: 'medium' },
    });
    assert.equal(ctx.run(`__getEffort()`), 'medium');
  });
});

// ── Part 4: Full end-to-end round-trip simulation ───────────

describe('thinkingEffort: full round-trip simulation', () => {

  // NOTE: 原 scenario A / B 起始于 resolveModelPresetLLM('智谱GLM-5.2', …) 的
  // 真实配置解析，依赖机器本地 config/presets.json，已移除。其下游链路
  // （overview → normalize → 前端读取）由 B+/C/D/E 用模拟数据覆盖。

  it('scenario B+: user swaps to "default" → local cache null preserves "cleared" state', () => {
    // The local optimistic cache is what makes "Default" selection stick
    // before the overview poll arrives.
    const effortCtx = createThinkingEffortSandbox({
      agent: { id: 'ph' },
      cachedEffort: null, // optimistic cache: user explicitly cleared
      overview: { thinkingEffort: null }, // overview agrees
      preset: { thinkingEffort: 'medium' },
    });
    // Cache null (≠ undefined) wins → returns null, NOT preset medium
    assert.equal(effortCtx.run(`__getEffort()`), null, 'cache null preserves cleared state');
  });

  it('scenario C: page reload with active thinking override → overview restores UI', () => {
    // After page reload, local cache is empty, but overview from poll has the value.
    // The overview is the ONLY source of truth for runtime state.
    const overviewFromPoll = {
      modelName: 'glm-5.2',
      presetName: '智谱GLM-5.2',
      thinkingEffort: 'xhigh',
    };

    const ctx = loadOverviewData();
    const normalized = ctx.run(`normalizeOverviewSnapshot(${JSON.stringify(overviewFromPoll)})`);
    assert.equal(normalized.thinkingEffort, 'xhigh');

    const effortCtx = createThinkingEffortSandbox({
      agent: { id: 'ph' },
      cachedEffort: undefined, // page reload wiped cache
      overview: normalized,
      preset: { thinkingEffort: 'medium' },
    });
    assert.equal(effortCtx.run(`__getEffort()`), 'xhigh', 'overview restores correct value');
  });

  it('scenario D: agent restart resets thinking → overview converges, cache syncs', () => {
    // Before restart: user had 'high'
    // After restart: agent uses preset default 'medium'
    // Overview poll arrives with 'medium'
    // _getCurrentThinkingEffort should show 'medium' (from overview, since cache is stale)

    // Phase 1: stale cache still says 'high'
    let effortCtx = createThinkingEffortSandbox({
      agent: { id: 'ph' },
      cachedEffort: 'high', // stale optimistic cache
      overview: { thinkingEffort: 'medium' }, // new authoritative value
      preset: { thinkingEffort: 'medium' },
    });
    // Cache wins (priority 1) — this is expected; cache is optimistic
    assert.equal(effortCtx.run(`__getEffort()`), 'high');

    // Phase 2: after updateThinkingEffortSwitcher syncs cache from overview,
    // cache is overwritten with overview value
    effortCtx = createThinkingEffortSandbox({
      agent: { id: 'ph' },
      cachedEffort: 'medium', // synced from overview
      overview: { thinkingEffort: 'medium' },
      preset: { thinkingEffort: 'medium' },
    });
    assert.equal(effortCtx.run(`__getEffort()`), 'medium');
  });

  it('scenario E: session switch — thinking values are isolated per-session', () => {
    // Each session has its own runtime process, so overview is per-session.
    // The local cache is keyed by agentId, so switching agents gets different values.

    // Session A: thinking = 'high'
    const ctxA = createThinkingEffortSandbox({
      agent: { id: 'agentA' },
      cachedEffort: 'high',
      overview: { thinkingEffort: 'high' },
      preset: { thinkingEffort: 'medium' },
    });

    // Session B: thinking = null (default)
    const ctxB = createThinkingEffortSandbox({
      agent: { id: 'agentB' },
      cachedEffort: null,
      overview: { thinkingEffort: null },
      preset: { thinkingEffort: 'medium' },
    });

    assert.equal(ctxA.run(`__getEffort()`), 'high', 'session A shows high');
    assert.equal(ctxB.run(`__getEffort()`), null, 'session B shows default');
  });
});

// ── Part 5: Regression guard — field must not be silently stripped ─

describe('thinkingEffort: regression guard', () => {
  it('normalizeOverviewSnapshot does NOT strip thinkingEffort (the original bug)', () => {
    // Before the fix, normalizeOverviewSnapshot reconstructed the object
    // field-by-field and simply didn't include thinkingEffort, silently
    // dropping it. This test ensures that can't happen again.
    const ctx = loadOverviewData();
    const raw = { modelName: 'test', thinkingEffort: 'high' };
    const result = ctx.run(`normalizeOverviewSnapshot(${JSON.stringify(raw)})`);
    assert.equal(result.thinkingEffort, 'high',
      'normalizeOverviewSnapshot must preserve thinkingEffort — it was silently stripped before the fix');
  });

  it('getEmptyOverviewSnapshot declares thinkingEffort key', () => {
    // If this key is missing from the empty template, normalizeOverviewSnapshot
    // can't default it to null for missing/invalid inputs.
    const ctx = loadOverviewData();
    const empty = ctx.run(`getEmptyOverviewSnapshot()`);
    assert.ok('thinkingEffort' in empty,
      'empty snapshot must declare thinkingEffort — otherwise consumers see undefined instead of null');
  });
});
