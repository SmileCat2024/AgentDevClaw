/**
 * OAuth Codex routes — REST API for OpenAI device-code login flow.
 *
 * Endpoints:
 *   POST   /protoclaw/oauth/codex/start              Start device-code login
 *   GET    /protoclaw/oauth/codex/status/:sessionId   Poll login session status
 *   GET    /protoclaw/oauth/codex/tokens/:providerName  Get token status
 *   DELETE /protoclaw/oauth/codex/tokens/:providerName  Clear tokens (logout)
 */

import {
  createLoginSession,
  runDeviceCodeLogin,
  getLoginSession,
  getTokenStatus,
  deleteTokens,
  refreshTokens,
  readTokensSync,
  DEFAULT_CLIENT_ID,
  DEFAULT_CODEX_BASE_URL,
} from '../oauth-codex.js';
import { getActiveProxyUrl } from '../shared/proxy-manager.js';

export function setupOAuthCodexRoutes(app, express) {

  // ── Start device-code login ──

  app.post('/protoclaw/oauth/codex/start', express.json(), async (req, res, next) => {
    try {
      const { providerName, clientId } = req.body || {};
      if (!providerName || typeof providerName !== 'string') {
        return res.status(400).json({ error: 'providerName is required' });
      }
      const cid = (typeof clientId === 'string' && clientId.trim()) || DEFAULT_CLIENT_ID;

      const sessionId = createLoginSession(providerName, cid);

      // Kick off background login flow
      runDeviceCodeLogin(sessionId, providerName, cid).catch((err) => {
        console.warn(`[OAuth/Codex] Background login error (session=${sessionId}):`, err);
      });

      res.json({
        sessionId,
        providerName,
        status: 'initiating',
        message: 'Device code request sent. Poll /protoclaw/oauth/codex/status/' + sessionId,
      });
    } catch (error) {
      next(error);
    }
  });

  // ── Poll login session status ──

  app.get('/protoclaw/oauth/codex/status/:sessionId', async (req, res, next) => {
    try {
      const { sessionId } = req.params;
      const sess = getLoginSession(sessionId);
      if (!sess) {
        return res.status(404).json({ error: 'Login session not found or expired' });
      }
      res.json(sess);
    } catch (error) {
      next(error);
    }
  });

  // ── Get token status ──

  app.get('/protoclaw/oauth/codex/tokens/:providerName', async (req, res, next) => {
    try {
      const { providerName } = req.params;
      const status = getTokenStatus(providerName);
      res.json(status);
    } catch (error) {
      next(error);
    }
  });

  // ── Delete tokens (logout) ──

  app.delete('/protoclaw/oauth/codex/tokens/:providerName', async (req, res, next) => {
    try {
      const { providerName } = req.params;
      deleteTokens(providerName);
      res.json({ ok: true, providerName, loggedIn: false });
    } catch (error) {
      next(error);
    }
  });

  // ── Force token refresh ──

  app.post('/protoclaw/oauth/codex/refresh/:providerName', express.json(), async (req, res, next) => {
    try {
      const { providerName } = req.params;
      const { clientId } = req.body || {};
      const tokens = readTokensSync(providerName);
      if (!tokens) {
        return res.status(404).json({ error: 'No stored tokens for this provider' });
      }
      const updated = await refreshTokens(providerName, tokens.refresh_token, clientId || tokens.clientId);
      res.json({
        ok: true,
        providerName,
        lastRefresh: updated.access_token ? new Date().toISOString() : null,
      });
    } catch (error) {
      res.status(400).json({ error: error.message || 'Token refresh failed' });
    }
  });

  // ── Get OAuth defaults (for frontend) ──

  app.get('/protoclaw/oauth/codex/defaults', async (_req, res) => {
    res.json({
      defaultClientId: DEFAULT_CLIENT_ID,
      defaultBaseUrl: DEFAULT_CODEX_BASE_URL,
      proxyConfigured: !!getActiveProxyUrl(),
    });
  });
}
