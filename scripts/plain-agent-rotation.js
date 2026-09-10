/**
 * Plain agent 进程内上下文自接力 — thread-rotation 的单进程镜像
 *
 * workspace coder 的过界接力由 server 侧 thread-rotation 执行（handoff 包
 * 落盘 + successor runtime 启动 + head 推进 + 指令补投）；plain agent 是
 * CLI 单进程 runtime，同一套语义在进程内收敛：
 *
 *   1. context-rotation-trigger 过界打断当前轮（onTrip 回调）；
 *   2. saveSession 落盘源会话 → 读取快照；
 *   3. 框架权威组合变换 TrimTranscriptWithSummaryTransformation 产出
 *      SuccessorSeed（Claw 装配层 runTrimTranscriptWithSummary：快照 +
 *      continuity 装饰 + 模型预设注入，与 compact / summary 共享实现）；
 *   4. 组装 HandoffSeedPayload（不落 handoff 包文件——进程内接力没有
 *      跨进程传输需求，seed 直接交给新 agent 实例）；
 *   5. 退役旧 agent，构建 successor（新 LLM 实例 + 底座 + metadata
 *      features + HandoffSeedFeature + importFeatureContinuity），
 *      以框架 R3 恢复指令语义续跑原目标。
 *
 * 每轮接力 = 全新 agent 实例 + 全新模型实例，context-rotation-trigger 的
 * 一次性熔丝随实例重建（与 thread 接力的 successor 换代同一语义）。
 * 接力链路记录在 session index（parentSessionId / resumeMode），最终结果
 * 报告 head session。
 */

import { runTrimTranscriptWithSummary } from '../server/context-continuity/trim-appended-summary.js';
import { buildTrimWithSummarySeedFields } from '../server/context-continuity/handoff-package.js';
import { applyContinuityToolPolicy, exportFeatureContinuity } from '../server/context-continuity/feature-continuity.js';

/**
 * 恢复指令。措辞逐字对齐框架 WorkThread 的 R3 官方默认
 * （core/workthread/core.ts DEFAULT_SUCCESSION_INSTRUCTION——dist 未在
 * core 公共入口 re-export，无法 import，故此处按源同步，措辞改动须两处
 * 同步）；plain 场景额外附带原目标，因为 plain 接力没有线程 Inbox 的
 * 指令暂存面，原目标需要显式随行。
 */
function composeSuccessionInstruction(initialGoal) {
  // R3 段落逐字对齐框架（core/workthread/core.ts join('') 连接）；plain
  // 场景无指令 Inbox，原目标以独立段落显式随行。
  const instruction = [
    '上下文已精简接力。先检查当前工作树、已有变更、测试结果和上一棒摘要，',
    '确认哪些步骤已经完成；不要重复可能已有副作用的操作，然后继续当前任务。',
    '需要人工决策或无法安全判断时，明确说明原因。',
  ].join('');
  return initialGoal ? `${instruction}\n\n本次运行的原始任务：${initialGoal}` : instruction;
}

