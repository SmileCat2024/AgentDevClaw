/**
 * input-render.js
 *
 * Input slot rendering — getInputRenderSignature + renderInputRequests.
 *
 * Extracted from app-main.js. Reworked by ticket 036: the input slot is now a
 * persistent composer (mounted once, updated in place; input-composer.js) plus
 * transient mutually-exclusive cards. persistent ↔ requests flips only update
 * attributes; session switches rebind dataset.sessionKey + draft. The composer
 * itself is never destroyed by this renderer anymore.
 *
 * Exported global functions:
 *   getInputRenderSignature, notifyInputSurfaceChanged, renderInputRequests
 *
 * Ticket 037: the input surface has a single render-trigger channel. State
 * writers declare changes through notifyInputSurfaceChanged (or reach it
 * automatically via the inputRequests write inside applySessionViewPatch);
 * the manual reset-signature + render pairing protocol is gone. The dedup
 * signature lives inside this module now (lastRenderedInputSignature /
 * lastRenderedInputMode are no longer poked from the outside).
 *
 * Dependencies (global state from app-core.js):
 *   currentRuntimeAgentId, currentLanguage, readOnlyMode, followLatestEnabled
 * Dependencies (modules):
 *   resolveInputSurfaceMode, showPersistentComposerCard, hidePersistentComposerCard,
 *   detachTransientInputContent, syncPersistentComposerSessionCard, applyComposerMode,
 *   insertTransientInputCard, _restoreSessionInputDraft, _sessionInputCache
 *   (input-composer.js)
 *   renderPersistentInput, _renderLastCallElapsed (persistent-input.js)
 *   renderChoiceInputRequest, collapsePrimaryChoiceRequest,
 *   isChoiceInputRequest, isChoiceInputRejected (choice-input.js)
 *   runWithSuppressedChatViewportObservers, notifyChatViewportMutation (chat-viewport.js)
 */

// 渲染去重签名（渲染器内部状态）：声明式入口下由本模块统一维护，
// 外部不再手动 reset（工单 037 退役 lastRenderedInputSignature 的手动协议）。
let lastRenderedInputSignature = '';
let lastRenderedInputMode = null;

// 渲染输入请求
function getInputRenderSignature(requests, renderMode) {
  const runtimeId = currentRuntimeAgentId || 'none';
  if (renderMode === 'persistent') {
    const contextKey = getRuntimeContextKey(runtimeId) || `runtime:${runtimeId}`;
    return `persistent|${contextKey}|${readOnlyMode ? 'ro' : 'rw'}`;
  }
  if (renderMode === 'requests') {
    const contextKey = getRuntimeContextKey(runtimeId) || `runtime:${runtimeId}`;
    // 精确 diff：渲染器防御性只消费单 lease（requests[0]），签名随之只含该
    // lease 的关键字段；多 lease 是 worker 侧违例，不应放大渲染。
    const lease = Array.isArray(requests) && requests.length > 0 ? requests[0] : null;
    return `requests|${contextKey}|${JSON.stringify(lease || null)}`;
  }
  // choice 模式：显示内容由 lease 身份 + 交互状态（选项/题号/折叠/上下文展开）
  // 共同决定（工单 037）。交互状态入签名后，choice 域的状态写入经声明入口
  // 即可重建选择卡，无需外部 reset。
  if (renderMode === 'choice' && typeof getChoiceInteractionSignature === 'function') {
    const contextKey = getRuntimeContextKey(runtimeId) || `runtime:${runtimeId}`;
    const lease = Array.isArray(requests) && requests.length > 0 ? requests[0] : null;
    const interaction = lease ? getChoiceInteractionSignature(lease.requestId) : 'new';
    return `choice|${contextKey}|${lease ? lease.requestId : ''}|${interaction}`;
  }
  return `${renderMode}|${runtimeId}`;
}

// 输入面唯一的渲染触发通道（工单 037）：所有域（patch 写入方、calling 翻转、
// 队列同步、choice 交互、回退对话框关闭）在相关状态变更后调用本入口声明
// 变更；渲染是同步、幂等的属性级更新（036 已具备），签名去重保证同轮多次
// 声明无副作用。session-view-state.js 的 inputRequests 写入路径经 typeof
// 解析到本函数，自动触发渲染。
function notifyInputSurfaceChanged(requests = readCurrentSessionViewState().inputRequests) {
  renderInputRequests(requests);
}

