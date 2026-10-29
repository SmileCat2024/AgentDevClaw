/**
 * input-helpers.js — Rollback/Process/Submit 辅助（从 app-main.js 域 AB 提取）
 * 拆出日期：2026-07-04
 *
 * 包含：
 *   - syncRollbackActionButtons / updateRollbackActionVisibility: rollback 按钮显隐
 *   - autoResize: textarea 自动高度
 *   - getPrimaryInputRequest / requestSupportsAction / getRollbackInputRequest:
 *     输入请求查询（纯函数）
 *   - getAvailableCallIndices / canRollbackMessage: rollback 可用性判断（纯函数）
 *   - saveChatProcessVisibility / updateChatProcessToggle:
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

// ── rollback / compact action 应答 ────────────────────────────────────
function captureInputViewToken(runtimeId) {
  return typeof captureSessionViewToken === 'function'
    ? captureSessionViewToken(runtimeId)
    : null;
}

function isInputViewTokenCurrent(token, runtimeId) {
  return token && typeof isSessionViewTokenCurrent === 'function'
    ? isSessionViewTokenCurrent(token)
    : currentRuntimeAgentId === runtimeId;
}

function commitInputViewPatch(token, patch, runtimeId) {
  if (token && typeof commitSessionViewState === 'function') {
    return commitSessionViewPatch(token, patch);
  }
  if (currentRuntimeAgentId !== runtimeId) return false;
  applySessionViewPatch(patch);
  return true;
}

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

  rows.forEach((row) => {
    const msgId = row.querySelector('.message-content')?.id || '';
    const match = /^msg-(\d+)$/.exec(msgId);
    const index = match ? Number(match[1]) : -1;
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

    // 图标按钮 HTML 由 chat-renderer.js 统一提供，与渲染路径保持同一形态
    meta.insertAdjacentHTML('beforeend', getMessageRollbackEditActionHtml(index));
  });
}

function updateRollbackActionVisibility() {
  syncRollbackActionButtons();
}

function autoResize(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px';
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
  if (available.includes(msg.turn)) return true;
  // 防御（低概率竞态）：lease 广播的 availableCallIndices 偶发缺最新轮的
  // checkpoint（广播早于 checkpoint 提交）。最新一条用户消息正是「回退到
  // 刚说的话」的目标：宁可放行（执行时 runtime 按实际 checkpoints 校验，
  // 真不存在会明确失败并 toast），也不静默禁用按钮。
  for (let i = currentMessages.length - 1; i >= 0; i--) {
    if (currentMessages[i]?.role !== 'user') continue;
    return currentMessages[i] === msg;
  }
  return false;
}

function saveChatProcessVisibility() {
  try {
    localStorage.setItem(CHAT_PROCESS_VISIBILITY_KEY, showChatProcess ? 'true' : 'false');
  } catch (error) {
    console.warn('Failed to persist chat process visibility:', error);
  }
}

function updateChatProcessToggle() {
  if (!chatProcessToggle) return;
  // 聊天界面常驻显示：数据未到位也不隐藏，与 chat-context-bar 同一显隐
  // 逻辑（非聊天界面时隐藏），避免加载期间按钮出现/消失的布局跳动。
  const show = !shouldRenderWorkspaceSurface();
  chatProcessToggle.classList.toggle('hidden', !show);
  if (!show) return;
  chatProcessToggle.classList.toggle('active', showChatProcess);
  chatProcessToggle.textContent = showChatProcess ? t('hide_process') : t('show_process');
}

function syncAssistantProcessOnlyRows(root = container, fromIndex = 0) {
  // fromIndex 之后才可能是新插入 / 被 patch 的行，旧行的空行判定不随
  // 尾部追加变化；child 探测里的 offsetParent 读取在布局脏时会强制
  // flush，遍历必须限定在尾部范围。fromIndex 是 DOM 行下标，不是消息
  // 下标（错误聚合会合并行），因此按全行列表而非 .assistant 子集截断。
  const rows = root.querySelectorAll('.message-row');
  for (let i = Math.max(0, fromIndex | 0); i < rows.length; i++) {
    const row = rows[i];
    if (!row.classList.contains('assistant')) continue;
    const content = row.querySelector('.message-content');
    if (!content) continue;

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
  }
}

function applyConversationProcessState(root = container, fromIndex = 0) {
  if (showChatProcess) {
    // Show mode: applyProcessDistance handles the windowing. Incremental
    // calls (append/patch with fromIndex > 0) only touch tail rows.
    applyProcessDistance(root, fromIndex);
  } else {
    // Hide mode: hide ALL process elements
    clearProcessDistance(root);
  }

  syncAssistantProcessOnlyRows(root, fromIndex);
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

/**
 * 输入动作提交失败的用户可见反馈：输入卡未被乐观清空（清空只在
 * res.ok 后发生），toast 告知后用户可直接重试。
 */
function _notifyActionSubmitFailed(actionId) {
  const isZh = typeof currentLanguage !== 'undefined' && currentLanguage === 'zh';
  if (typeof ClawToast === 'undefined' || !ClawToast?.show) return;
  const actionLabel = actionId === 'rollback_to_call'
    ? (isZh ? '回退' : 'rollback')
    : actionId === 'compact_from_call'
      ? (isZh ? '精简' : 'compact')
      : (isZh ? '操作' : 'action');
  ClawToast.show({
    id: `input-action-failed-${actionId}-${Date.now()}`,
    title: isZh
      ? `${actionLabel}请求提交失败，请重试`
      : `Failed to submit ${actionLabel} request, please retry`,
    status: 'error',
    autoDismiss: 5000,
  });
}

async function submitInputAction(requestId, actionId, payload = {}, boundRuntimeId = currentRuntimeAgentId, boundViewToken = null) {
  try {
    const targetRuntimeId = String(boundRuntimeId || '').trim();
    if (!targetRuntimeId) return;
    const viewToken = boundViewToken || captureInputViewToken(targetRuntimeId);
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
      if (isInputViewTokenCurrent(viewToken, targetRuntimeId)) {
        beginFollowLatestEntryWindow();
        requestFollowLatest({ forceEnable: true, behavior: 'auto' });
        // 乐观清空即声明（工单 037）：渲染由 patch hook 同步触发，不等 poll。
        commitInputViewPatch(viewToken, { inputRequests: [] }, targetRuntimeId);
        clearInterruptSuppression(targetRuntimeId);
        // rollback_to_call 只做本地回退 + 草稿回填 + 重弹输入框，不触发模型
        // 调用；乐观 calling 会造成最长一个 poll 周期的假"处理中"。compact_
        // from_call 走摘要 LLM，仍按调用处理。
        if (actionId !== 'rollback_to_call') {
          _markAgentCallStartedForNotify(targetRuntimeId);
          _agentCallActive.set(targetRuntimeId, true);
        }
        _syncPersistentActionButton();
        renderAgentList();
      }
      poll();
    } else {
      _notifyActionSubmitFailed(actionId);
    }
  } catch (e) {
    console.error('提交动作失败:', e);
    _notifyActionSubmitFailed(actionId);
  }
}
