#!/usr/bin/env node
import { copyFile, mkdir, readFile, writeFile, constants as fsConstants } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { buildPhThreadMigrationPlan, materializeThreadRecord } from './ph-thread-migration.js';
import { ThreadStore } from '../server/thread-control/thread-store.js';
import { ThreadArchiveIndex } from '../server/thread-control/thread-archive.js';
import { PREBUILT_WORKSPACES_ROOT, THREADS_ROOT } from '../server/shared/constants.js';

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

export async function writePreview(indexPath, outputPath, { threadsRoot } = {}) {
  const index = await readJson(indexPath);
  const existingStore = new ThreadStore({ rootDir: threadsRoot || THREADS_ROOT });
  const existingRecords = await Promise.all((await existingStore.list()).map((entry) => existingStore.get(entry.threadId)));
  const phRecords = existingRecords.filter((record) => record?.agentId === 'programming-helper');
  const existingSessionIds = phRecords.flatMap((record) => (record.sessionChain || []).map((entry) => entry?.sessionId));
  const existingThreadMembership = phRecords.map((record) => ({
    threadId: record.threadId,
    sessionIds: (record.sessionChain || []).map((entry) => entry?.sessionId),
  }));
  const plan = buildPhThreadMigrationPlan(index, { existingSessionIds, existingThreadMembership });
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(plan, null, 2)}
`, { flag: 'wx' });
  return plan;
}

export async function applyPreview({ indexPath, planPath, threadsRoot, backupRoot, confirmHash }) {
  const normalizedThreadsRoot = path.resolve(threadsRoot);
  const normalizedBackupRoot = path.resolve(backupRoot);
  const backupRelativeToThreads = path.relative(normalizedThreadsRoot, normalizedBackupRoot);
  if (backupRelativeToThreads === '' || (!backupRelativeToThreads.startsWith('..') && !path.isAbsolute(backupRelativeToThreads))) {
    throw new Error('Backup directory must be outside the thread store');
  }
  const [index, plan] = await Promise.all([readJson(indexPath), readJson(planPath)]);
  if (plan.schemaVersion !== 1 || plan.agentId !== 'programming-helper') throw new Error('Unsupported or wrong-workspace migration plan');
  if (plan.planHash !== confirmHash) throw new Error('Confirmation hash does not match preview plan');
  const { planHash, ...unsignedPlan } = plan;
  if (hash(unsignedPlan) !== planHash) throw new Error('Preview plan integrity check failed');
  if (hash(index) !== plan.sourceHash || (Number(index.revision) || 0) !== plan.sourceRevision) {
    throw new Error('Session index changed after preview; regenerate preview before applying');
  }

  const heldForReview = new Set((plan.ambiguous || []).flatMap((item) => item.sessionIds || []));
  const assigned = new Set((plan.groups || []).flatMap((group) => group.sessionIds || []));
  const partition = new Set([...assigned, ...heldForReview, ...(plan.skippedAlreadyThreadedSessionIds || [])]);
  // eligibleSessionIds excludes already-threaded sessions (they are filtered out of
  // `included`), so partition completeness compares against their union.
  const eligible = new Set([...(plan.eligibleSessionIds || []), ...(plan.skippedAlreadyThreadedSessionIds || [])]);
  if (assigned.size !== plan.summary?.memberCount
      || [...assigned].some((id) => heldForReview.has(id))
      || partition.size !== eligible.size
      || [...partition].some((id) => !eligible.has(id))
      || plan.planEligibleCount !== (index.sessions || []).filter((item) => item?.id && item.id !== 'legacy').length) {
    throw new Error('Preview does not partition eligible sessions into unique groups and review items');
  }
  if (!assigned.size && !plan.existingThreadMembership?.length) throw new Error('Preview contains no unambiguous groups to migrate');

  const store = new ThreadStore({ rootDir: normalizedThreadsRoot });
  backupRoot = normalizedBackupRoot;
  const completionPath = path.join(backupRoot, 'completed.json');
  let completed = null;
  try {
    completed = await readJson(completionPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (completed) {
    if (completed.planHash !== planHash) throw new Error('Backup directory belongs to a different completed migration plan');
    for (const group of plan.groups) {
      const record = await store.get(group.threadId);
      if (!record || JSON.stringify((record.sessionChain || []).map((entry) => entry?.sessionId)) !== JSON.stringify(group.sessionIds)) {
        throw new Error(`Completed migration record ${group.threadId} is missing or inconsistent`);
      }
    }
    return { alreadyApplied: true, createdThreadIds: completed.createdThreadIds, backupRoot, planHash };
  }

  const listed = await store.list();
  const existingRecords = await Promise.all(listed.map((entry) => store.get(entry.threadId)));
  const phRecords = existingRecords.filter((record) => record?.agentId === 'programming-helper');
  const currentMembership = phRecords.map((record) => ({
    threadId: record.threadId,
    sessionIds: (record.sessionChain || []).map((entry) => entry?.sessionId),
  })).sort((a, b) => a.threadId.localeCompare(b.threadId));
  const plannedMembership = [...(plan.existingThreadMembership || [])]
    .map((item) => ({ threadId: item.threadId, sessionIds: item.sessionIds || [] }))
    .sort((a, b) => a.threadId.localeCompare(b.threadId));
  const resumableMigrationMembership = (plan.groups || []).flatMap((group) => {
    const record = existingRecords.find((item) => item?.threadId === group.threadId && item?.agentId === 'programming-helper');
    if (!record) return [];
    const sessionIds = (record.sessionChain || []).map((entry) => entry?.sessionId);
    if (JSON.stringify(sessionIds) !== JSON.stringify(group.sessionIds)) {
      throw new Error(`Partially written migration thread ${group.threadId} differs from the preview plan`);
    }
    return [{ threadId: record.threadId, sessionIds }];
  }).sort((a, b) => a.threadId.localeCompare(b.threadId));
  const expectedMembership = [...plannedMembership, ...resumableMigrationMembership]
    .sort((a, b) => a.threadId.localeCompare(b.threadId));
  if (JSON.stringify(currentMembership) !== JSON.stringify(expectedMembership)) {
    throw new Error('Existing thread membership changed after preview; regenerate preview');
  }
  const sessionOwners = new Map();
  for (const record of phRecords) {
    for (const entry of record.sessionChain || []) if (entry?.sessionId) sessionOwners.set(entry.sessionId, record.threadId);
  }
  for (const group of plan.groups) {
    const existing = await store.get(group.threadId);
    if (existing && JSON.stringify((existing.sessionChain || []).map((entry) => entry?.sessionId)) !== JSON.stringify(group.sessionIds)) {
      throw new Error(`Existing planned thread ${group.threadId} does not match the preview plan`);
    }
    for (const sessionId of group.sessionIds) {
      const owner = sessionOwners.get(sessionId);
      if (owner && owner !== group.threadId) throw new Error(`Session ${sessionId} already belongs to thread ${owner}`);
    }
  }

  await mkdir(backupRoot, { recursive: true });
  const backupIndexPath = path.join(backupRoot, 'sessions-index.json');
  const backupArchivePath = path.join(backupRoot, 'archive-index.json');
  const absentArchiveMarker = path.join(backupRoot, 'archive-index.absent');
  const priorManifestPath = path.join(backupRoot, 'migration-manifest.json');
  try {
    const priorManifest = await readJson(priorManifestPath);
    if (priorManifest.planHash !== planHash || priorManifest.sourceHash !== plan.sourceHash) {
      throw new Error('Backup directory belongs to a different migration plan');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const liveArchivePath = path.join(threadsRoot, 'archive-index.json');
  try {
    await copyFile(liveArchivePath, backupArchivePath, fsConstants.COPYFILE_EXCL);
  } catch (error) {
    if (error.code === 'ENOENT') {
      try {
        await writeFile(absentArchiveMarker, 'absent\n', { flag: 'wx' });
      } catch (markerError) {
        if (markerError.code !== 'EEXIST') throw markerError;
      }
    } else if (error.code === 'EEXIST') {
      const saved = await readFile(backupArchivePath);
      let live;
      try { live = await readFile(liveArchivePath); }
      catch (readError) { if (readError.code !== 'ENOENT') throw readError; }
      if (!live || !live.equals(saved)) throw new Error('Archive index changed after backup was created');
    } else throw error;
  }
  try {
    await copyFile(indexPath, backupIndexPath, fsConstants.COPYFILE_EXCL);
  } catch (error) {
    if (error.code !== 'EEXIST' || hash(JSON.parse(await readFile(backupIndexPath, 'utf8'))) !== plan.sourceHash) throw error;
  }

  const manifestPath = path.join(backupRoot, 'migration-manifest.json');
  const manifest = { schemaVersion: 1, agentId: plan.agentId, sourceHash: plan.sourceHash, planHash, backupIndexPath, backupArchivePath, absentArchiveMarker };
  try {
    await writeFile(manifestPath, `${JSON.stringify({ ...manifest, createdAt: new Date().toISOString() }, null, 2)}\n`, { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existingManifest = await readJson(manifestPath);
    if (existingManifest.planHash !== planHash || existingManifest.sourceHash !== plan.sourceHash) throw new Error('Backup directory belongs to a different migration plan');
    const indexBackup = JSON.parse(await readFile(backupIndexPath, 'utf8'));
    if (hash(indexBackup) !== plan.sourceHash) throw new Error('Session index backup does not match the migration plan');
  }

  const processed = [];
  try {
    const archive = new ThreadArchiveIndex({ rootDir: threadsRoot });
    for (const group of plan.groups) {
      const existing = await store.get(group.threadId);
      if (!existing) await store.create(materializeThreadRecord(group, index));
      const head = index.sessions.find((item) => item?.id === group.sessionIds.at(-1));
      if (head?.archived === true) await archive.archive(group.threadId);
      processed.push(group.threadId);
    }
  } catch (error) {
    error.processedThreadIds = processed;
    error.backupRoot = backupRoot;
    throw error;
  }
  const result = { createdThreadIds: processed, backupRoot, planHash };
  await writeFile(completionPath, `${JSON.stringify({ ...result, completedAt: new Date().toISOString() }, null, 2)}
