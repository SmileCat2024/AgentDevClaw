/* coder-tickets-ui.js — coder 工作空间工单看板（外部目录消费模式） */

window.CoderTicketsUI = (() => {
  const INTAKE_DIR_STORAGE_KEY = 'coder-intake-dir';
  const AUTO_REFRESH_INTERVAL = 4000;

  let tickets = [];
  let externalTickets = [];
  let intakeDir = '';
  let loading = false;
  let loaded = false;
  let intakeLoaded = false;
  let lastRefreshAt = 0;
  let refreshTimer = null;

  function scheduleAutoRefresh() {
    if (refreshTimer) return;
    refreshTimer = setInterval(() => {
      if (typeof document === 'undefined' || document.hidden) return;
      refresh();
    }, AUTO_REFRESH_INTERVAL + 1000);
  }

  function refresh() {
    if (loading) return;
    loading = true;
    const jobs = [fetchTickets()];
    if (intakeDir) jobs.push(fetchIntake(intakeDir));
    Promise.allSettled(jobs)
      .finally(() => {
        loading = false;
        lastRefreshAt = Date.now();
        if (typeof renderCurrentMainView === 'function') renderCurrentMainView();
      });
  }

  function fetchTickets() {
    return fetch('/protoclaw/coder/tickets')
      .then((response) => response.ok ? response.json() : Promise.reject(new Error('Failed to load tickets')))
      .then((payload) => {
        tickets = Array.isArray(payload?.tickets) ? payload.tickets : [];
        loaded = true;
      });
  }

  function fetchIntake(dir) {
    return fetch('/protoclaw/coder/ticket_intake?dir=' + encodeURIComponent(dir))
      .then((response) => response.ok ? response.json() : Promise.reject(new Error('Failed to load tickets directory')))
      .then((payload) => {
        externalTickets = Array.isArray(payload?.tickets) ? payload.tickets : [];
        intakeLoaded = true;
      });
  }

  function statusLabel(status) {
    const labels = {
      queued: currentLanguage === 'zh' ? '等待恢复' : 'Queued',
      running: currentLanguage === 'zh' ? '执行中' : 'Running',
      blocked: currentLanguage === 'zh' ? '需要处理' : 'Blocked',
      done: currentLanguage === 'zh' ? '已完成' : 'Done',
    };
    return labels[status] || status;
  }

  function policyLabel(policy) {
    return policy === 'auto'
      ? (currentLanguage === 'zh' ? '可自动完成' : 'Auto complete')
      : (currentLanguage === 'zh' ? '人工验收' : 'Review required');
  }

  function shortId(value) {
    if (!value) return '';
    return value.length > 18 ? value.slice(0, 8) + '…' + value.slice(-6) : value;
  }

  function renderTicket(ticket) {
    const sessionAction = ticket.headSessionId
      ? escapeHtml(JSON.stringify({ type: 'open_session', sessionId: ticket.headSessionId }))
      : '';
    const lineage = [
      ticket.threadId
        ? '<span class="coder-ticket-lineage" title="' + escapeHtml(ticket.threadId) + '">' + (currentLanguage === 'zh' ? '线程 ' : 'thread ') + escapeHtml(shortId(ticket.threadId)) + '</span>'
        : '',
      ticket.headSessionId
        ? '<span class="coder-ticket-lineage" title="' + escapeHtml(ticket.headSessionId) + '">' + (currentLanguage === 'zh' ? '会话 ' : 'session ') + escapeHtml(shortId(ticket.headSessionId)) + '</span>'
        : '',
    ].filter(Boolean).join('');
    const actions = [
      ticket.headSessionId
        ? '<button class="coder-ticket-btn secondary" type="button" data-workspace-action="' + sessionAction + '" onclick="window.runWorkspaceAction(this.dataset.workspaceAction, this)">' + (currentLanguage === 'zh' ? '查看执行' : 'Open run') + '</button>'
        : '',
      ticket.status === 'blocked' || ticket.status === 'queued'
        ? '<button class="coder-ticket-btn" type="button" onclick="window.CoderTicketsUI.resume(\'' + escapeHtml(ticket.id) + '\')">' + (currentLanguage === 'zh' ? '继续' : 'Resume') + '</button>'
        : '',
      ticket.status !== 'done'
        ? '<button class="coder-ticket-btn secondary" type="button" onclick="window.CoderTicketsUI.done(\'' + escapeHtml(ticket.id) + '\')">' + (currentLanguage === 'zh' ? '标为完成' : 'Mark done') + '</button>'
        : '',
    ].filter(Boolean).join('');

    return [
      '<article class="coder-ticket-card">',
      '<div class="coder-ticket-card-head">',
      '<span class="coder-ticket-status status-' + escapeHtml(ticket.status) + '">' + escapeHtml(statusLabel(ticket.status)) + '</span>',
      '<span class="coder-ticket-policy">' + escapeHtml(policyLabel(ticket.completionPolicy)) + '</span>',
      '</div>',
      '<div class="coder-ticket-instruction">' + escapeHtml(ticket.instruction) + '</div>',
      '<div class="coder-ticket-project" title="' + escapeHtml(ticket.projectDir) + '">' + escapeHtml(ticket.projectDir) + '</div>',
      lineage ? '<div class="coder-ticket-lineage-row">' + lineage + '</div>' : '',
      ticket.blockedReason ? '<div class="coder-ticket-blocked">' + escapeHtml(ticket.blockedReason) + '</div>' : '',
      '<div class="coder-ticket-actions">' + actions + '</div>',
      '</article>',
    ].join('');
  }

  function renderExternalTicket(ticket, index) {
    const zh = currentLanguage === 'zh';
    const badge = ticket.parseError
      ? '<span class="coder-ticket-status status-blocked">' + (zh ? '无效 JSON' : 'Invalid JSON') + '</span>'
      : ticket.dispatched
        ? '<span class="coder-ticket-status status-' + escapeHtml(ticket.status || 'queued') + '">' + escapeHtml(statusLabel(ticket.status) || ticket.status) + '</span>'
        : '<span class="coder-ticket-intake-badge">' + (zh ? '未派发' : 'Not dispatched') + '</span>';
    const dispatchable = !ticket.parseError && !(ticket.dispatched && (ticket.status === 'running' || ticket.status === 'done'));
    return [
      '<article class="coder-intake-card">',
      '<div class="coder-ticket-card-head">',
      '<span class="coder-intake-id">' + escapeHtml(ticket.id) + '</span>',
      badge,
      '</div>',
      ticket.title ? '<div class="coder-intake-title">' + escapeHtml(ticket.title) + '</div>' : '',
      ticket.instruction
        ? '<details class="coder-intake-details"><summary>' + (zh ? '工单指令' : 'Instruction') + '</summary><pre>' + escapeHtml(ticket.instruction) + '</pre></details>'
        : '',
      ticket.projectDir
        ? '<div class="coder-ticket-project" title="' + escapeHtml(ticket.projectDir) + '">' + (zh ? '自带目录 ' : 'dir ') + escapeHtml(ticket.projectDir) + '</div>'
        : '',
      dispatchable
        ? [
            '<div class="coder-ticket-create-row">',
            '<input id="coder-intake-project-' + index + '" type="text" placeholder="' + escapeHtml(zh ? '项目目录（工单未自带时必填）' : 'Project directory (required if ticket has none)') + '" value="' + escapeHtml(ticket.projectDir || '') + '">',
            '<button class="coder-ticket-btn" type="button" onclick="window.CoderTicketsUI.dispatch(' + index + ')">' + (zh ? '派发执行' : 'Dispatch') + '</button>',
            '</div>',
          ].join('')
        : '',
      '</article>',
    ].join('');
  }

  function render() {
    if (!loaded && !loading) refresh();
    if (!refreshTimer && typeof setInterval === 'function') scheduleAutoRefresh();
    const zh = currentLanguage === 'zh';
    const title = zh ? '工单看板' : 'Ticket board';
    const description = zh
      ? '工单来自外部 tickets 目录：列出、点击派发，coder 以持续线程承接执行。'
      : 'Tickets come from an external directory: list them, dispatch on click, and coder executes them on continuous threads.';
    const intakeTitle = zh ? 'Tickets 目录' : 'Tickets directory';

    return [
      '<section class="coder-tickets">',
      '<div class="coder-ticket-heading"><div><div class="coder-ticket-kicker">24H CODER</div><h2>' + title + '</h2><p>' + description + '</p></div></div>',

      '<div class="coder-ticket-intake">',
      '<h3 class="coder-intake-heading">' + intakeTitle + '</h3>',
      '<div class="coder-ticket-create-row">',
      '<input id="coder-intake-dir" type="text" placeholder="' + escapeHtml(zh ? '例如 D:\\tickets\\my-feature' : 'e.g. D:\\tickets\\my-feature') + '" value="' + escapeHtml(intakeDir) + '">',
      '<button class="coder-ticket-btn" type="button" onclick="window.CoderTicketsUI.loadIntake()">' + (zh ? '加载' : 'Load') + '</button>',
      '</div>',
      '<div class="coder-intake-list">',
      intakeLoaded && externalTickets.length === 0
        ? '<div class="coder-ticket-empty">' + (zh ? '该目录下没有 JSON 工单。' : 'No JSON tickets in this directory.') + '</div>'
        : '',
      externalTickets.map(renderExternalTicket).join(''),
      '</div>',
      '</div>',

      '<div class="coder-ticket-list">',
      loading && !loaded ? '<div class="coder-ticket-empty">' + (zh ? '正在读取工单…' : 'Loading tickets…') + '</div>' : '',
      !loading && loaded && tickets.length === 0 ? '<div class="coder-ticket-empty">' + (zh ? '暂无已派发工单。' : 'No dispatched tickets yet.') + '</div>' : '',
      tickets.map(renderTicket).join(''),
      '</div></section>',
    ].join('');
  }

  async function request(path, body) {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) throw new Error(payload.error || 'Ticket request failed');
    return payload;
  }

  function loadIntake() {
    const dir = (document.getElementById('coder-intake-dir')?.value || '').trim();
    if (!dir) {
      if (typeof ClawToast !== 'undefined') ClawToast.error(currentLanguage === 'zh' ? '请输入 tickets 目录' : 'Tickets directory is required');
      return;
    }
    intakeDir = dir;
    try { localStorage.setItem(INTAKE_DIR_STORAGE_KEY, dir); } catch {}
    fetchIntake(dir)
      .then(() => { if (typeof renderCurrentMainView === 'function') renderCurrentMainView(); })
      .catch((error) => {
        if (typeof ClawToast !== 'undefined') ClawToast.error(error.message || 'Failed to load tickets directory');
      });
  }

  async function dispatch(index) {
    const ticket = externalTickets[index];
    if (!ticket) return;
    const projectDir = (document.getElementById('coder-intake-project-' + index)?.value || '').trim();
    try {
      await request('/protoclaw/coder/ticket_intake/dispatch', { ticketsDir: intakeDir, ticketId: ticket.id, projectDir });
      refresh();
      if (typeof loadAgents === 'function') loadAgents();
    } catch (error) {
      if (typeof ClawToast !== 'undefined') ClawToast.error(error.message || 'Failed to dispatch ticket');
    }
  }

  async function resume(ticketId) {
    try {
      await request('/protoclaw/coder/tickets/' + encodeURIComponent(ticketId) + '/resume');
      refresh();
    } catch (error) {
      if (typeof ClawToast !== 'undefined') ClawToast.error(error.message || 'Failed to resume ticket');
    }
  }

  async function done(ticketId) {
    try {
      await request('/protoclaw/coder/tickets/' + encodeURIComponent(ticketId) + '/done');
      refresh();
    } catch (error) {
      if (typeof ClawToast !== 'undefined') ClawToast.error(error.message || 'Failed to update ticket');
    }
  }

  try {
    const stored = localStorage.getItem(INTAKE_DIR_STORAGE_KEY);
    if (stored) intakeDir = stored;
  } catch {}

  return { render, refresh, loadIntake, dispatch, resume, done };
})();
