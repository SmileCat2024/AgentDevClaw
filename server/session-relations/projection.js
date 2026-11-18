/**
 * 会话引用线程关联投影（docs/plans/2026-11-14-session-reference-thread-cluster.md）。
 *
 * 从会话快照中提取显式引用（source: session-reference 且以「[会话引用]」开头的
 * 系统消息），把引用目标解析到线程（threads/index.json 现值反查），聚合为
 * thread → thread 边。边口径只认用户显式引用：读取事件、正文裸 ID、账本
 * reminder（[会话引用账本]，前缀不同不命中 content 门）都不构成边。
 *
 * 派生投影而非事实源：缓存可随时删除重建，不构成第二权威。缓存按会话
 * updatedAt 水位增量刷新——索引记录未变化的会话直接复用上次抽取结果，
 * 只有变化（或新出现）的会话重扫快照。线程归属在投影时刻用 threads/
 * index.json 现值解析，归属变化在下一次刷新时自然生效。
 *
 * 只读扫描：快照只读不写；缓存落 dataRoot/session-relations/cache.json
 * （tmp + rename 原子写）。SQLite 索引以 readOnly 连接打开，无 index.db
 * 时回退 index.json（plain 存储与测试数据根的形态）。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { USER_DATA_ROOT } from '../shared/constants.js';
import { resolveSessionStoreDir } from '../shared/session-storage.js';
import { loadTopicNotes, resolveTopicNote } from './topic-notes.js';

const CACHE_SCHEMA_VERSION = 2;
// 投影新鲜度：超过该时长的下一次查询触发增量刷新（多数会话未变，成本低）。
const REFRESH_MAX_AGE_MS = 10 * 60 * 1000;

const text = value => (typeof value === 'string' ? value : '');
const safeFragment = value => typeof value === 'string' && /^[a-zA-Z0-9_-]+$/.test(value);

/**
 * 从单条引用 reminder 行解析引用目标。
 *
 * 支持的行形态（首 token 即寻址身份）：
 * - 线程引用（新）  ：- wt-xxx「标题」 — agentId: ph（… 线程对话 · 被引一代: sid「t」 …）
 * - 会话引用（现役）：- sid「标题」 — agentId: ph（…）
 * - 会话引用（历史）：- sid「标题」 — agent: agent/type（…）
 * - 会话引用（更早）：- sid「标题」 (agent/type)
 * 解析失败的行忽略（reminder 里的引导语、收尾语天然不命中）。
 */
export function parseReferenceLine(line) {
  const match = line.match(/^-\s+(\S+?)(?:「(.*?)」)?\s+—\s+(agentId|agent):\s*([^\s（(]+)/);
  if (match) {
    const id = match[1];
    const agent = match[3] === 'agent' ? match[4].split('/')[0] : match[4];
    return { kind: id.startsWith('wt-') ? 'thread' : 'session', id, agentId: agent, titleHint: match[2] || '' };
  }
  const legacy = line.match(/^-\s+(\S+?)(?:「(.*?)」)?\s+\(([^/\s)]+)\/[^)]+\)/);
  if (legacy) {
    return { kind: legacy[1].startsWith('wt-') ? 'thread' : 'session', id: legacy[1], agentId: legacy[3], titleHint: legacy[2] || '' };
  }
  return null;
}

/**
 * 提取一个会话快照里的引用观察。content 门是唯一信任边界：只有
 * source === 'session-reference' 且以 '[会话引用]' 开头的消息才解析；
 * 账本 reminder（'[会话引用账本]'）与其他来源（time-awareness 等）不命中。
 */
export function extractReferenceObservations(messages) {
  const refs = [];
  if (!Array.isArray(messages)) return refs;
  for (const message of messages) {
    if (message?.role !== 'system' || message?.source !== 'session-reference') continue;
    const content = text(message.content);
    if (!content.startsWith('[会话引用]')) continue;
    for (const line of content.split('\n')) {
      const parsed = parseReferenceLine(line);
      if (parsed) refs.push(parsed);
    }
  }
  return refs;
}

