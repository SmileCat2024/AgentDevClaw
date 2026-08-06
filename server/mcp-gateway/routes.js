/**
 * MCP Gateway Express routes.
 *
 * Route map:
 *   GET  /protoclaw/mcp-gateway/servers        — discovery (for agents)
 *   GET  /protoclaw/mcp-gateway/status         — management status (for UI)
 *   GET  /protoclaw/mcp-gateway/config         — get raw config (for UI)
 *   PUT  /protoclaw/mcp-gateway/config         — save config (for UI)
 *   POST /protoclaw/mcp-gateway/:serverId/restart — restart a server
 *   ALL  /protoclaw/mcp-gateway/:serverId      — MCP proxy (standard StreamableHTTP)
 */

import { getGatewayManager } from './manager.js';
import { APP_ORIGIN } from '../shared/constants.js';

function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, mcp-session-id, last-event-id');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, DELETE, OPTIONS');
}

export function registerMCPGatewayRoutes(app) {
  const manager = getGatewayManager();

  // Load config on startup
  manager.loadConfig().catch(err => {
    console.error('[MCP Gateway] Failed to load config:', err.message);
  });

  // ── Discovery: list available gateway servers with URLs ───────
  app.get('/protoclaw/mcp-gateway/servers', async (_req, res) => {
    setCORS(res);
    try {
      const servers = manager.getDiscoveryInfo(APP_ORIGIN);
      res.json({ servers });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Management: status ────────────────────────────────────────
  app.get('/protoclaw/mcp-gateway/status', async (_req, res) => {
    setCORS(res);
    try {
      res.json(manager.getStatus());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Management: get config ────────────────────────────────────
  app.get('/protoclaw/mcp-gateway/config', async (_req, res) => {
    setCORS(res);
    res.json(manager.getConfig());
  });

  // ── Management: save config ───────────────────────────────────
  app.put('/protoclaw/mcp-gateway/config', async (req, res) => {
    setCORS(res);
    try {
      const newConfig = req.body;
      if (!newConfig || typeof newConfig !== 'object' || !newConfig.servers) {
        return res.status(400).json({ error: 'Config must have a "servers" object' });
      }
      await manager.saveConfig(newConfig);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Management: restart a specific server ─────────────────────
  app.post('/protoclaw/mcp-gateway/:serverId/restart', async (req, res) => {
    setCORS(res);
    try {
      await manager.restartServer(req.params.serverId);
      res.json({ ok: true });
    } catch (err) {
      res.status(404).json({ error: err.message });
    }
  });

  // ── MCP Proxy: standard StreamableHTTP endpoint ───────────────
  // Handles all HTTP methods (POST for requests, GET for SSE, DELETE for session)
  // Must come after the specific routes above.
  app.all('/protoclaw/mcp-gateway/:serverId', async (req, res) => {
    setCORS(res);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const { serverId } = req.params;
    try {
      await manager.handleRequest(serverId, req, res);
    } catch (err) {
      if (!res.headersSent) {
        const status = err.message?.includes('Unknown gateway server') ? 404 : 500;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          error: {
            code: status === 404 ? -32001 : -32603,
            message: err.message,
          },
          id: null,
        }));
      }
    }
  });
}
