/**
 * chat-renderer.js — 聊天消息渲染
 * 从 app-main.js 拆出（Phase D）
 * 拆出日期：2026-07-05
 *
 * 依赖全局状态（定义在 app-core.js）:
 *   currentMessages, allAgents, toolRenderConfigs, _lastRenderedChatSig,
 *   _userExpandedReasoning, _userExpandedMsgs, _userCollapsedMsgs,
 *   followLatestEnabled, container
 * 依赖全局函数:
 *   renderMarkdown (modules/markdown-utils.js)
 *   parseToolResult, renderJsonHighlight, applyTemplate, enhanceMathInElement,
 *   clearTruncatedHighlightData (modules/template-engine.js)
 *   getToolDisplayName, getToolRenderTemplate (modules/markdown-utils.js)
 *   canRollbackMessage, applyConversationProcessState, updateRollbackActionVisibility (modules/input-helpers.js)
 *   runWithSuppressedChatViewportObservers, notifyChatViewportMutation,
 *   cancelChatScrollSettlement, updateFollowLatestButton, getToggleButtonLabel,
 *   consumePendingChatScrollRestore (modules/chat-viewport.js)
 *   getEmptyStateHtml, escapeHtml, t (app-core.js)
 *   renderCurrentMainView, isChatSurfaceActive (app-ui.js)
 *   requestRollbackEdit (modules/rollback-dialog.js)
 *   switchAgent (app-main.js — onclick 字符串引用)
 * 导出全局函数:
 *   renderMessage, appendNewMessages, updateLastMessage, renderChatEmptyState,
 *   getCollapseThresholdForRow, syncRowCollapseState, syncCollapseStates,
 *   applyCollapseLogic, restoreUserCollapseState, render
 * 导出全局 window 函数:
 *   toggleMessage, toggleReasoning
 * HTML onclick 引用:
 *   onclick="toggleMessage(...)", onclick="toggleReasoning(...)"
 *   onclick="requestRollbackEdit(...)", onclick="switchAgent(...)"
 */

/**
 * Data-driven welcome page decision: when process is hidden and no user
 * message exists in the transcript, show the welcome page instead of
 * (potentially all-hidden) message rows.
 *
 * This replaces the old DOM-patch overlay mechanism (syncProcessHiddenEmptyState)
 * which was fragile: appendNewMessages deleted the overlay's inner .empty-state
 * but left the outer container, causing a blank shell.
 */
function shouldShowChatWelcome(messages) {
  return !showChatProcess
    && Array.isArray(messages)
    && messages.length > 0
    && !messages.some(m => m.role === 'user');
}

// Cached empty-state render: skip the DOM rebuild when the empty-state HTML
// hasn't changed and the container still shows it. Every innerHTML replacement
// restarts the welcome page CSS animations — switching into an empty session
// triggered this 2-3 times in quick succession (optimistic render, message
// fetch, poll append), making the welcome page visibly flicker.
let _lastRenderedChatEmptyHtml = null;

function renderChatEmptyState() {
  const emptyHtml = getEmptyStateHtml();
  if (_lastRenderedChatEmptyHtml === emptyHtml && container.querySelector('.empty-state')) {
    return;
  }
  _lastRenderedChatEmptyHtml = emptyHtml;
  cancelChatScrollSettlement();
  runWithSuppressedChatViewportObservers(() => {
    container.innerHTML = emptyHtml;
  }, 180);
}

