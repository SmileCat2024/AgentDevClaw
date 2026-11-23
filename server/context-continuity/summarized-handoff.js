import path from 'path';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import {
  getContextHandoffFilePath,
} from './handoff-package.js';
import {
  exportFeatureContinuity,
} from './feature-continuity.js';
import { runInProcessSummary } from './inprocess-summary.js';
import {
  HANDOFF_SCHEMA_VERSION,
  normalizeSummaryPolicy,
  buildSummarySeedMessage,
} from '@agentdevjs/core';
import { SESSION_TRANSFORMATION_TIMEOUT_MS } from '../shared/constants.js';

const HANDOFF_COMPILER_VERSION = 'summarized-nine-section-v1';

function sanitizeFragment(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'default';
}

function cleanInlineText(value) {
  return typeof value === 'string'
    ? value.replace(/\s+/g, ' ').trim()
    : '';
}

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

function buildSourceRecord(sourceRecord = {}) {
  return {
    title: cleanInlineText(sourceRecord?.title),
    featureName: cleanInlineText(sourceRecord?.featureName),
    agentName: cleanInlineText(sourceRecord?.agentName),
    taskTitle: cleanInlineText(sourceRecord?.taskTitle),
    taskType: cleanInlineText(sourceRecord?.taskType),
    goal: cleanMultilineText(sourceRecord?.goal),
    constraints: cleanMultilineText(sourceRecord?.constraints),
    expectedOutput: cleanMultilineText(sourceRecord?.expectedOutput),
    targetFiles: cleanMultilineText(sourceRecord?.targetFiles),
    referenceMaterials: cleanMultilineText(sourceRecord?.referenceMaterials),
    openDirectory: cleanInlineText(sourceRecord?.openDirectory),
    createdAt: cleanInlineText(sourceRecord?.createdAt),
    updatedAt: cleanInlineText(sourceRecord?.updatedAt),
    sessionType: cleanInlineText(sourceRecord?.sessionType),
    workspaceAgentId: sourceRecord?.workspaceAgentId === undefined ? 'main' : sourceRecord.workspaceAgentId,
  };
}

/** 摘要包可附带的用户输入上限：条数与字符双闸，避免大段粘贴把上下文撑回去。 */
export const RECENT_USER_INPUT_MAX_MESSAGES = 3;
export const RECENT_USER_INPUT_MAX_CHARS = 2000;

/**
 * 纯摘要接续会丢弃全部原始对话，用户最近的原话（尤其方向纠正）随之消失。
 * 这里把最近几条用户输入原样收成一段提醒块：它随 handoff 的 appendix
 * 在 runtime 侧以 system reminder 注入，不改接续产物骨架、不占 seed 账目、
 * 也不参与 turn 编号空间（ADR-0048）。
 */
export function buildRecentUserInputReminder(
  messages,
  { maxMessages = RECENT_USER_INPUT_MAX_MESSAGES, maxChars = RECENT_USER_INPUT_MAX_CHARS } = {},
) {
  if (!Array.isArray(messages) || messages.length === 0) return '';
  const picked = [];
  let budget = maxChars;
  for (let i = messages.length - 1; i >= 0 && picked.length < maxMessages && budget > 0; i -= 1) {
    const message = messages[i];
    if (message?.role !== 'user') continue;
    const text = cleanMultilineText(typeof message.content === 'string' ? message.content : '');
    if (!text) continue;
    const clipped = text.length > budget ? `${text.slice(0, Math.max(1, budget - 1)).trimEnd()}…` : text;
    picked.unshift(clipped);
    budget -= clipped.length;
  }
  if (picked.length === 0) return '';
  return [
    '以下是用户此前在这项任务中说过的话（按时间顺序）：',
    ...picked.map((text, index) => `${index + 1}. ${text}`),
    '',
    '继续工作时以这些要求为准；已经完成或已被后面的要求取代的部分不必重做。',
  ].join('\n');
}

