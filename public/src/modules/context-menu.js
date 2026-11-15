// context-menu.js
// Phase 2c-3: 上下文菜单功能（Domain P）
// 从 app-ui.js 提取的 8 个右键菜单函数
// （会话菜单已退役：会话右键统一走 ctx-menu-items.js 声明式菜单，ADR-0049）

// ── 关闭函数 ──────────────────────────────────────────────

function closeAgentContextMenu() {
  agentContextMenu.classList.remove('open');
  contextMenuAgentId = null;
  contextMenuAgentMode = null;
}

function closeProjectContextMenu() {
  projectContextMenu.classList.remove('open');
  contextMenuProjectAgentId = null;
  contextMenuProjectId = null;
}

function closeFeatureRepoContextMenu() {
  featureRepoContextMenu.classList.remove('open');
  contextMenuFeatureRepoPackageId = null;
}

function closeCompactMenu() {
  compactContextMenu.classList.remove('open');
  contextMenuCompactAction = null;
}

// ── 打开函数 ──────────────────────────────────────────────

function openCompactMenu(action, x, y) {
  closeAgentContextMenu();
  closeProjectContextMenu();
  contextMenuCompactAction = action;

  const margin = 8;
  compactContextMenu.classList.add('open');
  compactContextMenu.style.left = '0px';
  compactContextMenu.style.top = '0px';

  const rect = compactContextMenu.getBoundingClientRect();
  const maxLeft = window.innerWidth - rect.width - margin;
  const maxTop = window.innerHeight - rect.height - margin;
  compactContextMenu.style.left = Math.max(margin, Math.min(x, maxLeft)) + 'px';
  compactContextMenu.style.top = Math.max(margin, Math.min(y, maxTop)) + 'px';
}

function openFeatureRepoContextMenu(packageId, x, y) {
  closeAgentContextMenu();
  closeProjectContextMenu();
  contextMenuFeatureRepoPackageId = packageId;

  const margin = 8;
  featureRepoContextMenu.classList.add('open');
  featureRepoContextMenu.style.left = '0px';
  featureRepoContextMenu.style.top = '0px';

  const rect = featureRepoContextMenu.getBoundingClientRect();
  const maxLeft = window.innerWidth - rect.width - margin;
  const maxTop = window.innerHeight - rect.height - margin;
  featureRepoContextMenu.style.left = Math.max(margin, Math.min(x, maxLeft)) + 'px';
  featureRepoContextMenu.style.top = Math.max(margin, Math.min(y, maxTop)) + 'px';
}

function openProjectContextMenu(agentId, projectId, x, y) {
  closeAgentContextMenu();
  contextMenuProjectAgentId = agentId;
  contextMenuProjectId = projectId;

  const margin = 8;
  projectContextMenu.classList.add('open');
  projectContextMenu.style.left = '0px';
  projectContextMenu.style.top = '0px';

  const rect = projectContextMenu.getBoundingClientRect();
  const maxLeft = window.innerWidth - rect.width - margin;
  const maxTop = window.innerHeight - rect.height - margin;
  projectContextMenu.style.left = Math.max(margin, Math.min(x, maxLeft)) + 'px';
  projectContextMenu.style.top = Math.max(margin, Math.min(y, maxTop)) + 'px';
}

function openAgentContextMenu(agentId, x, y, mode) {
  closeProjectContextMenu();
  contextMenuAgentId = agentId;
  contextMenuAgentMode = mode || null;
  const showRuntimeActions = mode === 'prebuilt-runtime' || mode === 'external-runtime' || mode === 'child-runtime';

  restartAgentAction.style.display = showRuntimeActions ? '' : 'none';
  restartAgentAction.disabled = !showRuntimeActions;
  stopAgentAction.style.display = showRuntimeActions ? '' : 'none';
  stopAgentAction.disabled = !showRuntimeActions;
  deleteAgentAction.style.display = mode === 'delete-only' ? '' : 'none';
  deleteAgentAction.disabled = mode !== 'delete-only';

  const margin = 8;
  agentContextMenu.classList.add('open');
  agentContextMenu.style.left = '0px';
  agentContextMenu.style.top = '0px';

  const rect = agentContextMenu.getBoundingClientRect();
  const maxLeft = window.innerWidth - rect.width - margin;
  const maxTop = window.innerHeight - rect.height - margin;
  agentContextMenu.style.left = Math.max(margin, Math.min(x, maxLeft)) + 'px';
  agentContextMenu.style.top = Math.max(margin, Math.min(y, maxTop)) + 'px';
}
