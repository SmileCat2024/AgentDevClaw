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
 *   cancelChatScrollSettlement, updateFollowLatestButton, getToggleButtonLabel (modules/chat-viewport.js)
 *   getEmptyStateHtml, escapeHtml, t (app-core.js)
 *   renderCurrentMainView, isChatSurfaceActive (app-ui.js)
 *   requestRollbackEdit (modules/rollback-dialog.js)
 *   switchAgent (app-main.js — onclick 字符串引用)
 * 导出全局函数:
 *   renderMessage, appendNewMessages, updateLastMessage,
 *   getCollapseThresholdForRow, syncRowCollapseState, syncCollapseStates,
 *   applyCollapseLogic, restoreUserCollapseState, render
 * 导出全局 window 函数:
 *   toggleMessage, toggleReasoning
 * HTML onclick 引用:
 *   onclick="toggleMessage(...)", onclick="toggleReasoning(...)"
 *   onclick="requestRollbackEdit(...)", onclick="switchAgent(...)"
 */

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
    } else if (msg.content && (msg.content.startsWith('[Error:') || msg.content.startsWith('[API Error:'))) {
      // 错误消息使用红色样式
      innerContent += `<div class="tool-error">${escapeHtml(msg.content)}</div>`;
    } else {
      innerContent += `<div class="markdown-body">${renderMarkdown(msg.content)}</div>`;
    }

    if (msg.toolCalls && msg.toolCalls.length > 0) {
      const toolsHtml = msg.toolCalls.map(call => {
        const displayName = getToolDisplayName(call.name);
        const template = getToolRenderTemplate(call.name);
        let innerHtml;

        if (template.call) {
          innerHtml = applyTemplate(template.call, call.arguments);
        } else {
          innerHtml = renderJsonHighlight(call.arguments);
        }

        return `
          <div class="tool-call-container">
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

      const { success, data } = parseToolResult(msg.content);
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

    const { success, data } = parseToolResult(msg.content);
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

  if (shouldCollapse) {
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
    var el = document.getElementById('reasoning-msg-' + index);
    if (el) el.classList.add('expanded');
  });

  // Messages the user explicitly expanded (override auto-collapse)
  _userExpandedMsgs.forEach(function (index) {
    var el = document.getElementById('msg-' + index);
    if (!el) return;
    var row = el.closest('.message-row');
    if (row && (row.classList.contains('process-hidden') || row.classList.contains('process-hidden-empty'))) return;
    el.classList.remove('collapsed');
    var meta = row && row.querySelector('.message-meta .collapse-toggle svg');
    if (meta) meta.style.transform = 'rotate(0deg)';
    var btn = row && row.querySelector('.expand-toggle-btn');
    if (btn) btn.innerHTML = getToggleButtonLabel(false);
  });

  // Messages the user explicitly collapsed
  _userCollapsedMsgs.forEach(function (index) {
    var el = document.getElementById('msg-' + index);
    if (!el) return;
    var row = el.closest('.message-row');
    if (row && (row.classList.contains('process-hidden') || row.classList.contains('process-hidden-empty'))) return;
    el.classList.add('collapsed');
    var meta = row && row.querySelector('.message-meta .collapse-toggle svg');
    if (meta) meta.style.transform = 'rotate(-90deg)';
    var btn = row && row.querySelector('.expand-toggle-btn');
    if (btn) btn.innerHTML = getToggleButtonLabel(true);
  });
}

function render(messages) {
  if (typeof clearTruncatedHighlightData === 'function') clearTruncatedHighlightData();
  if (messages.length === 0) {
    _lastRenderedChatSig = '';
    cancelChatScrollSettlement();
    container.innerHTML = getEmptyStateHtml();
    updateFollowLatestButton();
    return;
  }

  // Dedup: skip the expensive full HTML generation + DOM rebuild when the
  // message list and tool count haven't changed since the last render.
  // This avoids a redundant container.innerHTML replacement after
  // optimistic cache render → loadAgentData render with identical data.
  const _sig = messages.length + ':'
    + messages[messages.length - 1].role + ':'
    + (messages[messages.length - 1].content || '').length + ':'
    + Object.keys(toolRenderConfigs).length;
  if (_sig === _lastRenderedChatSig && container.querySelector('.message-row')) {
    return;
  }
  _lastRenderedChatSig = _sig;

  const shouldFollowAfterMutation = followLatestEnabled && isChatSurfaceActive();
  const html = messages.map((msg, index) => {
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
          let innerHtml;

          if (template.call) {
            innerHtml = applyTemplate(template.call, call.arguments);
          } else {
            innerHtml = renderJsonHighlight(call.arguments);
          }

          return `
            <div class="tool-call-container">
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

      const { success, data } = parseToolResult(msg.content);
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

  const savedScrollTop = container.scrollTop;
  runWithSuppressedChatViewportObservers(() => {
    container.innerHTML = html;
    enhanceMathInElement(container);
  }, 220);

  updateRollbackActionVisibility();
  applyConversationProcessState(container);
  restoreUserCollapseState(container);
  updateFollowLatestButton();
  notifyChatViewportMutation({
    reason: 'render-full',
    shouldFollow: shouldFollowAfterMutation,
    preserveTop: shouldFollowAfterMutation ? null : savedScrollTop,
    forceSnap: shouldFollowAfterMutation,
    allowChase: false,
  });
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
  if (img.url) return img.url;
  if (img.path) {
    var parts = img.path.replace(/\\/g, '/').split('/');
    return '/protoclaw/images/' + encodeURIComponent(parts[parts.length - 1]);
  }
  if (img.base64) {
    return 'data:' + (img.mediaType || 'image/png') + ';base64,' + img.base64;
  }
  return null;
}

function renderUserImages(images) {
  if (!images || images.length === 0) return '';
  var thumbs = images.map(function(img) {
    var url = imageUrlFromImage(img);
    if (!url) return '';
    return '<div class="message-img-thumb" onclick="openImageZoom(\'' + url.replace(/'/g, "\\'") + '\')">' +
      '<img src="' + url + '" alt="' + escapeHtml(img.source || '') + '">' +
      '</div>';
  }).join('');
  return '<div class="message-images">' + thumbs + '</div>';
}

window.openImageZoom = function(src) {
  var existing = document.getElementById('image-zoom-overlay');
  if (existing) existing.remove();

  var overlay = document.createElement('div');
  overlay.id = 'image-zoom-overlay';
  overlay.className = 'image-zoom-overlay';
  overlay.onclick = function() { overlay.remove(); };

  var img = document.createElement('img');
  img.src = src;
  img.onclick = function(e) { e.stopPropagation(); };
  overlay.appendChild(img);

  document.body.appendChild(overlay);
};
