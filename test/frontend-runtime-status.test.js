/**
 * Tests for public/src/modules/runtime-status.js
 *
 * Covers pure and near-pure functions:
 *   - formatRuntimeDuration / formatRuntimeCompactNumber (number formatting)
 *   - getRuntimeStageClass (stage → CSS class)
 *   - normalizeNotificationRuntimeSnapshot (snapshot normalization)
 *   - resolveNotificationCallingState (call-active derivation)
 *   - getDerivedStageFromState (state-type → stage mapping)
 *   - getNotificationActionSource (event vs state selection)
 *   - shouldStatusUseQueueSync (queue sync predicate)
 *   - summarizeRuntimeToolNames (tool name summary)
 *   - buildSyntheticRuntimeEntry (synthetic runtime construction)
 *   - shouldShowRuntimeStatus / getRuntimeTimerLabel (display predicates)
 *   - getRuntimeStageLabel / getCompactRuntimeLabel / getRuntimeSummary (labels)
 *   - getPendingToolCallsFromMessages (pending tool detection)
 *   - isRuntimeCalling (call-active lookup)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deepEqual as deepLoose } from 'node:assert';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

/**
 * Create a sandbox with runtime-status.js loaded.
 *
 * The module calls ensureNotificationClockTimer() at load time, which invokes
 * window.setInterval. We stub it to a no-op to avoid leaking real timers.
 */
function loadRuntimeStatus(overrides = {}) {
  const defaults = {
    t: (key) => key,
    currentLanguage: 'zh',
    currentMessages: [],
    normalizeAgentIdentity: (x) => String(x || '').trim(),
    _agentCallActive: new Map(),
  };
  const ctx = createFrontendSandbox({ ...defaults, ...overrides });
  ctx.window.setInterval = () => 0;
  ctx.loadSource('public/src/modules/runtime-status.js');
  return ctx;
}

// ── formatRuntimeDuration ───────────────────────────────────

describe('runtime-status: formatRuntimeDuration', () => {
  it('0 ms → "0s"', () => {
    const ctx = loadRuntimeStatus();
    assert.equal(ctx.run('formatRuntimeDuration(0)'), '0s');
  });

  it('1 second → "1s"', () => {
    const ctx = loadRuntimeStatus();
    assert.equal(ctx.run('formatRuntimeDuration(1000)'), '1s');
  });

  it('45 seconds → "45s"', () => {
    const ctx = loadRuntimeStatus();
    assert.equal(ctx.run('formatRuntimeDuration(45000)'), '45s');
  });

  it('59 seconds → "59s"', () => {
    const ctx = loadRuntimeStatus();
    assert.equal(ctx.run('formatRuntimeDuration(59000)'), '59s');
  });

  it('60 seconds → "1m 0s"', () => {
    const ctx = loadRuntimeStatus();
    assert.equal(ctx.run('formatRuntimeDuration(60000)'), '1m 0s');
  });

  it('65 seconds → "1m 5s"', () => {
    const ctx = loadRuntimeStatus();
    assert.equal(ctx.run('formatRuntimeDuration(65000)'), '1m 5s');
  });

  it('1 hour 1 minute → "1h 1m"', () => {
    const ctx = loadRuntimeStatus();
    assert.equal(ctx.run('formatRuntimeDuration(3660000)'), '1h 1m');
  });

  it('NaN → "0s"', () => {
    const ctx = loadRuntimeStatus();
    assert.equal(ctx.run('formatRuntimeDuration(NaN)'), '0s');
  });

  it('negative → "0s" (clamped)', () => {
    const ctx = loadRuntimeStatus();
    assert.equal(ctx.run('formatRuntimeDuration(-5000)'), '0s');
  });
});

// ── formatRuntimeCompactNumber ──────────────────────────────

describe('runtime-status: formatRuntimeCompactNumber', () => {
  it('0 → "0"', () => {
    const ctx = loadRuntimeStatus();
    assert.equal(ctx.run('formatRuntimeCompactNumber(0)'), '0');
  });

  it('42 → "42"', () => {
    const ctx = loadRuntimeStatus();
    assert.equal(ctx.run('formatRuntimeCompactNumber(42)'), '42');
  });

  it('NaN → "0"', () => {
    const ctx = loadRuntimeStatus();
    assert.equal(ctx.run('formatRuntimeCompactNumber(NaN)'), '0');
  });

  it('Infinity → "0"', () => {
    const ctx = loadRuntimeStatus();
    assert.equal(ctx.run('formatRuntimeCompactNumber(Infinity)'), '0');
  });

  it('-5 → "-5"', () => {
    const ctx = loadRuntimeStatus();
    assert.equal(ctx.run('formatRuntimeCompactNumber(-5)'), '-5');
  });
});

