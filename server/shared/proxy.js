import { VIEWER_ORIGIN } from './constants.js';
import {
  RequestTargetError,
  resolveHostTarget,
  resolveProxyTarget,
  resolveRuntimeTarget,
  rewriteProxyUrl,
} from './request-target.js';
import { buildLocalFailureResponse, readOperationMetadata } from './operation-contract.js';

// These headers describe one transport hop, not the end-to-end request. In
// particular, forwarding the browser's Content-Length into undici's
// ProxyAgent makes local PUT/POST requests fail with UND_ERR_INVALID_ARG.
const HOP_BY_HOP_REQUEST_HEADERS = new Set([
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

// ── Remote read-through whitelist (R1-06 / ADR-0008 #2, #7, #8) ──────────
// Only requests whose identity carries the `remote:` namespace are matched
// against this table; local scope never consults it, so local read/write
// behavior stays byte-identical.

const REMOTE_READ_RESOURCES = new Set([
  'messages',
  'tools',
  'hooks',
  'overview',
  'todo',
  'notification',
  'input-requests',
  // Phase 2 写放行的读半边：排队气泡 UI 依赖 GET 队列余量（ADR-0011）。
  'queued-inputs',
  'running',
  // R1-07 只读主视图：轮询循环按 runtime 周期读取连接状态。
  'connection',
]);

// Phase 2 写透传白名单（ADR-0011）：命中资源且携带幂等键的写请求与读同语义
// 转发；之外的写维持 remote_write_disabled。资源名以 ViewerWorker 实际路由为准。
const REMOTE_WRITE_RESOURCES = new Set([
  'input',
  'queued-inputs',
  'interrupt',
  'user-turn',
]);

// Template mount assets live under /tpl/{mountId}/… — the mount layout also
// carries tsup shared chunks and sourcemaps. The remaining prefixes cover the
// standalone URL forms (npm-workspace roots, bare chunk files, legacy
// /template/ paths) so every whitelist-shaped asset stays routable.
const REMOTE_STATIC_PREFIXES = ['/tpl/', '/template/', '/features/', '/npm/'];

function isStaticAssetPath(pathname) {
  return REMOTE_STATIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))
    || pathname.startsWith('/chunk-');
}

// Remote static assets are addressed as /r/<connectionId><asset-path>.
// Identity-in-query (?agentId=remote:…) is not inherited by a module's
// relative imports — tsup shared chunks (`import "../../../chunk-X.js"`)
// resolve against the module path and drop the query, so chunk sub-requests
// lost their routing identity and fell through to the local ViewerWorker
// (unknown mountId → 404 → the whole template module failed to import). A
// path prefix survives relative resolution, so chunk sub-requests stay on the
// same connection automatically. Connection ids are URL-safe by store
// charset, so the segment needs no decoding.
const REMOTE_ASSET_ROUTE_PREFIX = '/r/';

function parseRemoteAssetRoute(pathname) {
  if (!pathname.startsWith(REMOTE_ASSET_ROUTE_PREFIX)) return null;
  const rest = pathname.slice(REMOTE_ASSET_ROUTE_PREFIX.length);
  const separator = rest.indexOf('/');
  if (separator <= 0) return null;
  return { connectionId: rest.slice(0, separator), assetPath: rest.slice(separator) };
}

function isRemoteReadWhitelisted(method, pathname) {
  if (method !== 'GET') return false;
  if (pathname === '/api/templates/feature') return true;
  if (pathname === '/protoclaw/agent_detail') return true;
  // R2-05 面板资源扩列：日志 / MCP 面板的 viewer 平面读端点（viewer-worker
  // 全局 GET），身份经 query agentId 解析，转发前由 rewriteProxyUrl 还原裸 id。
  if (pathname === '/api/logs') return true;
  if (pathname === '/api/mcp-info') return true;
  const match = pathname.match(/^\/api\/agents\/[^/]+\/([^/]+)$/);
  if (match && REMOTE_READ_RESOURCES.has(match[1])) return true;
  return isStaticAssetPath(pathname);
}

function isRemoteWriteWhitelisted(pathname) {
  const match = pathname.match(/^\/api\/agents\/[^/]+\/([^/]+)$/);
  return Boolean(match && REMOTE_WRITE_RESOURCES.has(match[1]));
}

// ── Connection-table injection (R1-01 ConnectionStore → proxy) ────────────
// The host plane wires its ConnectionStore lookup here (per-call options take
// precedence). Until wired, remote namespaces fail explicitly with
// target_not_found instead of silently falling back to local (ADR-0008 #1).
let _connectionLookup = null;

export function setProxyConnectionLookup(findConnection) {
  _connectionLookup = findConnection
    && (typeof findConnection === 'function' || typeof findConnection.getConnection === 'function')
    ? findConnection
    : null;
}

// 共享读取宿主装配的连接查找（remote-forward 等 ADR-0011 消费方复用同一张
// ConnectionStore，server.js 仍只注册一次）。
export function getProxyConnectionLookup() {
  return _connectionLookup;
}

