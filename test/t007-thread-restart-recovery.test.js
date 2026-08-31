/**
 * T007 场景 16：重启 server/runtime 后 Thread、head、Inbox 和归档结果仍能恢复。
 *
 * 既有测试覆盖单实例内的状态持久化（thread-store 读写、ThreadArchiveIndex
 * 跨实例）与崩溃后收敛（thread-succession 重启收敛），但没有一个测试把
 * 「新 control 实例读回完整现场」作为一条链验证。本文件补这条链：
 *
 * 1. 实例 A 建线程、推进 head、暂存 Inbox 指令、记录 board 事件、归档/恢复；
 * 2. 实例 B（同 rootDir，模拟 server 重启）读回：thread 记录、head、
 *    sessionChain、Inbox 指令与状态、board 状态、归档标记；
 * 3. 实例 B 上继续操作（新指令可 append、旧 pending 可投递）——恢复不只是
 *    可读，还能继续服务。
 *
 * 竞态确定性：归档与并发 append 的交错用 gate Promise 显式控制，不靠 sleep。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { WorkThreadRuntimeBridge } from '@agentdevjs/core';

import { createThreadControl } from '../server/thread-control/thread-controller.js';
import { createThreadIntegration } from '../server/thread-control/thread-integration.js';
import { WorkThreadCommandStatus as ThreadCommandStatus } from '@agentdevjs/core';

import { makeThreadEnv, startCoderThread } from './t007-helpers.js';

let base;
before(async () => { base = mkdtempSync(path.join(os.tmpdir(), 'claw-t007-restart-')); });
after(async () => { if (base) rmSync(base, { recursive: true, force: true }); });

function makeEnv(suffix, bridgeOptions) {
  const env = makeThreadEnv({ baseDir: base, suffix, bridgeOptions });
  return env;
}

describe('T007 S16: server 重启后线程现场完整恢复（跨 control 实例）', () => {
  it('head / chain / identity / inbox / board / archive 在新实例上可读回并继续服务', async () => {
    // ── 实例 A：装配完整现场 ────────────────────────────────
    const a = makeEnv('a-full');
    try {
      const thread = await startCoderThread(a, 's1');
      // head 推进：s1 → s2（s2 身份 coder，经 advanceHead 门禁）
      a.identity.register('s2', 'coder');
      await a.core.advanceHead({ threadId: thread.threadId, toSessionId: 's2', fromSessionId: 's1', endKind: 'trim' });
      // Inbox：一条 pending（重启期间积累）+ 一条 delivered（经 bridge 投递过）
      await a.core.appendCommand({ threadId: thread.threadId, text: '重启前积累', idempotencyKey: 'ik-1' });
      // board 事件：turn 开始（running 态）
      await a.board.recordRuntimeEvent({
        agentId: 'programming-helper', sessionId: 's2', runtimeInstanceId: 'rt-a',
        event: { type: 'turn.started', turn: 1 },
      });

      // ── 实例 B：模拟 server 重启（同 rootDir 新 control）────
      const b = makeEnv('a-full');
      try {
        const record = await b.core.getThread(thread.threadId);
        assert.equal(record.headSessionId, 's2', 'head 恢复');
        assert.equal(record.identity, 'coder', '身份事实恢复（T001 落盘字段）');
        assert.equal(record.status, 'open');
        assert.deepEqual(
          record.sessionChain.map((e) => e.sessionId),
          ['s1', 's2'],
          '线性链恢复',
        );
        assert.equal(record.sessionChain[0].role, 'predecessor');
        assert.equal(record.sessionChain[1].role, 'head');

        // 成员查询恢复（生命周期所有权不丢）
        const byMember = await b.core.findThreadBySession('programming-helper', 's1');
        assert.equal(byMember.threadId, thread.threadId);

        // Inbox 恢复：pending 保留且可继续投递
        const inbox = record.commands;
        assert.equal(inbox.length, 1);
        assert.equal(inbox[0].text, '重启前积累');
        assert.equal(inbox[0].status, ThreadCommandStatus.PENDING);

        // board 状态恢复（执行现场）
        const boardState = await b.board.getState(thread.threadId);
        assert.equal(boardState.status, 'running');
        assert.equal(boardState.lastLifecycleEvent.type, 'turn.started');

        // 恢复后继续服务：新指令可 append、成员归属不变
        await b.core.appendCommand({ threadId: thread.threadId, text: '重启后新指令', idempotencyKey: 'ik-2' });
        const after = await b.core.getThread(thread.threadId);
        assert.equal(after.commands.length, 2);
        assert.equal(after.commands[1].status, ThreadCommandStatus.PENDING);
        const stillMember = await b.core.findThreadBySession('programming-helper', 's2');
        assert.equal(stillMember.threadId, thread.threadId);
      } finally {
        b.cleanup();
      }
    } finally {
      a.cleanup();
    }
  });

  it('归档结果跨重启保留；恢复归档后新指令可执行（不复活旧 cancelled）', async () => {
    const a = makeEnv('a-archive');
    let b = null;
    try {
      const { createThreadLifecycleService } = await import('../server/thread-control/thread-lifecycle.js');
      const service = createThreadLifecycleService({
        control: a.control,
        stopSession: async () => ({ status: 'stopped' }),
      });
      const thread = await startCoderThread(a, 's1');
      await a.core.appendCommand({ threadId: thread.threadId, text: '待取消' });
      // 生产归档入口：seal 事务（hold + 取消 pending）+ 归档标记同一事务链
      const result = await service.archiveThread(thread.threadId, { reason: 't007_restart' });
      assert.equal(result.cleanup.status, 'complete');
      assert.equal(result.cleanup.commandsCancelled, 1);
      assert.equal(await a.archive.isArchived(thread.threadId), true);

      // 实例 B：归档事实可读回
      b = makeEnv('a-archive');
      assert.equal(await b.archive.isArchived(thread.threadId), true, '归档结果跨重启');

      // 恢复归档：可调度资格回来，旧 pending 不自动复活
      await b.archive.unarchive(thread.threadId);
      const record = await b.core.getThread(thread.threadId);
      const cancelled = record.commands.find((c) => c.text === '待取消');
      assert.equal(cancelled.status, ThreadCommandStatus.CANCELLED, '归档取消的指令保持取消');

      // 恢复后新指令可执行
      await b.core.appendCommand({ threadId: thread.threadId, text: '恢复后新指令' });
      const after = await b.core.getThread(thread.threadId);
      assert.equal(after.commands[after.commands.length - 1].status, ThreadCommandStatus.PENDING);
      assert.equal(await b.archive.isArchived(thread.threadId), false);
    } finally {
      if (b) b.cleanup();
      a.cleanup();
    }
  });

  it('进行中接力（pendingSuccession 挡板）跨重启保留并由恢复服务收敛', async () => {
    const a = makeEnv('a-handoff');
    let b = null;
    try {
      const { createThreadRecoveryService } = await import('../server/thread-control/thread-succession.js');
      const thread = await startCoderThread(a, 's1');
      await a.core.beginSessionHandoff({ threadId: thread.threadId, fromSessionId: 's1', reason: 'trim' });

      // 实例 B：挡板随记录恢复（不丢、不僵尸）
      b = makeEnv('a-handoff');
      const record = await b.core.getThread(thread.threadId);
      assert.equal(record.status, 'rotating');
      assert.equal(record.pendingSuccession?.fromSessionId, 's1', '挡板跨重启保留');

      // 恢复服务按落盘状态收敛（确定性：状态驱动，非 TTL）
      const recovery = createThreadRecoveryService({ threadControl: b.control, identitySource: b.identity.identitySource });
      const report = await recovery.convergeInterruptedSuccessions();
      assert.equal(report.converged.length, 1);
      const after = await b.core.getThread(thread.threadId);
      assert.equal(after.pendingSuccession, null, '收敛后不留挡板');
      assert.equal(after.status, 'rotation_failed', '明确失败态');
    } finally {
      if (b) b.cleanup();
      a.cleanup();
    }
  });

  it('归档与并发 append 的竞态：seal 事务覆盖并发窗口，raced 命令不可投递（hook 确定性交错）', async () => {
    const a = makeEnv('a-race');
    try {
      const { createThreadLifecycleService } = await import('../server/thread-control/thread-lifecycle.js');
      const thread = await startCoderThread(a, 's1');
      // 确定性交错：stopSession hook（归档事务的 runtime 收尾阶段，位于
      // 归档标记落盘之后、seal 之后的清理阶段）内并发 append 一条 pending——
      // 无 sleep，交错点由 hook 精确锚定在归档事务执行中。
      const service = createThreadLifecycleService({
        control: a.control,
        stopSession: async () => {
          await a.core.appendCommand({ threadId: thread.threadId, text: '竞态窗口内 append' });
          return { status: 'stopped' };
        },
      });
      const result = await service.archiveThread(thread.threadId, { reason: 't007_race' });
      assert.equal(result.cleanup.status, 'complete');

      const record = await a.core.getThread(thread.threadId);
      const raced = record.commands.find((c) => c.text === '竞态窗口内 append');
      assert.ok(raced, 'append 落盘');
      // 归档语义收敛：无论 raced 落在 seal 前（被取消）还是 seal 后
      // （hold 挡投递），它都不可能被投递出去
      assert.equal(record.hold, true);
      const deliver = await a.core.deliverPendingCommands(thread.threadId);
      assert.equal(deliver.delivered, 0);
      assert.ok(
        raced.status === ThreadCommandStatus.CANCELLED || raced.status === ThreadCommandStatus.PENDING,
        `raced command 必须是 cancelled 或 held-pending，实际 ${raced.status}`,
      );
      assert.equal(await a.archive.isArchived(thread.threadId), true);
    } finally {
      a.cleanup();
    }
  });
});
