/**
 * persistent-input.js — Phase B-4
 * 持久输入框 / 队列系统
 *
 * 包含：
 * - 常驻输入框渲染与交互（renderPersistentInput, onPersistentBtnClick, handlePersistentInputKey）
 * - 队列气泡管理与后端同步（_renderQueueBubbles, _syncQueueFromBackend, _syncPersistentInputUi）
 * - 中断操作（interruptAgent）
 * - 上次对话结束时间显示（_renderLastCallElapsed + setInterval）
 *
 * 依赖（全局，由 app-core.js / app-main.js / 已有模块提供）：
 * - t, escapeHtml, currentLanguage (app-core.js)
 * - currentRuntimeAgentId, currentInputRequests, lastRenderedInputSignature,
 *   lastRenderedInputMode, _agentCallActive, _interruptSuppression,
 *   INTERRUPT_SUPPRESSION_MS (app-core.js / app-main.js)
 * - isRuntimeCalling (runtime-status.js)
 * - renderAgentList, renderInputRequests, getInputSurfaceMode (app-main.js)
 * - isChatSurfaceActive, shouldRenderWorkspaceSurface (app-ui.js)
 * - autoResize (input-helpers.js)
 * - _voiceRecording, _voiceTranscribing, _voicePendingSend, stopVoiceRecording,
 *   _getSessionInputCacheKey, _restoreSessionInputDraft, _sessionInputCache,
 *   _cacheSessionInput, toggleVoiceRecording (voice-input.js)
 * - _clearRecapForNewMessage (recap-hint.js)
 * - _requestNotifyPermission (desktop-notify.js)
 * - beginFollowLatestEntryWindow, requestFollowLatest (chat-viewport.js)
 * - _lastRenderedNotificationRuntime (runtime-status.js)
 */

// 渲染常驻输入框（agent 运行期间始终可见）
let _pendingQueuedCount = 0;
let _queuedTexts = []; // 仅用于气泡展示
let _persistentUiSyncInFlight = false;
let _localQueuedInputPending = false;
let _lastQueueBubbleSignature = '';

// ── 上次对话结束时间显示 ──────────────────────────────────────────
let _lastCallFinishTime = 0;
let _callFinishTimerInterval = null;

function formatCallElapsed(finishTime) {
  const elapsed = Math.max(0, Date.now() - finishTime);
  const totalSeconds = Math.floor(elapsed / 1000);
  const zh = currentLanguage === 'zh';
  if (totalSeconds < 600) {
    if (totalSeconds < 60) {
      return zh ? totalSeconds + ' 秒前' : totalSeconds + 's ago';
    }
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return zh ? m + ' 分 ' + s + ' 秒前' : m + 'm ' + s + 's ago';
  }
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    return zh ? totalMinutes + ' 分钟前' : totalMinutes + 'm ago';
  }
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (m > 0) {
    return zh ? h + ' 小时 ' + m + ' 分前' : h + 'h ' + m + 'm ago';
  }
  return zh ? h + ' 小时前' : h + 'h ago';
}

function _ensureInputMetaBar(container) {
  let bar = container.querySelector('.input-meta-bar');
  if (bar) return bar;

  bar = document.createElement('div');
  bar.className = 'input-meta-bar';

  // Insert before the input card or queue bubbles
  const refEl = container.querySelector('.user-input-card, .queue-bubbles-stack');
  if (refEl) {
    container.insertBefore(bar, refEl);
  } else {
    container.appendChild(bar);
  }
  return bar;
}

function _cleanupInputMetaBar(container) {
  const bar = container.querySelector('.input-meta-bar');
  if (bar && bar.children.length === 0) {
    bar.remove();
  }
}

