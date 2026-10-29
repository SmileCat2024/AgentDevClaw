import path from 'path';
import { readFileSync } from 'fs';
import { promises as fs } from 'fs';
import {
  PREBUILT_SESSIONS_ROOT,
  PREBUILT_WORKSPACES_ROOT,
  PROJECT_DOCSET_SUBPATH,
} from './constants.js';
import {
  sanitizeSessionFragment,
  cleanSessionText,
  isWorkspaceSessionAgent,
} from './string-helpers.js';
import { readJson, ensureDir } from './fs-helpers.js';

// ── Path helpers ──────────────────────────────────────────────────

export function getPrebuiltAgentSessionDir(agentId) {
  if (isWorkspaceSessionAgent(agentId)) {
    return path.join(PREBUILT_WORKSPACES_ROOT, sanitizeSessionFragment(agentId), 'sessions');
  }
  return path.join(PREBUILT_SESSIONS_ROOT, sanitizeSessionFragment(agentId));
}

export function getPrebuiltSessionFilePath(agentId, sessionId) {
  return path.join(getPrebuiltAgentSessionDir(agentId), `${sanitizeSessionFragment(sessionId)}.json`);
}

export function getPrebuiltSessionIndexPath(agentId) {
  return path.join(getPrebuiltAgentSessionDir(agentId), 'index.json');
}

export function getPrebuiltWorkspaceDir(agentId) {
  return path.join(PREBUILT_WORKSPACES_ROOT, sanitizeSessionFragment(agentId));
}

export function getPrebuiltWorkspaceStatePath(agentId) {
  return path.join(getPrebuiltWorkspaceDir(agentId), 'state.json');
}

export function getPrebuiltWorkspaceArtifactsDir(agentId) {
  return path.join(getPrebuiltWorkspaceDir(agentId), 'artifacts');
}

export function getProjectDocsetDir(projectDir) {
  return path.join(path.resolve(String(projectDir || '').trim()), PROJECT_DOCSET_SUBPATH);
}

export function getProjectDocsetProjectPath(projectDir) {
  return path.join(getProjectDocsetDir(projectDir), 'project.json');
}

export function getProjectDocsetFormsDir(projectDir) {
  return path.join(getProjectDocsetDir(projectDir), 'forms');
}

export function getProjectDocsetMaterialsDir(projectDir) {
  return path.join(getProjectDocsetDir(projectDir), 'materials');
}

export function getProjectDocsetConversationsDir(projectDir) {
  return path.join(getProjectDocsetDir(projectDir), 'conversations');
}

export function getWorkspaceArtifactPath(agentId, artifactId) {
  return path.join(getPrebuiltWorkspaceArtifactsDir(agentId), `${sanitizeSessionFragment(artifactId)}.json`);
}

// ── Session index read/write ──────────────────────────────────────

// readSessionIndex 进程内缓存。侧栏轮询（get_connected_agents / prebuilt_sessions
// 条件刷新，每标签每 3s）与各路由都会反复读同一份索引；PH 工作空间的索引可累积
// 到数 MB / 数千条会话，无缓存的重复 磁盘读+JSON.parse+全量归一化 是主进程事件
// 循环停顿的主要来源（CPU profile 实测 readJson 占 self-time ~27%）。缓存以
// mtime+size 失效保持对 CLI 等外部写者的正确性；writeSessionIndex 落盘后主动
// 失效兜底同刻写入。命中返回 structuredClone，调用方可安全突变返回值。
const _indexCache = new Map(); // indexPath → { mtimeMs, size, value }

