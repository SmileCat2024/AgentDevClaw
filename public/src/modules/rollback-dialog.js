/**
 * rollback-dialog.js — Partial Compact / Rollback Dialog
 * 从 app-main.js 拆出（Phase A-6）
 * 拆出日期：2026-07-03
 *
 * 依赖全局状态（定义在 app-core.js）:
 *   currentRuntimeAgentId, currentLanguage, currentMessages, currentInputRequests
 * 依赖全局函数:
 *   _getSessionInputCacheKey (app-main.js)
 *   getRollbackInputRequest, getPrimaryInputRequest, requestSupportsAction,
 *   submitInputAction (input-helpers.js)
 *   isRuntimeCalling (runtime-status.js), isInterruptSuppressed (app-core.js)
 *   interruptAgent (persistent-input.js)
 *   notifyInputSurfaceChanged (input-render.js，工单 037 唯一渲染声明入口)
 *   detachTransientInputContent, hidePersistentComposerCard (input-composer.js)
 *   applySessionViewPatch, captureSessionViewToken, isSessionViewTokenCurrent
 *   (session-view-state.js)
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

// ── 运行期回退（轮次执行中的回退编排）──────────────────────────
// 回退能力由输入 lease 驱动：轮次执行期间（模型思考中 / 报错重试中 / 工具
// 运行中）lease 已被本轮消费，历史上按钮点击静默失效。运行期路径：确认
// 操作后自动打断当前轮次，等待输入循环空闲重发 lease，再提交所选动作。
// 间隔与超时可覆盖（测试注入短周期）。
let _rollbackLeasePollIntervalMs = 400;
let _rollbackLeaseWaitTimeoutMs = 30000;
let _rollbackAwaitInFlight = false;

function _rollbackToast(status, title, description) {
  if (typeof ClawToast === 'undefined' || !ClawToast?.show) return;
  ClawToast.show({
    id: `rollback-runtime-${status}-${Date.now()}`,
    status,
    title,
    ...(description ? { description } : {}),
    autoDismiss: 6000,
  });
}

function _notifyRollbackNoLease() {
  const isZh = currentLanguage === 'zh';
  _rollbackToast('error',
    isZh ? '当前没有可用的回退输入' : 'No rollback-capable input available',
    isZh ? '会话尚未就绪或不在等待输入' : 'The session is not ready or not waiting for input');
}

function _notifyRollbackInterrupting() {
  const isZh = currentLanguage === 'zh';
  _rollbackToast('info',
    isZh ? '正在打断当前轮次…' : 'Interrupting the current turn…',
    isZh ? '轮次结束后将自动执行所选操作' : 'The chosen action will run once the turn finishes');
}

function _notifyRollbackAwaitTimeout() {
  const isZh = currentLanguage === 'zh';
  _rollbackToast('error',
    isZh ? '等待轮次结束超时' : 'Timed out waiting for the turn to finish',
    isZh ? '请稍后重试回退' : 'Please retry the rollback later');
}

function _notifyRollbackAwaitBusy() {
  const isZh = currentLanguage === 'zh';
  _rollbackToast('info',
    isZh ? '正在等待轮次结束以执行回退' : 'Waiting for the turn to finish before rolling back');
}

function _notifyRollbackNoTargets() {
  const isZh = currentLanguage === 'zh';
  _rollbackToast('error',
    isZh ? '轮次结束后没有可回退的点' : 'No rollback targets after the turn finished');
}

/**
 * 运行期回退编排：打断当前轮次并等待输入循环空闲后重发的 lease。
 * 返回携带 rollback/compact 动作的 lease；失败（打断请求失败 / 等待超时 /
 * lease 无回退动作 / 会话已切走）返回 null。等待期间会话切走时立即放弃，
 * 绝不把旧会话的回退提交到新会话。
 */
