/**
 * ADR-0031 步骤一：真实执行链关联验证（Claw 装配层）。
 *
 * 链路（全部真实组件，仅 LLM 与 ViewerWorker 仲裁为确定性替身）：
 *   WorkThread.appendCommand（派发回执 commandId）
 *     → WorkThreadRuntimeBridge.submitTurn（stub = ViewerWorker 仲裁替身：
 *       arbiter 空闲 → CallArbiter.enqueue；busy → 假邮箱排队）
 *     → CallArbiter + 真实 Agent（LLM mock；fetch stub 供 react-loop 消费邮箱）
 *     → callFinished → mapEnvelopeToTurnEvent（宿主上报契约）
 *     → board.recordRuntimeEvent → getExecutionEvents 读回断言。
 *
 * 隔离：临时目录 + fetch stub，不触真实服务、无 sleep/poll。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  Agent,
  WorkThread,
  WorkThreadBoard,
  WorkThreadRuntimeBridge,
  WorkThreadStore,
} from '@agentdevjs/core';

import { CallArbiter } from '../server/call-arbiter.js';
import { mapEnvelopeToTurnEvent } from '../scripts/turn-event-mapping.js';

const AGENT_ID = 'coder-chain';
const HEAD_1 = 'sess-chain-1';

/** 可编排的 LLM 替身：按脚本逐次返回；首次调用可挂起（进入/释放双相闸门，确定性）。 */
function makeScriptedLLM(script, { hangFirstCall = false } = {}) {
  let call = 0;
  let releaseGate = null;
  let enteredResolve = null;
  const gate = hangFirstCall ? new Promise((resolve) => { releaseGate = resolve; }) : null;
  const entered = hangFirstCall ? new Promise((resolve) => { enteredResolve = resolve; }) : null;
  return {
    releaseGate: () => releaseGate?.(),
    /** 等待首次 chat 真正进入挂起点（之后测试操作才有确定性时序）。 */
    waitEntered: () => (entered ?? Promise.resolve()),
    async chat() {
      const index = call++;
      if (hangFirstCall && index === 0) {
        enteredResolve?.();
        await gate;
      }
      const step = script[Math.min(index, script.length - 1)];
      return typeof step === 'function' ? step(index) : step;
    },
  };
}

async function makeEnv({ llmScript, hangFirstCall = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'claw-wt-chain-'));
  const submitted = [];
  const mailbox = [];
  const completions = [];

  const store = new WorkThreadStore({ rootDir: join(root, 'threads') });
  const llm = makeScriptedLLM(llmScript ?? [{ content: 'done' }], { hangFirstCall });
  const agent = new Agent({ llm, maxTurns: 4 });
  const arbiter = new CallArbiter(agent);

  const bridge = new WorkThreadRuntimeBridge({
    enabled: true,
    resolveRuntimeViewerId: () => 'viewer-x',
    // ViewerWorker 仲裁替身：busy → 邮箱排队（react-loop 消费），空闲 → 入 arbiter
    submitTurn: async (params) => {
      submitted.push(params);
      if (arbiter.getStatus().status !== 'idle') {
        mailbox.push({ text: params.text, kind: params.kind, source: params.source, sourceRef: params.sourceRef });
        return { queued: true };
      }
      const entry = arbiter.enqueue({
        source: params.source,
        ...(params.sourceRef ? { sourceRef: params.sourceRef } : {}),
        text: params.text,
        ...(params.kind === 'reminder' ? { kind: 'reminder' } : {}),
      });
      completions.push(arbiter.waitForCompletion(entry.id));
      return { enqueued: entry.id };
    },
  });
  const core = new WorkThread({ store, bridge });
  const board = new WorkThreadBoard({ core, rootDir: join(root, 'boards') });

  // 宿主上报契约（对齐 run-prebuilt-agent）：callStarted/callFinished → turn 事件 → board。
  // 上报 promise 纳入 waitIdle 追踪：board 落盘是异步 IO，测试必须等其收敛再读。
  const reports = [];
  const trackReport = (promise) => { reports.push(promise); };
  const reportTurnEvent = async (event) => {
    const thread = await core.findThreadByHeadSession(AGENT_ID, HEAD_1);
    if (!thread) return;
    await board.recordRuntimeEvent({
      agentId: AGENT_ID,
      sessionId: thread.headSessionId,
      event,
    });
  };
  arbiter.on('callStarted', (envelope) => {
    trackReport(reportTurnEvent({
      type: 'turn.started',
      turn: typeof agent._callIndex === 'number' ? agent._callIndex + 1 : null,
      source: envelope?.source || null,
      sourceRef: envelope?.sourceRef || null,
    }));
  });
  arbiter.on('callFinished', (envelope) => {
    const turn = typeof agent._callIndex === 'number' ? agent._callIndex : null;
    trackReport(reportTurnEvent(mapEnvelopeToTurnEvent(envelope, { turn })));
  });

  // fetch stub：dequeue-input 供 react-loop drain；其余 URL 显式失败
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/dequeue-input')) {
      const input = mailbox.shift() ?? null;
      return { ok: true, json: async () => ({ input, remaining: mailbox.length }) };
    }
    throw new Error(`unexpected fetch in chain test: ${u}`);
  };

  const wt = await core.start({ sessionRef: { agentId: AGENT_ID, sessionId: HEAD_1 } });

  async function waitIdle() {
    // 等待所有已入队 envelope 落定 + 全部 board 上报收敛（含链式触发的新任务）
    while (completions.length > 0 || reports.length > 0) {
      const batch = [...completions.splice(0, completions.length), ...reports.splice(0, reports.length)];
      await Promise.all(batch);
    }
  }

  async function dispose() {
    // 1. 释放仍挂起的闸门（幂等）：在途 onCall 必须能落定
    llm.releaseGate();
    // 2. Agent 公开 dispose：interrupt + 等待活动/排队调用收敛 + onDestroy
    await agent.dispose();
    // 3. 尽力等待 board 上报收敛；收敛失败不掩盖用例原始异常
    try {
      await waitIdle();
    } catch {
      // ignore: 清理路径的 best-effort
    }
    // 4. 立即还原本用例捕获的全局 fetch（消除跨用例 stub 污染）
    globalThis.fetch = originalFetch;
    // 5. 临时目录清理
    await rm(root, { recursive: true, force: true });
  }

  return { root, core, board, agent, arbiter, submitted, mailbox, wt, waitIdle, dispose, releaseGate: () => llm.releaseGate(), waitEntered: () => llm.waitEntered() };
}

