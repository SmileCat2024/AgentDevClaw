import path from 'path';
import { promises as fs } from 'fs';
import { USER_DATA_ROOT } from './constants.js';

export const SIDEBAR_DIAGNOSTIC_SCHEMA_VERSION = 1;
export const SIDEBAR_DIAGNOSTIC_DIR = path.join(USER_DATA_ROOT, 'diagnostics', 'sidebar');
export const SIDEBAR_DIAGNOSTIC_FILE = 'sidebar-events.jsonl';
export const SIDEBAR_DIAGNOSTIC_MAX_FILE_BYTES = 5 * 1024 * 1024;
export const SIDEBAR_DIAGNOSTIC_RETENTION_DAYS = 7;
export const SIDEBAR_DIAGNOSTIC_MAX_ARCHIVED_FILES = 7;

const ALLOWED_SOURCES = new Set(['server', 'client']);
const ALLOWED_KINDS = new Set(['operation_phase', 'list_perf', 'read_perf', 'system']);
const ALLOWED_RESULTS = new Set(['success', 'degraded', 'blocked', 'failed', 'cancelled']);
const ALLOWED_READINESS = new Set(['missing', 'starting', 'ready', 'stopping', 'stopped']);
const ID_PATTERN = /[^a-zA-Z0-9._:-]/g;
const MAX_DURATION_MS = 24 * 60 * 60 * 1000;
const MAX_COUNT = 10_000_000;

function cleanText(value, maxLength = 128) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function cleanId(value, maxLength = 128) {
  return cleanText(value, maxLength).replace(ID_PATTERN, '');
}

function boundedNumber(value, max = MAX_DURATION_MS) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  return Math.min(max, Math.round(number * 1000) / 1000);
}

function safeEventTimestamp(value, nowMs) {
  const parsed = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(parsed)) return new Date(nowMs).toISOString();
  // Client clocks can drift, but an operation event should not be days away
  // from the server that receives it.
  if (parsed < nowMs - 24 * 60 * 60 * 1000 || parsed > nowMs + 60 * 60 * 1000) {
    return new Date(nowMs).toISOString();
  }
  return new Date(parsed).toISOString();
}

export function sanitizeSidebarDiagnosticEvent(raw, defaults = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const nowMs = typeof defaults.now === 'function' ? Number(defaults.now()) : Date.now();
  const sourceCandidate = cleanText(defaults.source || raw.source, 16);
  const kindCandidate = cleanText(defaults.kind || raw.kind, 32);
  const operation = cleanId(raw.operation, 64);
  const phase = cleanId(raw.phase, 64);
  if (!operation || !phase) return null;

  const event = {
    schemaVersion: SIDEBAR_DIAGNOSTIC_SCHEMA_VERSION,
    timestamp: safeEventTimestamp(raw.timestamp, nowMs),
    recordedAt: new Date(nowMs).toISOString(),
    source: ALLOWED_SOURCES.has(sourceCandidate) ? sourceCandidate : 'server',
    kind: ALLOWED_KINDS.has(kindCandidate) ? kindCandidate : 'operation_phase',
    operation,
    phase,
  };

  const stringFields = {
    operationId: cleanId(raw.operationId, 128),
    agentId: cleanId(raw.agentId, 128),
    sessionId: cleanId(raw.sessionId || raw.sourceSessionId, 128),
    targetSessionId: cleanId(raw.targetSessionId, 128),
    errorCode: cleanId(raw.errorCode, 64),
  };
  for (const [key, value] of Object.entries(stringFields)) {
    if (value) event[key] = value;
  }

  const result = cleanText(raw.result, 16);
  if (ALLOWED_RESULTS.has(result)) event.result = result;
  const readiness = cleanText(raw.readiness || raw.lifecycle, 16);
  if (ALLOWED_READINESS.has(readiness)) event.readiness = readiness;

  const durationFields = [
    'elapsedMs', 'phaseDurationMs', 'durationMs', 'indexMs',
    'handoffMs', 'modelMs', 'sessionsMs', 'totalMs',
  ];
  for (const key of durationFields) {
    const value = boundedNumber(raw[key]);
    if (value !== null) event[key] = value;
  }

  const countFields = [
    'revision', 'sessionCount', 'handoffSummaryCount', 'writebackCount',
    'runtimeCount', 'removedCount', 'agentCount', 'attempt',
    'responseBytes',
  ];
  for (const key of countFields) {
    const value = boundedNumber(raw[key], MAX_COUNT);
    if (value !== null) event[key] = value;
  }

  return event;
}

