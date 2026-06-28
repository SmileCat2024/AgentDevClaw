/**
 * work-group-ui.js — 群聊指挥台 UI 模块
 *
 * 设计原则：
 *   - 无 emoji，所有状态用文字或 CSS 元素表达
 *   - 消息块有清晰边界，强调消息性而非报告感
 *   - 遵循 Claw 项目整体设计语言（间距、字体、配色）
 *   - 最小字号 13px
 */

(function () {
  'use strict';

  // ── 模式定义（纯文字，无图标）──────────────────────────────

  const INITIATIVE_MODES = [
    { value: 'assist', label: '辅助', desc: '不主动参与路由，仅响应直接提及' },
    { value: 'plan', label: '规划', desc: '主动观察群内活动，适时提出建议' },
    { value: 'execute', label: '执行', desc: '全权管理路由、session 和调度' },
  ];

  const AUTONOMY_MODES = [
    { value: 'auto', label: '直接执行', desc: '拿到任务就做，自行判断' },
    { value: 'cautious', label: '有疑则停', desc: '正常推进，不确定时停下来问' },
    { value: 'confirm', label: '方案确认', desc: '先出方案，确认后再执行' },
  ];

  const DISPATCH_STATUS_TEXT = {
    pending: '等待派发',
    delivered: '处理中',
    completed: '已完成',
    failed: '失败',
  };

  // ── 状态 ────────────────────────────────────────────────────

  let chatSummaries = [];
  let activeChat = null;
  let activeChatId = null;
  let identities = [];
  let viewMode = 'chat';
  let searchKeyword = '';
  let pollTimer = null;
  let isLoading = false;
  let pendingLinks = [];
  let pendingAttachments = [];  // [{ name, content }]
  let openDropdown = null;
  let groupMdContent = '';      // GROUP.md 编辑器内容
  let groupMdLoading = false;   // GROUP.md 是否正在加载
  let groupMdChatId = null;     // GROUP.md 内容所属群聊，防止切群串数据
  let adminModelState = {
    loading: false,
    loaded: false,
    presets: [],
    current: '',
    error: null,
  };
  let _annotations = {};        // messageId → { text, timestamp }
  let _adminStatus = null;      // 管理员会话状态（admin_status API 返回）
  let _adminRestarting = false; // 管理员正在创建新会话中（UI 状态锁）
  let _archivedCollapsed = true; // 已归档群聊分组是否折叠
  let _hoverIdentity = null;     // 当前 hover 的成员 identityRef
  let _hoverTimer = null;        // hover 延迟计时器
  let _popoverEl = null;         // 成员 popover DOM 元素
  let _popoverHideTimer = null;  // popover 隐藏延迟计时器
  let _importModalEl = null;     // 引入会话搜索弹窗 DOM
  let _importSearchTimer = null; // 搜索防抖计时器
  let _mentionTarget = null;     // @mention picker 当前选中的 identityRef（level 2）
  let _settingsAdminCollapsed = true; // 管理员配置折叠区状态（默认收起）
  let _addMemberModalEl = null;  // 添加成员弹窗 DOM
  let _addMemberSearchTimer = null; // 添加成员搜索防抖计时器

  // ── 语音输入状态 ─────────────────────────────────────────────
  let _voiceRecording = false;
  let _voiceTranscribing = false;
  let _voiceMediaRecorder = null;
  let _voiceAudioChunks = [];
  let _voiceTargetBtn = null;
  let _voiceCancelled = false;
  let _voicePendingSend = false;
  let _voiceChatId = null;           // 录音发起时的 chatId（用于检测群聊切换）

  // ── 按群聊隔离的输入缓存 ─────────────────────────────────────
  // chatId → { editorHtml, pendingLinks, pendingAttachments }
  const _chatInputCache = {};

  // ── 按群聊隔离的 session 选择状态 ───────────────────────────
  // chatId → { identityRef → { mode: 'default'|'specific'|'new', sessionId, sessionTitle } }
  const _chatSessionSelection = {};
  // 当前打开的 session dropdown 对应的 identityRef
  let _openSessionDropdown = null;
  // session 数据缓存: identityRef → { pool, external, activeSessionId, sessionModel }
  let _sessionDataCache = {};

  // 运行时状态缓存: sessionId → { status, viewerAgentId, identityRef, displayName, workspaceId }
  let _runtimeStatusCache = {};

  // 滚动位置保持
  let _savedMsgScrollTop = 0;       // 跨 DOM 重建保持消息区滚动位置
  let _shouldScrollToBottom = false; // 进入/切换聊天时滚动到底部
  let _userScrolling = false;        // 用户正在手动滚动
  let _userScrollingTimer = null;    // 用户滚动状态清除计时器
  let _suppressScrollEvent = false;  // 程序设置 scrollTop 时抑制事件

  // ── API helpers ─────────────────────────────────────────────

  async function apiGet(path) {
    const res = await fetch(path);
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    return res.json();
  }

  async function apiPost(path, body) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    return res.json();
  }

  async function apiPut(path, body) {
    const res = await fetch(path, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    return res.json();
  }

  async function apiDelete(path) {
    const res = await fetch(path, { method: 'DELETE' });
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    return res.json();
  }

  // ── 数据加载 ─────────────────────────────────────────────────

  async function loadChatSummaries() {
    try {
      const data = await apiGet('/protoclaw/group_chats');
      chatSummaries = data.chats || [];
    } catch (err) {
      console.error('[WorkGroup] loadChatSummaries:', err);
      chatSummaries = [];
    }
  }

  async function loadActiveChat() {
    if (!activeChatId) return;
    try {
      activeChat = await apiGet(`/protoclaw/group_chats/${encodeURIComponent(activeChatId)}`);
      // 并行加载批注和管理员状态
      const [annData, adminData] = await Promise.allSettled([
        apiGet(`/protoclaw/group_chats/${encodeURIComponent(activeChatId)}/annotations`),
        apiGet(`/protoclaw/group_chats/${encodeURIComponent(activeChatId)}/admin_status`),
      ]);
      _annotations = annData.status === 'fulfilled' ? (annData.value.annotations || {}) : {};
      _adminStatus = adminData.status === 'fulfilled' ? adminData.value : null;
    } catch (err) {
      console.error('[WorkGroup] loadActiveChat:', err);
      activeChat = null;
      _annotations = {};
      _adminStatus = null;
    }
  }

  async function loadIdentities() {
    try {
      const data = await apiGet('/protoclaw/identities');
      identities = data.identities || [];
    } catch (err) {
      console.error('[WorkGroup] loadIdentities:', err);
      identities = [];
    }
  }

  // ── 工具函数 ────────────────────────────────────────────────

  function esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function formatTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    if (isToday) return `${hh}:${mm}`;
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${mo}/${dd} ${hh}:${mm}`;
  }

  function _formatCreateDate(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${mo}/${dd}`;
  }

  function _extractMdSummary(content) {
    if (!content) return '';
    return content.split('\n').map((l) => l.trim()).filter((l) => l).slice(0, 3).join('\n');
  }

  function getMemberName(chat, from) {
    if (from === 'user') return '我';
    const id = identities.find((i) => i.identityRef === from);
    return id ? id.displayName : from;
  }

  function getIdentityName(identityRef) {
    const id = identities.find((i) => i.identityRef === identityRef);
    return id ? id.displayName : identityRef;
  }

  // ── 生成式头像 ──────────────────────────────────────────────
  // 参考 Discord/GitHub 默认头像：首字母 + 基于 hash 的配色
  // 纯函数：name → { initials, color }

  // 高饱和、偏暗 — 作为 2px 边框在黑色底上醒目但不刺眼
  const AVATAR_COLORS = [
    '#4F46E5', // Indigo
    '#7C3AED', // Violet
    '#9333EA', // Purple
    '#DB2777', // Pink
    '#E11D48', // Rose
    '#DC2626', // Red
    '#EA580C', // Orange
    '#CA8A04', // Yellow
    '#65A30D', // Lime
    '#16A34A', // Green
    '#0D9488', // Teal
    '#0891B2', // Cyan
    '#2563EB', // Blue
    '#0284C7', // Sky
    '#C026D3', // Fuchsia
    '#D97706', // Amber
  ];

  const AVATAR_SPECIAL_COLORS = {
    'user': '#2563EB',             // 品牌蓝
    'work-group:admin': '#9333EA', // 管理紫
  };

  function _avatarInitials(name, identityRef) {
    if (identityRef === 'user') return '我';
    if (identityRef === 'work-group:admin') return '管';
    if (!name) return '?';
    return name.charAt(0).toUpperCase();
  }

  function generateAvatar(name, identityRef, seed) {
    const special = identityRef ? AVATAR_SPECIAL_COLORS[identityRef] : null;
    if (special) {
      return { initials: _avatarInitials(name, identityRef), color: special };
    }
    if (!name) return { initials: '?', color: '#6a6a6a' };
    const initials = _avatarInitials(name, identityRef);
    // FNV-1a hash — 分布比经典 multiply-add 更均匀
    // seed（如 createdAt）优先于 name，避免相似命名导致颜色聚集
    // String() 兜底：createdAt 可能是 Date.now() 数字，数字无 .length
    const source = String(seed || name || '');
    let hash = 0x811c9dc5;
    for (let i = 0; i < source.length; i++) {
      hash ^= source.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    const color = AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
    return { initials, color };
  }

  function collectActiveSessions(chat) {
    const sessionMap = new Map();
    for (const msg of (chat?.messages || [])) {
      const r = msg.routing;
      if (!r || !r.targetSessionId) continue;
      const key = `${r.targetIdentityRef}:${r.targetSessionId}`;
      const existing = sessionMap.get(key);
      if (!existing || (msg.timestamp || 0) > existing.lastActivity) {
        sessionMap.set(key, {
          identityRef: r.targetIdentityRef,
          sessionId: r.targetSessionId,
          workspaceId: r.targetWorkspaceId,
          displayName: getIdentityName(r.targetIdentityRef),
          status: resolveDispatchDisplayStatus(r),
          lastActivity: msg.timestamp || 0,
        });
      }
    }
    const sessions = Array.from(sessionMap.values()).filter((s) => s.status !== 'failed' && s.identityRef !== 'work-group:admin');
    sessions.sort((a, b) => b.lastActivity - a.lastActivity);
    return sessions;
  }

  /** 按身份分组活跃会话，返回 identityRef → session[] */
  function collectSessionsByIdentity(chat) {
    const sessions = collectActiveSessions(chat);
    const map = new Map();
    for (const s of sessions) {
      if (!map.has(s.identityRef)) map.set(s.identityRef, []);
      map.get(s.identityRef).push(s);
    }
    return map;
  }

  // ── 左侧：群聊列表 ──────────────────────────────────────────

  function _renderChatItem(chat) {
    const isActive = chat.id === activeChatId;
    const av = generateAvatar(chat.name, null, chat.createdAt);
    const lm = chat.lastMessage;
    const preview = lm ? (lm.text || '').slice(0, 40) : '暂无消息';

    return [
      `<div class="wg-chat-item${isActive ? ' active' : ''}" data-wg-chat-id="${esc(chat.id)}">`,
      `  <div class="wg-chat-avatar" style="--av-grad:${av.color}">${esc(av.initials)}</div>`,
      '  <div class="wg-chat-info">',
      '    <div class="wg-chat-top">',
      `      <span class="wg-chat-name">${esc(chat.name)}</span>`,
      `      <span class="wg-chat-time">${esc(formatTime(chat.updatedAt || chat.createdAt))}</span>`,
      '    </div>',
      `    <div class="wg-chat-preview">${esc(preview)}</div>`,
      '  </div>',
      '</div>',
    ].join('');
  }

  function renderChatList() {
    const filtered = searchKeyword
      ? chatSummaries.filter((c) =>
          (c.name || '').toLowerCase().includes(searchKeyword.toLowerCase()))
      : chatSummaries;

    if (filtered.length === 0 && !searchKeyword) {
      return '<div class="wg-chat-empty">暂无群聊<br><span>点击 + 创建</span></div>';
    }
    if (filtered.length === 0) {
      return '<div class="wg-chat-empty">未找到匹配的群聊</div>';
    }

    const activeChats = filtered.filter((c) => !c.archived);
    const archivedChats = filtered.filter((c) => c.archived);

    const parts = [];

    // 活跃群聊（无标题，直接列出）
    parts.push(activeChats.map(_renderChatItem).join(''));

    // 已归档群聊（可折叠分组；搜索时自动展开）
    if (archivedChats.length > 0) {
      const collapsed = _archivedCollapsed && !searchKeyword;
      parts.push([
        `<div class="wg-chat-group${collapsed ? ' collapsed' : ''}" data-wg-role="archived-group">`,
        `  <button class="wg-chat-group-header" data-wg-action="toggle-archived">`,
        `    <span class="wg-chat-group-arrow">${collapsed ? '&#9654;' : '&#9660;'}</span>`,
        `    <span class="wg-chat-group-title">已归档</span>`,
        `    <span class="wg-chat-group-count">${archivedChats.length}</span>`,
        '  </button>',
        `  <div class="wg-chat-group-body">${archivedChats.map(_renderChatItem).join('')}</div>`,
        '</div>',
      ].join(''));
    }

    return parts.join('');
  }

  // ── 右侧：群头部 ─────────────────────────────────────────────

  function renderGroupHeader(chat) {
    const initiative = chat.initiativeMode || 'assist';
    const autonomy = chat.autonomyMode || 'auto';
    const initMode = INITIATIVE_MODES.find((m) => m.value === initiative) || INITIATIVE_MODES[0];
    const autoMode = AUTONOMY_MODES.find((m) => m.value === autonomy) || AUTONOMY_MODES[0];

    return [
      '<div class="wg-group-header">',
      `  <span class="wg-group-title">${esc(chat.name)}</span>`,
      '  <div class="wg-mode-bar">',
      renderModeDropdown('initiative', initMode),
      renderModeDropdown('autonomy', autoMode),
      '  </div>',
      '</div>',
    ].join('');
  }

  function renderModeDropdown(type, currentMode) {
    const modes = type === 'initiative' ? INITIATIVE_MODES : AUTONOMY_MODES;
    const label = type === 'initiative' ? '主动性' : '自决权';

    const items = modes.map((m) => {
      const isSelected = m.value === currentMode.value;
      return [
        `<div class="wg-dropdown-item${isSelected ? ' selected' : ''}" data-wg-mode-type="${type}" data-wg-mode-value="${m.value}">`,
        '  <div class="wg-dropdown-item-content">',
        `    <span class="wg-dropdown-item-label">${esc(m.label)}</span>`,
        `    <span class="wg-dropdown-item-desc">${esc(m.desc)}</span>`,
        '  </div>',
        isSelected ? '  <span class="wg-dropdown-check">&#10003;</span>' : '',
        '</div>',
      ].join('');
    }).join('');

    return [
      `<div class="wg-mode-dropdown${openDropdown === type ? ' open' : ''}" data-wg-dropdown="${type}">`,
      `  <button class="wg-mode-trigger" data-wg-action="toggle-dropdown" data-wg-dropdown-type="${type}">`,
      `    <span class="wg-mode-label">${esc(label)}</span>`,
      `    <span class="wg-mode-value">${esc(currentMode.label)}</span>`,
      '  </button>',
      `  <div class="wg-dropdown-menu">${items}</div>`,
      '</div>',
    ].join('');
  }

  // ── 右侧：管理员状态 chip（精简内联，集成到态势层） ──────────

  function renderAdminChip() {
    if (!activeChat) return '';

    const st = _adminStatus;
    const restarting = _adminRestarting;

    // 状态指示
    let dotClass = 'offline';
    if (restarting) {
      dotClass = 'switching';
    } else if (st?.online) {
      dotClass = 'online';
    }

    // 健康度文本（紧凑）
    let healthText = '';
    if (st && !restarting && st.healthStatus && st.healthStatus !== 'unknown') {
      const pct = Math.round(Math.min(1, st.healthRatio || 0) * 100);
      healthText = `${pct}%`;
    }

    // 新会话/启动按钮 — 始终可用
    const btnLabel = restarting ? '…' : (st?.sessionId ? '新会话' : '启动');

    return [
      `<span class="wg-admin-chip ${dotClass}">`,
      `<span class="wg-admin-chip-info" data-wg-member-identity="work-group:admin">`,
      `<span class="wg-admin-chip-dot"></span>`,
      `<span class="wg-admin-chip-name">管理员</span>`,
      healthText ? `<span class="wg-admin-chip-health ${st.healthStatus}">${esc(healthText)}</span>` : '',
      '</span>',
      `<button class="wg-admin-chip-btn${restarting ? ' spinning' : ''}" data-wg-action="admin-restart"`,
      restarting ? ' disabled' : '',
      ` title="${st?.sessionId ? '创建新管理员会话' : '启动管理员会话'}">${esc(btnLabel)}</button>`,
      '</span>',
    ].join('');
  }

  // ── 右侧：态势层 ────────────────────────────────────────────

  /** 计算某个成员的聚合运行时状态 */
  function getMemberAggregateStatus(identityRef) {
    const memberSessions = Object.values(_runtimeStatusCache).filter(
      (s) => s.identityRef === identityRef
    );
    if (memberSessions.some((s) => s.status === 'running')) return 'running';
    if (memberSessions.some((s) => s.status === 'idle')) return 'idle';
    return 'offline';
  }

  /**
   * 根据 _runtimeStatusCache 中的实时运行时状态，解析派发消息的显示状态。
   * 与态势感知面板使用同一数据源（runtime_status API），替代旧版 routing.status
   * （由 trackGroupChatDispatch 轮询维护，使用 /running 端点，经常误标 failed）。
   *
   * 映射关系：
   *   running → delivered（处理中）
   *   idle    → completed（已完成 — agent 在线但空闲，任务处理完毕）
   *   offline → completed（已完成 — 进程已退出，任务处理完毕）
   *   未命中缓存 → 回退到 routing.status
   */
  function resolveDispatchDisplayStatus(routing) {
    if (!routing) return 'pending';
    var sessionId = routing.targetSessionId;
    if (sessionId && _runtimeStatusCache[sessionId]) {
      var rtStatus = _runtimeStatusCache[sessionId].status;
      if (rtStatus === 'running') return 'delivered';
      if (rtStatus === 'idle' || rtStatus === 'offline') return 'completed';
    }
    return routing.status || 'pending';
  }

  function renderAwarenessBar(chat) {
    const adminChip = renderAdminChip();
    const importedCount = (chat.importedSessions || []).length;

    // 成员 chip：每个群成员一个，带 data-wg-member-identity 触发 popover
    const agentMembers = (chat.members || []).filter(
      (m) => m.identityRef !== 'user' && m.identityRef !== 'work-group:admin'
    );

    const memberChips = agentMembers.map((m) => {
      const identityRef = m.identityRef;
      const name = getIdentityName(identityRef);
      const dotClass = getMemberAggregateStatus(identityRef);
      const dotTitle = dotClass === 'running' ? '运行中'
        : dotClass === 'idle' ? '在线 · 空闲'
        : '离线';

      return [
        `<span class="wg-member-chip ${dotClass}" data-wg-member-identity="${esc(identityRef)}">`,
        `  <span class="wg-member-dot ${dotClass}" title="${esc(dotTitle)}"></span>`,
        `  <span class="wg-member-name">${esc(name)}</span>`,
        '</span>',
      ].join('');
    }).join('');

    // 引入按钮：低频操作，降级为极简图标
    const importBtn = [
      `<button class="wg-import-icon-btn" data-wg-action="open-import-modal" title="从其他工作空间引入会话">`,
      `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`,
      importedCount > 0 ? `<span class="wg-import-mini-badge">${importedCount}</span>` : '',
      `</button>`,
    ].join('');

    return [
      '<div class="wg-awareness">',
      adminChip ? `  <div class="wg-awareness-admin">${adminChip}</div>` : '',
      memberChips ? `  <div class="wg-awareness-members">${memberChips}</div>` : `  <div class="wg-awareness-empty">暂无成员</div>`,
      `  <div class="wg-awareness-import">${importBtn}</div>`,
      '</div>',
    ].join('');
  }

  // ── 右侧：事件消息（agent 身份的通知卡片） ─────────────────────

  function renderEventMessage(chat, msg) {
    const evt = msg.event || {};
    if (evt.type !== 'task_started') return '';

    const name = evt.identityName || getMemberName(chat, msg.from);
    const time = formatTime(msg.timestamp);
    const av = generateAvatar(name, msg.from);
    const navTarget = evt.workspaceId && evt.sessionId
      ? `${evt.workspaceId}:${evt.sessionId}` : null;
    const evtSessionBadge = evt.sessionTitle
      ? `<span class="wg-msg-session-badge">${esc(evt.sessionTitle)}</span>` : '';

    const quoteAttrs = [
      `data-wg-quote-ref="${esc(msg.from)}"`,
      evt.workspaceId ? `data-wg-quote-workspace="${esc(evt.workspaceId)}"` : '',
      evt.sessionId ? `data-wg-quote-session="${esc(evt.sessionId)}"` : '',
      evt.sessionTitle ? `data-wg-quote-title="${esc(evt.sessionTitle)}"` : '',
      `data-wg-quote-name="${esc(name)}"`,
    ].filter(Boolean).join(' ');

    return [
      `<div class="wg-msg-row" data-wg-msg-id="${esc(msg.id || '')}" ${quoteAttrs}>`,
      `  <div class="wg-msg-avatar" style="--av-grad:${av.color}">${esc(av.initials)}</div>`,
      '  <div class="wg-msg-body">',
      `    <div class="wg-msg-meta"><span class="wg-msg-identity">${esc(name)}</span>${evtSessionBadge} <span class="wg-msg-time">${esc(time)}</span></div>`,
      '    <div class="wg-card">',
      '      <div class="wg-card-header">',
      '        <span class="wg-card-dot active"></span>',
      '        <span class="wg-card-title">已开始处理</span>',
      '      </div>',
      '      <div class="wg-card-body">',
      evt.sessionTitle
        ? `        <span class="wg-card-session-tag">${esc(evt.sessionTitle)}</span>`
        : `        <span class="wg-card-value">${esc(evt.sessionId ? evt.sessionId.slice(0, 12) : '—')}</span>`,
      navTarget
        ? `        <span class="wg-card-link" data-wg-session-nav="${esc(navTarget)}">查看会话</span>`
        : '',
      '      </div>',
      '    </div>',
      '  </div>',
      '</div>',
    ].join('');
  }

  // ── 右侧：派发卡片（管理员派遣任务） ─────────────────────────

  function renderDispatchCard(chat, msg) {
    const time = formatTime(msg.timestamp);
    const fromName = getMemberName(chat, msg.from);
    const fromAv = generateAvatar(fromName, msg.from);
    const targetRef = msg.mentions?.[0]?.identityRef || msg.routing?.targetIdentityRef;
    const targetName = targetRef ? getIdentityName(targetRef) : '';
    const routing = msg.routing || {};
    const navTarget = routing.targetWorkspaceId && routing.targetSessionId
      ? `${routing.targetWorkspaceId}:${routing.targetSessionId}` : null;
    const sessionLabel = routing.targetSessionTitle || null;
    const displayStatus = resolveDispatchDisplayStatus(routing);

    const quoteAttrs = targetRef && navTarget
      ? [
          `data-wg-quote-ref="${esc(targetRef)}"`,
          `data-wg-quote-workspace="${esc(routing.targetWorkspaceId)}"`,
          routing.targetSessionId ? `data-wg-quote-session="${esc(routing.targetSessionId)}"` : '',
          routing.targetSessionTitle ? `data-wg-quote-title="${esc(routing.targetSessionTitle)}"` : '',
          `data-wg-quote-name="${esc(targetName)}"`,
        ].filter(Boolean).join(' ')
      : '';

    return [
      `<div class="wg-msg-row" data-wg-msg-id="${esc(msg.id || '')}" ${quoteAttrs}>`,
      `  <div class="wg-msg-avatar" style="--av-grad:${fromAv.color}">${esc(fromAv.initials)}</div>`,
      '  <div class="wg-msg-body">',
      `    <div class="wg-msg-meta"><span class="wg-msg-identity">${esc(fromName)}</span> <span class="wg-msg-time">${esc(time)}</span></div>`,
      '    <div class="wg-card dispatch">',
      '      <div class="wg-card-header">',
      `        <span class="wg-card-mention-from">${esc(fromName)}</span>`,
      '        <span class="wg-card-mention-at">@</span>',
      `        <span class="wg-card-mention-to">${esc(targetName)}</span>`,
      '      </div>',
      `      <div class="wg-card-body markdown-body">${renderMarkdown((msg.text || '').slice(0, 300))}</div>`,
      '      <div class="wg-card-footer">',
      `        <span class="wg-card-status"><span class="wg-card-dot ${displayStatus === 'completed' ? '' : 'active'}"></span>${displayStatus === 'completed' ? '已完成' : displayStatus === 'failed' ? '失败' : '进行中'}</span>`,
      sessionLabel
        ? `        <span class="wg-card-session-tag">${esc(sessionLabel)}</span>`
        : '',
      navTarget
        ? `        <span class="wg-card-link" data-wg-session-nav="${esc(navTarget)}">查看会话</span>`
        : '',
      '      </div>',
      '    </div>',
      '  </div>',
      '</div>',
    ].join('');
  }

  // ── 右侧：消息流 ────────────────────────────────────────────

  function renderMessageBubble(chat, msg) {
    // 事件卡片 — 以 agent 身份发送的通知消息，左对齐
    if (msg.kind === 'event') {
      return renderEventMessage(chat, msg);
    }
    // 派发卡片 — 管理员派遣任务
    if (msg.kind === 'dispatch') {
      return renderDispatchCard(chat, msg);
    }

    const isMe = msg.from === 'user';
    const isSummary = msg.kind === 'summary';
    const isAdmin = msg.from === 'work-group:admin' || msg.from === 'work-group-admin:admin';
    const name = getMemberName(chat, msg.from);
    const time = formatTime(msg.timestamp);

    // dispatch 状态（用户消息的派发状态，替代旧的 routing badge）
    // 使用 resolveDispatchDisplayStatus 从 runtime_status 实时数据解析，
    // 与态势感知面板同一数据源，避免旧版 routing.status 误标 failed 的问题。
    let dispatchHtml = '';
    if (isMe && msg.routing) {
      const status = resolveDispatchDisplayStatus(msg.routing);
      const statusText = DISPATCH_STATUS_TEXT[status] || status;
      const targetName = msg.routing.targetIdentityRef
        ? getIdentityName(msg.routing.targetIdentityRef) : '';
      const navTarget = msg.routing.targetWorkspaceId && msg.routing.targetSessionId
        ? `${msg.routing.targetWorkspaceId}:${msg.routing.targetSessionId}` : null;

      dispatchHtml = [
        '<div class="wg-msg-dispatch">',
        `  <span class="wg-dispatch-status ${status}">`,
        '    <span class="wg-session-dot"></span>',
        `    ${esc(statusText)}`,
        '  </span>',
        targetName ? `<span class="wg-dispatch-text">${esc(targetName)}</span>` : '',
        navTarget
          ? `<span class="wg-dispatch-link" data-wg-session-nav="${esc(navTarget)}">查看会话</span>`
          : '',
        '</div>',
      ].join('');
    }

    // agent 回复消息的 session 导航
    let sessionLink = '';
    if (!isMe && msg.routing?.targetSessionId && msg.routing?.targetWorkspaceId) {
      const navTarget = `${msg.routing.targetWorkspaceId}:${msg.routing.targetSessionId}`;
      const sessionLabel = msg.routing.targetSessionTitle || msg.routing.targetSessionId.slice(-8);
      sessionLink = [
        `<span class="wg-session-link-tag" data-wg-session-nav="${esc(navTarget)}" title="点击跳转到会话">`,
        `  <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`,
        `  ${esc(sessionLabel)}`,
        '</span>',
      ].join('');
    }

    // 身份标签（非用户消息）+ 会话标识 badge
    // 同一身份可能同时有多个会话，用 session badge 区分来源
    const sessionBadge = (!isMe && !isSummary && msg.routing?.targetSessionTitle)
      ? `<span class="wg-msg-session-badge">${esc(msg.routing.targetSessionTitle)}</span>` : '';
    const identityTag = (!isMe && !isSummary && msg.from && msg.from !== 'user')
      ? `<span class="wg-msg-identity">${esc(name)}</span>${sessionBadge}` : '';

    // 链接引用
    const linksHtml = (Array.isArray(msg.links) && msg.links.length > 0)
      ? '<div class="wg-msg-links">' + msg.links.map((l) => {
          return `<a href="${esc(l.url)}" target="_blank" class="wg-msg-link">${esc(l.description || l.url)}</a>`;
        }).join('') + '</div>'
      : '';

    // 附件标签（点击可在文档面板打开）
    const attachmentsHtml = (Array.isArray(msg.attachments) && msg.attachments.length > 0)
      ? '<div class="wg-msg-attachments">' + msg.attachments.map((a) => {
          return `<span class="wg-msg-attachment-tag clickable" data-wg-attachment-open="${esc(a.name)}" title="${esc(a.name)} — 点击在文档面板打开">${esc(a.name)}</span>`;
        }).join('') + '</div>'
      : '';

    const av = generateAvatar(name, msg.from);
    const bubbleClass = isSummary ? ' summary' : (isAdmin ? ' admin' : '');

    if (isMe) {
      return [
        `<div class="wg-msg-row me" data-wg-msg-id="${esc(msg.id || '')}">`,
        '  <div class="wg-msg-body">',
        `    <div class="wg-msg-meta"><span class="wg-msg-time">${esc(time)}</span></div>`,
        `    <div class="wg-msg-bubble markdown-body${bubbleClass}">${renderMarkdown(msg.text || '')}</div>`,
        attachmentsHtml,
        linksHtml,
        dispatchHtml,
        '  </div>',
        '</div>',
      ].join('');
    }

    // agent 回复消息的 quote 数据（供右键引用使用）
    // routing 信息可能缺失，但只要不是自己的消息就至少打上 ref/name 标记，
    // 这样右键引用菜单也能识别发送者并降级为单纯 @mention。
    const hasRouting = !isMe && !isSummary && msg.routing?.targetSessionId && msg.routing?.targetWorkspaceId;
    const quoteAttrs = (!isMe && !isSummary && msg.from && msg.from !== 'user')
      ? [
          `data-wg-quote-ref="${esc(msg.from)}"`,
          hasRouting ? `data-wg-quote-workspace="${esc(msg.routing.targetWorkspaceId)}"` : '',
          hasRouting ? `data-wg-quote-session="${esc(msg.routing.targetSessionId)}"` : '',
          hasRouting && msg.routing.targetSessionTitle ? `data-wg-quote-title="${esc(msg.routing.targetSessionTitle)}"` : '',
          `data-wg-quote-name="${esc(name)}"`,
        ].filter(Boolean).join(' ')
      : '';

    return [
      `<div class="wg-msg-row" data-wg-msg-id="${esc(msg.id || '')}" ${quoteAttrs}>`,
      `  <div class="wg-msg-avatar" style="--av-grad:${av.color}">${esc(av.initials)}</div>`,
      '  <div class="wg-msg-body">',
      `    <div class="wg-msg-meta">${identityTag} <span class="wg-msg-time">${esc(time)}</span></div>`,
      `    <div class="wg-msg-bubble markdown-body${bubbleClass}">${renderMarkdown(msg.text || '')}</div>`,
      attachmentsHtml,
      linksHtml,
      sessionLink ? `    <div class="wg-msg-footer">${sessionLink}</div>` : '',
      '  </div>',
      '</div>',
    ].join('');
  }

  function renderMessageList(chat) {
    const bubbles = (chat.messages || []).map((msg) => renderMessageBubble(chat, msg)).join('');
    return '<div class="wg-msg-list">' + bubbles + '</div>';
  }

  // 长消息气泡自动折叠
  const COLLAPSE_THRESHOLD = 300;
  const _expandedMsgIds = new Set();
  function applyCollapsible(container) {
    if (!container) return;
    const targets = container.querySelectorAll('.wg-msg-bubble, .wg-card-body.markdown-body');
    targets.forEach((el) => {
      const row = el.closest('.wg-msg-row');
      if (!row) return;
      const msgId = row.dataset.wgMsgId;
      if (!msgId) return;
      if (el.dataset.wgCollapseInit) return;

      // 先隐藏元素，避免闪烁
      const originalVisibility = el.style.visibility;
      const originalPosition = el.style.position;
      el.style.visibility = 'hidden';
      el.style.position = 'absolute';

      // 添加折叠类，但先不添加 collapsed 类，检查自然高度
      el.classList.add('wg-collapsible');
      const needsCollapse = el.scrollHeight > COLLAPSE_THRESHOLD;

      if (!needsCollapse) {
        // 不需要折叠，移除类并恢复样式
        el.classList.remove('wg-collapsible');
        el.style.visibility = originalVisibility;
        el.style.position = originalPosition;
        return;
      }

      // 需要折叠
      el.dataset.wgCollapseInit = '1';
      const isExpanded = _expandedMsgIds.has(msgId);
      if (!isExpanded) el.classList.add('collapsed');

      // 恢复元素可见性
      el.style.visibility = originalVisibility;
      el.style.position = originalPosition;

      const toggleBar = document.createElement('div');
      toggleBar.className = 'wg-collapse-toggle';
      const btn = document.createElement('button');
      btn.innerHTML = isExpanded
        ? '<svg viewBox="0 0 24 24"><path d="M12 8l-6 6 1.41 1.41L12 10.83l4.59 4.58L18 14z"/></svg> 收起'
        : '<svg viewBox="0 0 24 24"><path d="M16.59 8.59L12 13.17 7.41 8.59 6 10l6 6 6-6z"/></svg> 展开';
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const willCollapse = !el.classList.contains('collapsed');
        el.classList.toggle('collapsed');
        btn.innerHTML = willCollapse
          ? '<svg viewBox="0 0 24 24"><path d="M16.59 8.59L12 13.17 7.41 8.59 6 10l6 6 6-6z"/></svg> 展开'
          : '<svg viewBox="0 0 24 24"><path d="M12 8l-6 6 1.41 1.41L12 10.83l4.59 4.58L18 14z"/></svg> 收起';
        if (willCollapse) {
          _expandedMsgIds.delete(msgId);
        } else {
          _expandedMsgIds.add(msgId);
        }
      });
      toggleBar.appendChild(btn);
      // 放到 bubble 外面、下方（作为 .wg-msg-body 内的兄弟元素）
      el.insertAdjacentElement('afterend', toggleBar);
    });
  }

  // ── 右侧：@mention 选择器 ───────────────────────────────────

  function renderMentionPicker() {
    return '<div class="wg-mention-picker" data-wg-role="mention-picker" style="display:none;"></div>';
  }

  // ── 右侧：输入区 ────────────────────────────────────────────

  function renderInputArea() {
    return [
      '<div class="wg-input-area">',
      '  <div class="wg-session-bar" data-wg-role="session-bar"></div>',
      '  <div class="wg-input-box">',
      '    <div class="wg-attachment-list" data-wg-role="attachment-list" style="display:none;"></div>',
      '    <div class="wg-link-list" data-wg-role="link-list"></div>',
      '    <div class="wg-input-editor" contenteditable="true" data-placeholder="输入消息，使用「@」派发任务"></div>',
      '    <div class=\"wg-input-footer\">',
      '      <button class=\"wg-mention-icon\" data-wg-action=\"mention\" title=\"提及成员\">',
      '        <svg viewBox=\"0 0 24 24\" width=\"18\" height=\"18\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\"><circle cx=\"12\" cy=\"12\" r=\"4\"/><path d=\"M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.92 7.94\"/></svg>',
      '      </button>',
      '      <button class=\"wg-voice-btn\" data-wg-action=\"voice\" title=\"语音输入\">',
      '        <svg class=\"icon-mic\" width=\"18\" height=\"18\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z\"></path><path d=\"M19 10v2a7 7 0 0 1-14 0v-2\"></path><line x1=\"12\" y1=\"19\" x2=\"12\" y2=\"22\"></line></svg>',
      '      </button>',
      '      <span class=\"wg-input-hint\">Enter 发送 · Shift+Enter 换行</span>',
      '      <div class=\"wg-input-spacer\"></div>',
      '      <button class=\"wg-send-btn\" data-wg-action=\"send\">发送</button>',
      '    </div>',
      '  </div>',
      renderMentionPicker(),
      '</div>',
    ].join('');
  }

  // ── 右侧：设置面板 ───────────────────────────────────────────

  function renderAdminModelOptions() {
    if (adminModelState.loading && !adminModelState.loaded) {
      return '<option value="">加载中</option>';
    }
    if (adminModelState.error) {
      return '<option value="">加载失败</option>';
    }
    const current = adminModelState.current || '';
    const presetOptions = adminModelState.presets.map((p) => {
      const name = typeof p === 'string' ? p : (p.name || '');
      if (!name) return '';
      const sel = name === current ? ' selected' : '';
      return `<option value="${esc(name)}"${sel}>${esc(name)}</option>`;
    }).filter(Boolean).join('');
    return `<option value=""${current ? '' : ' selected'}>使用全局默认</option>` + presetOptions;
  }

  function isManageableGroupIdentity(identityRef) {
    return identityRef && identityRef !== 'user' && identityRef !== 'work-group:admin';
  }

  function normalizeGroupMembers(members) {
    const result = [];
    const seen = new Set();
    const add = (member) => {
      const ref = member?.identityRef;
      if (!ref || seen.has(ref)) return;
      seen.add(ref);
      result.push(member);
    };
    add({ identityRef: 'user', role: 'human' });
    add({ identityRef: 'work-group:admin', role: 'admin' });
    (members || []).forEach((m) => {
      if (m.identityRef === 'user' || m.identityRef === 'work-group:admin') return;
      add({ identityRef: m.identityRef, role: m.role || 'agent' });
    });
    return result;
  }

  function getChatMemberRefs(chat = activeChat) {
    return new Set(normalizeGroupMembers(chat?.members || []).map((m) => m.identityRef));
  }

  function getAvailableMemberIdentities(chat = activeChat) {
    const memberRefs = getChatMemberRefs(chat);
    return identities.filter((id) =>
      isManageableGroupIdentity(id.identityRef) && !memberRefs.has(id.identityRef)
    );
  }

  // ── 成员头像网格（微信/QQ 风格） ───────────────────────────

  function renderGroupMemberRows(chat) {
    const members = normalizeGroupMembers(chat.members || []);
    if (!members.length) {
      return '<div class="wg-settings-empty-note">当前群聊还没有成员。</div>';
    }

    const cells = members.map((m) => {
      const identity = identities.find((id) => id.identityRef === m.identityRef);
      const name = m.identityRef === 'user' ? '我' : (identity?.displayName || getIdentityName(m.identityRef));
      const avatar = generateAvatar(name, m.identityRef);
      const canRemove = isManageableGroupIdentity(m.identityRef);
      const encodedRef = encodeURIComponent(m.identityRef);

      return [
        `<div class="wg-member-cell${canRemove ? ' removable' : ''}">`,
        '  <div class="wg-member-cell-avatar-wrap">',
        `    <div class="wg-avatar wg-avatar-md" style="--av-grad:${avatar.color}">${esc(avatar.initials)}</div>`,
        canRemove
          ? `    <button class="wg-member-cell-remove" onclick="window._wgRemoveMember(decodeURIComponent('${encodedRef}'))" title="移出群聊">&times;</button>`
          : '',
        '  </div>',
        `  <span class="wg-member-cell-name" title="${esc(name)}">${esc(name)}</span>`,
        '</div>',
      ].join('');
    }).join('');

    // 网格末尾的「+ 添加」按钮
    const addCell = [
      '<div class="wg-member-cell wg-member-cell-add">',
      '  <button class="wg-member-cell-add-btn" onclick="window._wgOpenAddMemberModal()" title="添加成员">',
      '    <span class="wg-member-cell-add-icon">+</span>',
      '  </button>',
      '  <span class="wg-member-cell-name">添加</span>',
      '</div>',
    ].join('');

    return `<div class="wg-member-grid">${cells}${addCell}</div>`;
  }

  // renderAddMemberControl 已被头像网格中的「+」按钮 + 弹窗替代
  function renderAddMemberControl(_chat) {
    return '';
  }

  // ── GROUP.md 只读卡片 + 群资料库入口 ──────────────────────────

  function renderFilesBridgeSection(chat) {
    const hasWorkDir = !!chat.workDir;
    const mdValue = (groupMdLoading || groupMdChatId !== chat.id) ? '' : groupMdContent;
    const mdSummary = _extractMdSummary(mdValue);

    const groupMdCard = (groupMdLoading && groupMdChatId === chat.id)
      ? '<div class="wg-group-md-summary wg-group-md-loading wg-group-md-clickable">加载中</div>'
      : mdSummary
        ? `<div class="wg-group-md-summary wg-group-md-clickable" onclick="window._wgEditGroupMd()">${esc(mdSummary)}</div>`
        : '<div class="wg-group-md-summary wg-group-md-empty wg-group-md-clickable" onclick="window._wgEditGroupMd()">点击添加群聊背景、目标和约定。</div>';

    return [
      // GROUP.md 只读卡片
      '  <div class="wg-settings-section">',
      '    <div class="wg-settings-section-header">',
      '      <span class="wg-settings-section-title">GROUP.md</span>',
      '    </div>',
      groupMdCard,
      '  </div>',
      // 群资料库
      '  <div class="wg-settings-section">',
      '    <div class="wg-settings-section-header">',
      '      <span class="wg-settings-section-title">群资料库</span>',
      hasWorkDir
        ? '      <button class="wg-settings-section-action" onclick="window._wgOpenFilesPanel()">打开文件</button>'
        : '      <button class="wg-settings-section-action" onclick="window._wgChangeWorkDir()">选择目录</button>',
      '    </div>',
      hasWorkDir
        ? `    <div class="wg-resource-bridge-info"><code>${esc(chat.workDir)}/.agentdev/resources</code></div>`
        : '    <div class="wg-settings-empty-note">未配置工作目录</div>',
      '  </div>',
    ].join('');
  }

  function renderSettingsPanel(chat) {
    const members = normalizeGroupMembers(chat.members || []);
    const memberCount = members.length;
    const avatar = generateAvatar(chat.name, null, chat.createdAt);
    const createdDate = _formatCreateDate(chat.createdAt);
    const memberGrid = renderGroupMemberRows(chat);

    return [
      '<div class="wg-settings-panel">',

      // ── 群资料卡片头部 ──
      '  <div class="wg-settings-profile-card">',
      `    <div class="wg-avatar wg-avatar-lg" style="--av-grad:${avatar.color}">${esc(avatar.initials)}</div>`,
      '    <div class="wg-settings-profile-info">',
      `      <input type="text" class="wg-settings-profile-name" value="${esc(chat.name)}" onchange="window._wgSettingsChange('name', this.value)" />`,
      `      <div class="wg-settings-profile-meta">${memberCount} 名成员${createdDate ? ' · 创建于 ' + esc(createdDate) : ''}</div>`,
      chat.workDir
        ? `      <div class="wg-settings-profile-workdir"><code title="${esc(chat.workDir)}">${esc(chat.workDir)}</code></div>`
        : '      <div class="wg-settings-profile-workdir"><span class="wg-settings-profile-no-workdir">未设置工作目录</span> <button class="wg-link-btn" onclick="window._wgChangeWorkDir()">设置</button></div>',
      '    </div>',
      '  </div>',

      // ── 成员头像网格 ──
      '  <div class="wg-settings-section">',
      '    <div class="wg-settings-section-header">',
      `      <span class="wg-settings-section-title">成员 (${memberCount})</span>`,
      '    </div>',
      memberGrid,
      '  </div>',

      // ── GROUP.md 只读卡片 + 群资料库 ──
      renderFilesBridgeSection(chat),

      // ── 管理员配置折叠区 ──
      '  <div class="wg-settings-collapse">',
      `    <button class="wg-settings-collapse-toggle${_settingsAdminCollapsed ? '' : ' expanded'}" onclick="window._wgToggleAdminConfig()">`,
      '      <span class="wg-settings-collapse-label">管理员配置</span>',
      `      <span class="wg-collapse-arrow">${_settingsAdminCollapsed ? '&#9654;' : '&#9660;'}</span>`,
      '    </button>',
      !_settingsAdminCollapsed ? renderAdminConfigBody(chat) : '',
      '  </div>',

      // ── 危险区 ──
      '  <div class="wg-settings-section wg-settings-danger">',
      chat.archived
        ? '    <button class="wg-btn-secondary" onclick="window._wgUnarchive()">取消归档</button>'
        : '    <button class="wg-btn-secondary" onclick="window._wgArchive()">归档群聊</button>',
      `    <button class="wg-btn-danger" onclick="window._wgDissolve()">解散此群聊</button>`,
      '  </div>',

      '</div>',
    ].join('');
  }

  // ── 管理员配置折叠区内容（模式设置 + 记忆 + 模型） ───────────

  function renderAdminConfigBody(chat) {
    const initiative = chat.initiativeMode || 'assist';
    const autonomy = chat.autonomyMode || 'auto';
    const memRange = chat.adminMemory?.range || '3d';
    const memLimitMode = chat.adminMemory?.limitMode || 'tokens';
    const memTokenLimit = chat.adminMemory?.tokenLimit ?? chat.adminMemory?.limitValue ?? 100000;
    const memRatioLimit = chat.adminMemory?.ratioLimit ?? 80;

    const initiativeOptions = INITIATIVE_MODES.map((m) =>
      `<option value="${m.value}"${m.value === initiative ? ' selected' : ''}>${esc(m.label)} — ${esc(m.desc)}</option>`
    ).join('');

    const autonomyOptions = AUTONOMY_MODES.map((m) =>
      `<option value="${m.value}"${m.value === autonomy ? ' selected' : ''}>${esc(m.label)} — ${esc(m.desc)}</option>`
    ).join('');

    // 上下文限制：分段切换 + 对应值输入（两组值独立存储，切换不丢失）
    const isTokenMode = memLimitMode === 'tokens';
    const limitSuffix = isTokenMode ? 'tokens' : '%';
    const limitMin = isTokenMode ? '1000' : '1';
    const limitMax = isTokenMode ? '1000000' : '100';
    const limitPlaceholder = isTokenMode ? '100000' : '80';
    const currentLimitValue = isTokenMode ? memTokenLimit : memRatioLimit;
    const limitField = isTokenMode ? 'memoryTokenLimit' : 'memoryRatioLimit';

    return [
      '    <div class="wg-settings-collapse-body">',

      // 模式设置
      '      <div class="wg-settings-sub-section">',
      '        <div class="wg-settings-sub-title">模式设置</div>',
      `        <div class="wg-config-row"><span class="wg-config-label">主动性</span><select class="wg-config-select" onchange="window._wgSettingsChange('initiativeMode', this.value)">${initiativeOptions}</select></div>`,
      `        <div class="wg-config-row"><span class="wg-config-label">自决权</span><select class="wg-config-select" onchange="window._wgSettingsChange('autonomyMode', this.value)">${autonomyOptions}</select></div>`,
      '      </div>',

      // 管理员记忆
      '      <div class="wg-settings-sub-section">',
      '        <div class="wg-settings-sub-title">管理员记忆</div>',
      `        <div class="wg-config-row"><span class="wg-config-label">记忆范围</span><select class="wg-config-select" onchange="window._wgSettingsChange('memoryRange', this.value)">`,
      `          <option value="1d"${memRange === '1d' ? ' selected' : ''}>最近 1 天</option>`,
      `          <option value="3d"${memRange === '3d' ? ' selected' : ''}>最近 3 天</option>`,
      `          <option value="1w"${memRange === '1w' ? ' selected' : ''}>最近 1 周</option>`,
      `          <option value="all"${memRange === 'all' ? ' selected' : ''}>全部记录</option>`,
      '        </select></div>',
      // 上下文限制：标签 + 分段切换 + 值输入，全部在同一行
      `        <div class="wg-config-row"><span class="wg-config-label">上下文限制</span>`,
      `          <div class="wg-config-limit-controls">`,
      `            <div class="wg-segment-toggle">`,
      `              <button class="wg-segment-btn${isTokenMode ? ' active' : ''}" onclick="window._wgSettingsChange('memoryLimitMode','tokens')">按 Token</button>`,
      `              <button class="wg-segment-btn${!isTokenMode ? ' active' : ''}" onclick="window._wgSettingsChange('memoryLimitMode','ratio')">按比例</button>`,
      `            </div>`,
      `            <div class="wg-config-limit-input">`,
      `              <input type="number" value="${currentLimitValue}" min="${limitMin}" max="${limitMax}" class="wg-settings-input wg-config-limit-value" onchange="window._wgSettingsChange('${limitField}', this.value)" placeholder="${limitPlaceholder}" />`,
      `              <span class="wg-config-limit-suffix">${limitSuffix}</span>`,
      `            </div>`,
      `          </div>`,
      `        </div>`,
      '      </div>',

      // 管理员模型
      '      <div class="wg-settings-sub-section">',
      '        <div class="wg-settings-sub-title">管理员模型</div>',
      `        <div class="wg-config-row"><span class="wg-config-label">模型预设</span><select class="wg-config-select" onchange="window._wgSettingsChange('admin-model', this.value)" data-wg-role="admin-model-select">${renderAdminModelOptions()}</select></div>`,
      '      </div>',

      '    </div>',
    ].join('');
  }

  // ── 右侧：空状态 ────────────────────────────────────────────

  function renderEmptyConversation() {
    return '<div class="wg-conversation-empty"><p>选择一个群聊开始工作</p></div>';
  }

  // ── 右侧：整体渲染 ──────────────────────────────────────────

  function renderConversation() {
    if (!activeChatId) return renderEmptyConversation();
    if (!activeChat) return '<div class="wg-conversation-empty"><p>加载中</p></div>';

    return [
      '<div class="wg-conversation">',
      renderGroupHeader(activeChat),
      renderAwarenessBar(activeChat),
      '<div class="wg-msg-scroll">' + renderMessageList(activeChat) + '</div>',
      renderInputArea(),
      '</div>',
    ].join('');
  }

  // ── 整体 workspace surface ─────────────────────────────────

  // 计算 contenteditable 编辑器内光标的字符偏移，用于 DOM 重建后恢复光标位置
  function _captureEditorSelection(editor) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    if (!editor.contains(range.commonAncestorContainer)) return null;

    const preRange = document.createRange();
    preRange.selectNodeContents(editor);
    preRange.setEnd(range.startContainer, range.startOffset);
    const startOffset = preRange.toString().length;
    return { startOffset, hadFocus: editor === document.activeElement };
  }

  function _restoreEditorSelection(editor, captured) {
    if (!editor || !captured) return false;
    const textNode = editor.firstChild;
    // 简单场景：单文本节点
    if (!textNode) {
      editor.focus();
      return false;
    }
    const text = editor.textContent;
    const offset = Math.min(captured.startOffset, text.length);
    const range = document.createRange();
    let cur = 0;
    let placed = false;

    function walk(node) {
      if (placed) return;
      if (node.nodeType === Node.TEXT_NODE) {
        const len = node.textContent.length;
        if (cur + len >= offset) {
          range.setStart(node, offset - cur);
          range.collapse(true);
          placed = true;
          return;
        }
        cur += len;
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        if (node.tagName === 'BR') {
          if (cur === offset) {
            range.setStart(node.parentNode, Array.from(node.parentNode.childNodes).indexOf(node));
            range.collapse(true);
            placed = true;
            return;
          }
          cur += 0;
        } else {
          for (const child of node.childNodes) walk(child);
        }
      }
    }
    walk(editor);
    if (!placed) {
      range.selectNodeContents(editor);
      range.collapse(false);
    }
    const newSel = window.getSelection();
    newSel.removeAllRanges();
    newSel.addRange(range);
    return true;
  }

  function renderWorkGroupSurface() {
    // 外层 renderCurrentMainView() 重建 DOM 前，保存消息区滚动位置（距底部偏移量）
    const existingScroll = document.querySelector('.wg-msg-scroll');
    const scrollExistsInDom = !!existingScroll;
    let savedOffsetFromBottom = 0;
    if (existingScroll) {
      savedOffsetFromBottom = existingScroll.scrollHeight - existingScroll.scrollTop;
      _savedMsgScrollTop = existingScroll.scrollTop; // 兼容其他路径
    }

    // 保存输入框内容、焦点、光标位置（DOM 重建后会丢失）
    const existingEditor = document.querySelector('.wg-input-editor');
    const savedEditorHtml = existingEditor ? existingEditor.innerHTML : null;
    const savedEditorFocus = existingEditor ? (existingEditor === document.activeElement) : false;
    const savedEditorSelection = existingEditor && savedEditorFocus
      ? _captureEditorSelection(existingEditor) : null;
    // 保存搜索框焦点
    const existingSearch = document.querySelector('[data-wg-role="search"]');
    const savedSearchFocus = existingSearch ? (existingSearch === document.activeElement) : false;
    // 保存搜索框光标位置（避免输入时光标被强制移到末尾）
    const savedSearchSelectionStart = existingSearch ? existingSearch.selectionStart : null;
    const savedSearchSelectionEnd = existingSearch ? existingSearch.selectionEnd : null;

    const html = [
      '<div class="wg-app">',
      '  <div class="wg-sidebar">',
      '    <div class="wg-sidebar-header">',
      '      <input type="text" class="wg-search-input" placeholder="搜索群聊" data-wg-role="search" value="' + esc(searchKeyword) + '">',
      '      <button class="wg-new-chat-btn" data-wg-action="new-chat" title="新建群聊">',
      '        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>',
      '      </button>',
      '    </div>',
      '    <div class="wg-chat-list" data-wg-role="chat-list">' + renderChatList() + '</div>',
      '  </div>',
      '  <div class="wg-main" data-wg-role="main">' + renderConversation() + '</div>',
      '</div>',
    ].join('');

    // 用 microtask 而不是 rAF，让 DOM 替换完成后立刻恢复，避免一帧的失焦闪烁
    Promise.resolve().then(() => {
      // 始终恢复输入框内容（无论是否有焦点），避免外部重建时内容丢失
      if (savedEditorHtml !== null) {
        const newEditor = document.querySelector('.wg-input-editor');
        if (newEditor && newEditor.innerHTML !== savedEditorHtml) {
          newEditor.innerHTML = savedEditorHtml;
        }
        if (savedEditorFocus && newEditor) {
          newEditor.focus();
          _restoreEditorSelection(newEditor, savedEditorSelection);
        }
      }

      // 恢复搜索框焦点和光标位置
      if (savedSearchFocus) {
        const newSearch = document.querySelector('[data-wg-role="search"]');
        if (newSearch) {
          newSearch.focus();
          if (savedSearchSelectionStart !== null) {
            newSearch.setSelectionRange(savedSearchSelectionStart, savedSearchSelectionEnd);
          }
        }
      }

      // 恢复附件列表和链接列表
      renderAttachmentList();
      renderLinkList();

      // 应用长消息折叠 & 注解条（必须在恢复滚动位置之前完成，
      // 因为折叠会改变 scrollHeight）
      // 这一步对于 workspace 切换后"冷加载"场景尤为关键：
      // 外层 renderCurrentMainView 先把 HTML 写入 DOM 再通过
      // rAF 恢复 visibility，此微任务在 rAF 之前执行，
      // 因此折叠在用户看到页面之前完成，避免展开态闪烁。
      const msgScroll = document.querySelector('.wg-msg-scroll');
      if (msgScroll) {
        if (typeof enhanceMathInElement === 'function') enhanceMathInElement(msgScroll);
        applyCollapsible(msgScroll);
        _renderAnnotationBars();
      }

      // 最后恢复滚动位置——在所有 DOM 修改完成之后，保证视觉位置不变
      const newScroll = msgScroll;
      if (newScroll) {
        _suppressScrollEvent = true;
        if (_shouldScrollToBottom) {
          _shouldScrollToBottom = false;
          newScroll.scrollTop = newScroll.scrollHeight;
        } else if (scrollExistsInDom) {
          newScroll.scrollTop = newScroll.scrollHeight - savedOffsetFromBottom;
        } else {
          newScroll.scrollTop = newScroll.scrollHeight;
        }
        _suppressScrollEvent = false;
      }
    });

    return html;
  }

  // ── 局部刷新 ────────────────────────────────────────────────

  function refreshMain() {
    const main = document.querySelector('[data-wg-role="main"]');
    if (main) {
      // 保存滚动位置（DOM 重建前）
      const scroll = main.querySelector('.wg-msg-scroll');
      const offsetFromBottom = scroll ? scroll.scrollHeight - scroll.scrollTop : 0;
      const scrollExists = !!scroll;

      main.innerHTML = renderConversation();
      if (typeof enhanceMathInElement === 'function') enhanceMathInElement(main);
      // DOM 重建后恢复附件列表和链接列表（pendingAttachments/pendingLinks 是模块级变量，不会因重渲染丢失）
      renderAttachmentList();
      renderLinkList();
      // 恢复 session bar（_chatSessionSelection 是模块级变量，不会被重渲染清除）
      renderSessionBar();

      // 恢复滚动位置（DOM 重建后）
      const newScroll = main.querySelector('.wg-msg-scroll');
      if (newScroll) {
        _suppressScrollEvent = true;
        if (_shouldScrollToBottom) {
          _shouldScrollToBottom = false;
          newScroll.scrollTop = newScroll.scrollHeight;
        } else if (scrollExists) {
          newScroll.scrollTop = newScroll.scrollHeight - offsetFromBottom;
        } else {
          // 退出再进入场景：滚动到底部
          newScroll.scrollTop = newScroll.scrollHeight;
        }
        _suppressScrollEvent = false;
      }
      applyCollapsible(main);
      _renderAnnotationBars();
    }
  }

  function refreshMessagesOnly() {
    const scroll = document.querySelector('.wg-msg-scroll');
    if (!scroll) return;

    // 用"距底部偏移量"而非绝对 scrollTop 来保存位置，这样在 DOM 修改导致
    // scrollHeight 变化时仍能精确恢复到同一视觉位置。
    const offsetFromBottom = scroll.scrollHeight - scroll.scrollTop;
    const nearBottom = offsetFromBottom - scroll.clientHeight < 80;

    // 隐藏元素避免 innerHTML 重建时的闪烁
    const originalVisibility = scroll.style.visibility;
    scroll.style.visibility = 'hidden';

    scroll.innerHTML = renderMessageList(activeChat);
    if (typeof enhanceMathInElement === 'function') enhanceMathInElement(scroll);

    // 先完成所有会修改 scrollHeight 的 DOM 操作，再恢复滚动位置
    applyCollapsible(scroll);
    _renderAnnotationBars();

    // 现在 scrollHeight 已经稳定，恢复滚动位置
    // 抑制 scroll 事件，防止程序触发的 scrollTop 被误判为用户手动滚动
    _suppressScrollEvent = true;
    if (_shouldScrollToBottom) {
      _shouldScrollToBottom = false;
      scroll.scrollTop = scroll.scrollHeight;
    } else if (nearBottom && !_userScrolling) {
      scroll.scrollTop = scroll.scrollHeight;
    } else {
      scroll.scrollTop = scroll.scrollHeight - offsetFromBottom;
    }
    _suppressScrollEvent = false;

    scroll.style.visibility = originalVisibility;
  }

  function refreshHeaderAndMessages() {
    // 只更新 header / admin bar / awareness / messages，完全不触碰输入区。
    // 旧实现会 refreshMain() 重建整个 main，导致输入框 DOM 被销毁重建，
    // 当焦点不在编辑器（例如点击模式按钮）时输入内容会丢失。
    const conv = document.querySelector('.wg-conversation');
    if (!conv) { refreshMain(); return; }

    const header = conv.querySelector('.wg-group-header');
    if (header) {
      const newHeader = document.createElement('div');
      newHeader.innerHTML = renderGroupHeader(activeChat);
      const replacement = newHeader.firstElementChild;
      if (replacement) header.replaceWith(replacement);
    }

    const awareness = conv.querySelector('.wg-awareness');
    if (awareness) {
      const newAwareness = document.createElement('div');
      newAwareness.innerHTML = renderAwarenessBar(activeChat);
      const replacement = newAwareness.firstElementChild;
      if (replacement) awareness.replaceWith(replacement);
    }

    const scroll = conv.querySelector('.wg-msg-scroll');
    if (scroll) {
      const offsetFromBottom = scroll.scrollHeight - scroll.scrollTop;
      const nearBottom = offsetFromBottom - scroll.clientHeight < 80;

      const originalVisibility = scroll.style.visibility;
      scroll.style.visibility = 'hidden';

      scroll.innerHTML = renderMessageList(activeChat);
      if (typeof enhanceMathInElement === 'function') enhanceMathInElement(scroll);

      // 先完成所有会修改 scrollHeight 的 DOM 操作，再恢复滚动位置
      applyCollapsible(scroll);
      _renderAnnotationBars();

      // 现在 scrollHeight 已经稳定，恢复滚动位置
      _suppressScrollEvent = true;
      if (_shouldScrollToBottom) {
        _shouldScrollToBottom = false;
        scroll.scrollTop = scroll.scrollHeight;
      } else if (nearBottom && !_userScrolling) {
        scroll.scrollTop = scroll.scrollHeight;
      } else {
        scroll.scrollTop = scroll.scrollHeight - offsetFromBottom;
      }
      _suppressScrollEvent = false;

      scroll.style.visibility = originalVisibility;
    }
  }

  function refreshChatList() {
    const list = document.querySelector('[data-wg-role="chat-list"]');
    if (list) list.innerHTML = renderChatList();
  }

  function refreshAdminBarOnly() {
    const awareness = document.querySelector('.wg-awareness');
    if (!awareness) return;

    // 如果 popover 正在显示，不能替换整个 DOM（会丢失 hover 状态），
    // 只原地更新 chip 状态点。
    if (_popoverEl && _hoverIdentity) {
      _updateAwarenessDotsInPlace(awareness);
      // 同时刷新 popover 内容（更新会话运行时状态）
      _refreshPopoverIfOpen();
      return;
    }

    const newEl = document.createElement('div');
    newEl.innerHTML = renderAwarenessBar(activeChat);
    const replacement = newEl.firstElementChild;
    if (replacement) awareness.replaceWith(replacement);

    // 如果 hover timer 正在等待（120ms 窗口内），原来的 anchor chip 已被销毁。
    // 在新 DOM 中重新找到对应 chip 并重新绑定 timer。
    if (_hoverIdentity) {
      const newChip = replacement.querySelector(
        `[data-wg-member-identity="${CSS.escape(_hoverIdentity)}"]`
      );
      if (newChip) {
        clearTimeout(_hoverTimer);
        const pendingId = _hoverIdentity;
        _hoverTimer = setTimeout(() => {
          if (_hoverIdentity === pendingId) showMemberPopover(pendingId, newChip);
        }, 120);
      }
    }
  }

  /** 原地更新态势栏中各 chip 的状态点，不替换 DOM 元素 */
  function _updateAwarenessDotsInPlace(awareness) {
    // 更新成员 chip 状态
    const chips = awareness.querySelectorAll('.wg-member-chip[data-wg-member-identity]');
    chips.forEach((chip) => {
      const identityRef = chip.dataset.wgMemberIdentity;
      if (identityRef === 'work-group:admin') return; // admin 单独处理
      const dotClass = getMemberAggregateStatus(identityRef);
      const dotTitle = dotClass === 'running' ? '运行中'
        : dotClass === 'idle' ? '在线 · 空闲' : '离线';
      chip.classList.remove('running', 'idle', 'offline');
      chip.classList.add(dotClass);
      const dot = chip.querySelector('.wg-member-dot');
      if (dot) {
        dot.classList.remove('running', 'idle', 'offline');
        dot.classList.add(dotClass);
        dot.title = dotTitle;
      }
    });

    // 更新 admin chip（替换 admin 区域的 HTML）
    const adminDiv = awareness.querySelector('.wg-awareness-admin');
    if (adminDiv) {
      const newAdminHtml = renderAdminChip();
      if (newAdminHtml) {
        adminDiv.innerHTML = newAdminHtml;
      }
    }
  }

  /** 如果 popover 正打开，刷新其会话列表内容（不重建 popover 容器） */
  function _refreshPopoverIfOpen() {
    if (!_popoverEl || !_hoverIdentity) return;
    const data = _sessionDataCache[_hoverIdentity];
    if (!data) return;

    if (_hoverIdentity === 'work-group:admin') {
      // 管理员：刷新历史列表（活跃按钮不变）
      const adminResult = _renderAdminSessionList(data);
      const listContainer = _popoverEl.querySelector('.wg-pop-list');
      if (listContainer) {
        listContainer.innerHTML = adminResult.historyHtml;
      }
    } else {
      const listContainer = _popoverEl.querySelector('.wg-pop-list');
      if (!listContainer) return;
      listContainer.innerHTML = _renderPopoverSessionList(_hoverIdentity, data);
    }
  }

  function scrollToBottom() {
    const scroll = document.querySelector('.wg-msg-scroll');
    if (scroll) {
      _suppressScrollEvent = true;
      scroll.scrollTop = scroll.scrollHeight;
      _suppressScrollEvent = false;
    }
  }

  // ── 轮询 ────────────────────────────────────────────────────

  /**
   * 拉取群聊成员的运行时状态（running / idle / offline）。
   * 与主轮询同步执行，更新 _runtimeStatusCache 后刷新态势层。
   */
  async function fetchRuntimeStatus() {
    if (!activeChatId) return;
    try {
      const data = await apiGet(
        `/protoclaw/gc/runtime_status?chatId=${encodeURIComponent(activeChatId)}`
      );
      const map = {};
      for (const s of (data.sessions || [])) {
        map[s.sessionId] = s;
      }
      _runtimeStatusCache = map;
    } catch (err) {
      // 静默失败，不阻断轮询
    }
  }

  function startPolling() {
    stopPolling();
    pollTimer = setInterval(async () => {
      if (activeChatId && !isLoading) {
        await loadActiveChat();
        await fetchRuntimeStatus();
        refreshMessagesOnly();
        refreshAdminBarOnly();
      }
    }, 3000);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  // ── 输入缓存 save/load ────────────────────────────────────────

  function _saveCurrentDraft(chatId) {
    if (!chatId) return;
    const editor = document.querySelector('.wg-input-editor');
    const html = editor ? editor.innerHTML : '';
    _chatInputCache[chatId] = {
      editorHtml: html,
      pendingLinks: pendingLinks.slice(),
      pendingAttachments: pendingAttachments.slice(),
    };
  }

  function _loadDraft(chatId) {
    const cached = _chatInputCache[chatId];
    if (cached) {
      pendingLinks = cached.pendingLinks.slice();
      pendingAttachments = cached.pendingAttachments.slice();
    } else {
      pendingLinks = [];
      pendingAttachments = [];
    }
  }

  function _restoreEditorFromDraft(chatId) {
    const cached = _chatInputCache[chatId];
    const editor = document.querySelector('.wg-input-editor');
    if (!editor) return;
    if (cached && cached.editorHtml) {
      editor.innerHTML = cached.editorHtml;
    } else {
      editor.innerHTML = '';
    }
  }

  // ── 事件处理 ────────────────────────────────────────────────

  async function selectChat(chatId) {
    // 保存当前群聊的输入草稿
    if (activeChatId) _saveCurrentDraft(activeChatId);

    activeChatId = chatId;
    viewMode = 'chat';
    activeChat = null;
    openDropdown = null;
    _adminStatus = null;
    _adminRestarting = false;
    // 清除跨群聊缓存，防止上一个群的会话数据泄漏到新群
    _runtimeStatusCache = {};
    _sessionDataCache = {};
    hideMemberPopover(true);
    closeImportModal();
    closeAddMemberModal();
    _shouldScrollToBottom = true;
    refreshChatList();

    // 加载目标群聊的草稿
    _loadDraft(chatId);

    refreshMain();
    await loadActiveChat();
    await fetchRuntimeStatus();
    _shouldScrollToBottom = true;
    refreshMain();
    scrollToBottom();

    // 恢复编辑器内容和附件/链接列表
    _restoreEditorFromDraft(chatId);
    renderAttachmentList();
    renderLinkList();

    // 刷新资料面板（如果正打开着）
    if (typeof activeFeaturePanel !== 'undefined' && activeFeaturePanel === 'resources' && typeof loadResourcesPanelData === 'function') {
      loadResourcesPanelData();
    }
    // 刷新 Settings 面板（如果正打开着）
    if (typeof activeFeaturePanel !== 'undefined' && activeFeaturePanel === 'settings') {
      if (typeof window._wgSettingsInit === 'function') {
        window._wgSettingsInit();
      } else if (typeof window._wgSettingsRefresh === 'function') {
        window._wgSettingsRefresh();
      }
    }
  }

  async function handleAdminRestart() {
    if (!activeChatId || _adminRestarting) return;
    _adminRestarting = true;
    refreshAdminBarOnly();
    try {
      _adminStatus = await apiPost(
        `/protoclaw/group_chats/${encodeURIComponent(activeChatId)}/admin_restart`
      );
    } catch (err) {
      console.error('[WorkGroup] admin restart failed:', err);
    } finally {
      _adminRestarting = false;
      refreshAdminBarOnly();
    }
  }

  // ── 成员 chip hover popover ──────────────────────────────────

  /**
   * 渲染 popover 中的会话列表（群内会话池）。
   * 每个会话显示运行时状态（running/idle/offline）+ 可选的中断按钮。
   * 被 showMemberPopover 和 _refreshPopoverIfOpen 共用。
   */
  function _renderPopoverSessionList(identityRef, data) {
    const workspaceId = identityRef.split(':')[0];
    const isMentioned = getMentionedIdentities().some((m) => m.identityRef === identityRef);
    const sel = activeChatId ? getSessionSelection(activeChatId, identityRef) : { mode: 'default' };

    return (data.inChatSessions || []).map((s) => {
      // 运行时状态（从 _runtimeStatusCache 交叉引用）
      const rt = _runtimeStatusCache[s.id];
      const rtStatus = rt?.status || 'offline';
      const dotClass = rtStatus === 'running' ? 'running'
        : rtStatus === 'idle' ? 'idle'
        : 'offline';
      const dotTitle = rtStatus === 'running' ? '运行中'
        : rtStatus === 'idle' ? '在线 · 空闲'
        : '离线';

      const activeMark = s.isActive ? ' <span class="wg-pop-active">当前</span>' : '';
      // 成员会话一律使用导航跳转（非只读）
      const navAttr = `data-wg-session-nav="${esc(workspaceId)}:${esc(s.id)}"`;

      // 派发至此按钮
      const isSelected = sel.mode === 'specific' && sel.sessionId === s.id;
      const dispatchBtn = (isMentioned && !isSelected)
        ? `<button class="wg-pop-dispatch-to" data-wg-dispatch="specific" data-wg-dispatch-id="${esc(identityRef)}" data-wg-dispatch-sid="${esc(s.id)}" data-wg-dispatch-title="${esc(s.title)}">派发至此</button>`
        : (isSelected ? '<span class="wg-pop-dispatch-cur">已选</span>' : '');

      // 中断按钮（仅 running 状态显示）
      const interruptBtn = rtStatus === 'running'
        ? `<button class="wg-pop-interrupt-btn" data-wg-action="interrupt-session" data-wg-identity="${esc(identityRef)}" data-wg-session-id="${esc(s.id)}" data-wg-workspace-id="${esc(workspaceId)}" title="中断此会话">中断</button>`
        : '';

      return [
        `<div class="wg-pop-session" ${navAttr} title="${s.isActive ? '点击查看会话' : '点击查看会话记录（只读）'}">`,
        `  <span class="wg-pop-dot ${dotClass}" title="${esc(dotTitle)}"></span>`,
        `  <span class="wg-pop-title">${esc(s.title)}${activeMark}</span>`,
        dispatchBtn,
        interruptBtn,
        '</div>',
      ].join('');
    }).join('');
  }

  /**
   * 格式化会话创建时间为 "MM-DD HH:MM"
   */
  function _formatSessionTime(isoStr) {
    if (!isoStr) return '未知时间';
    const d = new Date(isoStr);
    if (isNaN(d.getTime())) return '未知时间';
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${mm}-${dd} ${hh}:${mi}`;
  }

  /**
   * 渲染管理员 popover 内容（活跃会话跳转 + 历史会话记录）。
   * 活跃会话在顶部显示一个跳转按钮，不在历史列表中重复出现。
   * 历史会话以只读方式打开，名称使用创建时间。
   * 返回 { activeHtml, historyHtml, historyCount }
   */
  function _renderAdminSessionList(data) {
    const workspaceId = 'work-group';
    const sessions = data.inChatSessions || [];
    const active = sessions.find((s) => s.isActive);
    const history = sessions.filter((s) => !s.isActive);

    // 活跃会话跳转按钮（accent 色风格）
    let activeHtml = '';
    if (active) {
      activeHtml = [
        `<div class="wg-pop-admin-active">`,
        `  <button class="wg-pop-admin-jump" data-wg-session-nav="${esc(workspaceId)}:${esc(active.id)}">`,
        `    <span>跳转到当前会话</span>`,
        `  </button>`,
        `</div>`,
      ].join('');
    }

    // 历史会话记录（只读，用创建时间命名）
    const historyHtml = history.map((s) => {
      return [
        `<div class="wg-pop-session" data-wg-session-record="${esc(workspaceId)}:${esc(s.id)}" title="点击查看会话记录（只读）">`,
        `  <span class="wg-pop-dot offline"></span>`,
        `  <span class="wg-pop-title">${esc(_formatSessionTime(s.createdAt))}</span>`,
        '</div>',
      ].join('');
    }).join('');

    return { activeHtml, historyHtml, historyCount: history.length };
  }

  async function showMemberPopover(identityRef, anchorEl) {
    if (!anchorEl) return;
    clearTimeout(_popoverHideTimer);

    // 每次重新拉取会话数据（不依赖缓存），确保新建会话立即可见
    await fetchSessionData(identityRef);

    hideMemberPopover(true);

    const data = _sessionDataCache[identityRef];
    if (!data) return;

    const displayName = getIdentityName(identityRef);
    const modelLabel = data.sessionModel === 'persistent' ? '持久' : '一次性';

    // 检查该成员是否已被 @mention（决定是否显示派发选项）
    const isMentioned = getMentionedIdentities().some((m) => m.identityRef === identityRef);
    const sel = activeChatId ? getSessionSelection(activeChatId, identityRef) : { mode: 'default' };

    // 派发设置区（仅 mentioned 时显示）
    let dispatchSection = '';
    if (isMentioned) {
      const isDefault = sel.mode === 'default';
      const isNew = sel.mode === 'new';
      dispatchSection = [
        '<div class="wg-pop-dispatch">',
        '  <div class="wg-pop-dispatch-label">派发设置</div>',
        '  <div class="wg-pop-dispatch-opts">',
        `    <button class="wg-pop-dispatch-opt${isDefault ? ' selected' : ''}" data-wg-dispatch="default" data-wg-dispatch-id="${esc(identityRef)}">接续最近</button>`,
        `    <button class="wg-pop-dispatch-opt${isNew ? ' selected' : ''}" data-wg-dispatch="new" data-wg-dispatch-id="${esc(identityRef)}">新建</button>`,
        '  </div>',
        '</div>',
      ].join('');
    }

    // 群内会话 — 管理员显示活跃会话跳转 + 只读历史会话，成员显示运行时状态 + 导航 + 派发选项
    const isAdmin = identityRef === 'work-group:admin';
    let sessionSectionHtml = '';
    if (isAdmin) {
      const adminResult = _renderAdminSessionList(data);
      const parts = [];
      if (adminResult.activeHtml) parts.push(adminResult.activeHtml);
      if (adminResult.historyHtml) {
        parts.push(`<div class="wg-pop-section-label">历史会话记录 (${adminResult.historyCount})</div><div class="wg-pop-list">${adminResult.historyHtml}</div>`);
      }
      sessionSectionHtml = parts.length > 0
        ? parts.join('')
        : '<div class="wg-pop-empty">暂无历史会话</div>';
    } else {
      const poolItems = _renderPopoverSessionList(identityRef, data);
      sessionSectionHtml = poolItems
        ? `<div class="wg-pop-section-label">群内会话 (${(data.inChatSessions || []).length})</div><div class="wg-pop-list">${poolItems}</div>`
        : '<div class="wg-pop-empty">暂无活跃会话</div>';
    }

    const el = document.createElement('div');
    // 管理员：在 header 追加在线状态
    let statusBadge = '';
    if (identityRef === 'work-group:admin') {
      const st = _adminStatus;
      const restarting = _adminRestarting;
      let label = '离线';
      let cls = 'offline';
      if (restarting) { label = '创建中'; cls = 'switching'; }
      else if (st?.online) { label = '在线'; cls = 'online'; }
      statusBadge = `<span class="wg-pop-status ${cls}">${esc(label)}</span>`;
    }

    // 引入外部会话区（非管理员）— 右侧子面板
    let importToggle = '';
    let importPanel = '';
    if (identityRef !== 'work-group:admin') {
      const extCount = (data.externalSessions || []).length;
      importToggle = [
        '<div class="wg-pop-import-toggle" data-wg-pop-import-toggle>',
        `  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`,
        `  <span>引入外部会话</span>`,
        extCount > 0 ? `  <span class="wg-pop-import-count">${extCount}</span>` : '',
        '</div>',
      ].join('');

      const wsId = identityRef.split(':')[0];
      const ext = (data.externalSessions || []).slice(0, 10);
      const extItems = ext.length === 0
        ? '<div class="wg-pop-empty">无可引入的会话</div>'
        : ext.map((s) => [
            `<div class="wg-pop-side-item" data-wg-pop-import-do data-workspace-id="${esc(wsId)}" data-session-id="${esc(s.id)}" title="${esc(s.title)}">`,
            `  <span class="wg-pop-side-dot"></span>`,
            `  <span class="wg-pop-side-title">${esc(s.title)}</span>`,
            '</div>',
          ].join('')).join('');

      importPanel = [
        '<div class="wg-pop-side" data-wg-pop-side style="display:none">',
        '  <div class="wg-pop-side-header">引入会话</div>',
        `  <div class="wg-pop-side-list">${extItems}</div>`,
        '</div>',
      ].join('');
    }

    el.className = 'wg-member-popover';
    el.innerHTML = [
      '<div class="wg-pop-main">',
      `<div class="wg-pop-header">`,
      `  <span class="wg-pop-name">${esc(displayName)}</span>`,
      statusBadge ? `  ${statusBadge}` : `  <span class="wg-pop-model">${esc(modelLabel)}</span>`,
      '</div>',
      dispatchSection,
      sessionSectionHtml,
      importToggle,
      '</div>',
      importPanel,
    ].join('');
    document.body.appendChild(el);
    _popoverEl = el;

    // 定位
    const rect = anchorEl.getBoundingClientRect();
    el.style.left = `${rect.left}px`;
    el.style.top = `${rect.bottom + 4}px`;

    // hover popover 自身不触发隐藏
    el.addEventListener('mouseenter', () => clearTimeout(_popoverHideTimer));
    el.addEventListener('mouseleave', () => {
      _popoverHideTimer = setTimeout(() => hideMemberPopover(), 80);
    });
    // popover 内的会话导航和派发选择
    el.addEventListener('click', async (ev) => {
      // 派发选项按钮
      const dispatchBtn = ev.target.closest('[data-wg-dispatch]');
      if (dispatchBtn) {
        ev.stopPropagation();
        const mode = dispatchBtn.dataset.wgDispatch;
        const identityRef = dispatchBtn.dataset.wgDispatchId;
        if (mode === 'default') {
          handleSessionOption(identityRef, 'default');
        } else if (mode === 'new') {
          handleSessionOption(identityRef, 'new');
        } else if (mode === 'specific') {
          handleSessionOption(identityRef, 'specific', dispatchBtn.dataset.wgDispatchSid, dispatchBtn.dataset.wgDispatchTitle);
        }
        // 刷新 popover 以更新选中状态
        if (_hoverIdentity) {
          const chip = document.querySelector(`[data-wg-member-identity="${CSS.escape(identityRef)}"]`);
          if (chip) showMemberPopover(identityRef, chip);
        }
        return;
      }

      // 中断按钮
      const interruptBtn = ev.target.closest('[data-wg-action="interrupt-session"]');
      if (interruptBtn) {
        ev.stopPropagation();
        interruptBtn.disabled = true;
        interruptBtn.textContent = '...';
        handleInterruptSession(
          interruptBtn.dataset.wgIdentity,
          interruptBtn.dataset.wgSessionId,
          interruptBtn.dataset.wgWorkspaceId
        ).finally(() => {
          // 刷新 popover 内容（中断后状态会变化）
          _refreshPopoverIfOpen();
        });
        return;
      }

      const navItem = ev.target.closest('[data-wg-session-nav]');
      if (navItem) {
        navigateToSession(navItem.dataset.wgSessionNav);
        hideMemberPopover(true);
        return;
      }
      const recordItem = ev.target.closest('[data-wg-session-record]');
      if (recordItem) {
        const [workspaceId, sessionId] = recordItem.dataset.wgSessionRecord.split(':');
        navigateToSessionRecord(workspaceId, sessionId);
        hideMemberPopover(true);
      }

      // 引入外部会话 toggle — 展开/收起右侧子面板
      const importToggleBtn = ev.target.closest('[data-wg-pop-import-toggle]');
      if (importToggleBtn) {
        ev.stopPropagation();
        const sideEl = el.querySelector('[data-wg-pop-side]');
        if (sideEl) {
          const isOpen = sideEl.style.display !== 'none';
          if (isOpen) {
            sideEl.style.display = 'none';
            importToggleBtn.classList.remove('open');
          } else {
            sideEl.style.display = 'flex';
            importToggleBtn.classList.add('open');
          }
        }
        return;
      }

      // 引入操作 — 直接选中导入
      const importDo = ev.target.closest('[data-wg-pop-import-do]');
      if (importDo) {
        ev.stopPropagation();
        const { workspaceId, sessionId } = importDo.dataset;
        importDo.classList.add('imported');
        try {
          await doImportSession(workspaceId, sessionId);
          // 刷新缓存 + 关闭 popover
          delete _sessionDataCache[identityRef];
          hideMemberPopover(true);
          refreshAdminBarOnly();
        } catch {
          importDo.classList.remove('imported');
        }
        return;
      }
    });
  }

  function hideMemberPopover(immediate) {
    if (immediate) {
      if (_popoverEl) { _popoverEl.remove(); _popoverEl = null; }
      return;
    }
    _popoverHideTimer = setTimeout(() => {
      if (_popoverEl) { _popoverEl.remove(); _popoverEl = null; }
    }, 80);
  }

  function onContainerMouseOver(e) {
    const chip = e.target.closest('[data-wg-member-identity]');
    if (chip) {
      const identityRef = chip.dataset.wgMemberIdentity;
      clearTimeout(_popoverHideTimer);
      if (_hoverIdentity !== identityRef) {
        _hoverIdentity = identityRef;
        clearTimeout(_hoverTimer);
        _hoverTimer = setTimeout(() => showMemberPopover(identityRef, chip), 120);
      }
    }
  }

  function onContainerMouseOut(e) {
    const chip = e.target.closest('[data-wg-member-identity]');
    if (chip) {
      const related = e.relatedTarget;
      // 如果移到了 popover 自身或另一个 member chip，不隐藏
      if (related && (related.closest('.wg-member-popover') || related.closest('[data-wg-member-identity]'))) {
        return;
      }
      clearTimeout(_hoverTimer);
      _hoverIdentity = null;
      hideMemberPopover();
    }
  }

  async function handleSend() {
    // 如果正在录音，停止录音并设置自动发送标志
    if (_voiceRecording) {
      _voicePendingSend = true;
      stopVoiceRecording();
      return;
    }

    // 如果正在转写，忽略发送请求
    if (_voiceTranscribing) return;

    const editor = document.querySelector('.wg-input-editor');
    if (!editor) return;
    const text = editor.textContent.trim();
    if (!text || !activeChatId) return;

    // 解析 @mentions（带 session 选择）
    const mentions = [];
    const chatSel = _chatSessionSelection[activeChatId] || {};
    for (const id of getMentionableIdentities()) {
      const atName = `@${id.displayName}`;
      if (text.includes(atName)) {
        const sel = chatSel[id.identityRef] || { mode: 'default' };
        const m = { identityRef: id.identityRef };
        if (sel.mode === 'specific' && sel.sessionId) {
          m.targetSessionId = sel.sessionId;
        } else if (sel.mode === 'new') {
          m.forceNew = true;
        }
        mentions.push(m);
      }
    }

    editor.textContent = '';
    editor.focus();
    // 清空当前群聊的草稿缓存
    delete _chatInputCache[activeChatId];
    // 清空 session 选择状态（下次 @mention 重新选择）
    _openSessionDropdown = null;

    const links = pendingLinks.slice();
    pendingLinks = [];
    renderLinkList();

    const attachments = pendingAttachments.slice();
    pendingAttachments = [];
    renderAttachmentList();

    try {
      await apiPost(`/protoclaw/group_chats/${encodeURIComponent(activeChatId)}/messages`, {
        text,
        mentions,
        links: links.length > 0 ? links : undefined,
        attachments: attachments.length > 0 ? attachments : undefined,
      });
      await loadActiveChat();
      refreshHeaderAndMessages();
      scrollToBottom();
      await loadChatSummaries();
      refreshChatList();
    } catch (err) {
      console.error('[WorkGroup] send failed:', err);
      editor.textContent = text;
    }
  }

  function toggleMentionPicker() {
    const picker = document.querySelector('[data-wg-role="mention-picker"]');
    if (!picker) return;
    if (picker.style.display !== 'none') {
      hideMentionPicker();
    } else {
      showMentionLevel1();
    }
  }

  function hideMentionPicker() {
    const picker = document.querySelector('[data-wg-role="mention-picker"]');
    if (picker) picker.style.display = 'none';
    _mentionTarget = null;
  }

  function showMentionLevel1() {
    const picker = document.querySelector('[data-wg-role="mention-picker"]');
    if (!picker) return;

    const mentionable = getMentionableIdentities();
    if (mentionable.length === 0) return;

    const items = mentionable.map((id) => {
      const isAdmin = id.identityRef === 'work-group:admin';
      const hasArrow = !isAdmin;
      return [
        `<div class="wg-mention-item" data-wg-mention="${esc(id.identityRef)}">`,
        `  <span class="wg-mention-dot${isAdmin ? ' admin' : ''}"></span>`,
        `  <span class="wg-mention-name">${esc(id.displayName)}</span>`,
        hasArrow ? `  <svg class="wg-mention-arrow" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>` : '',
        '</div>',
      ].join('');
    }).join('');

    picker.innerHTML = `<div class="wg-mention-level1">${items}</div>`;
    picker.style.display = 'block';
    _mentionTarget = null;
  }

  function showMentionLevel2(identityRef) {
    const picker = document.querySelector('[data-wg-role="mention-picker"]');
    if (!picker) return;
    const id = identities.find((i) => i.identityRef === identityRef);
    if (!id) return;

    // 懒加载 session 数据
    if (!_sessionDataCache[identityRef] && activeChatId) {
      fetchSessionData(identityRef).then(() => showMentionLevel2(identityRef));
      picker.innerHTML = '<div class="wg-mention-loading">加载中...</div>';
      picker.style.display = 'block';
      return;
    }

    const data = _sessionDataCache[identityRef];
    const sel = activeChatId ? getSessionSelection(activeChatId, identityRef) : { mode: 'default' };
    const poolSessions = (data?.inChatSessions || []).slice(0, 6);

    const sessionItems = poolSessions.map((s) => {
      const selected = sel.mode === 'specific' && sel.sessionId === s.id;
      return [
        `<div class="wg-mention-session-item${selected ? ' selected' : ''}" data-wg-mention-session="${esc(s.id)}" data-wg-mention-title="${esc(s.title)}">`,
        `  <span class="wg-mention-session-dot${s.isActive ? ' active' : ''}"></span>`,
        `  <span class="wg-mention-session-title">${esc(s.title)}</span>`,
        '</div>',
      ].join('');
    }).join('');

    const modeItems = [
      `<button class="wg-mention-action${sel.mode === 'default' ? ' active' : ''}" data-wg-mention-session="__default__">接续最近</button>`,
      `<button class="wg-mention-action${sel.mode === 'new' ? ' active' : ''}" data-wg-mention-session="__new__">新建</button>`,
    ].join('');

    picker.innerHTML = [
      '<div class="wg-mention-header" data-wg-mention-back>',
      '  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>',
      `  <span>${esc(id.displayName)}</span>`,
      '</div>',
      `<div class="wg-mention-actions">${modeItems}</div>`,
      sessionItems
        ? `<div class="wg-mention-section"><div class="wg-mention-section-label">会话池</div>${sessionItems}</div>`
        : '',
    ].join('');
    picker.style.display = 'block';
    _mentionTarget = identityRef;
  }

  function _doInsertMention(displayName) {
    const editor = document.querySelector('.wg-input-editor');
    if (!editor) return;
    editor.focus();
    // 如果编辑器末尾已经有 @（由用户键入触发），先删除它再插入完整 mention
    const text = editor.textContent || '';
    if (text.endsWith('@')) {
      // 删除最后一个 @ 字符
      const sel = window.getSelection();
      const range = document.createRange();
      editor.focus();
      // 选中末尾的 @
      const lastNode = editor.lastChild;
      if (lastNode && lastNode.nodeType === Node.TEXT_NODE) {
        const nodeText = lastNode.textContent;
        range.setStart(lastNode, nodeText.length - 1);
        range.setEnd(lastNode, nodeText.length);
        sel.removeAllRanges();
        sel.addRange(range);
        document.execCommand('insertText', false, `@${displayName} `);
      } else {
        // fallback：直接整体替换
        editor.textContent = text.slice(0, -1) + `@${displayName} `;
      }
    } else {
      document.execCommand('insertText', false, `@${displayName} `);
    }
  }

  function insertMention(identityRef) {
    const id = identities.find((i) => i.identityRef === identityRef);
    if (!id) return;
    _doInsertMention(id.displayName);
    hideMentionPicker();
    if (!_sessionDataCache[identityRef]) {
      fetchSessionData(identityRef);
    }
    renderSessionBar();
  }

  function insertMentionWithSession(identityRef, mode, sessionId, sessionTitle) {
    const id = identities.find((i) => i.identityRef === identityRef);
    if (!id) return;
    _doInsertMention(id.displayName);

    if (activeChatId) {
      if (mode === 'new') {
        setSessionSelection(activeChatId, identityRef, { mode: 'new' });
      } else if (mode === 'specific') {
        setSessionSelection(activeChatId, identityRef, { mode: 'specific', sessionId, sessionTitle });
      } else {
        setSessionSelection(activeChatId, identityRef, { mode: 'default' });
      }
    }

    hideMentionPicker();
    renderSessionBar();
  }

  // ── Session Bar ─────────────────────────────────────────────

  function getMentionedIdentities() {
    const editor = document.querySelector('.wg-input-editor');
    if (!editor) return [];
    const text = editor.textContent || '';
    return getMentionableIdentities().filter((id) => text.includes(`@${id.displayName}`));
  }

  function getMentionableIdentities() {
    const memberRefs = getChatMemberRefs(activeChat);
    return identities.filter((id) => memberRefs.has(id.identityRef) && id.identityRef !== 'user');
  }

  function getSessionSelection(chatId, identityRef) {
    if (!_chatSessionSelection[chatId]) _chatSessionSelection[chatId] = {};
    return _chatSessionSelection[chatId][identityRef] || { mode: 'default' };
  }

  function setSessionSelection(chatId, identityRef, selection) {
    if (!_chatSessionSelection[chatId]) _chatSessionSelection[chatId] = {};
    _chatSessionSelection[chatId][identityRef] = selection;
  }

  function renderSessionBar() {
    const bar = document.querySelector('[data-wg-role="session-bar"]');
    if (!bar || !activeChatId) { if (bar) bar.innerHTML = ''; return; }

    const mentioned = getMentionedIdentities();
    if (mentioned.length === 0) { bar.innerHTML = ''; return; }

    // 只读指示器：显示每个被提及成员的当前派发路由
    // 交互式选择已移至 member popover（hover → 派发设置）
    const pills = mentioned.map((id) => {
      const sel = getSessionSelection(activeChatId, id.identityRef);
      let label = '接续最近';
      let modeClass = 'default';
      if (sel.mode === 'new') { label = '新建'; modeClass = 'new'; }
      else if (sel.mode === 'specific') { label = sel.sessionTitle || '指定会话'; modeClass = 'specific'; }
      return [
        `<div class="wg-session-pill-readonly ${modeClass}">`,
        `  <span class="wg-session-pill-name">${esc(id.displayName)}</span>`,
        `  <span class="wg-session-pill-sep"></span>`,
        `  <span class="wg-session-pill-label">${esc(label)}</span>`,
        '</div>',
      ].join('');
    }).join('');

    bar.innerHTML = `<div class="wg-session-pills-readonly">${pills}</div>`;
  }

  function renderSessionDropdown(identityRef) {
    const cache = _sessionDataCache[identityRef];
    if (!cache) {
      // Loading state — trigger fetch
      fetchSessionData(identityRef);
      return `<div class="wg-session-dropdown"><div class="wg-session-dropdown-loading">加载中...</div></div>`;
    }

    const sel = getSessionSelection(activeChatId, identityRef);
    const items = [];

    // Default option
    items.push([
      `<div class="wg-session-option${sel.mode === 'default' ? ' selected' : ''}" data-wg-session-opt="default" data-wg-identity="${esc(identityRef)}">`,
      `  <span class="wg-session-opt-title">接续最近会话</span>`,
      `  <span class="wg-session-opt-desc">自动复用群内最近会话</span>`,
      `</div>`,
    ].join(''));

    // New session option
    items.push([
      `<div class="wg-session-option${sel.mode === 'new' ? ' selected' : ''}" data-wg-session-opt="new" data-wg-identity="${esc(identityRef)}">`,
      `  <span class="wg-session-opt-title">新建会话</span>`,
      `  <span class="wg-session-opt-desc">在全新会话中执行</span>`,
      `</div>`,
    ].join(''));

    // Group sessions
    if (cache.pool && cache.pool.length > 0) {
      items.push('<div class="wg-session-opt-group">群内会话</div>');
      for (const s of cache.pool) {
        const isSel = sel.mode === 'specific' && sel.sessionId === s.id;
        const mark = s.isActive ? ' [当前]' : '';
        items.push([
          `<div class="wg-session-option${isSel ? ' selected' : ''}" data-wg-session-opt="specific" data-wg-identity="${esc(identityRef)}" data-wg-session-id="${esc(s.id)}" data-wg-session-title="${esc(s.title)}">`,
          `  <span class="wg-session-opt-title">${esc(s.title)}${mark}</span>`,
          `</div>`,
        ].join(''));
      }
    }

    return `<div class="wg-session-dropdown">${items.join('')}</div>`;
  }

  async function fetchSessionData(identityRef) {
    if (!activeChatId) return;
    try {
      const data = await apiGet(
        `/protoclaw/group_chats/${encodeURIComponent(activeChatId)}/sessions/${encodeURIComponent(identityRef)}`
      );
      _sessionDataCache[identityRef] = data;
      // Re-render only the dropdown if still open
      if (_openSessionDropdown === identityRef) {
        renderSessionBar();
      }
    } catch (err) {
      console.error('[WorkGroup] fetchSessionData failed:', err);
      // 即使失败也缓存空结构，确保 popover 能显示"无会话"状态
      _sessionDataCache[identityRef] = {
        inChatSessions: [],
        externalSessions: [],
        sessionModel: 'persistent',
      };
    }
  }

  function toggleSessionDropdown(identityRef) {
    if (_openSessionDropdown === identityRef) {
      _openSessionDropdown = null;
    } else {
      _openSessionDropdown = identityRef;
      // Pre-fetch if not cached
      if (!_sessionDataCache[identityRef]) {
        fetchSessionData(identityRef);
      }
    }
    renderSessionBar();
  }

  function handleSessionOption(identityRef, mode, sessionId, sessionTitle) {
    if (mode === 'default') {
      setSessionSelection(activeChatId, identityRef, { mode: 'default' });
    } else if (mode === 'new') {
      setSessionSelection(activeChatId, identityRef, { mode: 'new' });
    } else if (mode === 'specific') {
      setSessionSelection(activeChatId, identityRef, { mode: 'specific', sessionId, sessionTitle });
    }
    _openSessionDropdown = null;
    renderSessionBar();
  }

  function toggleLinksArea() {
    const area = document.querySelector('[data-wg-role="links-area"]');
    if (area) area.style.display = area.style.display === 'none' ? 'flex' : 'none';
  }

  function addLink() {
    const urlEl = document.querySelector('[data-wg-role="link-url"]');
    const descEl = document.querySelector('[data-wg-role="link-desc"]');
    const url = (urlEl?.value || '').trim();
    if (!url) return;
    const desc = (descEl?.value || '').trim();
    pendingLinks.push({ url, description: desc || undefined });
    if (urlEl) urlEl.value = '';
    if (descEl) descEl.value = '';
    renderLinkList();
  }

  function renderLinkList() {
    const list = document.querySelector('[data-wg-role="link-list"]');
    if (!list) return;
    if (pendingLinks.length === 0) { list.innerHTML = ''; return; }
    list.innerHTML = pendingLinks.map((l, i) => {
      return `<div class="wg-link-chip"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg><span class="wg-link-chip-text">${esc(l.description || l.url)}</span><button class="wg-chip-remove" data-wg-action="remove-link" data-wg-link-index="${i}"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18"/><path d="M6 6l12 12"/></svg></button></div>`;
    }).join('');
  }

  function renderAttachmentList() {
    const list = document.querySelector('[data-wg-role="attachment-list"]');
    if (!list) return;
    if (pendingAttachments.length === 0) {
      list.innerHTML = '';
      list.style.display = 'none';
      return;
    }
    list.style.display = 'flex';
    list.innerHTML = pendingAttachments.map((a, i) => {
      const displayName = a.name.length > 28 ? a.name.slice(0, 26) + '...' : a.name;
      const ext = (a.name.split('.').pop() || '').toUpperCase().slice(0, 4);
      return `<div class="wg-attachment-chip" title="${esc(a.name)}"><span class="wg-attachment-chip-ext">${esc(ext)}</span><span class="wg-attachment-chip-name">${esc(displayName)}</span><button class="wg-chip-remove" data-wg-action="remove-attachment" data-wg-attachment-index="${i}"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18"/><path d="M6 6l12 12"/></svg></button></div>`;
    }).join('');
  }

  function toggleDropdown(type) {
    openDropdown = openDropdown === type ? null : type;
    refreshHeaderAndMessages();
  }

  async function handleModeChange(type, value) {
    if (!activeChatId) return;
    openDropdown = null;

    const field = type === 'initiative' ? 'initiativeMode' : 'autonomyMode';
    try {
      const updated = await apiPut(`/protoclaw/group_chats/${encodeURIComponent(activeChatId)}`, {
        [field]: value,
      });
      activeChat = updated;
      await loadChatSummaries();
      refreshChatList();
      refreshHeaderAndMessages();
    } catch (err) {
      console.error('[WorkGroup] mode change failed:', err);
    }
  }

  async function navigateToSession(target) {
    const [workspaceId, sessionId] = target.split(':');
    if (!workspaceId || !window.handlePrebuiltAgentClick) return;
    try {
      // Step 1: navigate to the target workspace
      await window.handlePrebuiltAgentClick(workspaceId);
      // Step 2: activate the specific session
      if (sessionId && window.runWorkspaceAction) {
        await window.runWorkspaceAction(JSON.stringify({ type: 'open_session', sessionId }));
      }
    } catch (err) {
      console.error('[WorkGroup] navigateToSession failed:', err);
    }
  }

  async function navigateToSessionRecord(workspaceId, sessionId) {
    if (!workspaceId || !window.handlePrebuiltAgentClick) return;
    try {
      await window.handlePrebuiltAgentClick(workspaceId);
      if (window.runWorkspaceAction) {
        await window.runWorkspaceAction(JSON.stringify({
          type: 'view_session_record',
          agentId: workspaceId,
          sessionId,
        }));
      }
    } catch (err) {
      console.error('[WorkGroup] navigateToSessionRecord failed:', err);
    }
  }

  async function handleSettingsFieldChange(field, value) {
    if (!activeChatId) return;
    try {
      const body = {};
      if (field === 'name') body.name = value;
      else if (field === 'initiativeMode') body.initiativeMode = value;
      else if (field === 'autonomyMode') body.autonomyMode = value;
      else if (field === 'memoryRange' || field === 'memoryLimitMode' || field === 'memoryTokenLimit' || field === 'memoryRatioLimit') {
        // 合并当前 adminMemory 设置后整体提交
        const cur = activeChat?.adminMemory || { range: '3d', limitMode: 'tokens', tokenLimit: 100000, ratioLimit: 80 };
        const merged = { ...cur };
        if (field === 'memoryRange') merged.range = value;
        else if (field === 'memoryLimitMode') merged.limitMode = value;
        else if (field === 'memoryTokenLimit') merged.tokenLimit = parseInt(value) || 100000;
        else if (field === 'memoryRatioLimit') merged.ratioLimit = parseInt(value) || 80;
        body.adminMemory = merged;
      }
      else if (field === 'admin-model') {
        await saveAdminModel(value);
        return;
      }

      if (Object.keys(body).length > 0) {
        activeChat = await apiPut(`/protoclaw/group_chats/${encodeURIComponent(activeChatId)}`, body);
        await loadChatSummaries();
        refreshChatList();
      }
    } catch (err) {
      console.error('[WorkGroup] settings save failed:', err);
    }
  }

  async function loadGroupMd() {
    const chatId = activeChatId;
    if (!chatId) return;
    groupMdLoading = true;
    groupMdChatId = chatId;
    groupMdContent = '';
    if (typeof window._wgSettingsRefresh === 'function') window._wgSettingsRefresh();
    try {
      const data = await apiGet(`/protoclaw/group_chats/${encodeURIComponent(chatId)}/group_md`);
      if (activeChatId !== chatId) return;
      groupMdContent = data.content || '';
    } catch (err) {
      if (activeChatId !== chatId) return;
      console.error('[WorkGroup] load GROUP.md failed:', err);
      groupMdContent = '';
    } finally {
      if (activeChatId === chatId) {
        groupMdLoading = false;
        if (typeof window._wgSettingsRefresh === 'function') window._wgSettingsRefresh();
      }
    }
  }

  async function saveGroupMd(chatId = activeChatId) {
    if (!chatId) return;
    const editor = document.querySelector('[data-wg-role="group-md-editor"]');
    if (!editor) return;
    const content = editor.value;
    try {
      await apiPut(`/protoclaw/group_chats/${encodeURIComponent(chatId)}/group_md`, { content });
      if (activeChatId === chatId) {
        groupMdContent = content;
        groupMdChatId = chatId;
      }
      _setMdSaveStatus('已保存');
    } catch (err) {
      console.error('[WorkGroup] save GROUP.md failed:', err);
      _setMdSaveStatus('保存失败');
    }
  }

  let _mdAutoSaveTimer = null;
  let _mdAutoSaveChatId = null;
  function _wgMdAutoSave() {
    _setMdSaveStatus('保存中…');
    if (_mdAutoSaveTimer) clearTimeout(_mdAutoSaveTimer);
    _mdAutoSaveChatId = activeChatId;
    _mdAutoSaveTimer = setTimeout(() => {
      _mdAutoSaveTimer = null;
      saveGroupMd(_mdAutoSaveChatId);
    }, 800);
  }

  async function _flushGroupMdAutoSave() {
    if (!_mdAutoSaveTimer) return;
    clearTimeout(_mdAutoSaveTimer);
    _mdAutoSaveTimer = null;
    await saveGroupMd(_mdAutoSaveChatId || activeChatId);
  }

  function _setMdSaveStatus(text) {
    const el = document.querySelector('[data-wg-role="md-save-status"]');
    if (el) {
      el.textContent = text;
      el.classList.toggle('error', text === '保存失败');
      el.classList.toggle('saved', text === '已保存');
    }
  }

  async function changeWorkDir() {
    if (!activeChatId) return;
    try {
      const result = await invoke('select_directory');
      if (!result || result.cancelled || !result.path) return;
      activeChat = await apiPut(`/protoclaw/group_chats/${encodeURIComponent(activeChatId)}`, {
        workDir: result.path,
      });
      await loadChatSummaries();
      refreshChatList();
      refreshMain();
      // 刷新 settings 面板（工作目录已变更）
      if (typeof window._wgSettingsRefresh === 'function') window._wgSettingsRefresh();
    } catch (err) {
      console.error('[WorkGroup] change workDir failed:', err);
    }
  }

  async function loadAdminModelOptions() {
    adminModelState = { ...adminModelState, loading: true, error: null };
    if (typeof window._wgSettingsRefresh === 'function') window._wgSettingsRefresh();
    try {
      const [configRes, presetRes] = await Promise.all([
        apiGet('/protoclaw/model_config'),
        apiGet('/protoclaw/agent_model_presets?agentId=work-group'),
      ]);
      const presets = Array.isArray(configRes.presets) ? configRes.presets : [];
      const current = presetRes.modelPresets?.default || '';
      adminModelState = {
        loading: false,
        loaded: true,
        presets,
        current,
        error: null,
      };
    } catch (err) {
      console.error('[WorkGroup] load admin model options failed:', err);
      adminModelState = {
        ...adminModelState,
        loading: false,
        loaded: true,
        error: err,
      };
    }
    if (typeof window._wgSettingsRefresh === 'function') window._wgSettingsRefresh();
  }

  async function saveAdminModel(presetName) {
    try {
      const res = await fetch('/protoclaw/agent_model_presets', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: 'work-group', modelPresets: { default: presetName || null } }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      adminModelState = { ...adminModelState, current: presetName || '', error: null };
    } catch (err) {
      console.error('[WorkGroup] save admin model failed:', err);
      adminModelState = { ...adminModelState, error: err };
    }
  }

  function openFilesPanel() {
    if (typeof activeFeaturePanel !== 'undefined') {
      activeFeaturePanel = 'resources';
      if (typeof renderFeaturePanel === 'function') renderFeaturePanel();
    }
    if (typeof loadResourcesPanelData === 'function') {
      loadResourcesPanelData();
    }
  }

  function toggleAdminConfig() {
    _settingsAdminCollapsed = !_settingsAdminCollapsed;
    if (typeof window._wgSettingsRefresh === 'function') window._wgSettingsRefresh();
  }

  function editGroupMd() {
    // 写入共享文档状态 + 切换到 viewer panel
    const chatId = activeChatId;
    if (!chatId) return;
    if (typeof window._viewerOpen === 'function') {
      window._viewerOpen('GROUP.md', chatId, true);
    }
  }

  async function updateGroupMembers(nextMembers) {
    if (!activeChatId) return;
    activeChat = await apiPut(`/protoclaw/group_chats/${encodeURIComponent(activeChatId)}`, {
      members: normalizeGroupMembers(nextMembers),
    });
    await loadChatSummaries();
    refreshChatList();
    refreshAdminBarOnly();
    if (typeof window._wgSettingsRefresh === 'function') window._wgSettingsRefresh();
  }

  async function addGroupMember(identityRef) {
    if (!activeChat || !isManageableGroupIdentity(identityRef)) return;
    const members = normalizeGroupMembers(activeChat.members || []);
    if (members.some((m) => m.identityRef === identityRef)) return;
    try {
      await updateGroupMembers([
        ...members,
        { identityRef, role: 'agent' },
      ]);
    } catch (err) {
      console.error('[WorkGroup] add member failed:', err);
    }
  }

  async function removeGroupMember(identityRef) {
    if (!activeChat || !isManageableGroupIdentity(identityRef)) return;
    const name = getIdentityName(identityRef);
    const confirmed = confirm(`将「${name}」移出此群聊？\n\n已有消息和会话记录会保留，但它不会再出现在本群成员和 @ 选择器中。`);
    if (!confirmed) return;
    const members = normalizeGroupMembers(activeChat.members || []).filter((m) => m.identityRef !== identityRef);
    try {
      await updateGroupMembers(members);
      delete _sessionDataCache[identityRef];
      if (_chatSessionSelection[activeChatId]) delete _chatSessionSelection[activeChatId][identityRef];
    } catch (err) {
      console.error('[WorkGroup] remove member failed:', err);
    }
  }

  function addSelectedMember() {
    const select = document.querySelector('[data-wg-role="add-member-select"]');
    const ref = select?.value;
    if (ref) addGroupMember(ref);
  }

  // ── 添加成员弹窗（overlay，替代旧 <select>） ──────────────────

  function renderAddMemberListItems(candidates, memberRefs, keyword) {
    if (!candidates.length) {
      return keyword
        ? '<div class="wg-settings-empty-note">没有匹配的身份。</div>'
        : '<div class="wg-settings-empty-note">当前没有可拉入群聊的 Agent 身份。</div>';
    }
    return candidates.map((id) => {
      const inGroup = memberRefs.has(id.identityRef);
      const name = id.displayName || id.identityRef;
      const avatar = generateAvatar(name, id.identityRef);
      return [
        `<div class="wg-add-member-item${inGroup ? ' disabled' : ''}" data-wg-identity="${esc(id.identityRef)}">`,
        `  <div class="wg-avatar wg-avatar-sm" style="--av-grad:${avatar.color}">${esc(avatar.initials)}</div>`,
        '  <div class="wg-add-member-item-info">',
        `    <span class="wg-add-member-item-name">${esc(name)}</span>`,
        `    <span class="wg-add-member-item-desc">${esc(id.description || '')}</span>`,
        '  </div>',
        inGroup
          ? '  <span class="wg-add-member-item-tag">已在群中</span>'
          : '  <span class="wg-add-member-item-check">&#10003;</span>',
        '</div>',
      ].join('');
    }).join('');
  }

  function closeAddMemberModal() {
    if (_addMemberModalEl) {
      document.body.removeChild(_addMemberModalEl);
      _addMemberModalEl = null;
    }
    if (_addMemberSearchTimer) {
      clearTimeout(_addMemberSearchTimer);
      _addMemberSearchTimer = null;
    }
  }

  async function openAddMemberModal() {
    if (identities.length === 0) await loadIdentities();

    const memberRefs = getChatMemberRefs(activeChat);
    const candidates = identities.filter((id) => isManageableGroupIdentity(id.identityRef));

    closeAddMemberModal();

    const modal = document.createElement('div');
    modal.className = 'wg-modal-overlay';
    modal.innerHTML = [
      '<div class="wg-modal wg-add-member-modal">',
      '  <div class="wg-modal-title">添加成员</div>',
      '  <input type="text" class="wg-modal-input" data-wg-role="add-member-search" placeholder="搜索身份..." />',
      '  <div class="wg-add-member-list" data-wg-role="add-member-list">',
      renderAddMemberListItems(candidates, memberRefs, ''),
      '  </div>',
      '  <div class="wg-modal-actions">',
      '    <button class="wg-modal-btn" data-wg-action="close-add-member">取消</button>',
      '    <button class="wg-modal-btn confirm" data-wg-action="confirm-add-member">确定</button>',
      '  </div>',
      '</div>',
    ].join('');
    document.body.appendChild(modal);
    _addMemberModalEl = modal;

    // 搜索防抖
    const searchInput = modal.querySelector('[data-wg-role="add-member-search"]');
    searchInput.addEventListener('input', () => {
      clearTimeout(_addMemberSearchTimer);
      const kw = searchInput.value.trim().toLowerCase();
      _addMemberSearchTimer = setTimeout(() => {
        const filtered = kw
          ? candidates.filter((id) =>
            (id.displayName || '').toLowerCase().includes(kw) ||
            (id.description || '').toLowerCase().includes(kw) ||
            (id.identityRef || '').toLowerCase().includes(kw))
          : candidates;
        const listEl = modal.querySelector('[data-wg-role="add-member-list"]');
        if (listEl) listEl.innerHTML = renderAddMemberListItems(filtered, memberRefs, kw);
      }, 200);
    });

    // 点击代理
    modal.addEventListener('click', (e) => {
      if (e.target === modal) { closeAddMemberModal(); return; }

      const closeBtn = e.target.closest('[data-wg-action="close-add-member"]');
      if (closeBtn) { closeAddMemberModal(); return; }

      const confirmBtn = e.target.closest('[data-wg-action="confirm-add-member"]');
      if (confirmBtn) {
        const selected = Array.from(modal.querySelectorAll('.wg-add-member-item.selected'))
          .map((el) => el.dataset.wgIdentity);
        closeAddMemberModal();
        (async () => {
          for (const ref of selected) {
            await addGroupMember(ref);
          }
        })();
        return;
      }

      // 切换选中状态
      const item = e.target.closest('.wg-add-member-item');
      if (item && !item.classList.contains('disabled')) {
        item.classList.toggle('selected');
      }
    });
  }

  async function handleDissolveChat() {
    if (!activeChatId) return;
    const confirmed = confirm(`确定要解散群聊「${activeChat?.name || activeChatId}」吗？\n\n解散后群聊记录将被删除，无法恢复。`);
    if (!confirmed) return;
    try {
      await apiDelete(`/protoclaw/group_chats/${encodeURIComponent(activeChatId)}`);
      activeChatId = null;
      activeChat = null;
      await loadChatSummaries();
      refreshChatList();
      refreshMain();
      // 关闭 settings 面板
      if (typeof activeFeaturePanel !== 'undefined' && activeFeaturePanel === 'settings') {
        activeFeaturePanel = null;
        if (typeof renderFeaturePanel === 'function') renderFeaturePanel();
      }
    } catch (err) {
      console.error('[WorkGroup] dissolve chat failed:', err);
      alert('解散群聊失败');
    }
  }

  async function handleArchiveChat(chatId) {
    const targetId = chatId || activeChatId;
    if (!targetId) return;
    try {
      await apiPut(`/protoclaw/group_chats/${encodeURIComponent(targetId)}`, { archived: true });
      await loadChatSummaries();
      refreshChatList();
      if (targetId === activeChatId) refreshMain();
    } catch (err) {
      console.error('[WorkGroup] archive chat failed:', err);
      alert('归档群聊失败');
    }
  }

  async function handleUnarchiveChat(chatId) {
    const targetId = chatId || activeChatId;
    if (!targetId) return;
    try {
      await apiPut(`/protoclaw/group_chats/${encodeURIComponent(targetId)}`, { archived: false });
      await loadChatSummaries();
      refreshChatList();
      if (targetId === activeChatId) refreshMain();
    } catch (err) {
      console.error('[WorkGroup] unarchive chat failed:', err);
      alert('取消归档失败');
    }
  }

  async function handleDeleteChat(chatId) {
    if (!chatId) return;
    const chat = chatSummaries.find((c) => c.id === chatId);
    const name = chat?.name || chatId;
    const confirmed = confirm(`确定要解散群聊「${name}」吗？\n\n解散后群聊记录将被删除，无法恢复。`);
    if (!confirmed) return;
    try {
      await apiDelete(`/protoclaw/group_chats/${encodeURIComponent(chatId)}`);
      const wasActive = chatId === activeChatId;
      if (wasActive) {
        activeChatId = null;
        activeChat = null;
      }
      await loadChatSummaries();
      // 如果删除的是当前群聊，切换到第一个可用活跃群
      if (wasActive) {
        const firstActive = chatSummaries.find((c) => !c.archived);
        if (firstActive) {
          await selectChat(firstActive.id);
        } else {
          refreshChatList();
          refreshMain();
        }
      } else {
        refreshChatList();
      }
    } catch (err) {
      console.error('[WorkGroup] delete chat failed:', err);
      alert('删除群聊失败');
    }
  }

  // ── 建群模态框 ──────────────────────────────────────────────

  async function handleNewChat() {
    if (identities.length === 0) await loadIdentities();

    const memberCandidates = identities.filter((id) => isManageableGroupIdentity(id.identityRef));
    const identityItems = memberCandidates.length
      ? memberCandidates.map((id) => {
        const name = id.displayName || id.identityRef;
        const avatar = generateAvatar(name, id.identityRef);
        return `<label class="wg-modal-identity wg-new-chat-identity">
        <input type="checkbox" value="${esc(id.identityRef)}" />
        <div class="wg-avatar wg-avatar-sm" style="--av-grad:${avatar.color}">${esc(avatar.initials)}</div>
        <div class="wg-new-chat-identity-info">
          <span class="wg-modal-identity-name">${esc(name)}</span>
          <span class="wg-modal-identity-desc">${esc(id.description || '')}</span>
        </div>
      </label>`;
      }).join('')
      : '<div class="wg-settings-empty-note">当前没有可拉入群聊的 Agent 身份。</div>';

    const modal = document.createElement('div');
    modal.className = 'wg-modal-overlay';
    modal.innerHTML = `
    <div class="wg-modal">
      <div class="wg-modal-title">新建群聊</div>

      <div class="wg-new-chat-name-row">
        <div class="wg-avatar wg-avatar-lg wg-new-chat-avatar" data-wg-role="new-chat-avatar" style="--av-grad:#6a6a6a">?</div>
        <input type="text" class="wg-modal-input wg-new-chat-name-input" data-wg-role="new-chat-name" placeholder="群聊名称" />
      </div>

      <div class="wg-modal-section-title">群简介（可选）</div>
      <textarea class="wg-modal-input wg-new-chat-desc" data-wg-role="new-chat-desc" placeholder="这个群是干什么的..." rows="2"></textarea>

      <div class="wg-modal-section-title">固定成员</div>
      <div class="wg-modal-fixed-members">
        <div class="wg-modal-fixed-member">
          <div class="wg-avatar wg-avatar-sm" style="--av-grad:${AVATAR_SPECIAL_COLORS['user']}">我</div>
          <span>我</span><small>群主</small>
        </div>
        <div class="wg-modal-fixed-member">
          <div class="wg-avatar wg-avatar-sm" style="--av-grad:${AVATAR_SPECIAL_COLORS['work-group:admin']}">管</div>
          <span>管理员</span><small>固定入群</small>
        </div>
      </div>

      <div class="wg-modal-section-title">选择成员</div>
      <div class="wg-modal-identity-list">${identityItems}</div>

      <div class="wg-modal-section-title">工作目录（可选）</div>
      <div class="wg-modal-dir-row">
        <input type="text" class="wg-modal-input wg-modal-dir-display" data-wg-role="new-chat-workdir" placeholder="不设置也可创建群聊" readonly />
        <button class="wg-modal-btn" data-wg-action="pick-workdir">选择</button>
      </div>

      <div class="wg-modal-actions">
        <button class="wg-modal-btn" data-wg-action="cancel-new-chat">取消</button>
        <button class="wg-modal-btn confirm" data-wg-action="confirm-new-chat">创建</button>
      </div>
    </div>`;
    document.body.appendChild(modal);

    // 头像预览：输入群名时实时更新
    const nameInput = modal.querySelector('[data-wg-role="new-chat-name"]');
    const avatarEl = modal.querySelector('[data-wg-role="new-chat-avatar"]');
    nameInput.addEventListener('input', () => {
      const name = nameInput.value.trim();
      if (name) {
        const av = generateAvatar(name, null);
        avatarEl.textContent = av.initials;
        avatarEl.style.setProperty('--av-grad', av.color);
      } else {
        avatarEl.textContent = '?';
        avatarEl.style.setProperty('--av-grad', '#6a6a6a');
      }
    });

    modal.querySelector('[data-wg-action="pick-workdir"]').addEventListener('click', async () => {
      try {
        const result = await invoke('select_directory');
        if (result && !result.cancelled && result.path) {
          modal.querySelector('[data-wg-role="new-chat-workdir"]').value = result.path;
        }
      } catch (err) {
        console.error('[WorkGroup] directory pick failed:', err);
      }
    });

    modal.querySelector('[data-wg-action="confirm-new-chat"]').addEventListener('click', async () => {
      const name = nameInput.value.trim();
      if (!name) { nameInput.focus(); return; }

      const workDir = modal.querySelector('[data-wg-role="new-chat-workdir"]').value.trim() || null;
      const desc = modal.querySelector('[data-wg-role="new-chat-desc"]').value.trim();

      const selected = Array.from(modal.querySelectorAll('.wg-modal-identity-list input[type="checkbox"]:checked'))
        .map((cb) => cb.value);

      const members = normalizeGroupMembers([
        ...selected.map((ref) => ({ identityRef: ref, role: 'agent' })),
      ]);

      document.body.removeChild(modal);

      try {
        const chat = await apiPost('/protoclaw/group_chats', { name, workDir, members });
        // 写入 GROUP.md 初始内容（如果填了群简介）
        if (desc) {
          try {
            await apiPut(`/protoclaw/group_chats/${encodeURIComponent(chat.id)}/group_md`, { content: desc });
          } catch (e) {
            console.error('[WorkGroup] write initial GROUP.md failed:', e);
          }
        }
        await loadChatSummaries();
        refreshChatList();
        await selectChat(chat.id);
      } catch (err) {
        console.error('[WorkGroup] create chat failed:', err);
      }
    });

    modal.querySelector('[data-wg-action="cancel-new-chat"]').addEventListener('click', () => {
      document.body.removeChild(modal);
    });

    modal.addEventListener('click', (e) => {
      if (e.target === modal) document.body.removeChild(modal);
    });
  }

  // ── 引入会话搜索弹窗 ────────────────────────────────────────

  async function openImportModal() {
    if (!activeChatId) return;
    closeImportModal();

    const imported = activeChat?.importedSessions || [];

    const modal = document.createElement('div');
    modal.className = 'wg-modal-overlay';
    modal.innerHTML = [
      '<div class="wg-modal wg-import-modal">',
      '  <div class="wg-modal-title">引入会话</div>',
      '  <input type="text" class="wg-modal-input wg-import-search" data-wg-role="import-search" placeholder="搜索会话标题或目标..." />',
      '  <div class="wg-import-sections">',
      '    <div class="wg-import-section">',
      '      <div class="wg-import-section-label">已引入 (' + imported.length + ')</div>',
      '      <div class="wg-import-list" data-wg-role="imported-list">' + renderImportedList(imported) + '</div>',
      '    </div>',
      '    <div class="wg-import-section">',
      '      <div class="wg-import-section-label">搜索结果</div>',
      '      <div class="wg-import-list" data-wg-role="search-results"><div class="wg-import-empty">输入关键词搜索跨工作空间会话</div></div>',
      '    </div>',
      '  </div>',
      '  <div class="wg-modal-actions">',
      '    <button class="wg-modal-btn" data-wg-action="close-import-modal">关闭</button>',
      '  </div>',
      '</div>',
    ].join('');
    document.body.appendChild(modal);
    _importModalEl = modal;

    // 搜索防抖
    const searchInput = modal.querySelector('[data-wg-role="import-search"]');
    searchInput.addEventListener('input', () => {
      clearTimeout(_importSearchTimer);
      _importSearchTimer = setTimeout(() => doImportSearch(searchInput.value.trim()), 300);
    });

    // 弹窗内点击代理
    modal.addEventListener('click', (e) => {
      // 点击遮罩关闭
      if (e.target === modal) { closeImportModal(); return; }

      const importBtn = e.target.closest('[data-wg-import-action]');
      if (importBtn) {
        const action = importBtn.dataset.wgImportAction;
        const { workspaceId, sessionId, title } = importBtn.dataset;
        if (action === 'do-import') {
          doImportSession(workspaceId, sessionId);
        } else if (action === 'do-unimport') {
          doUnimportSession(workspaceId, sessionId);
        } else if (action === 'navigate') {
          navigateToSessionRecord(workspaceId, sessionId);
          closeImportModal();
        }
      }

      const closeBtn = e.target.closest('[data-wg-action="close-import-modal"]');
      if (closeBtn) closeImportModal();
    });

    // 自动聚焦搜索框
    searchInput.focus();
  }

  function closeImportModal() {
    if (_importModalEl) { _importModalEl.remove(); _importModalEl = null; }
    clearTimeout(_importSearchTimer);
  }

  function renderImportedList(imported) {
    if (!imported || imported.length === 0) {
      return '<div class="wg-import-empty">暂无引入会话</div>';
    }
    return imported.map((s) => {
      return [
        `<div class="wg-import-item">`,
        `  <div class="wg-import-item-info" data-wg-import-action="navigate" data-workspace-id="${esc(s.workspaceId)}" data-session-id="${esc(s.sessionId)}" title="点击跳转">`,
        `    <span class="wg-import-item-ws">${esc(s.workspaceName || s.workspaceId)}</span>`,
        `    <span class="wg-import-item-title">${esc(s.title)}</span>`,
        `  </div>`,
        `  <button class="wg-import-item-btn danger" data-wg-import-action="do-unimport" data-workspace-id="${esc(s.workspaceId)}" data-session-id="${esc(s.sessionId)}">移除</button>`,
        `</div>`,
      ].join('');
    }).join('');
  }

  function renderSearchResults(results, importedIds) {
    if (!results || results.length === 0) {
      return '<div class="wg-import-empty">无匹配会话</div>';
    }
    return results.map((s) => {
      const key = `${s.workspaceId}:${s.sessionId}`;
      const already = importedIds.has(key);
      return [
        `<div class="wg-import-item">`,
        `  <div class="wg-import-item-info">`,
        `    <span class="wg-import-item-ws">${esc(s.workspaceName || s.workspaceId)}</span>`,
        `    <span class="wg-import-item-title">${esc(s.title)}</span>`,
        `  </div>`,
        already
          ? `<span class="wg-import-item-done">已引入</span>`
          : `<button class="wg-import-item-btn confirm" data-wg-import-action="do-import" data-workspace-id="${esc(s.workspaceId)}" data-session-id="${esc(s.sessionId)}">引入</button>`,
        `</div>`,
      ].join('');
    }).join('');
  }

  async function doImportSearch(q) {
    if (!_importModalEl || !activeChatId) return;
    const resultsEl = _importModalEl.querySelector('[data-wg-role="search-results"]');
    if (!resultsEl) return;

    if (!q) {
      resultsEl.innerHTML = '<div class="wg-import-empty">输入关键词搜索跨工作空间会话</div>';
      return;
    }

    resultsEl.innerHTML = '<div class="wg-import-empty">搜索中...</div>';
    try {
      const data = await apiGet(
        `/protoclaw/group_chats/${encodeURIComponent(activeChatId)}/search_sessions?q=${encodeURIComponent(q)}`
      );
      const importedIds = new Set(
        (activeChat?.importedSessions || []).map((s) => `${s.workspaceId}:${s.sessionId}`)
      );
      resultsEl.innerHTML = renderSearchResults(data.sessions || [], importedIds);
    } catch (err) {
      resultsEl.innerHTML = '<div class="wg-import-empty">搜索失败</div>';
      console.error('[WorkGroup] import search failed:', err);
    }
  }

  async function doImportSession(workspaceId, sessionId) {
    if (!activeChatId) return;
    try {
      const result = await apiPost(
        `/protoclaw/group_chats/${encodeURIComponent(activeChatId)}/import_session`,
        { workspaceId, sessionId }
      );
      // 更新 activeChat
      if (activeChat) activeChat.importedSessions = result.imported || [];
      // 刷新弹窗内列表
      if (_importModalEl) {
        const listEl = _importModalEl.querySelector('[data-wg-role="imported-list"]');
        if (listEl) listEl.innerHTML = renderImportedList(result.imported || []);
        // 刷新搜索结果中的"已引入"状态
        const searchInput = _importModalEl.querySelector('[data-wg-role="import-search"]');
        if (searchInput) doImportSearch(searchInput.value.trim());
      }
      // 刷新态势层 badge
      refreshAdminBarOnly();
    } catch (err) {
      console.error('[WorkGroup] import session failed:', err);
    }
  }

  async function doUnimportSession(workspaceId, sessionId) {
    if (!activeChatId) return;
    try {
      const result = await fetch(
        `/protoclaw/group_chats/${encodeURIComponent(activeChatId)}/import_session`,
        { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId, sessionId }) }
      ).then((r) => r.json());
      if (activeChat) activeChat.importedSessions = result.imported || [];
      if (_importModalEl) {
        const listEl = _importModalEl.querySelector('[data-wg-role="imported-list"]');
        if (listEl) listEl.innerHTML = renderImportedList(result.imported || []);
        const searchInput = _importModalEl.querySelector('[data-wg-role="import-search"]');
        if (searchInput) doImportSearch(searchInput.value.trim());
      }
      refreshAdminBarOnly();
    } catch (err) {
      console.error('[WorkGroup] unimport session failed:', err);
    }
  }

  /**
   * 中断指定会话。
   */
  async function handleInterruptSession(identityRef, sessionId, workspaceId) {
    if (!activeChatId || !identityRef) return;
    try {
      const res = await fetch('/protoclaw/gc/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chatId: activeChatId,
          identityRef,
          sessionId,
          action: 'interrupt',
        }),
      });
      const data = await res.json();
      if (data.ok) {
        console.log(`[WorkGroup] interrupted session ${sessionId} (${identityRef})`);
        // 立即刷新运行时状态
        await fetchRuntimeStatus();
        refreshAdminBarOnly();
      } else {
        console.error('[WorkGroup] interrupt failed:', data.error);
      }
    } catch (err) {
      console.error('[WorkGroup] interrupt request failed:', err);
    }
  }

  // ── 容器事件代理 ────────────────────────────────────────────

  function onContainerClick(e) {
    // 关闭下拉菜单（点击外部）
    if (openDropdown && !e.target.closest(`[data-wg-dropdown="${openDropdown}"]`)) {
      openDropdown = null;
      refreshHeaderAndMessages();
    }

    // 关闭 mention picker（点击外部）
    const picker = document.querySelector('[data-wg-role="mention-picker"]');
    if (picker && picker.style.display !== 'none') {
      if (!e.target.closest('[data-wg-role="mention-picker"]') && !e.target.closest('[data-wg-action="mention"]')) {
        hideMentionPicker();
      }
    }

    const action = e.target.closest('[data-wg-action]');
    if (action) {
      const act = action.dataset.wgAction;

      if (act === 'new-chat') { handleNewChat(); return; }
      if (act === 'mention') { toggleMentionPicker(); return; }
      if (act === 'toggle-links') { toggleLinksArea(); return; }
      if (act === 'add-link') { addLink(); return; }
      if (act === 'send') { handleSend(); return; }
      if (act === 'voice') { toggleVoiceRecording(action); return; }
      if (act === 'toggle-session-dropdown') {
        toggleSessionDropdown(action.dataset.wgIdentity);
        return;
      }
      if (act === 'toggle-dropdown') {
        toggleDropdown(action.dataset.wgDropdownType);
        return;
      }
      if (act === 'admin-restart') { handleAdminRestart(); return; }
      if (act === 'open-import-modal') { openImportModal(); return; }
      if (act === 'interrupt-session') {
        e.stopPropagation();
        const btn = action;
        btn.disabled = true;
        btn.textContent = '...';
        handleInterruptSession(
          btn.dataset.wgIdentity,
          btn.dataset.wgSessionId,
          btn.dataset.wgWorkspaceId
        ).finally(() => {
          btn.disabled = false;
          btn.textContent = '中断';
        });
        return;
      }
      if (act === 'cancel-new-chat') return;
      if (act === 'pick-workdir') return; // handled by modal-specific listener
      if (act === 'toggle-archived') {
        _archivedCollapsed = !_archivedCollapsed;
        refreshChatList();
        return;
      }
    }

    const removeLink = e.target.closest('[data-wg-action="remove-link"]');
    if (removeLink) {
      const idx = parseInt(removeLink.dataset.wgLinkIndex);
      pendingLinks.splice(idx, 1);
      renderLinkList();
      return;
    }

    const removeAtt = e.target.closest('[data-wg-action="remove-attachment"]');
    if (removeAtt) {
      const idx = parseInt(removeAtt.dataset.wgAttachmentIndex);
      pendingAttachments.splice(idx, 1);
      renderAttachmentList();
      return;
    }

    const chatItem = e.target.closest('[data-wg-chat-id]');
    if (chatItem) {
      selectChat(chatItem.dataset.wgChatId);
      return;
    }

    // @mention picker — level 1: member selection
    const mentionItem = e.target.closest('[data-wg-mention]');
    if (mentionItem) {
      const identityRef = mentionItem.dataset.wgMention;
      // 管理员：没有 level 2，直接插入
      if (identityRef === 'work-group:admin') {
        insertMention(identityRef);
      } else {
        showMentionLevel2(identityRef);
      }
      return;
    }

    // @mention picker — back button
    const mentionBack = e.target.closest('[data-wg-mention-back]');
    if (mentionBack) {
      showMentionLevel1();
      return;
    }

    // @mention picker — level 2: session selection
    const mentionSession = e.target.closest('[data-wg-mention-session]');
    if (mentionSession && _mentionTarget) {
      const val = mentionSession.dataset.wgMentionSession;
      const title = mentionSession.dataset.wgMentionTitle;
      if (val === '__new__') {
        insertMentionWithSession(_mentionTarget, 'new');
      } else if (val === '__default__') {
        insertMentionWithSession(_mentionTarget, 'default');
      } else {
        insertMentionWithSession(_mentionTarget, 'specific', val, title);
      }
      return;
    }

    const modeItem = e.target.closest('[data-wg-mode-type]');
    if (modeItem) {
      handleModeChange(modeItem.dataset.wgModeType, modeItem.dataset.wgModeValue);
      return;
    }

    const navItem = e.target.closest('[data-wg-session-nav]');
    if (navItem) {
      navigateToSession(navItem.dataset.wgSessionNav);
      return;
    }

    // 附件 chip 点击 → 在文档面板打开该文件
    const attachmentOpen = e.target.closest('[data-wg-attachment-open]');
    if (attachmentOpen) {
      const name = attachmentOpen.dataset.wgAttachmentOpen;
      if (name && activeChatId && window._viewerOpen) {
        window._viewerOpen(name, activeChatId, false);
      }
      return;
    }

    const sessionOpt = e.target.closest('[data-wg-session-opt]');
    if (sessionOpt) {
      handleSessionOption(
        sessionOpt.dataset.wgIdentity,
        sessionOpt.dataset.wgSessionOpt,
        sessionOpt.dataset.wgSessionId,
        sessionOpt.dataset.wgSessionTitle,
      );
      return;
    }

    // 点击 session dropdown 外部时关闭
    if (_openSessionDropdown && !e.target.closest('.wg-session-pill-wrap')) {
      _openSessionDropdown = null;
      renderSessionBar();
    }
  }

  function onContainerInput(e) {
    const search = e.target.closest('[data-wg-role="search"]');
    if (search) {
      searchKeyword = search.value;
      refreshChatList();
      return;
    }
    // 编辑器内容变化时更新 session bar（@mention 增减时 pill 跟随）
    const editor = e.target.closest('.wg-input-editor');
    if (editor && activeChatId) {
      const text = editor.textContent || '';
      const picker = document.querySelector('[data-wg-role="mention-picker"]');
      if (picker) {
        const trimmed = text.trim();
        const lastChar = text.slice(-1);
        // @ 作为首个字符或在空格后键入 @ → 弹出 level 1
        if (lastChar === '@' && (trimmed === '@' || text.endsWith(' @'))) {
          if (picker.style.display === 'none') {
            showMentionLevel1();
          }
        }
        // @ 被删除 → 自动关闭弹窗
        if (picker.style.display !== 'none' && !trimmed.includes('@')) {
          hideMentionPicker();
        }
      }
      renderSessionBar();
    }
  }

  function onContainerChange(e) {
    // settings fields now use inline onchange handlers
  }

  function onContainerKeyDown(e) {
    const editor = e.target.closest('.wg-input-editor');
    if (!editor) return;
    // Escape 关闭 mention picker
    const picker = document.querySelector('[data-wg-role="mention-picker"]');
    if (e.key === 'Escape' && picker && picker.style.display !== 'none') {
      hideMentionPicker();
      e.stopPropagation();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  // ── 右键上下文菜单：引用续话 ──────────────────────────────

  function onContainerContextMenu(e) {
    // 群聊列表项右键菜单
    const chatItem = e.target.closest('[data-wg-chat-id]');
    if (chatItem) {
      const chatId = chatItem.dataset.wgChatId;
      const chat = chatSummaries.find((c) => c.id === chatId);
      if (!chat) return;

      e.preventDefault();
      const items = [];

      if (chat.archived) {
        items.push({
          label: '取消归档',
          action: () => handleUnarchiveChat(chatId),
        });
      } else {
        items.push({
          label: '归档群聊',
          action: () => handleArchiveChat(chatId),
        });
      }

      items.push({
        label: '删除群聊',
        hint: '解散后数据不可恢复',
        action: () => handleDeleteChat(chatId),
      });

      _showContextMenu(e.clientX, e.clientY, items);
      return;
    }

    if (!activeChatId) return;
    const msgRow = e.target.closest('.wg-msg-row');
    if (!msgRow) return;

    const msgId = msgRow.dataset.wgMsgId;
    if (!msgId) return;

    e.preventDefault();

    const items = [];

    // 批注（所有消息都支持）
    const existingAnn = _annotations[msgId];
    items.push({
      label: existingAnn ? '编辑批注' : '批注',
      hint: existingAnn ? existingAnn.text.slice(0, 30) : '',
      action: () => _openAnnotationEditor(msgId),
    });

    // 引用续话（自己发的消息不给）
    if (!msgRow.classList.contains('me')) {
      const quoteRef = msgRow.dataset.wgQuoteRef || '';
      const quoteSession = msgRow.dataset.wgQuoteSession || '';
      const quoteWorkspace = msgRow.dataset.wgQuoteWorkspace || '';
      const quoteName = msgRow.dataset.wgQuoteName || '';
      const quoteTitle = msgRow.dataset.wgQuoteTitle || quoteSession.slice(-8) || '';

      const matchedId = identities.find((id) =>
        (quoteRef && id.identityRef === quoteRef) ||
        (quoteName && id.displayName === quoteName)
      );
      if (matchedId) {
        if (quoteSession && quoteWorkspace) {
          items.push({
            label: '引用续话',
            hint: `@${matchedId.displayName} → ${quoteTitle}`,
            action: () => {
              const editor = document.querySelector('.wg-input-editor');
              if (!editor) return;
              editor.focus();
              document.execCommand('insertText', false, `@${matchedId.displayName} `);

              setSessionSelection(activeChatId, matchedId.identityRef, {
                mode: 'specific',
                sessionId: quoteSession,
                sessionTitle: quoteTitle,
              });

              if (!_sessionDataCache[matchedId.identityRef]) {
                fetchSessionData(matchedId.identityRef);
              }
              renderSessionBar();
            },
          });
        } else {
          items.push({
            label: '引用并提及',
            hint: `@${matchedId.displayName}`,
            action: () => {
              const editor = document.querySelector('.wg-input-editor');
              if (!editor) return;
              editor.focus();
              document.execCommand('insertText', false, `@${matchedId.displayName} `);

              if (!_sessionDataCache[matchedId.identityRef]) {
                fetchSessionData(matchedId.identityRef);
              }
              renderSessionBar();
            },
          });
        }
      }
    }

    _showContextMenu(e.clientX, e.clientY, items);
  }

  let _contextMenuEl = null;
  function _showContextMenu(x, y, items) {
    _hideContextMenu();
    _contextMenuEl = document.createElement('div');
    _contextMenuEl.className = 'wg-context-menu';
    _contextMenuEl.style.left = x + 'px';
    _contextMenuEl.style.top = y + 'px';
    _contextMenuEl.innerHTML = items.map((item, i) => {
      return [
        `<div class="wg-context-menu-item" data-wg-ctx-idx="${i}">`,
        `  <span class="wg-context-menu-label">${esc(item.label)}</span>`,
        item.hint ? `  <span class="wg-context-menu-hint">${esc(item.hint)}</span>` : '',
        '</div>',
      ].join('');
    }).join('');

    document.body.appendChild(_contextMenuEl);

    // 定位调整：防止超出视口
    const rect = _contextMenuEl.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
      _contextMenuEl.style.left = (window.innerWidth - rect.width - 4) + 'px';
    }
    if (rect.bottom > window.innerHeight) {
      _contextMenuEl.style.top = (window.innerHeight - rect.height - 4) + 'px';
    }

    _contextMenuEl.querySelectorAll('[data-wg-ctx-idx]').forEach((el) => {
      el.addEventListener('click', () => {
        const idx = parseInt(el.dataset.wgCtxIdx);
        items[idx].action();
        _hideContextMenu();
      });
    });

    // 点击外部关闭
    setTimeout(() => {
      document.addEventListener('click', _hideContextMenu, { once: true });
    }, 0);
  }

  function _hideContextMenu() {
    if (_contextMenuEl) {
      _contextMenuEl.remove();
      _contextMenuEl = null;
    }
  }

  // ── 批注编辑器（模态弹窗） ──────────────────────────────────

  function _openAnnotationEditor(msgId) {
    _closeAnnotationEditor();

    const existing = _annotations[msgId];
    const overlay = document.createElement('div');
    overlay.className = 'wg-modal-overlay wg-annotation-overlay';
    overlay.innerHTML = [
      '<div class="wg-modal wg-annotation-modal">',
      '  <div class="wg-modal-title">批注消息</div>',
      `  <textarea class="wg-annotation-textarea" placeholder="输入批注内容…" rows="5">${esc(existing ? existing.text : '')}</textarea>`,
      '  <div class="wg-modal-actions">',
      existing ? '    <button class="wg-modal-btn danger" data-action="delete">删除批注</button>' : '',
      '    <div style="flex:1"></div>',
      '    <button class="wg-modal-btn" data-action="cancel">取消</button>',
      '    <button class="wg-modal-btn confirm" data-action="save">保存</button>',
      '  </div>',
      '</div>',
    ].join('');
    document.body.appendChild(overlay);

    const textarea = overlay.querySelector('.wg-annotation-textarea');
    textarea.focus();
    if (existing) {
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    }

    overlay.addEventListener('click', (ev) => {
      if (ev.target === overlay) { _closeAnnotationEditor(); return; }
      const btn = ev.target.closest('[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      if (action === 'cancel') {
        _closeAnnotationEditor();
      } else if (action === 'save') {
        const text = textarea.value.trim();
        if (!text) return;
        _saveAnnotation(msgId, text);
        _closeAnnotationEditor();
      } else if (action === 'delete') {
        _deleteAnnotation(msgId);
        _closeAnnotationEditor();
      }
    });

    // Enter 保存，Escape 取消
    textarea.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
        ev.preventDefault();
        const text = textarea.value.trim();
        if (text) { _saveAnnotation(msgId, text); _closeAnnotationEditor(); }
      }
      if (ev.key === 'Escape') { _closeAnnotationEditor(); }
    });
  }

  function _closeAnnotationEditor() {
    const el = document.querySelector('.wg-annotation-overlay');
    if (el) el.remove();
  }

  async function _saveAnnotation(msgId, text) {
    if (!activeChatId) return;
    try {
      const data = await apiPut(
        `/protoclaw/group_chats/${encodeURIComponent(activeChatId)}/annotations/${encodeURIComponent(msgId)}`,
        { text }
      );
      if (data.annotation) _annotations[msgId] = data.annotation;
      _renderAnnotationBars();
    } catch (err) {
      console.error('[WorkGroup] saveAnnotation:', err);
    }
  }

  async function _deleteAnnotation(msgId) {
    if (!activeChatId) return;
    try {
      await apiDelete(
        `/protoclaw/group_chats/${encodeURIComponent(activeChatId)}/annotations/${encodeURIComponent(msgId)}`
      );
      delete _annotations[msgId];
      _renderAnnotationBars();
    } catch (err) {
      console.error('[WorkGroup] deleteAnnotation:', err);
    }
  }

  /** 在消息列表渲染后，给每条有批注的消息插入批注条 */
  function _renderAnnotationBars() {
    if (!activeChatId) return;
    const container = document.querySelector('.wg-msg-list');
    if (!container) return;
    // 清理旧批注条
    container.querySelectorAll('.wg-annotation-bar').forEach((el) => el.remove());
    // 插入新批注条
    Object.entries(_annotations).forEach(([msgId, ann]) => {
      const row = container.querySelector(`.wg-msg-row[data-wg-msg-id="${CSS.escape(msgId)}"]`);
      if (!row) return;
      const body = row.querySelector('.wg-msg-body');
      if (!body) return;
      const time = formatTime(ann.timestamp);
      const bar = document.createElement('div');
      bar.className = 'wg-annotation-bar';
      bar.innerHTML = [
        '<span class="wg-annotation-icon">我：</span>',
        `<span class="wg-annotation-text">${esc(ann.text)}</span>`,
        `<span class="wg-annotation-time">${esc(time)}</span>`,
      ].join('');
      body.appendChild(bar);
    });
  }

  // ── 拖拽：接收 Files 面板的文件 ───────────────────────────────

  function onContainerDragOver(e) {
    // 只处理来自 Files 面板的拖拽
    if (!e.dataTransfer?.types?.includes('application/x-claw-resource')) return;
    const inputArea = e.target.closest('.wg-input-area');
    if (!inputArea) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    inputArea.classList.add('dragover');
  }

  function onContainerDragLeave(e) {
    const inputArea = e.target.closest('.wg-input-area');
    if (!inputArea) return;
    // 只在真正离开 inputArea 时移除样式
    if (!inputArea.contains(e.relatedTarget)) {
      inputArea.classList.remove('dragover');
    }
  }

  async function onContainerDrop(e) {
    const inputArea = e.target.closest('.wg-input-area');
    if (!inputArea) return;
    const name = e.dataTransfer?.getData('application/x-claw-resource');
    if (!name) return;
    e.preventDefault();
    inputArea.classList.remove('dragover');

    // 从 Files 面板获取文件内容
    const chatId = activeChatId;
    if (!chatId) return;
    try {
      const res = await fetch(`/protoclaw/group_chats/${encodeURIComponent(chatId)}/resources/${encodeURIComponent(name)}`);
      const data = await res.json();
      // 检查是否已存在同名附件
      if (!pendingAttachments.find(a => a.name === name)) {
        pendingAttachments.push({ name, content: data.content || '' });
        renderAttachmentList();
      }
    } catch (err) {
      console.error('[WorkGroup] drop attachment failed:', err);
    }
  }

  // ── 初始化 ──────────────────────────────────────────────────

  async function init() {
    isLoading = true;
    await Promise.all([loadChatSummaries(), loadIdentities()]);
    // 优先选择第一个活跃群聊，跳过已归档的
    const firstActive = chatSummaries.find((c) => !c.archived);
    if (firstActive) {
      await selectChat(firstActive.id);
    } else if (chatSummaries.length > 0) {
      await selectChat(chatSummaries[0].id);
    }
    isLoading = false;
    startPolling();
    setupScrollListener();
  }

  function setupScrollListener() {
    // 使用事件委托监听scroll事件
    document.addEventListener('scroll', (e) => {
      // 忽略程序触发的 scroll 事件
      if (_suppressScrollEvent) return;
      const scrollEl = e.target.closest('.wg-msg-scroll');
      if (!scrollEl) return;
      
      // 用户手动滚动时设置标志位
      _userScrolling = true;
      
      // 清除之前的计时器
      if (_userScrollingTimer) {
        clearTimeout(_userScrollingTimer);
      }
      
      // 2秒后清除标志位
      _userScrollingTimer = setTimeout(() => {
        _userScrolling = false;
        _userScrollingTimer = null;
      }, 2000);
    }, true); // 使用捕获阶段确保能监听到
  }

  // ── 语音输入功能 ──────────────────────────────────────────────

  function _playVoiceSound(type) {
    try {
      const url = type === 'start'
        ? '/sounds/voice-recording-start.mp3'
        : '/sounds/voice-recording-stop.mp3';
      const audio = new Audio(url);
      audio.volume = 0.6;
      audio.play().catch(() => { /* ignore autoplay rejection */ });
    } catch (e) { /* non-critical */ }
  }

  function _updateVoiceUI() {
    const btn = _voiceTargetBtn;
    if (!btn || !btn.isConnected) return;
    btn.classList.toggle('transcribing', _voiceTranscribing);
    btn.classList.toggle('recording', _voiceRecording);
  }

  async function toggleVoiceRecording(btn) {
    if (_voiceRecording) {
      stopVoiceRecording();
    } else if (!_voiceTranscribing) {
      await startVoiceRecording(btn);
    }
  }

  async function startVoiceRecording(btn) {
    // Check speech config
    let speechConfig = window.ClawFW?._speechModelConfig;
    if (!speechConfig || !speechConfig.baseUrl || !speechConfig.apiKey) {
      try {
        const resp = await fetch('/protoclaw/speech_model_config');
        const data = await resp.json();
        speechConfig = data?.speechModel;
        if (window.ClawFW) window.ClawFW._speechModelConfig = speechConfig;
      } catch (e) { /* ignore */ }
    }
    if (!speechConfig || !speechConfig.baseUrl || !speechConfig.apiKey) {
      alert('语音模型未配置，请在设置中配置 ASR 模型');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      _voiceTargetBtn = btn;
      _voiceAudioChunks = [];
      _voiceChatId = activeChatId;
      _voicePendingSend = false;

      // Determine best supported MIME type
      const mimeTypes = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', ''];
      let selectedMime = '';
      for (const mt of mimeTypes) {
        if (!mt || MediaRecorder.isTypeSupported(mt)) {
          selectedMime = mt;
          break;
        }
      }

      const options = selectedMime ? { mimeType: selectedMime } : {};
      _voiceMediaRecorder = new MediaRecorder(stream, options);

      _voiceMediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          _voiceAudioChunks.push(e.data);
        }
      };

      _voiceMediaRecorder.onstop = async () => {
        // Stop all tracks
        stream.getTracks().forEach(t => t.stop());
        btn.classList.remove('recording');
        _voiceRecording = false;
        _playVoiceSound('stop');

        console.log('[WorkGroup][VoiceInput] onstop fired: cancelled=%s pendingSend=%s chunkCount=%d',
          _voiceCancelled, _voicePendingSend, _voiceAudioChunks.length);

        if (_voiceCancelled) {
          _voiceCancelled = false;
          _voiceAudioChunks = [];
          _updateVoiceUI();
          return;
        }

        if (_voiceAudioChunks.length === 0) {
          _updateVoiceUI();
          return;
        }

        const mimeType = _voiceMediaRecorder.mimeType || 'audio/webm';
        const blob = new Blob(_voiceAudioChunks, { type: mimeType });
        _voiceAudioChunks = [];

        _voiceTranscribing = true;
        _updateVoiceUI();
        try {
          await sendAudioToASR(blob, btn);
        } finally {
          _voiceTranscribing = false;
          _updateVoiceUI();
        }

        // Auto-send if user pressed send while recording
        if (_voicePendingSend) {
          _voicePendingSend = false;
          console.log('[WorkGroup][VoiceInput] auto-send check: voiceChatId=%s activeChatId=%s',
            _voiceChatId, activeChatId);
          if (_voiceChatId === activeChatId) {
            // Same chat — text already in editor, submit normally
            console.log('[WorkGroup][VoiceInput] same-chat auto-send → handleSend()');
            handleSend();
          }
        }
      };

      _voiceMediaRecorder.start(1000); // collect chunks every 1s
      _voiceRecording = true;
      btn.classList.add('recording');
      _playVoiceSound('start');
      _updateVoiceUI();
    } catch (err) {
      console.error('[WorkGroup][VoiceInput] Failed to start recording:', err);
      alert('无法访问麦克风：' + err.message);
    }
  }

  function stopVoiceRecording() {
    if (_voiceMediaRecorder && _voiceMediaRecorder.state === 'recording') {
      _voiceMediaRecorder.stop();
      _voiceRecording = false;
      if (_voiceTargetBtn) _voiceTargetBtn.classList.remove('recording');
    }
  }

  function _cancelVoiceRecording() {
    _voiceCancelled = true;
    _voicePendingSend = false;
    stopVoiceRecording();
  }

  async function sendAudioToASR(blob, btn) {
    try {
      const resp = await fetch('/protoclaw/speech_to_text', {
        method: 'POST',
        headers: { 'Content-Type': blob.type || 'audio/webm' },
        body: blob,
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: 'Unknown error' }));
        console.error('[WorkGroup][VoiceInput] ASR error:', err);
        alert(err.error || 'ASR request failed');
        return;
      }

      // Non-streaming JSON response
      const data = await resp.json();
      const text = data?.text || '';
      if (text) {
        const editor = document.querySelector('.wg-input-editor');
        // Only inject if we're still on the same chat that started the recording.
        if (editor && activeChatId === _voiceChatId) {
          insertTextAtEditorCursor(editor, text);
        }
      }

    } catch (err) {
      console.error('[WorkGroup][VoiceInput] ASR request failed:', err);
      alert('语音识别失败：' + err.message);
    }
  }

  function insertTextAtEditorCursor(editor, text) {
    editor.focus();
    const selection = window.getSelection();
    if (!selection) {
      // Fallback: append to end
      editor.textContent += text;
      return;
    }

    // If cursor is not inside editor, place at end
    if (!editor.contains(selection.anchorNode)) {
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    }

    // Insert text at cursor position
    const range = selection.getRangeAt(0);
    range.deleteContents();
    const textNode = document.createTextNode(text);
    range.insertNode(textNode);
    range.setStartAfter(textNode);
    range.setEndAfter(textNode);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  // ── 对外接口 ────────────────────────────────────────────────

  function deactivate() {
    // 离开工作空间前保存当前群聊的输入草稿
    if (activeChatId) _saveCurrentDraft(activeChatId);
    stopPolling();
    pendingLinks = [];
    pendingAttachments = [];
    openDropdown = null;
    hideMemberPopover(true);
    closeImportModal();
    closeAddMemberModal();
    // 取消正在进行的语音录制
    if (_voiceRecording) {
      _cancelVoiceRecording();
    }
  }

  // ── 全局暴露：Settings 面板（右侧边栏） ──────────────────────

  window._wgGetSettingsHtml = function () {
    if (!activeChat) return '<div class="feature-panel-empty"><div>请先选择一个群聊。</div></div>';
    return renderSettingsPanel(activeChat);
  };

  window._wgSettingsInit = async function () {
    if (!activeChatId) return;
    const cid = activeChatId;
    // 并行加载 admin model 选项和 GROUP.md 摘要内容（只读展示）
    groupMdLoading = true;
    groupMdChatId = cid;
    groupMdContent = '';
    if (typeof window._wgSettingsRefresh === 'function') window._wgSettingsRefresh();
    try {
      const [, mdData] = await Promise.all([
        loadAdminModelOptions(),
        apiGet(`/protoclaw/group_chats/${encodeURIComponent(cid)}/group_md`),
      ]);
      if (activeChatId !== cid) return;
      groupMdContent = mdData.content || '';
    } catch {
      if (activeChatId === cid) groupMdContent = '';
    } finally {
      if (activeChatId === cid) {
        groupMdLoading = false;
        if (typeof window._wgSettingsRefresh === 'function') window._wgSettingsRefresh();
      }
    }
  };

  window._wgSettingsRefresh = function () {
    if (typeof activeFeaturePanel !== 'undefined' && activeFeaturePanel === 'settings' && typeof renderFeaturePanel === 'function') {
      renderFeaturePanel();
    }
  };

  window._wgSettingsChange = async function (field, value) {
    await handleSettingsFieldChange(field, value);
    // 字段变更后刷新 settings 面板，让 UI 同步
    window._wgSettingsRefresh();
  };

  // ── Phase 1 新增导出 ──
  window._wgToggleAdminConfig = toggleAdminConfig;
  window._wgEditGroupMd = editGroupMd;
  window._wgOpenAddMemberModal = openAddMemberModal;

  // ── 保留导出 ──
  window._wgChangeWorkDir = changeWorkDir;
  window._wgOpenFilesPanel = openFilesPanel;
  window._wgAddSelectedMember = addSelectedMember; // 旧 select 已移除，保留占位
  window._wgRemoveMember = removeGroupMember;
  window._wgDissolve = handleDissolveChat;
  window._wgArchive = async function () { await handleArchiveChat(); window._wgSettingsRefresh(); };
  window._wgUnarchive = async function () { await handleUnarchiveChat(); window._wgSettingsRefresh(); };

  // 给外部 poll 用的轻量刷新：只更新左侧群聊列表，避免整个 workspace DOM 重建
  // 导致输入框失焦/内容丢失。
  function softRefresh() {
    refreshChatList();
  }

  window.WorkGroupUI = {
    render: renderWorkGroupSurface,
    onContainerClick,
    onContainerInput,
    onContainerChange,
    onContainerKeyDown,
    onContainerContextMenu,
    onContainerDragOver,
    onContainerDragLeave,
    onContainerDrop,
    onContainerMouseOver,
    onContainerMouseOut,
    init,
    destroy: stopPolling,
    deactivate,
    startPolling,
    softRefresh,
    getActiveChatId: () => activeChatId,
    getActiveChat: () => activeChat,
    getChatSummaries: () => chatSummaries,
    addAttachment: (name, content) => {
      if (!pendingAttachments.find(a => a.name === name)) {
        pendingAttachments.push({ name, content: content || '' });
        renderAttachmentList();
      }
    },
  };
})();
