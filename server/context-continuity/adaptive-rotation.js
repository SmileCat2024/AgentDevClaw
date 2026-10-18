/**
 * Adaptive Rotation — 自适应上下文接续策略的定档与编排（Claw 产品层验证）
 *
 * 一次性阶梯（设计定案 2026-10-18）：
 *   1. 进程内先按「trim + keepRecentToolCalls」跑一遍框架引擎（纯函数、
 *      零 LLM 成本）得到试探 seed；
 *   2. 字符比 = 试探 seed 消息字符总量 ÷ 原始消息字符总量（对称口径：
 *      content 字符 + toolCalls JSON 字符，无分词器依赖）：
 *        ratio ≤ 0.5        → trim 档（history-only handoff）
 *        0.5 < ratio ≤ 0.8  → trim+追加摘要档（框架官方组合变换）
 *        ratio > 0.8        → 纯摘要档（summarized-nine-section，试探 seed 弃用）
 *   3. 摘要追加后不复测：摘要自身体积不参与判定，避免自我指涉的档位抖动。
 *
 * 失败语义与既有组合路径一致（设计定案 Q5=B）：升级档的摘要 LLM 失败直接
 * 抛错 → 接力失败 → rotation_failed，不引入隐式降级。
 *
 * 分层（设计定案 Q1=B）：定档与编排在产品层验证，验证后视结果下沉框架
 * 官方变换；引擎原语（keepRecentToolCalls）在框架侧，三条 handoff 产物
 * 路径全部复用既有实现，本模块不重写任何变换语义。
 */

import {
  normalizeExportPolicy,
  buildTrimmedSeedMessages,
} from '@agentdevjs/core';
import {
  exportHistoryOnlyHandoffPackage,
  writeTrimWithSummaryHandoffPackage,
} from './handoff-package.js';
import { exportSummarizedHandoffPackage } from './summarized-handoff.js';
import { runTrimTranscriptWithSummary } from './trim-appended-summary.js';
import { applyContinuityToolPolicy } from './feature-continuity.js';

/** coder 接续 trim 系策略的引擎保护面：保最近 N 次工具调用（设计定案 Q2=B）。 */
export const ROTATION_KEEP_RECENT_TOOL_CALLS = 5;

/** 自适应阶梯参数（常量，不进配置页；试验反馈后再议参数化）。 */
export const ADAPTIVE_DEFAULTS = Object.freeze({
  keepRecentToolCalls: ROTATION_KEEP_RECENT_TOOL_CALLS,
  appendSummaryRatio: 0.5,
  pureSummaryRatio: 0.8,
});

/** 单条消息字符计量（对称口径）：content 字符 + toolCalls JSON 字符。 */
function messageCharCount(message) {
  if (!message || typeof message !== 'object') return 0;
  const content = typeof message.content === 'string' ? message.content.length : 0;
  const toolCalls = Array.isArray(message.toolCalls) ? message.toolCalls : [];
  let callChars = 0;
  for (const call of toolCalls) {
    try {
      callChars += JSON.stringify(call ?? {}).length;
    } catch {
      callChars += String(call ?? '').length;
    }
  }
  return content + callChars;
}

/** 消息数组字符总量（原始消息与 seed 消息用同一计量器，比例口径对称）。 */
export function measureMessagesCharTotal(messages) {
  if (!Array.isArray(messages)) return 0;
  return messages.reduce((total, message) => total + messageCharCount(message), 0);
}

/**
 * 一次性阶梯定档（纯函数）。
 * 边界：≤ appendSummaryRatio 归 trim 档；append < ratio ≤ pure 归追加摘要档；
 * > pureSummaryRatio 归纯摘要档（严格不等号，边界值归低档）。
 */
export function decideAdaptiveTier(ratio, {
  appendSummaryRatio = ADAPTIVE_DEFAULTS.appendSummaryRatio,
  pureSummaryRatio = ADAPTIVE_DEFAULTS.pureSummaryRatio,
} = {}) {
  const value = Number.isFinite(ratio) ? Math.max(0, ratio) : 0;
  if (value > pureSummaryRatio) return { tier: 'summary', ratio: value };
  if (value > appendSummaryRatio) return { tier: 'trim-summary', ratio: value };
  return { tier: 'trim', ratio: value };
}

