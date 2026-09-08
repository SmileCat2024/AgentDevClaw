/**
 * Image attachment storage routes.
 *
 * Host-scoped global resource (ADR-0006): images are persisted under the local
 * user data root, deduped by content hash, and referenced by absolute path in
 * messages — never by page focus or an Agent identity.
 *
 * Remote awareness (ADR-0011): an upload whose agent identity carries the
 * `remote:` namespace is forwarded to the remote host's own upload route, so
 * the returned `path` resolves on the machine the agent runtime actually runs
 * on. The response `url` is rewritten to the /r/<connectionId> asset route so
 * the browser keeps loading previews through this host's proxy.
 */
import { existsSync, mkdirSync, statSync, writeFileSync, createReadStream } from 'fs';
import { createHash } from 'crypto';
import path from 'path';
import {
  resolveForwardHostTarget,
  readForwardTargetError,
} from '../shared/remote-forward.js';
import {
  getProxyConnectionLookup,
  getProxyRemoteAuthSessions,
  REMOTE_ASSET_ROUTE_PREFIX,
} from '../shared/proxy.js';
import { buildLocalFailureResponse } from '../shared/operation-contract.js';

const MIME_TO_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
};

// Content-hash → resolved path cache (in-process dedup)
const _imageHashCache = new Map();

/**
 * Forward an upload to the remote host's own image storage (ADR-0011). The
 * message later references the path the remote agent can actually read; the
 * `url` field is rewritten to the /r/<connectionId> asset route so the
 * browser keeps fetching bytes through this host.
 */
async function forwardRemoteImageUpload(res, hostTarget, payload) {
  const authSessions = getProxyRemoteAuthSessions();
  const findConnection = getProxyConnectionLookup();
  const connection = authSessions && findConnection
    ? (typeof findConnection === 'function'
      ? findConnection(hostTarget.connectionId)
      : findConnection.getConnection?.(hostTarget.connectionId))
    : null;
  const requestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  };
  let response;
  try {
    response = connection && authSessions
      ? await authSessions.fetchWithAuth(connection, `${hostTarget.origin}/protoclaw/images/upload`, requestInit)
      : await fetch(`${hostTarget.origin}/protoclaw/images/upload`, requestInit);
  } catch (error) {
    res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(buildLocalFailureResponse({
      code: 'transport_unavailable',
      status: 503,
      retryable: true,
      message: 'Remote connection transport is unavailable',
    })));
    return;
  }
  const uploadPayload = await response.json().catch(() => null);
  if (uploadPayload === null || typeof uploadPayload !== 'object') {
    res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(buildLocalFailureResponse({
      code: 'operation_rejected',
      status: 502,
      retryable: false,
      message: `Remote image upload returned an unparseable response body (HTTP ${response.status})`,
    })));
    return;
  }
  // 远程返回的 url 是远程自身的相对路由，改写为本机的 /r/<connId> 资产路由，
  // 与历史渲染的派生寻址共用同一前缀。失败响应原样透传，不产生可用的 path。
  if (typeof uploadPayload.url === 'string' && uploadPayload.url.startsWith('/')) {
    uploadPayload.url = `${REMOTE_ASSET_ROUTE_PREFIX}${hostTarget.connectionId}${uploadPayload.url}`;
  }
  res.writeHead(response.status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(uploadPayload));
}

export function setupImageRoutes(app, { imagesDir }) {
  app.post('/protoclaw/images/upload', async (req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        const { base64, mediaType, source, agentId } = JSON.parse(body);
        if (!base64 || typeof base64 !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'Missing or invalid base64' }));
          return;
        }

        // ADR-0011：远程命名空间身份 → 图片必须落在 agent 所在主机（消息中的
        // path 由该机 runtime 按绝对路径读取，跨机路径不可解析）。本地身份
        // 走下方既有落盘路径，行为字节级不动。
        try {
          const hostTarget = resolveForwardHostTarget(typeof agentId === 'string' ? agentId : '');
          if (hostTarget.scope === 'remote') {
            // agentId 只在本机用于连接解析，不进入转发 body。
            return await forwardRemoteImageUpload(res, hostTarget, { base64, mediaType, source });
          }
        } catch (error) {
          res.writeHead(readForwardTargetError(error), { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(buildLocalFailureResponse(error)));
          return;
        }

        const mime = mediaType || 'image/png';
        const ext = MIME_TO_EXT[mime] || 'png';

        // Dedup by content hash — but verify the file still exists on disk
        const hash = createHash('sha256').update(base64).digest('hex').slice(0, 32);

        if (_imageHashCache.has(hash)) {
          const cached = _imageHashCache.get(hash);
          if (existsSync(cached.path)) {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({
              path: cached.path,
              mediaType: mime,
              source: source || `image.${ext}`,
              size: cached.size,
              url: `/protoclaw/images/${cached.filename}`,
            }));
            return;
          }
          // File was deleted externally — purge stale cache entry, fall through to re-write
          _imageHashCache.delete(hash);
        }

        mkdirSync(imagesDir, { recursive: true });
        const filename = `${hash}.${ext}`;
        const filePath = path.join(imagesDir, filename);

        if (!existsSync(filePath)) {
          writeFileSync(filePath, Buffer.from(base64, 'base64'));
        }

        const size = statSync(filePath).size;
        _imageHashCache.set(hash, { path: filePath, size, filename });

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          path: filePath,
          mediaType: mime,
          source: source || `image.${ext}`,
          size,
          url: `/protoclaw/images/${filename}`,
        }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: err.message || 'Upload failed' }));
      }
    });
  });

  // Serve stored images for frontend preview
  app.get('/protoclaw/images/:filename', (req, res) => {
    const filename = path.basename(req.params.filename);
    // Prevent path traversal
    if (filename !== req.params.filename || filename.includes('..')) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Invalid filename' }));
      return;
    }
    const filePath = path.join(imagesDir, filename);
    if (!existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Image not found' }));
      return;
    }
    const ext = path.extname(filename).slice(1);
    const mimeEntry = Object.entries(MIME_TO_EXT).find(([, e]) => e === ext);
    const mime = mimeEntry ? mimeEntry[0] : 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=86400' });
    createReadStream(filePath).pipe(res);
  });
}