// 生成单条消息的 HTML
function renderMessage(msg, index) {
  const role = msg.role;
  const msgId = `msg-${index}`;
  let contentHtml = '';
  let metaHtml = `<div class="role-badge">${role}</div>`;
  if (canRollbackMessage(msg)) {
    metaHtml += `<button class="message-action" onclick="requestRollbackEdit(${index})">编辑此轮</button>`;
  }

  if (role === 'user' || role === 'system') {
    let style = '';
    let rowClass = role;
    if (role === 'system') {
       const isLong = msg.content.includes('\n') || msg.content.length > 60;
       if (isLong) {
         style = 'text-align: left !important;';
         rowClass += ' long-content';
       }
       contentHtml = `<div class="message-content markdown-body" id="${msgId}" style="${style}">${renderMarkdown(msg.content)}</div>`;
    } else {
      contentHtml = `<div class="message-content markdown-body" id="${msgId}">${renderMarkdown(msg.content)}</div>`;
    }

    if (role === 'system') {
       return `
        <div class="message-row ${rowClass}">
          <div class="message-meta">
            ${metaHtml}
          </div>
          ${contentHtml}
        </div>
      `;
    }
    return `
      <div class="message-row ${role}">
        <div class="message-meta">
          ${metaHtml}
        </div>
        ${contentHtml}
        ${renderUserImages(msg.images)}
      </div>
    `;
  } else if (role === 'assistant') {
    let innerContent = '';

    if (msg.reasoning) {
      innerContent += `
        <div class="reasoning-block" id="reasoning-${msgId}">
            <div class="reasoning-header" onclick="toggleReasoning('reasoning-${msgId}')">
              <svg class="reasoning-icon" viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z"></path></svg>
            <span>${escapeHtml(t('thinking_process'))}</span>
          </div>
          <div class="reasoning-content markdown-body">
            ${renderMarkdown(msg.reasoning)}
          </div>
        </div>
      `;
    }

    // 检测子代理完成消息，使用 tool-call-container 风格渲染（类似 glob）
    const agentCompletePattern = /^[\s\S]*\[子代理\s+(\S+)\s+执行完成\]:[\s\S]*$/;
    const agentCompleteMatch = msg.content.match(agentCompletePattern);
    if (agentCompleteMatch) {
      const agentName = agentCompleteMatch[1];
      // 查找子代理对应的 agentId（使用前端的 allAgents 数组）
      const subAgent = allAgents.find(a => a.name === agentName);
      const subAgentId = subAgent ? subAgent.id : null;
      const clickAttr = subAgentId ? `onclick="switchAgent('${subAgentId}')"` : '';
      const linkHtml = subAgentId
        ? `<div style="font-size:11px; color:var(--text-secondary); margin-left:4px; cursor:pointer;" ${clickAttr}>${escapeHtml(t('subagent_view_messages'))}</div>`
        : '';

      innerContent += `
          <div class="tool-call-container">
            <div class="tool-header">
              <span class="tool-header-name">${escapeHtml(t('subagent_done'))}</span>
            </div>
            <div class="tool-content">
              <div class="bash-command">【${escapeHtml(agentName)}】${escapeHtml(t('subagent_done'))}</div>
              ${linkHtml}
            </div>
          </div>
      `;
    } else if (msg.execution?.status === 'failed'
      || (msg.content && (msg.content.startsWith('[Error:') || msg.content.startsWith('[API Error:')))) {
      // 错误消息使用红色样式。
      // 优先读结构化 execution 元数据（随会话持久化，重渲染后仍在）；
      // 文本前缀匹配仅作为旧会话（无 execution 字段）的回退。
      innerContent += `<div class="tool-error">${escapeHtml(msg.content)}</div>`;
    } else {
      innerContent += `<div class="markdown-body">${renderMarkdown(msg.content)}</div>`;
    }

    if (msg.toolCalls && msg.toolCalls.length > 0) {
      const toolsHtml = msg.toolCalls.map(call => {
        const displayName = getToolDisplayName(call.name);
        const template = getToolRenderTemplate(call.name);
        // 工具执行中进度（ticket 025）：callId 配对 + 进度数据经模板第三参传入
        const callIdAttr = call.id ? ` data-tool-call-id="${escapeHtml(String(call.id))}"` : '';
        const progressCtx = typeof resolveToolProgressForCall === 'function'
          ? resolveToolProgressForCall(call)
          : null;
        let innerHtml;

        if (template.call) {
          innerHtml = applyTemplate(template.call, call.arguments, true, progressCtx);
        } else {
          innerHtml = renderJsonHighlight(call.arguments);
        }

        return `
          <div class="tool-call-container"${callIdAttr}>
            <div class="tool-header">
              <span class="tool-header-name">${displayName}</span>
            </div>
            <div class="tool-content">${innerHtml}</div>
          </div>
        `;
      }).join('');
      innerContent += toolsHtml;
    }

    contentHtml = `<div class="message-content" id="${msgId}">${innerContent}</div>`;

  } else if (role === 'tool') {
    const toolCallId = msg.toolCallId;
    let toolName = null;
    let toolArgs = {};

    // 查找对应的工具调用（需要传入完整消息列表）
    return '';  // 这个需要在完整上下文中处理，暂时返回空
  }

  return `
    <div class="message-row ${role}">
      <div class="message-meta">
        ${metaHtml}
      </div>
      ${contentHtml}
      ${renderUserImages(msg.images)}
    </div>
  `;
}

