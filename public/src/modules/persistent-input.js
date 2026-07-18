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
let _submitInFlight = false;       // 发送重入保护：fetch 期间阻止二次提交/中断

// 待发送的图片附件
let _pendingImages = [];

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

// ── 图片附件管理 ──────────────────────────────────────────────────

const _MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10 MB

/**
 * Read a File, show preview instantly via local data URL,
 * and kick off a silent background upload to get a server-side path.
 * The user never sees any upload state — the preview is immediate.
 */
function _addImageFile(file) {
  if (!file || !file.type || !file.type.startsWith('image/')) return;
  if (file.size > _MAX_IMAGE_SIZE) {
    console.warn('[Image Attach] File too large, skipping:', file.name, file.size);
    return;
  }
  const reader = new FileReader();
  reader.onload = function() {
    const dataUrl = reader.result;
    const base64 = dataUrl.split(',')[1];

    // Entry with instant local preview; path is filled when upload completes
    const entry = {
      mediaType: file.type,
      source: file.name || '(pasted image)',
      _previewUrl: dataUrl,
      _uploadPromise: null,
      path: null,
    };

    // Silent background upload — no UI feedback needed
    entry._uploadPromise = fetch('/protoclaw/images/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        base64,
        mediaType: file.type,
        source: entry.source,
      }),
    }).then(function(res) {
      if (!res.ok) throw new Error('Upload failed: ' + res.status);
      return res.json();
    }).then(function(data) {
      entry.path = data.path;
      entry.mediaType = data.mediaType || file.type;
      entry._previewUrl = data.url;
      return entry;
    }).catch(function(err) {
      console.error('[Image Attach] Background upload failed:', err);
      throw err;
    });

    _pendingImages.push(entry);
    _renderAttachmentPreview();
  };
  reader.readAsDataURL(file);
}

function _getAttachmentPreviewTargets() {
  const targets = Array.from(document.querySelectorAll('[data-attachment-preview]'));
  const legacy = document.getElementById('attachment-preview');
  if (legacy && !targets.includes(legacy)) targets.push(legacy);
  return targets;
}

function _renderAttachmentPreview() {
  const previews = _getAttachmentPreviewTargets();
  if (previews.length === 0) return;
  const cards = Array.from(document.querySelectorAll('.user-input-card'));
  if (_pendingImages.length === 0) {
    previews.forEach(function(preview) {
      preview.style.display = 'none';
      preview.innerHTML = '';
    });
    cards.forEach(function(card) { card.classList.remove('has-attachments'); });
    return;
  }
  const html = _pendingImages.map(function(img, idx) {
    return '<div class="attachment-thumb">' +
      '<img src="' + img._previewUrl + '" alt="' + escapeHtml(img.source || '') + '">' +
      '<button class="attachment-remove" type="button" onclick="removePendingImage(' + idx + ')" title="' +
        (currentLanguage === 'zh' ? '移除' : 'Remove') + '">×</button>' +
      '</div>';
  }).join('');
  previews.forEach(function(preview) {
    preview.style.display = 'flex';
    preview.innerHTML = html;
  });
  cards.forEach(function(card) { card.classList.add('has-attachments'); });
}

/**
 * Wait for all pending background uploads to finish.
 * Called before sending so the message carries path references.
 */
async function _awaitPendingImageUploads() {
  var promises = _pendingImages
    .filter(function(img) { return img._uploadPromise; })
    .map(function(img) { return img._uploadPromise.catch(function() { return null; }); });
  await Promise.all(promises);
}

function getPendingInputImages() {
  return _pendingImages
    .filter(function(img) { return img.path; })
    .map(function(img) {
      return { path: img.path, mediaType: img.mediaType, source: img.source };
    });
}

function clearPendingInputImages() {
  _pendingImages = [];
  _renderAttachmentPreview();
}

// ── window 导出 ────────────────────────────────────────────────────

window.handleInputPaste = function(event) {
  const items = event.clipboardData?.items;
  if (!items) return;
  let hasImage = false;
  for (const item of items) {
    if (item.type && item.type.startsWith('image/')) {
      hasImage = true;
      const file = item.getAsFile();
      if (file) _addImageFile(file);
    }
  }
  if (hasImage) {
    event.preventDefault();
  }
};

window.onImageFilesSelected = function(input) {
  if (!input.files) return;
  for (const file of input.files) {
    _addImageFile(file);
  }
  input.value = ''; // reset so same file can be re-selected
};

window.removePendingImage = function(idx) {
  _pendingImages.splice(idx, 1);
  _renderAttachmentPreview();
};

// ── 渲染常驻输入框 ────────────────────────────────────────────────

