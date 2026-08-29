import { existsSync, readFileSync } from 'fs';
import { promises as fs } from 'fs';
import path from 'path';
import process from 'process';
import {
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'crypto';
import { USER_DATA_ROOT } from './shared/constants.js';

const AUTH_CONFIG_PATH = path.join(USER_DATA_ROOT, 'auth.json');
const SESSIONS_PATH = path.join(USER_DATA_ROOT, 'auth-sessions.json');
const SESSION_COOKIE = 'claw_session';
// 闲置 3 天不活跃即要求重新登录；自登录起算最长 7 天，不随活动延长。
export const SESSION_IDLE_TTL_MS = 3 * 24 * 60 * 60 * 1000;
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_FLUSH_DELAY_MS = 250;
const PASSWORD_MIN_LENGTH = 8;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;
const LOGIN_RETRY_AFTER_SEC = 60;

const sessions = loadSessions();
const loginFailures = new Map();

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function newServiceToken() {
  return randomBytes(32).toString('hex');
}

function loadAuthState() {
  let raw = {};
  if (existsSync(AUTH_CONFIG_PATH)) {
    try {
      raw = JSON.parse(readFileSync(AUTH_CONFIG_PATH, 'utf8')) || {};
    } catch {
      raw = {};
    }
  }
  const serviceToken = cleanText(raw.serviceToken) || newServiceToken();
  const state = {
    enabled: raw.enabled === true,
    passwordHash: cleanText(raw.passwordHash),
    passwordSalt: cleanText(raw.passwordSalt),
    serviceToken,
  };
  process.env.PROTOCLAW_INTERNAL_TOKEN = serviceToken;
  return state;
}

const state = loadAuthState();
let writeChain = Promise.resolve();

function publicState() {
  return {
    enabled: state.enabled,
    configured: Boolean(state.passwordHash && state.passwordSalt),
  };
}

function serializeState() {
  return `${JSON.stringify(state, null, 2)}\n`;
}

function persistState() {
  writeChain = writeChain.then(async () => {
    await fs.mkdir(USER_DATA_ROOT, { recursive: true });
    const tempPath = `${AUTH_CONFIG_PATH}.${process.pid}.tmp`;
    await fs.writeFile(tempPath, serializeState(), { encoding: 'utf8', mode: 0o600 });
    try {
      await fs.chmod(tempPath, 0o600);
    } catch {
      // Windows does not expose Unix file modes.
    }
    await fs.rename(tempPath, AUTH_CONFIG_PATH);
  });
  return writeChain;
}

// 会话持久化：重启后已登录会话保留。活动刷新走短防抖落盘，避免每请求写盘；
// 不依赖 exit 钩子刷盘（Windows 上 SIGTERM 不保证触发）。
let sessionWriteChain = Promise.resolve();
let sessionFlushTimer = null;

function scheduleSessionFlush() {
  if (sessionFlushTimer) return;
  sessionFlushTimer = setTimeout(() => {
    sessionFlushTimer = null;
    sessionWriteChain = sessionWriteChain.then(flushSessions).catch(() => {});
  }, SESSION_FLUSH_DELAY_MS);
  sessionFlushTimer.unref?.();
}

async function flushSessions() {
  pruneExpiredSessions();
  const payload = `${JSON.stringify({ sessions: Object.fromEntries(sessions) }, null, 2)}\n`;
  await fs.mkdir(USER_DATA_ROOT, { recursive: true });
  const tempPath = `${SESSIONS_PATH}.${process.pid}.tmp`;
  await fs.writeFile(tempPath, payload, { encoding: 'utf8', mode: 0o600 });
  try {
    await fs.chmod(tempPath, 0o600);
  } catch {
    // Windows does not expose Unix file modes.
  }
  await fs.rename(tempPath, SESSIONS_PATH);
}

function loadSessions() {
  const map = new Map();
  if (!existsSync(SESSIONS_PATH)) return map;
  try {
    const raw = JSON.parse(readFileSync(SESSIONS_PATH, 'utf8'));
    const entries = raw && typeof raw === 'object' ? raw.sessions : null;
    if (entries && typeof entries === 'object') {
      for (const [id, record] of Object.entries(entries)) {
        if (!/^[a-f0-9]{64}$/.test(id) || !record || typeof record !== 'object') continue;
        const absoluteExpiresAt = Number(record.absoluteExpiresAt);
        const lastActiveAt = Number(record.lastActiveAt);
        if (!Number.isFinite(absoluteExpiresAt) || !Number.isFinite(lastActiveAt)) continue;
        map.set(id, { absoluteExpiresAt, lastActiveAt });
      }
    }
  } catch {
    // 损坏的会话文件按无会话处理，重新登录即可恢复。
  }
  pruneExpiredSessions(map);
  return map;
}

export function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const normalized = typeof password === 'string' ? password : '';
  return {
    salt,
    hash: scryptSync(normalized, salt, 64).toString('hex'),
  };
}

