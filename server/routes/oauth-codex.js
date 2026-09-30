/**
 * OAuth Codex routes — REST API for OpenAI Codex login flows.
 *
 * Endpoints:
 *   POST   /protoclaw/oauth/codex/start              Start login (mode: browser | device)
 *   GET    /protoclaw/oauth/codex/status/:sessionId   Poll login session status
 *   GET    /protoclaw/oauth/codex/tokens/:providerName  Get token status
 *   DELETE /protoclaw/oauth/codex/tokens/:providerName  Clear tokens (logout)
 */

import {
  createLoginSession,
  runDeviceCodeLogin,
  beginBrowserLogin,
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

  // ── Start login (browser PKCE or device code) ──

  app.post('/protoclaw/oauth/codex/start', express.json(), async (req, res, next) => {
    try {
      const { providerName, clientId, mode } = req.body || {};
      if (!providerName || typeof providerName !== 'string') {
        return res.status(400).json({ error: 'providerName is required' });
      }
      const cid = (typeof clientId === 'string' && clientId.trim()) || DEFAULT_CLIENT_ID;
      const loginMode = mode === 'device' ? 'device' : 'browser';

      const sessionId = createLoginSession(providerName, cid);

      if (loginMode === 'browser') {
        // Local callback server + authorize URL are ready in milliseconds; the
        // response carries authUrl so the frontend can open the browser tab
        // inside the user-gesture call stack.
        const { authUrl } = await beginBrowserLogin(sessionId, providerName, cid);
        return res.json({
          sessionId,
          providerName,
          mode: 'browser',
          status: 'pending',
          authUrl,
          message: 'Browser authorization URL ready. Open authUrl and poll /protoclaw/oauth/codex/status/' + sessionId,
        });
      }

      runDeviceCodeLogin(sessionId, providerName, cid).catch((err) => {
        console.warn(`[OAuth/Codex] Background login error (session=${sessionId}):`, err);
      });

      res.json({
        sessionId,
        providerName,
        mode: 'device',
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