function renderPersistentInput(container) {
  // 先渲染队列气泡
  _renderQueueBubbles(container);

  const contextGuardBlocked = typeof isCurrentContextGuardBlocked === 'function'
    && isCurrentContextGuardBlocked();
  const contextGuardMessage = contextGuardBlocked && typeof getCurrentContextGuardMessage === 'function'
    ? getCurrentContextGuardMessage()
    : '';
  const disabledAttr = contextGuardBlocked ? ' disabled' : '';
  const disabledPlaceholder = currentLanguage === 'zh'
    ? '已达到上下文限制，输入已禁用'
    : 'Context limit reached — input disabled';
  const card = document.createElement('div');
  card.className = 'user-input-card persistent-input' + (contextGuardBlocked ? ' context-guard-input' : '');
  card.innerHTML = `
    <div class="persistent-attachment-preview" id="attachment-preview" data-attachment-preview style="display:none;"></div>
    ${contextGuardBlocked ? `
      <div class="context-guard-input-notice" role="alert">
        <span class="context-guard-input-icon">!</span>
        <span>${escapeHtml(contextGuardMessage)}</span>
      </div>
    ` : ''}
    <div class="persistent-input-row">
      <textarea class="user-input-textarea" rows="1" id="input-persistent"${disabledAttr}\n        onkeydown="handlePersistentInputKey(event)"\n        oninput="autoResize(this); _cacheSessionInput(this)"\n        onpaste="handleInputPaste(event)"\n        placeholder="${escapeHtml(contextGuardBlocked ? disabledPlaceholder : t('input_placeholder'))}"${contextGuardBlocked ? ` aria-label="${escapeHtml(contextGuardMessage)}"` : ''}></textarea>
      <input type="file" id="image-file-input" accept="image/*" multiple style="display:none;" onchange="onImageFilesSelected(this)"${disabledAttr}>
      <button class="persistent-icon-btn" id="attach-image-btn" onclick="document.getElementById('image-file-input').click()" title="${currentLanguage === 'zh' ? '添加图片' : 'Attach Image'}"${disabledAttr}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"></path></svg>
      </button>
      <button class="voice-input-btn" data-target="input-persistent" onclick="toggleVoiceRecording(this)" title="${currentLanguage === 'zh' ? '语音输入' : 'Voice Input'}"${disabledAttr}>
        <svg class="icon-mic" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="22"></line></svg>
      </button>
      <button class="persistent-action-btn" id="persistent-action-btn" onclick="onPersistentBtnClick()"${disabledAttr}>
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
  // Restore attachment preview if there are pending images (e.g. after re-render)
  _renderAttachmentPreview();
}

function onPersistentBtnClick() {
  const btn = document.getElementById('persistent-action-btn');
  if (!btn) return;
  if (_submitInFlight) return;         // fetch 进行中：阻止连点（防误触暂停）
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
  if (_submitInFlight) return;
  // 首次发送消息时请求桌面通知权限（用户手势内请求）-> modules/desktop-notify.js
  _requestNotifyPermission();
  const textarea = document.getElementById('input-persistent');
  if (!textarea) return;
  const text = textarea.value.trim();
  if (!text && _pendingImages.length === 0) return;
  const targetRuntimeId = currentRuntimeAgentId;
  const targetCacheKey = textarea.dataset.sessionKey || _getSessionInputCacheKey();

  _submitInFlight = true;
  // 乐观 UI：立即切换为 stop 按钮提供即时视觉反馈，消除"点击没反应"的手感。
  // _submitInFlight 守卫确保此期间点击不会触发 interruptAgent。
  _setActionBtnStop();

  // Build images payload — wait for background uploads to finish first
  await _awaitPendingImageUploads();
  const images = getPendingInputImages();

  try {
    const res = await fetch(`/api/agents/${targetRuntimeId}/queue-input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text || ' ', images: images.length > 0 ? images : undefined })
    });
    if (res.ok) {
      textarea.value = '';
      autoResize(textarea);
      clearPendingInputImages();
      if (targetCacheKey) delete _sessionInputCache[targetCacheKey];
      _clearRecapForNewMessage();
      beginFollowLatestEntryWindow();
      requestFollowLatest({ forceEnable: true, behavior: 'auto' });
      // 只有当 agent 正在 calling 时才显示排队气泡。
      // agent 空闲时后端会立即消费输入，不需要排队指示。
      if (isRuntimeCalling(targetRuntimeId)) {
        _localQueuedInputPending = true;
        _pendingQueuedCount++;
        _queuedTexts.push(text || (images && images.length ? '🖼' : '') || ' ');
        updateQueueIndicator();
      } else if (targetRuntimeId) {
        clearInterruptSuppression(targetRuntimeId);
        _markAgentCallStartedForNotify(targetRuntimeId);
        _agentCallActive.set(targetRuntimeId, true);
        _syncPersistentActionButton();
        renderAgentList();
      }
      const nextMode = getInputSurfaceMode(currentInputRequests || []);
      if (nextMode !== lastRenderedInputMode) {
        lastRenderedInputSignature = '';
        renderInputRequests(currentInputRequests || []);
      }
    }
  } catch (e) {
    console.error('排队输入提交失败:', e);
  } finally {
    _submitInFlight = false;
    _syncPersistentActionButton();
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
      .map((item) => {
        const t = typeof item?.text === 'string' ? item.text.trim() : '';
        if (t) return t;
        const imgCount = Array.isArray(item?.images) ? item.images.length : 0;
        return imgCount > 0 ? '🖼' : '';
      })
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
