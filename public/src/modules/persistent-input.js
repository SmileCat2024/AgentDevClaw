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
 * - currentRuntimeAgentId, currentInputRequests, _agentCallActive,
 *   _interruptSuppression, markInterruptPending, isInterruptSuppressed
 *   (app-core.js / app-main.js)
 * - isRuntimeCalling (runtime-status.js)
 * - renderAgentList (app-main.js)
 *   工单 037：模式翻转不再手动戳渲染——提交/队列同步声明
 *   notifyInputSurfaceChanged (input-render.js)，签名去重由渲染器统一处理。
 * - isChatSurfaceActive, shouldRenderWorkspaceSurface (app-ui.js)
 * - autoResize (input-helpers.js)
 * - _voiceRecording, _voiceStopping, _voiceTranscribing, _voicePendingSend, stopVoiceRecording,
 *   _getSessionInputCacheKey, _restoreSessionInputDraft, _sessionInputCache,
 *   _cacheSessionInput, toggleVoiceRecording (voice-input.js)
 * - _clearRecapForNewMessage (recap-hint.js)
 * - _requestNotifyPermission (desktop-notify.js)
 * - beginFollowLatestEntryWindow, requestFollowLatest (chat-viewport.js)
 * - _lastRenderedNotificationRuntime (runtime-status.js)
 * - updateInputModelSwitcher, updateThinkingEffortSwitcher (input-model-switcher.js)
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
let _runCapsuleStartAt = 0; // 运行期间胶囊使用的本轮 call 起始时间
let _runCapsuleStartConfirmed = false; // 起始时间是否已由运行时快照确认（未确认前允许快照值回拨纠正）

const _CAPSULE_CLOCK_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>';

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

