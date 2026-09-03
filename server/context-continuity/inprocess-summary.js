/**
 * 进程内摘要生成 — agentdev 官方 summary 实现的 Claw 装配层（ticket 008）。
 *
 * 框架 `generateSummaryText({llm}, snapshot, prompt)` 是摘要生成的唯一官方
 * 实现（空工具集、非流式、stripCompactAnalysis 清洗）。本模块只做 Claw 侧
 * 装配：模型预设解析（system 角色）、LLM 调优（关 thinking、限 maxTokens）、
 * 提示词选择、重试与超时。替代已删除的 run-compact-mirror 子进程管线。
 *
 * 已知接受的官方语义差异（相对旧 mirror 管线）：
 * - importantFiles/importantSkills/fileRanges 来自确定性扫描
 *   （scanFilesAndSkills），不再依赖 LLM 的 record_compaction_context 工具调用
 * - rawResponse 不再单独留存（官方实现只返回清洗后的摘要文本）
 * - LLM 输入只含 system/user/assistant 消息（官方 buildChatMessages 过滤）
 */

import path from 'path';
import { promises as fs } from 'fs';
import {
  buildSummaryPrompt,
  generateSummaryText,
  scanFilesAndSkills,
} from '@agentdevjs/core';
import { resolveAgentModelLLM } from '../model-preset-resolver.js';
import { tuneMirrorLLM } from '../shared/llm-tuning.js';
import { getPrebuiltSessionFilePath } from '../shared/session-access.js';
import { SESSION_TRANSFORMATION_TIMEOUT_MS } from '../shared/constants.js';

const SUMMARY_MAX_TOKENS = 16000;

export function buildSummaryPromptForSession({ trimAppended, additionalInstructions }) {
  return buildSummaryPrompt({
    additionalInstructions,
    ...(trimAppended ? { trimAppended: true } : {}),
  });
}

export async function loadSessionSnapshot(agentId, sessionId) {
  try {
    const raw = await fs.readFile(getPrebuiltSessionFilePath(agentId, sessionId), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * 读取会话快照的消息列表；空快照直接抛错（摘要/组合变换都要求非空输入）。
 */
export function extractSummaryMessages(snapshot, agentId, sessionId) {
  const messages = Array.isArray(snapshot?.runtime?.context?.messages)
    ? snapshot.runtime.context.messages
    : [];
  if (messages.length === 0) {
    throw new Error(`Session snapshot has no messages for in-process summary: agent=${agentId} session=${sessionId}`);
  }
  return messages;
}

/**
 * 装配摘要类调用的 TransformContext.llm：模型预设解析 + mirror 调优。
 * runInProcessSummary 与框架组合变换装配器（trim-appended-summary.js）共用，
 * 保证两条链路的模型角色与调优参数一致。
 *
 * @returns {{ llm: object, modelName: string }}
 */
export function resolveSummaryLLM({
  agentRelativeDir,
  projectRoot,
  agentId,
  sessionId,
}) {
  const agentDir = path.resolve(String(projectRoot || '').trim(), agentRelativeDir);
  const modelPresetRole = 'system';
  const resolvedModel = resolveAgentModelLLM(agentDir, modelPresetRole);
  if (!resolvedModel) {
    throw new Error(`No model preset resolved for in-process summary (agentDir=${agentRelativeDir}, role=${modelPresetRole}) — configure model presets for this agent`);
  }
  console.log(`[inprocess_summary] using model preset role=${modelPresetRole} model=${resolvedModel.modelName} agent=${agentId} session=${sessionId}`);
  tuneMirrorLLM(resolvedModel.llm, SUMMARY_MAX_TOKENS, { forceMaxTokens: true, protocol: resolvedModel.protocol });
  return { llm: resolvedModel.llm, modelName: resolvedModel.modelName };
}

/**
 * 进程内生成会话摘要。
 *
 * @param {object} params
 * @param {string} params.agentRelativeDir - 预制 agent 相对项目根的目录（含 metadata.json）
 * @param {string} params.projectRoot - 项目根目录
 * @param {string} params.agentId
 * @param {string} params.sessionId
 * @param {object|null} [params.sourceSessionSnapshot] - 会话快照；未提供时从会话文件读取
 * @param {boolean} [params.trimAppended] - true 时用 trim-appended 提示词
 * @param {number} [params.maxAttempts=3] - 空摘要/调用失败时的重试次数
 * @param {string} [params.additionalInstructions]
 * @param {number} [params.timeoutMs=SESSION_TRANSFORMATION_TIMEOUT_MS] - 单次 attempt 的超时；超时只中止当前 attempt（对标 react-loop 每步 LLM 调用各自持有完整 deadline），重试预算不被已失败的 attempt 侵占
 * @returns {Promise<{summaryText: string, attemptCount: number, importantFiles: string[], importantSkills: string[], fileRanges: Object}>}
 */
export async function runInProcessSummary({
  agentRelativeDir,
  projectRoot,
  agentId,
  sessionId,
  sourceSessionSnapshot = null,
  trimAppended = false,
  maxAttempts = 3,
  additionalInstructions = '',
  timeoutMs = SESSION_TRANSFORMATION_TIMEOUT_MS,
  signal = null,
}) {
  const snapshot = sourceSessionSnapshot || await loadSessionSnapshot(agentId, sessionId);
  if (!snapshot) {
    throw new Error(`Session snapshot not found for in-process summary: agent=${agentId} session=${sessionId}`);
  }
  const messages = extractSummaryMessages(snapshot, agentId, sessionId);

  const { llm } = resolveSummaryLLM({
    agentRelativeDir,
    projectRoot,
    agentId,
    sessionId,
  });

  const prompt = buildSummaryPromptForSession({ trimAppended, additionalInstructions });
  const attempts = Number.isFinite(maxAttempts) ? Math.max(1, Math.min(5, Number(maxAttempts))) : 3;

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
      // 每次 attempt 独立 deadline（对标 react-loop 每步 LLM 调用各自持有完整
      // deadline）：超时只中止当前 attempt 的底层 LLM 调用，不剥夺后续
      // attempt 的预算；caller 级 signal 仍然立即中止全部 attempt。
      const attemptSignal = new AbortController();
      const abortAttemptFromCaller = () => attemptSignal.abort(controller.signal.reason);
      controller.signal.addEventListener('abort', abortAttemptFromCaller, { once: true });
      const timer = Number.isFinite(timeoutMs) && timeoutMs > 0
        ? setTimeout(() => {
          attemptSignal.abort(new Error(`In-process summary attempt ${attempt}/${attempts} timed out after ${timeoutMs}ms`));
        }, timeoutMs)
        : null;
      try {
        const summaryText = await generateSummaryText({ llm, signal: attemptSignal.signal }, snapshot, prompt);
        const scanned = scanFilesAndSkills(messages);
        return {
          summaryText,
          attemptCount: attempt,
          importantFiles: scanned.files,
          importantSkills: scanned.skills,
          fileRanges: scanned.fileRanges,
        };
      } catch (error) {
        // caller 级中止直接传播；attempt 自身超时属于本次尝试失败，进入重试。
        if (controller.signal.aborted) throw error;
        lastFailure = error;
        console.warn(`[inprocess_summary] attempt ${attempt}/${attempts} failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        if (timer) clearTimeout(timer);
        controller.signal.removeEventListener('abort', abortAttemptFromCaller);
      }
    }
    throw lastFailure instanceof Error ? lastFailure : new Error(String(lastFailure || 'Unknown in-process summary failure'));
  } finally {
    signal?.removeEventListener('abort', abortFromCaller);
  }
}