// 追加新消息（保持现有 DOM 状态）
function appendNewMessages(newMessages, startIndex) {
  // If the welcome page should be showing (process hidden + no user messages),
  // do a full render instead of appending rows that would all be hidden.
  if (shouldShowChatWelcome(currentMessages)) {
    render(currentMessages);
    return;
  }
  const shouldFollowAfterMutation = followLatestEnabled && isChatSurfaceActive();
  const chatViewportTopBefore = container.scrollTop;
  // 移除空状态
  const emptyState = container.querySelector('.empty-state');
  runWithSuppressedChatViewportObservers(() => {
    if (emptyState) emptyState.remove();
  });

  // 获取当前消息数量
  const currentCount = container.querySelectorAll('.message-row').length;

  newMessages.forEach((msg, i) => {
    const index = startIndex + i;
    const msgId = `msg-${index}`;
    let html = '';

    if (msg.role === 'user' || msg.role === 'system' || msg.role === 'assistant') {
      html = renderMessage(msg, index);
    } else if (msg.role === 'tool') {
      // tool 需要特殊处理，查找对应的 toolCall
      let toolName = null;
      let toolArgs = {};
      const messages = currentMessages;
      const toolCallId = msg.toolCallId;

      for (const m of messages) {
        if (m.toolCalls) {
          const found = m.toolCalls.find(c => c.id === toolCallId);
          if (found) {
            toolName = found.name;
            toolArgs = found.arguments;
            break;
          }
        }
      }

      const { success, data } = parseToolResult(msg.content, msg.display);
      const displayName = getToolDisplayName(toolName);
      const template = getToolRenderTemplate(toolName);

      let bodyHtml;
      if (template.result) {
         bodyHtml = applyTemplate(template.result, data, success, toolArgs);
      } else {
         bodyHtml = renderJsonHighlight(data);
      }

      html = `
        <div class="message-row ${msg.role}" data-tool-success="${success ? 'true' : 'false'}">
          <div class="message-meta">
            <div class="role-badge">${msg.role}</div>
          </div>
          <div class="message-content" id="${msgId}" style="padding:0; overflow:hidden;">
            <div class="tool-result-header">
              <span class="status-dot ${success ? 'success' : 'error'}"></span>
              <span>${displayName}</span>
            </div>
            <div class="tool-result-body">${bodyHtml}</div>
          </div>
        </div>
      `;
    }

    // 追加到容器
    runWithSuppressedChatViewportObservers(() => {
      container.insertAdjacentHTML('beforeend', html);
      const appendedRow = container.lastElementChild;
      if (appendedRow) {
        // Pre-hide process elements in the new row before any layout
        var pEls = appendedRow.matches('.message-row.tool, .message-row.system')
          ? [appendedRow]
          : Array.from(appendedRow.querySelectorAll('.reasoning-block, .tool-call-container'));
        for (var pi = 0; pi < pEls.length; pi++) {
          pEls[pi].classList.add('process-hidden');
        }
        enhanceMathInElement(appendedRow);
      }
    });
  });

  // 对新消息应用折叠逻辑
  applyCollapseLogic(container, startIndex);
  updateRollbackActionVisibility();
  applyConversationProcessState(container);
  restoreUserCollapseState(container);
  updateFollowLatestButton();
  if (typeof ensureChatRuntimeIndicator === 'function') ensureChatRuntimeIndicator();
  notifyChatViewportMutation({
    reason: 'append',
    shouldFollow: shouldFollowAfterMutation,
    preserveTop: shouldFollowAfterMutation ? null : chatViewportTopBefore,
    allowChase: false,
    preferSmooth: false,
    forceSnap: false,
  });
}

// 更新最后一条消息
function updateLastMessage(msg) {
  // If the welcome page should be showing, do a full render instead of
  // patching a DOM row that doesn't exist.
  if (shouldShowChatWelcome(currentMessages)) {
    render(currentMessages);
    return;
  }
  const shouldFollowAfterMutation = followLatestEnabled && isChatSurfaceActive();
  const chatViewportTopBefore = container.scrollTop;
  const lastIndex = currentMessages.length - 1;
  const lastRow = container.querySelectorAll('.message-row')[lastIndex];
  if (!lastRow) {
    renderCurrentMainView();
    return;
  }

  const msgId = `msg-${lastIndex}`;

  if (msg.role === 'tool') {
    // tool 消息更新：重建 tool-result-body
    const toolCallId = msg.toolCallId;
    let toolName = null;
    let toolArgs = {};

    for (const m of currentMessages) {
      if (m.toolCalls) {
        const found = m.toolCalls.find(c => c.id === toolCallId);
        if (found) {
          toolName = found.name;
          toolArgs = found.arguments;
          break;
        }
      }
    }

    const { success, data } = parseToolResult(msg.content, msg.display);
    const displayName = getToolDisplayName(toolName);
    const template = getToolRenderTemplate(toolName);

    let bodyHtml;
    if (template.result) {
       bodyHtml = applyTemplate(template.result, data, success, toolArgs);
    } else {
       bodyHtml = renderJsonHighlight(data);
    }

    const toolResultBody = lastRow.querySelector('.tool-result-body');
    if (toolResultBody) {
      runWithSuppressedChatViewportObservers(() => {
        toolResultBody.innerHTML = bodyHtml;
      });
    }
    lastRow.dataset.toolSuccess = success ? 'true' : 'false';
    enhanceMathInElement(lastRow);
  } else if (msg.role === 'assistant') {
    // 流式更新：重建 assistant 消息的正文内容
    const contentEl = lastRow.querySelector('.markdown-body:not(.reasoning-content)');
    if (contentEl) {
      runWithSuppressedChatViewportObservers(() => {
        contentEl.innerHTML = renderMarkdown(msg.content || '');
      });
    }
    enhanceMathInElement(lastRow);
  } else {
    enhanceMathInElement(lastRow);
  }

  updateRollbackActionVisibility();
  applyConversationProcessState(container);
  restoreUserCollapseState(container);
  updateFollowLatestButton();
  if (typeof ensureChatRuntimeIndicator === 'function') ensureChatRuntimeIndicator();
  notifyChatViewportMutation({
    reason: 'patch-last',
    shouldFollow: shouldFollowAfterMutation,
    preserveTop: shouldFollowAfterMutation ? null : chatViewportTopBefore,
    allowChase: false,
    preferSmooth: false,
    forceSnap: false,
  });
}

