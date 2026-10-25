import { mkdir, readFile, writeFile, rename, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { writePreview, applyPreview } from '../../scripts/migrate-ph-threads.mjs';
import { ThreadArchiveIndex } from './thread-archive.js';
import { USER_DATA_ROOT } from '../shared/constants.js';

const AGENT_ID = 'programming-helper';
const MIGRATION_DIR = path.join('migrations', 'ph-thread-legacy-v1');
const MIGRATION_V2_DIR = path.join('migrations', 'ph-thread-archive-v2');

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

/**
 * Upgrade existing PH Session records into Thread records once per user-data root.
 * Ambiguous lineage components remain untouched; only unambiguous groups are applied.
 * Errors are surfaced to the caller so server startup can warn without being blocked.
 */
export async function runPhLegacyThreadMigration({
  dataRoot = USER_DATA_ROOT,
  indexPath = path.join(dataRoot, 'workspaces', AGENT_ID, 'sessions', 'index.json'),
  threadsRoot = path.join(dataRoot, 'threads'),
} = {}) {
  const root = path.resolve(dataRoot);
  indexPath = path.resolve(indexPath);
  threadsRoot = path.resolve(threadsRoot);
  const migrationDir = path.join(root, MIGRATION_DIR);
  const markerPath = path.join(migrationDir, 'completed.json');
  try {
    await readFile(indexPath);
  } catch (error) {
    if (error.code === 'ENOENT') return { skipped: true, reason: 'session-index-not-found' };
    throw error;
  }
  try {
    const completed = await readJson(markerPath);
    return { skipped: true, completedAt: completed.completedAt, summary: completed.summary };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  await mkdir(migrationDir, { recursive: true });
  const previewPath = path.join(migrationDir, 'preview.json');
  let plan;
  try {
    plan = await readJson(previewPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    plan = await writePreview(indexPath, previewPath, { threadsRoot });
  }

  const backupRoot = path.join(root, 'migration-backups', `ph-threads-${plan.planHash}`);
  const applyOptions = {
    indexPath, planPath: previewPath, threadsRoot, backupRoot, confirmHash: plan.planHash,
  };
  let result;
  try {
    if (plan.groups.length > 0) result = await applyPreview(applyOptions);
    else result = { createdThreadIds: [], backupRoot: null, planHash: plan.planHash };
  } catch (error) {
    // A crash after writing some records must resume the identical plan/IDs. If no
    // record was written yet and the source changed, discard only the stale plan
    // and generate a new preview on the next startup.
    if (/Session index changed after preview/.test(error.message)) {
      const completion = await readJson(path.join(backupRoot, 'completed.json')).catch(() => null);
      if (completion) throw error;
      const threadIndex = await readJson(path.join(threadsRoot, 'index.json')).catch(() => ({ threads: [] }));
      const existingIds = new Set((threadIndex.threads || []).map((item) => item.threadId));
      const partial = plan.groups.some((group) => existingIds.has(group.threadId));
      if (partial) throw error;
      const stalePath = path.join(migrationDir, `stale-preview-${plan.planHash}.json`);
      await rename(previewPath, stalePath);
      const nextPreviewPath = path.join(migrationDir, `next-preview-${Date.now()}-${process.pid}.json`);
      await writePreview(indexPath, nextPreviewPath, { threadsRoot });
      await rename(nextPreviewPath, previewPath);
      throw new Error('Source changed before migration wrote any threads; a fresh preview is saved for the next startup');
    }
    throw error;
  }

  const summary = {
    ...plan.summary,
    skippedAlreadyThreaded: plan.skippedAlreadyThreadedSessionIds.length,
    excludedOneShot: plan.excludedOneShotSessionIds.length,
    branchOrigins: plan.branchOrigins.length,
    createdThreadCount: result.createdThreadIds.length,
  };
  const marker = { schemaVersion: 1, agentId: AGENT_ID, planHash: plan.planHash, summary, completedAt: new Date().toISOString() };
  await writeFile(markerPath, `${JSON.stringify(marker, null, 2)}
`, { flag: 'wx' });
  return { skipped: false, summary, planHash: plan.planHash, backupRoot: result.backupRoot };
}

/**
 * v2（规则补齐，ADR-0032「已归档 = 线程归档」）：v1 建线时未映射 head
 * 会话的归档标志——head 当时已归档（session.archived=true）的线程应为
 * 归档态，否则这些对话按线程口径「复活」到「我的对话」。本阶段把
 * head archived=true 且未在归档索引的线程补写归档，archivedAt 取 head
 * 会话 updatedAt（保留旧归档时序在「已归档」分区的排序位置）。幂等：
 * 归档索引已有条目跳过；失败告警不阻断（与 v1 同模式：marker +
 * preview + backup）。
 */
export async function runPhThreadArchiveBackfill({
  dataRoot = USER_DATA_ROOT,
  indexPath = path.join(dataRoot, 'workspaces', AGENT_ID, 'sessions', 'index.json'),
  threadsRoot = path.join(dataRoot, 'threads'),
} = {}) {
  const root = path.resolve(dataRoot);
  indexPath = path.resolve(indexPath);
  threadsRoot = path.resolve(threadsRoot);
  const migrationDir = path.join(root, MIGRATION_V2_DIR);
  const markerPath = path.join(migrationDir, 'completed.json');
  try {
    const completed = await readJson(markerPath);
    return { skipped: true, completedAt: completed.completedAt, summary: completed.summary };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  try {
    await readFile(indexPath);
  } catch (error) {
    if (error.code === 'ENOENT') return { skipped: true, reason: 'session-index-not-found' };
    throw error;
  }

  const sessionIndex = await readJson(indexPath);
  const archivedHeads = new Map();
  for (const session of Array.isArray(sessionIndex.sessions) ? sessionIndex.sessions : []) {
    if (session?.archived === true) {
      archivedHeads.set(String(session.id), Number(session.updatedAt) || 0);
    }
  }
  const threadIndex = await readJson(path.join(threadsRoot, 'index.json')).catch(() => ({ threads: [] }));
  const archive = new ThreadArchiveIndex({ rootDir: threadsRoot });
  const existingEntries = await archive.list().catch(() => ({}));

  const candidates = [];
  let alreadyArchivedSkipped = 0;
  for (const thread of Array.isArray(threadIndex.threads) ? threadIndex.threads : []) {
    if (String(thread?.agentId || '') !== AGENT_ID) continue;
    const headSessionId = String(thread?.headSessionId || '');
    if (!archivedHeads.has(headSessionId)) continue;
    if (existingEntries[thread.threadId]) { alreadyArchivedSkipped += 1; continue; }
    candidates.push({
      threadId: thread.threadId,
      headSessionId,
      archivedAt: archivedHeads.get(headSessionId) || null,
    });
  }

  const summary = {
    archivedHeadThreads: candidates.length,
    alreadyArchivedSkipped,
  };
  if (candidates.length > 0) {
    await mkdir(migrationDir, { recursive: true });
    const preview = { schemaVersion: 1, agentId: AGENT_ID, candidates, generatedAt: new Date().toISOString() };
    const previewPath = path.join(migrationDir, 'preview.json');
    // preview 是审计留痕（非执行计划：候选每次重算，归档索引幂等跳过），
    // 崩溃重跑时覆盖旧文件
    await writeFile(previewPath, `${JSON.stringify(preview, null, 2)}
`);
    const backupRoot = path.join(root, 'migration-backups', 'ph-thread-archive-v2');
    await mkdir(backupRoot, { recursive: true });
    const archiveIndexPath = path.join(threadsRoot, 'archive-index.json');
    await copyFile(archiveIndexPath, path.join(backupRoot, 'archive-index.json')).catch(() => {});
    for (const candidate of candidates) {
      await archive.archive(candidate.threadId, { archivedAt: candidate.archivedAt });
    }
  }

  const marker = { schemaVersion: 1, agentId: AGENT_ID, summary, completedAt: new Date().toISOString() };
  await mkdir(migrationDir, { recursive: true });
  await writeFile(markerPath, `${JSON.stringify(marker, null, 2)}
`, { flag: 'wx' });
  return { skipped: false, summary };
}
