/**
 * 主题簇标注存储（title / summary）。
 *
 * 主题簇是 session-relations 投影派生的事实（显式会话引用连通分量），
 * 簇 id 由成员线程集合哈希派生——成员随引用演进增长，id 会漂移。标注是
 * 用户/agent 写在簇上的持久信息，不能因簇增长而静默丢失：
 * - 写入时随标注记录成员快照（threadIds）；
 * - 读取时精确命中簇 id 优先；未命中时，成员快照是当前簇成员真子集的
 *   旧记录按 updatedAt 最新继承（覆盖「簇只增长」的主线场景）。
 * 分裂（旧记录成员不完全落在新簇内）不继承——宁可丢弃也不误贴到别的簇。
 *
 * 存储位置：<dataRoot>/workspaces/<agentId>/topic-notes.json（tmp + rename
 * 原子写）。标注是持久用户数据而非投影缓存，不随 cache.json 重建。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

const text = value => (typeof value === 'string' ? value.trim() : '');

export function topicNotesPath(dataRoot, agentId) {
  return path.join(dataRoot, 'workspaces', agentId, 'topic-notes.json');
}

export async function loadTopicNotes(dataRoot, agentId) {
  try {
    const raw = JSON.parse(await fs.readFile(topicNotesPath(dataRoot, agentId), 'utf8'));
    const notes = raw?.notes;
    if (!notes || typeof notes !== 'object' || Array.isArray(notes)) return {};
    return notes;
  } catch {
    return {};
  }
}

/**
 * 解析簇当前生效的标注：精确命中簇 id 优先，否则按成员真子集继承最新。
 * 返回 { title, summary } 或 null（无任何可用标注）。
 */
export function resolveTopicNote(notes, { clusterId = '', memberThreadIds = [] } = {}) {
  if (!clusterId) return null;
  const exact = notes[clusterId];
  if (exact && (text(exact.title) || text(exact.summary))) {
    return { title: text(exact.title), summary: text(exact.summary) };
  }
  const members = new Set(memberThreadIds.filter(Boolean));
  if (members.size === 0) return null;
  let best = null;
  for (const note of Object.values(notes)) {
    const snapshotIds = Array.isArray(note?.threadIds) ? note.threadIds : [];
    if (snapshotIds.length === 0 || snapshotIds.length >= members.size + 1) continue;
    if (!snapshotIds.every(id => members.has(id))) continue; // 分裂/不相干不继承
    if (!text(note.title) && !text(note.summary)) continue;
    if (!best || text(note.updatedAt) > text(best.updatedAt)) best = note;
  }
  if (!best) return null;
  return { title: text(best.title), summary: text(best.summary) };
}

/**
 * 写入一条簇标注（整体替换该簇条目）。title 与 summary 同时为空时删除
 * 条目（空标注无继承价值，避免文件积累噪音）。返回写后该簇生效标注。
 */
export async function saveTopicNote({ dataRoot, agentId, clusterId, title = '', summary = '', threadIds = [] }) {
  const id = text(clusterId);
  if (!id) throw new Error('clusterId is required');
  const cleanTitle = text(title);
  const cleanSummary = text(summary);
  const filePath = topicNotesPath(dataRoot, agentId);
  let raw = {};
  try {
    raw = JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    raw = {};
  }
  const notes = raw?.notes && typeof raw.notes === 'object' && !Array.isArray(raw.notes) ? raw.notes : {};
  if (cleanTitle || cleanSummary) {
    notes[id] = {
      title: cleanTitle,
      summary: cleanSummary,
      threadIds: Array.isArray(threadIds) ? threadIds.filter(Boolean) : [],
      updatedAt: new Date().toISOString(),
    };
  } else {
    delete notes[id];
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  await fs.writeFile(tmp, JSON.stringify({ version: 1, notes }, null, 2));
  await fs.rename(tmp, filePath);
  return cleanTitle || cleanSummary ? { title: cleanTitle, summary: cleanSummary } : null;
}
