/**
 * input-render.js
 *
 * Input surface rendering — getInputRenderSignature + renderInputRequests.
 * （classic → ESM，P4 T2 批次）
 *
 * The input slot is a persistent composer (mounted once, updated in place;
 * input-composer.js) plus transient status cards. Choice cards render in their
 * own surface and temporarily take over the input area.
 *
 * Exported functions:
 *   getInputRenderSignature, notifyInputSurfaceChanged, renderInputRequests
 *
 * Ticket 037: the input surface has a single render-trigger channel. State
 * writers declare changes through notifyInputSurfaceChanged (or reach it
 * automatically via the inputRequests write inside applySessionViewPatch);
 * the manual reset-signature + render pairing protocol is gone. The dedup
 * signature lives inside this module now (lastRenderedInputSignature /
 * lastRenderedInputMode are module-private, not poked from the outside).
 *
 * 迁移要点（P4 T2）：
 *   - 顶层语句只有模块私有状态声明，没有 DOM 查询与事件注册；首屏渲染链已由
 *     `boot.js` 在模块相触发（P4 时序切换），本文件不再有 classic 相同步触达约束。
 *   - 跨文件键：`notifyInputSurfaceChanged` 是本文件唯一的桥键（domain
 *     `input-render`）——它是输入面唯一的声明入口，仍被 classic 的
 *     session-view-state / app-ui / persistent-input 裸调用，以及已迁 ESM 的
 *     choice-input / 排队投影 / 回退运行时的 `window.` 调用。注销条件：上述
 *     classic 消费方迁 ESM 后改为 import。`renderInputRequests` /
 *     `getInputRenderSignature` 生产侧零跨文件消费方（只在经
 *     notifyInputSurfaceChanged 的同一模块内使用），按配方保持模块私有、
 *     不上桥。
 *   - 回退 / 压缩域的状态与记账已迁 ESM，直读直写 owner
 *     `p2-w2-3b-rollback-domain.js`（`_rollbackDialogOpen` /
 *     `_partialCompactContextKey` / `_compactTimerInterval` 与开始时间读写），
 *     不再经 window 访问器。
 *   - 其余外来键都还是 classic 实现（renderer / composer / voice / viewport /
 *     app-core 状态桥键），统一显式经 `window.` 晚绑定，语义与迁移前裸标识符
 *     解析到 window 属性一致（桥键）或到全局函数声明一致。
 *   - 跟随开关（followLatestEnabled）是 app-core 的 classic 顶层 let，经
 *     `chatSurface` 宿主适配模块读写（p2-bootstrap-chat-surface）。
 *
 * 仍 classic 的依赖（均为 window 晚绑定，收敛批次见各定义方头注）：
 *   window.currentRuntimeAgentId / currentLanguage / readOnlyMode（app-core 桥键）
 *   window.getRuntimeContextKey / getInputSurfaceMode / _getSessionInputCacheKey
 *   window.readCurrentSessionViewState / isChatSurfaceActive / isRemoteNamespaceAgentId
 *   window.rebindQueueProjectionForRuntime / renderPersistentInput / _renderLastCallElapsed
 *   window.syncPersistentComposerSessionCard / detachTransientInputContent /
 *   window.hidePersistentComposerCard / insertTransientInputCard
 *   window.runWithSuppressedChatViewportObservers / notifyChatViewportMutation
 *   window._getSessionInputCacheKey / _sessionInputCache（桥键）
 *   window._voiceRecording / _voiceStopping / _voicePendingSend（桥键）/
 *     window.stopVoiceRecording / _cancelVoiceRecording / _shouldPreserveVoiceInputForRender /
 *     window._injectPendingVoiceResult
 *   window.isChoiceInputRequest / renderChoiceInputRequest（choice-input 桥键）
 *   window.autoResize（input-actions 桥键）/ window._renderRecapHint（recap-hint 桥键）
 *   window.escapeHtml（markdown-utils 桥键）/ window.ClawToast
 */
