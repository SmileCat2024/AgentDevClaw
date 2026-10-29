/**
 * persistent-input.js — Phase B-4
 * 持久输入框 / 队列系统
 *
 * 包含：
 * - 常驻输入框渲染与交互（renderPersistentInput, onPersistentBtnClick, handlePersistentInputKey）
 * - 队列气泡管理与后端同步（_renderQueueBubbles, _syncQueueFromBackend,
 *   _syncPersistentInputUi；投影经 rebindQueueProjectionForRuntime 按会话归属）
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
// 排队气泡投影的归属（会话隔离）：_queuedTexts / _pendingQueuedCount /
// _localQueuedInputPending 始终属于一个 runtime，与图片桶、草稿同属输入面
// 会话态家族。会话切换经 rebindQueueProjectionForRuntime 重绑，写入路径
// （applyQueuedInputsTexts / submitQueuedInput 乐观态）一律带归属校验，
// 旧会话的排队气泡不进入新会话的输入面。
let _queuedProjectionRuntimeId = null;
let _submitInFlight = false;       // 发送重入保护：fetch 期间阻止二次提交/中断
let _sendingStartedAt = 0;         // 发送反馈窗口起点（最短可见时长的计时基准）
let _sendingHoldTimer = null;      // 最短可见保持定时器：hold 期间轮询同步不得清 spinner

// 待发送的图片附件：按会话隔离存储（与 SessionReference 的会话引用同套路）。
// Map<key, entries[]>，key 复用 window.SessionReference.activeKey()——附件类
// 会话态的"哪个会话"只此一份权威判定（runtimeId::sessionId 组合，挂载/消费/
// 渲染三时刻读同一值）。会话 A 挂的图片不出现在会话 B 的输入框，切回 A 恢复；
// 发送只消费发送时刻捕获的桶，await 期间切换会话不误发新会话的图片。
const _pendingImageBuckets = new Map(); // key → [entry]

function _imageBucketKey() {
  return window.SessionReference?.activeKey?.() || 'default';
}

function _imageBucket() {
  const key = _imageBucketKey();
  let bucket = _pendingImageBuckets.get(key);
  if (!Array.isArray(bucket)) {
    bucket = [];
    _pendingImageBuckets.set(key, bucket);
  }
  return bucket;
}

// ── 上次对话结束时间显示 ──────────────────────────────────────────
let _lastCallFinishTime = 0;
let _callFinishTimerInterval = null;
let _runCapsuleStartAt = 0; // 运行期间胶囊使用的本轮 call 起始时间
let _runCapsuleStartConfirmed = false; // 起始时间是否已由运行时快照确认（未确认前允许快照值回拨纠正）

function resetCallElapsedForSwitch() {
  _lastCallFinishTime = 0;
  _runCapsuleStartAt = 0;
  _runCapsuleStartConfirmed = false;
  const container = document.getElementById('user-input-container');
  if (!container) return;
  container.querySelector('.call-elapsed-capsule')?.remove();
  _cleanupInputMetaBar(container);
}

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

// 交互面（#choice-input-container：Ask User 选择卡 / 回退压缩对话框）是否
// 正在占用输入区。读交互面容器的 DOM 事实（非空即接管），不依赖类标记——
// 历史 choice-input-active 类写在 user-input-container 上，交互面解耦后
// 已无写入方，类协议随之退役。
function _interactiveSurfaceOccupiesInput() {
  const surface = document.getElementById('choice-input-container');
  return !!surface && surface.children.length > 0;
}

function _renderLastCallElapsed() {
  const container = document.getElementById('user-input-container');
  if (!container) return;

  let el = container.querySelector('.call-elapsed-capsule');

  // 交互面（选择卡/回退对话框）占用输入面期间不显示运行时长胶囊（否则悬在
  // 交互卡上方）。本函数由每秒 tick 驱动，必须在这里统一拦截，否则胶囊会被
  // 重新插回。不重置 _runCapsuleStartAt：交互卡结束后回到运行态时计时应继续。
  if (_interactiveSurfaceOccupiesInput()) {
    if (el) {
      el.remove();
      _cleanupInputMetaBar(container);
    }
    return;
  }

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

// 图片按宿主机落盘寻址（ADR-0006/0011）：消息里的 path 由 agent 所在机器的
// runtime 读取，附件必须落在发送目标同一台主机上。本地会话 'local'，远程
// 会话按连接维度（remote:<connectionId>）——同一连接内的会话切换无需转存。
function _imageHostKey(agentId) {
  const split = (typeof window.RemoteConnections?.splitNamespaceId === 'function')
    ? window.RemoteConnections.splitNamespaceId(agentId)
    : null;
  return split ? `remote:${split.connectionId}` : 'local';
}

/**
 * Read a File, show preview instantly via local data URL, and kick off a
 * silent background upload to get a server-side path on the host the composer
 * is currently addressing. The user never sees any upload state.
 */
