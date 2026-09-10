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
    const trimCalls = [];
    let round = 0;
    const injectedLLM = { modelName: 'stub-llm' };

    const result = await executePlainCallWithRotation({
      initialGoal: '长任务',
      initialSessionId: 's0',
      sessionStore: { load: async (id) => {
        if (!store.has(id)) throw new Error(`session not found: ${id}`);
        return store.get(id);
      } },
      trimSource: {
        agentRelativeDir: '/a',
        projectRoot: '/p',
        agentId: 'plain-x',
        llm: () => injectedLLM, // 工厂：每次接力新实例
      },
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
        trimCalls.push(params);
        assert.equal(params.sourceSessionSnapshot.runtime.context.messages.length, 2);
        assert.equal(params.llm, injectedLLM);                       // 工厂产物逐轮注入
        assert.ok(Array.isArray(params.policy?.preserveToolNames));  // continuity 工具装饰同参
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

    // continuity 状态随 seed 转移（opencode-basic 先读后写授权）
    assert.equal(Array.isArray(builds[1].handoff.featureContinuity?.states), true);
    assert.equal(trimCalls.length, 1);
    assert.equal(result.ok, true);
    assert.notEqual(result.sessionId, 's0');
    assert.match(result.sessionId, /^plain-/);          // controller 生成 successor id
    assert.equal(result.successions, 1);
    assert.equal(result.response, 'done');
    assert.equal(disposed.includes('s0'), true);
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
    // llm 工厂与 continuity policy 装饰随 runTrim 调用注入
    assert.equal(trimCalls[0].llm, injectedLLM);
    assert.ok(Array.isArray(trimCalls[0].policy?.preserveToolNames));
    assert.equal(trimCalls.length, 1);
  });

  test('build 失败收敛报告已落盘的 persistedHead，不指向幽灵 successor', async () => {
    const store = new Map();
    let round = 0;
    const upserts = [];

    const result = await executePlainCallWithRotation({
      initialGoal: 'g',
      initialSessionId: 's0',
      sessionStore: { load: async (id) => {
        if (!store.has(id)) throw new Error(`session not found: ${id}`);
        return store.get(id);
      } },
      trimSource: { agentRelativeDir: '/a', projectRoot: '/p', agentId: 'a' },
      buildAgent: async ({ sessionId, onContextTrip }) => {
        if (round === 0) {
          round += 1;
          return {
            onCallDetailed: async () => {
              onContextTrip();
              return { status: 'cancelled', response: null };
            },
            saveSession: async () => { store.set(sessionId, baseSnapshot()); },
            dispose: async () => {},
          };
        }
        throw new Error('successor assembly exploded');
      },
      runTrim: async () => ({
        schemaVersion: 1,
        seedMessages: [{ role: 'user', content: 'x', turn: 0 }],
        meta: { summaryText: 's', mode: 'trim-transcript-with-summary' },
      }),
      upsertIndex: (record) => { upserts.push(record); },
    });
    // build 失败：报告已落盘的源会话，而非未构建的 successor id
    assert.equal(result.ok, false);
    assert.equal(result.sessionId, 's0');
    assert.equal(result.initialSessionId, 's0');
    assert.equal(result.successions, 0); // 未计数（successor 未建成）
    assert.match(result.error, /agent build failed/);
    // M1 回归：接力 index 登记只发生在 successor 构建成功之后——build 失败
    // 不得留下指向不存在会话文件的孤儿记录（与线程 commit/READY 门禁同语义）。
    assert.equal(upserts.length, 0);
  });

  test('接力成功：index 登记恰一次，字段完整', async () => {
    const store = new Map();
    let round = 0;
    const upserts = [];

    const result = await executePlainCallWithRotation({
      initialGoal: 'g',
      initialSessionId: 's0',
      sessionStore: { load: async (id) => {
        if (!store.has(id)) throw new Error(`session not found: ${id}`);
        return store.get(id);
      } },
      trimSource: { agentRelativeDir: '/a', projectRoot: '/p', agentId: 'a' },
      buildAgent: async ({ sessionId, handoff, onContextTrip }) => {
        const roundIndex = round;
        round += 1;
        return {
          onCallDetailed: async () => {
            if (roundIndex === 0) {
              onContextTrip();
              return { status: 'cancelled', response: null };
            }
            return { status: 'completed', response: 'done' };
          },
          saveSession: async () => { store.set(sessionId, baseSnapshot()); },
          dispose: async () => {},
        };
      },
      runTrim: async () => ({
        schemaVersion: 1,
        seedMessages: [{ role: 'user', content: 'x', turn: 0 }],
        meta: { summaryText: 's', mode: 'trim-transcript-with-summary' },
      }),
      upsertIndex: (record) => { upserts.push(record); },
    });
    assert.equal(result.ok, true);
    assert.equal(result.successions, 1);
    // 登记恰一次（build 成功后），不含 trim 时点的先行登记
    assert.equal(upserts.length, 1);
    assert.equal(upserts[0].id, result.sessionId);
    assert.equal(upserts[0].parentSessionId, 's0');
    assert.equal(upserts[0].rotationRound, 1);
    assert.equal(upserts[0].resumeMode, 'auto-rotation');
  });

  test('saveSession 失败：接力继续，首次失败事实保留不重置', async () => {
    let round = 0;
    const result = await executePlainCallWithRotation({
      initialGoal: 'g',
      initialSessionId: 's0',
      sessionStore: { load: async () => baseSnapshot() },
      trimSource: { agentRelativeDir: '/a', projectRoot: '/p', agentId: 'a' },
      buildAgent: async ({ onContextTrip }) => {
        const roundIndex = round;
        round += 1;
        return {
          onCallDetailed: async () => {
            if (roundIndex === 0) {
              onContextTrip();
              return { status: 'cancelled', response: null };
            }
            return { status: 'completed', response: 'done' };
          },
          saveSession: async () => { if (roundIndex === 0) throw new Error('disk full'); },
          dispose: async () => {},
        };
      },
      runTrim: async () => ({
        schemaVersion: 1,
        seedMessages: [{ role: 'user', content: 'x', turn: 0 }],
        meta: { summaryText: 's', mode: 'trim-transcript-with-summary' },
      }),
    });
    // 中间轮落盘失败：接力成功收敛，但首次失败事实随 result 携带（L2）
    assert.equal(result.ok, true);
    assert.equal(result.successions, 1);
    assert.equal(result.saveError, 'disk full');
  });

  test('save 失败窗口：trim 失败收敛指向 persistedHead，无孤儿 index 登记', async () => {
    let round = 0;
    let trimCalls = 0;
    const result = await executePlainCallWithRotation({
      initialGoal: 'g',
      initialSessionId: 's0',
      sessionStore: { load: async (id) => {
        if (id !== 's0') throw new Error('session not found'); // successor 未落盘
        return baseSnapshot();
      } },
      trimSource: { agentRelativeDir: '/a', projectRoot: '/p', agentId: 'a' },
      buildAgent: async ({ sessionId, onContextTrip }) => ({
        onCallDetailed: async () => {
          onContextTrip();
          return { status: 'cancelled', response: null };
        },
        saveSession: async (id) => {
          if (id !== 's0') throw new Error('disk full'); // successor 轮落盘失败
        },
        dispose: async () => {},
      }),
      runTrim: async () => {
        trimCalls += 1;
        if (trimCalls === 1) {
          // 首次轮换成功 → successor 进入执行
          return {
            schemaVersion: 1,
            seedMessages: [{ role: 'user', content: 'x', turn: 0 }],
            meta: { summaryText: 's', mode: 'trim-transcript-with-summary' },
          };
        }
        throw new Error('LLM summary failed'); // successor 轮过界后的第二次轮换失败
      },
      upsertIndex: () => { throw new Error('orphan record must not happen'); },
    });
    // M1 回归：result 指向已落盘的 persistedHead（非未落盘 successor）；
    // upsertIndex 全程未被调用（save 失败的 successor 不入索引）
    assert.equal(result.ok, false);
    assert.equal(result.sessionId, 's0');
    assert.match(result.error, /context rotation failed/);
    assert.equal(result.saveError, 'disk full');
    assert.equal(result.successions, 1);
  });

  test('upsertIndex 抛错不击穿执行：indexError 随 result 携带', async () => {
    let round = 0;
    const result = await executePlainCallWithRotation({
      initialGoal: 'g',
      initialSessionId: 's0',
      sessionStore: { load: async () => baseSnapshot() },
      trimSource: { agentRelativeDir: '/a', projectRoot: '/p', agentId: 'a' },
      buildAgent: async ({ sessionId, onContextTrip }) => {
        const roundIndex = round;
        round += 1;
        return {
          onCallDetailed: async () => {
            if (roundIndex === 0) {
              onContextTrip();
              return { status: 'cancelled', response: null };
            }
            return { status: 'completed', response: 'done' };
          },
          saveSession: async () => {},
          dispose: async () => {},
        };
      },
      runTrim: async () => ({
        schemaVersion: 1,
        seedMessages: [{ role: 'user', content: 'x', turn: 0 }],
        meta: { summaryText: 's', mode: 'trim-transcript-with-summary' },
      }),
      upsertIndex: () => { throw new Error('index.json on read-only fs'); },
    });
    assert.equal(result.ok, true); // 发现层写失败不吞执行结果
    assert.equal(result.successions, 1);
    assert.match(result.indexError, /read-only/);
  });

  test('onCall 兼容路径（无 onCallDetailed）：response 按 completed 归一', async () => {
    const result = await executePlainCallWithRotation({
      initialGoal: 'g',
      initialSessionId: 's0',
      sessionStore: { load: async () => { throw new Error('should not load'); } },
      trimSource: { agentRelativeDir: '/a', projectRoot: '/p', agentId: 'a' },
      buildAgent: async () => ({
        onCall: async () => 'legacy response',
        saveSession: async () => {},
        dispose: async () => {},
      }),
      runTrim: async () => { throw new Error('should not trim'); },
    });
    assert.equal(result.ok, true);
    assert.equal(result.status, 'completed');
    assert.equal(result.response, 'legacy response');
  });

  test('callError 单独（无过界）：按 failed 收敛不轮换', async () => {
    const result = await executePlainCallWithRotation({
      initialGoal: 'g',
      initialSessionId: 's0',
      sessionStore: { load: async () => { throw new Error('should not load'); } },
      trimSource: { agentRelativeDir: '/a', projectRoot: '/p', agentId: 'a' },
      buildAgent: async () => ({
        onCallDetailed: async () => { throw new Error('model blew up'); },
        saveSession: async () => {},
        dispose: async () => {},
      }),
      runTrim: async () => { throw new Error('should not trim'); },
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'failed');
    assert.match(result.error, /model blew up/);
    assert.equal(result.sessionId, 's0');
  });

  test('callError 与 tripped 同轮：tripped 优先进入接力', async () => {
    const result = await executePlainCallWithRotation({
      initialGoal: 'g',
      initialSessionId: 's0',
      sessionStore: { load: async () => baseSnapshot() },
      trimSource: { agentRelativeDir: '/a', projectRoot: '/p', agentId: 'a' },
      maxSuccessions: 1,
      buildAgent: async ({ onContextTrip }) => ({
        onCallDetailed: async () => {
          onContextTrip();
          throw new Error('guard interrupt');
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
    // tripped 优先：不按 callError 直接失败收敛，而是尝试接力（上限到达后失败收敛）
    assert.equal(result.successions, 1);
    assert.match(result.error, /rotation limit/);
  });

  test('tripped + completed 竞态：按 completed 收敛不轮换', async () => {
    const result = await executePlainCallWithRotation({
      initialGoal: 'g',
      initialSessionId: 's0',
      sessionStore: { load: async () => baseSnapshot() },
      trimSource: { agentRelativeDir: '/a', projectRoot: '/p', agentId: 'a' },
      buildAgent: async ({ onContextTrip }) => ({
        onCallDetailed: async () => {
          onContextTrip(); // 观测在响应返回后：同轮既完成又过线
          return { status: 'completed', response: '刚好完成' };
        },
        saveSession: async () => {},
        dispose: async () => {},
      }),
      runTrim: async () => { throw new Error('should not trim'); },
    });
    assert.equal(result.ok, true);
    assert.equal(result.status, 'completed');
    assert.equal(result.sessionId, 's0');
    assert.equal(result.successions, 0);
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
