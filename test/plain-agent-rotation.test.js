import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { executePlainCallWithRotation } from '../scripts/plain-agent-rotation.js';

// 接力控制器的纯逻辑测试：agent / 会话存储 / 组合变换全部注入桩，
// 不触真实 LLM。过界语义以 context-rotation-trigger 的观测事实为准
// （打断后的调用终态是 cancelled，controller 据此进入接力）。

function baseSnapshot({ withContinuity = false } = {}) {
  return {
    version: 1,
    sessionId: 's0',
    runtime: {
      context: {
        messages: [
          { role: 'user', content: '做一件长任务' },
          { role: 'assistant', content: '进行中' },
        ],
      },
      featureStates: withContinuity ? [
        {
          featureName: 'opencode-basic',
          snapshot: {
            __agentdev_continuity__: { protocol: 'claw.opencode-basic-continuity.v1' },
            readFiles: ['/tmp/a.js'],
          },
        },
      ] : [],
    },
  };
}

describe('plain agent 进程内上下文自接力', () => {
  test('round-0 完成即收敛：不轮换、sessionId 不变', async () => {
    let buildCalls = 0;
    const result = await executePlainCallWithRotation({
      initialGoal: 'g',
      initialSessionId: 's0',
      sessionStore: { load: async () => { throw new Error('should not load'); } },
      trimSource: { agentRelativeDir: '/a', projectRoot: '/p', agentId: 'a' },
      buildAgent: async ({ sessionId, handoff }) => {
        buildCalls += 1;
        assert.equal(handoff, null);
        assert.equal(sessionId, 's0');
        return {
          onCallDetailed: async () => ({ status: 'completed', response: 'done' }),
          saveSession: async () => {},
          dispose: async () => {},
        };
      },
      runTrim: async () => { throw new Error('should not trim'); },
    });
    assert.equal(buildCalls, 1);
    assert.equal(result.ok, true);
    assert.equal(result.sessionId, 's0');
    assert.equal(result.successions, 0);
    assert.equal(result.response, 'done');
  });

  test('过界打断 → 组合变换 → successor 续跑，seed 与 continuity 随行', async () => {
    const store = new Map();
    const disposed = [];
    const builds = [];
    let round = 0;

    const result = await executePlainCallWithRotation({
      initialGoal: '长任务',
      initialSessionId: 's0',
      sessionStore: { load: async (id) => {
        if (!store.has(id)) throw new Error(`session not found: ${id}`);
        return store.get(id);
      } },
      trimSource: { agentRelativeDir: '/a', projectRoot: '/p', agentId: 'plain-x' },
      buildAgent: async ({ sessionId, handoff, onContextTrip }) => {
        const roundIndex = round;
        round += 1;
        builds.push({ sessionId, handoff });
        return {
          onCallDetailed: async () => {
            if (roundIndex === 0) {
              onContextTrip();
              return { status: 'cancelled', response: null };
            }
            return { status: 'completed', response: 'done' };
          },
          saveSession: async () => { store.set(sessionId, baseSnapshot({ withContinuity: true })); },
          dispose: async () => { disposed.push(sessionId); },
        };
      },
      runTrim: async (params) => {
        assert.equal(params.sourceSessionSnapshot.runtime.context.messages.length, 2);
        return {
          schemaVersion: 1,
          seedMessages: [{ role: 'user', content: '裁剪后的历史', turn: 0 }],
          meta: { summaryText: '摘要文本', mode: 'trim-transcript-with-summary' },
          importantFiles: ['a.js'],
          importantSkills: [],
          fileRanges: {},
        };
      },
    });

    assert.equal(result.ok, true);
    assert.notEqual(result.sessionId, 's0');
    assert.match(result.sessionId, /^plain-/);          // controller 生成 successor id
    assert.equal(result.successions, 1);
    assert.equal(result.response, 'done');
    assert.equal(disposed.includes('s0'), true);
    // successor 构造期注入 seed
    assert.equal(builds.length, 2);
    assert.equal(builds[0].sessionId, 's0');
    assert.equal(builds[0].handoff, null);
    assert.equal(builds[1].sessionId, result.sessionId);
    assert.equal(builds[1].handoff.sourceSessionId, 's0');
    assert.equal(builds[1].handoff.mode, 'trim-transcript-with-summary');
    assert.equal(builds[1].handoff.sourceSummary, '摘要文本');
    assert.equal(Array.isArray(builds[1].handoff.seedMessages), true);
    // continuity 状态随 seed 转移（opencode-basic 先读后写授权）
    assert.equal(Array.isArray(builds[1].handoff.featureContinuity?.states), true);
  });

  test('接力上限到达按失败收敛', async () => {
    const result = await executePlainCallWithRotation({
      initialGoal: 'g',
      initialSessionId: 's0',
      sessionStore: { load: async () => baseSnapshot() },
      trimSource: { agentRelativeDir: '/a', projectRoot: '/p', agentId: 'a' },
      maxSuccessions: 1,
      buildAgent: async ({ onContextTrip }) => ({
        onCallDetailed: async () => {
          onContextTrip();
          return { status: 'cancelled', response: null };
        },
        saveSession: async () => {},
        dispose: async () => {},
      }),
      runTrim: async () => ({
        schemaVersion: 1,
        seedMessages: [{ role: 'user', content: 'x', turn: 0 }],
        meta: { summaryText: 's', mode: 'trim-transcript-with-summary' },
      }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.successions, 1);
    assert.match(result.error, /rotation limit/);
  });

  test('组合变换失败按失败收敛，不静默降级', async () => {
    const result = await executePlainCallWithRotation({
      initialGoal: 'g',
      initialSessionId: 's0',
      sessionStore: { load: async () => baseSnapshot() },
      trimSource: { agentRelativeDir: '/a', projectRoot: '/p', agentId: 'a' },
      buildAgent: async ({ onContextTrip }) => ({
        onCallDetailed: async () => {
          onContextTrip();
          return { status: 'cancelled', response: null };
        },
        saveSession: async () => {},
        dispose: async () => {},
      }),
      runTrim: async () => { throw new Error('LLM summary failed'); },
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /context rotation failed/);
    assert.equal(result.sessionId, 's0'); // 未推进
  });

  test('空快照（无消息）不进入变换，按现状收敛', async () => {
    const result = await executePlainCallWithRotation({
      initialGoal: 'g',
      initialSessionId: 's0',
      sessionStore: { load: async () => ({ runtime: { context: { messages: [] } } }) },
      trimSource: { agentRelativeDir: '/a', projectRoot: '/p', agentId: 'a' },
      buildAgent: async ({ onContextTrip }) => ({
        onCallDetailed: async () => {
          onContextTrip();
          return { status: 'cancelled', response: null };
        },
        saveSession: async () => {},
        dispose: async () => {},
      }),
      runTrim: async () => { throw new Error('should not trim'); },
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /no messages to trim/);
  });
});
