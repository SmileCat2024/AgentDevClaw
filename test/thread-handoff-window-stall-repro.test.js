import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

/**
 * 「换代窗口滞留 + 无人捎带」形态复刻（用户实际遭遇的 bug，非构造推演）。
 *
 * 生产实例 wt-1ab8a75b（2026-11-08，盘上复盘）：
 *   09:43-09:52  4 条消息（chat-composer）入箱后投递失败——前两条目标
 *               runtime 仍存活但拒收，后两条落在服务重启收割（09:46:06
 *               SIGTERM）后的 runtime 缺位窗口。失败无痕：attempts 不记、
 *               lastReason 为空、无 deliveredAt。
 *   10:09-11:09  同一前台会话的新消息每条秒级送达（deliveryRef 落在三个
 *               不同 pid 的 runtime 上——runtime 反复换代），滞留的 4 条
 *               pending 对在位 runtime 始终不可达：任何触发点（新消息入箱
 *               的即时投递等）都不把它们捎带送达，也不留任何新痕迹。
 *   11:24:40    adaptive 接续播种 → 11:24:45 head 换代 → 11:24:46 全部
 *               pending 同一毫刻批量送达。「点接续救活」的机制本体。
 *
 * 当时（fb978e7d）生产条件：无 janitor、无 requeue（均为 11-18 引入）——
 * 本测试同样不装配 recovery，复刻的是无自愈干预下的自然行为。
 *
 * 注入点（两处，其余全为真实生产模块）：
 *   1. managedAgents 注册表按时间线放置/移除 runtime 条目（收割 = 删除；
 *      R2 放置在非 head 会话上——生产 deliveryRef 证明恢复期 runtime 跑在
 *      别的会话）。
 *   2. submitTurn 仅在 R1 阶段全拒（09:43 形态）；09:47/09:52 的失败由
 *      resolveRuntimeViewerId 返回 null 自然产生（无注入）；R2 阶段 head
 *      上无 runtime 的不可达同样由 resolve-null 真实机制承担（无注入）。
 *      生产中 10:09 一条新消息经线程域送达的确切路径（deliveryRef 在
 *      多个 pid 上）盘上证据不可钉死，本测试以直投域送达（direct 路由）
 *      复刻「新消息正常流通与旧 pending 不可达并存」的可观察终态。
 *
 * 与 thread-pending-stall-deadlock-repro.test.js 的分工：那一份钉「条目
 * 在位 + fencing 永拒 + 三个自愈机制同源失效」的死锁形态及 requeue
 * reconcile 契约；本份钉用户实际遭遇的「换代窗口无痕滞留 + 新消息流通
 * 与旧 pending 不可达并存 + 接续 force 导流是唯一收敛」形态。
 */

const { WorkThreadRuntimeBridge } = await import('@agentdevjs/core');
const { createThreadControl } = await import('../server/thread-control/thread-controller.js');
const { createDeliveryConsumer } = await import('../server/thread-control/delivery-consumer.js');
const { deliverThreadInput, deliverUserInput } = await import('../server/thread-control/input-gateway.js');
const {
  managedAgents,
  getManagedRuntimeKey,
} = await import('../server/shared/agent-access.js');

const AGENT = 'programming-helper'; // 生产实例 agent（threadHost: true）
const R1_VIEWER = 'agent-1-18576'; // 与生产实例 deliveryRef 同名（收割前 runtime）
const R2_VIEWER = 'agent-1-35480'; // 生产 10:09 送达消息的 deliveryRef

/** viewer fencing 拒绝的等价错误（viewer-worker.ts:1290 code + user-turn.js 透传 retryable）。 */
function fencingReject() {
  return Object.assign(
    new Error('Command identity does not match the registered WorkThread head'),
    { name: 'UserTurnDeliveryError', code: 'runtime_not_accepting_input', retryable: true },
  );
}