// ── getRuntimeStageClass ────────────────────────────────────

describe('runtime-status: getRuntimeStageClass', () => {
  it('idle → "stage-idle"', () => {
    const ctx = loadRuntimeStatus();
    assert.equal(ctx.run('getRuntimeStageClass({ stage: "idle" })'), 'stage-idle');
  });

  it('thinking → "stage-thinking"', () => {
    const ctx = loadRuntimeStatus();
    assert.equal(ctx.run('getRuntimeStageClass({ stage: "thinking" })'), 'stage-thinking');
  });

  it('llm_content → "stage-llm_content" (underscore preserved)', () => {
    const ctx = loadRuntimeStatus();
    assert.equal(ctx.run('getRuntimeStageClass({ stage: "llm_content" })'), 'stage-llm_content');
  });

  it('failed → "stage-failed"', () => {
    const ctx = loadRuntimeStatus();
    assert.equal(ctx.run('getRuntimeStageClass({ stage: "failed" })'), 'stage-failed');
  });

  it('null → "stage-idle" (default)', () => {
    const ctx = loadRuntimeStatus();
    assert.equal(ctx.run('getRuntimeStageClass(null)'), 'stage-idle');
  });

  it('empty object → "stage-idle"', () => {
    const ctx = loadRuntimeStatus();
    assert.equal(ctx.run('getRuntimeStageClass({})'), 'stage-idle');
  });
});

// ── normalizeNotificationRuntimeSnapshot ────────────────────

describe('runtime-status: normalizeNotificationRuntimeSnapshot', () => {
  it('null → all defaults', () => {
    const ctx = loadRuntimeStatus();
    const result = ctx.run('normalizeNotificationRuntimeSnapshot(null)');
    deepLoose(result, {
      stage: 'idle',
      callActive: false,
      charCount: 0,
      thinkingChars: 0,
      contentChars: 0,
      toolCallCount: 0,
      activeToolNames: [],
      activeToolCount: 0,
      callStartedAt: 0,
      stageStartedAt: 0,
      retryAttempt: undefined,
      maxRetries: undefined,
      nextRetryDelayMs: undefined,
      updatedAt: 0,
      lastErrorType: null,
      lastErrorMessage: null,
    });
  });

  it('preserves provided fields', () => {
    const ctx = loadRuntimeStatus();
    const result = ctx.run(`normalizeNotificationRuntimeSnapshot({
      stage: 'llm_thinking', callActive: true, charCount: 500,
      thinkingChars: 200, toolCallCount: 3, updatedAt: 12345,
      lastErrorType: 'rate_limit', lastErrorMessage: 'Too many requests',
    })`);
    assert.equal(result.stage, 'llm_thinking');
    assert.equal(result.callActive, true);
    assert.equal(result.charCount, 500);
    assert.equal(result.toolCallCount, 3);
    assert.equal(result.updatedAt, 12345);
    assert.equal(result.lastErrorType, 'rate_limit');
    assert.equal(result.lastErrorMessage, 'Too many requests');
  });

  it('filters falsy tool names', () => {
    const ctx = loadRuntimeStatus();
    const result = ctx.run(`normalizeNotificationRuntimeSnapshot({
      activeToolNames: ['read', null, '', 'write', undefined],
    })`);
    deepLoose(result.activeToolNames, ['read', 'write']);
  });

  it('non-array activeToolNames → []', () => {
    const ctx = loadRuntimeStatus();
    const result = ctx.run(`normalizeNotificationRuntimeSnapshot({ activeToolNames: 'not-array' })`);
    deepLoose(result.activeToolNames, []);
  });
});

// ── resolveNotificationCallingState ─────────────────────────

