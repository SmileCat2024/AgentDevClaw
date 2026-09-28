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
 *   renderMarkdown, enhanceMarkdownTables (modules/markdown-utils.js)
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
 *   onclick="copyMessageContent(...)"
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

// ── 消息 meta 行图标操作（复制 / 编辑此轮）────────────────────────
// 图标本体零 DOM 节点：按钮为空元素，图标由 components.css 的
// .message-icon-action::before mask 绘制（is-icon-copy / .message-action
// / .copied 三种形态），节点预算从每按钮 4 节点降到 1 节点。
// 注意：复制按钮只带 .message-icon-action，不带 .message-action——
// syncRollbackActionButtons（input-helpers.js）用 .message-action 定位
// 编辑按钮，复制按钮混入该类会被误改 onclick。
function getMessageCopyActionHtml(index) {
  return `<button type="button" class="message-icon-action is-icon-copy" title="复制" onclick="copyMessageContent(${index}, this)"></button>`;
}

function getMessageRollbackEditActionHtml(index) {
  return `<button type="button" class="message-action message-icon-action" title="编辑此轮" onclick="requestRollbackEdit(${index})"></button>`;
}

// user / assistant 消息复制原始文本，tool 消息复制原始工具输出 JSON；
// 可回滚消息（仅 user）另给编辑按钮
function getMessageActionButtonsHtml(msg, index) {
  let html = '';
  if (msg.role === 'user' || msg.role === 'assistant' || msg.role === 'tool') {
    html += getMessageCopyActionHtml(index);
  }
  if (canRollbackMessage(msg)) {
    html += getMessageRollbackEditActionHtml(index);
  }
  return html;
}

// Read results are collapsed to 160px by default. Build only the first eight
// lines until the user expands the message, instead of highlighting/mounting
// every hidden line in every historical read. The original message stays intact.
function renderToolResultBody(toolName, template, data, success, toolArgs, index) {
  const previewRead = success && toolName === 'read'
    && data && typeof data === 'object' && data.type !== 'directory'
    && typeof data.content === 'string' && !_userExpandedMsgs.has(index);
  let renderData = data;
  let deferred = false;
  if (previewRead) {
    const lines = data.content.split('\n');
    if (lines.length > 8) {
      renderData = { ...data, content: lines.slice(0, 8).join('\n') };
      deferred = true;
    }
  }
  const html = template.result
    ? applyTemplate(template.result, renderData, success, toolArgs)
    : renderJsonHighlight(renderData);
  return deferred ? '<div class="tool-read-preview">' + html + '</div>' : html;
}

function refreshReadResultForMessage(row, index) {
  const msg = currentMessages[index];
  if (!msg || msg.role !== 'tool') return;
  let call = null;
  for (const message of currentMessages) {
    call = message.toolCalls?.find(item => item.id === msg.toolCallId);
    if (call) break;
  }
  if (call?.name !== 'read') return;
  const body = row.querySelector('.tool-result-body');
  if (!body) return;
  const { success, data } = parseToolResult(msg.content, msg.display);
  runWithSuppressedChatViewportObservers(() => {
    body.innerHTML = renderToolResultBody(call.name, getToolRenderTemplate(call.name),
      data, success, call.arguments || {}, index);
    enhanceMathInElement(body);
    enhanceMarkdownTables(body);
  });
}

