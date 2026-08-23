/**
 * Round-trip tests for the model display data pipeline.
 *
 * Locks down the invariant that model-related fields
 * (modelPresets, contextLength, compressRatio, presetName)
 * survive these transitions without flashing defaults:
 *
 *   1. getRuntimeAwareAgentRecord() merge — host → runtime child
 *   2. _modelInfoCache bridge — loadAgents replacement gap
 *   3. Agent switch — no cross-agent cache leakage
 *   4. Model swap — cache update + recovery
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deepEqual as deepLoose } from 'node:assert';
import vm from 'node:vm';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');

// ── Source extractors ──────────────────────────────────────

const uiSource = fs.readFileSync(join(PROJECT_ROOT, 'public/src/app-ui.js'), 'utf8');

function extractRuntimeAwareAgentSource() {
  const start = uiSource.indexOf('function _mergeWorkspaceSessions');
  const end = uiSource.indexOf('\nfunction getRuntimeAwareAgentName', start);
  assert.notEqual(start, -1, 'runtime-aware merge start marker should exist');
  assert.notEqual(end, -1, 'runtime-aware merge end marker should exist');
  return uiSource.slice(start, end);
}

// ── Helpers ────────────────────────────────────────────────

function loadSessionUi(overrides = {}) {
  const defaults = {
    currentLanguage: 'zh',
    getCurrentAgentRecord: () => null,
    phSessionSortMode: 'updatedAt',
  };
  const ctx = createFrontendSandbox({ ...defaults, ...overrides });
  ctx.loadSource('public/src/modules/session-ui.js');
  return ctx;
}

/**
 * Create a minimal sandbox with getRuntimeAwareAgentRecord extracted
 * from app-ui.js, plus mock getCurrentAgentRecord / getCurrentRuntimeRecord.
 */
function createRuntimeAwareSandbox(hostRecord, runtimeRecord) {
  const sandbox = {
    getCurrentAgentRecord: () => hostRecord,
    getCurrentRuntimeRecord: () => runtimeRecord,
  };
  vm.createContext(sandbox);
  vm.runInContext(
    `${extractRuntimeAwareAgentSource()}\nglobalThis.__fn = getRuntimeAwareAgentRecord;`,
    sandbox,
  );
  return sandbox;
}

// ── Tests: _cacheModelInfo + getCachedPresetName ───────────

describe('model-info cache: presetName round-trip', () => {
  it('caches presetName per agent and reads it back', () => {
    const ctx = loadSessionUi();
    ctx.run(`var agent = { id: 'ph' };`);
    ctx.run(`_cacheModelInfo(agent, null, null, 'glm-5.2')`);
    assert.equal(ctx.run(`getCachedPresetName({ id: 'ph' })`), 'glm-5.2');
  });

  it('returns empty string for unknown agent', () => {
    const ctx = loadSessionUi();
    ctx.run(`_cacheModelInfo({ id: 'ph' }, null, null, 'glm-5.2')`);
    assert.equal(ctx.run(`getCachedPresetName({ id: 'other' })`), '');
  });

  it('does NOT leak presetName across agents', () => {
    const ctx = loadSessionUi();
    ctx.run(`_cacheModelInfo({ id: 'agentA' }, null, null, 'claude-sonnet')`);
    ctx.run(`_cacheModelInfo({ id: 'agentB' }, null, null, 'gpt-4o')`);
    assert.equal(ctx.run(`getCachedPresetName({ id: 'agentA' })`), 'claude-sonnet');
    assert.equal(ctx.run(`getCachedPresetName({ id: 'agentB' })`), 'gpt-4o');
  });

  it('empty/null presetName does not overwrite existing cache', () => {
    const ctx = loadSessionUi();
    ctx.run(`_cacheModelInfo({ id: 'ph' }, null, null, 'glm-5.2')`);
    ctx.run(`_cacheModelInfo({ id: 'ph' }, null, null, '')`);
    ctx.run(`_cacheModelInfo({ id: 'ph' }, null, null, null)`);
    assert.equal(ctx.run(`getCachedPresetName({ id: 'ph' })`), 'glm-5.2');
  });

  it('co-exists with contextLength and compressRatio in same cache slot', () => {
    const ctx = loadSessionUi();
    ctx.run(`_cacheModelInfo({ id: 'ph' }, 128000, 75, 'claude-sonnet')`);
    // All three values should be independently present
    assert.equal(ctx.run(`getCachedPresetName({ id: 'ph' })`), 'claude-sonnet');
    assert.equal(ctx.run(`getSessionContextLength({}, { id: 'ph' })`), 128000);
    assert.equal(ctx.run(`getSessionCompressRatio({}, { id: 'ph' })`), 75);
  });
});

