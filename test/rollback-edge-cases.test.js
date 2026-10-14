/**
 * 回退边界场景回归：被打断的轮次 / 模型无输出的报错轮次。
 *
 * 用户报告：回退在这些场景偶发或 100% 失败——
 *   1. 轮次被打断（interrupt）
 *   2. 用户刚说完、模型还没输出任何内容
 *   3. 报错轮
 *
 * 驱动真实组件：@agentdevjs/core Agent + scripts/runtime-summary.js 的
 * createSummaryHandlers（与 UI 点"回退到此轮"后 runtime 走的同一函数）。
 * 与 rollback-semantics.test.js 同型，聚焦边界时序而非基线语义。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent, FileSessionStore } from '@agentdevjs/core';
import { createSummaryHandlers } from '../scripts/runtime-summary.js';

/** 挂起直到 signal abort 的 chat mock：模拟"模型还没输出任何内容"窗口 */
class HangUntilAbortLLM {
  constructor() { this.mode = 'echo'; this.pendingReject = null; }
  async chat(_messages, _tools, options) {
    if (this.mode === 'delayed-throw') {
      await new Promise(r => setTimeout(r, 10));
      throw new Error('mock llm failure after delay');
    }
    // 默认挂起，直到外部 abort
    const signal = options?.signal;
    await new Promise((_, reject) => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      if (signal) {
        if (signal.aborted) { reject(err); return; }
        signal.addEventListener('abort', () => reject(err), { once: true });
      }
      this.pendingReject = reject;
    });
    throw new Error('unreachable: hang llm must never resolve');
  }
}

class ReproAgent extends Agent {
  constructor() {
    super({ llm: new HangUntilAbortLLM(), maxTurns: 2, name: 'RollbackEdgeAgent', systemMessage: 'sys' });
  }
}

function makeCtx(agent, sessionId, sessionStore) {
  return {
    agentId: 'rollback-edge-test-agent',
    sessionId,
    PREBUILT_AGENT_MAX_TOKENS_CAP: 8192,
    agent,
    sessionStore,
    postJson: async () => ({}),
  };
}

function availableCallIndices(agent) {
  const checkpoints = Array.isArray(agent?._callCheckpoints) ? agent._callCheckpoints : [];
  return checkpoints.map(cp => cp.callIndex);
}

const userContents = agent => agent.getContext().getAll().filter(m => m.role === 'user').map(m => m.content);

async function clickRollback(handlers, callIndex, draftInput = 'edited') {
  const userInput = { setNextDraftInput: v => { clickRollback.lastDraft = v; } };
  return handlers.handleInputResponse(userInput, {
    kind: 'action',
    actionId: 'rollback_to_call',
    payload: { callIndex, draftInput },
  });
}

/** 等待谓词为真（5ms 轮询，上限 2s） */
async function waitFor(predicate, label) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(r => setTimeout(r, 5));
  }
  throw new Error(`waitFor timeout: ${label}`);
}

async function withStore(fn) {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'claw-rollback-edge-'));
  try {
    await fn(new FileSessionStore(tmpRoot));
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

test('rollback 边界: 用户刚说完、无任何输出即被打断 → 该轮仍可回退', async () => {
  await withStore(async (store) => {
    const agent = new ReproAgent();
    const handlers = createSummaryHandlers(makeCtx(agent, 'interrupt-no-output', store));

    const callPromise = agent.onCall('just-sent');
    // 等用户消息进入 context（此时模型尚未输出任何内容）
    await waitFor(() => agent.getContext().getAll().some(m => m.role === 'user' && m.content === 'just-sent'),
      'user message in context');
    agent.interrupt();
    await callPromise;

    // 打断后：该轮 checkpoint 必须存在（否则 UI 无回退点）
    assert.ok(availableCallIndices(agent).includes(0),
      `打断轮 checkpoint 缺失，indices=${JSON.stringify(availableCallIndices(agent))}`);

    await assert.doesNotReject(() => clickRollback(handlers, 0));
    assert.deepEqual(userContents(agent), [], '回退后应清空该轮用户消息');
    assert.equal(clickRollback.lastDraft, 'edited');
  });
});

test('rollback 边界: 无输出报错轮（异步失败）→ 该轮仍可回退', async () => {
  await withStore(async (store) => {
    const agent = new ReproAgent();
    agent.llm.mode = 'delayed-throw';
    const handlers = createSummaryHandlers(makeCtx(agent, 'error-no-output', store));

    await agent.onCall('will-fail');

    assert.ok(availableCallIndices(agent).includes(0),
      `报错轮 checkpoint 缺失，indices=${JSON.stringify(availableCallIndices(agent))}`);

    await assert.doesNotReject(() => clickRollback(handlers, 0));
    assert.deepEqual(userContents(agent), []);
  });
});

test('rollback 边界: 打断轮落盘重启（save → loadSession）后仍可回退', async () => {
  await withStore(async (store) => {
    const agent = new ReproAgent();
    const callPromise = agent.onCall('interrupted-turn');
    await waitFor(() => agent.getContext().getAll().some(m => m.role === 'user' && m.content === 'interrupted-turn'),
      'user message in context');
    agent.interrupt();
    await callPromise;
    await agent.saveSession('restart-interrupt', store);

    const restored = new ReproAgent();
    await restored.loadSession('restart-interrupt', store);
    assert.ok(availableCallIndices(restored).includes(0),
      `重启后打断轮 checkpoint 缺失，indices=${JSON.stringify(availableCallIndices(restored))}`);

    const handlers = createSummaryHandlers(makeCtx(restored, 'restart-interrupt', store));
    await assert.doesNotReject(() => clickRollback(handlers, 0, ''));
    assert.deepEqual(userContents(restored), []);
  });
});

test('rollback 边界: 报错轮落盘重启（save → loadSession）后仍可回退', async () => {
  await withStore(async (store) => {
    const agent = new ReproAgent();
    agent.llm.mode = 'delayed-throw';
    await agent.onCall('failed-turn');
    await agent.onCall('good-turn' /* never reached: mode still throw */);
    agent.llm.mode = 'echo-unused';
    await agent.saveSession('restart-error', store);

    const restored = new ReproAgent();
    await restored.loadSession('restart-error', store);
    const indices = availableCallIndices(restored);
    assert.ok(indices.includes(0) && indices.includes(1),
      `重启后报错轮 checkpoint 缺失，indices=${JSON.stringify(indices)}`);

    const handlers = createSummaryHandlers(makeCtx(restored, 'restart-error', store));
    await assert.doesNotReject(() => clickRollback(handlers, 0, ''));
    assert.deepEqual(userContents(restored), []);
  });
});
