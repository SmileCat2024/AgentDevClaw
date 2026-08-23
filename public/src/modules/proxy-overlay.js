/**
 * proxy-overlay.js — 网络代理设置面板模块（从 model-settings.js 拆分）
 *
 * 包含：独立 overlay host、代理面板渲染、加载 / 保存 / 连接测试。
 * 依赖（全局）：escapeHtml, currentLanguage
 */

window._proxyData = null;

function ensureProxyHost() {
  let host = document.getElementById('proxy-overlay-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'proxy-overlay-host';
    document.body.appendChild(host);
  }
  return host;
}

function openProxySettings() {
  window.ClawFW.proxyOverlayOpen = true;
  renderProxyOverlay();
  _loadProxyPanel();
}

function closeProxySettings() {
  window.ClawFW.proxyOverlayOpen = false;
  let host = document.getElementById('proxy-overlay-host');
  if (host) host.innerHTML = '';
}

function renderProxyOverlay() {
  let host = ensureProxyHost();
  if (!window.ClawFW.proxyOverlayOpen) {
    host.innerHTML = '';
    return;
  }
  let isZh = currentLanguage === 'zh';
  host.innerHTML = [
    '<div class="feature-detail-overlay">',
    '<div class="feature-detail-window" style="width:min(100%,520px);max-height:min(100%,640px);">',
    '<div class="feature-detail-head">',
    '<div>',
    '<div class="feature-detail-title">' + (isZh ? '网络代理' : 'Network Proxy') + '</div>',
    '</div>',
    '<button class="feature-detail-close" type="button" title="' + (isZh ? '关闭' : 'Close') + '" onclick="closeProxySettings()">×</button>',
    '</div>',
    '<div id="settings-proxy-container" class="settings-tab-content"></div>',
    '</div>',
    '</div>',
  ].join('');
}

async function _loadProxyPanel() {
  let container = document.getElementById('settings-proxy-container');
  if (!container) return;
  let isZh = currentLanguage === 'zh';

  container.innerHTML = '<div class="proxy-info-text">' + (isZh ? '加载中...' : 'Loading...') + '</div>';

  try {
    let res = await fetch('/protoclaw/proxy_config');
    window._proxyData = await res.json();
  } catch {
    window._proxyData = { config: { enabled: false, url: '' }, detected: { url: null, source: 'none' }, active: { url: null, applied: false } };
  }

  let d = window._proxyData;

  // Detected proxy info — clickable card that auto-fills URL + enables
  let detectedHtml = '';
  if (d.detected && d.detected.url) {
    detectedHtml = '<div class="proxy-detected-box proxy-detected-clickable" id="settings-proxy-detected">'
      + '<div class="proxy-detected-icon">◎</div>'
      + '<div class="proxy-detected-info">'
      + '<div class="proxy-detected-label">' + (isZh ? '检测到系统代理，点击使用' : 'System proxy detected — click to use') + '</div>'
      + '<div class="proxy-detected-url"><code>' + escapeHtml(d.detected.url) + '</code></div>'
      + '</div></div>';
  } else {
    detectedHtml = '<div class="proxy-detected-box proxy-detected-none">'
      + '<div class="proxy-detected-icon">○</div>'
      + '<div class="proxy-detected-info">'
      + '<div class="proxy-detected-label">' + (isZh ? '未检测到系统代理' : 'No system proxy detected') + '</div>'
      + '</div></div>';
  }

  // Active status banner
  let activeHtml = '';
  if (d.active && d.active.applied && d.active.url) {
    activeHtml = '<div class="proxy-active-banner">'
      + '<div class="proxy-active-banner-icon">✓</div>'
      + '<div class="proxy-active-banner-text">'
      + (isZh ? '代理已生效' : 'Proxy active')
      + '</div>'
      + '<code class="proxy-active-banner-url">' + escapeHtml(d.active.url) + '</code>'
      + '</div>';
  } else if (d.config.enabled) {
    activeHtml = '<div class="proxy-active-banner proxy-active-pending">'
      + '<div class="proxy-active-banner-icon">◐</div>'
      + '<div class="proxy-active-banner-text">'
      + (isZh ? '代理已启用，等待应用（需重启 Agent 子进程）' : 'Proxy enabled, pending apply (restart agent child processes)')
      + '</div>'
      + '</div>';
  }

  container.innerHTML = [
    // Description
    '<div class="proxy-info-text">',
    isZh ? '为服务端所有网络请求和 Agent 子进程启用全局代理。' : 'Enable a global proxy for all server-side HTTP requests and agent child processes.',
    '</div>',

    // Detected proxy
    detectedHtml,

    // Active banner
    activeHtml,

    // Enable toggle
    '<div class="proxy-toggle-row">',
    '<div class="proxy-toggle-label">' + (isZh ? '启用代理' : 'Enable Proxy') + '</div>',
    '<label class="proxy-switch">',
    '<input type="checkbox" id="settings-proxy-enabled" ' + (d.config.enabled ? 'checked' : '') + ' />',
    '<span class="proxy-switch-slider"></span>',
    '</label>',
    '</div>',

    // Proxy URL
    '<div class="settings-field">',
    '<label>' + (isZh ? '代理地址' : 'Proxy URL') + '</label>',
    '<input type="text" id="settings-proxy-url" class="settings-input" placeholder="http://127.0.0.1:7890" value="' + escapeHtml(d.config.url || '') + '" />',
    '</div>',

    // Buttons
    '<div class="proxy-btn-row">',
    '<button class="settings-btn settings-btn-secondary" type="button" id="settings-proxy-test">' + (isZh ? '测试连通性' : 'Test') + '</button>',
    '<button class="settings-btn settings-btn-primary" type="button" id="settings-proxy-save" style="margin-left:auto;">' + (isZh ? '保存并应用' : 'Save & Apply') + '</button>',
    '</div>',

    // Status
    '<div id="settings-proxy-status"></div>',
  ].join('');

  // Wire events
  let detectedCard = document.getElementById('settings-proxy-detected');
  if (detectedCard) {
    detectedCard.onclick = function() {
      if (d.detected && d.detected.url) {
        document.getElementById('settings-proxy-url').value = d.detected.url;
        document.getElementById('settings-proxy-enabled').checked = true;
      }
    };
  }
  document.getElementById('settings-proxy-save').onclick = _saveProxy;
  document.getElementById('settings-proxy-test').onclick = _testProxy;
}

