/**
 * Thread Stream — 线程单流投影读取器（ADR-0024 决策 4 / PR-3）
 *
 * 按 threadId 读取一次一致的 sessionChain 快照，为每棒返回稳定棒次、
 * 会话标识、消息基线与接缝（handoff / seed）关联事实。单流数据须按
 * sessionChain 有序读取每棒的用户可见记录，不得把 head session 的消息
 * 数组当作完整单流（spike 结论）。
 *
 * 契约锚定（不绑定任何具体变换的产物形态）：
 *   - 会话级切分：sessionChain 棒次 + successor 会话 index metadata 的
 *     handoffId / handoffPath（每棒到 handoff 包的权威关联）；
 *   - 消息级切分：seed 段边界按 marker 双落盘取值并交叉校验——
 *     handoff 声明数（seedBoundary.seedMessageCount）= successor 快照
 *     featureStates['handoff-seed'] 注入事实（seedCount）= successor
 *     enrichedMessages 数组 seq 区间实际条数；缺失或校验失败该棒标记
 *     incomplete 并带原因码，不回退为消息内容启发式切分、不伪装连续；
 *   - 消息基线锚 enrichedMessages 持久化 sequence / id；probe 通道是
 *     count 制全量数组（含 seed 段），渲染边界用 seq 区间换算的 count
 *     制下标（双坐标，head 棒的边界索引即 seedSegment / visibleStartIndex）。
 *
 * 一致性：以单次 getThread 的 sessionChain 为遍历蓝本（棒内数据按
 * sessionId 寻址，文件稳定）；读取结束后复核 head 未变，变化抛显式冲突
 * （thread_stream_conflict / 409），不混合新旧链。
 *
 * 依赖注入：session index / 会话文件 / handoff 包读取均可替换（测试用
 * 临时目录 fixture），生产缺省指向真实数据目录。
 */

import { createHash } from 'node:crypto';
import path from 'node:path';
import { promises as fsp } from 'node:fs';

import { readSessionIndex, getPrebuiltSessionFilePath } from '../shared/session-access.js';
import {
  getContextHandoffFilePath,
  normalizeSeedBoundary,
} from '../context-continuity/handoff-package.js';
import { USER_DATA_ROOT } from '../shared/constants.js';

const HANDOFF_SEED_FEATURE = 'handoff-seed';

async function defaultReadSessionFile(agentId, sessionId) {
  try {
    return JSON.parse(await fsp.readFile(getPrebuiltSessionFilePath(agentId, sessionId), 'utf8'));
  } catch {
    return null; // 文件缺失 / 损坏 → 该棒按 incomplete 报告，不中断整链
  }
}

/**
 * enrichedMessages 的持久化 sequence → 有限整数或 null（缺失 / 非数）。
 */
