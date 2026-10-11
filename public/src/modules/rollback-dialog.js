/**
 * rollback-dialog.js — Partial Compact / Rollback Dialog
 * 从 app-main.js 拆出（Phase A-6）
 * 拆出日期：2026-07-03
 *
 * 依赖全局状态（定义在 app-core.js）:
 *   currentRuntimeAgentId, currentLanguage, currentMessages, currentInputRequests
 * 依赖全局函数:
 *   _getSessionInputCacheKey (app-main.js)
 *   getRollbackInputRequest (app-main.js)
 *   notifyInputSurfaceChanged (input-render.js，工单 037 唯一渲染声明入口)
 *   detachTransientInputContent, hidePersistentComposerCard (input-composer.js)
 *   submitInputAction (app-main.js)
 *   applySessionViewPatch (session-view-state.js)
 *   escapeHtml (app-core.js)
 *   runWithSuppressedChatViewportObservers (app-ui.js)
 * 导出全局函数:
 *   getPartialCompactStorageKey, readPartialCompactStartedAt,
 *   writePartialCompactStartedAt, clearPartialCompactStartedAt,
 *   clearPartialCompactState, showRollbackActionDialog
 * window 函数:
 *   requestRollbackEdit
 * 导出全局变量:
 *   _partialCompactInFlight, _partialCompactRuntimeId,
 *   _partialCompactContextKey, _compactTimerInterval, _rollbackDialogOpen
 * HTML onclick 引用:
 *   onclick="requestRollbackEdit(...)"
 */

let _partialCompactInFlight = false;
let _partialCompactRuntimeId = null;
let _partialCompactContextKey = null;
let _compactTimerInterval = null;

let _rollbackDialogOpen = false;

function getPartialCompactStorageKey(contextKey = _getSessionInputCacheKey()) {
  return contextKey ? `agentdev-partial-compact-start:${contextKey}` : '';
}

function readPartialCompactStartedAt(contextKey = _getSessionInputCacheKey()) {
  const storageKey = getPartialCompactStorageKey(contextKey);
  if (!storageKey) return null;
  try {
    const raw = sessionStorage.getItem(storageKey);
    if (!raw) return null;
    const startedAt = Number(raw);
    return Number.isFinite(startedAt) ? startedAt : null;
  } catch {
    return null;
  }
}

function writePartialCompactStartedAt(startedAt, contextKey = _getSessionInputCacheKey()) {
  const storageKey = getPartialCompactStorageKey(contextKey);
  if (!storageKey || !Number.isFinite(startedAt)) return;
  try {
    sessionStorage.setItem(storageKey, String(startedAt));
  } catch {}
}

function clearPartialCompactStartedAt(contextKey = _partialCompactContextKey || _getSessionInputCacheKey()) {
  const storageKey = getPartialCompactStorageKey(contextKey);
  if (!storageKey) return;
  try {
    sessionStorage.removeItem(storageKey);
  } catch {}
}

function clearPartialCompactState(contextKey = _partialCompactContextKey || _getSessionInputCacheKey()) {
  if (_partialCompactContextKey && contextKey !== _partialCompactContextKey) return;
  const ownsCurrentView = !_partialCompactContextKey
    || _partialCompactContextKey === _getSessionInputCacheKey();
  _partialCompactInFlight = false;
  _partialCompactRuntimeId = null;
  _partialCompactContextKey = null;
  if (_compactTimerInterval) {
    clearInterval(_compactTimerInterval);
    _compactTimerInterval = null;
  }
  clearPartialCompactStartedAt(contextKey);
  // 清理属于发起压缩的 SessionView；旧 lease 的结束不能重渲染新会话输入面。
  if (ownsCurrentView) notifyInputSurfaceChanged();
}

window.requestRollbackEdit = async function(messageIndex) {
  const request = getRollbackInputRequest();
  if (!request) {
    console.warn('No rollback-capable input request available');
    return;
  }

  const msg = currentMessages[messageIndex];
  if (!msg || msg.role !== 'user') {
    return;
  }

  const fallbackCallIndex = currentMessages
    .slice(0, messageIndex + 1)
    .filter(entry => entry.role === 'user')
    .length - 1;
  const callIndex = typeof msg.turn === 'number' ? msg.turn : fallbackCallIndex;

  showRollbackActionDialog(request, callIndex, msg);
};