function _addImageFile(file) {
  if (!file || !file.type || !file.type.startsWith('image/')) return;
  const reader = new FileReader();
  reader.onload = function() {
    const dataUrl = reader.result;

    // Entry with instant local preview; path is filled when upload completes
    const entry = {
      mediaType: file.type,
      source: file.name || '(pasted image)',
      _previewUrl: dataUrl,
      _base64: dataUrl.split(',')[1],
      _uploadPromise: null,
      _hostKey: null,
      path: null,
    };

    entry._uploadPromise = _uploadImageEntryTo(entry, currentRuntimeAgentId);
    // 上传失败在发送前的就绪解析里显式报告；此处兜底记录，避免悬挂拒绝。
    entry._uploadPromise.catch(function(err) {
      console.error('[Image Attach] Background upload failed:', err);
    });

    _imageBucket().push(entry);
    _renderAttachmentPreview();
  };
  reader.readAsDataURL(file);
}

function _uploadImageEntryTo(entry, targetAgentId) {
  // 发送目标身份随请求携带：服务端据此决定落盘本机还是转发远程同名路由
  // （ADR-0011，远程会话的 path 必须在 agent 所在主机可解析）。
  // agentId 只用于寻址，转发时不进入远程请求体。
  entry._hostKey = _imageHostKey(targetAgentId);
  entry.path = null;
  entry._uploadPromise = fetch('/protoclaw/images/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      base64: entry._base64,
      mediaType: entry.mediaType,
      source: entry.source,
      agentId: targetAgentId || '',
    }),
  }).then(function(res) {
    if (!res.ok) throw new Error('Upload failed: ' + res.status);
    return res.json();
  }).then(function(data) {
    entry.path = data.path;
    entry.mediaType = data.mediaType || entry.mediaType;
    entry._previewUrl = data.url;
    return entry;
  });
  return entry._uploadPromise;
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
  // 引用 pill（session-reference-picker 模块局部状态）与图片缩略图同区渲染
  const refChipsHtml = (typeof window.SessionReference?.chipsHtml === 'function')
    ? window.SessionReference.chipsHtml()
    : '';
  const pendingImages = _imageBucket();
  if (pendingImages.length === 0 && refChipsHtml === '') {
    previews.forEach(function(preview) {
      preview.style.display = 'none';
      preview.innerHTML = '';
    });
    cards.forEach(function(card) { card.classList.remove('has-attachments'); });
    return;
  }
  const html = pendingImages.map(function(img, idx) {
    return '<div class="attachment-thumb">' +
      '<img src="' + img._previewUrl + '" alt="' + escapeHtml(img.source || '') + '">' +
      '<button class="attachment-remove" type="button" onclick="removePendingImage(' + idx + ')" title="' +
        (currentLanguage === 'zh' ? '移除' : 'Remove') + '">×</button>' +
      '</div>';
  }).join('') + refChipsHtml;
  previews.forEach(function(preview) {
    preview.style.display = 'flex';
    preview.innerHTML = html;
  });
  cards.forEach(function(card) { card.classList.add('has-attachments'); });
}

/**
 * 发送前的附件就绪解析：等待后台上传收尾，并把宿主与发送目标不一致（或
 * 上传尚未成功）的附件转存到目标主机（同一连接内会话切换零成本复用）。
 * 返回可直接随消息发送的 images；failedCount > 0 时调用方必须显式中止——
 * 附件绝不静默丢弃。
 */