// 生成单条消息的 HTML
function renderMessage(msg, index) {
  const role = msg.role;
  const msgId = `msg-${index}`;
  let contentHtml = '';
  let metaHtml = `<div class="role-badge">${role}</div>` + getMessageActionButtonsHtml(msg, index);

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
      const toolsHtml = msg.toolCalls.map((call, ci) => {
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
            <div class="tool-content" id="tcallc-${msgId}-${ci}">${innerHtml}</div>
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

      const bodyHtml = renderToolResultBody(toolName, template, data, success, toolArgs, index);

      html = `
        <div class="message-row ${msg.role}" data-tool-success="${success ? 'true' : 'false'}">
          <div class="message-meta">
            <div class="role-badge">${msg.role}</div>
            ${getMessageActionButtonsHtml(msg, index)}
          </div>
          <div class="message-content" id="${msgId}">
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
        enhanceMarkdownTables(appendedRow);
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

// ── Optimistic user echo（空闲直投路径的本地回显）─────────────────
// delivery:'input' 提交成功后，真实消息要经 agent 消费、push 回 viewer、
// 再等下一轮 poll 才上屏（实测 ~0.1–0.5s）。这里在提交瞬间先在 transcript
// 末尾插入一条 DOM 覆盖层气泡：不进 currentMessages（避开 probe/seq 对账
// 状态机），消息 commit 时按文本尾部对账移除；任何全量重建（render / 会话
// 切换 / 404 清理）会重写 container，覆盖层随 DOM 消失，由 reconcile 的
// isConnected 清理兜底。排队路径（queued）已有排队气泡，不走回显。
let _optimisticEchoes = []; // { text, el }

function pushOptimisticUserEcho({ text, images, sessionReferences } = {}) {
  if (typeof isChatSurfaceActive !== 'function' || !isChatSurfaceActive() || !container) return;
  const echoText = (typeof text === 'string' && text.length > 0) ? text : ' ';
  const row = document.createElement('div');
  row.className = 'message-row user optimistic-user-echo';
  row.innerHTML =
    '<div class="message-meta"><div class="role-badge">user</div></div>'
    + '<div class="message-content markdown-body">' + renderMarkdown(echoText) + '</div>'
    + renderUserImages(images)
    + renderSessionReferenceChips(sessionReferences);
  runWithSuppressedChatViewportObservers(() => {
    const emptyState = container.querySelector('.empty-state');
    if (emptyState) emptyState.remove();
    container.appendChild(row);
    enhanceMathInElement(row);
    enhanceMarkdownTables(row);
  });
  _optimisticEchoes.push({ text: echoText, el: row });
  updateFollowLatestButton();
  notifyChatViewportMutation({
    reason: 'append',
    shouldFollow: followLatestEnabled && isChatSurfaceActive(),
    preserveTop: null,
    allowChase: false,
    preferSmooth: false,
    forceSnap: false,
  });
}

function reconcileOptimisticUserEchoes(messages) {
  if (_optimisticEchoes.length === 0) return;
  // 全量重建后会话 DOM 已被重写，失效记录随 isConnected 清理
  _optimisticEchoes = _optimisticEchoes.filter(e => e.el && e.el.isConnected);
  if (_optimisticEchoes.length === 0) return;
  // 回显生命周期只有几个 poll 周期，只对 transcript 尾部对账
  const scanWindow = 12;
  const tail = Array.isArray(messages) ? messages.slice(-scanWindow) : [];
  const consumed = new Set();
  for (const echo of _optimisticEchoes) {
    for (let i = tail.length - 1; i >= 0; i--) {
      if (consumed.has(i)) continue;
      const m = tail[i];
      if (m && m.role === 'user' && m.content === echo.text) {
        consumed.add(i);
        echo.el.remove();
        echo.el = null;
        break;
      }
    }
  }
  _optimisticEchoes = _optimisticEchoes.filter(e => e.el);
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

    const bodyHtml = renderToolResultBody(toolName, template, data, success, toolArgs, lastIndex);

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
    enhanceMarkdownTables(lastRow);
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

// 工具调用卡（assistant 行内的 .tool-call-container）独立折叠阈值：与
// assistant 行一致。调用参数过长（如无模板工具的大 JSON、长命令）时按卡折叠，
// 不与所在行的折叠状态耦合。
var TOOL_CALL_COLLAPSE_THRESHOLD = 220;

// id 形如 tcallc-msg-<msgIndex>-<callIdx> → 用户偏好键 "<msgIndex>:<callIdx>"
function toolCallKeyFromContentId(id) {
  var m = /^tcallc-msg-(\d+)-(\d+)$/.exec(String(id || ''));
  return m ? (parseInt(m[1], 10) + ':' + parseInt(m[2], 10)) : null;
}

// Phase 1 of the collapse sync: all READS (geometry + state) needed to know
// what a row's collapse state should be. Returns null when the row must be
// left alone (windowing far rows), or a plan for applyRowCollapsePlan.
// Splitting reads from writes lets settleAllRowCollapseStates batch a whole
// session (read pass then write pass): under the full-render tier any
// read-write interleaving on a 50K-node laid-out tree forces a 100ms+
// synchronous reflow per write.
function computeRowCollapsePlan(row) {
  const el = row.querySelector('.message-content');
  if (!el) return null;

  if (row.classList.contains('process-hidden') || row.classList.contains('process-hidden-empty')) {
    return { kind: 'reveal' };
  }

  // Skip rows with process-hidden children (far from viewport in windowing mode)
  // scrollHeight is unreliable for these rows
  if (row.querySelector('.process-hidden') &&
      (row.classList.contains('tool') || row.classList.contains('system'))) return null;

  // Skip cv-hidden rows — reading scrollHeight forces layout of the
  // content-visibility:hidden subtree, triggering Chromium perf warnings
  if (row.classList.contains('process-cv-hidden')) return null;
  if (row.querySelector('.process-cv-hidden')) return null;

  const collapseThreshold = getCollapseThresholdForRow(row);
  const isCollapsible = el.scrollHeight > collapseThreshold;
  const isSystem = row.classList.contains('system');
  // 长工具结果一律默认折叠（用户可展开并记忆偏好）；assistant 文本行保持
  // 仅提供手动折叠按钮、不自动折叠的既有行为。
  const isToolRow = row.classList.contains('tool');
  const shouldCollapse = isCollapsible && (isSystem || isToolRow);

  // 同行内的工具调用卡：长参数按卡折叠。卡片与行共用同一 compute/apply 批次，
  // 保持「读测量 → 写状态」分离（settleAllRowCollapseStates 的批处理契约）。
  var callPlans = [];
  if (!isToolRow) {
    var cards = row.querySelectorAll('.tool-call-container');
    for (var ci = 0; ci < cards.length; ci++) {
      var card = cards[ci];
      if (card.classList.contains('process-hidden') || card.classList.contains('process-cv-hidden')) continue;
      var callContent = card.querySelector('.tool-content');
      if (!callContent || !callContent.id) continue;
      var callKey = toolCallKeyFromContentId(callContent.id);
      if (callKey === null) continue;
      callPlans.push({
        card: card,
        content: callContent,
        isCollapsible: callContent.scrollHeight > TOOL_CALL_COLLAPSE_THRESHOLD,
        userExpanded: _userExpandedToolCalls.has(callKey),
        userCollapsed: _userCollapsedToolCalls.has(callKey),
      });
    }
  }

  // Check if user has manually toggled this row — respect their choice
  var msgId = el.id || '';
  var msgIndex = parseInt(msgId.replace('msg-', ''), 10);
  var userExpanded = !isNaN(msgIndex) && _userExpandedMsgs.has(msgIndex);
  var userCollapsed = !isNaN(msgIndex) && _userCollapsedMsgs.has(msgIndex);

  // 行内已有按卡折叠的调用卡时，行级切换让位给卡片，避免内外两个
  // 展开/收起按钮嵌套叠加。用户显式操作过行折叠时仍保留行控件。
  var hasCollapsibleCall = callPlans.some(function (cp) { return cp.isCollapsible; });
  var suppressRowToggle = hasCollapsibleCall && !userExpanded && !userCollapsed;

  return { kind: 'apply', isCollapsible, userExpanded, userCollapsed, shouldCollapse, callPlans, suppressRowToggle };
}

// Phase 2 of the collapse sync: all WRITES. Every write is diff-guarded —
// re-syncing an already-settled row performs zero mutations, so scanning it
// again during scrolling cannot dirty the layout tree.
function applyRowCollapsePlan(row, plan) {
  const el = row.querySelector('.message-content');
  if (!el) return;

  if (plan.kind === 'reveal') {
    el.classList.remove('collapsed');
    const bar = row.querySelector('.expand-toggle-bar');
    if (bar) bar.remove();
    return;
  }

  // 工具调用卡独立于所在行折叠：行本身不高（早退分支）时也要应用卡状态。
  if (plan.callPlans) {
    for (var cpi = 0; cpi < plan.callPlans.length; cpi++) {
      applyToolCallCollapsePlan(plan.callPlans[cpi]);
    }
  }

  // 卡片已接管折叠：行保持展开且不出行级按钮（单一控件原则）。
  if (plan.suppressRowToggle) {
    el.classList.remove('collapsed');
    const ownedBar = row.querySelector('.expand-toggle-bar');
    if (ownedBar) ownedBar.remove();
    return;
  }

  if (!plan.isCollapsible) {
    el.classList.remove('collapsed');
    const bar = row.querySelector('.expand-toggle-bar');
    if (bar) bar.remove();
    return;
  }

  // Apply collapse state: user preference takes priority over auto-collapse.
  // All four branches fall through to the button creation code below — the
  // toggle button must persist for any collapsible message so the user can
  // reverse their choice. Previously the userExpanded/userCollapsed branches
  // removed the button and returned early, causing the button to vanish on
  // the next poll cycle.
  if (plan.userExpanded) {
    el.classList.remove('collapsed');
  } else if (plan.userCollapsed) {
    el.classList.add('collapsed');
  } else if (plan.shouldCollapse) {
    el.classList.add('collapsed');
  } else {
    el.classList.remove('collapsed');
  }

  let nextBtnBar = row.querySelector('.expand-toggle-bar');
  if (!nextBtnBar) {
    nextBtnBar = document.createElement('div');
    nextBtnBar.className = 'expand-toggle-bar';
    row.appendChild(nextBtnBar);
  }

  // innerHTML is the one write that always reparses even when identical —
  // guard it by comparing the rendered label and state class, or every settle
  // scan re-dirties the layout tree for every collapsible row it touches.
  const isCollapsed = el.classList.contains('collapsed');
  const desiredLabel = getToggleButtonLabel(isCollapsed);
  const desiredCls = isCollapsed ? 'is-collapsed' : 'is-expanded';
  const btn = nextBtnBar.querySelector('.expand-toggle-btn');
  if (!btn || btn.textContent !== desiredLabel || !btn.classList.contains(desiredCls)) {
    nextBtnBar.innerHTML = '<button class="expand-toggle-btn ' + desiredCls + '" onclick="toggleMessage(&quot;' + el.id + '&quot;)">' + desiredLabel + '</button>';
  }
}

// 工具调用卡折叠的写阶段：与行折叠同样的 diff-guard——已定态卡片零写入，
// 滚动期反复扫描不弄脏布局树。
function applyToolCallCollapsePlan(cp) {
  var el = cp.content;
  if (!cp.isCollapsible) {
    el.classList.remove('collapsed');
    var deadBar = cp.card.querySelector('.tool-call-toggle-bar');
    if (deadBar) deadBar.remove();
    return;
  }

  // 用户偏好优先；无偏好时长调用默认折叠。
  if (cp.userExpanded) el.classList.remove('collapsed');
  else el.classList.add('collapsed');

  var bar = cp.card.querySelector('.tool-call-toggle-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'tool-call-toggle-bar';
    cp.card.appendChild(bar);
  }
  var collapsed = el.classList.contains('collapsed');
  var label = getToggleButtonLabel(collapsed);
  var cls = collapsed ? 'is-collapsed' : 'is-expanded';
  var callBtn = bar.querySelector('.expand-toggle-btn');
  if (!callBtn || callBtn.textContent !== label || !callBtn.classList.contains(cls)) {
    bar.innerHTML = '<button class="expand-toggle-btn ' + cls + '" onclick="toggleToolCall(&quot;' + el.id + '&quot;)">' + label + '</button>';
  }
}

function syncRowCollapseState(row) {
  const plan = computeRowCollapsePlan(row);
  if (plan) applyRowCollapsePlan(row, plan);
}

// Whole-session landing settle for the full-render tier: compute every row's
// plan first (reads only, one layout flush total), then apply all writes in
// one batch. After this, scrolling never finds unsettled rows, so the
// scroll-time settle scans are pure reads on a clean layout tree.
function settleAllRowCollapseStates(root) {
  const rows = root.querySelectorAll('.message-row');
  const pending = [];
  rows.forEach(function (row) {
    const plan = computeRowCollapsePlan(row);
    if (plan) pending.push([row, plan]);
  });
  pending.forEach(function (entry) {
    applyRowCollapsePlan(entry[0], entry[1]);
  });
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
    let btn = row && row.querySelector('.expand-toggle-btn');
    if (btn) {
      btn.innerHTML = getToggleButtonLabel(false);
      btn.className = 'expand-toggle-btn is-expanded';
    }
  });

  // Messages the user explicitly collapsed
  _userCollapsedMsgs.forEach(function (index) {
    let el = document.getElementById('msg-' + index);
    if (!el) return;
    let row = el.closest('.message-row');
    if (row && (row.classList.contains('process-hidden') || row.classList.contains('process-hidden-empty'))) return;
    el.classList.add('collapsed');
    let btn = row && row.querySelector('.expand-toggle-btn');
    if (btn) {
      btn.innerHTML = getToggleButtonLabel(true);
      btn.className = 'expand-toggle-btn is-collapsed';
    }
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
    let metaHtml = `<div class="role-badge">${role}</div>` + getMessageActionButtonsHtml(msg, index);

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
        const toolsHtml = msg.toolCalls.map((call, ci) => {
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
              <div class="tool-content" id="tcallc-${msgId}-${ci}">${innerHtml}</div>
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
      
      const bodyHtml = renderToolResultBody(toolName, template, data, success, toolArgs, index);

      rowAttrs = ` data-tool-success="${success ? 'true' : 'false'}"`;
      contentHtml = `
        <div class="message-content" id="${msgId}">
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
    // Within budget, disable the estimated process window and first lay out
    // real rows. chat-row-visibility.js then limits browser work to nearby
    // rows while preserving those measured heights, without scroll folding.
    // Above budget keep pre-hide + windowing: the 134K-node-class sessions
    // that motivated virtualization (historical full-layout freeze) stay
    // protected. Full-render cost at 50K nodes (measured): +122~131MB
    // renderer RSS, one-time ~800ms landing layout. Re-evaluated on every
    // full render; streaming appends keep the current mode until then.
    if (typeof setProcessWindowingDisabled === 'function') {
      setProcessWindowingDisabled(
        container.getElementsByTagName('*').length <= 70000);
    }
    // Pre-hide ALL process elements before any layout read (full-render
    // tiering above makes clearProcessDistance itself skip the pre-hide).
    // Without this, the browser sees 134K visible nodes and freezes on layout.
    // applyProcessDistance (called next) will reveal ~70 near-viewport rows.
    if (typeof clearProcessDistance === 'function') {
      clearProcessDistance(container);
    }
    enhanceMathInElement(container);
    enhanceMarkdownTables(container);
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
    if (typeof revealMeasuredChatRow === 'function') revealMeasuredChatRow(el.closest('.message-row'));
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
      refreshReadResultForMessage(row, msgIndex);
    }

    // Update bottom button
    const btn = row.querySelector('.expand-toggle-btn');
    if (btn) {
      btn.innerHTML = getToggleButtonLabel(isCollapsed);
      btn.className = 'expand-toggle-btn ' + (isCollapsed ? 'is-collapsed' : 'is-expanded');
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

window.toggleToolCall = function(id) {
  const el = document.getElementById(id);
  if (!el) return;
  if (typeof revealMeasuredChatRow === 'function') revealMeasuredChatRow(el.closest('.message-row'));
  const chatViewportTopBefore = container.scrollTop;
  el.classList.toggle('collapsed');
  const isCollapsed = el.classList.contains('collapsed');

  // 记录用户对这张调用卡的显式选择，重渲染后由 computeRowCollapsePlan 恢复
  const callKey = toolCallKeyFromContentId(id);
  if (callKey !== null) {
    if (isCollapsed) {
      _userCollapsedToolCalls.add(callKey);
      _userExpandedToolCalls.delete(callKey);
    } else {
      _userExpandedToolCalls.add(callKey);
      _userCollapsedToolCalls.delete(callKey);
    }
  }

  const card = el.closest('.tool-call-container');
  const btn = card ? card.querySelector('.expand-toggle-btn') : null;
  if (btn) {
    btn.innerHTML = getToggleButtonLabel(isCollapsed);
    btn.className = 'expand-toggle-btn ' + (isCollapsed ? 'is-collapsed' : 'is-expanded');
  }

  notifyChatViewportMutation({
    reason: 'message-toggle',
    shouldFollow: followLatestEnabled && isChatSurfaceActive(),
    preserveTop: followLatestEnabled ? null : chatViewportTopBefore,
    forceSnap: false,
    allowChase: false,
    preferSmooth: false,
  });
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

// 复制一条消息的原始文本（复制模式对齐 chat-context-bar.js 的会话 ID 复制）
window.copyMessageContent = async function(index, btn) {
  const msg = currentMessages[index];
  let text = msg ? String(msg.content || '') : '';
  if (!text) return;
  if (msg.role === 'tool') {
    // 工具原始输出通常是单行 JSON 信封，解析成功则美化缩进后复制，失败保持原文
    try {
      text = JSON.stringify(JSON.parse(text), null, 2);
    } catch (e) { /* 非 JSON 文本，保持原文 */ }
  }
  let ok = false;
  if (navigator.clipboard && window.isSecureContext) {
    try { await navigator.clipboard.writeText(text); ok = true; } catch (e) { ok = false; }
  }
  if (!ok) {
    // Fallback for non-secure contexts (e.g. accessing the UI via a LAN IP)
    try {
      let ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      ok = document.execCommand('copy');
      document.body.removeChild(ta);
    } catch (e) { ok = false; }
  }
  if (!ok) {
    if (typeof ClawToast !== 'undefined') {
      const isZh = typeof currentLanguage !== 'undefined' && currentLanguage === 'zh';
      ClawToast.show({ id: 'chat-copy-msg', status: 'error', title: isZh ? '复制失败' : 'Failed to copy message' });
    }
    return;
  }
  if (btn) {
    btn.classList.add('copied');
    if (btn._copyResetTimer) clearTimeout(btn._copyResetTimer);
    btn._copyResetTimer = setTimeout(function() {
      btn.classList.remove('copied');
    }, 1200);
  }
};

// ── Image rendering ──────────────────────────────────────────────

// 图片资源按宿主机落盘寻址（ADR-0006/0011）：本地会话的附件取自本机
// IMAGES_DIR，远程会话的附件在连接对端主机的同名存储里，经 /r/<connId>
// 资产路由由本机代理转发取回。url 与 path 都是上传宿主机上的引用。
function imageUrlFromImage(img) {
  if (img.url || img.path) {
    let path = img.url
      || ('/protoclaw/images/' + encodeURIComponent(img.path.replace(/\\/g, '/').split('/').pop()));
    const remotePrefix = (typeof window.RemoteConnections?.getRemoteAssetPrefix === 'function'
      && typeof currentRuntimeAgentId === 'string')
      ? window.RemoteConnections.getRemoteAssetPrefix(currentRuntimeAgentId)
      : '';
    if (remotePrefix && path.startsWith('/protoclaw/images/')) {
      path = remotePrefix + path;
    }
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

/**
 * 乐观气泡上的引用 chips（与图片缩略图并列）。引用只在发送瞬间随
 * user-turn metadata 流动，服务端消息不持久化引用字段——chips 不参与
 * 全量重渲染（重渲染后由 session-reference reminder 呈现引用事实）。
 */
function renderSessionReferenceChips(references) {
  if (!Array.isArray(references) || references.length === 0) return '';
  const chips = references.map(function(ref) {
    const label = ref.title || ref.sessionId || '';
    const meta = (ref.agentId || '') + '/' + (ref.sessionType || 'main');
    return '<div class="session-ref-chip is-echo" title="' + escapeHtml(meta + ' · ' + (ref.sessionId || '')) + '">'
      + '<span class="session-ref-chip-label">' + escapeHtml(label) + '</span>'
      + '</div>';
  }).join('');
  return '<div class="message-session-refs">' + chips + '</div>';
}

window.openImageZoom = function(src) {
  let existing = document.getElementById('image-zoom-overlay');
  if (existing) existing.remove();

  let overlay = document.createElement('div');
  overlay.id = 'image-zoom-overlay';
  overlay.className = 'image-zoom-overlay';

  let img = document.createElement('img');
  img.src = src;
  img.onclick = function(e) { e.stopPropagation(); };
  overlay.appendChild(img);

  // 滚轮缩放：1x 即适配尺寸，向上放大、向下缩小，下限 0.2x 上限 8x
  let scale = 1;
  overlay.addEventListener('wheel', function(e) {
    e.preventDefault();
    scale = Math.min(8, Math.max(0.2, scale * (e.deltaY < 0 ? 1.1 : 0.9)));
    img.style.transform = 'scale(' + scale + ')';
  }, { passive: false });

  let onKey = function(e) {
    if (e.key === 'Escape') close();
  };
  let close = function() {
    document.removeEventListener('keydown', onKey);
    overlay.remove();
  };
  overlay.onclick = close;
  document.addEventListener('keydown', onKey);

  document.body.appendChild(overlay);
};

// 跨模块 API 走 window.ClawFW 命名空间（app-core 全局状态纪律）。
// 注意：本文件源码块会被前端 vm 测试按函数标记切取执行，导出语句必须放在
// 文件末尾，避免落入 appendNewMessages…getCollapseThresholdForRow 等切取区间。
window.ClawFW = window.ClawFW || {};
Object.assign(window.ClawFW, {
  pushOptimisticUserEcho,
  reconcileOptimisticUserEchoes,
});