describe('runtime-status: resolveNotificationCallingState', () => {
  it('runtime.callActive true → true', () => {
    const ctx = loadRuntimeStatus();
    assert.equal(ctx.run('resolveNotificationCallingState({ runtime: { callActive: true } })'), true);
  });

  it('runtime.callActive false → false', () => {
    const ctx = loadRuntimeStatus();
    assert.equal(ctx.run('resolveNotificationCallingState({ runtime: { callActive: false } })'), false);
  });

  it('state.type call.start → true', () => {
    const ctx = loadRuntimeStatus();
    assert.equal(ctx.run('resolveNotificationCallingState({ state: { type: "call.start" } })'), true);
  });

  it('state.type call.finish → false', () => {
    const ctx = loadRuntimeStatus();
    assert.equal(ctx.run('resolveNotificationCallingState({ state: { type: "call.finish" } })'), false);
  });

  it('top-level callActive true → true', () => {
    const ctx = loadRuntimeStatus();
    assert.equal(ctx.run('resolveNotificationCallingState({ callActive: true })'), true);
  });

  it('state.type llm.complete → false', () => {
    const ctx = loadRuntimeStatus();
    assert.equal(ctx.run('resolveNotificationCallingState({ state: { type: "llm.complete" } })'), false);
  });

  it('null → false', () => {
    const ctx = loadRuntimeStatus();
    assert.equal(ctx.run('resolveNotificationCallingState(null)'), false);
  });

  it('empty object → false', () => {
    const ctx = loadRuntimeStatus();
    assert.equal(ctx.run('resolveNotificationCallingState({})'), false);
  });
});

// ── getDerivedStageFromState ────────────────────────────────

describe('runtime-status: getDerivedStageFromState', () => {
  it('call.start → awaiting_runtime', () => {
    const ctx = loadRuntimeStatus();
    assert.equal(ctx.run('getDerivedStageFromState("call.start", null, "idle")'), 'awaiting_runtime');
  });

  it('call.finish → completed', () => {
    const ctx = loadRuntimeStatus();
    assert.equal(ctx.run('getDerivedStageFromState("call.finish", null, "idle")'), 'completed');
  });

  it('tool.start → tool_executing', () => {
    const ctx = loadRuntimeStatus();
    assert.equal(ctx.run('getDerivedStageFromState("tool.start", null, "idle")'), 'tool_executing');
  });

  it('tool.complete from tool_executing → awaiting_runtime', () => {
    const ctx = loadRuntimeStatus();
    assert.equal(ctx.run('getDerivedStageFromState("tool.complete", null, "tool_executing")'), 'awaiting_runtime');
  });

  it('tool.complete from idle → idle (unchanged)', () => {
    const ctx = loadRuntimeStatus();
    assert.equal(ctx.run('getDerivedStageFromState("tool.complete", null, "idle")'), 'idle');
  });

  it('llm.char_count phase thinking → llm_thinking', () => {
    const ctx = loadRuntimeStatus();
    assert.equal(ctx.run('getDerivedStageFromState("llm.char_count", { phase: "thinking" }, "idle")'), 'llm_thinking');
  });

  it('llm.char_count phase content → llm_content', () => {
    const ctx = loadRuntimeStatus();
    assert.equal(ctx.run('getDerivedStageFromState("llm.char_count", { phase: "content" }, "idle")'), 'llm_content');
  });

  it('llm.char_count phase tool_calling → llm_tool_call_building', () => {
    const ctx = loadRuntimeStatus();
    assert.equal(ctx.run('getDerivedStageFromState("llm.char_count", { phase: "tool_calling" }, "idle")'), 'llm_tool_call_building');
  });

  it('llm.complete from tool_executing → tool_executing', () => {
    const ctx = loadRuntimeStatus();
    assert.equal(ctx.run('getDerivedStageFromState("llm.complete", null, "tool_executing")'), 'tool_executing');
  });

  it('llm.complete from idle → awaiting_runtime', () => {
    const ctx = loadRuntimeStatus();
    assert.equal(ctx.run('getDerivedStageFromState("llm.complete", null, "idle")'), 'awaiting_runtime');
  });

  it('unknown type → currentStage', () => {
    const ctx = loadRuntimeStatus();
    assert.equal(ctx.run('getDerivedStageFromState("unknown", null, "thinking")'), 'thinking');
  });
});

// ── getNotificationActionSource ─────────────────────────────

