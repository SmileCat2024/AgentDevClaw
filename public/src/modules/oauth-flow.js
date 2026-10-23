/**
 * oauth-flow.js — OAuth 登录流程模块（从 model-settings.js 拆分）
 *
 * 包含：OAuth 登录区渲染、设备码轮询、provider 解析、登录状态刷新、OpenCode 模型列表辅助。
 * 依赖（全局）：escapeHtml, currentLanguage
 * 依赖（跨文件）：renderSettingsOverlay（model-settings.js）、saveSettingsPreset（model-settings.js）、
 *   OPENCODE_ZEN_BASE_URL / OPENCODE_GO_BASE_URL（model-settings.js）
 */

function checkOAuthProxy(isZh) {
  fetch('/protoclaw/oauth/codex/defaults')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (!data.proxyConfigured) {
        let display = document.getElementById('oauth-status-display');
        if (display) {
          display.innerHTML = '<div style="color:#e8a847;font-size:12px;padding:4px 0;">'
            + (isZh
              ? '⚠ 未检测到代理 (HTTPS_PROXY)。OpenAI 登录请求可能被地区限制拦截，请确保已设置环境变量并重启服务'
              : '⚠ No proxy (HTTPS_PROXY) detected. OpenAI login requests may be blocked by region restrictions. Ensure the env var is set and restart the server')
            + '</div>';
        }
      }
    })
    .catch(e => console.warn(e));
}

function renderOAuthLoginArea(preset, isZh) {
  let providerName = preset.providerName || '';
  return [
    '<div id="oauth-status-display" class="oauth-status-text" style="padding:2px 0;"></div>',
    '<div class="oauth-action-row">',
    '<button class="settings-btn settings-btn-primary" type="button" onclick="startOAuthLogin(\'browser\')">'
      + (isZh ? '浏览器授权登录' : 'Login in Browser') + '</button>',
    '<button class="settings-btn settings-btn-secondary" type="button" onclick="startOAuthLogin(\'device\')">'
      + (isZh ? '设备码登录' : 'Device Code Login') + '</button>',
    providerName
      ? '<button class="settings-btn settings-btn-secondary" type="button" onclick="logoutOAuth()">'
        + (isZh ? '登出' : 'Logout') + '</button>'
      : '<div style="font-size:11px;color:var(--text-secondary);">' + (isZh ? '预设尚未保存，点击登录时会自动保存' : 'Preset not saved yet — it will be saved automatically on login') + '</div>',
    '</div>',
  ].join('');
}

window.onProtocolChange = function() {
  let select = document.getElementById('settings-preset-provider');
  if (!select) return;
  let val = select.value;
  let apiKeySection = document.getElementById('api-key-section');
  let oauthSection = document.getElementById('oauth-section');
  let openCodeSection = document.getElementById('opencode-section');
  let baseUrlInput = document.getElementById('settings-preset-baseurl');
  let isZh = currentLanguage === 'zh';

  if (typeof window.onProviderChangeUpdateThinking === 'function') window.onProviderChangeUpdateThinking();

  if (val === 'openai-oauth') {
    if (apiKeySection) apiKeySection.style.display = 'none';
    if (oauthSection) oauthSection.style.display = '';
    if (openCodeSection) openCodeSection.style.display = 'none';
    // Auto-fill Codex base URL if empty or still default anthropic placeholder
    if (baseUrlInput && (!baseUrlInput.value || baseUrlInput.value.indexOf('bigmodel') >= 0)) {
      baseUrlInput.value = 'https://chatgpt.com/backend-api/codex';
    }
    // Auto-fill client_id default
    let cidInput = document.getElementById('settings-preset-clientid');
    if (cidInput && !cidInput.value) cidInput.value = 'app_EMoamEEZ73f0CkXaXp7hrann';
    // Suggest a preset name so auto-save on login doesn't fall back to "Preset N"
    let nameInput = document.getElementById('settings-preset-name');
    if (nameInput && !nameInput.value.trim()) nameInput.value = 'OpenAI Codex';
    // Check proxy status and warn if not configured
    checkOAuthProxy(isZh);
    // Load OAuth status
    refreshOAuthStatus();
  } else if (val === 'opencode') {
    if (apiKeySection) apiKeySection.style.display = '';
    if (oauthSection) oauthSection.style.display = 'none';
    if (openCodeSection) openCodeSection.style.display = '';
    if (baseUrlInput) {
      const tier = document.getElementById('settings-preset-opencode-tier')?.value;
      baseUrlInput.value = tier === 'go' ? OPENCODE_GO_BASE_URL : OPENCODE_ZEN_BASE_URL;
    }
  } else {
    if (apiKeySection) apiKeySection.style.display = '';
    if (oauthSection) oauthSection.style.display = 'none';
    if (openCodeSection) openCodeSection.style.display = 'none';
    // Clear Codex base URL if it was auto-filled
    if (baseUrlInput && baseUrlInput.value === 'https://chatgpt.com/backend-api/codex') {
      baseUrlInput.value = '';
    }
    // Clear an OpenCode gateway URL if it was auto-filled.
    if (baseUrlInput && (baseUrlInput.value === OPENCODE_ZEN_BASE_URL || baseUrlInput.value === OPENCODE_GO_BASE_URL)) {
      baseUrlInput.value = '';
    }
  }
  if (typeof window.syncBaseEndpointBadge === 'function') window.syncBaseEndpointBadge();
};

