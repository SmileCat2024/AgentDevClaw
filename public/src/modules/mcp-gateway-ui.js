/**
 * mcp-gateway-ui.js — MCP 网关管理覆盖层
 *
 * 逻辑分区：
 *   系统内置 — Claw MCP、Debugger MCP（始终在线，开关控制是否启用 gateway 连接）
 *   自定义服务器 — 用户通过 gateway 配置添加的共享 MCP
 *
 * 视图模式：list / detail / edit
 *
 * 依赖（全局）：escapeHtml, currentLanguage
 */

// ── State ─────────────────────────────────────────────────────────

let _gatewayOpen = false;
let _gatewayData = null;     // { systemServers: [...], servers: [...] }
let _gatewayConfig = null;   // raw config from /config
let _view = 'list';          // 'list' | 'detail' | 'edit'
let _editing = null;         // { id, isNew, config }
let _detail = null;          // detail data from /detail endpoint
let _detailLoading = false;
let _refreshTimer = null;
let _loading = false;

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
  _view = 'list';
  _editing = null;
  _detail = null;
  _loading = true;
  renderGatewayOverlay();
  await _loadGatewayData();
  _startAutoRefresh();
}

function closeMcpGateway() {
  _gatewayOpen = false;
  _editing = null;
  _detail = null;
  _view = 'list';
  _gatewayData = null;
  _gatewayConfig = null;
  _loading = false;
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
    if (_view !== 'list') return; // Only auto-refresh list view
    try {
      const res = await fetch('/protoclaw/mcp-gateway/status');
      _gatewayData = await res.json();
      renderGatewayOverlay();
    } catch { /* silent */ }
  }, 5000);
}

function _stopAutoRefresh() {
  if (_refreshTimer) { clearInterval(_refreshTimer); _refreshTimer = null; }
}

// ── Data loading ──────────────────────────────────────────────────

async function _loadGatewayData() {
  _loading = true;
  if (_view === 'list') renderGatewayOverlay();
  try {
    const [statusRes, configRes] = await Promise.all([
      fetch('/protoclaw/mcp-gateway/status'),
      fetch('/protoclaw/mcp-gateway/config'),
    ]);
    _gatewayData = await statusRes.json();
    _gatewayConfig = await configRes.json();
  } catch (e) {
    console.error('Failed to load MCP gateway data:', e);
    _gatewayData = { systemServers: [], servers: [] };
    _gatewayConfig = { servers: {} };
  }
  _loading = false;
  renderGatewayOverlay();
}

window._loadGatewayData = _loadGatewayData;

// ── Actions ───────────────────────────────────────────────────────

window._gatewayRestart = async function(serverId) {
  if (_gatewayData?.servers) {
    const s = _gatewayData.servers.find(x => x.id === serverId);
    if (s) { s.status = 'connecting'; s.lastError = null; }
    renderGatewayOverlay();
  }
  try {
    await fetch(`/protoclaw/mcp-gateway/${encodeURIComponent(serverId)}/restart`, { method: 'POST' });
    _pollForStatus(serverId, 3);
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
    if (_gatewayData?.servers) {
      _gatewayData.servers = _gatewayData.servers.filter(x => x.id !== serverId);
    }
    if (_gatewayConfig?.servers) {
      delete _gatewayConfig.servers[serverId];
    }
    renderGatewayOverlay();
    setTimeout(() => _loadGatewayData(), 800);
  } catch (e) {
    alert('Failed to delete: ' + e.message);
    _loadGatewayData();
  }
};

window._gatewayEdit = function(serverId) {
  const config = _gatewayConfig?.servers?.[serverId];
  if (!config) return;
  _editing = { id: serverId, isNew: false, config: JSON.parse(JSON.stringify(config)) };
  _view = 'edit';
  renderGatewayOverlay();
};

window._gatewayAdd = function() {
  _editing = {
    id: '',
    isNew: true,
    config: { transport: 'stdio', command: '', args: [] },
  };
  _view = 'edit';
  renderGatewayOverlay();
};