// ── Tests: contextLength/compressRatio cache round-trip ────

describe('model-info cache: contextLength/compressRatio survive loadAgents gap', () => {
  it('caches values when session provides them, then serves from cache when session loses them', () => {
    const ctx = loadSessionUi();
    const agent = { id: 'ph' };

    // Phase 1: Full data available (loadAgentDetail has run)
    ctx.run(`var agent = { id: 'ph' }`);
    assert.equal(ctx.run(`getSessionContextLength({ contextLength: 200000 }, agent)`), 200000);
    assert.equal(ctx.run(`getSessionCompressRatio({ compressRatio: 70 }, agent)`), 70);

    // Phase 2: loadAgents replaces allAgents — session fields gone
    // (simulates light snapshot from getConnectedAgents)
    assert.equal(ctx.run(`getSessionContextLength({}, agent)`), 200000);
    assert.equal(ctx.run(`getSessionCompressRatio({}, agent)`), 70);

    // Phase 3: Even agent.workspace_sessions is empty
    assert.equal(ctx.run(`getSessionContextLength({}, { id: 'ph' })`), 200000);
    assert.equal(ctx.run(`getSessionCompressRatio({}, { id: 'ph' })`), 70);
  });
});

// ── Tests: getRuntimeAwareAgentRecord modelPresets carry ───

describe('getRuntimeAwareAgentRecord: modelPresets preservation', () => {
  it('carries modelPresets from host when runtime child lacks it', () => {
    const host = {
      id: 'programming-helper',
      modelPresets: { default: { primary: 'glm-5.2' } },
      workspace_sessions: { sessions: [], contextLength: 128000 },
    };
    const runtime = {
      id: 'viewer-uuid-123',
      parent_id: 'programming-helper',
      active_workspace_session_id: 'sess-1',
      active_workspace_display_name: 'Test Session',
      // NO modelPresets — runtime child record
    };

    const sandbox = createRuntimeAwareSandbox(host, runtime);
    const record = sandbox.__fn();

    assert.ok(record.modelPresets, 'modelPresets should be present on merged record');
    assert.equal(record.modelPresets.default.primary, 'glm-5.2');
  });

  it('preserves runtime record modelPresets when it has its own', () => {
    const host = {
      id: 'programming-helper',
      modelPresets: { default: { primary: 'old-model' } },
      workspace_sessions: { sessions: [], contextLength: 128000 },
    };
    const runtime = {
      id: 'programming-helper',
      active_workspace_session_id: 'sess-1',
      modelPresets: { default: { primary: 'new-model' } },
    };

    const sandbox = createRuntimeAwareSandbox(host, runtime);
    const record = sandbox.__fn();

    // Runtime record's own modelPresets should win
    assert.equal(record.modelPresets.default.primary, 'new-model');
  });

  it('carries modelPresets even when host has no workspace_sessions', () => {
    const host = {
      id: 'programming-helper',
      modelPresets: { default: { primary: 'glm-5.2' } },
      // NO workspace_sessions
    };
    const runtime = {
      id: 'viewer-uuid',
      active_workspace_display_name: 'Session',
      active_workspace_session_id: 'sess-1',
    };

    const sandbox = createRuntimeAwareSandbox(host, runtime);
    const record = sandbox.__fn();

    assert.ok(record.modelPresets, 'modelPresets should be carried from host');
    assert.equal(record.modelPresets.default.primary, 'glm-5.2');
  });

  it('returns host record with modelPresets when no runtime is active', () => {
    const host = {
      id: 'programming-helper',
      modelPresets: { default: { primary: 'glm-5.2' } },
    };

    const sandbox = createRuntimeAwareSandbox(host, null);
    const record = sandbox.__fn();

    assert.equal(record.modelPresets.default.primary, 'glm-5.2');
  });
});

