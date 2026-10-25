import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { writePreview, applyPreview } from '../../scripts/migrate-ph-threads.mjs';
import { USER_DATA_ROOT } from '../shared/constants.js';

const AGENT_ID = 'programming-helper';
const MIGRATION_DIR = path.join('migrations', 'ph-thread-legacy-v1');

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
