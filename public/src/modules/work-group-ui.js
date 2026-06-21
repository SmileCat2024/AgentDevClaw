/**
 * work-group-ui.js — 群聊指挥台 UI 模块
 *
 * 渲染微信桌面端风格的工作群界面：
 *   左侧：群聊列表 + 搜索 + 新建按钮
 *   右侧：群头部（模式切换 + 态势层）→ 消息流 → 结构化输入框
 *
 * 数据来自后端 API（/protoclaw/group_chats/*）。
 */

(function () {
  'use strict';

  // ── 常量 ────────────────────────────────────────────────────

  const INITIATIVE_MODES = [
    { value: 'assist', label: '辅助', icon: '🔧', desc: '完全被动，不主动参与路由' },
    { value: 'plan', label: '规划', icon: '📋', desc: '主动观察，适时提出建议' },
    { value: 'execute', label: '执行', icon: '⚡', desc: '全权管理，决定路由和调度' },
  ];

  const AUTONOMY_MODES = [
    { value: 'auto', label: '直接执行', desc: '拿到任务就做，自行判断' },
    { value: 'cautious', label: '有疑则停', desc: '正常推进，不确定时停下来问' },
    { value: 'confirm', label: '方案确认', desc: '先出方案，确认后再执行' },
  ];

  const ROUTING_ICONS = {
    pending: '⏳',
    delivered: '🔄',
    completed: '✓',
    failed: '✗',
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
  let openDropdown = null;

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
    const member = (chat?.members || []).find((m) => m.identityRef === from);
    if (member) {
      const id = identities.find((i) => i.identityRef === from);
      return id ? id.displayName : from;
    }
    const id = identities.find((i) => i.identityRef === from);
    return id ? id.displayName : from;
  }

  function getIdentityName(identityRef) {
    const id = identities.find((i) => i.identityRef === identityRef);
    return id ? id.displayName : identityRef;
  }

  /**
   * 从消息列表中收集活跃 session 信息。
   * 返回 [{ identityRef, sessionId, displayName, status, lastActivity }]
   */
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
    // 只保留未失败的 session
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
      const preview = lm ? `${lm.from === 'user' ? '' : ''}${(lm.text || '').slice(0, 40)}` : '暂无消息';
      const modeLabel = INITIATIVE_MODES.find((m) => m.value === (chat.initiativeMode || 'assist'));

      return [
        `<div class="wg-chat-item${isActive ? ' active' : ''}" data-wg-chat-id="${esc(chat.id)}">`,
        `  <div class="wg-chat-avatar">${esc(avatarLetter)}</div>`,
        '  <div class="wg-chat-info">',
        '    <div class="wg-chat-top">',
        `      <span class="wg-chat-name">${esc(chat.name)}</span>`,
        modeLabel ? `      <span class="wg-chat-mode">${modeLabel.icon}</span>` : '',
        `      <span class="wg-chat-time">${esc(formatTime(chat.updatedAt || chat.createdAt))}</span>`,
        '    </div>',
        `    <div class="wg-chat-preview">${esc(preview)}</div>`,
        '  </div>',
        '</div>',
      ].join('');
    }).join('');

    return items;
  }

  // ── 右侧：群头部（模式切换 + 标题）─────────────────────────

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
      '  <button class="wg-icon-btn" data-wg-action="toggle-settings" title="群设置">',
      '    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5">',
      '      <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
      '    </svg>',
      '  </button>',
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
        `  <span class="wg-dropdown-item-label">${m.icon || ''} ${esc(m.label)}</span>`,
        `  <span class="wg-dropdown-item-desc">${esc(m.desc)}</span>`,
        isSelected ? '  <span class="wg-dropdown-check">✓</span>' : '',
        '</div>',
      ].join('');
    }).join('');

    return [
      `<div class="wg-mode-dropdown${openDropdown === type ? ' open' : ''}" data-wg-dropdown="${type}">`,
      `  <button class="wg-mode-trigger" data-wg-action="toggle-dropdown" data-wg-dropdown-type="${type}">`,
      `    <span class="wg-mode-label">${esc(label)}</span>`,
      `    <span class="wg-mode-value">${currentMode.icon || ''} ${esc(currentMode.label)}</span>`,
      '    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>',
      '  </button>',
      `  <div class="wg-dropdown-menu">${items}</div>`,
      '</div>',
    ].join('');
  }

  // ── 右侧：态势层 ────────────────────────────────────────────

  function renderAwarenessBar(chat) {
    const sessions = collectActiveSessions(chat);
    const agentMembers = (chat.members || []).filter((m) => m.role !== 'human');

    const sessionItems = sessions.slice(0, 5).map((s) => {
      const icon = ROUTING_ICONS[s.status] || '⏳';
      const statusClass = s.status || 'pending';
      const shortId = s.sessionId ? s.sessionId.slice(-6) : '';
      return [
        `<div class="wg-session-chip ${statusClass}" data-wg-session-nav="${esc(s.workspaceId)}:${esc(s.sessionId)}" title="点击查看会话">`,
        `  <span class="wg-session-icon">${icon}</span>`,
        `  <span class="wg-session-name">${esc(s.displayName)}</span>`,
        shortId ? `  <span class="wg-session-id">${esc(shortId)}</span>` : '',
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
      chat.goal ? `  <div class="wg-awareness-goal">${esc(chat.goal)}</div>` : '',
      '</div>',
    ].join('');
  }

  // ── 右侧：消息流 ────────────────────────────────────────────

  function renderMessageBubble(chat, msg) {
    const isMe = msg.from === 'user';
    const isSummary = msg.kind === 'summary';
    const isAdmin = msg.from === 'work-group:admin';
    const name = getMemberName(chat, msg.from);
    const time = formatTime(msg.timestamp);

    // routing badge（仅用户发送的带 mention 消息）
    let badge = '';
    if (isMe && msg.routing) {
      const icon = ROUTING_ICONS[msg.routing.status] || '⏳';
      const statusText = {
        pending: '等待中',
        delivered: '处理中',
        completed: '已完成',
        failed: '失败',
      }[msg.routing.status] || '';
      const cls = msg.routing.status || 'pending';
      badge = `<span class="wg-routing-badge ${cls}">${icon} ${esc(statusText)}</span>`;
    }

    // session 导航链接
    let sessionLink = '';
    if (isMe && msg.routing?.targetSessionId && msg.routing?.targetWorkspaceId) {
      const targetName = getIdentityName(msg.routing.targetIdentityRef);
      const navTarget = `${msg.routing.targetWorkspaceId}:${msg.routing.targetSessionId}`;
      sessionLink = `<span class="wg-session-link" data-wg-session-nav="${esc(navTarget)}">${esc(targetName)} 会话 →</span>`;
    }

    // agent 身份标签（非管理员回复时显示来源身份）
    const identityTag = (!isMe && !isSummary && msg.from && msg.from !== 'user')
      ? `<span class="wg-msg-identity">${esc(name)}</span>`
      : '';

    // 链接引用渲染
    const linksHtml = (Array.isArray(msg.links) && msg.links.length > 0)
      ? '<div class="wg-msg-links">' + msg.links.map((l) => {
          return `<a href="${esc(l.url)}" target="_blank" class="wg-msg-link">🔗 ${esc(l.description || l.url)}</a>`;
        }).join('') + '</div>'
      : '';

    const avatarLetter = name.charAt(0);
    const bubbleClass = isSummary ? ' summary' : (isAdmin ? ' admin' : '');

    if (isMe) {
      return [
        '<div class="wg-msg-row me">',
        '  <div class="wg-msg-body">',
        `    <div class="wg-msg-meta"><span class="wg-msg-author">${esc(name)}</span> <span class="wg-msg-time">${esc(time)}</span>${badge}</div>`,
        `    <div class="wg-msg-bubble${bubbleClass}">${esc(msg.text)}</div>`,
        linksHtml,
        sessionLink ? `    <div class="wg-msg-footer">${sessionLink}</div>` : '',
        '  </div>',
        `  <div class="wg-msg-avatar">${esc(avatarLetter)}</div>`,
        '</div>',
      ].join('');
    }

    return [
      '<div class="wg-msg-row">',
      `  <div class="wg-msg-avatar${isAdmin ? ' admin' : ''}">${esc(avatarLetter)}</div>`,
      '  <div class="wg-msg-body">',
      `    <div class="wg-msg-meta">${identityTag} <span class="wg-msg-time">${esc(time)}</span></div>`,
      `    <div class="wg-msg-bubble${bubbleClass}">${esc(msg.text)}</div>`,
      linksHtml,
      '  </div>',
      '</div>',
    ].join('');
  }

  function renderMessageList(chat) {
    const bubbles = (chat.messages || []).map((msg) => renderMessageBubble(chat, msg)).join('');
    return '<div class="wg-msg-list">' + bubbles + '</div>';
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
      '  <div class="wg-input-toolbar">',
      '    <button class="wg-input-btn" title="@提及成员" data-wg-action="mention">@</button>',
      '    <button class="wg-input-btn" title="附加链接" data-wg-action="toggle-links">🔗</button>',
      '  </div>',
      renderMentionPicker(),
      '  <div class="wg-links-area" data-wg-role="links-area" style="display:none;">',
      '    <input type="text" class="wg-link-input" data-wg-role="link-url" placeholder="粘贴参考链接 URL…" />',
      '    <input type="text" class="wg-link-input" data-wg-role="link-desc" placeholder="描述（可选）" />',
      '    <button class="wg-link-add-btn" data-wg-action="add-link">添加</button>',
      '  </div>',
      '  <div class="wg-link-list" data-wg-role="link-list"></div>',
      '  <div class="wg-input-editor" contenteditable="true" data-placeholder="输入消息，@提及成员派发任务…"></div>',
      '  <div class="wg-input-footer">',
      '    <span class="wg-input-hint">Enter 发送 · Shift+Enter 换行</span>',
      '    <button class="wg-send-btn" data-wg-action="send">',
      '      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>',
      '      发送',
      '    </button>',
      '  </div>',
      '</div>',
    ].join('');
  }

  // ── 右侧：设置面板 ──────────────────────────────────────────

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
      `<option value="${m.value}"${m.value === initiative ? ' selected' : ''}>${m.icon} ${esc(m.label)} — ${esc(m.desc)}</option>`
    ).join('');

    const autonomyOptions = AUTONOMY_MODES.map((m) =>
      `<option value="${m.value}"${m.value === autonomy ? ' selected' : ''}>${esc(m.label)} — ${esc(m.desc)}</option>`
    ).join('');

    return [
      '<div class="wg-settings-panel">',
      '  <div class="wg-settings-section">',
      '    <div class="wg-settings-section-title">群信息</div>',
      `    <div class="wg-settings-field"><label>群名称</label><input type="text" value="${esc(chat.name)}" class="wg-settings-input" data-wg-field="name" /></div>`,
      `    <div class="wg-settings-field"><label>群目标</label><textarea class="wg-settings-input" data-wg-field="goal">${esc(chat.goal || '')}</textarea></div>`,
      '  </div>',
      '  <div class="wg-settings-section">',
      '    <div class="wg-settings-section-title">模式设置</div>',
      `    <div class="wg-settings-field"><label>主动性模式</label><select class="wg-settings-input" data-wg-field="initiativeMode">${initiativeOptions}</select></div>`,
      `    <div class="wg-settings-field"><label>自决权模式</label><select class="wg-settings-input" data-wg-field="autonomyMode">${autonomyOptions}</select></div>`,
      '  </div>',
      '  <div class="wg-settings-section">',
      '    <div class="wg-settings-section-title">管理员模型</div>',
      '    <div class="wg-settings-field"><label>模型预设</label>',
      '      <select class="wg-settings-input" data-wg-field="admin-model" data-wg-role="admin-model-select"><option value="">加载中…</option></select>',
      '    </div>',
      '  </div>',
      '  <div class="wg-settings-section">',
      '    <div class="wg-settings-section-title">群成员</div>',
      memberRows,
      '  </div>',
      '</div>',
    ].join('');
  }

  // ── 右侧：空状态 ────────────────────────────────────────────

  function renderEmptyConversation() {
    return [
      '<div class="wg-conversation-empty">',
      '  <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1" opacity="0.4">',
      '    <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>',
      '  </svg>',
      '  <p>选择一个群聊开始工作</p>',
      '</div>',
    ].join('');
  }

  function renderLoadingConversation() {
    return '<div class="wg-conversation-empty"><p>加载中…</p></div>';
  }

  // ── 右侧：整体渲染 ──────────────────────────────────────────

  function renderConversation() {
    if (!activeChatId) return renderEmptyConversation();
    if (!activeChat) return renderLoadingConversation();

    if (viewMode === 'settings') {
      return [
        '<div class="wg-conversation">',
        '  <div class="wg-conv-header">',
        `    <span class="wg-conv-title">${esc(activeChat.name)} — 设置</span>`,
        '    <div class="wg-conv-actions">',
        '      <button class="wg-icon-btn" data-wg-action="back-to-chat" title="返回聊天">← 返回</button>',
        '    </div>',
        '  </div>',
        '<div class="wg-settings-scroll">',
        renderSettingsPanel(activeChat),
        '</div>',
        '</div>',
      ].join('');
    }

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

  function renderWorkGroupSurface() {
    return [
      '<div class="wg-app">',
      '  <div class="wg-sidebar">',
      '    <div class="wg-sidebar-header">',
      '      <input type="text" class="wg-search-input" placeholder="搜索群聊…" data-wg-role="search" value="' + esc(searchKeyword) + '">',
      '      <button class="wg-new-chat-btn" data-wg-action="new-chat" title="新建群聊">',
      '        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>',
      '      </button>',
      '    </div>',
      '    <div class="wg-chat-list" data-wg-role="chat-list">' + renderChatList() + '</div>',
      '  </div>',
      '  <div class="wg-main" data-wg-role="main">' + renderConversation() + '</div>',
      '</div>',
    ].join('');
  }

  // ── 局部刷新 ────────────────────────────────────────────────

  function refreshMain() {
    const main = document.querySelector('[data-wg-role="main"]');
    if (main) main.innerHTML = renderConversation();
  }

  function refreshMessagesOnly() {
    const scroll = document.querySelector('.wg-msg-scroll');
    if (!scroll) return;
    const wasNearBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 80;
    scroll.innerHTML = renderMessageList(activeChat);
    if (wasNearBottom) scroll.scrollTop = scroll.scrollHeight;
  }

  function refreshHeaderAndMessages() {
    // 刷新 header + awareness + messages，保持输入框不动
    const conv = document.querySelector('.wg-conversation');
    if (!conv) { refreshMain(); return; }
    const editor = conv.querySelector('.wg-input-editor');
    const editorText = editor ? editor.textContent : '';
    const editorFocus = editor === document.activeElement;

    refreshMain();

    if (editorFocus) {
      const newEditor = document.querySelector('.wg-input-editor');
      if (newEditor) {
        newEditor.textContent = editorText;
        newEditor.focus();
        // 将光标移到末尾
        const range = document.createRange();
        range.selectNodeContents(newEditor);
        range.collapse(false);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
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

  // ── 事件处理 ────────────────────────────────────────────────

  async function selectChat(chatId) {
    activeChatId = chatId;
    viewMode = 'chat';
    activeChat = null;
    openDropdown = null;
    refreshChatList();
    refreshMain();
    await loadActiveChat();
    refreshMain();
    scrollToBottom();
  }

  async function handleSend() {
    const editor = document.querySelector('.wg-input-editor');
    if (!editor) return;
    const text = editor.textContent.trim();
    if (!text || !activeChatId) return;

    // 解析 @mentions
    const mentions = [];
    for (const id of identities) {
      const atName = `@${id.displayName}`;
      if (text.includes(atName)) {
        mentions.push({ identityRef: id.identityRef });
      }
    }

    editor.textContent = '';
    editor.focus();

    const links = pendingLinks.slice();
    pendingLinks = [];
    renderLinkList();

    try {
      await apiPost(`/protoclaw/group_chats/${encodeURIComponent(activeChatId)}/messages`, {
        text,
        mentions,
        links: links.length > 0 ? links : undefined,
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
      return `<div class="wg-link-entry"><span class="wg-link-entry-url">${esc(l.url)}</span>${l.description ? ` <span class="wg-link-entry-desc">${esc(l.description)}</span>` : ''}<button class="wg-link-remove" data-wg-action="remove-link" data-wg-link-index="${i}">✕</button></div>`;
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

  function navigateToSession(target) {
    // target = "workspaceId:sessionId"
    const [workspaceId] = target.split(':');
    if (workspaceId && window.handlePrebuiltAgentClick) {
      window.handlePrebuiltAgentClick(workspaceId);
    }
  }

  async function handleSettingsFieldChange(field, value) {
    if (!activeChatId) return;
    try {
      const body = {};
      if (field === 'name') body.name = value;
      else if (field === 'goal') body.goal = value;
      else if (field === 'initiativeMode') body.initiativeMode = value;
      else if (field === 'autonomyMode') body.autonomyMode = value;
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
      <div class="wg-modal-section-title">选择成员</div>
      <div class="wg-modal-identity-list">${identityCheckboxes}</div>
      <div class="wg-modal-actions">
        <button class="wg-modal-btn" data-wg-action="cancel-new-chat">取消</button>
        <button class="wg-modal-btn confirm" data-wg-action="confirm-new-chat">创建</button>
      </div>
    </div>`;
    document.body.appendChild(modal);

    modal.querySelector('[data-wg-action="confirm-new-chat"]').addEventListener('click', async () => {
      const name = modal.querySelector('[data-wg-role="new-chat-name"]').value.trim();
      if (!name) return;

      const selected = Array.from(modal.querySelectorAll('input[type="checkbox"]:checked'))
        .map((cb) => cb.value);

      const members = [
        { identityRef: 'user', role: 'human' },
        ...selected.map((ref) => ({ identityRef: ref, role: 'agent' })),
      ];

      document.body.removeChild(modal);

      try {
        const chat = await apiPost('/protoclaw/group_chats', { name, members });
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
      if (act === 'toggle-settings') {
        viewMode = viewMode === 'settings' ? 'chat' : 'settings';
        openDropdown = null;
        refreshMain();
        if (viewMode === 'settings') loadAdminModelOptions();
        return;
      }
      if (act === 'back-to-chat') { viewMode = 'chat'; refreshMain(); return; }
      if (act === 'mention') { toggleMentionPicker(); return; }
      if (act === 'toggle-links') { toggleLinksArea(); return; }
      if (act === 'add-link') { addLink(); return; }
      if (act === 'send') { handleSend(); return; }
      if (act === 'toggle-dropdown') {
        toggleDropdown(action.dataset.wgDropdownType);
        return;
      }
      if (act === 'cancel-new-chat') return; // handled by modal listener
    }

    // remove link
    const removeLink = e.target.closest('[data-wg-action="remove-link"]');
    if (removeLink) {
      const idx = parseInt(removeLink.dataset.wgLinkIndex);
      pendingLinks.splice(idx, 1);
      renderLinkList();
      return;
    }

    // chat list item
    const chatItem = e.target.closest('[data-wg-chat-id]');
    if (chatItem) {
      selectChat(chatItem.dataset.wgChatId);
      return;
    }

    // mention item
    const mentionItem = e.target.closest('[data-wg-mention]');
    if (mentionItem) {
      insertMention(mentionItem.dataset.wgMention);
      return;
    }

    // mode dropdown item
    const modeItem = e.target.closest('[data-wg-mode-type]');
    if (modeItem) {
      handleModeChange(modeItem.dataset.wgModeType, modeItem.dataset.wgModeValue);
      return;
    }

    // session navigation
    const navItem = e.target.closest('[data-wg-session-nav]');
    if (navItem) {
      navigateToSession(navItem.dataset.wgSessionNav);
      return;
    }
  }

  function onContainerInput(e) {
    const search = e.target.closest('[data-wg-role="search"]');
    if (search) {
      searchKeyword = search.value;
      refreshChatList();
      return;
    }

    // settings field changes
    const field = e.target.closest('[data-wg-field]');
    if (field) {
      const fieldName = field.dataset.wgField;
      if (fieldName === 'admin-model') {
        saveAdminModel(field.value);
      }
    }
  }

  function onContainerChange(e) {
    const field = e.target.closest('[data-wg-field]');
    if (field) {
      handleSettingsFieldChange(field.dataset.wgField, field.value);
    }
  }

  function onContainerKeyDown(e) {
    const editor = e.target.closest('.wg-input-editor');
    if (!editor) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
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

  window.WorkGroupUI = {
    render: renderWorkGroupSurface,
    onContainerClick,
    onContainerInput,
    onContainerChange,
    onContainerKeyDown,
    init,
    destroy: stopPolling,
  };
})();
