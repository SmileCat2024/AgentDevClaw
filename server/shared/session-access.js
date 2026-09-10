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
        sessionType: cleanSessionText(session.sessionType) || 'main',
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
    return structuredClone(cached.value);
  }
  try {
    const value = normalizeSessionIndexData(await readJson(indexPath));
    _indexCache.set(indexPath, { mtimeMs: stat.mtimeMs, size: stat.size, value });
    return structuredClone(value);
  } catch {
    // 索引损坏：与无缓存时的行为一致返回空索引，并清掉旧缓存避免下次命中陈旧值
    _indexCache.delete(indexPath);
    return { revision: 0, activeSessionId: null, sessions: [] };
  }
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

export async function updateSessionIndex(agentId, fn) {
  const prev = _indexLocks.get(agentId) || Promise.resolve();
  let release;
  const next = new Promise(r => release = r);
  _indexLocks.set(agentId, next);
  await prev;
  try {
    const index = await readSessionIndex(agentId);
    const before = sessionIndexContentSignature(index);
    const proposedIndex = await fn(index);
    const comparableIndex = {
      ...(proposedIndex || index),
      revision: Math.max(0, Number(index.revision) || 0),
    };
    if (sessionIndexContentSignature(comparableIndex) === before) {
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

export function computeNextSessionNumber(sessions, openDirectory) {
  const normalizedDir = String(openDirectory || '').trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const newSessionPattern = /^新对话(\d+)$/;
  let maxN = 0;
  for (const session of (sessions || [])) {
    const sessionDir = String(session?.openDirectory || '').trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    if (normalizedDir && sessionDir !== normalizedDir) continue;
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

  const metadata = {
    resumeMode: cleanSessionText(raw.resumeMode),
    sourceAgentId: cleanSessionText(raw.sourceAgentId),
    sourceSessionId: cleanSessionText(raw.sourceSessionId),
    handoffId: cleanSessionText(raw.handoffId),
    handoffPath: cleanSessionText(raw.handoffPath),
    handoffCreatedAt: cleanSessionText(raw.handoffCreatedAt),
    handoffSummaryKind: cleanSessionText(raw.handoffSummaryKind),
  };

  return Object.fromEntries(
    Object.entries(metadata).filter(([, value]) => value),
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
