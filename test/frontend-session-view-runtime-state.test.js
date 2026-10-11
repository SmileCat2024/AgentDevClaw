/**
 * SessionView ownership tests for runtime notification and tool progress.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

function loadRuntimeState() {
  const ctx = createFrontendSandbox({
    t: (key) => key,
    currentLanguage: 'en',
    currentMessages: [],
    currentRuntimeAgentId: 'runtime-1',
    _switchEpoch: 1,
    currentHookInspector: null,
    currentOverviewSnapshot: {},
    currentTodoPlan: {},
    _lastRenderedNotificationRuntime: null,
    _lastCallFinishTime: 0,
    _recapPendingTrigger: false,
    _pendingQueuedCount: 0,
    getNotificationActionSource: (payload) => payload?.state || null,
    getNotificationCallStartedAt: (payload) => payload?.runtime?.callStartedAt || 0,
    getEffectiveRuntimeSnapshot: (payload) => payload?.runtime || {},
    getCompactRuntimeLabel: () => '',
    shouldShowRuntimeStatus: () => false,
    shouldStatusUseQueueSync: () => false,
    isSuspendedCallOutcome: (value) => value?.status === 'continued' && value?.reason === 'suspended',
    isRuntimeCalling: (id) => false,
    getRuntimeStageClass: () => '',
    renderRuntimeTimer: () => '',
    focusedAgentId: 'agent-1',
    currentInputRequests: [],
    toolRenderConfigs: {},
    currentHookInspector: null,
    currentOverviewSnapshot: {},
    currentTodoPlan: {},
    TOOL_NAMES: {},
    _agentCallActive: new Map(),
    _agentSuspended: new Map(),
    getCurrentHostAgentRecord: () => ({ id: 'agent-1' }),
    getEmptyOverviewSnapshot: () => ({}),
    getEmptyTodoPlan: () => ({}),
    setCurrentHookInspector() {},
    setCurrentOverviewSnapshot() {},
    setCurrentTodoPlan() {},
    notifyInputSurfaceChanged() {},
    getCurrentAgentRecord: () => ({ id: 'agent-1' }),
    getRuntimeRecord: () => null,
    getLogicalAgentId: (record) => record?.id,
    getActiveSessionId: (record) => record?.sessionId,
    normalizeAgentIdentity: (value) => String(value || '').trim(),
    renderAgentList() {},
    clearInterruptSuppression() {},
    isInterruptSuppressed: () => false,
    _markAgentCallStartedForNotify() {},
    _syncPersistentActionButton() {},
    _syncPersistentInputUi() {},
    _syncQueueFromBackend() {},
    _renderLastCallElapsed() {},
    _tryNotifyAgentFinished() {},
    ensureChatRuntimeIndicator() {},
    runWithSuppressedChatViewportObservers(fn) { fn(); },
    escapeHtml: (value) => String(value),
  });
  ctx.window.setInterval = () => 0;
  ctx.loadSource('public/src/modules/session-view-state.js');
  ctx.loadSource('public/src/modules/tool-progress.js');
  ctx.loadSource('public/src/modules/runtime-status.js');
  ctx.run(`applySessionViewPatch({ identity: { agentId: 'agent-1', sessionId: 'session-a' } })`);
  return ctx;
}

describe('SessionView runtime status ownership', () => {
  it('does not commit a notification captured for the previous session on the same runtime', () => {
    const ctx = loadRuntimeState();
    ctx.run('globalThis.token = captureSessionViewToken("runtime-1")');
    ctx.run(`applySessionViewPatch({ identity: { agentId: 'agent-1', sessionId: 'session-b' } })`);
    ctx.run(`updateNotificationStatus({ callActive: true, runtime: { callActive: true, stage: 'llm_thinking' }, state: { type: 'tool.progress', data: { callId: 'stale-call', toolName: 'bash' } } }, 'runtime-1', token)`);
    assert.equal(ctx.run('_agentCallActive.has("runtime-1")'), false);
    assert.equal(ctx.run('lastNotificationStatusPayload'), null);
    assert.equal(ctx.run('resolveToolProgressForCall({ id: "stale-call" })'), null);
  });

  it('keeps tool progress bound to the SessionView where its notification was accepted', () => {
    const ctx = loadRuntimeState();
    ctx.run(`updateNotificationStatus({ state: { type: 'tool.progress', data: { callId: 'call-a', toolName: 'bash', startedAt: Date.now(), outputTail: 'session a' } } })`);
    assert.equal(ctx.run('resolveToolProgressForCall({ id: "call-a" })?.outputTail'), 'session a');
    ctx.run(`applySessionViewPatch({ identity: { agentId: 'agent-1', sessionId: 'session-b' } })`);
    assert.equal(ctx.run('resolveToolProgressForCall({ id: "call-a" })'), null);
    ctx.run(`updateNotificationStatus({ state: { type: 'tool.progress', data: { callId: 'call-b', toolName: 'bash', startedAt: Date.now(), outputTail: 'session b' } } })`);
    assert.equal(ctx.run('resolveToolProgressForCall({ id: "call-a" })'), null);
    assert.equal(ctx.run('resolveToolProgressForCall({ id: "call-b" })?.outputTail'), 'session b');
  });

  it('preserves call-finish suspension semantics and clears the matching tool progress', () => {
    const ctx = loadRuntimeState();
    ctx.run(`updateNotificationStatus({ callActive: true, runtime: { callActive: true, stage: 'tool_executing' }, state: { type: 'tool.progress', data: { callId: 'call-a', toolName: 'bash' } } })`);
    ctx.run(`updateNotificationStatus({ callActive: false, runtime: { callActive: false, lastOutcome: { status: 'continued', reason: 'suspended' } }, state: { type: 'call.finish', data: { status: 'continued', reason: 'suspended' } } })`);
    assert.equal(ctx.run('_agentSuspended.get("runtime-1")'), true);
    assert.equal(ctx.run('resolveToolProgressForCall({ id: "call-a" })'), null);
    ctx.run('globalThis.sessionAfterFinish = readCurrentSessionViewState().identity.sessionId');
    assert.equal(ctx.run('sessionAfterFinish'), 'session-a');
  });
});
