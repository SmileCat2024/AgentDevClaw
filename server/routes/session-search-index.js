/**
 * Session Content Search Index.
 *
 * Extracted from session-helpers.js. Manages in-memory and persistent
 * search indices for session content, supporting keyword search across
 * all messages in a session.
 *
 * This module is self-contained — no closure dependencies.
 */

import path from 'path';
import { promises as fs } from 'fs';

import { SESSION_SEARCH_MAX_RESULTS, SESSION_INDEX_BATCH_SIZE } from '../shared/constants.js';
import { cleanSessionText } from '../shared/string-helpers.js';
import {
  readSessionIndex,
  getPrebuiltSessionFilePath,
  getPrebuiltAgentSessionDir,
} from '../shared/session-access.js';

// In-memory cache: agentId → Map<sessionId, { sessionId, title, openDirectory, fileMtimeMs, text }>
//
// The persistent index is the durable source; this cache is only an acceleration
// layer. Keep it bounded so searching across many agents cannot retain every
// session transcript in the server heap for the lifetime of the process.
const SEARCH_INDEX_MEMORY_CACHE_MAX_BYTES = 64 * 1024 * 1024;

export function createSearchIndexMemoryCache(maxBytes = SEARCH_INDEX_MEMORY_CACHE_MAX_BYTES) {
  const entriesByAgent = new Map();
  let totalBytes = 0;

  return {
    get(agentId) {
      const cached = entriesByAgent.get(agentId);
      if (!cached) return null;
      // Map insertion order is the LRU order.
      entriesByAgent.delete(agentId);
      entriesByAgent.set(agentId, cached);
      return cached.entries;
    },
    set(agentId, entries, byteSize) {
      const size = Math.max(0, Number(byteSize) || 0);
      const previous = entriesByAgent.get(agentId);
      if (previous) {
        totalBytes -= previous.byteSize;
        entriesByAgent.delete(agentId);
      }

      // A single oversized index remains searchable for the current request,
      // but is not retained in memory. Its persistent copy is reused later.
      if (size > maxBytes) return;

      while (totalBytes + size > maxBytes && entriesByAgent.size > 0) {
        const oldestAgentId = entriesByAgent.keys().next().value;
        const oldest = entriesByAgent.get(oldestAgentId);
        entriesByAgent.delete(oldestAgentId);
        totalBytes -= oldest.byteSize;
      }
      entriesByAgent.set(agentId, { entries, byteSize: size });
      totalBytes += size;
    },
    delete(agentId) {
      const cached = entriesByAgent.get(agentId);
      if (!cached) return false;
      entriesByAgent.delete(agentId);
      totalBytes -= cached.byteSize;
      return true;
    },
    clear() {
      entriesByAgent.clear();
      totalBytes = 0;
    },
    getStats() {
      return { size: entriesByAgent.size, totalBytes };
    },
  };
}

const _searchIndexCache = createSearchIndexMemoryCache();
const _searchIndexBuilding = new Map();
const SEARCH_INDEX_VERSION = 1;
const SEARCH_SNIPPET_RADIUS = 40;

function estimateSearchIndexBytes(entries) {
  let chars = 0;
  for (const entry of entries.values()) {
    chars += String(entry.sessionId || '').length;
    chars += String(entry.title || '').length;
    chars += String(entry.openDirectory || '').length;
    chars += String(entry.sessionType || '').length;
    chars += String(entry.text || '').length;
  }
  // JavaScript strings use up to two bytes per UTF-16 code unit. The fixed
  // allowance covers entry/Map metadata without pretending to be exact.
  return chars * 2 + entries.size * 128;
}

export function invalidateSearchIndex(agentId) {
  _searchIndexCache.delete(agentId);
}

export function getSearchIndexPath(agentId) {
  return path.join(getPrebuiltAgentSessionDir(agentId), 'search-index.json');
}

export async function loadPersistentSearchIndex(agentId) {
  try {
    const raw = await fs.readFile(getSearchIndexPath(agentId), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed.version !== SEARCH_INDEX_VERSION) return null;
    return parsed.entries || {};
  } catch {
    return null;
  }
}

export async function savePersistentSearchIndex(agentId, entriesMap) {
  try {
    const data = { version: SEARCH_INDEX_VERSION, entries: entriesMap };
    await fs.writeFile(getSearchIndexPath(agentId), JSON.stringify(data), 'utf8');
  } catch {}
}

export async function extractSessionSearchText(sessionPath) {
  const raw = await fs.readFile(sessionPath, 'utf8');
  const parsed = JSON.parse(raw);
  const messages = Array.isArray(parsed?.runtime?.context?.messages) ? parsed.runtime.context.messages : [];
  const parts = [];
  for (const m of messages) {
    if (m.role === 'user' && typeof m.content === 'string' && m.content.trim()) {
      parts.push('[user] ' + m.content);
    } else if (m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()) {
      parts.push('[assistant] ' + m.content);
    }
  }
  return parts.join('\n');
}

