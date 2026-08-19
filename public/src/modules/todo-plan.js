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
    forceContinue: snapshot.forceContinue && typeof snapshot.forceContinue === 'object' ? {
      enabled: snapshot.forceContinue.enabled === true,
      consecutive: typeof snapshot.forceContinue.consecutive === 'number' ? snapshot.forceContinue.consecutive : 0,
      max: typeof snapshot.forceContinue.max === 'number' ? snapshot.forceContinue.max : 3,
    } : null,
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
  const desc = task?.description || '';
  // 所有终态任务默认收起详情，手动操作记录在
  // _planTerminalDetailState 中覆盖默认态（有描述才可交互）。
  const detailOpen = isTerminal
    ? (_planTerminalDetailState.has(taskId) ? _planTerminalDetailState.get(taskId) : false)
    : true;
  const canToggleDetail = isTerminal && desc;
  const detail = detailOpen ? desc : '';
  const marker = status === 'in_progress'
    ? '<div class="plan-task-spinner"></div>'
    : '<div class="plan-task-dot"></div>';
  const actionBtn = isTerminal ? '' : (isInterruptTarget
    ? '<button class="plan-task-action" data-todo-interrupt data-action="cancel" data-task-id="' + escapeHtml(taskId) + '">' + (currentLanguage === 'zh' ? '取消停止' : 'Cancel stop') + '</button>'
    : '<button class="plan-task-action" data-todo-interrupt data-action="set" data-task-id="' + escapeHtml(taskId) + '">' + (currentLanguage === 'zh' ? '完成后停止' : 'Stop after done') + '</button>');
  const interruptLabel = isInterruptTarget ? '<span class="plan-task-interrupt-label">' + (currentLanguage === 'zh' ? '停止点' : 'Stop point') + '</span>' : '';
  const detailChev = canToggleDetail
    ? '<span class="plan-task-detail-chev' + (detailOpen ? ' is-open' : '') + '" aria-hidden="true">▸</span>'
    : '';
  return [
    '<article class="plan-task status-' + escapeHtml(status.replace(/[^a-z0-9_-]/gi, '-')) + (isTerminal ? ' is-terminal' : '') + (isInterruptTarget ? ' is-interrupt-target' : '') + '"'
    + (canToggleDetail ? ' data-plan-task-detail="' + escapeHtml(taskId) + '"' : '') + '>',
    '<div class="plan-task-marker">' + marker + '</div>',
    '<div class="plan-task-main">',
    '<div class="plan-task-title">' + escapeHtml(task?.subject || '') + interruptLabel + detailChev + '</div>',
    detail ? '<div class="plan-task-desc">' + escapeHtml(detail) + '</div>' : '',
    (isTerminal && !detailOpen) ? '' : '<div class="plan-task-meta">' + escapeHtml(meta) + '</div>',
    actionBtn,
    '</div>',
    '</article>',
  ].join('');
}

// ── 已完成任务折叠 ──────────────────────────────────────────
// 任意位置的连续终态任务段（已完成/已取消）默认收起为一行按钮，
// 仅保留段尾最近 KEEP_VISIBLE_TERMINAL 个可见（刚完成的任务仍能看到）。
// 段长不足以产生折叠量时整段平铺。
const KEEP_VISIBLE_TERMINAL = 4;
// 已展开段的起始索引集合 + 终态任务详情手动覆盖态（taskId -> open）；
// 会话/运行时切换（_switchEpoch 递增）后回到默认态
let _planExpandedRuns = new Set();
let _planTerminalDetailState = new Map();
let _planFoldSwitchEpoch = null;

// 扫描连续终态段，返回 [{start, end}]（end exclusive）
function getTerminalRuns(tasks) {
  const runs = [];
  let start = -1;
  for (let i = 0; i < tasks.length; i++) {
    const status = String(tasks[i]?.status || 'pending');
    const terminal = status === 'completed' || status === 'deleted';
    if (terminal && start < 0) start = i;
    if (start >= 0 && (!terminal || i === tasks.length - 1)) {
      runs.push({ start, end: terminal ? i + 1 : i });
      start = -1;
    }
  }
  return runs;
}