`, { flag: 'wx' });
  return result;
}

async function main() {
  const { values } = parseArgs({ options: {
    index: { type: 'string' }, preview: { type: 'string' }, 'threads-root': { type: 'string' },
    'backup-root': { type: 'string' }, 'confirm-hash': { type: 'string' }, apply: { type: 'boolean', default: false }, 'allow-user-data': { type: 'boolean', default: false },
  } });
  if (!values.index || !values.preview) throw new Error('Usage: node scripts/migrate-ph-threads.mjs --index <sessions/index.json|default> --preview <plan.json> [--threads-root <threads-dir>] [--apply --backup-root <new-backup-dir> --confirm-hash <planHash> --allow-user-data]');
  const liveIndexPath = path.join(PREBUILT_WORKSPACES_ROOT, 'programming-helper', 'sessions', 'index.json');
  const selectedIndex = values.index === 'default' ? liveIndexPath : path.resolve(values.index);
  if (values.apply && path.resolve(selectedIndex) === path.resolve(liveIndexPath) && !values['allow-user-data']) {
    throw new Error('Applying to real PH user data requires explicit --allow-user-data after the preview has been reviewed');
  }
  const selectedThreadsRoot = values['threads-root'] ? path.resolve(values['threads-root']) : THREADS_ROOT;
  if (values.apply && path.resolve(selectedThreadsRoot) === path.resolve(THREADS_ROOT) && !values['allow-user-data']) {
    throw new Error('Applying to the real thread store requires explicit --allow-user-data after the preview has been reviewed');
  }
  if (!values.apply) {
    const plan = await writePreview(selectedIndex, path.resolve(values.preview), {
      threadsRoot: selectedThreadsRoot,
    });
    const ambiguousReasons = (plan.ambiguous || []).flatMap((item) => item.reasons || []).reduce((counts, reason) => {
      counts[reason] = (counts[reason] || 0) + 1;
      return counts;
    }, {});
    console.log(JSON.stringify({
      preview: path.resolve(values.preview), planHash: plan.planHash, summary: plan.summary,
      skippedAlreadyThreaded: plan.skippedAlreadyThreadedSessionIds.length,
      excludedOneShot: plan.excludedOneShotSessionIds.length,
      branchOrigins: plan.branchOrigins.length,
      planEligibleCount: plan.planEligibleCount,
      ambiguousReasons,
    }, null, 2));
    return;
  }
  if (!values['threads-root'] || !values['backup-root'] || !values['confirm-hash']) throw new Error('--apply requires --threads-root, --backup-root, and --confirm-hash');
  const result = await applyPreview({
    indexPath: selectedIndex, planPath: path.resolve(values.preview), threadsRoot: selectedThreadsRoot,
    backupRoot: path.resolve(values['backup-root']), confirmHash: values['confirm-hash'],
  });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