function getCollapseThresholdForRow(row) {
  if (row.classList.contains('assistant')) {
    return 220;
  }
  return 160;
}

function syncRowCollapseState(row) {
  const el = row.querySelector('.message-content');
  if (!el) return;

  const btnBar = row.querySelector('.expand-toggle-bar');
  if (row.classList.contains('process-hidden') || row.classList.contains('process-hidden-empty')) {
    el.classList.remove('collapsed');
    if (btnBar) btnBar.remove();
    return;
  }

  // Skip rows with process-hidden children (far from viewport in windowing mode)
  // scrollHeight is unreliable for these rows
  if (row.querySelector('.process-hidden') && 
      (row.classList.contains('tool') || row.classList.contains('system'))) return;

  // Skip cv-hidden rows — reading scrollHeight forces layout of the
  // content-visibility:hidden subtree, triggering Chromium perf warnings
  if (row.classList.contains('process-cv-hidden')) return;
  if (row.querySelector('.process-cv-hidden')) return;

  const collapseThreshold = getCollapseThresholdForRow(row);
  const isCollapsible = el.scrollHeight > collapseThreshold;
  const isSystem = row.classList.contains('system');
  const toolName = row.querySelector('.tool-result-header span:last-child')?.textContent || '';
  const isReadOrEdit = toolName === 'Read' || toolName === 'Edit';
  const shouldCollapse = isCollapsible && (isSystem || isReadOrEdit);

  if (!isCollapsible) {
    el.classList.remove('collapsed');
    if (btnBar) btnBar.remove();
    const toggle = row.querySelector('.collapse-toggle');
    if (toggle) toggle.style.display = 'none';
    return;
  }

  // Check if user has manually toggled this row — respect their choice
  var msgId = el.id || '';
  var msgIndex = parseInt(msgId.replace('msg-', ''), 10);
  var userExpanded = !isNaN(msgIndex) && _userExpandedMsgs.has(msgIndex);
  var userCollapsed = !isNaN(msgIndex) && _userCollapsedMsgs.has(msgIndex);

  // Apply collapse state: user preference takes priority over auto-collapse.
  // All four branches fall through to the button creation code below — the
  // toggle button must persist for any collapsible message so the user can
  // reverse their choice. Previously the userExpanded/userCollapsed branches
  // removed the button and returned early, causing the button to vanish on
  // the next poll cycle.
  if (userExpanded) {
    el.classList.remove('collapsed');
    const meta = row.querySelector('.message-meta .collapse-toggle svg');
    if (meta) meta.style.transform = 'rotate(0deg)';
  } else if (userCollapsed) {
    el.classList.add('collapsed');
    const meta = row.querySelector('.message-meta .collapse-toggle svg');
    if (meta) meta.style.transform = 'rotate(-90deg)';
  } else if (shouldCollapse) {
    el.classList.add('collapsed');
    const meta = row.querySelector('.message-meta .collapse-toggle svg');
    if (meta) meta.style.transform = 'rotate(-90deg)';
  } else {
    el.classList.remove('collapsed');
    const meta = row.querySelector('.message-meta .collapse-toggle svg');
    if (meta) meta.style.transform = 'rotate(0deg)';
  }

  let nextBtnBar = btnBar;
  if (!nextBtnBar) {
    nextBtnBar = document.createElement('div');
    nextBtnBar.className = 'expand-toggle-bar';
    row.appendChild(nextBtnBar);
  }

  const isCollapsed = el.classList.contains('collapsed');
  nextBtnBar.innerHTML = '<button class="expand-toggle-btn" onclick="toggleMessage(&quot;' + el.id + '&quot;)">' + getToggleButtonLabel(isCollapsed) + '</button>';
}

