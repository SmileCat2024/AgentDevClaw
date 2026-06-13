/**
 * claw-core — 共享核心：provider 注册 + 数据读取 + 操作分发
 *
 * 被 bin/claw.mjs（CLI 入口）和 server/claw-mcp.js（MCP Server）共同消费。
 * 所有数据读取函数按 workspaceId 参数化，不再硬编码到任何特定工作空间。
 *
 * Provider 发现：扫描同目录下 providers/*.mjs，每个文件 export default 一个 provider 对象。
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join, dirname, resolve } from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';

// ── 常量 ────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const USER_DATA_ROOT = join(os.homedir(), '.agentdev', 'AgentDevClaw');
const WORKSPACES_ROOT = join(USER_DATA_ROOT, 'workspaces');
const HANDOFFS_ROOT = join(USER_DATA_ROOT, 'context-handoffs');
const SERVER_URL = process.env.PROTOCLAW_SERVER_URL || 'http://127.0.0.1:1420';
const PROVIDERS_DIR = join(__dirname, 'providers');
const PROJECT_ROOT = resolve(__dirname, '..');

// ── 通用 helpers ────────────────────────────────────────────────────

export function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function readJson(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

export function formatDate(isoString) {
  if (!isoString) return '';
  try {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return isoString;
    return d.toLocaleDateString('zh-CN', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return isoString;
  }
}

export function truncate(text, maxLen = 120) {
  if (!text || text.length <= maxLen) return text || '';
  return text.slice(0, maxLen - 1) + '…';
}

// ── 路径解析（按 workspaceId 参数化）────────────────────────────────

export function getWorkspaceDir(workspaceId) {
  return join(WORKSPACES_ROOT, workspaceId);
}

export function getSessionsDir(workspaceId) {
  return join(getWorkspaceDir(workspaceId), 'sessions');
}

export function getHandoffsDir(workspaceId) {
  return join(HANDOFFS_ROOT, workspaceId);
}

export function getWorkspaceStatePath(workspaceId) {
  return join(getWorkspaceDir(workspaceId), 'state.json');
}

// ── 数据读取层（全部按 workspaceId 参数化）──────────────────────────

export function readWorkspaceState(workspaceId) {
  return readJson(getWorkspaceStatePath(workspaceId)) || { forms: {}, openDirectory: '' };
}

export function readSessionIndex(workspaceId) {
  const index = readJson(join(getSessionsDir(workspaceId), 'index.json'));
  if (!index) return { activeSessionId: null, sessions: [] };
  const sessions = Array.isArray(index.sessions)
    ? index.sessions.filter(s => s && s.id && s.id !== 'legacy')
    : [];
  return { activeSessionId: index.activeSessionId, sessions };
}

export function getExplorations(workspaceId) {
  const index = readSessionIndex(workspaceId);
  return index.sessions.filter(s => {
    const st = cleanText(s.sessionType);
    if (st === 'exploration') return true;
    if (st === 'sub' && s.metadata?.clean === true) return true;
    if (st === 'sub' && s.metadata?.sourceSessionId?.startsWith('__protoclaw-clean-')) return true;
    return false;
  });
}

export function getSubs(workspaceId) {
  const index = readSessionIndex(workspaceId);
  return index.sessions.filter(s => {
    const st = cleanText(s.sessionType);
    if (st === 'sub' && s.metadata?.clean === true) return false;
    if (st === 'sub' && s.metadata?.sourceSessionId?.startsWith('__protoclaw-clean-')) return false;
    if (st === 'sub' && s.metadata?.resumeMode === 'one-shot') return true;
    return false;
  });
}

export function loadSessionDetail(workspaceId, sessionId) {
  const filePath = join(getSessionsDir(workspaceId), `${sessionId}.json`);
  if (!existsSync(filePath)) return null;
  const raw = readJson(filePath);
  if (!raw) return null;

  const messages = Array.isArray(raw?.runtime?.context?.messages)
    ? raw.runtime.context.messages
    : [];
  const lastMessage = [...messages].reverse().find(
    m => m && typeof m.content === 'string' && m.role !== 'system'
  );

  return {
    id: sessionId,
    savedAt: raw.savedAt,
    messageCount: messages.length,
    lastMessage: lastMessage?.content
      ? String(lastMessage.content).replace(/\s+/g, ' ').slice(0, 200)
      : '',
    messages,
  };
}

export function loadFinalOutput(workspaceId, sessionId) {
  const detail = loadSessionDetail(workspaceId, sessionId);
  if (!detail) return null;
  const lastAssistant = [...detail.messages].reverse().find(
    m => m && m.role === 'assistant' && typeof m.content === 'string'
  );
  return lastAssistant?.content || null;
}

export function findHandoffSummary(workspaceId, sessionId) {
  if (!sessionId) return null;
  const dir = getHandoffsDir(workspaceId);
  if (!existsSync(dir)) return null;

  let files;
  try {
    files = readdirSync(dir)
      .filter(name => name.startsWith('handoff-') && name.endsWith('.json'))
      .map(name => join(dir, name))
      .filter(filePath => statSync(filePath).isFile());
  } catch {
    return null;
  }

  let best = null;
  let bestPath = '';
  for (const filePath of files) {
    const handoff = readJson(filePath);
    if (!handoff || handoff.sourceSessionId !== sessionId) continue;
    const createdAt = handoff.createdAt || '';
    if (!best || createdAt > (best.createdAt || '')) {
      best = handoff;
      bestPath = filePath;
    }
  }

  if (!best) return null;

  return {
    sessionId,
    handoffId: best.handoffId || '',
    handoffPath: bestPath,
    handoffCreatedAt: best.createdAt || '',
    mode: best.mode || '',
    summaryText: cleanText(best.sourceSummary),
    importantFiles: Array.isArray(best.compactOutput?.importantFiles)
      ? best.compactOutput.importantFiles : [],
    importantSkills: Array.isArray(best.compactOutput?.importantSkills)
      ? best.compactOutput.importantSkills : [],
    seedMessages: Array.isArray(best.seedMessages) ? best.seedMessages : [],
    stats: best.stats || {},
    sessionTimestamp: best.sessionTimestamp || null,
    sessionTitle: best.sessionTitle || null,
    gitMeta: best.gitMeta || null,
  };
}

export function hasSummary(workspaceId, sessionId) {
  return findHandoffSummary(workspaceId, sessionId) !== null;
}

// ── HTTP helper ─────────────────────────────────────────────────────

export async function serverHttp(path, options = {}) {
  const response = await fetch(`${SERVER_URL}${path}`, {
    method: options.method || 'GET',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const ok = response.ok;
  let data;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  return { ok, status: response.status, data };
}

// ── Provider 注册 ───────────────────────────────────────────────────

/** @type {Map<string, any>} */
const _providers = new Map();
let _providersPromise = null;

