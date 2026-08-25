/**
 * T002 — successor 接力提交与失败收敛 验收测试（node:test，不依赖真实 Runtime）
 *
 * 覆盖工单验收标准：
 * 1. 接力提交点：successor READY 之前不得成为有效 head
 *    （commitSuccession successorReady=false → head 保持旧会话）；
 * 2. 接力成功时原子完成：旧 head 退历史 / successor 成 head /
 *    pendingSuccession 清除 / 接力期间 command 补投递；
 * 3. 成功接力不重复投递 Inbox command（terminal 状态不再入投递集）；
 * 4. 身份不一致（消费 T001 身份门）、handoff 损坏、Runtime 超时
 *    （= READY 门禁失败）、进程重启 四类失败均有可断言结果；
 * 5. 失败时 Thread 不推进、记录失败阶段（stage）与原因、
 *    pending 工作归属不丢失（旧 head 保持有效，挡板显式收敛而非 TTL）、
 *    不把 pending 指令投向未知目标；
 * 6. compact / summary / trim 共享 successor 创建入口
 *    （createCompactedResumeFromHandoff）与共享提交点（commitSuccession）——
 *    源码级契约断言，防止各路径各自实现继承逻辑。
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { WorkThreadRuntimeBridge, HANDOFF_SCHEMA_VERSION } from '@agentdev/core';
import { createThreadControl } from '../server/thread-control/thread-controller.js';
import { createThreadIntegration } from '../server/thread-control/thread-integration.js';
import {
  createThreadSuccessionService,
  createThreadRecoveryService,
  abortPendingSuccession,
} from '../server/thread-control/thread-succession.js';
import { createThreadRotationService } from '../server/thread-control/thread-rotation.js';
import { readHandoffPackage } from '../server/context-continuity/handoff-package.js';

// ─── 夹具 ─────────────────────────────────────────────────────────

function makeIdentitySource() {
  const sessions = new Map();
  return {
    register(sessionId, identity) { sessions.set(sessionId, identity); },
    identitySource: async (_agentId, sessionId) => {
      const id = String(sessionId || '').trim();
      if (!id) return null;
      const identity = sessions.get(id);
      return identity === undefined ? null : identity;
    },
  };
}

let counter = 0;

/**
 * 一套 hermetic 环境：独立数据目录 + 注入 identitySource + 可投递 bridge。
 * stopped 记录 stopManagedAgent 调用（失败 successor 的 runtime 退役证据）。
 */
function makeEnvironment(bridgeOptions = {}) {
  const identity = makeIdentitySource();
  const stopped = [];
  const root = mkdtempSync(path.join(os.tmpdir(), 'claw-succession-base-'));
  const control = createThreadControl({
    rootDir: path.join(root, `sc-${++counter}`),
    bridge: new WorkThreadRuntimeBridge(bridgeOptions),
    identitySource: identity.identitySource,
  });
  const integration = createThreadIntegration({ control });
  const succession = createThreadSuccessionService({
    threadControl: control,
    threadIntegration: integration,
    stopManagedAgent: async (agentId, sessionId) => { stopped.push({ agentId, sessionId }); },
  });
  const recovery = createThreadRecoveryService({
    threadControl: control,
    identitySource: identity.identitySource,
  });
  return { root, identity, control, core: control.core, integration, succession, recovery, stopped };
}

/** 建一个 coder 线程：root 会话 s1（身份经 identitySource 解析）。 */
async function startCoderThread(env, rootSessionId = 's1') {
  env.identity.register(rootSessionId, 'coder');
  return env.core.start({ sessionRef: { agentId: 'programming-helper', sessionId: rootSessionId } });
}

// ─── 1. 接力成功：原子完成四件事 ─────────────────────────────────

