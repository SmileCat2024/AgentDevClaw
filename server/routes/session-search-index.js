/**
 * Session Content Search Index.
 *
 * Extracted from session-helpers.js. Manages in-memory and persistent
 * search indices for session content, supporting keyword search across
 * all messages in a session.
 *
 * Index v2 stores per-message records (raw context index / role / text)
 * so search results can quote message-boundary snippets with identity
 * for in-chat locate, instead of one opaque concatenated transcript.
 *
 * This module is self-contained — no closure dependencies.
 */

import path from 'path';
import { promises as fs } from 'fs';

import { SESSION_SEARCH_MAX_RESULTS, SESSION_INDEX_BATCH_SIZE } from '../shared/constants.js';
import { cleanSessionText } from '../shared/string-helpers.js';
import {
  readSessionIndexShared,
  getPrebuiltSessionFilePath,
  getPrebuiltAgentSessionDir,
} from '../shared/session-access.js';

// In-memory cache: agentId → Map<sessionId, { sessionId, title, ..., msgs }>
//
// The persistent index is the durable source; this cache is only an acceleration
// layer. Keep it bounded so searching across many agents cannot retain every
// session transcript in the server heap for the lifetime of the process.
const SEARCH_INDEX_MEMORY_CACHE_MAX_BYTES = 128 * 1024 * 1024;

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
// The shared metadata reader changes object identity whenever its file changes.
// Weak keys keep this shortcut within the same lifetime as the bounded cache.
const _searchIndexSources = new WeakMap();
// v2: per-message records ({i,r,t}) replace the concatenated transcript.
// The bump invalidates every persistent v1 index on first search.
const SEARCH_INDEX_VERSION = 2;
const SEARCH_SNIPPET_RADIUS = 64;
// Snippet window cap — the line-snap below may widen the window, this bounds it.
const SEARCH_SNIPPET_MAX_CHARS = 360;
const SEARCH_SNIPPET_CONTEXT_MAX_CHARS = 160;
const SEARCH_MATCHES_PER_SESSION = 10;
const SEARCH_DEFAULT_PAGE_SIZE = 20;

