/**
 * 线程接续恢复入口（resumeRotation）—— 真实状态机 + 真实接续链路
 *
 * 契约：对一条 rotation_failed 的线程手动触发一次接力，执行体与自动接续
 * 是同一条链路（rotate → beginSessionSuccession → compactAndResume →
 * commitSuccession），成功后状态自然回到 open，不需要任何「清除失败标记」
 * 的额外语义。
 *
 * 三个必须成立的承诺：
 *   1. rotation_failed 状态下重跑能成功，head 换代、status 回 open——这是
 *      「恢复入口」存在的意义，也是状态机本就支持的路径（框架
 *      beginSessionHandoff 只拦 closed / head_mismatch）；
 *   2. 旧 head runtime 已退役时，先经 ensureHeadRuntime 拉起再接力——
 *      不补这个前置，rotate 的第一步 stopManagedAgent({waitForPersistence})
 *      会直接抛错，恢复等于没做；
 *   3. 挡板仍在（rotating）时不重入：接力进行中由既有事务负责。
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tmpRoot = await mkdtemp(path.join(tmpdir(), 'claw-rotation-resume-'));
process.env.AGENTDEV_DATA_DIR = tmpRoot;

const { WorkThreadRuntimeBridge } = await import('@agentdevjs/core');
const { createThreadControl } = await import('../server/thread-control/thread-controller.js');
const { createThreadIntegration } = await import('../server/thread-control/thread-integration.js');
const { createThreadSuccessionService } = await import('../server/thread-control/thread-succession.js');
const { createThreadRotationService } = await import('../server/thread-control/thread-rotation.js');
const { createSessionHandoffHelpers } = await import('../server/routes/session-handoff-helpers.js');
const { buildRotationStrategyResolver } = await import('../server/context-continuity/rotation-strategy-resolver.js');
const { getPrebuiltSessionFilePath } = await import('../server/shared/session-access.js');

const AGENT_ID = 'coder';
const FAKE_AGENT_DIR = path.join(tmpRoot, 'fake-agent-dir');

let control;
let rotationService;
let spawnCalls;
let stopCalls;
let ensureCalls;
let policyOverrides;
let sessionSeq;

function buildToolHeavyMessages() {
  const messages = [
    { role: 'system', content: '你是无人值守编码 agent，修复指定工单。', turn: 0 },
    { role: 'user', content: '工单：修复 server/auth.js 中的登录超时问题。', turn: 1 },
  ];
  for (let i = 1; i <= 5; i += 1) {
    messages.push({
      role: 'assistant', content: '', turn: 1,
      toolCalls: [{ id: `probe-${i}`, name: 'read', arguments: JSON.stringify({ filePath: `src/module-${i}.js` }) }],
    });
    messages.push({ role: 'tool', toolCallId: `probe-${i}`, turn: 1, content: `// module ${i}\n` + 'export function noop() { return 1; }\n'.repeat(400) });
  }
  messages.push({ role: 'assistant', content: '定位到根因：连接池未释放导致排队超时。开始修复。', turn: 2 });
  for (let i = 1; i <= 5; i += 1) {
    messages.push({
      role: 'assistant', content: '', turn: 3,
      toolCalls: [{ id: `fix-${i}`, name: 'edit', arguments: JSON.stringify({ filePath: 'server/auth.js', oldString: `release-${i}`, newString: `release-${i}-fixed` }) }],
    });
    messages.push({ role: 'tool', toolCallId: `fix-${i}`, turn: 3, content: `ok-${i}` });
  }
  messages.push({ role: 'assistant', content: '修复完成，正在验证。', turn: 4 });
  return messages;
}

async function writeSessionSnapshot(sessionId, messages) {
  const snapshot = {
    schemaVersion: 1,
    sessionId,
    runtime: {
      context: {
        messages,
        enrichedMessages: messages.map((_, index) => ({ timestamp: 1700000000000 + index * 60_000 })),
      },
    },
  };
  const file = getPrebuiltSessionFilePath(AGENT_ID, sessionId);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(snapshot), 'utf8');
  return snapshot;
}

async function readSnapshotFile(sessionId) {
  const { readFile } = await import('node:fs/promises');
  return JSON.parse(await readFile(getPrebuiltSessionFilePath(AGENT_ID, sessionId), 'utf8'));
}

before(async () => {
  spawnCalls = [];
  stopCalls = [];
  ensureCalls = [];
  policyOverrides = {};
  sessionSeq = 0;

  const bridge = new WorkThreadRuntimeBridge({
    enabled: true,
    resolveRuntimeViewerId: () => 'viewer-coder-live',
    submitTurn: async () => ({ ok: true }),
  });
  control = createThreadControl({ rootDir: path.join(tmpRoot, 'threads'), bridge });
  const integration = createThreadIntegration({ control, publishThreadEvent: () => {} });
  const succession = createThreadSuccessionService({
    threadControl: control,
    threadIntegration: integration,
    stopManagedAgent: async () => {},
  });

  const helpers = createSessionHandoffHelpers({
    startManagedAgent: async (agent, sessionId, opts) => {
      spawnCalls.push({ agentId: agent.id, sessionId, opts });
      return { status: 'ok' };
    },
    waitForManagedRuntimeReady: async (agentId, _timeout, sessionId) => ({
      id: `viewer-${sessionId}`, connected: true, name: 'coder successor',
    }),
    resolvePrebuiltSessionOwner: async () => AGENT_ID,
    requirePrebuiltSessionRecord: async (agentId, sessionId) => ({ id: sessionId, title: '恢复验证工单' }),
    requirePrebuiltAgentForRuntime: async () => ({ id: AGENT_ID, relativeDir: FAKE_AGENT_DIR }),
    createPrebuiltSession: async (agentId, opts) => ({ id: `session-resume-${sessionSeq += 1}`, sessionType: opts?.sessionType || '' }),
    readSessionSnapshotForContinuity: async (agentId, sessionId) => readSnapshotFile(sessionId),
    setSessionHasSummary: async () => {},
  });

  const resolver = buildRotationStrategyResolver({
    readPolicies: async () => policyOverrides,
    readDeclaredAgents: async () => [{ id: AGENT_ID, permissionDefaults: { contextRotationStrategy: 'trim' } }],
  });

  rotationService = createThreadRotationService({
    sessionApi: { ...helpers, updateSessionIndex: async () => ({}) },
    stopManagedAgent: async (agentId, sessionId, opts) => { stopCalls.push({ agentId, sessionId, opts }); },
    threadIntegration: integration,
    threadControl: control,
    threadSuccession: succession,
    resolveRotationStrategy: resolver,
  });
});

after(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

/** 把线程直接推到「接续失败」状态（真实事件 + 真实挡板收敛，不走 LLM）。 */
async function markRotationFailed(sessionId) {
  const started = await control.core.start({ sessionRef: { agentId: AGENT_ID, sessionId }, title: '恢复验证工单' });
  await control.core.beginSessionHandoff({ threadId: started.threadId, fromSessionId: sessionId, reason: 'trim' });
  await control.core.failSessionHandoff(started.threadId, {
    reason: 'context_rotation_failed',
    stage: 'compact_or_successor',
    error: 'summary timed out',
  });
  const { abortPendingSuccession } = await import('../server/thread-control/thread-succession.js');
  await abortPendingSuccession(control.core, started.threadId, {
    stage: 'compact_or_successor',
    reason: 'context_rotation_failed',
    error: 'summary timed out',
  });
  return started.threadId;
}

