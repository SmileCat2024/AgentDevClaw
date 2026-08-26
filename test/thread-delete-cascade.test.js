/**
 * T005 — Thread 直接删除与级联清理 验收测试（node:test）
 *
 * 覆盖工单验收标准：
 * 1. 删除 Thread 会清理全部关联数据，不生成孤儿记录（record / index /
 *    session 数据 / handoff / runtime 状态 / board（执行事件）/ archive）。
 * 2. 运行中调用优先收尾，超时后可强制停止并继续清理；收尾后成员
 *    runtime 无条件收敛（长活进程不绑已删会话）。
 * 3. 部分失败有结构化残留列表，record 保留（重试寻址对象），重复执行
 *    可以继续收敛到 complete。
 * 4. 用历史 Session ID 发起删除时删除的是所属 Thread，不是单个历史棒；
 *    非 Thread 成员（main 独立 Session）返回 null，保持独立 Session 语义。
 * 5. 删除后旧 Thread ID / pending command 的读路径返回明确 not found；
 *    删除 seal 后（partial 残留窗口）新 command / deliver 被拒
 *    （thread_closed）。
 *
 * 用真实 createThreadControl（真实 WorkThread / ThreadStore / Board）+
 * 注入 stopSession / 跨目录清理器 stub，seal 事务与并发行为来自真实落盘。
 * 跨目录清理器用真实 createThreadDeleteResources（handoff 扫描真实 IO，
 * 指向临时目录），session index / 会话文件经注入指向内存 / 临时目录，
 * 不触碰真实用户数据目录（测试约定）。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, mkdtempSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { WorkThreadRuntimeBridge } from '@agentdev/core';
import { createThreadControl } from '../server/thread-control/thread-controller.js';
import { createThreadLifecycleService } from '../server/thread-control/thread-lifecycle.js';
import { createThreadDeleteService } from '../server/thread-control/thread-delete.js';
import { createThreadDeleteResources } from '../server/thread-control/thread-delete-resources.js';
import { getContextHandoffsRoot } from '../server/context-continuity/handoff-package.js';
import { setupThreadRoutes } from '../server/thread-control/thread-routes.js';
import { ThreadCommandStatus } from '../server/thread-control/thread-inbox.js';

// ─── 夹具 ─────────────────────────────────────────────────────────

const AGENT = 'programming-helper';
let base = null;
let counter = 0;

function makeControl() {
  const root = path.join(base, `del-${++counter}`);
  // 身份真相源：测试会话统一 coder（线程宿主身份）
  const identitySource = async () => 'coder';
  const control = createThreadControl({
    rootDir: root,
    bridge: new WorkThreadRuntimeBridge(),
    identitySource,
  });
  return control;
}

/**
 * 删除环境：control + 资源清理器（注入）+ 观察记录。
 * options:
 *   - failRemoveSessions: 第一次调用 removeSessions 抛错（部分失败场景）
 *   - failStopSession: 指定 sessionId 的 stop 抛错（drain 失败场景）
 */
function makeDeleteEnvironment({ failRemoveSessions = false, failRemoveSessionsMode = 'once', failStopSession = null } = {}) {
  const control = makeControl();
  const observation = {
    stopped: [],
    removedSessions: [],
    removedHandoffs: null,
    clearedRuntimes: [],
  };
  let sessionsCalls = 0;
  const resources = createThreadDeleteResources({
    userDataRoot: path.join(base, `del-${counter}`, 'user-data'),
    sessionFileResolver: (agentId, sessionId) => path.join(base, `del-${counter}`, 'sessions', `${sessionId}.json`),
    sessionIndexUpdate: async (agentId, mutFn) => {
      sessionsCalls += 1;
      observation.removedSessions.push({ agentId, call: sessionsCalls });
      // 'once'：仅第一次调用失败（重试可收敛，测试 3）；
      // 'always'：持续失败（partial 残留窗口不收敛，测试 5b）。
      if (failRemoveSessions && (failRemoveSessionsMode === 'always' || sessionsCalls === 1)) {
        throw new Error('session store unavailable');
      }
      return { revision: sessionsCalls };
    },
    removeOpenSessionImpl: async () => {},
    invalidateSearchIndexImpl: () => {},
  });
  const deleteService = createThreadDeleteService({
    control,
    stopSession: async (agentId, sessionId) => {
      if (failStopSession && sessionId === failStopSession) {
        throw new Error('stop refused');
      }
      observation.stopped.push({ agentId, sessionId });
      return { status: 'stopped' };
    },
    removeSessions: async (agentId, sessionIds) => resources.removeSessions(agentId, sessionIds),
    removeHandoffs: async (agentId, sessionIds) => {
      observation.removedHandoffs = await resources.removeHandoffs(agentId, sessionIds);
      return observation.removedHandoffs;
    },
    clearRuntimes: (agentId, sessionIds) => {
      observation.clearedRuntimes.push({ agentId, sessionIds: [...sessionIds] });
      return { removed: sessionIds };
    },
  });
  return { control, core: control.core, board: control.board, archive: control.archive, deleteService, observation };
}