/** 宿主注册表放置 runtime 条目（进程存活、selectedSessionId 显式指定）。 */
function registerFakeRuntime(agentId, sessionId, viewerAgentId, runtimeKeys) {
  const key = getManagedRuntimeKey(agentId, sessionId);
  managedAgents.set(key, {
    agentId,
    id: agentId,
    process: { exitCode: null, signalCode: null }, // isChildProcessRunning → true
    stopped: false,
    stopping: false,
    selectedSessionId: sessionId,
    viewerAgentId,
    startedAt: new Date().toISOString(),
  });
  runtimeKeys.push(key);
}

async function pendingCommandsOf(control, threadId) {
  const record = await control.core.getThread(threadId);
  return (record.commands || []).filter((c) => c?.status === 'pending');
}

/** viewer 直投端点的受控替身：200 + success（submitUserTurn 成功契约）。 */
function makeViewerFetchStub(sink) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    sink.push(body);
    return {
      ok: true,
      status: 200,
      json: async () => ({ success: true, delivery: 'delivered' }),
    };
  };
}

describe('换代窗口滞留 + 无人捎带（wt-1ab8a75b 生产实例复刻）', () => {
  let env;
  const runtimeKeys = [];

  beforeEach(async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const root = await mkdtemp(path.join(tmpdir(), 'wt-handoff-stall-'));
    env = { root, cleanup: () => rm(root, { recursive: true, force: true }) };
  });

  afterEach(async () => {
    for (const key of runtimeKeys) managedAgents.delete(key);
    runtimeKeys.length = 0;
    await env.cleanup();
  });

  it('换代窗口失败无痕滞留 → 新消息流通与旧 pending 不可达并存 → 接续 force 导流批量清空', async () => {
    const HEAD = 'session-1794122776319-41899e'; // 生产实例滞留期的线程 head
    const OTHER = 'session-restarted-chat'; // 重启后前台实际对话的会话（非线程 head）
    const HEAD2 = 'session-1794137085015-4a8e48'; // 11:24 接续后的新 head
    const turns = [];
    const directSink = [];
    let phase = 'r1-reject-all'; // r1-reject-all → free

    let control;
    control = createThreadControl({
      rootDir: env.root,
      bridge: new WorkThreadRuntimeBridge({
        enabled: true,
        resolveRuntimeViewerId: (agentId, sessionId) => control.resolveSessionViewerId(agentId, sessionId),
        submitTurn: async (params) => {
          if (phase === 'r1-reject-all') throw fencingReject();
          turns.push(params);
          return { success: true };
        },
      }),
    });

    // 虚拟时钟：快进退避窗口（backoffMs=2s），避免真实等待
    let clockNow = 1_000_000;
    const consumer = createDeliveryConsumer(control.core, { now: () => clockNow });
    const integration = {
      core: control.core,
      tryDeliver: (tid) => consumer.consume(tid),
    };

    const thread = await control.core.start({ sessionRef: { agentId: AGENT, sessionId: HEAD } });

    // ── 09:43-09:45：R1 存活但拒收（前两条消息） ─────────────────────
    registerFakeRuntime(AGENT, HEAD, R1_VIEWER, runtimeKeys);
    for (const text of ['D:\\code\\adv-plugin 这个', '然后，当前仓库先提交一下代码']) {
      const accepted = await deliverThreadInput({ threadId: thread.threadId, text }, { integration });
      assert.equal(accepted.success, true);
      assert.equal(accepted.delivery, 'thread_queued', '入箱接受与送达是独立结果');
      clockNow += 3_000; // 过退避窗口（下一次投递不被 backoff 挡）
    }
    let pending = await pendingCommandsOf(control, thread.threadId);
    assert.equal(pending.length, 2, 'R1 拒收：前两条滞留');
    assert.ok(pending.every((c) => c.attempts === 0 && !c.lastReason && !c.deliveredAt),
      '失败无痕：attempts 不记、lastReason 空、无 deliveredAt（盘上铁证）');

    // ── 09:46：服务重启收割 R1（SIGTERM 等价：注册表条目移除） ──────────
    managedAgents.delete(getManagedRuntimeKey(AGENT, HEAD));

    // ── 09:47-09:52：runtime 缺位窗口（后两条消息，resolve null 自然失败） ──
    for (const text of ['嗯，我刚已经重启了，就是你得给我解释清楚', '编程小助手的项目配置弹窗']) {
      const accepted = await deliverThreadInput({ threadId: thread.threadId, text }, { integration });
      assert.equal(accepted.success, true);
      clockNow += 3_000;
    }
    pending = await pendingCommandsOf(control, thread.threadId);
    assert.equal(pending.length, 4, '收割后缺位窗口：后两条同样滞留');
    assert.ok(pending.every((c) => c.attempts === 0 && !c.lastReason && !c.deliveredAt),
      '四种失败路径汇同一形态：无痕 pending');

    // ── 10:09：R2 就位（跑在另一个会话上），新消息经直投域正常送达 ──────
    phase = 'free';
    registerFakeRuntime(AGENT, OTHER, R2_VIEWER, runtimeKeys);
    const direct = await deliverUserInput(
      { viewerAgentId: R2_VIEWER, text: '无法读取 package.json 的问题' },
      {
        integration,
        fetchImpl: makeViewerFetchStub(directSink),
      },
    );
    assert.equal(direct.success, true, '直投域（runtime selectedSession 非线程 head → direct 路由）正常送达');
    assert.equal(directSink.length, 1);
    assert.equal(directSink[0].text, '无法读取 package.json 的问题');

    // 线程域：head 上无 runtime（R2 的 selectedSession 是 OTHER）——resolve
    // null 自然挡住一切触发点投递，滞留指令不可达且不留新痕迹。
    const retried = await consumer.consume(thread.threadId);
    assert.equal(retried.delivered, 0, '触发点重投：head 无 runtime，仍不可达');
    pending = await pendingCommandsOf(control, thread.threadId);
    assert.equal(pending.length, 4, '新消息正常流通的世界里，旧 pending 无人捎带');
    assert.ok(pending.every((c) => c.attempts === 0 && !c.lastReason),
      '反复重试不留新痕迹：事后查现场仍是干净的');
    assert.equal(turns.length, 0, '线程域至今无任何成功投递');

    // ── 11:24：接续换代（head 推进 + 换代后 runtime 接受一切）→ force 导流 ──
    await control.core.beginSessionHandoff({
      threadId: thread.threadId,
      fromSessionId: HEAD,
      reason: 'adaptive',
      seedContinuation: false,
    });
    await control.core.advanceHead({
      threadId: thread.threadId,
      toSessionId: HEAD2,
      fromSessionId: HEAD,
      endKind: 'trim',
    });
    managedAgents.delete(getManagedRuntimeKey(AGENT, OTHER));
    registerFakeRuntime(AGENT, HEAD2, 'agent-2-22668', runtimeKeys);

    const revived = await consumer.consume(thread.threadId, { force: true });
    assert.equal(revived.delivered, 4, '接续 force 导流：全部滞留一次清空（11:24:46 批量送达）');

    const record = await control.core.getThread(thread.threadId);
    const delivered = record.commands.filter((c) => c.status === 'delivered');
    assert.equal(delivered.length, 4);
    assert.equal((await pendingCommandsOf(control, thread.threadId)).length, 0);
    const stamps = new Set(delivered.map((c) => c.deliveredAt));
    assert.equal(stamps.size, 1, '同一毫刻批量送达（生产 11:24:46.089 五条同刻）');
    assert.deepEqual(
      delivered.map((c) => c.text),
      ['D:\\code\\adv-plugin 这个', '然后，当前仓库先提交一下代码', '嗯，我刚已经重启了，就是你得给我解释清楚', '编程小助手的项目配置弹窗'],
      'FIFO 序完整送达',
    );
    assert.equal(turns.length, 4, '全部经线程域投出');
  });
});