function renderInputRequests(requests = readCurrentSessionViewState().inputRequests) {
  const inputContainer = document.getElementById('user-input-container');
  if (!inputContainer) return;

  const chatViewportTopBefore = inputContainer.scrollTop;
  const chatActive = isChatSurfaceActive();
  const renderMode = getInputSurfaceMode(requests);
  const signature = getInputRenderSignature(requests, renderMode);
  // Runtime contract: one Agent instance owns at most one input lease.  Keep
  // the renderer defensive as well, so a stale/mixed poll response can never
  // turn into several independent answer portals for one chat surface.
  const inputLease = Array.isArray(requests) && requests.length > 0 ? requests[0] : null;

  const unchanged = signature === lastRenderedInputSignature && renderMode === lastRenderedInputMode;
  // 签名/模式照常记录（声明式入口下由渲染器统一去重）；回退对话框接管期间
  // 不触碰 DOM（契约 §3 级 3），但签名已同步冻结态——关闭对话框后的下一次
  // 声明因签名差异自然触发恢复渲染，不再依赖外部手动 reset。
  lastRenderedInputSignature = signature;
  lastRenderedInputMode = renderMode;
  if (unchanged || _rollbackDialogOpen) return;

  // 会话切换草稿迁移（契约 §7）：composer 常驻后不再有"销毁前抢救"，
  // key 变化时在此保存旧会话草稿并恢复新会话草稿；同 key 幂等 no-op。
  syncPersistentComposerSessionCard(inputContainer);

  // MediaRecorder / ASR 属于语音操作本身，不属于某个短命 DOM 节点。
  // composer 常驻后同会话模式翻转不再触碰 DOM，录音自然保留；跨会话或
  // 离开输入面时才取消仍在采集的录音。已经开始的 ASR 由其异步所有者收尾。
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

  const runSuppressed = (fn) => runWithSuppressedChatViewportObservers(fn);

  // ── 级 1 / 级 9：hidden（非 chat surface / 无 runtime）────────────────
  if (!chatActive || renderMode === 'hidden') {
    runSuppressed(() => {
      detachTransientInputContent(inputContainer);
      hidePersistentComposerCard();
      inputContainer.classList.remove('choice-input-active', 'choice-collapsed');
      inputContainer.onclick = null;
    });
    notifyInputViewportMutation(chatViewportTopBefore, chatActive);
    return;
  }

  // ── 级 2：readonly（远程只读 / workspace 只读）────────────────────────
  if (renderMode === 'readonly') {
    runSuppressed(() => {
      detachTransientInputContent(inputContainer);
      hidePersistentComposerCard();
      // 远程会话是 Phase 1 明确的只读面：整体替换为禁用提示，不是假交互输入框。
      const card = document.createElement('div');
      card.className = 'user-input-card';
      const readonlyPlaceholder = isRemoteNamespaceAgentId(currentRuntimeAgentId)
        ? t('rcon_readonly_placeholder')
        : t('workspace_readonly_mode');
      card.innerHTML = `
        <textarea class="user-input-textarea" rows="1" disabled
          placeholder="${escapeHtml(readonlyPlaceholder)}"
          style="opacity:0.5;cursor:not-allowed;"></textarea>
      `;
      insertTransientInputCard(inputContainer, card);
    });
    notifyInputViewportMutation(chatViewportTopBefore, chatActive);
    return;
  }

  // 常驻输入框的显示条件一直是"当前正在查看某个 runtime 聊天面板"，
  // 而不是"runtime 此刻一定处于执行中"。
  const hasRuntimeSelected = !!currentRuntimeAgentId && chatActive;

  // ── 级 4：会话内压缩 in-flight（仅对发起 runtime 生效，不污染其他 runtime）
  if (renderMode === 'compacting' && hasRuntimeSelected) {
    runSuppressed(() => {
      detachTransientInputContent(inputContainer);
      hidePersistentComposerCard();
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
      insertTransientInputCard(inputContainer, card);
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
    });
    notifyInputViewportMutation(chatViewportTopBefore, chatActive);
    return;
  }

  // ── interactive 模式：常驻 composer 显示 ──────────────────────────────
  const hasRequests = !!inputLease;

  // 级 5：choice 选择卡（键问答卡）——与常驻 composer 互斥显示，
  // 选择卡内部实现保持现状（choice-input.js），这里只负责互斥调度。
  if (renderMode === 'choice' && inputLease && isChoiceInputRequest(inputLease)) {
    runSuppressed(() => {
      detachTransientInputContent(inputContainer);
      hidePersistentComposerCard();
      inputContainer.classList.add('choice-input-active');
      inputContainer.classList.remove('choice-collapsed');
      inputContainer.onclick = function(event) {
        if (event.target === inputContainer) {
          collapsePrimaryChoiceRequest();
        }
      };
      renderChoiceInputRequest(inputContainer, inputLease);
    });
    notifyInputViewportMutation(chatViewportTopBefore, chatActive);
    return;
  }

  // 级 6 / 7 / 8：persistent 与 requests 共用同一常驻 composer，
  // 翻转只更新提交端点与 footer 动作（applyComposerMode），不销毁元素。
  runSuppressed(() => detachTransientInputContent(inputContainer));
  showPersistentComposerCard(inputContainer);
  inputContainer.classList.remove('choice-input-active', 'choice-collapsed');
  inputContainer.onclick = null;

  if (renderMode === 'requests' && hasRequests) {
    renderRequestComposer(inputContainer, inputLease);
  } else if (renderMode === 'persistent' && hasRuntimeSelected) {
    // 常驻输入框：当前正在查看 runtime 聊天，但没有 pending input request
    renderPersistentInput(inputContainer);
  } else {
    // 理论不可达（九级矩阵已保证 requests/persistent 有 runtime/请求）：
    // 兜底隐藏，保持容器空态可观察行为
    hidePersistentComposerCard();
  }

  // 录音跨模式端点切换同步（textarea id 变化 → data-target/_voiceTargetId 重绑）
  if (_preserveVoiceInput) {
    _reattachVoiceInputUi(inputContainer);
  }

  // Inject any pending voice ASR result that arrived while viewing another session
  _injectPendingVoiceResult();

  _renderLastCallElapsed();
  _renderRecapHint();

  notifyInputViewportMutation(chatViewportTopBefore, chatActive);
}

