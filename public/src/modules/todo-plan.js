/**
 * todo-plan.js — Todo Plan 渲染模块（从 app-ui.js 提取；P4 L1 classic → ESM）
 *
 * 包含：
 *   - getEmptyTodoPlan, normalizeTodoPlan, getTodoPlanSignature
 *   - setCurrentTodoPlan, updatePlanBadge
 *   - getTodoStatusLabel, renderPlanTask, renderPlanPanel
 *   - sendTodoControl（"执行到此处"控制）
 *   - featurePanelBody click / keydown 事件监听器（控制按钮交互）
 *
 * 依赖形态：
 *   - 已迁 ESM 直接 import：翻译（t）、转义（escapeHtml）、语言
 *     （getCurrentLanguage）、计划快照存储（session-view-storage 的
 *     currentTodoPlan / currentTodoPlanSignature 与其 setter）、编排状态
 *     （currentRuntimeAgentId / _switchEpoch）、渲染入口状态
 *     （activeFeaturePanel）、DOM 引用（domRefs.featurePanelBody）、
 *     call 活动宿主（callActivity 的 `_lastInterruptUserActionAt`）。
 *   - 仍 classic 的显式 window 晚绑定（均为运行期调用，行尾注明定义域）：
 *     `getInterruptTargetId` / `setInterruptTargetId` / `getRuntimeId` /
 *     `getRuntimeWorkspaceSessionId` / `getCurrentControlAgentId`（app-core）、
 *     `renderFeaturePanel`（debug-panel-host）。
 *
 * 时序审计（R1/R2/R4）：本域键在 classic 相没有触达点——首屏链只经由
 * `getEmptyTodoPlan`（app-ui 的空态构造，在 boot 触发的 renderCurrentMainView
 * 内）与本模块的 panel render 闭包调用，两者都发生在模块求值相之后；
 * 顶层 `featurePanelBody.addEventListener` 的两个监听器只在用户交互时触发，
 * 加载相 → 模块相等价。因此注册相位取模块求值相。
 *
 * 桥键（domain `todo-plan`，classic 消费方尚未迁移）：
 *   - `getEmptyTodoPlan`      ← app-ui / app-core / app-main / session-view-state
 *   - `normalizeTodoPlan`     ← app-main（createMetadataCommitHost 适配器）
 *   - `getTodoPlanSignature`  ← app-core / app-main
 *   - `setCurrentTodoPlan`    ← session-view-state（applySessionViewPatch 提交计划）
 *   - `updatePlanBadge`       ← app-core / app-main / agent-data-loader
 *   - `renderPlanPanel`       ← app-ui（'plan' 面板注册闭包）
 *   注销条件：上述 classic 消费方迁 ESM 并改为 import。
 *   `isPlanTaskKind` / `getTaskKindLabel` / `getTodoStatusLabel` /
 *   `getTerminalRuns` / `renderPlanFoldButton` / `renderPlanTaskList` /
 *   `renderPlanTask` / `sendTodoControl` 生产消费面为零（仅测试经 import 使用），
 *   作命名导出但不造桥。
 */
import { t } from '../i18n.js';
import { escapeHtml } from './markdown-utils.js';
import { getCurrentLanguage } from './i18n-environment-state.js';
import { currentRuntimeAgentId, _switchEpoch } from './orchestration-state.js';
import { activeFeaturePanel } from './render-entry-state.js';
import { domRefs } from './p2-bootstrap-dom.js';
import { callActivity } from './p2-bootstrap-call-activity.js';
import {
  currentTodoPlan,
  setCurrentTodoPlan as setTodoPlanValue,
  setCurrentTodoPlanSignature,
} from './session-view-storage.js';
import { getCurrentControlAgentId, getRuntimeId, getRuntimeWorkspaceSessionId } from './identity.js';

// 加载期 DOM 引用（app-core 的 const 引用，元素从不替换）。
const { featurePanelBody } = domRefs;

export function getEmptyTodoPlan() {
  return {
    feature: 'todo',
    updatedAt: 0,
    counter: 0,
    tasks: [],
    summary: { total: 0, pending: 0, inProgress: 0, completed: 0, cancelled: 0 },
  };
}

// 任务类型渲染白名单（五值，与框架 features/todo 的 TaskKind / viewer-worker normalizeKind 同步）。
// other 是模型侧 kind 必填的兜底值：数据层经 normalize 保留（见 normalizeTodoPlan 内六值判断），
// 但不渲染类型徽章——「其他」不携带类型信息，出徽章只是视觉噪音。
export function isPlanTaskKind(value) {
  return ['investigate', 'design', 'implement', 'fix', 'verify'].includes(value);
}

