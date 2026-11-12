/**
 * ADR-0047 线程接续指令恢复：跨层时序与并发长链路测试。
 *
 * 与 test/thread-control.test.js 的分工：既有文件覆盖单层契约（bridge 参数
 * 映射、appendCommand 幂等、状态机单元）；本文件把 Claw 编排层
 * （thread-integration / delivery-consumer / thread store / board 证据）与
 * 真实 ViewerWorker HTTP 面（submitUserTurn → fencing → 持久队列 →
 * claim/ack）串成进程内端到端链路，按下述时序矩阵锁定换头各窗口的语义。
 * 唯一桩点：无真实模型与 agent runtime——viewer 会话由测试直接注册，
 * 其余（HTTP 投递、持久化、事务、分类）全部走真实实现。
 *
 * 时序矩阵（每格 = 一个测试锁定的窗口）：
 *
 *   G1 换头事务后的身份采纳缺口
 *      commit 成功 → 采纳失败 → 补投被 viewer fencing 拒收（409，retryable）
 *      → 指令保持 pending（不误标 failed）→ 采纳成功 → runtime-ready
 *      force 补投（不受上一轮失败退避约束）→ claim/ack 全协议结清。
 *
 *   G2 投递在途 × 换头提交交错（K20 已知窗口）
 *      viewer 已接受（真实入队）而 bridge 未返回时 commit 发生：
 *      分类时指令仍 pending → 非候选 → 无 unresolved；放行后迟到终态化
 *      落在新棒窗口（标记 delivered 前不重读 head——实现事实）。该窗口
 *      不丢失：下一次接续把该指令转为 unresolved(no_positive_reference)。
 *
 *   G3 同线程并发操作的结构不变量
 *      两个竞争性换头提交（同 from）恰好一个生效；同 unresolved 并发
 *      reissue ×3 恰好产生一条重投指令；同幂等键并发 append ×3 恰好一条；
 *      barrier 下并发投递是 gated no-op。最终：单头、链长一致、无重复、
 *      open unresolved 清零。
 *
 *   G4 手动接续免播 + unresolved 处置闭环
 *      seedContinuation=false 不构造 system_continuation 通知；无消费
 *      证据的指令进入 unresolved(evidence_missing)；reissue 派生新指令
 *      （metadata.reissueOf 回指）→ 投递 → claim/ack 消费；重复处置幂等
 *      返回同一指令、冲突处置显式拒绝。
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ViewerWorker } from '@agentdevjs/viewer';
import { WorkThreadRuntimeBridge } from '@agentdevjs/core';
import { createThreadControl, bridgeParamsToSubmitTurnArgs } from '../server/thread-control/thread-controller.js';
import { createThreadIntegration } from '../server/thread-control/thread-integration.js';
import { submitUserTurn } from '../server/shared/user-turn.js';

// ── 测试基础设施 ────────────────────────────────────────────────

function testPipeName(tag) {
  const uniq = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\agentdev-thread-timing-${tag}-${uniq}`
    : `/tmp/agentdev-thread-timing-${tag}-${uniq}.sock`;
}

let worker;
let viewerOrigin;
const tempDirs = [];

// 全部用例共享一个真实 ViewerWorker（HTTP 面真实监听回环端口，各用例用
// 互不相同的 viewerAgentId 隔离会话与持久队列文件）。命名管道每次唯一，
// 不触碰正式服务的 Viewer 通道（claw-test-isolation 纪律）。
before(async () => {
  // 清理继承的正式服务环境（claw-test-isolation 纪律）：本测试可能运行在
  // 真实服务的 agent shell 里，AGENTDEV_VIEWER_HTTP_BIND=0.0.0.0 会让
  // 测试用 ViewerWorker 全端点强制 Bearer（401），AGENTDEV_VIEWER_ADDR
  // 会触发构造期 TCP 传输装配。测试进程内清理，不影响正式服务。
  delete process.env.AGENTDEV_VIEWER_HTTP_BIND;
  delete process.env.AGENTDEV_VIEWER_ADDR;
  const storeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claw-thread-timing-viewer-'));
  tempDirs.push(storeDir);
  worker = new ViewerWorker(0, false, testPipeName('shared'), { queuedInputStoreDir: storeDir });
  await worker.start();
  const port = worker.server.address().port;
  viewerOrigin = `http://127.0.0.1:${port}`;
});

after(async () => {
  await worker.stop().catch(() => {});
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

/**
 * 每个用例独立的世界：独立线程数据根 + 独立 bridge/integration。
 * wrapSubmit 允许在投递链路上注入门控（G2 的在途挂起）。
 */