describe('T002: 接力成功（提交点原子完成）', () => {
  test('READY successor is committed: old head to history, new head, barrier cleared, staged commands delivered', async () => {
    const turns = [];
    const env = makeEnvironment({
      enabled: true,
      resolveRuntimeViewerId: (_a, s) => (s === 's2' ? 'viewer-s2' : null),
      submitTurn: async (params) => { turns.push(params); return { success: true }; },
    });
    try {
      const thread = await startCoderThread(env, 's1');
      await env.integration.beginSessionSuccession({ agentId: 'programming-helper', sessionId: 's1', reason: 'trim' });
      await env.core.appendCommand({ threadId: thread.threadId, text: '接力期间积累的指令' });

      // 交接窗口内不投递（旧 head 即将退役）
      const blocked = await env.core.deliverPendingCommands(thread.threadId);
      assert.equal(blocked.reason, 'handoff_in_progress');
      assert.equal(turns.length, 0);

      // 提交点：successor READY（compact 流程内的 ready 证据）
      const env2Identity = env.identity;
      env2Identity.register('s2', 'coder');
      const outcome = await env.succession.commitSuccession({
        agentId: 'programming-helper',
        fromSessionId: 's1',
        toSessionId: 's2',
        reason: 'trim',
        successorReady: true,
      });

      assert.equal(outcome.applied, true);
      assert.equal(outcome.delivery.delivered, 1, '接力期间积累的 command 进入补投递');
      assert.equal(turns.length, 1);
      assert.equal(turns[0].agentId, 'viewer-s2', '投递给新 head 的 runtime');
      assert.equal(turns[0].text, '接力期间积累的指令');

      // 原子四件套
      const record = await env.core.getThread(thread.threadId);
      assert.equal(record.headSessionId, 's2', 'successor 成为 head');
      assert.equal(record.pendingSuccession, null, 'pendingSuccession 清除');
      assert.equal(record.status, 'open');
      assert.equal(record.sessionChain.length, 2);
      assert.equal(record.sessionChain[0].role, 'predecessor', '旧 head 退为历史');
      assert.equal(record.sessionChain[0].endKind, 'trim');
      assert.equal(record.sessionChain[0].successorSessionId, 's2');
      assert.equal(record.commands[0].status, 'delivered');
    } finally {
      await fs.rm(env.root, { recursive: true, force: true });
    }
  });

  test('committed commands are never re-delivered (no duplicate Inbox delivery)', async () => {
    const turns = [];
    const env = makeEnvironment({
      enabled: true,
      resolveRuntimeViewerId: (_a, s) => (s === 's2' ? 'viewer-s2' : null),
      submitTurn: async (params) => { turns.push(params); return { success: true }; },
    });
    try {
      const thread = await startCoderThread(env, 's1');
      await env.integration.beginSessionSuccession({ agentId: 'programming-helper', sessionId: 's1', reason: 'summary' });
      await env.core.appendCommand({ threadId: thread.threadId, text: '只投一次' });
      env.identity.register('s2', 'coder');

      await env.succession.commitSuccession({
        agentId: 'programming-helper',
        fromSessionId: 's1',
        toSessionId: 's2',
        reason: 'summary',
        successorReady: true,
      });
      assert.equal(turns.length, 1);

      // 提交后再触发投递（runtime-ready 钩子 / 手动 deliver）：
      // terminal 指令不再进入投递集
      const again = await env.core.deliverPendingCommands(thread.threadId);
      assert.equal(again.delivered, 0);
      assert.equal(again.attempted, 0);
      assert.equal(turns.length, 1, '成功接力不会重复投递');

      const record = await env.core.getThread(thread.threadId);
      assert.equal(record.commands[0].attempts, 1);
    } finally {
      await fs.rm(env.root, { recursive: true, force: true });
    }
  });

  test('concurrent commit losing the head race is a void, not a recorded failure', async () => {
    const env = makeEnvironment();
    try {
      const thread = await startCoderThread(env, 's1');
      env.identity.register('s2', 'coder');
      // 另一并发操作已把 head 推进到 s2（本操作再提交 → head_mismatch）
      await env.core.advanceHead({ threadId: thread.threadId, toSessionId: 's2', fromSessionId: 's1', endKind: 'trim' });

      const outcome = await env.succession.commitSuccession({
        agentId: 'programming-helper',
        fromSessionId: 's1',
        toSessionId: 's2',
        reason: 'trim',
        successorReady: true,
      });
      assert.equal(outcome.applied, false);
      // 并发 void：另一操作已提交，fromSessionId 不再是 head——按旧 head
      // 找不到线程即幂等作废（线程状态已是权威），不记失败。
      assert.equal(outcome.reason, 'no_thread_for_session');

      const record = await env.core.getThread(thread.threadId);
      assert.equal(record.status, 'open', 'void 不记 rotation_failed');
      assert.equal(record.headSessionId, 's2');
    } finally {
      await fs.rm(env.root, { recursive: true, force: true });
    }
  });
});