// ── Remote auth sessions（远程单密码访问保护）────────────────────────────
// 宿主装配 RemoteAuthSessions 单例：远程目标请求经它附加登录会话凭据。
// 未装配或连接未配置密码时行为与从前一致（直通，不登录）。
let _remoteAuthSessions = null;

export function setProxyRemoteAuthSessions(authSessions) {
  _remoteAuthSessions = authSessions || null;
}

export function getProxyRemoteAuthSessions() {
  return _remoteAuthSessions;
}

// Template-map and static-asset requests address the agent through a query
// parameter instead of a route segment. The accepted keys are the canonical
// agent-addressing family rewriteProxyUrl restores (request-target's
// AGENT_QUERY_KEYS); keep both lists in sync if that family grows.
function readAgentQueryIdentity(originalUrl) {
  const query = String(originalUrl).split('?').slice(1).join('?');
  if (!query) return null;

  let agentId;
  let agent;
  for (const pair of query.split('&')) {
    const separator = pair.indexOf('=');
    if (separator === -1) continue;
    const key = pair.slice(0, separator);
    if (key === 'agentId') agentId = pair.slice(separator + 1);
    else if (key === 'agent') agent = pair.slice(separator + 1);
  }
  if (agentId === undefined && agent === undefined) return null;
  if (agentId !== undefined && agent !== undefined && agentId !== agent) {
    throw new RequestTargetError('agentId fields conflict');
  }
  return agentId !== undefined ? agentId : agent;
}

// Phase 0 failure shape, constructed locally because `remote_write_disabled`
// is a Phase 1 code that normalizeCode would fold into operation_rejected.
function buildRemoteFailure(code, message, metadata) {
  const { operationId, ...rest } = metadata || {};
  return {
    ok: false,
    code,
    retryable: false,
    operationId: operationId || null,
    message,
    // Keep the legacy field so existing clients continue to render failures.
    error: message,
    ...rest,
  };
}

// /api/templates/feature responds with { templateName: url } where each url
// addresses the remote's own template mounts. The rewrite nests every url
// under /r/<connectionId> so the frontend's follow-up requests — including
// relative chunk imports inside the template modules — route back through
// this proxy to the remote origin (the prefix is preserved by URL-relative
// resolution; the query form is not, see REMOTE_ASSET_ROUTE_PREFIX). Only
// these follow-up URL fields are rewritten; data references inside message
// bodies keep the remote's original ids untouched.
function rewriteTemplateMapUrls(body, target) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;

  const prefix = `${REMOTE_ASSET_ROUTE_PREFIX}${target.connectionId}`;
  let rewritten = null;
  for (const [name, url] of Object.entries(body)) {
    if (typeof url !== 'string' || !isStaticAssetPath(url.split('?')[0])) continue;
    // Urls that already carry an explicit agent identity are left untouched.
    if (/[?&]agentId=/.test(url)) continue;
    if (!rewritten) rewritten = { ...body };
    rewritten[name] = `${prefix}${url}`;
  }
  return rewritten;
}

async function readRewrittenTemplateMap(response, target) {
  let body;
  try {
    body = JSON.parse(Buffer.from(await response.arrayBuffer()).toString('utf8'));
  } catch {
    // Unparseable bodies pass through unchanged rather than being mangled.
    return null;
  }
  const rewritten = rewriteTemplateMapUrls(body, target);
  return rewritten ? Buffer.from(JSON.stringify(rewritten)) : null;
}

function readConnectionFromLookup(findConnection, connectionId) {
  if (!findConnection) return null;
  if (typeof findConnection === 'function') return findConnection(connectionId);
  return findConnection.getConnection?.(connectionId) ?? null;
}

// 远程目标请求经 RemoteAuthSessions 附加登录会话凭据（远程开启访问保护时
// 必需）；本地目标与未装配/未配置密码的连接保持直通，行为不变。连接查找与
// target 解析同源（per-call 注入优先），避免两条解析路径分叉。
async function remoteFetch(target, findConnection, url, init) {
  if (!target || target.scope !== 'remote' || !_remoteAuthSessions) {
    return fetch(url, init);
  }
  const connection = readConnectionFromLookup(findConnection || _connectionLookup, target.connectionId);
  if (!connection) return fetch(url, init);
  return _remoteAuthSessions.fetchWithAuth(connection, url, init);
}

