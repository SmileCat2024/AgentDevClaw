import path from 'node:path';
import { promises as fs } from 'node:fs';

const MAX_DIRECTORY_RESULTS = 50;

function timestampOf(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const raw = String(value ?? '').trim();
  if (/^[0-9]{11,}$/.test(raw)) return Number(raw);
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseDateBound(value, endOfDay = false) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const raw = value.trim();
  const normalized = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(raw)
    ? `${raw}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`
    : raw;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function buildThreadDirectoryEntries(threadEntries, { sessionIndexes = [], archivedThreadIds = new Set(), from, to, includeArchived = false, limit = MAX_DIRECTORY_RESULTS, offset = 0 } = {}) {
  const fromTime = parseDateBound(from);
  const toTime = parseDateBound(to, true);
  if (typeof from === 'string' && from.trim() && fromTime === null) throw new TypeError('from must be a valid ISO date/time');
  if (typeof to === 'string' && to.trim() && toTime === null) throw new TypeError('to must be a valid ISO date/time');
  if (fromTime !== null && toTime !== null && fromTime > toTime) throw new TypeError('from must not be later than to');
  const headSessions = new Map();
  for (const index of sessionIndexes) {
    const agentId = String(index?.agentId || '');
    for (const session of Array.isArray(index?.sessions) ? index.sessions : []) {
      if (session?.id) headSessions.set(`${agentId}/${session.id}`, session);
    }
  }
  const entries = [];
  for (const thread of Array.isArray(threadEntries) ? threadEntries : []) {
    const threadId = String(thread?.threadId || '').trim();
    const agentId = String(thread?.agentId || '').trim();
    if (!threadId || !agentId) continue;
    const archived = archivedThreadIds instanceof Set && archivedThreadIds.has(threadId);
    if (archived && !includeArchived) continue;
    const head = headSessions.get(`${agentId}/${thread.headSessionId}`) || {};
    const updatedAt = head.updatedAt || thread.updatedAt || thread.createdAt || '';
    const updatedTime = timestampOf(updatedAt);
    if (fromTime !== null && (!Number.isFinite(updatedTime) || updatedTime < fromTime)) continue;
    if (toTime !== null && (!Number.isFinite(updatedTime) || updatedTime > toTime)) continue;
    entries.push({
      threadId,
      agentId,
      title: String(head.title || thread.headSessionTitle || thread.title || ''),
      updatedAt,
      createdAt: thread.createdAt ?? null,
      lifeState: thread.lifeState || thread.status || '',
      archived,
      rootSessionId: String(thread.rootSessionId || ''),
      headSessionId: String(thread.headSessionId || ''),
      generationCount: Array.isArray(thread.sessionIds) ? thread.sessionIds.length
        : Array.isArray(thread.sessionChain) ? thread.sessionChain.length : 0,
    });
  }
  entries.sort((a, b) => (timestampOf(b.updatedAt) || 0) - (timestampOf(a.updatedAt) || 0) || a.threadId.localeCompare(b.threadId));
  const safeOffset = Number.isFinite(Number(offset)) && Number(offset) > 0 ? Math.floor(Number(offset)) : 0;
  const requested = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : MAX_DIRECTORY_RESULTS;
  return { entries: entries.slice(safeOffset, safeOffset + Math.min(requested, MAX_DIRECTORY_RESULTS)), total: entries.length, offset: safeOffset, requestedLimit: requested, maxResults: MAX_DIRECTORY_RESULTS, limitCapped: requested > MAX_DIRECTORY_RESULTS };
}

async function readJson(filePath, fallback) {
  try { return JSON.parse(await fs.readFile(filePath, 'utf8')); }
  catch (error) { if (error?.code === 'ENOENT') return fallback; throw error; }
}

export function setupThreadDirectoryRoute(app, { threadsRoot, discoverAgents, readSessionIndex }) {
  app.get('/protoclaw/thread_directory', async (req, res, next) => {
    try {
      const [threadIndex, archiveIndex, agents] = await Promise.all([
        readJson(path.join(threadsRoot, 'index.json'), { threads: [] }),
        readJson(path.join(threadsRoot, 'archive-index.json'), { threads: {} }),
        discoverAgents(),
      ]);
      const agentFilter = typeof req.query.agentId === 'string' ? req.query.agentId.trim() : '';
      const targets = agentFilter ? agents.filter((agent) => agent.id === agentFilter) : agents;
      const sessionIndexes = await Promise.all(targets.map(async (agent) => ({
        agentId: agent.id,
        ...(await readSessionIndex(agent.id)),
      })));
      const includeArchived = req.query.includeArchived === '1' || req.query.includeArchived === 'true';
      const agentIds = new Set(targets.map((agent) => String(agent.id)));
      const archivedIds = Object.keys(archiveIndex.threads || {});
      const liveThreads = (Array.isArray(threadIndex.threads) ? threadIndex.threads : [])
        .filter((thread) => agentIds.has(String(thread?.agentId || '')));
      const liveIds = new Set(liveThreads.map((thread) => String(thread.threadId || '')));
      const archivedRecords = includeArchived
        ? (await Promise.all(archivedIds
          .filter((threadId) => !liveIds.has(threadId) && /^[A-Za-z0-9._-]+$/.test(threadId))
          .map((threadId) => readJson(path.join(threadsRoot, 'threads', `${threadId}.json`), null).catch(() => null))))
        : [];
      const allThreads = [...liveThreads, ...archivedRecords.filter((thread) => thread && agentIds.has(String(thread.agentId || '')))];
      const result = buildThreadDirectoryEntries(allThreads, {
        sessionIndexes,
        archivedThreadIds: new Set(archivedIds),
        from: req.query.from,
        to: req.query.to,
        includeArchived,
        limit: req.query.limit,
        offset: req.query.offset,
      });
      res.json({ threads: result.entries, total: result.total, offset: result.offset, requestedLimit: result.requestedLimit, maxResults: result.maxResults, limitCapped: result.limitCapped });
    } catch (error) { next(error); }
  });
}