export function verifyPassword(password, salt, expectedHash) {
  if (!cleanText(salt) || !cleanText(expectedHash) || typeof password !== 'string') return false;
  try {
    const actual = scryptSync(password, salt, 64);
    const expected = Buffer.from(expectedHash, 'hex');
    return expected.length === actual.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function createSession() {
  const id = randomBytes(32).toString('hex');
  sessions.set(id, { absoluteExpiresAt: Date.now() + SESSION_TTL_MS, lastActiveAt: Date.now() });
  scheduleSessionFlush();
  return id;
}

export function sessionExpired(record, now = Date.now()) {
  return now >= record.absoluteExpiresAt
    || now - record.lastActiveAt >= SESSION_IDLE_TTL_MS;
}

function pruneExpiredSessions(target = sessions, now = Date.now()) {
  for (const [id, record] of target) {
    if (sessionExpired(record, now)) target.delete(id);
  }
}

function readCookies(header) {
  const cookies = {};
  for (const part of String(header || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key) cookies[key] = value;
  }
  return cookies;
}

function requestIp(req) {
  return cleanText(req.ip) || req.socket?.remoteAddress || 'unknown';
}

function checkLoginRateLimit(req) {
  const now = Date.now();
  const key = requestIp(req);
  const current = loginFailures.get(key);
  if (!current || current.resetAt <= now) {
    loginFailures.delete(key);
    return { allowed: true };
  }
  if (current.failures < LOGIN_MAX_FAILURES) return { allowed: true };
  return { allowed: false, retryAfter: Math.max(1, Math.ceil((current.resetAt - now) / 1000)) };
}

function recordLoginFailure(req) {
  const now = Date.now();
  const key = requestIp(req);
  const current = loginFailures.get(key);
  if (!current || current.resetAt <= now) {
    loginFailures.set(key, { failures: 1, resetAt: now + LOGIN_WINDOW_MS });
  } else {
    current.failures += 1;
  }
}

function clearLoginFailures(req) {
  loginFailures.delete(requestIp(req));
}

function isSecureRequest(req) {
  return req.secure === true || cleanText(req.headers['x-forwarded-proto']).split(',')[0] === 'https';
}

function setSessionCookie(res, id, req) {
  const secure = isSecureRequest(req) ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure}`);
}

function setNoStore(res) {
  res.setHeader('Cache-Control', 'no-store');
}

export function clearSessionCookie(res, req) {
  const secure = isSecureRequest(req) ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`);
}

function authenticateSession(req) {
  const id = readCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!id) return null;
  const record = sessions.get(id);
  if (!record) return null;
  if (sessionExpired(record)) {
    sessions.delete(id);
    scheduleSessionFlush();
    return null;
  }
  record.lastActiveAt = Date.now();
  scheduleSessionFlush();
  return { kind: 'session', id };
}