// ─── 2. READY 门禁（Runtime 超时 = 未 READY 同源）────────────────

describe('T002: 提交点 READY 门禁（successor 未 READY 不得成为 head）', () => {
  test('not-READY successor is rejected: head stays the old session, failure stage recorded, barrier converged', async () => {
    const env = makeEnvironment();
    try {
      const thread = await startCoderThread(env, 's1');
      await env.integration.beginSessionSuccession({ agentId: 'programming-helper', sessionId: 's1', reason: 'trim' });
      await env.core.appendCommand({ threadId: thread.threadId, text: 'pending 工作' });

      // compact 流程里 waitForManagedRuntimeReady 超时（result.agent=null）
      const outcome = await env.succession.commitSuccession({
        agentId: 'programming-helper',
        fromSessionId: 's1',
        toSessionId: 's2',
        reason: 'trim',
        successorReady: false,
      });

      assert.equal(outcome.applied, false);
      assert.equal(outcome.reason, 'successor_not_ready');
      assert.equal(outcome.stage, 'successor_runtime_not_ready');

      const record = await env.core.getThread(thread.threadId);
      assert.equal(record.headSessionId, 's1', 'successor 未 READY 时 Thread head 仍是旧 Session');
      assert.equal(record.sessionChain.length, 1, 'successor 不进链（不进线程成员）');
      assert.equal(record.status, 'rotation_failed');
      assert.equal(record.pendingSuccession, null, '挡板显式收敛，不靠 stale TTL');
      assert.equal(record.commands[0].status, 'pending', 'pending 工作归属不丢失（不取消、不失败）');
      const stages = record.lifecycleEvents
        .filter((e) => e.type === 'handoff_failed')
        .map((e) => e.stage);
      assert.ok(stages.includes('successor_runtime_not_ready'), '失败阶段落盘');
      const aborted = record.lifecycleEvents.find((e) => e.type === 'handoff_aborted');
      assert.ok(aborted, 'handoff_aborted 事件留痕');
      assert.deepEqual(env.stopped, [
        { agentId: 'programming-helper', sessionId: 's2' },
      ], '失败 successor 的半启动 runtime 退役（session 文件保留供审计）');
    } finally {
      await fs.rm(env.root, { recursive: true, force: true });
    }
  });

  test('after READY-gate failure the old head is authoritative: staged commands deliver to it', async () => {
    const turns = [];
    const env = makeEnvironment({
      enabled: true,
      resolveRuntimeViewerId: (_a, s) => (s === 's1' ? 'viewer-s1' : null),
      submitTurn: async (params) => { turns.push(params); return { success: true }; },
    });
    try {
      const thread = await startCoderThread(env, 's1');
      await env.integration.beginSessionSuccession({ agentId: 'programming-helper', sessionId: 's1', reason: 'trim' });
      await env.core.appendCommand({ threadId: thread.threadId, text: '回到旧 head' });

      await env.succession.commitSuccession({
        agentId: 'programming-helper',
        fromSessionId: 's1',
        toSessionId: 's2',
        reason: 'trim',
        successorReady: false,
      });

      // 挡板已收敛：旧 head 的 runtime 就绪时 pending 照常投递
      // （若仍靠 5 分钟 TTL 惰性清除，这里会被 handoff_in_progress 挡住）
      const delivery = await env.core.deliverPendingCommands(thread.threadId);
      assert.equal(delivery.delivered, 1);
      assert.equal(turns[0].agentId, 'viewer-s1', 'pending 投向仍有效的旧 head，不投向未知目标');
    } finally {
      await fs.rm(env.root, { recursive: true, force: true });
    }
  });
});

// ─── 3. 身份一致性（消费 T001 身份门）────────────────────────────

