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
 *   _agentCallActive, showChatProcess,
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
 *   poll, syncCollapseStates
 * 依赖 input-render.js:
 *   notifyInputSurfaceChanged（工单 037：patch 写入即声明，手动 render 配对退役）
 * 依赖 session-view-state.js:
 *   applySessionViewPatch, readCurrentSessionViewState
 */

// ── 幂等键（ADR-0011）──────────────────────────────────────────────
// 所有写类提交统一携带（本地忽略、远程强制）：服务端代理闸要求远程写请求
// 必须带幂等键，无键直接 400。只有一条提交路径，不存在 if(remote) 分支。
function newIdempotencyKey() {
  const cryptoObj = (typeof crypto !== 'undefined') ? crypto : null;
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    return cryptoObj.randomUUID();
  }
  return `key-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

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

  // ── 线程路由守卫（coder 工作空间）─────────────────────────────
  // 当前会话已被 successor 接续（非线程 head）时，槽位提交会「成功但
  // 投错目标」：消息被旧 runtime 消费，留在接续前的会话里。此时改走
  // Thread Inbox，由服务端投递给线程当前承接会话。其余情况（head /
  // 无线程 / 其他工作空间）完全走下方现有槽位路径，零行为变化。
  const threadRoute = typeof window.resolveThreadInputRoute === 'function'
    ? window.resolveThreadInputRoute()
    : { route: 'direct' };
  // Thread Inbox 只承载纯文本：带图片的槽位提交显式拒绝（保留输入，
  // 用户可去掉图片或等新会话就绪后重发），绝不静默丢弃附件。
  const hasImages = images.length > 0;
  // 激活通知（skill pill 等）随消息流动：一次取用，槽位直投 / Thread
  // Inbox 兜底共用；全部失败时归还，重试仍携带
  let capabilityActivations = window.ClawSlash?.consumeActivations?.() || null;

  if (threadRoute.route === 'thread' && input.trim()) {
    if (hasImages) {
      _notifyThreadImageUnsupported();
      window.ClawSlash?.restoreActivations?.(capabilityActivations);
      return;
    }
    await _submitInputViaThread(threadRoute.thread, { input, textarea, targetCacheKey, capabilityActivations });
    return;
  }

  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(targetRuntimeId)}/input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-idempotency-key': newIdempotencyKey() },
      body: JSON.stringify({
        requestId,
        input,
        response: {
          kind: 'text',
          text: input,
          payload: {
            ...(images.length > 0 ? { images } : {}),
            ...(capabilityActivations?.length ? { capabilityActivations } : {}),
          },
        },
      }),
    });
    if (res.ok) {
      // composer 常驻后 await 期间不再整块重建，但端点可能翻转（textarea id
      // 随模式切换）。优先按原请求端点定位，端点已切换时回落到容器内唯一
      // composer 输入框；校验仍属同一会话——提交过程中切换了会话，绝不能
      // 把旧 session 的成功清空/写回作用到新 session 的输入视图。
      const liveTextarea = document.getElementById(`input-${requestId}`)
        || document.querySelector('.user-input-textarea:not([disabled])');
      if (liveTextarea
        && (liveTextarea.dataset?.sessionKey || _getSessionInputCacheKey()) === targetCacheKey) {
        liveTextarea.value = '';
        autoResize(liveTextarea);
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
        // patch 写入即声明（工单 037）：乐观清空 inputRequests 自动触发
        // 输入面恢复渲染，无需手动 reset 签名 + 调 render。
        applySessionViewPatch({ inputRequests: [] });
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
      return;
    }
    // 槽位投递失败（runtime 停止/切换中）且当前会话属于活跃线程：
    // 兜底落 Thread Inbox，指令不丢，head 就绪后由服务端投递。
    // 带图片时不兜底（inbox 不支持附件），保留输入供用户重试。
    if ((threadRoute.route === 'direct' && threadRoute.thread) && input.trim() && !hasImages) {
      await _submitInputViaThread(threadRoute.thread, { input, textarea, targetCacheKey, capabilityActivations });
    } else {
      // 无兜底路径：归还激活，输入保留供重试
      window.ClawSlash?.restoreActivations?.(capabilityActivations);
    }
  } catch (e) {
    console.error('提交输入失败:', e);
    // 网络层失败的同款兜底：活跃线程的指令改走 Thread Inbox
    if ((threadRoute.route === 'direct' && threadRoute.thread) && input.trim() && !hasImages) {
      try {
        await _submitInputViaThread(threadRoute.thread, { input, textarea, targetCacheKey, capabilityActivations });
      } catch {
        // Thread Inbox 也不可用：保留输入文本与激活，用户可重试
        window.ClawSlash?.restoreActivations?.(capabilityActivations);
      }
    } else {
      window.ClawSlash?.restoreActivations?.(capabilityActivations);
    }
  }
}

/**
 * Thread Inbox 不支持附件的显式提示（与主聊天入口 persistent-input 的
 * 拒绝语义一致）：保留输入与图片，不做任何清理。
 */
function _notifyThreadImageUnsupported() {
  const isZh = typeof currentLanguage !== 'undefined' && currentLanguage === 'zh';
  if (typeof ClawToast !== 'undefined' && ClawToast?.show) {
    ClawToast.show({
      id: `thread-img-unsupported-${Date.now()}`,
      title: isZh
        ? '会话交接进行中：暂不支持图片输入，请在新会话就绪后重发'
        : 'Session handoff in progress: image input is not supported yet',
      status: 'error',
      autoDismiss: 5000,
    });
  }
}

/**
 * 经 Thread Inbox 提交：消息持久化到线程，由服务端投递给当前承接会话。
 * 成功后清空输入（与槽位路径一致），并给出明确反馈，避免「发出去没反应」。
 */
async function _submitInputViaThread(thread, { input, textarea, targetCacheKey, capabilityActivations }) {
  const isZh = typeof currentLanguage !== 'undefined' && currentLanguage === 'zh';
  const result = await window.submitThreadCommand(thread.threadId, input, {
    ...(capabilityActivations?.length ? { capabilityActivations } : {}),
  });
  const delivered = result?.delivery?.delivered > 0;
  // 清空输入（复用槽位路径的清理语义）：composer 常驻后 await 期间可能切换
  // 会话/端点，校验仍属同一会话再清空，防止清掉新会话的草稿。
  const liveTextarea = (textarea && textarea.isConnected)
    ? textarea
    : document.querySelector('.user-input-textarea:not([disabled])');
  if (liveTextarea
    && (liveTextarea.dataset?.sessionKey || _getSessionInputCacheKey()) === targetCacheKey) {
    liveTextarea.value = '';
    autoResize(liveTextarea);
  }
  if (typeof clearPendingInputImages === 'function') {
    clearPendingInputImages();
  }
  if (targetCacheKey) delete _sessionInputCache[targetCacheKey];
  if (typeof ClawToast !== 'undefined' && ClawToast?.show) {
    ClawToast.show({
      id: `thread-cmd-${Date.now()}`,
      title: isZh
        ? (delivered ? '已投递到线程当前会话' : '已暂存到线程，将在会话接续后投递')
        : (delivered ? 'Delivered to the current thread session' : 'Queued in thread; will deliver after handover'),
      status: 'success',
      autoDismiss: 3200,
    });
  }
  poll();
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

    const hasProcessChild = Array.from(content.children).some((child) =>
      child.classList.contains('reasoning-block')
      || child.classList.contains('tool-call-container')
    );
    const visibleContent = Array.from(content.children).some((child) => {
      if (child.classList.contains('markdown-body')) {
        return String(child.textContent || '').trim().length > 0;
      }
      if (child.classList.contains('reasoning-block')) {
        return !child.classList.contains('process-hidden')
          && !child.classList.contains('process-cv-hidden');
      }
      if (child.classList.contains('tool-call-container')) {
        return !child.classList.contains('process-hidden')
          && !child.classList.contains('process-cv-hidden');
      }
      return child.offsetParent !== null;
    });

    // In show-process mode, a far process-only row is still a real layout
    // row: its children use content-visibility and retain intrinsic height.
    // Treating those children as invisible here adds process-hidden-empty and
    // removes the row from layout, which invalidates the viewport model.
    const shouldHideEmptyRow = showChatProcess
      ? !hasProcessChild && !visibleContent
      : !visibleContent;
    row.classList.toggle('process-hidden-empty', shouldHideEmptyRow);
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

  // Follow mode has one authoritative scroll operation: the viewport
  // mutation settlement below. Restoring the old anchor first creates a
  // visible intermediate position, which is immediately overwritten by the
  // process-toggle follow snap. Anchor restoration is only for readers who
  // are intentionally not following the latest message.
  if (!followLatestEnabled && anchorIdx >= 0) {
    const rows = container.querySelectorAll('.message-row');
    for (let i = anchorIdx; i < rows.length; i++) {
      const row = rows[i];
      if (row.classList.contains('process-hidden') ||
          row.classList.contains('process-hidden-empty')) continue;
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
      headers: { 'Content-Type': 'application/json', 'x-idempotency-key': newIdempotencyKey() },
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
        // 乐观清空即声明（工单 037）：渲染由 patch hook 同步触发，不等 poll。
        applySessionViewPatch({ inputRequests: [] });
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