async function readEvents(board, threadId) {
  const { events } = await board.getExecutionEvents(threadId);
  return events;
}

describe('thread association chain: bridge → CallArbiter + real Agent → turn events → board', () => {
  // 测试纪律：每个用例 try/finally 即时 dispose（释放 gate → agent.dispose →
  // 上报收敛 → 还原全局 fetch → 清临时目录），异常路径同样还原；
  // 不在 suite 末尾批量嵌套恢复。

  it('dispatch receipt commandId flows through bridge and lands as the turn event sourceRef', async () => {
    const env = await makeEnv();
    try {
      const r = await env.core.appendCommand({ threadId: env.wt.threadId, text: 'task one', idempotencyKey: 'k1' });
      await env.core.deliverPendingCommands(env.wt.threadId);
      await env.waitIdle();

      // 派发回执 → bridge 投递身份
      assert.equal(env.submitted[0]?.sourceRef, r.command.commandId);
      // 真实 Agent 执行 → envelope 终态 → 宿主映射 → board 事件身份一致
      const events = await readEvents(env.board, env.wt.threadId);
      const terminal = events.find((e) => e.sourceRef === r.command.commandId && e.type === 'turn.completed');
      assert.ok(terminal, 'turn.completed with the dispatch commandId must reach the board');
      assert.equal(terminal.suspended, undefined);
      // envelope 无身份字段丢失：source 标签随事件
      assert.equal(terminal.source, 'thread');
    } finally {
      await env.dispose();
    }
  });

  it('M8D-EXEC-REF busy-time queued command is consumed by the running turn: consumedSourceRefs on board, no own turn', async () => {
    // 挂起闸门制造确定性 busy 窗口：X2 在 X1 回合执行中投递 → 邮箱排队 →
    // X1 收尾边界 drain 注入消费 → consumedSourceRefs 上板；X2 无独立回合。
    const env = await makeEnv({ llmScript: [{ content: 'done' }], hangFirstCall: true });
    try {
      const r1 = await env.core.appendCommand({ threadId: env.wt.threadId, text: 'task one', idempotencyKey: 'k1' });
      await env.core.deliverPendingCommands(env.wt.threadId);
      // 等首次 chat 真正进入挂起点：此后 X1 回合确定在执行中
      await env.waitEntered();
      // X1 执行中排队追加：submitTurn 替身将其放入邮箱（真实 ViewerWorker 语义）
      const r2 = await env.core.appendCommand({ threadId: env.wt.threadId, text: 'task two', idempotencyKey: 'k2' });
      await env.core.deliverPendingCommands(env.wt.threadId);
      env.releaseGate();
      await env.waitIdle();

      // X1 的终态事件携带已消费身份（X2 由 X1 的回合内注入执行）
      const events = await readEvents(env.board, env.wt.threadId);
      const terminal1 = events.find((e) => e.sourceRef === r1.command.commandId && e.type === 'turn.completed');
      assert.ok(terminal1, 'X1 completion must reach the board');
      assert.deepEqual(terminal1.consumedSourceRefs, [r2.command.commandId]);
      // X2 不产生独立 turn 事件：其执行随 X1 的回合落定
      assert.equal(
        events.some((e) => e.sourceRef === r2.command.commandId),
        false,
        'queued command must not gain its own turn event',
      );
    } finally {
      await env.dispose();
    }
  });

  it('M8D-SUSPEND-REF suspended turn then wakeup: event identity and work references remain available', async () => {
    const env = await makeEnv();
    try {
      // 登记 pending-work（suspended 判定的事实源）；唤醒后清空（任务完成）
      const runningTasks = new Set(['bg-9']);
      env.agent.registerPendingWorkProvider('shell', () => {
        return [...runningTasks].map((id) => ({ source: 'shell', id, summary: 'npm test' }));
      });

      const r1 = await env.core.appendCommand({ threadId: env.wt.threadId, text: 'long task', idempotencyKey: 'k-sus' });
      await env.core.deliverPendingCommands(env.wt.threadId);
      await env.waitIdle();

      // 挂起轮：turn.completed(suspended=true) 携带 pendingWakeups
      let events = await readEvents(env.board, env.wt.threadId);
      const suspended = events.find((e) => e.sourceRef === r1.command.commandId && e.type === 'turn.completed');
      assert.ok(suspended, 'suspended completion must reach the board');
      assert.equal(suspended.suspended, true);
      assert.deepEqual(suspended.pendingWakeups, [{ source: 'shell', id: 'bg-9', summary: 'npm test' }]);

      // 唤醒通报入线程域：保留事件身份，metadata 携带后台工作引用
      runningTasks.delete('bg-9');
      const wake = await env.core.appendCommand({
        threadId: env.wt.threadId,
        kind: 'reminder',
        source: 'shell',
        text: '[后台任务 bg-9 已完成] npm test 退出码 0',
        idempotencyKey: 'gw-shell-evt-completed-9',
        originSourceRef: 'shell-evt-completed-9',
        metadata: { shell: { taskId: 'bg-9', taskIds: ['bg-9'] } },
      });
      assert.equal(wake.command.originSourceRef, 'shell-evt-completed-9');
      assert.deepEqual(wake.command.metadata.shell.taskIds, ['bg-9']);
      await env.core.deliverPendingCommands(env.wt.threadId);
      await env.waitIdle();

      // 唤醒轮真实执行（reminder 身份 → system 消息落地 → 非 suspended 完成）
      events = await readEvents(env.board, env.wt.threadId);
      const wakeTerminal = events.find((e) => e.sourceRef === wake.command.commandId && e.type === 'turn.completed');
      assert.ok(wakeTerminal, 'wakeup turn completion must reach the board');
      assert.equal(wakeTerminal.suspended, undefined);
      assert.notEqual(wake.command.commandId, r1.command.commandId);
    } finally {
      await env.dispose();
    }
  });

  it('M8D-ROTATE-REF succession interrupt while executing: turn.cancelled with consumed identity is the association evidence', async () => {
    const env = await makeEnv({ llmScript: [{ content: 'done' }], hangFirstCall: true });
    try {
      const r = await env.core.appendCommand({ threadId: env.wt.threadId, text: 'executing when rotation hits', idempotencyKey: 'k-rot' });
      await env.core.deliverPendingCommands(env.wt.threadId);
      // 等首次 chat 真正进入挂起点：此后 X 的回合确定在执行中
      await env.waitEntered();

      // 上下文接力编排：打断当前 envelope（guard 轮换路径的 arbiter 语义）
      env.arbiter.interruptActive('cancelled by context rotation');
      env.releaseGate();
      await env.waitIdle();

      // 旧 head 上的中断事实先落 board（接力推进前），事件携带已消费身份
      const events = await readEvents(env.board, env.wt.threadId);
      const cancelled = events.find((e) => e.sourceRef === r.command.commandId && e.type === 'turn.cancelled');
      assert.ok(cancelled, 'cancelled turn must reach the board');
      assert.equal(cancelled.error?.category, 'lifecycle');
      // 取消不是完成：观察器不得把该终态当作 X 的执行完成
      assert.equal(
        events.some((e) => e.sourceRef === r.command.commandId && e.type === 'turn.completed'),
        false,
        'cancelled execution must not be reported as completed',
      );

      // 接力推进：指令已 DELIVERED 不复活；新 head 上无 X 的执行事件。
      // 完成对账需结合生命周期事实（sessionChain / 接续指令），属后续监视算法。
      await env.core.advanceHead({
        threadId: env.wt.threadId,
        toSessionId: 'sess-chain-2',
        fromSessionId: HEAD_1,
      });
      const eventsAfter = await readEvents(env.board, env.wt.threadId);
      assert.equal(
        eventsAfter.filter((e) => e.sourceRef === r.command.commandId && e.type === 'turn.completed').length,
        0,
        'no completion event after succession interrupt',
      );
    } finally {
      await env.dispose();
    }
  });
});
