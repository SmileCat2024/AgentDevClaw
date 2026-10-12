/**
 * C2 重启自动恢复（thread-restart-resume）测试
 *
 * 真实逻辑：core/board/archive 走框架 WorkThread + 文件存储（临时目录），
 * 仅在进程/投递边界注入记录型 stub（ensureHeadRuntime / submitUserTurn）。
 *
 * 覆盖（按「未完成事实判定」决策表逐行）：
 * - pending 指令 → 拉起不续跑（补投由 runtime-ready 链负责）
 * - 看板 running 无 pending → 拉起 + kind='resume' 空消息续跑
 * - idle / failed / waiting_input → 不拉起
 * - archived / deleting / closed / hold → 跳过（各有 reason）
 * - 拉起失败 → failed 记录，绝不发续跑
 * - 续跑投递失败 → failed[stage=resume_turn]（进程已拉起，不回滚）
 * - 多线程混合串行处理，报告完整
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { WorkThreadRuntimeBridge } from '@agentdevjs/core';
import { createThreadControl } from '../server/thread-control/thread-controller.js';
import { createThreadRestartResume } from '../server/thread-control/thread-restart-resume.js';

function makeTempRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'claw-restart-resume-'));
}

let seq = 0;
async function makeEnv() {
  const root = await makeTempRoot();
  const control = createThreadControl({
    rootDir: path.join(root, `env-${Date.now()}-${seq++}`),
    bridge: new WorkThreadRuntimeBridge({}),
  });
  // 寻址缝：生产 resolveSessionViewerId 扫描真实 runtime 表，测试按会话
  // 注入映射，断言续跑投递使用 viewerAgentId 而非裸 agentId。
  const viewerIdBySession = new Map();
  const moduleControl = {
    ...control,
    resolveSessionViewerId: (agentId, sessionId) => viewerIdBySession.get(sessionId) ?? null,
  };
  const calls = { wake: [], submit: [] };
  let wakeResult = () => ({ ok: true });
  const ensureHeadRuntime = async (agentId, sessionId) => {
    calls.wake.push({ agentId, sessionId });
    return wakeResult(agentId, sessionId);
  };
  const submitUserTurn = async (params) => {
    calls.submit.push(params);
  };
  const resume = createThreadRestartResume({ control: moduleControl, ensureHeadRuntime, submitUserTurn });
  return { root, control, moduleControl, viewerIdBySession, calls, resume, setWakeResult: (fn) => { wakeResult = fn; } };
}

async function makeThread(control, agentId, sessionId) {
  return control.core.start({ sessionRef: { agentId, sessionId } });
}

async function setBoard(control, thread, status, via = 'events') {
  const base = {
    agentId: thread.agentId, sessionId: thread.headSessionId, runtimeInstanceId: 'rt-1',
  };
  if (via === 'events') {
    await control.board.recordRuntimeEvent({ ...base, event: { type: 'turn.started', turn: 1 } });
    if (status === 'idle') {
      await control.board.recordRuntimeEvent({ ...base, event: { type: 'turn.completed', turn: 1 } });
    } else if (status === 'failed') {
      await control.board.recordRuntimeEvent({ ...base, event: { type: 'turn.failed', turn: 1, error: { message: 'x' } } });
    } else if (status === 'cancelled-idle') {
      await control.board.recordRuntimeEvent({ ...base, event: { type: 'turn.cancelled', turn: 1, error: { message: 'interrupted' } } });
    }
  } else {
    await control.board.setStatus(thread.threadId, status);
  }
}

describe('thread-restart-resume: 未完成事实判定', () => {
  test('pending 指令 → 只拉起不续跑', async () => {
    const env = await makeEnv();
    try {
      const t = await makeThread(env.control, 'a1', 's1');
      await env.control.core.appendCommand({ threadId: t.threadId, text: 'job' });
      const report = await env.resume.resumeInterruptedThreads();
      assert.equal(report.resumed.length, 1);
      assert.equal(report.resumed[0].action, 'wake_pending_commands');
      assert.equal(report.resumed[0].pendingCount, 1);
      assert.equal(env.calls.wake.length, 1);
      assert.equal(env.calls.submit.length, 0, 'pending 补投交给 runtime-ready 链，恢复模块不发 turn');
    } finally { await fs.rm(env.root, { recursive: true, force: true }); }
  });

  test('看板 running 无 pending → 拉起 + kind=resume 空消息续跑（按 viewerAgentId 寻址）', async () => {
    const env = await makeEnv();
    try {
      const t = await makeThread(env.control, 'a2', 's2');
      // 崩溃现场：turn.started 后进程没了，无收尾事件
      await setBoard(env.control, t, 'running');
      env.viewerIdBySession.set('s2', 'agent-42-p1');
      const report = await env.resume.resumeInterruptedThreads();
      assert.equal(report.resumed.length, 1);
      assert.equal(report.resumed[0].action, 'resume_interrupted_turn');
      assert.deepEqual(env.calls.submit, [{
        agentId: 'agent-42-p1',
        text: '',
        kind: 'resume',
        source: 'thread-recovery',
        sourceRef: t.threadId,
      }]);
      assert.notEqual(env.calls.submit[0].agentId, 'a2', '不得以裸 agentId 寻址（ViewerWorker 无命中）');
    } finally { await fs.rm(env.root, { recursive: true, force: true }); }
  });

  test('viewer 寻址失败 → failed[stage=resolve_viewer]，不发续跑 turn', async () => {
    const env = await makeEnv();
    try {
      const t = await makeThread(env.control, 'a2b', 's2b');
      await setBoard(env.control, t, 'running');
      // 不注入 viewer 映射：wake 成功但解析不到 viewerAgentId
      const report = await env.resume.resumeInterruptedThreads();
      assert.equal(report.resumed.length, 0);
      assert.equal(report.failed[0].threadId, t.threadId);
      assert.equal(report.failed[0].stage, 'resolve_viewer');
      assert.equal(env.calls.submit.length, 0);
    } finally { await fs.rm(env.root, { recursive: true, force: true }); }
  });

  test('手动中断收敛后的 idle（turn.cancelled）不触发恢复', async () => {
    const env = await makeEnv();
    try {
      const t = await makeThread(env.control, 'a3', 's3');
      await setBoard(env.control, t, 'cancelled-idle');
      const report = await env.resume.resumeInterruptedThreads();
      assert.equal(report.resumed.length, 0);
      assert.equal(report.skipped[0].reason, 'board_idle');
      assert.equal(env.calls.wake.length, 0);
    } finally { await fs.rm(env.root, { recursive: true, force: true }); }
  });

  for (const status of ['failed', 'waiting_input']) {
    test(`看板 ${status} 无 pending → 不拉起（失败等人 / 播种态不自动续）`, async () => {
      const env = await makeEnv();
      try {
        const t = await makeThread(env.control, 'a4', 's4');
        await setBoard(env.control, t, status, 'setStatus');
        const report = await env.resume.resumeInterruptedThreads();
        assert.equal(report.resumed.length, 0);
        assert.equal(report.skipped[0].reason, `board_${status}`);
        assert.equal(env.calls.wake.length, 0);
      } finally { await fs.rm(env.root, { recursive: true, force: true }); }
    });
  }

  for (const [label, prepare] of [
    ['archived', async (control, t) => control.archive.archive(t.threadId, { cleanup: { status: 'complete' } })],
    ['deleting', async (control, t) => control.core.store.update(t.threadId, (draft) => { draft.deleting = true; return draft; })],
    ['hold', async (control, t) => control.core.setHold(t.threadId, true)],
  ]) {
    test(`${label} 线程跳过（reason=${label === 'hold' ? 'held' : label}）`, async () => {
      const env = await makeEnv();
      try {
        const t = await makeThread(env.control, 'a5', 's5');
        await env.control.core.appendCommand({ threadId: t.threadId, text: 'job' });
        await prepare(env.control, t);
        const report = await env.resume.resumeInterruptedThreads();
        assert.equal(report.resumed.length, 0);
        assert.equal(report.skipped[0].reason, label === 'hold' ? 'held' : label);
        assert.equal(env.calls.wake.length, 0, `${label} 期间不拉起`);
      } finally { await fs.rm(env.root, { recursive: true, force: true }); }
    });
  }

  test('closed 线程跳过', async () => {
    const env = await makeEnv();
    try {
      const t = await makeThread(env.control, 'a6', 's6');
      await env.control.core.closeThread(t.threadId, { reason: 'test' });
      const report = await env.resume.resumeInterruptedThreads();
      assert.equal(report.resumed.length, 0);
      assert.equal(report.skipped[0].reason, 'closed');
    } finally { await fs.rm(env.root, { recursive: true, force: true }); }
  });

  test('拉起失败 → failed 记录，绝不发续跑 turn', async () => {
    const env = await makeEnv();
    try {
      const t = await makeThread(env.control, 'a7', 's7');
      await setBoard(env.control, t, 'running');
      env.setWakeResult(() => ({ ok: false, code: 'runtime_ready_timeout', message: 'not ready' }));
      const report = await env.resume.resumeInterruptedThreads();
      assert.equal(report.resumed.length, 0);
      assert.equal(report.failed[0].threadId, t.threadId);
      assert.equal(report.failed[0].stage, 'wake');
      assert.equal(report.failed[0].code, 'runtime_ready_timeout');
      assert.equal(env.calls.submit.length, 0);
    } finally { await fs.rm(env.root, { recursive: true, force: true }); }
  });

  test('续跑投递失败 → failed[stage=resume_turn]，拉起不回滚', async () => {
    const env = await makeEnv();
    try {
      const t = await makeThread(env.control, 'a8', 's8');
      await setBoard(env.control, t, 'running');
      env.viewerIdBySession.set('s8', 'agent-8-p1');
      const failing = createThreadRestartResume({
        control: env.moduleControl,
        ensureHeadRuntime: async () => ({ ok: true }),
        submitUserTurn: async () => { throw new Error('delivery down'); },
      });
      const report = await failing.resumeInterruptedThreads();
      assert.equal(report.resumed.length, 0);
      assert.equal(report.failed[0].stage, 'resume_turn');
      assert.match(report.failed[0].error, /delivery down/);
      assert.equal(env.calls.wake.length, 0);
    } finally { await fs.rm(env.root, { recursive: true, force: true }); }
  });

  test('多线程混合 → 串行全处理，报告分类完整', async () => {
    const env = await makeEnv();
    try {
      const tPending = await makeThread(env.control, 'm1', 'ms1');
      await env.control.core.appendCommand({ threadId: tPending.threadId, text: 'job' });

      const tCrashed = await makeThread(env.control, 'm2', 'ms2');
      await setBoard(env.control, tCrashed, 'running');
      env.viewerIdBySession.set('ms2', 'agent-m2-p1');

      const tIdle = await makeThread(env.control, 'm3', 'ms3');
      await setBoard(env.control, tIdle, 'idle');

      const tArchived = await makeThread(env.control, 'm4', 'ms4');
      await env.control.archive.archive(tArchived.threadId, { cleanup: { status: 'complete' } });

      const report = await env.resume.resumeInterruptedThreads();
      assert.equal(report.resumed.length, 2);
      assert.equal(report.skipped.length, 2);
      assert.equal(report.failed.length, 0);
      assert.deepEqual(report.resumed.map((r) => r.action).sort(),
        ['resume_interrupted_turn', 'wake_pending_commands']);
      assert.equal(env.calls.wake.length, 2);
      assert.equal(env.calls.submit.length, 1);
    } finally { await fs.rm(env.root, { recursive: true, force: true }); }
  });

  test('缺依赖 → 构造期报错（不静默）', async () => {
    const env = await makeEnv();
    try {
      assert.throws(() => createThreadRestartResume({ control: env.control }), /ensureHeadRuntime/);
      assert.throws(() => createThreadRestartResume({}), /control/);
      assert.throws(() => createThreadRestartResume({
        control: { ...env.control, resolveSessionViewerId: undefined },
        ensureHeadRuntime: async () => ({ ok: true }),
        submitUserTurn: async () => {},
      }), /resolveSessionViewerId/);
    } finally { await fs.rm(env.root, { recursive: true, force: true }); }
  });
});