// 并发装载去重（cache stampede 防护）。线程列表等批量读路径会以 Promise.all
// 并发解析同一个会话索引（PH 线程化后为 1400+ 个 head 会话各解析一次）；缓存
// 一旦失效（会话活跃时每次 turn 都写索引），全部并发调用会各自完整执行
// 「读 4.4MB + JSON.parse + 全量归一化」，单请求即可产生数十 GB 瞬时分配并
// 打爆堆（V8 OOM / code 134）。这里把同一文件版本的装载收敛为一次，其余调用
// 共享同一 promise。
//
// 键 = indexPath + mtimeMs + size：只合并「同一文件版本」的装载，写入后
// mtime 改变的新调用不会被旧在途装载短路（正确性与缓存失效语义一致）。
const _indexLoads = new Map(); // loadKey → Promise<index>

function normalizeSessionIndexData(data) {
  const sessions = Array.isArray(data.sessions)
    ? data.sessions
      .filter((session) => session && session.id && session.id !== 'legacy')
      .map((session) => ({
        ...session,
        id: String(session.id),
        title: cleanSessionText(session.title),
        featureName: cleanSessionText(session.featureName),
        agentName: cleanSessionText(session.agentName),
        taskTitle: cleanSessionText(session.taskTitle),
        taskType: cleanSessionText(session.taskType),
        goal: cleanSessionText(session.goal),
        constraints: cleanSessionText(session.constraints),
        expectedOutput: cleanSessionText(session.expectedOutput),
        targetFiles: cleanSessionText(session.targetFiles),
        referenceMaterials: cleanSessionText(session.referenceMaterials),
        openDirectory: cleanSessionText(session.openDirectory),
        // PH 项目会话归属（ticket 042）：读取侧只归一非空值，不给无此字段的
        // 历史记录补 key——updateSessionIndex 是"读（归一）→ 改 → 整写回"的
        // round-trip，无条件归一会让任何一次索引写入（meta_sync/标题/激活）
        // 给全部旧记录批量落上 projectId:''，违反"无历史批量补字段"验收。
        // 目录会话旧记录保持字段缺席，消费方经 getSessionProjectId 读作 ''。
        ...(cleanSessionText(session.projectId) ? { projectId: cleanSessionText(session.projectId) } : {}),
        sessionType: cleanSessionText(session.sessionType) || 'main',
        workspaceAgentId: session.workspaceAgentId === undefined ? 'main' : session.workspaceAgentId,
        archived: session.archived === true,
        todo: session.todo === true,
        metadata: normalizeSessionMetadata(session.metadata),
      }))
    : [];
  return {
    revision: Number.isSafeInteger(Number(data.revision)) && Number(data.revision) >= 0
      ? Number(data.revision)
      : 0,
    activeSessionId: sessions.some((session) => session.id === data.activeSessionId) ? data.activeSessionId : null,
    sessions,
  };
}

export async function readSessionIndex(agentId) {
  return structuredClone(await readSessionIndexShared(agentId));
}

/**
 * readSessionIndex 的共享只读变体：命中缓存时直接返回缓存对象，不做
 * structuredClone。面向高频批量只读路径（如线程列表逐线程解析 head 会话
 * 字段）——索引体积可达数 MB，逐调用 clone 整份索引的同步成本随线程数
 * 线性放大，会持续占据事件循环（server 周期性 health unreachable 的根因）。
 *
 * 契约：调用方只读返回值，不得修改（会污染缓存）；需要可变副本时用
 * readSessionIndex。缓存装载 / mtime+size 失效语义与 readSessionIndex 一致。
 */