function getEditingProviderName() {
  let editing = window.ClawFW.settingsEditing;
  let presets = window.ClawFW.settingsData?.presets || [];
  if (editing === null) {
    return presets.find((preset) => preset.authType === 'oauth-codex' && preset.providerName)?.providerName || 'OpenAI Auth';
  }
  return presets[editing]?.providerName || '';
}

// ── OpenCode model helpers ─────────────────────────────────────

/**
 * Client-side mirror of server/zen-helpers.js resolveZenModelProtocol.
 * Zen and Go expose the same protocol surfaces.
 */
function resolveOpenCodeProtocolClient(modelId) {
  var id = (typeof modelId === 'string' ? modelId : '').trim().toLowerCase();
  if (!id) return { protocol: 'openai', apiSurface: 'chat' };
  if (id.startsWith('gpt-') || id.startsWith('grok-')) return { protocol: 'openai', apiSurface: 'responses' };
  if (id.startsWith('claude-')) return { protocol: 'anthropic', apiSurface: 'chat' };
  return { protocol: 'openai', apiSurface: 'chat' };
}

window._openCodeModelsCache = null;

window.onOpenCodeTierChange = function() {
  var tier = document.getElementById('settings-preset-opencode-tier')?.value;
  var baseUrlInput = document.getElementById('settings-preset-baseurl');
  if (baseUrlInput) baseUrlInput.value = tier === 'go' ? OPENCODE_GO_BASE_URL : OPENCODE_ZEN_BASE_URL;
  if (typeof window.syncBaseEndpointBadge === 'function') window.syncBaseEndpointBadge();
  var select = document.getElementById('settings-preset-opencode-model');
  if (select) select.innerHTML = '<option value="">' + (currentLanguage === 'zh' ? '— 点击加载模型列表 —' : '— Click Load Models —') + '</option>';
};

