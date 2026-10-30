/**
 * 线程成员归属读取器（ADR-0032 列表口径的服务端数据面）。
 *
 * 会话列表分页/计数（sliceSessionsForWire）需要「会话 → 线程成员」
 * 关系与线程归档状态，但会话索引路径是 3s 轮询高频调用，不走线程
 * 控制面（listThreads 会逐线程解析 head 会话字段）。本读取器只读两
 * 个轻量 JSON——threads/index.json（线程摘要）与 threads/
 * archive-index.json（归档索引，Claw 所有）。文件缺席 / 解析失败返回
 * 空 Map：调用方回退会话级 archived 标志，与前端 phConversationArchived
 * 的回退语义一致。
 *
 * 缓存（stat 先行，与 session-access 的 _indexCache 同一失效模式）：
 * 以 mtime+size 构造版本键，命中路径零读取零解析——threads/index.json
 * 可达 MB 级（千级线程），旧实现「先 readFile+JSON.parse 再比对键」让
 * 每次调用都全量解析，会话列表每轮读两次 membership，主线程 CPU 停顿
 * 显著放大。写方（线程 store / 归档索引）均经 tmp+rename 落盘，mtime
 * 必变；装载完成后复查版本，文件在装载期间被改写时不进缓存。
 *
 * 命中返回同一 Map 实例（按 agent 单槽保留最新版本）：该对象同时作为
 * 侧栏投影缓存（session-helpers 的 _sidebarProjectionCache）的身份键，
 * 调用方只读，不得修改。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { THREADS_ROOT } from './constants.js';

const _memberships = new Map(); // agentId → { key, map }

const INDEX_PATH = path.join(THREADS_ROOT, 'index.json');
const ARCHIVE_PATH = path.join(THREADS_ROOT, 'archive-index.json');

async function statVersion(filePath) {
  try {
    const stat = await fsp.stat(filePath);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return 'missing';
  }
}

async function readJsonOrNull(filePath) {
  try {
    return JSON.parse(await fsp.readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 构造某 agent 的线程成员归属表。
 *
 * @param {string} agentId 线程 index 中的 agentId 字段口径（prebuilt agent id）
 * @returns {Promise<Map<string, {isHead: boolean, archived: boolean}>>}
 *   sessionId → 线程成员事实；该 agent 无线程或数据不可读时为空 Map。
 *   同一文件版本返回同一 Map 实例（只读共享契约）。
 */
export async function readThreadMembership(agentId) {
  const id = String(agentId || '').trim();
  if (!id) return new Map();

  const [indexVersion, archiveVersion] = await Promise.all([
    statVersion(INDEX_PATH), statVersion(ARCHIVE_PATH),
  ]);
  const cacheKey = `${id}|${indexVersion}|${archiveVersion}`;
  const cached = _memberships.get(id);
  if (cached && cached.key === cacheKey) return cached.map;

  const [indexData, archiveData] = await Promise.all([
    readJsonOrNull(INDEX_PATH), readJsonOrNull(ARCHIVE_PATH),
  ]);
  const archivedThreadIds = new Set(
    Object.keys(archiveData?.threads || {}),
  );
  const map = new Map();
  for (const thread of Array.isArray(indexData?.threads) ? indexData.threads : []) {
    if (String(thread?.agentId || '') !== id) continue;
    const headSessionId = String(thread?.headSessionId || '');
    const archived = archivedThreadIds.has(String(thread?.threadId || ''));
    for (const sessionId of Array.isArray(thread?.sessionIds) ? thread.sessionIds : []) {
      map.set(String(sessionId), { isHead: String(sessionId) === headSessionId, archived });
    }
  }
  // 装载期间文件可能已被改写（mtime/size 变化）：此时不要把旧内容写进
  // 缓存，直接返回本次结果，缓存留给后续读以新版本重建（_indexCache 同
  // 语义）。
  const [latestIndex, latestArchive] = await Promise.all([
    statVersion(INDEX_PATH), statVersion(ARCHIVE_PATH),
  ]);
  if (latestIndex === indexVersion && latestArchive === archiveVersion) {
    _memberships.set(id, { key: cacheKey, map });
  }
  return map;
}
