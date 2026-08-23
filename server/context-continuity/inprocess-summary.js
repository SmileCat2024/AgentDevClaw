/**
 * 进程内摘要生成 — agentdev 官方 summary 实现的 Claw 装配层（ticket 008）。
 *
 * 框架 `generateSummaryText({llm}, snapshot, prompt)` 是摘要生成的唯一官方
 * 实现（空工具集、非流式、stripCompactAnalysis 清洗）。本模块只做 Claw 侧
 * 装配：模型预设解析（system/exploration/sub 角色，复用 run-compact-mirror
 * 的装配约定）、LLM 调优（关 thinking、限 maxTokens）、提示词选择、重试与
 * 超时。替代已删除的 run-compact-mirror 子进程管线。
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
} from '@agentdev/core';
import { resolveAgentModelLLM } from '../model-preset-resolver.js';
import { tuneMirrorLLM } from '../shared/llm-tuning.js';
import { getPrebuiltSessionFilePath } from '../shared/session-access.js';

const SUMMARY_MAX_TOKENS = 16000;

// exploration 三段式提示词为 Claw 本地变体：框架 buildSummaryPrompt 声明了
// exploration 选项但尚未实现（AgentDev 006 未覆盖该分支）。行为等价要求
// 保留这段提示词，待框架补齐后改回 buildSummaryPrompt({ exploration: true })。
const EXPLORATION_SUMMARY_PROMPT = `你的任务是为一次代码探索生成一份精炼的探索摘要，帮助读者快速判断"这条探索记录跟我的当前任务相关吗"。

摘要面向主代理（Main Agent），用于一览列表中的快速扫描和相关度评估，不注入子代理上下文。

使用以下三段式结构：

1. **探索目标与范围**：本次探索被派去查什么，探索了哪些模块/目录/子系统
2. **关键发现与结论**：发现了什么，核心结论是什么，有什么值得注意的设计模式或架构特征
3. **重要的代码位置与文件**：对后续工作最有参考价值的文件路径和代码位置

摘要控制在 800 个英文单词以内（中文对应压缩），优先使用要点而非段落。`;

export function buildSummaryPromptForSession({ sessionType, trimAppended, additionalInstructions }) {
  if (!trimAppended && sessionType === 'exploration') {
    const extra = typeof additionalInstructions === 'string' && additionalInstructions.trim()
      ? `## 额外压缩指令\n${additionalInstructions.trim()}`
      : '';
    return [EXPLORATION_SUMMARY_PROMPT, extra].filter(Boolean).join('\n');
  }
  return buildSummaryPrompt({
    additionalInstructions,
    ...(trimAppended ? { trimAppended: true } : {}),
  });
}

// 模型角色映射复用 run-compact-mirror 的装配约定：exploration/sub 会话走
// 对应角色，其余走 system；未配置该角色时 resolver 回退 default。
function resolveModelRole(sessionType) {
  if (sessionType === 'exploration') return 'exploration';
  if (sessionType === 'sub') return 'sub';
  return 'system';
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
  sessionType = '',
}) {
  const agentDir = path.resolve(String(projectRoot || '').trim(), agentRelativeDir);
  const modelPresetRole = resolveModelRole(sessionType);
  const resolvedModel = resolveAgentModelLLM(agentDir, modelPresetRole);
  if (!resolvedModel) {
    throw new Error(`No model preset resolved for in-process summary (agentDir=${agentRelativeDir}, role=${modelPresetRole}) — configure model presets for this agent`);
  }
  console.log(`[inprocess_summary] using model preset role=${modelPresetRole} model=${resolvedModel.modelName} agent=${agentId} session=${sessionId}`);
  tuneMirrorLLM(resolvedModel.llm, SUMMARY_MAX_TOKENS, { forceMaxTokens: true });
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
 * @param {string} [params.sessionType] - 会话类型（exploration/sub/其他）
 * @param {boolean} [params.trimAppended] - true 时用 trim-appended 提示词
 * @param {number} [params.maxAttempts=3] - 空摘要/调用失败时的重试次数
 * @param {string} [params.additionalInstructions]
 * @param {number} [params.timeoutMs=600000] - 整体超时（超时后底层调用自然终止，结果被丢弃）
 * @returns {Promise<{summaryText: string, attemptCount: number, importantFiles: string[], importantSkills: string[], fileRanges: Object}>}
 */
export async function runInProcessSummary({
  agentRelativeDir,
  projectRoot,
  agentId,
  sessionId,
  sourceSessionSnapshot = null,
  sessionType = '',
  trimAppended = false,
  maxAttempts = 3,
  additionalInstructions = '',
  timeoutMs = 600000,
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
    sessionType,
  });

  const prompt = buildSummaryPromptForSession({ sessionType, trimAppended, additionalInstructions });
  const attempts = Number.isFinite(maxAttempts) ? Math.max(1, Math.min(5, Number(maxAttempts))) : 3;

  const work = (async () => {
    let lastFailure = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const summaryText = await generateSummaryText({ llm }, snapshot, prompt);
        const scanned = scanFilesAndSkills(messages);
        return {
          summaryText,
          attemptCount: attempt,
          importantFiles: scanned.files,
          importantSkills: scanned.skills,
          fileRanges: scanned.fileRanges,
        };
      } catch (error) {
        lastFailure = error;
        console.warn(`[inprocess_summary] attempt ${attempt}/${attempts} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw lastFailure instanceof Error ? lastFailure : new Error(String(lastFailure || 'Unknown in-process summary failure'));
  })();

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return work;
  }

  let timer = null;
  try {
    return await Promise.race([
      work,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`In-process summary timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
