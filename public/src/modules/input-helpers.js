/**
 * input-helpers.js — Rollback/Process/Submit 辅助（从 app-main.js 域 AB 提取）
 * 拆出日期：2026-07-04
 *
 * 包含：
 *   - syncRollbackActionButtons / updateRollbackActionVisibility: rollback 按钮显隐
 *   - autoResize: textarea 自动高度
 *   - handleInputKey: 输入框键盘事件（Enter 提交）
 *   - submitInput: 提交文本输入（async）
 *   - getPrimaryInputRequest / requestSupportsAction / getRollbackInputRequest:
 *     输入请求查询（纯函数）
 *   - getAvailableCallIndices / canRollbackMessage: rollback 可用性判断（纯函数）
 *   - saveChatProcessVisibility / hasConversationProcessContent / updateChatProcessToggle:
 *     对话过程显隐
 *   - syncAssistantProcessOnlyRows / applyConversationProcessState: 过程内容 DOM 同步
 *   - window.toggleChatProcessVisibility: 全局切换函数
 *   - submitInputAction: 提交动作输入（async）
 *
 * 依赖全局状态（定义在 app-core.js）:
 *   container, currentMessages, currentInputRequests, currentRuntimeAgentId,
 *   _agentCallActive, lastRenderedInputSignature, showChatProcess,
 *   chatProcessToggle, CHAT_PROCESS_VISIBILITY_KEY, followLatestEnabled
 * 依赖 voice-input.js:
 *   _voiceTranscribing, _voiceRecording, _voicePendingSend, stopVoiceRecording,
 *   _getSessionInputCacheKey, _sessionInputCache
 * 依赖 chat-viewport.js:
 *   beginFollowLatestEntryWindow, requestFollowLatest, notifyChatViewportMutation
 * 依赖 persistent-input.js (Phase B-4):
 *   _syncPersistentActionButton
 * 依赖 app-ui.js:
 *   isChatSurfaceActive, shouldRenderWorkspaceSurface
 * 依赖 app-main.js:
 *   poll, renderInputRequests, syncCollapseStates
 * 依赖 session-view-state.js:
 *   applySessionViewPatch, readCurrentSessionViewState
 */

function syncRollbackActionButtons() {
  const allowRollback = !!getRollbackInputRequest();
  const rows = container.querySelectorAll('.message-row');

  rows.forEach((row, index) => {
    const msg = currentMessages[index];
    const meta = row.querySelector('.message-meta');
    if (!meta) return;

    const existingButton = meta.querySelector('.message-action');
    const shouldShow = allowRollback && canRollbackMessage(msg);

    if (!shouldShow) {
      if (existingButton) {
        existingButton.remove();
      }
      return;
    }

    if (existingButton) {
      existingButton.setAttribute('onclick', 'requestRollbackEdit(' + index + ')');
      existingButton.style.display = '';
      return;
    }

    const button = document.createElement('button');
    button.className = 'message-action';
    button.type = 'button';
    button.textContent = '编辑此轮';
    button.setAttribute('onclick', 'requestRollbackEdit(' + index + ')');
    meta.appendChild(button);
  });
}

function updateRollbackActionVisibility() {
  syncRollbackActionButtons();
}

function autoResize(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px';
}

function handleInputKey(event, requestId, boundRuntimeId = currentRuntimeAgentId) {
  if (event.key === 'Enter') {
    if (event.ctrlKey || event.shiftKey) {
      // Ctrl+Enter or Shift+Enter for new line
      // default behavior is new line, but we might want to ensure it works
      
    } else {
      // Enter for submit
      event.preventDefault();
      submitInput(requestId, boundRuntimeId);
    }
  }
}

