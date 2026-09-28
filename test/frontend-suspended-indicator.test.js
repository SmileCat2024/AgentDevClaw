/**
 * ADR-0019 挂起等待的对话区指示块测试。
 *
 * 需求：call 以 continue（suspended）结束后、等待后台任务唤醒期间，消息区
 * 底部的运行状态指示块持续显示"等待中 + 已等待时长"，而不是随 call 结束
 * 消失。同时验证 calling 豁免：viewer-worker 在 call.start 不清理 lastOutcome，
 * 唤醒轮运行全程快照里残留旧挂起值，suspended 判定不得被其误触发。
 *
 * payload 形态与 ViewerWorker.getNotificationSnapshot 同构：
 *   - 挂起 finish：worker 侧 stage='cancelled'（continued 归入 cancelled 分支），
 *     前端展示阶段修正为 completed
 *   - 唤醒轮：runtime.lastOutcome 残留上一轮挂起值（跨 call 持久）
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

function loadRuntimeStatus() {
  const ctx = createFrontendSandbox({
    currentRuntimeAgentId: 'rt-focus',
    currentMessages: [],
    _agentCallActive: new Map(),
    normalizeAgentIdentity: (v) => String(v || '').trim(),
    isInterruptSuppressed: () => false,
    clearInterruptSuppression: () => {},
    getNotificationCallStartedAt: (p) => p?.runtime?.callStartedAt || 0,
    _markAgentCallStartedForNotify: () => {},
    _tryNotifyAgentFinished: () => {},
    renderAgentList: () => {},
    _syncPersistentActionButton: () => {},
    _syncPersistentInputUi: () => {},
    _syncQueueFromBackend: () => {},
    applyToolProgressNotification: () => {},
    _recapPendingTrigger: false,
    _maybeFetchRecap: () => {},
    _renderLastCallElapsed: () => {},
    runWithSuppressedChatViewportObservers: (fn) => fn(),
    getComputedStyle: () => ({}),
    getToolDisplayName: (name) => name,
    t: (key) => key,
  });
  ctx.loadSource('public/src/modules/runtime-status.js');
  return ctx;
}

// ── 真实快照形态（时间戳用真实时钟，settledRecently 窗口才有意义）────────────

function suspendedFinishPayload() {
  const finishAt = Date.now() - 3000;
  return {
    state: { type: 'call.finish', timestamp: finishAt, data: { status: 'continued', reason: 'suspended' } },
    event: null,
    runtime: {
      callActive: false, stage: 'cancelled', updatedAt: finishAt, callStartedAt: finishAt - 60000,
      lastOutcome: { status: 'continued', reason: 'suspended' },
    },
    callActive: false,
  };
}

// 唤醒轮开始：lastOutcome 残留旧挂起值（worker 在 call.start 不清理）
function wakeStartPayload() {
  const startAt = Date.now() - 2000;
  return {
    state: { type: 'call.start', timestamp: startAt, data: {} },
    event: null,
    runtime: {
      callActive: true, stage: 'awaiting_runtime', updatedAt: startAt, callStartedAt: startAt,
      lastOutcome: { status: 'continued', reason: 'suspended' },
    },
    callActive: true,
  };
}

// 唤醒轮表达性帧：callActive=true + lastOutcome 残留旧挂起值
function wakeCharCountPayload() {
  const at = Date.now() - 500;
  return {
    state: { type: 'llm.char_count', timestamp: at, data: { phase: 'thinking', charCount: 42 } },
    event: null,
    runtime: {
      callActive: true, stage: 'llm_thinking', updatedAt: at, callStartedAt: Date.now() - 2000,
      lastOutcome: { status: 'continued', reason: 'suspended' },
    },
    callActive: true,
  };
}

// 唤醒轮收尾窗口：llm.complete + 无 pending tool calls → stage=completed + callActive=true
function wakeLlmCompletePayload() {
  const at = Date.now() - 100;
  return {
    state: { type: 'llm.complete', timestamp: at, data: {} },
    event: null,
    runtime: {
      callActive: true, stage: 'llm_content', updatedAt: at, callStartedAt: Date.now() - 2000,
      lastOutcome: { status: 'continued', reason: 'suspended' },
    },
    callActive: true,
  };
}

// 正常运行轮首轮：用户输入触发的 call.start，无挂起残留
function normalStartPayload() {
  const startAt = Date.now() - 500;
  return {
    state: { type: 'call.start', timestamp: startAt, data: {} },
    event: null,
    runtime: {
      callActive: true, stage: 'awaiting_runtime', updatedAt: startAt, callStartedAt: startAt,
      lastOutcome: null,
    },
    callActive: true,
  };
}

// 唤醒轮聚合边沿：state 已是 call.start，但 runtime 快照尚未翻转 calling
//（callActive=false），lastOutcome 残留挂起值
function wakeStartCoalescedPayload() {
  const startAt = Date.now() - 500;
  return {
    state: { type: 'call.start', timestamp: startAt, data: {} },
    event: null,
    runtime: {
      callActive: false, stage: 'cancelled', updatedAt: startAt, callStartedAt: startAt,
      lastOutcome: { status: 'continued', reason: 'suspended' },
    },
    callActive: false,
  };
}

function completedFinishPayload() {
  const finishAt = Date.now() - 100;
  return {
    state: { type: 'call.finish', timestamp: finishAt, data: { status: 'completed', reason: 'completed' } },
    event: null,
    runtime: {
      callActive: false, stage: 'completed', updatedAt: finishAt, callStartedAt: Date.now() - 5000,
      lastOutcome: { status: 'completed', reason: 'completed' },
    },
    callActive: false,
  };
}

describe('挂起等待：对话区指示块（ADR-0019）', () => {
  let ctx;
  beforeEach(() => { ctx = loadRuntimeStatus(); });
  afterEach(() => { ctx.run('clearInterval(_notificationClockTimer); _notificationClockTimer = null;'); });

  it('挂起落定：指示块数据源保留，显示等待后台任务与已等待时长', () => {
    ctx.run(`updateNotificationStatus(${JSON.stringify(suspendedFinishPayload())})`);
    const rt = ctx.run('_lastRenderedNotificationRuntime');
    assert.ok(rt, '挂起落定后指示块数据源保留（不随 call 结束清空）');
    assert.equal(rt.suspended, true, 'suspended 置位');
    assert.equal(rt.stage, 'completed', 'stage 由 cancelled 归一化为 completed');

    const content = ctx.run('buildRuntimeIndicatorContent(_lastRenderedNotificationRuntime)');
    assert.ok(content, '指示块内容非空');
    assert.ok(content.main.includes('等待后台任务'), `主行含等待文案: ${content.main}`);
    assert.ok(/秒|s\b/.test(content.main), `主行含已等待时长: ${content.main}`);
  });

  it('静默超过终态展示窗口后：旧 call.finish 仍保持等待态', () => {
    const payload = suspendedFinishPayload();
    payload.runtime.updatedAt = Date.now() - 30000;
    payload.runtime.stageStartedAt = payload.runtime.updatedAt;
    ctx.run(`updateNotificationStatus(${JSON.stringify(payload)})`);
    const rt = ctx.run('_lastRenderedNotificationRuntime');
    assert.equal(rt?.suspended, true);
    assert.equal(ctx.run('shouldShowRuntimeStatus(_lastRenderedNotificationRuntime)'), true);
    assert.ok(ctx.run('buildRuntimeIndicatorContent(_lastRenderedNotificationRuntime)')?.main.includes('等待后台任务'));
  });

  it('静默轮询无事件：仅有 lastOutcome 的 cancelled 快照仍显示等待中及用时', () => {
    const finishAt = Date.now() - 30000;
    ctx.run(`updateNotificationStatus(${JSON.stringify({
      state: null, event: null, callActive: false,
      runtime: {
        callActive: false, stage: 'cancelled', updatedAt: finishAt, stageStartedAt: finishAt,
        lastOutcome: { status: 'continued', reason: 'suspended' },
      },
    })})`);
    const rt = ctx.run('_lastRenderedNotificationRuntime');
    assert.equal(rt?.suspended, true);
    assert.equal(rt?.stage, 'completed');
    assert.ok(ctx.run('buildRuntimeIndicatorContent(_lastRenderedNotificationRuntime)')?.main.includes('30 秒'));
  });

  it('挂起后有更新的非 call 事件：仍以 lastOutcome 展示等待态', () => {
    const payload = suspendedFinishPayload();
    payload.runtime.updatedAt = Date.now() - 30000;
    payload.runtime.stageStartedAt = payload.runtime.updatedAt;
    payload.event = { type: 'tool.progress', timestamp: Date.now() - 100, data: {} };
    ctx.run(`updateNotificationStatus(${JSON.stringify(payload)})`);
    assert.equal(ctx.run('_lastRenderedNotificationRuntime?.suspended'), true);
    assert.ok(ctx.run('buildRuntimeIndicatorContent(_lastRenderedNotificationRuntime)')?.main.includes('等待后台任务'));
  });

  it('挂起落定且消息带未完成工具 step：显示等待的工具明细', () => {
    ctx.currentMessages = [
      { role: 'user', content: '跑一下测试' },
      { role: 'assistant', toolCalls: [{ id: 'tc-1', name: 'bash', arguments: { command: 'npm test' } }] },
    ];
    ctx.run(`updateNotificationStatus(${JSON.stringify(suspendedFinishPayload())})`);
    const content = ctx.run('buildRuntimeIndicatorContent(_lastRenderedNotificationRuntime)');
    assert.ok(content.main.includes('等待 1 个后台任务'), `主行含等待数量: ${content.main}`);
    assert.ok(content.details.some((d) => d.includes('bash') && d.includes('npm test')),
      `明细含工具名与参数摘要: ${JSON.stringify(content.details)}`);
  });

  it('真完成落定：指示块不显示等待态（无回归）', () => {
    ctx.run(`updateNotificationStatus(${JSON.stringify(completedFinishPayload())})`);
    const rt = ctx.run('_lastRenderedNotificationRuntime');
    // 完成摘要窗口（800ms 内）数据源可能短暂存活（上栏"已完成"），但指示块
    // 内容判定必须为空：stage=completed 且非 suspended
    if (rt) {
      assert.equal(rt.suspended, false, '真完成不置挂起');
      assert.equal(ctx.run('buildRuntimeIndicatorContent(_lastRenderedNotificationRuntime)'), null,
        '指示块内容为空');
    }
    // 窗口过期后（updatedAt 超过 800ms）数据源照常清空
    const stale = completedFinishPayload();
    stale.runtime.updatedAt = Date.now() - 2000;
    ctx.run(`updateNotificationStatus(${JSON.stringify(stale)})`);
    assert.equal(ctx.run('_lastRenderedNotificationRuntime'), null, '摘要窗口外清空');
  });

  it('唤醒轮 call.start：挂起等待立即终止，指示块切换为运行态', () => {
    ctx.run(`updateNotificationStatus(${JSON.stringify(suspendedFinishPayload())})`);
    assert.ok(ctx.run('_lastRenderedNotificationRuntime'), '先处于挂起等待态');
    ctx.run(`updateNotificationStatus(${JSON.stringify(wakeStartPayload())})`);
    const rt = ctx.run('_lastRenderedNotificationRuntime');
    assert.ok(rt, 'call.start 后运行态数据源存在（首轮等待指示随 call.start 显示）');
    assert.equal(rt.suspended, false, '挂起标志终止');
    assert.equal(rt.stage, 'awaiting_runtime');
    const content = ctx.run('buildRuntimeIndicatorContent(_lastRenderedNotificationRuntime)');
    assert.ok(content.main.includes('等待响应'), `显示运行等待态: ${content.main}`);
    assert.ok(!content.main.includes('等待后台任务'), '等待后台任务文案不跨入运行轮');
  });

  it('唤醒轮聚合边沿（call.start + 快照 callActive=false + 挂起残留）：数据源清空', () => {
    ctx.run(`updateNotificationStatus(${JSON.stringify(suspendedFinishPayload())})`);
    assert.ok(ctx.run('_lastRenderedNotificationRuntime'), '先处于挂起等待态');
    ctx.run(`updateNotificationStatus(${JSON.stringify(wakeStartCoalescedPayload())})`);
    assert.equal(ctx.run('_lastRenderedNotificationRuntime'), null,
      '挂起残留数据源终止，等待后台任务文案不跨入运行轮');
  });

  it('正常运行轮首轮：call.start 后等待指示立即可见（回归）', () => {
    // 用户输入触发的第一个事件就是 call.start：此前实现无条件清空数据源，
    // 指示块要等首个 llm.char_count 才恢复，首轮"等待响应…"消失
    ctx.run(`updateNotificationStatus(${JSON.stringify(normalStartPayload())})`);
    const rt = ctx.run('_lastRenderedNotificationRuntime');
    assert.ok(rt, '首轮数据源存在');
    assert.equal(rt.stage, 'awaiting_runtime');
    assert.equal(rt.suspended, false);
    const content = ctx.run('buildRuntimeIndicatorContent(_lastRenderedNotificationRuntime)');
    assert.ok(content.main.includes('等待响应'), `首轮显示等待响应: ${content.main}`);
  });

  it('上一 call 真完成后新 call.start：等待指示随新一轮立即显示', () => {
    const staleFinish = completedFinishPayload();
    staleFinish.runtime.updatedAt = Date.now() - 2000;
    ctx.run(`updateNotificationStatus(${JSON.stringify(staleFinish)})`);
    assert.equal(ctx.run('_lastRenderedNotificationRuntime'), null, '上一轮数据源已清空');
    ctx.run(`updateNotificationStatus(${JSON.stringify(normalStartPayload())})`);
    const rt = ctx.run('_lastRenderedNotificationRuntime');
    assert.ok(rt, '新 call 首轮数据源立即建立');
    assert.equal(rt.stage, 'awaiting_runtime');
    assert.ok(ctx.run('buildRuntimeIndicatorContent(_lastRenderedNotificationRuntime)').main.includes('等待响应'));
  });

  it('唤醒轮表达性帧（lastOutcome 残留旧挂起值）：suspended 不误置位', () => {
    ctx.run(`updateNotificationStatus(${JSON.stringify(wakeCharCountPayload())})`);
    const rt = ctx.run('_lastRenderedNotificationRuntime');
    assert.ok(rt, '运行中数据源存在');
    assert.equal(rt.suspended, false, 'calling 豁免：运行轮不显示挂起态');
    const content = ctx.run('buildRuntimeIndicatorContent(_lastRenderedNotificationRuntime)');
    assert.ok(content.main.includes('思考'), `显示运行态而非等待态: ${content.main}`);
  });

  it('唤醒轮收尾窗口（stage=completed + callActive）：suspended 不误置位', () => {
    ctx.run(`updateNotificationStatus(${JSON.stringify(wakeLlmCompletePayload())})`);
    const rt = ctx.run('_lastRenderedNotificationRuntime');
    assert.ok(rt, '收尾窗口数据源存在');
    assert.equal(rt.stage, 'completed', 'llm.complete 无 pending → stage 收尾为 completed');
    assert.equal(rt.suspended, false, 'calling 豁免覆盖收尾窗口（worker 不清 lastOutcome）');
  });
});
