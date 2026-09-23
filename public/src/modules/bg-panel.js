/**
 * bg-panel.js — 后台任务实时面板（feature-comms 通道的消费端）。
 *
 * 数据链路（ADR-0018 首个真实接入）：
 *   BgRegistry 事件 → ShellBgCommsFeature（shell-bg-comms feature）
 *     → /protoclaw/feature-comms/publish（server store）
 *     → 本面板经 /protoclaw/feature-comms/stream（SSE）订阅渲染；
 *   kill / 输出查看经 /protoclaw/feature-comms/request → runtime
 *   onHostRequest（list / status / kill）。
 *
 * 面板是尽力而为的镜像面：通道不可用时降级为空态提示，任务状态真值
 * 仍是 bash_bg / bg_status。
 *
 * 宿主全局依赖（debug-panel-host 契约）：
 *   - focusedAgentId, currentRuntimeAgentId, currentLanguage, activeFeaturePanel
 *   - getRuntimeWorkspaceSessionId, getActiveWorkspaceSessionId, isRemoteNamespaceAgentId
 */
(function () {
  'use strict';

  const FEATURE_ID = 'shell-bg-comms';
  const CHANNEL_ID = 'shell-bg';
  const REFRESH_SESSION_WATCH_MS = 2_000;

  /** taskId -> BgTaskSnapshot（通道事件 + list 请求合并） */
  const tasks = new Map();
  /** taskId -> 展开的输出尾部文本（点"输出"按需经 status 请求拉取） */
  const outputTails = new Map();
  const state = {
    status: 'idle', // idle | connecting | live | unavailable | closed
    message: '',
    agentId: '',
    sessionId: '',
  };
  let source = null;
  let sessionWatchTimer = null;
  let requestSeq = 0;

  function t(zh, en) {
    return (typeof currentLanguage === 'string' ? currentLanguage : 'zh') === 'zh' ? zh : en;
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ── 寻址（对齐 session-controls-panel 的宿主身份纪律）─────────────

  function currentAddressing() {
    const runtimeRef = typeof currentRuntimeAgentId === 'string' ? currentRuntimeAgentId : '';
    const sessionId = (typeof getRuntimeWorkspaceSessionId === 'function' && runtimeRef
      ? getRuntimeWorkspaceSessionId(runtimeRef)
      : '') || (typeof getActiveWorkspaceSessionId === 'function' ? getActiveWorkspaceSessionId() : '');
    if (!sessionId) return null;
    // 远程会话没有本机 feature-comms 通道，降级为不可用（不猜目标）。
    const focused = typeof focusedAgentId === 'string' ? focusedAgentId : '';
    if (typeof isRemoteNamespaceAgentId === 'function'
      && (isRemoteNamespaceAgentId(focused) || isRemoteNamespaceAgentId(runtimeRef))) return null;
    const agentId = focused || '';
    if (!agentId) return null;
    return { agentId, sessionId };
  }

  // ── 服务端请求面 ─────────────────────────────────────────────────

  async function channelRequest(requestType, payload) {
    const addressing = currentAddressing();
    if (!addressing) return { ok: false, code: 'no_session' };
    const response = await fetch('/protoclaw/feature-comms/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: addressing.agentId,
        sessionId: addressing.sessionId,
        featureId: FEATURE_ID,
        channelId: CHANNEL_ID,
        requestType,
        payload: payload || {},
      }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      return { ok: false, code: body?.code || body?.result?.code || `HTTP ${response.status}` };
    }
    return body?.result || { ok: false, code: 'empty_result' };
  }

  // ── 渲染 ─────────────────────────────────────────────────────────

  function statusLabel(task) {
    if (task.status === 'running') {
      return task.readyFired ? t('运行（已就绪）', 'Running (ready)') : t('运行中', 'Running');
    }
    if (task.status === 'done') return `${t('完成', 'Done')}(${task.exitCode ?? '?'})`;
    if (task.status === 'killed') return t('已终止', 'Killed');
    if (task.status === 'terminated') return t('被打断', 'Terminated');
    return escapeHtml(task.status);
  }

  function formatDuration(ms) {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '-';
    const sec = Math.floor(ms / 1000);
    if (sec < 60) return `${sec}s`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m${sec % 60}s`;
    return `${Math.floor(min / 60)}h${min % 60}m`;
  }

  function renderTaskRow(task) {
    const running = task.status === 'running';
    const expanded = outputTails.has(task.id);
    const tail = outputTails.get(task.id) || '';
    return `
      <div class="bgp-task" data-bgp-task="${escapeHtml(task.id)}">
        <div class="bgp-task-main">
          <span class="bgp-dot bgp-dot-${escapeHtml(task.status)}"></span>
          <span class="bgp-command" title="${escapeHtml(task.command)}">${escapeHtml(task.command)}</span>
          <span class="bgp-meta">${statusLabel(task)} · ${formatDuration(task.durationMs)}</span>
          <span class="bgp-actions">
            <button class="bgp-btn" data-bgp-action="output" data-bgp-id="${escapeHtml(task.id)}">${expanded ? t('收起', 'Hide') : t('输出', 'Output')}</button>
            ${running ? `<button class="bgp-btn bgp-btn-danger" data-bgp-action="kill" data-bgp-id="${escapeHtml(task.id)}">${t('终止', 'Kill')}</button>` : ''}
          </span>
        </div>
        ${expanded ? `<pre class="bgp-output">${tail ? escapeHtml(tail) : t('（暂无输出）', '(no output)')}</pre>` : ''}
      </div>`;
  }

  function statusLineHtml() {
    switch (state.status) {
      case 'live': return `<span class="bgp-live-dot"></span>${t('实时', 'Live')}`;
      case 'connecting': return t('连接中…', 'Connecting…');
      case 'closed': return t('会话通道已关闭', 'Session channel closed');
      case 'unavailable': return t('当前会话无实时通道', 'No live channel for this session');
      default: return '';
    }
  }

  function getHtml() {
    const sorted = Array.from(tasks.values())
      .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
    const rows = sorted.map(renderTaskRow).join('');
    const empty = sorted.length === 0
      ? `<div class="feature-panel-empty"><div>${t('暂无后台任务（bash_bg 启动的任务会出现在这里）', 'No background tasks (bash_bg tasks appear here)')}</div></div>`
      : '';
    return `
      <div id="bg-panel-root" class="bgp-root">
        <div class="bgp-header">
          <span class="bgp-status">${statusLineHtml()}</span>
          <button class="bgp-btn" data-bgp-action="refresh">${t('刷新', 'Refresh')}</button>
        </div>
        ${rows || empty}
      </div>`;
  }

  function repaint() {
    const root = document.getElementById('bg-panel-root');
    if (!root) return;
    root.outerHTML = getHtml();
  }

  // ── 通道生命周期 ─────────────────────────────────────────────────

  function teardownChannel() {
    if (source) { source.close(); source = null; }
    if (sessionWatchTimer) { clearInterval(sessionWatchTimer); sessionWatchTimer = null; }
  }

  function applyEventTask(data) {
    if (!data || typeof data.id !== 'string') return;
    tasks.set(data.id, data);
  }

  function handleStreamEvent(data) {
    const payload = JSON.parse(data);
    if (payload?.type && payload?.data) applyEventTask(payload.data);
    repaint();
  }

  async function refreshList() {
    const seq = ++requestSeq;
    const result = await channelRequest('list', {});
    if (seq !== requestSeq) return; // 会话切换后过期响应直接丢弃
    if (result.ok === true && Array.isArray(result.tasks)) {
      tasks.clear();
      for (const task of result.tasks) applyEventTask(task);
      if (state.status !== 'live') { state.status = 'connecting'; }
    } else if (result.code === 'channel_not_declared' || result.code === 'runtime_not_connected') {
      state.status = 'unavailable';
    }
    repaint();
  }

  function startChannel() {
    teardownChannel();
    tasks.clear();
    outputTails.clear();
    const addressing = currentAddressing();
    if (!addressing) {
      state.status = 'unavailable';
      repaint();
      return;
    }
    state.agentId = addressing.agentId;
    state.sessionId = addressing.sessionId;
    state.status = 'connecting';
    repaint();

    const params = new URLSearchParams({
      agentId: state.agentId,
      sessionId: state.sessionId,
      featureId: FEATURE_ID,
      channelId: CHANNEL_ID,
    });
    source = new EventSource(`/protoclaw/feature-comms/stream?${params.toString()}`);
    source.addEventListener('open', () => {
      state.status = 'live';
      void refreshList();
      repaint();
    });
    source.addEventListener('event', (e) => handleStreamEvent(e.data));
    source.addEventListener('snapshot', (e) => {
      // 快照负载：{ revision, data }（本通道目前只发事件，快照留作协议兼容）
      try {
        const payload = JSON.parse(e.data);
        if (Array.isArray(payload?.data?.tasks)) {
          tasks.clear();
          for (const task of payload.data.tasks) applyEventTask(task);
        }
      } catch { /* 忽略畸形负载 */ }
      repaint();
    });
    source.addEventListener('resync', () => { void refreshList(); });
    source.addEventListener('closed', () => {
      state.status = 'closed';
      teardownChannel();
      repaint();
    });
    source.addEventListener('error', () => {
      // 连接失败（如 404 channel_not_declared）：降级提示，等待会话切换重试。
      if (state.status !== 'live') {
        state.status = 'unavailable';
        teardownChannel();
        repaint();
      }
    });

    // 会话切换守卫：面板常开时，焦点会话变了就重订通道（对齐面板寻址纪律）；
    // 面板被取消激活（如切出 chat 表面）时自动拆通道，不留隐藏订阅。
    sessionWatchTimer = setInterval(() => {
      if (typeof activeFeaturePanel !== 'string' || activeFeaturePanel !== 'bg') {
        teardownChannel();
        return;
      }
      const current = currentAddressing();
      if (!current || current.agentId !== state.agentId || current.sessionId !== state.sessionId) {
        startChannel();
      }
    }, REFRESH_SESSION_WATCH_MS);
  }

  // ── 交互（document 级委托，innerHTML 重写不丢监听）───────────────

  document.addEventListener('click', async (e) => {
    const button = e.target.closest('#bg-panel-root [data-bgp-action]');
    if (!button) return;
    const action = button.dataset.bgpAction;
    const taskId = button.dataset.bgpId || '';
    if (action === 'refresh') {
      await refreshList();
      return;
    }
    if (action === 'output') {
      if (outputTails.has(taskId)) {
        outputTails.delete(taskId);
        repaint();
        return;
      }
      const result = await channelRequest('status', { taskId });
      if (result.ok === true) {
        applyEventTask(result.task);
        outputTails.set(taskId, String(result.outputTail || ''));
      }
      repaint();
      return;
    }
    if (action === 'kill') {
      if (!window.confirm(t('确认终止该后台任务？', 'Kill this background task?'))) return;
      const result = await channelRequest('kill', { taskId });
      if (result.ok !== true) {
        window.alert(t('终止失败：', 'Kill failed: ') + (result.code || ''));
      }
      // 终态经通道 finalized 事件回推；失败（通道断）时刷新兜底。
      await refreshList();
    }
  });

  // ── 样式（模块自持，避免全局样式表耦合）──────────────────────────

  const STYLE = `
    .bgp-root { display: flex; flex-direction: column; gap: 8px; padding: 10px; }
    .bgp-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .bgp-status { font-size: 12px; opacity: .8; display: inline-flex; align-items: center; gap: 6px; }
    .bgp-live-dot { width: 8px; height: 8px; border-radius: 50%; background: #22c55e; display: inline-block; animation: bgp-pulse 1.6s infinite; }
    @keyframes bgp-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
    .bgp-task { border: 1px solid var(--border-color, #333); border-radius: 8px; padding: 8px 10px; }
    .bgp-task-main { display: flex; align-items: center; gap: 8px; }
    .bgp-command { font-family: var(--mono-font, monospace); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
    .bgp-meta { font-size: 11px; opacity: .75; white-space: nowrap; }
    .bgp-actions { display: flex; gap: 4px; }
    .bgp-btn { font-size: 11px; padding: 2px 8px; border-radius: 6px; border: 1px solid var(--border-color, #333); background: transparent; color: inherit; cursor: pointer; }
    .bgp-btn:hover { opacity: .8; }
    .bgp-btn-danger { color: #ef4444; border-color: #ef444466; }
    .bgp-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
    .bgp-dot-running { background: #22c55e; }
    .bgp-dot-done { background: #3b82f6; }
    .bgp-dot-killed, .bgp-dot-terminated { background: #ef4444; }
    .bgp-output { margin: 8px 0 0; padding: 8px; font-size: 11px; font-family: var(--mono-font, monospace); white-space: pre-wrap; word-break: break-all; max-height: 240px; overflow: auto; background: var(--bg-soft, rgba(127,127,127,.08)); border-radius: 6px; }
  `;
  const styleElement = document.createElement('style');
  styleElement.textContent = STYLE;
  document.head.appendChild(styleElement);

  window.BgPanel = {
    getHtml,
    onOpen: startChannel,
    onClose: teardownChannel,
    refresh: refreshList,
  };
})();
