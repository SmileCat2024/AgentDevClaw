/**
 * 线程成员归属读取器（ADR-0032 列表口径的服务端数据面）。
 *
 * 会话列表分页/计数（sliceSessionsForWire）需要「会话 → 线程成员」
 * 关系与线程归档状态，但会话索引路径是 3s 轮询高频调用，不走线程
 * 控制面（listThreads 会逐线程解析 head 会话字段）。本读取器只读两
 * 个轻量 JSON——threads/index.json（线程摘要）与 threads/
 * archive-index.json（归档索引，Claw 所有）——mtime+size 缓存，任一
 * 变化即重建。文件缺席 / 解析失败返回空 Map：调用方回退会话级
 * archived 标志，与前端 phConversationArchived 的回退语义一致。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { THREADS_ROOT } from './constants.js';

let _cache = { key: null, map: new Map() };

async function readJsonWithStat(filePath) {
  try {
    const [raw, stat] = await Promise.all([
      fsp.readFile(filePath, 'utf8'),
      fsp.stat(filePath),
    ]);
    return { data: JSON.parse(raw), key: `${stat.mtimeMs}:${stat.size}` };
  } catch {
    return { data: null, key: 'missing' };
  }
}

/**
 * 构造某 agent 的线程成员归属表。
 *
 * @param {string} agentId 线程 index 中的 agentId 字段口径（prebuilt agent id）
 * @returns {Promise<Map<string, {isHead: boolean, archived: boolean}>>}
 *   sessionId → 线程成员事实；该 agent 无线程或数据不可读时为空 Map
 */
export async function readThreadMembership(agentId) {
  const id = String(agentId || '').trim();
  if (!id) return new Map();
  const [indexRes, archiveRes] = await Promise.all([
    readJsonWithStat(path.join(THREADS_ROOT, 'index.json')),
    readJsonWithStat(path.join(THREADS_ROOT, 'archive-index.json')),
  ]);
  const cacheKey = `${id}|${indexRes.key}|${archiveRes.key}`;
  if (_cache.key === cacheKey) return _cache.map;

  const archivedThreadIds = new Set(
    Object.keys(archiveRes.data?.threads || {}),
  );
  const map = new Map();
  for (const thread of Array.isArray(indexRes.data?.threads) ? indexRes.data.threads : []) {
    if (String(thread?.agentId || '') !== id) continue;
    const headSessionId = String(thread?.headSessionId || '');
    const archived = archivedThreadIds.has(String(thread?.threadId || ''));
    for (const sessionId of Array.isArray(thread?.sessionIds) ? thread.sessionIds : []) {
      map.set(String(sessionId), { isHead: String(sessionId) === headSessionId, archived });
    }
  }
  _cache = { key: cacheKey, map };
  return map;
}
