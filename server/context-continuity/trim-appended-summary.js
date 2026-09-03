/**
 * Trim-Appended Summary — 框架官方组合变换的 Claw 装配层
 *
 * 「trim 裁剪 + 摘要追加到 seed 尾部」组合语义的唯一权威实现是框架
 * TrimTranscriptWithSummaryTransformation（ticket 006 自 Claw 1:1 上移，
 * golden 对照验收）。本模块只做 Claw 侧装配：会话快照读取、模型预设
 * 解析（system 角色，与 runInProcessSummary 同源）、TransformContext.llm
 * 注入、重试与超时。不再在 Claw 侧手工拼接 seedMessages。
 *
 * 组合变换内部的摘要提示词为框架 buildSummaryPrompt({ trimAppended: true })
 * （与旧 Claw trim-appended 提示词逐字一致），模型装配约定不变。
 */

import { TrimTranscriptWithSummaryTransformation } from '@agentdevjs/core';
import { SESSION_TRANSFORMATION_TIMEOUT_MS } from '../shared/constants.js';
import {
  loadSessionSnapshot,
  extractSummaryMessages,
  resolveSummaryLLM,
} from './inprocess-summary.js';

/**
 * 运行框架 trim-transcript-with-summary 组合变换。
 *
 * @param {object} params
 * @param {string} params.agentRelativeDir - 预制 agent 的相对目录路径
 * @param {string} params.agentId
 * @param {string} params.sessionId - 源会话 ID
 * @param {string} params.projectRoot - 项目根目录
 * @param {object|null} [params.sourceSessionSnapshot] - 会话快照；未提供时由装配器读取
 * @param {object} [params.policy] - trim 策略面（调用方负责 continuity 装饰，如 applyContinuityToolPolicy）
 * @param {object|null} [params.llm] - 显式注入的 LLM 基座；缺省走模型预设解析（system 角色）
 * @param {number} [params.maxAttempts=3] - 变换失败时的重试次数
 * @param {number} [params.timeoutMs=SESSION_TRANSFORMATION_TIMEOUT_MS] - 单次 attempt 的超时；超时只中止当前 attempt（对标 react-loop 每步 LLM 调用各自持有完整 deadline），重试预算不被已失败的 attempt 侵占
 * @returns {Promise<import('@agentdevjs/core').SuccessorSeed>}
 */
export async function runTrimTranscriptWithSummary({
  agentRelativeDir,
  projectRoot,
  agentId,
  sessionId,
  sourceSessionSnapshot = null,
  policy = {},
  llm = null,
  maxAttempts = 3,
  timeoutMs = SESSION_TRANSFORMATION_TIMEOUT_MS,
  signal = null,
}) {
  const snapshot = sourceSessionSnapshot || await loadSessionSnapshot(agentId, sessionId);
  if (!snapshot) {
    throw new Error(`Session snapshot not found for trim-with-summary: agent=${agentId} session=${sessionId}`);
  }
  extractSummaryMessages(snapshot, agentId, sessionId);

  const resolvedLLM = llm || resolveSummaryLLM({
    agentRelativeDir,
    projectRoot,
    agentId,
    sessionId,
  }).llm;

  const transformation = new TrimTranscriptWithSummaryTransformation();
  const attempts = Number.isFinite(maxAttempts) ? Math.max(1, Math.min(5, Number(maxAttempts))) : 3;

  console.log(`[trim_with_summary] begin agent=${agentId} session=${sessionId}`);

  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(signal?.reason);
  if (signal?.aborted) {
    abortFromCaller();
  } else if (signal) {
    signal.addEventListener('abort', abortFromCaller, { once: true });
  }

  try {
    let lastFailure = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (controller.signal.aborted) {
        throw controller.signal.reason || new DOMException('Aborted', 'AbortError');
      }
      // 每次 attempt 独立 deadline：超时只中止当前 attempt 的底层 LLM 调用，
      // 不剥夺后续 attempt 的预算。整体时长上限 = attempts × timeoutMs +
      // 本地 trim 开销；caller 级 signal 仍然立即中止全部 attempt。
      const attemptSignal = new AbortController();
      const abortAttemptFromCaller = () => attemptSignal.abort(controller.signal.reason);
      controller.signal.addEventListener('abort', abortAttemptFromCaller, { once: true });
      const timer = Number.isFinite(timeoutMs) && timeoutMs > 0
        ? setTimeout(() => {
          attemptSignal.abort(new Error(`Trim-with-summary attempt ${attempt}/${attempts} timed out after ${timeoutMs}ms`));
        }, timeoutMs)
        : null;
      try {
        const seed = await transformation.transform(
          { sourceSnapshot: snapshot, policy },
          { llm: resolvedLLM, signal: attemptSignal.signal },
        );
        console.log(`[trim_with_summary] done agent=${agentId} session=${sessionId} attempt=${attempt}`);
        return seed;
      } catch (error) {
        // caller 级中止（归档/会话删除等）直接传播；attempt 自身超时
        // 属于本次尝试失败，进入重试。
        if (controller.signal.aborted) throw error;
        lastFailure = error;
        console.warn(`[trim_with_summary] attempt ${attempt}/${attempts} failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        if (timer) clearTimeout(timer);
        controller.signal.removeEventListener('abort', abortAttemptFromCaller);
      }
    }
    throw lastFailure instanceof Error ? lastFailure : new Error(String(lastFailure || 'Unknown trim-with-summary failure'));
  } finally {
    signal?.removeEventListener('abort', abortFromCaller);
  }
}
