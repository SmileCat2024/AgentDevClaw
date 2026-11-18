import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

/**
 * 线程输入滞留自愈契约（requeue reconcile）。
 *
 * 历史：宿主注册表条目「在位且运行中」而 viewer 侧身份未采纳时，投递被
 * fencing 永拒（runtime_not_accepting_input，可重试失败保持 PENDING 且盘上
 * 无痕），而旧 requeue 扫描对条目在位的线程无条件跳过、ensureHeadRuntime
 * 同一事实短路、delivery-consumer 无自驱动——三个自愈机制全被同一宿主事实
 * 挡死，pending 永久滞留，唯一收敛路径是手动接续/重启（构造性复现钉住，
 * 见 git 历史版本的「永久滞留」用例）。
 *
 * 修复后契约（本文件断言）：requeue 扫描对「条目在位 + pending 滞留超阈值
 * （60s）」的线程行动——先强制重投（force，不受退避约束；覆盖触发点丢失
 * 类滞留），仍有滞留则重试身份采纳 adopt-thread-head（与重启路径 spawn
 * 注入收敛同构），采纳后复投。死锁形态应在单轮扫描内解除。
 *
 * 因果链的生产位置：
 *   fencing 拒绝 viewer-worker.ts:1287-1290 → Claw user-turn.js 透传
 *   retryable:true → 框架 bridge retryable 失败 → core 指令保持 PENDING →
 *   requeue reconcile（thread-succession.js）。
 */

const { WorkThreadRuntimeBridge } = await import('@agentdevjs/core');
const { createThreadControl } = await import('../server/thread-control/thread-controller.js');
const { createDeliveryConsumer } = await import('../server/thread-control/delivery-consumer.js');
const { createThreadRecoveryService } = await import('../server/thread-control/thread-succession.js');
const {
  managedAgents,
  getAgentRuntime,
  isManagedRuntimeRunning,
  getManagedRuntimeKey,
} = await import('../server/shared/agent-access.js');

const AGENT = 'programming-helper'; // 用户报告场景：PH 线程对话（threadHost: true）

/** viewer fencing 拒绝的等价错误（viewer-worker.ts:1290 的 code + user-turn.js 透传 retryable）。 */
function fencingReject() {
  return Object.assign(
    new Error('Command identity does not match the registered WorkThread head'),
    { name: 'UserTurnDeliveryError', code: 'runtime_not_accepting_input', retryable: true },
  );
}

/** 宿主侧注册表塞一个"在位且运行中"的条目（进程活着、selectedSessionId === head）。 */
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

/** 老化 pending 指令到超过 STALL_THRESHOLD_MS（60s），让扫描预筛通过。 */
async function agePendingCommands(control, threadId, ageMs = 120_000) {
  await control.store.update(threadId, (draft) => {
    for (const c of draft.commands || []) {
      if (c?.status === 'pending') c.createdAt = Date.now() - ageMs;
    }
    return draft;
  });
}

/** 生产同构的 ensureHeadRuntime 复刻（server.js 短路条件；server 侧逻辑变更时需同步更新）。 */
function makeEnsureHeadRuntime() {
  let wakes = 0;
  const fn = async (agentId, sessionId) => {
    if (isManagedRuntimeRunning(getAgentRuntime(agentId, sessionId))) {
      return { ok: true };
    }
    wakes += 1;
    return { ok: true };
  };
  return { fn, wakes: () => wakes };
}