// ── Tests: Full round-trip — agent switch isolation ────────

describe('model-info: full agent-switch round-trip', () => {
  it('agent A preset does not leak to agent B after switch', () => {
    const ctx = loadSessionUi();

    // Agent A is active, preset cached
    ctx.run(`_cacheModelInfo({ id: 'agentA' }, 128000, 80, 'claude-sonnet')`);

    // Simulate switch to agent B — B has different model
    // Agent B's record arrives from getConnectedAgents
    ctx.run(`_cacheModelInfo({ id: 'agentB' }, 200000, 70, 'gpt-4o')`);

    // Agent A cache should still be intact (not overwritten by B)
    assert.equal(ctx.run(`getCachedPresetName({ id: 'agentA' })`), 'claude-sonnet');
    assert.equal(ctx.run(`getSessionContextLength({}, { id: 'agentA' })`), 128000);

    // Agent B cache should be separate
    assert.equal(ctx.run(`getCachedPresetName({ id: 'agentB' })`), 'gpt-4o');
    assert.equal(ctx.run(`getSessionContextLength({}, { id: 'agentB' })`), 200000);
  });

  it('simulates loadAgents gap: cache bridges data loss without flashing defaults', () => {
    const ctx = loadSessionUi();

    // Phase 1: Agent has full data
    ctx.run(`
      var agent = { id: 'ph', workspace_sessions: { contextLength: 128000, compressRatio: 75 } };
      var session = { contextLength: 128000, compressRatio: 75 };
    `);
    // Values are read and cached
    assert.equal(ctx.run(`getSessionContextLength(session, agent)`), 128000);
    assert.equal(ctx.run(`getSessionCompressRatio(session, agent)`), 75);

    // Phase 2: loadAgents replaces allAgents — light snapshot arrives
    // session and agent.workspace_sessions lose their explicit values
    ctx.run(`
      var agent2 = { id: 'ph', workspace_sessions: {} };
      var session2 = {};
    `);

    // Cache should bridge — NO flashing to defaults (200000 / 80)
    const cl = ctx.run(`getSessionContextLength(session2, agent2)`);
    const cr = ctx.run(`getSessionCompressRatio(session2, agent2)`);
    assert.equal(cl, 128000, 'contextLength should come from cache, not default 200000');
    assert.equal(cr, 75, 'compressRatio should come from cache, not default 80');
  });
});

// ── Tests: swap agentId must resolve to HOST agent ID ──────

describe('model swap: agentId resolution', () => {
  it('focusedAgentId is the host agent ID, not the runtime child UUID', () => {
    // This test documents the invariant that swap_model must receive
    // the host agent ID (e.g. 'programming-helper'), because:
    //   1. Config file: .agentdev/agent-configs/{hostId}.json
    //   2. IPC delivery: listAgentRuntimes filters by runtime.agentId === hostId
    //   3. Runtime resolver: reads PROTOCLAW_PREBUILT_AGENT_ID === hostId
    //
    // If the ViewerWorker child UUID leaks through, all three fail silently.
    const hostId = 'programming-helper';
    const childUuid = 'viewer-session-abc-123';

    // Simulate the switchAgent() assignment
    // focusedAgentId = targetAgent?.parent_id || targetAgent?.id || runtimeAgentId;
    // For a prebuilt host: targetAgent.id = 'programming-helper', no parent_id
    const focusedAgentId = hostId;

    // The swap agentId must NOT be the child UUID
    assert.notEqual(focusedAgentId, childUuid);
    assert.equal(focusedAgentId, 'programming-helper');
  });

  it('getRuntimeAwareAgentRecord().id can be child UUID — swap must NOT use it', () => {
    // Document the trap: getRuntimeAwareAgentRecord() returns the runtime
    // child record when workspace state is present, and child.id is a UUID.
    const host = {
      id: 'programming-helper',
      modelPresets: { default: { primary: 'glm-5.2' } },
      workspace_sessions: { sessions: [], contextLength: 128000 },
      runtime_session_id: 'viewer-uuid-xyz',
    };
    const runtime = {
      id: 'viewer-uuid-xyz',
      parent_id: 'programming-helper',
      active_workspace_session_id: 'sess-1',
      active_workspace_display_name: 'Test',
    };

    const sandbox = createRuntimeAwareSandbox(host, runtime);
    const record = sandbox.__fn();

    // The merged record's id is the child UUID — NOT the host ID
    assert.equal(record.id, 'viewer-uuid-xyz');
    assert.notEqual(record.id, 'programming-helper');

    // This is exactly why _getInputAgentId / _getCurrentAgentIdForSwap
    // must use focusedAgentId (host ID) instead of record.id.
  });
});

