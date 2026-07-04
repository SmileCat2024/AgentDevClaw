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

function handleInputKey(event, requestId) {
  if (event.key === 'Enter') {
    if (event.ctrlKey || event.shiftKey) {
      // Ctrl+Enter or Shift+Enter for new line
      // default behavior is new line, but we might want to ensure it works
      return;
    } else {
      // Enter for submit
      event.preventDefault();
      submitInput(requestId);
    }
  }
}

// 提交输入
async function submitInput(requestId) {
  if (_voiceTranscribing) return;
  if (_voiceRecording) {
    _voicePendingSend = true;
    stopVoiceRecording();
    return;
  }
  const textarea = document.getElementById(`input-${requestId}`);
  const input = textarea ? textarea.value : '';
  const targetCacheKey = textarea?.dataset?.sessionKey || _getSessionInputCacheKey();

  try {
    const res = await fetch(`/api/agents/${currentRuntimeAgentId}/input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId,
        input,
        response: {
          kind: 'text',
          text: input,
        },
      })
    });
    if (res.ok) {
      if (textarea) {
        textarea.value = '';
        autoResize(textarea);
      }
      if (targetCacheKey) delete _sessionInputCache[targetCacheKey];
      beginFollowLatestEntryWindow();
      requestFollowLatest({ forceEnable: true, behavior: 'auto' });
      // 乐观清空输入请求并立即重渲染，避免等待下一轮 poll 才归位
      currentInputRequests = [];
      window.lastInputRequests = [];
      lastRenderedInputSignature = '';
      renderInputRequests([]);
      // 乐观标记 agent 进入 calling 状态，使 action button 立即切换为 stop
      if (currentRuntimeAgentId) {
        _agentCallActive.set(currentRuntimeAgentId, true);
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

function updateChatProcessToggle() {
  if (!chatProcessToggle) return;
  const hasProcess = hasConversationProcessContent(currentMessages) && !shouldRenderWorkspaceSurface();
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
  root.querySelectorAll('.message-row.system').forEach((row) => {
    row.classList.toggle('process-hidden', !showChatProcess);
  });

  root.querySelectorAll('.reasoning-block').forEach((block) => {
    block.classList.toggle('process-hidden', !showChatProcess);
  });

  root.querySelectorAll('.message-row.assistant .tool-call-container').forEach((block) => {
    block.classList.toggle('process-hidden', !showChatProcess);
  });

  root.querySelectorAll('.message-row.tool').forEach((row) => {
    row.classList.toggle('process-hidden', !showChatProcess);
  });

  syncAssistantProcessOnlyRows(root);
  syncCollapseStates(root);
  updateChatProcessToggle();
};

window.toggleChatProcessVisibility = function() {
  const chatViewportTopBefore = container.scrollTop;
  showChatProcess = !showChatProcess;
  saveChatProcessVisibility();
  applyConversationProcessState(container);
  notifyChatViewportMutation({
    reason: 'process-toggle',
    shouldFollow: followLatestEnabled && isChatSurfaceActive(),
    preserveTop: followLatestEnabled ? null : chatViewportTopBefore,
    forceSnap: true,
    allowChase: false,
  });
};

async function submitInputAction(requestId, actionId, payload = {}) {
  try {
    const res = await fetch(`/api/agents/${currentRuntimeAgentId}/input`, {
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
      beginFollowLatestEntryWindow();
      requestFollowLatest({ forceEnable: true, behavior: 'auto' });
      // 乐观清空输入请求并立即重渲染
      currentInputRequests = [];
      window.lastInputRequests = [];
      lastRenderedInputSignature = '';
      renderInputRequests([]);
      if (currentRuntimeAgentId) {
        _agentCallActive.set(currentRuntimeAgentId, true);
        _syncPersistentActionButton();
        renderAgentList();
      }
      poll();
    }
  } catch (e) {
    console.error('提交动作失败:', e);
  }
}