import { t } from '../i18n.js';
import { chatSurface } from './p2-bootstrap-chat-surface.js';
import {
  rollbackDialogOpen,
  compactTimerInterval,
  setCompactTimerInterval,
  partialCompactContextKey,
  readPartialCompactStartedAt,
  writePartialCompactStartedAt,
} from './p2-w2-3b-rollback-domain.js';
import { getRuntimeContextKey } from './identity.js';

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
  const cacheKey = window._getSessionInputCacheKey();
  if (!cacheKey) return;
  const ta = document.getElementById('input-persistent');
  // choice/frozen/readonly/compacting 面没有可编辑的普通发言 composer；
  // 不消费草稿，待 composer 恢复后由后续渲染声明再应用。
  const hasDraft = (typeof ta?.value === 'string' && ta.value.length > 0)
    || (typeof window._sessionInputCache[cacheKey] === 'string' && window._sessionInputCache[cacheKey].length > 0);
  if (!ta || ta.closest('[data-persistent-composer]')?.style.display === 'none') return;
  _lastLeaseDraftAppliedId = lease.requestId;
  if (hasDraft) return;
  window._sessionInputCache[cacheKey] = lease.initialValue;
  if (ta && (ta.dataset?.sessionKey || window._getSessionInputCacheKey()) === cacheKey) {
    ta.value = lease.initialValue;
    window.autoResize(ta); // 桥接期：定义于 input-actions（输入动作域收敛时改 import）
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
  if (typeof window.ClawToast === 'undefined' || !window.ClawToast?.show) return;
  const isZh = typeof window.currentLanguage !== 'undefined' && window.currentLanguage === 'zh';
  window.ClawToast.show({
    id: `lease-action-error-${lease.requestId}`,
    status: 'error',
    title: isZh ? '上一次回退/压缩操作失败' : 'Previous rollback/compact action failed',
    description: actionError,
    autoDismiss: 8000,
  });
}

// 渲染输入请求
function getInputRenderSignature(requests, renderMode) {
  const runtimeId = window.currentRuntimeAgentId || 'none';
  if (renderMode === 'persistent') {
    const contextKey = getRuntimeContextKey(runtimeId) || `runtime:${runtimeId}`;
    // 接续等待表面（无 runtime 态）：签名携带等待会话身份，等待会话之间
    // 切换时触发 composer 会话卡重绑（草稿按会话迁移），不残留上一条
    // 等待会话的草稿。
    const awaitSessionKey = window.currentRuntimeAgentId
      ? ''
      : `await:${String(window.getActiveThreadInputTarget?.()?.sessionId || '')}`;
    return `persistent|${contextKey}|${awaitSessionKey}|${window.readOnlyMode ? 'ro' : 'rw'}`;
  }
  // choice 模式：显示内容由 lease 身份 + 交互状态（选项/题号/折叠/上下文展开）
  // 共同决定（工单 037）。交互状态入签名后，choice 域的状态写入经声明入口
  // 即可重建选择卡，无需外部 reset。
  if (renderMode === 'choice' && typeof window.getChoiceInteractionSignature === 'function') {
    const contextKey = getRuntimeContextKey(runtimeId) || `runtime:${runtimeId}`;
    const lease = Array.isArray(requests) && requests.length > 0 ? requests[0] : null;
    const interaction = lease ? window.getChoiceInteractionSignature(lease.requestId) : 'new';
    return `choice|${contextKey}|${lease ? lease.requestId : ''}|${interaction}`;
  }
  return `${renderMode}|${runtimeId}`;
}

// 输入面唯一的渲染触发通道（工单 037）：所有域（patch 写入方、calling 翻转、
// 队列同步、choice 交互、回退对话框关闭）在相关状态变更后调用本入口声明
// 变更；渲染是同步、幂等的属性级更新（036 已具备），签名去重保证同轮多次
// 声明无副作用。session-view-state.js 的 inputRequests 写入路径经 typeof
// 解析到本函数，自动触发渲染。
function notifyInputSurfaceChanged(requests = window.readCurrentSessionViewState().inputRequests) {
  renderInputRequests(requests);
}

