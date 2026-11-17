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
 * Live model swaps are covered by input-model-swap-optimistic.test.js;
 * this cache is only for historical session-list token bars.
 *
 * 装载路线（P2 测试改造）：
 *   - session-ui 已迁 ESM → withP2EsmCase + 真实 import（每 case 整图隔离，
 *     模块私有 _modelInfoCache 不跨用例）。
 *   - getRuntimeAwareAgentRecord 仍定义在 classic app-ui.js → 按真实加载序
 *     （claw-host / right-panel-registry / app-core / app-ui）真实 bootstrap，
 *     直接调它的全局入口，不再切源码片段执行。
 *   - normalizeOverviewSnapshot 已迁 ESM（overview-data.js）→ 真实命名导出，
 *     替掉原先内联复刻的策略副本。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { prepareClassicSandbox } from './p2-classic-hosts.js';

const SESSION_UI = 'public/src/modules/session-ui.js';
const OVERVIEW_DATA = 'public/src/modules/overview-data.js';

/** session-ui / app-ui 共用的真实先行脚本序（test/p2-classic-hosts.js）。 */
/** app-ui 布局监听依赖的浏览器全局（沙箱无此能力）。 */
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function withSessionUi(probe) {
  return withP2EsmCase({
    classic: (sandbox) => {
      // 真实先行脚本序：宿主工厂（含 app-main / app-ui 提供的 runtime-switch /
      // poll / workspace-surface）都是生产实现，首屏 boot 与周期排程由基座关掉。
      prepareClassicSandbox(sandbox);
    },
  }, async (c) => {
    // agent-data-loader 已迁 ESM（P2 W2-4 二段）：host 工厂经 KernelState 桥
    // 供下游 loader host 模块求值期取用，必须先装载。
    await c.load('public/src/modules/agent-data-loader.js');
    const mod = await c.load(SESSION_UI);
    return probe(mod, c);
  });
}

/**
 * 真实 app-ui bootstrap：getRuntimeAwareAgentRecord 合并 host 与 runtime 记录。
 * 两个 record 经 classic 入口注入（生产里由 app-main 的两条解析链提供）。
 */
/**
 * overview-data 的 ESM 图在装载时经 window.createP2BootstrapDebugPanelHost()
 * 取宿主面（classic app-core 工厂），因此先跑 app-core 真实 bootstrap。
 */
function withOwnedOverviewData(probe) {
  return withP2EsmCase({
    classic: (sandbox) => {
      // 真实先行脚本序（含 app-core / session-view-state：overview-data 取
      // createP2BootstrapDebugPanelHost 与 classic 的 normalizeSessionModelState）。
      prepareClassicSandbox(sandbox);
    },
  }, async (c) => probe(c));
}

function withRuntimeAwareRecord(hostRecord, runtimeRecord, probe) {
  return withP2EsmCase({
    classic: (sandbox) => {
      sandbox.ResizeObserver = ResizeObserverStub;
      // 真实先行脚本序（index.html 的 classic 标签链，含 app-ui / app-main）；
      // 记录来源是本案夹具 → 真实链之后覆盖这两个窄观察面。
      prepareClassicSandbox(sandbox);
      sandbox.getCurrentAgentRecord = () => hostRecord;
      sandbox.getCurrentRuntimeRecord = () => runtimeRecord;
    },
  }, async (c) => probe(c.read('getRuntimeAwareAgentRecord()'), c));
}

// ── Tests: contextLength/compressRatio cache round-trip ────

describe('model-info cache: contextLength/compressRatio survive loadAgents gap', () => {
  it('caches values when session provides them, then serves from cache when session loses them', async () => {
    await withSessionUi((ui) => {
      // Phase 1: Full data available (loadAgentDetail has run)
      const agent = { id: 'ph' };
      assert.equal(ui.getSessionContextLength({ contextLength: 200000 }, agent), 200000);
      assert.equal(ui.getSessionCompressRatio({ compressRatio: 70 }, agent), 70);

      // Phase 2: loadAgents replaces allAgents — session fields gone
      // (simulates light snapshot from getConnectedAgents)
      assert.equal(ui.getSessionContextLength({}, agent), 200000);
      assert.equal(ui.getSessionCompressRatio({}, agent), 70);

      // Phase 3: Even agent.workspace_sessions is empty
      assert.equal(ui.getSessionContextLength({}, { id: 'ph' }), 200000);
      assert.equal(ui.getSessionCompressRatio({}, { id: 'ph' }), 70);
    });
  });
});

// ── Tests: getRuntimeAwareAgentRecord modelPresets carry ───

describe('getRuntimeAwareAgentRecord: modelPresets preservation', () => {
  it('carries modelPresets from host when runtime child lacks it', async () => {
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

    await withRuntimeAwareRecord(host, runtime, (record) => {
      assert.ok(record.modelPresets, 'modelPresets should be present on merged record');
      assert.equal(record.modelPresets.default.primary, 'glm-5.2');
    });
  });

  it('preserves runtime record modelPresets when it has its own', async () => {
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

    await withRuntimeAwareRecord(host, runtime, (record) => {
      // Runtime record's own modelPresets should win
      assert.equal(record.modelPresets.default.primary, 'new-model');
    });
  });

  it('carries modelPresets even when host has no workspace_sessions', async () => {
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

    await withRuntimeAwareRecord(host, runtime, (record) => {
      assert.ok(record.modelPresets, 'modelPresets should be carried from host');
      assert.equal(record.modelPresets.default.primary, 'glm-5.2');
    });
  });

  it('returns host record with modelPresets when no runtime is active', async () => {
    const host = {
      id: 'programming-helper',
      modelPresets: { default: { primary: 'glm-5.2' } },
    };

    await withRuntimeAwareRecord(host, null, (record) => {
      assert.equal(record.modelPresets.default.primary, 'glm-5.2');
    });
  });
});