window.fetchOpenCodeModels = function() {
  var apiKeyInput = document.getElementById('settings-preset-apikey');
  var apiKey = apiKeyInput ? apiKeyInput.value.trim() : '';
  var tier = document.getElementById('settings-preset-opencode-tier')?.value === 'go' ? 'go' : 'zen';
  var isZh = currentLanguage === 'zh';
  var select = document.getElementById('settings-preset-opencode-model');
  if (!select) return;
  if (!apiKey) {
    select.innerHTML = '<option value="">' + (isZh ? '请先输入 API Key' : 'Enter API Key first') + '</option>';
    return;
  }
  select.innerHTML = '<option value="">' + (isZh ? '加载中...' : 'Loading...') + '</option>';
  select.disabled = true;
  fetch('/protoclaw/opencode/models', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey: apiKey, tier: tier }),
  })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      select.disabled = false;
      if (data.error) {
        select.innerHTML = '<option value="">' + escapeHtml(isZh ? '加载失败: ' + data.error : 'Failed: ' + data.error) + '</option>';
        return;
      }
      var models = Array.isArray(data.models) ? data.models : [];
      if (!models.length) {
        select.innerHTML = '<option value="">' + (isZh ? '无可用模型' : 'No models available') + '</option>';
        return;
      }
      var currentModel = document.getElementById('settings-preset-model');
      var currentVal = currentModel ? currentModel.value.trim() : '';
      var html = '<option value="">' + (isZh ? '— 选择模型 —' : '— Select model —') + '</option>';
      for (var i = 0; i < models.length; i++) {
        var m = models[i];
        var sel = (m.id === currentVal) ? ' selected' : '';
        html += '<option value="' + escapeHtml(m.id) + '"' + sel + '>'
          + escapeHtml(m.id)
          + ' (' + m.protocol + (m.apiSurface ? '/' + m.apiSurface : '') + ')'
          + '</option>';
      }
      select.innerHTML = html;
      window._openCodeModelsCache = models;
    })
    .catch(function() {
      select.disabled = false;
      select.innerHTML = '<option value="">' + escapeHtml(isZh ? '网络错误' : 'Network error') + '</option>';
    });
};

window.onOpenCodeModelSelect = function() {
  var select = document.getElementById('settings-preset-opencode-model');
  if (!select) return;
  var modelId = select.value;
  if (!modelId) return;
  var modelInput = document.getElementById('settings-preset-model');
  if (modelInput) modelInput.value = modelId;
  if (typeof window.syncBaseEndpointBadge === 'function') window.syncBaseEndpointBadge();
  var nameInput = document.getElementById('settings-preset-name');
  if (nameInput && !nameInput.value.trim()) {
    var tier = document.getElementById('settings-preset-opencode-tier')?.value === 'go' ? 'Go' : 'Zen';
    nameInput.value = 'OpenCode ' + tier + ' ' + modelId;
  }
};

// The OAuth token is stored server-side under the provider name assigned when
// the preset is saved. Login is only consistent if the saved provider matches
// the current form (auth mode, baseUrl, clientId), so detect mismatches.
function oauthProviderNeedsSave() {
  let idx = window.ClawFW.settingsEditing;
  if (idx === null) return false;
  let saved = (window.ClawFW.settingsData?.presets || [])[idx];
  if (!saved) return false;
  if (!saved.providerName || saved.authType !== 'oauth-codex') return true;
  let baseUrlInput = document.getElementById('settings-preset-baseurl');
  let cidInput = document.getElementById('settings-preset-clientid');
  if (baseUrlInput && (baseUrlInput.value || '').trim() !== (saved.baseUrl || '')) return true;
  if (cidInput && (cidInput.value || '').trim() !== (saved.clientId || '')) return true;
  return false;
}