async function makeWorld(tag, wrapSubmit = null) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claw-thread-timing-'));
  tempDirs.push(root);
  const viewerIds = new Map(); // headSessionId → viewerAgentId（模拟 runtime 真相源）
  const baseSubmit = (params) => submitUserTurn(bridgeParamsToSubmitTurnArgs(params), {
    viewerOrigin,
    fetchImpl: globalThis.fetch,
  });
  const bridge = new WorkThreadRuntimeBridge({
    enabled: true,
    submitTurn: wrapSubmit ? wrapSubmit(baseSubmit) : baseSubmit,
    resolveRuntimeViewerId: (agentId, sessionId) => viewerIds.get(sessionId) ?? null,
  });
  const control = createThreadControl({ rootDir: root, bridge });
  const integration = createThreadIntegration({ control, publishThreadEvent: () => {} });
  return { root, tag, viewerIds, control, integration, core: control.core, board: control.board };
}

/** 在真实 viewer 上注册一个 runtime 会话。identity 缺省 = spawn 早于换头的
 *  无线程身份状态（ADR-0047 阶段 5 采纳缺口的起点）。 */
function registerViewerRuntime({ viewerAgentId, identity = null }) {
  const session = worker.getOrCreateSession(viewerAgentId, 'timing-runtime');
  const clientId = `client-${viewerAgentId}`;
  session.clientId = clientId;
  // destroy 必须提供：worker.stop() 清理 udsClients 时调用，缺失会抛
  // TypeError 并泄漏 HTTP server 句柄（进程不退出）。
  worker.udsClients.set(clientId, { write() {}, destroy() {} });
  session.callActive = true;
  if (identity) {
    worker.handleRegisterAgent({
      type: 'register-agent',
      agentId: viewerAgentId,
      name: 'timing-runtime',
      runtimeInstanceId: identity.runtimeInstanceId,
      threadId: identity.threadId,
      headGeneration: identity.headGeneration,
      workSessionId: identity.workSessionId,
    }, clientId);
  }
  return session;
}

async function claimHttp(viewerAgentId) {
  const res = await fetch(
    `${viewerOrigin}/api/agents/${encodeURIComponent(viewerAgentId)}/command-input/claim`,
    { method: 'POST' },
  );
  if (res.status === 204) return null;
  assert.equal(res.status, 200);
  const body = await res.json();
  return body.input ?? null;
}

async function ackHttp(viewerAgentId, receipt) {
  const res = await fetch(
    `${viewerOrigin}/api/agents/${encodeURIComponent(viewerAgentId)}/command-input/ack`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ receipt }),
    },
  );
  return { status: res.status, body: await res.json().catch(() => null) };
}

function leaseFacts(lease) {
  const { commandId, threadId, headGeneration, sessionId, runtimeInstanceId } = lease || {};
  return { commandId, threadId, headGeneration, sessionId, runtimeInstanceId };
}

function commandStatus(record, commandId) {
  return record.commands.find((c) => c.commandId === commandId)?.status;
}

// ── 用例 ────────────────────────────────────────────────────────

