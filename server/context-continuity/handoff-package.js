import path from 'path';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import {
  DEFAULT_EXPORT_POLICY,
  HANDOFF_SCHEMA_VERSION,
  HANDOFF_COMPILER_VERSION,
  normalizeExportPolicy,
  buildTrimmedSeedMessages,
} from '@agentdevjs/core';
import {
  applyContinuityToolPolicy,
  exportFeatureContinuity,
} from './feature-continuity.js';

// Trim 策略引擎（DEFAULT_EXPORT_POLICY / normalizeExportPolicy / buildTrimmedSeedMessages）
// 已上移框架（AgentDev src/core/continuity/transforms/trim-transcript.ts），
// 本模块只保留 Claw 侧 handoff 落盘与 sourceRecord 构建，并 re-export 引擎符号
// 供既有消费方使用（docs/adr/0002、docs/tickets/008）。
export {
  DEFAULT_EXPORT_POLICY,
  normalizeExportPolicy,
  buildTrimmedSeedMessages,
};

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

export function getContextHandoffsRoot(userDataRoot) {
  return path.join(path.resolve(String(userDataRoot || '').trim()), 'context-handoffs');
}

export function getContextHandoffDir(userDataRoot, agentId) {
  return path.join(getContextHandoffsRoot(userDataRoot), sanitizeFragment(agentId));
}

export function getContextHandoffFilePath(userDataRoot, agentId, handoffId) {
  return path.join(getContextHandoffDir(userDataRoot, agentId), `${sanitizeFragment(handoffId)}.json`);
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
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

export async function exportHistoryOnlyHandoffPackage({
  userDataRoot,
  agentId,
  sessionId,
  sessionPath,
  sourceRecord = {},
  policy: rawPolicy = {},
}) {
  const sessionSnapshot = await readJson(path.resolve(String(sessionPath || '').trim()));
  const featureContinuity = exportFeatureContinuity(sessionSnapshot, { mode: 'trim-transcript' });
  const policy = normalizeExportPolicy(applyContinuityToolPolicy(rawPolicy));
  const rawMessages = Array.isArray(sessionSnapshot?.runtime?.context?.messages)
    ? sessionSnapshot.runtime.context.messages
    : [];

  const { seedMessages, stats } = buildTrimmedSeedMessages(rawMessages, policy);
  const createdAt = new Date().toISOString();
  const handoffId = `handoff-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const sourceSummary = buildCompactOverview(sourceRecord);

  const handoff = {
    schemaVersion: HANDOFF_SCHEMA_VERSION,
    handoffId,
    createdAt,
    compilerVersion: HANDOFF_COMPILER_VERSION,
    seedKind: 'message-replay',
    mode: 'trim-transcript',
    sourceAgentId: sanitizeFragment(agentId),
    sourceSessionId: sanitizeFragment(sessionId),
    sourceSessionPath: path.resolve(String(sessionPath || '').trim()),
    sourceRecord: buildSourceRecord(sourceRecord),
    policy,
    stats,
    featureContinuity,
    sourceSummary,
    seedMessages,
  };

  const handoffPath = getContextHandoffFilePath(userDataRoot, agentId, handoffId);
  await ensureDir(path.dirname(handoffPath));
  await fs.writeFile(handoffPath, `${JSON.stringify(handoff, null, 2)}\n`, 'utf8');

  return {
    handoff,
    handoffPath,
  };
}

/**
 * 落盘框架 trim-transcript-with-summary 组合变换的产物（SuccessorSeed）。
 *
 * 组合语义（裁剪 + 摘要追加）由框架 TrimTranscriptWithSummaryTransformation
 * 产出；本函数只做 Claw 落盘格式化（handoff JSON v1），字段与
 * exportHistoryOnlyHandoffPackage 保持同构，消费方（compacted resume、
 * HandoffSeedFeature）不感知差异。
 */
export async function writeTrimWithSummaryHandoffPackage({
  userDataRoot,
  agentId,
  sessionId,
  sessionPath,
  sourceRecord = {},
  sessionSnapshot,
  seed,
}) {
  const meta = seed?.meta ?? {};
  const appended = meta.appendedSummary ?? {};
  const handoffId = `handoff-${Date.now()}-${randomUUID().slice(0, 8)}`;

  const handoff = {
    schemaVersion: HANDOFF_SCHEMA_VERSION,
    handoffId,
    createdAt: new Date().toISOString(),
    compilerVersion: meta.compilerVersion || HANDOFF_COMPILER_VERSION,
    seedKind: meta.seedKind || 'message-replay',
    mode: meta.mode || 'trim-transcript-with-summary',
    sourceAgentId: sanitizeFragment(agentId),
    sourceSessionId: sanitizeFragment(sessionId),
    sourceSessionPath: path.resolve(String(sessionPath || '').trim()),
    sourceRecord: buildSourceRecord(sourceRecord),
    policy: meta.trimPolicy ?? {},
    stats: meta.trimStats ?? {},
    featureContinuity: exportFeatureContinuity(sessionSnapshot, { mode: 'trim-transcript' }),
    sourceSummary: buildCompactOverview(sourceRecord),
    seedMessages: seed.seedMessages,
    appendedSummary: {
      summaryText: appended.summaryText ?? meta.summaryText ?? '',
      importantFiles: appended.importantFiles ?? seed.importantFiles ?? [],
      importantSkills: appended.importantSkills ?? seed.importantSkills ?? [],
      sessionTitle: '',
      fileRanges: appended.fileRanges ?? seed.fileRanges ?? {},
    },
  };

  const handoffPath = getContextHandoffFilePath(userDataRoot, agentId, handoffId);
  await ensureDir(path.dirname(handoffPath));
  await fs.writeFile(handoffPath, `${JSON.stringify(handoff, null, 2)}\n`, 'utf8');

  return {
    handoff,
    handoffPath,
  };
}

export async function readHandoffPackage({ userDataRoot, agentId, handoffId, handoffPath }) {
  const resolvedPath = handoffPath
    ? path.resolve(String(handoffPath || '').trim())
    : getContextHandoffFilePath(userDataRoot, agentId, handoffId);
  const handoff = await readJson(resolvedPath);
  if (handoff?.schemaVersion !== HANDOFF_SCHEMA_VERSION) {
    const error = new Error(`Unsupported handoff schema version: ${handoff?.schemaVersion ?? 'unknown'}`);
    error.statusCode = 400;
    // T002：接力材料校验失败的稳定错误 code——失败收敛按此记录阶段
    error.code = 'handoff_invalid';
    throw error;
  }
  return {
    handoff,
    handoffPath: resolvedPath,
  };
}