window.startOAuthLogin = async function(mode) {
  let isZh = currentLanguage === 'zh';
  let loginMode = mode === 'device' ? 'device' : 'browser';
  let idx = window.ClawFW.settingsEditing;

  if (idx === null) {
    // 连接视图（账号列表页）：每次添加账号都让服务端生成新槽位（'__new__'），
    // 不再复用既有 preset 的 providerName —— 那会把新账号 token 写进旧槽位。
    fetch('/protoclaw/oauth/codex/defaults').then((response) => response.json()).then((defaults) => {
      const launchLogin = () => fetch('/protoclaw/oauth/codex/start', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerName: '__new__', clientId: defaults.defaultClientId, mode: loginMode }),
      }).then((response) => response.json()).then((data) => {
        // Browser mode: the server opens the system default browser itself
        // (the desktop webview cannot pop one); just poll for completion.
        pollOAuthLogin(data.sessionId);
      }).catch((error) => {
        const display = document.getElementById('oauth-status-display');
        if (display) display.textContent = error.message || String(error);
      });
      launchLogin();
    }).catch((error) => {
      const display = document.getElementById('oauth-status-display');
      if (display) display.textContent = error.message || String(error);
    });
    return;
  }

  // 编辑表单路径（存量单 preset 语义）：登录写进该 preset 声明的 providerName
  let providerName = getEditingProviderName();

  if (oauthProviderNeedsSave()) {
    let display = document.getElementById('oauth-status-display');
    if (display) display.innerHTML = '<span class="oauth-status-text" style="color:var(--text-secondary);">' + (isZh ? '正在保存预设...' : 'Saving preset...') + '</span>';
    // Auto-save (keeping the edit form open) so the server assigns the
    // providerName the login token will be stored under.
    providerName = await saveSettingsPreset(idx, { keepEditing: true });
    if (!providerName) return;
  }

  let cidInput = document.getElementById('settings-preset-clientid');
  let clientId = cidInput ? cidInput.value.trim() : '';

  let display = document.getElementById('oauth-status-display');

  // Browser mode is opened by the server in the system default browser —
  // no client-side window.open (blocked inside the desktop webview, and
  // popup blockers complicate the plain browser case).
  if (loginMode === 'browser') {
    if (display) display.innerHTML = '<span class="oauth-status-text" style="color:var(--text-secondary);">' + (isZh ? '正在打开系统默认浏览器...' : 'Opening the system default browser...') + '</span>';
  } else {
    if (display) display.innerHTML = '<span class="oauth-status-text" style="color:var(--text-secondary);">' + (isZh ? '正在请求设备码...' : 'Requesting device code...') + '</span>';
  }

  fetch('/protoclaw/oauth/codex/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ providerName: providerName, clientId: clientId, mode: loginMode }),
  })
    .then(async function(r) {
      let data = await r.json().catch(function() { return {}; });
      if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
      return data;
    })
    .then(function(data) {
      if (data.error) throw new Error(data.error);
      pollOAuthLogin(data.sessionId);
    })
    .catch(function(err) {
      if (display) display.innerHTML = '<span class="oauth-status-text" style="color:#e57373;">' + escapeHtml(err.message) + '</span>';
    });
};

var _oauthPollTimer = null;

