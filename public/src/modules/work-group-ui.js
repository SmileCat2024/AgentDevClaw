/**
 * work-group-ui.js — 群聊指挥台 UI 模块
 *
 * 渲染微信桌面端风格的工作群界面：
 *   左侧：群聊列表 + 搜索 + 新建按钮
 *   右侧：会话头部（态势层）→ 消息流 → 结构化输入框
 *
 * 数据来自后端 API（/protoclaw/group_chats/*）。
 */

(function () {
  'use strict';

  // ── 状态 ────────────────────────────────────────────────────

  let chatSummaries = [];
  let activeChat = null;
  let activeChatId = null;
  let identities = [];
  let viewMode = 'chat';
  let searchKeyword = '';
  let pollTimer = null;
  let isLoading = false;
  let pendingLinks = []; // 当前消息编辑中已添加的链接

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
      identities = (data.identities || []).filter((i) => i.sessionModel === 'persistent');
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
    if (d.toDateString() === now.toDateString()) {
      return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    }
    return `${d.getMonth() + 1}/${d.getDate()}`;
  }

  function getMemberName(chat, from) {
    if (from === 'user') return '我';
    const m = (chat.members || []).find((mem) => mem.identityRef === from);
    if (m) {
      const id = identities.find((i) => i.identityRef === from);
      return id ? id.displayName : from;
    }
    return from;
  }

  function routingBadge(routing) {
    if (!routing) return '';
    const status = routing.status;
    const agentId = routing.targetWorkspaceId;
    const navLink = agentId
      ? ` <a class="wg-routing-link" data-wg-action="navigate-agent" data-wg-agent-id="${esc(agentId)}" title="跳转到 ${esc(agentId)} 会话">查看 &rarr;</a>`
      : '';
    if (status === 'pending') return ' <span class="wg-routing-badge pending" title="等待派发">⌛</span>';
    if (status === 'delivered') return ` <span class="wg-routing-badge delivered" title="已派发，执行中">🔄</span>${navLink}`;
    if (status === 'completed') return ` <span class="wg-routing-badge completed" title="已完成">✓</span>${navLink}`;
    if (status === 'failed') return ` <span class="wg-routing-badge failed" title="${esc(routing.error || '失败')}">✗</span>`;
    return '';
  }

  // ── 左侧：群聊列表 ──────────────────────────────────────────

  function renderChatList() {
    const filtered = searchKeyword
      ? chatSummaries.filter((c) => (c.name || '').toLowerCase().includes(searchKeyword.toLowerCase()))
      : chatSummaries;

    const items = filtered.map((chat) => {
      const isActive = chat.id === activeChatId;
      const lastMsg = chat.lastMessage;
      const preview = lastMsg ? `${lastMsg.from === 'user' ? '我' : lastMsg.from}: ${lastMsg.text}` : '';
      return [
        `<div class="wg-chat-item ${isActive ? 'active' : ''}" data-chat-id="${esc(chat.id)}">`,
        '  <div class="wg-chat-avatar">',
        '    <svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="currentColor" stroke-width="1.5">',
        '      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>',
        '      <circle cx="9" cy="7" r="4"/>',
        '      <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>',
        '      <path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
        '    </svg>',
        '  </div>',
        '  <div class="wg-chat-info">',
        '    <div class="wg-chat-top">',
        `      <span class="wg-chat-name">${esc(chat.name)}</span>`,
        `      <span class="wg-chat-time">${esc(formatTime(chat.updatedAt || chat.createdAt))}</span>`,
        '    </div>',
        `    <div class="wg-chat-preview">${esc(preview)}</div>`,
        '  </div>',
        '</div>',
      ].join('');
    }).join('');

    return items || '<div class="wg-chat-empty">暂无群聊，点击 + 创建</div>';
  }

  // ── 右侧：态势层（群头部）──────────────────────────────────

  function renderAwarenessBar(chat) {
    const agentMembers = (chat.members || []).filter((m) => m.role === 'agent');
    const memberChips = agentMembers.map((m) => {
      const id = identities.find((i) => i.identityRef === m.identityRef);
      const name = id ? id.displayName : m.identityRef;
      return [
        '<span class="wg-member-chip">',
        `<span class="wg-member-name">${esc(name)}</span>`,
        '</span>',
      ].join('');
    }).join('');

    return [
      '<div class="wg-awareness">',
      '  <div class="wg-awareness-members">' + memberChips + '</div>',
      `  <div class="wg-awareness-goal">${esc(chat.goal || '')}</div>`,
      '</div>',
    ].join('');
  }

  // ── 右侧：消息流 ────────────────────────────────────────────

  function renderMessageBubble(chat, msg) {
    const isMe = msg.from === 'user';
    const name = getMemberName(chat, msg.from);
    const time = formatTime(msg.timestamp);
    const badge = isMe ? routingBadge(msg.routing) : '';

    // 链接引用渲染
    const linksHtml = (Array.isArray(msg.links) && msg.links.length > 0)
      ? '<div class="wg-msg-links">' + msg.links.map((l) => {
          return `<a href="${esc(l.url)}" target="_blank" class="wg-msg-link">🔗 ${esc(l.description || l.url)}</a>`;
        }).join('') + '</div>'
      : '';

    const avatarLetter = name.charAt(0);

    if (isMe) {
      return [
        '<div class="wg-msg-row me">',
        '  <div class="wg-msg-body">',
        `    <div class="wg-msg-meta"><span class="wg-msg-author">${esc(name)}</span> <span class="wg-msg-time">${esc(time)}</span>${badge}</div>`,
        `    <div class="wg-msg-bubble">${esc(msg.text)}</div>`,
        linksHtml,
        '  </div>',
        `  <div class="wg-msg-avatar">${esc(avatarLetter)}</div>`,
        '</div>',
      ].join('');
    }

    return [
      '<div class="wg-msg-row">',
      `  <div class="wg-msg-avatar">${esc(avatarLetter)}</div>`,
      '  <div class="wg-msg-body">',
      `    <div class="wg-msg-meta"><span class="wg-msg-author">${esc(name)}</span> <span class="wg-msg-time">${esc(time)}</span></div>`,
      `    <div class="wg-msg-bubble">${esc(msg.text)}</div>`,
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
      '    <button class="wg-input-btn" title="@提及" data-wg-action="mention">@</button>',
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
      '    <button class="wg-send-btn" data-wg-action="send">发送</button>',
      '  </div>',
      '</div>',
    ].join('');
  }

  // ── 右侧：设置面板 ──────────────────────────────────────────

  function renderSettingsPanel(chat) {
    const memberRows = (chat.members || []).map((m) => {
      const id = identities.find((i) => i.identityRef === m.identityRef);
      const name = id ? id.displayName : (m.identityRef === 'user' ? '我' : m.identityRef);
      return [
        '<div class="wg-settings-row">',
        `  <span class="wg-settings-row-name">${esc(name)}</span>`,
        `  <span class="wg-settings-row-role">${esc(m.role)}</span>`,
        '</div>',
      ].join('');
    }).join('');

    return [
      '<div class="wg-settings-panel">',
      '  <div class="wg-settings-section">',
      '    <div class="wg-settings-section-title">群信息</div>',
      `    <div class="wg-settings-field"><label>群名称</label><input type="text" value="${esc(chat.name)}" class="wg-settings-input" data-wg-field="name" /></div>`,
      `    <div class="wg-settings-field"><label>群目标</label><textarea class="wg-settings-input" data-wg-field="goal">${esc(chat.goal || '')}</textarea></div>`,
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
      '  <svg viewBox="0 0 24 24" width="64" height="64" fill="none" stroke="currentColor" stroke-width="1">',
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
    if (!activeChatId) {
      return renderEmptyConversation();
    }
    if (!activeChat) {
      return renderLoadingConversation();
    }

    if (viewMode === 'settings') {
      return [
        '<div class="wg-conversation">',
        '  <div class="wg-conv-header">',
        `    <span class="wg-conv-title">${esc(activeChat.name)} — 设置</span>`,
        '    <div class="wg-conv-actions">',
        '      <button class="wg-icon-btn" data-wg-action="back-to-chat" title="返回聊天">← 返回</button>',
        '    </div>',
        '  </div>',
        renderSettingsPanel(activeChat),
        '</div>',
      ].join('');
    }

    return [
      '<div class="wg-conversation">',
      '  <div class="wg-conv-header">',
      `    <span class="wg-conv-title">${esc(activeChat.name)}</span>`,
      '    <div class="wg-conv-actions">',
      '      <button class="wg-icon-btn" data-wg-action="toggle-settings" title="设置">⚙</button>',
      '    </div>',
      '  </div>',
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
      '      <button class="wg-new-chat-btn" data-wg-action="new-chat" title="新建群聊">+</button>',
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
    if (main) {
      main.innerHTML = renderConversation();
    }
  }

  function refreshChatList() {
    const list = document.querySelector('[data-wg-role="chat-list"]');
    if (list) {
      list.innerHTML = renderChatList();
    }
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
        refreshMain();
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

    // 解析 @mentions：从文本中提取已选 mention，或解析 @displayName 格式
    const mentions = [];
    for (const id of identities) {
      const atName = `@${id.displayName}`;
      if (text.includes(atName)) {
        mentions.push({ identityRef: id.identityRef });
      }
    }

    editor.textContent = '';
    editor.focus();

    // 收集链接
    const links = pendingLinks.slice();
    pendingLinks = [];

    try {
      await apiPost(`/protoclaw/group_chats/${encodeURIComponent(activeChatId)}/messages`, {
        text,
        mentions,
        links: links.length > 0 ? links : undefined,
      });
      await loadActiveChat();
      refreshMain();
      scrollToBottom();
      // 刷新群聊列表（更新 lastMessage）
      await loadChatSummaries();
      refreshChatList();
    } catch (err) {
      console.error('[WorkGroup] send failed:', err);
      // 恢复文本到编辑器
      editor.textContent = text;
    }
  }

  function toggleMentionPicker() {
    const picker = document.querySelector('[data-wg-role="mention-picker"]');
    if (picker) {
      picker.style.display = picker.style.display === 'none' ? 'block' : 'none';
    }
  }

  function toggleLinksArea() {
    const area = document.querySelector('[data-wg-role="links-area"]');
    if (area) {
      area.style.display = area.style.display === 'none' ? 'flex' : 'none';
    }
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
    if (pendingLinks.length === 0) {
      list.innerHTML = '';
      return;
    }
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
    const mentionText = `@${id.displayName} `;
    document.execCommand('insertText', false, mentionText);

    const picker = document.querySelector('[data-wg-role="mention-picker"]');
    if (picker) picker.style.display = 'none';
  }

  async function handleNewChat() {
    const name = prompt('群聊名称');
    if (!name) return;

    try {
      const chat = await apiPost('/protoclaw/group_chats', { name });
      await loadChatSummaries();
      refreshChatList();
      await selectChat(chat.id);
    } catch (err) {
      console.error('[WorkGroup] create chat failed:', err);
      alert('创建群聊失败: ' + err.message);
    }
  }

  function onContainerClick(e) {
    const root = e.target.closest('.wg-app');
    if (!root) return;

    // 选择群聊
    const chatItem = e.target.closest('[data-chat-id]');
    if (chatItem) {
      selectChat(chatItem.dataset.chatId);
      return;
    }

    // 选择 mention
    const mentionItem = e.target.closest('[data-wg-mention]');
    if (mentionItem) {
      insertMention(mentionItem.dataset.wgMention);
      return;
    }

    // 动作按钮
    const actionEl = e.target.closest('[data-wg-action]');
    if (actionEl) {
      const action = actionEl.dataset.wgAction;
      if (action === 'navigate-agent') {
        const agentId = actionEl.dataset.wgAgentId;
        if (agentId && typeof window.switchAgent === 'function') {
          window.switchAgent(agentId);
        }
        return;
      }
      if (action === 'toggle-settings') {
        viewMode = viewMode === 'settings' ? 'chat' : 'settings';
        refreshMain();
      } else if (action === 'back-to-chat') {
        viewMode = 'chat';
        refreshMain();
      } else if (action === 'new-chat') {
        handleNewChat();
      } else if (action === 'send') {
        handleSend();
      } else if (action === 'mention') {
        toggleMentionPicker();
      } else if (action === 'toggle-links') {
        toggleLinksArea();
      } else if (action === 'add-link') {
        addLink();
      } else if (action === 'remove-link') {
        const idx = parseInt(actionEl.dataset.wgLinkIndex);
        if (!isNaN(idx)) {
          pendingLinks.splice(idx, 1);
          renderLinkList();
        }
      }
    }
  }

  function onContainerInput(e) {
    const searchEl = e.target.closest('[data-wg-role="search"]');
    if (searchEl) {
      searchKeyword = searchEl.value;
      refreshChatList();
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
    onContainerKeyDown,
    init,
    destroy: stopPolling,
  };
})();
