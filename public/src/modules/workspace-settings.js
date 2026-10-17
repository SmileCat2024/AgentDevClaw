/**
 * workspace-settings.js — 工作空间设置面板（用户 工作空间集 的呈现策略与资源策略）
 *
 * 概念定位：工作空间是用户资产（可安装任意工作空间集，未来甚至可不装
 * 智能编码空间），本面板随用户工作空间集走，不是随 Claw 的系统设置。
 * 面板列出声明为 on-demand（附属程序）的工作空间，逐条配置：
 *   - 侧栏显示策略：自动（作者默认，有存活且绑定会话的 Runtime 才显示）/
 *     始终显示（常驻侧栏，入口消失后的找回路径）
 *   - runtime 并发上限（ADR-0027）：同时存活的 runtime 子进程数上限；
 *     留空 = 不限制（缺省）。已存活超上限不追溯击杀，随归档/接续收敛。
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
    '<div class="feature-detail-subtitle">' + (isZh ? '附属工作空间的显示与资源策略' : 'Visibility & resource policies for on-demand workspaces') + '</div>',
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
  let resourcePolicies = {};
  let liveRuntimes = {};
  try {
    const res = await fetch('/protoclaw/workspace_settings');
    if (res.ok) {
      const data = await res.json();
      overrides = data?.workspaceVisibility && typeof data.workspaceVisibility === 'object'
        ? data.workspaceVisibility : {};
      resourcePolicies = data?.resourcePolicy && typeof data.resourcePolicy === 'object'
        ? data.resourcePolicy : {};
      liveRuntimes = data?.liveRuntimes && typeof data.liveRuntimes === 'object'
        ? data.liveRuntimes : {};
    }
  } catch { /* 读取失败按无覆盖（作者默认）渲染 */ }

  const rows = onDemandWorkspaces.map((agent) => {
    const policy = overrides[agent.id] === 'always' ? 'always' : 'auto';
    const canConfigureRuntimeQuota = Array.isArray(agent.permissions)
      && agent.permissions.includes('maxLiveRuntimes');
    const quotaLimit = resourcePolicies[agent.id]?.maxLiveRuntimes;
    const quotaValue = Number.isInteger(quotaLimit) && quotaLimit > 0 ? String(quotaLimit) : '';
    const liveCount = Number.isInteger(liveRuntimes[agent.id]) ? liveRuntimes[agent.id] : 0;
    // 存量豁免的可视化（ADR-0027 §5）：配额低于当前存活数时如实提示，
    // 已存活的不会被击杀，随归档/接续自然收敛到上限内。
    const overLimit = quotaValue !== '' && liveCount > quotaLimit;
    return [
      '<div class="proxy-toggle-row" style="align-items:center;flex-wrap:wrap;gap:8px;">',
      '<div class="proxy-toggle-label">',
      '<div>' + escapeHtml(agent.name || agent.id) + '</div>',
      '<div style="font-size:12px;color:var(--text-secondary);">' + escapeHtml(agent.description || agent.id) + '</div>',
      '</div>',
      '<select class="settings-input" data-claw-select style="min-width:140px;" onchange="onWorkspaceVisibilityChange(\'' + escapeHtml(agent.id) + '\', this.value)">',
      '<option value="auto"' + (policy === 'auto' ? ' selected' : '') + '>' + (isZh ? '自动（有会话运行时显示）' : 'Auto (visible while running)') + '</option>',
      '<option value="always"' + (policy === 'always' ? ' selected' : '') + '>' + (isZh ? '始终显示' : 'Always visible') + '</option>',
      '</select>',
      '</div>',
      canConfigureRuntimeQuota ? [
        '<div class="proxy-toggle-row" style="align-items:center;flex-wrap:wrap;gap:8px;">',
        '<div class="proxy-toggle-label">',
        '<div>' + (isZh ? 'runtime 并发上限' : 'Runtime concurrency limit') + '</div>',
        '<div style="font-size:12px;color:' + (overLimit ? 'var(--status-warning, #d29922)' : 'var(--text-secondary)') + ';">'
          + (isZh
            ? (overLimit
              ? '当前 ' + liveCount + ' 个运行中，已超上限 ' + quotaLimit + '——存量不追溯，随归档收敛'
              : '当前 ' + liveCount + ' 个运行中 · 留空不限制')
            : (overLimit
              ? liveCount + ' running, over limit ' + quotaLimit + ' — existing ones stay until archived'
              : liveCount + ' running · empty for unlimited'))
          + '</div>',
        '</div>',
        '<input type="number" min="1" step="1" class="settings-input" style="min-width:110px;" placeholder="' + (isZh ? '不限制' : 'Unlimited') + '" value="' + quotaValue + '" onchange="onWorkspaceQuotaChange(\'' + escapeHtml(agent.id) + '\', this.value)">',
        '</div>',
      ].join('') : '',
    ].join('');
  }).join('<div style="height:6px;"></div>');

  container.innerHTML = [
    '<div class="proxy-info-text">',
    isZh
      ? '附属工作空间默认有会话运行时才出现在侧栏；并发上限限制该工作空间同时存活的 runtime 子进程数（超限时新派发被拒，已有线程不受影响）。'
      : 'On-demand workspaces appear in the sidebar only while they have running sessions. The concurrency limit caps simultaneously live runtime processes (new spawns are rejected at the limit; existing threads are unaffected).',
    '</div>',
    rows,
    renderNotificationAuditSection(isZh, resourcePolicies),
    '<div id="workspace-settings-status"></div>',
  ].join('');

  if (window.ClawSelect) window.ClawSelect.enhanceAll(container);
}

