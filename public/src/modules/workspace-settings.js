/**
 * workspace-settings.js — 工作空间设置面板（用户 工作空间集 的呈现策略）
 *
 * 概念定位：工作空间是用户资产（可安装任意工作空间集，未来甚至可不装
 * 智能编码空间），本面板随用户工作空间集走，不是随 Claw 的系统设置。
 * 面板列出声明为 on-demand（附属程序）的工作空间，配置侧栏显示策略：
 *   - 自动（作者默认）：有运行中的会话才显示，会话全部结束即隐藏
 *   - 始终显示：常驻侧栏（入口消失后的找回路径）
 * 常规工作空间（persistent）始终显示，不上策略项。
 * 真相源在服务端（workspace-settings.json），保存走 PUT，前端刷新 wire
 * 后侧栏即时生效。
 *
 * 依赖（全局）：escapeHtml, currentLanguage, allAgents, loadAgents, renderAgentList
 */

function ensureWorkspaceSettingsHost() {
  let host = document.getElementById('workspace-settings-overlay-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'workspace-settings-overlay-host';
    document.body.appendChild(host);
  }
  return host;
}

function openWorkspaceSettings() {
  window.ClawFW.workspaceSettingsOpen = true;
  renderWorkspaceSettingsOverlay();
  loadWorkspaceSettingsPanel();
}

function closeWorkspaceSettings() {
  window.ClawFW.workspaceSettingsOpen = false;
  const host = document.getElementById('workspace-settings-overlay-host');
  if (host) host.innerHTML = '';
}

function renderWorkspaceSettingsOverlay() {
  const host = ensureWorkspaceSettingsHost();
  if (!window.ClawFW.workspaceSettingsOpen) {
    host.innerHTML = '';
    return;
  }
  const isZh = currentLanguage === 'zh';
  host.innerHTML = [
    '<div class="feature-detail-overlay">',
    '<div class="feature-detail-window" style="width:min(100%,520px);max-height:min(100%,640px);">',
    '<div class="feature-detail-head">',
    '<div>',
    '<div class="feature-detail-title">' + (isZh ? '工作空间' : 'Workspaces') + '</div>',
    '<div class="feature-detail-subtitle">' + (isZh ? '附属工作空间的侧栏显示策略' : 'Sidebar visibility for on-demand workspaces') + '</div>',
    '</div>',
    '<button class="feature-detail-close" type="button" title="' + (isZh ? '关闭' : 'Close') + '" onclick="closeWorkspaceSettings()">×</button>',
    '</div>',
    '<div id="workspace-settings-container" class="settings-tab-content"></div>',
    '</div>',
    '</div>',
  ].join('');
}

async function loadWorkspaceSettingsPanel() {
  const container = document.getElementById('workspace-settings-container');
  if (!container) return;
  const isZh = currentLanguage === 'zh';
  container.innerHTML = '<div class="proxy-info-text">' + (isZh ? '加载中...' : 'Loading...') + '</div>';

  const onDemandWorkspaces = (Array.isArray(allAgents) ? allAgents : [])
    .filter((agent) => agent?.source === 'prebuilt' && agent?.visibility === 'on-demand');
  if (onDemandWorkspaces.length === 0) {
    container.innerHTML = '<div class="proxy-info-text">'
      + (isZh ? '没有附属工作空间。' : 'No on-demand workspaces installed.')
      + '</div>';
    return;
  }

  let overrides = {};
  try {
    const res = await fetch('/protoclaw/workspace_settings');
    if (res.ok) {
      const data = await res.json();
      overrides = data?.workspaceVisibility && typeof data.workspaceVisibility === 'object'
        ? data.workspaceVisibility : {};
    }
  } catch { /* 读取失败按无覆盖（作者默认）渲染 */ }

  const rows = onDemandWorkspaces.map((agent) => {
    const policy = overrides[agent.id] === 'always' ? 'always' : 'auto';
    return [
      '<div class="proxy-toggle-row" style="align-items:center;">',
      '<div class="proxy-toggle-label">',
      '<div>' + escapeHtml(agent.name || agent.id) + '</div>',
      '<div style="font-size:12px;color:var(--text-secondary);">' + escapeHtml(agent.description || agent.id) + '</div>',
      '</div>',
      '<select class="settings-input" data-claw-select style="min-width:140px;" onchange="onWorkspaceVisibilityChange(\'' + escapeHtml(agent.id) + '\', this.value)">',
      '<option value="auto"' + (policy === 'auto' ? ' selected' : '') + '>' + (isZh ? '自动（有会话运行时显示）' : 'Auto (visible while running)') + '</option>',
      '<option value="always"' + (policy === 'always' ? ' selected' : '') + '>' + (isZh ? '始终显示' : 'Always visible') + '</option>',
      '</select>',
      '</div>',
    ].join('');
  }).join('');

  container.innerHTML = [
    '<div class="proxy-info-text">',
    isZh
      ? '附属工作空间默认有会话运行时才出现在侧栏；会话全部结束后入口隐藏，可在此改为始终显示。'
      : 'On-demand workspaces appear in the sidebar only while they have running sessions. When all sessions end the entry hides; switch it to always visible here.',
    '</div>',
    rows,
    '<div id="workspace-settings-status"></div>',
  ].join('');

  if (window.ClawSelect) window.ClawSelect.enhanceAll(container);
}

window.onWorkspaceVisibilityChange = async function(agentId, policy) {
  const isZh = currentLanguage === 'zh';
  const statusEl = document.getElementById('workspace-settings-status');
  const setStatus = (text) => {
    if (statusEl) statusEl.innerHTML = '<div class="proxy-status-row proxy-status-loading"><span class="proxy-status-text">' + escapeHtml(text) + '</span></div>';
  };
  setStatus(isZh ? '正在保存...' : 'Saving...');
  try {
    const res = await fetch('/protoclaw/workspace_settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId, policy }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data?.error || ('HTTP ' + res.status));
    }
    // 刷新 wire（服务端合流的 sidebarVisible 随之更新），侧栏即时生效。
    await loadAgents();
    renderAgentList();
    setStatus(isZh ? '已保存' : 'Saved');
  } catch (error) {
    console.error('[workspace-settings] save failed:', error);
    setStatus((isZh ? '保存失败：' : 'Save failed: ') + (error?.message || error));
  }
};

// ── window 导出 ──────────────────────────────────────────────
window.openWorkspaceSettings = openWorkspaceSettings;
window.closeWorkspaceSettings = closeWorkspaceSettings;
