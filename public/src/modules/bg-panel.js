/**
 * bg-panel.js — 后台任务实时面板（feature-comms 通道的消费端）。
 *
 * 数据链路（ADR-0018 首个真实接入）：
 *   BgRegistry 事件 → PanelShellFeature（shell feature 内建镜像）
 *     → /protoclaw/feature-comms/publish（server store）
 *     → 本面板经 /protoclaw/feature-comms/stream（SSE）订阅渲染。
 *
 * 面板心智：终端式小卡片，全自动——打开即订阅，事件实时推送，输出
 * 尾巴随事件下发（feature 端镜像附带）。交互两个，都在运行中卡片上：
 * "立即汇报"手动触发器（请求面 report → BgRegistry.reportNow，与节拍/
 * 静默同款汇报：通知增量 + 双节奏互重置）；"打断"手动终止（请求面
 * kill → BgRegistry.kill manual，终止后 Agent 收到用户手动打断通知，
 * 不会继续等待已死的任务）。反馈统一走 ClawToast（loading → success/
 * error），按钮只承担在途/冷却展示并防连点风暴。
 * 任务状态真值仍是 bash_bg / bg_status。
 *
 * 协议发现：presentation.panel=background；按 protocol/version 选择宿主渲染，
 * 不按 Feature ID 猜卡片类型。进程保留 report/kill，智能体仅展示。
 * 四元组 + 项目 ID 共同构成卡片键，操作始终投递到卡片冻结的来源。
 *
 * 图标徽标（rail-bg-badge）：由各来源同一缓存计算活跃项总数。
 * 面板关闭后保留流作徽标/缓存订阅，不保留时长渲染计时器；30s 发现增删
 * 来源，2s 守卫清理会话切换。EventSource 自持 Last-Event-ID 断线续接，
 * open/resync/snapshot 经 list 对账，逐来源版本防迟到列表覆盖新事件。
 *
 * 重开保暖（stale-while-revalidate）：面板关闭不丢任务快照——徽标流的
 * 事件与基线在关闭期间持续镜像进缓存，重开面板先渲染缓存再经 list 对账
 * （发现→订阅→list 是三次串行网络往返，本地无感，远程高延迟链路上就是
 * "每次切进去都等半天"）；寻址变化或通道确证消失（runtime 退出 / 会话
 * 摘除 / 未声明）时缓存整体作废，不留陈旧卡片。
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

  const PROCESS_PROTOCOL = 'claw.background.process';
  const AGENT_PROTOCOL = 'claw.background.agent';
  const channels = new Map();
  let panelOpen = false;
  let discoveryRevision = 0;
  let discoveryStatus = '';
  const REFRESH_SESSION_WATCH_MS = 2_000;
  const ELAPSED_TICK_MS = 1_000;
  /** 面板关闭态的通道发现与徽标订阅保障周期（发现走恒 200 的 channels 列表）。 */
  const BADGE_POLL_MS = 30_000;
  /** 输出区距底不超过该值视为「跟随底部」，重绘后继续贴底；上翻阅读时不打扰。 */
  const FOLLOW_THRESHOLD_PX = 28;
  /** 手动汇报请求的兜底恢复窗（fetch 悬挂时按钮不永久卡死）。 */
  const REPORT_PENDING_TIMEOUT_MS = 5_000;
  /** 成功后的按钮冷却展示（ClawToast 已给主反馈，这里兼做连点防抖窗口）。 */
  const REPORT_SENT_LINGER_MS = 3_000;

  /** taskId -> 'pending'（请求在途）| 'sent'（已成功，冷却展示）。状态放模块
   * 作用域，重绘存活；整个存续期忽略再次点击——每次触发都会打扰 agent，
   * 防抖即防通知风暴。 */
  const reportStates = new Map();

  /** 打断在途的 taskId 集合（模块作用域，重绘存活）。无 sent linger：kill
   * 成功后任务变终态，finalized 事件重绘时按钮自然消失。 */
  const killPending = new Set();

  /** 折叠中的 taskId 集合（模块作用域，重绘存活）。终态自动收起也记在这，
   * 用户可随时点卡片头行重新展开。 */
  const collapsedTasks = new Set();
  /** 用户手动点过折叠/展开的任务：面板打开时的终态默认收起不覆盖用户意图。 */
  const userToggledTasks = new Set();
  /** 隐藏的输出区没有可用滚动尺寸；折叠期间沿用最后一次可见位置。 */
  const tailPositions = new Map();

  /** taskId -> 任务快照（通道事件 + list 合并，含 outputTail） */
  const tasks = new Map();
  const state = {
    status: 'idle', // idle | connecting | live | unavailable
  };
  let source = null;
  let sessionWatchTimer = null;
  let elapsedTimer = null;
  let lastHtml = '';
  /** 卡片骨架（挖空时长/输出尾巴后的 HTML）：判断结构是否变化。 */
  let lastSkeleton = '';

  /** 徽标状态（面板关闭态）：事件订阅驱动 running 集合，并镜像进任务缓存。 */
  let badgeTimer = null;
  let badgeSource = null;
  /** 任务快照缓存归属的会话寻址（`${agentId}::${sessionId}`）：面板流与
   * 徽标流两个写入源共用，重开保暖时按它判定保留还是丢弃。 */
  let cacheAddressKey = '';
  /** 上次写入徽标的值（-1 = 隐藏）：repaint 每秒都会调，值未变不碰 DOM。 */
  let lastBadgeValue = null;

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

  async function channelRequest(channel, requestType, payload) {
    if (!isCurrentChannel(channel)) return { ok: false, code: 'no_session' };
    const addressing = channel.target;
    const response = await fetch('/protoclaw/feature-comms/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: addressing.agentId,
        sessionId: addressing.sessionId,
        featureId: addressing.featureId,
        channelId: addressing.channelId,
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

  /** 运行中卡片的"立即汇报"按钮（终态任务没有可推送的运行情况）。 */
  function reportButton(taskId) {
    const state = reportStates.get(taskId);
    const label = state === 'pending'
      ? t('发送中…', 'sending…')
      : state === 'sent' ? t('已发送', 'sent') : t('立即汇报', 'report now');
    return `
      <button class="bgp-report-btn" data-bgp-report="${escapeHtml(taskId)}" data-state="${state || ''}" ${state ? 'disabled' : ''}
        title="${t('立即把当前运行情况发送给 Agent', 'Send current status to the Agent now')}">
        ${label}
      </button>`;
  }

  /** 运行中卡片的"打断"按钮：终止任务并通知 Agent 这是用户手动打断。
   * kill 成功后任务变终态，卡片重绘时按钮自然消失（无需 sent linger）。 */
  function interruptButton(taskId) {
    const pending = killPending.has(taskId);
    return `
      <button class="bgp-kill-btn" data-bgp-kill="${escapeHtml(taskId)}" ${pending ? 'disabled' : ''}
        title="${t('终止该任务；Agent 会收到用户手动打断的通知', 'Terminate the task; the Agent is notified of the manual interrupt')}">
        ${pending ? t('终止中…', 'stopping…') : t('打断', 'interrupt')}
      </button>`;
  }

  /** 任务卡片。skeleton=true 时挖空易变文本（时长、输出尾巴）供骨架比对；
   * 易变文本由 updateVolatileTexts 定点更新，不走 DOM 重建。 */
  function renderTaskCard(task, skeleton = false) {
    if (task.protocol === AGENT_PROTOCOL) {
      const labels = { submitted: t('已提交', 'submitted'), executing: t('执行中', 'executing'),
        suspended: t('已挂起', 'suspended'), rotating: t('接力中', 'rotating'), completed: t('完成', 'completed'),
        failed: t('失败', 'failed'), cancelled: t('已中断', 'cancelled'), blocked: t('需介入', 'blocked'),
        monitor_lost: t('监视失联（非业务失败）', 'monitor lost (not execution failure)') };
      return `<div class="bgp-card${collapsedTasks.has(task.id) ? ' bgp-collapsed' : ''}" data-bgp-task="${escapeHtml(task.id)}">
        <div class="bgp-head"><span class="bgp-dot bgp-dot-${escapeHtml(task.status)}"></span>
          <span class="bgp-id">${escapeHtml(task.title)}</span>
          <span class="bgp-chevron${collapsedTasks.has(task.id) ? '' : ' bgp-chevron-open'}">${CHEVRON_SVG}</span></div>
        <pre class="bgp-cmd">${escapeHtml(task.agentId)} · ${escapeHtml(task.threadId)} / ${escapeHtml(task.commandId)}</pre>
        <pre class="bgp-tail" data-bgp-tail="${escapeHtml(task.id)}">${skeleton ? '' : escapeHtml(task.summary)}</pre>
        <div class="bgp-result"><span class="bgp-result-main">${escapeHtml(labels[task.status] || task.status)}</span>
          <span class="bgp-result-time" data-bgp-updated>${skeleton ? '' : formatClock(task.updatedAt)}</span></div></div>`;
    }
    const duration = taskDurationMs(task);
    const tail = typeof task.outputTail === 'string' ? task.outputTail.replace(/\s+$/, '') : '';
    const clock = formatClock(task.startedAt);
    const collapsed = collapsedTasks.has(task.id);
    // 结果行贴卡片底部：左端状态 · 用时（时长是走秒易变文本），右端启动时刻
    const durHtml = duration !== null
      ? ` · <span data-bgp-elapsed>${skeleton ? '' : escapeHtml(formatDuration(duration))}</span>`
      : '';
    return `
      <div class="bgp-card${collapsed ? ' bgp-collapsed' : ''}" data-bgp-task="${escapeHtml(task.id)}">
        <div class="bgp-head" title="${t('点击折叠 / 展开', 'Click to collapse / expand')}">
          <span class="bgp-dot bgp-dot-${escapeHtml(task.status)}"></span>
          <span class="bgp-id" title="${escapeHtml(task.channelKey)}">${escapeHtml(task.taskId)} · ${escapeHtml(channels.get(task.channelKey)?.title || '')}</span>
          ${task.status === 'running' ? reportButton(task.id) + interruptButton(task.id) : ''}
          <span class="bgp-chevron${collapsed ? '' : ' bgp-chevron-open'}">${CHEVRON_SVG}</span>
        </div>
        <pre class="bgp-cmd" title="${escapeHtml(task.command)}">${escapeHtml(task.command)}</pre>
        ${tail ? `<pre class="bgp-tail" data-bgp-tail="${escapeHtml(task.id)}">${skeleton ? '' : escapeHtml(tail)}</pre>` : ''}
        <div class="bgp-result">
          <span class="bgp-result-main">${escapeHtml(statusText(task))}${durHtml}</span>
          ${clock ? `<span class="bgp-result-time">${clock}</span>` : ''}
        </div>
      </div>`;
  }

  // 空态卡：复刻 git-empty-card / gen-ui-empty 同款配方
  // （虚线卡 + accent 图标块 + 标题 + 描述），保持右侧面板一致的空态语言。
  const TERMINAL_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 17l6-5-6-5"></path><path d="M12 19h8"></path></svg>';
  /** 卡片折叠指示（右指 chevron；展开态由 CSS 转向下）。 */
  const CHEVRON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"></polyline></svg>';

  function renderEmpty() {
    const connected = state.status === 'live' || state.status === 'connecting';
    return `
      <div class="bgp-empty-card">
        <div class="bgp-empty-icon">${TERMINAL_ICON}</div>
        <div class="bgp-empty-title">${connected
          ? t('暂无后台任务', 'No background tasks')
          : t('面板未连接', 'Panel not connected')}</div>
        <div class="bgp-empty-desc">${connected
          ? t('已接入的后台进程与智能体执行会出现在这里', 'Connected background processes and agent executions appear here')
          : t('当前会话没有活跃的后台任务通道', 'No live background-task channel for this session')}</div>
      </div>`;
  }

  function getHtml(skeleton = false) {
    const sorted = Array.from(tasks.values())
      .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
    const notices = [...channels.values()].filter(channel => !channel.supported || channel.error).map(channel =>
      `<div class="bgp-empty-desc">${escapeHtml(channel.title)} · ${escapeHtml(channel.supported
        ? t('面板连接/快照异常', 'Panel connection/snapshot error') + ': ' + channel.error
        : t('不支持的协议/版本', 'Unsupported protocol/version') + ': ' + channel.presentation.protocol + '@' + channel.presentation.version)}</div>`).join('');
    const cards = sorted.map((task) => renderTaskCard(task, skeleton)).join('') + notices
      + (discoveryStatus ? `<div class="bgp-empty-desc">${t('通道发现失败，等待重连', 'Channel discovery failed; awaiting reconnect')}</div>` : '');
    return `
      <div id="bg-panel-root" class="bgp-root">
        ${cards || renderEmpty()}
      </div>`;
  }

  /**
   * 重绘，两级更新（根治每秒重建的次生问题：按钮 hover 频闪、输出区滚动
   * 位置被重置、指示灯动画从头重播）：
   * 1. 骨架未变（输出尾巴增长）→ 定点更新易变文本，零
   *    DOM 重建，CSS 状态（hover / 滚动 / 动画进度）全部自然保留；
   * 2. 骨架变化（状态切换、按钮增减、卡片增删）→ 全量重建；输出区贴底
   *    的继续跟底，上翻阅读的原位恢复。
   */
  function repaint() {
    // 徽标先行于面板根检查：面板关闭时根不存在，但徽标由轮询路径单独驱动，
    // 这里只覆盖打开态（所有 tasks 变更路径都以 repaint 收尾，单点汇合）。
    let running = 0;
    for (const task of tasks.values()) {
      if (isActive(task)) running += 1;
    }
    _setBadge(running);
    const root = document.getElementById('bg-panel-root');
    if (!root || !panelOpen) return;
    const html = getHtml();
    if (html === lastHtml) return;
    const skeleton = getHtml(true);
    if (lastSkeleton !== '' && skeleton === lastSkeleton) {
      updateVolatileTexts(root);
      lastHtml = html;
      return;
    }
    // 全量重建：记录各输出区的滚动位置与跟随状态，重建后回贴。
    root.querySelectorAll('[data-bgp-tail]').forEach((el) => {
      const id = el.getAttribute('data-bgp-tail');
      if (!el.clientHeight || !tasks.has(id)) return;
      const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - FOLLOW_THRESHOLD_PX;
      tailPositions.set(id, { top: el.scrollTop, atBottom });
    });
    const next = root.cloneNode(false);
    next.innerHTML = html.slice(html.indexOf('>') + 1, html.lastIndexOf('</div>'));
    root.replaceWith(next);
    next.querySelectorAll('[data-bgp-tail]').forEach((el) => {
      const p = tailPositions.get(el.getAttribute('data-bgp-tail'));
      el.scrollTop = p ? (p.atBottom ? el.scrollHeight : p.top) : el.scrollHeight;
    });
    lastHtml = html;
    lastSkeleton = skeleton;
  }

  /** 轻量路径：只更新漂移的文本（时长走秒、输出尾巴）。 */
  function updateVolatileTexts(root, elapsedOnly = false) {
    for (const task of tasks.values()) {
      const id = window.CSS?.escape ? CSS.escape(task.id) : task.id.replace(/["\\]/g, '\\$&');
      const card = root.querySelector(`[data-bgp-task="${id}"]`);
      if (!card) continue;
      const elapsedEl = card.querySelector('[data-bgp-elapsed]');
      const duration = taskDurationMs(task);
      const durText = duration !== null ? formatDuration(duration) : '';
      if (elapsedEl && elapsedEl.textContent !== durText) elapsedEl.textContent = durText;
      if (elapsedOnly) continue;
      const updatedEl = card.querySelector('[data-bgp-updated]');
      const clock = formatClock(task.updatedAt);
      if (updatedEl && updatedEl.textContent !== clock) updatedEl.textContent = clock;
      const tailEl = card.querySelector('[data-bgp-tail]');
      const tail = task.protocol === AGENT_PROTOCOL ? String(task.summary ?? '')
        : typeof task.outputTail === 'string' ? task.outputTail.replace(/\s+$/, '') : '';
      if (tailEl && tailEl.textContent !== tail) {
        const visible = tailEl.clientHeight > 0;
        const atBottom = tailEl.scrollTop + tailEl.clientHeight >= tailEl.scrollHeight - FOLLOW_THRESHOLD_PX;
        const prevTop = tailEl.scrollTop;
        if (visible) tailPositions.set(task.id, { top: prevTop, atBottom });
        tailEl.textContent = tail;
        if (visible) tailEl.scrollTop = atBottom ? tailEl.scrollHeight : prevTop;
      }
    }
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
      elapsedTimer = setInterval(() => {
        const root = document.getElementById('bg-panel-root');
        if (root) updateVolatileTexts(root, true);
      }, ELAPSED_TICK_MS);
    } else if (!hasRunningTask() && elapsedTimer !== null) {
      clearInterval(elapsedTimer);
      elapsedTimer = null;
    }
  }

  /** 丢弃任务快照缓存（寻址变化，或通道确证消失：runtime 退出 / 会话摘除
   * / 未声明）。终态缓存常驻会让重开面板显示早已消亡的陈旧卡片。 */
  function _resetTaskCache() {
    tasks.clear();
    tailPositions.clear();
    reportStates.clear();
    killPending.clear();
    collapsedTasks.clear();
    userToggledTasks.clear();
  }

  function addressKey(address) {
    return address ? JSON.stringify([address.agentId, address.sessionId]) : '';
  }

  function isCurrentChannel(channel) {
    return !!channel && channels.get(channel.key) === channel && cacheAddressKey === addressKey(currentAddressing());
  }

  function taskKey(channel, id) {
    return JSON.stringify([channel.target.agentId, channel.target.sessionId, channel.target.featureId, channel.target.channelId, id]);
  }

  function isActive(task) {
    return task.protocol === AGENT_PROTOCOL
      ? ['submitted', 'executing', 'suspended', 'rotating'].includes(task.status) : task.status === 'running';
  }

  function applyTask(channel, data) {
    if (!data || typeof data.id !== 'string') return;
    const key = taskKey(channel, data.id);
    const task = { ...data, id: key, taskId: data.id, channelKey: channel.key, protocol: channel.presentation.protocol };
    const prev = tasks.get(key);
    if (prev && task.protocol === AGENT_PROTOCOL && task.startedAt === prev.startedAt
      && typeof task.revision === 'number' && task.revision < prev.revision) return;
    if (prev && isActive(prev) && !isActive(task)) collapsedTasks.add(key);
    tasks.set(key, task);
    if (!isActive(task) && !userToggledTasks.has(key)) collapsedTasks.add(key);
  }

  function removeChannel(channel) {
    channel.stream?.close();
    channels.delete(channel.key);
    for (const [id, task] of tasks) {
      if (task.channelKey !== channel.key) continue;
      tasks.delete(id);
      tailPositions.delete(id);
      reportStates.delete(id);
      killPending.delete(id);
      collapsedTasks.delete(id);
      userToggledTasks.delete(id);
    }
  }

  function teardownChannel() {
    discoveryRevision += 1;
    for (const channel of channels.values()) channel.stream?.close();
    channels.clear();
    source = null;
    badgeSource = null;
    if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
  }

  function syncAddress() {
    const address = currentAddressing();
    const key = addressKey(address);
    if (cacheAddressKey !== key) {
      teardownChannel();
      _resetTaskCache();
      cacheAddressKey = key;
      discoveryStatus = '';
      state.status = 'connecting';
      repaint();
    }
    return address;
  }

  async function refreshChannel(channel) {
    const revision = channel.eventRevision;
    const requestRevision = ++channel.listRevision;
    let result;
    try { result = await channelRequest(channel, 'list', {}); }
    catch { result = { ok: false, code: 'network_error' }; }
    if (!isCurrentChannel(channel) || requestRevision !== channel.listRevision) return;
    if (result.ok === true && Array.isArray(result.tasks)) {
      channel.error = '';
      const listed = new Set();
      for (const task of result.tasks) {
        if (typeof task?.id !== 'string') continue;
        const key = taskKey(channel, task.id);
        listed.add(key);
        if ((channel.revisions.get(key) || 0) <= revision) applyTask(channel, task);
      }
      for (const [id, task] of tasks) {
        if (task.channelKey === channel.key && !listed.has(id) && (channel.revisions.get(id) || 0) <= revision) {
          tasks.delete(id);
          tailPositions.delete(id);
          channel.revisions.delete(id);
          collapsedTasks.delete(id);
          userToggledTasks.delete(id);
          reportStates.delete(id);
          killPending.delete(id);
        }
      }
    } else if (['channel_not_declared', 'runtime_not_connected'].includes(result.code)) {
      removeChannel(channel);
    } else channel.error = result.code || 'list_failed';
    if (panelOpen) syncElapsedTimer();
    repaint();
  }

  function refreshList() {
    return Promise.all([...channels.values()].filter(channel => channel.supported).map(refreshChannel));
  }

  function subscribeChannel(channel) {
    const params = new URLSearchParams({ ...channel.target, latest: '1' });
    const stream = new EventSource(`/protoclaw/feature-comms/stream?${params}`);
    channel.stream = stream;
    stream.addEventListener('open', () => {
      if (!isCurrentChannel(channel)) return;
      channel.error = '';
      state.status = 'live';
      void refreshChannel(channel);
      repaint();
    });
    stream.addEventListener('event', event => {
      if (!isCurrentChannel(channel)) return;
      let payload;
      try { payload = JSON.parse(event.data); } catch { return; }
      if (typeof payload?.data?.id !== 'string') return;
      const key = taskKey(channel, payload.data.id);
      channel.revisions.set(key, ++channel.eventRevision);
      applyTask(channel, payload.data);
      if (payload.type === 'finalized') void refreshChannel(channel);
      if (panelOpen) syncElapsedTimer();
      repaint();
    });
    for (const type of ['resync', 'snapshot']) stream.addEventListener(type, () => {
      if (isCurrentChannel(channel)) void refreshChannel(channel);
    });
    stream.addEventListener('error', () => {
      if (!isCurrentChannel(channel)) return;
      channel.error = 'disconnected';
      repaint(); // EventSource owns cursor-preserving reconnect; never stop business work.
    });
    stream.addEventListener('closed', () => {
      if (!isCurrentChannel(channel)) return;
      removeChannel(channel);
      source = [...channels.values()].find(c => c.stream)?.stream || null;
      badgeSource = panelOpen ? null : source;
      if (panelOpen) syncElapsedTimer();
      repaint();
    });
  }

  async function discover() {
    const address = syncAddress();
    if (!address) { state.status = 'unavailable'; repaint(); return; }
    const revision = ++discoveryRevision;
    let declarations;
    try { declarations = await window.ClawFeatureCommunication.listChannels(address.agentId, address.sessionId); }
    catch {
      if (revision === discoveryRevision && cacheAddressKey === addressKey(currentAddressing())) {
        discoveryStatus = 'discovery_failed';
        repaint();
      }
      return;
    }
    if (revision !== discoveryRevision || cacheAddressKey !== addressKey(currentAddressing())) return;
    discoveryStatus = '';
    const found = new Set();
    for (const declaration of declarations) {
      if (declaration?.presentation?.panel !== 'background') continue;
      const target = { ...address, featureId: declaration.featureId, channelId: declaration.channelId };
      const key = JSON.stringify(Object.values(target));
      found.add(key);
      const existing = channels.get(key);
      if (existing && JSON.stringify(existing.presentation) === JSON.stringify(declaration.presentation)) continue;
      if (existing) removeChannel(existing);
      const presentation = declaration.presentation;
      const supported = presentation.version === 1 && [PROCESS_PROTOCOL, AGENT_PROTOCOL].includes(presentation.protocol);
      const channel = { key, target, presentation, title: declaration.title || declaration.featureId,
        supported, error: '', stream: null, eventRevision: 0, listRevision: 0, revisions: new Map() };
      channels.set(key, channel);
      if (supported) subscribeChannel(channel);
    }
    for (const channel of channels.values()) if (!found.has(channel.key)) removeChannel(channel);
    // Reopening retains a warm cache but recreates subscriptions; absent sources
    // must also retire cached cards whose previous channel object is already gone.
    for (const [id, task] of tasks) {
      const channel = channels.get(task.channelKey);
      if (channel?.supported && channel.presentation.protocol === task.protocol) continue;
      tasks.delete(id);
      tailPositions.delete(id);
      collapsedTasks.delete(id);
      userToggledTasks.delete(id);
      reportStates.delete(id);
      killPending.delete(id);
    }
    source = [...channels.values()].find(c => c.stream)?.stream || null;
    badgeSource = panelOpen ? null : source;
    state.status = channels.size ? 'live' : 'unavailable';
    if (panelOpen) syncElapsedTimer();
    repaint();
  }

  function startChannel() {
    teardownChannel();
    panelOpen = true;
    badgeSource = null;
    syncAddress();
    lastHtml = '';
    lastSkeleton = '';
    syncElapsedTimer();
    repaint();
    void discover();
  }

  function _setBadge(count) {
    const value = count > 0 ? Math.min(count, 99) : -1;
    if (value === lastBadgeValue) return;
    lastBadgeValue = value;
    const badge = document.getElementById('rail-bg-badge');
    if (!badge) return;
    badge.textContent = count > 0 ? (count > 99 ? '99+' : String(count)) : '';
    if (count > 0) badge.classList.add('visible');
    else badge.classList.remove('visible');
  }

  function _pollBadge() { return discover(); }

  function _ensureBadgePolling() {
    badgeTimer = setInterval(() => { void discover(); }, BADGE_POLL_MS);
    sessionWatchTimer = setInterval(() => {
      const previous = cacheAddressKey;
      syncAddress();
      if (previous !== cacheAddressKey) void discover();
      if (panelOpen && activeFeaturePanel !== 'bg') window.BgPanel.onClose();
    }, REFRESH_SESSION_WATCH_MS);
  }

  // ── 手动汇报触发器（请求面 report → BgRegistry.reportNow）──────────

  // 卡片结构变化时会重建，点击监听挂 document 做委托，
  // 不随重绘丢失；.bgp-* 类名空间归本面板，命中即本面板卡片。
  // 反馈走 ClawToast（loading → success/error）；按钮只承担在途/冷却展示。
  document.addEventListener('click', (e) => {
    const btn = e.target instanceof Element ? e.target.closest('.bgp-report-btn') : null;
    if (!btn) return;
    const taskId = btn.getAttribute('data-bgp-report');
    if (!taskId || reportStates.has(taskId)) return; // 冷却期防抖：防通知风暴
    const task = tasks.get(taskId);
    const channel = channels.get(task?.channelKey);
    if (!task || task.protocol !== PROCESS_PROTOCOL || !isCurrentChannel(channel)) return;
    reportStates.set(taskId, 'pending');
    repaint();
    const toastId = `bgp-report-${taskId}`;
    window.ClawToast?.show?.({
      id: toastId,
      status: 'loading',
      title: t('正在推送运行情况…', 'Pushing status to Agent…'),
      description: taskId,
    });
    // 兜底：fetch 悬挂（无超时的网络异常）时恢复按钮。
    const fallback = setTimeout(() => {
      if (reportStates.get(taskId) === 'pending') {
        reportStates.delete(taskId);
        repaint();
        window.ClawToast?.update?.(toastId, { status: 'error', title: t('推送超时', 'Report timed out'), description: taskId });
      }
    }, REPORT_PENDING_TIMEOUT_MS);
    void channelRequest(channel, 'report', { taskId: task.taskId }).then((result) => {
      clearTimeout(fallback);
      if (!isCurrentChannel(channel)) return;
      if (result.ok === true) {
        reportStates.set(taskId, 'sent');
        window.ClawToast?.update?.(toastId, {
          status: 'success',
          title: t('运行情况已发送给 Agent', 'Current status sent to Agent'),
          description: taskId,
        });
        setTimeout(() => {
          if (reportStates.get(taskId) === 'sent') { reportStates.delete(taskId); repaint(); }
        }, REPORT_SENT_LINGER_MS);
      } else {
        reportStates.delete(taskId);
        window.ClawToast?.update?.(toastId, { status: 'error', title: t('推送失败', 'Report failed'), description: `${taskId} · ${result.code || ''}` });
      }
      repaint();
    }).catch(() => {
      clearTimeout(fallback);
      reportStates.delete(taskId);
      repaint();
      window.ClawToast?.update?.(toastId, { status: 'error', title: t('推送失败', 'Report failed'), description: `${taskId} · network error` });
    });
  });

  // ── 手动打断（请求面 kill → BgRegistry.kill manual）────────────────
  //
  // 与手动汇报同款纪律：document 委托 + ClawToast 主反馈 + 在途防抖。
  // kill 幂等（终态返回 false），防抖只为不叠多余请求；成功后 finalized
  // 事件把卡片刷成"已终止"，按钮随状态自然消失。
  document.addEventListener('click', (e) => {
    const btn = e.target instanceof Element ? e.target.closest('.bgp-kill-btn') : null;
    if (!btn) return;
    const taskId = btn.getAttribute('data-bgp-kill');
    if (!taskId || killPending.has(taskId)) return;
    const task = tasks.get(taskId);
    const channel = channels.get(task?.channelKey);
    if (!task || task.protocol !== PROCESS_PROTOCOL || !isCurrentChannel(channel)) return;
    killPending.add(taskId);
    repaint();
    const toastId = `bgp-kill-${taskId}`;
    window.ClawToast?.show?.({
      id: toastId,
      status: 'loading',
      title: t('正在打断任务…', 'Interrupting task…'),
      description: taskId,
    });
    void channelRequest(channel, 'kill', { taskId: task.taskId }).then((result) => {
      if (!isCurrentChannel(channel)) return;
      killPending.delete(taskId);
      repaint();
      if (result.ok === true) {
        window.ClawToast?.update?.(toastId, {
          status: 'success',
          title: t('任务已打断', 'Task interrupted'),
          description: taskId,
        });
      } else {
        window.ClawToast?.update?.(toastId, { status: 'error', title: t('打断失败', 'Interrupt failed'), description: `${taskId} · ${result.code || ''}` });
      }
    }).catch(() => {
      killPending.delete(taskId);
      repaint();
      window.ClawToast?.update?.(toastId, { status: 'error', title: t('打断失败', 'Interrupt failed'), description: `${taskId} · network error` });
    });
  });

  // ── 卡片折叠（点头行切换；终态由 applyTask 跃迁自动收起）──────────

  document.addEventListener('click', (e) => {
    // 按钮有自己的委托（report / kill），不触发折叠
    if (e.target instanceof Element && e.target.closest('.bgp-report-btn, .bgp-kill-btn')) return;
    const head = e.target instanceof Element ? e.target.closest('.bgp-head') : null;
    if (!head) return;
    const taskId = head.closest('.bgp-card')?.getAttribute('data-bgp-task');
    if (!taskId) return;
    userToggledTasks.add(taskId);
    if (collapsedTasks.has(taskId)) collapsedTasks.delete(taskId);
    else collapsedTasks.add(taskId);
    repaint();
  });

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
      gap: 8px;
      min-width: 0;
    }
    body[data-theme="light"] .bgp-card { background: #ffffff; border-color: #e0e0e0; }
    .bgp-head { display: flex; align-items: center; gap: 8px; min-width: 0; cursor: pointer; }
    /* 折叠态：只收起输出尾巴；命令行与底部状态行保留（一眼可辨任务是谁、结果如何） */
    .bgp-card.bgp-collapsed > .bgp-tail { display: none; }
    .bgp-chevron {
      flex: none;
      width: 13px;
      height: 13px;
      color: var(--text-secondary);
      transition: transform 0.15s ease;
    }
    .bgp-chevron svg { width: 100%; height: 100%; display: block; }
    .bgp-chevron-open { transform: rotate(90deg); }
    .bgp-dot { width: 6px; height: 6px; border-radius: 50%; flex: none; }
    .bgp-dot-running { background: var(--success-color); animation: bgp-pulse 1.2s ease-in-out infinite; }
    .bgp-dot-done, .bgp-dot-completed { background: var(--code-accent); }
    .bgp-dot-submitted, .bgp-dot-suspended, .bgp-dot-rotating, .bgp-dot-blocked, .bgp-dot-monitor_lost { background: var(--warning-color); }
    .bgp-dot-executing { background: var(--success-color); }
    .bgp-dot-failed, .bgp-dot-cancelled { background: var(--error-color); }
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
    /* 头行操作按钮：对齐 layout.css .plan-task-action（"执行到此处"）的
     * 基础配方——继承全局 UI 字体（中文渲染不发虚），不另设 font-family。
     * 不带 transition：卡片每秒走秒重绘（innerHTML 重建），新元素会重播
     * 过渡动画，hover 时表现为频闪。 */
    .bgp-report-btn {
      flex: none;
      padding: 3px 10px;
      font-size: 11px;
      line-height: 1.3;
      color: var(--text-secondary);
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid var(--border-color);
      border-radius: 6px;
      cursor: pointer;
      white-space: nowrap;
    }
    .bgp-report-btn:hover:not(:disabled) {
      color: var(--text-primary);
      background: rgba(255, 255, 255, 0.09);
      border-color: rgba(255, 255, 255, 0.25);
    }
    .bgp-report-btn:disabled { opacity: 0.55; cursor: default; }
    .bgp-report-btn[data-state="sent"]:disabled { opacity: 0.9; color: var(--success-color); border-color: color-mix(in srgb, var(--success-color) 45%, transparent); }
    body[data-theme="light"] .bgp-report-btn { background: #ffffff; border-color: #d0d0d0; }
    body[data-theme="light"] .bgp-report-btn:hover:not(:disabled) { background: #f0f0f0; border-color: #b0b0b0; }
    /* 打断按钮：基础态与汇报按钮同配方，hover 转 danger 色调——动作不可逆，
     * 悬停时显式示警。同样不带 transition（见上）。 */
    .bgp-kill-btn {
      flex: none;
      padding: 3px 10px;
      font-size: 11px;
      line-height: 1.3;
      color: var(--text-secondary);
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid var(--border-color);
      border-radius: 6px;
      cursor: pointer;
      white-space: nowrap;
    }
    .bgp-kill-btn:hover:not(:disabled) {
      color: var(--error-color);
      background: rgba(255, 255, 255, 0.09);
      border-color: color-mix(in srgb, var(--error-color) 55%, transparent);
    }
    .bgp-kill-btn:disabled { opacity: 0.55; cursor: default; }
    body[data-theme="light"] .bgp-kill-btn { background: #ffffff; border-color: #d0d0d0; }
    body[data-theme="light"] .bgp-kill-btn:hover:not(:disabled) { background: #f0f0f0; border-color: color-mix(in srgb, #d54545 55%, transparent); }
    /* 命令行：裸文字，最多两行省略（title 悬浮看全文） */
    .bgp-cmd {
      margin: 0;
      font-family: ${MONO};
      font-size: 12px;
      line-height: 1.5;
      color: var(--text-primary);
      white-space: pre-wrap;
      word-break: break-all;
      display: -webkit-box;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 2;
      overflow: hidden;
    }
    /* 结果行：状态 · 用时靠左，启动时刻靠右 */
    .bgp-result { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
    .bgp-result-main, .bgp-result-time { font-family: ${MONO}; font-size: 11px; color: var(--text-secondary); }
    .bgp-tail {
      margin: 0;
      padding: 8px 10px;
      font-family: ${MONO};
      font-size: 11px;
      line-height: 1.5;
      max-height: calc(7 * 1.5em + 16px);
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
    __testBadgeStream: () => badgeSource,
    getHtml,
    onOpen: startChannel,
    onClose: () => {
      panelOpen = false;
      if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
      badgeSource = source;
      // Same protocol streams keep the cache and badge fresh without a second subscription.
      void _pollBadge();
    },
    refresh: refreshList,
    /** 立即触发一次徽标发现（runtime 切换时让红点及时出现，与 GenUI 同款）。 */
    refreshBadge: () => { void _pollBadge(); },
  };

  // 启动徽标轮询 — badge 需要在面板未打开时也持续更新
  _ensureBadgePolling();
})();