function syncCollapseStates(containerElement, startIndex = 0) {
  const rows = containerElement.querySelectorAll('.message-row');
  rows.forEach((row, idx) => {
    if (idx < startIndex) return;
    syncRowCollapseState(row);
  });
}

// 应用折叠逻辑（只处理指定索引后的消息）
function applyCollapseLogic(containerElement, startIndex = 0) {
  syncCollapseStates(containerElement, startIndex);
}

// Re-apply user's explicit expand/collapse choices after a full re-render.
// Runs AFTER syncCollapseStates + applyConversationProcessState so user
// preferences take final precedence over auto-collapse rules.
function restoreUserCollapseState(root) {
  // Reasoning blocks: restore expanded state
  _userExpandedReasoning.forEach(function (index) {
    let el = document.getElementById('reasoning-msg-' + index);
    if (el) el.classList.add('expanded');
  });

  // Messages the user explicitly expanded (override auto-collapse)
  _userExpandedMsgs.forEach(function (index) {
    let el = document.getElementById('msg-' + index);
    if (!el) return;
    let row = el.closest('.message-row');
    if (row && (row.classList.contains('process-hidden') || row.classList.contains('process-hidden-empty'))) return;
    el.classList.remove('collapsed');
    let meta = row && row.querySelector('.message-meta .collapse-toggle svg');
    if (meta) meta.style.transform = 'rotate(0deg)';
    let btn = row && row.querySelector('.expand-toggle-btn');
    if (btn) btn.innerHTML = getToggleButtonLabel(false);
  });

  // Messages the user explicitly collapsed
  _userCollapsedMsgs.forEach(function (index) {
    let el = document.getElementById('msg-' + index);
    if (!el) return;
    let row = el.closest('.message-row');
    if (row && (row.classList.contains('process-hidden') || row.classList.contains('process-hidden-empty'))) return;
    el.classList.add('collapsed');
    let meta = row && row.querySelector('.message-meta .collapse-toggle svg');
    if (meta) meta.style.transform = 'rotate(-90deg)';
    let btn = row && row.querySelector('.expand-toggle-btn');
    if (btn) btn.innerHTML = getToggleButtonLabel(true);
  });
}