function renderPlanFoldButton(foldCount, runStart, expanded) {
  return '<button class="plan-fold' + (expanded ? ' is-open' : '') + '" data-plan-toggle-run="' + String(runStart) + '">'
    + '<span class="plan-fold-chev" aria-hidden="true">▸</span>'
    + '<span>' + escapeHtml(t(expanded ? 'plan_fold_collapse' : 'plan_fold_expand').replace('{n}', String(foldCount))) + '</span>'
    + '</button>';
}

function renderPlanTaskList(tasks) {
  const runs = getTerminalRuns(tasks);
  const html = [];
  let runIdx = 0;
  for (let i = 0; i < tasks.length; i++) {
    const run = runs[runIdx];
    if (run && run.start === i) {
      const foldCount = run.end - run.start - KEEP_VISIBLE_TERMINAL;
      if (foldCount > 0) {
        const expanded = _planExpandedRuns.has(run.start);
        html.push(renderPlanFoldButton(expanded ? 0 : foldCount, run.start, expanded));
        // 折叠态只渲染段尾保留项；展开态整段平铺。按钮固定在段首，位置不随展开移动。
        const visibleFrom = expanded ? run.start : run.end - KEEP_VISIBLE_TERMINAL;
        for (let j = visibleFrom; j < run.end; j++) html.push(renderPlanTask(tasks[j]));
        i = run.end - 1;
        runIdx++;
        continue;
      }
    }
    html.push(renderPlanTask(tasks[i]));
    if (run && i === run.end - 1) runIdx++;
  }
  return html.join('');
}

// ── 任务未完自动继续开关 ─────────────────────────────────────────
// 状态以 app-core 的会话级缓存为准（乐观更新，app-main.js 从 server snapshot 同步），
// 开关复用 feature 面板的 .tool-toggle 组件样式。

function renderPlanForceContinueToggle() {
  const enabled = getTodoForceContinue();
  return [
    '<section class="plan-force-continue">',
    '<div class="plan-force-continue-main">',
    '<div class="plan-force-continue-label">' + escapeHtml(t('plan_force_continue')) + '</div>',
    '<div class="plan-force-continue-help">' + escapeHtml(t(enabled ? 'plan_force_continue_on' : 'plan_force_continue_off')) + '</div>',
    '</div>',
    '<label class="tool-toggle" title="' + escapeHtml(t('plan_force_continue_help')) + '">',
    '<input type="checkbox" class="tool-toggle-input" data-todo-force-continue' + (enabled ? ' checked' : '') + '>',
    '<span class="tool-toggle-slider"></span>',
    '</label>',
    '</section>',
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
      renderPlanForceContinueToggle(),
      '<div class="plan-empty">',
      '<div class="plan-empty-title">' + escapeHtml(t('plan_empty')) + '</div>',
      '<div class="plan-empty-desc">' + escapeHtml(t('plan_empty_desc')) + '</div>',
      '</div>',
      '</div>',
    ].join('');
  }

  // 会话/运行时切换（_switchEpoch 递增）后回到默认折叠
  if (_planFoldSwitchEpoch !== _switchEpoch) {
    _planFoldSwitchEpoch = _switchEpoch;
    _planExpandedRuns = new Set();
    _planTerminalDetailState = new Map();
  }

  return [
    '<div class="plan-panel">',
    '<section class="plan-summary">',
    '<div class="plan-summary-line">',
    stats.map(([label, value]) => '<span><strong>' + escapeHtml(String(value)) + '</strong> ' + escapeHtml(label) + '</span>').join(''),
    '</div>',
    '</section>',
    renderPlanForceContinueToggle(),
    '<section class="plan-task-list">',
    renderPlanTaskList(tasks),
    '</section>',
    '</div>',
  ].join('');
}

// ── TODO 中断控制（完成后停止）──────────────────────────────────

async function sendTodoControl(taskId) {
  if (!currentRuntimeAgentId) return;
  // runtimeId 优先（与轮询数据源 /api/agents/:id/todo 同一 id 空间，不会错位）；
  // sessionId 作为 fallback（getRuntimeWorkspaceSessionId 精确匹配当前 session 条目，
  // 不用 OR find —— 会误匹配 workspace host 条目拿到错误的 active session）
  const sessionId = getRuntimeWorkspaceSessionId(currentRuntimeAgentId) || undefined;
  try {
    await fetch('/protoclaw/todo_control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: currentAgentId, runtimeId: currentRuntimeAgentId, sessionId, taskId }),
    });
  } catch (e) {
    console.error('[TodoControl] request failed:', e);
  }
}

