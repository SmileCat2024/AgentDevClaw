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

  // 滚动位置保持
  let _savedMsgScrollTop = 0;       // 跨 DOM 重建保持消息区滚动位置
  let _shouldScrollToBottom = false; // 进入/切换聊天时滚动到底部

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
    } catch (err) {
      console.error('[WorkGroup] loadActiveChat:', err);
      activeChat = null;
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

  function getMemberName(chat, from) {
    if (from === 'user') return '我';
    const id = identities.find((i) => i.identityRef === from);
    return id ? id.displayName : from;
  }

  function getIdentityName(identityRef) {
    const id = identities.find((i) => i.identityRef === identityRef);
    return id ? id.displayName : identityRef;
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
          status: r.status || 'pending',
          lastActivity: msg.timestamp || 0,
        });
      }
    }
    const sessions = Array.from(sessionMap.values()).filter((s) => s.status !== 'failed');
    sessions.sort((a, b) => b.lastActivity - a.lastActivity);
    return sessions;
  }

  // ── 左侧：群聊列表 ──────────────────────────────────────────

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

    const items = filtered.map((chat) => {
      const isActive = chat.id === activeChatId;
      const avatarLetter = (chat.name || '?').charAt(0);
      const lm = chat.lastMessage;
      const preview = lm ? (lm.text || '').slice(0, 40) : '暂无消息';
      const modeLabel = INITIATIVE_MODES.find((m) => m.value === (chat.initiativeMode || 'assist'));

      return [
        `<div class="wg-chat-item${isActive ? ' active' : ''}" data-wg-chat-id="${esc(chat.id)}">`,
        `  <div class="wg-chat-avatar">${esc(avatarLetter)}</div>`,
        '  <div class="wg-chat-info">',
        '    <div class="wg-chat-top">',
        `      <span class="wg-chat-name">${esc(chat.name)}</span>`,
        modeLabel ? `      <span class="wg-chat-mode">${esc(modeLabel.label)}</span>` : '',
        `      <span class="wg-chat-time">${esc(formatTime(chat.updatedAt || chat.createdAt))}</span>`,
        '    </div>',
        `    <div class="wg-chat-preview">${esc(preview)}</div>`,
        '  </div>',
        '</div>',
      ].join('');
    }).join('');

    return items;
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

  // ── 右侧：态势层 ────────────────────────────────────────────

  function renderAwarenessBar(chat) {
    const sessions = collectActiveSessions(chat);
    const agentMembers = (chat.members || []).filter((m) => m.role !== 'human');

    const sessionItems = sessions.slice(0, 6).map((s) => {
      const statusClass = s.status || 'pending';
      const shortId = s.sessionId ? s.sessionId.slice(-6) : '';
      return [
        `<div class="wg-session-chip ${statusClass}" data-wg-session-nav="${esc(s.workspaceId)}:${esc(s.sessionId)}" title="点击查看会话">`,
        `  <span class="wg-session-dot"></span>`,
        `  <span class="wg-session-name">${esc(s.displayName)}</span>`,
        shortId ? `<span class="wg-session-id">${esc(shortId)}</span>` : '',
        '</div>',
      ].join('');
    }).join('');

    const memberChips = agentMembers.map((m) => {
      const name = getIdentityName(m.identityRef);
      return `<span class="wg-member-chip">${esc(name)}</span>`;
    }).join('');

    return [
      '<div class="wg-awareness">',
      sessions.length > 0 ? `  <div class="wg-awareness-sessions">${sessionItems}</div>` : '',
      `  <div class="wg-awareness-members">${memberChips}</div>`,
      chat.workDir ? `  <div class="wg-awareness-workdir"><code>${esc(chat.workDir)}</code></div>` : '',
      '</div>',
    ].join('');
  }

  // ── 右侧：事件消息（agent 身份的通知卡片） ─────────────────────

  function renderEventMessage(chat, msg) {
    const evt = msg.event || {};
    if (evt.type !== 'task_started') return '';

    const name = evt.identityName || getMemberName(chat, msg.from);
    const time = formatTime(msg.timestamp);
    const avatarLetter = name.charAt(0);
    const navTarget = evt.workspaceId && evt.sessionId
      ? `${evt.workspaceId}:${evt.sessionId}` : null;

    const quoteAttrs = [
      `data-wg-quote-ref="${esc(msg.from)}"`,
      evt.workspaceId ? `data-wg-quote-workspace="${esc(evt.workspaceId)}"` : '',
      evt.sessionId ? `data-wg-quote-session="${esc(evt.sessionId)}"` : '',
      evt.sessionTitle ? `data-wg-quote-title="${esc(evt.sessionTitle)}"` : '',
      `data-wg-quote-name="${esc(name)}"`,
    ].filter(Boolean).join(' ');

    return [
      `<div class="wg-msg-row" ${quoteAttrs}>`,
      `  <div class="wg-msg-avatar">${esc(avatarLetter)}</div>`,
      '  <div class="wg-msg-body">',
      `    <div class="wg-msg-meta"><span class="wg-msg-identity">${esc(name)}</span> <span class="wg-msg-time">${esc(time)}</span></div>`,
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
    const fromAvatar = fromName.charAt(0);
    const targetRef = msg.mentions?.[0]?.identityRef || msg.routing?.targetIdentityRef;
    const targetName = targetRef ? getIdentityName(targetRef) : '';
    const routing = msg.routing || {};
    const navTarget = routing.targetWorkspaceId && routing.targetSessionId
      ? `${routing.targetWorkspaceId}:${routing.targetSessionId}` : null;
    const sessionLabel = routing.targetSessionTitle || null;

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
      `<div class="wg-msg-row" ${quoteAttrs}>`,
      `  <div class="wg-msg-avatar admin">${esc(fromAvatar)}</div>`,
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
      `        <span class="wg-card-status"><span class="wg-card-dot ${routing.status === 'completed' ? '' : 'active'}"></span>${routing.status === 'completed' ? '已完成' : routing.status === 'failed' ? '失败' : '进行中'}</span>`,
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
    let dispatchHtml = '';
    if (isMe && msg.routing) {
      const status = msg.routing.status || 'pending';
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

    // 身份标签（非用户消息）
    const identityTag = (!isMe && !isSummary && msg.from && msg.from !== 'user')
      ? `<span class="wg-msg-identity">${esc(name)}</span>` : '';

    // 链接引用
    const linksHtml = (Array.isArray(msg.links) && msg.links.length > 0)
      ? '<div class="wg-msg-links">' + msg.links.map((l) => {
          return `<a href="${esc(l.url)}" target="_blank" class="wg-msg-link">${esc(l.description || l.url)}</a>`;
        }).join('') + '</div>'
      : '';

    // 附件标签
    const attachmentsHtml = (Array.isArray(msg.attachments) && msg.attachments.length > 0)
      ? '<div class="wg-msg-attachments">' + msg.attachments.map((a) => {
          return `<span class="wg-msg-attachment-tag" title="${esc(a.name)}">${esc(a.name)}</span>`;
        }).join('') + '</div>'
      : '';

    const avatarLetter = name.charAt(0);
    const bubbleClass = isSummary ? ' summary' : (isAdmin ? ' admin' : '');

    if (isMe) {
      return [
        '<div class="wg-msg-row me">',
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
      `<div class="wg-msg-row" ${quoteAttrs}>`,
      `  <div class="wg-msg-avatar${isAdmin ? ' admin' : ''}">${esc(avatarLetter)}</div>`,
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
  const COLLAPSE_THRESHOLD = 180;
  function applyCollapsible(container) {
    if (!container) return;
    const targets = container.querySelectorAll('.wg-msg-bubble, .wg-card-body.markdown-body');
    targets.forEach((el) => {
      if (el.dataset.wgCollapseInit) return;
      if (el.scrollHeight <= COLLAPSE_THRESHOLD) return;
      el.dataset.wgCollapseInit = '1';
      el.classList.add('wg-collapsible', 'collapsed');

      const toggle = document.createElement('span');
      toggle.className = 'wg-collapse-toggle';
      toggle.textContent = '展开';
      toggle.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const isCollapsed = el.classList.toggle('collapsed');
        toggle.textContent = isCollapsed ? '展开' : '收起';
      });
      // 放到 bubble/card-body 内部底部，配合 CSS 绝对定位居中到中轴线。
      // 之前 appendChild(el.parentElement) 会让 toggle 靠左，看起来"位置阴间"。
      el.appendChild(toggle);
    });
  }

  // ── 右侧：@mention 选择器 ───────────────────────────────────

  function renderMentionPicker() {
    if (identities.length === 0) return '';
    const items = identities.map((id) => {
      return [
        `<div class="wg-mention-item" data-wg-mention="${esc(id.identityRef)}">`,
        `  <span class="wg-mention-name">${esc(id.displayName)}</span>`,
        `  <span class="wg-mention-desc">${esc(id.description || '')}</span>`,
        '</div>',
      ].join('');
    }).join('');

    return `<div class="wg-mention-picker" data-wg-role="mention-picker" style="display:none;">${items}</div>`;
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
      '    <div class="wg-input-footer">',
      '      <button class="wg-mention-icon" data-wg-action="mention" title="提及成员">',
      '        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.92 7.94"/></svg>',
      '      </button>',
      '      <span class="wg-input-hint">Enter 发送 · Shift+Enter 换行</span>',
      '      <div class="wg-input-spacer"></div>',
      '      <button class="wg-send-btn" data-wg-action="send">发送</button>',
      '    </div>',
      '  </div>',
      renderMentionPicker(),
      '</div>',
    ].join('');
  }

  // ── 右侧：设置面板 ───────────────────────────────────────────

  function renderSettingsPanel(chat) {
    const initiative = chat.initiativeMode || 'assist';
    const autonomy = chat.autonomyMode || 'auto';

    const memberRows = (chat.members || []).map((m) => {
      const name = m.identityRef === 'user' ? '我' : getIdentityName(m.identityRef);
      return [
        '<div class="wg-settings-row">',
        `  <span class="wg-settings-row-name">${esc(name)}</span>`,
        `  <span class="wg-settings-row-role">${esc(m.role)}</span>`,
        '</div>',
      ].join('');
    }).join('');

    const initiativeOptions = INITIATIVE_MODES.map((m) =>
      `<option value="${m.value}"${m.value === initiative ? ' selected' : ''}>${esc(m.label)} — ${esc(m.desc)}</option>`
    ).join('');

    const autonomyOptions = AUTONOMY_MODES.map((m) =>
      `<option value="${m.value}"${m.value === autonomy ? ' selected' : ''}>${esc(m.label)} — ${esc(m.desc)}</option>`
    ).join('');

    return [
      '<div class="wg-settings-panel">',
      '  <div class="wg-settings-section">',
      '    <div class="wg-settings-section-title">群信息</div>',
      `    <div class="wg-settings-field"><label>群名称</label><input type="text" value="${esc(chat.name)}" class="wg-settings-input" onchange="window._wgSettingsChange('name', this.value)" /></div>`,
      `    <div class="wg-settings-field"><label>工作目录</label>`,
      `      <div class="wg-workdir-row">`,
      `        <code class="wg-workdir-path">${esc(chat.workDir || '未设置')}</code>`,
      `        <button class="wg-modal-btn" onclick="window._wgChangeWorkDir()">更改</button>`,
      `      </div>`,
      `    </div>`,
      '  </div>',
      `  <div class="wg-settings-section">`,
      `    <div class="wg-settings-section-title">群聊背景文档 (GROUP.md)</div>`,
      `    <div class="wg-settings-field">`,
      `      <textarea class="wg-settings-input wg-md-editor" data-wg-role="group-md-editor" oninput="window._wgMdAutoSave()" placeholder="在此编写群聊的背景、目标、约定和关键资源…">${esc(groupMdLoading ? '加载中…' : groupMdContent)}</textarea>`,
      `      <div class="wg-md-save-status" data-wg-role="md-save-status">自动保存</div>`,
      `    </div>`,
      '  </div>',
      '  <div class="wg-settings-section">',
      '    <div class="wg-settings-section-title">模式设置</div>',
      `    <div class="wg-settings-field"><label>主动性模式</label><select class="wg-settings-input" onchange="window._wgSettingsChange('initiativeMode', this.value)">${initiativeOptions}</select></div>`,
      `    <div class="wg-settings-field"><label>自决权模式</label><select class="wg-settings-input" onchange="window._wgSettingsChange('autonomyMode', this.value)">${autonomyOptions}</select></div>`,
      '  </div>',
      '  <div class="wg-settings-section">',
      '    <div class="wg-settings-section-title">管理员记忆</div>',
      '    <div class="wg-settings-field"><label>记忆范围</label>',
      `      <select class="wg-settings-input" onchange="window._wgSettingsChange('memoryRange', this.value)">`,
      `        <option value="1d"${(chat.adminMemory?.range || '3d') === '1d' ? ' selected' : ''}>最近 1 天</option>`,
      `        <option value="3d"${(chat.adminMemory?.range || '3d') === '3d' ? ' selected' : ''}>最近 3 天</option>`,
      `        <option value="1w"${(chat.adminMemory?.range || '3d') === '1w' ? ' selected' : ''}>最近 1 周</option>`,
      `        <option value="all"${(chat.adminMemory?.range || '3d') === 'all' ? ' selected' : ''}>全部记录</option>`,
      `      </select></div>`,
      '    <div class="wg-settings-field"><label>上下文限制</label>',
      `      <select class="wg-settings-input" onchange="window._wgSettingsChange('memoryLimitMode', this.value)">`,
      `        <option value="tokens"${(chat.adminMemory?.limitMode || 'tokens') === 'tokens' ? ' selected' : ''}>按 token 数</option>`,
      `        <option value="ratio"${(chat.adminMemory?.limitMode || 'tokens') === 'ratio' ? ' selected' : ''}>按比例 (%)</option>`,
      `      </select></div>`,
      `    <div class="wg-settings-field"><label>限制值</label><input type="number" value="${chat.adminMemory?.limitValue ?? 100000}" class="wg-settings-input" onchange="window._wgSettingsChange('memoryLimitValue', this.value)" /></div>`,
      '  </div>',
      '  <div class="wg-settings-section">',
      '    <div class="wg-settings-section-title">管理员模型</div>',
      '    <div class="wg-settings-field"><label>模型预设</label>',
      `      <select class="wg-settings-input" onchange="window._wgSettingsChange('admin-model', this.value)" data-wg-role="admin-model-select"><option value="">加载中</option></select>`,
      '    </div>',
      '  </div>',
      '  <div class="wg-settings-section">',
      '    <div class="wg-settings-section-title">群成员</div>',
      memberRows,
      '  </div>',
      '  <div class="wg-settings-section wg-settings-danger">',
      `    <button class="wg-btn-danger" onclick="window._wgDissolve()">解散此群聊</button>`,
      '  </div>',
      '</div>',
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
    // 外层 renderCurrentMainView() 重建 DOM 前，保存消息区滚动位置
    const existingScroll = document.querySelector('.wg-msg-scroll');
    const scrollExistsInDom = !!existingScroll;
    if (existingScroll) {
      _savedMsgScrollTop = existingScroll.scrollTop;
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
      // 恢复滚动位置
      const newScroll = document.querySelector('.wg-msg-scroll');
      if (newScroll) {
        if (_shouldScrollToBottom) {
          _shouldScrollToBottom = false;
          newScroll.scrollTop = newScroll.scrollHeight;
        } else if (scrollExistsInDom && _savedMsgScrollTop > 0) {
          newScroll.scrollTop = _savedMsgScrollTop;
        } else {
          newScroll.scrollTop = newScroll.scrollHeight;
        }
      }

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
          if (savedSearchSelectionStart !== null && savedSearchSelectionEnd !== null) {
            try {
              newSearch.setSelectionRange(savedSearchSelectionStart, savedSearchSelectionEnd);
            } catch (_) {}
          }
        }
      }

      // 恢复附件列表和链接列表
      renderAttachmentList();
      renderLinkList();
    });

    return html;
  }

  // ── 局部刷新 ────────────────────────────────────────────────

  function refreshMain() {
    const main = document.querySelector('[data-wg-role="main"]');
    if (main) {
      // 保存滚动位置（DOM 重建前）
      const scroll = main.querySelector('.wg-msg-scroll');
      const savedTop = scroll ? scroll.scrollTop : 0;
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
        if (_shouldScrollToBottom) {
          _shouldScrollToBottom = false;
          newScroll.scrollTop = newScroll.scrollHeight;
        } else if (scrollExists) {
          newScroll.scrollTop = savedTop;
        } else {
          // 退出再进入场景：滚动到底部
          newScroll.scrollTop = newScroll.scrollHeight;
        }
      }
      applyCollapsible(main);
    }
  }

  function refreshMessagesOnly() {
    const scroll = document.querySelector('.wg-msg-scroll');
    if (!scroll) return;
    const savedTop = scroll.scrollTop;
    const wasNearBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 80;
    scroll.innerHTML = renderMessageList(activeChat);
    if (typeof enhanceMathInElement === 'function') enhanceMathInElement(scroll);
    if (_shouldScrollToBottom) {
      _shouldScrollToBottom = false;
      scroll.scrollTop = scroll.scrollHeight;
    } else if (wasNearBottom) {
      scroll.scrollTop = scroll.scrollHeight;
    } else {
      // 用户主动滚动浏览历史时，innerHTML 重建后浏览器会把 scrollTop 重置为 0，
      // 显得"自动向上滑一下"。这里恢复用户原来的滚动位置。
      scroll.scrollTop = savedTop;
    }
    applyCollapsible(scroll);
  }

  function refreshHeaderAndMessages() {
    // 只更新 header / awareness / messages，完全不触碰输入区。
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
      const savedTop = scroll.scrollTop;
      const wasNearBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 80;
      scroll.innerHTML = renderMessageList(activeChat);
      if (typeof enhanceMathInElement === 'function') enhanceMathInElement(scroll);
      if (_shouldScrollToBottom) {
        _shouldScrollToBottom = false;
        scroll.scrollTop = scroll.scrollHeight;
      } else if (wasNearBottom) {
        scroll.scrollTop = scroll.scrollHeight;
      } else {
        scroll.scrollTop = savedTop;
      }
      applyCollapsible(scroll);
    }
  }

  function refreshChatList() {
    const list = document.querySelector('[data-wg-role="chat-list"]');
    if (list) list.innerHTML = renderChatList();
  }

  function scrollToBottom() {
    const scroll = document.querySelector('.wg-msg-scroll');
    if (scroll) scroll.scrollTop = scroll.scrollHeight;
  }

  // ── 轮询 ────────────────────────────────────────────────────

  function startPolling() {
    stopPolling();
    pollTimer = setInterval(async () => {
      if (activeChatId && !isLoading) {
        await loadActiveChat();
        refreshMessagesOnly();
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
    _shouldScrollToBottom = true;
    refreshChatList();

    // 加载目标群聊的草稿
    _loadDraft(chatId);

    refreshMain();
    await loadActiveChat();
    _shouldScrollToBottom = true;
    refreshMain();
    scrollToBottom();

    // 恢复编辑器内容和附件/链接列表
    _restoreEditorFromDraft(chatId);
    renderAttachmentList();
    renderLinkList();

    // 刷新 Files 面板（如果正打开着）
    if (typeof activeFeaturePanel !== 'undefined' && activeFeaturePanel === 'files' && typeof loadFilesPanelResources === 'function') {
      loadFilesPanelResources();
    }
    // 刷新 Settings 面板（如果正打开着）
    if (typeof activeFeaturePanel !== 'undefined' && activeFeaturePanel === 'settings' && typeof window._wgSettingsRefresh === 'function') {
      window._wgSettingsRefresh();
    }
  }

  async function handleSend() {
    const editor = document.querySelector('.wg-input-editor');
    if (!editor) return;
    const text = editor.textContent.trim();
    if (!text || !activeChatId) return;

    // 解析 @mentions（带 session 选择）
    const mentions = [];
    const chatSel = _chatSessionSelection[activeChatId] || {};
    for (const id of identities) {
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
    if (picker) picker.style.display = picker.style.display === 'none' ? 'block' : 'none';
  }

  // ── Session Bar ─────────────────────────────────────────────

  function getMentionedIdentities() {
    const editor = document.querySelector('.wg-input-editor');
    if (!editor) return [];
    const text = editor.textContent || '';
    return identities.filter((id) => text.includes(`@${id.displayName}`));
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

    const pills = mentioned.map((id) => {
      const sel = getSessionSelection(activeChatId, id.identityRef);
      let label = '接续最近会话';
      if (sel.mode === 'new') label = '新建会话';
      else if (sel.mode === 'specific') label = sel.sessionTitle || sel.sessionId?.slice(-8) || '指定会话';

      const isOpen = _openSessionDropdown === id.identityRef;
      return [
        `<div class="wg-session-pill-wrap">`,
        `  <div class="wg-session-pill${isOpen ? ' active' : ''}" data-wg-action="toggle-session-dropdown" data-wg-identity="${esc(id.identityRef)}">`,
        `    <span class="wg-session-pill-name">${esc(id.displayName)}</span>`,
        `    <span class="wg-session-pill-arrow">&#9662;</span>`,
        `    <span class="wg-session-pill-label">${esc(label)}</span>`,
        `  </div>`,
        isOpen ? renderSessionDropdown(id.identityRef) : '',
        `</div>`,
      ].join('');
    }).join('');

    bar.innerHTML = `<div class="wg-session-pills">${pills}</div>`;
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

  function insertMention(identityRef) {
    const id = identities.find((i) => i.identityRef === identityRef);
    if (!id) return;
    const editor = document.querySelector('.wg-input-editor');
    if (!editor) return;
    editor.focus();
    document.execCommand('insertText', false, `@${id.displayName} `);

    const picker = document.querySelector('[data-wg-role="mention-picker"]');
    if (picker) picker.style.display = 'none';

    // 预加载 session 数据并渲染 session bar
    if (!_sessionDataCache[identityRef]) {
      fetchSessionData(identityRef);
    }
    renderSessionBar();
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

  async function handleSettingsFieldChange(field, value) {
    if (!activeChatId) return;
    try {
      const body = {};
      if (field === 'name') body.name = value;
      else if (field === 'initiativeMode') body.initiativeMode = value;
      else if (field === 'autonomyMode') body.autonomyMode = value;
      else if (field === 'memoryRange' || field === 'memoryLimitMode' || field === 'memoryLimitValue') {
        // 合并当前 adminMemory 设置后整体提交
        const cur = activeChat?.adminMemory || { range: '3d', limitMode: 'tokens', limitValue: 100000 };
        const merged = { ...cur };
        if (field === 'memoryRange') merged.range = value;
        else if (field === 'memoryLimitMode') merged.limitMode = value;
        else if (field === 'memoryLimitValue') merged.limitValue = parseInt(value) || 100000;
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
    if (!activeChatId) return;
    groupMdLoading = true;
    if (typeof window._wgSettingsRefresh === 'function') window._wgSettingsRefresh();
    try {
      const data = await apiGet(`/protoclaw/group_chats/${encodeURIComponent(activeChatId)}/group_md`);
      groupMdContent = data.content || '';
    } catch (err) {
      console.error('[WorkGroup] load GROUP.md failed:', err);
      groupMdContent = '';
    }
    groupMdLoading = false;
    if (typeof window._wgSettingsRefresh === 'function') window._wgSettingsRefresh();
  }

  async function saveGroupMd() {
    if (!activeChatId) return;
    const editor = document.querySelector('[data-wg-role="group-md-editor"]');
    if (!editor) return;
    const content = editor.value;
    try {
      await apiPut(`/protoclaw/group_chats/${encodeURIComponent(activeChatId)}/group_md`, { content });
      groupMdContent = content;
      _setMdSaveStatus('已保存');
    } catch (err) {
      console.error('[WorkGroup] save GROUP.md failed:', err);
      _setMdSaveStatus('保存失败');
    }
  }

  let _mdAutoSaveTimer = null;
  function _wgMdAutoSave() {
    _setMdSaveStatus('保存中…');
    if (_mdAutoSaveTimer) clearTimeout(_mdAutoSaveTimer);
    _mdAutoSaveTimer = setTimeout(() => {
      _mdAutoSaveTimer = null;
      saveGroupMd();
    }, 800);
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
    const select = document.querySelector('[data-wg-role="admin-model-select"]');
    if (!select) return;
    try {
      const [configRes, presetRes] = await Promise.all([
        apiGet('/protoclaw/model_config'),
        apiGet('/protoclaw/agent_model_presets?agentId=work-group'),
      ]);
      const presets = Array.isArray(configRes.presets) ? configRes.presets : [];
      const current = presetRes.modelPresets?.default || '';
      select.innerHTML = '<option value="">使用全局默认</option>' +
        presets.map((p) => {
          const name = typeof p === 'string' ? p : (p.name || '');
          const sel = name === current ? ' selected' : '';
          return `<option value="${esc(name)}"${sel}>${esc(name)}</option>`;
        }).join('');
    } catch {
      select.innerHTML = '<option value="">加载失败</option>';
    }
  }

  async function saveAdminModel(presetName) {
    try {
      await fetch('/protoclaw/agent_model_presets', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: 'work-group', modelPresets: { default: presetName || null } }),
      });
    } catch (err) {
      console.error('[WorkGroup] save admin model failed:', err);
    }
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

  // ── 建群模态框 ──────────────────────────────────────────────

  async function handleNewChat() {
    if (identities.length === 0) await loadIdentities();

    const identityCheckboxes = identities.map((id) => {
      return `<label class="wg-modal-identity">
      <input type="checkbox" value="${esc(id.identityRef)}" />
      <span class="wg-modal-identity-name">${esc(id.displayName)}</span>
      <span class="wg-modal-identity-desc">${esc(id.description || '')}</span>
    </label>`;
    }).join('');

    const modal = document.createElement('div');
    modal.className = 'wg-modal-overlay';
    modal.innerHTML = `
    <div class="wg-modal">
      <div class="wg-modal-title">新建群聊</div>
      <input type="text" class="wg-modal-input" data-wg-role="new-chat-name" placeholder="群聊名称" />
      <div class="wg-modal-section-title">工作目录（知识库根目录）</div>
      <div class="wg-modal-dir-row">
        <input type="text" class="wg-modal-input wg-modal-dir-display" data-wg-role="new-chat-workdir" placeholder="点击右侧按钮选择项目目录" readonly />
        <button class="wg-modal-btn" data-wg-action="pick-workdir">选择</button>
      </div>
      <div class="wg-modal-section-title">选择成员</div>
      <div class="wg-modal-identity-list">${identityCheckboxes}</div>
      <div class="wg-modal-actions">
        <button class="wg-modal-btn" data-wg-action="cancel-new-chat">取消</button>
        <button class="wg-modal-btn confirm" data-wg-action="confirm-new-chat">创建</button>
      </div>
    </div>`;
    document.body.appendChild(modal);

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
      const name = modal.querySelector('[data-wg-role="new-chat-name"]').value.trim();
      if (!name) return;

      const workDir = modal.querySelector('[data-wg-role="new-chat-workdir"]').value.trim() || null;

      const selected = Array.from(modal.querySelectorAll('input[type="checkbox"]:checked'))
        .map((cb) => cb.value);

      const members = [
        { identityRef: 'user', role: 'human' },
        ...selected.map((ref) => ({ identityRef: ref, role: 'agent' })),
      ];

      document.body.removeChild(modal);

      try {
        const chat = await apiPost('/protoclaw/group_chats', { name, workDir, members });
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

  // ── 容器事件代理 ────────────────────────────────────────────

  function onContainerClick(e) {
    // 关闭下拉菜单（点击外部）
    if (openDropdown && !e.target.closest(`[data-wg-dropdown="${openDropdown}"]`)) {
      openDropdown = null;
      refreshHeaderAndMessages();
    }

    const action = e.target.closest('[data-wg-action]');
    if (action) {
      const act = action.dataset.wgAction;

      if (act === 'new-chat') { handleNewChat(); return; }
      if (act === 'mention') { toggleMentionPicker(); return; }
      if (act === 'toggle-links') { toggleLinksArea(); return; }
      if (act === 'add-link') { addLink(); return; }
      if (act === 'send') { handleSend(); return; }
      if (act === 'toggle-session-dropdown') {
        toggleSessionDropdown(action.dataset.wgIdentity);
        return;
      }
      if (act === 'toggle-dropdown') {
        toggleDropdown(action.dataset.wgDropdownType);
        return;
      }
      if (act === 'cancel-new-chat') return;
      if (act === 'pick-workdir') return; // handled by modal-specific listener
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

    const mentionItem = e.target.closest('[data-wg-mention]');
    if (mentionItem) {
      insertMention(mentionItem.dataset.wgMention);
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
      renderSessionBar();
    }
  }

  function onContainerChange(e) {
    // settings fields now use inline onchange handlers
  }

  function onContainerKeyDown(e) {
    const editor = e.target.closest('.wg-input-editor');
    if (!editor) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  // ── 右键上下文菜单：引用续话 ──────────────────────────────

  function onContainerContextMenu(e) {
    if (!activeChatId) return;
    const msgRow = e.target.closest('.wg-msg-row');
    if (!msgRow) return;

    // 自己发的消息不给引用菜单
    if (msgRow.classList.contains('me')) return;

    // 从 msg-row 的 quote 数据属性中提取会话信息（可能为空）
    const quoteRef = msgRow.dataset.wgQuoteRef || '';
    const quoteSession = msgRow.dataset.wgQuoteSession || '';
    const quoteWorkspace = msgRow.dataset.wgQuoteWorkspace || '';
    const quoteName = msgRow.dataset.wgQuoteName || '';
    const quoteTitle = msgRow.dataset.wgQuoteTitle || quoteSession.slice(-8) || '';

    // 找到对应的 identity；优先按 ref，其次按 displayName
    const matchedId = identities.find((id) =>
      (quoteRef && id.identityRef === quoteRef) ||
      (quoteName && id.displayName === quoteName)
    );
    // 没法识别发送者就不弹菜单
    if (!matchedId) return;

    e.preventDefault();

    const items = [];
    if (quoteSession && quoteWorkspace) {
      // 有完整 routing：引用并切换到那个 session
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
      // 没有 routing 数据：退化为单纯 @mention
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
    if (chatSummaries.length > 0) {
      await selectChat(chatSummaries[0].id);
    }
    isLoading = false;
    startPolling();
  }

  // ── 对外接口 ────────────────────────────────────────────────

  function deactivate() {
    // 离开工作空间前保存当前群聊的输入草稿
    if (activeChatId) _saveCurrentDraft(activeChatId);
    stopPolling();
    pendingLinks = [];
    pendingAttachments = [];
    openDropdown = null;
  }

  // ── 全局暴露：Settings 面板（右侧边栏） ──────────────────────

  window._wgGetSettingsHtml = function () {
    if (!activeChat) return '<div class="feature-panel-empty"><div>请先选择一个群聊。</div></div>';
    return renderSettingsPanel(activeChat);
  };

  window._wgSettingsInit = async function () {
    if (!activeChatId) return;
    await Promise.all([loadAdminModelOptions(), loadGroupMd()]);
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

  window._wgMdAutoSave = _wgMdAutoSave;
  window._wgChangeWorkDir = changeWorkDir;
  window._wgDissolve = handleDissolveChat;

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
    init,
    destroy: stopPolling,
    deactivate,
    startPolling,
    softRefresh,
    getActiveChatId: () => activeChatId,
    getActiveChat: () => activeChat,
  };
})();
