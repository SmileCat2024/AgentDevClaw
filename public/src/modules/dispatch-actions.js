/**
 * Dispatch Console Actions 模块
 * 从 app-main.js 拆出 (域 U: dispatch 操作)
 *
 * 依赖全局状态 (定义在 app-core.js):
 *   currentLanguage
 * 依赖全局函数 (定义在 app-ui.js):
 *   renderCurrentMainView
 * 导出全局函数 (window.*):
 *   loadDispatchSchedules, loadDispatchAgents, openDispatchModalFor,
 *   openDispatchModal, closeDispatchModal, selectDispatchAgent,
 *   selectDispatchTrigger, selectDispatchMode, createDispatchSchedule,
 *   cancelDispatchSchedule, showDispatchDetail, closeDispatchDetail,
 *   selectDispatchEndPreset, updateDispatchEndTime, onDispatchProjectChange,
 *   loadDispatchPHSessions, loadDispatchPHProjects,
 *   loadDispatchSessionsForAgent, loadDispatchProjectsForAgent
 */

// ── Dispatch Console ──────────────────────────────────────────────
window._dispatchSchedules = [];
window._dispatchAgents = [];
window._dispatchSessions = [];
window._dispatchProjects = [];
window._dispatchSelectedAgent = null;
window._dispatchTriggerType = 'timer';
window._dispatchMode = 'continue';
window._dispatchSchedulesLoaded = false;
window._dispatchAgentsLoaded = false;
window._dispatchListTab = 'pending';
window._dispatchSchedulesUpdatedAt = 0;
window._dispatchSchedulesSignature = '';
window._dispatchSchedulesRefreshPromise = null;
window._dispatchAgentsUpdatedAt = 0;
window._dispatchAgentsSignature = '';
window._dispatchAgentsRefreshPromise = null;

function getDispatchSchedulesSignature(schedules) {
  return JSON.stringify((Array.isArray(schedules) ? schedules : []).map((schedule) => ({
    id: schedule?.id || '',
    status: schedule?.status || '',
    fireAt: schedule?.fireAt || '',
    firedAt: schedule?.firedAt || '',
    completedAt: schedule?.completedAt || '',
    loopFiredCount: schedule?.loopFiredCount || 0,
    result: schedule?.result || '',
    error: schedule?.error || '',
  })));
}

function getDispatchAgentsSignature(agents) {
  return JSON.stringify((Array.isArray(agents) ? agents : []).map((agent) => ({
    id: agent?.id || '',
    name: agent?.name || '',
    activeSessionId: agent?.activeSessionId || '',
    sessionCount: Array.isArray(agent?.sessions) ? agent.sessions.length : 0,
  })));
}

window.loadDispatchSchedules = async () => {
  if (window._dispatchSchedulesRefreshPromise) {
    return window._dispatchSchedulesRefreshPromise;
  }
  window._dispatchSchedulesRefreshPromise = (async () => {
  try {
    const res = await fetch('/protoclaw/dispatch/schedules');
    const data = await res.json();
    const nextSchedules = Array.isArray(data?.schedules) ? data.schedules : [];
    window._dispatchSchedules = nextSchedules;
    window._dispatchSchedulesSignature = getDispatchSchedulesSignature(nextSchedules);
    window._dispatchSchedulesUpdatedAt = Date.now();
    window._dispatchSchedulesLoaded = true;
    return nextSchedules;
  } catch (e) {
    console.error('Failed to load dispatch schedules:', e);
    return window._dispatchSchedules || [];
  } finally {
    window._dispatchSchedulesRefreshPromise = null;
  }
  })();
  return window._dispatchSchedulesRefreshPromise;
};

window.loadDispatchAgents = async () => {
  if (window._dispatchAgentsRefreshPromise) {
    return window._dispatchAgentsRefreshPromise;
  }
  window._dispatchAgentsRefreshPromise = (async () => {
  try {
    const res = await fetch('/protoclaw/get_prebuilt_agents');
    const agents = await res.json();
    const list = Array.isArray(agents) ? agents : [];
    const nextAgents = list.map(a => ({
      id: a.id,
      name: a.name || a.id,
      description: a.description || '',
      icon: a.icon || 'terminal',
      sessions: a.workspace_sessions?.sessions || [],
      activeSessionId: a.workspace_sessions?.activeSessionId || null,
    }));
    window._dispatchAgents = nextAgents;
    window._dispatchAgentsSignature = getDispatchAgentsSignature(nextAgents);
    window._dispatchAgentsUpdatedAt = Date.now();
    if (!window._dispatchSelectedAgent && window._dispatchAgents.length > 0) {
      window._dispatchSelectedAgent = window._dispatchAgents[0].id;
    }
    return nextAgents;
  } catch (e) {
    console.error('Failed to load dispatch agents:', e);
    window._dispatchAgents = [];
    return [];
  } finally {
    window._dispatchAgentsRefreshPromise = null;
  }
  })();
  return window._dispatchAgentsRefreshPromise;
};

