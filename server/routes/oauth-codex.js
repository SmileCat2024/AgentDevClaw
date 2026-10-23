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
import {
  listCodexAccounts,
  registerCodexAccount,
  generateCodexSlotName,
  activateCodexAccount,
  renameCodexAccount,
  removeCodexAccount,
} from '../codex-accounts.js';

export function setupOAuthCodexRoutes(app, express) {

  // 登录完成（新凭证族落盘）→ 登记账号簿 + 广播 refresh-credentials：运行中
  // runtime 同 preset 重 resolve 换新实例（ADR-0028 修订）。旧凭证仍有效时没
  // 有 401 可触发反应式恢复，这是唯一的主动换新通道。登记失败只告警——token
  // 已落盘，账号列表可在任何后续写操作时补齐，不应破坏已完成的登录。
  setCredentialChangeListener((providerName) => {
    if (providerName) {
      try {
        registerCodexAccount(providerName);
      } catch (err) {
        console.warn(`[OAuth/Codex] Failed to register account "${providerName}" in the account book:`, err?.message || err);
      }
    }
    broadcastIPCToAllRuntimes({ type: 'refresh-credentials' });
  });

  // ── Start login (browser PKCE or device code) ──

  app.post('/protoclaw/oauth/codex/start', express.json(), async (req, res, next) => {
    try {
      // 多账号：providerName 传 '__new__'（或省略）时由账号簿生成未占用槽位名，
      // 响应与登录会话携带实际槽位；显式传名用于既有登录/重登指定槽位。
      const requested = typeof req.body?.providerName === 'string' ? req.body.providerName.trim() : '';
      const providerName = (!requested || requested === '__new__')
        ? generateCodexSlotName()
        : requested;
      if (!providerName) {
        return res.status(400).json({ error: 'providerName is required' });
      }
      const { clientId, mode } = req.body || {};
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

  // ── Multi-account book (codex-accounts.js) ──
  //
  // 账号 = token 槽位 + 列表元数据；当前账号（activeProvider）全局生效，
  // 所有 codex preset 经 resolver 走当前账号的 token。

  app.get('/protoclaw/oauth/codex/accounts', (_req, res, next) => {
    try {
      const state = listCodexAccounts();
      const accounts = state.accounts.map((a) => ({
        providerName: a.providerName,
        displayName: a.displayName,
        hasToken: a.hasToken,
        active: state.activeProvider !== '' && a.providerName === state.activeProvider,
        status: getTokenStatus(a.providerName),
      }));
      res.json({ accounts, activeProvider: state.activeProvider });
    } catch (error) { next(error); }
  });

  app.put('/protoclaw/oauth/codex/accounts/:providerName', express.json(), async (req, res, next) => {
    try {
      const { providerName } = req.params;
      const result = renameCodexAccount(providerName, req.body?.displayName);
      if (!result.ok) {
        return res.status(result.error === 'not_found' ? 404 : 400).json({ error: result.error });
      }
      res.json({ ok: true, providerName, displayName: req.body?.displayName });
    } catch (error) { next(error); }
  });

  app.post('/protoclaw/oauth/codex/accounts/:providerName/activate', async (req, res, next) => {
    try {
      const { providerName } = req.params;
      const result = activateCodexAccount(providerName);
      if (!result.ok) {
        return res.status(result.error === 'not_logged_in' ? 409 : 400).json({ error: result.error });
      }
      // 切换当前账号 = 全局换 token 来源：运行中会话经既有 refresh-credentials
      // 广播重 resolve（ADR-0028 通道复用，无新增热重载）；激活未变化不打扰。
      if (result.previous !== providerName) {
        broadcastIPCToAllRuntimes({ type: 'refresh-credentials' });
      }
      res.json({ ok: true, providerName, previous: result.previous || null });
    } catch (error) { next(error); }
  });

  app.delete('/protoclaw/oauth/codex/accounts/:providerName', async (req, res, next) => {
    try {
      const { providerName } = req.params;
      const before = listCodexAccounts();
      deleteTokens(providerName);
      const state = removeCodexAccount(providerName);
      // 当前账号被登出 → 回退账号接管；运行中会话重 resolve 到新账号
      if (before.activeProvider === providerName && state.activeProvider !== '') {
        broadcastIPCToAllRuntimes({ type: 'refresh-credentials' });
      }
      res.json({ ok: true, providerName, accounts: state.accounts, activeProvider: state.activeProvider });
    } catch (error) { next(error); }
  });
}
