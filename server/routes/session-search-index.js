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
const _searchIndexCache = new Map();
const _searchIndexBuilding = new Map();
const SEARCH_INDEX_VERSION = 1;
const SEARCH_SNIPPET_RADIUS = 40;

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

    // Source of truth for valid entries: index.json session IDs
    const validIds = new Set(index.sessions.map(s => s.id));

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

    // Persist updated index (only if we actually read files)
    if (toRead.length > 0) {
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

    // Cache in memory
    _searchIndexCache.set(agentId, entries);
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

  for (const [sessionId, entry] of entries) {
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