async function _resolvePendingImagesForTarget(targetAgentId, bucketKey = _imageBucketKey()) {
  let failedCount = 0;
  const images = [];
  const targetHostKey = _imageHostKey(targetAgentId);
  // 只消费发送时刻捕获的会话桶：await 期间切换会话后，新会话挂载的图片
  // 绝不混入本次发送。桶数组身份不变（remove 用 splice / clear 用 delete），
  // 成员校验对捕获引用始终有效。
  const bucket = _pendingImageBuckets.get(bucketKey) || [];
  // await 期间用户可能移除附件（splice 移动索引）：快照迭代 + push 前
  // 成员校验，已移除者既不发送也不计入失败。
  const snapshot = bucket.slice();
  for (const entry of snapshot) {
    try {
      if (!bucket.includes(entry)) {
        continue; // await 期间被用户移除：不转存、不随消息发送
      }
      // 先收尾挂起的后台上传（失败则按目标重新上传拿结论），再做宿主一致性转存
      if (!entry.path && entry._uploadPromise) {
        await entry._uploadPromise.catch(function() { /* 视为未成功，下方重传 */ });
      }
      if (!bucket.includes(entry)) {
        continue; // await 期间被移除：不发送、不算失败
      }
      if (!entry.path || entry._hostKey !== targetHostKey) {
        await _uploadImageEntryTo(entry, targetAgentId);
      }
      if (!bucket.includes(entry)) {
        continue; // 转存 await 期间被移除：已转存副本留在远端无副作用，但不随消息发送
      }
      images.push({ path: entry.path, mediaType: entry.mediaType, source: entry.source });
    } catch (err) {
      if (!bucket.includes(entry)) {
        continue; // 转存失败与移除同窗口：用户已移除的附件不算失败，剩余附件照常发送
      }
      console.error('[Image Attach] upload for target failed:', err);
      failedCount += 1;
    }
  }
  return { images, failedCount };
}

/**
 * 清空指定会话的图片桶（缺省当前会话）。发送成功后按发送时刻捕获的 key
 * 清空，不误伤其他会话挂着的附件；渲染面读当前会话桶，重渲染幂等。
 */
function clearPendingInputImages(bucketKey) {
  const key = typeof bucketKey === 'string' ? bucketKey : _imageBucketKey();
  _pendingImageBuckets.delete(key);
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
  _imageBucket().splice(idx, 1);
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

function onPersistentBtnClick(submit) {
  const btn = document.getElementById('persistent-action-btn');
  if (!btn) return;
  if (_submitInFlight) return;         // fetch 进行中：阻止连点（防误触暂停）
  if (btn.classList.contains('is-interrupting')) return;
  // 输入框有内容时，按钮的语义是发送，即使 runtime 正在处理上一轮；
  // user-turn 会由 ViewerWorker 排队。仅空输入时才把 stop 状态解释为中断。
  // 这也避免轮询状态滞后把一个已空闲 runtime 永久卡在 stop 按钮上。
  const textarea = btn.closest('.user-input-card')?.querySelector('.user-input-textarea');
  const hasText = !!textarea?.value?.trim();
  const hasImages = _imageBucket().length > 0;
  const hasSessionReferences = (window.SessionReference?.peek?.() || []).length > 0;
  if (btn.classList.contains('is-stop') && !hasText && !hasImages && !hasSessionReferences) {
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
  return typeof submit === 'function' ? submit() : submitQueuedInput();
}

function _setActionBtnStop() {
  if (_submitInFlight || _sendingHoldTimer) return; // 提交/保持窗口内维持 sending 态，轮询同步不得覆盖
  const btn = document.getElementById('persistent-action-btn');
  if (!btn) return;
  btn.classList.remove('is-interrupting', 'is-sending');
  btn.classList.add('is-stop');
  btn.removeAttribute('aria-busy');
  btn.title = currentLanguage === 'zh' ? '停止当前任务' : 'Stop current task';
  const iconSend = btn.querySelector('.icon-send');
  const iconStop = btn.querySelector('.icon-stop');
  if (iconSend) iconSend.style.display = 'none';
  if (iconStop) iconStop.style.display = '';
}

function _setActionBtnInterrupting() {
  if (_submitInFlight || _sendingHoldTimer) return;
  const btn = document.getElementById('persistent-action-btn');
  if (!btn) return;
  btn.classList.remove('is-sending');
  btn.classList.add('is-stop', 'is-interrupting');
  btn.setAttribute('aria-busy', 'true');
  btn.title = currentLanguage === 'zh' ? '正在停止当前任务…' : 'Stopping current task…';
  const iconSend = btn.querySelector('.icon-send');
  const iconStop = btn.querySelector('.icon-stop');
  if (iconSend) iconSend.style.display = 'none';
  if (iconStop) iconStop.style.display = '';
}

function _setActionBtnSend() {
  if (_submitInFlight || _sendingHoldTimer) return;
  const btn = document.getElementById('persistent-action-btn');
  if (!btn) return;
  btn.classList.remove('is-stop', 'is-interrupting', 'is-sending');
  btn.removeAttribute('aria-busy');
  btn.title = currentLanguage === 'zh' ? '发送' : 'Send';
  const iconSend = btn.querySelector('.icon-send');
  const iconStop = btn.querySelector('.icon-stop');
  if (iconSend) iconSend.style.display = '';
  if (iconStop) iconStop.style.display = 'none';
}

// 发送进行中（点击/Enter → 投递落定）：两种 composer 端点共用 spinner，
// 覆盖图片转存 + fetch 的整个提交窗口；恢复后重新读取运行态。
function _setActionBtnSending() {
  const btn = document.getElementById('persistent-action-btn');
  if (!btn) return;
  btn.classList.remove('is-stop', 'is-interrupting');
  btn.classList.add('is-sending');
  btn.setAttribute('aria-busy', 'true');
  btn.title = currentLanguage === 'zh' ? '发送中…' : 'Sending…';
  const iconSend = btn.querySelector('.icon-send');
  const iconStop = btn.querySelector('.icon-stop');
  if (iconSend) iconSend.style.display = 'none';
  if (iconStop) iconStop.style.display = 'none';
}

// 提交窗口结束后，两种输入端点都恢复到当前运行态，而非固定恢复发送。
function _restoreActionBtnAfterSubmit() {
  _syncPersistentActionButton();
}

// ── 发送反馈窗口（persistent 与 requests 两端点共用）──────────────────
//
// 间歇性"点了没转圈、消息直接蹦出去"的根因是渲染时机：spinner 类设置后、
// 浏览器绘制前，本地直投的 fetch 可能已落定并移除类（或点击后主线程被
// 轮询渲染短暂阻塞挤掉了 paint 机会）——spinner 从未被画出来。双保险：
//   1. paint 门槛：设置 spinner 后等双 rAF 再发请求，保证至少绘制一次；
//      此后即使主线程阻塞，transform 旋转由 compositor 驱动继续转动。
//   2. 最短可见保持：fetch 快于阈值时恢复延迟到阈值，反馈不被一闪带过。

const _SENDING_MIN_VISIBLE_MS = 300;

function _nextPaint() {
  return new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });
}

