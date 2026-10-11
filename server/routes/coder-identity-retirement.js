// coder 身份投影退役 — 一次性遗弃搬移（ADR-0025 决策 5）。
//
// 服务启动时执行一次（server.js main()，先于 studio 迁移）：
// 把 coder 侧全部现存数据物理搬移到带日期的遗弃目录，不格式转换、不删除。
// 新代码零识别、零兼容分支——搬移后活动库中不存在 coder 身份数据。
//
// 白名单枚举（只搬以下对象，main 数据一概不动）：
//   1. threads 全局库中 workspaceId ∈ {coder, programming-helper} 的线程
//      （main 会话不建线程，ph 名下全部为 coder 线程）及 boards / 归档连带；
//   2. workspaces/coder/ 整树（2026-08 独立工作空间时代遗留，升格后会被
//      重新激活，必须整体遗弃保证新库从零开始）；
//   3. programming-helper 会话索引中 sessionType=coder 的条目与会话文件；
//   4. programming-helper open-sessions.json 中的 coder 条目。
//
// fail-hard：任何一条失败抛错拒绝启动。幂等：遗弃目录存在且有 MIGRATED.json
// 完成标记即跳过；目录存在但无标记 = 上次搬移中断，拒绝启动（人工处理：
// 整目录还原回滚，或核对后删除半成品目录再重启）。遗弃目录整目录可还原。

import path from 'path';
import { promises as fsp } from 'fs';
import { readJsonSafe } from '../shared/fs-helpers.js';
import { resolveUserDataDir } from '../shared/constants.js';
import { sanitizeSessionFragment } from '../shared/string-helpers.js';

const RETIREMENT_DIR_NAME = 'coder-identity-20261011';
const HOST_AGENT_ID = 'programming-helper';
const CODER_AGENT_ID = 'coder';
const MIGRATED_MARKER = 'MIGRATED.json';

/** 会话存储路径（与 session-access.getPrebuiltAgentSessionDir 的 workspace 分支同构）。 */
function sessionDirFor(dataRoot, agentId) {
  return path.join(dataRoot, 'workspaces', sanitizeSessionFragment(agentId), 'sessions');
}