function _renderLastCallElapsed() {
  const container = document.getElementById('user-input-container');
  if (!container) return;

  let el = container.querySelector('.call-elapsed-capsule');

  if (!_lastCallFinishTime || isRuntimeCalling(currentRuntimeAgentId) || !isChatSurfaceActive()) {
    if (el) {
      el.remove();
      _cleanupInputMetaBar(container);
    }
    return;
  }

  const bar = _ensureInputMetaBar(container);

  if (!el) {
    el = document.createElement('div');
    el.className = 'call-elapsed-capsule';
    bar.insertBefore(el, bar.firstChild); // always leftmost
  }

  el.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg><span>${formatCallElapsed(_lastCallFinishTime)}</span>`;
}

// ── Recap (离开摘要) → modules/recap-hint.js (Phase A-7, 2026-07-03) ──

function renderPersistentInput(container) {
  // 先渲染队列气泡
  _renderQueueBubbles(container);

  const card = document.createElement('div');
  card.className = 'user-input-card persistent-input';
  card.innerHTML = `
    <div class="persistent-input-row">
      <textarea class="user-input-textarea" rows="1" id="input-persistent"\n        onkeydown="handlePersistentInputKey(event)"\n        oninput="autoResize(this); _cacheSessionInput(this)"\n        placeholder="${escapeHtml(t('input_placeholder'))}"></textarea>
      <button class="voice-input-btn" data-target="input-persistent" onclick="toggleVoiceRecording(this)" title="${currentLanguage === 'zh' ? '语音输入' : 'Voice Input'}">
        <svg class="icon-mic" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="22"></line></svg>
      </button>
      <button class="persistent-action-btn" id="persistent-action-btn" onclick="onPersistentBtnClick()">
        <svg class="icon-send" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
        <svg class="icon-stop" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style="display:none"><rect x="4" y="4" width="16" height="16" rx="3"></rect></svg>
      </button>
    </div>
  `;
  container.appendChild(card);
  // 在 textarea 上标记所属会话，供销毁前 save 使用（不依赖全局 currentRuntimeAgentId 时序）
  const ta = document.getElementById('input-persistent');
  if (ta) {
    const cacheKey = _getSessionInputCacheKey();
    ta.dataset.sessionKey = cacheKey || '';
    _restoreSessionInputDraft(ta, cacheKey);
  }
  _syncPersistentInputUi();
}

function onPersistentBtnClick() {
  const btn = document.getElementById('persistent-action-btn');
  if (!btn) return;
  if (_voiceTranscribing) return;
  if (_voiceRecording) {
    _voicePendingSend = true;
    stopVoiceRecording();
    return;
  }
  if (btn.classList.contains('is-stop')) {
    interruptAgent();
  } else {
    submitQueuedInput();
  }
}

function _setActionBtnStop() {
  const btn = document.getElementById('persistent-action-btn');
  if (!btn) return;
  btn.classList.add('is-stop');
  const iconSend = btn.querySelector('.icon-send');
  const iconStop = btn.querySelector('.icon-stop');
  if (iconSend) iconSend.style.display = 'none';
  if (iconStop) iconStop.style.display = '';
}

function _setActionBtnSend() {
  const btn = document.getElementById('persistent-action-btn');
  if (!btn) return;
  btn.classList.remove('is-stop');
  const iconSend = btn.querySelector('.icon-send');
  const iconStop = btn.querySelector('.icon-stop');
  if (iconSend) iconSend.style.display = '';
  if (iconStop) iconStop.style.display = 'none';
}

function _syncPersistentActionButton() {
  if (currentRuntimeAgentId && isRuntimeCalling(currentRuntimeAgentId)) {
    _setActionBtnStop();
  } else {
    _setActionBtnSend();
  }
}

function _renderQueueBubbles(container) {
  const signature = JSON.stringify(_queuedTexts);
  const existingStack = container.querySelector('.queue-bubbles-stack');
  if (signature === _lastQueueBubbleSignature && (
    (_queuedTexts.length === 0 && !existingStack)
    || (_queuedTexts.length > 0 && existingStack)
  )) {
    return;
  }
  _lastQueueBubbleSignature = signature;

  container.querySelectorAll('.queue-bubbles-stack').forEach(el => el.remove());
  if (_queuedTexts.length === 0) return;

  const stack = document.createElement('div');
  stack.className = 'queue-bubbles-stack';
  for (const txt of _queuedTexts) {
    const b = document.createElement('div');
    b.className = 'queue-bubble';
    b.textContent = txt.length > 80 ? txt.substring(0, 80) + '...' : txt;
    b.title = txt;
    stack.appendChild(b);
  }

  const card = container.querySelector('.user-input-card');
  if (card) container.insertBefore(stack, card);
  else container.appendChild(stack);
}

// 查询后端真实队列余量，移除已被消费的气泡
async function _syncQueueFromBackend() {
  await _syncPersistentInputUi();
}

function handlePersistentInputKey(event) {
  if (event.key === 'Enter') {
    if (event.ctrlKey || event.shiftKey) {
      return;
    }
    if (_voiceTranscribing) return;
    if (_voiceRecording) {
      _voicePendingSend = true;
      stopVoiceRecording();
      return;
    }
    event.preventDefault();
    submitQueuedInput();
  }
}

async function submitQueuedInput() {
  // 首次发送消息时请求桌面通知权限（用户手势内请求）-> modules/desktop-notify.js
  _requestNotifyPermission();
  const textarea = document.getElementById('input-persistent');
  if (!textarea) return;
  const text = textarea.value.trim();
  if (!text) return;
  const targetRuntimeId = currentRuntimeAgentId;
  const targetCacheKey = textarea.dataset.sessionKey || _getSessionInputCacheKey();

  try {
    const res = await fetch(`/api/agents/${targetRuntimeId}/queue-input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
    if (res.ok) {
      textarea.value = '';
      autoResize(textarea);
      if (targetCacheKey) delete _sessionInputCache[targetCacheKey];
      _clearRecapForNewMessage();
      beginFollowLatestEntryWindow();
      requestFollowLatest({ forceEnable: true, behavior: 'auto' });
      // 只有当 agent 正在 calling 时才显示排队气泡。
      // agent 空闲时后端会立即消费输入，不需要排队指示。
      if (isRuntimeCalling(targetRuntimeId)) {
        _localQueuedInputPending = true;
        _pendingQueuedCount++;
        _queuedTexts.push(text);
        updateQueueIndicator();
      }
      const nextMode = getInputSurfaceMode(currentInputRequests || []);
      if (nextMode !== lastRenderedInputMode) {
        lastRenderedInputSignature = '';
        renderInputRequests(currentInputRequests || []);
      }
    }
  } catch (e) {
    console.error('排队输入提交失败:', e);
  }
}