describe('runtime-status: getNotificationActionSource', () => {
  it('state only → state', () => {
    const ctx = loadRuntimeStatus();
    const result = ctx.run('getNotificationActionSource({ state: { type: "a", timestamp: 100 } })');
    assert.equal(result.type, 'a');
  });

  it('event only → event', () => {
    const ctx = loadRuntimeStatus();
    const result = ctx.run('getNotificationActionSource({ event: { type: "b", timestamp: 200 } })');
    assert.equal(result.type, 'b');
  });

  it('both, event newer → event', () => {
    const ctx = loadRuntimeStatus();
    const result = ctx.run('getNotificationActionSource({ state: { type: "a", timestamp: 100 }, event: { type: "b", timestamp: 200 } })');
    assert.equal(result.type, 'b');
  });

  it('both, state newer → state', () => {
    const ctx = loadRuntimeStatus();
    const result = ctx.run('getNotificationActionSource({ state: { type: "a", timestamp: 200 }, event: { type: "b", timestamp: 100 } })');
    assert.equal(result.type, 'a');
  });

  it('null → null', () => {
    const ctx = loadRuntimeStatus();
    assert.equal(ctx.run('getNotificationActionSource(null)'), null);
  });
});

// ── shouldStatusUseQueueSync ────────────────────────────────

describe('runtime-status: shouldStatusUseQueueSync', () => {
  it('llm_thinking → true', () => {
    const ctx = loadRuntimeStatus();
    assert.equal(ctx.run('shouldStatusUseQueueSync({ stage: "llm_thinking" })'), true);
  });

  it('llm_content → true', () => {
    const ctx = loadRuntimeStatus();
    assert.equal(ctx.run('shouldStatusUseQueueSync({ stage: "llm_content" })'), true);
  });

  it('llm_tool_call_building → true', () => {
    const ctx = loadRuntimeStatus();
    assert.equal(ctx.run('shouldStatusUseQueueSync({ stage: "llm_tool_call_building" })'), true);
  });

  it('tool_executing → false', () => {
    const ctx = loadRuntimeStatus();
    assert.equal(ctx.run('shouldStatusUseQueueSync({ stage: "tool_executing" })'), false);
  });

  it('idle → false', () => {
    const ctx = loadRuntimeStatus();
    assert.equal(ctx.run('shouldStatusUseQueueSync({ stage: "idle" })'), false);
  });

  it('empty object → false', () => {
    const ctx = loadRuntimeStatus();
    assert.equal(ctx.run('shouldStatusUseQueueSync({})'), false);
  });
});

// ── summarizeRuntimeToolNames ───────────────────────────────

describe('runtime-status: summarizeRuntimeToolNames', () => {
  it('empty array → ""', () => {
    const ctx = loadRuntimeStatus();
    assert.equal(ctx.run('summarizeRuntimeToolNames([])'), '');
  });

  it('single tool → tool name', () => {
    const ctx = loadRuntimeStatus();
    assert.equal(ctx.run('summarizeRuntimeToolNames(["read"])'), 'read');
  });

  it('two tools → comma-separated', () => {
    const ctx = loadRuntimeStatus();
    assert.equal(ctx.run('summarizeRuntimeToolNames(["read", "write"])'), 'read, write');
  });

  it('three tools (zh) → first two + count', () => {
    const ctx = loadRuntimeStatus();
    assert.equal(ctx.run('summarizeRuntimeToolNames(["read", "write", "grep"])'), 'read, write +1个');
  });

  it('four tools (zh) → first two + count', () => {
    const ctx = loadRuntimeStatus();
    assert.equal(ctx.run('summarizeRuntimeToolNames(["read", "write", "grep", "ls"])'), 'read, write +2个');
  });

  it('three tools (en) → first two + count', () => {
    const ctx = loadRuntimeStatus({ currentLanguage: 'en' });
    assert.equal(ctx.run('summarizeRuntimeToolNames(["read", "write", "grep"])'), 'read, write +1');
  });

  it('not array → ""', () => {
    const ctx = loadRuntimeStatus();
    assert.equal(ctx.run('summarizeRuntimeToolNames(null)'), '');
  });

  it('filters falsy entries', () => {
    const ctx = loadRuntimeStatus();
    assert.equal(ctx.run('summarizeRuntimeToolNames([null, "", "read", undefined])'), 'read');
  });
});

// ── buildSyntheticRuntimeEntry ──────────────────────────────

