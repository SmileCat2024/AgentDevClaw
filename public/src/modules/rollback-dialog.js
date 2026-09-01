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
  _partialCompactInFlight = false;
  _partialCompactRuntimeId = null;
  _partialCompactContextKey = null;
  if (_compactTimerInterval) {
    clearInterval(_compactTimerInterval);
    _compactTimerInterval = null;
  }
  clearPartialCompactStartedAt(contextKey);
  // 压缩状态清除即声明输入面变更（工单 037）：模式由 compacting 翻回，
  // 渲染器按签名差异自动恢复输入面。
  notifyInputSurfaceChanged();
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
  const container = document.getElementById('user-input-container');
  if (!container) return;
  const boundRuntimeId = currentRuntimeAgentId;
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

  runWithSuppressedChatViewportObservers(() => {
    container.innerHTML = '';
    container.classList.add('choice-input-active');
    container.classList.remove('choice-collapsed');
    container.onclick = null;
    container.appendChild(card);
  });

  setTimeout(() => card.focus(), 30);

  const close = () => {
    _rollbackDialogOpen = false;
    container.classList.remove('choice-input-active', 'choice-collapsed');
    // 工单 037：接管标志写入即声明——签名在冻结期间已被记录为 frozen，
    // 关闭后的声明因模式差异自然恢复输入面。
    notifyInputSurfaceChanged();
  };

  card.querySelector('[data-mode="cancel"]').addEventListener('click', close);

  container.addEventListener('click', function backdropHandler(e) {
    if (e.target === container) {
      container.removeEventListener('click', backdropHandler);
      close();
    }
  });

  card.querySelector('[data-mode="rollback"]').addEventListener('click', async () => {
    close();
    await submitInputAction(request.requestId, 'rollback_to_call', {
      callIndex,
      draftInput: msg.content,
    }, boundRuntimeId);
  });

  card.querySelector('[data-mode="compact"]').addEventListener('click', async () => {
    close();
    _partialCompactInFlight = true;
    _partialCompactRuntimeId = boundRuntimeId;
    _partialCompactContextKey = boundContextKey;
    writePartialCompactStartedAt(Date.now(), _partialCompactContextKey);
    // 压缩标志先置、patch 写入即声明（工单 037）：渲染读取到 compacting 模式。
    applySessionViewPatch({ inputRequests: [] });
    await submitInputAction(request.requestId, 'compact_from_call', {
      callIndex,
    }, boundRuntimeId);
  });
}