window.refreshDispatchConsoleData = async (options = {}) => {
  const { force = false, render = false } = options;
  const now = Date.now();
  const schedulesStale = force || !window._dispatchSchedulesLoaded || (now - (window._dispatchSchedulesUpdatedAt || 0) > 1500);
  const agentsStale = force || !window._dispatchAgentsLoaded || (now - (window._dispatchAgentsUpdatedAt || 0) > 10000);
  if (!schedulesStale && !agentsStale) {
    // Data is fresh — but still honor render request (e.g. checkbox state depends on promise lifecycle)
    if (render) { renderCurrentMainView(); }
    return false;
  }

  const prevScheduleSig = window._dispatchSchedulesSignature || '';
  const prevAgentSig = window._dispatchAgentsSignature || '';
  await Promise.all([
    schedulesStale ? window.loadDispatchSchedules() : Promise.resolve(window._dispatchSchedules || []),
    agentsStale ? window.loadDispatchAgents() : Promise.resolve(window._dispatchAgents || []),
  ]);
  window._dispatchAgentsLoaded = true;
  const changed = prevScheduleSig !== (window._dispatchSchedulesSignature || '')
    || prevAgentSig !== (window._dispatchAgentsSignature || '');
  if (render) {
    renderCurrentMainView();
  }
  return changed;
};

window.selectDispatchAgent = (agentId) => {
  window._dispatchSelectedAgent = agentId;
};

window.openDispatchModalFor = async (agentId) => {
  window._dispatchModalAgent = agentId;
  window._dispatchSelectedAgent = agentId;
  window._dispatchShowModal = true;
  window._dispatchTriggerType = 'timer';
  window._dispatchMode = 'continue';
  // Render modal immediately (shows loading state), then load data in background
  window._dispatchSessions = [];
  window._dispatchProjects = [];
  renderCurrentMainView();
  // Defer data loading so modal opens instantly
  const [sessRes, projRes] = await Promise.all([
    fetch('/protoclaw/prebuilt_sessions?agentId=' + encodeURIComponent(agentId)).then(r => r.json()).catch(() => ({ sessions: [] })),
    fetch('/protoclaw/dispatch/projects?agentId=' + encodeURIComponent(agentId)).then(r => r.json()).catch(() => ({ projects: [] })),
  ]);
  const sessions = Array.isArray(sessRes?.sessions) ? sessRes.sessions : [];
  window._dispatchSessions = sessions.map(s => {
    const openDir = s.openDirectory || '';
    const projectId = openDir ? 'dir:' + openDir.replace(/\\/g, '/').toLowerCase() : '';
    return {
      id: s.id,
      title: s.title || s.taskTitle || '',
      sessionType: s.sessionType || 'main',
      projectId,
    };
  });
  const projects = Array.isArray(projRes?.projects) ? projRes.projects : [];
  window._dispatchProjects = projects;
  // Only re-render if modal is still open
  if (window._dispatchShowModal) {
    renderCurrentMainView();
  }
};

window.openDispatchModal = async () => {
  const agentId = window._dispatchSelectedAgent;
  if (!agentId) return;
  window._dispatchModalAgent = agentId;
  window._dispatchShowModal = true;
  renderCurrentMainView();
};

window.closeDispatchModal = () => {
  window._dispatchShowModal = false;
  window._dispatchModalAgent = null;
  renderCurrentMainView();
};

window.loadDispatchSessionsForAgent = async (agentId) => {
  try {
    const res = await fetch('/protoclaw/prebuilt_sessions?agentId=' + encodeURIComponent(agentId));
    const data = await res.json();
    const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
    window._dispatchSessions = sessions.map(s => {
      const openDir = s.openDirectory || '';
      const projectId = openDir ? 'dir:' + openDir.replace(/\\/g, '/').toLowerCase() : '';
      return {
        id: s.id,
        title: s.title || s.taskTitle || '',
        sessionType: s.sessionType || 'main',
        projectId,
      };
    });
  } catch (e) {
    console.error('Failed to load sessions:', e);
    window._dispatchSessions = [];
  }
};