async function listDirNames(dir) {
  try {
    return (await fs.readdir(dir, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name);
  } catch {
    return [];
  }
}

/**
 * 枚举数据根内的规范会话存储：workspaces/<name>/sessions（工作空间 agent）、
 * prebuilt-sessions/<name>（其他 prebuilt）、agents/<name>/sessions（plain，
 * agentId 带 plain: 前缀防与工作空间同名冲突）。返回 key（"<agentId>/<sessionId>"）
 * → { dir, record } 的索引记录表；无索引记录的目录天然跳过。
 */
export async function enumerateSessionRecords(dataRoot) {
  const storeDirs = [];
  const names = new Set([
    ...await listDirNames(path.join(dataRoot, 'workspaces')),
    ...await listDirNames(path.join(dataRoot, 'prebuilt-sessions')),
  ]);
  for (const name of names) {
    storeDirs.push({
      agentId: name,
      dir: resolveSessionStoreDir(name, dataRoot),
    });
  }
  for (const name of await listDirNames(path.join(dataRoot, 'agents'))) {
    storeDirs.push({ agentId: `plain:${name}`, dir: path.join(dataRoot, 'agents', name, 'sessions') });
  }

  const records = new Map();
  for (const store of storeDirs) {
    let sessionRecords = null;
    const dbPath = path.join(store.dir, 'index.db');
    try {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        sessionRecords = db.prepare('SELECT record FROM sessions').all().map(row => JSON.parse(row.record));
      } finally {
        db.close();
      }
    } catch {
      try {
        const raw = JSON.parse(await fs.readFile(path.join(store.dir, 'index.json'), 'utf8'));
        if (Array.isArray(raw.sessions)) sessionRecords = raw.sessions;
      } catch { /* 无索引的存储目录跳过 */ }
    }
    if (!sessionRecords) continue;
    for (const record of sessionRecords) {
      const id = text(record?.id);
      if (!safeFragment(id)) continue;
      records.set(`${store.agentId}/${id}`, {
        dir: store.dir,
        sessionId: id,
        title: text(record?.title),
        projectId: text(record?.projectId),
        openDirectory: text(record?.openDirectory),
        updatedAt: text(record?.updatedAt),
      });
    }
  }
  return records;
}

/**
 * 线程归属表：sessionId（含所属 agent 限定）→ threadId，以及 threadId →
 * { title, agentId }。归属以 threads/index.json 现值为准；文件缺失 / 解析
 * 失败返回空结构（投影退化为无边，不报错）。
 */
export async function readThreadMembership(dataRoot) {
  const membership = new Map();
  const threads = new Map();
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(dataRoot, 'threads', 'index.json'), 'utf8'));
    for (const thread of Array.isArray(parsed?.threads) ? parsed.threads : []) {
      const threadId = text(thread?.threadId);
      if (!safeFragment(threadId)) continue;
      const agentId = text(thread?.workspaceId) || text(thread?.agentId);
      const sessionIds = Array.isArray(thread?.sessionIds) ? thread.sessionIds.map(text).filter(Boolean) : [];
      threads.set(threadId, {
        title: text(thread?.title),
        agentId,
        generations: sessionIds.length,
        sessionIds,
        updatedAt: text(thread?.updatedAt) || text(thread?.createdAt),
      });
      for (const sessionId of sessionIds) {
        membership.set(`${agentId}/${text(sessionId)}`, threadId);
      }
    }
  } catch { /* 无线程数据：投影无边 */ }
  return { membership, threads };
}

function cacheFilePath(dataRoot) {
  return path.join(dataRoot, 'session-relations', 'cache.json');
}

