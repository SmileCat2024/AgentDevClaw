import path from 'path';
import { readFileSync, existsSync, renameSync, readdirSync } from 'fs';
import { promises as fs } from 'fs';
import { DatabaseSync } from 'node:sqlite';
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
import { ensureDir } from './fs-helpers.js';

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

// ── Session index storage（SQLite，ADR-0036）────────────────────────
//
// 会话索引的持久层是每工作空间一个 index.db（node:sqlite，Node 24 内置，
// 开发与桌面运行时同钉 24.19.0）。历史形态 index.json 在首次访问前由
// 启动自迁移（migrateAllPrebuiltSessionIndexes）或访问兜底（ensureSessionDb）
// 收敛为 db + index.migrated.json 留档，不保留 JSON 读写双链路。
//
// 读写契约与 JSON 时代完全一致（返回形状、revision 单调、sinceRevision
// 条件刷新、readSessionIndex 返回可突变副本），消费方零改动。归一化时机
// 从读侧移到写侧：库里存的 record 就是归一化形态，读路径直接返回存储形态。

// agentId → DatabaseSync 长开连接。DatabaseSync 为同步 API，同一连接上
// 语句天然串行；连接不跨进程（外部读者用只读连接，见 mirror-runtime）。
const _dbConnections = new Map();

// readSessionIndexShared 的进程内读缓存，键 = (meta.revision, PRAGMA data_version)。
// revision 覆盖本进程与外部写者经 API 的变更；data_version 兜底探测绕过 API
// 直连 db 改写 sessions 而不动 meta 的外部写。命中返回同一稳定对象（共享只读
// 契约，findPrebuiltSessionRecordShared 等下游 WeakMap 身份键依赖此语义）。
const _indexReadCache = new Map();

// db → 预编译语句。高频读路径（侧栏轮询每秒多次）避免逐次 prepare。
const _stmtCache = new WeakMap();

