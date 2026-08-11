/**
 * todo-plan.js — Todo Plan 渲染模块（从 app-ui.js 提取）
 *
 * 包含：
 *   - getEmptyTodoPlan, normalizeTodoPlan, getTodoPlanSignature
 *   - setCurrentTodoPlan, updatePlanBadge
 *   - getTodoStatusLabel, renderPlanTask, renderPlanPanel
 *   - sendTodoControl (TODO 中断控制)
 *   - featurePanelBody click 事件监听器（中断按钮交互）
 *
 * 依赖（全局变量/函数，声明于 app-core.js / app-ui.js / 其他模块）：
 *   - currentTodoPlan, currentTodoPlanSignature (app-core.js)
 *   - getInterruptTargetId, setInterruptTargetId (app-core.js)
 *   - featurePanelBody (app-core.js)
 *   - currentRuntimeAgentId, currentAgentId, allAgents (app-core.js / app-main.js)
 *   - activeFeaturePanel (app-core.js)
 *   - renderFeaturePanel (debug-panel-host.js)
 *   - escapeHtml, t, currentLanguage (app-core.js)
 */

function getEmptyTodoPlan() {
  return {
    feature: 'todo',
    updatedAt: 0,
    counter: 0,
    tasks: [],
    summary: { total: 0, pending: 0, inProgress: 0, completed: 0, cancelled: 0 },
  };
}

function normalizeTodoPlan(snapshot) {
  const empty = getEmptyTodoPlan();
  if (!snapshot || typeof snapshot !== 'object') return empty;
  const tasks = Array.isArray(snapshot.tasks) ? snapshot.tasks.map(task => ({
    id: String(task?.id || ''),
    subject: String(task?.subject || ''),
    description: String(task?.description || ''),
    status: ['pending', 'in_progress', 'completed', 'deleted'].includes(task?.status) ? task.status : 'pending',
    metadata: task?.metadata && typeof task.metadata === 'object' ? task.metadata : {},
    createdAt: typeof task?.createdAt === 'number' ? task.createdAt : 0,
    updatedAt: typeof task?.updatedAt === 'number' ? task.updatedAt : 0,
  })).filter(task => task.id) : [];
  const summary = snapshot.summary || {};
  return {
    feature: 'todo',
    updatedAt: typeof snapshot.updatedAt === 'number' ? snapshot.updatedAt : 0,
    counter: typeof snapshot.counter === 'number' ? snapshot.counter : tasks.length,
    tasks,
    summary: {
      total: typeof summary.total === 'number' ? summary.total : tasks.length,
      pending: typeof summary.pending === 'number' ? summary.pending : tasks.filter(task => task.status === 'pending').length,
      inProgress: typeof summary.inProgress === 'number' ? summary.inProgress : tasks.filter(task => task.status === 'in_progress').length,
      completed: typeof summary.completed === 'number' ? summary.completed : tasks.filter(task => task.status === 'completed').length,
      cancelled: typeof summary.cancelled === 'number' ? summary.cancelled : tasks.filter(task => task.status === 'deleted').length,
    },
    interruptTargetId: typeof snapshot.interruptTargetId === 'string' ? snapshot.interruptTargetId : null,
  };
}

function getTodoPlanSignature(snapshot) {
  return JSON.stringify(normalizeTodoPlan(snapshot));
}

function setCurrentTodoPlan(snapshot) {
  const normalized = normalizeTodoPlan(snapshot);
  currentTodoPlan = normalized;
  currentTodoPlanSignature = getTodoPlanSignature(normalized);
  updatePlanBadge();
}

function updatePlanBadge() {
  const badge = document.getElementById('rail-plan-badge');
  if (!badge) return;
  const tasks = Array.isArray(currentTodoPlan?.tasks) ? currentTodoPlan.tasks : [];
  const incomplete = tasks.filter(t => t.status === 'pending' || t.status === 'in_progress').length;
  if (incomplete > 0) {
    badge.textContent = incomplete > 99 ? '99+' : String(incomplete);
    badge.classList.add('visible');
  } else {
    badge.classList.remove('visible');
    badge.textContent = '';
  }
}

// [Phase 2f-2] Usage/Token 渲染 + 日志面板 + MCP 面板 + 生命周期选择器 + Summary + Upload + 结构/监控/特性/Hook 面板 + renderFeaturePanel → modules/debug-panels.js

function getTodoStatusLabel(status) {
  const labels = {
    pending: t('plan_pending'),
    in_progress: t('plan_in_progress'),
    completed: t('plan_completed'),
    deleted: t('plan_cancelled'),
  };
  return labels[status] || status || t('metric_unavailable');
}