async function loadCache(dataRoot) {
  try {
    const parsed = JSON.parse(await fs.readFile(cacheFilePath(dataRoot), 'utf8'));
    if (parsed?.schemaVersion === CACHE_SCHEMA_VERSION && parsed.sessions && typeof parsed.sessions === 'object') {
      return parsed;
    }
  } catch { /* 无缓存或损坏：全量重建 */ }
  return { schemaVersion: CACHE_SCHEMA_VERSION, builtAt: '', sessions: {} };
}

async function scanSessionObservations(record) {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(record.dir, `${record.sessionId}.json`), 'utf8'));
    return extractReferenceObservations(parsed?.runtime?.context?.messages);
  } catch {
    return []; // 快照缺失 / 不可解析：该会话无观察（水位照记，避免每次重试）
  }
}

/**
 * 增量刷新投影快照。
 *
 * @param {object} options
 * @param {string} options.dataRoot 数据根（测试可指向隔离副本）
 * @param {boolean} options.force 忽略缓存逐会话重扫（缓存损坏 / 手动重建）
 * @param {() => void} options.onProgress 进度回调（全量首建时低频通报）
 */
export async function buildRelationsSnapshot({ dataRoot = USER_DATA_ROOT, force = false, onProgress = () => {} } = {}) {
  const previous = force ? { schemaVersion: CACHE_SCHEMA_VERSION, builtAt: '', sessions: {} } : await loadCache(dataRoot);
  const records = await enumerateSessionRecords(dataRoot);

  const sessions = {};
  let scanned = 0;
  for (const [key, record] of records) {
    const cached = previous.sessions[key];
    if (cached && cached.updatedAt === record.updatedAt) {
      sessions[key] = cached;
      continue;
    }
    sessions[key] = { updatedAt: record.updatedAt, refs: await scanSessionObservations(record) };
    scanned++;
    if (scanned % 500 === 0) onProgress(scanned);
  }

  const { membership, threads } = await readThreadMembership(dataRoot);
  const edges = new Map(); // "<src>\u0000<dst>" → { source, target, count, lastSeenAt }
  let unresolvedTargets = 0;
  for (const [key, entry] of Object.entries(sessions)) {
    const sourceThread = membership.get(key);
    if (!sourceThread) continue;
    for (const ref of entry.refs) {
      const targetThread = ref.kind === 'thread' ? ref.id : membership.get(`${ref.agentId}/${ref.id}`);
      if (!targetThread || targetThread === sourceThread) {
        if (targetThread !== sourceThread) unresolvedTargets++;
        continue;
      }
      const edgeKey = `${sourceThread}\u0000${targetThread}`;
      const edge = edges.get(edgeKey) || { source: sourceThread, target: targetThread, count: 0, lastSeenAt: '' };
      edge.count++;
      if (entry.updatedAt > edge.lastSeenAt) edge.lastSeenAt = entry.updatedAt;
      edges.set(edgeKey, edge);
    }
  }

  // 全量会话元数据（records 枚举的所有会话，非仅引用涉及会话）：主题簇
  // 的线程标题回退要用 head session 标题，而 head session 多数没有引用
  // 观察，只从 sessions 派生会漏。体积每会话约百字节，全量可承受。
  const sessionMeta = Object.fromEntries([...records.entries()].map(([key, record]) => [key, {
    title: text(record?.title),
    projectId: text(record?.projectId),
    openDirectory: text(record?.openDirectory),
    updatedAt: text(record?.updatedAt),
  }]));
  const snapshot = {
    schemaVersion: CACHE_SCHEMA_VERSION,
    builtAt: new Date().toISOString(),
    sessions,
    sessionMeta,
    edges: [...edges.values()],
    unresolvedTargets,
    threadTitles: Object.fromEntries([...threads.entries()].map(([id, t]) => [id, t.title])),
    threadAgents: Object.fromEntries([...threads.entries()].map(([id, t]) => [id, t.agentId])),
    threadMeta: Object.fromEntries([...threads.entries()].map(([id, t]) => [id, {
      title: t.title,
      agentId: t.agentId,
      generations: t.generations,
      sessionIds: t.sessionIds,
      updatedAt: t.updatedAt,
    }])),
  };

  await fs.mkdir(path.dirname(cacheFilePath(dataRoot)), { recursive: true });
  const tmp = `${cacheFilePath(dataRoot)}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(snapshot));
  await fs.rename(tmp, cacheFilePath(dataRoot));
  return snapshot;
}

// 进程内快照备忘 + 重建串行化：并发查询共享同一次重建。
const _memo = new Map(); // dataRoot → { snapshot, builtAtMs, refreshPromise }

async function ensureSnapshot(dataRoot, { force = false, freshnessMs = REFRESH_MAX_AGE_MS } = {}) {
  const cached = _memo.get(dataRoot);
  const fresh = cached && !force && Date.now() - cached.builtAtMs < freshnessMs;
  if (fresh) return cached.snapshot;
  if (cached?.refreshPromise) return cached.refreshPromise;
  const refreshPromise = buildRelationsSnapshot({ dataRoot, force: force || !cached })
    .then(snapshot => {
      _memo.set(dataRoot, { snapshot, builtAtMs: Date.now(), refreshPromise: null });
      return snapshot;
    })
    .catch(error => {
      if (cached) cached.refreshPromise = null;
      throw error;
    });
  if (cached) cached.refreshPromise = refreshPromise;
  else _memo.set(dataRoot, { snapshot: null, builtAtMs: 0, refreshPromise });
  return refreshPromise;
}

/**
 * 从投影快照计算一条线程的一跳邻居与所在关联群（无向连通分量）。
 * 边仅显式引用口径；计数是重建观察值（含跨代重复观察），作相对权重
 * 提示而非精确账本。
 */
function buildAdjacency(snapshot) {
  const adjacency = new Map(); // threadId → Map<threadId, {out, in, count, lastSeenAt} | null>
  const add = (a, b, direction, lastSeenAt, weight = 1) => {
    if (!adjacency.has(a)) adjacency.set(a, new Map());
    if (!adjacency.has(b)) adjacency.set(b, new Map());
    const forward = adjacency.get(a).get(b) || { out: 0, in: 0, lastSeenAt: '' };
    forward[direction] += weight;
    forward.count = forward.out + forward.in;
    if (lastSeenAt > forward.lastSeenAt) forward.lastSeenAt = lastSeenAt;
    adjacency.get(a).set(b, forward);
    if (!adjacency.get(b).has(a)) adjacency.get(b).set(a, null);
  };
  for (const edge of Array.isArray(snapshot?.edges) ? snapshot.edges : []) {
    add(edge.source, edge.target, 'out', edge.lastSeenAt, edge.count || 1);
    add(edge.target, edge.source, 'in', edge.lastSeenAt, edge.count || 1);
  }
  return adjacency;
}

function computeRelationsFromSnapshot(snapshot, threadId) {
  const adjacency = buildAdjacency(snapshot);
  const known = adjacency.get(threadId) || null;
  const neighbors = known
    ? [...known.entries()]
        .filter(([, link]) => link)
        .map(([id, link]) => ({
          threadId: id,
          title: text(snapshot.threadTitles[id]),
          agentId: text(snapshot.threadAgents[id]),
          direction: link.out && link.in ? 'both' : link.out ? 'references' : 'referenced-by',
          count: link.count,
          lastSeenAt: link.lastSeenAt,
        }))
        .sort((a, b) => b.count - a.count || a.threadId.localeCompare(b.threadId))
    : [];

  // 关联群（无向连通分量）规模：从 threadId 起 BFS。孤立线程群大小为 1。
  const visited = new Set([threadId]);
  const queue = [threadId];
  const memberThreadIds = [];
  while (queue.length) {
    const current = queue.pop();
    memberThreadIds.push(current);
    for (const next of adjacency.get(current)?.keys() || []) {
      if (!visited.has(next)) { visited.add(next); queue.push(next); }
    }
  }
  return { found: Boolean(known), neighbors, component: { size: visited.size, memberThreadIds: memberThreadIds.sort() } };
}

function timestampOf(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const raw = text(value);
  if (/^[0-9]{11,}$/.test(raw)) return Number(raw);
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function componentForThread(adjacency, threadId) {
  const visited = new Set([threadId]);
  const queue = [threadId];
  while (queue.length) {
    const current = queue.pop();
    for (const next of adjacency.get(current)?.keys() || []) {
      if (!visited.has(next)) {
        visited.add(next);
        queue.push(next);
      }
    }
  }
  return [...visited].sort();
}

function computeTopicGroupsFromSnapshot(snapshot, { agentId = '', projectId = '', openDirectory = '' } = {}) {
  const adjacency = buildAdjacency(snapshot);
  const seen = new Set();
  const groups = [];
  const meta = snapshot.threadMeta || {};
  const sessionMeta = snapshot.sessionMeta || {};
  for (const threadId of adjacency.keys()) {
    if (seen.has(threadId)) continue;
    const memberThreadIds = componentForThread(adjacency, threadId);
    memberThreadIds.forEach((id) => seen.add(id));
    const members = memberThreadIds.map((id) => ({ threadId: id, ...(meta[id] || {}) }));
    const filtered = members.filter((member) => {
      if (agentId && member.agentId !== agentId) return false;
      if (!projectId && !openDirectory) return true;
      return (snapshot.threadMeta?.[member.threadId]?.sessionIds || []).some((sessionId) => {
        const session = sessionMeta[`${member.agentId}/${sessionId}`];
        if (!session) return false;
        if (projectId && session.projectId !== projectId) return false;
        return !openDirectory || session.openDirectory === openDirectory;
      });
    });
    if (filtered.length === 0) continue;
    const latestForMember = (member) => {
      const values = [member.updatedAt];
      for (const sessionId of member.sessionIds || []) {
        const session = sessionMeta[`${member.agentId}/${sessionId}`];
        if (session) values.push(session.updatedAt);
      }
      return Math.max(...values.map(timestampOf));
    };
    const latest = filtered.reduce((best, member) => Math.max(best, latestForMember(member)), 0);
    const sortedMembers = [...filtered].sort((a, b) => latestForMember(b) - latestForMember(a) || a.threadId.localeCompare(b.threadId));
    // 线程标题回退链：thread record 标题（近期线程普遍未维护）→ 该线程
    // 最新一代会话的标题。看板与工具面都以会话标题兜底，避免大面积
    // 「未命名」。
    const threadTitle = (member) => {
      if (text(member.title) || text(snapshot.threadTitles?.[member.threadId])) {
        return text(member.title || snapshot.threadTitles?.[member.threadId]);
      }
      const headSessionId = Array.isArray(member.sessionIds) ? (member.sessionIds.at(-1) || '') : '';
      return text(sessionMeta[`${member.agentId}/${headSessionId}`]?.title);
    };
    groups.push({
      id: `relation_${crypto.createHash('sha1').update(memberThreadIds.join('\0')).digest('hex').slice(0, 12)}`,
      threadIds: memberThreadIds,
      threads: sortedMembers.map((member) => ({
        threadId: member.threadId,
        title: threadTitle(member),
        agentId: text(member.agentId),
        updatedAt: new Date(latestForMember(member) || 0).toISOString(),
        generations: member.generations || 0,
        sessionIds: Array.isArray(member.sessionIds) ? member.sessionIds : [],
        headSessionId: Array.isArray(member.sessionIds) ? (member.sessionIds.at(-1) || '') : '',
      })),
      fallbackTitle: sortedMembers.map(threadTitle).find(Boolean) || '',
      updatedAt: new Date(latest || 0).toISOString(),
      memberCount: filtered.length,
    });
  }
  return groups.sort((a, b) => timestampOf(b.updatedAt) - timestampOf(a.updatedAt) || a.id.localeCompare(b.id));
}

/** 投影就绪等待上限：冷启动首建可能分钟级，请求侧超时即降级（身份不受影响）。 */
const SNAPSHOT_WAIT_MS = 500;

/**
 * 投影等待（stale-while-revalidate）：进程内已有快照（哪怕超过新鲜度
 * 窗口）立即服务旧值并触发后台刷新——真实数据上增量刷新的成本大头是
 * 枚举全部存储目录（逐个开 SQLite 比对水位，约分钟级），若让查询等它，
 * 每个新鲜度周期都会有一段全部降级 partial 的窗口；关联是可陈旧的派生
 * 提示（builtAt 随响应披露），陈旧服务优于缺席。只有进程内尚无快照
 * （首建）或 force 重建时才走 500ms 竞速，超时降级 partial。
 *
 * 冷启动种子：进程内无快照（服务刚重启）而磁盘上有上次投影时，先把磁盘
 * 快照种进备忘并立即以它服务（builtAt 如实披露数据时点），再走常规增量
 * 刷新。没有种子的话，重启后的首建枚举全部存储目录可达分钟级，这段窗口
 * 内所有查询都降级 partial（历史事故：关联群看板重启后长时间误报空）。
 * 种子走增量路径（force=false）：水位未变的会话复用磁盘缓存，只有变化的
 * 会话重扫。
 */
async function waitSnapshot(dataRoot, force, freshnessMs) {
  if (!force) {
    const cached = _memo.get(dataRoot);
    if (cached?.snapshot) {
      ensureSnapshot(dataRoot, { freshnessMs }).catch(() => {}); // 后台刷新，共享同一 promise
      return Promise.resolve(cached.snapshot);
    }
    const diskSnapshot = await loadCache(dataRoot);
    if (diskSnapshot.builtAt) {
      // 先种备忘再触发刷新：ensureSnapshot 看到 cached 存在即走增量（force
      // 保持 false），而不是把磁盘缓存弃掉做全量重扫。
      _memo.set(dataRoot, { snapshot: diskSnapshot, builtAtMs: 0, refreshPromise: null });
      ensureSnapshot(dataRoot, { freshnessMs }).catch(() => {}); // 后台增量刷新
      return diskSnapshot;
    }
  }
  return Promise.race([
    ensureSnapshot(dataRoot, { force, freshnessMs }).then(snapshot => ({ snapshot })),
    new Promise(resolve => setTimeout(() => resolve({ snapshot: null }), SNAPSHOT_WAIT_MS)),
  ]).then(result => result.snapshot);
}

/**
 * 线程关联查询：解析目标身份（threadId 直连或 agentId+sessionId 反查归属）
 * 并返回一跳邻居与关联群规模。
 *
 * 身份解析只读 threads/index.json 现值（快，永远可用）；邻居与群规模来自
 * 派生投影——投影未就绪时这些字段缺席（partial: true），身份照常返回，
 * 消费方（引用注入）只降级关联节、不丢线程身份。
 */
export async function getTopicGroups({ agentId = 'programming-helper', projectId = '', openDirectory = '', dataRoot = USER_DATA_ROOT, force = false, freshnessMs = REFRESH_MAX_AGE_MS } = {}) {
  // Topic 看板的契约是“当前近期主题”，不能像单线程详情那样先返回陈旧快照。
  // 仍走增量水位复用：未变化会话不重扫，变化会话完成后才返回。
  // 冷启动种子（与 waitSnapshot 同策略）：进程内无快照而磁盘有上次投影时先
  // 种进备忘——ensureSnapshot 因此走增量（只有水位变化的会话重扫）而不是
  // 从零全量。没有种子的话，服务重启后的首次看板查询要等分钟级全量枚举，
  // 窗口内看板空白（与关联群历史事故同构）。
  if (!force && !_memo.get(dataRoot)?.snapshot) {
    const diskSnapshot = await loadCache(dataRoot).catch(() => null);
    if (diskSnapshot?.builtAt) {
      _memo.set(dataRoot, { snapshot: diskSnapshot, builtAtMs: 0, refreshPromise: null });
    }
  }
  const snapshot = await ensureSnapshot(dataRoot, {
    force,
    freshnessMs: force ? freshnessMs : 0,
  }).catch(() => null);
  if (!snapshot) {
    return { groups: [], builtAt: '', partial: true, scope: 'explicit session-reference connected components only' };
  }
  const groups = computeTopicGroupsFromSnapshot(snapshot, { agentId, projectId, openDirectory });
  // 合并簇标注（自定义标题/简介/参考文档/提交条目）：精确命中簇 id，否则按
  // 成员真子集继承（簇增长场景），见 topic-notes.js。
  const notes = await loadTopicNotes(dataRoot, agentId);
  for (const group of groups) {
    const note = resolveTopicNote(notes, { clusterId: group.id, memberThreadIds: group.threadIds });
    group.title = note?.title || group.fallbackTitle || '';
    group.customTitle = Boolean(note?.title);
    group.summary = note?.summary || '';
    group.docs = note?.docs || [];
    group.commits = note?.commits || [];
  }
  return {
    groups,
    builtAt: snapshot.builtAt,
    partial: false,
    scope: 'explicit session-reference connected components only',
  };
}

export async function getThreadRelations({ threadId = '', agentId = '', sessionId = '', dataRoot = USER_DATA_ROOT, force = false, freshnessMs = REFRESH_MAX_AGE_MS } = {}) {
  const { membership, threads } = await readThreadMembership(dataRoot);
  let resolved = safeFragment(threadId) && threadId.startsWith('wt-') ? threadId : '';
  if (!resolved && agentId && sessionId) {
    resolved = membership.get(`${text(agentId)}/${text(sessionId)}`) || '';
  }
  const threadMeta = resolved ? threads.get(resolved) : undefined;

  let relations = { found: false, neighbors: [], component: { size: resolved ? 1 : 0, memberThreadIds: resolved ? [resolved] : [] } };
  let builtAt = '';
  let unresolvedTargets = 0;
  let partial = true;
  if (resolved) {
    try {
      const snapshot = await waitSnapshot(dataRoot, force, freshnessMs);
      if (snapshot) {
        relations = computeRelationsFromSnapshot(snapshot, resolved);
        builtAt = snapshot.builtAt;
        unresolvedTargets = snapshot.unresolvedTargets;
        partial = false;
      }
    } catch { /* 投影构建失败：身份照常返回，关联缺席 */ }
  }

  return {
    threadId: resolved,
    resolvedThreadId: resolved,
    resolvedThreadTitle: text(threadMeta?.title),
    generations: threadMeta?.generations || 0,
    found: relations.found,
    neighbors: relations.neighbors,
    component: relations.component,
    builtAt,
    unresolvedTargets,
    partial,
    scope: 'local indexed stores; explicit user references only (docs/plans/2026-11-14-session-reference-thread-cluster.md)',
  };
}

/**
 * 启动预热：后台构建投影（首建分钟级），不阻塞启动与请求；请求侧超时
 * 降级，预热完成后自然命中。失败只记日志，下次请求重试。
 */
export function warmRelationsProjection(dataRoot = USER_DATA_ROOT) {
  ensureSnapshot(dataRoot).catch(error => {
    console.error('[session-relations] warm-up failed:', error?.message || error);
  });
}

/** 测试辅助：清空进程内备忘（隔离用例间的 dataRoot 状态）。 */
export function resetRelationsMemo() {
  _memo.clear();
}