function showRollbackActionDialog(request, callIndex, msg) {
  const inputContainer = document.getElementById('user-input-container');
  const choiceContainer = document.getElementById('choice-input-container');
  if (!inputContainer || !choiceContainer) return;
  const boundRuntimeId = currentRuntimeAgentId;
  const viewToken = captureSessionViewToken(boundRuntimeId);
  const boundContextKey = _getSessionInputCacheKey();

  _rollbackDialogOpen = true;

  const msgPreview = (typeof msg.content === 'string' ? msg.content : '').slice(0, 120);
  const isZh = currentLanguage === 'zh';

  const card = document.createElement('div');
  card.className = 'user-input-card user-choice-card';
  card.innerHTML = `
    <div class="user-choice-topline">
      <div class="user-choice-title">${isZh ? '选择操作' : 'Choose Action'}</div>
      <button class="user-choice-close" type="button" data-mode="cancel">×</button>
    </div>
    <div class="user-choice-question">${escapeHtml(msgPreview)}</div>
    <div class="user-choice-options">
      <button class="user-choice-option" type="button" data-mode="rollback">
        <span class="user-choice-key">1</span>
        <span>
          <span class="user-choice-label">${isZh ? '回退到此轮' : 'Rewind to Here'}</span>
          <span class="user-choice-description">${isZh ? '丢弃此轮之后的所有消息，回到此轮重新编辑' : 'Discard everything after this turn and edit again'}</span>
        </span>
      </button>
      <button class="user-choice-option" type="button" data-mode="compact">
        <span class="user-choice-key">2</span>
        <span>
          <span class="user-choice-label">${isZh ? '从此处压缩' : 'Summarize from Here'}</span>
          <span class="user-choice-description">${isZh ? '保留此轮之前的消息，将此轮及之后的内容压缩为摘要' : 'Keep earlier messages, summarize from this turn onward'}</span>
        </span>
      </button>
    </div>
    <div class="user-choice-footer">
      <span>${isZh ? '点击选择操作' : 'Click to choose an action'}</span>
    </div>
  `;

  // 交互弹窗与常驻输入框解耦：对话框渲染到 #choice-input-container（与
  // Ask User 选择卡同一交互面），输入槽只做 transient 清理 + composer 隐藏，
  // 节点保留（焦点/草稿/IME 不因弹窗销毁重建）。
  runWithSuppressedChatViewportObservers(() => {
    detachTransientInputContent(inputContainer);
    hidePersistentComposerCard();
    for (const child of Array.from(choiceContainer.children)) child.remove();
    choiceContainer.appendChild(card);
  });

  setTimeout(() => card.focus(), 30);

  const close = () => {
    if (!isSessionViewTokenCurrent(viewToken)) return;
    _rollbackDialogOpen = false;
    // 工单 037：接管标志写入即声明——签名在冻结期间已被记录为 frozen，
    // 关闭后的声明因模式差异自然恢复输入面（交互面容器随之清空、composer
    // 恢复显示）。
    notifyInputSurfaceChanged();
  };

  card.querySelector('[data-mode="cancel"]').addEventListener('click', close);

  // 点击交互面空白处关闭；onclick 属性与 choice 卡同款，恢复渲染时由
  // renderInputRequests 统一置空。
  choiceContainer.onclick = function(event) {
    if (event.target === choiceContainer) close();
  };

  // 打开即声明一次：让渲染器把 frozen 签名记录在案。若跳过这步且冻结期间
  // 无任何状态变化，close 的声明会因签名相同被去重跳过，composer 将停留
  // 在隐藏态（原实现表现为关闭后输入区空置，同一疏漏）。
  notifyInputSurfaceChanged();

  card.querySelector('[data-mode="rollback"]').addEventListener('click', async () => {
    close();
    await submitInputAction(request.requestId, 'rollback_to_call', {
      callIndex,
      draftInput: msg.content,
    }, boundRuntimeId, viewToken);
  });

  card.querySelector('[data-mode="compact"]').addEventListener('click', async () => {
    close();
    if (!isSessionViewTokenCurrent(viewToken)) return;
    _partialCompactInFlight = true;
    _partialCompactRuntimeId = boundRuntimeId;
    _partialCompactContextKey = boundContextKey;
    writePartialCompactStartedAt(Date.now(), _partialCompactContextKey);
    // 压缩标志先置、patch 写入即声明（工单 037）：渲染读取到 compacting 模式。
    applySessionViewPatch({ inputRequests: [] });
    await submitInputAction(request.requestId, 'compact_from_call', {
      callIndex,
    }, boundRuntimeId, viewToken);
  });
}
