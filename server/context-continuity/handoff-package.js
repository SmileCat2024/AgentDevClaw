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

/**
 * seedBoundary 形状规整（ADR-0024 PR-3 marker 双落盘之协议层）。
 *
 * 变换产物（SuccessorSeed）顶层声明的透传校验：形状不合法按缺失处理
 * （返回 null），由消费方（线程流读取）按 incomplete 报告，落盘侧不
 * 捏造、不拒写。旧产物无该字段不是错误（框架 SuccessorSeed 契约：可选）。
 */
export function normalizeSeedBoundary(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const seedMessageCount = Number(raw.seedMessageCount);
  if (!Number.isInteger(seedMessageCount) || seedMessageCount < 0) return null;
  const rawInjections = Array.isArray(raw.appendedInjection) ? raw.appendedInjection : [];
  const appendedInjection = [];
  for (const item of rawInjections) {
    const messageIndex = Number(item?.messageIndex);
    if (typeof item?.kind !== 'string' || !item.kind.trim()
      || !Number.isInteger(messageIndex) || messageIndex < 0) {
      return null;
    }
    appendedInjection.push({ kind: item.kind, messageIndex });
  }
  return { seedMessageCount, appendedInjection };
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

/**
 * 精简注解种子消息（history-only trim 专用，追加在裁剪产物末尾）。
 *
 * 不带 turn 字段：HandoffSeedFeature 重放时按 fallbackTurn + index 顺延，
 * 数组末尾的注解消息因此天然落在全部保留消息之后（上下文最后一条）。
 */
function buildTrimNoticeSeedMessage({ sourceSessionId, trimmedAt }) {
  return {
    role: 'system',
    content: [
      `上下文积累到此处时被精简，会话 id 已更新，上一段会话 id：${sanitizeFragment(sourceSessionId)}`,
      `精简发生时间：${trimmedAt}`,
      '',
      '继续工作前，请先审视当前任务状态：重新阅读仍然涉及的关键文件以确认其最新内容，回顾上文中的关键结论、约定与未完成事项，核对进度后再决定下一步动作。',
    ].join('\n'),
  };
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
  // 源消息时间投影（enriched 侧 timestamp）：透传进 trim 产物，接续会话保留
  // 历史时间线；长度失配的结构异常快照按无时间锚降级。
  const enrichedMessages = Array.isArray(sessionSnapshot?.runtime?.context?.enrichedMessages)
    ? sessionSnapshot.runtime.context.enrichedMessages
    : null;
  const msgTimestamps = enrichedMessages && enrichedMessages.length === rawMessages.length
    ? enrichedMessages.map(e => (typeof e?.timestamp === 'number' && Number.isFinite(e.timestamp) ? e.timestamp : null))
    : undefined;

  const { seedMessages, stats } = buildTrimmedSeedMessages(rawMessages, policy, msgTimestamps);
  const createdAt = new Date().toISOString();
  // 不带摘要的精简也在上下文末尾注入一条注解（与带摘要版本的摘要消息同位），
  // 让续接 agent 明确感知会话 id 已变更并重新审视任务状态。
  seedMessages.push(buildTrimNoticeSeedMessage({
    sourceSessionId: sessionId,
    trimmedAt: createdAt,
  }));
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
    // seed 边界声明（ADR-0024 PR-3 marker 双落盘之协议层）：本入口的产物
    // 在 Claw 侧本地构建，账目自洽——总量即 seedMessages.length，trim
    // 注解是唯一追加注入项（尾部，见上方 push）。
    seedBoundary: {
      seedMessageCount: seedMessages.length,
      appendedInjection: seedMessages.length > 0
        ? [{ kind: 'trim-notice', messageIndex: seedMessages.length - 1 }]
        : [],
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

/**
 * SuccessorSeed → handoff 字段提取（写侧唯一权威）。
 *
 * 落盘写侧（writeTrimWithSummaryHandoffPackage）与 plain 进程内接力
 * （组装 HandoffSeedPayload）共用同一条回退链：appendedSummary 优先、
 * seed 顶层兜底。框架 payload 增字段只改这里，消费方不再平行手拼。
 */
export function buildTrimWithSummarySeedFields(seed) {
  const meta = seed?.meta ?? {};
  const appended = meta.appendedSummary ?? {};
  return {
    seedMessages: Array.isArray(seed?.seedMessages) ? seed.seedMessages : [],
    summaryText: appended.summaryText ?? meta.summaryText ?? '',
    importantFiles: appended.importantFiles ?? seed.importantFiles ?? [],
    importantSkills: appended.importantSkills ?? seed.importantSkills ?? [],
    fileRanges: appended.fileRanges ?? seed.fileRanges ?? {},
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
  const seedFields = buildTrimWithSummarySeedFields(seed);
  const meta = seed?.meta ?? {};
  // 变换产物顶层的 seedBoundary 声明（框架 TrimTranscriptWithSummary /
  // TrimTranscript 已实现，ADR-0024 PR-3）：形状规整后透传落盘。旧框架
  // 产物无该字段时保持缺省不写（schemaVersion 不动，旧包兼容）。
  const seedBoundary = normalizeSeedBoundary(seed?.seedBoundary);
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
    seedMessages: seedFields.seedMessages,
    ...(seedBoundary ? { seedBoundary } : {}),
    appendedSummary: {
      summaryText: seedFields.summaryText,
      importantFiles: seedFields.importantFiles,
      importantSkills: seedFields.importantSkills,
      sessionTitle: '',
      fileRanges: seedFields.fileRanges,
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
