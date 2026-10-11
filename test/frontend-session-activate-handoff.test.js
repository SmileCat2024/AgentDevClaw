// 接续挡板 409 的结构化透传（openPrebuiltWorkspaceSession）：
// activate 撞 thread_handoff_in_progress 时抛 error.handoff = {threadId,
// sessionId}，供 open_session 消费方转入线程等待表面——不得作为普通
// 失败弹 alert（历史缺陷：用户点击接续中的线程条目弹
// "Session failed: ... 挂载已拒绝"）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createFrontendSandbox, sourceBetween } from './helpers/frontend-vm.js';

const source = fs.readFileSync(new URL('../public/src/app-main.js', import.meta.url), 'utf8');

const fnSource = sourceBetween(
  source,
  'async function openPrebuiltWorkspaceSession(agentId, rawAction) {',
  'function applyOptimisticWorkspaceSession(agentId, session) {',
);

function loadWithFetch(fetchImpl) {
  const ctx = createFrontendSandbox({ fetch: fetchImpl });
  ctx.run('window.openPrebuiltWorkspaceSession = ' + fnSource.replace(/^async function openPrebuiltWorkspaceSession/, 'async function'));
  return ctx;
}

const HANDOFF_409 = {
  ok: false,
  code: 'thread_handoff_in_progress',
  message: 'Thread wt-1 正在接续（head 将换到 successor），挂载已拒绝',
  threadId: 'wt-1',
  headSessionId: 'sess-head',
};

test('挡板 409 → 抛结构化 error.handoff（threadId/headSessionId 透传）', async () => {
  const ctx = loadWithFetch(async () => ({
    ok: false,
    status: 409,
    json: async () => HANDOFF_409,
    text: async () => JSON.stringify(HANDOFF_409),
  }));

  const error = await ctx.run('window.openPrebuiltWorkspaceSession("coder", JSON.stringify({ type: "open_session", sessionId: "sess-head" })).then(() => null, (e) => e)');
  assert.ok(error, '409 必须抛错');
  assert.equal(error.handoff?.threadId, 'wt-1');
  assert.equal(error.handoff?.sessionId, 'sess-head');
  assert.match(error.message, /正在接续/);
});

test('其他 409 / 非 200 → 普通错误（无 handoff 语义）', async () => {
  const ctx = loadWithFetch(async () => ({
    ok: false,
    status: 409,
    json: async () => ({ ok: false, code: 'other_conflict' }),
    text: async () => 'conflict',
  }));

  const error = await ctx.run('window.openPrebuiltWorkspaceSession("coder", JSON.stringify({ type: "open_session", sessionId: "s1" })).then(() => null, (e) => e)');
  assert.ok(error);
  assert.ok(!error.handoff, '非挡板 409 不携带 handoff');
});

test('成功路径 → 正常返回 json（无抛错）', async () => {
  const ctx = loadWithFetch(async () => ({
    ok: true,
    json: async () => ({ session: { id: 's1' } }),
  }));

  const result = await ctx.run('window.openPrebuiltWorkspaceSession("coder", JSON.stringify({ type: "open_session", sessionId: "s1" }))');
  assert.equal(result.session.id, 's1');
});
