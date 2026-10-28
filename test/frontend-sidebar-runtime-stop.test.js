/**
 * Tests for the archived source runtime optimistic retirement in the sidebar.
 *
 * 覆盖（精简/摘要/分支/归档共用链路）：
 *   - markPendingRuntimeStop 后侧栏投影立即隐藏源 runtime 条目（child 与宿主
 *     合成条目），兄弟条目与 operation 占位不受影响
 *   - reconcilePendingRuntimeStops：权威快照不再包含该实例时解除抑制；
 *     时间流逝不代表失败，同 Session 新实例不受旧关闭意图影响
 *   - reconcileArchivedSourceRuntime：确认退役后协调呈现，不再补发 stop；
 *     读取失败不能撤销已确认的关闭
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

class FakeDate extends Date {}
let clockOffsetMs = 0;
FakeDate.now = () => Date.now() + clockOffsetMs;

function createStopSandbox(overrides = {}) {
  const defaults = {
    t: (key) => key,
    currentLanguage: 'zh',
    currentMessages: [],
    normalizeAgentIdentity: (x) => String(x || '').trim(),
    getPathLeaf: (value) => String(value || '').replace(/\\/g, '/').split('/').filter(Boolean).pop() || '',
    toEpochMs: (value) => Date.parse(value || '') || 0,
    _agentCallActive: new Map(),
    renderCount: 0,
    Date: FakeDate,
    getParentAgentId: (record) => record?.parent_id || record?.parentId || null,
    getRuntimeId: (record) => (record && (record.source === 'child' || record.source === 'external') ? record.id : null) || null,
    getActiveSessionId: (record) =>
      record?.workspace_sessions?.activeSessionId
      ?? record?.active_workspace_session_id
      ?? record?.sessionId
      ?? null,
  };
  const ctx = createFrontendSandbox({ ...defaults, ...overrides });
  ctx.window.setInterval = () => 0;
  ctx.getWorkspaceSessions = (agent) => (
    Array.isArray(agent?.workspace_sessions?.sessions) ? agent.workspace_sessions.sessions : []
  );
  ctx.updateAgentRecord = (agentId, updates = {}) => {
    let matched = null;
    ctx.allAgents = ctx.allAgents.map((agent) => {
      if (agent.id !== agentId) return agent;
      matched = { ...agent, ...updates };
      return matched;
    });
    return matched;
  };
  ctx.renderCurrentMainView = () => { ctx.renderCount += 1; };
  ctx.renderAgentList = () => { ctx.renderCount += 1; };
  ctx.clearAgentRuntimeCache = () => {};
  ctx.refreshSidebarRuntimeAfterMutation = async () => {};
  ctx.invoke = async () => {};
  ctx.loadSource('public/src/modules/sidebar-operations.js');
  ctx.loadSource('public/src/modules/session-mutation.js');
  ctx.loadSource('public/src/modules/runtime-status.js');
  return ctx;
}

const HOST = `{
  id: 'programming-helper', source: 'prebuilt',
  workspace_sessions: { sessions: [] }
}`;

const SOURCE_CHILD = `{
  id: 'runtime-1', source: 'child', parent_id: 'programming-helper',
  sessionType: 'main', sidebar_entry_id: 'programming-helper',
  runtime_session_id: 'runtime-1', active_workspace_session_id: 'session-1',
  created_at: '2026-01-01T00:00:01.000Z', connected: true
}`;

const SIBLING_CHILD = `{
  id: 'runtime-2', source: 'child', parent_id: 'programming-helper',
  sessionType: 'main', sidebar_entry_id: 'programming-helper',
  runtime_session_id: 'runtime-2', active_workspace_session_id: 'session-2',
  created_at: '2026-01-01T00:00:02.000Z', connected: true
}`;

describe('sidebar: archived source runtime optimistic retirement', () => {
  it('hides the pending-stop child entry from the projection while siblings stay visible', () => {
    const ctx = createStopSandbox();
    const before = ctx.run(`collectRuntimeEntriesForPrebuilt(${HOST}, [${SOURCE_CHILD}, ${SIBLING_CHILD}])`);
    assert.equal(before.map((e) => e.runtimeId).sort().join(','), 'runtime-1,runtime-2');

    ctx.run(`markPendingRuntimeStop('programming-helper', 'session-1', 'runtime-1')`);
    const after = ctx.run(`collectRuntimeEntriesForPrebuilt(${HOST}, [${SOURCE_CHILD}, ${SIBLING_CHILD}])`);
    assert.equal(after.map((e) => e.runtimeId).join(','), 'runtime-2');
  });

  it('hides the host synthetic entry when the host primary runtime is pending stop', () => {
    const ctx = createStopSandbox();
    ctx.run(`markPendingRuntimeStop('programming-helper', 'session-1', 'runtime-1')`);
    const entries = ctx.run(`collectRuntimeEntriesForPrebuilt({
      id: 'programming-helper', source: 'prebuilt', runtime_session_id: 'runtime-1',
      active_workspace_session_id: 'session-1', active_workspace_display_name: 'Host Primary',
      workspace_sessions: { sessions: [] }
    }, [${SIBLING_CHILD}])`);
    assert.equal(entries.map((e) => e.runtimeId).join(','), 'runtime-2');
  });

  it('keeps operation placeholder entries visible while their source runtime is hidden', () => {
    const ctx = createStopSandbox();
    ctx.run(`
      markPendingRuntimeStop('programming-helper', 'session-1', 'runtime-1');
      beginSidebarOperation({
        operationId: 'trim:retirement', type: 'create', kind: 'trim', phase: 'generating',
        agentId: 'programming-helper', sourceSessionId: 'session-1',
        targetSessionId: 'session-new',
        projectDir: 'D:\\\\code\\\\project-a', projectName: 'project-a'
      });
    `);
    const entries = ctx.run(`collectRuntimeEntriesForPrebuilt(${HOST}, [${SOURCE_CHILD}])`);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].source, 'operation-pending');
    assert.equal(entries[0].name, '正在生成精简会话…');
  });

  it('releases the suppression once the polling snapshot no longer contains the runtime', () => {
    const ctx = createStopSandbox();
    ctx.run(`markPendingRuntimeStop('programming-helper', 'session-1', 'runtime-1')`);
    ctx.run(`reconcilePendingRuntimeStops([{ id: 'runtime-2', source: 'child', parent_id: 'programming-helper', runtime_session_id: 'runtime-2', active_workspace_session_id: 'session-2' }])`);
    assert.equal(ctx.run(`isRuntimeStopPending('programming-helper', 'session-1', 'runtime-1')`), false);
    const entries = ctx.run(`collectRuntimeEntriesForPrebuilt(${HOST}, [${SOURCE_CHILD}])`);
    assert.equal(entries.map((e) => e.runtimeId).join(','), 'runtime-1');
  });

  it('closing one instance does not hide a newly started instance of the same session', () => {
    const ctx = createStopSandbox();
    ctx.run(`markPendingRuntimeStop('programming-helper', 'session-1', 'runtime-1')`);
    assert.equal(ctx.run(`isRuntimeStopPending('programming-helper', 'session-1', 'runtime-new')`), false);
    ctx.run(`reconcilePendingRuntimeStops([{ id: 'runtime-new', source: 'child', parent_id: 'programming-helper', active_workspace_session_id: 'session-1' }])`);
    assert.equal(ctx.run(`isRuntimeStopPending('programming-helper', 'session-1', 'runtime-1')`), false);
  });

  it('keeps the suppression while the snapshot still contains the runtime', () => {
    const ctx = createStopSandbox();
    ctx.run(`markPendingRuntimeStop('programming-helper', 'session-1', 'runtime-1')`);
    ctx.run(`reconcilePendingRuntimeStops([{ id: 'runtime-1', source: 'child', parent_id: 'programming-helper', runtime_session_id: 'runtime-1', active_workspace_session_id: 'session-1' }])`);
    assert.equal(ctx.run(`isRuntimeStopPending('programming-helper', 'session-1', 'runtime-1')`), true);
    const entries = ctx.run(`collectRuntimeEntriesForPrebuilt(${HOST}, [${SOURCE_CHILD}])`);
    assert.equal(entries.length, 0);
  });

  it('keeps a pending close hidden until a receipt or authoritative snapshot, never a timer', () => {
    const ctx = createStopSandbox();
    ctx.run(`markPendingRuntimeStop('programming-helper', 'session-1', 'runtime-1')`);
    assert.equal(ctx.run(`isRuntimeStopPending('programming-helper', 'session-1', 'runtime-1')`), true);
    clockOffsetMs = 31000;
    try {
      assert.equal(ctx.run(`isRuntimeStopPending('programming-helper', 'session-1', 'runtime-1')`), true);
      ctx.run(`reconcilePendingRuntimeStops([{ id: 'runtime-1', source: 'child', parent_id: 'programming-helper', runtime_session_id: 'runtime-1', active_workspace_session_id: 'session-1' }])`);
      assert.equal(ctx.run(`collectRuntimeEntriesForPrebuilt(${HOST}, [${SOURCE_CHILD}])`).length, 0);
      ctx.run(`releasePendingRuntimeStop('runtime-1', 'programming-helper', 'session-1')`);
      assert.equal(ctx.run(`collectRuntimeEntriesForPrebuilt(${HOST}, [${SOURCE_CHILD}])`).length, 1);
    } finally {
      clockOffsetMs = 0;
    }
  });

  it('reconcileArchivedSourceRuntime hides retired entries without another stop request', async () => {
    const ctx = createStopSandbox();
    let stopCalls = 0;
    ctx.invoke = async (command, payload) => {
      stopCalls += 1;
      assert.equal(command, 'stop_agent');
      assert.equal(payload.agentId, 'programming-helper');
      assert.equal(payload.sessionId, 'session-1');
    };
    ctx.run(`reconcileArchivedSourceRuntime('programming-helper', 'session-1', 'runtime-1')`);
    assert.equal(ctx.run(`isRuntimeStopPending('programming-helper', 'session-1', 'runtime-1')`), true);
    const entries = ctx.run(`collectRuntimeEntriesForPrebuilt(${HOST}, [${SOURCE_CHILD}])`);
    assert.equal(entries.length, 0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(stopCalls, 0);
    // stop 成功返回后抑制保留，由轮询快照（reconcile）解除。
    assert.equal(ctx.run(`isRuntimeStopPending('programming-helper', 'session-1', 'runtime-1')`), true);
  });

  it('a failed projection refresh cannot undo confirmed archive retirement', async () => {
    const ctx = createStopSandbox();
    ctx.refreshSidebarRuntimeAfterMutation = async () => { throw new Error('refresh failed'); };
    ctx.console = { ...console, warn() {} };
    ctx.run(`reconcileArchivedSourceRuntime('programming-helper', 'session-1', 'runtime-1')`);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(ctx.run(`isRuntimeStopPending('programming-helper', 'session-1', 'runtime-1')`), true);
    assert.equal(ctx.run(`collectRuntimeEntriesForPrebuilt(${HOST}, [${SOURCE_CHILD}])`).length, 0);
  });
});
