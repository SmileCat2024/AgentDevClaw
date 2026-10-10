/**
 * Thread stream fixture — 5 棒链的真实结构落盘（ADR-0024 PR-3 spike 样本形态）
 *
 * 按 spike 结论的数据面构建（不以手写理想化数组代替结构）：
 *   - 真实 ThreadStore / WorkThread（createThreadControl + core.start +
 *     advanceHead×4）落盘 sessionChain；
 *   - 每棒会话快照 JSON（AgentRuntimeSnapshot 结构：runtime.context.
 *     enrichedMessages 持久化 sequence + runtime.featureStates 的
 *     handoff-seed 注入事实回写）；
 *   - 每个接缝一个 handoff 包 JSON（schemaVersion 1 + seedBoundary 声明）；
 *   - session index（successor 棒 metadata.handoffId / handoffPath 关联）。
 *
 * seed 规模对齐 spike 真实产物（59 条形态）：每缝 seedCount = 59，
 * 尾部 1 条 summary 注入（appendedInjection）。
 *
 * options 支持制造各 incomplete 变体（默认全链完整）。
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { WorkThreadRuntimeBridge } from '@agentdevjs/core';

import { createThreadControl } from '../../server/thread-control/thread-controller.js';
import { createThreadStreamReader } from '../../server/thread-control/thread-stream.js';

const AGENT = 'programming-helper';
const SEED_COUNT = 59;
const OWN_MESSAGES = [130, 40, 30, 20, 15]; // 棒 0..4 各自的"seed 段之后"消息数

function enrichedEntry(sessionId, seq, role, content) {
  return {
    id: `msg-${sessionId}-${String(seq).padStart(4, '0')}`,
    role,
    content,
    timestamp: 1760000000000 + seq * 1000,
    turn: Math.floor(seq / 2),
    sequence: seq,
    tags: [],
    parsed: {},
  };
}

function seedRoleAt(index, last) {
  if (index === last) return 'system'; // 尾部 summary 注入（appendedInjection 指向）
  return index % 2 === 0 ? 'user' : 'assistant';
}

function buildSeedMessages(handoffId) {
  const messages = [];
  for (let j = 0; j < SEED_COUNT; j += 1) {
    const role = seedRoleAt(j, SEED_COUNT - 1);
    messages.push({
      role,
      content: role === 'system'
        ? `## 上下文交接摘要（${handoffId}）\n上一段对话的关键结论与未完成事项。`
        : `seed[${handoffId}][${j}]`,
    });
  }
  return messages;
}

/** 棒 i 的 enriched：seed 段（seq 0..58，重放副本）+ 自有消息。 */
function buildEnriched(sessionId, seamHandoffId, ownCount) {
  const list = [];
  if (seamHandoffId) {
    const seed = buildSeedMessages(seamHandoffId);
    seed.forEach((msg, j) => {
      list.push(enrichedEntry(sessionId, j, msg.role, msg.content));
    });
  }
  const seqBase = seamHandoffId ? SEED_COUNT : 0;
  for (let k = 0; k < ownCount; k += 1) {
    const seq = seqBase + k;
    list.push(enrichedEntry(sessionId, seq, k % 2 === 0 ? 'user' : 'assistant', `own[${sessionId}][${k}]`));
  }
  return list;
}

async function writeJson(filePath, data) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, JSON.stringify(data), 'utf8');
  return filePath;
}