export async function readSessionIndexShared(agentId) {
  const dirPath = getPrebuiltAgentSessionDir(agentId);
  const indexPath = getPrebuiltSessionIndexPath(agentId);
  await ensureDir(dirPath);

  let stat = null;
  try {
    stat = await fs.stat(indexPath);
  } catch { /* 索引文件不存在：走空索引语义 */ }
  if (!stat) {
    return { revision: 0, activeSessionId: null, sessions: [] };
  }
  const cached = _indexCache.get(indexPath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.value;
  }
  // 并发装载去重：同一文件版本只解析一次（见 _indexLoads 注释）。缓存未命中
  // 的并发调用是线程列表的主要形态，逐次完整解析会打爆堆。
  const loadKey = `${indexPath}|${stat.mtimeMs}|${stat.size}`;
  const inflight = _indexLoads.get(loadKey);
  if (inflight) return inflight;
  const load = (async () => {
    try {
      const value = normalizeSessionIndexData(await readJson(indexPath));
      // 装载期间文件可能已被改写（mtime/size 变化）：此时不要把旧内容写进
      // 缓存，否则会以旧版本覆盖下一次读取应得的新版本。直接返回本次结果
      // 给已经在等的调用方，缓存留给后续读重新装载。
      const latest = await fs.stat(indexPath).catch(() => null);
      if (latest && latest.mtimeMs === stat.mtimeMs && latest.size === stat.size) {
        _indexCache.set(indexPath, { mtimeMs: stat.mtimeMs, size: stat.size, value });
      }
      return value;
    } catch {
      // 索引损坏：与无缓存时的行为一致返回空索引，并清掉旧缓存避免下次命中陈旧值
      _indexCache.delete(indexPath);
      return { revision: 0, activeSessionId: null, sessions: [] };
    } finally {
      _indexLoads.delete(loadKey);
    }
  })();
  _indexLoads.set(loadKey, load);
  return load;
}

export async function resolvePrebuiltSessionType(agentId, sessionId) {
  const normalizedSessionId = cleanSessionText(sessionId);
  if (!normalizedSessionId) return '';

  try {
    const index = await readSessionIndex(agentId);
    const record = Array.isArray(index?.sessions)
      ? index.sessions.find((session) => cleanSessionText(session?.id) === normalizedSessionId)
      : null;
    const indexedType = cleanSessionText(record?.sessionType);
    if (indexedType) {
      return indexedType;
    }
  } catch {}

  try {
    const sessionPath = getPrebuiltSessionFilePath(agentId, normalizedSessionId);
    const sessionRecord = await fs.readFile(sessionPath, 'utf8').then(JSON.parse).catch(() => null);
    const fileType = cleanSessionText(sessionRecord?.sessionType);
    if (fileType) {
      return fileType;
    }
  } catch {}

  return '';
}

const _indexLocks = new Map();

