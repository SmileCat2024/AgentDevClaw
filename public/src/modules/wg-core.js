/**
 * wg-core.js — 核心域
 *
 * 包含：API helpers、数据加载、工具函数、聊天列表/消息渲染、输入/mention、
 *       actions、rendering lifecycle、事件代理、init/deactivate、window.WorkGroupUI 导出。
 *
 * 依赖加载顺序：必须在所有 wg-*.js 子文件之后加载。
 */

// ── 本域常量 ──────────────────────────────────────────────────
const WG_DISPATCH_STATUS_TEXT = {
  'auto': '自动执行',
  'manual': '人工确认',
  'editing': '编辑中',
  'interrupted': '已中断',
};

const WG_AVATAR_COLORS = [
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

const WG_AVATAR_SPECIAL_COLORS = {
  'user': '#2563EB',             // 品牌蓝
  'work-group:admin': '#9333EA', // 管理紫
};

const WG_COLLAPSE_THRESHOLD = 300;
const WG_POLL_INTERVAL = 3000;
const WG_SCROLL_USER_TIMEOUT = 2000;
const WG_NEAR_BOTTOM_THRESHOLD = 80;
const WG_CHAT_PREVIEW_LENGTH = 40;
const WG_DISPATCH_TEXT_SLICE = 100;
const WG_ATTACHMENT_NAME_MAX = 28;
const WG_ATTACHMENT_NAME_SLICE = 26;
const WG_SESSION_ID_TAIL_LENGTH = 8;
const WG_MENTION_POOL_MAX = 6;
const WG_IMPORT_SEARCH_DEBOUNCE = 300;

// ── 模式定义 ──────────────────────────────────────────────────

  // 响应模式：控制 Agent 何时介入
  // 执行策略：控制 Agent 的自主裁决空间
  // ── 状态 ────────────────────────────────────────────────────


  // ── 拒绝派发的特殊输入状态 ─────────────────────────────────
  // 用户点击"拒绝"后，输入框进入预填充状态，
  // 必须发送消息才算有效拒绝；退格删除预填充内容则取消。


  // ── 按群聊隔离的输入缓存 ─────────────────────────────────────
  // chatId → { editorHtml, WgState.pendingLinks, WgState.pendingAttachments }

  // ── 按群聊隔离的 session 选择状态 ───────────────────────────
  // chatId → { identityRef → { mode: 'default'|'specific'|'new', sessionId, sessionTitle } }
  // 当前打开的 session dropdown 对应的 identityRef
  // session 数据缓存: identityRef → { pool, external, activeSessionId, sessionModel }

  // 运行时状态缓存: sessionId → { status, viewerAgentId, identityRef, displayName, workspaceId }

  // 滚动位置保持

  // ── API helpers ─────────────────────────────────────────────

  async function wgApiGet(path) {
    const res = await fetch(path);
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    return res.json();
  }

  async function wgApiPost(path, body) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    return res.json();
  }

  async function wgApiPut(path, body) {
    const res = await fetch(path, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    return res.json();
  }

  async function wgApiDelete(path) {
    const res = await fetch(path, { method: 'DELETE' });
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    return res.json();
  }

  // ── 数据加载 ─────────────────────────────────────────────────

  async function loadChatSummaries() {
    try {
      const data = await wgApiGet('/protoclaw/group_chats');
      WgState.chatSummaries = data.chats || [];
    } catch (err) {
      console.error('[WorkGroup] loadChatSummaries:', err);
      WgState.chatSummaries = [];
    }
  }

  async function loadActiveChat() {
    if (!WgState.activeChatId) return;
    try {
      WgState.activeChat = await wgApiGet(`/protoclaw/group_chats/${encodeURIComponent(WgState.activeChatId)}`);
      // 并行加载批注和管理员状态
      const [annData, adminData] = await Promise.allSettled([
        wgApiGet(`/protoclaw/group_chats/${encodeURIComponent(WgState.activeChatId)}/annotations`),
        wgApiGet(`/protoclaw/group_chats/${encodeURIComponent(WgState.activeChatId)}/admin_status`),
      ]);
      WgState._annotations = annData.status === 'fulfilled' ? (annData.value.annotations || {}) : {};
      WgState._adminStatus = adminData.status === 'fulfilled' ? adminData.value : null;
    } catch (err) {
      console.error('[WorkGroup] loadActiveChat:', err);
      WgState.activeChat = null;
      WgState._annotations = {};
      WgState._adminStatus = null;
    }
  }

  async function loadIdentities() {
    try {
      const data = await wgApiGet('/protoclaw/identities');
      WgState.identities = data.identities || [];
    } catch (err) {
      console.error('[WorkGroup] loadIdentities:', err);
      WgState.identities = [];
    }
  }

  // ── 工具函数 ────────────────────────────────────────────────

  function wgEsc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function wgFormatTime(ts) {
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

  function wgFormatCreateDate(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${mo}/${dd}`;
  }

  function wgExtractMdSummary(content) {
    if (!content) return '';
    return content.split('\n').map((l) => l.trim()).filter((l) => l).slice(0, 3).join('\n');
  }

  function getMemberName(chat, from) {
    if (from === 'user') return '我';
    const id = WgState.identities.find((i) => i.identityRef === from);
    return id ? id.displayName : from;
  }

  function getIdentityName(identityRef) {
    const id = WgState.identities.find((i) => i.identityRef === identityRef);
    return id ? id.displayName : identityRef;
  }

  // ── 生成式头像 ──────────────────────────────────────────────
  // 参考 Discord/GitHub 默认头像：首字母 + 基于 hash 的配色
  // 纯函数：name → { initials, color }

  // 高饱和、偏暗 — 作为 2px 边框在黑色底上醒目但不刺眼
  function _avatarInitials(name, identityRef) {
    if (identityRef === 'user') return '我';
    if (identityRef === 'work-group:admin') return '管';
    if (!name) return '?';
    return name.charAt(0).toUpperCase();
  }

  function generateAvatar(name, identityRef, seed) {
    const special = identityRef ? WG_AVATAR_SPECIAL_COLORS[identityRef] : null;
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
    const color = WG_AVATAR_COLORS[Math.abs(hash) % WG_AVATAR_COLORS.length];
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
    const isActive = chat.id === WgState.activeChatId;
    const av = generateAvatar(chat.name, null, chat.createdAt);
    const lm = chat.lastMessage;
    const preview = lm ? (lm.text || '').slice(0, 40) : '暂无消息';

    return [
      `<div class="wg-chat-item${isActive ? ' active' : ''}" data-wg-chat-id="${wgEsc(chat.id)}">`,
      `  <div class="wg-chat-avatar" style="--av-grad:${av.color}">${wgEsc(av.initials)}</div>`,
      '  <div class="wg-chat-info">',
      '    <div class="wg-chat-top">',
      `      <span class="wg-chat-name">${wgEsc(chat.name)}</span>`,
      `      <span class="wg-chat-time">${wgEsc(wgFormatTime(chat.updatedAt || chat.createdAt))}</span>`,
      '    </div>',
      `    <div class="wg-chat-preview">${wgEsc(preview)}</div>`,
      '  </div>',
      '</div>',
    ].join('');
  }

  function renderChatList() {
    const filtered = WgState.searchKeyword
      ? WgState.chatSummaries.filter((c) =>
          (c.name || '').toLowerCase().includes(WgState.searchKeyword.toLowerCase()))
      : WgState.chatSummaries;

    if (filtered.length === 0 && !WgState.searchKeyword) {
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
      const collapsed = WgState._archivedCollapsed && !WgState.searchKeyword;
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
    const initMode = WG_INITIATIVE_MODES.find((m) => m.value === initiative) || WG_INITIATIVE_MODES[0];
    const autoMode = WG_AUTONOMY_MODES.find((m) => m.value === autonomy) || WG_AUTONOMY_MODES[0];

    return [
      '<div class="wg-group-header">',
      `  <span class="wg-group-title">${wgEsc(chat.name)}</span>`,
      '  <div class="wg-mode-bar">',
      renderModeDropdown('initiative', initMode),
      renderModeDropdown('autonomy', autoMode),
      '  </div>',
      '</div>',
    ].join('');
  }

  function renderModeDropdown(type, currentMode) {
    const modes = type === 'initiative' ? WG_INITIATIVE_MODES : WG_AUTONOMY_MODES;
    const label = type === 'initiative' ? '响应模式' : '执行策略';

    const items = modes.map((m) => {
      const isSelected = m.value === currentMode.value;
      return [
        `<div class="wg-dropdown-item${isSelected ? ' selected' : ''}" data-wg-mode-type="${type}" data-wg-mode-value="${m.value}">`,
        '  <div class="wg-dropdown-item-content">',
        `    <span class="wg-dropdown-item-label">${wgEsc(m.label)}</span>`,
        `    <span class="wg-dropdown-item-desc">${wgEsc(m.desc)}</span>`,
        '  </div>',
        isSelected ? '  <span class="wg-dropdown-check"><svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg></span>' : '',
        '</div>',
      ].join('');
    }).join('');

    return [
      `<div class="wg-mode-dropdown${WgState.openDropdown === type ? ' open' : ''}" data-wg-dropdown="${type}">`,
      `  <button class="wg-mode-trigger" data-wg-action="toggle-dropdown" data-wg-dropdown-type="${type}">`,
      `    <span class="wg-mode-label">${wgEsc(label)}</span>`,
      `    <span class="wg-mode-sep">·</span>`,
      `    <span class="wg-mode-value">${wgEsc(currentMode.short || currentMode.label)}</span>`,
      '    <svg class="wg-mode-chevron" viewBox="0 0 24 24"><path d="M16.59 8.59L12 13.17 7.41 8.59 6 10l6 6 6-6z"/></svg>',
      '  </button>',
      `  <div class="wg-dropdown-menu">`,
      `    <div class="wg-dropdown-title">${wgEsc(label)}</div>`,
      items,
      `  </div>`,
      '</div>',
    ].join('');
  }

  // ── 右侧：管理员状态 chip（精简内联，集成到态势层） ──────────

  function renderAdminChip() {
    if (!WgState.activeChat) return '';

    const st = WgState._adminStatus;
    const restarting = WgState._adminRestarting;

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
      healthText ? `<span class="wg-admin-chip-health ${st.healthStatus}">${wgEsc(healthText)}</span>` : '',
      '</span>',
      `<button class="wg-admin-chip-btn${restarting ? ' spinning' : ''}" data-wg-action="admin-restart"`,
      restarting ? ' disabled' : '',
      ` title="${st?.sessionId ? '创建新管理员会话' : '启动管理员会话'}">${wgEsc(btnLabel)}</button>`,
      '</span>',
    ].join('');
  }

  // ── 右侧：态势层 ────────────────────────────────────────────

  /** 计算某个成员的聚合运行时状态 */
  function getMemberAggregateStatus(identityRef) {
    const memberSessions = Object.values(WgState._runtimeStatusCache).filter(
      (s) => s.identityRef === identityRef
    );
    if (memberSessions.some((s) => s.status === 'running')) return 'running';
    if (memberSessions.some((s) => s.status === 'idle')) return 'idle';
    return 'offline';
  }

  /**
   * 根据 WgState._runtimeStatusCache 中的实时运行时状态，解析派发消息的显示状态。
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
    if (sessionId && WgState._runtimeStatusCache[sessionId]) {
      var rtStatus = WgState._runtimeStatusCache[sessionId].status;
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

      // 工作线程数 badge
      const threadCount = (typeof window._wgGetThreadCount === 'function')
        ? window._wgGetThreadCount(identityRef)
        : 0;
      const badgeHtml = threadCount > 1
        ? `<span class="wg-thread-badge">${threadCount}</span>`
        : '';

      return [
        `<span class="wg-member-chip ${dotClass}" data-wg-member-identity="${wgEsc(identityRef)}">`,
        `  <span class="wg-member-dot ${dotClass}" title="${wgEsc(dotTitle)}"></span>`,
        `  <span class="wg-member-name">${wgEsc(name)}</span>`,
        badgeHtml,
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

    // task_completed: 不在消息流中渲染
    if (evt.type === 'task_completed') return '';

    // session_continued / session_archived: 薄分隔线
    if (evt.type === 'session_continued' || evt.type === 'session_archived') {
      return _renderEventDivider(evt);
    }

    // task_started: 保持卡片渲染
    if (evt.type !== 'task_started') return '';

    const name = evt.identityName || getMemberName(chat, msg.from);
    const time = wgFormatTime(msg.timestamp);
    const av = generateAvatar(name, msg.from);
    const navTarget = evt.workspaceId && evt.sessionId
      ? `${evt.workspaceId}:${evt.sessionId}` : null;
    const evtSessionBadge = evt.sessionTitle
      ? `<span class="wg-msg-session-badge">${wgEsc(evt.sessionTitle)}</span>` : '';

    const quoteAttrs = [
      `data-wg-quote-ref="${wgEsc(msg.from)}"`,
      evt.workspaceId ? `data-wg-quote-workspace="${wgEsc(evt.workspaceId)}"` : '',
      evt.sessionId ? `data-wg-quote-session="${wgEsc(evt.sessionId)}"` : '',
      evt.sessionTitle ? `data-wg-quote-title="${wgEsc(evt.sessionTitle)}"` : '',
      `data-wg-quote-name="${wgEsc(name)}"`,
    ].filter(Boolean).join(' ');

    return [
      `<div class="wg-msg-row" data-wg-msg-id="${wgEsc(msg.id || '')}" ${quoteAttrs}>`,
      `  <div class="wg-msg-avatar" style="--av-grad:${av.color}">${wgEsc(av.initials)}</div>`,
      '  <div class="wg-msg-body">',
      `    <div class="wg-msg-meta"><span class="wg-msg-identity">${wgEsc(name)}</span>${evtSessionBadge} <span class="wg-msg-time">${wgEsc(time)}</span></div>`,
      '    <div class="wg-card">',
      '      <div class="wg-card-header">',
      '        <span class="wg-card-dot active"></span>',
      '        <span class="wg-card-title">已开始处理</span>',
      '      </div>',
      '      <div class="wg-card-body">',
      evt.sessionTitle
        ? `        <span class="wg-card-session-tag">${wgEsc(evt.sessionTitle)}</span>`
        : `        <span class="wg-card-value">${wgEsc(evt.sessionId ? evt.sessionId.slice(0, 12) : '—')}</span>`,
      navTarget
        ? `        <span class="wg-card-link" data-wg-session-nav="${wgEsc(navTarget)}">查看会话</span>`
        : '',
      '      </div>',
      '    </div>',
      '  </div>',
      '</div>',
    ].join('');
  }

  /**
   * 渲染生命周期事件分隔线（session_continued / session_archived）。
   */
  function _renderEventDivider(evt) {
    const name = evt.identityName || '';
    let text = '';
    let navTarget = '';

    if (evt.type === 'session_continued') {
      const reasonLabel = _getEventReasonLabel(evt.reason);
      const cutInfo = evt.trimCutRounds != null ? ` ${evt.trimCutRounds} 轮` : '';
      const fromLabel = evt.fromSessionTitle || _shortSessionLabel(evt.fromSessionId);
      const toLabel = evt.sessionTitle || _shortSessionLabel(evt.toSessionId || evt.sessionId);
      text = `${name} ·「${fromLabel}」${reasonLabel}${cutInfo}，已续接到「${toLabel}」`;
      if (evt.workspaceId && (evt.toSessionId || evt.sessionId)) {
        navTarget = `${evt.workspaceId}:${evt.toSessionId || evt.sessionId}`;
      }
    } else if (evt.type === 'session_archived') {
      const sessionLabel = evt.sessionTitle || _shortSessionLabel(evt.sessionId);
      text = `${name} ·「${sessionLabel}」已归档`;
    }

    if (!text) return '';

    return [
      `<div class="wg-event-divider${navTarget ? ' is-clickable' : ''}"${navTarget ? ` data-wg-session-nav="${wgEsc(navTarget)}" title="查看后续会话"` : ''}>`,
      '  <span class="wg-event-divider-line"></span>',
      `  <span class="wg-event-divider-text">${wgEsc(text)}</span>`,
      '  <span class="wg-event-divider-line"></span>',
      '</div>',
    ].join('');
  }

  function _shortSessionLabel(sessionId) {
    const shortId = String(sessionId || '').slice(-8);
    return shortId ? `会话 #${shortId}` : '未命名会话';
  }

  /**
   * 将血缘转换 reason 转为可读标签（用于事件分隔线）。
   */
  function _getEventReasonLabel(reason) {
    var labels = {
      trim: '会话精简',
      compact: '上下文压缩',
      summary: '摘要导出',
      branch: '会话分支',
    };
    return labels[reason] || '会话转换';
  }

  // ── 右侧：派发卡片（管理员派遣任务） ─────────────────────────

  function renderDispatchCard(chat, msg) {
    const time = wgFormatTime(msg.timestamp);
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
          `data-wg-quote-ref="${wgEsc(targetRef)}"`,
          `data-wg-quote-workspace="${wgEsc(routing.targetWorkspaceId)}"`,
          routing.targetSessionId ? `data-wg-quote-session="${wgEsc(routing.targetSessionId)}"` : '',
          routing.targetSessionTitle ? `data-wg-quote-title="${wgEsc(routing.targetSessionTitle)}"` : '',
          `data-wg-quote-name="${wgEsc(targetName)}"`,
        ].filter(Boolean).join(' ')
      : '';

    return [
      `<div class="wg-msg-row" data-wg-msg-id="${wgEsc(msg.id || '')}" ${quoteAttrs}>`,
      `  <div class="wg-msg-avatar" style="--av-grad:${fromAv.color}">${wgEsc(fromAv.initials)}</div>`,
      '  <div class="wg-msg-body">',
      `    <div class="wg-msg-meta"><span class="wg-msg-identity">${wgEsc(fromName)}</span> <span class="wg-msg-time">${wgEsc(time)}</span></div>`,
      '    <div class="wg-card dispatch">',
      '      <div class="wg-card-header">',
      `        <span class="wg-card-mention-from">${wgEsc(fromName)}</span>`,
      '        <span class="wg-card-mention-at">@</span>',
      `        <span class="wg-card-mention-to">${wgEsc(targetName)}</span>`,
      '      </div>',
      `      <div class="wg-card-body markdown-body">${renderMarkdown(msg.text || '')}</div>`,
      '      <div class="wg-card-footer">',
      `        <span class="wg-card-status"><span class="wg-card-dot ${displayStatus === 'completed' ? '' : 'active'}"></span>${displayStatus === 'completed' ? '已完成' : displayStatus === 'failed' ? '失败' : '进行中'}</span>`,
      sessionLabel
        ? `        <span class="wg-card-session-tag">${wgEsc(sessionLabel)}</span>`
        : '',
      navTarget
        ? `        <span class="wg-card-link" data-wg-session-nav="${wgEsc(navTarget)}">查看会话</span>`
        : '',
      '      </div>',
      '    </div>',
      '  </div>',
      '</div>',
    ].join('');
  }

  function renderDispatchPendingCard(chat, msg) {
    const time = wgFormatTime(msg.timestamp);
    const fromName = getMemberName(chat, msg.from);
    const fromAv = generateAvatar(fromName, msg.from);
    const targetRef = msg.mentions?.[0]?.identityRef || msg.routing?.targetIdentityRef;
    const targetName = targetRef ? getIdentityName(targetRef) : '';
    const approval = msg.approval || { status: 'pending' };
    const routing = msg.routing || {};
    const sessionLabel = routing.targetSessionTitle || null;
    const navTarget = routing.targetWorkspaceId && routing.targetSessionId
      ? `${routing.targetWorkspaceId}:${routing.targetSessionId}` : null;

    // 会话信息行（pending 和 approved 都显示）
    function sessionInfoHtml() {
      if (!sessionLabel && !navTarget) return '';
      const tag = sessionLabel ? `<span class="wg-card-session-tag">${wgEsc(sessionLabel)}</span>` : '';
      const link = navTarget ? `<span class="wg-card-link" data-wg-session-nav="${wgEsc(navTarget)}">查看会话</span>` : '';
      return `${tag}${link}`;
    }

    // 审批状态对应的展示
    let statusHtml = '';
    let cardClass = 'dispatch-pending';
    let headerTag = '<span class="wg-card-pending-tag">待审批</span>';

    if (approval.status === 'pending') {
      cardClass = 'dispatch-pending';
      statusHtml = [
        '      <div class="wg-card-actions">',
        `        <button class="wg-approve-btn" data-wg-action="approve-dispatch" data-wg-dispatch-id="${wgEsc(msg.id)}">批准</button>`,
        `        <button class="wg-reject-btn" data-wg-action="reject-dispatch" data-wg-dispatch-id="${wgEsc(msg.id)}" data-wg-dispatch-text="${wgEsc((msg.text || '').slice(0, 100))}" data-wg-dispatch-target="${wgEsc(targetName)}">拒绝</button>`,
        sessionInfoHtml(),
        '      </div>',
      ].join('');
    } else if (approval.status === 'approved') {
      cardClass = 'dispatch-resolved approved';
      headerTag = '';
      statusHtml = [
        '      <div class="wg-card-footer">',
        '        <span class="wg-card-status approved"><span class="wg-card-dot"></span>已批准</span>',
        sessionInfoHtml(),
        '      </div>',
      ].join('');
    } else if (approval.status === 'rejected') {
      cardClass = 'dispatch-resolved rejected';
      headerTag = '';
      statusHtml = [
        '      <div class="wg-card-footer">',
        '        <span class="wg-card-status rejected"><span class="wg-card-dot"></span>已拒绝</span>',
        '      </div>',
      ].join('');
    }

    return [
      `<div class="wg-msg-row" data-wg-msg-id="${wgEsc(msg.id || '')}">`,
      `  <div class="wg-msg-avatar" style="--av-grad:${fromAv.color}">${wgEsc(fromAv.initials)}</div>`,
      '  <div class="wg-msg-body">',
      `    <div class="wg-msg-meta"><span class="wg-msg-identity">${wgEsc(fromName)}</span> <span class="wg-msg-time">${wgEsc(time)}</span></div>`,
      `    <div class="wg-card ${cardClass}">`,
      '      <div class="wg-card-header">',
      `        <span class="wg-card-mention-from">${wgEsc(fromName)}</span>`,
      '        <span class="wg-card-mention-at">@</span>',
      `        <span class="wg-card-mention-to">${wgEsc(targetName)}</span>`,
      headerTag,
      '      </div>',
      `      <div class="wg-card-body markdown-body">${renderMarkdown(msg.text || '')}</div>`,
      statusHtml,
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
    // 待审批派发卡片 — 规划模式下需要人工审批
    if (msg.kind === 'dispatch_pending') {
      return renderDispatchPendingCard(chat, msg);
    }

    const isMe = msg.from === 'user';
    const isSummary = msg.kind === 'summary';
    const isAdmin = msg.from === 'work-group:admin' || msg.from === 'work-group-admin:admin';
    const name = getMemberName(chat, msg.from);
    const time = wgFormatTime(msg.timestamp);

    // dispatch 状态（用户消息的派发状态，替代旧的 routing badge）
    // 使用 resolveDispatchDisplayStatus 从 runtime_status 实时数据解析，
    // 与态势感知面板同一数据源，避免旧版 routing.status 误标 failed 的问题。
    let dispatchHtml = '';
    if (isMe && msg.routing) {
      const status = resolveDispatchDisplayStatus(msg.routing);
      const statusText = WG_DISPATCH_STATUS_TEXT[status] || status;
      const targetName = msg.routing.targetIdentityRef
        ? getIdentityName(msg.routing.targetIdentityRef) : '';
      const navTarget = msg.routing.targetWorkspaceId && msg.routing.targetSessionId
        ? `${msg.routing.targetWorkspaceId}:${msg.routing.targetSessionId}` : null;

      dispatchHtml = [
        '<div class="wg-msg-dispatch">',
        `  <span class="wg-dispatch-status ${status}">`,
        '    <span class="wg-session-dot"></span>',
        `    ${wgEsc(statusText)}`,
        '  </span>',
        targetName ? `<span class="wg-dispatch-text">${wgEsc(targetName)}</span>` : '',
        navTarget
          ? `<span class="wg-dispatch-link" data-wg-session-nav="${wgEsc(navTarget)}">查看会话</span>`
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
        `<span class="wg-session-link-tag" data-wg-session-nav="${wgEsc(navTarget)}" title="点击跳转到会话">`,
        `  <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`,
        `  ${wgEsc(sessionLabel)}`,
        '</span>',
      ].join('');
    }

    // 身份标签（非用户消息）+ 会话标识 badge
    // 同一身份可能同时有多个会话，用 session badge 区分来源
    const sessionBadge = (!isMe && !isSummary && msg.routing?.targetSessionTitle)
      ? `<span class="wg-msg-session-badge">${wgEsc(msg.routing.targetSessionTitle)}</span>` : '';
    const identityTag = (!isMe && !isSummary && msg.from && msg.from !== 'user')
      ? `<span class="wg-msg-identity">${wgEsc(name)}</span>${sessionBadge}` : '';

    // 链接引用
    const linksHtml = (Array.isArray(msg.links) && msg.links.length > 0)
      ? '<div class="wg-msg-links">' + msg.links.map((l) => {
          return `<a href="${wgEsc(l.url)}" target="_blank" class="wg-msg-link">${wgEsc(l.description || l.url)}</a>`;
        }).join('') + '</div>'
      : '';

    // 附件标签（点击可在文档面板打开）
    const attachmentsHtml = (Array.isArray(msg.attachments) && msg.attachments.length > 0)
      ? '<div class="wg-msg-attachments">' + msg.attachments.map((a) => {
          return `<span class="wg-msg-attachment-tag clickable" data-wg-attachment-open="${wgEsc(a.name)}" title="${wgEsc(a.name)} — 点击在文档面板打开">${wgEsc(a.name)}</span>`;
        }).join('') + '</div>'
      : '';

    const av = generateAvatar(name, msg.from);
    const bubbleClass = isSummary ? ' summary' : (isAdmin ? ' admin' : '');

    if (isMe) {
      return [
        `<div class="wg-msg-row me" data-wg-msg-id="${wgEsc(msg.id || '')}">`,
        '  <div class="wg-msg-body">',
        `    <div class="wg-msg-meta"><span class="wg-msg-time">${wgEsc(time)}</span></div>`,
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
          `data-wg-quote-ref="${wgEsc(msg.from)}"`,
          hasRouting ? `data-wg-quote-workspace="${wgEsc(msg.routing.targetWorkspaceId)}"` : '',
          hasRouting ? `data-wg-quote-session="${wgEsc(msg.routing.targetSessionId)}"` : '',
          hasRouting && msg.routing.targetSessionTitle ? `data-wg-quote-title="${wgEsc(msg.routing.targetSessionTitle)}"` : '',
          `data-wg-quote-name="${wgEsc(name)}"`,
        ].filter(Boolean).join(' ')
      : '';

    return [
      `<div class="wg-msg-row" data-wg-msg-id="${wgEsc(msg.id || '')}" ${quoteAttrs}>`,
      `  <div class="wg-msg-avatar" style="--av-grad:${av.color}">${wgEsc(av.initials)}</div>`,
      '  <div class="wg-msg-body">',
      `    <div class="wg-msg-meta">${identityTag} <span class="wg-msg-time">${wgEsc(time)}</span></div>`,
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
      const needsCollapse = el.scrollHeight > WG_COLLAPSE_THRESHOLD;

      if (!needsCollapse) {
        // 不需要折叠，移除类并恢复样式
        el.classList.remove('wg-collapsible');
        el.style.visibility = originalVisibility;
        el.style.position = originalPosition;
        return;
      }

      // 需要折叠
      el.dataset.wgCollapseInit = '1';
      const isExpanded = WgState._expandedMsgIds.has(msgId);
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
          WgState._expandedMsgIds.delete(msgId);
        } else {
          WgState._expandedMsgIds.add(msgId);
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

  // ── 成员头像网格（微信/QQ 风格） ───────────────────────────

  // renderAddMemberControl 已被头像网格中的「+」按钮 + 弹窗替代
  // ── GROUP.md 只读卡片 + 群资料库入口 ──────────────────────────

  // ── 管理员配置折叠区内容（模式设置 + 记忆 + 模型） ───────────

  // ── 右侧：空状态 ────────────────────────────────────────────

  function renderEmptyConversation() {
    return '<div class="wg-conversation-empty"><p>选择一个群聊开始工作</p></div>';
  }

  // ── 右侧：整体渲染 ──────────────────────────────────────────

  function renderConversation() {
    if (!WgState.activeChatId) return renderEmptyConversation();
    if (!WgState.activeChat) return '<div class="wg-conversation-empty"><p>加载中</p></div>';

    return [
      '<div class="wg-conversation">',
      renderGroupHeader(WgState.activeChat),
      renderAwarenessBar(WgState.activeChat),
      '<div class="wg-msg-scroll">' + renderMessageList(WgState.activeChat) + '</div>',
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
      WgState._savedMsgScrollTop = existingScroll.scrollTop; // 兼容其他路径
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
      '<div class="wg-app' + (WgState._sidebarCollapsed ? ' sidebar-collapsed' : '') + '">',
      '  <div class="wg-sidebar">',
      '    <div class="wg-sidebar-header">',
      '      <input type="text" class="wg-search-input" placeholder="搜索群聊" data-wg-role="search" value="' + wgEsc(WgState.searchKeyword) + '">',
      '      <button class="wg-new-chat-btn" data-wg-action="new-chat" title="新建群聊">',
      '        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>',
      '      </button>',
      '    </div>',
      '    <div class="wg-chat-list" data-wg-role="chat-list">' + renderChatList() + '</div>',
      '  </div>',
      '  <button class="wg-sidebar-toggle" data-wg-action="toggle-sidebar" title="' + (WgState._sidebarCollapsed ? '展开群聊列表' : '收起群聊列表') + '">',
      '    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5"><path d="' + (WgState._sidebarCollapsed ? 'M9 18l6-6-6-6' : 'M15 18l-6-6 6-6') + '"/></svg>',
      '  </button>',
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
        WgState._suppressScrollEvent = true;
        if (WgState._shouldScrollToBottom) {
          WgState._shouldScrollToBottom = false;
          newScroll.scrollTop = newScroll.scrollHeight;
        } else if (scrollExistsInDom) {
          newScroll.scrollTop = newScroll.scrollHeight - savedOffsetFromBottom;
        } else {
          newScroll.scrollTop = newScroll.scrollHeight;
        }
        WgState._suppressScrollEvent = false;
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
      // DOM 重建后恢复附件列表和链接列表（WgState.pendingAttachments/WgState.pendingLinks 是模块级变量，不会因重渲染丢失）
      renderAttachmentList();
      renderLinkList();
      // 恢复 session bar（WgState._chatSessionSelection 是模块级变量，不会被重渲染清除）
      renderSessionBar();

      // 恢复滚动位置（DOM 重建后）
      const newScroll = main.querySelector('.wg-msg-scroll');
      if (newScroll) {
        WgState._suppressScrollEvent = true;
        if (WgState._shouldScrollToBottom) {
          WgState._shouldScrollToBottom = false;
          newScroll.scrollTop = newScroll.scrollHeight;
        } else if (scrollExists) {
          newScroll.scrollTop = newScroll.scrollHeight - offsetFromBottom;
        } else {
          // 退出再进入场景：滚动到底部
          newScroll.scrollTop = newScroll.scrollHeight;
        }
        WgState._suppressScrollEvent = false;
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

    scroll.innerHTML = renderMessageList(WgState.activeChat);
    if (typeof enhanceMathInElement === 'function') enhanceMathInElement(scroll);

    // 先完成所有会修改 scrollHeight 的 DOM 操作，再恢复滚动位置
    applyCollapsible(scroll);
    _renderAnnotationBars();

    // 现在 scrollHeight 已经稳定，恢复滚动位置
    // 抑制 scroll 事件，防止程序触发的 scrollTop 被误判为用户手动滚动
    WgState._suppressScrollEvent = true;
    if (WgState._shouldScrollToBottom) {
      WgState._shouldScrollToBottom = false;
      scroll.scrollTop = scroll.scrollHeight;
    } else if (nearBottom && !WgState._userScrolling) {
      scroll.scrollTop = scroll.scrollHeight;
    } else {
      scroll.scrollTop = scroll.scrollHeight - offsetFromBottom;
    }
    WgState._suppressScrollEvent = false;

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
      newHeader.innerHTML = renderGroupHeader(WgState.activeChat);
      const replacement = newHeader.firstElementChild;
      if (replacement) header.replaceWith(replacement);
    }

    const awareness = conv.querySelector('.wg-awareness');
    if (awareness) {
      // popover 正在显示时不替换 awareness DOM，避免 anchor chip 被销毁导致 popover 失效
      if (WgState._popoverEl && WgState._hoverIdentity) {
        _updateAwarenessDotsInPlace(awareness);
      } else {
        const newAwareness = document.createElement('div');
        newAwareness.innerHTML = renderAwarenessBar(WgState.activeChat);
        const replacement = newAwareness.firstElementChild;
        if (replacement) awareness.replaceWith(replacement);
      }
    }

    const scroll = conv.querySelector('.wg-msg-scroll');
    if (scroll) {
      const offsetFromBottom = scroll.scrollHeight - scroll.scrollTop;
      const nearBottom = offsetFromBottom - scroll.clientHeight < 80;

      const originalVisibility = scroll.style.visibility;
      scroll.style.visibility = 'hidden';

      scroll.innerHTML = renderMessageList(WgState.activeChat);
      if (typeof enhanceMathInElement === 'function') enhanceMathInElement(scroll);

      // 先完成所有会修改 scrollHeight 的 DOM 操作，再恢复滚动位置
      applyCollapsible(scroll);
      _renderAnnotationBars();

      // 现在 scrollHeight 已经稳定，恢复滚动位置
      WgState._suppressScrollEvent = true;
      if (WgState._shouldScrollToBottom) {
        WgState._shouldScrollToBottom = false;
        scroll.scrollTop = scroll.scrollHeight;
      } else if (nearBottom && !WgState._userScrolling) {
        scroll.scrollTop = scroll.scrollHeight;
      } else {
        scroll.scrollTop = scroll.scrollHeight - offsetFromBottom;
      }
      WgState._suppressScrollEvent = false;

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
    if (WgState._popoverEl && WgState._hoverIdentity) {
      _updateAwarenessDotsInPlace(awareness);
      // 同时刷新 popover 内容（更新会话运行时状态）
      _refreshPopoverIfOpen();
      return;
    }

    const newEl = document.createElement('div');
    newEl.innerHTML = renderAwarenessBar(WgState.activeChat);
    const replacement = newEl.firstElementChild;
    if (replacement) awareness.replaceWith(replacement);

    // 如果 hover timer 正在等待（120ms 窗口内），原来的 anchor chip 已被销毁。
    // 在新 DOM 中重新找到对应 chip 并重新绑定 timer。
    if (WgState._hoverIdentity) {
      const newChip = replacement.querySelector(
        `[data-wg-member-identity="${CSS.escape(WgState._hoverIdentity)}"]`
      );
      if (newChip) {
        clearTimeout(WgState._hoverTimer);
        const pendingId = WgState._hoverIdentity;
        WgState._hoverTimer = setTimeout(() => {
          if (WgState._hoverIdentity === pendingId) showMemberPopover(pendingId, newChip);
        }, 120);
      }
    }
  }

  /** 原地更新态势栏中各 chip 的状态点，不替换 DOM 元素 */
  /** 如果 popover 正打开，刷新其会话列表内容（不重建 popover 容器） */
  function scrollToBottom() {
    const scroll = document.querySelector('.wg-msg-scroll');
    if (scroll) {
      WgState._suppressScrollEvent = true;
      scroll.scrollTop = scroll.scrollHeight;
      WgState._suppressScrollEvent = false;
    }
  }

  // ── 轮询 ────────────────────────────────────────────────────

  /**
   * 拉取群聊成员的运行时状态（running / idle / offline）。
   * 与主轮询同步执行，更新 WgState._runtimeStatusCache 后刷新态势层。
   */
  async function fetchRuntimeStatus() {
    if (!WgState.activeChatId) return;
    try {
      const data = await wgApiGet(
        `/protoclaw/gc/runtime_status?chatId=${encodeURIComponent(WgState.activeChatId)}`
      );
      const map = {};
      for (const s of (data.sessions || [])) {
        map[s.sessionId] = s;
      }
      WgState._runtimeStatusCache = map;
    } catch (err) {
      // 静默失败，不阻断轮询
    }
  }

  function startPolling() {
    stopPolling();
    WgState._pollingActive = true;

    // 长轮询：等待群聊数据变更（新消息、routing 更新等）
    _pollCycle();

    // 独立定时器：刷新运行时状态（running/idle 指示灯），不影响消息延迟
    WgState._runtimeTimer = setInterval(async () => {
      if (WgState.activeChatId && !WgState.isLoading) {
        await fetchRuntimeStatus();
        refreshAdminBarOnly();
      }
    }, 5000);
  }

  function stopPolling() {
    WgState._pollingActive = false;
    if (WgState.pollTimer) {
      clearTimeout(WgState.pollTimer);
      WgState.pollTimer = null;
    }
    if (WgState._runtimeTimer) {
      clearInterval(WgState._runtimeTimer);
      WgState._runtimeTimer = null;
    }
    if (WgState._pollAbortController) {
      WgState._pollAbortController.abort();
      WgState._pollAbortController = null;
    }
  }

  /**
   * 长轮询循环：向 /updates 端点发起请求，服务端在群聊有变更时立即返回。
   * 收到更新后拉取 annotations + admin_status 并刷新消息列表。
   * 超时（25s 无变更）后自动重新发起下一轮。
   */
  async function _pollCycle() {
    if (!WgState._pollingActive) return;

    // 正在加载或无活跃群聊时，短暂等待后重试
    if (!WgState.activeChatId || WgState.isLoading) {
      WgState.pollTimer = setTimeout(_pollCycle, 1000);
      return;
    }

    try {
      const since = (WgState.activeChat && WgState.activeChat.updatedAt) || 0;
      const chatId = encodeURIComponent(WgState.activeChatId);
      const url = `/protoclaw/group_chats/${chatId}/updates?since=${since}&timeout=25`;

      WgState._pollAbortController = new AbortController();
      const res = await fetch(url, { signal: WgState._pollAbortController.signal });

      if (!WgState._pollingActive) return;

      if (res.ok) {
        const data = await res.json();
        if (data.updated && data.chat) {
          // 守卫：等待期间可能切换了群聊，丢弃过期响应
          if (data.chat.id !== WgState.activeChatId) {
            // 直接进入下一轮，用新 chatId 发起
          } else {
            WgState.activeChat = data.chat;
            // 并行拉取批注和管理员状态
            const [annData, adminData] = await Promise.allSettled([
              wgApiGet(`/protoclaw/group_chats/${chatId}/annotations`),
              wgApiGet(`/protoclaw/group_chats/${chatId}/admin_status`),
            ]);
            WgState._annotations = annData.status === 'fulfilled' ? (annData.value.annotations || {}) : {};
            WgState._adminStatus = adminData.status === 'fulfilled' ? adminData.value : null;
            refreshMessagesOnly();
            refreshAdminBarOnly();
            // 同步刷新工作面板（如果打开）
            if (window._wgThreadsReload) window._wgThreadsReload();
          }
        }
        // data.updated === false → 超时无变更，直接进入下一轮
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.error('[WorkGroup] long-poll error:', err);
      }
      // AbortError 不 return：selectChat 切换群聊时会 abort 旧请求，
      // 但 _pollingActive 仍为 true，需要继续下一轮（使用新 chatId）。
      // stopPolling 会先设 _pollingActive=false 再 abort，底部检查会正确跳过。
    }

    // 继续下一轮长轮询
    if (WgState._pollingActive) {
      WgState.pollTimer = setTimeout(_pollCycle, 500);
    }
  }

  // ── 输入缓存 save/load ────────────────────────────────────────

  function _saveCurrentDraft(chatId) {
    if (!chatId) return;
    const editor = document.querySelector('.wg-input-editor');
    const html = editor ? editor.innerHTML : '';
    WgState._chatInputCache[chatId] = {
      editorHtml: html,
      pendingLinks: WgState.pendingLinks.slice(),
      pendingAttachments: WgState.pendingAttachments.slice(),
    };
  }

  function _loadDraft(chatId) {
    const cached = WgState._chatInputCache[chatId];
    if (cached) {
      WgState.pendingLinks = cached.pendingLinks.slice();
      WgState.pendingAttachments = cached.pendingAttachments.slice();
    } else {
      WgState.pendingLinks = [];
      WgState.pendingAttachments = [];
    }
  }

  function _restoreEditorFromDraft(chatId) {
    const cached = WgState._chatInputCache[chatId];
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
    if (WgState.activeChatId) _saveCurrentDraft(WgState.activeChatId);

    // 中止正在进行的 long-poll（针对旧群聊），下一轮自动使用新 chatId
    if (WgState._pollAbortController) {
      WgState._pollAbortController.abort();
      WgState._pollAbortController = null;
    }

    WgState.activeChatId = chatId;
    WgState.viewMode = 'chat';
    WgState.activeChat = null;
    WgState.openDropdown = null;
    WgState._adminStatus = null;
    WgState._adminRestarting = false;
    // 清除跨群聊缓存，防止上一个群的会话数据泄漏到新群
    WgState._runtimeStatusCache = {};
    WgState._sessionDataCache = {};
    // 清理工作面板缓存
    if (window._wgThreadsCleanup) window._wgThreadsCleanup();
    hideMemberPopover(true);
    closeImportModal();
    closeAddMemberModal();
    // 清除拒绝派发状态
    WgState._rejectDispatchId = null;
    WgState._rejectPrefillText = '';
    WgState._shouldScrollToBottom = true;
    refreshChatList();

    // 加载目标群聊的草稿
    _loadDraft(chatId);

    refreshMain();
    await loadActiveChat();
    await fetchRuntimeStatus();
    // 首次进入群聊即准备线程摘要，不要求用户先打开工作面板。
    if (window._wgThreadsReload) window._wgThreadsReload();
    WgState._shouldScrollToBottom = true;
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
    if (typeof activeFeaturePanel !== 'undefined' && activeFeaturePanel === 'settings') {
      if (typeof window._wgSettingsInit === 'function') {
      } else if (typeof window._wgSettingsRefresh === 'function') {
      }
    }
  }

  async function handleAdminRestart() {
    if (!WgState.activeChatId || WgState._adminRestarting) return;
    WgState._adminRestarting = true;
    refreshAdminBarOnly();
    try {
      WgState._adminStatus = await wgApiPost(
        `/protoclaw/group_chats/${encodeURIComponent(WgState.activeChatId)}/admin_restart`
      );
    } catch (err) {
      console.error('[WorkGroup] admin restart failed:', err);
    } finally {
      WgState._adminRestarting = false;
      refreshAdminBarOnly();
    }
  }


  /**
   * 渲染 popover 中的会话列表（群内会话池）。
   * 每个会话显示运行时状态（running/idle/offline）+ 可选的中断按钮。
   * 被 showMemberPopover 和 _refreshPopoverIfOpen 共用。
   */
  /**
   * 格式化会话创建时间为 "MM-DD HH:MM"
   */
  /**
   * 渲染管理员 popover 内容（活跃会话跳转 + 历史会话记录）。
   * 活跃会话在顶部显示一个跳转按钮，不在历史列表中重复出现。
   * 历史会话以只读方式打开，名称使用创建时间。
   * 返回 { activeHtml, historyHtml, historyCount }
   */

  async function handleSend() {
    // 如果正在录音，停止录音并设置自动发送标志
    if (WgState._voiceRecording) {
      WgState._voicePendingSend = true;
      wgStopVoiceRecording();
      return;
    }

    // 如果正在转写，忽略发送请求
    if (WgState._voiceTranscribing) return;

    const editor = document.querySelector('.wg-input-editor');
    if (!editor) return;
    const text = editor.textContent.trim();
    if (!text || !WgState.activeChatId) return;

    // 解析 @mentions（带 session 选择）
    const mentions = [];
    const chatSel = WgState._chatSessionSelection[WgState.activeChatId] || {};
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
    delete WgState._chatInputCache[WgState.activeChatId];
    // 清空 session 选择状态（下次 @mention 重新选择）
    WgState._openSessionDropdown = null;

    const links = WgState.pendingLinks.slice();
    WgState.pendingLinks = [];
    renderLinkList();

    const attachments = WgState.pendingAttachments.slice();
    WgState.pendingAttachments = [];
    renderAttachmentList();

    try {
      await wgApiPost(`/protoclaw/group_chats/${encodeURIComponent(WgState.activeChatId)}/messages`, {
        text,
        mentions,
        links: links.length > 0 ? links : undefined,
        attachments: attachments.length > 0 ? attachments : undefined,
        rejectDispatchId: WgState._rejectDispatchId || undefined,
      });
      // 清除拒绝派发状态
      WgState._rejectDispatchId = null;
      WgState._rejectPrefillText = '';
      updateRejectInputVisual();
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

  // ── 派发审批：批准 ──────────────────────────────────────────

  async function handleApproveDispatch(dispatchId) {
    if (!WgState.activeChatId || !dispatchId) return;
    try {
      await wgApiPost('/protoclaw/gc/dispatch/approve', {
        chatId: WgState.activeChatId,
        messageId: dispatchId,
      });
      await loadActiveChat();
      refreshHeaderAndMessages();
    } catch (err) {
      console.error('[WorkGroup] approve dispatch failed:', err);
    }
  }

  // ── 派发审批：拒绝（进入特殊输入状态）──────────────────────────

  function enterRejectDispatchState(dispatchId) {
    if (!dispatchId) return;
    WgState._rejectDispatchId = dispatchId;
    // 获取管理员显示名（确保 @mention 解析正确）
    const adminId = WgState.identities.find((i) => i.identityRef === 'work-group:admin');
    const adminName = adminId?.displayName || '管理员';
    // 锚点：仅 @管理员 本身，用于 startsWith 判断
    WgState._rejectPrefillText = `@${adminName}`;

    const editor = document.querySelector('.wg-input-editor');
    if (editor) {
      editor.focus();
      // 用 \u00A0（不间断空格）确保尾部空格可见且不被 contenteditable 吞掉
      editor.textContent = `@${adminName}\u00A0`;
      // 将光标移到末尾
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    }
    updateRejectInputVisual();
  }

  function exitRejectDispatchState() {
    WgState._rejectDispatchId = null;
    WgState._rejectPrefillText = '';
    updateRejectInputVisual();
  }

  function updateRejectInputVisual() {
    const container = document.querySelector('.wg-input-area');
    if (!container) return;
    if (WgState._rejectDispatchId) {
      container.classList.add('reject-mode');
    } else {
      container.classList.remove('reject-mode');
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
    WgState._mentionTarget = null;
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
        `<div class="wg-mention-item" data-wg-mention="${wgEsc(id.identityRef)}">`,
        `  <span class="wg-mention-dot${isAdmin ? ' admin' : ''}"></span>`,
        `  <span class="wg-mention-name">${wgEsc(id.displayName)}</span>`,
        hasArrow ? `  <svg class="wg-mention-arrow" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>` : '',
        '</div>',
      ].join('');
    }).join('');

    picker.innerHTML = `<div class="wg-mention-level1">${items}</div>`;
    picker.style.display = 'block';
    WgState._mentionTarget = null;
  }

  function showMentionLevel2(identityRef) {
    const picker = document.querySelector('[data-wg-role="mention-picker"]');
    if (!picker) return;
    const id = WgState.identities.find((i) => i.identityRef === identityRef);
    if (!id) return;

    // 懒加载 session 数据
    if (!WgState._sessionDataCache[identityRef] && WgState.activeChatId) {
      fetchSessionData(identityRef).then(() => showMentionLevel2(identityRef));
      picker.innerHTML = '<div class="wg-mention-loading">加载中...</div>';
      picker.style.display = 'block';
      return;
    }

    const data = WgState._sessionDataCache[identityRef];
    const sel = WgState.activeChatId ? getSessionSelection(WgState.activeChatId, identityRef) : { mode: 'default' };
    const poolSessions = (data?.inChatSessions || []).slice(0, 6);

    const sessionItems = poolSessions.map((s) => {
      const selected = sel.mode === 'specific' && sel.sessionId === s.id;
      return [
        `<div class="wg-mention-session-item${selected ? ' selected' : ''}" data-wg-mention-session="${wgEsc(s.id)}" data-wg-mention-title="${wgEsc(s.title)}">`,
        `  <span class="wg-mention-session-dot${s.isActive ? ' active' : ''}"></span>`,
        `  <span class="wg-mention-session-title">${wgEsc(s.title)}</span>`,
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
      `  <span>${wgEsc(id.displayName)}</span>`,
      '</div>',
      `<div class="wg-mention-actions">${modeItems}</div>`,
      sessionItems
        ? `<div class="wg-mention-section"><div class="wg-mention-section-label">会话池</div>${sessionItems}</div>`
        : '',
    ].join('');
    picker.style.display = 'block';
    WgState._mentionTarget = identityRef;
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
    const id = WgState.identities.find((i) => i.identityRef === identityRef);
    if (!id) return;
    _doInsertMention(id.displayName);
    hideMentionPicker();
    if (!WgState._sessionDataCache[identityRef]) {
      fetchSessionData(identityRef);
    }
    renderSessionBar();
  }

  function insertMentionWithSession(identityRef, mode, sessionId, sessionTitle) {
    const id = WgState.identities.find((i) => i.identityRef === identityRef);
    if (!id) return;
    const editor = document.querySelector('.wg-input-editor');
    if (!(editor?.textContent || '').includes(`@${id.displayName}`)) {
      _doInsertMention(id.displayName);
    }

    if (WgState.activeChatId) {
      if (mode === 'new') {
        setSessionSelection(WgState.activeChatId, identityRef, { mode: 'new' });
      } else if (mode === 'specific') {
        setSessionSelection(WgState.activeChatId, identityRef, { mode: 'specific', sessionId, sessionTitle });
      } else {
        setSessionSelection(WgState.activeChatId, identityRef, { mode: 'default' });
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
    const memberRefs = getChatMemberRefs(WgState.activeChat);
    return WgState.identities.filter((id) => memberRefs.has(id.identityRef) && id.identityRef !== 'user');
  }

  function getSessionSelection(chatId, identityRef) {
    if (!WgState._chatSessionSelection[chatId]) WgState._chatSessionSelection[chatId] = {};
    return WgState._chatSessionSelection[chatId][identityRef] || { mode: 'default' };
  }

  function setSessionSelection(chatId, identityRef, selection) {
    if (!WgState._chatSessionSelection[chatId]) WgState._chatSessionSelection[chatId] = {};
    WgState._chatSessionSelection[chatId][identityRef] = selection;
  }

  function renderSessionBar() {
    const bar = document.querySelector('[data-wg-role="session-bar"]');
    if (!bar || !WgState.activeChatId) { if (bar) bar.innerHTML = ''; return; }

    const mentioned = getMentionedIdentities();
    if (mentioned.length === 0) { bar.innerHTML = ''; return; }

    // 只读指示器：显示每个被提及成员的当前派发路由
    // 交互式选择已移至 member popover（hover → 派发设置）
    const pills = mentioned.map((id) => {
      const sel = getSessionSelection(WgState.activeChatId, id.identityRef);
      let label = '接续最近';
      let modeClass = 'default';
      if (sel.mode === 'new') { label = '新建'; modeClass = 'new'; }
      else if (sel.mode === 'specific') { label = sel.sessionTitle || '指定会话'; modeClass = 'specific'; }
      return [
        `<div class="wg-session-pill-readonly ${modeClass}">`,
        `  <span class="wg-session-pill-name">${wgEsc(id.displayName)}</span>`,
        `  <span class="wg-session-pill-sep"></span>`,
        `  <span class="wg-session-pill-label">${wgEsc(label)}</span>`,
        '</div>',
      ].join('');
    }).join('');

    bar.innerHTML = `<div class="wg-session-pills-readonly">${pills}</div>`;
  }

  function renderSessionDropdown(identityRef) {
    const cache = WgState._sessionDataCache[identityRef];
    if (!cache) {
      // Loading state — trigger fetch
      fetchSessionData(identityRef);
      return `<div class="wg-session-dropdown"><div class="wg-session-dropdown-loading">加载中...</div></div>`;
    }

    const sel = getSessionSelection(WgState.activeChatId, identityRef);
    const items = [];

    // Default option
    items.push([
      `<div class="wg-session-option${sel.mode === 'default' ? ' selected' : ''}" data-wg-session-opt="default" data-wg-identity="${wgEsc(identityRef)}">`,
      `  <span class="wg-session-opt-title">接续最近会话</span>`,
      `  <span class="wg-session-opt-desc">自动复用群内最近会话</span>`,
      `</div>`,
    ].join(''));

    // New session option
    items.push([
      `<div class="wg-session-option${sel.mode === 'new' ? ' selected' : ''}" data-wg-session-opt="new" data-wg-identity="${wgEsc(identityRef)}">`,
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
          `<div class="wg-session-option${isSel ? ' selected' : ''}" data-wg-session-opt="specific" data-wg-identity="${wgEsc(identityRef)}" data-wg-session-id="${wgEsc(s.id)}" data-wg-session-title="${wgEsc(s.title)}">`,
          `  <span class="wg-session-opt-title">${wgEsc(s.title)}${mark}</span>`,
          `</div>`,
        ].join(''));
      }
    }

    return `<div class="wg-session-dropdown">${items.join('')}</div>`;
  }

  async function fetchSessionData(identityRef) {
    if (!WgState.activeChatId) return;
    try {
      const data = await wgApiGet(
        `/protoclaw/group_chats/${encodeURIComponent(WgState.activeChatId)}/sessions/${encodeURIComponent(identityRef)}`
      );
      WgState._sessionDataCache[identityRef] = data;
      // Re-render only the dropdown if still open
      if (WgState._openSessionDropdown === identityRef) {
        renderSessionBar();
      }
    } catch (err) {
      console.error('[WorkGroup] fetchSessionData failed:', err);
      // 即使失败也缓存空结构，确保 popover 能显示"无会话"状态
      WgState._sessionDataCache[identityRef] = {
        inChatSessions: [],
        externalSessions: [],
        sessionModel: 'persistent',
      };
    }
  }

  function toggleSessionDropdown(identityRef) {
    if (WgState._openSessionDropdown === identityRef) {
      WgState._openSessionDropdown = null;
    } else {
      WgState._openSessionDropdown = identityRef;
      // Pre-fetch if not cached
      if (!WgState._sessionDataCache[identityRef]) {
        fetchSessionData(identityRef);
      }
    }
    renderSessionBar();
  }

  function handleSessionOption(identityRef, mode, sessionId, sessionTitle) {
    if (mode === 'default') {
      setSessionSelection(WgState.activeChatId, identityRef, { mode: 'default' });
    } else if (mode === 'new') {
      setSessionSelection(WgState.activeChatId, identityRef, { mode: 'new' });
    } else if (mode === 'specific') {
      setSessionSelection(WgState.activeChatId, identityRef, { mode: 'specific', sessionId, sessionTitle });
    }
    WgState._openSessionDropdown = null;
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
    WgState.pendingLinks.push({ url, description: desc || undefined });
    if (urlEl) urlEl.value = '';
    if (descEl) descEl.value = '';
    renderLinkList();
  }

  function renderLinkList() {
    const list = document.querySelector('[data-wg-role="link-list"]');
    if (!list) return;
    if (WgState.pendingLinks.length === 0) { list.innerHTML = ''; return; }
    list.innerHTML = WgState.pendingLinks.map((l, i) => {
      return `<div class="wg-link-chip"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg><span class="wg-link-chip-text">${wgEsc(l.description || l.url)}</span><button class="wg-chip-remove" data-wg-action="remove-link" data-wg-link-index="${i}"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18"/><path d="M6 6l12 12"/></svg></button></div>`;
    }).join('');
  }

  function renderAttachmentList() {
    const list = document.querySelector('[data-wg-role="attachment-list"]');
    if (!list) return;
    if (WgState.pendingAttachments.length === 0) {
      list.innerHTML = '';
      list.style.display = 'none';
      return;
    }
    list.style.display = 'flex';
    list.innerHTML = WgState.pendingAttachments.map((a, i) => {
      const displayName = a.name.length > 28 ? a.name.slice(0, 26) + '...' : a.name;
      const ext = (a.name.split('.').pop() || '').toUpperCase().slice(0, 4);
      return `<div class="wg-attachment-chip" title="${wgEsc(a.name)}"><span class="wg-attachment-chip-ext">${wgEsc(ext)}</span><span class="wg-attachment-chip-name">${wgEsc(displayName)}</span><button class="wg-chip-remove" data-wg-action="remove-attachment" data-wg-attachment-index="${i}"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18"/><path d="M6 6l12 12"/></svg></button></div>`;
    }).join('');
  }

  function toggleDropdown(type) {
    WgState.openDropdown = WgState.openDropdown === type ? null : type;
    refreshHeaderAndMessages();
  }

  async function handleModeChange(type, value) {
    if (!WgState.activeChatId) return;
    WgState.openDropdown = null;

    const field = type === 'initiative' ? 'initiativeMode' : 'autonomyMode';
    try {
      const updated = await wgApiPut(`/protoclaw/group_chats/${encodeURIComponent(WgState.activeChatId)}`, {
        [field]: value,
      });
      WgState.activeChat = updated;
      await loadChatSummaries();
      refreshChatList();
      refreshHeaderAndMessages();
    } catch (err) {
      console.error('[WorkGroup] mode change failed:', err);
    }
  }

  async function navigateToSession(target) {
    const [workspaceId, sessionId] = target.split(':');
    if (!workspaceId) return;
    try {
      if (window.navigateToWorkspaceSession) {
        await window.navigateToWorkspaceSession(workspaceId, sessionId || '');
      } else if (window.handlePrebuiltAgentClick) {
        // Fallback for older builds
        await window.handlePrebuiltAgentClick(workspaceId);
        if (sessionId && window.runWorkspaceAction) {
          await window.runWorkspaceAction(JSON.stringify({ type: 'open_session', sessionId }));
        }
      }
    } catch (err) {
      console.error('[WorkGroup] navigateToSession failed:', err);
    }
  }

  async function navigateToSessionRecord(workspaceId, sessionId) {
    if (!workspaceId) return;
    try {
      if (window.navigateToWorkspaceSession) {
        await window.navigateToWorkspaceSession(workspaceId, '', {
          actionOverride: sessionId ? { type: 'view_session_record', agentId: workspaceId, sessionId } : null,
        });
      } else if (window.handlePrebuiltAgentClick) {
        await window.handlePrebuiltAgentClick(workspaceId);
        if (window.runWorkspaceAction) {
          await window.runWorkspaceAction(JSON.stringify({
            type: 'view_session_record',
            agentId: workspaceId,
            sessionId,
          }));
        }
      }
    } catch (err) {
      console.error('[WorkGroup] navigateToSessionRecord failed:', err);
    }
  }

  // ── 添加成员弹窗（overlay，替代旧 <select>） ──────────────────

  async function handleDissolveChat() {
    if (!WgState.activeChatId) return;
    const confirmed = confirm(`确定要解散群聊「${WgState.activeChat?.name || WgState.activeChatId}」吗？\n\n解散后群聊记录将被删除，无法恢复。`);
    if (!confirmed) return;
    try {
      await wgApiDelete(`/protoclaw/group_chats/${encodeURIComponent(WgState.activeChatId)}`);
      WgState.activeChatId = null;
      WgState.activeChat = null;
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
    const targetId = chatId || WgState.activeChatId;
    if (!targetId) return;
    try {
      await wgApiPut(`/protoclaw/group_chats/${encodeURIComponent(targetId)}`, { archived: true });
      await loadChatSummaries();
      refreshChatList();
      if (targetId === WgState.activeChatId) refreshMain();
    } catch (err) {
      console.error('[WorkGroup] archive chat failed:', err);
      alert('归档群聊失败');
    }
  }

  async function handleUnarchiveChat(chatId) {
    const targetId = chatId || WgState.activeChatId;
    if (!targetId) return;
    try {
      await wgApiPut(`/protoclaw/group_chats/${encodeURIComponent(targetId)}`, { archived: false });
      await loadChatSummaries();
      refreshChatList();
      if (targetId === WgState.activeChatId) refreshMain();
    } catch (err) {
      console.error('[WorkGroup] unarchive chat failed:', err);
      alert('取消归档失败');
    }
  }

  async function handleDeleteChat(chatId) {
    if (!chatId) return;
    const chat = WgState.chatSummaries.find((c) => c.id === chatId);
    const name = chat?.name || chatId;
    const confirmed = confirm(`确定要解散群聊「${name}」吗？\n\n解散后群聊记录将被删除，无法恢复。`);
    if (!confirmed) return;
    try {
      await wgApiDelete(`/protoclaw/group_chats/${encodeURIComponent(chatId)}`);
      const wasActive = chatId === WgState.activeChatId;
      if (wasActive) {
        WgState.activeChatId = null;
        WgState.activeChat = null;
      }
      await loadChatSummaries();
      // 如果删除的是当前群聊，切换到第一个可用活跃群
      if (wasActive) {
        const firstActive = WgState.chatSummaries.find((c) => !c.archived);
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
    if (WgState.identities.length === 0) await loadIdentities();

    const memberCandidates = WgState.identities.filter((id) => isManageableGroupIdentity(id.identityRef));
    const identityItems = memberCandidates.length
      ? memberCandidates.map((id) => {
        const name = id.displayName || id.identityRef;
        const avatar = generateAvatar(name, id.identityRef);
        return `<label class="wg-modal-identity wg-new-chat-identity">
        <input type="checkbox" value="${wgEsc(id.identityRef)}" />
        <div class="wg-avatar wg-avatar-sm" style="--av-grad:${avatar.color}">${wgEsc(avatar.initials)}</div>
        <div class="wg-new-chat-identity-info">
          <span class="wg-modal-identity-name">${wgEsc(name)}</span>
          <span class="wg-modal-identity-desc">${wgEsc(id.description || '')}</span>
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
          <div class="wg-avatar wg-avatar-sm" style="--av-grad:${WG_AVATAR_SPECIAL_COLORS['user']}">我</div>
          <span>我</span><small>群主</small>
        </div>
        <div class="wg-modal-fixed-member">
          <div class="wg-avatar wg-avatar-sm" style="--av-grad:${WG_AVATAR_SPECIAL_COLORS['work-group:admin']}">管</div>
          <span>管理员</span><small>固定入群</small>
        </div>
      </div>

      <div class="wg-modal-section-title">选择成员</div>
      <div class="wg-modal-identity-list">${identityItems}</div>

      <div class="wg-modal-section-title">工作目录 <span class="wg-required-mark">*</span></div>
      <div class="wg-modal-dir-row">
        <input type="text" class="wg-modal-input wg-modal-dir-display" data-wg-role="new-chat-workdir" placeholder="请选择项目目录（必填）" readonly />
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
      if (!workDir) {
        modal.querySelector('[data-wg-action="pick-workdir"]').click();
        return;
      }
      const desc = modal.querySelector('[data-wg-role="new-chat-desc"]').value.trim();

      const selected = Array.from(modal.querySelectorAll('.wg-modal-identity-list input[type="checkbox"]:checked'))
        .map((cb) => cb.value);

      const members = normalizeGroupMembers([
        ...selected.map((ref) => ({ identityRef: ref, role: 'agent' })),
      ]);

      document.body.removeChild(modal);

      try {
        const chat = await wgApiPost('/protoclaw/group_chats', { name, workDir, members });
        // 写入 GROUP.md 初始内容（如果填了群简介）
        if (desc) {
          try {
            await wgApiPut(`/protoclaw/group_chats/${encodeURIComponent(chat.id)}/group_md`, { content: desc });
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
    if (!WgState.activeChatId) return;
    closeImportModal();

    const imported = WgState.activeChat?.importedSessions || [];

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
    WgState._importModalEl = modal;

    // 搜索防抖
    const searchInput = modal.querySelector('[data-wg-role="import-search"]');
    searchInput.addEventListener('input', () => {
      clearTimeout(WgState._importSearchTimer);
      WgState._importSearchTimer = setTimeout(() => doImportSearch(searchInput.value.trim()), 300);
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
    if (WgState._importModalEl) { WgState._importModalEl.remove(); WgState._importModalEl = null; }
    clearTimeout(WgState._importSearchTimer);
  }

  function renderImportedList(imported) {
    if (!imported || imported.length === 0) {
      return '<div class="wg-import-empty">暂无引入会话</div>';
    }
    return imported.map((s) => {
      return [
        `<div class="wg-import-item">`,
        `  <div class="wg-import-item-info" data-wg-import-action="navigate" data-workspace-id="${wgEsc(s.workspaceId)}" data-session-id="${wgEsc(s.sessionId)}" title="点击跳转">`,
        `    <span class="wg-import-item-ws">${wgEsc(s.workspaceName || s.workspaceId)}</span>`,
        `    <span class="wg-import-item-title">${wgEsc(s.title)}</span>`,
        `  </div>`,
        `  <button class="wg-import-item-btn danger" data-wg-import-action="do-unimport" data-workspace-id="${wgEsc(s.workspaceId)}" data-session-id="${wgEsc(s.sessionId)}">移除</button>`,
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
        `    <span class="wg-import-item-ws">${wgEsc(s.workspaceName || s.workspaceId)}</span>`,
        `    <span class="wg-import-item-title">${wgEsc(s.title)}</span>`,
        `  </div>`,
        already
          ? `<span class="wg-import-item-done">已引入</span>`
          : `<button class="wg-import-item-btn confirm" data-wg-import-action="do-import" data-workspace-id="${wgEsc(s.workspaceId)}" data-session-id="${wgEsc(s.sessionId)}">引入</button>`,
        `</div>`,
      ].join('');
    }).join('');
  }

  async function doImportSearch(q) {
    if (!WgState._importModalEl || !WgState.activeChatId) return;
    const resultsEl = WgState._importModalEl.querySelector('[data-wg-role="search-results"]');
    if (!resultsEl) return;

    if (!q) {
      resultsEl.innerHTML = '<div class="wg-import-empty">输入关键词搜索跨工作空间会话</div>';
      return;
    }

    resultsEl.innerHTML = '<div class="wg-import-empty">搜索中...</div>';
    try {
      const data = await wgApiGet(
        `/protoclaw/group_chats/${encodeURIComponent(WgState.activeChatId)}/search_sessions?q=${encodeURIComponent(q)}`
      );
      const importedIds = new Set(
        (WgState.activeChat?.importedSessions || []).map((s) => `${s.workspaceId}:${s.sessionId}`)
      );
      resultsEl.innerHTML = renderSearchResults(data.sessions || [], importedIds);
    } catch (err) {
      resultsEl.innerHTML = '<div class="wg-import-empty">搜索失败</div>';
      console.error('[WorkGroup] import search failed:', err);
    }
  }

  async function doImportSession(workspaceId, sessionId) {
    if (!WgState.activeChatId) return;
    try {
      const result = await wgApiPost(
        `/protoclaw/group_chats/${encodeURIComponent(WgState.activeChatId)}/import_session`,
        { workspaceId, sessionId }
      );
      // 更新 WgState.activeChat
      if (WgState.activeChat) WgState.activeChat.importedSessions = result.imported || [];
      // 刷新弹窗内列表
      if (WgState._importModalEl) {
        const listEl = WgState._importModalEl.querySelector('[data-wg-role="imported-list"]');
        if (listEl) listEl.innerHTML = renderImportedList(result.imported || []);
        // 刷新搜索结果中的"已引入"状态
        const searchInput = WgState._importModalEl.querySelector('[data-wg-role="import-search"]');
        if (searchInput) doImportSearch(searchInput.value.trim());
      }
      // 刷新态势层 badge
      refreshAdminBarOnly();
    } catch (err) {
      console.error('[WorkGroup] import session failed:', err);
    }
  }

  async function doUnimportSession(workspaceId, sessionId) {
    if (!WgState.activeChatId) return;
    try {
      const result = await fetch(
        `/protoclaw/group_chats/${encodeURIComponent(WgState.activeChatId)}/import_session`,
        { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId, sessionId }) }
      ).then((r) => r.json());
      if (WgState.activeChat) WgState.activeChat.importedSessions = result.imported || [];
      if (WgState._importModalEl) {
        const listEl = WgState._importModalEl.querySelector('[data-wg-role="imported-list"]');
        if (listEl) listEl.innerHTML = renderImportedList(result.imported || []);
        const searchInput = WgState._importModalEl.querySelector('[data-wg-role="import-search"]');
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
    if (!WgState.activeChatId || !identityRef) return;
    try {
      const res = await fetch('/protoclaw/gc/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chatId: WgState.activeChatId,
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
    if (WgState.openDropdown && !e.target.closest(`[data-wg-dropdown="${WgState.openDropdown}"]`)) {
      WgState.openDropdown = null;
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
      if (act === 'voice') { wgToggleVoiceRecording(action); return; }
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
      if (act === 'approve-dispatch') { handleApproveDispatch(action.dataset.wgDispatchId); return; }
      if (act === 'reject-dispatch') {
        enterRejectDispatchState(action.dataset.wgDispatchId);
        return;
      }
      if (act === 'toggle-archived') {
        WgState._archivedCollapsed = !WgState._archivedCollapsed;
        refreshChatList();
        return;
      }
      if (act === 'toggle-sidebar') {
        WgState._sidebarCollapsed = !WgState._sidebarCollapsed;
        const app = document.querySelector('.wg-app');
        if (app) {
          app.classList.toggle('sidebar-collapsed', WgState._sidebarCollapsed);
          const btn = app.querySelector('.wg-sidebar-toggle');
          if (btn) {
            btn.title = WgState._sidebarCollapsed ? '展开群聊列表' : '收起群聊列表';
            const path = btn.querySelector('path');
            if (path) path.setAttribute('d', WgState._sidebarCollapsed ? 'M9 18l6-6-6-6' : 'M15 18l-6-6 6-6');
          }
        }
        return;
      }
    }

    const removeLink = e.target.closest('[data-wg-action="remove-link"]');
    if (removeLink) {
      const idx = parseInt(removeLink.dataset.wgLinkIndex);
      WgState.pendingLinks.splice(idx, 1);
      renderLinkList();
      return;
    }

    const removeAtt = e.target.closest('[data-wg-action="remove-attachment"]');
    if (removeAtt) {
      const idx = parseInt(removeAtt.dataset.wgAttachmentIndex);
      WgState.pendingAttachments.splice(idx, 1);
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
    if (mentionSession && WgState._mentionTarget) {
      const val = mentionSession.dataset.wgMentionSession;
      const title = mentionSession.dataset.wgMentionTitle;
      if (val === '__new__') {
        insertMentionWithSession(WgState._mentionTarget, 'new');
      } else if (val === '__default__') {
        insertMentionWithSession(WgState._mentionTarget, 'default');
      } else {
        insertMentionWithSession(WgState._mentionTarget, 'specific', val, title);
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
      if (name && WgState.activeChatId && window._viewerOpen) {
        window._viewerOpen(name, WgState.activeChatId, false);
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
    if (WgState._openSessionDropdown && !e.target.closest('.wg-session-pill-wrap')) {
      WgState._openSessionDropdown = null;
      renderSessionBar();
    }
  }

  function onContainerInput(e) {
    const search = e.target.closest('[data-wg-role="search"]');
    if (search) {
      WgState.searchKeyword = search.value;
      refreshChatList();
      return;
    }
    // 编辑器内容变化时更新 session bar（@mention 增减时 pill 跟随）
    const editor = e.target.closest('.wg-input-editor');
    if (editor && WgState.activeChatId) {
      const text = editor.textContent || '';

      // 拒绝派发模式：不渲染 session bar、不弹 @ picker
      if (WgState._rejectDispatchId) {
        if (!text.startsWith(WgState._rejectPrefillText)) {
          exitRejectDispatchState();
          // 退出后继续正常流程
        } else {
          return; // 仍在拒绝模式，跳过所有编辑器交互逻辑
        }
      }

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
    const chatItem = e.target.closest('[data-wg-chat-id]');
    if (chatItem) {
      const chatId = chatItem.dataset.wgChatId;
      const chat = WgState.chatSummaries.find((c) => c.id === chatId);
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

    if (!WgState.activeChatId) return;
    const msgRow = e.target.closest('.wg-msg-row');
    if (!msgRow) return;

    const msgId = msgRow.dataset.wgMsgId;
    if (!msgId) return;

    e.preventDefault();

    const items = [];

    // 批注（所有消息都支持）
    const existingAnn = WgState._annotations[msgId];
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

      const matchedId = WgState.identities.find((id) =>
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

              setSessionSelection(WgState.activeChatId, matchedId.identityRef, {
                mode: 'specific',
                sessionId: quoteSession,
                sessionTitle: quoteTitle,
              });

              if (!WgState._sessionDataCache[matchedId.identityRef]) {
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

              if (!WgState._sessionDataCache[matchedId.identityRef]) {
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


  /** 在消息列表渲染后，给每条有批注的消息插入批注条 */
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
    const chatId = WgState.activeChatId;
    if (!chatId) return;
    try {
      const res = await fetch(`/protoclaw/group_chats/${encodeURIComponent(chatId)}/resources/${encodeURIComponent(name)}`);
      const data = await res.json();
      // 检查是否已存在同名附件
      if (!WgState.pendingAttachments.find(a => a.name === name)) {
        WgState.pendingAttachments.push({ name, content: data.content || '' });
        renderAttachmentList();
      }
    } catch (err) {
      console.error('[WorkGroup] drop attachment failed:', err);
    }
  }

  // ── 初始化 ──────────────────────────────────────────────────

  async function init() {
    WgState.isLoading = true;
    await Promise.all([loadChatSummaries(), loadIdentities()]);
    // 优先选择第一个活跃群聊，跳过已归档的
    const firstActive = WgState.chatSummaries.find((c) => !c.archived);
    if (firstActive) {
      await selectChat(firstActive.id);
    } else if (WgState.chatSummaries.length > 0) {
      await selectChat(WgState.chatSummaries[0].id);
    }
    WgState.isLoading = false;
    startPolling();
    setupScrollListener();
  }

  function setupScrollListener() {
    // 使用事件委托监听scroll事件
    document.addEventListener('scroll', (e) => {
      // 忽略程序触发的 scroll 事件
      if (WgState._suppressScrollEvent) return;
      const scrollEl = e.target.closest('.wg-msg-scroll');
      if (!scrollEl) return;
      
      // 用户手动滚动时设置标志位
      WgState._userScrolling = true;
      
      // 清除之前的计时器
      if (WgState._userScrollingTimer) {
        clearTimeout(WgState._userScrollingTimer);
      }
      
      // 2秒后清除标志位
      WgState._userScrollingTimer = setTimeout(() => {
        WgState._userScrolling = false;
        WgState._userScrollingTimer = null;
      }, 2000);
    }, true); // 使用捕获阶段确保能监听到
  }


  // ── 对外接口 ────────────────────────────────────────────────

  function deactivate() {
    // 离开工作空间前保存当前群聊的输入草稿
    if (WgState.activeChatId) _saveCurrentDraft(WgState.activeChatId);
    stopPolling();
    // 清理工作面板
    if (window._wgThreadsCleanup) window._wgThreadsCleanup();
    WgState.pendingLinks = [];
    WgState.pendingAttachments = [];
    WgState.openDropdown = null;
    hideMemberPopover(true);
    closeImportModal();
    closeAddMemberModal();
    // 取消正在进行的语音录制
    if (WgState._voiceRecording) {
      _wgCancelVoiceRecording();
    }
  }


  // ── Phase 1 新增导出 ──
  // ── 保留导出 ──
  // 给外部 poll 用的轻量刷新：只更新左侧群聊列表，避免整个 workspace DOM 重建
  // 导致输入框失焦/内容丢失。
  function softRefresh() {
    refreshChatList();
    if (window._wgThreadsReload) window._wgThreadsReload();
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
    getActiveChatId: () => WgState.activeChatId,
    getActiveChat: () => WgState.activeChat,
    getChatSummaries: () => WgState.chatSummaries,
    selectChat: (chatId) => selectChat(chatId),
    addAttachment: (name, content) => {
      if (!WgState.pendingAttachments.find(a => a.name === name)) {
        WgState.pendingAttachments.push({ name, content: content || '' });
        renderAttachmentList();
      }
    },
  };