window.loadDispatchProjectsForAgent = async (agentId) => {
  try {
    const res = await fetch('/protoclaw/dispatch/projects?agentId=' + encodeURIComponent(agentId));
    const data = await res.json();
    window._dispatchProjects = Array.isArray(data?.projects) ? data.projects : [];
  } catch (e) {
    console.error('Failed to load projects:', e);
    window._dispatchProjects = [];
  }
};

window.onDispatchProjectChange = () => {
  const el = document.getElementById('dispatch-project');
  if (el) window._dispatchContinueProject = el.value;
  renderCurrentMainView();
};

window.selectDispatchEndPreset = (el, seconds) => {
  const target = new Date(Date.now() + seconds * 1000);
  const hidden = document.getElementById('dispatch-loop-end-ts');
  if (hidden) hidden.value = target.getTime();
  document.querySelectorAll('.dispatch-end-preset').forEach(e => e.classList.remove('active'));
  el.classList.add('active');
  const yEl = document.getElementById('dispatch-end-year');
  const mEl = document.getElementById('dispatch-end-month');
  const dEl = document.getElementById('dispatch-end-day');
  const hEl = document.getElementById('dispatch-end-hour');
  const minEl = document.getElementById('dispatch-end-min');
  if (yEl) yEl.value = target.getFullYear();
  if (mEl) mEl.value = target.getMonth() + 1;
  if (dEl) dEl.value = target.getDate();
  if (hEl) hEl.value = target.getHours();
  if (minEl) minEl.value = target.getMinutes();
};

window.updateDispatchEndTime = () => {
  const yEl = document.getElementById('dispatch-end-year');
  const mEl = document.getElementById('dispatch-end-month');
  const dEl = document.getElementById('dispatch-end-day');
  const hEl = document.getElementById('dispatch-end-hour');
  const minEl = document.getElementById('dispatch-end-min');
  const year = Math.max(2024, parseInt(yEl?.value || '2026', 10) || 2026);
  const month = Math.max(1, Math.min(12, parseInt(mEl?.value || '1', 10) || 1));
  const day = Math.max(1, Math.min(31, parseInt(dEl?.value || '1', 10) || 1));
  const hour = Math.max(0, Math.min(23, parseInt(hEl?.value || '0', 10) || 0));
  const minute = Math.max(0, Math.min(59, parseInt(minEl?.value || '0', 10) || 0));
  const target = new Date(year, month - 1, day, hour, minute, 0, 0);
  const hidden = document.getElementById('dispatch-loop-end-ts');
  if (hidden) hidden.value = target.getTime();
  document.querySelectorAll('.dispatch-end-preset').forEach(e => e.classList.remove('active'));
};

window.selectDispatchTrigger = (type) => {
  window._dispatchTriggerType = type;
  renderCurrentMainView();
};

window.selectDispatchMode = (mode) => {
  window._dispatchMode = mode;
  const TRIGGER_AVAIL = {
    'continue':        ['timer', 'on-idle'],
    'new-main':        ['timer', 'on-ready'],
    'new-exploration': ['timer', 'on-ready'],
  };
  const available = TRIGGER_AVAIL[mode] || ['timer'];
  if (!available.includes(window._dispatchTriggerType)) {
    window._dispatchTriggerType = available[0];
  }
  renderCurrentMainView();
};

window.loadDispatchPHSessions = async () => {
  const agentId = window._dispatchSelectedAgent || 'programming-helper';
  return window.loadDispatchSessionsForAgent(agentId);
};

window.loadDispatchPHProjects = async () => {
  const agentId = window._dispatchSelectedAgent || 'programming-helper';
  return window.loadDispatchProjectsForAgent(agentId);
};

