/**
 * Lightweight diagnostics for the external coder ACP adapter.
 *
 * Diagnostics never write to stdout. File writes are queued asynchronously so
 * a slow disk cannot delay an ACP request or notification.
 */

import { mkdir, rename, stat, appendFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_CONTENT_LIMIT = 512;
const MAX_ROTATIONS = 2;
const SENSITIVE_KEY = /pass(word)?|secret|token|api[_-]?key|authorization|cookie|credential|private[_-]?key/i;
const CONTENT_KEY = /prompt|text|arguments?|raw(input|output)|result|error|message|cwd|path|uri|env/i;

function enabled(value) {
  return value === true || value === '1' || value === 1;
}

function finitePositive(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function truncate(value, limit) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}…[truncated]`;
}

function redact(value, limit, key = '') {
  if (SENSITIVE_KEY.test(key)) return '[REDACTED]';
  if (typeof value === 'string') {
    return truncate(value.replace(/(bearer\s+)[^\s]+/gi, '$1[REDACTED]'), limit);
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, limit, key));
  if (value && typeof value === 'object') {
    const result = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      result[childKey] = redact(childValue, limit, childKey);
    }
    return result;
  }
  return value;
}

function metadata(value, { includeContent, contentLimit }) {
  if (!includeContent) {
    if (typeof value === 'string') return { length: value.length };
    if (Array.isArray(value)) return { count: value.length };
    if (value && typeof value === 'object') return { keys: Object.keys(value).slice(0, 32) };
    return typeof value;
  }
  return redact(value, contentLimit);
}

function sanitizeTraceValue(value, key, options) {
  if (SENSITIVE_KEY.test(key)) return '[REDACTED]';
  if (CONTENT_KEY.test(key)) return metadata(value, options);
  if (Array.isArray(value)) return value.map((item) => sanitizeTraceValue(item, key, options));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [
      childKey,
      sanitizeTraceValue(childValue, childKey, options),
    ]));
  }
  return value;
}

function compactFrame(frame, includeContent, contentLimit) {
  if (!frame || typeof frame !== 'object') {
    return { frameType: typeof frame };
  }
  const result = {};
  for (const [key, value] of Object.entries(frame)) {
    if (key === 'params' || key === 'result' || key === 'error') {
      result[key] = metadata(value, { includeContent, contentLimit });
    } else if (key === 'method' || key === 'id' || key === 'jsonrpc') {
      result[key] = value;
    }
  }
  return result;
}

/**
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv|object} [options.env]
 * @param {(line: string) => void} [options.stderr]
 * @param {() => number} [options.now]
 * @param {string} [options.traceFile]
 * @param {number} [options.maxBytes]
 * @param {number} [options.contentLimit]
 */
export function createTraceLogger(options = {}) {
  const env = options.env ?? process.env;
  const stderr = options.stderr ?? ((line) => process.stderr.write(`${line}\n`));
  const now = options.now ?? Date.now;
  const debugEnabled = enabled(env.CLAW_ACP_DEBUG);
  const wireEnabled = enabled(env.CLAW_ACP_WIRE_TRACE);
  const includeContent = enabled(env.CLAW_ACP_TRACE_CONTENT);
  const traceFile = options.traceFile ?? env.CLAW_ACP_TRACE_FILE ?? '';
  const maxBytes = finitePositive(options.maxBytes ?? env.CLAW_ACP_TRACE_MAX_BYTES, DEFAULT_MAX_BYTES);
  const contentLimit = finitePositive(options.contentLimit ?? env.CLAW_ACP_TRACE_CONTENT_MAX, DEFAULT_CONTENT_LIMIT);
  const instanceId = randomUUID();
  const requestContexts = new Map();
  const sessionContexts = new Map();
  let queue = Promise.resolve();
  let closed = false;

  function enqueueFile(line) {
    if (!traceFile || closed) return;
    queue = queue.then(async () => {
      try {
        await mkdir(dirname(traceFile), { recursive: true });
        let currentSize = 0;
        try {
          currentSize = (await stat(traceFile)).size;
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        if (currentSize > 0 && currentSize + Buffer.byteLength(line) > maxBytes) {
          for (let index = MAX_ROTATIONS; index >= 1; index -= 1) {
            const source = index === 1 ? traceFile : `${traceFile}.${index - 1}`;
            const target = `${traceFile}.${index}`;
            try {
              await rename(source, target);
            } catch (error) {
              if (error.code !== 'ENOENT') throw error;
            }
          }
        }
        await appendFile(traceFile, line, 'utf8');
      } catch (error) {
        stderr(`${new Date(now()).toISOString()} [error] coder-acp trace file: ${error.message}`);
      }
    });
  }

  function record(event, fields = {}, { level = 'info', force = false } = {}) {
    if (!debugEnabled && !traceFile && !wireEnabled) return null;
    const recordValue = {
      timestamp: new Date(now()).toISOString(),
      level,
      event,
      traceId: randomUUID(),
      runtimeInstanceId: instanceId,
      ...Object.fromEntries(Object.entries(fields)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => [key, sanitizeTraceValue(value, key, { includeContent, contentLimit })])),
    };
    const line = `${JSON.stringify(recordValue)}\n`;
    if (traceFile) enqueueFile(line);
    if (debugEnabled || force) stderr(`${recordValue.timestamp} [${level}] coder-acp trace: ${line.trim()}`);
    return recordValue;
  }

  function wire(direction, frame) {
    if (!wireEnabled) return null;
    const rawFrame = frame instanceof Uint8Array ? new TextDecoder().decode(frame) : frame;
    const normalized = typeof rawFrame === 'string'
      ? (() => { try { return JSON.parse(rawFrame); } catch { return null; } })()
      : rawFrame;
    const id = normalized?.id;
    const method = normalized?.method;
    let context = id !== undefined ? requestContexts.get(String(id)) : sessionContexts.get(normalized?.params?.sessionId);
    if (direction === 'inbound' && normalized && (id !== undefined || method)) {
      context = {
        acpTraceId: randomUUID(),
        requestId: id,
        method,
        acpSessionId: normalized.params?.sessionId,
      };
      if (id !== undefined) requestContexts.set(String(id), context);
      if (context.acpSessionId) sessionContexts.set(context.acpSessionId, context);
      record('acp.request.received', {
        acpTraceId: context.acpTraceId,
        requestId: id,
        acpSessionId: context.acpSessionId,
        method,
        params: compactFrame(normalized, includeContent, contentLimit).params,
      });
    }
    return record(`acp.${direction}`, {
      direction,
      requestId: id,
      method,
      acpTraceId: context?.acpTraceId,
      acpSessionId: normalized?.params?.sessionId ?? context?.acpSessionId,
      errorCode: normalized?.error?.code,
      frame: compactFrame(normalized, includeContent, contentLimit),
    });
  }

  function findContext(method, params = {}) {
    if (params?.sessionId && sessionContexts.has(params.sessionId)) return sessionContexts.get(params.sessionId);
    for (const context of requestContexts.values()) {
      if (context.method === method && (!params?.sessionId || context.acpSessionId === params.sessionId)) return context;
    }
    return undefined;
  }

  function registerSession(acpSessionId, fields = {}) {
    if (!acpSessionId) return;
    const context = {
      ...(sessionContexts.get(acpSessionId) ?? {}),
      acpSessionId,
      ...fields,
    };
    sessionContexts.set(acpSessionId, context);
    for (const [requestId, requestContext] of requestContexts) {
      if (requestContext.method === 'session/new' && !requestContext.acpSessionId) {
        requestContexts.set(requestId, { ...requestContext, acpSessionId });
      }
    }
  }

  function child(fields = {}) {
    return {
      record: (event, more = {}, options) => record(event, { ...fields, ...more }, options),
      wire,
      registerSession,
      findContext,
      flush,
    };
  }

  async function flush() {
    await queue;
  }

  async function close() {
    await flush();
    closed = true;
  }

  return {
    debugEnabled,
    wireEnabled,
    includeContent,
    contentLimit,
    maxBytes,
    traceFile,
    record,
    wire,
    child,
    findContext,
    registerSession,
    safe: (value) => metadata(value, { includeContent, contentLimit }),
    flush,
    close,
    get pendingWrites() { return queue; },
  };
}

export { redact, truncate, metadata };
