import { VIEWER_ORIGIN } from './constants.js';

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

export async function proxyToViewer(req, res) {
  const targetUrl = `${VIEWER_ORIGIN}${req.originalUrl}`;
  const headers = new Headers();

  for (const [key, value] of Object.entries(req.headers)) {
    if (value == null) continue;
    if (HOP_BY_HOP_REQUEST_HEADERS.has(key.toLowerCase())) continue;
    headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  }

  const method = req.method.toUpperCase();
  const init = { method, headers };

  if (method !== 'GET' && method !== 'HEAD') {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    init.body = Buffer.concat(chunks);
  }

  const response = await fetch(targetUrl, init);
  res.status(response.status);

  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'transfer-encoding') return;
    res.setHeader(key, value);
  });

  const arrayBuffer = await response.arrayBuffer();
  res.end(Buffer.from(arrayBuffer));
}
