/**
 * bg-panel.js — 后台任务实时面板（feature-comms 通道的消费端）。
 *
 * 数据链路（ADR-0018 首个真实接入）：
 *   BgRegistry 事件 → ShellBgCommsFeature（shell-bg-comms feature）
 *     → /protoclaw/feature-comms/publish（server store）
 *     → 本面板经 /protoclaw/feature-comms/stream（SSE）订阅渲染。
 *
 * 面板心智：终端式小卡片，全自动——打开即订阅，事件实时推送，输出
 * 尾巴随事件下发（feature 端镜像附带），无任何按钮。终止等交互待
 * 功能定稿后再上；任务状态真值仍是 bash_bg / bg_status。
 *
 * 视觉对齐右侧面板既有设计语言（feature-panel-section 卡片、
 * bash-progress 系列观感、项目等宽字体栈与状态色变量）。
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
  const ELAPSED_TICK_MS = 1_000;
  /** 输出区距底不超过该值视为「跟随底部」，重绘后继续贴底；上翻阅读时不打扰。 */
  const FOLLOW_THRESHOLD_PX = 28;

  /** taskId -> 任务快照（通道事件 + list 合并，含 outputTail） */
  const tasks = new Map();
  const state = {
    status: 'idle', // idle | connecting | live | unavailable | closed
    agentId: '',
    sessionId: '',
  };
  let source = null;
  let sessionWatchTimer = null;
  let elapsedTimer = null;
  let lastHtml = '';

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

  // ── 服务端请求面（仅初始快照 / resync 对账用；实时更新走事件流）───

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

  function statusText(task) {
    if (task.status === 'running') {
      return task.readyFired ? t('运行 · 已就绪', 'running · ready') : t('运行中', 'running');
    }
    if (task.status === 'done') return `${t('完成', 'done')} · exit ${task.exitCode ?? '?'}`;
    if (task.status === 'killed') return t('已终止', 'killed');
    if (task.status === 'terminated') return t('被打断', 'terminated');
    return String(task.status || '');
  }  // 与 tool-progress.js 相同的紧凑时长格式（12s / 2m05s / 1h02m）
  function formatDuration(ms) {
    const totalSeconds = typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
    if (totalSeconds < 60) return `${totalSeconds}s`;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes < 60) {
      return seconds > 0 ? `${minutes}m${String(seconds).padStart(2, '0')}s` : `${minutes}m`;
    }
    const hours = Math.floor(minutes / 60);
    return `${hours}h${String(minutes % 60).padStart(2, '0')}m`;
  }

  function taskDurationMs(task) {
    if (task.status === 'running') {
      const startedAt = Number(task.startedAt);
      if (Number.isFinite(startedAt) && startedAt > 0) return Date.now() - startedAt;
      return null;
    }
    const duration = Number(task.durationMs);
    return Number.isFinite(duration) && duration > 0 ? duration : null;
  }

  function formatClock(ms) {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '';
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function renderTaskCard(task) {
    const duration = taskDurationMs(task);
    const tail = typeof task.outputTail === 'string' ? task.outputTail.replace(/\s+$/, '') : '';
    const meta = [statusText(task), duration !== null ? formatDuration(duration) : '']
      .filter(Boolean).join(' · ');
    const clock = formatClock(task.startedAt);
    return `
      <div class="bgp-card" data-bgp-task="${escapeHtml(task.id)}">
        <div class="bgp-head">
          <span class="bgp-dot bgp-dot-${escapeHtml(task.status)}"></span>
          <span class="bgp-id" title="${escapeHtml(task.id)}">${escapeHtml(task.id)}</span>
          ${clock ? `<span class="bgp-time">${clock}</span>` : ''}
        </div>
        <pre class="bgp-cmd" title="${escapeHtml(task.command)}">${escapeHtml(task.command)}</pre>
        <div class="bgp-meta">${escapeHtml(meta)}</div>
        ${tail ? `<pre class="bgp-tail" data-bgp-tail="${escapeHtml(task.id)}">${escapeHtml(tail)}</pre>` : ''}
      </div>`;
  }

  // 空态卡：复刻 git-empty-card / gen-ui-empty 同款配方
  // （虚线卡 + accent 图标块 + 标题 + 描述），保持右侧面板一致的空态语言。
  const TERMINAL_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 17l6-5-6-5"></path><path d="M12 19h8"></path></svg>';

  function renderEmpty() {
    const connected = state.status === 'live' || state.status === 'connecting';
    return `
      <div class="bgp-empty-card">
        <div class="bgp-empty-icon">${TERMINAL_ICON}</div>
        <div class="bgp-empty-title">${connected
          ? t('暂无后台任务', 'No background tasks')
          : t('面板未连接', 'Panel not connected')}</div>
        <div class="bgp-empty-desc">${connected
          ? t('bash_bg 启动的任务会实时出现在这里', 'Tasks started via bash_bg appear here in real time')
          : t('当前会话没有活跃的后台任务通道', 'No live background-task channel for this session')}</div>
      </div>`;
  }

  function getHtml() {
    const sorted = Array.from(tasks.values())
      .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
    const cards = sorted.map(renderTaskCard).join('');
    return `
      <div id="bg-panel-root" class="bgp-root">
        ${cards || renderEmpty()}
      </div>`;
  }

  /** 重绘：innerHTML 比对零变化零 DOM 写入；输出区贴近底部时保持跟随。 */
  function repaint() {
    const root = document.getElementById('bg-panel-root');
    if (!root) return;
    const html = getHtml();
    if (html === lastHtml) return;
    // 记录各输出区的跟随状态，重写后回贴。
    const follow = new Map();
    root.querySelectorAll('[data-bgp-tail]').forEach((el) => {
      follow.set(el.getAttribute('data-bgp-tail'), el.scrollTop + el.clientHeight >= el.scrollHeight - FOLLOW_THRESHOLD_PX);
    });
    const next = root.cloneNode(false);
    next.innerHTML = html;
    root.replaceWith(next);
    lastHtml = html;
    next.querySelectorAll('[data-bgp-tail]').forEach((el) => {
      if (follow.get(el.getAttribute('data-bgp-tail')) !== false) el.scrollTop = el.scrollHeight;
    });
  }

  // ── 通道生命周期 ─────────────────────────────────────────────────

  function hasRunningTask() {
    for (const task of tasks.values()) {
      if (task.status === 'running') return true;
    }
    return false;
  }

  function syncElapsedTimer() {
    // 运行中任务的时长行本地插值（事件之间平滑走秒）；无运行任务时停表。
    if (hasRunningTask() && elapsedTimer === null) {
      elapsedTimer = setInterval(repaint, ELAPSED_TICK_MS);
    } else if (!hasRunningTask() && elapsedTimer !== null) {
      clearInterval(elapsedTimer);
      elapsedTimer = null;
    }
  }

  function teardownChannel() {
    if (source) { source.close(); source = null; }
    if (sessionWatchTimer) { clearInterval(sessionWatchTimer); sessionWatchTimer = null; }
    if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
  }

  function applyTask(data) {
    if (!data || typeof data.id !== 'string') return;
    tasks.set(data.id, data);
  }

  function handleStreamEvent(data) {
    let payload;
    try { payload = JSON.parse(data); } catch { return; }
    if (payload?.type && payload?.data) applyTask(payload.data);
    syncElapsedTimer();
    repaint();
  }

  async function refreshList() {
    const result = await channelRequest('list', {});
    if (!source) return; // 等待期间通道已拆（会话切换），丢弃过期响应
    if (result.ok === true && Array.isArray(result.tasks)) {
      tasks.clear();
      for (const task of result.tasks) applyTask(task);
    } else if (result.code === 'channel_not_declared' || result.code === 'runtime_not_connected') {
      state.status = 'unavailable';
    }
    syncElapsedTimer();
    repaint();
  }

  function startChannel() {
    teardownChannel();
    tasks.clear();
    lastHtml = '';
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

  // ── 样式（模块自持；字体栈 / 颜色 / 卡片语言对齐项目设计体系）─────

  const MONO = '"Fira Code", "Cascadia Code", "Source Code Pro", "JetBrains Mono", ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, monospace';
  const STYLE = `
    /* 宿主 .feature-panel-body 已有 24px padding（genui 同款做法），根容器不再留边 */
    .bgp-root { display: flex; flex-direction: column; gap: 8px; }
    .bgp-card {
      padding: 10px 12px;
      border: 1px solid rgba(255, 255, 255, 0.07);
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.02);
      display: flex;
      flex-direction: column;
      gap: 6px;
      min-width: 0;
    }
    body[data-theme="light"] .bgp-card { background: #ffffff; border-color: #e0e0e0; }
    .bgp-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .bgp-dot { width: 6px; height: 6px; border-radius: 50%; flex: none; }
    .bgp-dot-running { background: var(--success-color); animation: bgp-pulse 1.2s ease-in-out infinite; }
    .bgp-dot-done { background: var(--code-accent); }
    .bgp-dot-killed, .bgp-dot-terminated { background: var(--error-color); }
    .bgp-id {
      font-family: ${MONO};
      font-size: 11px;
      color: var(--text-secondary);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
      min-width: 0;
    }
    .bgp-time { font-family: ${MONO}; font-size: 11px; color: var(--text-secondary); flex: none; }
    /* 命令块：最多两行，超长省略（title 悬浮看全文） */
    .bgp-cmd {
      margin: 0 0 0 14px;
      padding: 6px 8px;
      font-family: ${MONO};
      font-size: 12px;
      line-height: 1.5;
      color: var(--text-primary);
      background: var(--hover-bg);
      border-radius: 6px;
      white-space: pre-wrap;
      word-break: break-all;
      display: -webkit-box;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 2;
      overflow: hidden;
    }
    /* 状态 · 时长小字行，与命令块文字起点对齐（dot 6px + gap 8px） */
    .bgp-meta { margin-left: 14px; font-family: ${MONO}; font-size: 11px; color: var(--text-secondary); }
    .bgp-tail {
      margin: 0;
      padding: 8px 10px;
      font-family: ${MONO};
      font-size: 11px;
      line-height: 1.5;
      max-height: 200px;
      overflow-y: auto;
      white-space: pre-wrap;
      word-break: break-all;
      color: var(--text-secondary);
      background: var(--hover-bg);
      border-radius: 8px;
    }
    /* 空态卡：git-empty-card / gen-ui-empty 同款配方 */
    .bgp-empty-card {
      display: flex;
      min-height: 176px;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 24px;
      border: 1px dashed var(--border-color, rgba(128, 128, 128, 0.28));
      border-radius: 12px;
      background: linear-gradient(145deg, rgba(100, 130, 240, 0.045), transparent);
      color: var(--text-secondary);
      text-align: center;
    }
    .bgp-empty-icon {
      display: grid;
      width: 36px;
      height: 36px;
      margin-bottom: 10px;
      place-items: center;
      border: 1px solid color-mix(in srgb, var(--accent, #6391ff) 24%, transparent);
      border-radius: 11px;
      background: color-mix(in srgb, var(--accent, #6391ff) 10%, transparent);
      color: var(--accent, #6391ff);
      font-size: 18px;
      line-height: 1;
    }
    .bgp-empty-title { color: var(--text-primary); font-size: 14px; font-weight: 600; line-height: 20px; }
    .bgp-empty-desc { max-width: 260px; margin-top: 4px; font-size: 12px; line-height: 19px; }
    @keyframes bgp-pulse { 0%, 100% { opacity: 0.35; } 50% { opacity: 1; } }
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