function estimateSearchIndexBytes(entries) {
  let chars = 0;
  for (const entry of entries.values()) {
    chars += String(entry.sessionId || '').length;
    chars += String(entry.title || '').length;
    chars += String(entry.openDirectory || '').length;
    chars += String(entry.sessionType || '').length;
    if (Array.isArray(entry.msgs)) {
      for (const msg of entry.msgs) {
        chars += String(msg?.t || '').length + 8;
      }
    }
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

/**
 * v2 extractor: per-message records preserving the raw context index so a
 * content hit can address the exact chat row (frontend `msg-<index>` DOM id).
 * Role stays a structured field — snippets must never leak `[user]`-style
 * internal tags into user-visible text.
 */
export async function extractSessionSearchMessages(sessionPath) {
  const raw = await fs.readFile(sessionPath, 'utf8');
  const parsed = JSON.parse(raw);
  const messages = Array.isArray(parsed?.runtime?.context?.messages) ? parsed.runtime.context.messages : [];
  const msgs = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    const text = typeof m.content === 'string' ? m.content
      : Array.isArray(m.content) ? m.content.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('\n') : '';
    if (text.trim()) msgs.push({ i, r: m.role, t: text });
  }
  return msgs;
}

export async function ensureSearchIndex(agentId) {
  // Deduplicate concurrent builds
  if (_searchIndexBuilding.has(agentId)) {
    return _searchIndexBuilding.get(agentId);
  }

  const buildPromise = (async () => {
    const index = await readSessionIndexShared(agentId);
    const memCache = _searchIndexCache.get(agentId);
    if (memCache && _searchIndexSources.get(memCache) === index) return memCache;
    const persistent = memCache ? null : await loadPersistentSearchIndex(agentId);

    // Source of truth for valid entries: session index (index.db, ADR-0036) session
    // IDs. Persisted entries for deleted sessions are pruned on the next search rebuild.
    const validIds = new Set(index.sessions.map(s => s.id));
    const hasStaleEntries = memCache
      ? [...memCache.keys()].some((sessionId) => !validIds.has(sessionId))
      : !!persistent && Object.keys(persistent).some((sessionId) => !validIds.has(sessionId));

    // Build entries map: start from existing cache (in-memory or persistent)
    const entries = new Map();
    const toRead = []; // sessions that need file reads

    for (const record of index.sessions) {
      // Check in-memory cache first, then persistent
      const source = memCache?.get(record.id) || persistent?.[record.id];
      if (
        source &&
        source.fileMtimeMs === (record.fileMtimeMs || 0) &&
        Array.isArray(source.msgs)
      ) {
        // 命中缓存也用 Session 索引元数据刷新身份字段（ticket 044）：旧
        // v2 缓存缺 projectId，这里按索引记录补齐——msgs（正文派生物）原样
        // 保留，不重读会话文件、不全量重扫历史。
        entries.set(record.id, {
          ...source,
          title: cleanSessionText(record.title) || source.title || record.id,
          openDirectory: cleanSessionText(record.openDirectory),
          projectId: cleanSessionText(record.projectId),
          sessionType: cleanSessionText(record.sessionType) || source.sessionType || 'main',
          archived: record.archived === true,
          todo: record.todo === true,
          updatedAt: cleanSessionText(record.updatedAt) || source.updatedAt || '',
          createdAt: cleanSessionText(record.createdAt) || source.createdAt || '',
          messageCount: Number.isFinite(Number(record.messageCount)) ? Number(record.messageCount) : source.messageCount ?? 0,
        });
      } else {
        toRead.push(record);
      }
    }

    let refreshedEntries = 0;
    // Read files in batches, yielding between batches
    for (let i = 0; i < toRead.length; i += SESSION_INDEX_BATCH_SIZE) {
      const batch = toRead.slice(i, i + SESSION_INDEX_BATCH_SIZE);
      await Promise.all(batch.map(async (record) => {
        try {
          const sessionPath = getPrebuiltSessionFilePath(agentId, record.id);
          const msgs = await extractSessionSearchMessages(sessionPath);
          refreshedEntries += 1;
          entries.set(record.id, {
            sessionId: record.id,
            title: cleanSessionText(record.title) || record.id,
            openDirectory: cleanSessionText(record.openDirectory),
            projectId: cleanSessionText(record.projectId),
            sessionType: cleanSessionText(record.sessionType) || 'main',
            archived: record.archived === true,
            todo: record.todo === true,
            updatedAt: cleanSessionText(record.updatedAt) || '',
            createdAt: cleanSessionText(record.createdAt) || '',
            messageCount: Number.isFinite(Number(record.messageCount)) ? Number(record.messageCount) : msgs.length,
            fileMtimeMs: record.fileMtimeMs || 0,
            msgs,
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
    if (refreshedEntries > 0 || hasStaleEntries) {
      const persistData = {};
      for (const [id, entry] of entries) {
        persistData[id] = {
          sessionId: entry.sessionId,
          title: entry.title,
          openDirectory: entry.openDirectory,
          projectId: entry.projectId,
          sessionType: entry.sessionType,
          archived: entry.archived,
          todo: entry.todo,
          updatedAt: entry.updatedAt,
          createdAt: entry.createdAt,
          messageCount: entry.messageCount,
          fileMtimeMs: entry.fileMtimeMs,
          msgs: entry.msgs,
        };
      }
      await savePersistentSearchIndex(agentId, persistData);
    }

    // Cache in memory under a process-wide LRU budget. The persistent index
    // remains available if this agent's entries are evicted.
    // Retry unreadable session files on the next request rather than marking
    // a partial build as up to date.
    if (entries.size === index.sessions.length) _searchIndexSources.set(entries, index);
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

/**
 * Message-boundary snippet: a window around the first occurrence, snapped to
 * line boundaries when they are close (keeps code/list structure readable),
 * capped so a single hit cannot dominate the response.
 */
function buildMatchSnippet(text, queryLower) {
  const idx = text.toLowerCase().indexOf(queryLower);
  if (idx < 0) return null;
  const hitEnd = idx + queryLower.length;
  let start = Math.max(0, idx - SEARCH_SNIPPET_RADIUS);
  let end = Math.min(text.length, hitEnd + SEARCH_SNIPPET_RADIUS);
  // Snap to the nearest line boundary when it is close by.
  const nlBefore = start > 0 ? text.lastIndexOf('\n', start) : -1;
  if (nlBefore >= 0 && start - nlBefore <= 40) start = nlBefore + 1;
  const nlAfter = text.indexOf('\n', Math.min(end, text.length));
  if (nlAfter >= 0 && nlAfter - end <= 40) end = nlAfter;
  if (end - start > SEARCH_SNIPPET_MAX_CHARS) {
    // Line snapping widened the window too far — fall back to the plain window.
    start = Math.max(0, idx - SEARCH_SNIPPET_RADIUS);
    end = Math.min(text.length, hitEnd + SEARCH_SNIPPET_RADIUS);
  }
  return {
    snippet: text.slice(start, end),
    leadingEllipsis: start > 0,
    trailingEllipsis: end < text.length,
  };
}

function countOccurrences(textLower, queryLower) {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = textLower.indexOf(queryLower, from);
    if (at < 0) break;
    count += 1;
    from = at + queryLower.length;
  }
  return count;
}

function entrySortTime(entry) {
  return entry.updatedAt
    || (entry.fileMtimeMs ? new Date(entry.fileMtimeMs).toISOString() : '');
}

/**
 * Session content search over the per-message index.
 *
 * options:
 *   - scope: 'all' (default) | 'main' (unarchived) | 'archived'
 *   - sort:  'relevance' (default, title match first then recency) | 'recency'
 *   - offset / limit: pagination applied after scope+directory filtering and
 *     sorting. limit defaults to 20, capped at SESSION_SEARCH_MAX_RESULTS.
 *
 * A session is recalled when the title matches OR any message content matches;
 * title-only recalls carry `titleMatched: true` with an empty `matches` list.
 */
export async function searchSessionsContent(agentId, query, openDirectory, options = {}) {
  const queryLower = String(query || '').trim().toLowerCase();
  if (!queryLower) return { query: '', results: [], total: 0, indexed: 0 };
  const entries = await ensureSearchIndex(agentId);
  const scope = options.scope === 'main' || options.scope === 'archived' ? options.scope : 'all';
  const sort = options.sort === 'recency' ? 'recency' : 'relevance';
  const offset = Number.isFinite(Number(options.offset)) && Number(options.offset) > 0
    ? Math.floor(Number(options.offset)) : 0;
  const rawLimit = Number.isFinite(Number(options.limit)) && Number(options.limit) > 0 ? Math.floor(Number(options.limit)) : SEARCH_DEFAULT_PAGE_SIZE;
  const limit = Math.min(Math.max(rawLimit, 1), SESSION_SEARCH_MAX_RESULTS);

  // Normalize openDirectory for filtering
  const normalizedDir = openDirectory
    ? String(openDirectory).replace(/\\/g, '/').toLowerCase()
    : null;
  // 归属过滤（ticket 044）：projectId 是项目集合过滤（身份相等）；
  // openDirectory 是目录集合过滤（目录相等且排除项目会话——项目会话的
  // openDirectory 只是创建时记录，不构成目录归属）。
  const projectFilter = cleanSessionText(options.projectId);

  const results = [];
  for (const [, entry] of entries) {
    if (projectFilter) {
      if (cleanSessionText(entry.projectId) !== projectFilter) continue;
    } else if (normalizedDir) {
      if (cleanSessionText(entry.projectId)) continue;
      // Filter by openDirectory
      const entryDir = String(entry.openDirectory || '').replace(/\\/g, '/').toLowerCase();
      if (entryDir !== normalizedDir) continue;
    }
    // Scope filter precedes matching and pagination.
    if (scope === 'main' && entry.archived === true) continue;
    if (scope === 'archived' && entry.archived !== true) continue;

    const titleMatched = entry.title.toLowerCase().includes(queryLower);

    let matchCount = 0;
    for (const msg of entry.msgs || []) {
      if (String(msg?.t || '').toLowerCase().includes(queryLower)) matchCount += 1;
    }
    if (!titleMatched && matchCount === 0) continue;

    results.push({
      sessionId: entry.sessionId,
      title: entry.title,
      openDirectory: entry.openDirectory,
      projectId: cleanSessionText(entry.projectId),
      sessionType: entry.sessionType || 'main',
      archived: entry.archived === true,
      todo: entry.todo === true,
      updatedAt: entrySortTime(entry),
      messageCount: Number.isFinite(Number(entry.messageCount)) ? Number(entry.messageCount) : 0,
      titleMatched,
      matchCount,
    });
  }

  // Relevance: title match first, then real recency (index-record updatedAt,
  // not a sessionId approximation). Both ties keep deterministic order.
  results.sort((a, b) => {
    if (sort === 'relevance' && a.titleMatched !== b.titleMatched) return a.titleMatched ? -1 : 1;
    const timeCmp = String(b.updatedAt).localeCompare(String(a.updatedAt));
    if (timeCmp !== 0) return timeCmp;
    return String(b.sessionId).localeCompare(String(a.sessionId));
  });

  const total = results.length;
  const page = results.slice(offset, offset + limit);
  // Build passages only for the page that will actually be returned. Matching
  // above still scans every eligible message to preserve exact totals/counts.
  for (const result of page) {
    const entry = entries.get(result.sessionId);
    const matches = [];
    if (Array.isArray(entry.msgs)) {
      for (const msg of entry.msgs) {
        const text = String(msg?.t || '');
        if (!text) continue;
        const textLower = text.toLowerCase();
        if (!textLower.includes(queryLower)) continue;
        if (matches.length >= SEARCH_MATCHES_PER_SESSION) break;
        const snippet = buildMatchSnippet(text, queryLower);
        if (!snippet) continue;
        const hitIndex = textLower.indexOf(queryLower);
        const excerptStart = Math.max(0, hitIndex - 240);
        const excerptEnd = Math.min(text.length, hitIndex + queryLower.length + 600);
        const match = {
          index: msg.i,
          role: msg.r === 'user' ? 'user' : 'assistant',
          snippet: snippet.snippet,
          leadingEllipsis: snippet.leadingEllipsis,
          trailingEllipsis: snippet.trailingEllipsis,
          occurrences: countOccurrences(textLower, queryLower),
          excerpt: text.slice(excerptStart, excerptEnd),
          excerptLeadingEllipsis: excerptStart > 0,
          excerptTrailingEllipsis: excerptEnd < text.length,
        };
        // Short primary hit: attach one adjacent message for question/answer
        // context (previous message preferred, next as fallback).
        if (matches.length === 0) {
          const msgPos = entry.msgs.indexOf(msg);
          const neighbor = msg.r === 'assistant'
            ? entry.msgs.slice(0, msgPos).findLast((item) => item.r === 'user')
            : entry.msgs.slice(msgPos + 1).find((item) => item.r === 'assistant');
          if (neighbor && neighbor.i !== msg.i) {
            const neighborText = String(neighbor.t || '');
            const neighborSnippet = neighborText.length > SEARCH_SNIPPET_CONTEXT_MAX_CHARS
              ? neighborText.slice(0, SEARCH_SNIPPET_CONTEXT_MAX_CHARS)
              : neighborText;
            match.context = {
              index: neighbor.i,
              relation: neighbor.i < msg.i ? 'prev' : 'next',
              role: neighbor.r === 'user' ? 'user' : 'assistant',
              snippet: neighborSnippet,
              truncated: neighborText.length > SEARCH_SNIPPET_CONTEXT_MAX_CHARS,
            };
          }
        }
        matches.push(match);
      }
    }

    result.matches = matches;
  }

  return {
    query,
    scope,
    sort,
    offset,
    limit,
    results: page,
    total,
    indexed: entries.size,
  };
}
