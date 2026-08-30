(() => {
  const nativeFetch = window.fetch.bind(window);
  let authState = { enabled: false, configured: false, authenticated: true };
  let overlay = null;
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  window.__clawAuthReady = ready;

  function appUrl(pathname) {
    return typeof window.__PROTOCLAW_APP_URL__ === 'function'
      ? window.__PROTOCLAW_APP_URL__(pathname)
      : pathname;
  }

  function isAuthPath(input) {
    const raw = typeof input === 'string' ? input : input?.url || '';
    try {
      return new URL(raw, window.location.href).pathname.startsWith('/protoclaw/auth/');
    } catch {
      return false;
    }
  }

  // 远程命名空间请求（/api/agents/remote:<connId>:… /…）的 401 来自远程实例
  // 的访问保护，与本机会话无关：输入本机密码解决不了，弹登录框只会误导。
  // 这类失败由调用方按业务错误呈现（如消息发送失败的 toast）。
  function isRemoteNamespaceRequest(input) {
    const raw = typeof input === 'string' ? input : input?.url || '';
    try {
      const { pathname } = new URL(raw, window.location.href);
      if (!pathname.startsWith('/api/agents/')) return false;
      return decodeURIComponent(pathname.split('/')[3] || '').startsWith('remote:');
    } catch {
      return false;
    }
  }

  function text(zh, en) {
    return (localStorage.getItem('agentdev-language') || 'zh') === 'zh' ? zh : en;
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[char]);
  }

  function removeOverlay() {
    overlay?.remove();
    overlay = null;
  }

  function showLogin(error = '') {
    if (!authState.enabled || authState.authenticated) return;
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'claw-auth-overlay';
      overlay.innerHTML = `
        <div class="claw-auth-card">
          <div class="claw-auth-brand-mark" aria-hidden="true">A</div>
          <div class="claw-auth-title">AgentDevClaw</div>
          <div class="claw-auth-subtitle">${text('访问保护', 'Access protection')}</div>
          <div class="claw-auth-prompt">${text('请输入密码以继续使用工作台', 'Enter the password to continue to the workbench')}</div>
          <form id="claw-auth-form" novalidate>
            <label class="claw-auth-label" for="claw-auth-password">${text('密码', 'Password')}</label>
            <input id="claw-auth-password" type="password" autocomplete="current-password" autofocus
              placeholder="${text('请输入访问密码', 'Enter access password')}">
            <div id="claw-auth-error" class="claw-auth-error" role="alert"></div>
            <button class="settings-btn settings-btn-primary" type="submit">${text('登录工作台', 'Sign in')}</button>
          </form>
        </div>`;
      document.body.appendChild(overlay);
      overlay.querySelector('#claw-auth-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        const passwordInput = overlay.querySelector('#claw-auth-password');
        const errorEl = overlay.querySelector('#claw-auth-error');
        const button = overlay.querySelector('button');
        button.disabled = true;
        errorEl.textContent = '';
        try {
          const response = await nativeFetch(appUrl('/protoclaw/auth/login'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: passwordInput.value }),
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(data.error || text('登录失败', 'Sign-in failed'));
          authState.authenticated = true;
          removeOverlay();
          resolveReady(authState);
          window.dispatchEvent(new CustomEvent('claw-authenticated'));
        } catch (error) {
          errorEl.textContent = error.message || text('登录失败', 'Sign-in failed');
          passwordInput.select();
          button.disabled = false;
        }
      });
    }
    const errorEl = overlay.querySelector('#claw-auth-error');
    if (errorEl && error) errorEl.textContent = error;
    overlay.querySelector('#claw-auth-password')?.focus();
  }

  function handleUnauthorized(input) {
    if (isAuthPath(input) || isRemoteNamespaceRequest(input)) return;
    authState.authenticated = false;
    showLogin();
  }

  function ensureAuthSettingsHost() {
    let host = document.getElementById('auth-settings-overlay-host');
    if (!host) {
      host = document.createElement('div');
      host.id = 'auth-settings-overlay-host';
      document.body.appendChild(host);
    }
    return host;
  }

  function closeAuthSettings() {
    const host = document.getElementById('auth-settings-overlay-host');
    if (host) host.innerHTML = '';
  }

  function renderAuthSettings(config) {
    const isZh = (localStorage.getItem('agentdev-language') || 'zh') === 'zh';
    const auth = config || { enabled: false, configured: false };
    const host = ensureAuthSettingsHost();
    host.innerHTML = [
      '<div class="feature-detail-overlay">',
      '<div class="feature-detail-window auth-settings-window">',
      '<div class="feature-detail-head">',
      '<div>',
      '<div class="feature-detail-title">' + (isZh ? '访问保护' : 'Access protection') + '</div>',
      '<div class="feature-detail-subtitle">' + (isZh ? '配置此 Claw 的单密码访问保护' : 'Configure single-password access protection for this Claw') + '</div>',
      '</div>',
      '<button class="feature-detail-close" type="button" title="' + (isZh ? '关闭' : 'Close') + '" onclick="closeAuthSettings()">×</button>',
      '</div>',
      '<div class="settings-tab-content auth-settings-content">',
      '<div class="settings-section">',
      '<div class="settings-auth-warning">' + text(
        '开启后，访问此 Claw 的浏览器需要输入密码。密码只保存在服务端的加密哈希中。公网部署仍建议使用 HTTPS。',
        'When enabled, browsers must enter a password to access this Claw. Only a password hash is stored on the server. HTTPS is still recommended for public deployments.') + '</div>',
      '<label class="settings-checkbox auth-settings-checkbox">',
      '<input type="checkbox" id="settings-auth-enabled" ' + (auth.enabled ? 'checked' : '') + '>',
      '<span>' + (isZh ? '开启访问保护' : 'Enable access protection') + '</span>',
      '</label>',
      '<div class="settings-field">',
      '<label for="settings-auth-password">' + (auth.configured ? (isZh ? '修改密码（留空保持不变）' : 'Change password (leave blank to keep)') : (isZh ? '设置密码' : 'Set password')) + '</label>',
      '<input class="settings-input" id="settings-auth-password" type="password" autocomplete="new-password" placeholder="' + (isZh ? '至少 8 个字符' : 'At least 8 characters') + '">',
      '</div>',
      '<div class="settings-auth-status">' + (auth.enabled ? (isZh ? '当前状态：已开启' : 'Status: enabled') : (isZh ? '当前状态：未开启' : 'Status: disabled')) + '</div>',
      '</div>',
      '</div>',
      '<div class="settings-footer">',
      '<div class="settings-actions">',
      auth.enabled ? '<button class="settings-btn settings-btn-secondary" type="button" onclick="ClawAuth.logout()">' + (isZh ? '退出登录' : 'Sign out') + '</button>' : '',
      '<button class="settings-btn settings-btn-secondary" type="button" onclick="closeAuthSettings()">' + (isZh ? '取消' : 'Cancel') + '</button>',
      '<button class="settings-btn settings-btn-primary" type="button" id="auth-settings-save" onclick="saveAuthSettings()">' + (isZh ? '保存保护设置' : 'Save protection settings') + '</button>',
      '</div>',
      '</div>',
      '</div>',
      '</div>',
    ].join('');
  }

  async function openAuthSettings() {
    try {
      const response = await fetch(appUrl('/protoclaw/auth/config'), { cache: 'no-store' });
      const config = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(config.error || text('读取保护设置失败', 'Failed to load protection settings'));
      renderAuthSettings(config);
    } catch (error) {
      window.alert(error.message || text('读取保护设置失败', 'Failed to load protection settings'));
    }
  }

  async function saveAuthSettings() {
    const enabled = document.getElementById('settings-auth-enabled')?.checked === true;
    const password = document.getElementById('settings-auth-password')?.value || '';
    const button = document.getElementById('auth-settings-save');
    if (button) button.disabled = true;
    try {
      const response = await fetch(appUrl('/protoclaw/auth/config'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled, password }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || text('保存保护设置失败', 'Failed to save protection settings'));
      authState.enabled = data.enabled === true;
      authState.configured = data.configured === true;
      authState.authenticated = true;
      closeAuthSettings();
      window.alert(text('访问保护设置已保存。', 'Access protection settings saved.'));
    } catch (error) {
      window.alert(error.message || text('保存失败', 'Save failed'));
      if (button) button.disabled = false;
    }
  }

  window.closeAuthSettings = closeAuthSettings;
  window.openAuthSettings = openAuthSettings;
  window.saveAuthSettings = saveAuthSettings;

  window.fetch = function(input, init) {
    return nativeFetch(input, init).then((response) => {
      if (response.status === 401) handleUnauthorized(input);
      return response;
    });
  };

  async function initialize() {
    try {
      const response = await nativeFetch(appUrl('/protoclaw/auth/status'), { cache: 'no-store' });
      const data = await response.json().catch(() => ({}));
      authState = {
        enabled: data.enabled === true,
        configured: data.configured === true,
        authenticated: data.authenticated !== false,
      };
      if (authState.enabled && !authState.authenticated) {
        showLogin();
        return;
      }
      resolveReady(authState);
    } catch (error) {
      rejectReady(error);
      console.warn('[auth] failed to read authentication status:', error);
    }
  }

  window.ClawAuth = {
    getState: () => ({ ...authState }),
    getConfig: async () => {
      const response = await fetch(appUrl('/protoclaw/auth/config'), { cache: 'no-store' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || text('读取保护设置失败', 'Failed to load protection settings'));
      return data;
    },
    saveConfig: async ({ enabled, password = '' }) => {
      const response = await fetch(appUrl('/protoclaw/auth/config'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: enabled === true, password }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || text('保存保护设置失败', 'Failed to save protection settings'));
      authState.enabled = data.enabled === true;
      authState.configured = data.configured === true;
      authState.authenticated = true;
      return data;
    },
    logout: async () => {
      await fetch(appUrl('/protoclaw/auth/logout'), { method: 'POST' });
      window.location.reload();
    },
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
  else initialize();
})();
