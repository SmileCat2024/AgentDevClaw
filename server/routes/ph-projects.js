import { promises as fs } from 'fs';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import crypto from 'crypto';

import {
  PH_STYLE_WORKSPACE_AGENT_IDS,
  PREBUILT_WORKSPACES_ROOT,
  USER_DATA_ROOT,
} from '../shared/constants.js';
import { ensureDir, normalizePathCasing } from '../shared/fs-helpers.js';
import { cleanSessionText } from '../shared/string-helpers.js';
import { readSessionIndex, updateSessionIndex } from '../shared/session-access.js';

// ── PH 独立项目存储（ticket 041）─────────────────────────────────────────────
//
// 与旧目录条目（state.phProjects，normalizeWorkspacePhProject /
// upsertWorkspacePhProject 管理的 dir:<path> 记录）严格分轨：
// - 本表只持有用户显式创建的独立项目（稳定 ID，名称/目录不参与 ID 生成）；
// - 不经过 writeWorkspaceState，不触发目录 docset 同步；
// - 托管工作目录在用户数据根的独立区域按项目 ID 分配，与会话消息存储
//   （workspaces/programming-helper/sessions）分离。
//
// directorySource 是托管资产的唯一判据：路径恰好位于数据根下不能推断为
// 可删除的托管目录（外部项目完全可能指向数据根内的路径），后续归档/删除
// （ticket 046）必须按此字段判定。

const PH_AGENT_ID = 'programming-helper';
const PH_PROJECTS_SCHEMA_VERSION = 1;
const PH_PROJECT_ID_PATTERN = /^prj_[0-9a-f]{12}$/;
// 用户数据根下的 PH 项目托管工作目录区（与会话存储分离）
const PH_MANAGED_PROJECTS_ROOT = path.join(USER_DATA_ROOT, 'ph-projects');

export function getPhProjectStorePath() {
  return path.join(PREBUILT_WORKSPACES_ROOT, PH_AGENT_ID, 'projects.json');
}

export function getPhManagedProjectDir(projectId) {
  return path.join(PH_MANAGED_PROJECTS_ROOT, projectId);
}

export function isValidPhProjectId(projectId) {
  return typeof projectId === 'string' && PH_PROJECT_ID_PATTERN.test(projectId);
}

/**
 * PH 项目目录入参收敛：绝对化 + 真实大小写还原 + 存在性校验。
 *
 * 大小写还原（normalizePathCasing）只在 Windows 生效——Linux 上文件系统
 * 大小写敏感，错误大小写的路径本就不存在，因此这里的存在性校验同时
 * 充当大小写闸门：拼写大小写与磁盘不符的目录在此被拒绝，而不是被照单
 * 全收生成幽灵项目、再由 runtime spawn 撑出一个错误大小写的真实目录
 * （历史事故：bookscanning/BookScanning 双目录）。
 */
export async function resolvePhProjectDirectory(rawDirectory) {
  const trimmed = typeof rawDirectory === 'string' ? rawDirectory.trim() : '';
  const resolved = trimmed ? path.resolve(trimmed) : '';
  const stat = resolved ? await fs.stat(resolved).catch(() => null) : null;
  if (!stat || !stat.isDirectory()) {
    const error = new Error(`openDirectory does not exist or is not a directory: ${trimmed || '(empty)'}`);
    error.statusCode = 400;
    throw error;
  }
  return normalizePathCasing(resolved);
}

// ── Record normalization ─────────────────────────────────────────────────────

/**
 * 单条项目记录的结构校验与归一。未知字段原样保留（前向兼容：后续票据
 * 新增字段不被本轮读写在落盘时洗掉）。结构不合法返回 null——由调用方
 * 决定按整表损坏处理，绝不在读取时静默丢弃记录。
 */
function normalizePhProjectRecord(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = cleanSessionText(raw.id);
  const name = cleanSessionText(raw.name);
  const workDirectory = cleanSessionText(raw.workDirectory);
  const directorySource = raw.directorySource === 'managed' ? 'managed'
    : (raw.directorySource === 'external' ? 'external' : null);
  if (!PH_PROJECT_ID_PATTERN.test(id)) return null;
  if (!name || !workDirectory || !directorySource) return null;
  if (typeof raw.archived !== 'boolean') return null;
  return {
    ...raw,
    id,
    name,
    workDirectory,
    directorySource,
    archived: raw.archived,
    createdAt: cleanSessionText(raw.createdAt) || null,
    updatedAt: cleanSessionText(raw.updatedAt) || null,
    archivedAt: cleanSessionText(raw.archivedAt) || null,
  };
}

function corruptStoreError(detail) {
  const error = new Error(`PH project store is corrupted at ${getPhProjectStorePath()}: ${detail}`);
  error.statusCode = 500;
  return error;
}

// ── Store read / write ───────────────────────────────────────────────────────

/**
 * 读取项目表。缺文件 = 尚无独立项目，返回空集合且不落盘；文件存在但
 * 损坏（JSON 解析失败 / 结构不合法 / schemaVersion 不受支持）抛 500，
 * 绝不静默当空集合返回——否则下一次写入会用空表覆盖掉真实数据。
 */
export async function readPhProjectStore() {
  const storePath = getPhProjectStorePath();
  let raw;
  try {
    raw = JSON.parse(await fs.readFile(storePath, 'utf8'));
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      return { schemaVersion: PH_PROJECTS_SCHEMA_VERSION, projects: [] };
    }
    throw corruptStoreError(error.message);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw corruptStoreError('root is not an object');
  }
  if (raw.schemaVersion !== PH_PROJECTS_SCHEMA_VERSION) {
    throw corruptStoreError(`unsupported schemaVersion ${JSON.stringify(raw.schemaVersion)}`);
  }
  if (!Array.isArray(raw.projects)) {
    throw corruptStoreError('projects is not an array');
  }
  const seen = new Set();
  const projects = raw.projects.map((record) => {
    const normalized = normalizePhProjectRecord(record);
    if (!normalized) throw corruptStoreError(`invalid project record: ${JSON.stringify(record)}`);
    if (seen.has(normalized.id)) throw corruptStoreError(`duplicate project id: ${normalized.id}`);
    seen.add(normalized.id);
    return normalized;
  });
  return { schemaVersion: PH_PROJECTS_SCHEMA_VERSION, projects };
}

// 进程内串行锁：create/rename 是读-改-写，防止并发写吞掉对方记录。
// 跨进程一致性由「唯一临时名 + rename」原子写兜底。
const _storeWriteLock = { chain: Promise.resolve() };

async function withStoreWriteLock(fn) {
  const prev = _storeWriteLock.chain;
  let release;
  const next = new Promise((resolve) => { release = resolve; });
  _storeWriteLock.chain = next;
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}