describe('线程输入滞留自愈（requeue reconcile）', () => {
  let env;
  const runtimeKeys = [];

  beforeEach(async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const root = await mkdtemp(path.join(tmpdir(), 'wt-stall-repro-'));
    env = { root, cleanup: () => rm(root, { recursive: true, force: true }) };
  });

  afterEach(async () => {
    for (const key of runtimeKeys) managedAgents.delete(key);
    runtimeKeys.length = 0;
    await env.cleanup();
  });

  it('死锁形态（条目在位 + fencing 永拒）：扫描强制重投 → 仍滞留则 adopt 重试 → 复投解除', async () => {
    const HEAD = 'stall-head';
    const turns = [];
    const adoptCalls = [];
    let adoptedRealigned = false; // 模拟 runtime 采纳身份后的 fencing 对齐

    let control;
    control = createThreadControl({
      rootDir: env.root,
      bridge: new WorkThreadRuntimeBridge({
        enabled: true,
        resolveRuntimeViewerId: (agentId, sessionId) => control.resolveSessionViewerId(agentId, sessionId),
        submitTurn: async (params) => {
          if (!adoptedRealigned) throw fencingReject();
          turns.push(params);
          return { success: true };
        },
      }),
    });
    const thread = await control.core.start({ sessionRef: { agentId: AGENT, sessionId: HEAD } });
    registerFakeRuntime(AGENT, HEAD, 'viewer-stalled', runtimeKeys);

    // 到达死锁点：入箱 → 即时投递被 fencing 拒 → pending 无痕滞留
    await control.core.appendCommand({ threadId: thread.threadId, text: '继续' });
    const consumer = createDeliveryConsumer(control.core);
    const stalled = await consumer.consume(thread.threadId);
    assert.equal(stalled.delivered, 0);
    assert.equal((await pendingCommandsOf(control, thread.threadId)).length, 1);

    // 滞留超阈值后的扫描（janitor 15s 一拍的等价单次调用）
    await agePendingCommands(control, thread.threadId);
    const ensureHead = makeEnsureHeadRuntime();
    const recovery = createThreadRecoveryService({
      threadControl: control,
      rotationRegistry: { isActive: () => false },
      getEnsureHeadRuntime: () => ensureHead.fn,
      getForceDeliver: () => (tid) => consumer.consume(tid, { force: true }),
      getHeadIdentityAdopter: () => async (agentId, sessionId, identity) => {
        adoptCalls.push({ agentId, sessionId, ...identity });
        adoptedRealigned = true; // 采纳成功：viewer 重注册，fencing 对齐
        return { ok: true };
      },
    });
    const sweep = await recovery.requeueStalledPendingThreads();

    // 扫描行动且解除死锁
    assert.equal(sweep.examined, 1, '条目在位不再被跳过：扫描行动');
    assert.equal(sweep.reconciled.length, 1);
    assert.equal(sweep.reconciled[0].delivered, 1, '滞留指令经对账后送达');
    assert.equal(sweep.reconciled[0].adopt, 'ok', '身份采纳成功后复投');
    assert.equal(adoptCalls.length, 1, 'adopt 恰好重试一次');
    assert.equal(adoptCalls[0].threadId, thread.threadId);
    assert.equal(adoptCalls[0].sessionId, HEAD);
    assert.equal(adoptCalls[0].headGeneration, 1, '单会话线程 gen=1');
    assert.equal(ensureHead.wakes(), 0, '条目在位：不需要唤醒路径');

    // 终态：指令 delivered，消息送达
    const record = await control.core.getThread(thread.threadId);
    assert.equal(record.commands[0].status, 'delivered');
    assert.equal((await pendingCommandsOf(control, thread.threadId)).length, 0);
    assert.equal(turns.at(-1).text, '继续');
  });

  it('触发点丢失形态（条目在位 + 投递本可成功但无人触发）：一次强制重投即解除，不需 adopt', async () => {
    const HEAD = 'trigger-lost-head';
    const turns = [];
    const adoptCalls = [];

    let control;
    control = createThreadControl({
      rootDir: env.root,
      bridge: new WorkThreadRuntimeBridge({
        enabled: true,
        resolveRuntimeViewerId: (agentId, sessionId) => control.resolveSessionViewerId(agentId, sessionId),
        submitTurn: async (params) => { turns.push(params); return { success: true }; },
      }),
    });
    const thread = await control.core.start({ sessionRef: { agentId: AGENT, sessionId: HEAD } });
    registerFakeRuntime(AGENT, HEAD, 'viewer-healthy', runtimeKeys);

    // 入箱后不触发任何投递（模拟 runtime-ready 钩子丢失等触发点缺失）
    await control.core.appendCommand({ threadId: thread.threadId, text: '补投我' });
    assert.equal((await pendingCommandsOf(control, thread.threadId)).length, 1);

    await agePendingCommands(control, thread.threadId);
    const consumer = createDeliveryConsumer(control.core);
    const recovery = createThreadRecoveryService({
      threadControl: control,
      rotationRegistry: { isActive: () => false },
      getEnsureHeadRuntime: () => async () => ({ ok: true }),
      getForceDeliver: () => (tid) => consumer.consume(tid, { force: true }),
      getHeadIdentityAdopter: () => async (agentId, sessionId, identity) => {
        adoptCalls.push({ agentId, sessionId, ...identity });
        return { ok: true };
      },
    });
    const sweep = await recovery.requeueStalledPendingThreads();

    assert.equal(sweep.examined, 1);
    assert.equal(sweep.reconciled[0].adopt, 'not_needed', '首次强制重投即送达，身份无错位');
    assert.equal(sweep.reconciled[0].delivered, 1);
    assert.equal(adoptCalls.length, 0, '身份正确时不做多余 adopt IPC');
    assert.equal(turns.at(-1).text, '补投我');
    assert.equal((await pendingCommandsOf(control, thread.threadId)).length, 0);
  });

  it('对照：手动接续等价（换头 + 旧 runtime 退役 + 新 runtime 采纳身份）后 force 投递即恢复', async () => {
    const HEAD = 'stall-head';
    const HEAD2 = 'stall-head-s2';
    const turns = [];

    let control;
    control = createThreadControl({
      rootDir: env.root,
      bridge: new WorkThreadRuntimeBridge({
        enabled: true,
        resolveRuntimeViewerId: (agentId, sessionId) => control.resolveSessionViewerId(agentId, sessionId),
        submitTurn: async (params) => {
          if (params.sessionId === HEAD) throw fencingReject();
          turns.push(params);
          return { success: true };
        },
      }),
    });
    const thread = await control.core.start({ sessionRef: { agentId: AGENT, sessionId: HEAD } });
    registerFakeRuntime(AGENT, HEAD, 'viewer-stalled', runtimeKeys);

    await control.core.appendCommand({ threadId: thread.threadId, text: '继续' });
    const consumer = createDeliveryConsumer(control.core);
    const stalled = await consumer.consume(thread.threadId);
    assert.equal(stalled.delivered, 0, '先到达死锁点：同一现场');

    await control.core.beginSessionHandoff({ threadId: thread.threadId, fromSessionId: HEAD, reason: 'trim', seedContinuation: false });
    await control.core.advanceHead({ threadId: thread.threadId, toSessionId: HEAD2, fromSessionId: HEAD, endKind: 'trim' });
    managedAgents.get(getManagedRuntimeKey(AGENT, HEAD)).stopped = true;
    registerFakeRuntime(AGENT, HEAD2, 'viewer-successor', runtimeKeys);

    const revived = await consumer.consume(thread.threadId, { force: true });
    assert.equal(revived.delivered, 1, '换头后同一指令即投出');
    const record = await control.core.getThread(thread.threadId);
    assert.equal(record.commands[0].status, 'delivered');
    assert.equal(turns.at(-1).text, '继续', '消息送达新 head —— 与"手动接续一下就能正常发出去"吻合');
  });
});
