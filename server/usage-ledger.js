import { createHash, randomUUID } from 'crypto';
import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';
import { USER_DATA_ROOT } from './shared/constants.js';

const USAGE_ROOT = path.join(USER_DATA_ROOT, 'usage');
const EVENTS_DIR = path.join(USAGE_ROOT, 'events');
const EVENT_INDEX_PATH = path.join(USAGE_ROOT, 'event-index.json');
const MAX_INDEX_IDS = 20000;

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function toNumber(value) {
  return Number.isFinite(value) ? value : 0;
}

function normalizeDate(value) {
  const text = cleanText(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : '';
}

function localDateString(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseLocalDate(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return new Date(value);
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function dateFromTimestamp(timestamp) {
  const date = new Date(Number.isFinite(timestamp) ? timestamp : Date.now());
  return localDateString(date);
}

function timestampValue(event) {
  const value = event?.timestamp || event?.createdAt || 0;
  if (Number.isFinite(value)) return value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function hashBaseUrl(value) {
  const text = cleanText(value);
  if (!text) return '';
  return `sha256:${createHash('sha256').update(text).digest('hex').slice(0, 16)}`;
}

function stableHash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
}

function normalizeUsage(usage = {}) {
  const inputTokens = toNumber(usage.inputTokens);
  const outputTokens = toNumber(usage.outputTokens);
  const cacheReadTokens = toNumber(usage.cacheReadTokens);
  const cacheCreationTokens = toNumber(usage.cacheCreationTokens);
  const reasoningTokens = toNumber(usage.reasoningTokens);
  const audioTokens = toNumber(usage.audioTokens);
  const totalTokens = toNumber(usage.totalTokens) || inputTokens + outputTokens;
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cacheReadTokens,
    cacheCreationTokens,
    reasoningTokens,
    audioTokens,
  };
}

function normalizeModel(model = {}) {
  return {
    modelName: cleanText(model.modelName),
    provider: cleanText(model.provider),
    providerName: cleanText(model.providerName),
    protocol: cleanText(model.protocol),
    presetName: cleanText(model.presetName),
    presetRole: cleanText(model.presetRole),
    baseUrlHash: cleanText(model.baseUrlHash) || hashBaseUrl(model.baseUrl),
  };
}

export function buildUsageEvent(raw = {}) {
  const timestamp = Number.isFinite(raw.timestamp) ? raw.timestamp : Date.now();
  const usage = normalizeUsage(raw.usage);
  const model = normalizeModel(raw.model);
  const event = {
    schemaVersion: 1,
    eventId: cleanText(raw.eventId),
    timestamp,
    date: normalizeDate(raw.date) || dateFromTimestamp(timestamp),
    source: cleanText(raw.source) || 'unknown',
    agentId: cleanText(raw.agentId),
    sessionId: cleanText(raw.sessionId),
    runtimeInstanceId: cleanText(raw.runtimeInstanceId),
    jobId: cleanText(raw.jobId),
    callIndex: Number.isFinite(raw.callIndex) ? raw.callIndex : null,
    step: Number.isFinite(raw.step) ? raw.step : null,
    requestCount: Math.max(1, Math.trunc(toNumber(raw.requestCount) || 1)),
    cacheHitRequests: Math.max(0, Math.trunc(toNumber(raw.cacheHitRequests))),
    model,
    usage,
    context: {
      contextInputTokens: toNumber(raw.context?.contextInputTokens),
      messageCount: Math.max(0, Math.trunc(toNumber(raw.context?.messageCount))),
    },
    metadata: raw.metadata && typeof raw.metadata === 'object' ? raw.metadata : {},
  };
  if (!event.eventId) {
    event.eventId = stableHash({
      source: event.source,
      agentId: event.agentId,
      sessionId: event.sessionId,
      runtimeInstanceId: event.runtimeInstanceId,
      jobId: event.jobId,
      callIndex: event.callIndex,
      step: event.step,
      timestamp: event.timestamp,
      usage: event.usage,
      model: event.model,
    });
  }
  return event;
}

async function ensureUsageDirs() {
  await mkdir(EVENTS_DIR, { recursive: true });
}

async function readEventIndex() {
  try {
    const parsed = JSON.parse(await readFile(EVENT_INDEX_PATH, 'utf8'));
    return {
      ids: Array.isArray(parsed?.ids) ? parsed.ids.map(String) : [],
    };
  } catch {
    return { ids: [] };
  }
}

async function writeEventIndex(index) {
  const ids = Array.isArray(index?.ids) ? index.ids.slice(-MAX_INDEX_IDS) : [];
  await writeFile(EVENT_INDEX_PATH, JSON.stringify({ ids }, null, 2), 'utf8');
}

export async function appendUsageEvent(rawEvent) {
  await ensureUsageDirs();
  const event = buildUsageEvent(rawEvent);
  const index = await readEventIndex();
  if (index.ids.includes(event.eventId)) {
    return { ok: true, duplicate: true, event };
  }
  const filePath = path.join(EVENTS_DIR, `${event.date}.jsonl`);
  await writeFile(filePath, `${JSON.stringify(event)}\n`, { encoding: 'utf8', flag: 'a' });
  index.ids.push(event.eventId);
  await writeEventIndex(index);
  return { ok: true, duplicate: false, event };
}

function iterateDates(fromDate, toDate) {
  const dates = [];
  const start = parseLocalDate(fromDate);
  const end = parseLocalDate(toDate);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) return dates;
  for (let d = start; d <= end; d = new Date(d.getTime() + 86400000)) {
    dates.push(localDateString(d));
  }
  return dates;
}

async function readEventsForDate(date) {
  const filePath = path.join(EVENTS_DIR, `${date}.jsonl`);
  try {
    const content = await readFile(filePath, 'utf8');
    return content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function emptyTotals() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    reasoningTokens: 0,
    audioTokens: 0,
    requests: 0,
    cacheHitRequests: 0,
    events: 0,
  };
}

function addUsage(target, event) {
  const usage = normalizeUsage(event.usage);
  target.inputTokens += usage.inputTokens;
  target.outputTokens += usage.outputTokens;
  target.totalTokens += usage.totalTokens;
  target.cacheReadTokens += usage.cacheReadTokens;
  target.cacheCreationTokens += usage.cacheCreationTokens;
  target.reasoningTokens += usage.reasoningTokens;
  target.audioTokens += usage.audioTokens;
  target.requests += Math.max(1, Math.trunc(toNumber(event.requestCount) || 1));
  target.cacheHitRequests += Math.max(0, Math.trunc(toNumber(event.cacheHitRequests)));
  target.events += 1;
}

function groupKey(event, groupBy) {
  if (groupBy === 'preset') return event.model?.presetName || '(no preset)';
  if (groupBy === 'agent') return event.agentId || '(no agent)';
  if (groupBy === 'source') return event.source || '(unknown)';
  if (groupBy === 'date') return dateFromTimestamp(timestampValue(event));
  return event.model?.modelName || '(unknown model)';
}

export async function queryUsageSummary(options = {}) {
  const today = dateFromTimestamp(Date.now());
  const from = normalizeDate(options.from) || today;
  const to = normalizeDate(options.to) || from;
  const groupBy = ['model', 'preset', 'agent', 'source', 'date'].includes(options.groupBy)
    ? options.groupBy
    : 'model';
  const search = cleanText(options.search).toLowerCase();
  const fromBuffer = parseLocalDate(from);
  const toBuffer = parseLocalDate(to);
  fromBuffer.setDate(fromBuffer.getDate() - 1);
  toBuffer.setDate(toBuffer.getDate() + 1);
  const dates = iterateDates(localDateString(fromBuffer), localDateString(toBuffer));
  const events = [];
  for (const date of dates) {
    events.push(...await readEventsForDate(date));
  }
  const filtered = events.filter((event) => {
    const eventDate = dateFromTimestamp(timestampValue(event));
    if (eventDate < from || eventDate > to) return false;
    if (!search) return true;
    const haystack = [
      event.source,
      event.agentId,
      event.sessionId,
      event.model?.modelName,
      event.model?.presetName,
      event.model?.presetRole,
      event.model?.provider,
      event.model?.providerName,
    ].filter(Boolean).join(' ').toLowerCase();
    return haystack.includes(search);
  });

  const totals = emptyTotals();
  const dailyMap = new Map();
  const groupMap = new Map();

  for (const event of filtered) {
    addUsage(totals, event);
    const date = dateFromTimestamp(timestampValue(event));
    if (!dailyMap.has(date)) dailyMap.set(date, emptyTotals());
    addUsage(dailyMap.get(date), event);

    const key = groupKey(event, groupBy);
    if (!groupMap.has(key)) {
      groupMap.set(key, {
        key,
        label: key,
        modelName: event.model?.modelName || '',
        presetName: event.model?.presetName || '',
        provider: event.model?.provider || '',
        source: event.source || '',
        totals: emptyTotals(),
      });
    }
    addUsage(groupMap.get(key).totals, event);
  }

  const groups = Array.from(groupMap.values())
    .sort((a, b) => b.totals.totalTokens - a.totals.totalTokens);
  const daily = Array.from(dailyMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, dayTotals]) => ({ date, totals: dayTotals }));
  const recentEvents = filtered
    .slice()
    .sort((a, b) => timestampValue(b) - timestampValue(a))
    .slice(0, 120);
  const chartEvents = filtered
    .slice()
    .sort((a, b) => timestampValue(a) - timestampValue(b))
    .slice(-1000);

  return {
    from,
    to,
    groupBy,
    search,
    totals,
    groups,
    daily,
    events: chartEvents,
    recentEvents,
    eventCount: filtered.length,
  };
}

export function setupUsageRoutes(app, express) {
  app.post('/protoclaw/usage/events', express.json({ limit: '1mb' }), async (req, res, next) => {
    try {
      const result = await appendUsageEvent(req.body || {});
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  app.get('/protoclaw/usage/summary', async (req, res, next) => {
    try {
      const summary = await queryUsageSummary({
        from: req.query.from,
        to: req.query.to,
        groupBy: req.query.groupBy,
        search: req.query.search,
      });
      res.json(summary);
    } catch (error) {
      next(error);
    }
  });
}
