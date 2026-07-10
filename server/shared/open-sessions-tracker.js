import path from 'path';
import { promises as fs } from 'fs';
import { readJsonSafe, ensureDir } from './fs-helpers.js';
import { getPrebuiltWorkspaceDir, readSessionIndex } from './session-access.js';
import { sanitizeSessionFragment } from './string-helpers.js';

// ── In-memory crash recovery cache ──────────────────────────────────────
// Populated once on Claw startup by reading the persisted file, then the
// file is cleared so it can accumulate fresh entries during this run.
// The card UI reads exclusively from this in-memory cache.
// When a session is restored (activated), it is consumed (removed) from
// the cache so it never reappears on refresh.
const _recoveryCache = new Map(); // agentId → Array<{ sessionId, title, openDirectory, updatedAt }>

function getOpenSessionsFilePath(agentId) {
  return path.join(getPrebuiltWorkspaceDir(sanitizeSessionFragment(agentId)), 'open-sessions.json');
}

/**
 * On Claw startup: read persisted file into in-memory cache, then clear
 * the file so it can track fresh sessions during this run.
 * Safe to call multiple times — subsequent calls are no-ops if cache
 * already initialised for the agent.
 */
export async function initRecoveryCache(agentId) {
  if (_recoveryCache.has(agentId)) return;

  try {
    const data = await readJsonSafe(getOpenSessionsFilePath(agentId), null);
    const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
    _recoveryCache.set(agentId, sessions);

    // Clear the file so it accumulates only sessions from this run
    const filePath = getOpenSessionsFilePath(agentId);
    await fs.writeFile(filePath, JSON.stringify({ updatedAt: new Date().toISOString(), sessions: [] }, null, 2), 'utf8');
  } catch {
    _recoveryCache.set(agentId, []);
  }
}

/**
 * Return recovery sessions for an agent, validated against the session index.
 * Sessions that no longer exist are silently dropped from the cache.
 * Titles and openDirectory are refreshed from the live session index so
 * AI-generated titles (set after addOpenSession ran) are reflected.
 */
export async function getRecoverySessions(agentId) {
  if (!_recoveryCache.has(agentId)) {
    await initRecoveryCache(agentId);
  }
  const cached = _recoveryCache.get(agentId) || [];

  // Validate + enrich from session index
  let indexRecords = null;
  try {
    const index = await readSessionIndex(agentId);
    indexRecords = index.sessions || [];
  } catch {
    // index unreadable — return as-is
    return cached;
  }

  const indexMap = new Map(indexRecords.map((s) => [s.id, s]));
  let changed = false;

  const valid = cached.filter((s) => indexMap.has(s.sessionId));
  if (valid.length !== cached.length) changed = true;

  // Refresh title and openDirectory from live session index
  for (const entry of valid) {
    const record = indexMap.get(entry.sessionId);
    if (!record) continue;
    if (record.title && record.title !== entry.title) {
      entry.title = record.title;
      changed = true;
    }
    if (record.openDirectory && record.openDirectory !== entry.openDirectory) {
      entry.openDirectory = record.openDirectory;
      changed = true;
    }
  }

  if (changed) {
    _recoveryCache.set(agentId, valid);
  }
  return valid;
}

/**
 * Consume (remove) a session from the in-memory recovery cache.
 * Called when a session is activated — whether from the card, the session
 * list, or any other flow. Once consumed, it never reappears in the card.
 */
export function consumeRecoverySession(agentId, sessionId) {
  const cached = _recoveryCache.get(agentId);
  if (!cached) return;
  _recoveryCache.set(agentId, cached.filter((s) => s.sessionId !== sessionId));
}

/**
 * Clear all recovery sessions for an agent (user dismissed the card).
 */
export function dismissRecoverySessions(agentId) {
  _recoveryCache.set(agentId, []);
}

// ── File-level tracking (for next crash) ─────────────────────────────────

/**
 * Record a session as "open" (runtime became ready).
 * Writes to the file which will be read on next Claw startup.
 */
export async function addOpenSession(agentId, sessionId) {
  const filePath = getOpenSessionsFilePath(agentId);
  await ensureDir(path.dirname(filePath));

  const data = await readJsonSafe(filePath, null);
  const sessions = Array.isArray(data?.sessions) ? data.sessions : [];

  let title = null;
  let openDirectory = null;
  try {
    const index = await readSessionIndex(agentId);
    const record = (index.sessions || []).find((s) => s.id === sessionId);
    if (record) {
      title = record.title || null;
      openDirectory = record.openDirectory || null;
    }
  } catch { /* session index unreadable — store minimal info */ }

  const now = new Date().toISOString();
  const filtered = sessions.filter((s) => s.sessionId !== sessionId);
  filtered.unshift({ sessionId, title, openDirectory, updatedAt: now });

  const nextData = { updatedAt: now, sessions: filtered };
  await fs.writeFile(filePath, JSON.stringify(nextData, null, 2), 'utf8');
  return nextData;
}

/**
 * Remove a session from the "open" file (explicit stop or delete).
 */
export async function removeOpenSession(agentId, sessionId) {
  const filePath = getOpenSessionsFilePath(agentId);
  const data = await readJsonSafe(filePath, null);
  if (!data || !Array.isArray(data.sessions)) return;

  const filtered = data.sessions.filter((s) => s.sessionId !== sessionId);
  if (filtered.length === data.sessions.length) return;

  const nextData = { updatedAt: new Date().toISOString(), sessions: filtered };
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, JSON.stringify(nextData, null, 2), 'utf8');
  return nextData;
}
