/**
 * 线程状态矩阵密集测试 —— docs/reference/thread-state-matrix.md 缺口格 G1–G5。
 *
 * 真实框架 WorkThread 状态机 + 真实 Claw 装配层（succession / lifecycle /
 * recovery），仅 bridge 投递为 stub（resolveRuntimeViewerId + submitTurn 记录）。
 * 挡板 freshness 用 store.update 直接改 startedAt 构造（避免真实 5min 等待）。
 *
 * 用例名携带矩阵格 ID；新增格子先在矩阵文档建格再补测（维护约定见文档 §6）。
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { WorkThreadRuntimeBridge } from '@agentdevjs/core';

const DATA_ROOT = mkdtempSync(path.join(os.tmpdir(), 'claw-state-matrix-'));
process.env.AGENTDEV_DATA_DIR = DATA_ROOT;

const { createThreadControl } = await import('../server/thread-control/thread-controller.js');
const { createThreadIntegration } = await import('../server/thread-control/thread-integration.js');
const {
  createThreadSuccessionService,
  createThreadRecoveryService,
} = await import('../server/thread-control/thread-succession.js');
const { createThreadLifecycleService } = await import('../server/thread-control/thread-lifecycle.js');
const { getPrebuiltSessionIndexPath } = await import('../server/shared/session-access.js');

after(async () => {
  await fs.rm(DATA_ROOT, { recursive: true, force: true });
});

// ── 夹具 ─────────────────────────────────────────────────────────

let counter = 0;
const roots = [];

/** 独立线程环境：真实 control/integration/succession/lifecycle/recovery。 */
function makeEnvironment(bridgeOptions) {
  const root = path.join(DATA_ROOT, `env-${++counter}`);
  roots.push(root);
  const bridge = new WorkThreadRuntimeBridge({
    enabled: true,
    resolveRuntimeViewerId: (agentId, sessionId) => `viewer:${agentId}:${sessionId}`,
    submitTurn: async (params) => {
      env.turns.push(params);
      return { success: true };
    },
    ...bridgeOptions,
  });
  const control = createThreadControl({ rootDir: path.join(root, 'threads'), bridge });
  const integration = createThreadIntegration({ control, publishThreadEvent: () => {} });
  const succession = createThreadSuccessionService({
    threadControl: control,
    threadIntegration: integration,
    stopManagedAgent: async () => ({}),
  });
  const recovery = createThreadRecoveryService({ threadControl: control });
  const lifecycle = createThreadLifecycleService({
    control,
    stopSession: async () => ({ status: 'stopped' }),
    publishThreadEvent: () => {},
  });
  const env = { root, control, core: control.core, integration, succession, recovery, lifecycle, turns: [] };
  return env;
}

async function startCoderThread(env, rootSessionId = 's1') {
  return env.core.start({ sessionRef: { agentId: 'coder', sessionId: rootSessionId } });
}

/** 播种 coder 会话索引（recovery 的 head 承接性判定输入）。 */
async function seedCoderSessionIndex(sessionIds) {
  const indexPath = getPrebuiltSessionIndexPath('coder');
  await fs.mkdir(path.dirname(indexPath), { recursive: true });
  await fs.writeFile(indexPath, JSON.stringify({
    revision: 1,
    activeSessionId: null,
    sessions: sessionIds.map((id) => ({ id, title: `M-${id}` })),
  }), 'utf8');
}

/** 把挡板 startedAt 挪到 stale 窗口之外（HANDOFF_STALE_MS = 5min）。 */
async function ageBarrierToStale(core, threadId) {
  await core.store.update(threadId, (draft) => {
    if (draft.pendingSuccession) draft.pendingSuccession.startedAt = Date.now() - 6 * 60 * 1000;
    return draft;
  });
}

const pendingTexts = (record) =>
  (record.commands || []).filter((c) => c?.status === 'pending').map((c) => c.text);

// ── G1: M1-RF-F / M1-RF-S — 失败态上的 begin 覆写（Claw 编排层） ──