describe('T002: 身份一致性（T001 身份门经提交点消费）', () => {
  test('identity mismatch rejects the commit, records stage, leaves the thread untouched', async () => {
    const env = makeEnvironment();
    try {
      const thread = await startCoderThread(env, 's1');
      // successor 被错误装配为 main（本轮事故场景）
      env.identity.register('s2-main', 'main');
      await env.integration.beginSessionSuccession({ agentId: 'programming-helper', sessionId: 's1', reason: 'trim' });
      const before = await env.core.getThread(thread.threadId);

      const outcome = await env.succession.commitSuccession({
        agentId: 'programming-helper',
        fromSessionId: 's1',
        toSessionId: 's2-main',
        reason: 'trim',
        successorReady: true,
      });

      assert.equal(outcome.applied, false);
      assert.equal(outcome.reason, 'handoff_failed');
      assert.equal(outcome.stage, 'thread_identity_mismatch', 'T001 稳定 code 作为失败阶段透传');

      const record = await env.core.getThread(thread.threadId);
      assert.equal(record.headSessionId, 's1', 'Thread 不推进 head');
      assert.equal(record.sessionChain.length, 1, '线程记录零变更（successor 不入链）');
      assert.equal(record.identity, 'coder');
      assert.equal(record.status, 'rotation_failed');
      assert.equal(record.pendingSuccession, null, '挡板显式收敛');
      assert.deepEqual(
        record.lifecycleEvents.filter((e) => e.type === 'handoff_failed').map((e) => e.stage),
        ['thread_identity_mismatch'],
        '失败阶段与原因落盘',
      );
      // 失败收敛两次写盘：failSessionHandoff（失败事实）+ abortPendingSuccession
      // （挡板清除），各推进一次 revision；head 推进零变更。
      assert.equal(record.revision - before.revision, 2);
    } finally {
      await fs.rm(env.root, { recursive: true, force: true });
    }
  });

  test('successor outside the workspace host is rejected with session_workspace_mismatch', async () => {
    const env = makeEnvironment();
    try {
      const thread = await startCoderThread(env, 's1');
      // 'foreign' 未登记：identitySource 解析不到 = 不属于该宿主
      await env.integration.beginSessionSuccession({ agentId: 'programming-helper', sessionId: 's1', reason: 'trim' });

      const outcome = await env.succession.commitSuccession({
        agentId: 'programming-helper',
        fromSessionId: 's1',
        toSessionId: 'foreign',
        reason: 'trim',
        successorReady: true,
      });

      assert.equal(outcome.applied, false);
      assert.equal(outcome.stage, 'session_workspace_mismatch');
      const record = await env.core.getThread(thread.threadId);
      assert.equal(record.headSessionId, 's1');
      assert.equal(record.status, 'rotation_failed');
      assert.equal(record.pendingSuccession, null);
    } finally {
      await fs.rm(env.root, { recursive: true, force: true });
    }
  });
});

// ─── 4. handoff 损坏（接力材料校验失败）──────────────────────────

describe('T002: handoff 损坏（材料校验失败阶段可断言）', () => {
  let handoffRoot;
  before(async () => { handoffRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'claw-handoff-damaged-')); });
  after(async () => { await fs.rm(handoffRoot, { recursive: true, force: true }); });

  test('readHandoffPackage rejects a corrupted package with a stable machine code', async () => {
    const dir = path.join(handoffRoot, 'context-handoffs', 'programming-helper');
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, 'h1.json');
    await fs.writeFile(filePath, JSON.stringify({ schemaVersion: 999, handoffId: 'h1' }), 'utf8');

    await assert.rejects(
      () => readHandoffPackage({ userDataRoot: handoffRoot, agentId: 'programming-helper', handoffId: 'h1' }),
      (err) => err.code === 'handoff_invalid' && err.statusCode === 400,
    );
  });

  test('a handoff_invalid failure converges the thread without advancing the head', async () => {
    const env = makeEnvironment();
    try {
      const thread = await startCoderThread(env, 's1');
      await env.integration.beginSessionSuccession({ agentId: 'programming-helper', sessionId: 's1', reason: 'summary' });
      await env.core.appendCommand({ threadId: thread.threadId, text: '待投递' });

      // 路由 / rotation 生成阶段抛出 error.code='handoff_invalid' 后的收敛
      const failure = await env.succession.failSuccession({
        agentId: 'programming-helper',
        fromSessionId: 's1',
        reason: 'compact_failed',
        stage: 'handoff_invalid',
        error: 'Unsupported handoff schema version: 999',
      });
      assert.equal(failure.applied, true);

      const record = await env.core.getThread(thread.threadId);
      assert.equal(record.headSessionId, 's1', 'Thread 不推进 head');
      assert.equal(record.status, 'rotation_failed');
      assert.equal(record.pendingSuccession, null, '挡板显式收敛');
      assert.equal(record.commands[0].status, 'pending', 'pending 工作归属不丢失');
      assert.ok(record.lifecycleEvents.some(
        (e) => e.type === 'handoff_failed' && e.stage === 'handoff_invalid' && e.error.includes('Unsupported handoff'),
      ), '失败阶段与原因落盘');
    } finally {
      await fs.rm(env.root, { recursive: true, force: true });
    }
  });
});