function toSequence(value) {
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

/**
 * 从会话快照 featureStates 提取 handoff-seed 注入事实（marker 双落盘的
 * 注入侧，框架 HandoffSeedFeature.captureState 回写）。
 * 旧快照仅 { injected: true } 无数字事实 → 返回 null（seed_facts_missing）。
 */
function extractSeedInjection(snapshot) {
  const featureStates = Array.isArray(snapshot?.runtime?.featureStates)
    ? snapshot.runtime.featureStates
    : [];
  const entry = featureStates.find((f) => f?.featureName === HANDOFF_SEED_FEATURE);
  const snap = entry?.snapshot;
  if (!snap || typeof snap !== 'object' || snap.injected !== true) return null;
  const seedCount = Number(snap.seedCount);
  if (!Number.isInteger(seedCount) || seedCount < 0) return null;
  const first = Number(snap.firstMessageSeq);
  const last = Number(snap.lastMessageSeq);
  const hasRange = Number.isInteger(first) && Number.isInteger(last)
    && first >= 0 && last >= first;
  return {
    packageId: typeof snap.packageId === 'string' ? snap.packageId : '',
    seedCount,
    ...(hasRange ? { firstMessageSeq: first, lastMessageSeq: last } : {}),
  };
}

/**
 * seed 段在 successor 自己的 enrichedMessages 数组中定位（seq 区间 →
 * count 制下标，双坐标换算点）。区间与数组不一致（洞 / 乱序 / 越界）
 * 返回 null——切分不可信，归接缝 incomplete。
 */
function locateSeedSegment(enriched, seedInjection) {
  if (!seedInjection || !Number.isInteger(seedInjection.firstMessageSeq)) return null;
  const { firstMessageSeq, lastMessageSeq } = seedInjection;
  let startIndex = -1;
  let endIndex = -2;
  let inRangeCount = 0;
  for (let i = 0; i < enriched.length; i += 1) {
    const seq = Number(enriched[i]?.sequence);
    if (!Number.isInteger(seq)) continue;
    if (seq >= firstMessageSeq && seq <= lastMessageSeq) {
      if (startIndex === -1) startIndex = i;
      endIndex = i;
      inRangeCount += 1;
    }
  }
  const expected = lastMessageSeq - firstMessageSeq + 1;
  if (inRangeCount !== expected) return null;
  return { startIndex, endIndex, inRangeCount };
}

function _notFound(threadId) {
  const error = new Error(`WorkThread "${threadId}" not found`);
  error.code = 'workthread_not_found';
  error.status = 404;
  return error;
}

/**
 * @param {object} deps
 * @param {import('@agentdevjs/core').WorkThread} deps.core - 线程锚点（getThread）
 * @param {Function} [deps.readSessionIndex] - (agentId) => session index（缺省生产实现）
 * @param {Function} [deps.readSessionFile] - (agentId, sessionId) => 会话快照 | null
 * @param {Function} [deps.readHandoff] - ({ agentId, handoffId, handoffPath }) => handoff | null
 * @param {string} [deps.userDataRoot] - handoffPath 缺失时按 handoffId 定位的根目录
 */
export function createThreadStreamReader({
  core,
  readSessionIndex: readSessionIndexImpl = readSessionIndex,
  readSessionFile: readSessionFileImpl = defaultReadSessionFile,
  userDataRoot = USER_DATA_ROOT,
  readHandoff: readHandoffImpl,
} = {}) {
  if (!core || typeof core.getThread !== 'function') {
    throw new Error('createThreadStreamReader requires a core with getThread');
  }
  const readHandoff = readHandoffImpl || (async ({ agentId, handoffId, handoffPath }) => {
    const resolvedPath = handoffPath
      ? path.resolve(String(handoffPath || '').trim())
      : getContextHandoffFilePath(userDataRoot, agentId, handoffId);
    try {
      return JSON.parse(await fsp.readFile(resolvedPath, 'utf8'));
    } catch {
      return null;
    }
  });

  async function readThreadStream(threadId) {
    const normalizedThreadId = String(threadId || '').trim();
    if (!normalizedThreadId) throw _notFound(threadId);

    const before = await core.getThread(normalizedThreadId);
    if (!before) throw _notFound(normalizedThreadId);

    const chain = Array.isArray(before.sessionChain) ? before.sessionChain : [];
    const sessionIndex = await readSessionIndexImpl(before.agentId);
    const metadataBySession = new Map(
      (Array.isArray(sessionIndex?.sessions) ? sessionIndex.sessions : [])
        .map((s) => [String(s?.id || ''), s?.metadata || {}]),
    );

    // 每棒基础事实（棒内数据按 sessionId 寻址，遍历蓝本来自本次快照）
    const sticks = [];
    for (let i = 0; i < chain.length; i += 1) {
      const entry = chain[i] || {};
      const sessionId = String(entry.sessionId || '').trim();
      const snapshot = sessionId ? await readSessionFileImpl(before.agentId, sessionId) : null;
      const enriched = Array.isArray(snapshot?.runtime?.context?.enrichedMessages)
        ? snapshot.runtime.context.enrichedMessages
        : [];
      const seedInjection = extractSeedInjection(snapshot);
      const seedSegment = locateSeedSegment(enriched, seedInjection);
      sticks.push({
        index: i,
        sessionId,
        role: sessionId === before.headSessionId ? 'head' : (entry.role || 'predecessor'),
        endKind: entry.endKind ?? null,
        successorSessionId: entry.successorSessionId ?? null,
        seedInjection,
        seedSegment,
        snapshotMissing: !snapshot,
        enriched,
      });
    }

    // 接缝校验与响应组装。接缝 = 棒 i（handoff 声明侧，successorSessionId
    // 非空）× 棒 i+1（注入侧，featureStates + 数组区间）；incomplete 挂在
    // 声明侧棒上（描述该接缝是否可切分）。
    const segments = [];
    for (let i = 0; i < sticks.length; i += 1) {
      const stick = sticks[i];
      const successor = stick.successorSessionId ? sticks[i + 1] : null;
      let incomplete = false;
      let incompleteReason = null;
      let handoffId = null;
      let handoffPath = null;
      let seedBoundary = null;

      if (stick.successorSessionId && (!successor || successor.sessionId !== stick.successorSessionId)) {
        incomplete = true;
        incompleteReason = 'chain_broken';
      } else if (successor) {
        const metadata = metadataBySession.get(successor.sessionId) || {};
        handoffId = String(metadata.handoffId || '').trim() || null;
        handoffPath = String(metadata.handoffPath || '').trim() || null;
        if (!handoffId && !handoffPath) {
          incomplete = true;
          incompleteReason = 'handoff_unlinked';
        } else {
          const handoff = await readHandoff({ agentId: before.agentId, handoffId, handoffPath });
          if (!handoff) {
            incomplete = true;
            incompleteReason = 'handoff_unreadable';
          } else {
            handoffId = String(handoff.handoffId || handoffId || '').trim() || null;
            seedBoundary = normalizeSeedBoundary(handoff.seedBoundary);
            if (!seedBoundary) {
              // 旧产物（marker 双落盘之前）：显式不完整，不启发式切分
              incomplete = true;
              incompleteReason = 'seed_boundary_missing';
            } else {
              const injection = successor.seedInjection;
              if (!injection) {
                incomplete = true;
                incompleteReason = 'seed_facts_missing';
              } else if (injection.packageId && handoffId && injection.packageId !== handoffId) {
                incomplete = true;
                incompleteReason = 'package_id_mismatch';
              } else {
                const declared = seedBoundary.seedMessageCount;
                const handoffSeedLength = Array.isArray(handoff.seedMessages)
                  ? handoff.seedMessages.length
                  : null;
                const injectionsInBounds = seedBoundary.appendedInjection
                  .every((item) => item.messageIndex < declared);
                const rangeLength = Number.isInteger(injection.firstMessageSeq)
                  ? injection.lastMessageSeq - injection.firstMessageSeq + 1
                  : null;
                const arrayCount = successor.seedSegment
                  ? successor.seedSegment.inRangeCount
                  : null;
                if (handoffSeedLength !== declared || !injectionsInBounds
                  || declared !== injection.seedCount
                  || rangeLength === null || declared !== rangeLength
                  || arrayCount === null || declared !== arrayCount) {
                  incomplete = true;
                  incompleteReason = 'seed_count_mismatch';
                }
              }
            }
          }
        }
      }

      // 该棒作为 successor 时的渲染边界：seed 段切分成功 → 边界后第一条；
      // 切分失败（seedSegment null）→ 归零保守渲染，接缝已在声明侧标
      // incomplete，UI 按不完整呈现，不静默伪装连续。
      const visibleStartIndex = stick.seedSegment
        ? stick.seedSegment.endIndex + 1
        : 0;

      segments.push({
        index: stick.index,
        sessionId: stick.sessionId,
        role: stick.role,
        endKind: stick.endKind,
        successorSessionId: stick.successorSessionId,
        ...(handoffId ? { handoffId } : {}),
        ...(handoffPath ? { handoffPath } : {}),
        ...(seedBoundary ? { seedBoundary } : {}),
        ...(stick.seedInjection ? { seedInjection: stick.seedInjection } : {}),
        ...(stick.seedSegment
          ? { seedSegment: { startIndex: stick.seedSegment.startIndex, endIndex: stick.seedSegment.endIndex } }
          : {}),
        ...(stick.snapshotMissing ? { snapshotMissing: true } : {}),
        incomplete,
        incompleteReason,
        baseline: {
          count: stick.enriched.length,
          firstSequence: toSequence(stick.enriched[0]?.sequence),
          lastSequence: toSequence(stick.enriched[stick.enriched.length - 1]?.sequence),
        },
        visibleStartIndex,
        // head 棒的消息内容走既有 probe/tail 通道（runtime 内存领先快照），
        // 流接口只给坐标；predecessor 棒返回 seed 段之后的可见消息。
        ...(stick.role !== 'head' ? { messages: stick.enriched.slice(visibleStartIndex) } : {}),
      });
    }

    // 一致性复核：读取期间 head 推进（接力落定）→ 显式冲突，调用方重取。
    const after = await core.getThread(normalizedThreadId);
    if (!after
      || after.headSessionId !== before.headSessionId
      || (Array.isArray(after.sessionChain) ? after.sessionChain.length : 0) !== chain.length) {
      const error = new Error('Thread head changed while reading the stream snapshot');
      error.status = 409;
      error.code = 'thread_stream_conflict';
      error.currentHeadSessionId = after?.headSessionId ?? null;
      throw error;
    }

    // 链投影签名（轮询兜底比对键）：锚链结构与消息基线，不含消息内容。
    const contentHash = createHash('sha1').update(JSON.stringify({
      headSessionId: before.headSessionId,
      segments: segments.map((s) => [
        s.sessionId,
        s.incomplete ? (s.incompleteReason || 'incomplete') : 'ok',
        s.baseline.count,
        s.visibleStartIndex,
      ]),
    })).digest('hex');

    return {
      threadId: before.threadId,
      agentId: before.agentId,
      workspaceId: before.workspaceId ?? null,
      title: before.title ?? null,
      status: before.status,
      headSessionId: before.headSessionId,
      rootSessionId: before.rootSessionId ?? null,
      revision: before.revision,
      contentHash,
      segments,
    };
  }

  return { readThreadStream };
}
