/**
 * Dispatch Console UI 模块
 * 从 app-ui.js 拆出 (域 I: dispatch 渲染)
 *
 * 依赖全局状态 (定义在 app-core.js):
 *   currentLanguage
 * 依赖全局函数 (定义在 app-ui.js):
 *   renderCurrentMainView, getCurrentAgentRecord, escapeHtml, getAgentIconHtml
 * 导出全局函数:
 *   isDispatchConfigEditor, renderDispatchConfigEditor,
 *   renderDispatchDetailModal, renderDispatchModal
 */

// ── Schedule Console ──────────────────────────────────────────────

function isDispatchConfigEditor(block) {
  return getCurrentAgentRecord()?.id === 'dispatch-console' && block?.id === 'dispatch-schedule-form';
}

const DISPATCH_WORKSPACE_IDS = ['programming-helper', 'qqbot'];

function renderDispatchConfigEditor(_block) {
  if (!window._dispatchSchedulesLoaded) {
    window._dispatchAgentsLoaded = false;
    window.refreshDispatchConsoleData({ force: true, render: true }).catch((error) => {
      console.error('Failed to refresh dispatch console data:', error);
    });
  } else if (typeof window.refreshDispatchConsoleData === 'function') {
    window.refreshDispatchConsoleData({ render: true }).catch((error) => {
      console.error('Failed to refresh dispatch console data:', error);
    });
  }

  const agents = (window._dispatchAgents || []).filter(a => DISPATCH_WORKSPACE_IDS.includes(a.id));
  const schedules = window._dispatchSchedules || [];
  const isZh = (window._lang || 'zh') === 'zh';
  const loading = !window._dispatchAgentsLoaded;

  const pendingSchedules = schedules.filter(s => s.status === 'pending');
  const firedSchedules = schedules.filter(s => s.status === 'fired');
  const doneSchedules = schedules.filter(s => ['completed', 'failed', 'cancelled'].includes(s.status)).slice(-20).reverse();

  // Workspace cards — click to open "add task" modal for that workspace
  let agentCards;
  if (loading) {
    agentCards = '<div class="dispatch-loading-hint">' + (isZh ? '加载中...' : 'Loading...') + '</div>';
  } else if (agents.length === 0) {
    agentCards = '<div class="dispatch-loading-hint">' + (isZh ? '暂无可用工作空间' : 'No workspaces available') + '</div>';
  } else {
    agentCards = agents.map(a => {
      const iconHtml = typeof getAgentIconHtml === 'function' ? getAgentIconHtml(a.id) : '';
      return [
        '<div class="dispatch-workspace-card" onclick="window.openDispatchModalFor(\'' + escapeHtml(a.id) + '\')">',
        '<div class="dispatch-ws-icon">' + iconHtml + '</div>',
        '<div class="dispatch-ws-name">' + escapeHtml(a.name) + '</div>',
        '<div class="dispatch-ws-hint">' + (isZh ? '点击创建指令' : 'Click to create') + '</div>',
        '<div class="dispatch-ws-add-btn">',
        '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 1v12M1 7h12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
        '</div>',
        '</div>',
      ].join('');
    }).join('');
  }

  // ── Tab state ──
  const activeTab = window._dispatchListTab || 'pending';

  // ── Schedule row renderer ──
  function renderScheduleRow(s, options) {
    const showCancel = options === 'pending';
    const triggerLabel = s.trigger?.type === 'on-idle' ? (isZh ? '空闲时' : 'on-idle')
      : s.trigger?.type === 'on-ready' ? (isZh ? '就绪时' : 'on-ready')
      : s.repeatInterval ? (isZh ? '循环' : 'repeat')
      : (isZh ? '定时' : 'timer');
    const triggerIcon = s.trigger?.type === 'on-idle' ? '\u{23F3}'
      : s.trigger?.type === 'on-ready' ? '\u{26A1}'
      : s.repeatInterval ? '\u{1F501}'
      : '\u{23F0}';
    const modeLabel = s.newSessionType === 'exploration' ? (isZh ? '探索' : 'explore')
      : s.targetSessionId ? (s.targetSessionId === '__latest__' ? (isZh ? '最新对话' : 'latest') : (isZh ? '续接' : 'continue'))
      : (isZh ? '新建' : 'new');
    const loopInfo = s.repeatInterval ? (s.loopMaxCount ? (s.loopFiredCount || 0) + '/' + s.loopMaxCount : '') : '';

    const isPending = s.status === 'pending';
    const isFired = s.status === 'fired';
    const timeStr = (isPending || isFired)
      ? new Date(s.fireAt).toLocaleTimeString(isZh ? 'zh-CN' : 'en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      : new Date(s.firedAt || s.completedAt || s.fireAt).toLocaleTimeString(isZh ? 'zh-CN' : 'en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const timeLabel = isPending ? (isZh ? '下次 ' : 'next ') + timeStr
      : isFired ? (isZh ? '执行中' : 'running')
      : timeStr;

    return [
      '<div class="dispatch-row-v2" onclick="window.showDispatchDetail(\'' + escapeHtml(s.id) + '\')">',
      '<div class="dispatch-row-dot ' + s.status + '"></div>',
      '<div class="dispatch-row-body">',
      '<div class="dispatch-row-msg">' + escapeHtml(s.message.slice(0, 100)) + (s.message.length > 100 ? '...' : '') + '</div>',
      '<div class="dispatch-row-meta">',
      '<span class="dispatch-row-target">' + escapeHtml(s.targetAgentId || '') + ' · ' + escapeHtml(modeLabel) + '</span>',
      '<span class="dispatch-row-trigger">' + triggerIcon + ' ' + escapeHtml(triggerLabel) + '</span>',
      loopInfo ? '<span>' + escapeHtml(loopInfo) + '</span>' : '',
      s.onlyActiveSessions ? '<span>' + (isZh ? '仅活跃' : 'active-only') + '</span>' : '',
      '</div>',
      '</div>',
      '<div class="dispatch-row-time' + (isPending ? ' next' : '') + '">' + escapeHtml(timeLabel) + '</div>',
      '<div class="dispatch-row-action">',
      showCancel ? '<button class="dispatch-cancel-btn" type="button" onclick="event.stopPropagation();window.cancelDispatchSchedule(\'' + escapeHtml(s.id) + '\')">×</button>' : '',
      '</div>',
      '</div>',
    ].join('');
  }

  const modalHtml = window._dispatchShowModal ? renderDispatchModal(isZh) : '';
  const detailHtml = window._dispatchDetailId ? renderDispatchDetailModal(window._dispatchDetailId, isZh, schedules) : '';

  return [
    // Workspace cards as "add task" entry points
    '<section class="workspace-section dispatch-add-task-section">',
    '<div class="workspace-section-header">',
    '<div class="workspace-section-title">' + (isZh ? '添加任务指令' : 'Add Task') + '</div>',
    '<div class="workspace-section-desc">' + (isZh ? '选择一个工作空间来添加调度任务' : 'Pick a workspace to schedule a task') + '</div>',
    '</div>',
    '<div class="dispatch-workspace-grid">', agentCards, '</div>',
    '</section>',

    // Schedule list with tabs
    '<section class="workspace-section">',

    '<div class="dispatch-list-tabs">',
    '<button class="dispatch-list-tab' + (activeTab === 'pending' ? ' active' : '') + '" type="button" onclick="window._dispatchListTab=\'pending\';renderCurrentMainView()">',
    (isZh ? '计划' : 'Planned'), '<span class="tab-count">' + pendingSchedules.length + '</span>',
    '</button>',
    '<button class="dispatch-list-tab' + (activeTab === 'fired' ? ' active' : '') + '" type="button" onclick="window._dispatchListTab=\'fired\';renderCurrentMainView()">',
    (isZh ? '执行中' : 'Running'), '<span class="tab-count">' + firedSchedules.length + '</span>',
    '</button>',
    '<button class="dispatch-list-tab' + (activeTab === 'done' ? ' active' : '') + '" type="button" onclick="window._dispatchListTab=\'done\';renderCurrentMainView()">',
    (isZh ? '已完成' : 'Done'), '<span class="tab-count">' + doneSchedules.length + '</span>',
    '</button>',
    '</div>',

    loading ? '<div class="dispatch-loading-hint">' + (isZh ? '加载中...' : 'Loading...') + '</div>' : [
      activeTab === 'pending' && pendingSchedules.length > 0
        ? pendingSchedules.map(s => renderScheduleRow(s, 'pending')).join('')
        : '',
      activeTab === 'fired' && firedSchedules.length > 0
        ? firedSchedules.map(s => renderScheduleRow(s, 'fired')).join('')
        : '',
      activeTab === 'done' && doneSchedules.length > 0
        ? doneSchedules.map(s => renderScheduleRow(s, 'done')).join('')
        : '',

      activeTab === 'pending' && pendingSchedules.length === 0 ? '<div style="font-size:13px;color:var(--text-muted);padding:16px 0;">' + (isZh ? '暂无计划中的调度' : 'No planned schedules') + '</div>' : '',
      activeTab === 'fired' && firedSchedules.length === 0 ? '<div style="font-size:13px;color:var(--text-muted);padding:16px 0;">' + (isZh ? '暂无执行中的调度' : 'No running schedules') + '</div>' : '',
      activeTab === 'done' && doneSchedules.length === 0 ? '<div style="font-size:13px;color:var(--text-muted);padding:16px 0;">' + (isZh ? '暂无已完成记录' : 'No completed records') + '</div>' : '',
    ].join(''),

    '</section>',

    modalHtml,
    detailHtml,
  ].join('');
}

function renderDispatchDetailModal(scheduleId, isZh, schedules) {
  const s = schedules.find(x => x.id === scheduleId);
  if (!s) return '';

  const triggerLabel = s.trigger?.type === 'on-idle' ? (isZh ? '空闲触发' : 'On-idle')
    : s.trigger?.type === 'on-ready' ? (isZh ? '就绪触发' : 'On-ready')
    : (isZh ? '定时触发' : 'Timer');
  const triggerIcon = s.trigger?.type === 'on-idle' ? '\u{23F3}'
    : s.trigger?.type === 'on-ready' ? '\u{26A1}'
    : '\u{23F0}';
  const modeLabel = s.newSessionType === 'exploration' ? (isZh ? '新建探索' : 'New exploration')
    : s.targetSessionId ? (s.targetSessionId === '__latest__' ? (isZh ? '最新对话' : 'Latest session') : (isZh ? '续接对话' : 'Continue'))
    : (isZh ? '新建会话' : 'New session');
  const statusLabel = { pending: isZh ? '已部署' : 'Armed', fired: isZh ? '已触发' : 'Triggered', completed: isZh ? '已完成' : 'Completed', failed: isZh ? '失败' : 'Failed', cancelled: isZh ? '已取消' : 'Cancelled' }[s.status] || s.status;
  const statusIcon = { pending: '\u{23F3}', fired: '\u{26A1}', completed: '\u{2705}', failed: '\u{274C}', cancelled: '\u{1F6AB}' }[s.status] || '';

  function fmtTime(iso) {
    if (!iso) return isZh ? '—' : '—';
    return new Date(iso).toLocaleString(isZh ? 'zh-CN' : 'en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  const rows = [];

  // Status
  rows.push({ label: isZh ? '状态' : 'Status', value: statusIcon + ' ' + statusLabel, cls: 'dispatch-detail-status-' + s.status });

  // Trigger
  rows.push({ label: isZh ? '触发类型' : 'Trigger', value: triggerIcon + ' ' + triggerLabel });
  if (s.trigger?.type === 'on-idle' && s.trigger.idleThreshold) {
    rows.push({ label: isZh ? '空闲阈值' : 'Idle Threshold', value: s.trigger.idleThreshold + 's' });
  }
  if (s.trigger?.type === 'timer' || !s.trigger?.type) {
    rows.push({ label: isZh ? '计划触发' : 'Fire at', value: fmtTime(s.fireAt) });
  }

  // Target
  rows.push({ label: isZh ? '目标工作空间' : 'Target', value: s.targetAgentId || '—' });
  rows.push({ label: isZh ? '模式' : 'Mode', value: modeLabel });
  if (s.targetSessionId && s.targetSessionId !== '__latest__') {
    rows.push({ label: isZh ? '会话' : 'Session', value: s.targetSessionId.slice(0, 20) });
  }
  if (s.projectId) {
    rows.push({ label: isZh ? '项目' : 'Project', value: s.projectId });
  }

  // Loop
  if (s.repeatInterval) {
    rows.push({ label: isZh ? '循环间隔' : 'Repeat', value: s.repeatInterval + (isZh ? ' 秒' : ' sec') });
    if (s.loopMaxCount) {
      rows.push({ label: isZh ? '执行进度' : 'Progress', value: (s.loopFiredCount || 0) + ' / ' + s.loopMaxCount });
    }
    if (s.loopEndTime) {
      rows.push({ label: isZh ? '截止时间' : 'End at', value: fmtTime(new Date(s.loopEndTime).toISOString()) });
    }
    if (s.onlyActiveSessions) {
      rows.push({ label: '', value: isZh ? '仅对已启动的会话生效' : 'Active sessions only', cls: 'dispatch-detail-note' });
    }
  }

  // Timeline
  rows.push({ label: isZh ? '创建时间' : 'Created', value: fmtTime(s.createdAt) });
  if (s.firedAt) rows.push({ label: isZh ? '最近触发' : 'Last fired', value: fmtTime(s.firedAt) });
  if (s.completedAt) rows.push({ label: isZh ? '完成时间' : 'Completed', value: fmtTime(s.completedAt) });

  // Result
  if (s.result) {
    const resultText = s.status === 'failed'
      ? '\u{274C} ' + (s.result.length > 200 ? s.result.slice(0, 200) + '...' : s.result)
      : s.result.length > 300 ? s.result.slice(0, 300) + '...' : s.result;
    rows.push({ label: isZh ? '结果' : 'Result', value: resultText, cls: 'dispatch-detail-result' });
  }
  if (s.error) {
    rows.push({ label: isZh ? '错误' : 'Error', value: s.error.slice(0, 200), cls: 'dispatch-detail-error' });
  }

  const fieldHtml = rows.map(r => {
    if (!r.label && r.value) {
      return '<div class="dispatch-detail-field' + (r.cls ? ' ' + r.cls : '') + '" style="grid-column:1/-1;"><span class="dispatch-detail-value">' + escapeHtml(r.value) + '</span></div>';
    }
    return [
      '<div class="dispatch-detail-field">',
      '<span class="dispatch-detail-label">' + escapeHtml(r.label) + '</span>',
      '</div>',
      '<div class="dispatch-detail-field' + (r.cls ? ' ' + r.cls : '') + '">',
      '<span class="dispatch-detail-value">' + escapeHtml(r.value) + '</span>',
      '</div>',
    ].join('');
  }).join('');

  // Actions
  const actions = [];
  if (s.status === 'pending') {
    actions.push('<button class="settings-btn settings-btn-danger" type="button" onclick="window.cancelDispatchSchedule(\'' + escapeHtml(s.id) + '\')">' + (isZh ? '取消' : 'Cancel') + '</button>');
  }

  return [
    '<div class="feature-detail-overlay">',
    '<div class="feature-detail-window" style="max-width:480px;gap:12px;">',

    '<div class="feature-detail-head">',
    '<div>',
    '<div class="feature-detail-title">' + (isZh ? 'Schedule 详情' : 'Schedule Detail') + '</div>',
    '<div class="feature-detail-subtitle">' + escapeHtml(s.id.slice(0, 24)) + '</div>',
    '</div>',
    '<button class="feature-detail-close" type="button" onclick="window.closeDispatchDetail()">×</button>',
    '</div>',

    // Message block
    '<div class="dispatch-detail-message">',
    '<div class="dispatch-detail-message-label">' + (isZh ? '消息内容' : 'Message') + '</div>',
    '<div class="dispatch-detail-message-text">' + escapeHtml(s.message) + '</div>',
    '</div>',

    // Fields grid
    '<div class="dispatch-detail-grid">', fieldHtml, '</div>',

    // Actions
    actions.length > 0 ? '<div style="display:flex;gap:10px;justify-content:flex-end;margin-top:4px;">' + actions.join('') + '</div>' : '',

    '</div>',
    '</div>',
  ].join('');
}

function renderDispatchModal(isZh) {
  const selectedAgent = window._dispatchModalAgent || window._dispatchSelectedAgent;
  const agents = window._dispatchAgents || [];
  const sessions = window._dispatchSessions || [];
  const projects = window._dispatchProjects || [];
  const currentMode = window._dispatchMode || 'continue';
  const agentName = agents.find(a => a.id === selectedAgent)?.name || selectedAgent;

  // ── Mode definitions per workspace ──
  // NOTE: new-main before new-exploration (per user request)
  const MODE_DEFS = {
    'programming-helper': [
      { id: 'continue', icon: '\u{1F504}', zh: '续接对话', en: 'Continue', desc: '向已有主对话注入消息' },
      { id: 'new-main', icon: '\u{1F4AC}', zh: '新建主对话', en: 'New Session', desc: '前台可交互的主代理' },
      { id: 'new-exploration', icon: '\u{1F50D}', zh: '新建探索', en: 'Explore', desc: '后台运行的探索代理' },
    ],
    'qqbot': [
      { id: 'continue', icon: '\u{1F504}', zh: '续接对话', en: 'Continue', desc: '向已有会话注入消息' },
      { id: 'new-main', icon: '\u{1F4E8}', zh: '新建对话', en: 'New Session', desc: '创建新的门户代理会话' },
    ],
  };
  const modes = MODE_DEFS[selectedAgent] || MODE_DEFS['programming-helper'];

  // ── Trigger availability per mode ──
  const TRIGGER_AVAIL = {
    'continue':        ['timer', 'on-idle'],
    'new-main':        ['timer', 'on-ready'],
    'new-exploration': ['timer', 'on-ready'],
  };
  const availableTriggers = TRIGGER_AVAIL[currentMode] || ['timer'];
  let triggerType = window._dispatchTriggerType || 'timer';
  if (!availableTriggers.includes(triggerType)) triggerType = availableTriggers[0];

  // ── Whether this trigger type supports loop ──
  const triggerSupportsLoop = (triggerType === 'timer' || triggerType === 'on-idle');

  // Mode cards
  const modeCards = modes.map(m =>
    '<div class="dispatch-mode-card' + (currentMode === m.id ? ' active' : '') +
    '" onclick="window.selectDispatchMode(\'' + m.id + '\')">' +
    '<div class="dispatch-mode-icon">' + m.icon + '</div>' +
    '<div class="dispatch-mode-name">' + (isZh ? m.zh : m.en) + '</div>' +
    '<div class="dispatch-mode-desc">' + m.desc + '</div>' +
    '</div>'
  ).join('');

  // Trigger tabs
  const triggerDefs = [
    { type: 'timer',   zh: '定时', en: 'Timer' },
    { type: 'on-idle', zh: '空闲时', en: 'On Idle' },
    { type: 'on-ready', zh: '就绪时', en: 'On Ready' },
  ].filter(t => availableTriggers.includes(t.type));

  const triggerTabs = triggerDefs.map(t =>
    '<button class="dispatch-trigger-tab' + (triggerType === t.type ? ' active' : '') +
    '" type="button" onclick="window.selectDispatchTrigger(\'' + t.type + '\')">' +
    (isZh ? t.zh : t.en) + '</button>'
  ).join('');

  // Trigger-specific fields
  let triggerFields = '';
  if (triggerType === 'timer') {
    triggerFields = [
      '<div class="dispatch-form-row">',
      '<label class="dispatch-label">' + (isZh ? '延迟' : 'Delay') + '</label>',
      '<div class="dispatch-input-group">',
      '<input type="number" id="dispatch-seconds" class="dispatch-input" min="1" max="86400" value="30" placeholder="30">',
      '<span class="dispatch-input-suffix">' + (isZh ? '秒' : 'sec') + '</span>',
      '</div>',
      '</div>',
    ].join('');
  } else if (triggerType === 'on-idle') {
    triggerFields = [
      '<div class="dispatch-form-row">',
      '<label class="dispatch-label">' + (isZh ? '空闲阈值' : 'Idle Threshold') + '</label>',
      '<div class="dispatch-input-group">',
      '<input type="number" id="dispatch-idle-threshold" class="dispatch-input" min="10" max="86400" value="300" placeholder="300">',
      '<span class="dispatch-input-suffix">' + (isZh ? '秒' : 'sec') + '</span>',
      '</div>',
      '</div>',
    ].join('');
  }

  // ── Loop config (timer + on-idle, NOT for exploration mode) ──
  let loopSection = '';
  if (triggerSupportsLoop && currentMode !== 'new-exploration') {
    const intervalRow = triggerType === 'on-idle'
      ? [
        '<div class="dispatch-loop-row">',
        '<span class="dispatch-loop-row-label">' + (isZh ? '最小间隔' : 'Min gap') + '</span>',
        '<div class="dispatch-input-group">',
        '<input type="number" id="dispatch-repeat" class="dispatch-input" style="width:80px;" min="1" max="86400" value="300" placeholder="300">',
        '<span class="dispatch-input-suffix">' + (isZh ? '秒' : 'sec') + '</span>',
        '</div>',
        '</div>',
      ].join('')
      : '';

    // Quick presets (duration-based shortcuts, placed below time input)
    const presets = [
      { label: isZh ? '30分钟后' : '30m later', seconds: 1800 },
      { label: isZh ? '1小时后' : '1h later', seconds: 3600 },
      { label: isZh ? '2小时后' : '2h later', seconds: 7200 },
      { label: isZh ? '6小时后' : '6h later', seconds: 21600 },
      { label: isZh ? '12小时后' : '12h later', seconds: 43200 },
      { label: isZh ? '1天后' : '1d later', seconds: 86400 },
      { label: isZh ? '1周后' : '1w later', seconds: 604800 },
    ];
    const presetChips = presets.map(p =>
      '<span class="dispatch-end-preset' + (p.seconds === 3600 ? ' active' : '') + '" data-seconds="' + p.seconds + '" onclick="window.selectDispatchEndPreset(this,' + p.seconds + ')">' + p.label + '</span>'
    ).join('');

    // Exact end time: default = now + 1 hour
    const defaultEnd = new Date(Date.now() + 3600000);
    const eYear = defaultEnd.getFullYear();
    const eMonth = defaultEnd.getMonth() + 1;
    const eDay = defaultEnd.getDate();
    const eHour = defaultEnd.getHours();
    const eMin = defaultEnd.getMinutes();
    const defaultEndTs = defaultEnd.getTime();

    loopSection = [
      '<div class="dispatch-loop-section">',
      '<label class="dispatch-loop-toggle">',
      '<input type="checkbox" id="dispatch-loop-enable">',
      (isZh ? '启用循环' : 'Enable repeat'),
      '</label>',
      '<div class="dispatch-loop-body">',

      intervalRow,

      '<div class="dispatch-loop-row">',
      '<span class="dispatch-loop-row-label">' + (isZh ? '截止时间' : 'End at') + '</span>',
      '<div class="dispatch-time-inputs">',
      '<input type="number" id="dispatch-end-year" class="dispatch-time-input" style="width:48px;" min="2024" max="2099" value="' + eYear + '" oninput="window.updateDispatchEndTime()">',
      '<span class="dispatch-time-sep">/</span>',
      '<input type="number" id="dispatch-end-month" class="dispatch-time-input" min="1" max="12" value="' + eMonth + '" oninput="window.updateDispatchEndTime()">',
      '<span class="dispatch-time-sep">/</span>',
      '<input type="number" id="dispatch-end-day" class="dispatch-time-input" min="1" max="31" value="' + eDay + '" oninput="window.updateDispatchEndTime()">',
      '<span class="dispatch-time-sep" style="margin-right:6px;">' + (isZh ? '' : 'd') + '</span>',
      '<input type="number" id="dispatch-end-hour" class="dispatch-time-input" min="0" max="23" value="' + eHour + '" oninput="window.updateDispatchEndTime()">',
      '<span class="dispatch-time-sep">:</span>',
      '<input type="number" id="dispatch-end-min" class="dispatch-time-input" min="0" max="59" value="' + eMin + '" oninput="window.updateDispatchEndTime()">',
      '</div>',
      '</div>',

      '<div class="dispatch-end-presets" style="margin-top:4px;">', presetChips, '</div>',

      '<div class="dispatch-loop-row">',
      '<span class="dispatch-loop-row-label">' + (isZh ? '次数上限' : 'Max') + '</span>',
      '<div class="dispatch-input-group">',
      '<input type="number" id="dispatch-loop-max" class="dispatch-input" style="width:80px;" min="1" max="9999" value="" placeholder="∞">',
      '<span class="dispatch-input-suffix">' + (isZh ? '次' : 'x') + '</span>',
      '</div>',
      '</div>',

      '<label class="dispatch-loop-toggle" style="margin-top:4px;">',
      '<input type="checkbox" id="dispatch-loop-active-only">',
      (isZh ? '仅对已启动的会话生效' : 'Only fire for active sessions'),
      '</label>',

      '</div>',
      '<input type="hidden" id="dispatch-loop-end-ts" value="' + defaultEndTs + '">',
      '</div>',
    ].join('');
  }

  // ── Context-dependent fields ──
  let contextFields = '';

  if (currentMode === 'continue') {
    // Project picker first
    if (selectedAgent !== 'qqbot' && projects.length > 0) {
      const projOpts = projects.map(p =>
        '<option value="' + escapeHtml(p.id) + '">' + escapeHtml(p.name || 'Unnamed') + '</option>'
      ).join('');
      contextFields += [
        '<div class="dispatch-form-row">',
        '<label class="dispatch-label">' + (isZh ? '项目' : 'Project') + '</label>',
        '<select id="dispatch-project" class="dispatch-select" onchange="window.onDispatchProjectChange()">', projOpts, '</select>',
        '</div>',
      ].join('');
    }

    // Session picker: filtered by selected project, with "latest" option
    const selectedProject = window._dispatchContinueProject || (projects[0]?.id || '');
    const filteredSessions = sessions.filter(s => {
      if (selectedAgent === 'programming-helper' && s.sessionType === 'exploration') return false;
      if (selectedProject && s.projectId && s.projectId !== selectedProject) return false;
      return true;
    });
    const latestLabel = isZh ? '⭐ 最新对话（动态路由）' : '⭐ Latest session (dynamic)';
    const sessionOpts = (filteredSessions.length > 0
      ? filteredSessions.map(s => '<option value="' + escapeHtml(s.id) + '">' + escapeHtml(s.title || s.id.slice(0, 16)) + '</option>').join('')
      : '') || '';
    contextFields += [
      '<div class="dispatch-form-row">',
      '<label class="dispatch-label">' + (isZh ? '选择对话' : 'Session') + '</label>',
      '<select id="dispatch-session" class="dispatch-select">',
      '<option value="__latest__">' + latestLabel + '</option>',
      sessionOpts,
      '</select>',
      '</div>',
    ].join('');
  } else {
    // new-exploration / new-main: show project picker if workspace has multiple projects
    if (selectedAgent !== 'qqbot' && projects.length > 0) {
      const projOpts = projects.map(p =>
        '<option value="' + escapeHtml(p.id) + '">' + escapeHtml(p.name || 'Unnamed') + '</option>'
      ).join('');
      contextFields = [
        '<div class="dispatch-form-row">',
        '<label class="dispatch-label">' + (isZh ? '项目' : 'Project') + '</label>',
        '<select id="dispatch-project" class="dispatch-select">', projOpts, '</select>',
        '</div>',
      ].join('');
    }
  }

  return [
    '<div class="feature-detail-overlay">',
    '<div class="feature-detail-window" style="max-width:540px;gap:12px;">',

    '<div class="feature-detail-head">',
    '<div>',
    '<div class="feature-detail-title">' + (isZh ? '添加 Schedule' : 'Add Schedule') + '</div>',
    '<div class="feature-detail-subtitle">' + escapeHtml(agentName) + '</div>',
    '</div>',
    '<button class="feature-detail-close" type="button" onclick="window.closeDispatchModal()">×</button>',
    '</div>',

    '<div class="dispatch-mode-selector">', modeCards, '</div>',

    triggerDefs.length > 1 ? [
      '<div class="dispatch-trigger-tabs">',
      triggerTabs,
      '</div>',
    ].join('') : '',

    '<div class="dispatch-form">',
    triggerFields,
    loopSection,
    contextFields,
    '<div class="dispatch-form-row">',
    '<label class="dispatch-label">' + (isZh ? '消息' : 'Message') + '</label>',
    '<textarea id="dispatch-message" class="dispatch-textarea" rows="4" placeholder="' + (isZh ? '要发送的消息...' : 'Message to send...') + '"></textarea>',
    '</div>',
    '</div>',

    '<div class="ph-mc-footer" style="display:flex;gap:10px;justify-content:flex-end;">',
    '<button class="settings-btn settings-btn-primary" type="button" onclick="window.createDispatchSchedule()">' + (isZh ? '创建' : 'Create') + '</button>',
    '<button class="settings-btn settings-btn-secondary" type="button" onclick="window.closeDispatchModal()">' + (isZh ? '取消' : 'Cancel') + '</button>',
    '</div>',

    '</div>',
    '</div>',
  ].join('');
}

// ── End Dispatch Console ─────────────────────────────────────────