function renderInputRequests(requests = window.readCurrentSessionViewState().inputRequests) {
  const inputContainer = document.getElementById('user-input-container');
  const choiceContainer = document.getElementById('choice-input-container');
  if (!inputContainer || !choiceContainer) return;

  // preserveTop 必须取聊天容器的滚动位置：非跟随模式下视口结算会把它回写。
  // 历史上误读输入容器的 scrollTop（恒 0），导致输入面重渲染时聊天视口跳回顶部。
  const chatViewport = document.getElementById('chat-container');
  const chatViewportTopBefore = chatViewport ? chatViewport.scrollTop : null;
  const chatActive = window.isChatSurfaceActive();
  // 会话隔离重绑（契约 §7 同款）：§3 级 6 的模式判定读排队气泡投影，必须
  // 先与当前 runtime 对齐，旧会话的排队乐观态不得劫持新会话的输入面模式。
  window.rebindQueueProjectionForRuntime(window.currentRuntimeAgentId);
  const renderMode = window.getInputSurfaceMode(requests);
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
  if (unchanged || rollbackDialogOpen) return;

  for (const child of Array.from(choiceContainer.children)) child.remove();
  choiceContainer.classList.remove('choice-collapsed');
  choiceContainer.onclick = null;

  // 会话切换草稿迁移（契约 §7）：composer 常驻后不再有"销毁前抢救"，
  // key 变化时在此保存旧会话草稿并恢复新会话草稿；同 key 幂等 no-op。
  window.syncPersistentComposerSessionCard(inputContainer);

  // MediaRecorder / ASR 属于语音操作本身，不属于某个短命 DOM 节点。
  // composer 常驻后同会话重渲染不再触碰 DOM，录音自然保留；跨会话或
  // 离开输入面时才取消仍在采集的录音。已经开始的 ASR 由其异步所有者收尾。
  const _currentVoiceCacheKey = window._getSessionInputCacheKey();
  const _preserveVoiceInput = window._shouldPreserveVoiceInputForRender(renderMode, _currentVoiceCacheKey);

  if ((window._voiceRecording || window._voiceStopping) && !_preserveVoiceInput) {
    if (window._voicePendingSend) {
      // User already pressed send — preserve auto-send intent.
      // Just stop the recording; onstop will run ASR and auto-send normally.
      window.stopVoiceRecording();
    } else {
      window._cancelVoiceRecording();
    }
  }

  const runSuppressed = (fn) => window.runWithSuppressedChatViewportObservers(fn);

  // ── 级 1 / 级 9：hidden（非 chat surface / 无 runtime）────────────────
  if (!chatActive || renderMode === 'hidden') {
    runSuppressed(() => {
      window.detachTransientInputContent(inputContainer);
      window.hidePersistentComposerCard();
      inputContainer.onclick = null;
    });
    notifyInputViewportMutation(chatViewportTopBefore, chatActive);
    return;
  }

  // ── 级 2：readonly（远程只读 / workspace 只读 / 归档浏览）──────────────
  if (renderMode === 'readonly') {
    runSuppressed(() => {
      window.detachTransientInputContent(inputContainer);
      window.hidePersistentComposerCard();
      // 远程会话是 Phase 1 明确的只读面：整体替换为禁用提示，不是假交互输入框。
      const card = document.createElement('div');
      card.className = 'user-input-card';
      // 只读浏览（归档对话 / 历史存档）说明为何不能输入，以及怎样恢复可写：
      // 归档禁止重新启动运行是运行约束，不是内容不可读。
      const readonlyTarget = typeof window.getReadOnlySessionTarget === 'function'
        ? window.getReadOnlySessionTarget()
        : null;
      const readonlyPlaceholder = window.isRemoteNamespaceAgentId(window.currentRuntimeAgentId)
        ? t('rcon_readonly_placeholder')
        : (readonlyTarget
          ? (readonlyTarget.archived
            ? t('workspace_readonly_archived_hint')
            : t('workspace_readonly_history_hint'))
          : t('workspace_readonly_mode'));
      card.innerHTML = `
        <textarea class="user-input-textarea" rows="1" disabled
          placeholder="${window.escapeHtml(readonlyPlaceholder)}"
          style="opacity:0.5;cursor:not-allowed;"></textarea>
      `;
      window.insertTransientInputCard(inputContainer, card);
    });
    notifyInputViewportMutation(chatViewportTopBefore, chatActive);
    return;
  }

  // 常驻输入框的显示条件一直是"当前正在查看某个 runtime 聊天面板"，
  // 而不是"runtime 此刻一定处于执行中"。
  const hasRuntimeSelected = !!window.currentRuntimeAgentId && chatActive;
  // 接续等待表面：无 runtime 态，但视图挂在等待会话上（矩阵级 8 放行项）。
  const hasThreadAwaitTarget = () => !window.currentRuntimeAgentId && chatActive
    && typeof window.getActiveThreadInputTarget === 'function'
    && !!window.getActiveThreadInputTarget()?.threadId;

  // ── 级 4：会话内压缩 in-flight（仅对发起 runtime 生效，不污染其他 runtime）
  if (renderMode === 'compacting' && hasRuntimeSelected) {
    runSuppressed(() => {
      window.detachTransientInputContent(inputContainer);
      window.hidePersistentComposerCard();
      const card = document.createElement('div');
      card.className = 'user-input-card partial-compact-card';
      const compactContextKey = partialCompactContextKey || window._getSessionInputCacheKey();
      let compactStart = readPartialCompactStartedAt(compactContextKey);
      if (!Number.isFinite(compactStart)) {
        compactStart = Date.now();
        writePartialCompactStartedAt(compactStart, compactContextKey);
      }
      card.innerHTML = `
        <div class="partial-compact-status" aria-live="polite">
          <span class="partial-compact-spinner" aria-hidden="true"></span>
          <span class="partial-compact-copy">
            <span class="partial-compact-title">${window.currentLanguage === 'zh' ? '压缩中' : 'Compacting'}</span>
            <span class="partial-compact-elapsed" id="partial-compact-elapsed">${window.currentLanguage === 'zh' ? '已用时 0s' : 'Elapsed 0s'}</span>
          </span>
        </div>
      `;
      window.insertTransientInputCard(inputContainer, card);
      // Start elapsed timer
      const elapsedEl = card.querySelector('#partial-compact-elapsed');
      const updateCompactTimer = () => {
        if (!elapsedEl || !document.body.contains(elapsedEl)) {
          clearInterval(compactTimerInterval);
          setCompactTimerInterval(null);
          return;
        }
        const elapsed = Math.floor((Date.now() - compactStart) / 1000);
        elapsedEl.textContent = window.currentLanguage === 'zh'
          ? `已用时 ${elapsed}s`
          : `Elapsed ${elapsed}s`;
      };
      updateCompactTimer();
      if (compactTimerInterval) clearInterval(compactTimerInterval);
      setCompactTimerInterval(setInterval(updateCompactTimer, 1000));
    });
    notifyInputViewportMutation(chatViewportTopBefore, chatActive);
    return;
  }

  // ── interactive 模式：常驻 composer 显示 ──────────────────────────────

  // 级 5：choice 卡使用独立容器；显示时隐藏常驻 composer。
  if (renderMode === 'choice' && inputLease && window.isChoiceInputRequest(inputLease)) {
    runSuppressed(() => {
      window.detachTransientInputContent(inputContainer);
      window.hidePersistentComposerCard();
      window.renderChoiceInputRequest(choiceContainer, inputLease);
    });
    notifyInputViewportMutation(chatViewportTopBefore, chatActive);
    return;
  }

  // 文本 lease 不改变普通发言输入面：输入框始终 persistent，空闲发言经
  // user-turn 由 viewer 转为 lease 应答（ADR-0035）。
  runSuppressed(() => window.detachTransientInputContent(inputContainer));
  if (hasRuntimeSelected || hasThreadAwaitTarget()) {
    window.renderPersistentInput(inputContainer);
  } else {
    window.hidePersistentComposerCard();
  }

  // Inject any pending voice ASR result that arrived while viewing another session
  window._injectPendingVoiceResult();

  window._renderLastCallElapsed();
  window._renderRecapHint();

  notifyInputViewportMutation(chatViewportTopBefore, chatActive);
}

function notifyInputViewportMutation(preserveTop, chatActive) {
  window.notifyChatViewportMutation({
    reason: 'input-render',
    shouldFollow: chatSurface.followLatestEnabled && chatActive,
    preserveTop: chatSurface.followLatestEnabled ? null : preserveTop,
    forceSnap: chatSurface.followLatestEnabled,
    allowChase: false,
  });
}

export { getInputRenderSignature, notifyInputSurfaceChanged, renderInputRequests };

// 桥（domain `input-render`）：输入面唯一的渲染声明入口，classic 消费方
// （session-view-state / app-ui / persistent-input）裸调用命中本访问器；
// 已迁 ESM 的消费方（choice-input / 排队投影 / 回退运行时）保持 window. 调用，
// 收敛后改为 import 并注销本行。
const bridgeState = { notifyInputSurfaceChanged };
window.KernelState.defineKey('input-render', 'notifyInputSurfaceChanged', bridgeState.notifyInputSurfaceChanged);
window.KernelState.claim('input-render', {
  get: (key) => bridgeState[key],
  set: (key, value) => { bridgeState[key] = value; },
});