function getSessionStatements(db) {
  let stmts = _stmtCache.get(db);
  if (!stmts) {
    stmts = {
      getMeta: db.prepare('SELECT value FROM meta WHERE key = ?'),
      setMeta: db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)'),
      listRecords: db.prepare('SELECT record FROM sessions ORDER BY position'),
      clearSessions: db.prepare('DELETE FROM sessions'),
      insertSession: db.prepare(`INSERT INTO sessions (
        id, position, record, updated_at, archived, project_id,
        open_directory, session_type, workspace_agent_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      updateSessionRecord: db.prepare(`UPDATE sessions SET
        record = ?, updated_at = ?, archived = ?, project_id = ?,
        open_directory = ?, session_type = ?, workspace_agent_id = ?, created_at = ?
      WHERE id = ?`),
      dataVersion: db.prepare('PRAGMA data_version'),
    };
    _stmtCache.set(db, stmts);
  }
  return stmts;
}

function getSessionDbPath(agentId) {
  return path.join(getPrebuiltAgentSessionDir(agentId), 'index.db');
}

function openSessionDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.function('session_contains', (value, query) => String(value || '').toLowerCase().includes(String(query || '')) ? 1 : 0);
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      position INTEGER NOT NULL,
      record TEXT NOT NULL,
      updated_at TEXT,
      archived INTEGER,
      project_id TEXT,
      open_directory TEXT,
      session_type TEXT,
      workspace_agent_id TEXT,
      created_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_order ON sessions(updated_at DESC, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);
  `);
  return db;
}

// 冗余列与 position 由同一事务从 record 提取，不构成第二事实源；position 承载
// 数组顺序（持久事实），读时 ORDER BY position 还原。
function sessionRowValues(record, position) {
  return [
    String(record.id),
    position,
    JSON.stringify(record),
    record.updatedAt ?? null,
    record.archived === true ? 1 : 0,
    record.projectId ?? null,
    record.openDirectory ?? null,
    record.sessionType ?? null,
    record.workspaceAgentId ?? null,
    record.createdAt ?? null,
  ];
}

// JSON → db 一次性迁移（幂等）。事务内导入后 COMMIT，再把 index.json 改名留档：
// COMMIT 前崩溃 db 无数据、JSON 原样，重试重新导入；COMMIT 后改名前崩溃，重试
// 检测到 meta 已有 revision 即跳过导入、直接完成改名。JSON 损坏时不迁移不抛错，
// 保持 JSON 原状（与 JSON 时代"索引损坏返回空索引"的容错语义一致）。
function migrateJsonIndexIntoDb(agentId, db, jsonPath) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(jsonPath, 'utf8'));
  } catch {
    return false;
  }
  const normalized = normalizeSessionIndexData(parsed);
  const stmts = getSessionStatements(db);
  db.exec('BEGIN IMMEDIATE');
  try {
    const hasRevision = stmts.getMeta.get('revision');
    if (!hasRevision) {
      stmts.clearSessions.run();
      normalized.sessions.forEach((record, i) => stmts.insertSession.run(...sessionRowValues(record, i)));
      stmts.setMeta.run('revision', String(normalized.revision));
      stmts.setMeta.run('activeSessionId', normalized.activeSessionId ?? '');
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  renameSync(jsonPath, `${jsonPath.slice(0, -'index.json'.length)}index.migrated.json`);
  return true;
}

// 确保工作空间索引的 db 连接可用；返回 null 表示"无 db 且无遗留 JSON"的空索引
// 语义（不建库——与 JSON 时代"无 index.json 不建文件"对齐，首次写时才建库）。
function ensureSessionDb(agentId) {
  let db = _dbConnections.get(agentId);
  if (db) return db;
  const dbPath = getSessionDbPath(agentId);
  const jsonPath = getPrebuiltSessionIndexPath(agentId);
  const dbExists = existsSync(dbPath);
  const jsonExists = existsSync(jsonPath);
  if (!dbExists && !jsonExists) return null;
  db = openSessionDb(dbPath);
  if (jsonExists) {
    migrateJsonIndexIntoDb(agentId, db, jsonPath);
  }
  _dbConnections.set(agentId, db);
  return db;
}

// 写路径用：无库时建库（目录由调用方 ensureDir）。
function ensureOrCreateSessionDb(agentId) {
  const db = ensureSessionDb(agentId);
  if (db) return db;
  const created = openSessionDb(getSessionDbPath(agentId));
  _dbConnections.set(agentId, created);
  return created;
}

// 关闭全部连接并清空读缓存。测试收尾（临时数据根 rmSync 前释放文件句柄）与
// 进程级重置用；server 正常运行无需调用（进程退出自动释放）。
export function closeAllSessionDbs() {
  for (const db of _dbConnections.values()) {
    try { db.close(); } catch { /* 已关闭 */ }
  }
  _dbConnections.clear();
  _indexReadCache.clear();
}

// 服务启动全量自迁移（ADR-0036 决策 5）：扫描两个数据根下所有遗留 index.json，
// 逐工作空间迁移；单工作空间失败按 ADR-0032 先例告警不阻断，保持 JSON 原状，
// 下次启动或首次访问时重试。
export function migrateAllPrebuiltSessionIndexes(warn = console.warn) {
  const migrated = [];
  // resolveAgentDir 返回该 agentId 的 sessions 目录；agentFilter 校验目录归属
  //（workspaces/<id>/sessions 只对集合内 agent 成立，防止把不在集合的目录
  // 错位迁移到 prebuilt-sessions/<id> 的寻址上）。
  const visit = (root, agentFilter, resolveAgentDir) => {
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      return; // 数据根不存在：全新安装
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !agentFilter(entry.name)) continue;
      const agentId = entry.name;
      const jsonPath = path.join(resolveAgentDir(agentId), 'index.json');
      if (!existsSync(jsonPath)) continue;
      try {
        const db = ensureSessionDb(agentId);
        if (!db) throw new Error('migration produced no db');
        // 损坏 JSON 无法迁移也无需重试（migrateJsonIndexIntoDb 内部容错为空索引
        // 语义）：文件保持原状但不计入 migrated，避免每次启动重复计入。
        if (existsSync(jsonPath)) continue;
        migrated.push(agentId);
      } catch (err) {
        warn(`[session-index] 迁移 ${agentId} 失败（保持 JSON 原状，下次重试）: ${err?.message || err}`);
      }
    }
  };
  // 非 workspace 型：sessions 根 = prebuilt-sessions/<agentId>/
  visit(
    PREBUILT_SESSIONS_ROOT,
    (agentId) => !isWorkspaceSessionAgent(agentId),
    (agentId) => path.join(PREBUILT_SESSIONS_ROOT, agentId),
  );
  // workspace 型：sessions 根 = workspaces/<agentId>/sessions/
  visit(
    PREBUILT_WORKSPACES_ROOT,
    (agentId) => isWorkspaceSessionAgent(agentId),
    (agentId) => path.join(PREBUILT_WORKSPACES_ROOT, agentId, 'sessions'),
  );
  return migrated;
}