// 请求卡端点的属性级更新：同一 composer 元素，仅提交端点 / placeholder /
// footer 动作随 lease 变化；50ms 聚焦与 initialValue 回填保持契约 5.2 节奏。
function renderRequestComposer(inputContainer, lease) {
  const composer = showPersistentComposerCard(inputContainer);
  const boundRuntimeId = String(currentRuntimeAgentId || '');
  applyComposerMode(composer, 'requests', lease);

  const requestTextarea = document.getElementById(`input-${lease.requestId}`);
  const requestCacheKey = _getSessionInputCacheKey();
  if (requestTextarea) {
    requestTextarea.dataset.sessionKey = requestCacheKey || '';
    _restoreSessionInputDraft(requestTextarea, requestCacheKey);
  }
  _renderAttachmentPreview();
  // Populate model switcher button with current preset name
  if (typeof updateInputModelSwitcher === 'function') updateInputModelSwitcher();
  if (typeof updateThinkingEffortSwitcher === 'function') updateThinkingEffortSwitcher();

  // Auto-focus（契约 5.2：50ms 后自动聚焦、光标到末尾、无草稿时回填 initialValue）
  setTimeout(() => {
    const el = document.getElementById(`input-${lease.requestId}`);
    if (el) {
      const cachedDraft = el.dataset.sessionKey ? _sessionInputCache[el.dataset.sessionKey] : undefined;
      const hasCachedDraft = typeof cachedDraft === 'string' && cachedDraft.length > 0;
      if (!hasCachedDraft && !el.value && typeof lease.initialValue === 'string' && lease.initialValue.length > 0) {
        el.value = lease.initialValue;
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

function notifyInputViewportMutation(preserveTop, chatActive) {
  notifyChatViewportMutation({
    reason: 'input-render',
    shouldFollow: followLatestEnabled && chatActive,
    preserveTop: followLatestEnabled ? null : preserveTop,
    forceSnap: followLatestEnabled,
    allowChase: false,
  });
}
