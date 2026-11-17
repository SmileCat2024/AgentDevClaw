/**
 * workspace-docset.js — 域 Q 的同步首屏边界（P2 W2-10 装配工作台批次）。
 *
 * 迁移结论（R1/R4 审计）：本域的可迁实现已移入 ESM 模块
 * [p2-w2-10-workspace-docset.js](p2-w2-10-workspace-docset.js)
 * （artifacts / project-docset 渲染、动作处理器、toggleProjectDocsetOverlay）。
 * 只剩 `updateProjectDocsetChrome` 与它的读取 helper `getCurrentProjectDocset`
 * 保留为**唯一 classic 实现**，因为 app-ui 的同步首屏调用链会不依赖 agent
 * 数据直接触达它：
 *
 *   app-main 顶层 `applyTheme(); applyLanguage();`（classic 加载期）
 *     → theme-lang.applyLanguage → renderCurrentMainView()
 *     → workspace 或 chat 空态分支都会执行 `updateProjectDocsetChrome(agent)`。
 *
 * 该调用发生在任何 deferred ESM 执行之前，且首屏 agent 为 null（allAgents 尚未
 * 加载）——此时函数只需读取「无 docset」分支：同步 DOM 引用、清零开合状态、
 * 隐藏 overlay。把实现推迟到 ESM 相会让首屏渲染抛 TypeError 并中断后续渲染，
 * 静默跳过又会让 docset 按钮状态错乱，两者都不可接受，故保留 classic。
 *
 * 非首屏分支（docset 存在、需要渲染内容）经 `window.renderProjectDocsetContent`
 * 转调 ESM 实现——该分支只有拿到 agent 的 workspace_data 才可能进入，而 agent
 * 数据在认证后加载（受 DOMContentLoaded → 静态 ESM 执行顺序保护），因此转调
 * 目标届时必然已就绪。
 *
 * 收敛条件：app-ui 渲染入口域迁入 ESM 后，`updateProjectDocsetChrome` 一并
 * import（本文件删除），`window.renderProjectDocsetContent` 反向转调同时消失。
 */

// ── 读取 helper（首屏分支与 ESM 实现共用；ESM 侧经 window 晚绑定）──

function getCurrentProjectDocset(agent = getCurrentAgentRecord()) {
  const workspaceData = agent?.workspace_data;
  if (!workspaceData || typeof workspaceData !== 'object') return null;
  const data = workspaceData['project-docset'];
  return data && typeof data === 'object' ? data : null;
}

// ── 首屏 chrome 同步（唯一 classic 实现）──

function updateProjectDocsetChrome(agent = getCurrentAgentRecord()) {
  if (!projectDocsetToggle || !projectDocsetOverlay || !projectDocsetSheet) return;
  const docset = getCurrentProjectDocset(agent);
  const canShowButton = Boolean(docset?.exists) && ensureUnitMode(agent) === 'chat';
  projectDocsetToggle.classList.toggle('hidden', !canShowButton);
  projectDocsetToggle.classList.toggle('active', canShowButton && currentProjectDocsetOpen);
  projectDocsetToggle.textContent = currentLanguage === 'zh' ? '项目文档' : 'Project Docs';

  if (!canShowButton) {
    currentProjectDocsetOpen = false;
    currentProjectRequirementEdit = null;
  }

  projectDocsetOverlay.classList.toggle('hidden', !(canShowButton && currentProjectDocsetOpen));
  if (!(canShowButton && currentProjectDocsetOpen)) {
    projectDocsetSheet.innerHTML = '';
    return;
  }

  const block = {
    id: 'project-docset',
    title: { zh: '项目文档集', en: 'Project Docset' },
    description: { zh: '当前项目的实时文档状态。', en: 'Live project documentation for the current conversation.' },
  };

  projectDocsetSheet.innerHTML = [
    '<div class="project-docset-sheet-head">',
    '<div>',
    '<div class="project-docset-sheet-title">' + escapeHtml(localizeWorkspaceValue(block.title, 'Project Docset')) + '</div>',
    '<div class="project-docset-sheet-subtitle">' + escapeHtml(String(docset?.projectDir || '')) + '</div>',
    '</div>',
    '<div class="workspace-actions"><button class="workspace-action secondary" type="button" data-action="wsDocset.overlayClose">关闭</button></div>',
    '</div>',
    '<div class="project-docset-sheet-body">',
    // 桥接期：实现于 p2-w2-10-workspace-docset.js（ESM）；该分支只在 agent 数据
    // 已加载时可达，晚于静态 ESM 执行。
    window.renderProjectDocsetContent(agent, block, docset),
    '</div>',
  ].join('');
}