function _beginSubmitFeedbackWindow() {
  if (_sendingHoldTimer) {
    clearTimeout(_sendingHoldTimer);
    _sendingHoldTimer = null;
  }
  _sendingStartedAt = Date.now();
  _setActionBtnSending();
}

function _endSubmitFeedbackWindow() {
  const remain = _SENDING_MIN_VISIBLE_MS - (Date.now() - _sendingStartedAt);
  if (remain > 0) {
    _sendingHoldTimer = setTimeout(() => {
      _sendingHoldTimer = null;
      // hold 到期前新提交已开启新窗口（其 begin 会清掉本 timer），此处
      // 只在窗口确已空闲时恢复
      if (!_submitInFlight) _restoreActionBtnAfterSubmit();
    }, remain);
  } else {
    _restoreActionBtnAfterSubmit();
  }
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
  // 交互面（选择卡/回退对话框）占用输入面期间，暂存/排队气泡不能出现在
  // 交互卡上方。updateQueueIndicator() 可能与交互面状态变更交错调用，因此
  // 这里也要做最后一道 DOM 侧守卫，而不能只依赖 input-render 的互斥清理。
  if (_interactiveSurfaceOccupiesInput()) {
    container.querySelectorAll('.queue-bubbles-stack').forEach(el => el.remove());
    _lastQueueBubbleSignature = '';
    return;
  }

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
    event.preventDefault();
    if (_voiceTranscribing) {
      _voicePendingSend = true;
      return;
    }
    if (_voiceRecording) {
      _voicePendingSend = true;
      stopVoiceRecording();
      return;
    }
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
  const sessionReferenceCount = (window.SessionReference?.peek?.() || []).length;
  if (!text && _imageBucket().length === 0 && sessionReferenceCount === 0) return;
  const targetRuntimeId = currentRuntimeAgentId;
  const viewToken = captureSessionViewToken(targetRuntimeId);
  const echoFromIndex = currentMessages.length;
  // 一致性校验后的线程输入目标（getActiveThreadInputTarget）：全局指向与
  // 当前视图不符（用户已切走、残留未清）时为 null——消息走当前视图常规
  // 路径，绝不串到别的线程（会话绝对隔离）。
  const activeConversation = window.getActiveThreadInputTarget?.();
  const targetCacheKey = textarea.dataset.sessionKey || _getSessionInputCacheKey();
  // 图片桶 key 同步捕获（与 targetCacheKey 同款防漂移语义）：await 期间切换
  // 会话后，resolve / 成功清空只作用于发起会话的桶。
  const targetImageKey = _imageBucketKey();

  _submitInFlight = true;
  // 乐观 UI：立即进入 sending 态（spinner），覆盖点击 → user-turn 落定的
  // 整个提交窗口（含图片转存等待）。_submitInFlight 守卫确保此期间点击与
  // 轮询同步都不会把按钮切走或触发 interruptAgent。
  _beginSubmitFeedbackWindow();

  let capabilityActivations = null;
  // 会话引用快照：try 外声明（catch 归还路径可见；try 内 const 会让 catch
  // 拿到 ReferenceError 而不是空数组——B1 审查修复）
  let sessionRefs = [];
  try {
    // paint 门槛：spinner 画出来之后再发请求，杜绝"类设置了但从未绘制"
    // 导致点击无反馈、消息直接蹦出的间歇性空窗
    await _nextPaint();
    // 图片就绪：等待后台上传，并把宿主与发送目标不一致的附件转存过去。
    // 任何附件失败都显式中止（输入与预览保留，供用户重试），绝不静默丢弃。
    const resolved = await _resolvePendingImagesForTarget(targetRuntimeId, targetImageKey);
    if (resolved.failedCount > 0) {
      throw new Error(currentLanguage === 'zh'
        ? '部分图片上传失败：请重试或移除失败的附件'
        : 'Some image uploads failed: retry or remove the failed attachments');
    }
    const images = resolved.images;
    // 准备阶段尚未投递；导航后保留原草稿，不读取新会话的线程或附件。
    if (!isSessionViewTokenCurrent(viewToken)) {
      window.ClawToast?.show?.({
        id: `input-navigation-${targetRuntimeId}`,
        status: 'info',
        title: currentLanguage === 'zh' ? '会话已切换，消息尚未发送' : 'Session changed; message not sent',
        description: currentLanguage === 'zh' ? '草稿已保留，切回原会话后可重试。' : 'Your draft is preserved. Return to the original session to retry.',
      });
      return;
    }

    if (activeConversation?.threadId && typeof window.submitThreadInput === 'function') {
      sessionRefs = window.SessionReference?.consume?.() || [];
      capabilityActivations = window.ClawSlash?.consumeActivations?.() || null;
      const result = await window.submitThreadInput(activeConversation.threadId, {
        text: text || ' ',
        images,
        source: 'chat-composer',
        ...(capabilityActivations?.length ? { capabilityActivations } : {}),
        ...(sessionRefs.length ? { metadata: { 'session-reference': sessionRefs } } : {}),
      });
      const liveTextarea = document.getElementById('input-persistent')
        || document.querySelector('.user-input-textarea:not([disabled])');
      if (liveTextarea && (liveTextarea.dataset?.sessionKey || _getSessionInputCacheKey()) === targetCacheKey) {
        liveTextarea.value = '';
        autoResize(liveTextarea);
      }
      clearPendingInputImages(targetImageKey);
      if (targetCacheKey) delete _sessionInputCache[targetCacheKey];
      _clearRecapForNewMessage();
      window.refreshThreads?.(true);
      updateQueueIndicator();
      // 线程寻址端点只回答两件事：输入是否被接住（HTTP 成功 = 是），以及
      // 本次投递尝试是否当场送达（deliveryAttempt.delivered）。交接挡板 /
      // head runtime 未就绪时 delivered=0 是正常状态——指令已在 Thread Inbox，
      // 由 runtime-ready / head 推进触发点补投。
      //
      // 因此：送达 = 安静成功（不弹常驻提示）；未送达 = 提示「已暂存」。
      // 正常对话的成功发送不弹 toast。
      const delivered = Number(result?.deliveryAttempt?.delivered) > 0;
      if (delivered) {
        // 与直投成功路径同构：清打断抑制、标记 call 已开始（发送按钮转停止）、
        // 跟随最新。线程域投递经 bridge 转 viewer user-turn，无法区分 viewer
        // 直投与忙时排队，故不做乐观回显（避免与排队气泡重复），消息由
        // 立即轮询 / SSE 回流。
        if (targetRuntimeId) {
          clearInterruptSuppression(targetRuntimeId);
          _markAgentCallStartedForNotify(targetRuntimeId);
          _agentCallActive.set(targetRuntimeId, true);
          _syncPersistentActionButton();
          renderAgentList();
        }
        if (isSessionViewTokenCurrent(viewToken)) {
          if (typeof beginFollowLatestEntryWindow === 'function') beginFollowLatestEntryWindow();
          if (typeof requestFollowLatest === 'function') {
            requestFollowLatest({ forceEnable: true, behavior: 'auto' });
          }
          window.ClawFW?.requestImmediatePoll?.();
        }
      } else {
        window.ClawToast?.show?.({
          id: `thread-staged-input-${activeConversation.threadId}`,
          status: 'info',
          title: currentLanguage === 'zh'
            ? '已暂存 · 新会话就绪后自动继续'
            : 'Staged · will continue in the successor session',
          autoDismiss: 5000,
        });
      }
      return;
    }

    capabilityActivations = window.ClawSlash?.consumeActivations?.() || null;
    // 会话引用随消息流动（一次性附件语义）：consume 取走 pill，失败时归还。
    // agent calling 中排队输入由 react-loop call 内注入消费，metadata 经
    // dispatchTurnMetadata 派发（reminder 随注入点落位），无需前端拦截。
    sessionRefs = window.SessionReference?.consume?.() || [];
    const turnMetadata = sessionRefs.length > 0
      ? { 'session-reference': sessionRefs }
      : null;
    const res = await fetch(`/api/agents/${targetRuntimeId}/user-turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-idempotency-key': newIdempotencyKey() },
      body: JSON.stringify({
        text: text || ' ',
        images: images.length > 0 ? images : undefined,
        source: 'chat-composer',
        ...(capabilityActivations?.length ? { capabilityActivations } : {}),
        ...(turnMetadata ? { metadata: turnMetadata } : {}),
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
      clearPendingInputImages(targetImageKey);
      if (targetCacheKey) delete _sessionInputCache[targetCacheKey];
      const stillOwnsView = isSessionViewTokenCurrent(viewToken);
      if (stillOwnsView) {
        _clearRecapForNewMessage();
        beginFollowLatestEntryWindow();
        requestFollowLatest({ forceEnable: true, behavior: 'auto' });
      }
      // 只有当 agent 正在 calling 时才显示排队气泡。
      // agent 空闲时后端会立即消费输入，不需要排队指示。
      if (delivery.delivery === 'thread_queued') {
        // 网关域判定（R6）：线程 head 的输入一律先入 Thread Inbox 再做
        // 即时投递尝试。deliveryAttempt.delivered > 0 表示已当场送达
        // 运行中的 head 会话，反馈对齐直投成功路径；仅真滞留（交接挡板
        // / hold / runtime 未就绪）才提示已暂存。刷新线程数据以同步
        // pendingTexts（真滞留时渲染暂存气泡）。
        window.refreshThreads?.(true);
        updateQueueIndicator();
        if (Number(delivery.deliveryAttempt?.delivered) > 0) {
          if (targetRuntimeId) {
            clearInterruptSuppression(targetRuntimeId);
            _markAgentCallStartedForNotify(targetRuntimeId);
            _agentCallActive.set(targetRuntimeId, true);
            _syncPersistentActionButton();
            renderAgentList();
          }
        } else {
          window.ClawToast?.show?.({
            id: `thread-staged-gw-${targetRuntimeId}`,
            status: 'info',
            title: currentLanguage === 'zh' ? '已暂存 · 新会话就绪后自动继续' : 'Staged · will continue in the successor session',
            autoDismiss: 5000,
          });
        }
      } else if (delivery.delivery === 'queued') {
        // SSE 乱序防护（F5）：事件帧先到时快照已含该排队项，POST 响应后到
        // 不再乐观 push，避免气泡瞬时重复（约 1s 才能对账消除）
        const queueClient = window.ClawFW?.SseClient;
        const queueText = text || (images.length ? '🖼' : '') || ' ';
        const shouldProject = !delivery.id || !queueClient?.noteQueuedOptimistic
          || queueClient.noteQueuedOptimistic(delivery.id, queueText, targetRuntimeId);
        if (shouldProject && stillOwnsView) {
          // 乐观气泡只写入提交目标的投影：await 期间用户可能已切走，新会话
          // 的输入面不冒出本会话的排队文本（服务端队列与 SSE 乐观锚点仍
          // 完整记录，切回时经快照恢复）。
          _localQueuedInputPending = true;
          _pendingQueuedCount++;
          _queuedTexts.push(text || (images && images.length ? '🖼' : '') || ' ');
        }
        updateQueueIndicator();
      } else if (targetRuntimeId) {
        // 空闲直投（lease / 即时消费）：乐观回显先上屏，真实消息经
        // poll 回流后由对账无缝替换；排队路径走上方气泡，不回显。
        // 引用 chips 只随乐观气泡呈现（服务端消息不持久化引用字段，
        // 引用的持久化产物是随后出现的 session-reference reminder）
        if (stillOwnsView) {
          window.ClawFW?.pushOptimisticUserEcho?.({ text, images, sessionReferences: sessionRefs, fromIndex: echoFromIndex });
        }
        clearInterruptSuppression(targetRuntimeId);
        _markAgentCallStartedForNotify(targetRuntimeId);
        _agentCallActive.set(targetRuntimeId, true);
        _syncPersistentActionButton();
        renderAgentList();
      }
      // 排队乐观态/提交完成后的模式可能翻转（工单 037）：声明变更即可，
      // 渲染器按签名差异决定是否重建。
      notifyInputSurfaceChanged(currentInputRequests || []);
      // 削掉 0–300ms 轮询相位：立即取一轮状态/消息（in-flight 自守卫）
      window.ClawFW?.requestImmediatePoll?.();
    } else {
      const error = await res.json().catch(() => ({}));
      throw new Error(error.error || `HTTP ${res.status}`);
    }
  } catch (e) {
    console.error('排队输入提交失败:', e);
    // 消息未发出：归还激活 refs 与会话引用，输入框重试发送时仍携带
    if (capabilityActivations?.length) {
      window.ClawSlash?.restoreActivations?.(capabilityActivations);
    }
    if (sessionRefs?.length) {
      window.SessionReference?.restore?.(sessionRefs);
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
    _endSubmitFeedbackWindow();
  }
}

function updateQueueIndicator() {
  // 渲染入口守卫：投影先与当前查看的 runtime 对齐（幂等重绑），旧会话
  // 残留的排队文本不得渲染进新会话的输入面。
  rebindQueueProjectionForRuntime(currentRuntimeAgentId);
  const container = document.getElementById('user-input-container');
  if (container) _renderQueueBubbles(container);
}

/**
 * 排队气泡投影的会话重绑（幂等）：runtime 变化时旧投影立即失效。新会话
 * 的队列优先从 SSE 快照缓存恢复（_lastQueuedSnapshots 本就按 runtime
 * 缓存非焦点期间的队列变化）；缓存缺席时置空，由轮询 / SSE 事件在下个
 * 周期补齐。
 */
function rebindQueueProjectionForRuntime(runtimeId) {
  const next = String(runtimeId || '').trim();
  if (String(_queuedProjectionRuntimeId || '').trim() === next) return;
  _queuedProjectionRuntimeId = next || null;
  _queuedTexts = [];
  _pendingQueuedCount = 0;
  _localQueuedInputPending = false;
  if (_queuedProjectionRuntimeId) {
    const cached = window.ClawFW?.SseClient?.getLastQueuedSnapshot?.(_queuedProjectionRuntimeId);
    if (cached && Array.isArray(cached.items)) {
      const texts = window.ClawFW?.SseClient?.reconcileQueuedTexts?.(
        cached.items, Date.now(), _queuedProjectionRuntimeId) || [];
      _queuedTexts = texts.slice();
      _pendingQueuedCount = cached.items.filter((item) => item?.kind !== 'reminder').length;
    }
  }
  _lastQueueBubbleSignature = '';
}

/**
 * 队列快照的同步消费（轮询路径与 SSE 事件路径共用）：更新 _queuedTexts /
 * _pendingQueuedCount / 队列气泡 / 输入面声明。texts 已由调用方完成乐观
 * 对账（SSE 路径经 SseClient.reconcileQueuedTexts）。
 */
function applyQueuedInputsTexts(runtimeId, texts, snapshotCount) {
  // 写入口归属守卫：投影只承载当前查看的 runtime；轮询 / SSE 异步竞态下
  // 过期快照的写入直接丢弃，不污染新会话的排队气泡。
  if (String(runtimeId || '').trim() !== String(currentRuntimeAgentId || '').trim()) return;
  _queuedProjectionRuntimeId = String(runtimeId || '').trim() || null;
  _queuedTexts = Array.isArray(texts) ? texts.slice() : [];
  _pendingQueuedCount = Number.isFinite(snapshotCount) ? snapshotCount : _queuedTexts.length;
  if (_queuedTexts.length === 0 && !isRuntimeCalling(runtimeId)) {
    _localQueuedInputPending = false;
  }
  updateQueueIndicator();
  notifyInputSurfaceChanged(currentInputRequests || []);
}

async function _syncPersistentInputUi(runtimeId = currentRuntimeAgentId) {
  if (_persistentUiSyncInFlight) return;
  _persistentUiSyncInFlight = true;
  // Always update model switcher regardless of queue/runtime state
  updateInputModelSwitcher();
  updateThinkingEffortSwitcher();
  const viewToken = captureSessionViewToken(runtimeId);
  const queueClient = window.ClawFW?.SseClient;
  const snapshotBeforeFetch = queueClient?.getLastQueuedSnapshot?.(runtimeId);
  try {
    if (!runtimeId) {
      _queuedTexts = [];
      _pendingQueuedCount = 0;
      _queuedProjectionRuntimeId = null;
      updateQueueIndicator();
      _syncPersistentActionButton();
      return;
    }

    const expectedRuntimeId = runtimeId;
    _syncPersistentActionButton();

    // SSE 激活时优先消费事件通道缓存的最新快照（零请求）；缓存缺席
    // （首载/事件未达）时回退 fetch 一次补齐，等事件接管
    if (typeof isSseActive === 'function' && isSseActive()) {
      const cached = window.ClawFW?.SseClient?.getLastQueuedSnapshot?.(expectedRuntimeId);
      if (cached && Array.isArray(cached.items)) {
        const texts = window.ClawFW?.SseClient?.reconcileQueuedTexts?.(cached.items, Date.now(), expectedRuntimeId) || [];
        // 待发送气泡/计数只认用户输入：reminder（机器通报）同队存放但不展示
        applyQueuedInputsTexts(expectedRuntimeId, texts, cached.items.filter((item) => item?.kind !== 'reminder').length);
        return;
      }
    }

    const res = await fetch(`/api/agents/${expectedRuntimeId}/queued-inputs`);
    if (!res.ok || expectedRuntimeId !== currentRuntimeAgentId) return;
    const data = await res.json();
    if (!isSessionViewTokenCurrent(viewToken)) return;
    // 请求期间 SSE 已带来更新的观察，HTTP 快照不再拥有队列写入权。
    if (queueClient?.getLastQueuedSnapshot?.(expectedRuntimeId) !== snapshotBeforeFetch) return;
    const queue = Array.isArray(data) ? data : (Array.isArray(data.inputs) ? data.inputs : []);
    // 同上：reminder（机器通报）不进待发送气泡与待发送计数
    const userQueue = queue.filter((item) => item?.kind !== 'reminder');
    const viewerQueueTexts = userQueue
      .map((item) => {
        const t = typeof item?.text === 'string' ? item.text.trim() : '';
        if (t) return t;
        const imgCount = Array.isArray(item?.images) ? item.images.length : 0;
        return imgCount > 0 ? '🖼' : '';
      })
      .filter(Boolean);

    // 即使文本相同也消费权威计数与排空事实；DOM 去重由渲染器负责。
    queueClient?.reconcileQueuedTexts?.(queue, Date.now(), expectedRuntimeId);
    applyQueuedInputsTexts(expectedRuntimeId, viewerQueueTexts, userQueue.length);
  } catch (e) {
    // ignore transient queue sync failures
  } finally {
    _persistentUiSyncInFlight = false;
  }
}

// 返回 { ok } 供编排方（如运行期回退 rollback-dialog.js）判断结果：
//   { ok: true }                    — 打断请求已被服务端接受
//   { ok: false, reason }           — 未发出或失败（'no-runtime' / 'suppressed'
//                                     / 'request-failed'，失败原因已自行 toast）
async function interruptAgent() {
  if (!currentRuntimeAgentId) return { ok: false, reason: 'no-runtime' };
  const targetRuntimeId = currentRuntimeAgentId;
  if (isInterruptSuppressed(targetRuntimeId)) return { ok: false, reason: 'suppressed' };
  const wasCalling = isRuntimeCalling(targetRuntimeId);

  // 立即进入粘性的 interrupting 状态；中间阶段仍然是“正在停止”，绝不伪装成
  // idle。后续同一 call 的 callActive:true 只是排空中的旧状态，不能恢复按钮。
  markInterruptPending(targetRuntimeId, getNotificationCallStartedAt(lastNotificationStatusPayload));
  _agentCallActive.delete(targetRuntimeId);
  _localQueuedInputPending = false;
  _pendingQueuedCount = 0;
  _queuedTexts = [];
  _queuedProjectionRuntimeId = String(targetRuntimeId || '').trim() || null;
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
    return { ok: true };
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
    return { ok: false, reason: 'request-failed', error: e };
  }
}

// ── 启动上次对话结束时间计时器 ───

_callFinishTimerInterval = setInterval(_renderLastCallElapsed, 1000);