describe('线程接续恢复入口', () => {
  it('rotation_failed 线程重跑接续：head 换代、status 回 open、失败事实保留', async () => {
    const sessionId = 'session-resume-a';
    await writeSessionSnapshot(sessionId, buildToolHeavyMessages());
    const threadId = await markRotationFailed(sessionId);

    const beforeRecord = await control.core.getThread(threadId);
    assert.equal(beforeRecord.status, 'rotation_failed', '前置状态应为接续失败');
    assert.equal(beforeRecord.pendingSuccession, null, '失败已收敛挡板');

    const result = await rotationService.resumeRotation({
      agentId: AGENT_ID,
      sessionId,
      ensureHeadRuntime: async (agentId, sid) => { ensureCalls.push({ agentId, sid }); return { ok: true }; },
    });

    assert.equal(result.applied, true, `恢复应成功: ${JSON.stringify(result)}`);
    const afterRecord = await control.core.findThreadByHeadSession(AGENT_ID, result.headSessionId);
    assert.ok(afterRecord, '新 head 应可反查线程');
    assert.equal(afterRecord.status, 'open', '成功提交后状态自然回到 open');
    assert.equal(afterRecord.headSessionId, result.headSessionId);
    assert.notEqual(afterRecord.headSessionId, sessionId, 'head 应换代');
    // 失败事实保留供审计（不因重试成功而抹除）
    assert.ok(
      afterRecord.lifecycleEvents.some((e) => e.type === 'handoff_failed'),
      '历史失败事实应保留',
    );
    assert.ok(
      afterRecord.lifecycleEvents.some((e) => e.type === 'handoff_completed' || e.type === 'head_advanced'),
      '应有成功提交事件',
    );
  });

  it('旧 head runtime 已退役时先唤起再接力（不补前置会停在 stopManagedAgent 抛错）', async () => {
    const sessionId = 'session-resume-b';
    await writeSessionSnapshot(sessionId, buildToolHeavyMessages());
    const threadId = await markRotationFailed(sessionId);

    const order = [];
    const result = await rotationService.resumeRotation({
      agentId: AGENT_ID,
      sessionId,
      ensureHeadRuntime: async () => { order.push('ensure'); return { ok: true }; },
    });
    order.push('after');

    assert.equal(result.applied, true, JSON.stringify(result));
    assert.equal(order[0], 'ensure', '唤起必须发生在接力之前');
    assert.ok(order.includes('after'));
    assert.ok(threadId);
  });

  it('head runtime 起不来时不发起接力，如实回报原因', async () => {
    const sessionId = 'session-resume-c';
    await writeSessionSnapshot(sessionId, buildToolHeavyMessages());
    const threadId = await markRotationFailed(sessionId);
    const spawnBase = spawnCalls.length;

    const result = await rotationService.resumeRotation({
      agentId: AGENT_ID,
      sessionId,
      ensureHeadRuntime: async () => ({ ok: false, code: 'runtime_ready_timeout', message: 'not ready' }),
    });

    assert.equal(result.applied, false);
    assert.equal(result.reason, 'head_runtime_unavailable');
    assert.equal(result.code, 'runtime_ready_timeout');
    assert.equal(spawnCalls.length - spawnBase, 0, '不得在 head 未就绪时继续接力');
    const record = await control.core.getThread(threadId);
    assert.equal(record.status, 'rotation_failed', '状态保持原样，等待下次恢复');
    assert.equal(record.headSessionId, sessionId, 'head 不得推进');
    assert.equal(record.pendingSuccession, null, '不得留下挡板');
  });

  it('接力进行中（挡板未收敛）拒绝重入', async () => {
    const sessionId = 'session-resume-d';
    await writeSessionSnapshot(sessionId, buildToolHeavyMessages());
    const started = await control.core.start({ sessionRef: { agentId: AGENT_ID, sessionId }, title: '进行中' });
    await control.core.beginSessionHandoff({ threadId: started.threadId, fromSessionId: sessionId, reason: 'trim' });

    // handleContextGuard 的去重基于 inflight 表，这里直接构造「挡板仍在」的情形：
    // resumeRotation 会照常调用 rotate，而 rotate 的第一步 beginSessionSuccession
    // 由框架守卫挡下（同一 fromSessionId 的挡板仍新鲜）。
    const result = await rotationService.resumeRotation({
      agentId: AGENT_ID,
      sessionId,
      ensureHeadRuntime: async () => ({ ok: true }),
    });

    assert.equal(result.applied, false, '挡板仍在时不得重复接力');
    const record = await control.core.getThread(started.threadId);
    assert.equal(record.status, 'rotating', '既有接续仍在进行');
    assert.equal(record.headSessionId, sessionId, 'head 不得推进');
  });

  it('无效入参直接拒绝，不触碰线程', async () => {
    const result = await rotationService.resumeRotation({ agentId: '', sessionId: '' });
    assert.equal(result.applied, false);
    assert.equal(result.reason, 'invalid_session');
  });
});