/**
 * 运行自适应接续：试探 trim → 定档 → 三分派。
 *
 * 三档全部复用既有产物路径（本模块不落盘、不改写产物 schema）：
 *   trim          → exportHistoryOnlyHandoffPackage（内部重跑同策略 trim，确定性同结果）
 *   trim-summary  → runTrimTranscriptWithSummary + writeTrimWithSummaryHandoffPackage
 *   summary       → exportSummarizedHandoffPackage
 *
 * @param {object} params
 * @param {object} params.sessionSnapshot 源会话快照（runtime.context.messages）
 * @param {object} [params.options] 阶梯参数覆盖（测试缝）
 * @param {object} [params.executors] 三档执行器注入（测试缝；缺省绑定真实路径）
 * @returns {Promise<{ handoff: object, handoffPath: string, adaptive: { tier: string, ratio: number } }>}
 */
export async function runAdaptiveRotationHandoff(params) {
  const {
    userDataRoot,
    agentId,
    sessionId,
    sessionPath,
    sourceRecord = {},
    sessionSnapshot,
    agentRelativeDir,
    projectRoot,
    policy: rawPolicy = {},
    signal = null,
    timeoutMs,
    options = {},
    executors = {},
  } = params;
  const exportHistoryOnly = executors.exportHistoryOnly || exportHistoryOnlyHandoffPackage;
  const runTrimWithSummary = executors.runTrimWithSummary || runTrimTranscriptWithSummary;
  const writeTrimWithSummary = executors.writeTrimWithSummary || writeTrimWithSummaryHandoffPackage;
  const exportSummarized = executors.exportSummarized || exportSummarizedHandoffPackage;

  const keepRecentToolCalls = Number.isInteger(options.keepRecentToolCalls) && options.keepRecentToolCalls > 0
    ? options.keepRecentToolCalls
    : ADAPTIVE_DEFAULTS.keepRecentToolCalls;
  const rawMessages = Array.isArray(sessionSnapshot?.runtime?.context?.messages)
    ? sessionSnapshot.runtime.context.messages
    : [];

  // 试探 trim 与 trim / 追加摘要两档的产物策略完全同面（含 continuity 装饰），
  // 定档与落盘出自同一策略，避免「测一套、写一套」的分叉。
  const probePolicy = applyContinuityToolPolicy({ ...rawPolicy, keepRecentToolCalls });
  const { seedMessages } = buildTrimmedSeedMessages(rawMessages, normalizeExportPolicy(probePolicy));
  const originalTotal = measureMessagesCharTotal(rawMessages);
  const trimmedTotal = measureMessagesCharTotal(seedMessages);
  const ratio = originalTotal > 0 ? trimmedTotal / originalTotal : 0;
  const { tier } = decideAdaptiveTier(ratio, options);
  console.log(`[adaptive_rotation] agent=${agentId} session=${sessionId} tier=${tier} chars ${trimmedTotal}/${originalTotal} ratio=${(ratio * 100).toFixed(1)}%`);

  if (tier === 'trim') {
    const result = await exportHistoryOnly({
      userDataRoot, agentId, sessionId, sessionPath, sourceRecord, policy: probePolicy,
    });
    return { ...result, adaptive: { tier, ratio } };
  }
  if (tier === 'trim-summary') {
    const seed = await runTrimWithSummary({
      agentRelativeDir,
      agentId,
      sessionId,
      projectRoot,
      sourceSessionSnapshot: sessionSnapshot,
      policy: probePolicy,
      signal,
      timeoutMs,
    });
    const result = await writeTrimWithSummary({
      userDataRoot, agentId, sessionId, sessionPath, sourceRecord, sessionSnapshot, seed,
    });
    return { ...result, adaptive: { tier, ratio } };
  }
  const result = await exportSummarized({
    userDataRoot,
    agentId,
    sessionId,
    sourceRecord,
    policy: rawPolicy,
    agentRelativeDir,
    projectRoot,
    sourceSessionSnapshot: sessionSnapshot,
    signal,
    timeoutMs,
  });
  return { ...result, adaptive: { tier, ratio } };
}