function pollOAuthLogin(sessionId) {
  if (_oauthPollTimer) clearInterval(_oauthPollTimer);
  let isZh = currentLanguage === 'zh';
  // 状态区每次渲染时重新查找：期间的整体重渲染（目录刷新等）不会让轮询写入失联节点
  let display = function() { return document.getElementById('oauth-status-display'); };

  let renderPending = function(sess) {
    let el = display();
    if (!el) return;
    let html;
    if (sess.mode === 'browser') {
      html = sess.authUrl
        ? '<div class="oauth-status-text" style="color:var(--text-secondary);">'
          + (isZh ? '等待浏览器完成授权…若未自动打开，' : 'Waiting for browser authorization… if it did not open, ')
          + '<a href="' + escapeHtml(sess.authUrl) + '" target="_blank">' + (isZh ? '点击此处打开' : 'open it here') + '</a>'
          + (isZh ? '（需在运行本服务的电脑上打开）' : ' (must be opened on the machine running this server)')
          + '</div>'
        : '<span class="oauth-status-text" style="color:var(--text-secondary);">' + (isZh ? '正在打开系统默认浏览器...' : 'Opening the system default browser...') + '</span>';
    } else {
      html = sess.userCode
        ? '<div class="oauth-code-row">'
          + '<div class="oauth-user-code">' + escapeHtml(sess.userCode) + '</div>'
          + '<button class="settings-btn settings-btn-secondary oauth-copy-btn" type="button" data-copy-code="' + escapeHtml(sess.userCode) + '" onclick="copyOAuthUserCode(this)" title="' + (isZh ? '复制设备码' : 'Copy device code') + '">' + (isZh ? '复制' : 'Copy') + '</button>'
          + '</div>'
          + '<div class="oauth-status-text" style="color:var(--text-secondary);">' + (isZh ? '在任意设备的浏览器打开 ' : 'Open ') + '<a href="' + escapeHtml(sess.verificationUrl) + '" target="_blank">' + escapeHtml(sess.verificationUrl) + '</a>' + (isZh ? ' 并输入上方代码，完成授权后自动继续（本机无需打开浏览器）' : ' on any device and enter the code; login continues automatically after approval') + '</div>'
        : '<span class="oauth-status-text" style="color:var(--text-secondary);">' + (isZh ? '正在请求设备码...' : 'Requesting device code...') + '</span>';
    }
    // Skip unchanged renders so the copy button keeps its "copied" feedback
    if (el && el.innerHTML !== html) el.innerHTML = html;
  };

  let poll = function() {
    fetch('/protoclaw/oauth/codex/status/' + sessionId)
      .then(function(r) {
        if (!r.ok) throw new Error('Session not found');
        return r.json();
      })
      .then(function(sess) {
        if (sess.status === 'pending' || sess.status === 'initiating') {
          renderPending(sess);
        } else if (sess.status === 'approved') {
          if (_oauthPollTimer) { clearInterval(_oauthPollTimer); _oauthPollTimer = null; }
          let el = display();
          if (el) el.innerHTML = '<span class="oauth-status-text" style="color:#81c784;">✓ ' + (isZh ? '登录成功！令牌已保存' : 'Login successful! Token saved.') + '</span>';
          refreshModelCatalog('codex');
          renderCodexAccountsList();
        } else if (sess.status === 'expired') {
          if (_oauthPollTimer) { clearInterval(_oauthPollTimer); _oauthPollTimer = null; }
          let el = display();
          if (el) el.innerHTML = '<span class="oauth-status-text" style="color:#e57373;">' + (isZh ? '登录已过期，请重试' : 'Login expired. Please try again.') + '</span>';
        } else if (sess.status === 'error') {
          if (_oauthPollTimer) { clearInterval(_oauthPollTimer); _oauthPollTimer = null; }
          let el = display();
          if (el) el.innerHTML = '<span class="oauth-status-text" style="color:#e57373;">' + escapeHtml(sess.errorMessage || 'Login failed') + '</span>';
        }
      })
      .catch(function(err) {
        // A status read can fail transiently while the background OAuth flow is
        // still healthy. Keep polling instead of abandoning an approved login.
        let el = display();
        if (el) {
          el.innerHTML = '<span class="oauth-status-text" style="color:#ffb74d;">'
            + escapeHtml(isZh ? '状态读取失败，正在重试…' : 'Status check failed, retrying…')
            + '<br><small>' + escapeHtml(err && err.message ? err.message : String(err)) + '</small></span>';
        }
      });
  };

  poll();
  _oauthPollTimer = setInterval(poll, 3000);
}

window.copyOAuthUserCode = async function(btn) {
  let code = btn?.dataset?.copyCode || '';
  if (!code) return;
  let isZh = currentLanguage === 'zh';
  let ok = false;
  if (navigator.clipboard && window.isSecureContext) {
    try { await navigator.clipboard.writeText(code); ok = true; } catch (e) { ok = false; }
  }
  if (!ok) {
    // Fallback for non-secure contexts (e.g. accessing the UI via a LAN IP)
    try {
      let ta = document.createElement('textarea');
      ta.value = code;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      ok = document.execCommand('copy');
      document.body.removeChild(ta);
    } catch (e) { ok = false; }
  }
  let label = btn.textContent;
  btn.textContent = ok ? (isZh ? '已复制' : 'Copied') : (isZh ? '复制失败' : 'Copy failed');
  if (btn._copyTimer) clearTimeout(btn._copyTimer);
  btn._copyTimer = setTimeout(function() { btn.textContent = label; }, 1500);
};

window.logoutOAuth = function() {
  let providerName = getEditingProviderName();
  if (!providerName) return;
  fetch('/protoclaw/oauth/codex/tokens/' + encodeURIComponent(providerName), { method: 'DELETE' })
    .then(function() { refreshOAuthStatus(); });
};

