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
  };
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
  });
}