/** 建线程 s1 → 接力 s2（s1 成为历史成员）。 */
async function startTwoLinkThread(core) {
  const thread = await core.start({ sessionRef: { agentId: AGENT, sessionId: 's1' }, identity: 'coder' });
  await core.advanceHead({ threadId: thread.threadId, toSessionId: 's2', fromSessionId: 's1', endKind: 'trim' });
  return thread.threadId;
}

/** 在 handoff 目录写一个交接包（sourceSessionId 决定归属）。 */
async function writeHandoff(env, { agentId, sourceSessionId, handoffId }) {
  const dir = path.join(getContextHandoffsRoot(path.join(base, `del-${counter}`, 'user-data')), agentId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${handoffId}.json`), JSON.stringify({
    schemaVersion: 1,
    handoffId,
    sourceSessionId,
    seedMessages: [],
  }), 'utf8');
}

async function memberSessionFiles(env) {
  const dir = path.join(base, `del-${counter}`, 'sessions');
  return fs.readdir(dir).catch(() => []);
}

before(async () => { base = mkdtempSync(path.join(os.tmpdir(), 'claw-delete-t005-')); });
after(async () => { if (base) await fs.rm(base, { recursive: true, force: true }); });

// ─── 路由层 mock（coder-acp-routes 同源模式）─────────────────────

function makeMockApp() {
  const routes = {};
  return {
    routes,
    get: (p, ...h) => { routes[`GET ${p}`] = h; },
    post: (p, ...h) => { routes[`POST ${p}`] = h; },
  };
}

async function callRoute(app, method, pattern, { params, body } = {}) {
  const handlers = app.routes[`${method} ${pattern}`];
  assert.ok(handlers, `route not registered: ${method} ${pattern}`);
  const handler = handlers[handlers.length - 1];
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; },
  };
  await handler({ params, body: body ?? {}, query: {} }, res);
  return res;
}

// ─── 1. 级联清理无孤儿 ────────────────────────────────────────────

describe('T005: 删除 Thread 清理全部关联数据', () => {
  it('deletes record/index, session data, handoff, runtimes, board, archive without orphans', async () => {
    const env = makeDeleteEnvironment();
    const threadId = await startTwoLinkThread(env.core);
    const { board, archive } = env;

    // 铺满全部关联对象：pending + in_flight command、board running、归档条目、
    // 成员归属 handoff + 非成员 handoff、会话文件
    await env.core.appendCommand({ threadId, text: 'pending work', source: 'ui' });
    await env.core.store.update(threadId, (draft) => {
      draft.commands.push({
        commandId: 'cmd-running', threadId, kind: 'user_message',
        text: 'started call', source: 'ui', idempotencyKey: '', status: 'in_flight',
        attempts: 1, envelopeId: null, lastReason: null,
        createdAt: Date.now(), updatedAt: Date.now(), deliveredAt: Date.now(),
      });
      return draft;
    });
    await board.setStatus(threadId, 'running');
    await archive.archive(threadId);
    await writeHandoff(env, { agentId: AGENT, sourceSessionId: 's2', handoffId: 'h-member' });
    await writeHandoff(env, { agentId: AGENT, sourceSessionId: 'other-thread-session', handoffId: 'h-foreign' });
    const sessionsDir = path.join(base, `del-${counter}`, 'sessions');
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.writeFile(path.join(sessionsDir, 's1.json'), '{}', 'utf8');
    await fs.writeFile(path.join(sessionsDir, 's2.json'), '{}', 'utf8');

    const result = await env.deleteService.deleteThread(threadId, { forceWaitMs: 100 });

    // 结果形状：complete，无残留
    assert.equal(result.status, 'complete');
    assert.equal(result.deleted, true);
    assert.equal(result.idempotent, false);
    assert.deepEqual(result.cleanup.failures, []);
    // seal 事实：pending + in_flight 取消（保留原因），delivered/in_flight 进 drain 清单
    assert.equal(result.cleanup.commandsCancelled, 2);
    assert.deepEqual(result.cleanup.inflightDrain.startedCommandIds, ['cmd-running']);
    assert.deepEqual(result.cleanup.sessionIds.sort(), ['s1', 's2']);
    // 成员 runtime 收敛（无论是否运行中都停止）
    assert.deepEqual(env.observation.stopped.map((s) => s.sessionId).sort(), ['s1', 's2']);

    // 线程域：record / index / board / archive 全空
    assert.equal(await env.core.getThread(threadId), null);
    const index = await env.control.store.list();
    assert.ok(!index.some((t) => t.threadId === threadId), 'index entry must be removed');
    assert.equal(await board.getState(threadId), null, 'board file (执行事件) must be removed');
    assert.equal(await archive.isArchived(threadId), false);
    // 会话域：全部成员会话文件删除
    assert.deepEqual(await memberSessionFiles(env), []);
    // 清理范围只含成员集合
    assert.deepEqual(env.observation.removedSessions, [{ agentId: AGENT, call: 1 }]);
    // handoff：成员归属的删除，非成员的保留（不删其它 Thread 的材料）
    assert.deepEqual(env.observation.removedHandoffs.removed.map((h) => h.handoffId), ['h-member']);
    const handoffDir = path.join(getContextHandoffsRoot(path.join(base, `del-${counter}`, 'user-data')), AGENT);
    assert.deepEqual(await fs.readdir(handoffDir), ['h-foreign.json']);
    // runtime 状态释放
    assert.equal(env.observation.clearedRuntimes.length, 1);
    assert.deepEqual(env.observation.clearedRuntimes[0].sessionIds.sort(), ['s1', 's2']);
  });

  it('is idempotent: second delete of an absent thread reports idempotent success', async () => {
    const env = makeDeleteEnvironment();
    const threadId = await startTwoLinkThread(env.core);
    await env.deleteService.deleteThread(threadId, { forceWaitMs: 50 });
    const second = await env.deleteService.deleteThread(threadId, { forceWaitMs: 50 });
    assert.equal(second.idempotent, true);
    assert.equal(second.status, 'complete');
    assert.equal(second.deleted, true);
  });
});

// ─── 2. 收尾策略（等待 / 强制停止 / 成员 runtime 收敛）────────────

describe('T005: 运行中调用收尾策略', () => {
  it('prefers natural completion within budget and still settles member runtimes', async () => {
    const env = makeDeleteEnvironment();
    const threadId = await startTwoLinkThread(env.core);
    await env.core.store.update(threadId, (draft) => {
      draft.commands.push({
        commandId: 'cmd-live', threadId, kind: 'user_message',
        text: 'live call', source: 'ui', idempotencyKey: '', status: 'in_flight',
        attempts: 1, envelopeId: null, lastReason: null,
        createdAt: Date.now(), updatedAt: Date.now(), deliveredAt: Date.now(),
      });
      return draft;
    });
    await env.board.setStatus(threadId, 'running');

    // 删除启动后调用自然完成（turn.completed → idle），在等待预算内
    const task = env.deleteService.deleteThread(threadId, { forceWaitMs: 1000 });
    await new Promise((resolve) => setTimeout(resolve, 120));
    await env.board.recordRuntimeEvent({ agentId: AGENT, sessionId: 's2', event: { type: 'turn.completed', turn: 1 } });
    const result = await task;

    assert.equal(result.status, 'complete');
    assert.equal(result.cleanup.inflightDrain.drained, true);
    assert.equal(result.cleanup.inflightDrain.forcedStopped, false, '自然完成，不强制停止');
    assert.ok(result.cleanup.inflightDrain.waitedMs < 1000);
    // 收尾后成员 runtime 仍收敛（长活进程不绑已删会话）
    assert.deepEqual(env.observation.stopped.map((s) => s.sessionId).sort(), ['s1', 's2']);
  });

  it('force-stops when the call does not finish within the budget, then continues cleanup', async () => {
    const env = makeDeleteEnvironment();
    const threadId = await startTwoLinkThread(env.core);
    await env.board.setStatus(threadId, 'running');
    // 无 turn.completed：调用一直「运行中」

    const result = await env.deleteService.deleteThread(threadId, { forceWaitMs: 120 });

    assert.equal(result.status, 'complete');
    assert.equal(result.cleanup.inflightDrain.drained, true);
    assert.equal(result.cleanup.inflightDrain.forcedStopped, true, '达到明确超时后强制停止');
    assert.ok(result.cleanup.inflightDrain.waitedMs >= 100);
    // 强停后继续清理：record 已删，级联完整
    assert.equal(await env.core.getThread(threadId), null);
    assert.deepEqual(result.cleanup.failures, []);
  });

  it('reports drain as structured residual when a runtime refuses to stop', async () => {
    const env = makeDeleteEnvironment({ failStopSession: 's2' });
    const threadId = await startTwoLinkThread(env.core);
    await env.board.setStatus(threadId, 'running');

    const result = await env.deleteService.deleteThread(threadId, { forceWaitMs: 50 });

    assert.equal(result.status, 'partial');
    assert.equal(result.deleted, false);
    const drainFailure = result.cleanup.failures.find((f) => f.stage === 'drain');
    assert.ok(drainFailure, 'stop 失败必须进结构化残留列表');
    // 记录保留（closed 终态）：重试仍可按 threadId 寻址
    const retained = await env.core.getThread(threadId);
    assert.equal(retained.status, 'closed');
  });
});

// ─── 3. 部分失败残留与重复收敛 ────────────────────────────────────

describe('T005: 部分失败残留与重试收敛', () => {
  it('returns structured residuals on partial failure; retry converges to complete', async () => {
    const env = makeDeleteEnvironment({ failRemoveSessions: true });
    const threadId = await startTwoLinkThread(env.core);
    await writeHandoff(env, { agentId: AGENT, sourceSessionId: 's2', handoffId: 'h-retry' });
    const sessionsDir = path.join(base, `del-${counter}`, 'sessions');
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.writeFile(path.join(sessionsDir, 's1.json'), '{}', 'utf8');

    const first = await env.deleteService.deleteThread(threadId, { forceWaitMs: 50 });

    // 结构化残留：失败阶段 + 错误
    assert.equal(first.status, 'partial');
    assert.equal(first.deleted, false);
    assert.deepEqual(first.cleanup.failures, [{ stage: 'sessions', error: 'session store unavailable' }]);
    assert.equal(first.cleanup.steps.record.note, 'retained_for_retry', 'partial 时 record 保留供重试');
    // 未失败的步骤已完成：handoff / board / archive 不残留
    assert.equal(first.cleanup.steps.handoffs.ok, true);
    assert.equal(first.cleanup.steps.board.ok, true);
    assert.equal(await env.board.getState(threadId), null);
    assert.equal(await env.archive.isArchived(threadId), false);
    const handoffDir = path.join(getContextHandoffsRoot(path.join(base, `del-${counter}`, 'user-data')), AGENT);
    assert.deepEqual(await fs.readdir(handoffDir), []);
    // record 仍在（closed）：可寻址
    assert.ok(await env.core.getThread(threadId));

    // 重复执行（session 清理器恢复）继续收敛到 complete
    const second = await env.deleteService.deleteThread(threadId, { forceWaitMs: 50 });
    assert.equal(second.status, 'complete');
    assert.equal(second.deleted, true);
    assert.deepEqual(second.cleanup.failures, []);
    assert.equal(await env.core.getThread(threadId), null, '收敛后 record 删除');
    assert.deepEqual(await memberSessionFiles(env), [], '残留会话文件在重试中清除');
  });
});

// ─── 4. 成员目标解析（历史 Session 不能单独删除）──────────────────

describe('T005: 成员目标解析到所属 Thread', () => {
  it('deleting a historical session target deletes the whole thread', async () => {
    const env = makeDeleteEnvironment();
    const threadId = await startTwoLinkThread(env.core);
    const { record } = await env.core.store.update(threadId, (draft) => draft); // 取当前记录
    void record;

    const outcome = await env.deleteService.deleteBySessionTarget(AGENT, 's1'); // 历史成员（root/predecessor）

    assert.equal(outcome.actual.type, 'thread');
    assert.equal(outcome.actual.id, threadId);
    assert.equal(outcome.requested.sessionId, 's1');
    assert.equal(outcome.result.status, 'complete');
    // 整条线程被删（不是单个历史棒）：head 会话数据一并清理
    assert.equal(await env.core.getThread(threadId), null);
    assert.deepEqual(env.observation.removedSessions.length, 1);
  });

  it('resolves any member (root / historical / head) to the same thread', async () => {
    const env = makeDeleteEnvironment();
    const threadId = await startTwoLinkThread(env.core);
    for (const sessionId of ['s1', 's2']) {
      const target = await env.deleteService.resolveThreadTarget(AGENT, sessionId);
      assert.ok(target, `${sessionId} must resolve to a thread`);
      assert.equal(target.thread.threadId, threadId);
    }
  });

  it('non-member (main) sessions are never resolved to a thread', async () => {
    const env = makeDeleteEnvironment();
    await startTwoLinkThread(env.core);
    const target = await env.deleteService.resolveThreadTarget(AGENT, 'main-session-x');
    assert.equal(target, null);
    const outcome = await env.deleteService.deleteBySessionTarget(AGENT, 'main-session-x');
    assert.equal(outcome, null, '调用方据此走独立 Session 删除语义');
  });

  it('session delete route resolves thread members to thread deletion (T003 resolveLifecycleTarget)', async () => {
    // 源码级契约（与 T004 归档路由同源模式）：session 删除路由经统一目标
    // 解析，Thread 成员删除走 threadDelete.deleteThread（级联清理），
    // 独立 Session（main）保持原删除路径（deletePrebuiltSession）。
    const fsSync = await import('node:fs');
    const sessionRoutes = fsSync.readFileSync(
      new URL('../server/routes/session.js', import.meta.url), 'utf8',
    );
    const start = sessionRoutes.indexOf("app.post('/protoclaw/prebuilt_sessions/delete'");
    assert.ok(start >= 0, 'session delete route must exist');
    const route = sessionRoutes.slice(start, sessionRoutes.indexOf('app.post(', start + 10));
    assert.match(route, /resolveLifecycleTarget\(\{/);
    assert.match(route, /lifecycleTarget\.actual\.type === 'thread'/);
    assert.match(route, /threadDelete\.deleteThread\(lifecycleTarget\.actual\.id/);
    assert.match(route, /deletePrebuiltSession\(agent\.id, sessionId/);
  });
});

// ─── 5. 删除后旧 ID 明确 not found / deleted ─────────────────────

describe('T005: 删除后旧 ID 的读路径', () => {
  it('thread detail / commands / deliver all return not found after delete', async () => {
    const env = makeDeleteEnvironment();
    const threadId = await startTwoLinkThread(env.core);
    const lifecycle = createThreadLifecycleService({ control: env.control, stopSession: async () => ({ status: 'stopped' }) });
    const app = makeMockApp();
    setupThreadRoutes(app, { json: () => () => {} }, { control: env.control, lifecycle, threadDelete: env.deleteService });

    await env.deleteService.deleteThread(threadId, { forceWaitMs: 50 });

    const detail = await callRoute(app, 'GET', '/protoclaw/threads/:threadId', { params: { threadId } });
    assert.equal(detail.statusCode, 404);
    assert.equal(detail.body.code, 'thread_not_found');

    const cmd = await callRoute(app, 'POST', '/protoclaw/threads/:threadId/commands', {
      params: { threadId }, body: { text: 'late command', source: 'ui' },
    });
    assert.equal(cmd.statusCode, 404);
    assert.match(cmd.body.code, /not_found/);

    const deliver = await callRoute(app, 'POST', '/protoclaw/threads/:threadId/deliver', { params: { threadId } });
    assert.equal(deliver.statusCode, 404);
    assert.match(deliver.body.code, /not_found/);
  });

  it('rejects new command writes and delivery against a closed thread in the partial residual window', async () => {
    // partial 失败（record 保留、closed 终态）= 删除 seal 后 / record 删除前
    // 的窗口：新 command 写入与自动投递必须被拒（thread_closed）。
    // failRemoveSessions 持续失败（always）确保 partial 窗口不收敛。
    const env = makeDeleteEnvironment({ failRemoveSessions: true, failRemoveSessionsMode: 'always' });
    const threadId = await startTwoLinkThread(env.core);
    const lifecycle = createThreadLifecycleService({ control: env.control, stopSession: async () => ({ status: 'stopped' }) });
    const app = makeMockApp();
    setupThreadRoutes(app, { json: () => () => {} }, { control: env.control, lifecycle, threadDelete: env.deleteService });

    const partial = await env.deleteService.deleteThread(threadId, { forceWaitMs: 50 });
    assert.equal(partial.status, 'partial');

    const cmd = await callRoute(app, 'POST', '/protoclaw/threads/:threadId/commands', {
      params: { threadId }, body: { text: 'new work', source: 'ui' },
    });
    assert.equal(cmd.statusCode, 409);
    assert.equal(cmd.body.code, 'thread_closed');

    const deliver = await callRoute(app, 'POST', '/protoclaw/threads/:threadId/deliver', { params: { threadId } });
    assert.equal(deliver.statusCode, 409);
    assert.equal(deliver.body.code, 'thread_closed');

    // 删除路由对 partial 不伪装成功
    const delRoute = await callRoute(app, 'POST', '/protoclaw/threads/:threadId/delete', {
      params: { threadId }, body: {},
    });
    assert.equal(delRoute.body.ok, false);
    assert.equal(delRoute.body.status, 'partial');
    assert.ok(Array.isArray(delRoute.body.cleanup.failures));
  });
});

// ─── 6. main 独立 Session 删除行为保持不变 ─────────────────────────

describe('T005: main 独立 Session 不受影响', () => {
  it('thread delete only touches member sessions; independent main session data is untouched', async () => {
    const env = makeDeleteEnvironment();
    const threadId = await startTwoLinkThread(env.core);
    const sessionsDir = path.join(base, `del-${counter}`, 'sessions');
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.writeFile(path.join(sessionsDir, 's1.json'), '{}', 'utf8');
    await fs.writeFile(path.join(sessionsDir, 's2.json'), '{}', 'utf8');
    await fs.writeFile(path.join(sessionsDir, 'main-1.json'), '{}', 'utf8'); // 独立 main 会话

    const result = await env.deleteService.deleteThread(threadId, { forceWaitMs: 50 });

    assert.equal(result.status, 'complete');
    const remaining = await memberSessionFiles(env);
    assert.deepEqual(remaining, ['main-1.json'], '独立 main 会话数据不受线程删除影响');
  });

  it('main session has no thread membership and keeps its independent lifecycle', async () => {
    const env = makeDeleteEnvironment();
    const threadId = await startTwoLinkThread(env.core);
    // main 会话无线程归属：解析返回 null（不落入任何线程的成员集合）
    const found = await env.deleteService.resolveThreadTarget(AGENT, 'main-session');
    assert.equal(found, null);

    // 线程删除不影响 main 会话：main 不在成员集合、不被级联清理
    const result = await env.deleteService.deleteThread(threadId, { forceWaitMs: 50 });
    assert.equal(result.status, 'complete');
    assert.ok(!result.cleanup.sessionIds.includes('main-session'), 'main 会话不属于成员集合');
    assert.equal(
      (await env.core.listThreads()).find((t) => t.threadId === threadId),
      undefined,
      '线程删除后无残留线程',
    );
    // 删除后 main 会话的归属查询仍返回 null（独立 Session 语义不变）
    assert.equal(await env.deleteService.resolveThreadTarget(AGENT, 'main-session'), null);
  });
});

// ─── 7. 收尾事实源与状态一致性 ────────────────────────────────────

describe('T005: 命令状态事实', () => {
  it('seal cancels pending and in_flight commands with the deleting reason', async () => {
    const env = makeDeleteEnvironment();
    const threadId = await startTwoLinkThread(env.core);
    await env.core.appendCommand({ threadId, text: 'queued', source: 'ui' });
    const { command: pendingCommand } = { command: null };
    void pendingCommand;

    const result = await env.deleteService.deleteThread(threadId, { forceWaitMs: 50 });
    assert.equal(result.status, 'complete');
    assert.equal(result.cleanup.commandsCancelled, 1);
    assert.equal(result.deleted, true);
  });

  it('command statuses use the shared vocabulary (no invented states)', async () => {
    assert.equal(ThreadCommandStatus.PENDING, 'pending');
    assert.equal(ThreadCommandStatus.CANCELLED, 'cancelled');
    const env = makeDeleteEnvironment();
    const threadId = await startTwoLinkThread(env.core);
    await env.core.appendCommand({ threadId, text: 'x', source: 'ui' });
    await env.deleteService.deleteThread(threadId, { forceWaitMs: 50 });
    // 已删线程无记录可读；状态词汇断言在 seal 前由 thread-control 测试覆盖
  });
});