describe('G1 M1-RF-*: 接续失败后立即重试（begin 覆写）', () => {
  test('M1-RF-F: rotation_failed + fresh 挡板上 begin 放行覆写，R3 播种不重复', async () => {
    const env = makeEnvironment();
    const thread = await startCoderThread(env, 'g1-s1');

    await env.integration.beginSessionSuccession({ agentId: 'coder', sessionId: 'g1-s1', reason: 'trim' });
    await env.core.failSessionHandoff(thread.threadId, { reason: 'test_failure', stage: 'compaction' });
    let record = await env.core.getThread(thread.threadId);
    assert.equal(record.status, 'rotation_failed');
    assert.ok(record.pendingSuccession, '失败后挡板保留');

    // 覆写重试（同移交易）：RF + fresh 挡板上 begin 放行（F2-1 锁定语义）
    await env.integration.beginSessionSuccession({ agentId: 'coder', sessionId: 'g1-s1', reason: 'trim' });
    record = await env.core.getThread(thread.threadId);
    assert.equal(record.status, 'rotating');
    assert.equal(record.pendingSuccession.reason, 'trim');

    // R3 幂等键 succession:<tid>:<from>：同移交易重试不重复播种
    const continuations = (record.commands || []).filter((c) => c.kind === 'system_continuation');
    assert.equal(continuations.length, 1, '同一移交易重试 begin 只播种一条接续指令');
  });

  test('M1-RF-F: 覆写后完整流转到提交（begin → fail → begin → commit）', async () => {
    const env = makeEnvironment();
    const thread = await startCoderThread(env, 'g1-s2');
    await seedCoderSessionIndex(['g1-s2', 'g1-s2-next']);

    await env.integration.beginSessionSuccession({ agentId: 'coder', sessionId: 'g1-s2', reason: 'context_guard' });
    await env.core.failSessionHandoff(thread.threadId, { reason: 'stub_failure', stage: 'summary' });

    const retry = await env.integration.beginSessionSuccession({ agentId: 'coder', sessionId: 'g1-s2', reason: 'context_guard' });
    assert.ok(retry, '覆写 begin 成功');

    const commit = await env.succession.commitSuccession({
      agentId: 'coder',
      fromSessionId: 'g1-s2',
      toSessionId: 'g1-s2-next',
      successorReady: true,
    });
    assert.equal(commit.applied, true, `重试接续提交成功：${commit.error || ''}`);
    const record = await env.core.getThread(thread.threadId);
    assert.equal(record.status, 'open');
    assert.equal(record.headSessionId, 'g1-s2-next');
    assert.equal(record.pendingSuccession, null, '提交后挡板清除');
  });

  test('M1-RF-S: stale 挡板同样放行覆写', async () => {
    const env = makeEnvironment();
    const thread = await startCoderThread(env, 'g1-s3');

    await env.integration.beginSessionSuccession({ agentId: 'coder', sessionId: 'g1-s3', reason: 'trim' });
    await env.core.failSessionHandoff(thread.threadId, { reason: 'stub_failure', stage: 'compaction' });
    await ageBarrierToStale(env.core, thread.threadId);

    await env.integration.beginSessionSuccession({ agentId: 'coder', sessionId: 'g1-s3', reason: 'trim' });
    const record = await env.core.getThread(thread.threadId);
    assert.equal(record.status, 'rotating', 'stale 挡板上 begin 覆写重开');
  });
});

// ── G2: M4-RF-F / M4-RF-S — 失败态挡板的投递消费 ─────────────────

describe('G2 M4-RF-*: rotation_failed 挡板期的指令投递', () => {
  test('M4-RF-F: fresh 挡板挡投递，指令保持 pending', async () => {
    const env = makeEnvironment();
    const thread = await startCoderThread(env, 'g2-s1');

    await env.core.appendCommand({ threadId: thread.threadId, text: 'g2 挡板前的指令' });
    await env.integration.beginSessionSuccession({ agentId: 'coder', sessionId: 'g2-s1', reason: 'trim' });
    await env.core.appendCommand({ threadId: thread.threadId, text: 'g2 失败后新派的指令' });
    await env.core.failSessionHandoff(thread.threadId, { reason: 'stub_failure', stage: 'summary' });

    const outcome = await env.core.deliverPendingCommands(thread.threadId);
    assert.equal(outcome.reason, 'handoff_in_progress', 'RF + fresh 挡板同样挡投递（isHandoffActive 不看 status）');
    assert.equal(outcome.delivered, 0);

    const record = await env.core.getThread(thread.threadId);
    assert.equal(pendingTexts(record).length >= 2, true, '指令全部保持 pending');
    assert.equal(env.turns.length, 0, '无任何投递发生');
  });

  test('M4-RF-S: stale 挡板懒清理（status 保持 RF）后投给旧 head', async () => {
    const env = makeEnvironment();
    const thread = await startCoderThread(env, 'g2-s2');

    await env.core.appendCommand({ threadId: thread.threadId, text: 'g2-stale 指令' });
    await env.integration.beginSessionSuccession({ agentId: 'coder', sessionId: 'g2-s2', reason: 'trim' });
    await env.core.failSessionHandoff(thread.threadId, { reason: 'stub_failure', stage: 'summary' });
    await ageBarrierToStale(env.core, thread.threadId);

    const outcome = await env.core.deliverPendingCommands(thread.threadId);
    assert.ok(outcome.delivered >= 1, 'stale 挡板清除后恢复投递');

    const record = await env.core.getThread(thread.threadId);
    assert.equal(record.status, 'rotation_failed', '懒清理不改变 status（F2-3 锁定）');
    assert.equal(record.pendingSuccession, null, 'stale 挡板已被清除');

    const targets = env.turns.map((t) => t.agentId);
    assert.ok(targets.every((id) => id === 'viewer:coder:g2-s2'), '全部投给旧 head');
  });
});