export async function ensureSearchIndex(agentId) {
  // Deduplicate concurrent builds
  if (_searchIndexBuilding.has(agentId)) {
    return _searchIndexBuilding.get(agentId);
  }

  const buildPromise = (async () => {
    const index = await readSessionIndex(agentId);
    const memCache = _searchIndexCache.get(agentId);
    const persistent = memCache ? null : await loadPersistentSearchIndex(agentId);

    // Source of truth for valid entries: index.json session IDs. Persisted
    // entries for deleted sessions are pruned on the next search rebuild.
    const validIds = new Set(index.sessions.map(s => s.id));
    const hasStalePersistentEntries = !!persistent
      && Object.keys(persistent).some((sessionId) => !validIds.has(sessionId));

    // Build entries map: start from existing cache (in-memory or persistent)
    const entries = new Map();
    const toRead = []; // sessions that need file reads

    for (const record of index.sessions) {
      // Check in-memory cache first, then persistent
      const source = memCache?.get(record.id) || persistent?.[record.id];
      if (
        source &&
        source.fileMtimeMs === record.fileMtimeMs &&
        typeof source.text === 'string'
      ) {
        entries.set(record.id, {
          ...source,
          title: cleanSessionText(record.title) || source.title || record.id,
          openDirectory: cleanSessionText(record.openDirectory),
          sessionType: cleanSessionText(record.sessionType) || source.sessionType || 'main',
          archived: record.archived === true,
          todo: record.todo === true,
        });
      } else {
        toRead.push(record);
      }
    }

    // Read files in batches, yielding between batches
    for (let i = 0; i < toRead.length; i += SESSION_INDEX_BATCH_SIZE) {
      const batch = toRead.slice(i, i + SESSION_INDEX_BATCH_SIZE);
      await Promise.all(batch.map(async (record) => {
        try {
          const sessionPath = getPrebuiltSessionFilePath(agentId, record.id);
          const text = await extractSessionSearchText(sessionPath);
          entries.set(record.id, {
            sessionId: record.id,
            title: cleanSessionText(record.title) || record.id,
            openDirectory: cleanSessionText(record.openDirectory),
            sessionType: cleanSessionText(record.sessionType) || 'main',
            archived: record.archived === true,
            todo: record.todo === true,
            fileMtimeMs: record.fileMtimeMs || 0,
            text,
          });
        } catch {
          // Skip unreadable sessions
        }
      }));
      if (i + SESSION_INDEX_BATCH_SIZE < toRead.length) {
        await new Promise(resolve => setImmediate(resolve));
      }
    }

    // Persist newly read entries and prune deleted entries from the durable
    // index. Without the latter, removed session transcripts accumulate on disk
    // and return to memory after an LRU eviction.
    if (toRead.length > 0 || hasStalePersistentEntries) {
      const persistData = {};
      for (const [id, entry] of entries) {
        persistData[id] = {
          sessionId: entry.sessionId,
          title: entry.title,
          openDirectory: entry.openDirectory,
          sessionType: entry.sessionType,
          archived: entry.archived,
          fileMtimeMs: entry.fileMtimeMs,
          text: entry.text,
        };
      }
      await savePersistentSearchIndex(agentId, persistData);
    }

    // Cache in memory under a process-wide LRU budget. The persistent index
    // remains available if this agent's entries are evicted.
    _searchIndexCache.set(agentId, entries, estimateSearchIndexBytes(entries));
    return entries;
  })();

  _searchIndexBuilding.set(agentId, buildPromise);
  try {
    const result = await buildPromise;
    return result;
  } finally {
    _searchIndexBuilding.delete(agentId);
  }
}

export function searchInText(text, queryLower) {
  const idx = text.toLowerCase().indexOf(queryLower);
  if (idx === -1) return null;
  const start = Math.max(0, idx - SEARCH_SNIPPET_RADIUS);
  const end = Math.min(text.length, idx + queryLower.length + SEARCH_SNIPPET_RADIUS);
  let snippet = text.slice(start, end);
  // Strip role prefix from the beginning of snippet if present
  snippet = snippet.replace(/^\[[^\]]*\]\s*/, '');
  // Determine match role by looking backwards for role tag
  const beforeSnippet = text.slice(0, idx);
  const lastRoleMatch = beforeSnippet.match(/\[(user|assistant)\][^[]*$/);
  const matchRole = lastRoleMatch ? lastRoleMatch[1] : '';
  return { snippet, matchRole, matchIndex: idx };
}

export async function searchSessionsContent(agentId, query, openDirectory) {
  const entries = await ensureSearchIndex(agentId);
  const queryLower = query.toLowerCase();
  const results = [];

  // Normalize openDirectory for filtering
  const normalizedDir = openDirectory
    ? String(openDirectory).replace(/\\/g, '/').toLowerCase()
    : null;

  for (const [, entry] of entries) {
    // Filter by openDirectory
    if (normalizedDir) {
      const entryDir = String(entry.openDirectory || '').replace(/\\/g, '/').toLowerCase();
      if (entryDir !== normalizedDir) continue;
    }

    // Search in text content
    const match = searchInText(entry.text, queryLower);
    if (match) {
      results.push({
        sessionId: entry.sessionId,
        title: entry.title,
        openDirectory: entry.openDirectory,
        sessionType: entry.sessionType || 'main',
        archived: entry.archived === true,
        snippet: match.snippet,
        matchRole: match.matchRole,
        matchedInText: true,
      });
    }
  }

  // Sort by title relevance then by recency (approximated by sessionId timestamp)
  results.sort((a, b) => {
    // Exact title match gets priority
    const aTitle = a.title.toLowerCase().includes(queryLower) ? 0 : 1;
    const bTitle = b.title.toLowerCase().includes(queryLower) ? 0 : 1;
    if (aTitle !== bTitle) return aTitle - bTitle;
    return String(b.sessionId).localeCompare(String(a.sessionId));
  });

  const total = results.length;
  const trimmed = results.slice(0, SESSION_SEARCH_MAX_RESULTS);

  return {
    query,
    results: trimmed,
    total,
    indexed: entries.size,
  };
}
