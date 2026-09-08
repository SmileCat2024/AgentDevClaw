/**
 * 回退（rollback_to_call）语义回归矩阵。
 *
 * 驱动真实组件：@agentdevjs/core Agent + scripts/runtime-summary.js 的
 * createSummaryHandlers（与 UI 点"回退到此轮"后 runtime 走的同一函数）。
 * 这些场景曾在排查"回退不删老消息/失败轮回退不对"时被怀疑，矩阵锁死
 * runtime 侧语义，防止回归误归因：掉线丢 push / 前端乐观态另案。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent, FileSessionStore } from '@agentdevjs/core';
import { createSummaryHandlers } from '../scripts/runtime-summary.js';

class ScriptLLM {
  constructor() { this.mode = 'echo'; }
  async chat(messages) {
    if (this.mode === 'throw') throw new Error('mock llm failure');
    const lastUser = [...messages].reverse().find(m => m.role === 'user')?.content || '';
    return { content: `reply:${lastUser}` };
  }
}

class ReproAgent extends Agent {
  constructor() {
    super({ llm: new ScriptLLM(), maxTurns: 2, name: 'RollbackAgent', systemMessage: 'sys' });
  }
}

function makeCtx(agent, sessionId, sessionStore) {
  return {
    agentId: 'rollback-test-agent',
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

const transcript = agent => agent.getContext().getAll().map(m => `${m.role}(${m.turn ?? '?'})`).join(' ');
const userContents = agent => agent.getContext().getAll().filter(m => m.role === 'user').map(m => m.content);

async function clickRollback(handlers, callIndex, draftInput = 'edited') {
  const userInput = { setNextDraftInput: v => { clickRollback.lastDraft = v; } };
  return handlers.handleInputResponse(userInput, {
    kind: 'action',
    actionId: 'rollback_to_call',
    payload: { callIndex, draftInput },
  });
}

async function withStore(fn) {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'claw-rollback-test-'));
  try {
    await fn(new FileSessionStore(tmpRoot));
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

test('rollback_to_call: 基线三轮回退中轮', async () => {
  await withStore(async (store) => {
    const agent = new ReproAgent();
    const handlers = createSummaryHandlers(makeCtx(agent, 'baseline', store));
    await agent.onCall('first');
    await agent.onCall('second');
    await agent.onCall('third');

    assert.deepEqual(availableCallIndices(agent), [0, 1, 2]);

    await clickRollback(handlers, 1);

    assert.deepEqual(userContents(agent), ['first'], `transcript=${transcript(agent)}`);
    assert.deepEqual(availableCallIndices(agent), [0], 'checkpoint 应过滤到 < 1');
    assert.equal(clickRollback.lastDraft, 'edited');
  });
});

test('rollback_to_call: 失败轮（错误 assistant 消息）随同轮删除', async () => {
  await withStore(async (store) => {
    const agent = new ReproAgent();
    const handlers = createSummaryHandlers(makeCtx(agent, 'failed-turn', store));
    await agent.onCall('good-turn');
    agent.llm.mode = 'throw';
    await agent.onCall('bad-turn');

    const msgs = agent.getContext().getAll();
    assert.equal(msgs.at(-1).execution?.status, 'failed', '错误 assistant 消息应存在');
    assert.deepEqual(availableCallIndices(agent), [0, 1], '失败轮 checkpoint 保留');

    await assert.doesNotReject(() => clickRollback(handlers, 1));

    assert.deepEqual(userContents(agent), ['good-turn'],
      `错误消息应与 user 同轮删除，transcript=${transcript(agent)}`);
  });
});

test('rollback_to_call: 首轮即失败（单消息轮）回退到空转录', async () => {
  await withStore(async (store) => {
    const agent = new ReproAgent();
    const handlers = createSummaryHandlers(makeCtx(agent, 'first-fail', store));
    agent.llm.mode = 'throw';
    await agent.onCall('only-turn');

    await assert.doesNotReject(() => clickRollback(handlers, 0));

    const after = agent.getContext().getAll();
    assert.equal(after.length, 1);
    assert.equal(after[0].role, 'system');
    assert.equal(availableCallIndices(agent).length, 0, '回退点清空，getNextTurnActions 应返回空');
    assert.equal(clickRollback.lastDraft, 'edited');
  });
});

test('rollback_to_call: 会话恢复往返（save → loadSession → rollback）', async () => {
  await withStore(async (store) => {
    const agent = new ReproAgent();
    await agent.onCall('a');
    await agent.onCall('b');
    await agent.saveSession('roundtrip', store);

    const restored = new ReproAgent();
    await restored.loadSession('roundtrip', store);
    assert.deepEqual(availableCallIndices(restored), availableCallIndices(agent),
      'checkpoint 应随会话快照往返');

    const handlers = createSummaryHandlers(makeCtx(restored, 'roundtrip', store));
    await assert.doesNotReject(() => clickRollback(handlers, 0, ''));
    assert.deepEqual(userContents(restored), []);
  });
});

test('rollback_to_call: user turn 与可用回退点对齐（失败轮后）', async () => {
  await withStore(async (_store) => {
    const agent = new ReproAgent();
    await agent.onCall('t0');
    agent.llm.mode = 'throw';
    await agent.onCall('t1');

    const userTurns = agent.getContext().getAll().filter(m => m.role === 'user').map(m => m.turn);
    const indices = availableCallIndices(agent);
    for (const turn of userTurns) {
      assert.ok(indices.includes(turn), `user turn ${turn} 应有对应回退点，indices=${JSON.stringify(indices)}`);
    }
  });
});