// ── G3: M6-RF-F — rotation_failed 中归档 ──────────────────────────

describe('G3 M6-RF-F: rotation_failed + 挡板中归档', () => {
  test('seal 清挡板、status 保持 RF、hold 落下、pending 取消', async () => {
    const env = makeEnvironment();
    const thread = await startCoderThread(env, 'g3-s1');

    await env.core.appendCommand({ threadId: thread.threadId, text: 'g3 未投指令' });
    await env.integration.beginSessionSuccession({ agentId: 'coder', sessionId: 'g3-s1', reason: 'trim' });
    await env.core.failSessionHandoff(thread.threadId, { reason: 'stub_failure', stage: 'summary' });

    const result = await env.lifecycle.archiveThread(thread.threadId, { reason: 'user_archive' });
    assert.equal(result.cleanup.handoffConverged, true, '挡板被 seal 收敛');

    const record = await env.core.getThread(thread.threadId);
    assert.equal(record.pendingSuccession, null, '挡板清除');
    assert.equal(record.status, 'rotation_failed', '归档不翻转已失败的 status（与懒清理同语义）');
    assert.equal(record.hold, true, 'seal 落 hold');

    const events = (record.lifecycleEvents || []).map((e) => e.type);
    assert.ok(events.includes('handoff_aborted'), 'handoff_aborted 审计事件');
    assert.ok(events.includes('archived'), 'archived 事件');

    const cancelled = (record.commands || []).filter((c) => c.status === 'cancelled');
    assert.equal(cancelled.length, 2, 'pending 用户指令与 R3 播种指令都被取消');
  });

  test('unarchive 恢复 hold，cancelled 指令不复活', async () => {
    const env = makeEnvironment();
    const thread = await startCoderThread(env, 'g3-s2');
    await env.core.appendCommand({ threadId: thread.threadId, text: 'g3-u 指令' });
    await env.integration.beginSessionSuccession({ agentId: 'coder', sessionId: 'g3-s2', reason: 'trim' });
    await env.core.failSessionHandoff(thread.threadId, { reason: 'stub_failure', stage: 'summary' });
    await env.lifecycle.archiveThread(thread.threadId);

    await env.lifecycle.unarchiveThread(thread.threadId);
    const record = await env.core.getThread(thread.threadId);
    assert.equal(record.hold, false, 'unarchive 解除 hold 恢复可调度');
    assert.equal(record.status, 'rotation_failed', 'status 不因归档/恢复翻转');
    assert.equal((record.commands || []).some((c) => c.status === 'pending'), false, 'cancelled 不复活');
  });
});

// ── G4: M8D-R-F — 调度端到端：挡板期 dispatch → 接续完成 → 导向新 head ──