function refreshOAuthStatus() {
  // While a device-code login poll is running, it owns the status display
  if (_oauthPollTimer) return;
  // Codex 连接视图（账号列表页）：状态呈现完全由账号列表承载；编辑表单路径
  // （settingsEditing 非 null）保持单 preset 的状态查询语义
  if (window.ClawFW.codexConnectionView) {
    renderCodexAccountsList();
    return;
  }
  let providerName = getEditingProviderName();
  if (!providerName) return;
  let isZh = currentLanguage === 'zh';

  fetch('/protoclaw/oauth/codex/tokens/' + encodeURIComponent(providerName))
    .then(function(r) { return r.json(); })
    .then(function(status) {
      let display = document.getElementById('oauth-status-display');
      if (!display) return;
      if (status.loggedIn) {
        let expiryStr = status.expiresAt ? new Date(status.expiresAt).toLocaleString() : '';
        let color = status.isExpiring ? '#ffb74d' : '#81c784';
        let icon = status.isExpiring ? '⚠' : '✓';
        let label = status.isExpiring ? (isZh ? '即将过期' : 'Expiring soon') : (isZh ? '已登录' : 'Logged in');
        display.innerHTML = '<span class="oauth-status-text" style="color:' + color + ';">' + icon + ' ' + label
          + (expiryStr ? ' · ' + (isZh ? '过期: ' : 'Expires: ') + escapeHtml(expiryStr) : '') + '</span>';
      } else {
        display.innerHTML = '<span class="oauth-status-text" style="color:var(--text-secondary);">' + (isZh ? '未登录' : 'Not logged in') + '</span>';
      }
    })
    .catch(function() {
      let display = document.getElementById('oauth-status-display');
      if (display) display.innerHTML = '<span class="oauth-status-text" style="color:var(--text-secondary);">' + (isZh ? '未登录' : 'Not logged in') + '</span>';
    });
}

// ── Codex multi-account list (connection view) ─────────────────────
//
// 账号行复用 settings-preset-card 配方；行操作（设为当前/重命名/登出）经
// data-provider 寻址，全局切换由服务端 activate 端点 + refresh-credentials
// 广播完成（无客户端热重载逻辑）。

function renderCodexAccountsList() {
  let container = document.getElementById('codex-accounts-list');
  if (!container) return;
  let isZh = currentLanguage === 'zh';
  container.innerHTML = '<div class="oauth-status-text" style="color:var(--text-secondary);">' + (isZh ? '正在加载账号…' : 'Loading accounts…') + '</div>';
  fetch('/protoclaw/oauth/codex/accounts')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      let el = document.getElementById('codex-accounts-list');
      if (!el) return;
      let accounts = Array.isArray(data.accounts) ? data.accounts : [];
      if (!accounts.length) {
        el.innerHTML = '<div class="oauth-status-text" style="color:var(--text-secondary);">' + (isZh ? '尚无账号，点击上方按钮添加' : 'No accounts yet; use the buttons above to add one') + '</div>';
        return;
      }
      el.innerHTML = accounts.map(function(a) { return codexAccountRowHtml(a, isZh); }).join('');
    })
    .catch(function() {
      let el = document.getElementById('codex-accounts-list');
      if (el) el.innerHTML = '<div class="oauth-status-text" style="color:#e57373;">' + (isZh ? '账号列表加载失败' : 'Failed to load accounts') + '</div>';
    });
}