describe('thread succession timing (ADR-0047, cross-layer long chains)', () => {

  test('G1 head advance → adoption gap → fencing rejection keeps pending → adopt → runtime-ready redelivery → claim/ack settles', async () => {
    const { integration, core, board, viewerIds } = await makeWorld('g1');
    const HOST = 'host-app';
    const thread = await core.start({ sessionRef: { agentId: HOST, sessionId: 'g1-s1' } });
    const tid = thread.threadId;

    // 旧 head runtime：完整身份注册（gen1）
    registerViewerRuntime({
      viewerAgentId: 'g1-rt-1',
      identity: { runtimeInstanceId: 'g1-ri-1', threadId: tid, headGeneration: 1, workSessionId: 'g1-s1' },
    });
    viewerIds.set('g1-s1', 'g1-rt-1');
    // successor runtime 已拉起但 spawn 早于换头 → 无线程身份
    registerViewerRuntime({ viewerAgentId: 'g1-rt-2' });
    viewerIds.set('g1-s2', 'g1-rt-2');

    // C1：投递到旧 head 并留下正引用消费证据（turn.completed 携带 sourceRef）
    const { command: c1 } = await core.appendCommand({ threadId: tid, text: 'g1 first' });
    const firstDelivery = await integration.tryDeliver(tid);
    assert.equal(firstDelivery.delivered, 1);
    await board.recordRuntimeEvent({
      agentId: HOST, sessionId: 'g1-s1', runtimeInstanceId: 'g1-ri-1',
      event: { type: 'turn.completed', sourceRef: c1.commandId, at: Date.now() },
    });

    // 采纳器先失败（模拟 runtime IPC 不可达）
    const adoptCalls = [];
    integration.setHeadIdentityAdopter(async (agentId, sessionId, identity) => {
      adoptCalls.push({ agentId, sessionId, ...identity });
      return { ok: false, error: 'runtime unreachable (simulated)' };
    });

    // 接力：barrier → 滞留指令 C2 → 换头提交
    const begun = await integration.beginSessionSuccession({
      agentId: HOST, sessionId: 'g1-s1', reason: 'manual', seedContinuation: false,
    });
    assert.equal(begun.applied, true);
    const { command: c2 } = await core.appendCommand({ threadId: tid, text: 'g1 second' });
    const applied = await integration.applySessionSuccession({
      agentId: HOST, fromSessionId: 'g1-s1', toSessionId: 'g1-s2', reason: 'manual', seedContinuation: false,
    });

    // 换头成功；采纳失败不回滚（ADR：失败不回滚换头，指令留 retryable-pending）
    assert.equal(applied.applied, true);
    assert.equal(applied.thread.headSessionId, 'g1-s2');
    assert.equal(adoptCalls.length, 1);
    assert.deepEqual(
      { agentId: adoptCalls[0].agentId, sessionId: adoptCalls[0].sessionId, threadId: adoptCalls[0].threadId, headGeneration: adoptCalls[0].headGeneration },
      { agentId: HOST, sessionId: 'g1-s2', threadId: tid, headGeneration: 2 },
    );
    // C1 有正引用 → 已消费，不产生 unresolved
    assert.equal((await core.listUnresolved(tid)).length, 0);
    // C2 被 rt-2 fencing 拒收（会话无线程身份）→ retryable → 保持 pending
    let record = await core.getThread(tid);
    assert.equal(commandStatus(record, c2.commandId), 'pending');
    // 退避契约（delivery-consumer 防风暴）：retryable 失败后线程级冷却，
    // 非强制触发（tryDeliver）在窗口内 no-op；恢复依赖 force 通道
    // （runtime-ready / 换头）。锁定该拓扑，防止有人把 tryDeliver 改成
    // force 造成触发点风暴、或删掉退避让每条新指令都撞同一堵 fencing 墙。
    const gated = await integration.tryDeliver(tid);
    assert.equal(gated.attempted, 0);
    assert.equal(gated.reason, 'delivery_backoff');

    // 采纳成功：rt-2 以完整身份重注册（gen2），runtime-ready force 补投
    registerViewerRuntime({
      viewerAgentId: 'g1-rt-2',
      identity: { runtimeInstanceId: 'g1-ri-2', threadId: tid, headGeneration: 2, workSessionId: 'g1-s2' },
    });
    integration.setHeadIdentityAdopter(async () => ({ ok: true }));
    const ready = await integration.handleRuntimeReady(HOST, 'g1-s2');
    assert.equal(ready.applied, true);
    assert.equal(ready.delivery.delivered, 1);
    record = await core.getThread(tid);
    assert.equal(commandStatus(record, c2.commandId), 'delivered');

    // claim/ack 全协议（HTTP → 真实持久队列）：领取不移除，ack 结清
    const claimed = await claimHttp('g1-rt-2');
    assert.ok(claimed, 'durable command must be claimable after adoption');
    assert.equal(claimed.sourceRef, c2.commandId);
    assert.deepEqual(leaseFacts(claimed.inputLease), {
      commandId: c2.commandId, threadId: tid, headGeneration: 2,
      sessionId: 'g1-s2', runtimeInstanceId: 'g1-ri-2',
    });
    const ack = await ackHttp('g1-rt-2', claimed.inputLease);
    assert.equal(ack.status, 200);
    assert.equal(ack.body.acknowledged, true);
    assert.equal(await claimHttp('g1-rt-2'), null);
  });

  test('manual interrupt cancellation is separate from automatic succession delivery', async () => {
    const { integration, core, viewerIds } = await makeWorld('cancel-auto');
    const HOST = 'host-app';
    const thread = await core.start({ sessionRef: { agentId: HOST, sessionId: 'cancel-auto-s1' } });
    const tid = thread.threadId;
    registerViewerRuntime({
      viewerAgentId: 'cancel-auto-rt-1',
      identity: { runtimeInstanceId: 'cancel-auto-ri-1', threadId: tid, headGeneration: 1, workSessionId: 'cancel-auto-s1' },
    });
    viewerIds.set('cancel-auto-s1', 'cancel-auto-rt-1');
    const { command } = await core.appendCommand({ threadId: tid, text: 'survive succession' });
    const delivered = await integration.tryDeliver(tid);
    assert.equal(delivered.delivered, 1);
    const before = await core.getThread(tid);
    assert.equal(before.commands.find((entry) => entry.commandId === command.commandId).status, 'delivered');

    await integration.beginSessionSuccession({ agentId: HOST, sessionId: 'cancel-auto-s1', reason: 'context_guard', seedContinuation: true });
    const applied = await integration.applySessionSuccession({
      agentId: HOST, fromSessionId: 'cancel-auto-s1', toSessionId: 'cancel-auto-s2',
      reason: 'context_guard', seedContinuation: true,
    });
    assert.equal(applied.applied, true);
    const after = await core.getThread(tid);
    assert.equal(after.commands.find((entry) => entry.commandId === command.commandId).status, 'delivered');
    assert.ok((after.commands || []).some((entry) => entry.kind === 'system_continuation'));
  });

  test('G2 in-flight delivery racing head commit: late finalization lands in the new bar window and is converted to unresolved by the next succession', async () => {
    // 门控投递：viewer 真实接受（入队成功）后、bridge 返回前挂起——
    // 构造「接收成功但终态化迟到」的交错窗口。
    let signalHeld; let release;
    const held = new Promise((resolve) => { signalHeld = resolve; });
    const released = new Promise((resolve) => { release = resolve; });
    const wrapSubmit = (base) => async (params) => {
      const result = await base(params);
      signalHeld();
      await released;
      return result;
    };
    const { integration, core, board, viewerIds } = await makeWorld('g2', wrapSubmit);
    const HOST = 'host-app';
    const thread = await core.start({ sessionRef: { agentId: HOST, sessionId: 'g2-s1' } });
    const tid = thread.threadId;
    registerViewerRuntime({
      viewerAgentId: 'g2-rt-1',
      identity: { runtimeInstanceId: 'g2-ri-1', threadId: tid, headGeneration: 1, workSessionId: 'g2-s1' },
    });
    viewerIds.set('g2-s1', 'g2-rt-1');
    // 注意：g2-s2 不映射 runtime——换头后的补投在 resolver 处即返回
    // retryable，不产生额外在途请求，交错窗口只保留被测的那一条。

    const { command: c1 } = await core.appendCommand({ threadId: tid, text: 'g2 in-flight' });
    const deliveryPromise = integration.tryDeliver(tid);
    await held; // viewer 已真实接受 C1（rt-1 持久队列），inbox 仍 pending
    let record = await core.getThread(tid);
    assert.equal(commandStatus(record, c1.commandId), 'pending');

    // 换头提交：分类时 C1 pending → 非候选 → 无 unresolved；C1 不算已消费
    await integration.beginSessionSuccession({
      agentId: HOST, sessionId: 'g2-s1', reason: 'manual', seedContinuation: false,
    });
    integration.setHeadIdentityAdopter(async () => ({ ok: true }));
    const applied = await integration.applySessionSuccession({
      agentId: HOST, fromSessionId: 'g2-s1', toSessionId: 'g2-s2', reason: 'manual', seedContinuation: false,
    });
    assert.equal(applied.applied, true);
    assert.equal((await core.listUnresolved(tid)).length, 0);

    // 放行：迟到终态化落在 s2 窗口（标记 delivered 前不重读 head——K20 窗口）
    release();
    const delivery = await deliveryPromise;
    assert.equal(delivery.delivered, 1);
    record = await core.getThread(tid);
    const cmd = record.commands.find((c) => c.commandId === c1.commandId);
    assert.equal(cmd.status, 'delivered');
    const s2Bar = record.sessionChain.find((entry) => entry.sessionId === 'g2-s2');
    assert.ok(s2Bar?.startedAt, 's2 bar must exist after commit');
    assert.ok(
      Number(cmd.deliveredAt) >= Number(s2Bar.startedAt),
      'late finalization must be timestamped inside the new head window',
    );

    // 下一次接续（s2 → s3）：s2 有无关 turn 事件（touched）但无 C1 正引用
    // → C1 转为 unresolved(no_positive_reference)。迟到窗口不丢失，由
    // 后续接续兜底发现——这是设计语义，不是缺陷容忍。
    await board.recordRuntimeEvent({
      agentId: HOST, sessionId: 'g2-s2', runtimeInstanceId: 'g2-ri-2',
      event: { type: 'turn.completed', sourceRef: 'g2-unrelated-command', at: Date.now() },
    });
    const second = await integration.applySessionSuccession({
      agentId: HOST, fromSessionId: 'g2-s2', toSessionId: 'g2-s3', reason: 'manual', seedContinuation: false,
    });
    assert.equal(second.applied, true);
    const unresolved = await core.listUnresolved(tid);
    assert.equal(unresolved.length, 1);
    assert.equal(unresolved[0].commandId, c1.commandId);
    assert.equal(unresolved[0].reason, 'no_positive_reference');
  });

  test('G3 concurrent successions / reissue / appends / delivery against one thread keep structural invariants', async () => {
    const { integration, core, board, viewerIds } = await makeWorld('g3');
    const HOST = 'host-app';
    const thread = await core.start({ sessionRef: { agentId: HOST, sessionId: 'g3-s1' } });
    const tid = thread.threadId;
    registerViewerRuntime({
      viewerAgentId: 'g3-rt-1',
      identity: { runtimeInstanceId: 'g3-ri-1', threadId: tid, headGeneration: 1, workSessionId: 'g3-s1' },
    });
    viewerIds.set('g3-s1', 'g3-rt-1');
    registerViewerRuntime({
      viewerAgentId: 'g3-rt-2',
      identity: { runtimeInstanceId: 'g3-ri-2', threadId: tid, headGeneration: 2, workSessionId: 'g3-s2' },
    });
    viewerIds.set('g3-s2', 'g3-rt-2');

    // C1 投递但只留无关事件（touched、无正引用）→ 首次换头后成为 unresolved
    const { command: c1 } = await core.appendCommand({ threadId: tid, text: 'g3 first' });
    await integration.tryDeliver(tid);
    await board.recordRuntimeEvent({
      agentId: HOST, sessionId: 'g3-s1', runtimeInstanceId: 'g3-ri-1',
      event: { type: 'turn.completed', sourceRef: 'g3-unrelated-command', at: Date.now() },
    });
    await integration.beginSessionSuccession({
      agentId: HOST, sessionId: 'g3-s1', reason: 'manual', seedContinuation: false,
    });
    integration.setHeadIdentityAdopter(async () => ({ ok: true }));
    const first = await integration.applySessionSuccession({
      agentId: HOST, fromSessionId: 'g3-s1', toSessionId: 'g3-s2', reason: 'manual', seedContinuation: false,
    });
    assert.equal(first.applied, true);
    const unresolved = await core.listUnresolved(tid);
    assert.equal(unresolved.length, 1);
    const u1 = unresolved[0];
    assert.equal(u1.commandId, c1.commandId);

    // 并发风暴：barrier 已被首次换头清除，重新竖起后并发触发
    await integration.beginSessionSuccession({
      agentId: HOST, sessionId: 'g3-s2', reason: 'manual', seedContinuation: false,
    });
    const burst = await Promise.allSettled([
      integration.applySessionSuccession({ agentId: HOST, fromSessionId: 'g3-s2', toSessionId: 'g3-s3', reason: 'manual', seedContinuation: false }),
      integration.applySessionSuccession({ agentId: HOST, fromSessionId: 'g3-s2', toSessionId: 'g3-s4', reason: 'manual', seedContinuation: false }),
      core.resolveUnresolved({ threadId: tid, unresolvedId: u1.unresolvedId, resolution: 'reissue' }),
      core.resolveUnresolved({ threadId: tid, unresolvedId: u1.unresolvedId, resolution: 'reissue' }),
      core.resolveUnresolved({ threadId: tid, unresolvedId: u1.unresolvedId, resolution: 'reissue' }),
      core.appendCommand({ threadId: tid, text: 'g3 dup a', idempotencyKey: 'g3-dup' }),
      core.appendCommand({ threadId: tid, text: 'g3 dup b', idempotencyKey: 'g3-dup' }),
      core.appendCommand({ threadId: tid, text: 'g3 dup c', idempotencyKey: 'g3-dup' }),
      core.appendCommand({ threadId: tid, text: 'g3 beta', idempotencyKey: 'g3-b' }),
      core.appendCommand({ threadId: tid, text: 'g3 gamma', idempotencyKey: 'g3-c' }),
      integration.tryDeliver(tid),
    ]);

    // 竞争性换头：恰好一个生效；败者 void（两种时序都合法：交错进 commit
    // → head_mismatch；胜者先提交败者后启动 → findThreadByHeadSession 未
    // 命中 → no_thread_for_session。两者都是"线程状态已是权威"的幂等作废）
    const successionResults = [burst[0].value, burst[1].value];
    const appliedOnes = successionResults.filter((r) => r?.applied === true);
    assert.equal(appliedOnes.length, 1);
    const voided = successionResults.filter((r) => r?.applied !== true);
    assert.equal(voided.length, 1);
    assert.ok(
      ['head_mismatch', 'no_thread_for_session'].includes(voided[0].reason),
      `void succession must be a void-family reason, got ${voided[0].reason}`,
    );

    // 结构不变量：单头、链长 3、adopt 只发生一次（败者 commit 前即被拒）
    const record = await core.getThread(tid);
    assert.ok(['g3-s3', 'g3-s4'].includes(record.headSessionId));
    assert.equal(record.sessionChain.length, 3);

    // 指令不变量：reissue 恰好一条；同幂等键并发 append 恰好一条
    const reissues = record.commands.filter((c) => c.idempotencyKey === `reissue-${u1.unresolvedId}`);
    assert.equal(reissues.length, 1);
    assert.equal(reissues[0].metadata?.reissueOf, c1.commandId);
    const dups = record.commands.filter((c) => c.idempotencyKey === 'g3-dup');
    assert.equal(dups.length, 1);
    for (const key of ['g3-b', 'g3-c']) {
      assert.equal(record.commands.filter((c) => c.idempotencyKey === key).length, 1);
    }
    // C1 保持 delivered；重投与新增指令在 barrier / 未映射 head 下保持 pending
    assert.equal(commandStatus(record, c1.commandId), 'delivered');
    for (const command of [reissues[0], dups[0], ...record.commands.filter((c) => ['g3-b', 'g3-c'].includes(c.idempotencyKey))]) {
      assert.ok(['pending', 'delivered'].includes(command.status), `command ${command.commandId} must stay pending/delivered, got ${command.status}`);
    }
    // 并发 reissue 全部成功（幂等），open unresolved 清零
    for (const result of burst.slice(2, 5)) {
      assert.equal(result.status, 'fulfilled');
      assert.equal(result.value.command.idempotencyKey, `reissue-${u1.unresolvedId}`);
    }
    assert.equal((await core.listUnresolved(tid)).length, 0);
  });

  test('G4 manual succession without broadcast: unresolved → reissue → deliver → claim/ack consume, idempotent resolution', async () => {
    const { integration, core, viewerIds } = await makeWorld('g4');
    const HOST = 'host-app';
    const thread = await core.start({ sessionRef: { agentId: HOST, sessionId: 'g4-s1' } });
    const tid = thread.threadId;
    registerViewerRuntime({
      viewerAgentId: 'g4-rt-1',
      identity: { runtimeInstanceId: 'g4-ri-1', threadId: tid, headGeneration: 1, workSessionId: 'g4-s1' },
    });
    viewerIds.set('g4-s1', 'g4-rt-1');
    registerViewerRuntime({
      viewerAgentId: 'g4-rt-2',
      identity: { runtimeInstanceId: 'g4-ri-2', threadId: tid, headGeneration: 2, workSessionId: 'g4-s2' },
    });
    viewerIds.set('g4-s2', 'g4-rt-2');

    // C1 投递成功但不留任何 board 事件（board 无状态 → 证据缺失）
    const { command: c1 } = await core.appendCommand({ threadId: tid, text: 'g4 first' });
    await integration.tryDeliver(tid);

    await integration.beginSessionSuccession({
      agentId: HOST, sessionId: 'g4-s1', reason: 'manual', seedContinuation: false,
    });
    integration.setHeadIdentityAdopter(async () => ({ ok: true }));
    const applied = await integration.applySessionSuccession({
      agentId: HOST, fromSessionId: 'g4-s1', toSessionId: 'g4-s2', reason: 'manual', seedContinuation: false,
    });
    assert.equal(applied.applied, true);

    // 手动接续免播：不构造 system_continuation 通知指令
    let record = await core.getThread(tid);
    assert.equal(record.commands.filter((c) => c.kind === 'system_continuation').length, 0);

    // 无消费证据 → unresolved（board 从未写入 → evidence_missing）
    const unresolved = await core.listUnresolved(tid);
    assert.equal(unresolved.length, 1);
    const u1 = unresolved[0];
    assert.equal(u1.commandId, c1.commandId);
    assert.equal(u1.reason, 'evidence_missing');

    // reissue：派生新指令（回指原指令），状态 pending
    const resolved = await core.resolveUnresolved({ threadId: tid, unresolvedId: u1.unresolvedId, resolution: 'reissue' });
    const reissued = resolved.command;
    assert.equal(reissued.idempotencyKey, `reissue-${u1.unresolvedId}`);
    assert.equal(reissued.metadata?.reissueOf, c1.commandId);
    assert.equal(reissued.status, 'pending');

    // 重复同处置幂等：返回同一指令，不新增
    const again = await core.resolveUnresolved({ threadId: tid, unresolvedId: u1.unresolvedId, resolution: 'reissue' });
    assert.equal(again.command.commandId, reissued.commandId);
    record = await core.getThread(tid);
    assert.equal(record.commands.filter((c) => c.idempotencyKey === `reissue-${u1.unresolvedId}`).length, 1);

    // 冲突处置显式拒绝（不可再改口 discard）
    await assert.rejects(
      () => core.resolveUnresolved({ threadId: tid, unresolvedId: u1.unresolvedId, resolution: 'discard' }),
      (error) => error.code === 'unresolved_already_resolved',
    );

    // 投递到新 head（gen2 fencing 放行）→ claim/ack 消费闭环
    const delivery = await integration.tryDeliver(tid);
    assert.equal(delivery.delivered, 1);
    const claimed = await claimHttp('g4-rt-2');
    assert.ok(claimed, 'reissued command must be claimable on the new head');
    assert.equal(claimed.sourceRef, reissued.commandId);
    assert.deepEqual(leaseFacts(claimed.inputLease), {
      commandId: reissued.commandId, threadId: tid, headGeneration: 2,
      sessionId: 'g4-s2', runtimeInstanceId: 'g4-ri-2',
    });
    const ack = await ackHttp('g4-rt-2', claimed.inputLease);
    assert.equal(ack.status, 200);
    assert.equal(await claimHttp('g4-rt-2'), null);

    // 处置面收敛：open unresolved 清零（resolvedAt 已落）
    assert.equal((await core.listUnresolved(tid)).length, 0);
    record = await core.getThread(tid);
    assert.equal(commandStatus(record, reissued.commandId), 'delivered');
  });
});