describe('runtime-status: buildSyntheticRuntimeEntry', () => {
  it('valid agent → entry with correct fields', () => {
    const ctx = loadRuntimeStatus();
    const entry = ctx.run(`buildSyntheticRuntimeEntry({
      runtime_session_id: 'rt-1', id: 'ph', name: 'Programming Helper',
      active_workspace_display_name: 'My Session',
      active_workspace_session_id: 'sess-1', connected: true,
    })`);
    assert.equal(entry.id, 'rt-1');
    assert.equal(entry.runtimeId, 'rt-1');
    assert.equal(entry.ownerId, 'ph');
    assert.equal(entry.sessionId, 'sess-1');
    assert.equal(entry.name, 'My Session');
    assert.equal(entry.status, 'connected');
    assert.equal(entry.source, 'managed-runtime');
  });

  it('no runtime_session_id → null', () => {
    const ctx = loadRuntimeStatus();
    assert.equal(ctx.run('buildSyntheticRuntimeEntry({ id: "ph" })'), null);
  });

  it('connected false → null', () => {
    const ctx = loadRuntimeStatus();
    assert.equal(ctx.run('buildSyntheticRuntimeEntry({ runtime_session_id: "rt-1", connected: false })'), null);
  });

  it('fallback name from agent name', () => {
    const ctx = loadRuntimeStatus();
    const entry = ctx.run(`buildSyntheticRuntimeEntry({
      runtime_session_id: 'rt-1', id: 'ph', name: 'MyAgent',
    })`);
    assert.equal(entry.name, 'MyAgent Runtime');
  });
});

// ── shouldShowRuntimeStatus ─────────────────────────────────

describe('runtime-status: shouldShowRuntimeStatus', () => {
  it('callActive with expressive stage → true', () => {
    const ctx = loadRuntimeStatus();
    assert.equal(ctx.run('shouldShowRuntimeStatus({ callActive: true, stage: "llm_thinking" })'), true);
  });

  it('completed, recently updated → true', () => {
    const ctx = loadRuntimeStatus();
    assert.equal(ctx.run('shouldShowRuntimeStatus({ callActive: false, stage: "completed", updatedAt: Date.now() })'), true);
  });

  it('callActive false, idle → false', () => {
    const ctx = loadRuntimeStatus();
    assert.equal(ctx.run('shouldShowRuntimeStatus({ callActive: false, stage: "idle" })'), false);
  });

  it('failed, recently → true', () => {
    const ctx = loadRuntimeStatus();
    assert.equal(ctx.run('shouldShowRuntimeStatus({ callActive: false, stage: "failed", updatedAt: Date.now() })'), true);
  });

  it('stateType llm.char_count → true regardless', () => {
    const ctx = loadRuntimeStatus();
    assert.equal(ctx.run('shouldShowRuntimeStatus({ callActive: false, stage: "idle" }, "llm.char_count")'), true);
  });
});

// ── getRuntimeTimerLabel ────────────────────────────────────

describe('runtime-status: getRuntimeTimerLabel', () => {
  it('with stageStartedAt 5s ago → "5s"', () => {
    const ctx = loadRuntimeStatus();
    ctx.run('var rt = { stageStartedAt: Date.now() - 5000 }');
    assert.equal(ctx.run('getRuntimeTimerLabel(rt)'), '5s');
  });

  it('stageStartedAt 0 → "0s"', () => {
    const ctx = loadRuntimeStatus();
    assert.equal(ctx.run('getRuntimeTimerLabel({ stageStartedAt: 0 })'), '0s');
  });

  it('empty object → "0s"', () => {
    const ctx = loadRuntimeStatus();
    assert.equal(ctx.run('getRuntimeTimerLabel({})'), '0s');
  });
});

// ── getRuntimeStageLabel ────────────────────────────────────