async function readJsonOrNull(filePath) {
  try {
    return JSON.parse(await fsp.readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * @param {object} [options] incomplete 变体开关
 * @param {number} [options.dropSeedBoundarySeam] 该缝 handoff 无 seedBoundary（旧产物）
 * @param {number} [options.breakSeedCountSeam] 该缝 seedBoundary.seedMessageCount 与注入事实不一致
 * @param {number} [options.unlinkHandoffSeam] 该缝 successor index metadata 不带 handoffId/Path
 * @param {number} [options.removeHandoffFileSeam] 该缝 handoff 包文件不落盘
 * @param {number} [options.dropFactsStick] 该棒快照 featureStates 不含 handoff-seed 事实
 * @param {number} [options.mismatchPackageIdSeam] 该缝注入事实 packageId 指向别的包
 */
export async function buildThreadStreamFixture(rootDir, options = {}) {
  const threadsRoot = path.join(rootDir, 'threads');
  const sessionsDir = path.join(rootDir, 'data', 'sessions', AGENT);
  const handoffsDir = path.join(rootDir, 'data', 'context-handoffs', AGENT);

  const sessionIds = ['s0', 's1', 's2', 's3', 's4'];
  const identitySessions = new Map(sessionIds.map((id) => [id, 'coder']));
  const control = createThreadControl({
    rootDir: threadsRoot,
    bridge: new WorkThreadRuntimeBridge(),
    identitySource: async (_agentId, sessionId) => identitySessions.get(String(sessionId || '').trim()) ?? null,
  });

  // 真实链：start(s0) + advanceHead×4（endKind 对齐接续语义）
  const thread = await control.core.start({
    sessionRef: { agentId: AGENT, sessionId: 's0' },
    title: 'fixture-thread',
  });
  const endKinds = ['context_rotation', 'context_rotation', 'context_rotation', 'context_rotation'];
  for (let i = 0; i < 4; i += 1) {
    const current = await control.core.getThread(thread.threadId);
    await control.core.advanceHead({
      threadId: thread.threadId,
      toSessionId: sessionIds[i + 1],
      fromSessionId: sessionIds[i],
      expectedRevision: current.revision,
      endKind: endKinds[i],
    });
  }

  // 每缝 handoff 包 + successor 会话快照 + session index
  const handoffIds = [];
  const handoffPaths = [];
  const indexSessions = [];
  const seedInjections = [];

  for (let seam = 0; seam < 4; seam += 1) {
    const handoffId = `handoff-fixture-${seam}-${'a1b2c3d' + seam}`;
    handoffIds.push(handoffId);

    const declaredCount = options.breakSeedCountSeam === seam ? SEED_COUNT - 1 : SEED_COUNT;
    const handoff = {
      schemaVersion: 1,
      handoffId,
      createdAt: new Date(1760000000000 + seam * 60000).toISOString(),
      compilerVersion: 'trim-transcript-with-summary-v1',
      seedKind: 'message-replay',
      mode: 'trim-transcript-with-summary',
      sourceAgentId: AGENT,
      sourceSessionId: sessionIds[seam],
      sourceSessionPath: path.join(sessionsDir, `${sessionIds[seam]}.json`),
      sourceRecord: {},
      policy: {},
      stats: { total: OWN_MESSAGES[seam], retained: SEED_COUNT - 1, appended: 1 },
      featureContinuity: [],
      sourceSummary: 'fixture source summary',
      seedMessages: buildSeedMessages(handoffId),
      seedBoundary: {
        seedMessageCount: declaredCount,
        appendedInjection: [{ kind: 'summary', messageIndex: SEED_COUNT - 1 }],
      },
      appendedSummary: {
        summaryText: `summary of ${sessionIds[seam]}`,
        importantFiles: [],
        importantSkills: [],
        sessionTitle: '',
        fileRanges: {},
      },
    };
    if (options.dropSeedBoundarySeam === seam) delete handoff.seedBoundary;
    if (options.removeHandoffFileSeam !== seam) {
      handoffPaths.push(await writeJson(path.join(handoffsDir, `${handoffId}.json`), handoff));
    } else {
      handoffPaths.push(path.join(handoffsDir, `${handoffId}.json`));
    }

    // successor 棒（seam + 1）的注入事实
    const packageId = options.mismatchPackageIdSeam === seam ? 'handoff-fixture-other' : handoffId;
    seedInjections.push({
      injected: true,
      packageId,
      seedCount: SEED_COUNT,
      firstMessageSeq: 0,
      lastMessageSeq: SEED_COUNT - 1,
    });
  }

  // 会话快照（棒 0 root 无注入事实；其余按缝注入）
  for (let i = 0; i < sessionIds.length; i += 1) {
    const sessionId = sessionIds[i];
    const seamHandoffId = i === 0 ? null : handoffIds[i - 1];
    const enriched = buildEnriched(sessionId, seamHandoffId, OWN_MESSAGES[i]);
    const featureStates = (i > 0 && options.dropFactsStick !== i)
      ? [{ featureName: 'handoff-seed', snapshot: seedInjections[i - 1] }]
      : [];
    await writeJson(path.join(sessionsDir, `${sessionId}.json`), {
      version: 1,
      sessionId,
      savedAt: new Date(1760000000000 + i * 120000).toISOString(),
      agentType: AGENT,
      runtime: {
        initialized: true,
        callIndex: 50 + i,
        context: {
          messages: enriched.map((m) => ({ role: m.role, content: m.content, turn: m.turn })),
          enrichedMessages: enriched,
        },
        featureStates,
      },
      rollbackHistory: [],
    });

    const metadata = (i > 0 && options.unlinkHandoffSeam !== i - 1)
      ? {
        resumeMode: 'handoff',
        handoffId: handoffIds[i - 1],
        handoffPath: handoffPaths[i - 1],
        handoffCreatedAt: new Date(1760000000000 + i * 60000).toISOString(),
        handoffSummaryKind: 'trim-transcript-with-summary',
      }
      : {};
    indexSessions.push({
      id: sessionId,
      title: `fixture-${sessionId}`,
      sessionType: 'coder',
      openDirectory: 'D:/code/fixture',
      createdAt: new Date(1760000000000 + i * 130000).toISOString(),
      metadata,
    });
  }
  await writeJson(path.join(sessionsDir, 'index.json'), {
    revision: 1,
    activeSessionId: 's4',
    sessions: indexSessions,
  });

  const reader = createThreadStreamReader({
    core: control.core,
    readSessionIndex: async () => readJsonOrNull(path.join(sessionsDir, 'index.json')),
    readSessionFile: async (_agentId, sessionId) => readJsonOrNull(path.join(sessionsDir, `${sessionId}.json`)),
    readHandoff: async ({ handoffId, handoffPath }) => readJsonOrNull(
      handoffPath || path.join(handoffsDir, `${handoffId}.json`),
    ),
  });

  return {
    agentId: AGENT,
    threadId: thread.threadId,
    control,
    reader,
    sessionIds,
    handoffIds,
    seedCount: SEED_COUNT,
    ownCounts: OWN_MESSAGES,
    paths: { threadsRoot, sessionsDir, handoffsDir },
  };
}