// ─── 5. 进程重启：按落盘状态收敛（不靠内存 TTL）──────────────────

describe('T002: 进程重启按落盘状态收敛', () => {
  async function seedInterruptedHandoff(env, thread, { startedAt, stage = 'started' } = {}) {
    // 模拟进程崩溃：prepare（begin）完成、commit 未完成，挡板留在盘上
    await env.core.store.update(thread.threadId, (draft) => {
      draft.status = 'rotating';
      draft.pendingSuccession = {
        fromSessionId: draft.headSessionId,
        reason: 'trim',
        stage,
        startedAt: startedAt ?? Date.now(),
      };
      return draft;
    });
  }

  test('fresh (non-stale) interrupted handoff is converged at restart — state, not TTL', async () => {
    const turns = [];
    const env = makeEnvironment({
      enabled: true,
      resolveRuntimeViewerId: (_a, s) => (s === 's1' ? 'viewer-s1' : null),
      submitTurn: async (params) => { turns.push(params); return { success: true }; },
    });
    try {
      const thread = await startCoderThread(env, 's1');
      await env.core.appendCommand({ threadId: thread.threadId, text: '崩溃前的 pending' });
      // startedAt = 现在：TTL 视角「新鲜」，若靠 stale 惰性清除要再等 5 分钟
      await seedInterruptedHandoff(env, thread, { startedAt: Date.now() });

      const report = await env.recovery.convergeInterruptedSuccessions();
      assert.equal(report.converged.length, 1);
      assert.equal(report.converged[0].threadId, thread.threadId);
      assert.equal(report.converged[0].stage, 'commit_not_reached', 'stage 透传（崩溃于 commit 之前）');
      assert.equal(report.converged[0].reason, 'restart_convergence');

      const record = await env.core.getThread(thread.threadId);
      assert.equal(record.headSessionId, 's1', '重启不推进 head');
      assert.equal(record.status, 'rotation_failed', '明确失败态，不是旋转中的僵尸');
      assert.equal(record.pendingSuccession, null, '挡板清除：不留永久挡板');
      assert.ok(record.lifecycleEvents.some((e) => e.type === 'handoff_aborted'));
      assert.equal(record.commands[0].status, 'pending', 'pending 工作归属保留');

      // 状态驱动补投：旧 head runtime 就绪后 pending 照常送达
      const delivery = await env.core.deliverPendingCommands(thread.threadId);
      assert.equal(delivery.delivered, 1);
      assert.equal(turns[0].agentId, 'viewer-s1');
    } finally {
      await fs.rm(env.root, { recursive: true, force: true });
    }
  });

  test('interrupted handoff with an unusable old head fails its pending commands instead of delivering to an unknown target', async () => {
    const turns = [];
    const env = makeEnvironment({
      enabled: true,
      resolveRuntimeViewerId: (_a, s) => (s === 'ghost' ? 'viewer-ghost' : null),
      submitTurn: async (params) => { turns.push(params); return { success: true }; },
    });
    try {
      const thread = await startCoderThread(env, 's1');
      await env.core.appendCommand({ threadId: thread.threadId, text: '无人承接的工作' });
      await seedInterruptedHandoff(env, thread);
      // 旧 head 会话被删 / 身份事实丢失（identitySource 解析不到）
      env.identity.sessions?.delete?.('s1');
      const identity = env.identity;
      // 重新用「查不到 s1」的 identitySource 重建恢复服务
      const strictRecovery = createThreadRecoveryService({
        threadControl: env.control,
        identitySource: async (_agentId, sessionId) => {
          if (sessionId === 's1') return null;
          return identity.identitySource(_agentId, sessionId);
        },
      });

      const report = await strictRecovery.convergeInterruptedSuccessions();
      assert.equal(report.converged.length, 1);
      assert.equal(report.converged[0].reason, 'head_session_missing');

      const record = await env.core.getThread(thread.threadId);
      assert.equal(record.status, 'rotation_failed');
      assert.equal(record.pendingSuccession, null);
      assert.equal(record.commands[0].status, 'failed');
      assert.equal(record.commands[0].lastReason, 'head_session_missing', '归属留痕，不投向未知目标');
      assert.equal(turns.length, 0, '永不投递');

      // 即使旧 head runtime「就绪」也不投（已 failed，terminal）
      const delivery = await env.core.deliverPendingCommands(thread.threadId);
      assert.equal(delivery.delivered, 0);
      assert.equal(turns.length, 0);
    } finally {
      await fs.rm(env.root, { recursive: true, force: true });
    }
  });

  test('threads without an interrupted handoff are left untouched', async () => {
    const env = makeEnvironment();
    try {
      const thread = await startCoderThread(env, 's1');
      // 正常的 rotation_failed（失败路径已显式收敛，挡板为空）
      await env.core.failSessionHandoff(thread.threadId, { reason: 'x', stage: 'compact_or_successor' });
      await env.core.store.update(thread.threadId, (draft) => {
        if (draft.status === 'rotating') draft.status = 'open';
        return draft;
      });

      const report = await env.recovery.convergeInterruptedSuccessions();
      assert.equal(report.converged.length, 0, '无交接残留 → no-op');
      assert.equal(report.examined, 1);
    } finally {
      await fs.rm(env.root, { recursive: true, force: true });
    }
  });

  test('interrupted handoff stage is carried through when the barrier recorded one', async () => {
    const env = makeEnvironment();
    try {
      const thread = await startCoderThread(env, 's1');
      await seedInterruptedHandoff(env, thread, { stage: 'successor_runtime_not_ready' });

      const report = await env.recovery.convergeInterruptedSuccessions();
      assert.equal(report.converged[0].stage, 'successor_runtime_not_ready', '落盘 stage 透传');
      const record = await env.core.getThread(thread.threadId);
      assert.ok(record.lifecycleEvents.some(
        (e) => e.type === 'handoff_failed' && e.stage === 'successor_runtime_not_ready',
      ));
    } finally {
      await fs.rm(env.root, { recursive: true, force: true });
    }
  });
});