function render(messages) {
  if (typeof clearTruncatedHighlightData === 'function') clearTruncatedHighlightData();
  if (messages.length === 0 || shouldShowChatWelcome(messages)) {
    _lastRenderedChatSig = '';
    renderChatEmptyState();
    updateFollowLatestButton();
    return;
  }

  // Dedup: skip the expensive full HTML generation + DOM rebuild when the
  // message list and tool count haven't changed since the last render.
  // This avoids a redundant container.innerHTML replacement after
  // optimistic cache render → loadAgentData render with identical data.
  const _sig = buildChatRenderSignature(messages);
  if (_sig === _lastRenderedChatSig && container.querySelector('.message-row')) {
    return;
  }
  _lastRenderedChatSig = _sig;

  const shouldFollowAfterMutation = followLatestEnabled && isChatSurfaceActive();
  // 线程接力分隔条（coder 宿主：非 root 棒在首条消息前显示来源与方式；
  // 无线程 / root 棒 / 模块缺席时为空串，零影响）
  let relaySeparatorHtml = '';
  try {
    if (typeof window.renderThreadRelaySeparatorHtml === 'function' && typeof getCurrentHostAgentRecord === 'function') {
      const hostAgent = getCurrentHostAgentRecord();
      const activeSessionId = hostAgent?.active_workspace_session_id || hostAgent?.workspace_sessions?.activeSessionId || '';
      if (hostAgent?.id && activeSessionId) {
        relaySeparatorHtml = window.renderThreadRelaySeparatorHtml(hostAgent.id, activeSessionId);
      }
    }
  } catch { /* 分隔条是增强显示，任何失败都不影响消息渲染 */ }
  const html = relaySeparatorHtml + messages.map((msg, index) => {
    const role = msg.role;
    const msgId = `msg-${index}`;
    let contentHtml = '';
    let rowAttrs = '';
    let metaHtml = `<div class="role-badge">${role}</div>`;
    if (canRollbackMessage(msg)) {
      metaHtml += `<button class="message-action" onclick="requestRollbackEdit(${index})">编辑此轮</button>`;
    }

    if (role === 'user' || role === 'system') {
      let style = '';
      let rowClass = role;
      if (role === 'system') {
         const isLong = msg.content.includes('\n') || msg.content.length > 60;
         if (isLong) {
           style = 'text-align: left !important;';
           rowClass += ' long-content';
         }
         contentHtml = `<div class="message-content markdown-body" id="${msgId}" style="${style}">${renderMarkdown(msg.content)}</div>`;
      } else {
        contentHtml = `<div class="message-content markdown-body" id="${msgId}">${renderMarkdown(msg.content)}</div>`;
      }
      
      if (role === 'system') {
         return `
          <div class="message-row ${rowClass}">
            <div class="message-meta">
              ${metaHtml}
            </div>
            ${contentHtml}
          </div>
        `;
      }
    } else if (role === 'assistant') {
      let innerContent = '';

      if (msg.reasoning) {
        innerContent += `
          <div class="reasoning-block" id="reasoning-${msgId}">
            <div class="reasoning-header" onclick="toggleReasoning('reasoning-${msgId}')">
              <svg class="reasoning-icon" viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z"></path></svg>
              <span>${escapeHtml(t('thinking_process'))}</span>
            </div>
            <div class="reasoning-content markdown-body">
              ${renderMarkdown(msg.reasoning)}
            </div>
          </div>
        `;
      }

      // 检测子代理完成消息，使用 tool-call-container 风格渲染（类似 glob）
      const agentCompletePattern = /^[\s\S]*\[子代理\s+(\S+)\s+执行完成\]:[\s\S]*$/;
      const agentCompleteMatch = msg.content.match(agentCompletePattern);
      if (agentCompleteMatch) {
        const agentName = agentCompleteMatch[1];
        // 查找子代理对应的 agentId（使用前端的 allAgents 数组）
        const subAgent = allAgents.find(a => a.name === agentName);
        const subAgentId = subAgent ? subAgent.id : null;
        const clickAttr = subAgentId ? `onclick="switchAgent('${subAgentId}')"` : '';
        const linkHtml = subAgentId
          ? `<div style="font-size:11px; color:var(--text-secondary); margin-left:4px; cursor:pointer;" ${clickAttr}>${escapeHtml(t('subagent_view_messages'))}</div>`
          : '';

        innerContent += `
          <div class="tool-call-container">
            <div class="tool-header">
              <span class="tool-header-name">${escapeHtml(t('subagent'))}</span>
            </div>
            <div class="tool-content">
              <div class="bash-command">${escapeHtml(agentName)} ${escapeHtml(t('subagent_done'))}</div>
              ${linkHtml}
            </div>
          </div>
        `;
      } else {
        innerContent += `<div class="markdown-body">${renderMarkdown(msg.content)}</div>`;
      }

      if (msg.toolCalls && msg.toolCalls.length > 0) {
        const toolsHtml = msg.toolCalls.map(call => {
          const displayName = getToolDisplayName(call.name);
          const template = getToolRenderTemplate(call.name);
          // 工具执行中进度（ticket 025）：callId 配对 + 进度数据经模板第三参传入
          const callIdAttr = call.id ? ` data-tool-call-id="${escapeHtml(String(call.id))}"` : '';
          const progressCtx = typeof resolveToolProgressForCall === 'function'
            ? resolveToolProgressForCall(call)
            : null;
          let innerHtml;

          if (template.call) {
            innerHtml = applyTemplate(template.call, call.arguments, true, progressCtx);
          } else {
            innerHtml = renderJsonHighlight(call.arguments);
          }

          return `
            <div class="tool-call-container"${callIdAttr}>
              <div class="tool-header">
                <span class="tool-header-name">${displayName}</span>
              </div>
              <div class="tool-content">${innerHtml}</div>
            </div>
          `;
        }).join('');
        innerContent += toolsHtml;
      }

      contentHtml = `<div class="message-content" id="${msgId}">${innerContent}</div>`;

    } else if (role === 'tool') {
      const toolCallId = msg.toolCallId;
      let toolName = null;
      let toolArgs = {};
      
      for (const m of messages) {
        if (m.toolCalls) {
          const found = m.toolCalls.find(c => c.id === toolCallId);
          if (found) { 
            toolName = found.name;
            toolArgs = found.arguments;
            break; 
          }
        }
      }

      const { success, data } = parseToolResult(msg.content, msg.display);
      rowAttrs = ` data-tool-success="${success ? 'true' : 'false'}"`;
      const displayName = getToolDisplayName(toolName);
      const template = getToolRenderTemplate(toolName);
      
      let bodyHtml;
      if (template.result) {
         bodyHtml = applyTemplate(template.result, data, success, toolArgs);
      } else {
         bodyHtml = renderJsonHighlight(data);
      }

      rowAttrs = ` data-tool-success="${success ? 'true' : 'false'}"`;
      contentHtml = `
        <div class="message-content" id="${msgId}" style="padding:0; overflow:hidden;">
          <div class="tool-result-header">
            <span class="status-dot ${success ? 'success' : 'error'}"></span>
            <span>${displayName}</span>
          </div>
          <div class="tool-result-body">${bodyHtml}</div>
        </div>`;
    }

    return `
      <div class="message-row ${role}"${rowAttrs}>
        <div class="message-meta">
          ${metaHtml}
        </div>
        ${contentHtml}
        ${renderUserImages(msg.images)}
      </div>
    `;
  }).join('');

  const chatContextKey = typeof getChatScrollContextKey === 'function'
    ? getChatScrollContextKey() : null;
  const savedScrollAnchor = typeof consumePendingChatViewportAnchor === 'function'
    ? consumePendingChatViewportAnchor()
    : null;
  const outgoingDomIsSameContext = !!chatContextKey
    && container.dataset
    && container.dataset.chatRenderContext === chatContextKey
    && !!container.querySelector('.message-row');
  const rebuildAnchor = !shouldFollowAfterMutation && !savedScrollAnchor
    && outgoingDomIsSameContext
    && typeof captureChatViewportAnchor === 'function'
    ? captureChatViewportAnchor()
    : null;
  const renderAnchor = savedScrollAnchor || rebuildAnchor;
  const legacyScrollTop = consumePendingChatScrollRestore() ?? container.scrollTop;
  runWithSuppressedChatViewportObservers(() => {
    container.innerHTML = html;
    if (container.dataset && chatContextKey) {
      container.dataset.chatRenderContext = chatContextKey;
    }
    // Pre-hide ALL process elements before any layout read.
    // Without this, the browser sees 134K visible nodes and freezes on layout.
    // applyProcessDistance (called next) will reveal ~70 near-viewport rows.
    if (typeof clearProcessDistance === 'function') {
      clearProcessDistance(container);
    }
    enhanceMathInElement(container);
  }, 220);

  updateRollbackActionVisibility();
  applyConversationProcessState(container);
  // Show-process mode + follow: the landing collapse scan inside
  // applyProcessDistance runs against the pre-lock scrollTop, so it scans a
  // stale position (rows that are still cv-hidden there) instead of the
  // viewport the user is about to see. Locking to the bottom here — before
  // the first paint — puts the viewport at its final position and lets the
  // landing scan fold the visible rows in the same task. Without this, the
  // first frame paints expanded tool blocks and they fold only after the
  // scroll-stop settle (~150ms later): the flash-then-collapse seen when a
  // session renders. The viewport settlement below re-locks idempotently.
  if (shouldFollowAfterMutation && showChatProcess && typeof lockChatViewportToBottomNow === 'function') {
    lockChatViewportToBottomNow();
    if (typeof runLandingCollapseScan === 'function') runLandingCollapseScan();
  }
  restoreUserCollapseState(container);
  if (!shouldFollowAfterMutation && rebuildAnchor
      && typeof applyChatViewportAnchor === 'function') {
    applyChatViewportAnchor(rebuildAnchor);
  } else if (!shouldFollowAfterMutation && savedScrollAnchor
      && typeof applyChatViewportAnchor === 'function') {
    applyChatViewportAnchor(savedScrollAnchor);
  }
  updateFollowLatestButton();
  if (typeof ensureChatRuntimeIndicator === 'function') ensureChatRuntimeIndicator();
  notifyChatViewportMutation({
    reason: 'render-full',
    shouldFollow: shouldFollowAfterMutation,
    preserveAnchor: renderAnchor,
    preserveTop: shouldFollowAfterMutation
      ? null
      : (renderAnchor ? container.scrollTop : legacyScrollTop),
    forceSnap: shouldFollowAfterMutation,
    allowChase: false,
  });
}