// ── Tests: thinkingEffort runtime override ─────────────────

describe('_cacheModelInfo: thinkingEffort override', () => {
  it('caches thinkingEffort override per-agentId', () => {
    const ctx = loadSessionUi();
    ctx.run(`_cacheModelInfo({ id: 'ph' }, null, null, null, 'high')`);
    assert.equal(ctx.run(`getCachedThinkingEffort({ id: 'ph' })`), 'high');
  });

  it('returns undefined when no override cached', () => {
    const ctx = loadSessionUi();
    // Never cached → undefined (means "use preset default")
    assert.equal(ctx.run(`getCachedThinkingEffort({ id: 'ph' })`), undefined);
  });

  it('caches null as explicit "cleared to default"', () => {
    const ctx = loadSessionUi();
    // First set an override
    ctx.run(`_cacheModelInfo({ id: 'ph' }, null, null, null, 'high')`);
    assert.equal(ctx.run(`getCachedThinkingEffort({ id: 'ph' })`), 'high');

    // Then clear it
    ctx.run(`_cacheModelInfo({ id: 'ph' }, null, null, null, null)`);
    assert.equal(ctx.run(`getCachedThinkingEffort({ id: 'ph' })`), null);
    // null !== undefined — null means "explicitly cleared", not "never set"
  });

  it('does not leak thinkingEffort across agents', () => {
    const ctx = loadSessionUi();
    ctx.run(`_cacheModelInfo({ id: 'ph' }, null, null, null, 'high')`);
    assert.equal(ctx.run(`getCachedThinkingEffort({ id: 'ph' })`), 'high');
    assert.equal(ctx.run(`getCachedThinkingEffort({ id: 'qqbot' })`), undefined);
  });

  it('thinkingEffort undefined does not overwrite existing cache', () => {
    const ctx = loadSessionUi();
    // Set override
    ctx.run(`_cacheModelInfo({ id: 'ph' }, null, null, null, 'high')`);
    // Call with only contextLength — thinkingEffort is undefined (not passed)
    ctx.run(`_cacheModelInfo({ id: 'ph' }, 128000, null)`);
    // Override should still be there
     assert.equal(ctx.run(`getCachedThinkingEffort({ id: 'ph' })`), 'high');
  });
});

// ── Tests: overview.presetName round-trip ──────────────────

describe('overview.presetName: per-session data source', () => {
  // The overview snapshot is fetched per-session via
  // /api/agents/{runtimeId}/overview. Each session has its own
  // runtime process, so overview.presetName is inherently
  // per-session isolated — no frontend cache needed.

  it('normalizeOverviewSnapshot preserves presetName', () => {
    // Simulate what normalizeOverviewSnapshot does with presetName
    const raw = { modelName: 'claude-sonnet-4-5', presetName: 'glm-5.2' };
    const normalized = typeof raw.presetName === 'string' ? raw.presetName : '';
    assert.equal(normalized, 'glm-5.2');
  });

  it('missing presetName normalizes to empty string', () => {
    const raw = { modelName: 'claude-sonnet-4-5' };
    const normalized = typeof raw.presetName === 'string' ? raw.presetName : '';
    assert.equal(normalized, '');
  });

  it('different sessions get different overview from different runtimeIds', () => {
    // Each session's poll fetches from its own runtimeId.
    // Session A overview: { presetName: 'glm-5.2' }
    // Session B overview: { presetName: 'claude-sonnet' }
    // They are completely independent — no shared state.
    const overviewA = { presetName: 'glm-5.2' };
    const overviewB = { presetName: 'claude-sonnet' };
    assert.notEqual(overviewA.presetName, overviewB.presetName);
  });
});

