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
  setCredentialChangeListener,
  DEFAULT_CLIENT_ID,
  DEFAULT_CODEX_BASE_URL,
} from '../oauth-codex.js';
import { getActiveProxyUrl } from '../shared/proxy-manager.js';
import { openUrlInSystem } from '../shared/system-opener.js';
import { broadcastIPCToAllRuntimes } from '../shared/ipc.js';

export function setupOAuthCodexRoutes(app, express) {

  // 登录完成（新凭证族落盘）→ 广播 refresh-credentials：运行中 runtime 同
  // preset 重 resolve 换新实例（ADR-0028 修订）。旧凭证仍有效时没有 401 可
  // 触发反应式恢复，这是唯一的主动换新通道。
  setCredentialChangeListener(() => {
    broadcastIPCToAllRuntimes({ type: 'refresh-credentials' });
  });

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
        // Local callback server + authorize URL are ready in milliseconds;
        // the response carries authUrl as a manual fallback.
        const { authUrl } = await beginBrowserLogin(sessionId, providerName, cid);
        // The loopback callback only completes when the authorize URL is
        // opened on the machine running this server, so the server itself
        // opens the system default browser. The webview of the desktop
        // shell cannot pop system browser windows, and a browser-side
        // window.open fights popup blockers. Failure is non-fatal: the UI
        // falls back to the authUrl link.
        const openResult = await openUrlInSystem(authUrl);
        if (!openResult.opened) {
          console.warn(`[OAuth/Codex] Could not open the system default browser (${openResult.reason}) for session=${sessionId}; share authUrl manually`);
        }
        return res.json({
          sessionId,
          providerName,
          mode: 'browser',
          status: 'pending',
          authUrl,
          browserOpened: openResult.opened,
          ...(openResult.opened ? {} : { browserOpenReason: openResult.reason }),
          message: 'Browser authorization URL ready. Poll /protoclaw/oauth/codex/status/' + sessionId,
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
    const { providerName } = req.params;
    try {
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
      // 与 refreshTokensInBackground 的 relogin 清理保持同口径：
      // refresh_token 永久失效（400 + invalid_grant / refresh_token_*）后
      // 留着死 token 只会让后续 resolve 反复触发注定失败的刷新。
      if (error?.reloginRequired) {
        deleteTokens(providerName);
        console.warn(`[OAuth/Codex] Tokens cleared for "${providerName}" — re-login required`);
      }
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