function authenticateInternal(req) {
  const header = cleanText(req.headers.authorization);
  if (!header.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  const expected = Buffer.from(state.serviceToken);
  const actual = Buffer.from(token);
  if (!actual.length || actual.length !== expected.length) return null;
  try {
    return timingSafeEqual(actual, expected) ? { kind: 'internal' } : null;
  } catch {
    return null;
  }
}

function isProtectedPath(pathname) {
  return pathname === '/mcp'
    || pathname.startsWith('/mcp/')
    || pathname === '/api'
    || pathname.startsWith('/api/')
    || pathname === '/protoclaw'
    || pathname.startsWith('/protoclaw/');
}

function isAuthPublicPath(pathname) {
  return pathname === '/protoclaw/auth/status' || pathname === '/protoclaw/auth/login';
}

function requestHasSameOrigin(req) {
  const protocol = cleanText(req.headers['x-forwarded-proto']).split(',')[0] || (req.socket?.encrypted ? 'https' : 'http');
  const host = cleanText(req.headers['x-forwarded-host']) || cleanText(req.headers.host);
  const origin = cleanText(req.headers.origin);
  const referer = cleanText(req.headers.referer);
  const candidate = origin || referer;
  if (!candidate) return false;
  try {
    const url = new URL(candidate);
    return url.protocol === `${protocol}:` && url.host === host;
  } catch {
    return false;
  }
}

export function authMiddleware(req, res, next) {
  const pathname = String(req.path || req.url || '').split('?')[0];
  if (!state.enabled || !isProtectedPath(pathname) || isAuthPublicPath(pathname)) {
    next();
    return;
  }

  const identity = authenticateInternal(req) || authenticateSession(req);
  if (!identity) {
    res.status(401).json({ ok: false, error: 'Authentication required', code: 'AUTH_REQUIRED' });
    return;
  }

  if (identity.kind === 'session' && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !requestHasSameOrigin(req)) {
    res.status(403).json({ ok: false, error: 'Cross-origin request denied', code: 'CSRF_ORIGIN_REJECTED' });
    return;
  }
  req.auth = identity;
  next();
}

export function registerAuthRoutes(app, express) {
  app.get('/protoclaw/auth/status', (req, res) => {
    setNoStore(res);
    res.json({ ok: true, ...publicState(), authenticated: !state.enabled || Boolean(authenticateInternal(req) || authenticateSession(req)) });
  });

  app.post('/protoclaw/auth/login', express.json({ limit: '16kb' }), (req, res) => {
    setNoStore(res);
    const limit = checkLoginRateLimit(req);
    if (!limit.allowed) {
      res.setHeader('Retry-After', String(limit.retryAfter || LOGIN_RETRY_AFTER_SEC));
      res.status(429).json({ ok: false, error: 'Too many login attempts', code: 'AUTH_RATE_LIMITED' });
      return;
    }
    if (!state.enabled) {
      res.json({ ok: true, authenticated: true, enabled: false });
      return;
    }
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const valid = verifyPassword(password, state.passwordSalt, state.passwordHash);
    if (!valid) {
      recordLoginFailure(req);
      res.status(401).json({ ok: false, error: 'Invalid password', code: 'AUTH_INVALID_CREDENTIALS' });
      return;
    }
    clearLoginFailures(req);
    setSessionCookie(res, createSession(), req);
    res.json({ ok: true, authenticated: true, enabled: true });
  });

  app.post('/protoclaw/auth/logout', (req, res) => {
    setNoStore(res);
    const identity = authenticateSession(req);
    if (state.enabled && identity?.kind !== 'session') {
      res.status(401).json({ ok: false, error: 'Authentication required', code: 'AUTH_REQUIRED' });
      return;
    }
    const id = readCookies(req.headers.cookie)[SESSION_COOKIE];
    if (id) sessions.delete(id);
    scheduleSessionFlush();
    clearSessionCookie(res, req);
    res.json({ ok: true });
  });

  app.get('/protoclaw/auth/config', (req, res) => {
    setNoStore(res);
    if (state.enabled && !(authenticateInternal(req) || authenticateSession(req))) {
      res.status(401).json({ ok: false, error: 'Authentication required', code: 'AUTH_REQUIRED' });
      return;
    }
    res.json({ ok: true, ...publicState() });
  });

  app.put('/protoclaw/auth/config', express.json({ limit: '16kb' }), async (req, res, next) => {
    setNoStore(res);
    try {
      const identity = authenticateInternal(req) || authenticateSession(req);
      if (state.enabled && identity?.kind !== 'session') {
        res.status(401).json({ ok: false, error: 'Authentication required', code: 'AUTH_REQUIRED' });
        return;
      }
      const enabled = req.body?.enabled === true;
      const password = typeof req.body?.password === 'string' ? req.body.password : '';
      const configured = Boolean(state.passwordHash && state.passwordSalt);
      if (enabled && !configured && password.length < PASSWORD_MIN_LENGTH) {
        res.status(400).json({ ok: false, error: `Password must be at least ${PASSWORD_MIN_LENGTH} characters`, code: 'AUTH_PASSWORD_TOO_SHORT' });
        return;
      }
      if (password && password.length < PASSWORD_MIN_LENGTH) {
        res.status(400).json({ ok: false, error: `Password must be at least ${PASSWORD_MIN_LENGTH} characters`, code: 'AUTH_PASSWORD_TOO_SHORT' });
        return;
      }
      if (password) {
        const hashed = hashPassword(password);
        state.passwordSalt = hashed.salt;
        state.passwordHash = hashed.hash;
        // 密码变更后作废全部旧会话，防止旧登录态继续使用。
        sessions.clear();
        scheduleSessionFlush();
      }
      if (!enabled && !password && !state.passwordHash) {
        state.passwordSalt = '';
        state.passwordHash = '';
      }
      if (enabled && !state.passwordHash) {
        res.status(400).json({ ok: false, error: 'A password is required before enabling protection', code: 'AUTH_PASSWORD_REQUIRED' });
        return;
      }
      if (!enabled) {
        sessions.clear();
        scheduleSessionFlush();
      }
      state.enabled = enabled;
      await persistState();
      if (enabled) setSessionCookie(res, createSession(), req);
      else clearSessionCookie(res, req);
      res.json({ ok: true, ...publicState(), authenticated: true });
    } catch (error) {
      next(error);
    }
  });
}

export function getInternalAuthToken() {
  return state.serviceToken;
}

export function getAuthStateForTest() {
  return { ...publicState() };
}

export const AUTH_PASSWORD_MIN_LENGTH = PASSWORD_MIN_LENGTH;