function stableSerializeForChatSignature(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(stableSerializeForChatSignature).join(',') + ']';
  }
  return '{' + Object.keys(value).sort().map(function(key) {
    return JSON.stringify(key) + ':' + stableSerializeForChatSignature(value[key]);
  }).join(',') + '}';
}

function hashChatSignaturePart(value) {
  const text = String(value == null ? '' : value);
  let h1 = 0xdeadbeef ^ text.length;
  let h2 = 0x41c6ce57 ^ text.length;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

function buildChatRenderSignature(messages) {
  const configKeys = Object.keys(toolRenderConfigs || {}).sort();
  const parts = [
    'messages=' + messages.length,
    'toolConfigs=' + hashChatSignaturePart(configKeys.map(function(key) {
      return key + ':' + stableSerializeForChatSignature(toolRenderConfigs[key]);
    }).join('|')),
  ];

  messages.forEach(function(msg, index) {
    const renderState = {
      index,
      role: msg.role || '',
      content: msg.content || '',
      reasoning: msg.reasoning || '',
      toolCallId: msg.toolCallId || '',
      toolCalls: msg.toolCalls || null,
      images: msg.images || null,
    };
    const serialized = stableSerializeForChatSignature(renderState);
    parts.push(serialized.length + ':' + hashChatSignaturePart(serialized));
  });

  return parts.join('|');
}

window.toggleMessage = function(id) {
  const el = document.getElementById(id);
  if (el) {
    const chatViewportTopBefore = container.scrollTop;
    el.classList.toggle('collapsed');
    const row = el.closest('.message-row');
    const isCollapsed = el.classList.contains('collapsed');

    // Record user's explicit choice so it survives full re-render
    const msgIndex = parseInt((id || '').replace('msg-', ''), 10);
    if (!isNaN(msgIndex)) {
      if (isCollapsed) {
        _userCollapsedMsgs.add(msgIndex);
        _userExpandedMsgs.delete(msgIndex);
      } else {
        _userExpandedMsgs.add(msgIndex);
        _userCollapsedMsgs.delete(msgIndex);
      }
    }

    // Update meta icon
    const meta = row.querySelector('.message-meta .collapse-toggle svg');
    if (meta) {
       meta.style.transform = isCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)'; // meta uses transform
       // Fix: meta.transform in previous code was wrong, it's meta.style.transform
    }
    
    // Update bottom button
    const btn = row.querySelector('.expand-toggle-btn');
    if (btn) {
      btn.innerHTML = getToggleButtonLabel(isCollapsed);
    }

    notifyChatViewportMutation({
      reason: 'message-toggle',
      shouldFollow: followLatestEnabled && isChatSurfaceActive(),
      preserveTop: followLatestEnabled ? null : chatViewportTopBefore,
      forceSnap: false,
      allowChase: false,
      preferSmooth: false,
    });
  }
};