function rotatedFileName(nowMs, sequence) {
  const stamp = new Date(nowMs).toISOString().replace(/[-:.TZ]/g, '');
  return `sidebar-events-${stamp}-${String(sequence).padStart(3, '0')}.jsonl`;
}

export function createSidebarDiagnosticWriter(options = {}) {
  const rootDir = path.resolve(options.rootDir || SIDEBAR_DIAGNOSTIC_DIR);
  const activePath = path.join(rootDir, SIDEBAR_DIAGNOSTIC_FILE);
  const maxFileBytes = Math.max(1024, Number(options.maxFileBytes) || SIDEBAR_DIAGNOSTIC_MAX_FILE_BYTES);
  const retentionDays = Math.max(1, Number(options.retentionDays) || SIDEBAR_DIAGNOSTIC_RETENTION_DAYS);
  const maxArchivedFiles = Math.max(1, Number(options.maxArchivedFiles) || SIDEBAR_DIAGNOSTIC_MAX_ARCHIVED_FILES);
  const clock = typeof options.now === 'function' ? options.now : () => Date.now();
  let queue = Promise.resolve();
  let rotationSequence = 0;
  let lastCleanupAt = 0;

  async function cleanup(nowMs, force = false) {
    if (!force && nowMs - lastCleanupAt < 60 * 60 * 1000) return;
    lastCleanupAt = nowMs;
    const entries = await fs.readdir(rootDir, { withFileTypes: true }).catch(() => []);
    const archived = [];
    for (const entry of entries) {
      if (!entry.isFile() || !/^sidebar-events-\d{17}-\d{3}\.jsonl$/.test(entry.name)) continue;
      const filePath = path.join(rootDir, entry.name);
      const stat = await fs.stat(filePath).catch(() => null);
      if (stat) archived.push({ filePath, mtimeMs: stat.mtimeMs });
    }
    archived.sort((left, right) => right.mtimeMs - left.mtimeMs);
    const cutoff = nowMs - retentionDays * 24 * 60 * 60 * 1000;
    await Promise.all(archived.map((entry, index) => {
      if (entry.mtimeMs >= cutoff && index < maxArchivedFiles) return null;
      return fs.rm(entry.filePath, { force: true }).catch(() => {});
    }));
  }

  async function writeLines(lines) {
    if (!lines) return;
    const nowMs = Number(clock());
    await fs.mkdir(rootDir, { recursive: true });
    const bytes = Buffer.byteLength(lines, 'utf8');
    const stat = await fs.stat(activePath).catch(() => null);
    if (stat?.size > 0 && stat.size + bytes > maxFileBytes) {
      rotationSequence += 1;
      const rotatedPath = path.join(rootDir, rotatedFileName(nowMs, rotationSequence));
      await fs.rename(activePath, rotatedPath);
      await cleanup(nowMs, true);
    } else {
      await cleanup(nowMs, false);
    }
    await fs.appendFile(activePath, lines, 'utf8');
  }

  function append(rawEvents, defaults = {}) {
    const values = Array.isArray(rawEvents) ? rawEvents : [rawEvents];
    const sanitized = values
      .slice(0, 50)
      .map((event) => sanitizeSidebarDiagnosticEvent(event, { ...defaults, now: clock }))
      .filter(Boolean);
    if (sanitized.length === 0) return Promise.resolve(0);
    const lines = sanitized.map((event) => JSON.stringify(event)).join('\n') + '\n';
    const task = queue.then(() => writeLines(lines)).then(() => sanitized.length);
    queue = task.catch(() => {});
    return task;
  }

  return {
    append,
    flush: () => queue,
    status: () => ({
      enabled: true,
      schemaVersion: SIDEBAR_DIAGNOSTIC_SCHEMA_VERSION,
      directory: rootDir,
      activeFile: activePath,
      maxFileBytes,
      retentionDays,
      maxArchivedFiles,
    }),
  };
}

export const sidebarDiagnosticWriter = createSidebarDiagnosticWriter();

export function recordSidebarDiagnosticEvent(event, defaults = {}) {
  // `node --test` must not write diagnostic artifacts into the user's data
  // directory. Writer behavior is tested through an explicit temp directory.
  if (process.env.NODE_TEST_CONTEXT) return Promise.resolve(0);
  return sidebarDiagnosticWriter.append(event, defaults).catch((error) => {
    console.warn('[SIDEBAR_DIAGNOSTICS] failed to persist event:', error?.message || String(error));
    return 0;
  });
}