// ── 通知权限只读审计（ADR-0030）──────────────────────────────────────
// 编辑位置在各 APP 的设置页（editingSurface，ADR-0027「编辑位置迁就业务
// 语义，知情权不迁就」），全局面板只保留知情权：逐 workspace 展示声明的
// 通知权限项与当前生效值（判定链 = 用户覆盖 > 作者默认 > false）。
// 无编辑控件；maxLiveRuntimes 现有编辑能力不动。
const NOTIFICATION_AUDIT_ITEMS = [
  { permissionId: 'notifications.finish', labelZh: '完成通知', labelEn: 'Finished runs' },
  { permissionId: 'notifications.input', labelZh: '输入请求', labelEn: 'Input requests' },
  { permissionId: 'notifications.reminder', labelZh: '提醒', labelEn: 'Reminders' },
];

function renderNotificationAuditSection(isZh, resourcePolicies) {
  const agents = (Array.isArray(allAgents) ? allAgents : [])
    .filter((agent) => agent?.source === 'prebuilt'
      && Array.isArray(agent.permissions)
      && agent.permissions.some((id) => String(id).indexOf('notifications.') === 0));
  if (agents.length === 0) return '';
  const rows = agents.map((agent) => {
    const defaults = agent.permissionDefaults && typeof agent.permissionDefaults === 'object'
      ? agent.permissionDefaults : {};
    const cells = NOTIFICATION_AUDIT_ITEMS
      .filter((item) => agent.permissions.includes(item.permissionId))
      .map((item) => {
        const userValue = resourcePolicies[agent.id]?.[item.permissionId];
        const authorDefault = typeof defaults[item.permissionId] === 'boolean'
          ? defaults[item.permissionId] : false;
        const effective = typeof userValue === 'boolean' ? userValue : authorDefault;
        const valueText = effective ? (isZh ? '开' : 'on') : (isZh ? '关' : 'off');
        const sourceText = typeof userValue === 'boolean'
          ? (isZh ? '自定义' : 'custom')
          : (isZh ? '默认' : 'default');
        return '<span style="font-size:12px;color:var(--text-secondary);">'
          + (isZh ? item.labelZh : item.labelEn) + '：' + valueText + '（' + sourceText + '）</span>';
      })
      .join('<span style="margin:0 8px;color:var(--border-color);">·</span>');
    return [
      '<div class="proxy-toggle-row" style="align-items:center;">',
      '<div class="proxy-toggle-label"><div>' + escapeHtml(agent.name || agent.id) + '</div></div>',
      '<div>' + cells + '</div>',
      '</div>',
    ].join('');
  }).join('<div style="height:6px;"></div>');
  return [
    '<div class="proxy-info-text" style="margin-top:12px;">',
    isZh
      ? '通知权限（只读）：编辑入口在各工作空间自己的设置页（设置 → 通知）。'
      : 'Notification permissions (read-only): edit them in each workspace\'s own settings page (Settings → Notifications).',
    '</div>',
    rows,
  ].join('');
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

// ADR-0027 配额保存：空 = 清除（不限制），正整数 = 上限；其他值就地报错
// 不提交。配额不影响侧栏显示（不刷新 wire），只影响内核后续 spawn 判定。
window.onWorkspaceQuotaChange = async function(agentId, rawValue) {
  const isZh = currentLanguage === 'zh';
  const statusEl = document.getElementById('workspace-settings-status');
  const setStatus = (text) => {
    if (statusEl) statusEl.innerHTML = '<div class="proxy-status-row proxy-status-loading"><span class="proxy-status-text">' + escapeHtml(text) + '</span></div>';
  };
  const trimmed = String(rawValue || '').trim();
  let maxLiveRuntimes = null;
  if (trimmed !== '') {
    const parsed = Number(trimmed);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      setStatus(isZh ? '并发上限须为正整数（留空 = 不限制），未保存。' : 'Concurrency limit must be a positive integer (empty = unlimited); not saved.');
      return;
    }
    maxLiveRuntimes = parsed;
  }
  setStatus(isZh ? '正在保存...' : 'Saving...');
  try {
    const res = await fetch('/protoclaw/workspace_settings/resource_policy', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId, permissionId: 'maxLiveRuntimes', value: maxLiveRuntimes }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data?.error || ('HTTP ' + res.status));
    }
    setStatus(isZh ? '已保存' : 'Saved');
    await loadWorkspaceSettingsPanel();
  } catch (error) {
    console.error('[workspace-settings] quota save failed:', error);
    setStatus((isZh ? '保存失败：' : 'Save failed: ') + (error?.message || error));
  }
};

// ── window 导出 ──────────────────────────────────────────────
window.openWorkspaceSettings = openWorkspaceSettings;
window.closeWorkspaceSettings = closeWorkspaceSettings;
