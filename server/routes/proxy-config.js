/**
 * Proxy Configuration Routes
 *
 *   GET  /protoclaw/proxy_config   — current config + detected system proxy + active state
 *   PUT  /protoclaw/proxy_config   — save config, apply globally
 *   POST /protoclaw/proxy_test     — test connectivity through active proxy
 */

import {
  getProxyConfig,
  saveProxyConfig,
  detectSystemProxy,
  applyProxy,
  getActiveProxyUrl,
  testProxyConnectivity,
} from '../shared/proxy-manager.js';

export function setupProxyConfigRoutes(app, express) {
  // ── Read current proxy config + system detection ──────────────

  app.get('/protoclaw/proxy_config', (_req, res) => {
    const config = getProxyConfig();
    const detected = detectSystemProxy();
    const activeUrl = getActiveProxyUrl();

    res.json({
      config,
      detected,
      active: {
        url: activeUrl,
        applied: !!activeUrl,
      },
    });
  });

  // ── Save proxy config and apply globally ─────────────────────

  app.put('/protoclaw/proxy_config', express.json(), (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object') {
      return res.status(400).json({ error: 'Body must be a non-null object' });
    }

    const proxyConfig = {
      enabled: !!body.enabled,
      url: typeof body.url === 'string' ? body.url.trim() : '',
    };

    if (proxyConfig.enabled && !proxyConfig.url) {
      return res.status(400).json({ error: 'Proxy URL is required when enabled' });
    }

    saveProxyConfig(proxyConfig);
    applyProxy();

    const activeUrl = getActiveProxyUrl();
    res.json({
      ok: true,
      config: proxyConfig,
      active: {
        url: activeUrl,
        applied: !!activeUrl,
      },
    });
  });

  // ── Test proxy connectivity ──────────────────────────────────

  app.post('/protoclaw/proxy_test', express.json(), async (req, res) => {
    const testUrl = (typeof req.body?.url === 'string' && req.body.url.trim())
      || 'https://chatgpt.com/backend-api/codex/responses';

    const result = await testProxyConnectivity(testUrl);
    res.json(result);
  });
}