// 原子写核心（writeSessionIndex 与显式路径变体共用）：唯一临时名 + rename，
// EPERM/EXDEV 兜底。临时名带 pid+随机——同 agent 并发进程写同一索引时，
// 固定 .tmp 名会让两个进程互相吞掉对方的 tmp 文件。
async function writeIndexFileAt(indexPath, index) {
  await ensureDir(path.dirname(indexPath));
  const tmpPath = `${indexPath}.${process.pid}-${Math.random().toString(36).slice(2, 8)}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(index, null, 2), 'utf8');
  try {
    await fs.rename(tmpPath, indexPath);
  } catch (err) {
    if (err.code === 'EPERM' || err.code === 'EACCES') {
      await fs.unlink(indexPath).catch(e => console.warn(e));
      await fs.rename(tmpPath, indexPath);
    } else if (err.code === 'EXDEV') {
      await fs.copyFile(tmpPath, indexPath);
      await fs.unlink(tmpPath).catch(e => console.warn(e));
    } else {
      throw err;
    }
  }
  // 同刻写入（mtime 粒度内）时 mtime+size 可能不变，主动失效兜底——
  // 所有写路径（writeSessionIndex / upsertSessionIndexAt）经此核心，
  // 缓存失效不再依赖各写方自觉。
  _indexCache.delete(indexPath);
}

export async function writeSessionIndex(agentId, index) {
  const dirPath = getPrebuiltAgentSessionDir(agentId);
  const indexPath = getPrebuiltSessionIndexPath(agentId);
  await ensureDir(dirPath);
  await writeIndexFileAt(indexPath, index);
}

export function sessionIndexContentSignature(index = {}) {
  return JSON.stringify({
    activeSessionId: index?.activeSessionId || null,
    sessions: Array.isArray(index?.sessions) ? index.sessions : [],
  });
}

// ── 显式路径变体（plain agent 数据根等非 workspace 消费方）────────────
//
// plain agent 的会话索引在 AGENTS_DATA_ROOT/agents/<id>/sessions/index.json，
// 不在 getPrebuiltAgentSessionDir 的寻址范围内；此前 CLI 侧私搭了一份
// read-modify-write（无 revision、无锁），与 server 侧格式漂移。这里提供
// 显式路径变体复用同一套锁 + revision + 原子写语义。注意：进程内锁不跨
// 进程，跨进程互斥由 writeIndexFileAt 的唯一临时名 + rename 原子性兜底
// （后写者基于自己读到的快照合并，极端并发下仍可能后写覆盖——索引是
// 发现层，会话文件本体不受影响）。

async function readSessionIndexAt(indexPath) {
  try {
    const parsed = JSON.parse(await fs.readFile(indexPath, 'utf8'));
    if (parsed && typeof parsed === 'object') {
      return {
        ...parsed,
        revision: Number.isSafeInteger(Number(parsed.revision)) && Number(parsed.revision) >= 0
          ? Number(parsed.revision)
          : 0,
        activeSessionId: parsed.activeSessionId || null,
        sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
      };
    }
  } catch { /* 索引不存在或损坏：空索引语义（与 readSessionIndex 一致） */ }
  return { revision: 0, activeSessionId: null, sessions: [] };
}

/**
 * 显式路径的 session index upsert：与 updateSessionIndex 同语义
 * （per-key 进程内锁 + revision 自增 + 原子写），供 plain agent runner
 * 等非 workspace 数据根消费方使用，不再各自私搭读写。
 */
export async function upsertSessionIndexAt(indexPath, record, { lockKey = indexPath } = {}) {
  const prev = _indexLocks.get(lockKey) || Promise.resolve();
  let release;
  const next = new Promise(r => release = r);
  _indexLocks.set(lockKey, next);
  try {
    await prev;
    const index = await readSessionIndexAt(indexPath);
    const existing = index.sessions.findIndex(s => s?.id === record.id);
    if (existing >= 0) {
      // createdAt 登记后不可变：续接 / 终态 / 轮换登记都不得重置原始
      // 创建时间（record 携带 createdAt 仅对新建记录生效）。
      index.sessions[existing] = {
        ...index.sessions[existing],
        ...record,
        createdAt: index.sessions[existing].createdAt ?? record.createdAt,
      };
    } else {
      index.sessions.push(record);
    }
    index.activeSessionId = record.id;
    const mergedIndex = {
      ...index,
      revision: Math.max(0, Number(index.revision) || 0) + 1,
    };
    await writeIndexFileAt(indexPath, mergedIndex);
    return mergedIndex;
  } finally {
    release();
    if (_indexLocks.get(lockKey) === next) _indexLocks.delete(lockKey);
  }
}

export async function updateSessionIndex(agentId, fn, { skipContentComparison = false } = {}) {
  const prev = _indexLocks.get(agentId) || Promise.resolve();
  let release;
  const next = new Promise(r => release = r);
  _indexLocks.set(agentId, next);
  await prev;
  try {
    const index = await readSessionIndex(agentId);
    const before = skipContentComparison ? null : sessionIndexContentSignature(index);
    const proposedIndex = await fn(index);
    const comparableIndex = {
      ...(proposedIndex || index),
      revision: Math.max(0, Number(index.revision) || 0),
    };
    if (!skipContentComparison && sessionIndexContentSignature(comparableIndex) === before) {
      return index;
    }
    const newIndex = {
      ...comparableIndex,
      revision: Math.max(0, Number(index.revision) || 0) + 1,
    };
    await writeSessionIndex(agentId, newIndex);
    return newIndex;
  } finally {
    release();
    if (_indexLocks.get(agentId) === next) _indexLocks.delete(agentId);
  }
}

export function buildSessionTitle(createdAtIso) {
  const date = new Date(createdAtIso);
  const parts = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ];
  const time = [
    String(date.getHours()).padStart(2, '0'),
    String(date.getMinutes()).padStart(2, '0'),
  ];
  return `对话 ${parts.join('-')} ${time.join(':')}`;
}

/**
 * "新对话N" 计数器。归属集合判定（ticket 042）：
 * - projectId 非空：项目集合 = 同 projectId 的会话（目录不参与，同路径的
 *   目录/其他项目会话不混入编号）；
 * - projectId 空：目录集合 = 无 projectId 且 openDirectory 匹配的会话
 *   （原目录语义，项目会话即使同路径也不占用目录编号）。
 */
export function computeNextSessionNumber(sessions, openDirectory, { projectId = '' } = {}) {
  const normalizedDir = String(openDirectory || '').trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const normalizedProjectId = String(projectId || '').trim();
  const newSessionPattern = /^新对话(\d+)$/;
  let maxN = 0;
  for (const session of (sessions || [])) {
    const sessionProjectId = String(session?.projectId || '').trim();
    if (normalizedProjectId) {
      if (sessionProjectId !== normalizedProjectId) continue;
    } else {
      if (sessionProjectId) continue;
      const sessionDir = String(session?.openDirectory || '').trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
      if (normalizedDir && sessionDir !== normalizedDir) continue;
    }
    const m = cleanSessionText(session?.title).match(newSessionPattern);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > maxN) maxN = n;
    }
  }
  return maxN + 1;
}

export function findMissingCheckpoints(branchMessages, branchCheckpoints) {
  const branchUserTurns = branchMessages
    .filter(m => m.role === 'user' && typeof m.turn === 'number')
    .map(m => m.turn);
  const branchCpIndices = branchCheckpoints.map(cp => cp.callIndex);
  return branchUserTurns.filter(t => !branchCpIndices.includes(t));
}

export function normalizeSessionMetadata(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }

  // studioFeatureIds（会话 ↔ feature 绑定，ADR-0022）：数组形态的例外字段。
  // 就地清洗（trim/去重）而非引 session-helpers-pure 的 cleanStudioFeatureIds，
  // 后者 import 本模块，反向引会成环。
  const studioFeatureIds = Array.isArray(raw.studioFeatureIds)
    ? [...new Set(raw.studioFeatureIds.map(id => cleanSessionText(id)).filter(Boolean))]
    : [];

  const metadata = {
    resumeMode: cleanSessionText(raw.resumeMode),
    sourceAgentId: cleanSessionText(raw.sourceAgentId),
    sourceSessionId: cleanSessionText(raw.sourceSessionId),
    handoffId: cleanSessionText(raw.handoffId),
    handoffPath: cleanSessionText(raw.handoffPath),
    handoffCreatedAt: cleanSessionText(raw.handoffCreatedAt),
    handoffSummaryKind: cleanSessionText(raw.handoffSummaryKind),
    studioFeatureIds,
    // legacy 透传（ADR-0022）：存量索引的 studioProjectId 由启动迁移
    // （studio-feature-migration.js）换算为 studioFeatureIds 后删除；透传保证
    // 迁移能看到落盘的旧字段。新代码不再写入此字段，迁移完成后自然消亡。
    studioProjectId: cleanSessionText(raw.studioProjectId),
  };

  return Object.fromEntries(
    Object.entries(metadata).filter(([, value]) => (Array.isArray(value) ? value.length > 0 : value)),
  );
}

export function readSessionIndexSync(agentId) {
  const sessionDir = isWorkspaceSessionAgent(agentId)
    ? path.join(PREBUILT_WORKSPACES_ROOT, agentId, 'sessions')
    : path.join(PREBUILT_SESSIONS_ROOT, agentId);
  const indexPath = path.join(sessionDir, 'index.json');
  try {
    return JSON.parse(readFileSync(indexPath, 'utf8'));
  } catch {
    return { revision: 0, sessions: [] };
  }
}