window.toggleReasoning = function(id) {
  const el = document.getElementById(id);
  if (el) {
    const chatViewportTopBefore = container.scrollTop;
    el.classList.toggle('expanded');

    // Record user's explicit choice so it survives full re-render
    const msgIndex = parseInt((id || '').replace('reasoning-msg-', ''), 10);
    if (!isNaN(msgIndex)) {
      if (el.classList.contains('expanded')) {
        _userExpandedReasoning.add(msgIndex);
      } else {
        _userExpandedReasoning.delete(msgIndex);
      }
    }

    notifyChatViewportMutation({
      reason: 'reasoning-toggle',
      shouldFollow: followLatestEnabled && isChatSurfaceActive(),
      preserveTop: followLatestEnabled ? null : chatViewportTopBefore,
      forceSnap: false,
      allowChase: false,
      preferSmooth: false,
    });
  }
};

// ── Image rendering ──────────────────────────────────────────────

function imageUrlFromImage(img) {
  if (img.url) return window.__PROTOCLAW_APP_URL__?.(img.url) || img.url;
  if (img.path) {
    let parts = img.path.replace(/\\/g, '/').split('/');
    let path = '/protoclaw/images/' + encodeURIComponent(parts[parts.length - 1]);
    return window.__PROTOCLAW_APP_URL__?.(path) || path;
  }
  if (img.base64) {
    return 'data:' + (img.mediaType || 'image/png') + ';base64,' + img.base64;
  }
  return null;
}

function renderUserImages(images) {
  if (!images || images.length === 0) return '';
  let thumbs = images.map(function(img) {
    let url = imageUrlFromImage(img);
    if (!url) return '';
    return '<div class="message-img-thumb" onclick="openImageZoom(\'' + url.replace(/'/g, "\\'") + '\')">' +
      '<img src="' + url + '" alt="' + escapeHtml(img.source || '') + '">' +
      '</div>';
  }).join('');
  return '<div class="message-images">' + thumbs + '</div>';
}

window.openImageZoom = function(src) {
  let existing = document.getElementById('image-zoom-overlay');
  if (existing) existing.remove();

  let overlay = document.createElement('div');
  overlay.id = 'image-zoom-overlay';
  overlay.className = 'image-zoom-overlay';
  overlay.onclick = function() { overlay.remove(); };

  let img = document.createElement('img');
  img.src = src;
  img.onclick = function(e) { e.stopPropagation(); };
  overlay.appendChild(img);

  document.body.appendChild(overlay);
};