/**
 * 从 providers/ 目录加载所有 provider 模块。
 * 每个模块 export default 一个对象：{ id, name, description, operations: [...] }
 * 使用 Promise 缓存避免并发竞态。
 */
export async function loadProviders() {
  if (_providersPromise) return _providersPromise;

  _providersPromise = (async () => {
    if (!existsSync(PROVIDERS_DIR)) return _providers;

    let files;
    try {
      files = readdirSync(PROVIDERS_DIR).filter(f => f.endsWith('.mjs'));
    } catch {
      return _providers;
    }

    for (const file of files) {
      try {
        const mod = await import(pathToFileURL(join(PROVIDERS_DIR, file)).href);
        const provider = mod.default;
        if (provider && provider.id && Array.isArray(provider.operations)) {
          _providers.set(provider.id, provider);
        }
      } catch (err) {
        console.error(`[claw-core] Failed to load provider ${file}:`, err?.message || err);
      }
    }

    return _providers;
  })();

  return _providersPromise;
}

export function getProvider(id) {
  return _providers.get(id) || null;
}

export function listProviders() {
  return Array.from(_providers.values());
}

/**
 * 获取默认 workspace ID（第一个注册的 provider）。
 */
export function getDefaultWorkspaceId() {
  const providers = listProviders();
  return providers.length > 0 ? providers[0].id : null;
}

// ── Context 工厂 ────────────────────────────────────────────────────

/**
 * 为 provider operation 创建执行上下文。
 * 绑定了当前 workspaceId 的所有数据读取函数。
 * @param {string} workspaceId
 * @param {object} [provider] — provider 对象，其非 operations 字段会注入到 ctx
 */
export function createContext(workspaceId, provider = null) {
  const ctx = {
    workspaceId,
    projectRoot: PROJECT_ROOT,
    serverUrl: SERVER_URL,

    // 数据读取
    readWorkspaceState: () => readWorkspaceState(workspaceId),
    readSessionIndex: () => readSessionIndex(workspaceId),
    getExplorations: () => getExplorations(workspaceId),
    getSubs: () => getSubs(workspaceId),
    loadSessionDetail: (sessionId) => loadSessionDetail(workspaceId, sessionId),
    loadFinalOutput: (sessionId) => loadFinalOutput(workspaceId, sessionId),
    findHandoffSummary: (sessionId) => findHandoffSummary(workspaceId, sessionId),

    // HTTP
    http: (path, options) => serverHttp(path, options),

    // Process execution
    execFileSync,

    // 路径
    getSessionsDir: () => getSessionsDir(workspaceId),
    getHandoffsDir: () => getHandoffsDir(workspaceId),
  };

  // 注入 provider 级别的元数据（如 agentDir）
  if (provider) {
    for (const [key, value] of Object.entries(provider)) {
      if (key === 'operations') continue;
      if (!(key in ctx)) {
        ctx[key] = value;
      }
    }
  }

  return ctx;
}

// ── 操作分发 ────────────────────────────────────────────────────────

/**
 * 在指定 workspace 上执行一个操作。
 *
 * @param {string} workspaceId
 * @param {string} operationName - provider.operations[].name
 * @param {object} params - 已解析的参数
 * @returns {Promise<{ ok: boolean, result?: any, error?: string }>}
 */
export async function dispatch(workspaceId, operationName, params = {}) {
  const provider = getProvider(workspaceId);
  if (!provider) {
    return { ok: false, error: `Unknown workspace: ${workspaceId}` };
  }

  const operation = provider.operations.find(op => op.name === operationName);
  if (!operation) {
    const available = provider.operations.map(op => op.name).join(', ');
    return { ok: false, error: `Unknown operation "${operationName}" for workspace "${workspaceId}". Available: ${available}` };
  }

  // 校验必填参数
  if (Array.isArray(operation.params)) {
    for (const param of operation.params) {
      if (param.required && (params[param.name] === undefined || params[param.name] === '')) {
        return { ok: false, error: `Missing required parameter: ${param.name}` };
      }
    }
  }

  const ctx = createContext(workspaceId, provider);
  try {
    const result = await operation.execute(ctx, params);
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

// ── 导出常量供外部使用 ──────────────────────────────────────────────

export { USER_DATA_ROOT, WORKSPACES_ROOT, SERVER_URL, PROJECT_ROOT };
