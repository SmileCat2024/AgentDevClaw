/**
 * Trim-Appended Summary — 独立的 summary 流水线
 *
 * 当用户在 Trim 对话框中勾选"同时生成摘要并追加"时，此模块负责生成
 * summary 文本并构建追加到 trim seed messages 之后的 system message。
 *
 * 设计原则：此模块的 summary 生成逻辑（提示词、流程编排、seed message 格式）
 * 是一份完全独立的实现，与 summarized-handoff.js 中的独立 summary 功能分离。
 * 底层共用 run-compact-mirror.js 脚本基础设施（agent 加载、工具管理、LLM 调用），
 * 但提示词通过 promptOverride 注入，不经过 buildClaudeCompactPrompt()。
 */

import path from 'path';
import os from 'os';
import process from 'process';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { spawn } from 'child_process';
import { childProcessEnv } from '../shared/string-helpers.js';

// ── 独立提示词（不经过 buildClaudeCompactPrompt） ──

const TRIM_APPENDED_TOOL_PREAMBLE = `你必须调用 record_compaction_context 工具，将所有结果作为参数传入。

参数说明：
- summary：完整摘要文本，按下方摘要结构输出
- important_files：恢复工作所需的文件路径列表
- important_skills：实际使用invoke_skill工具激活的技能名称列表

不要调用其他工具。`;

const TRIM_APPENDED_SUMMARY_PROMPT = `你的任务是为当前对话创建一份详细摘要，保留后续继续工作所需的关键信息。

需要注意：在摘要生成后，对话中的大部分工具调用记录会被精简，而用户消息和 Agent 的主要回复通常仍会保留。因此，在分析完整上下文时，应特别关注工具调用中获得的重要信息，并将其中对后续工作仍有价值的部分保留到摘要中，例如代码和文件中的重要事实、测试和命令结果、外部资料、关键错误、技术判断所依赖的依据等。

已经在用户消息或 Agent 主要回复中明确表达的信息，原则上不需要再次总结。摘要应更多承担对工具调用信息和关键工作成果的提炼与保留，减少对主对话内容的重复。

按时间顺序分析对话，重点关注：

1. 工具调用中获得的重要事实、技术信息、代码机制、文件内容、测试结果和外部资料。
2. 重要的文件名、路径、函数、类型、数据结构、关键参数、代码位置、错误信息、数字、版本、命令结果等具体信息。对于当前任务涉及的核心代码，可以适当保留更具体的实现细节和定位信息。
3. 对于已经在 Agent 回复中明确表达的重要结论、技术判断和决策，不必重复结论本身；重点记录这些结论所依赖、但主要存在于工具调用中的事实、证据和必要依据。
4. 用户对方向的重要反馈和纠正，尤其是曾经理解有误、后来改变方向的部分；如果这些内容已经在保留的对话中表达得很清楚，则无需重复展开。
5. 已经尝试但被否定或放弃的重要方向，以及不应重复尝试的原因。普通操作失误或偶发错误通常无需记录，除非它们揭示了后续仍然有价值的信息。
6. 已经实际完成的重要修改、操作和状态变化，以及仍然存在的重要问题。注意区分计划、尝试、完成和验证。
7. 如果当前只能保留某个结论或机制的概括，而后续修改、调试或深入判断仍可能需要更具体的信息，应说明缺少哪些关键细节，并保留足够的定位信息，方便重新查看原始代码、文件或资料。
8. 对外部调研和参考资料，优先保留资料本身提供的具体机制、实现方式、差异和关键事实，减少只记录最终评价或笼统结论。

摘要使用自然的 Markdown 结构，根据实际内容组织，例如：

## 重要发现与技术信息

## 关键证据与实现细节

## 结论背后的补充依据

## 已排除的问题与方向

## 修改、执行结果与当前状态

## 需要重新查看的细节与位置

不要求所有章节都出现，也不要为了填充结构重复内容。

优先记录工具调用带来的信息增量和后续工作真正需要的事实。尤其避免重复用户请求、Agent 已经明确给出的主要结论、已有回答和完整对话过程。

不要为了完整而记录所有工具调用、所有错误或完整的问题解决过程。普通操作过程、偶发错误、没有后续价值的中间信息，以及已经被后续结果取代的信息可以省略。

摘要控制在 3000 个词以内，优先使用要点而非长段落。`;

const TRIM_APPENDED_TOOL_TRAILER = `现在调用 record_compaction_context，传入 summary、文件路径和技能名称。
只包含恢复工作真正需要的文件和技能。`;

function buildTrimAppendedPrompt() {
  return [
    TRIM_APPENDED_TOOL_PREAMBLE,
    '',
    TRIM_APPENDED_SUMMARY_PROMPT,
    '',
    TRIM_APPENDED_TOOL_TRAILER,
  ].join('\n');
}