// 运行期间的整轮用时："已运行 12 秒" / "已运行 1 分 5 秒" / "已运行 1 小时 5 分"
function formatRunningElapsed(startAt) {
  const totalSeconds = Math.floor(Math.max(0, Date.now() - startAt) / 1000);
  const zh = currentLanguage === 'zh';
  if (totalSeconds < 60) {
    return zh ? '已运行 ' + totalSeconds + ' 秒' : 'Running ' + totalSeconds + 's';
  }
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  if (m < 60) {
    return zh ? '已运行 ' + m + ' 分 ' + s + ' 秒' : 'Running ' + m + 'm ' + s + 's';
  }
  const h = Math.floor(m / 60);
  const restM = m % 60;
  return zh ? '已运行 ' + h + ' 小时 ' + restM + ' 分' : 'Running ' + h + 'h ' + restM + 'm';
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
  const calling = isRuntimeCalling(currentRuntimeAgentId);

  if ((!calling && !_lastCallFinishTime) || !isChatSurfaceActive()) {
    if (el) {
      el.remove();
      _cleanupInputMetaBar(container);
    }
    if (!calling) {
      _runCapsuleStartAt = 0;
      _runCapsuleStartConfirmed = false;
    }
    return;
  }

  const bar = _ensureInputMetaBar(container);

  if (!el) {
    el = document.createElement('div');
    el.className = 'call-elapsed-capsule';
    bar.insertBefore(el, bar.firstChild); // always leftmost
  }

  if (calling) {
    // 运行期间：显示整轮运行时长（已运行 X 分 Y 秒）
    // callStartedAt 优先取运行时快照。快照未到达时（如刚刷新页面）用本地时间
    // 兜底，之后的第一个有效快照值即使更早也直接采纳（服务器侧记录了真实
    // 起始时间，刷新后应回拨纠正）；确认过快照后只接受更新的起始时间，
    // 防止上一轮 call 的旧值把时钟拨回去。
    const snapshotStart = Number(_lastRenderedNotificationRuntime?.callStartedAt) || 0;
    if (snapshotStart > 0) {
      if (!_runCapsuleStartConfirmed || snapshotStart > _runCapsuleStartAt) {
        _runCapsuleStartAt = snapshotStart;
      }
      _runCapsuleStartConfirmed = true;
    } else if (_runCapsuleStartAt <= 0) {
      _runCapsuleStartAt = Date.now();
    }
    el.classList.add('is-running');
    el.innerHTML = `${_CAPSULE_CLOCK_SVG}<span>${formatRunningElapsed(_runCapsuleStartAt)}</span>`;
    return;
  }

  _runCapsuleStartAt = 0;
  _runCapsuleStartConfirmed = false;
  el.classList.remove('is-running');
  el.innerHTML = `${_CAPSULE_CLOCK_SVG}<span>${formatCallElapsed(_lastCallFinishTime)}</span>`;
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
  let promises = _pendingImages
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

// Composer 卡常驻 DOM（input-composer.js）：persistent 端点只是模式属性，
// 这里做幂等的"确保挂载 + 属性级更新 + 会话重绑"，不再每次新建元素。
function renderPersistentInput(container) {
  // 先渲染队列气泡
  _renderQueueBubbles(container);

  const card = showPersistentComposerCard(container);
  applyComposerMode(card, 'persistent');
  syncPersistentComposerSessionCard(container);
  _syncPersistentInputUi();
  // Restore attachment preview if there are pending images (e.g. after re-render)
  _renderAttachmentPreview();
  // Update model switcher button with current preset name
  updateInputModelSwitcher();
  // Update thinking effort switcher button
  updateThinkingEffortSwitcher();
}

/**
 * 压力驱动的超阈值提示 chip：当前用量占压缩阈值的比例 ≥100% 时出现在
 * 输入框顶部，压力回落自动消失。数据来自 updateChatContextBar 每轮
 * poll 的计算（与 context bar 进度条同源），不做独立状态机。
 */
function syncContextPressureChip(thresholdPct) {
  const card = document.querySelector('.user-input-card.persistent-input');
  if (!card) return;
  const chip = card.querySelector(':scope > .context-pressure-chip');
  const over = Number.isFinite(thresholdPct) && thresholdPct >= 100;
  if (!over) {
    if (chip) chip.remove();
    return;
  }
  const zh = currentLanguage === 'zh';
  if (chip) {
    chip.textContent = zh ? '上下文已超阈值 — 建议精简后继续' : 'Context over threshold — consider trimming';
    return;
  }
  const el = document.createElement('div');
  el.className = 'context-pressure-chip';
  el.setAttribute('role', 'status');
  el.textContent = zh ? '上下文已超阈值 — 建议精简后继续' : 'Context over threshold — consider trimming';
  card.prepend(el);
}

function onPersistentBtnClick() {
  const btn = document.getElementById('persistent-action-btn');
  if (!btn) return;
  if (_submitInFlight) return;         // fetch 进行中：阻止连点（防误触暂停）
  if (btn.classList.contains('is-interrupting')) return;
  // “停止 Agent”优先于语音按钮状态。录音是独立资源，打断 Agent 不应
  // 把这次点击改写成“停止录音并发送”，否则会出现二次暂停和录音截断。
  if (btn.classList.contains('is-stop')) {
    interruptAgent();
    return;
  }
  if (_voiceTranscribing) return;
  if (_voiceRecording) {
    _voicePendingSend = true;
    stopVoiceRecording();
    return;
  }
  if (_voiceStopping) {
    _voicePendingSend = true;
    return;
  }
  submitQueuedInput();
}

function _setActionBtnStop() {
  const btn = document.getElementById('persistent-action-btn');
  if (!btn) return;
  btn.classList.remove('is-interrupting');
  btn.classList.add('is-stop');
  btn.removeAttribute('aria-busy');
  btn.title = currentLanguage === 'zh' ? '停止当前任务' : 'Stop current task';
  const iconSend = btn.querySelector('.icon-send');
  const iconStop = btn.querySelector('.icon-stop');
  if (iconSend) iconSend.style.display = 'none';
  if (iconStop) iconStop.style.display = '';
}

function _setActionBtnInterrupting() {
  const btn = document.getElementById('persistent-action-btn');
  if (!btn) return;
  btn.classList.add('is-stop', 'is-interrupting');
  btn.setAttribute('aria-busy', 'true');
  btn.title = currentLanguage === 'zh' ? '正在停止当前任务…' : 'Stopping current task…';
  const iconSend = btn.querySelector('.icon-send');
  const iconStop = btn.querySelector('.icon-stop');
  if (iconSend) iconSend.style.display = 'none';
  if (iconStop) iconStop.style.display = '';
}

function _setActionBtnSend() {
  const btn = document.getElementById('persistent-action-btn');
  if (!btn) return;
  btn.classList.remove('is-stop', 'is-interrupting');
  btn.removeAttribute('aria-busy');
  btn.title = currentLanguage === 'zh' ? '发送' : 'Send';
  const iconSend = btn.querySelector('.icon-send');
  const iconStop = btn.querySelector('.icon-stop');
  if (iconSend) iconSend.style.display = '';
  if (iconStop) iconStop.style.display = 'none';
}

function _syncPersistentActionButton() {
  if (currentRuntimeAgentId && isInterruptSuppressed(currentRuntimeAgentId)) {
    _setActionBtnInterrupting();
  } else if (currentRuntimeAgentId && isRuntimeCalling(currentRuntimeAgentId)) {
    _setActionBtnStop();
  } else {
    _setActionBtnSend();
  }
}

function _renderQueueBubbles(container) {
  // 线程暂存（Thread Inbox pending）与 viewer 排队同栈渲染：
  // 前者意图归属是「工作」（交接窗口/非 head 暂存，新会话就绪后投递），
  // 后者归属是「runtime」（call 间排队）。样式变体区分，语义不混。
  const threadPending = (typeof window.getThreadPendingTexts === 'function')
    ? window.getThreadPendingTexts()
    : [];
  const signature = JSON.stringify({ q: _queuedTexts, t: threadPending });
  const existingStack = container.querySelector('.queue-bubbles-stack');
  if (signature === _lastQueueBubbleSignature && (
    (_queuedTexts.length === 0 && threadPending.length === 0 && !existingStack)
    || ((_queuedTexts.length > 0 || threadPending.length > 0) && existingStack)
  )) {
    return;
  }
  _lastQueueBubbleSignature = signature;

  container.querySelectorAll('.queue-bubbles-stack').forEach(el => el.remove());
  if (_queuedTexts.length === 0 && threadPending.length === 0) return;

  const stack = document.createElement('div');
  stack.className = 'queue-bubbles-stack';
  for (const txt of threadPending) {
    const b = document.createElement('div');
    b.className = 'queue-bubble thread-staged';
    b.textContent = txt.length > 80 ? txt.substring(0, 80) + '...' : txt;
    b.title = txt;
    stack.appendChild(b);
  }
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

  let capabilityActivations = null;
  try {
    // 线程路由快路径（coder 宿主）：交接窗口 / 非 head 会话时输入改走
    // Thread Inbox（服务端 input-gateway 是兜底真相，此处拦截只为即时
    // 暂存气泡反馈）。viewer 排队语义只对健康 runtime 有意义，不适用。
    const threadRoute = (typeof window.resolveThreadInputRoute === 'function')
      ? window.resolveThreadInputRoute()
      : { route: 'direct' };
    if (threadRoute.route === 'thread') {
      if (images.length > 0) {
        throw new Error(currentLanguage === 'zh'
          ? '会话交接进行中：暂不支持图片输入，请在新会话就绪后重发'
          : 'Session handoff in progress: image input is not supported yet');
      }
      if (!text) throw new Error('empty input');
      capabilityActivations = window.ClawSlash?.consumeActivations?.() || null;
      await window.submitThreadCommand(threadRoute.thread.threadId, text, {
        ...(capabilityActivations?.length ? { capabilityActivations } : {}),
      });
      // await 期间 composer 端点可能翻转（textarea id 随模式切换），但节点
      // 常驻不重建。定位当前 live textarea（优先 persistent 端点，端点已切换
      // 时回落到容器内唯一 composer 输入框），并校验仍属同一会话：否则已发送
      // 文本残留，且会话切换前的草稿写回会让它"复活"。
      const liveTextarea0 = document.getElementById('input-persistent')
        || document.querySelector('.user-input-textarea:not([disabled])');
      if (liveTextarea0
        && (liveTextarea0.dataset?.sessionKey || _getSessionInputCacheKey()) === targetCacheKey) {
        liveTextarea0.value = '';
        autoResize(liveTextarea0);
      }
      if (targetCacheKey) delete _sessionInputCache[targetCacheKey];
      _clearRecapForNewMessage();
      window.refreshThreads?.(true);
      updateQueueIndicator();
      window.ClawToast?.show?.({
        id: `thread-staged-${threadRoute.thread.threadId}`,
        status: 'info',
        title: currentLanguage === 'zh' ? '已暂存 · 新会话就绪后自动继续' : 'Staged · will continue in the successor session',
        autoDismiss: 5000,
      });
      return;
    }

    capabilityActivations = window.ClawSlash?.consumeActivations?.() || null;
    const res = await fetch(`/api/agents/${targetRuntimeId}/user-turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-idempotency-key': newIdempotencyKey() },
      body: JSON.stringify({
        text: text || ' ',
        images: images.length > 0 ? images : undefined,
        source: 'chat-composer',
        ...(capabilityActivations?.length ? { capabilityActivations } : {}),
        operationId: `user-turn:${Date.now()}`,
      })
    });
    if (res.ok) {
      const delivery = await res.json().catch(() => ({}));
      // await 期间输入面不再整块重建，但 composer 端点可能翻转：定位当前
      // live textarea（端点已切换时回落到容器内唯一 composer 输入框），并校验
      // 仍属同一会话——已发送文本不得残留或经草稿写回"复活"。
      const liveTextarea = document.getElementById('input-persistent')
        || document.querySelector('.user-input-textarea:not([disabled])');
      if (liveTextarea
        && (liveTextarea.dataset?.sessionKey || _getSessionInputCacheKey()) === targetCacheKey) {
        liveTextarea.value = '';
        autoResize(liveTextarea);
      }
      clearPendingInputImages();
      if (targetCacheKey) delete _sessionInputCache[targetCacheKey];
      _clearRecapForNewMessage();
      beginFollowLatestEntryWindow();
      requestFollowLatest({ forceEnable: true, behavior: 'auto' });
      // 只有当 agent 正在 calling 时才显示排队气泡。
      // agent 空闲时后端会立即消费输入，不需要排队指示。
      if (delivery.delivery === 'thread_queued') {
        // 服务端网关兜底拦截（快路径未命中但交接已开始）：输入已进
        // Thread Inbox，刷新线程数据即可渲染暂存气泡
        window.refreshThreads?.(true);
        updateQueueIndicator();
        window.ClawToast?.show?.({
          id: `thread-staged-gw-${targetRuntimeId}`,
          status: 'info',
          title: currentLanguage === 'zh' ? '已暂存 · 新会话就绪后自动继续' : 'Staged · will continue in the successor session',
          autoDismiss: 5000,
        });
      } else if (delivery.delivery === 'queued') {
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
      // 排队乐观态/提交完成后的模式可能翻转（工单 037）：声明变更即可，
      // 渲染器按签名差异决定是否重建。
      notifyInputSurfaceChanged(currentInputRequests || []);
    } else {
      const error = await res.json().catch(() => ({}));
      throw new Error(error.error || `HTTP ${res.status}`);
    }
  } catch (e) {
    console.error('排队输入提交失败:', e);
    // 消息未发出：归还激活 refs，输入框重试发送时仍携带
    if (capabilityActivations?.length) {
      window.ClawSlash?.restoreActivations?.(capabilityActivations);
    }
    window.ClawToast?.show({
      id: `user-turn-failed-${targetRuntimeId}`,
      status: 'error',
      title: currentLanguage === 'zh' ? '消息发送失败' : 'Failed to send message',
      description: e instanceof Error ? e.message : String(e),
      autoDismiss: 6000,
    });
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
  // Always update model switcher regardless of queue/runtime state
  updateInputModelSwitcher();
  updateThinkingEffortSwitcher();
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
  // 队列同步可能翻转显示模式（排空 → 请求卡恢复，工单 037）：声明变更即可，
  // 渲染器按签名差异决定是否重建；无翻转时是幂等 no-op。
  notifyInputSurfaceChanged(currentInputRequests || []);
}

async function interruptAgent() {
  if (!currentRuntimeAgentId) return;
  const targetRuntimeId = currentRuntimeAgentId;
  if (isInterruptSuppressed(targetRuntimeId)) return;
  const wasCalling = isRuntimeCalling(targetRuntimeId);

  // 立即进入粘性的 interrupting 状态；中间阶段仍然是“正在停止”，绝不伪装成
  // idle。后续同一 call 的 callActive:true 只是排空中的旧状态，不能恢复按钮。
  markInterruptPending(targetRuntimeId, getNotificationCallStartedAt(lastNotificationStatusPayload));
  _agentCallActive.delete(targetRuntimeId);
  _localQueuedInputPending = false;
  _pendingQueuedCount = 0;
  _queuedTexts = [];
  _lastQueueBubbleSignature = '';
  updateQueueIndicator();
  _setActionBtnInterrupting();
  // 明确展示过渡态，直到同一 call 的终态到达。
  const statusEl = document.getElementById('notification-status');
  if (statusEl) {
    statusEl.style.display = 'flex';
    statusEl.className = 'notification-status active is-interrupting';
    const phaseEl = document.getElementById('notification-phase');
    const summaryEl = document.getElementById('notification-summary');
    const metricsEl = document.getElementById('notification-metrics');
    if (phaseEl) phaseEl.textContent = currentLanguage === 'zh' ? '正在停止…' : 'Stopping…';
    if (summaryEl) summaryEl.textContent = currentLanguage === 'zh'
      ? '等待当前步骤安全退出'
      : 'Waiting for the current step to exit safely';
    if (metricsEl) metricsEl.innerHTML = '';
  }
  _lastRenderedNotificationRuntime = null;
  renderAgentList();

  console.log(`[Interrupt] sending POST /api/agents/${targetRuntimeId}/interrupt`);
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(targetRuntimeId)}/interrupt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-idempotency-key': newIdempotencyKey() },
    });
    const data = await res.json().catch(() => ({}));
    console.log(`[Interrupt] response:`, res.status, data);
    if (!res.ok || data?.success === false || data?.error) {
      throw new Error(data?.error || `HTTP ${res.status}`);
    }
  } catch (e) {
    console.error('[Interrupt] request failed:', e);
    // 请求没有被接受时才回滚 interrupting。成功请求没有任何超时回滚；它必须
    // 等待 call.finish/callActive:false，以免旧轮询制造“假恢复”。
    clearInterruptSuppression(targetRuntimeId);
    if (wasCalling) _agentCallActive.set(targetRuntimeId, true);
    if (normalizeAgentIdentity(currentRuntimeAgentId) === normalizeAgentIdentity(targetRuntimeId)) {
      _syncPersistentActionButton();
      updateNotificationStatus(lastNotificationStatusPayload || null);
    }
    renderAgentList();
    window.ClawToast?.show?.({
      id: `interrupt-failed-${targetRuntimeId}`,
      status: 'error',
      title: currentLanguage === 'zh' ? '停止请求失败' : 'Stop request failed',
      description: e instanceof Error ? e.message : String(e),
    });
  }
}

// ── 启动上次对话结束时间计时器 ───

_callFinishTimerInterval = setInterval(_renderLastCallElapsed, 1000);