describe('G4 M8D-R-F: 挡板期派发的指令在接续完成后导向新 head', () => {
  test('挡板期 dispatch 不丢不重，提交后全部投给新 head', async () => {
    const env = makeEnvironment();
    const thread = await startCoderThread(env, 'g4-s1');
    await seedCoderSessionIndex(['g4-s1', 'g4-s2']);

    // 接续前已有积压指令（模拟调度先派了一单）
    await env.core.appendCommand({ threadId: thread.threadId, text: 'G4-early' });

    // 接续开始：竖挡板 + R3 播种接续指令
    await env.integration.beginSessionSuccession({ agentId: 'coder', sessionId: 'g4-s1', reason: 'context_guard' });

    // 挡板期调度面再派新工单（HTTP commands 端点同语义：入箱 ✓、投递被挡）
    await env.core.appendCommand({ threadId: thread.threadId, text: 'G4-during' });

    const gated = await env.core.deliverPendingCommands(thread.threadId);
    assert.equal(gated.reason, 'handoff_in_progress', '挡板期投递被挡');
    assert.equal(env.turns.length, 0, '挡板期零投递');

    // 提交点：head 换代（successorReady 门禁走真实 commitSuccession）
    const commit = await env.succession.commitSuccession({
      agentId: 'coder',
      fromSessionId: 'g4-s1',
      toSessionId: 'g4-s2',
      successorReady: true,
    });
    assert.equal(commit.applied, true, `提交成功：${commit.error || ''}`);

    // 提交内含 staged delivery；若未全投，补一次显式投递也不产生重复
    await env.core.deliverPendingCommands(thread.threadId);

    const texts = env.turns.map((t) => t.text);
    assert.ok(texts.includes('G4-early'), '接续前积压指令投达新 head');
    assert.ok(texts.includes('G4-during'), '挡板期派发指令投达新 head');
    const continuationTurns = env.turns.filter((t) => t.kind === 'system_continuation');
    assert.equal(continuationTurns.length, 1, 'R3 接续指令恰好投递一次');

    // 不丢不重：每条指令的 sourceRef（commandId）唯一
    const refs = env.turns.map((t) => t.sourceRef);
    assert.equal(new Set(refs).size, refs.length, '无重复投递');
    assert.ok(env.turns.every((t) => t.agentId === 'viewer:coder:g4-s2'), '全部导向新 head');

    const record = await env.core.getThread(thread.threadId);
    assert.equal(pendingTexts(record).length, 0, '无滞留 pending');
  });
});

// ── G5: M8-RF-F — 重启收敛扫描对已失败挡板的再收敛 ────────────────

describe('G5 M8-RF-F: 重启收敛对 rotation_failed 残留挡板', () => {
  test('已失败已落账的挡板同样被收敛：再落 handoff_failed + 清挡板 + status 保持', async () => {
    const env = makeEnvironment();
    const thread = await startCoderThread(env, 'g5-s1');
    await seedCoderSessionIndex(['g5-s1']);

    await env.integration.beginSessionSuccession({ agentId: 'coder', sessionId: 'g5-s1', reason: 'trim' });
    await env.core.failSessionHandoff(thread.threadId, { reason: 'stub_failure', stage: 'summary' });
    const before = await env.core.getThread(thread.threadId);
    const failedEventsBefore = (before.lifecycleEvents || []).filter((e) => e.type === 'handoff_failed').length;

    const report = await env.recovery.convergeInterruptedSuccessions();
    assert.ok(report.converged.some((c) => c.threadId === thread.threadId), '已失败挡板也被收敛（状态判定非时间判定）');

    const after = await env.core.getThread(thread.threadId);
    assert.equal(after.status, 'rotation_failed', 'status 保持失败态');
    assert.equal(after.pendingSuccession, null, '挡板被重启收敛清除');
    const failedEventsAfter = (after.lifecycleEvents || []).filter((e) => e.type === 'handoff_failed').length;
    assert.equal(failedEventsAfter, failedEventsBefore + 1, '再落一条 handoff_failed（reason=restart_convergence）');

    // 收敛后投递恢复（M4 联动）：清挡板即解除投递门禁
    await env.core.appendCommand({ threadId: thread.threadId, text: 'g5 重启后指令' });
    const outcome = await env.core.deliverPendingCommands(thread.threadId);
    assert.ok(outcome.delivered >= 1, '挡板清除后投递恢复');
  });

  test('M8-∅ 对照：无挡板线程（含纯 open）不被触碰', async () => {
    const env = makeEnvironment();
    const thread = await startCoderThread(env, 'g5-s2');
    await seedCoderSessionIndex(['g5-s2']);

    const report = await env.recovery.convergeInterruptedSuccessions();
    assert.equal(report.converged.some((c) => c.threadId === thread.threadId), false, '无挡板线程不进收敛名单');
    const record = await env.core.getThread(thread.threadId);
    assert.equal(record.status, 'open');
    assert.equal((record.lifecycleEvents || []).length, 0, '零事件写入');
  });
});
