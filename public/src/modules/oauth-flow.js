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
              ? '⚠ 未检测到代理 (HTTPS_PROXY)。OpenAI 设备码请求可能被地区限制拦截，请确保已设置环境变量并重启服务'
              : '⚠ No proxy (HTTPS_PROXY) detected. OpenAI device-code requests may be blocked by region restrictions. Ensure the env var is set and restart the server')
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
    '<button class="settings-btn settings-btn-primary" type="button" onclick="startOAuthLogin()">'
      + (isZh ? '登录 OpenAI' : 'Login with OpenAI') + '</button>',
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
};

function getEditingProviderName() {
  let editing = window.ClawFW.settingsEditing;
  if (editing === null) return '';
  let presets = window.ClawFW.settingsData?.presets || [];
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

window.startOAuthLogin = async function() {
  let isZh = currentLanguage === 'zh';
  let idx = window.ClawFW.settingsEditing;
  if (idx === null) return;
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
  if (display) display.innerHTML = '<span class="oauth-status-text" style="color:var(--text-secondary);">' + (isZh ? '正在请求设备码...' : 'Requesting device code...') + '</span>';

  fetch('/protoclaw/oauth/codex/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ providerName: providerName, clientId: clientId }),
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
  let display = document.getElementById('oauth-status-display');

  let renderPending = function(sess) {
    let html = sess.userCode
      ? '<div class="oauth-code-row">'
        + '<div class="oauth-user-code">' + escapeHtml(sess.userCode) + '</div>'
        + '<button class="settings-btn settings-btn-secondary oauth-copy-btn" type="button" data-copy-code="' + escapeHtml(sess.userCode) + '" onclick="copyOAuthUserCode(this)" title="' + (isZh ? '复制设备码' : 'Copy device code') + '">' + (isZh ? '复制' : 'Copy') + '</button>'
        + '</div>'
        + '<div class="oauth-status-text" style="color:var(--text-secondary);">' + (isZh ? '在浏览器打开 ' : 'Open ') + '<a href="' + escapeHtml(sess.verificationUrl) + '" target="_blank">' + escapeHtml(sess.verificationUrl) + '</a>' + (isZh ? ' 并输入上方代码，完成授权后自动继续' : ' and enter the code; login continues automatically after approval') + '</div>'
      : '<span class="oauth-status-text" style="color:var(--text-secondary);">' + (isZh ? '正在请求设备码...' : 'Requesting device code...') + '</span>';
    // Skip unchanged renders so the copy button keeps its "copied" feedback
    if (display && display.innerHTML !== html) display.innerHTML = html;
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
          if (display) display.innerHTML = '<span class="oauth-status-text" style="color:#81c784;">✓ ' + (isZh ? '登录成功！令牌已保存' : 'Login successful! Token saved.') + '</span>';
        } else if (sess.status === 'expired') {
          if (_oauthPollTimer) { clearInterval(_oauthPollTimer); _oauthPollTimer = null; }
          if (display) display.innerHTML = '<span class="oauth-status-text" style="color:#e57373;">' + (isZh ? '设备码已过期，请重试' : 'Device code expired. Please try again.') + '</span>';
        } else if (sess.status === 'error') {
          if (_oauthPollTimer) { clearInterval(_oauthPollTimer); _oauthPollTimer = null; }
          if (display) display.innerHTML = '<span class="oauth-status-text" style="color:#e57373;">' + escapeHtml(sess.errorMessage || 'Login failed') + '</span>';
        }
      })
      .catch(function(err) {
        // A status read can fail transiently while the background OAuth flow is
        // still healthy. Keep polling instead of abandoning an approved login.
        if (display) {
          display.innerHTML = '<span class="oauth-status-text" style="color:#ffb74d;">'
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
  let providerName = getEditingProviderName();
  if (!providerName) return;
  let display = document.getElementById('oauth-status-display');
  if (!display) return;
  let isZh = currentLanguage === 'zh';

  fetch('/protoclaw/oauth/codex/tokens/' + encodeURIComponent(providerName))
    .then(function(r) { return r.json(); })
    .then(function(status) {
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
      display.innerHTML = '<span class="oauth-status-text" style="color:var(--text-secondary);">' + (isZh ? '未登录' : 'Not logged in') + '</span>';
    });
}