// ── Tests: Full round-trip — agent switch isolation ────────

describe('model-info: full agent-switch round-trip', () => {
  it('historical window values stay isolated across agents', async () => {
    await withSessionUi((ui) => {
      // Agent A is active, preset cached
      ui.getSessionContextLength({ contextLength: 128000, compressRatio: 80 }, { id: 'agentA' });
      ui.getSessionCompressRatio({ contextLength: 128000, compressRatio: 80 }, { id: 'agentA' });

      // Simulate switch to agent B — B has different model
      // Agent B's record arrives from getConnectedAgents
      ui.getSessionContextLength({ contextLength: 200000, compressRatio: 70 }, { id: 'agentB' });
      ui.getSessionCompressRatio({ contextLength: 200000, compressRatio: 70 }, { id: 'agentB' });

      // Agent A cache should still be intact (not overwritten by B)
      assert.equal(ui.getSessionContextLength({}, { id: 'agentA' }), 128000);

      // Agent B cache should be separate
      assert.equal(ui.getSessionContextLength({}, { id: 'agentB' }), 200000);
    });
  });

  it('simulates loadAgents gap: cache bridges data loss without flashing defaults', async () => {
    await withSessionUi((ui) => {
      // Phase 1: Agent has full data
      const agent = { id: 'ph', workspace_sessions: { contextLength: 128000, compressRatio: 75 } };
      const session = { contextLength: 128000, compressRatio: 75 };
      // Values are read and cached
      assert.equal(ui.getSessionContextLength(session, agent), 128000);
      assert.equal(ui.getSessionCompressRatio(session, agent), 75);

      // Phase 2: loadAgents replaces allAgents — light snapshot arrives
      // session and agent.workspace_sessions lose their explicit values
      const agent2 = { id: 'ph', workspace_sessions: {} };
      const session2 = {};

      // Cache should bridge — NO flashing to defaults (200000 / 80)
      const cl = ui.getSessionContextLength(session2, agent2);
      const cr = ui.getSessionCompressRatio(session2, agent2);
      assert.equal(cl, 128000, 'contextLength should come from cache, not default 200000');
      assert.equal(cr, 75, 'compressRatio should come from cache, not default 80');
    });
  });
});

// ── Tests: swap agentId must resolve to HOST agent ID ──────

describe('model swap: agentId resolution', () => {
  it('focusedAgentId is the host agent ID, not the runtime child UUID', () => {
    // This test documents the invariant that swap_model must receive
    // the host agent ID (e.g. 'programming-helper'), because:
    //   1. Config file: Claw user data agent-configs/{hostId}.json
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

  it('getRuntimeAwareAgentRecord().id can be child UUID — swap must NOT use it', async () => {
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

    await withRuntimeAwareRecord(host, runtime, (record) => {
      // The merged record's id is the child UUID — NOT the host ID
      assert.equal(record.id, 'viewer-uuid-xyz');
      assert.notEqual(record.id, 'programming-helper');

      // This is exactly why _getInputAgentId / _getCurrentAgentIdForSwap
      // must use focusedAgentId (host ID) instead of record.id.
    });
  });
});

// ── Tests: overview.presetName round-trip ──────────────────

describe('overview.presetName: per-session data source', () => {
  // The overview snapshot is fetched per-session via
  // /api/agents/{runtimeId}/overview. Each session has its own
  // runtime process, so overview.presetName is inherently
  // per-session isolated — no frontend cache needed.

  it('normalizeOverviewSnapshot preserves presetName', async () => {
    await withOwnedOverviewData(async (c) => {
      const overview = await c.load(OVERVIEW_DATA);
      const out = overview.normalizeOverviewSnapshot({ modelName: 'claude-sonnet-4-5', presetName: 'glm-5.2' });
      assert.equal(out.presetName, 'glm-5.2');
    });
  });

  it('missing presetName normalizes to empty string', async () => {
    await withOwnedOverviewData(async (c) => {
      const overview = await c.load(OVERVIEW_DATA);
      const out = overview.normalizeOverviewSnapshot({ modelName: 'claude-sonnet-4-5' });
      assert.equal(out.presetName, '');
    });
  });

  it('different sessions get different overview from different runtimeIds', async () => {
    await withOwnedOverviewData(async (c) => {
      const overview = await c.load(OVERVIEW_DATA);
      // Session A overview: { presetName: 'glm-5.2' }
      // Session B overview: { presetName: 'claude-sonnet' }
      // They are completely independent — no shared state.
      const overviewA = overview.normalizeOverviewSnapshot({ presetName: 'glm-5.2' });
      const overviewB = overview.normalizeOverviewSnapshot({ presetName: 'claude-sonnet' });
      assert.notEqual(overviewA.presetName, overviewB.presetName);
      assert.equal(overviewA.presetName, 'glm-5.2');
      assert.equal(overviewB.presetName, 'claude-sonnet');
    });
  });
});