describe('runtime-status: getRuntimeStageLabel', () => {
  it('llm_thinking → phase_thinking', () => {
    const ctx = loadRuntimeStatus();
    assert.equal(ctx.run('getRuntimeStageLabel({ stage: "llm_thinking" })'), 'phase_thinking');
  });

  it('llm_content → phase_content', () => {
    const ctx = loadRuntimeStatus();
    assert.equal(ctx.run('getRuntimeStageLabel({ stage: "llm_content" })'), 'phase_content');
  });

  it('llm_tool_call_building → phase_tool_calling', () => {
    const ctx = loadRuntimeStatus();
    assert.equal(ctx.run('getRuntimeStageLabel({ stage: "llm_tool_call_building" })'), 'phase_tool_calling');
  });

  it('tool_executing → phase_tool_executing', () => {
    const ctx = loadRuntimeStatus();
    assert.equal(ctx.run('getRuntimeStageLabel({ stage: "tool_executing" })'), 'phase_tool_executing');
  });

  it('completed → phase_completed', () => {
    const ctx = loadRuntimeStatus();
    assert.equal(ctx.run('getRuntimeStageLabel({ stage: "completed" })'), 'phase_completed');
  });

  it('failed → phase_failed', () => {
    const ctx = loadRuntimeStatus();
    assert.equal(ctx.run('getRuntimeStageLabel({ stage: "failed" })'), 'phase_failed');
  });

  it('idle, not callActive → ""', () => {
    const ctx = loadRuntimeStatus();
    assert.equal(ctx.run('getRuntimeStageLabel({ stage: "idle" })'), '');
  });

  it('idle, callActive → phase_processing', () => {
    const ctx = loadRuntimeStatus();
    assert.equal(ctx.run('getRuntimeStageLabel({ stage: "idle", callActive: true })'), 'phase_processing');
  });
});

// ── getCompactRuntimeLabel ──────────────────────────────────

describe('runtime-status: getCompactRuntimeLabel', () => {
  it('disconnected → runtime_status_disconnected', () => {
    const ctx = loadRuntimeStatus();
    assert.equal(ctx.run('getCompactRuntimeLabel({ stage: "llm_thinking" }, false)'), 'runtime_status_disconnected');
  });

  it('llm_thinking no chars (zh) → 思考中', () => {
    const ctx = loadRuntimeStatus();
    assert.equal(ctx.run('getCompactRuntimeLabel({ stage: "llm_thinking" }, true)'), '思考中');
  });

  it('llm_thinking with chars (zh) → 思考 N chars', () => {
    const ctx = loadRuntimeStatus();
    const result = ctx.run('getCompactRuntimeLabel({ stage: "llm_thinking", thinkingChars: 42 }, true)');
    assert.ok(result.includes('思考'));
    assert.ok(result.includes('42'));
    assert.ok(result.includes('runtime_unit_chars'));
  });

  it('llm_content no chars (zh) → 生成中', () => {
    const ctx = loadRuntimeStatus();
    assert.equal(ctx.run('getCompactRuntimeLabel({ stage: "llm_content" }, true)'), '生成中');
  });

  it('llm_tool_call_building → 准备工具', () => {
    const ctx = loadRuntimeStatus();
    assert.equal(ctx.run('getCompactRuntimeLabel({ stage: "llm_tool_call_building" }, true)'), '准备工具');
  });

  it('tool_executing with tools → 执行工具 · name', () => {
    const ctx = loadRuntimeStatus();
    assert.equal(ctx.run('getCompactRuntimeLabel({ stage: "tool_executing", activeToolNames: ["read"] }, true)'), '执行工具 · read');
  });

  it('failed → 请求失败', () => {
    const ctx = loadRuntimeStatus();
    assert.equal(ctx.run('getCompactRuntimeLabel({ stage: "failed" }, true)'), '请求失败');
  });

  it('completed → 已完成', () => {
    const ctx = loadRuntimeStatus();
    assert.equal(ctx.run('getCompactRuntimeLabel({ stage: "completed" }, true)'), '已完成');
  });

  it('callActive, toolCallCount>0, no active tools → 等待工具结果', () => {
    const ctx = loadRuntimeStatus();
    assert.equal(ctx.run('getCompactRuntimeLabel({ stage: "idle", callActive: true, toolCallCount: 1, activeToolCount: 0 }, true)'), '等待工具结果');
  });

  it('callActive, no tools → runtime_status_waiting_model', () => {
    const ctx = loadRuntimeStatus();
    assert.equal(ctx.run('getCompactRuntimeLabel({ stage: "idle", callActive: true }, true)'), 'runtime_status_waiting_model');
  });
});

// ── getRuntimeSummary ───────────────────────────────────────

