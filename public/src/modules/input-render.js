/**
 * input-render.js
 *
 * Input surface rendering — getInputRenderSignature + renderInputRequests.
 *
 * The input slot is a persistent composer (mounted once, updated in place;
 * input-composer.js) plus transient status cards. Choice cards render in their
 * own surface and temporarily take over the input area.
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
 *   detachTransientInputContent, syncPersistentComposerSessionCard,
 *   insertTransientInputCard, _restoreSessionInputDraft, _sessionInputCache
 *   (input-composer.js)
 *   renderPersistentInput, rebindQueueProjectionForRuntime, _renderLastCallElapsed,
 *   _cleanupInputMetaBar (persistent-input.js)
 *   renderChoiceInputRequest (choice-input.js)
 *   isChoiceInputRequest, isChoiceInputConsumed (choice-input.js)
 *   runWithSuppressedChatViewportObservers, notifyChatViewportMutation (chat-viewport.js)
 */

// 渲染去重签名（渲染器内部状态）：声明式入口下由本模块统一维护，
// 外部不再手动 reset（工单 037 退役 lastRenderedInputSignature 的手动协议）。
let lastRenderedInputSignature = '';
let lastRenderedInputMode = null;

// 已 toast 过动作失败的 lease（runtime 侧回退/压缩失败原因随 lease actions
// 一次性携带；签名去重之外按 requestId 再去重，防止重复提示）。
let _lastLeaseActionErrorToastedId = null;

// 已回填过草稿的 lease（initialValue 一次性语义，读后即清）。
let _lastLeaseDraftAppliedId = null;

// rollback 草稿回填（ADR-0035 伴生反馈迁移）：宿主 setNextDraftInput 经下一
// 轮 lease 的 initialValue 回传。按 requestId 去重；仅当前无草稿时写入缓存，
// composer 在场且属当前会话时同步上屏，绝不覆盖用户已输入内容。
function _applyLeaseInitialDraft(lease) {
  if (!lease || typeof lease.initialValue !== 'string' || lease.initialValue.length === 0) return;
  if (_lastLeaseDraftAppliedId === lease.requestId) return;
  const cacheKey = _getSessionInputCacheKey();
  if (!cacheKey) return;
  const ta = document.getElementById('input-persistent');
  // choice/frozen/readonly/compacting 面没有可编辑的普通发言 composer；
  // 不消费草稿，待 composer 恢复后由后续渲染声明再应用。
  const hasDraft = (typeof ta?.value === 'string' && ta.value.length > 0)
    || (typeof _sessionInputCache[cacheKey] === 'string' && _sessionInputCache[cacheKey].length > 0);
  if (!ta || ta.closest('[data-persistent-composer]')?.style.display === 'none') return;
  _lastLeaseDraftAppliedId = lease.requestId;
  if (hasDraft) return;
  _sessionInputCache[cacheKey] = lease.initialValue;
  if (ta && (ta.dataset?.sessionKey || _getSessionInputCacheKey()) === cacheKey) {
    ta.value = lease.initialValue;
    autoResize(ta);
  }
}

// runtime 侧输入动作（回退/压缩）执行失败的一次性 toast：失败原因由下一
// 次 lease 的 actions data 携带（run-prebuilt-agent.js getNextTurnActions
// 读后即清），此前只进输入框 placeholder（几乎不可见）。
function _notifyLeaseActionError(lease) {
  const actionError = Array.isArray(lease?.actions)
    ? (lease.actions.find(action => typeof action?.data?.lastActionError === 'string'
      && action.data.lastActionError)?.data?.lastActionError || null)
    : null;
  if (!actionError || _lastLeaseActionErrorToastedId === lease.requestId) return;
  _lastLeaseActionErrorToastedId = lease.requestId;
  if (typeof ClawToast === 'undefined' || !ClawToast?.show) return;
  const isZh = typeof currentLanguage !== 'undefined' && currentLanguage === 'zh';
  ClawToast.show({
    id: `lease-action-error-${lease.requestId}`,
    status: 'error',
    title: isZh ? '上一次回退/压缩操作失败' : 'Previous rollback/compact action failed',
    description: actionError,
    autoDismiss: 8000,
  });
}