function codexAccountRowHtml(a, isZh) {
  let status;
  if (!a.hasToken) {
    status = { color: 'var(--text-secondary)', icon: '○', label: isZh ? '未登录' : 'Not logged in' };
  } else if (a.status && a.status.loggedIn) {
    status = a.status.isExpiring
      ? { color: '#ffb74d', icon: '⚠', label: isZh ? '即将过期' : 'Expiring soon' }
      : { color: '#81c784', icon: '✓', label: isZh ? '已登录' : 'Logged in' };
  } else {
    status = { color: '#e57373', icon: '✕', label: isZh ? '已过期' : 'Expired' };
  }
  let expiry = a.status && a.status.expiresAt ? new Date(a.status.expiresAt).toLocaleString() : '';
  let providerAttr = escapeHtml(a.providerName);
  let actions = ''
    + (a.hasToken && !a.active
      ? '<button class="settings-btn settings-btn-secondary" type="button" data-provider="' + providerAttr + '" onclick="activateCodexAccountBtn(this)">' + (isZh ? '设为当前' : 'Set Active') + '</button>'
      : '')
    + '<button class="settings-btn settings-btn-secondary" type="button" data-provider="' + providerAttr + '" data-name="' + escapeHtml(a.displayName || '') + '" onclick="renameCodexAccountBtn(this)">' + (isZh ? '重命名' : 'Rename') + '</button>'
    + '<button class="settings-btn settings-btn-secondary settings-btn-quiet" type="button" data-provider="' + providerAttr + '" onclick="logoutCodexAccountBtn(this)">' + (isZh ? '登出' : 'Logout') + '</button>';
  return '<div class="settings-preset-card oauth-account-row' + (a.active ? ' active' : '') + '">'
    + '<div class="settings-preset-dot"></div>'
    + '<div class="settings-preset-info">'
    + '<div class="settings-preset-name">' + escapeHtml(a.displayName || a.providerName)
    + (a.active ? ' <span class="preset-tag">' + (isZh ? '当前' : 'Active') + '</span>' : '') + '</div>'
    + '<div class="settings-preset-detail"><span style="color:' + status.color + ';">' + status.icon + ' ' + status.label + '</span>'
    + (expiry ? ' · ' + (isZh ? '过期: ' : 'Expires: ') + escapeHtml(expiry) : '') + '</div>'
    + '</div>'
    + '<div class="settings-preset-actions">' + actions + '</div>'
    + '</div>';
}

window.activateCodexAccountBtn = function(btn) {
  let providerName = btn?.dataset?.provider;
  if (!providerName) return;
  let isZh = currentLanguage === 'zh';
  fetch('/protoclaw/oauth/codex/accounts/' + encodeURIComponent(providerName) + '/activate', { method: 'POST' })
    .then(async function(r) {
      let data = await r.json().catch(function() { return {}; });
      if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
      return data;
    })
    .then(function() {
      // 全局切换：目录按新账号重拉；运行中会话由服务端广播 refresh-credentials 自然重 resolve
      renderCodexAccountsList();
      refreshModelCatalog('codex');
    })
    .catch(function(err) {
      alert((isZh ? '切换失败: ' : 'Switch failed: ') + (err?.message || err));
    });
};

window.renameCodexAccountBtn = function(btn) {
  let providerName = btn?.dataset?.provider;
  if (!providerName) return;
  let isZh = currentLanguage === 'zh';
  let next = prompt(isZh ? '账号显示名' : 'Account display name', btn?.dataset?.name || '');
  if (next === null) return;
  let trimmed = next.trim();
  if (!trimmed) return;
  fetch('/protoclaw/oauth/codex/accounts/' + encodeURIComponent(providerName), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName: trimmed }),
  })
    .then(async function(r) {
      if (!r.ok) {
        let data = await r.json().catch(function() { return {}; });
        throw new Error(data.error || ('HTTP ' + r.status));
      }
      renderCodexAccountsList();
    })
    .catch(function(err) {
      alert((isZh ? '重命名失败: ' : 'Rename failed: ') + (err?.message || err));
      renderCodexAccountsList();
    });
};

window.logoutCodexAccountBtn = function(btn) {
  let providerName = btn?.dataset?.provider;
  if (!providerName) return;
  let isZh = currentLanguage === 'zh';
  fetch('/protoclaw/oauth/codex/accounts/' + encodeURIComponent(providerName), { method: 'DELETE' })
    .then(function() {
      // 登出后 active 自动回退到下一个有 token 的账号（服务端），目录随之重拉
      renderCodexAccountsList();
      refreshModelCatalog('codex');
    })
    .catch(function(err) {
      alert((isZh ? '登出失败: ' : 'Logout failed: ') + (err?.message || err));
    });
};