async function writePhProjectStore(store) {
  const storePath = getPhProjectStorePath();
  await ensureDir(path.dirname(storePath));
  const tmpPath = `${storePath}.${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(store, null, 2), 'utf8');
  try {
    await fs.rename(tmpPath, storePath);
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') {
      await fs.unlink(storePath).catch(() => null);
      await fs.rename(tmpPath, storePath);
    } else {
      await fs.unlink(tmpPath).catch(() => null);
      throw error;
    }
  }
}

// ── Store operations ─────────────────────────────────────────────────────────

export async function listPhProjects() {
  const store = await readPhProjectStore();
  return store.projects;
}

/**
 * 按 ID 查询。非法 ID 格式 400；表损坏 500；未知 ID 404。
 * 不校验目录存在性——存量项目引用暂时不存在的目录，不能因此从表里消失。
 */
export async function getPhProject(projectId) {
  if (!isValidPhProjectId(projectId)) {
    const error = new Error(`Invalid projectId: ${projectId}`);
    error.statusCode = 400;
    throw error;
  }
  const projects = await listPhProjects();
  const project = projects.find((item) => item.id === projectId) || null;
  if (!project) {
    const error = new Error(`Unknown project: ${projectId}`);
    error.statusCode = 404;
    throw error;
  }
  return project;
}

/**
 * 同步按 ID 查表（ticket 042）：runtime 宿主脚本（run-prebuilt-agent /
 * mirror-runtime / run-one-shot-agent）在 readFileSync 上下文里逐 Session
 * 解析项目目录，不能走 async store 读取。语义与 readPhProjectStore 对齐：
 * 缺文件 = 无此项目（返回 null）；损坏表 throw，绝不静默当空。
 * 不校验目录存在性（同 getPhProject）。
 */
export function findPhProjectSync(projectId) {
  if (!isValidPhProjectId(projectId)) {
    const error = new Error(`Invalid projectId: ${projectId}`);
    error.statusCode = 400;
    throw error;
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(getPhProjectStorePath(), 'utf8'));
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return null;
    throw corruptStoreError(error.message);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw corruptStoreError('root is not an object');
  }
  if (raw.schemaVersion !== PH_PROJECTS_SCHEMA_VERSION) {
    throw corruptStoreError(`unsupported schemaVersion ${JSON.stringify(raw.schemaVersion)}`);
  }
  if (!Array.isArray(raw.projects)) {
    throw corruptStoreError('projects is not an array');
  }
  const record = raw.projects.find((item) => normalizePhProjectRecord(item)?.id === projectId);
  return record ? normalizePhProjectRecord(record) : null;
}

function generatePhProjectId(existingIds) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = `prj_${crypto.randomBytes(6).toString('hex')}`;
    if (!existingIds.has(candidate)) return candidate;
  }
  const error = new Error('Failed to generate a unique project id');
  error.statusCode = 500;
  throw error;
}

/**
 * 新建独立项目。同名/同目录项目按 ID 区分，不做唯一性约束。
 * - 显式 workDirectory：external，经 resolvePhProjectDirectory 校验（存在性
 *   + 大小写还原），不向该目录写入任何文件；
 * - 未提供：managed，在数据根 PH 项目区按 ID 分配专属目录并创建。
 * 不创建 Session、不启动模型。
 */
export async function createPhProject({ name, workDirectory } = {}) {
  const trimmedName = cleanSessionText(name);
  if (!trimmedName) {
    const error = new Error('name is required');
    error.statusCode = 400;
    throw error;
  }
  const rawDirectory = cleanSessionText(workDirectory);
  const directorySource = rawDirectory ? 'external' : 'managed';

  return withStoreWriteLock(async () => {
    const store = await readPhProjectStore();
    const id = generatePhProjectId(new Set(store.projects.map((item) => item.id)));
    const timestamp = new Date().toISOString();
    let resolvedDirectory;
    if (directorySource === 'external') {
      resolvedDirectory = await resolvePhProjectDirectory(rawDirectory);
    } else {
      resolvedDirectory = getPhManagedProjectDir(id);
      await ensureDir(resolvedDirectory);
    }
    const project = {
      id,
      name: trimmedName,
      workDirectory: resolvedDirectory,
      directorySource,
      archived: false,
      createdAt: timestamp,
      updatedAt: timestamp,
      archivedAt: null,
    };
    store.projects.push(project);
    await writePhProjectStore(store);
    return project;
  });
}

/** 改名只动 name 与 updatedAt；ID 与工作目录不变。非法 ID 格式 400，未知 ID 404。 */
export async function renamePhProject(projectId, name) {
  if (!isValidPhProjectId(projectId)) {
    const error = new Error(`Invalid projectId: ${projectId}`);
    error.statusCode = 400;
    throw error;
  }
  const trimmedName = cleanSessionText(name);
  if (!trimmedName) {
    const error = new Error('name is required');
    error.statusCode = 400;
    throw error;
  }
  return withStoreWriteLock(async () => {
    const store = await readPhProjectStore();
    const index = store.projects.findIndex((item) => item.id === projectId);
    if (index < 0) {
      const error = new Error(`Unknown project: ${projectId}`);
      error.statusCode = 404;
      throw error;
    }
    const project = {
      ...store.projects[index],
      name: trimmedName,
      updatedAt: new Date().toISOString(),
    };
    store.projects.splice(index, 1, project);
    await writePhProjectStore(store);
    return project;
  });
}

// ── 项目改绑（ticket 046）───────────────────────────────────────────────────
//
// 改绑 = 把项目的 workDirectory 换到新目录，同时让该项目的空闲存活实例按
// 「先持久化、再移除、最后写表」的顺序安全失效：
//   1. 改绑释放窗口内，新输入与新启动都被门闩拒绝（getPhSessionGateInfo /
//      getPhProjectGateInfo）——不存在输入落进旧实例执行的窗口；
//   2. 停止走 stopManagedAgent(agentId, sessionId, { waitForPersistence: true })，
//      共享进程经 remove-session 精确释放单个会话，兄弟会话（B/D）不受影响；
//      不带 sessionId 的全量停止语义绝不使用；
//   3. 所有存活实例释放成功后才写项目表——失败时旧绑定完整保留（会话下次
//      启动仍绑旧目录），绝不出现「记录已变、下一轮还用旧实例」或假成功。
// 门闩是进程内的归属协调（与线程 handoff barrier 同风格），不是通用事务
// 框架；热路径（无归属释放进行中）零查询成本。PH 会话归属转移
// （movePhSessions）共用同一张门闩表。

const _phOwnershipGates = new Map(); // gateKey -> { projectIds:Set, sessionIds:Set, code, message }

const PH_REBIND_GATE_CODE = 'ph_project_rebind_in_progress';
const PH_MOVE_GATE_CODE = 'ph_sessions_move_in_progress';
const PH_ARCHIVE_GATE_CODE = 'ph_project_archive_in_progress';
const PH_DELETE_GATE_CODE = 'ph_project_delete_in_progress';

function findOwnershipGateByProject(projectId) {
  for (const gate of _phOwnershipGates.values()) {
    if (gate.projectIds.has(projectId)) return gate;
  }
  return null;
}

function findOwnershipGateBySession(sessionId) {
  for (const gate of _phOwnershipGates.values()) {
    if (gate.sessionIds.has(sessionId)) return gate;
  }
  return null;
}

/** 项目是否处于任何归属事务窗口（改绑/转移/归档/删除）。 */
export function isPhProjectRebindActive(projectId) {
  return Boolean(projectId) && findOwnershipGateByProject(projectId) !== null;
}

/** 会话是否处于归属释放窗口（input-gateway 输入闸用）。空表短路。 */
export function isPhSessionRebindGated(sessionId) {
  if (_phOwnershipGates.size === 0 || !sessionId) return false;
  return findOwnershipGateBySession(sessionId) !== null;
}

/** 会话所在归属窗口的失败语义（code + message），无窗口返回 null。 */
export function getPhSessionGateInfo(sessionId) {
  if (_phOwnershipGates.size === 0 || !sessionId) return null;
  const gate = findOwnershipGateBySession(sessionId);
  return gate ? { code: gate.code, message: gate.message } : null;
}

/** 项目所在归属窗口的失败语义（code + message），无窗口返回 null。 */
export function getPhProjectGateInfo(projectId) {
  if (_phOwnershipGates.size === 0 || !projectId) return null;
  const gate = findOwnershipGateByProject(projectId);
  return gate ? { code: gate.code, message: gate.message } : null;
}

function ownershipGateError(gate, fallbackMessage) {
  const error = new Error(gate?.message || fallbackMessage);
  error.statusCode = 409;
  error.code = gate?.code || PH_REBIND_GATE_CODE;
  return error;
}

/**
 * 归属门闩：改绑 / 转移 / 归档 / 删除共用的进程内互斥。任何 project /
 * session 维度与既有窗口相交时返回冲突门闩（同步原子判定，检查与登记
 * 之间无 await）。持有期必须覆盖操作自身的整个异步事务；建立前的预读
 * 快照一律视为过期，须在窗口内刷新或落盘锁内按 fresh 事实重验。
 */
function beginPhOwnershipGate(gateKey, projectIds, sessionIds, code, message) {
  for (const gate of _phOwnershipGates.values()) {
    const projectOverlap = projectIds.some((id) => gate.projectIds.has(id));
    const sessionOverlap = sessionIds.some((id) => gate.sessionIds.has(id));
    if (projectOverlap || sessionOverlap) return gate;
  }
  _phOwnershipGates.set(gateKey, {
    projectIds: new Set(projectIds),
    sessionIds: new Set(sessionIds),
    code,
    message,
  });
  return null;
}

function endPhOwnershipGate(gateKey) {
  _phOwnershipGates.delete(gateKey);
}

/** 窗口内补充会话成员（rebind/delete 建立后刷新索引成员）。 */
function addPhOwnershipGateSessions(gateKey, sessionIds) {
  const gate = _phOwnershipGates.get(gateKey);
  if (!gate) return;
  for (const sessionId of sessionIds) gate.sessionIds.add(sessionId);
}

function normalizeDirectoryForCompare(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.replace(/\\/g, '/').toLowerCase() : resolved;
}

function sameNormalizedDirectory(a, b) {
  return typeof a === 'string' && typeof b === 'string'
    && normalizeDirectoryForCompare(a) === normalizeDirectoryForCompare(b);
}

/**
 * 探测单个存活 runtime 是否有执行中轮次 / 排队输入。
 * 探测失败按 busy 处理（fail-closed）：无法确认空闲就不能安全失效。
 */
async function _probeRuntimeBusy(viewerAgentId, readViewerJson) {
  const base = `/api/agents/${encodeURIComponent(viewerAgentId)}`;
  let notification;
  try {
    notification = await readViewerJson(`${base}/notification`);
  } catch (error) {
    return { busy: true, reason: `probe_failed: ${error?.message || error}` };
  }
  if (notification?.callActive === true) return { busy: true, reason: 'call_active' };
  let queued;
  try {
    queued = await readViewerJson(`${base}/queued-inputs`);
  } catch (error) {
    return { busy: true, reason: `probe_failed: ${error?.message || error}` };
  }
  if (Array.isArray(queued) && queued.length > 0) return { busy: true, reason: 'queued_inputs' };
  return { busy: false };
}

function rebindBusyError(projectId, sessionId, reason) {
  const error = new Error(`PH project ${projectId} has busy sessions (${reason}); rebind is rejected: session=${sessionId}`);
  error.statusCode = 409;
  error.code = 'ph_project_busy';
  return error;
}

/**
 * 项目改绑编排。
 * - workDirectory 非空：external，经 resolvePhProjectDirectory 校验（存在性 +
 *   大小写还原）；为空：managed，按项目 ID 重新分配托管目录。
 * - busy（执行中轮次 / 排队输入 / 探测失败）→ 409，不动任何状态。
 * - 空闲存活实例逐个 waitForPersistence 释放（保留共享进程兄弟会话），
 *   全部成功后才写表；任一失败抛错，旧绑定保留。
 * - 目录与来源均未变化时为 no-op 成功（不触碰 runtime）。
 *
 * deps 由路由装配层注入（生产 server.js / 测试假件）：
 * getAgentRuntime / isManagedRuntimeRunning / stopManagedAgent / readViewerJson。
 */
export async function rebindPhProject(projectId, { workDirectory } = {}, deps = {}) {
  const {
    getAgentRuntime: getRuntime,
    isManagedRuntimeRunning: isRuntimeRunning,
    stopManagedAgent: stopAgent,
    readViewerJson: readViewer,
    readSessionIndex: readIndex = readSessionIndex,
  } = deps;
  if (!getRuntime || !isRuntimeRunning || !stopAgent || !readViewer) {
    throw new Error('rebindPhProject requires lifecycle deps: getAgentRuntime / isManagedRuntimeRunning / stopManagedAgent / readViewerJson');
  }

  const project = await getPhProject(projectId); // 400 非法 ID / 404 未知项目
  const rawDirectory = cleanSessionText(workDirectory);
  const directorySource = rawDirectory ? 'external' : 'managed';
  let resolvedDirectory;
  if (directorySource === 'external') {
    resolvedDirectory = await resolvePhProjectDirectory(rawDirectory); // 400 不存在
  } else {
    resolvedDirectory = getPhManagedProjectDir(project.id);
    await ensureDir(resolvedDirectory);
  }

  if (project.directorySource === directorySource && sameNormalizedDirectory(project.workDirectory, resolvedDirectory)) {
    return { project, releasedSessionIds: [], unchanged: true };
  }

  // 门闩覆盖改绑全程；项目会话成员在窗口内按 fresh 索引刷新——建立前的
  // 索引快照可能已被并发归属转移改写（新成员不在旧快照里就不会被门闩
  // 保护，也不会被释放，改绑落盘后变成旧目录幽灵实例）。
  const rebindGateKey = `rebind:${project.id}`;
  const rebindConflict = beginPhOwnershipGate(
    rebindGateKey,
    [project.id],
    [],
    PH_REBIND_GATE_CODE,
    `PH project ${project.id} is being rebound; retry after the rebind completes`,
  );
  if (rebindConflict) {
    throw ownershipGateError(rebindConflict, `PH project ${project.id} is already being rebound`);
  }
  try {
    // 枚举项目会话（归属规则同 session-project.getSessionProjectId；此处内联
    // 使用同一表达式，避免 ph-projects ↔ session-project 的 import 环）。
    const index = await readIndex(PH_AGENT_ID);
    const sessionIds = (index?.sessions || [])
      .map((record) => ({ id: cleanSessionText(record?.id), projectId: cleanSessionText(record?.projectId) }))
      .filter((item) => item.id && item.projectId === project.id)
      .map((item) => item.id);
    addPhOwnershipGateSessions(rebindGateKey, sessionIds);
    // busy 探测：全部存活实例先探一遍再动手，杜绝"释放了一半才发现 busy"。
    const liveRuntimes = [];
    for (const sessionId of sessionIds) {
      const runtime = getRuntime(PH_AGENT_ID, sessionId);
      if (runtime && isRuntimeRunning(runtime)) liveRuntimes.push(runtime);
    }
    for (const runtime of liveRuntimes) {
      if (!runtime.viewerAgentId) {
        // 存活但无 viewer 身份（启动中）：无法探测，按 busy 拒绝（fail-closed）
        throw rebindBusyError(project.id, runtime.selectedSessionId, 'runtime_starting');
      }
      const probe = await _probeRuntimeBusy(runtime.viewerAgentId, readViewer);
      if (probe.busy) throw rebindBusyError(project.id, runtime.selectedSessionId, probe.reason);
    }

    // 精确释放：带 sessionId + waitForPersistence，共享进程兄弟会话不受影响。
    // 任一持久化确认失败即抛错——旧绑定保留，调用方收到的就是失败。
    const releasedSessionIds = [];
    for (const runtime of liveRuntimes) {
      await stopAgent(PH_AGENT_ID, runtime.selectedSessionId, { waitForPersistence: true });
      releasedSessionIds.push(runtime.selectedSessionId);
    }

    // 全部释放成功后才写表；写表失败同样保留旧绑定。
    const updated = await withStoreWriteLock(async () => {
      const store = await readPhProjectStore();
      const idx = store.projects.findIndex((item) => item.id === project.id);
      if (idx < 0) {
        const error = new Error(`Unknown project: ${project.id}`);
        error.statusCode = 404;
        throw error;
      }
      const next = {
        ...store.projects[idx],
        workDirectory: resolvedDirectory,
        directorySource,
        updatedAt: new Date().toISOString(),
      };
      store.projects.splice(idx, 1, next);
      await writePhProjectStore(store);
      return next;
    });
    return { project: updated, releasedSessionIds, unchanged: false };
  } finally {
    endPhOwnershipGate(rebindGateKey);
  }
}

// ── 项目归档 / 恢复（ticket 046）─────────────────────────────────────────────
//
// 归档只翻项目记录的 archived 位（+archivedAt 时间戳）：会话、项目配置与
// 工作文件全部原样保留，runtime 不失效（与改绑不同，归档不是取消性操作）。
// 「不可用」是选择器层面的隐藏/标注，不是 Session archived 语义——那是另一
// 个既有字段，本项目状态不写入任何 Session 记录。

export async function setPhProjectArchived(projectId, archived, deps = {}) {
  const { withStoreWriteLock: lockFn = withStoreWriteLock } = deps;
  if (!isValidPhProjectId(projectId)) {
    const error = new Error(`Invalid projectId: ${projectId}`);
    error.statusCode = 400;
    throw error;
  }
  // 门闩覆盖归档翻转全程：与改绑 / 转移 / 删除互斥。只查不持有会留下
  // 「归档等表锁期间 move 落盘、归档按陈旧状态翻转」的反向竞态。
  const archiveGateKey = `archive:${projectId}`;
  const archiveConflict = beginPhOwnershipGate(
    archiveGateKey,
    [projectId],
    [],
    PH_ARCHIVE_GATE_CODE,
    `PH project ${projectId} archive state is being changed; retry after it completes`,
  );
  if (archiveConflict) {
    throw ownershipGateError(archiveConflict, `PH project ${projectId} is in an ownership transfer window`);
  }
  try {
    const nextArchived = archived === true;
    return await lockFn(async () => {
      const store = await readPhProjectStore();
      const index = store.projects.findIndex((item) => item.id === projectId);
      if (index < 0) {
        const error = new Error(`Unknown project: ${projectId}`);
        error.statusCode = 404;
        throw error;
      }
      if (store.projects[index].archived === nextArchived) {
        return store.projects[index]; // 幂等：重复归档/恢复 no-op
      }
      const project = {
        ...store.projects[index],
        archived: nextArchived,
        archivedAt: nextArchived ? new Date().toISOString() : null,
        updatedAt: new Date().toISOString(),
      };
      store.projects.splice(index, 1, project);
      await writePhProjectStore(store);
      return project;
    });
  } finally {
    endPhOwnershipGate(archiveGateKey);
  }
}

// ── 项目永久删除（ticket 046）────────────────────────────────────────────────
//
// 按 ID 枚举并删除：项目会话（复用 deletePrebuiltSession：索引 + 会话文件 +
// 搜索索引 + open-sessions tracker 一体清理）、项目层配置文件、项目记录；
// 托管工作目录仅在三重条件同时满足时删除——
//   1. directorySource === 'managed'（托管资产唯一判据，路径位置不参与推断）；
//   2. 路径确实位于数据根的托管区之内（防表被篡改后误删任意路径）；
//   3. 该目录未被任何其他项目 / 目录会话 / 工作空间当前目录引用；
// 且用户在请求里显式携带 deleteManagedDirectory: true（默认 false = 不捎带删）。
// 外部目录绝不删除；用户显式要求删除但条件不满足时整个请求 409 拒绝——
// 不静默保留（调用方会误以为目录已删）也不带病误删。

/** 项目会话枚举（改绑与删除共用）。 */
async function _listProjectSessions(projectId, readIndex) {
  const index = await readIndex(PH_AGENT_ID);
  return (index?.sessions || [])
    .filter((record) => cleanSessionText(record?.projectId) === projectId && cleanSessionText(record?.id))
    .map((record) => ({
      id: cleanSessionText(record?.id),
      title: cleanSessionText(record?.title) || '',
      updatedAt: cleanSessionText(record?.updatedAt) || null,
    }));
}

function isInsidePhManagedRoot(directory) {
  const root = normalizeDirectoryForCompare(PH_MANAGED_PROJECTS_ROOT);
  const dir = normalizeDirectoryForCompare(directory);
  return dir.startsWith(`${root}/`);
}

/**
 * 托管目录的外部引用扫描：其他项目（同目录绑定）、目录会话（无 projectId、
 * openDirectory 指向该目录）、工作空间当前目录选择（目录会话工作区）。
 */
async function _collectDirectoryReferences(project, { readIndex = readSessionIndex, readWorkspaceState = null } = {}) {
  const references = [];
  const store = await readPhProjectStore();
  for (const other of store.projects) {
    if (other.id === project.id) continue;
    if (sameNormalizedDirectory(other.workDirectory, project.workDirectory)) {
      references.push({ kind: 'project', id: other.id, name: other.name });
    }
  }
  const index = await readIndex(PH_AGENT_ID);
  for (const record of index?.sessions || []) {
    if (cleanSessionText(record?.projectId)) continue; // 项目会话目录随项目表走
    const openDirectory = cleanSessionText(record?.openDirectory);
    if (openDirectory && sameNormalizedDirectory(openDirectory, project.workDirectory)) {
      references.push({
        kind: 'session',
        id: cleanSessionText(record?.id),
        title: cleanSessionText(record?.title) || '',
      });
    }
  }
  if (readWorkspaceState) {
    const state = await readWorkspaceState(PH_AGENT_ID).catch(() => null);
    const currentDirectory = cleanSessionText(state?.openDirectory);
    if (currentDirectory && sameNormalizedDirectory(currentDirectory, project.workDirectory)) {
      references.push({ kind: 'workspace_open_directory', id: PH_AGENT_ID });
    }
  }
  return references;
}

/**
 * 删除影响预览：不改动任何状态。列出将被删除的会话、配置文件与托管目录
 * 的可删性判定（含保留原因），供 UI 呈现影响面并收集用户明确选择。
 */
export async function previewPhProjectDeletion(projectId, deps = {}) {
  const {
    readSessionIndex: readIndex = readSessionIndex,
    readWorkspaceState = null,
    projectLayerPath: layerPath = null,
  } = deps;
  const project = await getPhProject(projectId);
  const sessions = await _listProjectSessions(project.id, readIndex);
  const featureConfig = layerPath ? { path: layerPath(project.id), exists: existsSync(layerPath(project.id)) } : null;
  const references = await _collectDirectoryReferences(project, { readIndex, readWorkspaceState });
  const insideRoot = isInsidePhManagedRoot(project.workDirectory);
  const reasons = [];
  if (project.directorySource !== 'managed') reasons.push({ kind: 'external_directory' });
  if (project.directorySource === 'managed' && !insideRoot) reasons.push({ kind: 'outside_managed_root' });
  reasons.push(...references);
  const deletable = reasons.length === 0;
  return {
    project,
    sessions,
    featureConfig,
    managedDirectory: {
      path: project.workDirectory,
      source: project.directorySource,
      deletable,
      reasons,
    },
  };
}

function directoryNotDeletableError(projectId, reasons) {
  const detail = reasons.map((reason) => reason.kind).join(', ');
  const error = new Error(`PH project ${projectId} managed directory cannot be deleted (${detail}); remove the references or delete without the directory`);
  error.statusCode = 409;
  error.code = 'ph_project_directory_not_deletable';
  error.reasons = reasons;
  return error;
}

/**
 * 永久删除项目。deps 注入与 preview 相同（生产 server.js / 测试假件），
 * 另需运行时生命周期依赖：getAgentRuntime / isManagedRuntimeRunning /
 * stopManagedAgent / deletePrebuiltSession / clearUISurfaces。
 *
 * 停止顺序：先按 waitForPersistence 优雅失效（保存会话事实），失败则回退
 * 普通 stopManagedAgent（与单会话删除路由同款硬停兜底）——会话即将删除，
 * 持久化失败不应阻断删除本身；随后 deletePrebuiltSession 清理索引与文件。
 */
export async function deletePhProject(projectId, { deleteManagedDirectory = false } = {}, deps = {}) {
  const {
    getAgentRuntime: getRuntime,
    isManagedRuntimeRunning: isRuntimeRunning,
    stopManagedAgent: stopAgent,
    deletePrebuiltSession: deleteSession,
    clearUISurfaces: clearSurfaces = null,
    readSessionIndex: readIndex = readSessionIndex,
    readWorkspaceState = null,
    projectLayerPath: layerPath = null,
  } = deps;
  if (!getRuntime || !isRuntimeRunning || !stopAgent || !deleteSession) {
    throw new Error('deletePhProject requires lifecycle deps: getAgentRuntime / isManagedRuntimeRunning / stopManagedAgent / deletePrebuiltSession');
  }

  // 门闩覆盖删除全程（枚举 → 释放 → 删文件 → 写表）：只查不持有会留下
  // 「删除 await 停实例期间 move 建窗落盘」的反向竞态；成员在窗口内按
  // fresh 索引刷新。
  const deleteGateKey = `delete:${projectId}`;
  const deleteConflict = beginPhOwnershipGate(
    deleteGateKey,
    [projectId],
    [],
    PH_DELETE_GATE_CODE,
    `PH project ${projectId} is being deleted; retry after it completes`,
  );
  if (deleteConflict) {
    throw ownershipGateError(deleteConflict, `PH project ${projectId} is in an ownership transfer window`);
  }
  try {
    const project = await getPhProject(projectId);
    const sessions = await _listProjectSessions(project.id, readIndex);
    addPhOwnershipGateSessions(deleteGateKey, sessions.map((session) => session.id));

    // 托管目录删除判定（与 preview 同源）。显式要求但不可删 → 整个请求拒绝，
    // 不做「删了项目却悄悄留下目录」的半成功。
    let removeManagedDirectory = false;
    if (deleteManagedDirectory === true) {
      const preview = await previewPhProjectDeletion(projectId, { readIndex, readWorkspaceState, projectLayerPath: layerPath });
      if (!preview.managedDirectory.deletable) {
        throw directoryNotDeletableError(projectId, preview.managedDirectory.reasons);
      }
      removeManagedDirectory = true;
    }

    // 1) 存活 runtime 逐会话精确失效（共享进程兄弟会话——其他项目/目录的
    //    会话——不经此路径，不受影响）。
    const stoppedViewerAgentIds = [];
    for (const session of sessions) {
      const runtime = getRuntime(PH_AGENT_ID, session.id);
      if (runtime?.viewerAgentId) stoppedViewerAgentIds.push(runtime.viewerAgentId);
      if (!runtime || !isRuntimeRunning(runtime)) continue;
      try {
        await stopAgent(PH_AGENT_ID, session.id, { waitForPersistence: true });
      } catch (error) {
        console.warn(`[ph-projects] graceful stop failed before delete, falling back to hard stop: ${session.id}:`, error?.message || error);
        await stopAgent(PH_AGENT_ID, session.id);
      }
    }

    // 2) 逐会话删除（索引 + 会话文件 + 搜索索引 + tracker 一体清理）。
    const deletedSessions = [];
    for (const session of sessions) {
      try {
        await deleteSession(PH_AGENT_ID, session.id);
        deletedSessions.push(session.id);
      } catch (error) {
        if (error?.statusCode !== 404) throw error; // 已不存在的会话视为已删
      }
    }

    // 3) UI surface 缓存清理（与单会话删除路由同款善后）。
    if (clearSurfaces) {
      for (const viewerAgentId of stoppedViewerAgentIds) clearSurfaces(viewerAgentId);
    }

    // 4) 项目层配置文件删除（best-effort，缺失不算失败）。
    let featureConfigDeleted = false;
    if (layerPath) {
      const configPath = layerPath(project.id);
      featureConfigDeleted = await fs.rm(configPath, { force: true }).then(() => true, () => false);
    }

    // 5) 托管目录删除：三重条件已在上方判定，此处只做物理移除。
    let managedDirectoryDeleted = false;
    if (removeManagedDirectory) {
      await fs.rm(project.workDirectory, { recursive: true, force: true });
      managedDirectoryDeleted = true;
    }

    // 6) 项目记录移除。
    await withStoreWriteLock(async () => {
      const store = await readPhProjectStore();
      const index = store.projects.findIndex((item) => item.id === project.id);
      if (index < 0) {
        const error = new Error(`Unknown project: ${projectId}`);
        error.statusCode = 404;
        throw error;
      }
      store.projects.splice(index, 1);
      await writePhProjectStore(store);
    });

    return {
      project,
      deletedSessions,
      featureConfigDeleted,
      managedDirectory: {
        path: project.workDirectory,
        deleted: managedDirectoryDeleted,
        deleteRequested: deleteManagedDirectory === true,
      },
    };
  } finally {
    endPhOwnershipGate(deleteGateKey);
  }
}



// ── PH 会话归属转移（sessions_move）────────────────────────────────────────
//
// 同一有效工作目录内，把 Session 的正式归属在「默认目录 ↔ 项目」与
// 「项目 A ↔ 项目 B」之间转移（移动非复制）：
// - 只改索引记录的归属字段（projectId / openDirectory）：会话 id、历史、
//   workspaceAgentId、checkpoint 等全部保留，会话文件本体一字节不动；
// - 全部先校验后释放：busy（执行中轮次 / 排队输入 / 探测失败）409 拒绝且
//   零状态变化；批量预校验不通过绝不部分改归属；
// - 空闲存活实例按「精确单会话 + waitForPersistence」安全失效（共享进程
//   兄弟会话不受影响），下次启动按目标归属重新装配（runtime 逐实例读索引
//   projectId 选项目配置层，run-prebuilt-agent ticket 043）；
// - 释放窗口经归属门闩拒绝新输入 / 新启动 / 派生会话；涉及项目（来源 +
//   目标）窗口内拒绝改绑 / 归档 / 删除；
// - 归属无变化（会话已在目标集合）为 no-op 成功：不停实例、不重写索引、
//   不递增 revision；
// - 目标项目未知 / 已归档、跨有效目录、无效 Session → 显式失败，不自动
//   回退、不猜测。

function moveRequestError(message, code, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

/** 目标描述（响应回显用）：解析后的归属身份 + 有效目录。 */
function describeMoveTarget(targetType, targetProject, targetDirectory) {
  return targetType === 'project'
    ? { type: 'project', id: targetProject.id, workDirectory: targetProject.workDirectory }
    : { type: 'directory', openDirectory: targetDirectory };
}

/**
 * 会话索引记录 → 目标归属字段。project 目标：projectId + 项目当前目录
 * （与 createPrebuiltSession 的项目会话写法对齐）；directory 目标：
 * 删除 projectId（目录会话无此字段，与历史记录形态一致）+ 目标目录。
 */
function applyMoveOwnership(record, targetType, targetProject, targetDirectory) {
  const next = { ...record };
  if (targetType === 'project') {
    next.projectId = targetProject.id;
    next.openDirectory = targetProject.workDirectory;
  } else {
    delete next.projectId;
    next.openDirectory = targetDirectory;
  }
  return next;
}

/** 记录当前归属是否已等于目标（幂等重试 / no-op 判定）。 */
function recordMatchesMoveTarget(record, targetType, targetProjectId, targetDirectory) {
  if (targetType === 'project') {
    return cleanSessionText(record?.projectId) === targetProjectId;
  }
  return !cleanSessionText(record?.projectId)
    && sameNormalizedDirectory(cleanSessionText(record?.openDirectory), targetDirectory);
}

/**
 * PH 会话归属转移编排（单条/批量共用）。deps 与 rebindPhProject 同源注入
 * （生产 server.js / 测试假件）：getAgentRuntime / isManagedRuntimeRunning /
 * stopManagedAgent / readViewerJson，另可注入 readSessionIndex /
 * updateSessionIndex（缺省走 server/shared/session-access.js）。
 */
export async function movePhSessions({ sessionIds, target } = {}, deps = {}) {
  const {
    getAgentRuntime: getRuntime,
    isManagedRuntimeRunning: isRuntimeRunning,
    stopManagedAgent: stopAgent,
    readViewerJson: readViewer,
    readSessionIndex: readIndex = readSessionIndex,
    updateSessionIndex: updateIndex = updateSessionIndex,
  } = deps;
  if (!getRuntime || !isRuntimeRunning || !stopAgent || !readViewer) {
    throw new Error('movePhSessions requires lifecycle deps: getAgentRuntime / isManagedRuntimeRunning / stopManagedAgent / readViewerJson');
  }

  // ── 参数与目标解析（失败零状态变化）──────────────────────────────
  if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
    throw moveRequestError('sessionIds must be a non-empty array', 'ph_sessions_move_invalid_request');
  }
  const uniqueSessionIds = [];
  const seenIds = new Set();
  for (const raw of sessionIds) {
    const id = cleanSessionText(raw);
    if (!id) {
      throw moveRequestError(`sessionIds contains an invalid entry: ${JSON.stringify(raw)}`, 'ph_sessions_move_invalid_request');
    }
    if (!seenIds.has(id)) {
      seenIds.add(id);
      uniqueSessionIds.push(id);
    }
  }

  const targetType = target?.type;
  if (targetType !== 'project' && targetType !== 'directory') {
    throw moveRequestError(`target.type must be "project" or "directory": ${JSON.stringify(targetType)}`, 'ph_sessions_move_invalid_request');
  }
  let targetProject = null;
  let targetDirectory = '';
  if (targetType === 'project') {
    const targetProjectId = cleanSessionText(target.id);
    if (!isValidPhProjectId(targetProjectId)) {
      throw moveRequestError(`Invalid projectId: ${targetProjectId}`, 'ph_sessions_move_invalid_request');
    }
    try {
      targetProject = await getPhProject(targetProjectId); // 400 非法 / 404 未知
    } catch (error) {
      if (error?.statusCode === 404) error.code = 'ph_project_unknown';
      throw error;
    }
    if (targetProject.archived) {
      throw moveRequestError(
        `PH project ${targetProject.id} is archived; cannot move sessions into an archived project`,
        'ph_project_archived',
        409,
      );
    }
    // 有效目录契约与 directory 分支对齐：目录不在盘上就拒绝（落盘后的下次
    // 启动 resolveSessionRuntimeDirectory 也会因目录缺失而失败，提前给明确错）。
    if (!existsSync(targetProject.workDirectory)) {
      throw moveRequestError(
        `PH project ${targetProject.id} work directory does not exist: ${targetProject.workDirectory}`,
        'ph_project_directory_missing',
        409,
      );
    }
    targetDirectory = targetProject.workDirectory;
  } else {
    targetDirectory = await resolvePhProjectDirectory(target.openDirectory); // 400 不存在
  }

  // ── 批量预校验（全部通过才动手，绝不部分改归属）──────────────────
  const index = await readIndex(PH_AGENT_ID);
  const recordsById = new Map(
    (index?.sessions || [])
      .filter((record) => cleanSessionText(record?.id))
      .map((record) => [cleanSessionText(record?.id), record]),
  );
  const store = await readPhProjectStore();
  const projectsById = new Map(store.projects.map((project) => [project.id, project]));

  const toMove = [];
  for (const sessionId of uniqueSessionIds) {
    const record = recordsById.get(sessionId);
    if (!record) {
      throw moveRequestError(`Unknown session: ${sessionId}`, 'ph_session_unknown', 404);
    }
    if (recordMatchesMoveTarget(record, targetType, targetProject?.id || '', targetDirectory)) {
      continue; // 已在目标集合：no-op 成员，不动实例不改索引
    }
    const sourceProjectId = cleanSessionText(record?.projectId);
    let currentDirectory;
    if (sourceProjectId) {
      const sourceProject = projectsById.get(sourceProjectId) || null;
      if (!sourceProject) {
        throw moveRequestError(
          `Session ${sessionId} belongs to unknown PH project ${sourceProjectId}`,
          'ph_session_source_project_unknown',
          409,
        );
      }
      currentDirectory = sourceProject.workDirectory;
    } else {
      currentDirectory = cleanSessionText(record?.openDirectory);
      if (!currentDirectory) {
        throw moveRequestError(
          `Session ${sessionId} has no resolvable working directory`,
          'ph_session_directory_unresolved',
          409,
        );
      }
    }
    if (!sameNormalizedDirectory(currentDirectory, targetDirectory)) {
      throw moveRequestError(
        `Session ${sessionId} belongs to ${currentDirectory}; move target directory is ${targetDirectory} (cross-directory moves are not supported)`,
        'ph_session_cross_directory',
        409,
      );
    }
    toMove.push({ sessionId, sourceProjectId });
  }

  // 全员 no-op：归属无改动成功，不触碰 runtime、不重写索引、不递增 revision。
  if (toMove.length === 0) {
    return {
      movedSessionIds: [],
      releasedSessionIds: [],
      revision: Number(index?.revision) || 0,
      target: describeMoveTarget(targetType, targetProject, targetDirectory),
    };
  }

  // ── 与既有归属释放窗口互斥（项目级 + 会话级，防改绑/移动并发竞态）──
  const involvedProjectIds = new Set(toMove.map((item) => item.sourceProjectId).filter(Boolean));
  if (targetProject) involvedProjectIds.add(targetProject.id);
  for (const projectId of involvedProjectIds) {
    const activeGate = getPhProjectGateInfo(projectId);
    if (activeGate) {
      throw ownershipGateError(activeGate, `PH project ${projectId} is in an ownership transfer window`);
    }
  }
  for (const item of toMove) {
    const activeGate = getPhSessionGateInfo(item.sessionId);
    if (activeGate) {
      throw ownershipGateError(activeGate, `Session ${item.sessionId} is in an ownership transfer window`);
    }
  }

  // ── 释放窗口（门闩建立 → busy 探测 → 精确释放 → 落盘）────────────
  const movingIds = toMove.map((item) => item.sessionId);
  const plansById = new Map(toMove.map((item) => [item.sessionId, item]));
  const moveGateKey = `move:${crypto.randomUUID()}`;
  const conflictGate = beginPhOwnershipGate(
    moveGateKey,
    [...involvedProjectIds],
    movingIds,
    PH_MOVE_GATE_CODE,
    'PH session ownership move is in progress; retry after it completes',
  );
  if (conflictGate) {
    throw ownershipGateError(conflictGate, 'PH sessions move conflicts with an in-flight ownership transfer');
  }
  try {
    // busy 探测：全部存活实例先探一遍再动手，杜绝「释放了一半才发现 busy」。
    const liveRuntimes = [];
    for (const sessionId of movingIds) {
      const runtime = getRuntime(PH_AGENT_ID, sessionId);
      if (runtime && isRuntimeRunning(runtime)) liveRuntimes.push(runtime);
    }
    for (const runtime of liveRuntimes) {
      if (!runtime.viewerAgentId) {
        // 存活但无 viewer 身份（启动中）：无法探测，按 busy 拒绝（fail-closed）
        throw moveRequestError(
          `Sessions are busy (runtime_starting); move is rejected: session=${runtime.selectedSessionId}`,
          'ph_sessions_busy',
          409,
        );
      }
      const probe = await _probeRuntimeBusy(runtime.viewerAgentId, readViewer);
      if (probe.busy) {
        throw moveRequestError(
          `Sessions are busy (${probe.reason}); move is rejected: session=${runtime.selectedSessionId}`,
          'ph_sessions_busy',
          409,
        );
      }
    }

    // 精确释放：带 sessionId + waitForPersistence，共享进程兄弟会话不受影响。
    // 任一持久化确认失败即抛错——归属保持原样，调用方收到的就是失败。
    const releasedSessionIds = [];
    for (const runtime of liveRuntimes) {
      await stopAgent(PH_AGENT_ID, runtime.selectedSessionId, { waitForPersistence: true });
      releasedSessionIds.push(runtime.selectedSessionId);
    }

    // 落盘：门闩建立前的预读一律视为过期，锁内按 fresh 事实全量重验——
    // 目标（项目存在/未归档/目录在盘，或目录目标仍在盘）、会话仍在、归属
    // 未被并发改变、逐会话有效目录（来源项目表现值或记录 openDirectory）
    // 仍与目标目录一致（窗口前按陈旧目录通过的预校验在这里被拦截）。
    // 任一不满足立即抛错——索引不写，归属不变。
    const updatedIndex = await updateIndex(PH_AGENT_ID, async (current) => {
      const freshStore = await readPhProjectStore();
      if (targetType === 'project') {
        const freshTarget = freshStore.projects.find((project) => project.id === targetProject.id) || null;
        if (!freshTarget) {
          throw moveRequestError(`Unknown project: ${targetProject.id}`, 'ph_project_unknown', 404);
        }
        if (freshTarget.archived) {
          throw moveRequestError(
            `PH project ${targetProject.id} is archived; cannot move sessions into an archived project`,
            'ph_project_archived',
            409,
          );
        }
        if (!existsSync(cleanSessionText(freshTarget.workDirectory))) {
          throw moveRequestError(
            `PH project ${freshTarget.id} work directory does not exist: ${freshTarget.workDirectory}`,
            'ph_project_directory_missing',
            409,
          );
        }
        targetProject = freshTarget;
        targetDirectory = cleanSessionText(freshTarget.workDirectory);
      } else if (!existsSync(targetDirectory)) {
        throw moveRequestError(`Target directory does not exist: ${targetDirectory}`, 'ph_project_directory_missing', 409);
      }
      const currentIds = new Set((current.sessions || []).map((record) => cleanSessionText(record?.id)));
      for (const sessionId of movingIds) {
        if (!currentIds.has(sessionId)) {
          throw moveRequestError(`Unknown session: ${sessionId}`, 'ph_session_unknown', 404);
        }
      }
      const freshProjectDirs = new Map(
        freshStore.projects.map((project) => [project.id, cleanSessionText(project.workDirectory)]),
      );
      let changed = false;
      const nextSessions = (current.sessions || []).map((record) => {
        const sessionId = cleanSessionText(record?.id);
        if (!plansById.has(sessionId)) return record;
        if (recordMatchesMoveTarget(record, targetType, targetProject?.id || '', targetDirectory)) {
          return record; // 已在目标（幂等重试）：不再改写
        }
        const currentProjectId = cleanSessionText(record?.projectId);
        if (currentProjectId !== plansById.get(sessionId).sourceProjectId) {
          // 窗口内归属被并发改变：拒绝继续，绝不盲目覆写
          throw moveRequestError(
            `Session ${sessionId} ownership changed during the move window`,
            'ph_sessions_move_conflict',
            409,
          );
        }
        const currentDirectory = currentProjectId
          ? (freshProjectDirs.get(currentProjectId) || '')
          : cleanSessionText(record?.openDirectory);
        if (!currentDirectory || !sameNormalizedDirectory(currentDirectory, targetDirectory)) {
          throw moveRequestError(
            `Session ${sessionId} effective directory (${currentDirectory || 'unresolved'}) no longer matches the move target (${targetDirectory}); retry the move`,
            'ph_sessions_move_conflict',
            409,
          );
        }
        changed = true;
        return applyMoveOwnership(record, targetType, targetProject, targetDirectory);
      });
      if (!changed) return current;
      return { ...current, sessions: nextSessions };
    });

    // 从落盘后的事实回读实际归属（幂等重试时也如实报告）
    const movedSessionIds = (updatedIndex?.sessions || [])
      .filter((record) => plansById.has(cleanSessionText(record?.id))
        && recordMatchesMoveTarget(record, targetType, targetProject?.id || '', targetDirectory))
      .map((record) => cleanSessionText(record?.id));

    return {
      movedSessionIds,
      releasedSessionIds,
      revision: Number(updatedIndex?.revision) || 0,
      target: describeMoveTarget(targetType, targetProject, targetDirectory),
    };
  } finally {
    endPhOwnershipGate(moveGateKey);
  }
}

// ── Routes ───────────────────────────────────────────────────────────────────
// 与既有 ph_project 路由同款守卫：agentId 缺省 programming-helper，
// PH_STYLE_WORKSPACE_AGENT_IDS 之外的 agentId 直接 400。

function phProjectAgentIdGuard(value) {
  const agentId = typeof value === 'string' ? value.trim() : PH_AGENT_ID;
  if (!PH_STYLE_WORKSPACE_AGENT_IDS.has(agentId)) {
    const error = new Error(`agentId is not supported for ph_project: ${agentId}`);
    error.statusCode = 400;
    return error;
  }
  return null;
}

export function setupPhProjectRoutes(app, express, deps = {}) {
  app.post('/protoclaw/ph_project/project_rebind', express.json(), async (req, res, next) => {
    try {
      const guardError = phProjectAgentIdGuard(req.body?.agentId);
      if (guardError) throw guardError;
      const projectId = typeof req.body?.projectId === 'string' ? req.body.projectId.trim() : '';
      if (!isValidPhProjectId(projectId)) {
        const error = new Error(`Invalid projectId: ${projectId}`);
        error.statusCode = 400;
        throw error;
      }
      const result = await rebindPhProject(projectId, { workDirectory: req.body?.workDirectory }, deps);
      res.json({
        ok: true,
        project: result.project,
        releasedSessionIds: result.releasedSessionIds,
        unchanged: result.unchanged,
      });
    } catch (error) {
      next(error);
    }
  });

  app.post('/protoclaw/ph_project/sessions_move', express.json(), async (req, res, next) => {
    try {
      const guardError = phProjectAgentIdGuard(req.body?.agentId);
      if (guardError) throw guardError;
      const result = await movePhSessions({
        sessionIds: req.body?.sessionIds,
        target: req.body?.target,
      }, deps);
      res.json({
        ok: true,
        movedSessionIds: result.movedSessionIds,
        releasedSessionIds: result.releasedSessionIds,
        revision: result.revision,
        target: result.target,
      });
    } catch (error) {
      next(error);
    }
  });

  app.post('/protoclaw/ph_project/project_archive', express.json(), async (req, res, next) => {
    try {
      const guardError = phProjectAgentIdGuard(req.body?.agentId);
      if (guardError) throw guardError;
      const projectId = typeof req.body?.projectId === 'string' ? req.body.projectId.trim() : '';
      if (!isValidPhProjectId(projectId)) {
        const error = new Error(`Invalid projectId: ${projectId}`);
        error.statusCode = 400;
        throw error;
      }
      const project = await setPhProjectArchived(projectId, req.body?.archived === true);
      res.json({ ok: true, project });
    } catch (error) {
      next(error);
    }
  });

  app.get('/protoclaw/ph_project/project_delete_preview', async (req, res, next) => {
    try {
      const guardError = phProjectAgentIdGuard(req.query?.agentId);
      if (guardError) throw guardError;
      const projectId = typeof req.query?.projectId === 'string' ? req.query.projectId.trim() : '';
      if (!isValidPhProjectId(projectId)) {
        const error = new Error(`Invalid projectId: ${projectId}`);
        error.statusCode = 400;
        throw error;
      }
      res.json({ ok: true, ...(await previewPhProjectDeletion(projectId, deps)) });
    } catch (error) {
      next(error);
    }
  });

  app.post('/protoclaw/ph_project/project_delete', express.json(), async (req, res, next) => {
    try {
      const guardError = phProjectAgentIdGuard(req.body?.agentId);
      if (guardError) throw guardError;
      const projectId = typeof req.body?.projectId === 'string' ? req.body.projectId.trim() : '';
      if (!isValidPhProjectId(projectId)) {
        const error = new Error(`Invalid projectId: ${projectId}`);
        error.statusCode = 400;
        throw error;
      }
      // 托管目录删除必须是用户显式选择（默认 false = 只删项目与会话，
      // 目录原样保留）。影响预览与二次确认在前端完成，服务端只认显式布尔。
      const result = await deletePhProject(
        projectId,
        { deleteManagedDirectory: req.body?.deleteManagedDirectory === true },
        deps,
      );
      res.json({ ok: true, ...result });
    } catch (error) {
      next(error);
    }
  });

  app.get('/protoclaw/ph_project/projects', async (req, res, next) => {
    try {
      const guardError = phProjectAgentIdGuard(req.query?.agentId);
      if (guardError) throw guardError;
      res.json({ ok: true, projects: await listPhProjects() });
    } catch (error) {
      next(error);
    }
  });

  app.get('/protoclaw/ph_project/project', async (req, res, next) => {
    try {
      const guardError = phProjectAgentIdGuard(req.query?.agentId);
      if (guardError) throw guardError;
      const projectId = typeof req.query?.projectId === 'string' ? req.query.projectId.trim() : '';
      if (!projectId) {
        const error = new Error('projectId is required');
        error.statusCode = 400;
        throw error;
      }
      res.json({ ok: true, project: await getPhProject(projectId) });
    } catch (error) {
      next(error);
    }
  });

  app.post('/protoclaw/ph_project/project_create', express.json(), async (req, res, next) => {
    try {
      const guardError = phProjectAgentIdGuard(req.body?.agentId);
      if (guardError) throw guardError;
      const project = await createPhProject({
        name: req.body?.name,
        workDirectory: req.body?.workDirectory,
      });
      res.json({ ok: true, project });
    } catch (error) {
      next(error);
    }
  });

  app.post('/protoclaw/ph_project/project_rename', express.json(), async (req, res, next) => {
    try {
      const guardError = phProjectAgentIdGuard(req.body?.agentId);
      if (guardError) throw guardError;
      const projectId = typeof req.body?.projectId === 'string' ? req.body.projectId.trim() : '';
      if (!isValidPhProjectId(projectId)) {
        const error = new Error(`Invalid projectId: ${projectId}`);
        error.statusCode = 400;
        throw error;
      }
      const project = await renamePhProject(projectId, req.body?.name);
      res.json({ ok: true, project });
    } catch (error) {
      next(error);
    }
  });
}