// 渲染输入请求
function getInputRenderSignature(requests, renderMode) {
  const runtimeId = currentRuntimeAgentId || 'none';
  if (renderMode === 'persistent') {
    const contextKey = getRuntimeContextKey(runtimeId) || `runtime:${runtimeId}`;
    // 接续等待表面（无 runtime 态）：签名携带等待会话身份，等待会话之间
    // 切换时触发 composer 会话卡重绑（草稿按会话迁移），不残留上一条
    // 等待会话的草稿。
    const awaitSessionKey = currentRuntimeAgentId
      ? ''
      : `await:${String(window.getActiveThreadInputTarget?.()?.sessionId || '')}`;
    return `persistent|${contextKey}|${awaitSessionKey}|${readOnlyMode ? 'ro' : 'rw'}`;
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
  const choiceContainer = document.getElementById('choice-input-container');
  if (!inputContainer || !choiceContainer) return;

  // preserveTop 必须取聊天容器的滚动位置：非跟随模式下视口结算会把它回写。
  // 历史上误读输入容器的 scrollTop（恒 0），导致输入面重渲染时聊天视口跳回顶部。
  const chatViewport = document.getElementById('chat-container');
  const chatViewportTopBefore = chatViewport ? chatViewport.scrollTop : null;
  const chatActive = isChatSurfaceActive();
  // 会话隔离重绑（契约 §7 同款）：§3 级 6 的模式判定读排队气泡投影，必须
  // 先与当前 runtime 对齐，旧会话的排队乐观态不得劫持新会话的输入面模式。
  rebindQueueProjectionForRuntime(currentRuntimeAgentId);
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
  // lease 伴生反馈查收（ADR-0035）：必须放在签名去重之前——persistent 签名
  // 不含 lease 字段，lease 到达/消失不产生签名差异；查收自身按 requestId
  // 去重，幂等。回退对话框接管期间同样查收（rollback 失败提示不应因对话框
  // 在场而丢失）。
  _notifyLeaseActionError(inputLease);
  _applyLeaseInitialDraft(inputLease);
  if (unchanged || _rollbackDialogOpen) return;

  for (const child of Array.from(choiceContainer.children)) child.remove();
  choiceContainer.classList.remove('choice-collapsed');
  choiceContainer.onclick = null;

  // 会话切换草稿迁移（契约 §7）：composer 常驻后不再有"销毁前抢救"，
  // key 变化时在此保存旧会话草稿并恢复新会话草稿；同 key 幂等 no-op。
  syncPersistentComposerSessionCard(inputContainer);

  // MediaRecorder / ASR 属于语音操作本身，不属于某个短命 DOM 节点。
  // composer 常驻后同会话重渲染不再触碰 DOM，录音自然保留；跨会话或
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
  // 接续等待表面：无 runtime 态，但视图挂在等待会话上（矩阵级 8 放行项）。
  const hasThreadAwaitTarget = () => !currentRuntimeAgentId && chatActive
    && typeof window.getActiveThreadInputTarget === 'function'
    && !!window.getActiveThreadInputTarget()?.threadId;

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

  // 级 5：choice 卡使用独立容器；显示时隐藏常驻 composer。
  if (renderMode === 'choice' && inputLease && isChoiceInputRequest(inputLease)) {
    runSuppressed(() => {
      detachTransientInputContent(inputContainer);
      hidePersistentComposerCard();
      renderChoiceInputRequest(choiceContainer, inputLease);
    });
    notifyInputViewportMutation(chatViewportTopBefore, chatActive);
    return;
  }

  // 文本 lease 不改变普通发言输入面：输入框始终 persistent，空闲发言经
  // user-turn 由 viewer 转为 lease 应答（ADR-0035）。
  runSuppressed(() => detachTransientInputContent(inputContainer));
  if (hasRuntimeSelected || hasThreadAwaitTarget()) {
    renderPersistentInput(inputContainer);
  } else {
    hidePersistentComposerCard();
  }

  // Inject any pending voice ASR result that arrived while viewing another session
  _injectPendingVoiceResult();

  _renderLastCallElapsed();
  _renderRecapHint();

  notifyInputViewportMutation(chatViewportTopBefore, chatActive);
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
