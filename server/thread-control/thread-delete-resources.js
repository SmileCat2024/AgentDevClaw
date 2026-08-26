/**
 * Thread Delete Resources — 删除级联的跨目录清理器（T005 §清理范围生产装配）
 *
 * thread-delete.js 是纯编排（线程域：record / index / board / archive）；
 * 本模块提供它要触碰的 Claw 数据域的清理器：
 *
 *   - removeSessions  全部成员 Session：session index 记录 + 会话文件 +
 *                     运行恢复跟踪（open-sessions.json，best-effort）+
 *                     search index 失效（best-effort，持久索引在下次重建时
 *                     按 index 成员裁剪）
 *   - removeHandoffs  context-handoffs/<agent>/ 中 sourceSessionId 属于
 *                     成员集合的交接包（handoff 必须随 Thread 一起删除，
 *                     否则留下指向已删会话的孤儿材料）
 *   - clearRuntimes   成员 session 的 runtime envelope 状态
 *                     （inbox / execution state / envelope 注册表，内存态）
 *
 * 每个清理器都幂等：对象不存在视为成功（ENOENT 吞掉）；真正的 IO 错误向上
 * 抛，由编排层收集进结构化残留列表。session index 的移除走注入的
 * updateSessionIndex 事务（与 deletePrebuiltSession 同路径，activeSessionId
 * 回退规则一致）。
 *
 * 路径 / 状态源默认指向生产实现；测试经同名参数注入临时目录与 stub，
 * 不触碰真实用户数据目录（测试约定）。
 */

import fsp from 'node:fs/promises';
import path from 'node:path';

import {
  getPrebuiltSessionFilePath,
  updateSessionIndex,
} from '../shared/session-access.js';
import { sanitizeSessionFragment } from '../shared/string-helpers.js';
import { USER_DATA_ROOT } from '../shared/constants.js';
import { getContextHandoffsRoot } from '../context-continuity/handoff-package.js';
import { getManagedRuntimeKey } from '../shared/agent-access.js';
import { releaseRuntimeState } from '../runtime-call-envelope.js';
import { removeOpenSession } from '../shared/open-sessions-tracker.js';
import { invalidateSearchIndex } from '../routes/session-search-index.js';

function cleanText(value) {
  return String(value || '').trim();
}

function uniqueIds(sessionIds) {
  return Array.from(new Set((Array.isArray(sessionIds) ? sessionIds : []).map(cleanText).filter(Boolean)));
}

/**
 * @param {object} [deps]
 * @param {string} [deps.userDataRoot] - context-handoffs 根的用户数据根（缺省 USER_DATA_ROOT）
 * @param {Function} [deps.sessionFileResolver] - (agentId, sessionId) => 会话文件路径
 * @param {Function} [deps.sessionIndexUpdate] - (agentId, mutFn) => Promise，session index 事务
 * @param {Function} [deps.removeOpenSessionImpl] - (agentId, sessionId) => Promise
 * @param {Function} [deps.invalidateSearchIndexImpl] - (agentId) => void
 */
export function createThreadDeleteResources({
  userDataRoot = null,
  sessionFileResolver = getPrebuiltSessionFilePath,
  sessionIndexUpdate = updateSessionIndex,
  removeOpenSessionImpl = removeOpenSession,
  invalidateSearchIndexImpl = invalidateSearchIndex,
} = {}) {
  const handoffsRoot = (userDataRoot || USER_DATA_ROOT).trim();

  /** 删除全部成员 Session 数据（index 记录 / 会话文件 / 运行恢复 / search）。 */
  async function removeSessions(agentId, sessionIds) {
    const normalizedAgentId = cleanText(agentId);
    const ids = uniqueIds(sessionIds);
    if (ids.length === 0) return { removed: [] };
    const removed = [];

    // session index 记录移除（事务；activeSessionId 回退到剩余首个会话，
    // 与 deletePrebuiltSession 的语义一致）。index 中不存在的成员不产生
    // 变更（幂等）。
    const memberSet = new Set(ids);
    const updated = await sessionIndexUpdate(normalizedAgentId, (index) => {
      if (!index.sessions.some((s) => memberSet.has(s.id))) return index;
      const wasActive = index.activeSessionId != null && memberSet.has(index.activeSessionId);
      const remaining = index.sessions.filter((s) => !memberSet.has(s.id));
      return {
        activeSessionId: wasActive ? (remaining[0]?.id ?? null) : index.activeSessionId,
        sessions: remaining,
      };
    });
    removed.push({ kind: 'session-index', count: ids.length });

    // 会话文件（缺失 = 已删除，幂等成功）。
    for (const sessionId of ids) {
      await fsp.rm(sessionFileResolver(normalizedAgentId, sessionId), { force: true }).catch((error) => {
        if (error?.code !== 'ENOENT') throw error;
      });
      removed.push({ kind: 'session-file', sessionId });
    }

    // 运行恢复跟踪与 search index 是瞬态加速层：best-effort，失败不产生
    // 线程数据残留（恢复卡片下次校验时自行丢弃已删会话）。
    for (const sessionId of ids) {
      await removeOpenSessionImpl(normalizedAgentId, sessionId).catch(() => {});
    }
    invalidateSearchIndexImpl(normalizedAgentId);

    return { removed, indexRevision: Number(updated?.revision) || null };
  }

  /** 删除 sourceSessionId 属于成员集合的 handoff 包。 */
  async function removeHandoffs(agentId, sessionIds) {
    const normalizedAgentId = cleanText(agentId);
    const memberSet = new Set(uniqueIds(sessionIds));
    const dirPath = path.join(getContextHandoffsRoot(handoffsRoot), sanitizeSessionFragment(normalizedAgentId));
    const entries = await fsp.readdir(dirPath, { withFileTypes: true }).catch((error) => {
      if (error?.code === 'ENOENT') return [];
      throw error;
    });
    const removed = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const filePath = path.join(dirPath, entry.name);
      let handoff;
      try {
        handoff = JSON.parse(await fsp.readFile(filePath, 'utf8'));
      } catch {
        continue; // 不可解析的文件不属于可识别的 handoff 范围，不动
      }
      const sourceSession = cleanText(handoff?.sourceSessionId);
      if (sourceSession && memberSet.has(sourceSession)) {
        await fsp.rm(filePath, { force: true });
        removed.push({ handoffId: cleanText(handoff?.handoffId) || entry.name });
      }
    }
    return { removed };
  }

  /** 释放成员 session 的 runtime envelope 状态（内存态，幂等）。 */
  function clearRuntimes(agentId, sessionIds) {
    const normalizedAgentId = cleanText(agentId);
    const ids = uniqueIds(sessionIds);
    for (const sessionId of ids) {
      releaseRuntimeState(getManagedRuntimeKey(normalizedAgentId, sessionId));
    }
    return { removed: ids };
  }

  return { removeSessions, removeHandoffs, clearRuntimes };
}
