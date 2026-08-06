/**
 * mcp-gateway-ui.js — MCP 网关管理覆盖层
 *
 * 从设置菜单的「MCP 网关」入口打开。
 * 功能：查看共享 MCP 服务器列表、状态、增删改配置、重启连接。
 *
 * 依赖（全局）：escapeHtml, currentLanguage
 */

// ── State ─────────────────────────────────────────────────────────

let _gatewayOpen = false;
let _gatewayData = null;     // { servers: [...] }
let _gatewayConfig = null;   // raw config from /config
let _editing = null;         // { id, isNew, config }

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
}

function closeMcpGateway() {
  _gatewayOpen = false;
  _editing = null;
  _gatewayData = null;
  _gatewayConfig = null;
  const host = document.getElementById('mcp-gateway-overlay-host');
  if (host) host.innerHTML = '';
}

window.openMcpGateway = openMcpGateway;
window.closeMcpGateway = closeMcpGateway;

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

// ── Actions ───────────────────────────────────────────────────────

window._gatewayRestart = async function(serverId) {
  try {
    await fetch(`/protoclaw/mcp-gateway/${encodeURIComponent(serverId)}/restart`, { method: 'POST' });
    await _loadGatewayData();
  } catch (e) {
    alert('Failed to restart: ' + e.message);
  }
};

window._gatewayDelete = async function(serverId) {
  if (!confirm(`Delete server "${serverId}"?`)) return;
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

window._gatewayCancelEdit = function() {
  _editing = null;
  renderGatewayOverlay();
};

window._gatewaySaveEdit = async function() {
  const id = (document.getElementById('gateway-edit-id')?.value || '').trim();
  if (!id) { alert('Server ID is required'); return; }

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
    if (!config.command) { alert('Command is required for stdio transport'); return; }
  } else {
    config.url = (document.getElementById('gateway-edit-url')?.value || '').trim();
    if (!config.url) { alert('URL is required for HTTP/SSE transport'); return; }
  }

  const newConfig = JSON.parse(JSON.stringify(_gatewayConfig || { servers: {} }));
  // If editing and ID changed, remove old entry
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
  // Re-render just the form fields based on transport selection
  const transport = document.getElementById('gateway-edit-transport')?.value || 'stdio';
  const dynamicFields = document.getElementById('gateway-edit-dynamic');
  if (!dynamicFields) return;
  dynamicFields.innerHTML = _renderEditFields(transport, _editing?.config || {});
};

// ── Rendering ─────────────────────────────────────────────────────

function _statusBadge(status) {
  const colors = {
    connected: 'var(--success-color, #22c55e)',
    connecting: 'var(--warning-color, #f59e0b)',
    error: 'var(--danger-color, #ef4444)',
    disconnected: 'var(--text-secondary, #999)',
  };
  const color = colors[status] || colors.disconnected;
  return `<span class="gateway-status-badge" style="color:${color}">● ${escapeHtml(status)}</span>`;
}

function _renderServerList(servers) {
  if (!servers || servers.length === 0) {
    return '<div style="padding:24px;text-align:center;color:var(--text-secondary, #999);font-size:13px;">' +
      '尚未配置任何共享 MCP 服务器。点击「添加服务器」开始。' +
      '</div>';
  }

  return '<div class="gateway-server-list">' + servers.map(s => {
    return [
      '<div class="gateway-server-card">',
      '<div class="gateway-server-header">',
      '<div class="gateway-server-name">' + escapeHtml(s.id) + '</div>',
      _statusBadge(s.status),
      '</div>',
      '<div class="gateway-server-meta">',
      '<span class="gateway-server-transport">' + escapeHtml(s.transport) + '</span>',
      '<span class="gateway-server-tools">' + s.toolCount + ' 个工具</span>',
      s.lastError ? '<span class="gateway-server-error" title="' + escapeHtml(s.lastError) + '">' + escapeHtml(s.lastError.substring(0, 60)) + '</span>' : '',
      '</div>',
      s.toolNames && s.toolNames.length ? '<div class="gateway-server-tools-list">' + s.toolNames.map(t => '<span class="gateway-tool-tag">' + escapeHtml(t) + '</span>').join('') + '</div>' : '',
      '<div class="gateway-server-actions">',
      '<button type="button" class="gateway-btn gateway-btn-sm" onclick="_gatewayRestart(\'' + escapeHtml(s.id) + '\')">重启</button>',
      '<button type="button" class="gateway-btn gateway-btn-sm" onclick="_gatewayEdit(\'' + escapeHtml(s.id) + '\')">编辑</button>',
      '<button type="button" class="gateway-btn gateway-btn-sm gateway-btn-danger" onclick="_gatewayDelete(\'' + escapeHtml(s.id) + '\')">删除</button>',
      '</div>',
      '</div>',
    ].join('');
  }).join('') + '</div>';
}

