/**
 * Coder 接续策略端到端情景测试（设计定案 2026-10-18 三选一）
 *
 * 端点拉远：上游从 handleContextGuard（context-rotation-trigger 事件在
 * server 侧的出口，即 coder runtime 内 feature 触发后的上报落点）进，
 * 下游到 handoff 真实落盘文件、接续 spawn 参数（ROTATION 豁免意图 +
 * handoff 环境变量）、线程 head 推进与 R3 恢复指令投递。中间全部走真实
 * 实现：框架 WorkThread 状态机（state-kernel）、挡板 / 失败收敛、
 * thread-succession 提交点、真实 sessionApi（createSessionHandoffHelpers）、
 * 真实三档产物路径与 trim 引擎。
 *
 * 不出真实 API：
 *   - trim 档本身零 LLM；
 *   - 失败注入走真实解析失败（stub agentDir 无 metadata.json →
 *     resolveSummaryLLM 抛 "No model preset resolved"）；
 *   - trim-summary 档成功路径经 llm 注入缝（runTrimTranscriptWithSummary
 *     既有参数，编排层透传）换 stub LLM，组合变换本身真实执行。
 *
 * 数据隔离：AGENTDEV_DATA_DIR 必须先于任何 server 模块加载设置
 * （USER_DATA_ROOT 是模块级常量），全部动态 import。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// ── 数据根隔离（先设 env，再动态 import server 模块）────────────────
const tmpRoot = await mkdtemp(path.join(tmpdir(), 'claw-rotation-e2e-'));
process.env.AGENTDEV_DATA_DIR = tmpRoot;

const { WorkThreadRuntimeBridge } = await import('@agentdevjs/core');
const { createThreadControl } = await import('../server/thread-control/thread-controller.js');
const { createThreadIntegration } = await import('../server/thread-control/thread-integration.js');
const { createThreadSuccessionService } = await import('../server/thread-control/thread-succession.js');
const { createThreadRotationService } = await import('../server/thread-control/thread-rotation.js');
const { createSessionHandoffHelpers } = await import('../server/routes/session-handoff-helpers.js');
const { buildRotationStrategyResolver } = await import('../server/context-continuity/rotation-strategy-resolver.js');
const { runAdaptiveRotationHandoff, measureMessagesCharTotal } = await import('../server/context-continuity/adaptive-rotation.js');
const { applyContinuityToolPolicy, getContinuityToolPolicy } = await import('../server/context-continuity/feature-continuity.js');
const { getPrebuiltSessionFilePath } = await import('../server/shared/session-access.js');

const AGENT_ID = 'coder';
// 无 metadata.json 的假 agent 目录（绝对路径绕过 projectRoot 拼接）：
// resolveAgentModelLLM 在此确定性返回 null → 升级档真实解析失败注入。
const FAKE_AGENT_DIR = path.join(tmpRoot, 'fake-agent-dir');

// ── fixture：模拟 coder 真实工单上下文 ──────────────────────────────

/** tool-heavy：早期大文件调查（折叠面）+ 最近 5 次小修复（保护面）→ trim 档。 */
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

/** mixed：早期大工具结果（超出保护面的部分折叠）+ 主体长对话（全保留）→ 追加摘要档。 */
function buildMixedMessages() {
  const messages = [
    { role: 'system', content: '你是无人值守编码 agent，按工单重构模块。', turn: 0 },
    { role: 'user', content: '工单：重构认证模块并补写迁移文档。', turn: 1 },
  ];
  // 8 次调用：前 5 次大结果（超出 keepRecentToolCalls=5 保护面 → 折叠），
  // 后 3 次小结果（保护原样保留）。
  for (let i = 1; i <= 8; i += 1) {
    const big = i <= 5;
    messages.push({
      role: 'assistant', content: '', turn: 1,
      toolCalls: [{ id: `scan-${i}`, name: 'read', arguments: JSON.stringify({ filePath: `auth/legacy-${i}.js` }) }],
    });
    messages.push({
      role: 'tool', toolCallId: `scan-${i}`, turn: 1,
      content: big ? `// legacy ${i}\n` + 'function placeholder() {}\n'.repeat(90) : `ok-${i}`,
    });
  }
  for (let round = 1; round <= 10; round += 1) {
    messages.push({
      role: 'user', turn: round + 1,
      content: `第 ${round} 轮评审意见：` + '接口兼容性与回滚方案需要补充说明，重点关注凭证轮换与旧数据迁移路径。'.repeat(8),
    });
    messages.push({
      role: 'assistant', turn: round + 1,
      content: `第 ${round} 轮结论：` + '已按意见调整分层结构，authResolver 与凭证仓储解耦；回滚走 feature flag；迁移按双写窗口收敛。'.repeat(8),
    });
  }
  return messages;
}