async function _ensureRollbackLeaseAfterInterrupt(boundRuntimeId, viewToken) {
  const runtimeId = String(boundRuntimeId || '').trim();
  if (!runtimeId) return null;
  if (_rollbackAwaitInFlight) {
    _notifyRollbackAwaitBusy();
    return null;
  }
  _rollbackAwaitInFlight = true;
  try {
    // interrupting 中的轮次（suppression 粘性态）不再重复打断，直接等终态。
    if (isRuntimeCalling(runtimeId) && !isInterruptSuppressed(runtimeId)) {
      _notifyRollbackInterrupting();
      const result = await interruptAgent();
      if (result && result.ok === false && result.reason === 'request-failed') {
        // 打断请求本身失败：轮次不会终止，等待必超时；interruptAgent 已
        // toast 失败原因，这里直接放弃。
        return null;
      }
    }
    const deadline = Date.now() + _rollbackLeaseWaitTimeoutMs;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, _rollbackLeasePollIntervalMs));
      const viewStillCurrent = typeof isSessionViewTokenCurrent === 'function'
        ? isSessionViewTokenCurrent(viewToken)
        : currentRuntimeAgentId === runtimeId;
      if (!viewStillCurrent) return null;
      const lease = typeof getPrimaryInputRequest === 'function'
        ? getPrimaryInputRequest()
        : (Array.isArray(currentInputRequests) ? currentInputRequests[0] : null);
      if (lease) {
        if (requestSupportsAction(lease, 'rollback_to_call')
          || requestSupportsAction(lease, 'compact_from_call')) {
          return lease;
        }
        // lease 已重发但没有可回退点：继续等待无意义。
        _notifyRollbackNoTargets();
        return null;
      }
    }
    _notifyRollbackAwaitTimeout();
    return null;
  } finally {
    _rollbackAwaitInFlight = false;
  }
}

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
  const msg = currentMessages[messageIndex];
  if (!msg || msg.role !== 'user') {
    return;
  }

  const fallbackCallIndex = currentMessages
    .slice(0, messageIndex + 1)
    .filter(entry => entry.role === 'user')
    .length - 1;
  const callIndex = typeof msg.turn === 'number' ? msg.turn : fallbackCallIndex;

  const request = getRollbackInputRequest();
  if (request) {
    showRollbackActionDialog(request, callIndex, msg);
    return;
  }

  // 无 lease 且轮次执行中（含打断进行中）：lease 已被本轮消费，历史行为是
  // 静默返回（表现为「点击无反应」）。改为进入运行期模式：确认操作后
  // 自动打断当前轮次并等待终态执行。
  const runtimeId = currentRuntimeAgentId;
  if (runtimeId && (isRuntimeCalling(runtimeId) || isInterruptSuppressed(runtimeId))) {
    showRollbackActionDialog(null, callIndex, msg);
    return;
  }
  // 既无 lease 也无运行轮次：没有可回退的输入面，给出明确反馈。
  _notifyRollbackNoLease();
};

function showRollbackActionDialog(request, callIndex, msg) {
  const inputContainer = document.getElementById('user-input-container');
  const choiceContainer = document.getElementById('choice-input-container');
  if (!inputContainer || !choiceContainer) return;
  // request 为 null：轮次运行中（无 lease），确认操作后打断 + 等终态 + 提交。
  const runningTurn = !request;
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
    ${runningTurn ? `
    <div class="user-choice-running-hint">
      ${isZh ? '当前轮次仍在运行，选择操作后将自动打断它' : 'The current turn is still running; choosing an action will interrupt it'}
    </div>` : ''}
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
    const lease = runningTurn
      ? await _ensureRollbackLeaseAfterInterrupt(boundRuntimeId, viewToken)
      : request;
    if (!lease) return;
    if (!isSessionViewTokenCurrent(viewToken)) return;
    await submitInputAction(lease.requestId, 'rollback_to_call', {
      callIndex,
      draftInput: msg.content,
    }, boundRuntimeId, viewToken);
  });

  card.querySelector('[data-mode="compact"]').addEventListener('click', async () => {
    close();
    if (!isSessionViewTokenCurrent(viewToken)) return;
    const lease = runningTurn
      ? await _ensureRollbackLeaseAfterInterrupt(boundRuntimeId, viewToken)
      : request;
    if (!lease) return;
    if (!isSessionViewTokenCurrent(viewToken)) return;
    _partialCompactInFlight = true;
    _partialCompactRuntimeId = boundRuntimeId;
    _partialCompactContextKey = boundContextKey;
    writePartialCompactStartedAt(Date.now(), _partialCompactContextKey);
    // 压缩标志先置、patch 写入即声明（工单 037）：渲染读取到 compacting 模式。
    applySessionViewPatch({ inputRequests: [] });
    await submitInputAction(lease.requestId, 'compact_from_call', {
      callIndex,
    }, boundRuntimeId, viewToken);
  });
}