function _renderEditFields(transport, existing) {
  if (transport === 'stdio') {
    return [
      '<div class="settings-field-group">',
      '<label class="settings-field-label">命令 (command)</label>',
      '<input type="text" id="gateway-edit-command" class="settings-input" value="' + escapeHtml(existing.command || '') + '" placeholder="npx" />',
      '</div>',
      '<div class="settings-field-group">',
      '<label class="settings-field-label">参数 (args，每行一个)</label>',
      '<textarea id="gateway-edit-args" class="settings-textarea" rows="3" placeholder="-y\n@modelcontextprotocol/server-filesystem\n/tmp">' + escapeHtml((existing.args || []).join('\n')) + '</textarea>',
      '</div>',
      '<div class="settings-field-group">',
      '<label class="settings-field-label">环境变量 (JSON)</label>',
      '<input type="text" id="gateway-edit-env" class="settings-input" value="' + escapeHtml(existing.env ? JSON.stringify(existing.env) : '') + '" placeholder=\'{"API_KEY":"xxx"}\' />',
      '</div>',
    ].join('');
  }

  return [
    '<div class="settings-field-group">',
    '<label class="settings-field-label">URL</label>',
    '<input type="text" id="gateway-edit-url" class="settings-input" value="' + escapeHtml(existing.url || '') + '" placeholder="http://localhost:3000/mcp" />',
    '</div>',
  ].join('');
}

function _renderEditForm() {
  const e = _editing;
  const isEdit = !e.isNew;
  const transport = e.config.transport || 'stdio';

  return [
    '<div class="gateway-edit-section">',
    '<div class="gateway-edit-title">' + (isEdit ? '编辑服务器' : '添加服务器') + '</div>',
    '<div class="settings-field-group">',
    '<label class="settings-field-label">服务器 ID</label>',
    '<input type="text" id="gateway-edit-id" class="settings-input" value="' + escapeHtml(e.id) + '" placeholder="filesystem" ' + (isEdit ? 'readonly' : '') + ' />',
    '</div>',
    '<div class="settings-field-group">',
    '<label class="settings-field-label">传输类型</label>',
    '<select id="gateway-edit-transport" class="settings-select" onchange="_gatewayTransportChange()">',
    '<option value="stdio"' + (transport === 'stdio' ? ' selected' : '') + '>stdio</option>',
    '<option value="http"' + (transport === 'http' ? ' selected' : '') + '>HTTP (StreamableHTTP)</option>',
    '<option value="sse"' + (transport === 'sse' ? ' selected' : '') + '>SSE</option>',
    '</select>',
    '</div>',
    '<div id="gateway-edit-dynamic">',
    _renderEditFields(transport, e.config),
    '</div>',
    '<div class="gateway-edit-actions">',
    '<button type="button" class="gateway-btn" onclick="_gatewayCancelEdit()">取消</button>',
    '<button type="button" class="gateway-btn gateway-btn-primary" onclick="_gatewaySaveEdit()">保存</button>',
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

  const servers = _gatewayData?.servers || [];
  const showList = !_editing;

  host.innerHTML = [
    '<div class="feature-detail-overlay">',
    '<div class="feature-detail-window" style="width:min(100%,600px);max-height:min(100%,680px);overflow:hidden;display:flex;flex-direction:column;">',
    '<div class="feature-detail-head">',
    '<div>',
    '<div class="feature-detail-title">MCP 网关</div>',
    '<div class="feature-detail-subtitle">集中托管共享 MCP 服务器</div>',
    '</div>',
    '<button class="feature-detail-close" type="button" title="关闭" onclick="closeMcpGateway()">×</button>',
    '</div>',
    '<div style="overflow-y:auto;flex:1;padding:0 4px;">',
    showList ? [
      '<div style="padding:8px 4px 12px;color:var(--text-secondary);font-size:13px;line-height:1.5;">',
      'Claw 主进程集中托管 MCP 服务器，所有会话共享同一份连接，无需各自启动子进程。',
      '</div>',
      '<div style="display:flex;gap:8px;padding:0 4px 12px;">',
      '<button type="button" class="ctx-menu-item gateway-btn gateway-btn-primary" onclick="_gatewayAdd()" style="border:1px solid var(--glass-border);border-radius:8px;padding:6px 14px;cursor:pointer;background:var(--accent-color,color-mix(in srgb,var(--glass-bg),#3b82f6 30%));color:#fff;font-size:13px;">+ 添加服务器</button>',
      '<button type="button" class="ctx-menu-item gateway-btn" onclick="_loadGatewayData()" style="border:1px solid var(--glass-border);border-radius:8px;padding:6px 14px;cursor:pointer;background:var(--glass-bg);color:var(--text-primary);font-size:13px;">刷新</button>',
      '</div>',
      _renderServerList(servers),
    ].join('') : _renderEditForm(),
    '</div>',
    '</div>',
    '</div>',
  ].join('');
}

// Make _loadGatewayData callable from onclick
window._loadGatewayData = _loadGatewayData;