function renderPlanTask(task) {
  const status = String(task?.status || 'pending');
  const isTerminal = status === 'completed' || status === 'deleted';
  const taskId = String(task?.id || '');
  const isInterruptTarget = !isTerminal && getInterruptTargetId() === taskId;
  const meta = [
    '#' + escapeHtml(taskId),
    getTodoStatusLabel(status),
  ].filter(Boolean).join(' · ');
  const detail = isTerminal ? '' : (task?.description || '');
  const marker = status === 'in_progress'
    ? '<div class="plan-task-spinner"></div>'
    : '<div class="plan-task-dot"></div>';
  const actionBtn = isTerminal ? '' : (isInterruptTarget
    ? '<button class="plan-task-action" data-todo-interrupt data-action="cancel" data-task-id="' + escapeHtml(taskId) + '">' + (currentLanguage === 'zh' ? '取消停止' : 'Cancel stop') + '</button>'
    : '<button class="plan-task-action" data-todo-interrupt data-action="set" data-task-id="' + escapeHtml(taskId) + '">' + (currentLanguage === 'zh' ? '完成后停止' : 'Stop after done') + '</button>');
  const interruptLabel = isInterruptTarget ? '<span class="plan-task-interrupt-label">' + (currentLanguage === 'zh' ? '停止点' : 'Stop point') + '</span>' : '';
  return [
    '<article class="plan-task status-' + escapeHtml(status.replace(/[^a-z0-9_-]/gi, '-')) + (isTerminal ? ' is-terminal' : '') + (isInterruptTarget ? ' is-interrupt-target' : '') + '">',
    '<div class="plan-task-marker">' + marker + '</div>',
    '<div class="plan-task-main">',
    '<div class="plan-task-title">' + escapeHtml(task?.subject || '') + interruptLabel + '</div>',
    detail ? '<div class="plan-task-desc">' + escapeHtml(detail) + '</div>' : '',
    isTerminal ? '' : '<div class="plan-task-meta">' + escapeHtml(meta) + '</div>',
    actionBtn,
    '</div>',
    '</article>',
  ].join('');
}

function renderPlanPanel() {
  const plan = currentTodoPlan || {};
  const tasks = Array.isArray(plan.tasks) ? plan.tasks : [];
  const summary = plan.summary || {};
  const stats = [
    [t('plan_total'), summary.total ?? tasks.length],
    [t('plan_in_progress'), summary.inProgress ?? tasks.filter(task => task.status === 'in_progress').length],
    [t('plan_pending'), summary.pending ?? tasks.filter(task => task.status === 'pending').length],
    [t('plan_completed'), summary.completed ?? tasks.filter(task => task.status === 'completed').length],
    [t('plan_cancelled'), summary.cancelled ?? tasks.filter(task => task.status === 'deleted').length],
  ];

  if (tasks.length === 0) {
    return [
      '<div class="plan-panel">',
      '<section class="plan-summary">',
      '<div class="plan-summary-line">',
      stats.map(([label, value]) => '<span><strong>' + escapeHtml(String(value)) + '</strong> ' + escapeHtml(label) + '</span>').join(''),
      '</div>',
      '</section>',
      '<div class="plan-empty">',
      '<div class="plan-empty-title">' + escapeHtml(t('plan_empty')) + '</div>',
      '<div class="plan-empty-desc">' + escapeHtml(t('plan_empty_desc')) + '</div>',
      '</div>',
      '</div>',
    ].join('');
  }

  return [
    '<div class="plan-panel">',
    '<section class="plan-summary">',
    '<div class="plan-summary-line">',
    stats.map(([label, value]) => '<span><strong>' + escapeHtml(String(value)) + '</strong> ' + escapeHtml(label) + '</span>').join(''),
    '</div>',
    '</section>',
    '<section class="plan-task-list">',
    tasks.map(task => renderPlanTask(task)).join(''),
    '</section>',
    '</div>',
  ].join('');
}

// ── TODO 中断控制（完成后停止）──────────────────────────────────

async function sendTodoControl(taskId) {
  if (!currentRuntimeAgentId) return;
  // 用 runtime_session_id 精确匹配当前 session 条目，
  // 不再用 OR find（会误匹配 workspace host 条目，拿到错误的 active session）
  const sessionId = getRuntimeWorkspaceSessionId(currentRuntimeAgentId) || undefined;
  try {
    await fetch('/protoclaw/todo_control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: currentAgentId, sessionId, taskId }),
    });
  } catch (e) {
    console.error('[TodoControl] request failed:', e);
  }
}

featurePanelBody.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-todo-interrupt]');
  if (!btn) return;
  e.preventDefault();
  e.stopPropagation();
  const action = btn.dataset.action;
  const taskId = btn.dataset.taskId;
  // 立即更新前端变量并重新渲染
  setInterruptTargetId(action === 'set' ? taskId : null);
  _lastInterruptUserActionAt = Date.now();
  if (activeFeaturePanel === 'plan') {
    renderFeaturePanel();
  }
  if (action === 'set') {
    sendTodoControl(taskId);
  } else if (action === 'cancel') {
    sendTodoControl(null);
  }
});