function loadIndexFromDb(agentId, db) {
  const stmts = getSessionStatements(db);
  const revisionRow = stmts.getMeta.get('revision');
  const revision = Number(revisionRow?.value);
  const activeSessionId = stmts.getMeta.get('activeSessionId')?.value || null;
  const sessions = stmts.listRecords.all().map((row) => JSON.parse(row.record));
  return {
    revision: Number.isSafeInteger(revision) && revision >= 0 ? revision : 0,
    activeSessionId,
    sessions,
  };
}

function readMetaRevision(db) {
  const value = Number(getSessionStatements(db).getMeta.get('revision')?.value);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function readDataVersion(db) {
  return getSessionStatements(db).dataVersion.get().data_version;
}

// 单条记录归一化：读侧（迁移导入）与写侧（updateSessionIndex / writeSessionIndex
// 提交前）共用。字段语义见各行内注释；归一化后形态即 db 存储形态。
function normalizeSessionRecord(session) {
  return {
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
    // PH 项目会话归属（ticket 042）：只归一非空值，不给无此字段的历史记录补
    // key——updateSessionIndex 是"读（归一形态）→ 改 → 写回"的 round-trip，
    // 无条件归一会让任何一次索引写入（meta_sync/标题/激活）给全部旧记录批量
    // 落上 projectId:''，违反"无历史批量补字段"验收。
    // 目录会话旧记录保持字段缺席，消费方经 getSessionProjectId 读作 ''。
    ...(cleanSessionText(session.projectId) ? { projectId: cleanSessionText(session.projectId) } : {}),
    sessionType: cleanSessionText(session.sessionType) || 'main',
    workspaceAgentId: session.workspaceAgentId === undefined ? 'main' : session.workspaceAgentId,
    archived: session.archived === true,
    todo: session.todo === true,
    metadata: normalizeSessionMetadata(session.metadata),
  };
}

// 全量索引形态归一化：legacy 记录过滤 + revision / activeSessionId 校验。
// 仅用于迁移导入与整份写入（writeSessionIndex）；updateSessionIndex 的增量
// 提交只对变更行调 normalizeSessionRecord。
function normalizeSessionIndexData(data) {
  const sessions = Array.isArray(data.sessions)
    ? data.sessions
      .filter((session) => session && session.id && session.id !== 'legacy')
      .map((session) => normalizeSessionRecord(session))
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
 * readSessionIndex 的共享只读变体：命中读缓存时直接返回缓存对象，不做
 * structuredClone。面向高频批量只读路径（如线程列表逐线程解析 head 会话
 * 字段）——逐调用 clone 整份索引的同步成本随线程数线性放大，会持续占据
 * 事件循环。下游 findPrebuiltSessionRecordShared、投影缓存以对象身份为
 * WeakMap 键，依赖"同一 revision 下返回同一稳定对象"的语义。
 *
 * 契约：调用方只读返回值，不得修改（会污染缓存）；需要可变副本时用
 * readSessionIndex。无索引数据（无 db 且无遗留 JSON）时返回全新空索引对象。
 */
export async function readSessionIndexShared(agentId) {
  await ensureDir(getPrebuiltAgentSessionDir(agentId));
  const db = ensureSessionDb(agentId);
  if (!db) {
    return { revision: 0, activeSessionId: null, sessions: [] };
  }
  const cached = _indexReadCache.get(agentId);
  const revision = readMetaRevision(db);
  const dataVersion = readDataVersion(db);
  if (cached && cached.revision === revision && cached.dataVersion === dataVersion) {
    return cached.value;
  }
  const value = loadIndexFromDb(agentId, db);
  _indexReadCache.set(agentId, { revision: value.revision, dataVersion, value });
  return value;
}

// ── 会话列表 SQL 查询（ADR-0036 后续）───────────────────────────────
// 项目/目录/标题搜索过滤、线程 head/归档过滤、计数与分页在 SQLite 内完成。
// 线程状态仍以 thread store 为权威；只读快照装入连接级 TEMP 表，成员表
// 对象身份未变时跳过重装。同一只读事务保证计数与页面看到相同索引快照。
//
// 谓词全部 CASE 守卫：SQLite 不保证 OR 短路求值，空参数路径若仍逐行执行
// json_extract（每行解析整条 record JSON）会引入毫秒级退化——CASE 只求值
// 命中分支。目录归一化用内置 replace/lower/rtrim（C 实现），不经 JS 函数
// 边界；session_contains 保留 JS 实现换取与旧路径 toLowerCase 一致的
// Unicode 语义（只在搜索激活时逐行执行）。
const SESSION_PAGE_MAX_LIMIT = 500;
const _sessionListStatements = new WeakMap();

function normalizeSessionProjectDir(value) {
  let normalized = String(value || '').trim().replaceAll(String.fromCharCode(92), '/').toLowerCase();
  while (normalized.endsWith('/')) normalized = normalized.slice(0, -1);
  return normalized;
}

// SQL 谓词片段（占位符顺序 = 绑定参数顺序）：
//   project: [projectId, projectId]
//   dir:     [projectDir]（裸式，目录过滤激活时）
//   tab:     [archived, archived]
//   query:   [query, query, query]
// 目录谓词不用 CASE 守卫而是语句二分：CASE 包装会让规划器无法识别
// 表达式等值约束，idx_sessions_dir_cover 不被采用退化成全表回表扫描。
const SQL_PROJECT_PRED = `(CASE WHEN ? = '' THEN 1 ELSE s.project_id = ? END) = 1`;
const SQL_DIR_PLAIN = `(
    COALESCE(s.project_id, '') = ''
    AND lower(rtrim(replace(s.open_directory, '\\', '/'), '/')) = ?
  )`;
const SQL_TAB_PRED = `(CASE WHEN ? = '' THEN 1 ELSE COALESCE(m.archived, s.archived) = ? END) = 1`;
const SQL_QUERY_PRED = `(CASE WHEN ? = '' THEN 1 ELSE (
    session_contains(json_extract(s.record, '$.title'), ?) = 1
    OR session_contains(s.open_directory, ?) = 1
  ) END) = 1`;
const SQL_HEAD_PRED = `(m.session_id IS NULL OR m.is_head = 1)`;

function getSessionListStatements(db) {
  let statements = _sessionListStatements.get(db);
  if (statements) return statements;
  db.exec(`
    CREATE TEMP TABLE IF NOT EXISTS session_thread_membership (
      session_id TEXT PRIMARY KEY,
      is_head INTEGER NOT NULL,
      archived INTEGER NOT NULL
    );
  `);
  statements = {
    lastMembership: undefined,
    clearMembership: db.prepare('DELETE FROM temp.session_thread_membership'),
    insertMembership: db.prepare('INSERT INTO temp.session_thread_membership (session_id, is_head, archived) VALUES (?, ?, ?)'),
    // 单次扫描同时产出：归属集 main/archived 真实总数（不受 tab/query 影响，
    // 前端徽标）与 tab+query 过滤后的分页 total。目录激活/未激活两套变体。
    aggregateNoDir: db.prepare(`
      SELECT
        SUM(CASE WHEN COALESCE(m.archived, s.archived) = 0 THEN 1 ELSE 0 END) AS main_total,
        SUM(CASE WHEN COALESCE(m.archived, s.archived) = 1 THEN 1 ELSE 0 END) AS archived_total,
        SUM(CASE WHEN ${SQL_TAB_PRED} AND ${SQL_QUERY_PRED} THEN 1 ELSE 0 END) AS filtered_total
      FROM sessions s
      LEFT JOIN temp.session_thread_membership m ON m.session_id = s.id
      WHERE ${SQL_PROJECT_PRED} AND ${SQL_HEAD_PRED}
    `),
    aggregateDir: db.prepare(`
      SELECT
        SUM(CASE WHEN COALESCE(m.archived, s.archived) = 0 THEN 1 ELSE 0 END) AS main_total,
        SUM(CASE WHEN COALESCE(m.archived, s.archived) = 1 THEN 1 ELSE 0 END) AS archived_total,
        SUM(CASE WHEN ${SQL_TAB_PRED} AND ${SQL_QUERY_PRED} THEN 1 ELSE 0 END) AS filtered_total
      FROM sessions s
      LEFT JOIN temp.session_thread_membership m ON m.session_id = s.id
      WHERE ${SQL_PROJECT_PRED} AND ${SQL_DIR_PLAIN} AND ${SQL_HEAD_PRED}
    `),
    pageNoDir: db.prepare(`
      SELECT s.record, COALESCE(m.archived, s.archived) AS archived
      FROM sessions s
      LEFT JOIN temp.session_thread_membership m ON m.session_id = s.id
      WHERE ${SQL_PROJECT_PRED} AND ${SQL_QUERY_PRED}
        AND ${SQL_HEAD_PRED} AND ${SQL_TAB_PRED}
      ORDER BY s.updated_at COLLATE BINARY DESC, s.created_at COLLATE BINARY DESC, s.id COLLATE BINARY DESC
      LIMIT ? OFFSET ?
    `),
    pageDir: db.prepare(`
      SELECT s.record, COALESCE(m.archived, s.archived) AS archived
      FROM sessions s
      LEFT JOIN temp.session_thread_membership m ON m.session_id = s.id
      WHERE ${SQL_PROJECT_PRED} AND ${SQL_DIR_PLAIN} AND ${SQL_QUERY_PRED}
        AND ${SQL_HEAD_PRED} AND ${SQL_TAB_PRED}
      ORDER BY s.updated_at COLLATE BINARY DESC, s.created_at COLLATE BINARY DESC, s.id COLLATE BINARY DESC
      LIMIT ? OFFSET ?
    `),
    exact: db.prepare('SELECT record, archived FROM sessions WHERE id = ?'),
    indexMeta: db.prepare(`
      SELECT
        (SELECT value FROM meta WHERE key = 'revision') AS revision,
        (SELECT value FROM meta WHERE key = 'activeSessionId') AS active_session_id
    `),
    fallbackActive: db.prepare(`
      SELECT id FROM sessions
      ORDER BY updated_at COLLATE BINARY DESC, created_at COLLATE BINARY DESC, id COLLATE BINARY DESC
      LIMIT 1
    `),
  };
  _sessionListStatements.set(db, statements);
  return statements;
}

function sessionListPredParams(options = {}) {
  const projectId = cleanSessionText(options.projectId);
  const projectDir = projectId ? '' : normalizeSessionProjectDir(options.projectDir);
  const query = String(options.query || '').trim().toLowerCase();
  const archived = options.archived === 'main' ? 0 : options.archived === 'archived' ? 1 : '';
  return {
    projectId,
    projectDir,
    // 绑定顺序 = 语句文本中的占位符顺序：aggregate 的 SUM CASE 谓词
    // （SELECT 内）先于 WHERE 谓词出现；page 全部在 WHERE。
    // projectDir 非空时选用带目录谓词的语句变体（projectDir 单占位符，
    // DIR_PLAIN 无 CASE 守卫以保索引可用）。
    aggregateNoDir: [archived, archived, query, query, query, projectId, projectId],
    aggregateDir: [archived, archived, query, query, query, projectId, projectId, projectDir],
    pageNoDir: [projectId, projectId, query, query, query, archived, archived],
    pageDir: [projectId, projectId, projectDir, query, query, query, archived, archived],
  };
}

/**
 * SQL-backed PH list query. Exact-session lookup preserves the existing bypass
 * of ownership/archive/thread filtering. Normal listing filters before page
 * selection, so historical thread members do not consume offsets or totals.
 */
export async function querySessionIndexPage(agentId, options = {}) {
  const db = ensureSessionDb(agentId);
  if (!db) return { slice: [], total: 0, mainTotal: 0, archivedTotal: 0, offset: 0, latestSessionId: null };
  const offset = Number.isFinite(Number(options.offset)) && Number(options.offset) > 0
    ? Math.floor(Number(options.offset)) : 0;
  const rawLimit = Number.isFinite(Number(options.limit)) && Number(options.limit) > 0
    ? Math.floor(Number(options.limit)) : 0;
  const limit = rawLimit > 0 ? Math.min(rawLimit, SESSION_PAGE_MAX_LIMIT) : -1;
  const statements = getSessionListStatements(db);

  // 精确单查不走成员/分页谓词（绕过归属与线程分桶是既有契约），
  // 也无需事务与成员表同步。
  if (options.sessionId) {
    const row = statements.exact.get(String(options.sessionId));
    const matched = row ? [{ record: JSON.parse(row.record), archived: Number(row.archived) === 1 }] : [];
    // 精确查询也遵守 offset/limit 切片（与 sliceSessionsForWire 的
    // filtered.slice 行为对齐；正常调用方 offset=0 时不产生可见差异）。
    const slice = limit > 0 ? matched.slice(offset, offset + limit) : matched.slice(offset);
    return {
      slice,
      total: matched.length,
      mainTotal: 0,
      archivedTotal: 0,
      offset,
      activeSessionId: null,
      fallbackActiveSessionId: null,
      revision: 0,
    };
  }

  const membership = options.threadMembership instanceof Map ? options.threadMembership : null;
  const params = sessionListPredParams(options);

  db.exec('BEGIN');
  try {
    // 成员表身份跳过：readThreadMembership 在文件版本不变时返回同一 Map
    // 实例；本函数体无 await（同步驱动 SQLite），身份比较不存在交错窗口。
    if (statements.lastMembership !== membership) {
      statements.clearMembership.run();
      if (membership) {
        for (const [sessionId, entry] of membership) {
          statements.insertMembership.run(
            String(sessionId),
            entry?.isHead === true ? 1 : 0,
            entry?.archived === true ? 1 : 0,
          );
        }
      }
      statements.lastMembership = membership;
    }
    const meta = statements.indexMeta.get();
    const withDir = params.projectDir !== '';
    const counts = (withDir ? statements.aggregateDir : statements.aggregateNoDir)
      .get(...(withDir ? params.aggregateDir : params.aggregateNoDir));
    const rows = (withDir ? statements.pageDir : statements.pageNoDir)
      .all(...(withDir ? params.pageDir : params.pageNoDir), limit, offset);
    const slice = rows.map((row) => ({
      record: JSON.parse(row.record),
      archived: Number(row.archived) === 1,
    }));
    db.exec('COMMIT');
    return {
      slice,
      total: Number(counts?.filtered_total) || 0,
      mainTotal: Number(counts?.main_total) || 0,
      archivedTotal: Number(counts?.archived_total) || 0,
      offset,
      activeSessionId: meta?.active_session_id || null,
      // fallback 仅在 meta 缺席时才有意义（常态 activeSessionId 恒有值），
      // 条件执行避免每次请求的全表排序。
      fallbackActiveSessionId: meta?.active_session_id ? null : (statements.fallbackActive.get()?.id || null),
      revision: Number(meta?.revision) || 0,
    };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* transaction may already be closed */ }
    throw error;
  }
}

// ── 共享记录查找（存储层能力）──────────────────────────────────────
//
// requirePrebuiltSessionRecord 的共享只读变体：找不到返回 null（不抛 404），
// 且经 readSessionIndexShared 不 clone 索引。面向高频只读字段解析（ga 每轮
// 逐 runtime 解析 head 会话字段、线程列表逐线程解析 head——每次 clone 数 MB
// 索引 × 调用次数会打满事件循环）。
// 契约：返回的 record 只读，不得修改（缓存对象的一部分）。
// 归属存储层的原因：只依赖 readSessionIndexShared 与 cleanSessionText，且
// agent-discovery 需要不经 sessionApi 注入直接调用（sessionApi 是打破
// agent-discovery ↔ session-helpers 环的可变引用对象，注入空对象时方法
// 缺失——见 ph-project-frontend-projection 的隔离 discovery 契约）。
const _sessionRecordMaps = new WeakMap();

export async function findPrebuiltSessionRecordShared(agentId, sessionId) {
  const index = await readSessionIndexShared(agentId);
  // 同一份共享索引对象会被大量只读解析复用。为索引对象惰性建一次 Map，
  // 避免每次线性扫描；索引变更后 readSessionIndexShared 返回新对象，
  // 自然创建对应的新 Map（身份键失效语义）。
  let recordsById = _sessionRecordMaps.get(index);
  if (!recordsById) {
    recordsById = new Map(index.sessions.map((session) => [session.id, session]));
    _sessionRecordMaps.set(index, recordsById);
  }
  const wanted = cleanSessionText(sessionId);
  if (!wanted) return null;
  return recordsById.get(wanted) || null;
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

// 原子写核心（仅剩 plain agent 显式路径变体使用，JSON 形态）：唯一临时名 +
// rename，EPERM/EXDEV 兜底。临时名带 pid+随机——同 agent 并发进程写同一索引时，
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
}

/**
 * 全量替换写入：把传入索引整体归一化后写入 db（全量重建 sessions 行，revision
 * 采用传入值，不额外自增）。生产代码无调用方；测试 fixture 与工具场景用它构造
 * 任意索引状态。等价于 JSON 时代"裸写 index.json + 下次读取侧归一化"的组合：
 * 写入后 readSessionIndex 读到的就是归一化形态。
 */
export async function writeSessionIndex(agentId, index) {
  await ensureDir(getPrebuiltAgentSessionDir(agentId));
  const normalized = normalizeSessionIndexData(index ?? {});
  const db = ensureOrCreateSessionDb(agentId);
  const stmts = getSessionStatements(db);
  db.exec('BEGIN IMMEDIATE');
  try {
    stmts.clearSessions.run();
    normalized.sessions.forEach((record, i) => stmts.insertSession.run(...sessionRowValues(record, i)));
    stmts.setMeta.run('revision', String(normalized.revision));
    stmts.setMeta.run('activeSessionId', normalized.activeSessionId ?? '');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  _indexReadCache.delete(agentId);
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

// updateSessionIndex 的提交核心：三分支写入策略。比较必须在归一化之前进行
// （normalizeSessionRecord 会为所有行创建新对象，破坏引用可比性），归一化
// 只作用于实际要写的行。
// 1. mutator 产出数组与输入数组非同一引用、id 序列相同（turn 级 meta_sync 的
//    `.map()` 形态：未变行保留原引用）→ 指针 diff，只归一化并 UPDATE 引用
//    变化的行；
// 2. mutator 返回了原数组引用（可能原地突变行）→ 归一化后与库内当前内容做
//    行级比较，保证原地突变的行也被持久化；
// 3. id 序列不同（头插新会话/删除/重排，均为低频操作）→ 全量重建行与 position。
// 三分支都在同一 BEGIN IMMEDIATE 事务内，revision + 1 写 meta。
function commitIndexToDb(agentId, newIndex, mutatorSessions) {
  const rawList = Array.isArray(newIndex?.sessions) ? newIndex.sessions : [];
  const oldList = Array.isArray(mutatorSessions) ? mutatorSessions : [];
  const sameIds = rawList.length === oldList.length
    && rawList.every((s, i) => s?.id === oldList[i]?.id);
  const db = ensureOrCreateSessionDb(agentId);
  const stmts = getSessionStatements(db);
  db.exec('BEGIN IMMEDIATE');
  try {
    if (!sameIds) {
      stmts.clearSessions.run();
      rawList
        .filter((s) => s && s.id && s.id !== 'legacy')
        .map((s) => normalizeSessionRecord(s))
        .forEach((record, i) => stmts.insertSession.run(...sessionRowValues(record, i)));
    } else if (newIndex.sessions === mutatorSessions) {
      // 数组为同一引用：以库内当前内容为准做行级比较，覆盖原地突变。
      const stored = new Map(
        db.prepare('SELECT id, record FROM sessions').all().map((row) => [row.id, row.record]),
      );
      for (const raw of rawList) {
        const record = normalizeSessionRecord(raw);
        if (JSON.stringify(record) === stored.get(String(record.id))) continue;
        stmts.updateSessionRecord.run(...sessionRowValues(record, 0).slice(2), String(record.id));
      }
    } else {
      // 新数组：未变行引用相同，直接跳过；引用变化行归一化后 UPDATE（id 序列
      // 不变，无插入删除）。行对象必须由 mutator 新建（契约见 updateSessionIndex）。
      for (let i = 0; i < rawList.length; i++) {
        if (oldList[i] === rawList[i]) continue;
        const record = normalizeSessionRecord(rawList[i]);
        stmts.updateSessionRecord.run(...sessionRowValues(record, 0).slice(2), String(record.id));
      }
    }
    const normalizedActive = rawList.some((s) => s?.id === newIndex.activeSessionId)
      ? newIndex.activeSessionId
      : null;
    stmts.setMeta.run('activeSessionId', normalizedActive ?? '');
    stmts.setMeta.run('revision', String(Math.max(0, Number(newIndex.revision) || 0)));
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  _indexReadCache.delete(agentId);
}

/**
 * 会话索引事务更新：锁内"读快照 → fn(mutator) → 提交"。
 *
 * mutator 契约：接收 readSessionIndex 的可突变副本；返回新 index 对象
 * （或原地修改后返回原对象——此形态走内容比较兜底，可正确持久化，但每行
 * 需全量比较，性能次于新建对象形态）。修改已存在的行时必须新建行对象
 * （`{ ...record, changes }`），在 `.map()` 中原地改字段后返回原引用的行
 * 不会被检测为变更。mutator 抛错时事务不发生，异常原样上抛。
 *
 * `{ skipContentComparison: true }`：跳过"内容无变化不提交"的短路（用于
 * 明知有新增/变更的调用方，避免全量签名比对成本）。
 */
export async function updateSessionIndex(agentId, fn, { skipContentComparison = false } = {}) {
  const prev = _indexLocks.get(agentId) || Promise.resolve();
  let release;
  const next = new Promise(r => release = r);
  _indexLocks.set(agentId, next);
  await prev;
  try {
    const index = await readSessionIndex(agentId);
    // 必须在 fn 执行前捕获 sessions 数组引用：mutator 可能原地替换
    // index.sessions（返回原 index 对象），fn 之后再取已是新数组，diff 会
    // 误走"同引用兜底"分支——新 id 以 UPDATE 写入不存在的行，静默丢失。
    const sessionsBefore = index.sessions;
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
    commitIndexToDb(agentId, newIndex, sessionsBefore);
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

// 同步读：DatabaseSync 直查，返回与异步变体一致的归一化形态（库内存储即
// 归一形态）。无索引数据时返回空索引。调用方（im.js、group-chat.js）零改动。
export function readSessionIndexSync(agentId) {
  const db = ensureSessionDb(agentId);
  if (!db) {
    return { revision: 0, activeSessionId: null, sessions: [] };
  }
  return loadIndexFromDb(agentId, db);
}