/** mixed fixture 的试探比必须落在追加摘要档（fixture 漂移时先炸这里）。 */
async function assertMixedFixtureInMiddleBand(messages) {
  const { normalizeExportPolicy, buildTrimmedSeedMessages } = await import('@agentdevjs/core');
  const probePolicy = applyContinuityToolPolicy({ keepRecentToolCalls: 5 });
  const { seedMessages } = buildTrimmedSeedMessages(messages, normalizeExportPolicy(probePolicy));
  const ratio = measureMessagesCharTotal(seedMessages) / measureMessagesCharTotal(messages);
  assert.ok(ratio > 0.5 && ratio <= 0.8, `mixed fixture ratio ${ratio.toFixed(3)} out of the trim-summary band`);
  return ratio;
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
  return JSON.parse(await readFile(getPrebuiltSessionFilePath(AGENT_ID, sessionId), 'utf8'));
}

async function findThreadByHead(sessionId) {
  return control.core.findThreadByHeadSession(AGENT_ID, sessionId);
}

// ── 共享装配（真实链路 + 最小注入面）────────────────────────────────
let control;
let rotationService;
let submittedTurns;
let spawnCalls;
let stopCalls;
let summaryMarks;
let policyOverrides;
let sessionSeq;

before(async () => {
  submittedTurns = [];
  spawnCalls = [];
  stopCalls = [];
  summaryMarks = [];
  policyOverrides = {};
  sessionSeq = 0;

  // 真实框架桥：只有投递终点是注入的（模拟 viewer runtime 接收）。
  const bridge = new WorkThreadRuntimeBridge({
    enabled: true,
    resolveRuntimeViewerId: () => 'viewer-coder-live',
    submitTurn: async (params) => {
      submittedTurns.push(params);
      return { ok: true };
    },
  });
  control = createThreadControl({ rootDir: path.join(tmpRoot, 'threads'), bridge });
  const integration = createThreadIntegration({ control, publishThreadEvent: () => {} });
  const succession = createThreadSuccessionService({
    threadControl: control,
    threadIntegration: integration,
    stopManagedAgent: async (agentId, sessionId) => { stopCalls.push({ agentId, sessionId }); },
  });

  // 真实 sessionApi：helper 全链真实分派，仅 runtime spawn / 会话登记是注入面。
  const helpers = createSessionHandoffHelpers({
    startManagedAgent: async (agent, sessionId, opts) => {
      spawnCalls.push({ agentId: agent.id, sessionId, opts });
      return { status: 'ok' };
    },
    // READY 证据：返回 runtime 形状对象（buildChildRuntimeAgent 要求对象输入，
    // 布尔会折叠为 null → successorReady=false → READY 门禁拒绝提交）
    waitForManagedRuntimeReady: async (agentId, _timeout, sessionId) => ({ id: `viewer-${sessionId}`, connected: true, name: 'coder successor' }),
    resolvePrebuiltSessionOwner: async () => AGENT_ID,
    requirePrebuiltSessionRecord: async (agentId, sessionId) => ({ id: sessionId, title: 'E2E 工单' }),
    requirePrebuiltAgentForRuntime: async () => ({ id: AGENT_ID, relativeDir: FAKE_AGENT_DIR }),
    createPrebuiltSession: async (agentId, opts) => ({ id: `session-next-${sessionSeq += 1}`, sessionType: opts?.sessionType || '' }),
    readSessionSnapshotForContinuity: async (agentId, sessionId) => readSnapshotFile(sessionId),
    setSessionHasSummary: async (agentId, sessionId, v) => { summaryMarks.push({ agentId, sessionId, v }); },
  });

  const resolver = buildRotationStrategyResolver({
    readPolicies: async () => policyOverrides,
    readDeclaredAgents: async () => [{ id: AGENT_ID, permissionDefaults: { contextRotationStrategy: 'adaptive' } }],
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

// ── 场景 A：作者默认 adaptive + tool-heavy 上下文 → trim 档全链成功 ──
describe('scenario A: adaptive default rotates a tool-heavy thread end-to-end (trim tier)', () => {
  it('exports a real trim handoff, spawns the successor, advances the head and delivers the R3 instruction', async () => {
    const sessionId = 'session-e2e-a';
    await writeSessionSnapshot(sessionId, buildToolHeavyMessages());
    const thread = await control.core.start({ sessionRef: { agentId: AGENT_ID, sessionId }, title: '修复登录超时' });
    const spawnBase = spawnCalls.length;
    const stopBase = stopCalls.length;

    const result = await rotationService.handleContextGuard(AGENT_ID, sessionId);

    assert.equal(result.applied, true, `rotation should apply: ${JSON.stringify(result)}`);
    const nextSessionId = result.headSessionId;
    assert.ok(nextSessionId && nextSessionId !== sessionId);

    // 接续 spawn（ROTATION 豁免意图）+ handoff 环境变量指向真实落盘文件
    assert.equal(spawnCalls.length - spawnBase, 1);
    assert.equal(spawnCalls[spawnBase].opts.spawnIntent, 'rotation');
    const handoffPath = spawnCalls[spawnBase].opts.extraEnv.PROTOCLAW_HANDOFF_PATH;
    const handoff = JSON.parse(await readFile(handoffPath, 'utf8'));
    assert.equal(handoff.mode, 'trim-transcript');
    assert.equal(handoff.policy.keepRecentToolCalls, 5);
    // continuity 装饰真实进入落盘 policy（按名保护工具并集）
    for (const name of getContinuityToolPolicy().preserveToolNames) {
      assert.ok(handoff.policy.preserveToolNames.includes(name), `preserveToolNames should carry ${name}`);
    }
    // keepRecentToolCalls 保护面：最近 5 次调用原样保留，早期 5 次折叠
    const keptToolIds = handoff.seedMessages.filter((m) => m.role === 'tool').map((m) => m.toolCallId);
    assert.deepEqual([...keptToolIds].sort(), ['fix-1', 'fix-2', 'fix-3', 'fix-4', 'fix-5']);
    assert.ok(handoff.seedMessages.some((m) => m.tag === 'folded-tool-activity'));
    // trim notice 注入末尾（含旧会话 id）+ seedBoundary 账目
    const last = handoff.seedMessages[handoff.seedMessages.length - 1];
    assert.ok(last.content.includes(sessionId), 'trim notice should reference the source session id');
    assert.equal(handoff.seedBoundary.seedMessageCount, handoff.seedMessages.length);
    assert.deepEqual(handoff.seedBoundary.appendedInjection, [{ kind: 'trim-notice', messageIndex: handoff.seedMessages.length - 1 }]);

    // 线程状态机（真实落盘）：head 换代、旧 head 记 trim、挡板原子清除
    const record = await control.core.getThread(thread.threadId);
    assert.equal(record.headSessionId, nextSessionId);
    assert.equal(record.status, 'open');
    assert.equal(record.pendingSuccession, null);
    const predecessor = record.sessionChain.find((e) => e.sessionId === sessionId);
    assert.equal(predecessor.role, 'predecessor');
    assert.equal(predecessor.endKind, 'trim');

    // R3 恢复指令：播种 + 投递给新 head 的 viewer runtime
    const continuation = record.commands.find((c) => c.kind === 'system_continuation');
    assert.ok(continuation, 'R3 continuation instruction should be seeded with the barrier');
    assert.equal(continuation.status, 'delivered');
    assert.equal(submittedTurns.length, 1);
    assert.equal(submittedTurns[0].agentId, 'viewer-coder-live');
    assert.equal(submittedTurns[0].kind, 'system_continuation');
    assert.ok(submittedTurns[0].text.includes('审视当前任务状态'));

    // 成功路径零失败落卷；旧 runtime 恰好退役一次（pre-compact）
    assert.ok(!record.lifecycleEvents.some((e) => e.type === 'handoff_failed'));
    assert.equal(stopCalls.length - stopBase, 1);
    assert.deepEqual(summaryMarks.map((m) => m.v), [true]);
  });
});

// ── 场景 B：升级档真实解析失败 → rotation_failed + 挡板收敛 + 旧 head 保持 ──
describe('scenario B: escalation tier fails on missing model preset → rotation_failed', () => {
  it('converges the barrier, keeps the old head, leaves the R3 instruction pending', async () => {
    const sessionId = 'session-e2e-b';
    const messages = buildMixedMessages();
    await assertMixedFixtureInMiddleBand(messages); // fixture 保证真实落入 trim-summary 档
    await writeSessionSnapshot(sessionId, messages);
    await control.core.start({ sessionRef: { agentId: AGENT_ID, sessionId }, title: '重构认证模块' });
    const spawnBase = spawnCalls.length;

    const result = await rotationService.handleContextGuard(AGENT_ID, sessionId);

    // 升级档 LLM 失败即失败：不隐式降级（Q5=B）
    assert.equal(result.applied, false);
    assert.match(result.error, /No model preset resolved/);

    const record = await findThreadByHead(sessionId);
    assert.ok(record);
    // 失败落卷 + 显式挡板收敛（handoff_failed → rotation_failed；handoff_aborted 清挡板）
    assert.equal(record.status, 'rotation_failed');
    assert.equal(record.pendingSuccession, null);
    const aborted = record.lifecycleEvents.find((e) => e.type === 'handoff_aborted');
    assert.ok(aborted, 'barrier convergence should leave a handoff_aborted event');
    assert.equal(aborted.stage, 'compact_or_successor');
    assert.ok(record.lifecycleEvents.some((e) => e.type === 'handoff_failed'));
    // 旧 head 保持有效：head 未推进、无 successor spawn
    assert.equal(record.headSessionId, sessionId);
    assert.equal(spawnCalls.length - spawnBase, 0);
    // R3 恢复指令已播种但保持 pending（接力未成功，不投给旧 head）
    const continuation = record.commands.find((c) => c.kind === 'system_continuation');
    assert.ok(continuation);
    assert.equal(continuation.status, 'pending');
  });
});

// ── 场景 C：失败后自愈——下一次 guard 经用户覆盖 trim 成功接力 ──────────
describe('scenario C: thread recovers on the next guard after rotation_failed', () => {
  it('re-reads the strategy per rotation (override trim) and completes the succession idempotently', async () => {
    const sessionId = 'session-e2e-b'; // 场景 B 的同一线程 / 同一旧 head
    policyOverrides[AGENT_ID] = { contextRotationStrategy: 'trim' }; // 现读生效
    const spawnBase = spawnCalls.length;

    const result = await rotationService.handleContextGuard(AGENT_ID, sessionId);

    assert.equal(result.applied, true, `recovery rotation should apply: ${JSON.stringify(result)}`);

    // 接续 spawn 指向 trim 产物（用户覆盖压过作者默认的直接证据）
    assert.equal(spawnCalls.length - spawnBase, 1);
    const handoff = JSON.parse(await readFile(spawnCalls[spawnBase].opts.extraEnv.PROTOCLAW_HANDOFF_PATH, 'utf8'));
    assert.equal(handoff.mode, 'trim-transcript');
    assert.equal(handoff.policy.keepRecentToolCalls, 5);

    // 线程回到 open、head 换代；R3 播种幂等（同 threadId+fromSessionId 不重复）
    const record = await findThreadByHead(result.headSessionId);
    assert.equal(record.status, 'open');
    assert.equal(record.headSessionId, result.headSessionId);
    const continuations = record.commands.filter((c) => c.kind === 'system_continuation');
    assert.equal(continuations.length, 1);
    assert.equal(continuations[0].status, 'delivered');
  });
});

// ── 场景 D：trim-summary 档真实组合变换 + stub LLM（不出 API）─────────
describe('scenario D: adaptive trim-summary tier with an injected stub LLM', () => {
  const sessionId = 'session-e2e-d';

  it('runs the official combined transformation and writes the v1 handoff with the appended summary', async () => {
    const messages = buildMixedMessages();
    await assertMixedFixtureInMiddleBand(messages);
    const snapshot = await writeSessionSnapshot(sessionId, messages);
    const llmCalls = [];

    const result = await runAdaptiveRotationHandoff({
      userDataRoot: tmpRoot,
      agentId: AGENT_ID,
      sessionId,
      sessionPath: getPrebuiltSessionFilePath(AGENT_ID, sessionId),
      sourceRecord: { title: '重构认证模块' },
      sessionSnapshot: snapshot,
      agentRelativeDir: FAKE_AGENT_DIR,
      projectRoot: tmpRoot,
      policy: {},
      llm: {
        chat: async (msgs, tools, opts) => {
          llmCalls.push({ msgs, tools, opts });
          return { content: '【接续摘要】认证模块重构设计已完成，迁移文档写到一半，凭证轮换方案待验证。' };
        },
      },
    });

    assert.equal(result.adaptive.tier, 'trim-summary');
    assert.ok(result.adaptive.ratio > 0.5 && result.adaptive.ratio <= 0.8);
    // stub LLM 被官方变换真实消费：非流式、对话素材完整
    assert.equal(llmCalls.length, 1);
    assert.equal(llmCalls[0].opts.noStream, true);
    assert.ok(llmCalls[0].msgs.some((m) => m.role === 'user'));

    const handoff = JSON.parse(await readFile(result.handoffPath, 'utf8'));
    assert.equal(handoff.mode, 'trim-transcript-with-summary');
    assert.ok(handoff.appendedSummary.summaryText.includes('接续摘要'));
    // trimPolicy 保留保护面（框架 meta.trimPolicy 透传）
    assert.equal(handoff.policy.keepRecentToolCalls, 5);
    // 摘要种子追加末尾 + seedBoundary 注入账目
    const last = handoff.seedMessages[handoff.seedMessages.length - 1];
    assert.equal(last.role, 'system');
    assert.ok(last.content.includes('接续摘要'));
    assert.deepEqual(handoff.seedBoundary.appendedInjection, [{ kind: 'summary', messageIndex: handoff.seedMessages.length - 1 }]);
  });

  it('surfaces escalation LLM failure without silent downgrade (maxAttempts retries then throws)', async () => {
    // 自建快照（不依赖上一用例的落盘），失败注入独立可跑
    const messages = buildMixedMessages();
    await assertMixedFixtureInMiddleBand(messages);
    const snapshot = await writeSessionSnapshot(sessionId, messages);
    const llmCalls = [];

    await assert.rejects(
      runAdaptiveRotationHandoff({
        userDataRoot: tmpRoot,
        agentId: AGENT_ID,
        sessionId,
        sessionPath: getPrebuiltSessionFilePath(AGENT_ID, sessionId),
        sourceRecord: { title: '重构认证模块' },
        sessionSnapshot: snapshot,
        agentRelativeDir: FAKE_AGENT_DIR,
        projectRoot: tmpRoot,
        policy: {},
        llm: {
          chat: async () => {
            llmCalls.push(1);
            throw new Error('model overloaded');
          },
        },
      }),
      /model overloaded/,
    );
    // 真实重试语义：默认 maxAttempts=3 全部消耗后如实抛出
    assert.equal(llmCalls.length, 3);
  });
});

// ── 场景 E：策略解析判定链（真实 resolver，注入读函数）────────────────
describe('scenario E: rotation strategy resolver chain', () => {
  const build = (policies, declared) => buildRotationStrategyResolver({
    readPolicies: async () => policies,
    readDeclaredAgents: async () => declared,
  });
  const declared = [{ id: 'coder', permissionDefaults: { contextRotationStrategy: 'adaptive' } }];

  it('user override beats the author default', async () => {
    const resolve = build({ coder: { contextRotationStrategy: 'trim' } }, declared);
    assert.equal(await resolve('coder'), 'trim');
  });

  it('falls back to the author default when no override is set', async () => {
    const resolve = build({}, declared);
    assert.equal(await resolve('coder'), 'adaptive');
  });

  it('returns null (combined semantics) when neither side declares it', async () => {
    const resolve = build({}, [{ id: 'memo' }]);
    assert.equal(await resolve('memo'), null);
  });

  it('treats blank overrides as unset and falls through to the author default', async () => {
    const resolve = build({ coder: { contextRotationStrategy: '' } }, declared);
    assert.equal(await resolve('coder'), 'adaptive');
  });

  it('falls back to the author default when the override read fails', async () => {
    const resolve = buildRotationStrategyResolver({
      readPolicies: async () => { throw new Error('workspace settings unreadable'); },
      readDeclaredAgents: async () => declared,
    });
    assert.equal(await resolve('coder'), 'adaptive');
  });
});