export function getTaskKindLabel(kind) {
  if (!isPlanTaskKind(kind)) return '';
  return t('plan_kind_' + kind);
}

export function normalizeTodoPlan(snapshot) {
  const empty = getEmptyTodoPlan();
  if (!snapshot || typeof snapshot !== 'object') return empty;
  const tasks = Array.isArray(snapshot.tasks) ? snapshot.tasks.map(task => ({
    id: String(task?.id || ''),
    subject: String(task?.subject || ''),
    description: String(task?.description || ''),
    deliver: String(task?.deliver || ''),
    // 数据层六值：other 为合法兜底值，保留供回读与后续分析（渲染层另用五值白名单）
    kind: ['investigate', 'design', 'implement', 'fix', 'verify', 'other'].includes(task?.kind) ? task.kind : '',
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

export function getTodoPlanSignature(snapshot) {
  return JSON.stringify(normalizeTodoPlan(snapshot));
}

export function setCurrentTodoPlan(snapshot) {
  const normalized = normalizeTodoPlan(snapshot);
  setTodoPlanValue(normalized);
  setCurrentTodoPlanSignature(getTodoPlanSignature(normalized));
  updatePlanBadge();
}

export function updatePlanBadge() {
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

export function getTodoStatusLabel(status) {
  const labels = {
    pending: t('plan_pending'),
    in_progress: t('plan_in_progress'),
    completed: t('plan_completed'),
    deleted: t('plan_cancelled'),
  };
  return labels[status] || status || t('metric_unavailable');
}

export function renderPlanTask(task) {
  const status = String(task?.status || 'pending');
  const isTerminal = status === 'completed' || status === 'deleted';
  const taskId = String(task?.id || '');
  const isInterruptTarget = !isTerminal && window.getInterruptTargetId() === taskId;
  const meta = [
    '#' + taskId,
    getTodoStatusLabel(status),
  ].filter(Boolean).join(' · ');
  const desc = task?.description || '';
  const deliver = String(task?.deliver || '').trim();
  const kindLabel = getTaskKindLabel(task?.kind);
  const kindBadge = kindLabel
    ? '<span class="plan-task-kind kind-' + escapeHtml(String(task.kind)) + '">' + escapeHtml(kindLabel) + '</span>'
    : '';
  // 所有终态任务默认收起详情，手动操作记录在
  // _planTerminalDetailState 中覆盖默认态（有描述或交付物才可交互）。
  const detailOpen = isTerminal
    ? (_planTerminalDetailState.has(taskId) ? _planTerminalDetailState.get(taskId) : false)
    : true;
  const canToggleDetail = isTerminal && Boolean(desc || deliver);
  const detail = detailOpen ? desc : '';
  const marker = status === 'in_progress'
    ? '<div class="plan-task-spinner"></div>'
    : status === 'completed'
      ? '<svg class="plan-task-check" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 4 4L19 6"/></svg>'
      : '<div class="plan-task-dot"></div>';
  const actionBtn = isTerminal ? '' : (isInterruptTarget
    ? '<button type="button" class="plan-task-action" data-todo-interrupt data-action="cancel" data-task-id="' + escapeHtml(taskId) + '">' + (getCurrentLanguage() === 'zh' ? '取消执行' : 'Cancel') + '</button>'
    : '<button type="button" class="plan-task-action" data-todo-interrupt data-action="set" data-task-id="' + escapeHtml(taskId) + '">' + (getCurrentLanguage() === 'zh' ? '执行到此处' : 'Run to here') + '</button>');
  const interruptLabel = isInterruptTarget ? '<span class="plan-task-interrupt-label">' + (getCurrentLanguage() === 'zh' ? '执行到此为止' : 'Stop here') + '</span>' : '';
  const detailChev = canToggleDetail
    ? '<svg class="plan-task-detail-chev' + (detailOpen ? ' is-open' : '') + '" aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>'
    : '';
  return [
    '<article class="plan-task status-' + escapeHtml(status.replace(/[^a-z0-9_-]/gi, '-')) + (isTerminal ? ' is-terminal' : '') + (isInterruptTarget ? ' is-interrupt-target' : '') + '"'
    + (canToggleDetail ? ' data-plan-task-detail="' + escapeHtml(taskId) + '" role="button" tabindex="0" aria-expanded="' + String(detailOpen) + '"' : '') + '>',
    '<div class="plan-task-marker" aria-hidden="true">' + marker + '</div>',
    '<div class="plan-task-main">',
    '<div class="plan-task-title">' + kindBadge + escapeHtml(task?.subject || '') + interruptLabel + detailChev + '</div>',
    detail ? '<div class="plan-task-desc">' + escapeHtml(detail) + '</div>' : '',
    // 交付物：描述之外独立一行，靠字号与颜色降一级区分，随详情一起折叠
    (detailOpen && deliver)
      ? '<div class="plan-task-deliver" title="' + escapeHtml(deliver) + '">' + escapeHtml((getCurrentLanguage() === 'zh' ? '交付 · ' : 'Deliver · ') + deliver) + '</div>'
      : '',
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
// 会话/运行时切换（_switchEpoch 递增）后回到默认态。
// 两者随导航面导出：测试直接操作这两张表驱动折叠/详情用例（生产侧无跨文件消费）。
export let _planExpandedRuns = new Set();
export let _planTerminalDetailState = new Map();
let _planFoldSwitchEpoch = null;

// 扫描连续终态段，返回 [{start, end}]（end exclusive）
export function getTerminalRuns(tasks) {
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

export function renderPlanFoldButton(foldCount, runStart, expanded) {
  return '<button type="button" class="plan-fold' + (expanded ? ' is-open' : '') + '" data-plan-toggle-run="' + String(runStart) + '" aria-expanded="' + String(expanded) + '">'
    + '<svg class="plan-fold-chev" aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>'
    + '<span>' + escapeHtml(t(expanded ? 'plan_fold_collapse' : 'plan_fold_expand').replace('{n}', String(foldCount))) + '</span>'
    + '</button>';
}

export function renderPlanTaskList(tasks) {
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

export function renderPlanPanel() {
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
    '<section class="plan-task-list">',
    renderPlanTaskList(tasks),
    '</section>',
    '</div>',
  ].join('');
}

// ── TODO"执行到此处"控制 ────────────────────────────────────────

export async function sendTodoControl(taskId) {
  const runtimeId = getRuntimeId(currentRuntimeAgentId);
  if (!runtimeId) return;
  // runtimeId 与轮询数据源 /api/agents/:id/todo 共用同一身份空间；sessionId
  // 仅表达当前绑定会话，不从页面焦点或 parentId 猜测。
  const sessionId = getRuntimeWorkspaceSessionId(runtimeId) || undefined;
  try {
    await fetch('/protoclaw/todo_control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: getCurrentControlAgentId(), runtimeId, sessionId, taskId }),
    });
  } catch (e) {
    console.error('[TodoControl] request failed:', e);
  }
}

// 终态行是轻量 disclosure，键盘与点击走同一条交互路径。
featurePanelBody.addEventListener('keydown', (e) => {
  const detailTarget = e.target.closest('[data-plan-task-detail]');
  if (detailTarget && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    detailTarget.click();
  }
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
      window.renderFeaturePanel();
      const row = Array.from(featurePanelBody.querySelectorAll('[data-plan-task-detail]'))
        .find(element => element.dataset.planTaskDetail === taskId);
      if (row) row.focus({ preventScroll: true });
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
      window.renderFeaturePanel();
      // 只更新下方内容，不主动滚动；键盘操作后焦点仍留在原折叠入口。
      const btn = featurePanelBody.querySelector('[data-plan-toggle-run="' + String(runStart) + '"]');
      if (btn) btn.focus({ preventScroll: true });
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
  window.setInterruptTargetId(action === 'set' ? taskId : null);
  callActivity._lastInterruptUserActionAt = Date.now();
  if (activeFeaturePanel === 'plan') {
    window.renderFeaturePanel();
  }
  if (action === 'set') {
    sendTodoControl(taskId);
  } else if (action === 'cancel') {
    sendTodoControl(null);
  }
});

// ── 兼容桥（classic 消费方收敛后注销）──────────────────────────────

const bridgeValues = {
  getEmptyTodoPlan,
  normalizeTodoPlan,
  getTodoPlanSignature,
  setCurrentTodoPlan,
  updatePlanBadge,
  renderPlanPanel,
};

window.KernelState.defineKey('todo-plan', 'getEmptyTodoPlan', getEmptyTodoPlan);
window.KernelState.defineKey('todo-plan', 'normalizeTodoPlan', normalizeTodoPlan);
window.KernelState.defineKey('todo-plan', 'getTodoPlanSignature', getTodoPlanSignature);
window.KernelState.defineKey('todo-plan', 'setCurrentTodoPlan', setCurrentTodoPlan);
window.KernelState.defineKey('todo-plan', 'updatePlanBadge', updatePlanBadge);
window.KernelState.defineKey('todo-plan', 'renderPlanPanel', renderPlanPanel);
window.KernelState.claim('todo-plan', {
  get(key) {
    return bridgeValues[key];
  },
  set(key, value) {
    bridgeValues[key] = value;
  },
});