async function sendTodoForceContinue(enabled, { attempt = 0 } = {}) {
  if (!currentRuntimeAgentId) return false;
  const sessionId = getRuntimeWorkspaceSessionId(currentRuntimeAgentId) || undefined;
  try {
    const response = await fetch('/protoclaw/todo_control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // runtimeId 是主定位 id：与轮询数据源 /api/agents/:id/todo 的 :id 相同，
      // 开关显示哪个 runtime 的快照，控制就发往哪个 runtime，天然一致。
      // sessionId 仅作 runtimeId 失效时的 fallback。
      body: JSON.stringify({ agentId: currentAgentId, runtimeId: currentRuntimeAgentId, sessionId, forceContinue: enabled }),
    });
    const payload = await response.json().catch(() => null);
    if (response.ok && payload?.ok === true) return true;
    // IPC 未送达：runtime 已停止/重启中，或 sessionId 暂态错位（会话切换后
    // allAgents 尚未刷新的窗口）。续期用户操作时间戳防止轮询快照覆盖乐观
    // 状态，刷新 agent 列表后重试一次（runtime 重启后 id 可能已更新）。
    _lastTodoForceContinueUserActionAt = Date.now();
    if (attempt === 0 && typeof loadAgents === 'function') {
      await loadAgents();
      return sendTodoForceContinue(enabled, { attempt: attempt + 1 });
    }
    // 重试仍失败：回滚乐观状态，让 UI 回到 server 真实状态（否则
    // 3 秒宽限期后轮询快照会把开关"悄悄"弹回，表现为按钮自动关回）。
    setTodoForceContinue(!enabled);
    _lastTodoForceContinueUserActionAt = Date.now();
    if (activeFeaturePanel === 'plan') renderFeaturePanel();
    console.warn('[TodoControl] force-continue not delivered (runtime not reachable), rolled back to', !enabled);
    return false;
  } catch (e) {
    console.error('[TodoControl] force-continue request failed:', e);
    return false;
  }
}

featurePanelBody.addEventListener('change', (e) => {
  const toggle = e.target?.closest?.('input[data-todo-force-continue]');
  if (!toggle) return;
  const enabled = toggle.checked === true;
  // 乐观更新本地缓存并重渲染；server 侧由 app-main 轮询同步兜底
  setTodoForceContinue(enabled);
  _lastTodoForceContinueUserActionAt = Date.now();
  if (activeFeaturePanel === 'plan') {
    renderFeaturePanel();
  }
  sendTodoForceContinue(enabled);
});

featurePanelBody.addEventListener('click', (e) => {
  const detailTarget = e.target.closest('[data-plan-task-detail]');
  if (detailTarget) {
    e.preventDefault();
    e.stopPropagation();
    const taskId = detailTarget.dataset.planTaskDetail;
    // 切换详情开合：记录与当前渲染态相反的覆盖值
    const article = detailTarget.closest('.plan-task');
    const nowOpen = !article?.querySelector('.plan-task-detail-chev')?.classList.contains('is-open');
    _planTerminalDetailState.set(taskId, nowOpen);
    if (activeFeaturePanel === 'plan') {
      renderFeaturePanel();
    }
    return;
  }
  const foldBtn = e.target.closest('[data-plan-toggle-run]');
  if (foldBtn) {
    e.preventDefault();
    e.stopPropagation();
    const runStart = Number(foldBtn.dataset.planToggleRun);
    // 收起动作清除该段的单条详情覆盖态，段再次展开时回到默认折叠。
    if (_planExpandedRuns.has(runStart)) {
      const tasks = Array.isArray(currentTodoPlan?.tasks) ? currentTodoPlan.tasks : [];
      const run = getTerminalRuns(tasks).find(r => r.start === runStart);
      if (run) {
        for (let j = run.start; j < run.end; j++) {
          const tid = String(tasks[j]?.id || '');
          if (tid) _planTerminalDetailState.delete(tid);
        }
      }
      _planExpandedRuns.delete(runStart);
    } else {
      _planExpandedRuns.add(runStart);
    }
    if (activeFeaturePanel === 'plan') {
      renderFeaturePanel();
      // 展开态按钮固定在段首：锚定回按钮位置，阅读位置连续
      const btn = featurePanelBody.querySelector('[data-plan-toggle-run="' + String(runStart) + '"]');
      if (btn) btn.scrollIntoView({ block: 'start' });
    }
    return;
  }
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