window.createDispatchSchedule = async () => {
  const messageEl = document.getElementById('dispatch-message');
  const sessionEl = document.getElementById('dispatch-session');
  const projectEl = document.getElementById('dispatch-project');
  const secondsEl = document.getElementById('dispatch-seconds');
  const idleEl = document.getElementById('dispatch-idle-threshold');
  const loopEnableEl = document.getElementById('dispatch-loop-enable');
  const repeatEl = document.getElementById('dispatch-repeat');
  const loopMaxEl = document.getElementById('dispatch-loop-max');
  const loopEndTsEl = document.getElementById('dispatch-loop-end-ts');
  const loopActiveOnlyEl = document.getElementById('dispatch-loop-active-only');

  if (!messageEl) { console.warn('[Dispatch] messageEl not found'); return; }
  const message = messageEl.value.trim();
  if (!message) {
    alert(currentLanguage === 'zh' ? '请输入要发送的消息' : 'Please enter a message');
    return;
  }

  const agentId = window._dispatchSelectedAgent || 'programming-helper';
  const triggerType = window._dispatchTriggerType || 'timer';
  const mode = window._dispatchMode || 'continue';

  const body = {
    targetAgentId: agentId,
    message,
  };

  // ── Trigger config ──
  if (triggerType === 'timer') {
    const seconds = secondsEl ? Number(secondsEl.value) : 30;
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    body.secondsFromNow = seconds;
    body.trigger = { type: 'timer' };
  } else if (triggerType === 'on-idle') {
    const threshold = idleEl ? Number(idleEl.value) : 300;
    body.trigger = { type: 'on-idle', idleThreshold: threshold > 0 ? threshold : 300 };
  } else if (triggerType === 'on-ready') {
    body.trigger = { type: 'on-ready' };
  }

  // ── Loop config (timer + on-idle) ──
  const loopEnabled = loopEnableEl ? loopEnableEl.checked : false;
  if (loopEnabled && (triggerType === 'timer' || triggerType === 'on-idle')) {
    // For timer: repeatInterval is the loop interval; for on-idle: need to read the interval field
    let repeatVal = 0;
    if (triggerType === 'timer') {
      // timer loop interval defaults to the same as delay
      repeatVal = secondsEl ? Number(secondsEl.value) : 30;
    } else {
      // on-idle loop interval
      repeatVal = repeatEl ? Number(repeatEl.value) : 300;
    }
    if (Number.isFinite(repeatVal) && repeatVal > 0) {
      body.repeatInterval = repeatVal;
    }
    // Max count
    const maxCount = loopMaxEl ? Number(loopMaxEl.value) : 0;
    if (Number.isFinite(maxCount) && maxCount > 0) {
      body.loopMaxCount = maxCount;
    }
    // End time (absolute timestamp)
    const endTs = loopEndTsEl ? Number(loopEndTsEl.value) : 0;
    if (Number.isFinite(endTs) && endTs > Date.now()) {
      body.loopEndTime = endTs;
    }
    // Only active sessions
    const activeOnly = loopActiveOnlyEl ? loopActiveOnlyEl.checked : false;
    if (activeOnly) {
      body.onlyActiveSessions = true;
    }
  }

  // ── Mode-specific target config ──
  if (mode === 'continue') {
    const sessionVal = sessionEl ? sessionEl.value : '';
    if (sessionVal === '__latest__') {
      body.targetSessionId = '__latest__';
      // Also pass project context so server can resolve latest within project
      const projectVal = projectEl ? projectEl.value : '';
      if (projectVal) body.projectId = projectVal;
    } else if (sessionVal) {
      body.targetSessionId = sessionVal;
    }
  } else if (mode === 'new-exploration') {
    body.newSessionType = 'exploration';
    body.targetSessionId = null;
    const projectVal = projectEl ? projectEl.value : '';
    if (projectVal) body.projectId = projectVal;
  } else if (mode === 'new-main') {
    body.newSessionType = null;
    body.targetSessionId = null;
    const projectVal = projectEl ? projectEl.value : '';
    if (projectVal) body.projectId = projectVal;
  }

  console.log('[Dispatch] creating schedule:', JSON.stringify(body, null, 2));
  try {
    const res = await fetch('/protoclaw/dispatch/schedules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.error('Failed to create schedule:', err, 'body was:', body);
      alert('创建失败: ' + (err.error || res.status));
      return;
    }
    await window.refreshDispatchConsoleData({ force: true });
    messageEl.value = '';
    window._dispatchShowModal = false;
    window._dispatchModalAgent = null;
    renderCurrentMainView();
  } catch (e) {
    console.error('Failed to create dispatch schedule:', e, 'body was:', body);
    alert('创建失败: ' + e.message);
  }
};

window.cancelDispatchSchedule = async (scheduleId) => {
  try {
    await fetch('/protoclaw/dispatch/schedules/' + encodeURIComponent(scheduleId), { method: 'DELETE' });
    if (window._dispatchDetailId === scheduleId) window._dispatchDetailId = null;
    await window.refreshDispatchConsoleData({ force: true });
    renderCurrentMainView();
  } catch (e) {
    console.error('Failed to cancel schedule:', e);
  }
};

window.showDispatchDetail = (scheduleId) => {
  window._dispatchDetailId = scheduleId;
  renderCurrentMainView();
};

window.closeDispatchDetail = () => {
  window._dispatchDetailId = null;
  renderCurrentMainView();
};
// ── End Dispatch Console ──────────────────────────────────────────
