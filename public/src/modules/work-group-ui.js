/**
 * work-group-ui.js — 群聊指挥台 UI 模块
 *
 * 渲染微信桌面端风格的工作群界面：
 *   左侧：群聊列表 + 搜索 + 新建按钮
 *   右侧：会话头部（态势层）→ 消息流 → 结构化输入框
 *   右上角：设置入口
 *
 * 当前为 demo 阶段，数据全部内置 mock，不依赖后端 API。
 */

(function () {
  'use strict';

  // ── Mock 数据 ──────────────────────────────────────────────

  const MOCK_CHATS = [
    {
      id: 'chat-sys-refactor',
      name: '系统重构',
      type: 'group',
      goal: '重构支付系统，拆分 auth / payment / order 三个模块',
      members: [
        { id: 'user', name: '我', role: 'human', status: 'online' },
        { id: 'helper-main-auth', name: '编程小助手·主代理', tag: 'auth', role: 'agent', status: 'running' },
        { id: 'helper-main-payment', name: '编程小助手·主代理', tag: 'payment', role: 'agent', status: 'idle' },
        { id: 'admin', name: '管理员', role: 'admin', status: 'idle' },
      ],
      messages: [
        { from: 'user', text: '@编程小助手·主代理<auth> 重构 auth 模块的登录逻辑，确保 v1 API 兼容', time: '14:30' },
        { from: 'helper-main-auth', text: '收到，开始分析 auth 模块结构。', time: '14:31' },
        { from: 'helper-main-auth', text: '发现 3 处需要修改的接口，预计修改 3 个文件。', time: '14:33' },
        { from: 'helper-main-auth', text: '重构完成。修改了 login.ts, auth-middleware.ts, session.ts。全部测试通过。', time: '14:52', kind: 'report' },
      ],
      unread: 0,
      lastTime: '14:52',
    },
    {
      id: 'chat-daily-ops',
      name: '每日运维',
      type: 'group',
      goal: '日常运维巡检与异常处理',
      members: [
        { id: 'user', name: '我', role: 'human', status: 'online' },
        { id: 'qqbot-operator', name: '接线员', role: 'agent', status: 'idle' },
        { id: 'dispatch-scheduler', name: '调度员', role: 'agent', status: 'idle' },
        { id: 'admin', name: '管理员', role: 'admin', status: 'idle' },
      ],
      messages: [
        { from: 'dispatch-scheduler', text: '每日巡检定时任务已就绪，下次触发：明天 09:00', time: '昨天' },
      ],
      unread: 1,
      lastTime: '昨天',
    },
    {
      id: 'chat-explore',
      name: '探索调研',
      type: 'group',
      goal: '探索开源代码库，收集架构知识',
      members: [
        { id: 'user', name: '我', role: 'human', status: 'online' },
        { id: 'helper-explore-a', name: '探索代理 A', role: 'agent', status: 'idle' },
        { id: 'helper-explore-b', name: '探索代理 B', role: 'agent', status: 'idle' },
        { id: 'admin', name: '管理员', role: 'admin', status: 'idle' },
      ],
      messages: [
        { from: 'user', text: '探索一下这个仓库的整体架构', time: '前天' },
        { from: 'helper-explore-a', text: '已开始探索，入口文件已读取。', time: '前天' },
      ],
      unread: 0,
      lastTime: '前天',
    },
  ];

  // ── 状态 ────────────────────────────────────────────────────

  let activeChatId = MOCK_CHATS[0].id;
  let viewMode = 'chat'; // 'chat' | 'settings'
  let searchKeyword = '';

  // ── 工具函数 ────────────────────────────────────────────────

  function esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function getChat(id) {
    return MOCK_CHATS.find((c) => c.id === id) || null;
  }

  function getMemberName(chat, fromId) {
    const m = chat.members.find((mem) => mem.id === fromId);
    return m ? m.name : fromId;
  }

  function getMemberTag(chat, fromId) {
    const m = chat.members.find((mem) => mem.id === fromId);
    return m && m.tag ? m.tag : null;
  }

  function statusDot(status) {
    switch (status) {
      case 'running': return '<span class="wg-status-dot running" title="运行中"></span>';
      case 'idle': return '<span class="wg-status-dot idle" title="空闲"></span>';
      case 'online': return '<span class="wg-status-dot online" title="在线"></span>';
      default: return '<span class="wg-status-dot"></span>';
    }
  }

  // ── 左侧：群聊列表 ──────────────────────────────────────────

  function renderChatList() {
    const filtered = searchKeyword
      ? MOCK_CHATS.filter((c) => c.name.toLowerCase().includes(searchKeyword.toLowerCase()))
      : MOCK_CHATS;

    const items = filtered.map((chat) => {
      const isActive = chat.id === activeChatId;
      const lastMsg = chat.messages[chat.messages.length - 1];
      const preview = lastMsg ? `${getMemberName(chat, lastMsg.from)}: ${lastMsg.text}` : '';
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
        `    <div class="wg-chat-top">`,
        `      <span class="wg-chat-name">${esc(chat.name)}</span>`,
        `      <span class="wg-chat-time">${esc(chat.lastTime || '')}</span>`,
        `    </div>`,
        `    <div class="wg-chat-preview">${esc(preview)}</div>`,
        '  </div>',
        chat.unread > 0 ? `  <span class="wg-chat-badge">${chat.unread}</span>` : '',
        '</div>',
      ].join('');
    }).join('');

    return items || '<div class="wg-chat-empty">暂无群聊</div>';
  }

  // ── 右侧：态势层（群头部）──────────────────────────────────

  function renderAwarenessBar(chat) {
    const members = chat.members.map((m) => {
      const isAgent = m.role === 'agent' || m.role === 'admin';
      const tag = m.tag ? `·${esc(m.tag)}` : '';
      return [
        `<span class="wg-member-chip">`,
        statusDot(m.status),
        `<span class="wg-member-name">${esc(m.name)}${tag}</span>`,
        '</span>',
      ].join('');
    }).join('');

    return [
      '<div class="wg-awareness">',
      '  <div class="wg-awareness-members">' + members + '</div>',
      `  <div class="wg-awareness-goal">${esc(chat.goal || '')}</div>`,
      '</div>',
    ].join('');
  }

  // ── 右侧：消息流 ────────────────────────────────────────────

  function renderMessageBubble(chat, msg) {
    const isMe = msg.from === 'user';
    const name = getMemberName(chat, msg.from);
    const tag = getMemberTag(chat, msg.from);
    const tagLabel = tag ? `<span class="wg-msg-tag">&lt;${esc(tag)}&gt;</span>` : '';
    const isReport = msg.kind === 'report';

    const avatarLetter = name.charAt(0);

    if (isMe) {
      return [
        '<div class="wg-msg-row me">',
        '  <div class="wg-msg-body">',
        `    <div class="wg-msg-meta"><span class="wg-msg-author">${esc(name)}</span> <span class="wg-msg-time">${esc(msg.time || '')}</span></div>`,
        `    <div class="wg-msg-bubble ${isReport ? 'report' : ''}">${esc(msg.text)}</div>`,
        '  </div>',
        `  <div class="wg-msg-avatar">${esc(avatarLetter)}</div>`,
        '</div>',
      ].join('');
    }

    return [
      '<div class="wg-msg-row">',
      `  <div class="wg-msg-avatar">${esc(avatarLetter)}</div>`,
      '  <div class="wg-msg-body">',
      `    <div class="wg-msg-meta"><span class="wg-msg-author">${esc(name)}</span>${tagLabel} <span class="wg-msg-time">${esc(msg.time || '')}</span></div>`,
      `    <div class="wg-msg-bubble ${isReport ? 'report' : ''}">${esc(msg.text)}</div>`,
      '  </div>',
      '</div>',
    ].join('');
  }

  function renderMessageList(chat) {
    const bubbles = chat.messages.map((msg) => renderMessageBubble(chat, msg)).join('');
    return '<div class="wg-msg-list">' + bubbles + '</div>';
  }

  // ── 右侧：输入区 ────────────────────────────────────────────

  function renderInputArea() {
    return [
      '<div class="wg-input-area">',
      '  <div class="wg-input-toolbar">',
      '    <button class="wg-input-btn" title="@提及" data-wg-action="mention">@</button>',
      '    <button class="wg-input-btn" title="表情" data-wg-action="emoji">☺</button>',
      '    <button class="wg-input-btn" title="文件" data-wg-action="file">📎</button>',
      '  </div>',
      '  <div class="wg-input-editor" contenteditable="true" data-placeholder="输入消息，@提及成员…"></div>',
      '  <div class="wg-input-footer">',
      '    <span class="wg-input-hint">Enter 发送 · Shift+Enter 换行</span>',
      '    <button class="wg-send-btn" data-wg-action="send">发送</button>',
      '  </div>',
      '</div>',
    ].join('');
  }

  // ── 右侧：设置面板 ──────────────────────────────────────────

  function renderSettingsPanel(chat) {
    const memberRows = chat.members.map((m) => {
      const tag = m.tag ? `（${esc(m.tag)}）` : '';
      return [
        '<div class="wg-settings-row">',
        `  <span class="wg-settings-row-name">${esc(m.name)}${tag}</span>`,
        `  <span class="wg-settings-row-role">${esc(m.role)}</span>`,
        `  <span class="wg-settings-row-status">${statusDot(m.status)}${esc(m.status || '')}</span>`,
        '</div>',
      ].join('');
    }).join('');

    return [
      '<div class="wg-settings-panel">',
      '  <div class="wg-settings-section">',
      '    <div class="wg-settings-section-title">群信息</div>',
      `    <div class="wg-settings-field"><label>群名称</label><input type="text" value="${esc(chat.name)}" class="wg-settings-input" /></div>`,
      `    <div class="wg-settings-field"><label>群目标</label><textarea class="wg-settings-input">${esc(chat.goal || '')}</textarea></div>`,
      '  </div>',
      '  <div class="wg-settings-section">',
      '    <div class="wg-settings-section-title">群成员</div>',
      memberRows,
      '  </div>',
      '  <div class="wg-settings-section">',
      '    <div class="wg-settings-section-title">通知设置</div>',
      '    <div class="wg-settings-field"><label><input type="checkbox" checked /> Agent 报告时通知</label></div>',
      '    <div class="wg-settings-field"><label><input type="checkbox" checked /> 管理员分析完成时通知</label></div>',
      '    <div class="wg-settings-field"><label><input type="checkbox" /> 仅 @我 时通知</label></div>',
      '  </div>',
      '</div>',
    ].join('');
  }

  // ── 右侧：空状态（未选中群聊）──────────────────────────────

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

  // ── 右侧：整体渲染 ──────────────────────────────────────────

  function renderConversation() {
    const chat = getChat(activeChatId);
    if (!chat) {
      return renderEmptyConversation();
    }

    if (viewMode === 'settings') {
      return [
        '<div class="wg-conversation">',
        '  <div class="wg-conv-header">',
        `    <span class="wg-conv-title">${esc(chat.name)} — 设置</span>`,
        '    <div class="wg-conv-actions">',
        '      <button class="wg-icon-btn" data-wg-action="back-to-chat" title="返回聊天">← 返回</button>',
        '    </div>',
        '  </div>',
        renderSettingsPanel(chat),
        '</div>',
      ].join('');
    }

    return [
      '<div class="wg-conversation">',
      '  <div class="wg-conv-header">',
      `    <span class="wg-conv-title">${esc(chat.name)}</span>`,
      '    <div class="wg-conv-actions">',
      '      <button class="wg-icon-btn" data-wg-action="toggle-settings" title="设置">⚙</button>',
      '    </div>',
      '  </div>',
      renderAwarenessBar(chat),
      '<div class="wg-msg-scroll">' + renderMessageList(chat) + '</div>',
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

  // ── 事件处理 ────────────────────────────────────────────────

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

  function onContainerClick(e) {
    const root = e.target.closest('.wg-app');
    if (!root) return;

    const chatItem = e.target.closest('[data-chat-id]');
    if (chatItem) {
      activeChatId = chatItem.dataset.chatId;
      viewMode = 'chat';
      const chat = getChat(activeChatId);
      if (chat) chat.unread = 0;
      refreshChatList();
      refreshMain();
      return;
    }

    const actionEl = e.target.closest('[data-wg-action]');
    if (actionEl) {
      const action = actionEl.dataset.wgAction;
      if (action === 'toggle-settings') {
        viewMode = viewMode === 'settings' ? 'chat' : 'settings';
        refreshMain();
      } else if (action === 'back-to-chat') {
        viewMode = 'chat';
        refreshMain();
      } else if (action === 'new-chat') {
        // demo: 仅闪一下，后续实现
      } else if (action === 'send') {
        handleSend();
      } else if (action === 'mention') {
        const editor = root.querySelector('[data-wg-role]')?.closest('.wg-app')?.querySelector('.wg-input-editor');
        if (editor) {
          editor.focus();
          document.execCommand('insertText', false, '@');
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

  function handleSend() {
    const editor = document.querySelector('.wg-input-editor');
    if (!editor) return;
    const text = editor.textContent.trim();
    if (!text) return;

    const chat = getChat(activeChatId);
    if (!chat) return;

    const now = new Date();
    const time = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
    chat.messages.push({ from: 'user', text, time });
    chat.lastTime = time;
    editor.textContent = '';
    refreshMain();
    refreshChatList();

    // 滚动到底部
    const scroll = document.querySelector('.wg-msg-scroll');
    if (scroll) scroll.scrollTop = scroll.scrollHeight;
  }

  // ── 对外接口 ────────────────────────────────────────────────

  window.WorkGroupUI = {
    render: renderWorkGroupSurface,
    onContainerClick,
    onContainerInput,
    onContainerKeyDown,
  };
})();
