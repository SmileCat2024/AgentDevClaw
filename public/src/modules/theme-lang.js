// theme-lang.js
// Phase 2d-3: 主题 / 语言 / 连接状态（Domain O-c）
// 从 app-ui.js 提取的主题切换、语言切换和连接状态函数

function setConnectionStatus(connected) {
  statusBadge.textContent = connected ? t('status_connected') : t('status_disconnected');
  statusBadge.classList.toggle('disconnected', !connected);
}

function showAgentStartError(error) {
  const message = error && error.message ? error.message : String(error || '');
  statusBadge.textContent = t('status_start_failed');
  statusBadge.classList.add('disconnected');
  window.alert(`${t('status_start_failed')}: ${message}`);
}

function renderThemeToggle() {
  const isLight = currentTheme === 'light';
  themeToggle.title = isLight ? t('theme_toggle_dark') : t('theme_toggle_light');
  themeToggle.innerHTML = isLight
    ? '<svg id="theme-toggle-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v2.2M12 19.8V22M4.93 4.93l1.56 1.56M17.51 17.51l1.56 1.56M2 12h2.2M19.8 12H22M4.93 19.07l1.56-1.56M17.51 6.49l1.56-1.56"></path></svg>'
    : '<svg id="theme-toggle-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"></path></svg>';
}

function applyLanguage() {
  localStorage.setItem('agentdev-language', currentLanguage);
  document.title = t('page_title');

  const sidebarToggleEl = document.getElementById('sidebar-toggle');
  const workspaceButton = document.getElementById('rail-workspace');
  const planButton = document.getElementById('rail-plan');
  const monitorButton = document.getElementById('rail-monitor');
  const hooksButton = document.getElementById('rail-hooks');
  const inspectorButton = document.getElementById('rail-inspector');
  const logsButton = document.getElementById('rail-logs');
  const mcpButton = document.getElementById('rail-mcp');
  const resourcesButton = document.getElementById('rail-resources');
  const viewerButton = document.getElementById('rail-viewer');

  if (sidebarToggleEl) sidebarToggleEl.title = t('sidebar_toggle');
  if (workspaceButton) workspaceButton.title = t('structure_tooltip');
  if (planButton) planButton.title = t('plan_tooltip');
  if (monitorButton) monitorButton.title = t('monitor_tooltip');
  if (hooksButton) hooksButton.title = t('features_tooltip');
  if (inspectorButton) inspectorButton.title = t('reverse_hooks_tooltip');
  if (logsButton) logsButton.title = t('logs_tooltip');
  if (mcpButton) mcpButton.title = t('mcp_tooltip');
  if (resourcesButton) resourcesButton.title = '资料';
  if (viewerButton) viewerButton.title = '文档';
  const settingsConfigItem = document.getElementById('settings-flyout-config');
  const settingsRemoteItem = document.getElementById('settings-flyout-remote');
  const settingsRemoteServersItem = document.getElementById('settings-flyout-remote-servers');
  const settingsUsageItem = document.getElementById('settings-flyout-usage');
  const settingsExitItem = document.getElementById('settings-flyout-exit');
  if (settingsConfigItem) settingsConfigItem.textContent = currentLanguage === 'zh' ? '模型配置' : 'Model settings';
  if (settingsRemoteItem) settingsRemoteItem.textContent = currentLanguage === 'zh' ? '远程连接' : 'Remote connection';
  if (settingsRemoteServersItem) settingsRemoteServersItem.textContent = t('rcon_flyout_servers');
  if (settingsUsageItem) settingsUsageItem.textContent = currentLanguage === 'zh' ? '用量信息' : 'Usage';
  if (settingsExitItem) settingsExitItem.textContent = currentLanguage === 'zh' ? '退出程序' : 'Quit';

  if (typeof updateNotificationStatus === 'function' && typeof lastNotificationStatusPayload !== 'undefined' && lastNotificationStatusPayload) {
    updateNotificationStatus(lastNotificationStatusPayload);
  }

  if (typeof renderBrandCard === 'function') {
    renderBrandCard();
  }

  languageToggle.title = t('language_toggle');
  languageToggle.textContent = t('language_toggle_short');
  restartAgentAction.textContent = t('restart_agent_runtime');
  stopAgentAction.textContent = t('close_agent_runtime');
  deleteAgentAction.textContent = t('delete_agent');
  openSessionAction.textContent = currentLanguage === 'zh' ? '进入对话' : 'Enter Chat';
  compactedResumeSessionAction.textContent = t('workspace_light_resume');
  if (archiveSessionAction) {
    archiveSessionAction.textContent = currentLanguage === 'zh' ? '归档会话' : 'Archive';
  }
  deleteSessionAction.textContent = t('delete_session');
  deleteProjectAction.textContent = t('delete_project');

  renderThemeToggle();
  renderAgentList();
  renderFeaturePanel();

  if (typeof updateCurrentAgentChrome === 'function') {
    updateCurrentAgentChrome();
  } else if (!focusedAgentId) {
    currentAgentTitle.textContent = t('page_title');
    statusBadge.textContent = t('status_no_agent');
  }

  renderCurrentMainView();
}

function applyTheme(theme) {
  currentTheme = theme === 'light' ? 'light' : 'dark';
  document.body.dataset.theme = currentTheme;
  localStorage.setItem('agentdev-theme', currentTheme);
  renderThemeToggle();
}