// ── 文本清洗工具（独立拷贝） ──

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

// ── Mirror compaction runner（独立拷贝） ──

async function runTrimAppendedMirrorCompaction(scriptPath, args, cwd, timeoutMs = 600000) {
  const resultDir = path.join(os.tmpdir(), `trim-append-summary-${Date.now()}-${randomUUID().slice(0, 8)}`);
  const resultPath = path.join(resultDir, 'result.json');
  await fs.mkdir(resultDir, { recursive: true });

  return new Promise((resolve, reject) => {
    console.log(`[trim_append_summary] spawning child resultPath=${resultPath}`);

    const child = spawn(process.execPath, [scriptPath, ...args, resultPath], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...childProcessEnv(),
      },
    });

    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Trim-appended summary mirror compaction timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stderr.on('data', (chunk) => {
      const text = String(chunk);
      stderr += text;
      for (const line of text.split('\n')) {
        if (line.trim()) console.log(`[trim-append-summary] ${line.trimEnd()}`);
      }
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      console.error(`[trim_append_summary] child spawn error: ${err.message}`);
      reject(err);
    });
    child.on('exit', async (code) => {
      clearTimeout(timer);
      console.log(`[trim_append_summary] child exited code=${code}`);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `run-compact-mirror exited with code ${code}`));
        return;
      }
      try {
        const raw = await fs.readFile(resultPath, 'utf8');
        resolve(JSON.parse(raw.trim()));
      } catch (error) {
        reject(new Error(`Failed to read trim-appended summary result file: ${error instanceof Error ? error.message : String(error)}`));
      } finally {
        await fs.rm(resultDir, { recursive: true, force: true }).catch(e => console.warn(e));
      }
    });
  });
}

// ── Seed message builder（独立拷贝） ──

function buildTrimAppendedSummarySeedMessage(summaryText) {
  const body = cleanMultilineText(summaryText);
  return {
    role: 'system',
    content: [
      '以下是前一会话的工作摘要，用于延续同一任务上下文。',
      '摘要涵盖前一轮对话的关键内容。',
      '',
      '摘要：',
      body,
      '',
      '请基于此摘要继续工作，无需要求用户重复陈述背景。',
    ].join('\n'),
    turn: 0,
  };
}

// ── 编排入口 ──

/**
 * 运行 trim-appended summary 流水线。
 *
 * 使用独立的提示词（TRIM_APPENDED_SUMMARY_PROMPT），通过 promptOverride
 * 注入 run-compact-mirror.js，完全绕过 buildClaudeCompactPrompt()。
 *
 * @param {object} params
 * @param {string} params.agentRelativeDir - 预制 agent 的相对目录路径
 * @param {string} params.agentId - Agent ID
 * @param {string} params.sessionId - 源会话 ID
 * @param {object} params.sourceRecord - 源会话记录（含 sessionType 等）
 * @param {string} params.projectRoot - 项目根目录
 * @returns {Promise<{summarySeedMessage: object, summaryText: string, compactOutput: object}>}
 */
export async function runTrimAppendedSummary({
  agentRelativeDir,
  agentId,
  sessionId,
  sourceRecord = {},
  projectRoot,
}) {
  const mirrorScriptPath = path.join(path.resolve(String(projectRoot || '').trim()), 'scripts', 'run-compact-mirror.js');
  console.log(`[trim_append_summary] begin agent=${agentId} session=${sessionId}`);

  const promptOverride = buildTrimAppendedPrompt();

  const mirrorResult = await runTrimAppendedMirrorCompaction(
    mirrorScriptPath,
    [
      agentRelativeDir,
      agentId,
      sessionId,
      JSON.stringify({
        maxAttempts: 3,
        promptOverride,
      }),
    ],
    path.resolve(String(projectRoot || '').trim()),
  );
  console.log(`[trim_append_summary] done agent=${agentId} session=${sessionId} attempts=${mirrorResult?.attemptCount ?? 'unknown'}`);

  const summaryText = cleanMultilineText(mirrorResult?.summaryText);
  if (!summaryText) {
    throw new Error('Trim-appended summary mirror compaction returned an empty summary');
  }

  const summarySeedMessage = buildTrimAppendedSummarySeedMessage(summaryText);

  const compactOutput = {
    importantFiles: Array.isArray(mirrorResult?.importantFiles) ? mirrorResult.importantFiles : [],
    importantSkills: Array.isArray(mirrorResult?.importantSkills) ? mirrorResult.importantSkills : [],
    sessionTitle: typeof mirrorResult?.sessionTitle === 'string' ? mirrorResult.sessionTitle : '',
    fileRanges: typeof mirrorResult?.fileRanges === 'object' && mirrorResult.fileRanges !== null ? mirrorResult.fileRanges : {},
  };

  return {
    summarySeedMessage,
    summaryText,
    compactOutput,
  };
}