function buildCompactOverview(sourceRecord = {}) {
  const lines = [];
  const title = cleanInlineText(sourceRecord?.taskTitle || sourceRecord?.title);
  const goal = cleanMultilineText(sourceRecord?.goal);
  const constraints = cleanMultilineText(sourceRecord?.constraints);
  const openDirectory = cleanInlineText(sourceRecord?.openDirectory);
  if (title) lines.push(`Task: ${title}`);
  if (goal) lines.push(`Goal: ${goal}`);
  if (constraints) lines.push(`Constraints: ${constraints}`);
  if (openDirectory) lines.push(`Working directory: ${openDirectory}`);
  return lines.join('\n');
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

export {
  sanitizeFragment,
  cleanInlineText,
  cleanMultilineText,
  buildSourceRecord,
  buildCompactOverview,
  normalizeSummaryPolicy,
  buildSummarySeedMessage,
};

export async function writeSummarizedHandoffPackage({
  userDataRoot,
  agentId,
  sessionId,
  sourceRecord = {},
  policy: rawPolicy = {},
  summaryText: rawSummaryText = '',
  rawResponse = '',
  attemptCount = null,
  importantFiles = [],
  importantSkills = [],
  sessionTitle = '',
  fileRanges = {},
  sessionTimestamp = null,
  gitMeta = null,
  sourceSessionSnapshot = null,
  featureContinuity = null,
  appendixContent = '',
}) {
  const policy = normalizeSummaryPolicy(rawPolicy);
  const continuity = featureContinuity && typeof featureContinuity === 'object'
    ? featureContinuity
    : exportFeatureContinuity(sourceSessionSnapshot, { mode: 'summarized-nine-section' });
  const createdAt = new Date().toISOString();
  const handoffId = `handoff-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const summaryText = cleanMultilineText(rawSummaryText);
  if (!summaryText) {
    throw new Error('Summary text is required for summarized handoff');
  }

  const handoff = {
    schemaVersion: HANDOFF_SCHEMA_VERSION,
    handoffId,
    createdAt,
    compilerVersion: HANDOFF_COMPILER_VERSION,
    seedKind: 'summary-message',
    mode: 'summarized-nine-section',
    summaryShape: policy.summaryShape,
    sourceAgentId: sanitizeFragment(agentId),
    sourceSessionId: sanitizeFragment(sessionId),
    sourceRecord: buildSourceRecord(sourceRecord),
    policy,
    stats: {
      attemptCount: Number.isFinite(attemptCount) ? Number(attemptCount) : null,
      rawResponseChars: typeof rawResponse === 'string' ? rawResponse.length : 0,
      summaryChars: summaryText.length,
    },
    sourceSummary: summaryText,
    summaryArtifact: {
      shape: policy.summaryShape,
      rawResponse: typeof rawResponse === 'string' ? rawResponse : '',
      summaryText,
    },
    compactOutput: {
      sessionTitle: typeof sessionTitle === 'string' ? sessionTitle.trim() : '',
      importantFiles: Array.isArray(importantFiles) ? importantFiles : [],
      importantSkills: Array.isArray(importantSkills) ? importantSkills : [],
      fileRanges: typeof fileRanges === 'object' && fileRanges !== null ? fileRanges : {},
    },
    sessionTimestamp: typeof sessionTimestamp === 'string' && sessionTimestamp ? sessionTimestamp : null,
    gitMeta: gitMeta && typeof gitMeta === 'object' ? {
      branch: cleanInlineText(gitMeta.branch),
      commitHash: cleanInlineText(gitMeta.commitHash),
      commitMessage: cleanInlineText(gitMeta.commitMessage),
      isDirty: !!gitMeta.isDirty,
    } : null,
    featureContinuity: continuity,
    seedMessages: [buildSummarySeedMessage(summaryText)],
    ...(cleanMultilineText(appendixContent)
      ? { appendix: { kind: 'recent-user-input', content: cleanMultilineText(appendixContent) } }
      : {}),
  };

  const handoffPath = getContextHandoffFilePath(userDataRoot, agentId, handoffId);
  await ensureDir(path.dirname(handoffPath));
  await fs.writeFile(handoffPath, `${JSON.stringify(handoff, null, 2)}\n`, 'utf8');

  return {
    handoff,
    handoffPath,
  };
}

export async function exportSummarizedHandoffPackage({
  userDataRoot,
  agentId,
  sessionId,
  sourceRecord = {},
  policy: rawPolicy = {},
  agentRelativeDir,
  projectRoot,
  sourceSessionSnapshot = null,
  timeoutMs = SESSION_TRANSFORMATION_TIMEOUT_MS,
  signal = null,
  includeRecentUserInput = false,
}) {
  const policy = normalizeSummaryPolicy(rawPolicy);

  console.log(`[summarized_handoff] in-process summary begin agent=${agentId} session=${sessionId}`);
  const summaryResult = await runInProcessSummary({
    agentRelativeDir,
    projectRoot,
    agentId,
    sessionId,
    sourceSessionSnapshot,
    maxAttempts: policy.maxAttempts,
    additionalInstructions: policy.additionalInstructions,
    timeoutMs,
    signal,
  });
  console.log(`[summarized_handoff] in-process summary done agent=${agentId} session=${sessionId} attempts=${summaryResult.attemptCount}`);

  const summaryText = cleanMultilineText(summaryResult?.summaryText);
  if (!summaryText) {
    throw new Error('In-process summary returned an empty summary');
  }
  return writeSummarizedHandoffPackage({
    userDataRoot,
    agentId,
    sessionId,
    sourceRecord,
    policy,
    summaryText,
    attemptCount: summaryResult?.attemptCount,
    importantFiles: Array.isArray(summaryResult?.importantFiles) ? summaryResult.importantFiles : [],
    importantSkills: Array.isArray(summaryResult?.importantSkills) ? summaryResult.importantSkills : [],
    fileRanges: typeof summaryResult?.fileRanges === 'object' && summaryResult.fileRanges !== null ? summaryResult.fileRanges : {},
    sourceSessionSnapshot,
    appendixContent: includeRecentUserInput
      ? buildRecentUserInputReminder(sourceSessionSnapshot?.runtime?.context?.messages)
      : '',
  });
}