function newPlainSessionId() {
  return `plain-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export { newPlainSessionId };

function failureResult({ sessionId, initialSessionId, successions, outcome, error, status }) {
  // initialSessionId 由调用点显式传入（所有失败收敛路径都必须携带，
  // 与成功返回的契约一致）。
  return {
    ok: false,
    status: status || 'failed',
    response: outcome?.response || null,
    sessionId,
    initialSessionId,
    successions,
    error,
    callOutcome: outcome,
  };
}

/**
 * 进程内执行一次带上下文自接力的 agent 调用。
 *
 * @param {object} params
 * @param {string} params.initialGoal - 原始目标（--goal）
 * @param {string} params.initialSessionId
 * @param {import('@agentdevjs/core').FileSessionStore} params.sessionStore
 * @param {object} params.trimSource - 组合变换的模型解析定位（server 装配层入参）
 * @param {string} params.trimSource.agentRelativeDir - agent 目录（绝对路径可直传）
 * @param {string} params.trimSource.projectRoot
 * @param {string} params.trimSource.agentId
 * @param {(opts: { sessionId: string, handoff: object|null, onContextTrip: () => void }) => Promise<object>} params.buildAgent
 *   每轮构造全新 agent 实例（新 LLM 实例 + 底座 + metadata features）；
 *   handoff 非空时负责挂载 HandoffSeedFeature 与 continuity 导入。
 * @param {Function} [params.runTrim=runTrimTranscriptWithSummary]
 *   组合变换装配层（默认权威实现）；测试注入桩。
 * @param {(record: object) => void} [params.upsertIndex]
 *   session index 更新钩子（successor 会话的接力链路落 index.json）
 * @param {number} [params.maxSuccessions=8]
 * @param {(...args: any[]) => void} [params.log] - stderr 过程日志
 * @returns {Promise<{ ok: boolean, status: string, response: (string|null), sessionId: string,
 *   initialSessionId: string, successions: number, error: (string|null), callOutcome: object|null }>}
 */
export async function executePlainCallWithRotation({
  initialGoal,
  initialSessionId,
  sessionStore,
  trimSource,
  buildAgent,
  runTrim = runTrimTranscriptWithSummary,
  upsertIndex = null,
  maxSuccessions = 8,
  log = () => {},
}) {
  let sessionId = initialSessionId;
  let prompt = initialGoal;
  let handoff = null;
  let successions = 0;
  let persistedHead = initialSessionId; // 最后一个已落盘的会话（失败收敛用它报告，不指向未落盘的 successor）
  let saveError = null; // 最后一轮 saveSession 失败事实（result 携带，接力将基于磁盘旧快照）
  let outcome = null;
  let callError = null;

  while (true) {
    let tripped = false;
    let currentAgent;
    try {
      currentAgent = await buildAgent({
        sessionId,
        handoff,
        onContextTrip: () => { tripped = true; },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return failureResult({ sessionId: persistedHead, initialSessionId, successions, outcome, error: `agent build failed: ${message}`, status: 'failed' });
    }

    // successor 构建成功：接力计数与 index 登记都在此刻成立（trim 成功
    // 不先入索引——build 失败不会留下指向不存在会话文件的孤儿记录）。
    if (handoff) {
      successions += 1;
      await upsertIndex?.({
        id: sessionId,
        goal: initialGoal,
        sessionType: 'plain',
        source: 'cli',
        resumeMode: 'auto-rotation',
        parentSessionId: handoff?.sourceSessionId || persistedHead,
        rotationRound: successions,
      });
    }
    outcome = null;
    callError = null;
    try {
      // onCallDetailed 是框架标准（CallOutcome 终态元数据）；非 BasicAgent
      // 子类的兼容实现只有 onCall（response-only），按 completed 归一。
      if (typeof currentAgent.onCallDetailed === 'function') {
        outcome = await currentAgent.onCallDetailed(prompt);
      } else {
        outcome = { status: 'completed', response: await currentAgent.onCall(prompt) };
      }
    } catch (err) {
      callError = err instanceof Error ? err.message : String(err);
      log(`[PlainRotation] onCall 异常: ${callError}`);
    }

    try {
      await currentAgent.saveSession(sessionId, sessionStore);
      persistedHead = sessionId;
      saveError = null;
    } catch (err) {
      // 接力仍会进行，但基于磁盘上的旧快照——最新一轮内容缺席 successor
      // seed（不可逆），事实随 result 携带（saveError），不只留日志。
      saveError = err instanceof Error ? err.message : String(err);
      log(`[PlainRotation] saveSession 失败（snapshot 可能落后于最新一轮）: ${saveError}`);
    }

    // 正常完成（或不可接力场景）即收敛；过界打断才进入接力。
    // 两个竞态分支一并说明：
    //   - completed 竞态：过界观测在响应返回之后，最后一轮刚好完成且过线
    //     → 按 completed 收敛，目标已达成不轮换；
    //   - callError 与过界同轮：打断本身引起异常是主路径（guard interrupt），
    //     语义按 tripped 优先——异常事实随 callError 停留在 stderr/日志。
    if (!tripped || (outcome?.status === 'completed' && !callError)) {
      return {
        ok: !callError && outcome?.status === 'completed',
        status: callError ? 'failed' : (outcome?.status || 'completed'),
        response: outcome?.response || null,
        sessionId,
        initialSessionId,
        successions,
        error: callError,
        callOutcome: outcome,
        ...(saveError ? { saveError } : {}),
      };
    }

    // ── 过界 → 进程内接力 ──────────────────────────────────────────
    if (successions >= maxSuccessions) {
      return failureResult({
        sessionId,
        initialSessionId,
        successions,
        outcome,
        error: `context rotation limit reached (${maxSuccessions} successions)`,
      });
    }

    let snapshot = null;
    try {
      snapshot = await sessionStore.load(sessionId);
    } catch (err) {
      return failureResult({
        sessionId,
        initialSessionId,
        successions,
        outcome,
        error: `rotation aborted: source session snapshot unavailable (${err?.message || err})`,
      });
    }

    const messages = snapshot?.runtime?.context?.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      return failureResult({
        sessionId,
        initialSessionId,
        successions,
        outcome,
        error: 'rotation aborted: source session has no messages to trim',
        status: outcome?.status || 'failed',
      });
    }

    let seed = null;
    try {
      seed = await runTrim({
        agentRelativeDir: trimSource.agentRelativeDir,
        projectRoot: trimSource.projectRoot,
        agentId: trimSource.agentId,
        sessionId,
        sourceSessionSnapshot: snapshot,
        // 摘要 LLM 由 runner 以工厂注入（每轮新实例，OAuth 凭证不冻结在
        // 启动时刻）；缺省时 runTrim 落回 agentDir 预设解析。continuity
        // 工具装饰与工作区 compact 路径同参（runTrim docstring 的调用方契约）。
        ...(typeof trimSource.llm === 'function' ? { llm: trimSource.llm() } : {}),
        policy: applyContinuityToolPolicy({}),
      });
    } catch (err) {
      return failureResult({
        sessionId,
        initialSessionId,
        successions,
        outcome,
        error: `context rotation failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    const successorId = newPlainSessionId();
    // SuccessorSeed → HandoffSeedPayload 字段提取与 server 落盘写侧
    // （writeTrimWithSummaryHandoffPackage）共用同一构建器：框架 payload
    // 增字段只改一处回退链，不再平行手拼。
    const seedFields = buildTrimWithSummarySeedFields(seed);
    handoff = {
      packageId: `plain-handoff-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      sourceSessionId: sessionId,
      mode: 'trim-transcript-with-summary',
      sourceSummary: seedFields.summaryText,
      seedMessages: seedFields.seedMessages,
      importantFiles: seedFields.importantFiles,
      importantSkills: seedFields.importantSkills,
      fileRanges: seedFields.fileRanges,
      featureContinuity: exportFeatureContinuity(snapshot, { mode: 'trim-transcript' }),
    };

    log(`[PlainRotation] context tripped — rotating round ${successions + 1}: ${sessionId} -> ${successorId} (seed=${seedFields.seedMessages?.length ?? 0} messages)`);

    try { await currentAgent.dispose(); } catch { /* 旧实例释放失败不阻断接力 */ }

    sessionId = successorId;
    prompt = composeSuccessionInstruction(initialGoal);
  }
}