async function _saveProxy() {
  let isZh = currentLanguage === 'zh';
  let enabled = document.getElementById('settings-proxy-enabled').checked;
  let url = document.getElementById('settings-proxy-url').value.trim();

  if (enabled && !url) {
    _proxyStatus('error', isZh ? '代理地址不能为空' : 'Proxy URL is required');
    return;
  }

  _proxyStatus('loading', isZh ? '正在保存...' : 'Saving...');
  try {
    let res = await fetch('/protoclaw/proxy_config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: enabled, url: url }),
    });
    let data = await res.json();
    if (res.ok) {
      window._proxyData = data;
      let msg = data.active && data.active.applied
        ? (isZh ? '已保存并应用: ' : 'Saved & Applied: ') + (data.active.url || '')
        : (isZh ? '已保存（代理已禁用）' : 'Saved (proxy disabled)');
      _proxyStatus('ok', msg);
    } else {
      _proxyStatus('error', data.error || 'Failed');
    }
  } catch (err) {
    _proxyStatus('error', err.message);
  }
}

async function _testProxy() {
  let isZh = currentLanguage === 'zh';
  _proxyStatus('loading', isZh ? '正在测试...' : 'Testing...');

  try {
    let res = await fetch('/protoclaw/proxy_test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    let data = await res.json();
    if (data.ok) {
      _proxyStatus('ok',
        isZh ? '连接成功 (HTTP ' + data.statusCode + ')' : 'Connected (HTTP ' + data.statusCode + ')',
        data.durationMs + 'ms');
    } else {
      _proxyStatus('error',
        isZh ? '连接失败' : 'Connection failed',
        [data.phase, data.errorCode, data.error].filter(Boolean).join(' · '));
    }
  } catch (err) {
    _proxyStatus('error', isZh ? '测试失败' : 'Test failed', err.message);
  }
}

function _proxyStatus(type, text, detail) {
  let el = document.getElementById('settings-proxy-status');
  if (!el) return;

  let icons = { ok: '✓', error: '✕', loading: '◐' };
  let cls = type === 'ok' ? 'proxy-status-ok' : type === 'error' ? 'proxy-status-error' : 'proxy-status-loading';

  el.innerHTML = '<div class="proxy-status-row ' + cls + '">'
    + '<span class="proxy-status-icon">' + (icons[type] || '') + '</span>'
    + '<span class="proxy-status-text">' + escapeHtml(text) + '</span>'
    + (detail ? '<span class="proxy-status-detail">' + escapeHtml(detail) + '</span>' : '')
    + '</div>';
}

// ── window 导出 ──────────────────────────────────────────────
window.openProxySettings = openProxySettings;
window.closeProxySettings = closeProxySettings;