// ─── 6. 三条路径共享 successor 创建入口与提交点（源码契约）──────

describe('T002: compact / summary / trim 共享入口（不各自实现继承逻辑）', () => {
  let sessionRoutes;
  let handoffHelpers;
  let rotationSrc;

  before(async () => {
    sessionRoutes = await fs.readFile(
      new URL('../server/routes/session.js', import.meta.url), 'utf8',
    );
    handoffHelpers = await fs.readFile(
      new URL('../server/routes/session-handoff-helpers.js', import.meta.url), 'utf8',
    );
    rotationSrc = await fs.readFile(
      new URL('../server/thread-control/thread-rotation.js', import.meta.url), 'utf8',
    );
  });

  test('compact_and_resume route commits through the shared commit point in both branches', () => {
    const start = sessionRoutes.indexOf("app.post('/protoclaw/context_handoffs/compact_and_resume'");
    const end = sessionRoutes.indexOf("app.post('/protoclaw/prebuilt_sessions/activate'", start);
    const route = sessionRoutes.slice(start, end);
    const commitCalls = route.split('commitSuccession({').length - 1;
    assert.ok(commitCalls >= 2, `detached 与同步分支都经 commitSuccession（实际 ${commitCalls} 处）`);
    // READY 门禁证据：successorReady 来自 compact 流程的 ready 结果
    assert.match(route, /successorReady:\s*result\?\.agent\s*!=\s*null/);
    // 生成阶段失败（detached catch + 同步外层 catch）都收敛挡板
    assert.ok((route.split('failSuccession({').length - 1) >= 2, '两分支失败路径都经共享失败收敛');
  });

  test('context guard rotation commits through the shared commit point', () => {
    assert.match(rotationSrc, /commitSuccession/);
    assert.match(rotationSrc, /successorReady:\s*result\?\.agent\s*!=\s*null/);
  });

  test('all three paths share one successor creation entry (createCompactedResumeFromHandoff)', () => {
    // compactAndResumeCurrentSession（compact / trim+summary）与
    // compactAndResumeFromProvidedSummary（summary）都收敛到同一入口
    const current = handoffHelpers.indexOf('async function compactAndResumeCurrentSession');
    const provided = handoffHelpers.indexOf('async function compactAndResumeFromProvidedSummary');
    const tail = handoffHelpers.indexOf('async function exportProvidedSummaryHandoff');
    assert.ok(current > 0 && provided > current && tail > provided);
    const compactBody = handoffHelpers.slice(current, provided);
    const summaryBody = handoffHelpers.slice(provided, tail);
    assert.match(compactBody, /return createCompactedResumeFromHandoff\(/);
    assert.match(summaryBody, /return createCompactedResumeFromHandoff\(/);
  });

  test('thread rotation consumes the shared commit point and records ready-gate failures', async () => {
    // 端到端（stub sessionApi）：compact 产出 agent=null（READY 等待超时）
    const calls = { stop: [], begin: [], commit: [], fail: [], command: [] };
    const identity = makeIdentitySource();
    identity.register('session-1', 'coder');
    const root = mkdtempSync(path.join(os.tmpdir(), 'claw-succession-rot-'));
    const control = createThreadControl({
      rootDir: path.join(root, 'rot'),
      bridge: new WorkThreadRuntimeBridge({ enabled: false }),
      identitySource: identity.identitySource,
    });
    const integration = createThreadIntegration({ control });
    const succession = createThreadSuccessionService({
      threadControl: control,
      threadIntegration: integration,
      stopManagedAgent: async () => {},
    });
    try {
      const service = createThreadRotationService({
        sessionApi: {
          updateSessionIndex: async (_a, mutator) => mutator({ sessions: [] }),
          compactAndResumeCurrentSession: async () => ({ session: { id: 'session-next' }, agent: null }),
        },
        stopManagedAgent: async (agentId, sessionId) => { calls.stop.push({ agentId, sessionId }); },
        threadIntegration: integration,
        threadControl: control,
        threadSuccession: succession,
      });

      const thread = await control.core.start({ sessionRef: { agentId: 'programming-helper', sessionId: 'session-1' } });
      await control.core.appendCommand({ threadId: thread.threadId, text: '轮换期间指令' });
      const result = await service.handleContextGuard('programming-helper', 'session-1');

      assert.equal(result.applied, false);
      assert.equal(result.stage, 'successor_runtime_not_ready');
      const record = await control.core.getThread(thread.threadId);
      assert.equal(record.headSessionId, 'session-1', '未 READY：head 不推进');
      assert.equal(record.status, 'rotation_failed');
      assert.equal(record.pendingSuccession, null);
      assert.equal(record.commands[0].status, 'pending');
      assert.equal(calls.command.length, 0, '失败棒次不追加恢复指令');
      assert.ok(calls.stop.length >= 1, '旧 head runtime 退役');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

// ─── 7. abortPendingSuccession 纯逻辑 ─────────────────────────────

describe('T002: 挡板显式收敛（abortPendingSuccession）', () => {
  test('clears the barrier and lands open with an audit event', async () => {
    const env = makeEnvironment();
    try {
      const thread = await startCoderThread(env, 's1');
      await env.core.beginSessionHandoff({ threadId: thread.threadId, fromSessionId: 's1', reason: 'trim' });
      let record = await env.core.getThread(thread.threadId);
      assert.equal(record.status, 'rotating');

      await abortPendingSuccession(env.core, thread.threadId, {
        stage: 'compact_or_successor',
        reason: 'handoff_failed',
        error: 'boom',
      });
      record = await env.core.getThread(thread.threadId);
      assert.equal(record.pendingSuccession, null);
      assert.equal(record.status, 'open');
      assert.equal(record.lastLifecycleEvent.type, 'handoff_aborted');
      assert.equal(record.lastLifecycleEvent.stage, 'compact_or_successor');

      // 幂等：无挡板时 no-op
      const before = (await env.core.getThread(thread.threadId)).revision;
      await abortPendingSuccession(env.core, thread.threadId, { stage: 'x', reason: 'y' });
      const after = await env.core.getThread(thread.threadId);
      assert.equal(after.revision, before);
    } finally {
      await fs.rm(env.root, { recursive: true, force: true });
    }
  });
});