function updateQueueIndicator() {
  const container = document.getElementById('user-input-container');
  if (container) _renderQueueBubbles(container);
}

async function _syncPersistentInputUi(runtimeId = currentRuntimeAgentId) {
  if (_persistentUiSyncInFlight) return;
  _persistentUiSyncInFlight = true;
  const prevMode = getInputSurfaceMode(currentInputRequests || []);
  const prevQueueSignature = JSON.stringify(_queuedTexts);
  try {
    if (!runtimeId) {
      _queuedTexts = [];
      _pendingQueuedCount = 0;
      updateQueueIndicator();
      _syncPersistentActionButton();
      return;
    }

    const expectedRuntimeId = runtimeId;
    _syncPersistentActionButton();

    const res = await fetch(`/api/agents/${expectedRuntimeId}/queued-inputs`);
    if (!res.ok || expectedRuntimeId !== currentRuntimeAgentId) return;
    const data = await res.json();
    const queue = Array.isArray(data) ? data : (Array.isArray(data.inputs) ? data.inputs : []);
    const viewerQueueTexts = queue
      .map((item) => typeof item?.text === 'string' ? item.text.trim() : '')
      .filter(Boolean);

    _queuedTexts = viewerQueueTexts.slice();
    _pendingQueuedCount = _queuedTexts.length;
    if (_queuedTexts.length === 0 && !isRuntimeCalling(expectedRuntimeId)) {
      _localQueuedInputPending = false;
    }
    if (JSON.stringify(_queuedTexts) !== prevQueueSignature) {
      updateQueueIndicator();
    }
  } catch (e) {
    // ignore transient queue sync failures
  } finally {
    _persistentUiSyncInFlight = false;
  }
  const nextMode = getInputSurfaceMode(currentInputRequests || []);
  if (nextMode !== prevMode) {
    lastRenderedInputSignature = '';
    renderInputRequests(currentInputRequests || []);
  }
}

async function interruptAgent() {
  if (!currentRuntimeAgentId) return;

  // 乐观 UI 更新：立即清空 calling 状态、切换按钮、清空队列，
  // 不等 POST 返回，让用户瞬间看到反馈。
  // 设置中断抑制窗口：后端从 abort 生效到 call.finish 有延迟（取决于 agent
  // 当前所处阶段：LLM 流式 ~50ms，工具执行 + 钩子 + auto-save 可能数秒），
  // 期间轮询会拿到旧的 callActive:true。抑制窗口防止轮询覆盖乐观状态。
  _interruptSuppression.set(currentRuntimeAgentId, Date.now() + INTERRUPT_SUPPRESSION_MS);
  _agentCallActive.delete(currentRuntimeAgentId);
  _localQueuedInputPending = false;
  _pendingQueuedCount = 0;
  _queuedTexts = [];
  _lastQueueBubbleSignature = '';
  updateQueueIndicator();
  _setActionBtnSend();
  // 立即隐藏状态栏
  const statusEl = document.getElementById('notification-status');
  if (statusEl) {
    statusEl.style.display = 'none';
    statusEl.className = 'notification-status';
    const phaseEl = document.getElementById('notification-phase');
    const summaryEl = document.getElementById('notification-summary');
    const metricsEl = document.getElementById('notification-metrics');
    if (phaseEl) phaseEl.textContent = '';
    if (summaryEl) summaryEl.textContent = '';
    if (metricsEl) metricsEl.innerHTML = '';
  }
  _lastRenderedNotificationRuntime = null;
  renderAgentList();

  console.log(`[Interrupt] sending POST /api/agents/${currentRuntimeAgentId}/interrupt`);
  try {
    const res = await fetch(`/api/agents/${currentRuntimeAgentId}/interrupt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const data = await res.json();
    console.log(`[Interrupt] response:`, res.status, data);
    lastRenderedInputSignature = '';
    renderInputRequests(currentInputRequests || []);
  } catch (e) {
    console.error('[Interrupt] request failed:', e);
  }
}

// ── 启动上次对话结束时间计时器 ───

_callFinishTimerInterval = setInterval(_renderLastCallElapsed, 1000);