export async function proxyToViewer(req, res, options = {}) {
  const metadata = readOperationMetadata(req);
  const resolveOptions = {
    viewerOrigin: VIEWER_ORIGIN,
    findConnection: options.findConnection || _connectionLookup,
  };

  const method = req.method.toUpperCase();
  const originalUrl = String(req.originalUrl || '');
  const pathname = originalUrl.split(/[?#]/, 1)[0];

  // /r/<connectionId><asset-path> carries its target in the path itself; it
  // bypasses the query/route identity resolution and the read whitelist,
  // which it subsumes (GET + static asset prefixes + enabled connection).
  const remoteAssetRoute = parseRemoteAssetRoute(pathname);
  if (remoteAssetRoute) {
    if (method !== 'GET') {
      res.status(403).json(buildLocalFailureResponse({
        status: 403,
        message: `Remote asset route is read-only: ${method} ${pathname}`,
      }, metadata));
      return;
    }
    if (!isStaticAssetPath(remoteAssetRoute.assetPath)) {
      res.status(403).json(buildLocalFailureResponse({
        status: 403,
        message: `Remote asset route only serves static asset paths: ${method} ${pathname}`,
      }, metadata));
      return;
    }
  }

  let target = resolveProxyTarget(req, resolveOptions);
  if (!target) {
    const queryAgentId = readAgentQueryIdentity(originalUrl);
    if (queryAgentId !== null) {
      target = resolveRuntimeTarget({ agentId: queryAgentId }, resolveOptions);
    }
  }

  if (remoteAssetRoute) {
    // resolveHostTarget applies the same failure contract as runtime targets:
    // unknown connection → target_not_found, disabled → transport_unavailable.
    const hostTarget = resolveHostTarget({ connectionId: remoteAssetRoute.connectionId }, {
      findConnection: resolveOptions.findConnection,
    });
    target = {
      scope: 'remote',
      connectionId: remoteAssetRoute.connectionId,
      agentId: null,
      sessionId: null,
      runtimeId: null,
      origin: hostTarget.origin,
    };
  }

  if (target && target.scope === 'remote' && !remoteAssetRoute && !isRemoteReadWhitelisted(method, pathname)) {
    const isWrite = method !== 'GET' && method !== 'HEAD';
    const writeWhitelisted = isWrite && isRemoteWriteWhitelisted(pathname);
    if (!writeWhitelisted) {
      // Whitelisted reads forward to the remote origin. Everything else is
      // rejected locally: non-whitelisted writes keep the Phase 1
      // remote_write_disabled code, so the remote stays unaware of them.
      const failure = isWrite
        ? buildRemoteFailure(
          'remote_write_disabled',
          'Remote connections are read-only; write operations are disabled',
          metadata,
        )
        : buildLocalFailureResponse({
          status: 403,
          message: `Remote read path is not whitelisted: ${method} ${pathname}`,
        }, metadata);
      res.status(403).json(failure);
      return;
    }
    // Idempotency gate (ADR-0011): a remote write without an idempotency key
    // is rejected before it can cross the tunnel. Keys arrive via header or
    // query — the body has not been buffered at gate time.
    if (!metadata.idempotencyKey) {
      res.status(400).json(buildRemoteFailure(
        'idempotency_key_required',
        'Remote write operations require an idempotency key (x-idempotency-key)',
        metadata,
      ));
      return;
    }
    // Fall through: forward like a read (tunnel origin + rewritten ids).
  }

  const headers = new Headers();

  for (const [key, value] of Object.entries(req.headers)) {
    if (value == null) continue;
    if (HOP_BY_HOP_REQUEST_HEADERS.has(key.toLowerCase())) continue;
    headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  }

  const init = { method, headers };

  if (method !== 'GET' && method !== 'HEAD') {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    init.body = Buffer.concat(chunks);
  }

  // Remote forwards restore the remote's original resource ids in the
  // request URL; rewriteProxyUrl is a no-op for local targets, which keep
  // byte-identical forwarding. Asset-route forwards strip the /r/<connId>
  // prefix — the asset path (query included) is forwarded verbatim.
  const targetUrl = remoteAssetRoute
    ? `${target.origin}${remoteAssetRoute.assetPath}${originalUrl.slice(pathname.length)}`
    : target && target.scope === 'remote'
      ? `${target.origin}${rewriteProxyUrl(originalUrl, target)}`
      : `${target?.viewerOrigin || VIEWER_ORIGIN}${originalUrl}`;

  let response;
  try {
    response = await remoteFetch(target, resolveOptions.findConnection, targetUrl, init);
  } catch (error) {
    const isRemote = Boolean(target && target.scope === 'remote');
    const failure = buildLocalFailureResponse({
      ...error,
      message: isRemote
        ? 'Remote connection transport is unavailable'
        : 'Local Viewer transport is unavailable',
      code: 'transport_unavailable',
      status: 503,
      retryable: true,
      transport: true,
    }, metadata);
    res.status(503).json(failure);
    return;
  }

  const templateMapEligible = Boolean(target && target.scope === 'remote')
    && pathname === '/api/templates/feature'
    && response.status === 200
    && (response.headers.get('content-type') || '').includes('json')
    && !response.headers.get('content-encoding');
  const rewrittenBody = templateMapEligible
    ? await readRewrittenTemplateMap(response, target)
    : null;

  res.status(response.status);

  // A rewritten body invalidates the remote's content-length; every other
  // header (operation metadata included) is forwarded verbatim.
  response.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (lower === 'transfer-encoding') return;
    if (rewrittenBody && lower === 'content-length') return;
    res.setHeader(key, value);
  });

  const arrayBuffer = rewrittenBody || await response.arrayBuffer();
  res.end(Buffer.from(arrayBuffer));
}