// 提交输入
async function submitInput(requestId, boundRuntimeId = currentRuntimeAgentId) {
  if (_voiceTranscribing) return;
  if (_voiceRecording) {
    _voicePendingSend = true;
    stopVoiceRecording();
    return;
  }
  const targetRuntimeId = String(boundRuntimeId || '').trim();
  if (!targetRuntimeId) return;
  const textarea = document.getElementById(`input-${requestId}`);
  const input = textarea ? textarea.value : '';
  const targetCacheKey = textarea?.dataset?.sessionKey || _getSessionInputCacheKey();
  // Wait for background image uploads before reading pending images
  if (typeof _awaitPendingImageUploads === 'function') {
    await _awaitPendingImageUploads();
  }
  const images = typeof getPendingInputImages === 'function' ? getPendingInputImages() : [];

  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(targetRuntimeId)}/input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId,
        input,
        response: {
          kind: 'text',
          text: input,
          ...(images.length > 0 ? { payload: { images } } : {}),
        },
      })
    });
    if (res.ok) {
      if (textarea) {
        textarea.value = '';
        autoResize(textarea);
      }
      if (typeof clearPendingInputImages === 'function') {
        clearPendingInputImages();
      }
      if (targetCacheKey) delete _sessionInputCache[targetCacheKey];
      // 输入卡绑定其渲染时的 runtime；若提交过程中切换了会话，绝不能
      // 把旧 session 的成功结果写进新 session 的输入视图。
      if (currentRuntimeAgentId === targetRuntimeId) {
        beginFollowLatestEntryWindow();
        requestFollowLatest({ forceEnable: true, behavior: 'auto' });
        applySessionViewPatch({ inputRequests: [] });
        lastRenderedInputSignature = '';
        renderInputRequests([]);
      }
      // 乐观标记 agent 进入 calling 状态，使 action button 立即切换为 stop
      if (currentRuntimeAgentId === targetRuntimeId) {
        clearInterruptSuppression(targetRuntimeId);
        _markAgentCallStartedForNotify(targetRuntimeId);
        _agentCallActive.set(targetRuntimeId, true);
        _syncPersistentActionButton();
        renderAgentList();
      }
      // 后台刷新
      poll();
    }
  } catch (e) {
    console.error('提交输入失败:', e);
  }
}

function getPrimaryInputRequest() {
  return Array.isArray(currentInputRequests) && currentInputRequests.length > 0
    ? currentInputRequests[0]
    : null;
}

function requestSupportsAction(request, actionId) {
  return Array.isArray(request?.actions)
    && request.actions.some((action) => action && action.id === actionId);
}

function getRollbackInputRequest() {
  if (!Array.isArray(currentInputRequests)) {
    return null;
  }
  return currentInputRequests.find((request) =>
    requestSupportsAction(request, 'rollback_to_call')
    || requestSupportsAction(request, 'compact_from_call')
  ) || null;
}

function getAvailableCallIndices() {
  const request = getRollbackInputRequest();
  if (!request) return null;
  // Find the action that carries availableCallIndices
  for (const action of (request.actions || [])) {
    if (Array.isArray(action?.data?.availableCallIndices)) {
      return action.data.availableCallIndices;
    }
  }
  // Fallback: if no data is provided (older runtime), return null to signal
  // "unknown" — in that case we allow all user messages to be rollbackable
  // to preserve backward compatibility.
  return null;
}

function canRollbackMessage(msg) {
  if (!getRollbackInputRequest() || !msg || msg.role !== 'user') return false;
  // Seed messages from handoff are never rollbackable
  if (msg.source === 'handoff-seed') return false;
  const available = getAvailableCallIndices();
  // If runtime didn't send availableCallIndices, fall back to allowing all
  if (available === null) return true;
  return available.includes(msg.turn);
}

function saveChatProcessVisibility() {
  try {
    localStorage.setItem(CHAT_PROCESS_VISIBILITY_KEY, showChatProcess ? 'true' : 'false');
  } catch (error) {
    console.warn('Failed to persist chat process visibility:', error);
  }
}

function hasConversationProcessContent(messages = []) {
  return messages.some((msg) =>
    msg?.role === 'system'
    || msg?.role === 'tool'
    || (msg?.role === 'assistant' && !!msg.reasoning)
    || (Array.isArray(msg?.toolCalls) && msg.toolCalls.length > 0)
  );
}

function updateChatProcessToggle(messages = readCurrentSessionViewState().messages) {
  if (!chatProcessToggle) return;
  const hasProcess = hasConversationProcessContent(messages) && !shouldRenderWorkspaceSurface();
  chatProcessToggle.classList.toggle('hidden', !hasProcess);
  if (!hasProcess) return;
  chatProcessToggle.classList.toggle('active', showChatProcess);
  chatProcessToggle.textContent = showChatProcess ? t('hide_process') : t('show_process');
}

function syncAssistantProcessOnlyRows(root = container) {
  root.querySelectorAll('.message-row.assistant').forEach((row) => {
    const content = row.querySelector('.message-content');
    if (!content) return;

    const visibleContent = Array.from(content.children).some((child) => {
      if (child.classList.contains('markdown-body')) {
        return String(child.textContent || '').trim().length > 0;
      }
      if (child.classList.contains('reasoning-block')) {
        return !child.classList.contains('process-hidden');
      }
      if (child.classList.contains('tool-call-container')) {
        return !child.classList.contains('process-hidden');
      }
      return child.offsetParent !== null;
    });

    row.classList.toggle('process-hidden-empty', !visibleContent);
  });
}

