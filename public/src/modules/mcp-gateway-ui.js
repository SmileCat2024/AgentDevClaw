/**
 * mcp-gateway-ui.js — MCP 网关管理覆盖层
 *
 * 设计语言：与 model-settings.js 一致。
 *   - 复用 feature-detail-window / settings-btn / settings-icon-btn / settings-input
 *   - server 卡片参考 settings-preset-card 但更宽大，包含状态、工具列表
 *
 * 依赖（全局）：escapeHtml, currentLanguage
 */

// ── State ─────────────────────────────────────────────────────────

let _gatewayOpen = false;
let _gatewayData = null;     // { servers: [...] }
let _gatewayConfig = null;   // raw config from /config
let _editing = null;         // { id, isNew, config }
let _refreshTimer = null;

// ── Presets ───────────────────────────────────────────────────────

const MCP_PRESETS = [
  {
    id: 'filesystem',
    label: 'Filesystem',
    desc: '文件系统读写',
    config: { transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:\\'] },
  },
  {
    id: 'fetch',
    label: 'Fetch',
    desc: '网页抓取与转换',
    config: { transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-fetch'] },
  },
  {
    id: 'git',
    label: 'Git',
    desc: 'Git 仓库操作',
    config: { transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-git'] },
  },
  {
    id: 'memory',
    label: 'Memory',
    desc: '知识图谱记忆',
    config: { transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] },
  },
];

// ── Overlay host ──────────────────────────────────────────────────

function _ensureGatewayHost() {
  let host = document.getElementById('mcp-gateway-overlay-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'mcp-gateway-overlay-host';
    document.body.appendChild(host);
  }
  return host;
}

// ── Open / Close ──────────────────────────────────────────────────

async function openMcpGateway() {
  _gatewayOpen = true;
  _editing = null;
  renderGatewayOverlay();
  await _loadGatewayData();
  _startAutoRefresh();
}

function closeMcpGateway() {
  _gatewayOpen = false;
  _editing = null;
  _gatewayData = null;
  _gatewayConfig = null;
  _stopAutoRefresh();
  const host = document.getElementById('mcp-gateway-overlay-host');
  if (host) host.innerHTML = '';
}

window.openMcpGateway = openMcpGateway;
window.closeMcpGateway = closeMcpGateway;

// ── Auto refresh ──────────────────────────────────────────────────

function _startAutoRefresh() {
  _stopAutoRefresh();
  _refreshTimer = setInterval(async () => {
    if (!_gatewayOpen) { _stopAutoRefresh(); return; }
    // Only refresh status, not config (avoid clobbering edit form)
    try {
      const res = await fetch('/protoclaw/mcp-gateway/status');
      _gatewayData = await res.json();
      if (!_editing) renderGatewayOverlay();
      else _refreshStatusBadges();
    } catch { /* silent */ }
  }, 5000);
}

function _stopAutoRefresh() {
  if (_refreshTimer) { clearInterval(_refreshTimer); _refreshTimer = null; }
}

// Only update the status dots/badges without full re-render (for edit mode)
function _refreshStatusBadges() {
  const servers = _gatewayData?.servers || [];
  for (const s of servers) {
    const dot = document.querySelector(`[data-server-dot="${s.id}"]`);
    if (dot) {
      dot.className = 'settings-preset-dot' + (s.status === 'connected' ? ' active' : s.status === 'error' ? ' error' : '');
    }
  }
}

// ── Data loading ──────────────────────────────────────────────────

async function _loadGatewayData() {
  try {
    const [statusRes, configRes] = await Promise.all([
      fetch('/protoclaw/mcp-gateway/status'),
      fetch('/protoclaw/mcp-gateway/config'),
    ]);
    _gatewayData = await statusRes.json();
    _gatewayConfig = await configRes.json();
  } catch (e) {
    console.error('Failed to load MCP gateway data:', e);
    _gatewayData = { servers: [] };
    _gatewayConfig = { servers: {} };
  }
  renderGatewayOverlay();
}

window._loadGatewayData = _loadGatewayData;

// ── Actions ───────────────────────────────────────────────────────

window._gatewayRestart = async function(serverId) {
  // Optimistic: show connecting state
  const dot = document.querySelector(`[data-server-dot="${serverId}"]`);
  if (dot) dot.className = 'settings-preset-dot connecting';
  try {
    await fetch(`/protoclaw/mcp-gateway/${encodeURIComponent(serverId)}/restart`, { method: 'POST' });
    // Wait a moment then refresh
    setTimeout(() => _loadGatewayData(), 500);
  } catch (e) {
    alert('Failed to restart: ' + e.message);
    _loadGatewayData();
  }
};

window._gatewayDelete = async function(serverId) {
  const isZh = currentLanguage === 'zh';
  if (!confirm(isZh ? `确定删除服务器 "${serverId}"？` : `Delete server "${serverId}"?`)) return;
  const config = JSON.parse(JSON.stringify(_gatewayConfig || { servers: {} }));
  delete config.servers[serverId];
  try {
    await fetch('/protoclaw/mcp-gateway/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
    await _loadGatewayData();
  } catch (e) {
    alert('Failed to delete: ' + e.message);
  }
};

window._gatewayEdit = function(serverId) {
  const config = _gatewayConfig?.servers?.[serverId];
  if (!config) return;
  _editing = { id: serverId, isNew: false, config: JSON.parse(JSON.stringify(config)) };
  renderGatewayOverlay();
};

window._gatewayAdd = function() {
  _editing = {
    id: '',
    isNew: true,
    config: { transport: 'stdio', command: '', args: [] },
  };
  renderGatewayOverlay();
};

window._gatewayAddPreset = function(presetId) {
  const preset = MCP_PRESETS.find(p => p.id === presetId);
  if (!preset) return;
  // Check if ID already taken
  let id = preset.id;
  let n = 2;
  while (_gatewayConfig?.servers?.[id]) { id = `${preset.id}-${n++}`; }
  const config = JSON.parse(JSON.stringify(_gatewayConfig || { servers: {} }));
  config.servers[id] = JSON.parse(JSON.stringify(preset.config));
  fetch('/protoclaw/mcp-gateway/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  }).then(() => _loadGatewayData()).catch(e => alert('Failed to add: ' + e.message));
};

window._gatewayCancelEdit = function() {
  _editing = null;
  renderGatewayOverlay();
};

window._gatewaySaveEdit = async function() {
  const isZh = currentLanguage === 'zh';
  const id = (document.getElementById('gateway-edit-id')?.value || '').trim();
  if (!id) { alert(isZh ? '服务器 ID 不能为空' : 'Server ID is required'); return; }

  const transport = document.getElementById('gateway-edit-transport')?.value || 'stdio';
  const config = { transport };

  if (transport === 'stdio') {
    config.command = (document.getElementById('gateway-edit-command')?.value || '').trim();
    config.args = (document.getElementById('gateway-edit-args')?.value || '')
      .split('\n').map(s => s.trim()).filter(Boolean);
    const envText = (document.getElementById('gateway-edit-env')?.value || '').trim();
    if (envText) {
      try { config.env = JSON.parse(envText); } catch { config.env = {}; }
    }
    if (!config.command) { alert(isZh ? 'stdio 模式需要填写命令' : 'Command is required for stdio transport'); return; }
  } else {
    config.url = (document.getElementById('gateway-edit-url')?.value || '').trim();
    if (!config.url) { alert(isZh ? 'HTTP/SSE 模式需要填写 URL' : 'URL is required for HTTP/SSE transport'); return; }
  }

  const newConfig = JSON.parse(JSON.stringify(_gatewayConfig || { servers: {} }));
  if (_editing && !_editing.isNew && _editing.id !== id) {
    delete newConfig.servers[_editing.id];
  }
  newConfig.servers[id] = config;

  try {
    await fetch('/protoclaw/mcp-gateway/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newConfig),
    });
    _editing = null;
    await _loadGatewayData();
  } catch (e) {
    alert('Failed to save: ' + e.message);
  }
};

window._gatewayTransportChange = function() {
  const transport = document.getElementById('gateway-edit-transport')?.value || 'stdio';
  const dynamicFields = document.getElementById('gateway-edit-dynamic');
  if (!dynamicFields) return;
  dynamicFields.innerHTML = _renderEditFields(transport, _editing?.config || {});
};

// ── Rendering ─────────────────────────────────────────────────────

function _statusDotClass(status) {
  if (status === 'connected') return 'active';
  if (status === 'connecting') return 'connecting';
  if (status === 'error') return 'error';
  return '';
}

function _statusText(status) {
  const isZh = currentLanguage === 'zh';
  const map = {
    connected: isZh ? '已连接' : 'Connected',
    connecting: isZh ? '连接中' : 'Connecting',
    error: isZh ? '错误' : 'Error',
    disconnected: isZh ? '未连接' : 'Disconnected',
  };
  return map[status] || map.disconnected;
}

function _renderServerCard(s, isZh) {
  const dotClass = _statusDotClass(s.status);
  const connectedTime = s.connectedAt
    ? new Date(s.connectedAt).toLocaleTimeString()
    : '';

  // Tool tags (show first 8, then "+N")
  const tools = s.toolNames || [];
  const visibleTools = tools.slice(0, 8);
  const extraCount = tools.length - visibleTools.length;
  const toolTagsHtml = tools.length > 0
    ? '<div class="gateway-tool-tags">' +
      visibleTools.map(t => `<span class="gateway-tool-tag">${escapeHtml(t)}</span>`).join('') +
      (extraCount > 0 ? `<span class="gateway-tool-tag more">+${extraCount}</span>` : '') +
      '</div>'
    : '';

  // Error message
  const errorHtml = s.lastError
    ? `<div class="gateway-server-error" title="${escapeHtml(s.lastError)}">${escapeHtml(s.lastError.length > 80 ? s.lastError.substring(0, 80) + '…' : s.lastError)}</div>`
    : '';

  return [
    '<div class="settings-preset-card gateway-server-card">',
    // Row 1: dot + name + status + actions
    '<div class="gateway-server-top">',
    '<div class="gateway-server-left">',
    `<div class="settings-preset-dot ${dotClass}" data-server-dot="${escapeHtml(s.id)}"></div>`,
    '<div class="settings-preset-info">',
    `<div class="settings-preset-name">${escapeHtml(s.id)}</div>`,
    `<div class="settings-preset-detail">`,
    `<span>${escapeHtml(s.transport)}</span>`,
    `<span class="gateway-dot-sep">·</span>`,
    `<span>${s.toolCount} ${isZh ? '个工具' : 'tools'}</span>`,
    connectedTime ? `<span class="gateway-dot-sep">·</span><span class="gateway-uptime">${connectedTime}</span>` : '',
    `</div>`,
    '</div>',
    '</div>',
    '<div class="settings-preset-actions">',
    // Status badge
    `<span class="gateway-status-pill ${s.status}">${_statusText(s.status)}</span>`,
    // Restart button
    `<button class="settings-icon-btn" type="button" title="${isZh ? '重启' : 'Restart'}" onclick="event.stopPropagation();_gatewayRestart('${escapeHtml(s.id)}')">`,
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M3 21v-5h5"/></svg>',
    '</button>',
    // Edit button
    `<button class="settings-icon-btn" type="button" title="${isZh ? '编辑' : 'Edit'}" onclick="event.stopPropagation();_gatewayEdit('${escapeHtml(s.id)}')">`,
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>',
    '</button>',
    // Delete button
    `<button class="settings-icon-btn danger" type="button" title="${isZh ? '删除' : 'Delete'}" onclick="event.stopPropagation();_gatewayDelete('${escapeHtml(s.id)}')">`,
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>',
    '</button>',
    '</div>',
    '</div>',
    // Row 2: tool tags
    toolTagsHtml,
    // Row 3: error message
    errorHtml,
    '</div>',
  ].join('');
}

function _renderServerList(servers, isZh) {
  if (!servers || servers.length === 0) {
    return '<div style="padding:32px 16px;text-align:center;color:var(--text-secondary);font-size:13px;">' +
      (isZh ? '尚未配置任何共享 MCP 服务器' : 'No shared MCP servers configured') +
      '</div>';
  }

  return '<div class="settings-presets-grid gateway-server-grid">' +
    servers.map(s => _renderServerCard(s, isZh)).join('') +
    '</div>';
}

function _renderPresetRow(isZh) {
  const existingIds = new Set(Object.keys(_gatewayConfig?.servers || {}));
  const presets = MCP_PRESETS.map(p => {
    const added = existingIds.has(p.id);
    return `<button class="gateway-preset-btn${added ? ' added' : ''}" type="button" ` +
      `onclick="_gatewayAddPreset('${p.id}')" ${added ? 'disabled' : ''} ` +
      `title="${escapeHtml(p.config.args.join(' '))}">` +
      `<span class="gateway-preset-icon">+</span>` +
      `<span class="gateway-preset-name">${escapeHtml(p.label)}</span>` +
      `<span class="gateway-preset-desc">${escapeHtml(p.desc)}</span>` +
      (added ? `<span class="gateway-preset-added">${isZh ? '已添加' : 'Added'}</span>` : '') +
      '</button>';
  }).join('');

  return [
    '<div class="gateway-preset-section">',
    `<div class="settings-section-title">${isZh ? '快速添加常用 MCP' : 'Quick Add'}</div>`,
    '<div class="gateway-preset-row">',
    presets,
    '</div>',
    '</div>',
  ].join('');
}

function _renderEditFields(transport, existing) {
  const isZh = currentLanguage === 'zh';
  if (transport === 'stdio') {
    return [
      '<div class="settings-field">',
      `<label>${isZh ? '命令' : 'Command'}</label>`,
      '<input type="text" id="gateway-edit-command" class="settings-input" value="' + escapeHtml(existing.command || '') + '" placeholder="npx" />',
      '</div>',
      '<div class="settings-field">',
      `<label>${isZh ? '参数（每行一个）' : 'Arguments (one per line)'}</label>`,
      '<textarea id="gateway-edit-args" class="settings-input" rows="3" style="resize:vertical;font-family:var(--mono-font,monospace);font-size:12px;" placeholder="-y\n@modelcontextprotocol/server-filesystem\n/tmp">' + escapeHtml((existing.args || []).join('\n')) + '</textarea>',
      '</div>',
      '<div class="settings-field">',
      `<label>${isZh ? '环境变量 (JSON)' : 'Environment Variables (JSON)'}</label>`,
      '<input type="text" id="gateway-edit-env" class="settings-input" value="' + escapeHtml(existing.env ? JSON.stringify(existing.env) : '') + '" placeholder=\'{"API_KEY":"xxx"}\' />',
      '</div>',
    ].join('');
  }

  return [
    '<div class="settings-field">',
    `<label>URL</label>`,
    '<input type="text" id="gateway-edit-url" class="settings-input" value="' + escapeHtml(existing.url || '') + '" placeholder="http://localhost:3000/mcp" />',
    '</div>',
  ].join('');
}

function _renderEditForm(isZh) {
  const e = _editing;
  const isEdit = !e.isNew;
  const transport = e.config.transport || 'stdio';

  return [
    '<div class="settings-section">',
    `<div class="settings-section-title">${isZh ? (isEdit ? '编辑服务器' : '添加服务器') : (isEdit ? 'Edit Server' : 'Add Server')}</div>`,
    '<div class="settings-field">',
    `<label>${isZh ? '服务器 ID' : 'Server ID'}</label>`,
    '<input type="text" id="gateway-edit-id" class="settings-input" value="' + escapeHtml(e.id) + '" placeholder="filesystem" ' + (isEdit ? 'readonly' : '') + ' />',
    '</div>',
    '<div class="settings-field">',
    `<label>${isZh ? '传输类型' : 'Transport'}</label>`,
    '<select id="gateway-edit-transport" class="settings-input" onchange="_gatewayTransportChange()">',
    '<option value="stdio"' + (transport === 'stdio' ? ' selected' : '') + '>stdio</option>',
    '<option value="http"' + (transport === 'http' ? ' selected' : '') + '>HTTP (StreamableHTTP)</option>',
    '<option value="sse"' + (transport === 'sse' ? ' selected' : '') + '>SSE</option>',
    '</select>',
    '</div>',
    '<div id="gateway-edit-dynamic">',
    _renderEditFields(transport, e.config),
    '</div>',
    '</div>',
  ].join('');
}

function renderGatewayOverlay() {
  const host = _ensureGatewayHost();
  if (!_gatewayOpen) {
    host.innerHTML = '';
    return;
  }

  const isZh = currentLanguage === 'zh';
  const servers = _gatewayData?.servers || [];
  const showList = !_editing;

  // Footer buttons
  let footerButtons = '';
  if (showList) {
    footerButtons = [
      '<div class="settings-actions">',
      `<button class="settings-btn settings-btn-secondary" type="button" onclick="_loadGatewayData()">`,
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:6px;vertical-align:-2px;"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>',
      isZh ? '刷新' : 'Refresh',
      '</button>',
      `<button class="settings-btn settings-btn-primary" type="button" onclick="_gatewayAdd()">+ ${isZh ? '添加服务器' : 'Add Server'}</button>`,
      '</div>',
    ].join('');
  } else {
    footerButtons = [
      '<div class="settings-actions">',
      `<button class="settings-btn settings-btn-secondary" type="button" onclick="_gatewayCancelEdit()">${isZh ? '取消' : 'Cancel'}</button>`,
      `<button class="settings-btn settings-btn-primary" type="button" onclick="_gatewaySaveEdit()">${isZh ? '保存' : 'Save'}</button>`,
      '</div>',
    ].join('');
  }

  // Scrollable content
  let scrollContent = '';
  if (showList) {
    scrollContent = [
      // Preset quick-add row
      _renderPresetRow(isZh),
      // Server list
      '<div class="settings-section">',
      `<div class="settings-section-title">${isZh ? '服务器列表' : 'Servers'}</div>`,
      _renderServerList(servers, isZh),
      '</div>',
    ].join('');
  } else {
    scrollContent = _renderEditForm(isZh);
  }

  host.innerHTML = [
    '<div class="feature-detail-overlay">',
    '<div class="feature-detail-window" style="width:min(100%,600px);height:min(100%,660px);overflow:hidden;display:flex;flex-direction:column;">',
    // Header
    '<div class="feature-detail-head">',
    '<div>',
    `<div class="feature-detail-title">${isZh ? 'MCP 网关' : 'MCP Gateway'}</div>`,
    `<div class="feature-detail-subtitle">${isZh ? '集中托管共享 MCP 服务器，所有会话复用同一连接' : 'Centrally hosted MCP servers, shared across all sessions'}</div>`,
    '</div>',
    `<button class="feature-detail-close" type="button" title="${isZh ? '关闭' : 'Close'}" onclick="closeMcpGateway()">×</button>`,
    '</div>',
    // Scrollable content
    '<div class="settings-tab-content">',
    scrollContent,
    '</div>',
    // Footer
    '<div class="settings-footer">',
    footerButtons,
    '</div>',
    '</div>',
    '</div>',
  ].join('');
}