/** 原子写（tmp + rename，与 session-access 写语义一致）。 */
async function writeJsonAtomic(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}-${Math.random().toString(36).slice(2, 8)}.tmp`;
  await fsp.writeFile(tmpPath, JSON.stringify(value, null, 2), 'utf8');
  await fsp.rename(tmpPath, filePath);
}

async function pathExists(p) {
  try {
    await fsp.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** 同数据根内搬移（同盘 rename；数据根内不存在跨盘）。目标目录自动创建。 */
async function moveFileInto(srcPath, destDir, { keepName = true } = {}) {
  await fsp.mkdir(destDir, { recursive: true });
  const destPath = keepName ? path.join(destDir, path.basename(srcPath)) : destDir;
  await fsp.rename(srcPath, destPath);
}

/**
 * 判定线程索引条目是否属于 coder 侧（白名单：coder 遗留 + ph 名下全部）。
 * main 会话不建线程是产品事实（ADR-0025 摸排锚点），ph 名下线程一律视为
 * coder 线程（含合并早期无 identity 字段的条目）。
 */
function isCoderSideThreadEntry(entry) {
  const ws = String(entry?.workspaceId || '').trim();
  return ws === CODER_AGENT_ID || ws === HOST_AGENT_ID;
}

/**
 * 搬移 threads 全局库中的 coder 侧数据。
 * 归属判定源是 threads/index.json（live 条目）；归档索引条目无归属字段，
 * 经 threads/<id>.json 记录文件的存在性与 live 归属映射回查（归档线程的
 * 记录文件保留在 threads/threads/ 下，记录内含 workspaceId）。
 */
async function retireThreadsStore(threadsRoot, retiredRoot) {
  const indexPath = path.join(threadsRoot, 'index.json');
  const index = await readJsonSafe(indexPath, null);
  if (!index) return { liveThreads: 0, archivedEntries: 0, boardFiles: 0 };

  const liveEntries = Array.isArray(index.threads) ? index.threads : [];
  const coderLive = liveEntries.filter(isCoderSideThreadEntry);
  const coderLiveIds = new Set(coderLive.map((entry) => String(entry.threadId || '').trim()).filter(Boolean));

  // 归档条目归属：归档线程的记录文件仍在 threads/threads/ 下，读其
  // workspaceId 判定；记录文件缺失的归档条目按 live 归属映射兜底。
  const archiveIndexPath = path.join(threadsRoot, 'archive-index.json');
  const archiveIndex = await readJsonSafe(archiveIndexPath, null);
  const archivedIds = archiveIndex && archiveIndex.threads && typeof archiveIndex.threads === 'object'
    ? Object.keys(archiveIndex.threads)
    : [];
  const coderArchivedIds = [];
  for (const threadId of archivedIds) {
    if (coderLiveIds.has(threadId)) {
      coderArchivedIds.push(threadId);
      continue;
    }
    const recordPath = path.join(threadsRoot, 'threads', `${threadId}.json`);
    const record = await readJsonSafe(recordPath, null);
    if (record && isCoderSideThreadEntry(record)) {
      coderArchivedIds.push(threadId);
    }
  }

  const retiredThreadsRoot = path.join(retiredRoot, 'threads');
  const retiredRecordsDir = path.join(retiredThreadsRoot, 'threads');
  const retiredBoardsDir = path.join(retiredThreadsRoot, 'boards');

  // 1) 线程记录文件 + 看板文件（live + archived 的 coder 侧）
  const coderRecordIds = new Set([...coderLiveIds, ...coderArchivedIds]);
  const recordsDir = path.join(threadsRoot, 'threads');
  let movedRecords = 0;
  if (await pathExists(recordsDir)) {
    const files = await fsp.readdir(recordsDir);
    for (const file of files) {
      const threadId = file.endsWith('.json') ? file.slice(0, -'.json'.length) : '';
      if (!threadId || !coderRecordIds.has(threadId)) continue;
      await moveFileInto(path.join(recordsDir, file), retiredRecordsDir);
      movedRecords += 1;
    }
  }

  let movedBoards = 0;
  const boardsDir = path.join(threadsRoot, 'boards');
  if (await pathExists(boardsDir)) {
    const files = await fsp.readdir(boardsDir);
    for (const file of files) {
      const m = file.match(/^(.+)\.board\.json$/);
      if (!m || !coderRecordIds.has(m[1])) continue; // help.board.json 等非线程看板保留
      await moveFileInto(path.join(boardsDir, file), retiredBoardsDir);
      movedBoards += 1;
    }
  }

  // 2) 索引原快照进遗弃目录，活动库重写为仅剩非 coder 条目
  await fsp.mkdir(retiredThreadsRoot, { recursive: true });
  await fsp.copyFile(indexPath, path.join(retiredThreadsRoot, 'index.json'));

  const remaining = liveEntries.filter((entry) => !coderLiveIds.has(String(entry?.threadId || '').trim()));
  await writeJsonAtomic(indexPath, {
    ...index,
    revision: (Number(index.revision) || 0) + 1,
    threads: remaining,
  });

  // 3) 归档索引：coder 侧条目移除（原快照保留）
  if (archiveIndex) {
    await fsp.copyFile(archiveIndexPath, path.join(retiredThreadsRoot, 'archive-index.json'));
    const remainingArchived = {};
    for (const threadId of archivedIds) {
      if (!coderArchivedIds.includes(threadId)) {
        remainingArchived[threadId] = archiveIndex.threads[threadId];
      }
    }
    await writeJsonAtomic(archiveIndexPath, {
      ...archiveIndex,
      threads: remainingArchived,
    });
  }

  return { liveThreads: coderLive.length, archivedEntries: coderArchivedIds.length, boardFiles: movedBoards, recordFiles: movedRecords };
}

/**
 * 搬移 ph 会话存储中的 coder 会话（索引条目 + 会话文件）与 open-sessions
 * 中的 coder 条目。main / exploration / sub 等其它会话一概不动。
 */
async function retirePhCoderSessions(dataRoot, retiredRoot) {
  const sessionDir = sessionDirFor(dataRoot, HOST_AGENT_ID);
  const indexPath = path.join(sessionDir, 'index.json');
  const index = await readJsonSafe(indexPath, null);
  if (!index) return { sessions: 0, openSessionEntries: 0 };

  const sessions = Array.isArray(index.sessions) ? index.sessions : [];
  const coderSessions = sessions.filter((record) => String(record?.sessionType || '').trim() === 'coder');
  const coderSessionIds = new Set(coderSessions.map((record) => String(record.id || '').trim()).filter(Boolean));

  const retiredSessionDir = path.join(retiredRoot, 'workspaces', HOST_AGENT_ID, 'sessions');
  await fsp.mkdir(retiredSessionDir, { recursive: true });

  // 1) 会话记录文件（不在索引中的会话文件不属于 coder 白名单，不动）
  for (const sessionId of coderSessionIds) {
    const sessionPath = path.join(sessionDir, `${sessionId}.json`);
    if (!(await pathExists(sessionPath))) {
      throw new Error(`coder session file missing: ${sessionPath}（索引条目存在但文件缺失，拒绝搬移）`);
    }
    await moveFileInto(sessionPath, retiredSessionDir);
  }

  // 2) 索引原快照 + 重写（移除 coder 条目）
  await fsp.copyFile(indexPath, path.join(retiredSessionDir, 'index.json'));
  const remaining = sessions.filter((record) => !coderSessionIds.has(String(record?.id || '').trim()));
  await writeJsonAtomic(indexPath, {
    ...index,
    revision: (Number(index.revision) || 0) + 1,
    sessions: remaining,
  });

  // 3) open-sessions：coder 条目过滤（登记在恢复卡片的 coder 会话）
  let openSessionEntries = 0;
  const openSessionsPath = path.join(dataRoot, 'workspaces', HOST_AGENT_ID, 'open-sessions.json');
  const openData = await readJsonSafe(openSessionsPath, null);
  if (openData && Array.isArray(openData.sessions)) {
    const coderOpen = openData.sessions.filter((entry) => coderSessionIds.has(String(entry?.sessionId || '').trim()));
    if (coderOpen.length > 0) {
      const retiredHostDir = path.join(retiredRoot, 'workspaces', HOST_AGENT_ID);
      await fsp.mkdir(retiredHostDir, { recursive: true });
      await fsp.copyFile(openSessionsPath, path.join(retiredHostDir, 'open-sessions.json'));
      await writeJsonAtomic(openSessionsPath, {
        ...openData,
        sessions: openData.sessions.filter((entry) => !coderSessionIds.has(String(entry?.sessionId || '').trim())),
      });
      openSessionEntries = coderOpen.length;
    }
  }

  return { sessions: coderSessionIds.size, openSessionEntries };
}

/**
 * 搬移 2026-08 独立工作空间时代的 workspaces/coder/ 整树。
 * 升格后 coder APP 的会话存储落在同一路径，遗留数据必须整体遗弃，
 * 新库从零开始。
 */
async function retireLegacyCoderWorkspace(dataRoot, retiredRoot) {
  const legacyDir = path.join(dataRoot, 'workspaces', CODER_AGENT_ID);
  if (!(await pathExists(legacyDir))) return { legacyWorkspace: false };
  const retiredWorkspacesRoot = path.join(retiredRoot, 'workspaces');
  await fsp.mkdir(retiredWorkspacesRoot, { recursive: true });
  await fsp.rename(legacyDir, path.join(retiredWorkspacesRoot, CODER_AGENT_ID));
  return { legacyWorkspace: true };
}

/** 搬移后校验：活动库中不得残留 coder 事实，残留即 fail-hard。 */
async function assertNoCoderResidue(dataRoot) {
  const threadsRoot = path.join(dataRoot, 'threads');
  const index = await readJsonSafe(path.join(threadsRoot, 'index.json'), null);
  const liveEntries = Array.isArray(index?.threads) ? index.threads : [];
  const residue = liveEntries.filter(isCoderSideThreadEntry);
  if (residue.length > 0) {
    throw new Error(`threads index still holds ${residue.length} coder-side entr(y/ies) after retirement`);
  }
  if (await pathExists(path.join(dataRoot, 'workspaces', CODER_AGENT_ID))) {
    throw new Error('workspaces/coder still exists after retirement');
  }
  const sessionIndex = await readJsonSafe(path.join(sessionDirFor(dataRoot, HOST_AGENT_ID), 'index.json'), null);
  const coderSessions = (sessionIndex?.sessions || []).filter((record) => String(record?.sessionType || '').trim() === 'coder');
  if (coderSessions.length > 0) {
    throw new Error(`programming-helper session index still holds ${coderSessions.length} coder session(s) after retirement`);
  }
}

/**
 * 启动搬移入口。幂等 + fail-hard：
 * - 遗弃目录有 MIGRATED.json → 已完成，跳过；
 * - 遗弃目录存在但无 MIGRATED.json → 上次中断，抛错拒绝启动；
 * - 任何一步失败抛错拒绝启动（回滚以遗弃目录为基础人工整体还原）。
 *
 * @param {string} [userDataRoot] 数据根（默认由 constants.resolveUserDataDir 解析；测试可显式注入）
 */
export async function runCoderIdentityRetirement(userDataRoot) {
  const dataRoot = path.resolve(userDataRoot || resolveUserDataDir());
  const retiredRoot = path.join(dataRoot, 'retired', RETIREMENT_DIR_NAME);
  const threadsRoot = path.join(dataRoot, 'threads');
  const markerPath = path.join(retiredRoot, MIGRATED_MARKER);

  if (await pathExists(markerPath)) {
    console.log(`[coder-retirement] already migrated, skip (${retiredRoot})`);
    return { skipped: true };
  }
  if (await pathExists(retiredRoot)) {
    throw new Error(
      `遗弃目录已存在但缺少完成标记：${retiredRoot}\n`
      + '上次搬移可能中断。请人工核对遗弃目录与活动库：回滚请整目录还原，'
      + '确认无误后删除该目录并重启服务重新搬移。',
    );
  }

  const counts = {
    threads: { liveThreads: 0, archivedEntries: 0, boardFiles: 0, recordFiles: 0 },
    phSessions: { sessions: 0, openSessionEntries: 0 },
    legacyWorkspace: false,
  };

  if (await pathExists(threadsRoot)) {
    counts.threads = await retireThreadsStore(threadsRoot, retiredRoot);
  }
  counts.phSessions = await retirePhCoderSessions(dataRoot, retiredRoot);
  counts.legacyWorkspace = (await retireLegacyCoderWorkspace(dataRoot, retiredRoot)).legacyWorkspace;

  await assertNoCoderResidue(dataRoot);

  await writeJsonAtomic(markerPath, {
    migratedAt: new Date().toISOString(),
    retirementDir: RETIREMENT_DIR_NAME,
    counts,
  });

  console.log(
    '[coder-retirement] coder 侧数据已遗弃搬移:',
    `threads(live=${counts.threads.liveThreads}, archived=${counts.threads.archivedEntries}),`,
    `ph coder sessions=${counts.phSessions.sessions},`,
    `legacy workspace=${counts.legacyWorkspace} →`,
    retiredRoot,
  );
  return { skipped: false, counts };
}
