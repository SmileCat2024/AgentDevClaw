/**
 * 主题簇标注存储（title / summary / docs / commits）。
 *
 * 主题簇是 session-relations 投影派生的事实（显式会话引用连通分量），
 * 簇 id 由成员线程集合哈希派生——成员随引用演进增长，id 会漂移。标注是
 * 用户/agent 写在簇上的持久信息，不能因簇增长而静默丢失：
 * - 写入时随标注记录成员快照（threadIds）；
 * - 读取时精确命中簇 id 优先；未命中时，成员快照是当前簇成员真子集的
 *   旧记录按 updatedAt 最新继承（覆盖「簇只增长」的主线场景）。
 * 分裂（旧记录成员不完全落在新簇内）不继承——宁可丢弃也不误贴到别的簇。
 *
 * docs / commits 是自由文本条目数组（参考文档 / 相关提交），仅约束为
 * 非空字符串数组；内容形态（路径、URL、hash+说明）由写入方决定。
 * 存储时空数组不落键，与存量无这两字段的条目格式保持一致。
 *
 * 存储位置：<dataRoot>/workspaces/<agentId>/topic-notes.json（tmp + rename
 * 原子写）。标注是持久用户数据而非投影缓存，不随 cache.json 重建。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

const text = value => (typeof value === 'string' ? value.trim() : '');

/** 数组字段清洗：仅字符串数组有意义；trim 并丢弃空串，条目顺序保留。 */
const textList = value => (Array.isArray(value) ? value.map(item => text(item)).filter(Boolean) : []);

/** 标注是否有任何可继承内容（四个内容字段任一非空）。 */
const hasNoteContent = note => Boolean(
  text(note?.title) || text(note?.summary) || textList(note?.docs).length || textList(note?.commits).length
);

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
 * 返回 { title, summary, docs, commits } 或 null（无任何可用标注）。
 */
export function resolveTopicNote(notes, { clusterId = '', memberThreadIds = [] } = {}) {
  if (!clusterId) return null;
  const exact = notes[clusterId];
  if (exact && hasNoteContent(exact)) {
    return { title: text(exact.title), summary: text(exact.summary), docs: textList(exact.docs), commits: textList(exact.commits) };
  }
  const members = new Set(memberThreadIds.filter(Boolean));
  if (members.size === 0) return null;
  let best = null;
  for (const note of Object.values(notes)) {
    const snapshotIds = Array.isArray(note?.threadIds) ? note.threadIds : [];
    if (snapshotIds.length === 0 || snapshotIds.length >= members.size + 1) continue;
    if (!snapshotIds.every(id => members.has(id))) continue; // 分裂/不相干不继承
    if (!hasNoteContent(note)) continue;
    if (!best || text(note.updatedAt) > text(best.updatedAt)) best = note;
  }
  if (!best) return null;
  return { title: text(best.title), summary: text(best.summary), docs: textList(best.docs), commits: textList(best.commits) };
}

/**
 * 写入一条簇标注（整体替换该簇条目）。title / summary / docs / commits
 * 全部为空时删除条目（空标注无继承价值，避免文件积累噪音）。数组字段
 * 空时不落键。返回写后该簇生效标注。
 */
export async function saveTopicNote({ dataRoot, agentId, clusterId, title = '', summary = '', docs = [], commits = [], threadIds = [] }) {
  const id = text(clusterId);
  if (!id) throw new Error('clusterId is required');
  const cleanTitle = text(title);
  const cleanSummary = text(summary);
  const cleanDocs = textList(docs);
  const cleanCommits = textList(commits);
  const filePath = topicNotesPath(dataRoot, agentId);
  let raw = {};
  try {
    raw = JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    raw = {};
  }
  const notes = raw?.notes && typeof raw.notes === 'object' && !Array.isArray(raw.notes) ? raw.notes : {};
  const hasContent = Boolean(cleanTitle || cleanSummary || cleanDocs.length || cleanCommits.length);
  if (hasContent) {
    notes[id] = {
      title: cleanTitle,
      summary: cleanSummary,
      ...(cleanDocs.length ? { docs: cleanDocs } : {}),
      ...(cleanCommits.length ? { commits: cleanCommits } : {}),
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
  return hasContent ? { title: cleanTitle, summary: cleanSummary, docs: cleanDocs, commits: cleanCommits } : null;
}