describe('runtime-status: getRuntimeSummary', () => {
  it('disconnected → runtime_status_disconnected', () => {
    const ctx = loadRuntimeStatus();
    assert.equal(ctx.run('getRuntimeSummary({ stage: "llm_thinking" }, false)'), 'runtime_status_disconnected');
  });

  it('llm_thinking → runtime_status_thinking_active', () => {
    const ctx = loadRuntimeStatus();
    assert.equal(ctx.run('getRuntimeSummary({ stage: "llm_thinking" }, true)'), 'runtime_status_thinking_active');
  });

  it('llm_content → runtime_status_streaming_active', () => {
    const ctx = loadRuntimeStatus();
    assert.equal(ctx.run('getRuntimeSummary({ stage: "llm_content" }, true)'), 'runtime_status_streaming_active');
  });

  it('tool_executing with tools → includes tool name', () => {
    const ctx = loadRuntimeStatus();
    const result = ctx.run('getRuntimeSummary({ stage: "tool_executing", activeToolNames: ["read"] }, true)');
    assert.ok(result.includes('runtime_status_executing_tools'));
    assert.ok(result.includes('read'));
  });

  it('failed with lastErrorMessage → error message', () => {
    const ctx = loadRuntimeStatus();
    assert.equal(ctx.run('getRuntimeSummary({ stage: "failed", lastErrorMessage: "oops" }, true)'), 'oops');
  });

  it('failed without message → runtime_status_failed', () => {
    const ctx = loadRuntimeStatus();
    assert.equal(ctx.run('getRuntimeSummary({ stage: "failed" }, true)'), 'runtime_status_failed');
  });

  it('completed → runtime_status_completed', () => {
    const ctx = loadRuntimeStatus();
    assert.equal(ctx.run('getRuntimeSummary({ stage: "completed" }, true)'), 'runtime_status_completed');
  });

  it('callActive, no chars → runtime_status_waiting_model', () => {
    const ctx = loadRuntimeStatus();
    assert.equal(ctx.run('getRuntimeSummary({ stage: "idle", callActive: true, charCount: 0, contentChars: 0, thinkingChars: 0 }, true)'), 'runtime_status_waiting_model');
  });

  it('callActive, stale data → runtime_status_stale', () => {
    const ctx = loadRuntimeStatus();
    ctx.run('var rt = { stage: "idle", callActive: true, charCount: 100, updatedAt: Date.now() - 10000 }');
    assert.equal(ctx.run('getRuntimeSummary(rt, true)'), 'runtime_status_stale');
  });
});

// ── getPendingToolCallsFromMessages ─────────────────────────

describe('runtime-status: getPendingToolCallsFromMessages', () => {
  it('empty array → []', () => {
    const ctx = loadRuntimeStatus();
    deepLoose(ctx.run('getPendingToolCallsFromMessages([])'), []);
  });

  it('no toolCalls → []', () => {
    const ctx = loadRuntimeStatus();
    deepLoose(ctx.run('getPendingToolCallsFromMessages([{ role: "user", content: "hi" }])'), []);
  });

  it('pending tool call (no completion) → returned', () => {
    const ctx = loadRuntimeStatus();
    const result = ctx.run('getPendingToolCallsFromMessages([{ role: "assistant", toolCalls: [{ id: "t1", name: "read" }] }])');
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 't1');
  });

  it('completed tool call → filtered out', () => {
    const ctx = loadRuntimeStatus();
    const result = ctx.run('getPendingToolCallsFromMessages([{ role: "assistant", toolCalls: [{ id: "t1" }] }, { role: "tool", toolCallId: "t1" }])');
    assert.equal(result.length, 0);
  });

  it('partial completion → only pending returned', () => {
    const ctx = loadRuntimeStatus();
    const result = ctx.run('getPendingToolCallsFromMessages([{ role: "assistant", toolCalls: [{ id: "t1" }, { id: "t2" }] }, { role: "tool", toolCallId: "t1" }])');
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 't2');
  });
});

// ── isRuntimeCalling ────────────────────────────────────────

describe('runtime-status: isRuntimeCalling', () => {
  it('active runtime → true', () => {
    const ctx = loadRuntimeStatus({ _agentCallActive: new Map([['rt-1', true]]) });
    assert.equal(ctx.run('isRuntimeCalling("rt-1")'), true);
  });

  it('inactive runtime → false', () => {
    const ctx = loadRuntimeStatus({ _agentCallActive: new Map() });
    assert.equal(ctx.run('isRuntimeCalling("rt-2")'), false);
  });

  it('empty string → false (normalized to empty)', () => {
    const ctx = loadRuntimeStatus({ _agentCallActive: new Map([['', true]]) });
    assert.equal(ctx.run('isRuntimeCalling("")'), false);
  });

  it('null → false', () => {
    const ctx = loadRuntimeStatus({ _agentCallActive: new Map() });
    assert.equal(ctx.run('isRuntimeCalling(null)'), false);
  });
});
