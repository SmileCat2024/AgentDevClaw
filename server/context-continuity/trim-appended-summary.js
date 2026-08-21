/**
 * Trim-Appended Summary — 独立的 summary 流水线
 *
 * 当用户在 Trim 对话框中勾选"同时生成摘要并追加"时，此模块负责生成
 * summary 文本并构建追加到 trim seed messages 之后的 system message。
 *
 * 摘要生成走 agentdev 官方 summary 实现（进程内 llm 注入，
 * buildSummaryPrompt({ trimAppended: true }) 与本地旧提示词逐字一致），
 * 由 inprocess-summary.js 负责模型装配、重试与超时。
 */

import { buildSummarySeedMessage } from '@agentdev/core';
import { runInProcessSummary } from './inprocess-summary.js';

function cleanMultilineText(value) {
  if (typeof value !== 'string') return '';
  const normalized = value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n').map((line) => line.replace(/[ \t]+/g, ' ').trimEnd());
  const compacted = [];
  let blankRun = 0;
  for (const line of lines) {
    if (line.trim() === '') {
      blankRun += 1;
      if (blankRun <= 1) {
        compacted.push('');
      }
      continue;
    }
    blankRun = 0;
    compacted.push(line);
  }
  return compacted.join('\n').trim();
}

/**
 * 运行 trim-appended summary 流水线。
 *
 * 使用 trim-appended 专用提示词（框架 buildSummaryPrompt({ trimAppended: true })），
 * 生成摘要后构建追加到 trim seed messages 之后的 system message。
 *
 * @param {object} params
 * @param {string} params.agentRelativeDir - 预制 agent 的相对目录路径
 * @param {string} params.agentId - Agent ID
 * @param {string} params.sessionId - 源会话 ID
 * @param {string} params.projectRoot - 项目根目录
 * @param {object|null} [params.sourceSessionSnapshot] - 会话快照；未提供时由生成器读取
 * @returns {Promise<{summarySeedMessage: object, summaryText: string, compactOutput: object}>}
 */
export async function runTrimAppendedSummary({
  agentRelativeDir,
  agentId,
  sessionId,
  projectRoot,
  sourceSessionSnapshot = null,
}) {
  console.log(`[trim_append_summary] begin agent=${agentId} session=${sessionId}`);

  const summaryResult = await runInProcessSummary({
    agentRelativeDir,
    projectRoot,
    agentId,
    sessionId,
    sourceSessionSnapshot,
    trimAppended: true,
    maxAttempts: 3,
  });
  console.log(`[trim_append_summary] done agent=${agentId} session=${sessionId} attempts=${summaryResult.attemptCount}`);

  const summaryText = cleanMultilineText(summaryResult?.summaryText);
  if (!summaryText) {
    throw new Error('Trim-appended summary returned an empty summary');
  }

  const summarySeedMessage = buildSummarySeedMessage(summaryText);

  const compactOutput = {
    importantFiles: Array.isArray(summaryResult?.importantFiles) ? summaryResult.importantFiles : [],
    importantSkills: Array.isArray(summaryResult?.importantSkills) ? summaryResult.importantSkills : [],
    sessionTitle: '',
    fileRanges: typeof summaryResult?.fileRanges === 'object' && summaryResult.fileRanges !== null ? summaryResult.fileRanges : {},
  };

  return {
    summarySeedMessage,
    summaryText,
    compactOutput,
  };
}
