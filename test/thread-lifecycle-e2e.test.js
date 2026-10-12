/**
 * 线程生命周期端到端语义矩阵（thread-lifecycle-e2e）
 *
 * 全部使用真实模块组合（框架 WorkThread/Board/文件存储 + Claw 服务层
 * lifecycle/delete/C1 收敛/C2 恢复/lifeState 投影），仅在进程与投递边界
 * （stopSession / ensureHeadRuntime / submitUserTurn / removeSessions）
 * 注入记录型 stub——不实机运行，逻辑链路保真。
 *
 * 覆盖分区：
 * A. 看板转换矩阵（真实事件流驱动，含 F1 turn.cancelled → idle）
 * B. 锚点 × 指令域（closed 取消、幂等、终态裁剪）
 * C. 守卫与事务（hold 投递闸、归档 seal/unarchive 往返、删除事务 closed 不残留）
 * D. 全生命周期场景链（主循环 / 手动中断 / C1 收敛 / C2 崩溃恢复 / 交接中断收敛）
 * E. lifeState 投影合成矩阵
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { WorkThreadRuntimeBridge } from '@agentdevjs/core';
import { createThreadControl } from '../server/thread-control/thread-controller.js';
import { createThreadLifecycleService } from '../server/thread-control/thread-lifecycle.js';
import { createThreadDeleteService } from '../server/thread-control/thread-delete.js';
import { createThreadRestartResume } from '../server/thread-control/thread-restart-resume.js';
import { convergeThreadBoardOnDeliberateStop } from '../server/thread-control/deliberate-stop-convergence.js';
import { createThreadRecoveryService } from '../server/thread-control/thread-succession.js';
import { synthesizeThreadLifeState } from '../server/thread-control/thread-life-state.js';

let envSeq = 0;

async function makeEnv() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claw-e2e-'));
  const control = createThreadControl({
    rootDir: path.join(root, `e${envSeq++}`),
    bridge: new WorkThreadRuntimeBridge({}),
  });
  const stops = [];
  const stopSession = async (...args) => { stops.push(args); };
  const lifecycle = createThreadLifecycleService({ control, stopSession });
  const removedSessions = [];
  const deleteService = createThreadDeleteService({
    control,
    stopSession,
    removeSessions: async (agentId, sessionIds) => { removedSessions.push({ agentId, sessionIds: [...sessionIds] }); },
    // drain 轮询压缩到 1-2ms：真实定时器语义，墙钟预算不膨胀
    timers: { setTimeout: (fn, ms) => globalThis.setTimeout(fn, Math.min(Number(ms) || 1, 2)) },
  });
  const calls = { wake: [], submit: [] };
  // 寻址缝：生产 resolveSessionViewerId 扫描真实 runtime 表；测试按会话注入，
  // 断言续跑投递走 viewerAgentId（与 bridge 同口径），而非裸 agentId。
  const viewerIdBySession = new Map();
  const moduleControl = {
    ...control,
    resolveSessionViewerId: (agentId, sessionId) => viewerIdBySession.get(sessionId) ?? null,
  };
  const resume = createThreadRestartResume({
    control: moduleControl,
    ensureHeadRuntime: async (agentId, sessionId) => { calls.wake.push({ agentId, sessionId }); return { ok: true }; },
    submitUserTurn: async (params) => { calls.submit.push(params); },
  });
  const recovery = createThreadRecoveryService({ threadControl: control });

  async function startThread(agentId, sessionId) {
    return control.core.start({ sessionRef: { agentId, sessionId } });
  }

  async function emit(thread, type, extra = {}) {
    const payload = { type, turn: 1, ...extra };
    if (type === 'turn.failed' && !payload.error) payload.error = { message: 'e2e-failure' };
    if (type === 'turn.cancelled' && !payload.error) payload.error = { message: 'interrupted', reason: 'cancelled' };
    return control.board.recordRuntimeEvent({
      agentId: thread.agentId,
      sessionId: thread.headSessionId,
      runtimeInstanceId: 'rt-e2e',
      event: payload,
    });
  }

  async function life(threadId) {
    const [record, boardState, archiveEntries] = await Promise.all([
      control.core.getThread(threadId),
      control.board.getState(threadId),
      control.archive.list().catch(() => ({})),
    ]);
    return synthesizeThreadLifeState({ thread: record, boardState, archiveEntry: archiveEntries[threadId] ?? null });
  }

  async function cleanup() {
    await fs.rm(root, { recursive: true, force: true });
  }

  return { root, control, lifecycle, deleteService, resume, recovery, stops, removedSessions, calls, viewerIdBySession, startThread, emit, life, cleanup };
}

// ── A. 看板转换矩阵（真实事件流）──────────────────────────────────

describe('A. 看板转换矩阵', () => {
  test('A1 事件全链往返：started→running / completed→idle / 再 started→running', async () => {
    const env = await makeEnv();
    try {
      const t = await env.startThread('e2e-a1', 's-a1');
      assert.equal((await env.emit(t, 'turn.started')).state.status, 'running');
      assert.equal((await env.emit(t, 'turn.completed')).state.status, 'idle');
      assert.equal((await env.emit(t, 'turn.started', { turn: 2 })).state.status, 'running');
      assert.equal((await env.emit(t, 'turn.completed', { turn: 2 })).state.status, 'idle');
    } finally { await env.cleanup(); }
  });

  test('A2 turn.failed→failed；随后迟到 turn.cancelled 把 failed 收敛为 idle（F1 合法收敛）', async () => {
    const env = await makeEnv();
    try {
      const t = await env.startThread('e2e-a2', 's-a2');
      await env.emit(t, 'turn.started');
      assert.equal((await env.emit(t, 'turn.failed')).state.status, 'failed');
      assert.equal((await env.emit(t, 'turn.cancelled')).state.status, 'idle');
    } finally { await env.cleanup(); }
  });

  test('A3 F1 语义：turn.cancelled → idle（手动中断不是失败），事件仍入执行流水', async () => {
    const env = await makeEnv();
    try {
      const t = await env.startThread('e2e-a3', 's-a3');
      await env.emit(t, 'turn.started');
      const result = await env.emit(t, 'turn.cancelled');
      assert.equal(result.state.status, 'idle');
      const life = await env.life(t.threadId);
      assert.equal(life.lifeState, 'idle');
      assert.equal(life.failed, false, '手动中断无红点');
    } finally { await env.cleanup(); }
  });

  test('A4 waiting_input（宿主播种）不卡死：后续 turn.started 事件照常收敛 running', async () => {
    const env = await makeEnv();
    try {
      const t = await env.startThread('e2e-a4', 's-a4');
      await env.control.board.setStatus(t.threadId, 'waiting_input');
      assert.equal((await env.emit(t, 'turn.started')).state.status, 'running');
      assert.equal((await env.emit(t, 'turn.completed')).state.status, 'idle');
    } finally { await env.cleanup(); }
  });

  test('A5 closed（归档 seal）后迟到 turn.completed 不改变看板——closed 无出边', async () => {
    const env = await makeEnv();
    try {
      const t = await env.startThread('e2e-a5', 's-a5');
      await env.emit(t, 'turn.started');
      await env.lifecycle.archiveThread(t.threadId);
      await env.emit(t, 'turn.completed');
      assert.equal((await env.control.board.getState(t.threadId)).status, 'closed');
    } finally { await env.cleanup(); }
  });

  test('A6 failed 有出边：新回合 turn.started 可重新执行（失败不是终局）', async () => {
    const env = await makeEnv();
    try {
      const t = await env.startThread('e2e-a6', 's-a6');
      await env.emit(t, 'turn.started');
      await env.emit(t, 'turn.failed');
      assert.equal((await env.control.board.getState(t.threadId)).status, 'failed');
      assert.equal((await env.emit(t, 'turn.started', { turn: 2 })).state.status, 'running');
      assert.equal((await env.emit(t, 'turn.completed', { turn: 2 })).state.status, 'idle');
    } finally { await env.cleanup(); }
  });
});

// ── B. 锚点 × 指令域 ─────────────────────────────────────────────

describe('B. 锚点 × 指令域', () => {
  test('B1 closeThread 落盘时 pending 指令批量转 cancelled', async () => {
    const env = await makeEnv();
    try {
      const t = await env.startThread('e2e-b1', 's-b1');
      await env.control.core.appendCommand({ threadId: t.threadId, text: 'job1' });
      await env.control.core.appendCommand({ threadId: t.threadId, text: 'job2' });
      await env.control.core.closeThread(t.threadId, { reason: 'e2e' });
      const record = await env.control.core.getThread(t.threadId);
      assert.equal(record.status, 'closed');
      assert.ok(record.commands.every((c) => c.status === 'cancelled'));
    } finally { await env.cleanup(); }
  });

  test('B2 appendCommand 幂等键去重：同键不重复入箱', async () => {
    const env = await makeEnv();
    try {
      const t = await env.startThread('e2e-b2', 's-b2');
      const first = await env.control.core.appendCommand({ threadId: t.threadId, text: 'job', idempotencyKey: 'idem-1' });
      const second = await env.control.core.appendCommand({ threadId: t.threadId, text: 'job', idempotencyKey: 'idem-1' });
      assert.equal(first.duplicate, false);
      assert.equal(second.duplicate, true);
      const record = await env.control.core.getThread(t.threadId);
      assert.equal(record.commands.length, 1);
    } finally { await env.cleanup(); }
  });

  test('B3 终态指令裁剪：超上限的终态指令被裁，pending 永不裁', async () => {
    const env = await makeEnv();
    try {
      const t = await env.startThread('e2e-b3', 's-b3');
      for (let i = 0; i < 205; i++) {
        await env.control.core.appendCommand({ threadId: t.threadId, text: `job-${i}` });
        // 直接标记终态制造裁剪压力
        await env.control.core.store.update(t.threadId, (draft) => {
          const last = draft.commands[draft.commands.length - 1];
          if (last && last.status === 'pending') last.status = 'delivered';
          return draft;
        });
      }
      await env.control.core.appendCommand({ threadId: t.threadId, text: 'still-pending' });
      const record = await env.control.core.getThread(t.threadId);
      // 语义：终态指令保留上限 200，pending 永不裁
      const terminal = record.commands.filter((c) => c.status !== 'pending');
      assert.ok(terminal.length <= 200, `terminal commands capped at 200, got ${terminal.length}`);
      assert.equal(record.commands[record.commands.length - 1].text, 'still-pending');
      assert.equal(record.commands[record.commands.length - 1].status, 'pending');
    } finally { await env.cleanup(); }
  });
});

// ── C. 守卫与事务 ─────────────────────────────────────────────────

describe('C. 守卫与事务', () => {
  test('C1 hold 投递闸：held 时 deliver 0 投（thread_held），解除后恢复', async () => {
    const env = await makeEnv();
    try {
      const t = await env.startThread('e2e-c1', 's-c1');
      await env.control.core.appendCommand({ threadId: t.threadId, text: 'job' });
      await env.control.core.setHold(t.threadId, true);
      const held = await env.control.core.deliverPendingCommands(t.threadId);
      assert.equal(held.reason, 'thread_held');
      assert.equal(held.delivered, 0);
      await env.control.core.setHold(t.threadId, false);
      const released = await env.control.core.deliverPendingCommands(t.threadId);
      assert.notEqual(released.reason, 'thread_held');
    } finally { await env.cleanup(); }
  });

  test('C2 归档 seal 事务：pending 取消 + board closed + hold 置位 + lifeState archived', async () => {
    const env = await makeEnv();
    try {
      const t = await env.startThread('e2e-c2', 's-c2');
      await env.control.core.appendCommand({ threadId: t.threadId, text: 'pending-job' });
      await env.emit(t, 'turn.started');
      await env.lifecycle.archiveThread(t.threadId);
      const [record, boardState, life] = await Promise.all([
        env.control.core.getThread(t.threadId),
        env.control.board.getState(t.threadId),
        env.life(t.threadId),
      ]);
      assert.equal(boardState.status, 'closed');
      assert.ok(record.commands.every((c) => c.status === 'cancelled'));
      assert.equal(record.hold, true, '归档 hold 保证清理期不再消费');
      assert.equal(life.lifeState, 'archived');
    } finally { await env.cleanup(); }
  });

  test('C3 归档后投递闸关闭：deliver 0 投', async () => {
    const env = await makeEnv();
    try {
      const t = await env.startThread('e2e-c3', 's-c3');
      await env.lifecycle.archiveThread(t.threadId);
      // 归档后 append 会被路由层拒（thread_archived）；core 层直接验证 hold 闸
      const delivered = await env.control.core.deliverPendingCommands(t.threadId);
      assert.equal(delivered.delivered, 0);
    } finally { await env.cleanup(); }
  });

  test('C4 unarchive 往返：看板回 idle、已取消指令不复活、可再投新指令', async () => {
    const env = await makeEnv();
    try {
      const t = await env.startThread('e2e-c4', 's-c4');
      await env.control.core.appendCommand({ threadId: t.threadId, text: 'old-job' });
      await env.lifecycle.archiveThread(t.threadId);
      await env.lifecycle.unarchiveThread(t.threadId);
      const [record, boardState, life] = await Promise.all([
        env.control.core.getThread(t.threadId),
        env.control.board.getState(t.threadId),
        env.life(t.threadId),
      ]);
      assert.equal(record.status, 'open');
      assert.equal(record.hold, false);
      assert.ok(record.commands.every((c) => c.status === 'cancelled'), '取消的指令不复活');
      assert.equal(boardState.status, 'idle', '看板经 reopen 回 idle');
      assert.equal(life.lifeState, 'idle');
      const fresh = await env.control.core.appendCommand({ threadId: t.threadId, text: 'new-job' });
      assert.equal(fresh.duplicate, false);
    } finally { await env.cleanup(); }
  });

  test('C5 删除事务：complete + 级联删会话 + 线程记录消失（closed 中间态不残留盘上）', async () => {
    const env = await makeEnv();
    try {
      const t = await env.startThread('e2e-c5', 's-c5');
      await env.control.core.appendCommand({ threadId: t.threadId, text: 'job' });
      const result = await env.deleteService.deleteThread(t.threadId, { reason: 'e2e' });
      assert.equal(result.status, 'complete');
      assert.ok(env.removedSessions.some((r) => r.sessionIds.includes('s-c5')), '级联删除 head 会话');
      // 语义：complete 删除后线程记录从盘上消失（closed 只在事务中途存在）
      assert.equal(await env.control.core.getThread(t.threadId), null);
    } finally { await env.cleanup(); }
  });

  test('C6 删除幂等：已删除线程再次删除不报错', async () => {
    const env = await makeEnv();
    try {
      const t = await env.startThread('e2e-c6', 's-c6');
      await env.deleteService.deleteThread(t.threadId, { reason: 'e2e' });
      const again = await env.deleteService.deleteThread(t.threadId, { reason: 'e2e-again' });
      assert.equal(again.deleted, true);
      assert.equal(again.idempotent, true);
      assert.equal(env.removedSessions.length, 1, '幂等删除不重复级联清理');
    } finally { await env.cleanup(); }
  });
});

// ── D. 全生命周期场景链 ───────────────────────────────────────────

describe('D. 场景链', () => {
  test('D1 主循环：派活→执行→完成→idle→归档→archived（coder 静默归档主线）', async () => {
    const env = await makeEnv();
    try {
      const t = await env.startThread('e2e-d1', 's-d1');
      await env.control.core.appendCommand({ threadId: t.threadId, text: 'build feature' });
      // 模拟 bridge 投递成功事实：指令离开 pending
      await env.control.core.store.update(t.threadId, (draft) => {
        draft.commands.forEach((c) => { if (c.status === 'pending') c.status = 'delivered'; });
        return draft;
      });
      await env.emit(t, 'turn.started');
      assert.equal((await env.life(t.threadId)).lifeState, 'executing');
      await env.emit(t, 'turn.completed');
      assert.equal((await env.life(t.threadId)).lifeState, 'idle');
      await env.lifecycle.archiveThread(t.threadId);
      assert.equal((await env.life(t.threadId)).lifeState, 'archived');
      assert.equal(env.calls.wake.length, 0, '主循环全程无需恢复拉起');
    } finally { await env.cleanup(); }
  });

  test('D2 手动中断链（F1）：running→cancelled→idle，无红点，重启恢复不触发', async () => {
    const env = await makeEnv();
    try {
      const t = await env.startThread('e2e-d2', 's-d2');
      await env.emit(t, 'turn.started');
      await env.emit(t, 'turn.cancelled');
      const life = await env.life(t.threadId);
      assert.equal(life.lifeState, 'idle');
      assert.equal(life.failed, false);
      const report = await env.resume.resumeInterruptedThreads();
      assert.equal(report.resumed.length, 0, '手动中断后重启不拉起（用户意志不续作）');
    } finally { await env.cleanup(); }
  });

  test('D3 手动关 Agent 链（C1）：running→收敛 idle；二次收敛幂等 no-op', async () => {
    const env = await makeEnv();
    try {
      const t = await env.startThread('e2e-d3', 's-d3');
      await env.emit(t, 'turn.started');
      assert.equal(await convergeThreadBoardOnDeliberateStop('e2e-d3', 's-d3', env.control), true);
      assert.equal((await env.control.board.getState(t.threadId)).status, 'idle');
      assert.equal(await convergeThreadBoardOnDeliberateStop('e2e-d3', 's-d3', env.control), false, '幂等 no-op');
      assert.equal(env.calls.wake.length, 0, '重启恢复也不触发');
    } finally { await env.cleanup(); }
  });

  test('D4 C1 边界：非 head 会话 no-op；看板 closed（已归档）no-op', async () => {
    const env = await makeEnv();
    try {
      const t = await env.startThread('e2e-d4', 's-d4');
      assert.equal(await convergeThreadBoardOnDeliberateStop('e2e-d4', 'not-a-session', env.control), false);
      await env.emit(t, 'turn.started');
      await env.lifecycle.archiveThread(t.threadId);
      assert.equal(await convergeThreadBoardOnDeliberateStop('e2e-d4', 's-d4', env.control), false);
      assert.equal((await env.control.board.getState(t.threadId)).status, 'closed');
    } finally { await env.cleanup(); }
  });

  test('D5 崩溃恢复链（C2+F2）：turn.started 无收尾 → 重启扫描 → kind=resume 空消息续跑', async () => {
    const env = await makeEnv();
    try {
      const t = await env.startThread('e2e-d5', 's-d5');
      await env.emit(t, 'turn.started'); // 崩溃：无收尾事件，看板停留 running
      env.viewerIdBySession.set('s-d5', 'agent-d5-p1');
      const report = await env.resume.resumeInterruptedThreads();
      assert.equal(report.resumed.length, 1);
      assert.equal(report.resumed[0].action, 'resume_interrupted_turn');
      assert.deepEqual(env.calls.submit.map((s) => ({ kind: s.kind, text: s.text, agentId: s.agentId })),
        [{ kind: 'resume', text: '', agentId: 'agent-d5-p1' }]);
    } finally { await env.cleanup(); }
  });

  test('D6 崩溃 + 归档并发语义：归档打断收纳后重启恢复跳过（archived 压倒一切）', async () => {
    const env = await makeEnv();
    try {
      const t = await env.startThread('e2e-d6', 's-d6');
      await env.emit(t, 'turn.started');
      await env.lifecycle.archiveThread(t.threadId); // 执行中归档：打断收纳
      const report = await env.resume.resumeInterruptedThreads();
      assert.equal(report.resumed.length, 0);
      assert.equal(report.skipped[0].reason, 'archived');
    } finally { await env.cleanup(); }
  });

  test('D7 交接中断恢复（head 会话丢失分支）：挡板残留 → 收敛 → rotation_failed + pending 显式 failed + 挡板清除', async () => {
    const env = await makeEnv();
    try {
      const t = await env.startThread('e2e-d7', 's-d7');
      await env.control.core.appendCommand({ threadId: t.threadId, text: 'job' });
      await env.control.core.beginSessionHandoff({ threadId: t.threadId, fromSessionId: 's-d7', reason: 'e2e-crash' });
      const record = await env.control.core.getThread(t.threadId);
      assert.equal(record.status, 'rotating');
      const report = await env.recovery.convergeInterruptedSuccessions();
      assert.ok(report.converged.some((c) => c.threadId === t.threadId), '挡板残留线程必须被收敛');
      const after = await env.control.core.getThread(t.threadId);
      // 语义：测试环境无会话索引（head 不可承接）→ pending 指令显式 failed
      // （永不投向未知目标）、失败事实落盘（rotation_failed）、挡板清除。
      // head 可承接分支（pending 保留）由 thread-succession.test.js 覆盖。
      assert.equal(after.status, 'rotation_failed');
      assert.equal(after.pendingSuccession, null);
      const job = after.commands.find((c) => c.text === 'job');
      assert.equal(job.status, 'failed');
      assert.equal(job.lastReason, 'head_session_missing');
    } finally { await env.cleanup(); }
  });

  test('D8 deleting 窗口：恢复扫描跳过（deleting 期间不得拉起）；独立线程验证删除事务收敛', async () => {
    const env = await makeEnv();
    try {
      // 段一：running 现场被删除事务标记 → 恢复扫描必须跳过
      const t = await env.startThread('e2e-d8', 's-d8');
      await env.emit(t, 'turn.started');
      await env.control.core.store.update(t.threadId, (draft) => { draft.deleting = true; return draft; });
      const report = await env.resume.resumeInterruptedThreads();
      assert.equal(report.resumed.length, 0);
      assert.equal(env.calls.wake.length, 0);
      assert.ok(report.skipped.some((s) => s.threadId === t.threadId));

      // 段二：删除事务收敛（idle 现场，无 drain 等待）
      const t2 = await env.startThread('e2e-d8b', 's-d8b');
      const result = await env.deleteService.deleteThread(t2.threadId, { reason: 'e2e' });
      assert.equal(result.status, 'complete');
      assert.equal(await env.control.core.getThread(t2.threadId), null);
    } finally { await env.cleanup(); }
  });
});

// ── E. lifeState 投影合成矩阵 ─────────────────────────────────────

describe('E. lifeState 投影矩阵', () => {
  test('E1 archived 压倒 board running（归档是唯一终局）', async () => {
    const env = await makeEnv();
    try {
      const t = await env.startThread('e2e-e1', 's-e1');
      await env.emit(t, 'turn.started');
      await env.lifecycle.archiveThread(t.threadId);
      assert.equal((await env.life(t.threadId)).lifeState, 'archived');
    } finally { await env.cleanup(); }
  });

  test('E2 closed 锚点 → lifeState closed（列表过滤目标）', async () => {
    const env = await makeEnv();
    try {
      const t = await env.startThread('e2e-e2', 's-e2');
      await env.control.core.closeThread(t.threadId, { reason: 'e2e' });
      assert.equal((await env.life(t.threadId)).lifeState, 'closed');
    } finally { await env.cleanup(); }
  });

  test('E3 rotating（交接中）→ executing（交接也是活跃）', async () => {
    const env = await makeEnv();
    try {
      const t = await env.startThread('e2e-e3', 's-e3');
      await env.control.core.beginSessionHandoff({ threadId: t.threadId, fromSessionId: 's-e3', reason: 'e2e' });
      // 语义：交接中也是活跃工作（交接在途时线程在执行接力）
      assert.equal((await env.life(t.threadId)).lifeState, 'executing');
    } finally { await env.cleanup(); }
  });

  test('E4 board running → executing；rotation_failed → failed 红点叠加', async () => {
    const env = await makeEnv();
    try {
      const t = await env.startThread('e2e-e4', 's-e4');
      await env.emit(t, 'turn.started');
      assert.equal((await env.life(t.threadId)).lifeState, 'executing');

      const t2 = await env.startThread('e2e-e4b', 's-e4b');
      await env.control.core.beginSessionHandoff({ threadId: t2.threadId, fromSessionId: 's-e4b', reason: 'e2e' });
      await env.control.core.failSessionHandoff(t2.threadId, { reason: 'e2e', stage: 'commit' });
      const life2 = await env.life(t2.threadId);
      assert.equal(life2.failed, true, 'rotation_failed → 红点');
    } finally { await env.cleanup(); }
  });

  test('E5 pending 指令（无执行）→ pending-commands；空线程 → idle', async () => {
    const env = await makeEnv();
    try {
      const t = await env.startThread('e2e-e5', 's-e5');
      assert.equal((await env.life(t.threadId)).lifeState, 'idle');
      await env.control.core.appendCommand({ threadId: t.threadId, text: 'queued' });
      assert.equal((await env.life(t.threadId)).lifeState, 'pending-commands');
    } finally { await env.cleanup(); }
  });

  test('E6 board failed → failed 红点（失败等人，不自动拉起）', async () => {
    const env = await makeEnv();
    try {
      const t = await env.startThread('e2e-e6', 's-e6');
      await env.emit(t, 'turn.started');
      await env.emit(t, 'turn.failed');
      const life = await env.life(t.threadId);
      assert.equal(life.failed, true);
      assert.equal(life.lifeState, 'idle', '失败后看板 failed，非执行态');
      const report = await env.resume.resumeInterruptedThreads();
      assert.equal(report.resumed.length, 0);
    } finally { await env.cleanup(); }
  });
});
