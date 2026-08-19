/**
 * input-render.js
 *
 * Input request rendering — getInputRenderSignature + renderInputRequests.
 *
 * Extracted from app-main.js.
 *
 * Exported global functions:
 *   getInputRenderSignature, renderInputRequests
 *
 * Dependencies (global state from app-core.js):
 *   currentRuntimeAgentId, currentLanguage, readOnlyMode, followLatestEnabled
 */


// 渲染输入请求
function getInputRenderSignature(requests, renderMode) {
  const runtimeId = currentRuntimeAgentId || 'none';
  if (renderMode === 'persistent') {
    const contextKey = getRuntimeContextKey(runtimeId) || `runtime:${runtimeId}`;
    return `persistent|${contextKey}|${readOnlyMode ? 'ro' : 'rw'}`;
  }
  if (renderMode === 'requests') {
    const contextKey = getRuntimeContextKey(runtimeId) || `runtime:${runtimeId}`;
    return `requests|${contextKey}|${JSON.stringify(requests || [])}`;
  }
  return `${renderMode}|${runtimeId}`;
}

function renderInputRequests(requests = readCurrentSessionViewState().inputRequests) {
  const inputContainer = document.getElementById('user-input-container');
  if (!inputContainer) return;

  // Don't re-render while the rollback action dialog is open
  if (_rollbackDialogOpen) return;

  const chatViewportTopBefore = container.scrollTop;
  const chatActive = isChatSurfaceActive();
  const renderMode = getInputSurfaceMode(requests);
  const signature = getInputRenderSignature(requests, renderMode);
  // Runtime contract: one Agent instance owns at most one input lease.  Keep
  // the renderer defensive as well, so a stale/mixed poll response can never
  // turn into several independent answer portals for one chat surface.
  const inputLease = Array.isArray(requests) && requests.length > 0 ? requests[0] : null;
  const hasChoiceRequest = !!inputLease
    && isChoiceInputRequest(inputLease)
    && !isChoiceInputRejected(inputLease.requestId);

  if (signature === lastRenderedInputSignature && renderMode === lastRenderedInputMode) {
    return;
  }

  lastRenderedInputSignature = signature;
  lastRenderedInputMode = renderMode;

  // ── 焦点保持：签名变化意味着输入面即将整块重建，先记录焦点与光标 ──
  // （重建会销毁 textarea，焦点/IME/选中态是 DOM 局部状态，必然丢失；
  //  仅当焦点原本就在输入 textarea 内才恢复，避免抢占用户在他处的焦点）
  const prevActiveEl = document.activeElement;
  const hadInputFocus = prevActiveEl instanceof HTMLTextAreaElement
    && inputContainer.contains(prevActiveEl)
    && prevActiveEl.classList.contains('user-input-textarea');
  const prevInputSelection = hadInputFocus
    ? { start: prevActiveEl.selectionStart, end: prevActiveEl.selectionEnd }
    : null;

  // MediaRecorder / ASR 属于语音操作本身，不属于某个短命 DOM 节点。
  // 同一会话的 persistent ↔ requests 重绘只重绑 UI；切换会话或离开输入面
  // 时才取消仍在采集的录音。已经开始的 ASR 由其异步所有者自行收尾。
  const _currentVoiceCacheKey = _getSessionInputCacheKey();
  const _preserveVoiceInput = _shouldPreserveVoiceInputForRender(renderMode, _currentVoiceCacheKey);

  if ((_voiceRecording || _voiceStopping) && !_preserveVoiceInput) {
    if (_voicePendingSend) {
      // User already pressed send — preserve auto-send intent.
      // Just stop the recording; onstop will run ASR and auto-send normally.
      stopVoiceRecording();
    } else {
      _cancelVoiceRecording();
    }
  }

  _storeVisibleSessionInputDraft(inputContainer);

  // 清空现有内容
  runWithSuppressedChatViewportObservers(() => {
    inputContainer.innerHTML = '';
    inputContainer.classList.toggle('choice-input-active', hasChoiceRequest);
    inputContainer.classList.remove('choice-collapsed');
    inputContainer.onclick = hasChoiceRequest
      ? function(event) {
          if (event.target === inputContainer) {
            collapsePrimaryChoiceRequest();
          }
        }
      : null;
  });

  if (!chatActive || renderMode === 'hidden') {
    inputContainer.classList.remove('choice-input-active', 'choice-collapsed');
    notifyChatViewportMutation({
      reason: 'input-render',
      shouldFollow: followLatestEnabled && chatActive,
      preserveTop: followLatestEnabled ? null : chatViewportTopBefore,
      forceSnap: followLatestEnabled,
      allowChase: false,
    });
    return;
  }

  if (renderMode === 'readonly') {
    inputContainer.classList.remove('choice-input-active', 'choice-collapsed');
    const card = document.createElement('div');
    card.className = 'user-input-card';
    card.innerHTML = `
      <textarea class="user-input-textarea" rows="1" disabled
        placeholder="${escapeHtml(t('workspace_readonly_mode'))}"
        style="opacity:0.5;cursor:not-allowed;"></textarea>
    `;
    runWithSuppressedChatViewportObservers(() => {
      inputContainer.appendChild(card);
    });
    notifyChatViewportMutation({
      reason: 'input-render',
      shouldFollow: followLatestEnabled && chatActive,
      preserveTop: followLatestEnabled ? null : chatViewportTopBefore,
      forceSnap: followLatestEnabled,
      allowChase: false,
    });
    return;
  }

  // 常驻输入框的显示条件一直是"当前正在查看某个 runtime 聊天面板"，
  // 而不是"runtime 此刻一定处于执行中"。
  const hasRequests = !!inputLease;
  const hasRuntimeSelected = !!currentRuntimeAgentId && chatActive;

  // 部分压缩进行中：显示压缩状态，禁止输入
  // 仅对发起压缩的 runtime 生效，不污染其他 runtime
  if (_partialCompactInFlight && hasRuntimeSelected && currentRuntimeAgentId === _partialCompactRuntimeId) {
    inputContainer.classList.remove('choice-input-active', 'choice-collapsed');
    const card = document.createElement('div');
    card.className = 'user-input-card partial-compact-card';
    const compactContextKey = _partialCompactContextKey || _getSessionInputCacheKey();
    let compactStart = readPartialCompactStartedAt(compactContextKey);
    if (!Number.isFinite(compactStart)) {
      compactStart = Date.now();
      writePartialCompactStartedAt(compactStart, compactContextKey);
    }
    card.innerHTML = `
      <div class="partial-compact-status" aria-live="polite">
        <span class="partial-compact-spinner" aria-hidden="true"></span>
        <span class="partial-compact-copy">
          <span class="partial-compact-title">${currentLanguage === 'zh' ? '压缩中' : 'Compacting'}</span>
          <span class="partial-compact-elapsed" id="partial-compact-elapsed">${currentLanguage === 'zh' ? '已用时 0s' : 'Elapsed 0s'}</span>
        </span>
      </div>
    `;
    runWithSuppressedChatViewportObservers(() => {
      inputContainer.appendChild(card);
    });
    // Start elapsed timer
    const elapsedEl = card.querySelector('#partial-compact-elapsed');
    const updateCompactTimer = () => {
      if (!elapsedEl || !document.body.contains(elapsedEl)) {
        clearInterval(_compactTimerInterval);
        _compactTimerInterval = null;
        return;
      }
      const elapsed = Math.floor((Date.now() - compactStart) / 1000);
      elapsedEl.textContent = currentLanguage === 'zh'
        ? `已用时 ${elapsed}s`
        : `Elapsed ${elapsed}s`;
    };
    updateCompactTimer();
    if (_compactTimerInterval) clearInterval(_compactTimerInterval);
    _compactTimerInterval = setInterval(updateCompactTimer, 1000);
    notifyChatViewportMutation({
      reason: 'input-render',
      shouldFollow: followLatestEnabled && chatActive,
      preserveTop: followLatestEnabled ? null : chatViewportTopBefore,
      forceSnap: followLatestEnabled,
      allowChase: false,
    });
    return;
  }

  // 如果有 pending requests，正常渲染
  // 如果没有 pending requests 但当前有 runtime 聊天上下文，渲染常驻输入框（队列模式）
  if (renderMode === 'requests' && hasRequests) {
    // `inputLease` is intentionally a single item.  The Worker makes this an
    // invariant; retaining it here prevents legacy/stale payloads from
    // violating the interaction model in the browser.
    for (const req of [inputLease]) {
      const boundRuntimeId = String(currentRuntimeAgentId || '');
      if (isChoiceInputRequest(req)) {
        renderChoiceInputRequest(inputContainer, req);
        continue;
      }

      const card = document.createElement('div');
      card.className = 'user-input-card';
      const visibleActions = Array.isArray(req.actions)
        ? req.actions.filter(action => action && action.id !== 'rollback_to_call' && action.id !== 'compact_from_call')
        : [];
      const actionsHtml = visibleActions.length > 0
        ? '<div class="user-input-actions">' + visibleActions.map(action =>
            '<button class="user-input-action ' + escapeHtml(action.variant || 'secondary') + '" onclick="submitInputAction(\'' + req.requestId + '\', \'' + escapeHtml(action.id) + '\', {}, \'' + escapeHtml(boundRuntimeId) + '\')">' + escapeHtml(action.label) + '</button>'
          ).join('') + '</div>'
        : '';
      card.innerHTML = `
        <div class="persistent-attachment-preview" data-attachment-preview style="display:none;"></div>
        <div class="persistent-input-body">
          <div class="persistent-input-textarea-area">
            <textarea class="user-input-textarea" rows="1" id="input-${req.requestId}"
              onkeydown="handleInputKey(event, '${req.requestId}', '${escapeHtml(boundRuntimeId)}')"
              oninput="autoResize(this); _cacheSessionInput(this)"
              onpaste="handleInputPaste(event)"
              placeholder="${escapeHtml(req.placeholder || t('input_placeholder'))}"></textarea>
          </div>
          <div class="persistent-input-toolbar">
            <div class="persistent-input-toolbar-left">
              <input type="file" id="image-file-input-${req.requestId}" accept="image/*" multiple style="display:none;" onchange="onImageFilesSelected(this)">
              <button class="persistent-icon-btn" onclick="document.getElementById('image-file-input-${req.requestId}').click()" title="${currentLanguage === 'zh' ? '添加图片' : 'Attach Image'}">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
              </button>
            </div>
            <div class="persistent-input-toolbar-right">
              <button class="input-model-switch-btn" id="input-model-switch-btn" onclick="toggleInputModelDropdown(event)">
                <span class="input-model-name">${currentLanguage === 'zh' ? '模型' : 'Model'}</span>
                <svg class="input-model-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
              </button>
              <button class="input-thinking-btn" id="input-thinking-btn" onclick="toggleThinkingEffortDropdown(event)">
                <svg class="input-thinking-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z"></path><path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z"></path></svg>
                <span class="input-thinking-name">${currentLanguage === 'zh' ? '思考强度' : 'Thinking'}</span>
                <svg class="input-thinking-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
              </button>
              <button class="voice-input-btn" data-target="input-${req.requestId}" onclick="toggleVoiceRecording(this)" title="${currentLanguage === 'zh' ? '语音输入' : 'Voice Input'}">
                <svg class="icon-mic" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="22"></line></svg>
              </button>
              <button class="persistent-action-btn" onclick="submitInput('${req.requestId}', '${escapeHtml(boundRuntimeId)}')" title="Send">
                <svg class="icon-send" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
              </button>
            </div>
          </div>
        </div>
        ${actionsHtml ? `<div class="user-input-footer">${actionsHtml}</div>` : ''}
      `;
      runWithSuppressedChatViewportObservers(() => {
        inputContainer.appendChild(card);
      });

      const requestTextarea = document.getElementById(`input-${req.requestId}`);
      const requestCacheKey = _getSessionInputCacheKey();
      if (requestTextarea) {
        requestTextarea.dataset.sessionKey = requestCacheKey || '';
        _restoreSessionInputDraft(requestTextarea, requestCacheKey);
      }
      _renderAttachmentPreview();
      // Populate model switcher button with current preset name
      if (typeof updateInputModelSwitcher === 'function') updateInputModelSwitcher();
      if (typeof updateThinkingEffortSwitcher === 'function') updateThinkingEffortSwitcher();

      // Auto-focus
      setTimeout(() => {
        const el = document.getElementById(`input-${req.requestId}`);
        if(el) {
           const cachedDraft = el.dataset.sessionKey ? _sessionInputCache[el.dataset.sessionKey] : undefined;
           const hasCachedDraft = typeof cachedDraft === 'string' && cachedDraft.length > 0;
           if (!hasCachedDraft && !el.value && typeof req.initialValue === 'string' && req.initialValue.length > 0) {
             el.value = req.initialValue;
             _cacheSessionInput(el);
           }
           el.focus();
           const end = el.value.length;
           if (typeof el.setSelectionRange === 'function') {
             el.setSelectionRange(end, end);
           }
           autoResize(el);
        }
      }, 50);
    }
    if (_preserveVoiceInput) {
      _reattachVoiceInputUi(inputContainer);
    }
  } else if (renderMode === 'persistent' && hasRuntimeSelected && !readOnlyMode) {
    // 常驻输入框：当前正在查看 runtime 聊天，但没有 pending input request
    renderPersistentInput(inputContainer);
    // 跨 DOM 重建保留了录音时，将按钮引用重新指向新元素
    if (_preserveVoiceInput) {
      _reattachVoiceInputUi(inputContainer);
    }
  }

  // Inject any pending voice ASR result that arrived while viewing another session
  _injectPendingVoiceResult();

  // 恢复重建前的输入焦点与光标（requests/persistent 两种输入面均适用；
  // request 模式自带的 50ms autofocus 会再次聚焦自身，与此不冲突）
  if (hadInputFocus) {
    const nextTa = inputContainer.querySelector('.user-input-textarea:not([disabled])');
    if (nextTa) {
      nextTa.focus();
      try {
        const pos = Number.isInteger(prevInputSelection?.start)
          ? prevInputSelection.start
          : nextTa.value.length;
        const end = Number.isInteger(prevInputSelection?.end)
          ? prevInputSelection.end
          : pos;
        nextTa.setSelectionRange(pos, end);
      } catch { /* 个别 input 类型 setSelectionRange 会抛错，忽略 */ }
    }
  }

  _renderLastCallElapsed();
  _renderRecapHint();

  notifyChatViewportMutation({
    reason: 'input-render',
    shouldFollow: followLatestEnabled && chatActive,
    preserveTop: followLatestEnabled ? null : chatViewportTopBefore,
    forceSnap: followLatestEnabled,
    allowChase: false,
  });
}