window._gatewayCancelEdit = function() {
  _editing = null;
  _view = 'list';
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
    _gatewayConfig = newConfig;
    _editing = null;
    _view = 'list';
    if (_gatewayData?.servers) {
      const existing = _gatewayData.servers.find(x => x.id === id);
      if (existing) {
        existing.status = 'connecting';
        existing.lastError = null;
        existing.transport = transport;
      } else {
        _gatewayData.servers.push({
          id, transport, status: 'connecting', toolCount: 0, toolNames: [], lastError: null,
        });
      }
    }
    renderGatewayOverlay();
    _pollForStatus(id, 5);
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

window._gatewayToggleSystem = async function(serverId, checkbox) {
  try {
    await fetch(`/protoclaw/mcp-gateway/system/${encodeURIComponent(serverId)}/toggle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: checkbox.checked }),
    });
    if (_gatewayData?.systemServers) {
      const s = _gatewayData.systemServers.find(x => x.id === serverId);
      if (s) s.enabled = checkbox.checked;
    }
  } catch (e) {
    checkbox.checked = !checkbox.checked;
    alert('Failed to toggle: ' + e.message);
  }
};

// ── Detail view ───────────────────────────────────────────────────

window._gatewayViewDetail = async function(serverId) {
  _view = 'detail';
  _detail = null;
  _detailLoading = true;
  renderGatewayOverlay();
  try {
    const res = await fetch(`/protoclaw/mcp-gateway/${encodeURIComponent(serverId)}/detail`);
    _detail = await res.json();
  } catch (e) {
    console.error('Failed to load detail:', e);
    _detail = { id: serverId, name: serverId, tools: [], error: e.message };
  }
  _detailLoading = false;
  renderGatewayOverlay();
};

window._gatewayBackToList = function() {
  _view = 'list';
  _detail = null;
  renderGatewayOverlay();
};

window._gatewayRefreshDetail = async function() {
  if (!_detail) return;
  _detailLoading = true;
  renderGatewayOverlay();
  try {
    const res = await fetch(`/protoclaw/mcp-gateway/${encodeURIComponent(_detail.id)}/detail`);
    _detail = await res.json();
  } catch (e) {
    // keep old detail
  }
  _detailLoading = false;
  renderGatewayOverlay();
};

function _pollForStatus(serverId, rounds) {
  let count = 0;
  const poll = async () => {
    if (!_gatewayOpen || _view !== 'list') return;
    count++;
    try {
      const res = await fetch('/protoclaw/mcp-gateway/status');
      const data = await res.json();
      _gatewayData = data;
      const s = data.servers?.find(x => x.id === serverId);
      if (s && (s.status === 'connected' || s.status === 'error')) {
        renderGatewayOverlay();
        return;
      }
      renderGatewayOverlay();
      if (count < rounds) setTimeout(poll, 1500);
    } catch { /* silent */ }
  };
  setTimeout(poll, 1500);
}

// ── SVG icons ─────────────────────────────────────────────────────

const SVG_REFRESH = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M3 21v-5h5"/></svg>';
const SVG_EDIT = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>';
const SVG_DELETE = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>';
const SVG_SERVER = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>';
const SVG_BACK = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 19-7-7 7-7"/><path d="M19 12H5"/></svg>';
const SVG_TOOL = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>';

// ── Helpers ───────────────────────────────────────────────────────

function _statusDotClass(status) {
  if (status === 'connected') return 'active';
  if (status === 'connecting') return 'connecting';
  if (status === 'error') return 'error';
  return '';
}

function _fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleTimeString();
}

// ── List rendering ────────────────────────────────────────────────

function _renderSystemItem(s, isZh) {
  const checked = s.enabled !== false ? 'checked' : '';
  const toolText = s.toolCount > 0
    ? '<span class="gateway-dot-sep">·</span><span>' + s.toolCount + (isZh ? ' 个工具' : ' tools') + '</span>'
    : '';
  return [
    '<div class="gateway-list-item clickable" onclick="_gatewayViewDetail(\'' + escapeHtml(s.id) + '\')">',
    '  <div class="gateway-list-row">',
    '    <div class="gateway-item-left">',
    '      <div class="gateway-item-icon">' + SVG_SERVER + '</div>',
    '      <div class="gateway-item-text">',
    '        <div class="gateway-item-name">' + escapeHtml(s.name || s.id) + '</div>',
    '        <div class="gateway-item-detail">',
    '          <span>' + escapeHtml(s.transport) + '</span>',
    '          toolText',
    '        </div>',
    '      </div>',
    '    </div>',
    '    <div class="gateway-item-right">',
    '      <label class="proxy-switch" title="' + (isZh ? '启用/禁用' : 'Enable/Disable') + '" onclick="event.stopPropagation()">',
    '      <input type="checkbox" ' + checked + ' onchange="_gatewayToggleSystem(\'' + escapeHtml(s.id) + '\', this)" />',
    '        <span class="proxy-switch-slider"></span>',
    '      </label>',
    '    </div>',
    '  </div>',
    '</div>',
  ].join('').replace('toolText', toolText);
}

function _renderCustomItem(s, isZh) {
  const dotClass = _statusDotClass(s.status);
  const statusText = {
    connected: isZh ? '已连接' : 'Connected',
    connecting: isZh ? '连接中' : 'Connecting',
    error: isZh ? '错误' : 'Error',
    disconnected: isZh ? '未连接' : 'Disconnected',
  }[s.status] || (isZh ? '未连接' : 'Disconnected');

  const toolText = s.toolCount > 0
    ? '<span>' + s.toolCount + (isZh ? ' 个工具' : ' tools') + '</span>'
    : '';

  const detailParts = [
    '<span>' + escapeHtml(s.transport) + '</span>',
    '<span class="gateway-dot-sep">·</span>',
    toolText || '<span>' + (isZh ? '无工具' : 'no tools') + '</span>',
  ];

  const errorHtml = s.lastError
    ? '<div class="gateway-server-error" title="' + escapeHtml(s.lastError) + '">' + escapeHtml(s.lastError.length > 100 ? s.lastError.substring(0, 100) + '…' : s.lastError) + '</div>'
    : '';

  return [
    '<div class="gateway-list-item clickable" onclick="_gatewayViewDetail(\'' + escapeHtml(s.id) + '\')">',
    '  <div class="gateway-list-row">',
    '    <div class="gateway-item-left">',
    '      <div class="settings-preset-dot ' + dotClass + '"></div>',
    '      <div class="gateway-item-text">',
    '        <div class="gateway-item-name">' + escapeHtml(s.id) + '</div>',
    '        <div class="gateway-item-detail">' + detailParts.join('') + '</div>',
    '      </div>',
    '    </div>',
    '    <div class="gateway-item-right">',
    '      <span class="gateway-status-text ' + s.status + '">' + statusText + '</span>',
    '      <button class="settings-icon-btn" type="button" title="' + (isZh ? '重启' : 'Restart') + '" onclick="event.stopPropagation();_gatewayRestart(\'' + escapeHtml(s.id) + '\')">' + SVG_REFRESH + '</button>',
    '      <button class="settings-icon-btn" type="button" title="' + (isZh ? '编辑' : 'Edit') + '" onclick="event.stopPropagation();_gatewayEdit(\'' + escapeHtml(s.id) + '\')">' + SVG_EDIT + '</button>',
    '      <button class="settings-icon-btn danger" type="button" title="' + (isZh ? '删除' : 'Delete') + '" onclick="event.stopPropagation();_gatewayDelete(\'' + escapeHtml(s.id) + '\')">' + SVG_DELETE + '</button>',
    '    </div>',
    '  </div>',
    errorHtml,
    '</div>',
  ].join('');
}

function _renderSystemSection(systemServers, isZh) {
  if (!systemServers || systemServers.length === 0) return '';
  return [
    '<div class="settings-section">',
    '  <div class="settings-section-title">' + (isZh ? '系统内置' : 'Built-in') + '</div>',
    '  <div class="gateway-list">',
    systemServers.map(s => _renderSystemItem(s, isZh)).join(''),
    '  </div>',
    '</div>',
  ].join('');
}

function _renderCustomSection(servers, isZh) {
  const emptyText = isZh ? '尚未配置自定义服务器' : 'No custom servers configured';
  const items = servers.length > 0
    ? servers.map(s => _renderCustomItem(s, isZh)).join('')
    : '<div class="gateway-list-empty">' + escapeHtml(emptyText) + '</div>';

  return [
    '<div class="settings-section">',
    '  <div class="settings-section-title">' + (isZh ? '自定义服务器' : 'Custom Servers') + '</div>',
    '  <div class="gateway-list">',
    items,
    '  </div>',
    '</div>',
  ].join('');
}

// ── Detail rendering ──────────────────────────────────────────────

function _renderDetailRow(label, value, isMono) {
  if (!value && value !== 0) return '';
  const valClass = isMono ? 'gateway-detail-val mono' : 'gateway-detail-val';
  return '<div class="gateway-detail-row"><span class="gateway-detail-label">' + escapeHtml(label) + '</span><span class="' + valClass + '">' + escapeHtml(String(value)) + '</span></div>';
}

function _renderToolCard(tool, isZh) {
  const desc = tool.description || (isZh ? '（无描述）' : '(no description)');
  const props = tool.inputSchema?.properties ? Object.keys(tool.inputSchema.properties) : [];

  return [
    '<div class="feature-tool-card">',
    '  <div class="feature-tool-top">',
    '    <div class="feature-tool-name">' + SVG_TOOL + ' ' + escapeHtml(tool.name) + '</div>',
    '  </div>',
    '  <div class="feature-tool-desc">' + escapeHtml(desc) + '</div>',
    props.length > 0
      ? '<div class="gateway-tool-params">' + props.map(p => '<span class="gateway-tool-tag">' + escapeHtml(p) + '</span>').join('') + '</div>'
      : '',
    '</div>',
  ].join('');
}

function _renderDetailView(isZh) {
  if (_detailLoading) {
    return '<div class="gateway-list-empty">' + (isZh ? '加载详情中…' : 'Loading details…') + '</div>';
  }
  if (!_detail) return '';

  const d = _detail;

  // Config section
  const configRows = [];
  configRows.push(_renderDetailRow(isZh ? '传输方式' : 'Transport', d.transport));
  if (d.isSystem) {
    configRows.push(_renderDetailRow('URL', d.url, true));
    configRows.push(_renderDetailRow(isZh ? '已启用' : 'Enabled', d.enabled !== false ? '✓' : '✗'));
  } else if (d.config) {
    if (d.config.command) configRows.push(_renderDetailRow(isZh ? '命令' : 'Command', d.config.command, true));
    if (d.config.args?.length) configRows.push(_renderDetailRow(isZh ? '参数' : 'Arguments', d.config.args.join(' '), true));
    if (d.config.url) configRows.push(_renderDetailRow('URL', d.config.url, true));
    if (d.config.env && Object.keys(d.config.env).length > 0) {
      configRows.push(_renderDetailRow(isZh ? '环境变量' : 'Environment', JSON.stringify(d.config.env), true));
    }
  }
  configRows.push(_renderDetailRow(isZh ? '连接时间' : 'Connected At', _fmtTime(d.connectedAt)));
  if (d.lastError) {
    configRows.push('<div class="gateway-server-error" style="margin-top:8px;">' + escapeHtml(d.lastError) + '</div>');
  }

  // Tools section
  const tools = d.tools || [];
  const toolsHtml = tools.length > 0
    ? '<div class="gateway-tool-grid">' + tools.map(t => _renderToolCard(t, isZh)).join('') + '</div>'
    : '<div class="gateway-list-empty">' + (isZh ? '暂无工具（服务器未连接或未提供工具）' : 'No tools available (server not connected or provides no tools)') + '</div>';

  // Action buttons for custom servers
  let actionButtons = '';
  if (!d.isSystem && d.status === 'error') {
    actionButtons = '<button class="settings-btn settings-btn-secondary" type="button" onclick="_gatewayRestart(\'' + escapeHtml(d.id) + '\');_gatewayRefreshDetail()">' + SVG_REFRESH + (isZh ? ' 重试连接' : ' Retry') + '</button>';
  }

  return [
    // Config section
    '<div class="settings-section">',
    '  <div class="settings-section-title">' + (isZh ? '连接配置' : 'Configuration') + '</div>',
    '  <div class="gateway-detail-rows">',
    configRows.join(''),
    '  </div>',
    '</div>',
    // Tools section
    '<div class="settings-section">',
    '  <div class="settings-section-title">' + (isZh ? '工具列表' : 'Tools') + ' (' + tools.length + ')</div>',
    toolsHtml,
    '</div>',
    actionButtons ? '<div class="settings-actions">' + actionButtons + '</div>' : '',
  ].join('');
}

// ── Edit form rendering ───────────────────────────────────────────

function _renderEditFields(transport, existing) {
  const isZh = currentLanguage === 'zh';
  if (transport === 'stdio') {
    return [
      '<div class="settings-field">',
      '  <label>' + (isZh ? '命令' : 'Command') + '</label>',
      '  <input type="text" id="gateway-edit-command" class="settings-input" value="' + escapeHtml(existing.command || '') + '" placeholder="npx" />',
      '</div>',
      '<div class="settings-field">',
      '  <label>' + (isZh ? '参数（每行一个）' : 'Arguments (one per line)') + '</label>',
      '  <textarea id="gateway-edit-args" class="settings-input" rows="3" style="resize:vertical;" placeholder="-y\n@modelcontextprotocol/server-filesystem\n/tmp">' + escapeHtml((existing.args || []).join('\n')) + '</textarea>',
      '</div>',
      '<div class="settings-field">',
      '  <label>' + (isZh ? '环境变量 (JSON)' : 'Environment Variables (JSON)') + '</label>',
      '  <input type="text" id="gateway-edit-env" class="settings-input" value="' + escapeHtml(existing.env ? JSON.stringify(existing.env) : '') + '" placeholder=\'{"API_KEY":"xxx"}\' />',
      '</div>',
    ].join('');
  }
  return [
    '<div class="settings-field">',
    '  <label>URL</label>',
    '  <input type="text" id="gateway-edit-url" class="settings-input" value="' + escapeHtml(existing.url || '') + '" placeholder="http://localhost:3000/mcp" />',
    '</div>',
  ].join('');
}

function _renderEditForm(isZh) {
  const e = _editing;
  const isEdit = !e.isNew;
  const transport = e.config.transport || 'stdio';

  return [
    '<div class="settings-section">',
    '  <div class="settings-section-title">' + (isZh ? (isEdit ? '编辑服务器' : '添加服务器') : (isEdit ? 'Edit Server' : 'Add Server')) + '</div>',
    '  <div class="settings-field">',
    '    <label>' + (isZh ? '服务器 ID' : 'Server ID') + '</label>',
    '    <input type="text" id="gateway-edit-id" class="settings-input" value="' + escapeHtml(e.id) + '" placeholder="filesystem" ' + (isEdit ? 'readonly' : '') + ' />',
    '  </div>',
    '  <div class="settings-field">',
    '    <label>' + (isZh ? '传输类型' : 'Transport') + '</label>',
    '    <select id="gateway-edit-transport" class="settings-input" onchange="_gatewayTransportChange()">',
    '      <option value="stdio"' + (transport === 'stdio' ? ' selected' : '') + '>stdio</option>',
    '      <option value="http"' + (transport === 'http' ? ' selected' : '') + '>HTTP (StreamableHTTP)</option>',
    '      <option value="sse"' + (transport === 'sse' ? ' selected' : '') + '>SSE</option>',
    '    </select>',
    '  </div>',
    '  <div id="gateway-edit-dynamic" style="display:flex;flex-direction:column;gap:12px;">',
    _renderEditFields(transport, e.config),
    '  </div>',
    '</div>',
  ].join('');
}

// ── Main render ───────────────────────────────────────────────────

function renderGatewayOverlay() {
  const host = _ensureGatewayHost();
  if (!_gatewayOpen) { host.innerHTML = ''; return; }

  const isZh = currentLanguage === 'zh';
  const systemServers = _gatewayData?.systemServers || [];
  const servers = _gatewayData?.servers || [];

  // Determine header + content + footer based on view
  let title, titleHtml, subtitle, scrollContent, footerButtons;

  if (_view === 'detail') {
    const d = _detail;
    const detailName = d?.name || d?.id || '';
    const dotClass = d ? _statusDotClass(d.status) : '';
    const badgeText = d?.isSystem ? (isZh ? '系统' : 'System') : (isZh ? '自定义' : 'Custom');
    title = detailName || (isZh ? 'MCP 详情' : 'MCP Detail');
    subtitle = '';
    // Build header HTML: status dot → name → status text → type badge
    if (d) {
      const statusLabel = {
        connected: isZh ? '已连接' : 'Connected',
        connecting: isZh ? '连接中' : 'Connecting',
        error: isZh ? '错误' : 'Error',
        disconnected: isZh ? '未连接' : 'Disconnected',
      }[d.status] || d.status;
      titleHtml = '<span class="settings-preset-dot ' + dotClass + '"></span>'
        + '<span style="margin-left:8px;">' + escapeHtml(title) + '</span>'
        + '<span class="gateway-status-text ' + d.status + '" style="margin-left:10px;">' + statusLabel + '</span>'
        + '<span class="gateway-detail-type-badge" style="margin-left:8px;">' + badgeText + '</span>';
    }
    scrollContent = _renderDetailView(isZh);
    footerButtons = [
      '<div class="settings-actions">',
      '  <button class="settings-btn settings-btn-secondary" type="button" onclick="_gatewayRefreshDetail()">' + SVG_REFRESH + (isZh ? ' 刷新' : ' Refresh') + '</button>',
      '  <button class="settings-btn settings-btn-primary" type="button" onclick="_gatewayBackToList()">' + (isZh ? '返回列表' : 'Back to List') + '</button>',
      '</div>',
    ].join('');

  } else if (_view === 'edit') {
    const isEdit = !_editing?.isNew;
    title = isZh ? (isEdit ? '编辑服务器' : '添加服务器') : (isEdit ? 'Edit Server' : 'Add Server');
    subtitle = '';
    scrollContent = _renderEditForm(isZh);
    footerButtons = [
      '<div class="settings-actions">',
      '  <button class="settings-btn settings-btn-secondary" type="button" onclick="_gatewayCancelEdit()">' + (isZh ? '取消' : 'Cancel') + '</button>',
      '  <button class="settings-btn settings-btn-primary" type="button" onclick="_gatewaySaveEdit()">' + (isZh ? '保存' : 'Save') + '</button>',
      '</div>',
    ].join('');

  } else {
    // List view
    title = isZh ? 'MCP 网关' : 'MCP Gateway';
    subtitle = isZh ? '集中托管共享 MCP 服务器，所有会话复用同一连接' : 'Centrally hosted MCP servers, shared across all sessions';
    footerButtons = [
      '<div class="settings-actions">',
      '  <button class="settings-btn settings-btn-secondary" type="button" onclick="_loadGatewayData()">' + SVG_REFRESH + (isZh ? ' 刷新' : ' Refresh') + '</button>',
      '  <button class="settings-btn settings-btn-primary" type="button" onclick="_gatewayAdd()">+ ' + (isZh ? '添加服务器' : 'Add Server') + '</button>',
      '</div>',
    ].join('');

    if (_loading && !systemServers.length && !servers.length) {
      scrollContent = '<div class="gateway-list-empty">' + (isZh ? '加载中…' : 'Loading…') + '</div>';
    } else {
      scrollContent = [
        _renderSystemSection(systemServers, isZh),
        _renderCustomSection(servers, isZh),
      ].join('');
    }
  }

  // Header with optional back button
  let headerLeft = '';
  if (_view === 'detail' || _view === 'edit') {
    headerLeft = '<button class="feature-detail-close" type="button" title="' + (isZh ? '返回' : 'Back') + '" onclick="' + (_view === 'detail' ? '_gatewayBackToList()' : '_gatewayCancelEdit()') + '" style="margin-right:8px;font-size:16px;">' + SVG_BACK + '</button>';
  }

  host.innerHTML = [
    '<div class="feature-detail-overlay">',
    '  <div class="feature-detail-window" style="width:min(100%,600px);height:min(100%,660px);overflow:hidden;display:flex;flex-direction:column;">',
    '    <div class="feature-detail-head">',
    '      <div style="display:flex;align-items:center;gap:4px;">',
    headerLeft,
    '        <div>',
    '          <div class="feature-detail-title">' + (titleHtml || escapeHtml(title)) + '</div>',
    subtitle ? '          <div class="feature-detail-subtitle">' + escapeHtml(subtitle) + '</div>' : '',
    '        </div>',
    '      </div>',
    '      <button class="feature-detail-close" type="button" title="' + (isZh ? '关闭' : 'Close') + '" onclick="closeMcpGateway()">×</button>',
    '    </div>',
    '    <div class="settings-tab-content">',
    scrollContent,
    '    </div>',
    '    <div class="settings-footer">',
    footerButtons,
    '    </div>',
    '  </div>',
    '</div>',
  ].join('');
}
