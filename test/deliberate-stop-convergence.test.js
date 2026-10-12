/**
 * C1 人为停止看板收敛：convergeThreadBoardOnDeliberateStop
 *
 * 语义（线程生命周期定案）：手动关闭 Agent → 线程进空闲；
 * 收敛仅作用于 head 会话且看板 running 的线程，其余一律 no-op。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createThreadControl } from '../server/thread-control/thread-controller.js';
import { convergeThreadBoardOnDeliberateStop } from '../server/thread-control/deliberate-stop-convergence.js';

function makeControl() {
  const root = mkdtempSync(path.join(tmpdir(), 'c1-conv-'));
  const control = createThreadControl({ rootDir: root });
  return { control, root };
}

/** 造一条看板 running 的线程（head 会话已开跑） */
async function seedRunningThread(control, agentId, sessionId) {
  const { core, board } = control;
  const thread = await core.start({ sessionRef: { agentId, sessionId } });
  await board.recordRuntimeEvent({ agentId, sessionId, event: { type: 'turn.started', turn: 1 } });
  return thread;
}

test('head 会话 + 看板 running → 收敛 idle', async () => {
  const { control, root } = makeControl();
  try {
    const thread = await seedRunningThread(control, 'coder', 's-head-1');
    const converged = await convergeThreadBoardOnDeliberateStop('coder', 's-head-1', control);
    assert.equal(converged, true);
    assert.equal((await control.board.getState(thread.threadId)).status, 'idle');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('非 head 会话 no-op（找不到 head 匹配的线程）', async () => {
  const { control, root } = makeControl();
  try {
    await seedRunningThread(control, 'coder', 's-head-1');
    const converged = await convergeThreadBoardOnDeliberateStop('coder', 's-other', control);
    assert.equal(converged, false);
    assert.equal((await control.board.getState((await control.core.listThreads({ agentId: 'coder' }))[0].threadId)).status, 'running');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('看板已 idle → no-op（幂等，不重复播种）', async () => {
  const { control, root } = makeControl();
  try {
    const thread = await seedRunningThread(control, 'coder', 's-head-1');
    await control.board.recordRuntimeEvent({ agentId: 'coder', sessionId: 's-head-1', event: { type: 'turn.completed', turn: 1 } });
    const converged = await convergeThreadBoardOnDeliberateStop('coder', 's-head-1', control);
    assert.equal(converged, false);
    assert.equal((await control.board.getState(thread.threadId)).status, 'idle');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('看板 closed（归档/删除 seal 后）→ no-op，不被收敛覆写', async () => {
  const { control, root } = makeControl();
  try {
    const thread = await seedRunningThread(control, 'coder', 's-head-1');
    await control.board.closeBoard(thread.threadId, { reason: 'archived' });
    const converged = await convergeThreadBoardOnDeliberateStop('coder', 's-head-1', control);
    assert.equal(converged, false);
    assert.equal((await control.board.getState(thread.threadId)).status, 'closed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