function applyConversationProcessState(root = container) {
  if (showChatProcess) {
    // Show mode: only un-hide near-viewport process elements.
    // applyProcessDistance handles the windowing — far elements stay
    // display:none, avoiding the 27-second full-layout bottleneck.
    applyProcessDistance(root);
  } else {
    // Hide mode: hide ALL process elements
    clearProcessDistance(root);
  }

  syncAssistantProcessOnlyRows(root);
  if (!showChatProcess) {
    // Hide mode: safe to sync all (most rows are display:none, early-return)
    syncCollapseStates(root);
  }
  // Show mode: skip syncCollapseStates entirely — it reads scrollHeight
  // on all 1,427 rows causing layout thrashing (27s).
  // Collapse is handled lazily by _applyWindow's Phase 2 for revealed rows.
  updateChatProcessToggle();
  if (typeof ensureChatRuntimeIndicator === 'function') ensureChatRuntimeIndicator();
};

window.toggleChatProcessVisibility = function() {
  const chatViewportTopBefore = container.scrollTop;
  const hasUserMessages = Array.isArray(currentMessages)
    && currentMessages.some(m => m.role === 'user');

  // Anchor-based scroll preservation: record the topmost visible row and
  // its offset from the viewport top. After the toggle changes row heights,
  // we restore scroll so that the same row stays at the same screen position.
  // This is more accurate than preserveTop (absolute scrollTop) because rows
  // above the viewport grow/shrink when process blocks show/hide.
  let anchorIdx = -1;
  let anchorOffsetInViewport = 0;
  if (hasUserMessages) {
    const rows = container.querySelectorAll('.message-row');
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (row.classList.contains('process-hidden') ||
          row.classList.contains('process-hidden-empty')) continue;
      const rowTop = row.offsetTop;
      const rowBottom = rowTop + row.offsetHeight;
      if (rowBottom > chatViewportTopBefore) {
        anchorIdx = i;
        anchorOffsetInViewport = chatViewportTopBefore - rowTop;
        break;
      }
    }
  }

  showChatProcess = !showChatProcess;
  saveChatProcessVisibility();

  // Before un-hiding process elements, record the viewport position so
  // applyProcessDistance can window correctly without triggering a full layout.
  if (showChatProcess && hasUserMessages) {
    precomputeViewportIdx();
  }

  // When there are no user messages, toggling process visibility switches
  // between the welcome page and the (hidden-process) content. This requires
  // a full re-render, not just CSS class toggling.
  if (!hasUserMessages) {
    _lastRenderedChatSig = '';
    render(currentMessages);
  } else {
    applyConversationProcessState(container);
  }

  // Restore scroll position based on the anchor row.
  // If the anchor itself got hidden (e.g. it was a process-only assistant
  // row), walk forward to the next visible row.
  if (anchorIdx >= 0) {
    const rows = container.querySelectorAll('.message-row');
    for (let i = anchorIdx; i < rows.length; i++) {
      const row = rows[i];
      if (row.classList.contains('process-hidden') ||
          row.classList.contains('process-hidden-empty')) continue;
      // Accessing offsetTop forces synchronous layout, giving us the
      // post-toggle position.
      container.scrollTop = row.offsetTop + anchorOffsetInViewport;
      break;
    }
  }

  notifyChatViewportMutation({
    reason: 'process-toggle',
    shouldFollow: followLatestEnabled && isChatSurfaceActive(),
    forceSnap: true,
    allowChase: false,
  });
};

async function submitInputAction(requestId, actionId, payload = {}, boundRuntimeId = currentRuntimeAgentId) {
  try {
    const targetRuntimeId = String(boundRuntimeId || '').trim();
    if (!targetRuntimeId) return;
    const res = await fetch(`/api/agents/${encodeURIComponent(targetRuntimeId)}/input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId,
        input: '',
        response: {
          kind: 'action',
          actionId,
          payload,
        },
      }),
    });
    if (res.ok) {
      if (currentRuntimeAgentId === targetRuntimeId) {
        beginFollowLatestEntryWindow();
        requestFollowLatest({ forceEnable: true, behavior: 'auto' });
        applySessionViewPatch({ inputRequests: [] });
        lastRenderedInputSignature = '';
        renderInputRequests([]);
        clearInterruptSuppression(targetRuntimeId);
        _markAgentCallStartedForNotify(targetRuntimeId);
        _agentCallActive.set(targetRuntimeId, true);
        _syncPersistentActionButton();
        renderAgentList();
      }
      poll();
    }
  } catch (e) {
    console.error('提交动作失败:', e);
  }
}
