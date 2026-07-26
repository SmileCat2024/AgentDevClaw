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
 *   markInterruptPending, isInterruptSuppressed (app-core.js / app-main.js)
 * - isRuntimeCalling (runtime-status.js)
 * - renderAgentList, renderInputRequests, getInputSurfaceMode (app-main.js)
 * - isChatSurfaceActive, shouldRenderWorkspaceSurface (app-ui.js)
 * - autoResize (input-helpers.js)
 * - _voiceRecording, _voiceStopping, _voiceTranscribing, _voicePendingSend, stopVoiceRecording,
 *   _getSessionInputCacheKey, _restoreSessionInputDraft, _sessionInputCache,
 *   _cacheSessionInput, toggleVoiceRecording (voice-input.js)
 * - _clearRecapForNewMessage (recap-hint.js)
 * - _requestNotifyPermission (desktop-notify.js)
 * - beginFollowLatestEntryWindow, requestFollowLatest (chat-viewport.js)
 * - _lastRenderedNotificationRuntime (runtime-status.js)
 * - _cacheModelInfo, getCachedPresetName, getCachedThinkingEffort (session-ui.js)
 * - getCurrentHostAgentRecord (app-main.js)
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

// ── 输入框模型切换下拉 ──────────────────────────────────────────────

let _inputModelDropdown = null;

function _getInputAgentId() {
  // Model swap is keyed on the HOST agent ID (e.g. 'programming-helper'),
  // not the ViewerWorker child UUID. The config file
  // (.agentdev/agent-configs/{agentId}.json) and IPC delivery
  // (sendIPCToAllSessions → listAgentRuntimes) both use the host ID.
  // currentAgentId is set to the host ID by switchAgent().
  if (typeof currentAgentId !== 'undefined' && currentAgentId) return currentAgentId;
  // Fallback: resolve via host record
  if (typeof getCurrentHostAgentRecord === 'function') {
    let host = getCurrentHostAgentRecord();
    if (host && host.id) return host.id;
  }
  if (typeof getCurrentAgentRecord === 'function') {
    let agent = getCurrentAgentRecord();
    if (agent && agent.id) return agent.id;
  }
  return null;
}

function _getInputDefaultPresetName() {
  // Priority 1: overview.presetName — the runtime LLM instance's actual preset.
  // This is the same per-session data source as the context bar's modelName.
  // It's set by agent.setLLM() and pushed via overview poll, so it's always
  // correct for the current session and immune to loadAgents replacement gaps.
  if (typeof currentOverviewSnapshot !== 'undefined' && currentOverviewSnapshot) {
    let pn = currentOverviewSnapshot.presetName;
    if (pn && typeof pn === 'string') return pn;
  }

  // Priority 2: preset from agent config (startup default, before first poll)
  let agent = typeof getRuntimeAwareAgentRecord === 'function'
    ? getRuntimeAwareAgentRecord()
    : null;
  if (!agent) return '';
  let modelPresets = agent.modelPresets || {};
  let defaultCfg = modelPresets.default || {};
  if (typeof defaultCfg === 'string') return defaultCfg;
  return (defaultCfg && defaultCfg.primary) || '';
}

function _closeInputModelDropdown() {
  if (_inputModelDropdown) {
    _inputModelDropdown.classList.remove('visible');
    setTimeout(function() {
      if (_inputModelDropdown) { _inputModelDropdown.remove(); _inputModelDropdown = null; }
    }, 150);
  }
}

function _inputModelDropdownOutsideClick(e) {
  if (_inputModelDropdown && !_inputModelDropdown.contains(e.target)) {
    let btn = document.getElementById('input-model-switch-btn');
    if (!btn || !btn.contains(e.target)) {
      _closeInputModelDropdown();
    }
  } else if (_inputModelDropdown) {
    document.addEventListener('click', _inputModelDropdownOutsideClick, { once: true });
  }
}

async function _performInputModelSwap(agentId, presetName) {
  let isZh = typeof currentLanguage !== 'undefined' && currentLanguage === 'zh';
  let toastId = 'input-model-swap';

  if (typeof ClawToast !== 'undefined') {
    ClawToast.show({
      id: toastId,
      title: isZh ? '正在切换模型...' : 'Switching model...',
      status: 'loading',
      closable: false,
    });
  }

  try {
    let sessionId = typeof getActiveWorkspaceSessionId === 'function'
      ? getActiveWorkspaceSessionId()
      : '';
    let runtimeId = (typeof currentRuntimeAgentId !== 'undefined' && currentRuntimeAgentId) || '';
    const resp = await fetch('/protoclaw/swap_model', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId, presetName, sessionId: sessionId || undefined, runtimeId: runtimeId || undefined }),
    });
    const result = await resp.json();
    if (result.ok) {
      // Clear thinking effort override on model change
      let agent = typeof getRuntimeAwareAgentRecord === 'function'
        ? getRuntimeAwareAgentRecord()
        : null;
      if (agent && typeof _cacheModelInfo === 'function') {
        _cacheModelInfo(agent, null, null, null, null);
      }
      if (typeof ClawToast !== 'undefined') {
        ClawToast.update(toastId, {
          status: 'success',
          title: isZh ? '模型已切换' : 'Model switched',
          description: presetName,
          autoDismiss: 3000,
        });
      }
      // Re-fetch presets so thinking effort reads from the new preset
      try {
        const resp2 = await fetch('/protoclaw/model_config');
        const data2 = await resp2.json();
        if (window.ClawFW) window.ClawFW._modelPresets = Array.isArray(data2?.presets) ? data2.presets : [];
      } catch (_) {}
      updateInputModelSwitcher();
      updateThinkingEffortSwitcher();
      if (typeof updateChatContextBar === 'function') updateChatContextBar();
    } else {
      throw new Error(result.error || 'Unknown error');
    }
  } catch (e) {
    console.error('[InputModelSwitch] Swap failed:', e);
    if (typeof ClawToast !== 'undefined') {
      ClawToast.update(toastId, {
        status: 'error',
        title: isZh ? '切换失败' : 'Switch failed',
        description: e?.message || String(e),
        closable: true,
        autoDismiss: 8000,
      });
    }
  }
}

window.toggleInputModelDropdown = function(event) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }

  if (_inputModelDropdown) {
    _closeInputModelDropdown();
    return;
  }

  let btn = document.getElementById('input-model-switch-btn');
  if (!btn) return;

  let agentId = _getInputAgentId();
  if (!agentId) return;

  // Fetch presets synchronously from cache or API
  (async function() {
    let presets = (window.ClawFW && window.ClawFW._modelPresets) || [];
    if (!presets.length) {
      try {
        const resp = await fetch('/protoclaw/model_config');
        const data = await resp.json();
        presets = Array.isArray(data && data.presets) ? data.presets : [];
        if (window.ClawFW) window.ClawFW._modelPresets = presets;
      } catch (e) {
        console.error('[InputModelSwitch] Failed to load presets:', e);
        return;
      }
    }
    if (!presets.length) return;

    let currentPreset = _getInputDefaultPresetName();
    let isZh = typeof currentLanguage !== 'undefined' && currentLanguage === 'zh';

    _inputModelDropdown = document.createElement('div');
    _inputModelDropdown.className = 'ccb-model-dropdown';

    let html = '<div class="ccb-model-dropdown-list">';
    presets.forEach(function(p) {
      let name = p.name || p.model || '';
      let isActive = name === currentPreset;
      let visionIcon = p.vision === true
        ? '<svg class="ccb-md-vision" title="' + (isZh ? '支持视觉' : 'Vision') + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>'
        : '';
      let ctxText = p.contextLength && p.contextLength > 0
        ? Math.round(p.contextLength / 1000) + 'K'
        : '';
      html += '<div class="ccb-md-item' + (isActive ? ' active' : '') + '" data-preset="' + escapeHtml(name) + '">'
        + '<span class="ccb-md-left">'
        + '<span class="ccb-md-name">' + escapeHtml(name) + '</span>'
        + visionIcon
        + '</span>'
        + '<span class="ccb-md-right">'
        + (ctxText ? '<span class="ccb-md-ctx">' + ctxText + '</span>' : '')
        + '</span>'
        + '</div>';
    });
    html += '</div>';
    _inputModelDropdown.innerHTML = html;

    // Position relative to the button — open upward
    let rect = btn.getBoundingClientRect();
    _inputModelDropdown.style.left = rect.left + 'px';

    _inputModelDropdown.addEventListener('click', function(e) {
      let item = e.target.closest('.ccb-md-item');
      if (!item) return;
      let presetName = item.dataset.preset;
      _closeInputModelDropdown();
      _performInputModelSwap(agentId, presetName);
    });

    document.body.appendChild(_inputModelDropdown);
    // Measure height after insert, then place above the button
    let ddHeight = _inputModelDropdown.offsetHeight;
    _inputModelDropdown.style.top = (rect.top - ddHeight - 4) + 'px';
    requestAnimationFrame(function() { _inputModelDropdown.classList.add('visible'); });

    setTimeout(function() {
      document.addEventListener('click', _inputModelDropdownOutsideClick, { once: true });
    }, 0);
  })();
};

/**
 * Update the model name shown in the input-area switcher button.
 * Called on render and after model swap.
 */

function updateInputModelSwitcher() {
  let nameEl = document.querySelector('.input-model-name');
  if (!nameEl) return;
  // _getInputDefaultPresetName already checks runtime cache first,
  // then falls back to the preset. No additional cache logic needed here.
  let displayName = _getInputDefaultPresetName() || '';
  nameEl.textContent = displayName || (currentLanguage === 'zh' ? '模型' : 'Model');
}

// ── 输入框思考强度切换下拉 ──────────────────────────────────────────

const OPENAI_EFFORT_LABELS = {
  'none': 'none',
  'minimal': 'minimal',
  'low': 'low',
  'medium': 'medium',
  'high': 'high',
  'xhigh': 'xhigh',
};
const ANTHROPIC_EFFORT_LABELS = {
  'none': 'none',
  'low': 'low',
  'medium': 'medium',
  'high': 'high',
  'xhigh': 'xhigh',
  'max': 'max',
};

let _inputThinkingDropdown = null;

function _getCurrentPreset() {
  let presets = (window.ClawFW && window.ClawFW._modelPresets) || [];
  if (!presets.length) return null;
  let currentName = _getInputDefaultPresetName();
  if (!currentName) return null;
  return presets.find(function(p) { return (p.name || p.model) === currentName; }) || null;
}

function _getCurrentPresetProtocol() {
  let preset = _getCurrentPreset();
  return (preset && (preset.provider || preset.protocol)) || 'anthropic';
}

function _getEffortList(protocol) {
  return protocol === 'openai'
    ? Object.keys(OPENAI_EFFORT_LABELS)
    : Object.keys(ANTHROPIC_EFFORT_LABELS);
}

function _getEffortLabel(effort) {
  return OPENAI_EFFORT_LABELS[effort] || ANTHROPIC_EFFORT_LABELS[effort] || effort;
}

function _getCurrentThinkingEffort() {
  // Runtime override takes priority (from swap-thinking IPC)
  let agent = typeof getRuntimeAwareAgentRecord === 'function'
    ? getRuntimeAwareAgentRecord()
    : null;
  if (agent && typeof getCachedThinkingEffort === 'function') {
    let cached = getCachedThinkingEffort(agent);
    if (cached !== undefined) return cached;
  }
  // Fall back to the preset's default thinkingEffort
  let preset = _getCurrentPreset();
  return (preset && preset.thinkingEffort) || null;
}

function _currentModelSupportsThinking() {
  let preset = _getCurrentPreset();
  if (!preset) return false;
  return preset.thinkingEffort != null && preset.thinkingEffort !== '' && preset.thinkingEffort !== 'none';
}

function _closeThinkingEffortDropdown() {
  if (_inputThinkingDropdown) {
    _inputThinkingDropdown.classList.remove('visible');
    setTimeout(function() {
      if (_inputThinkingDropdown) { _inputThinkingDropdown.remove(); _inputThinkingDropdown = null; }
    }, 150);
  }
}

function _inputThinkingDropdownOutsideClick(e) {
  if (_inputThinkingDropdown && !_inputThinkingDropdown.contains(e.target)) {
    let btn = document.getElementById('input-thinking-btn');
    if (!btn || !btn.contains(e.target)) {
      _closeThinkingEffortDropdown();
    }
  } else if (_inputThinkingDropdown) {
    document.addEventListener('click', _inputThinkingDropdownOutsideClick, { once: true });
  }
}

async function _performThinkingEffortSwap(agentId, thinkingEffort) {
  let isZh = typeof currentLanguage !== 'undefined' && currentLanguage === 'zh';
  let toastId = 'input-thinking-swap';

  if (typeof ClawToast !== 'undefined') {
    ClawToast.show({
      id: toastId,
      title: isZh ? '正在切换思考强度...' : 'Switching thinking effort...',
      status: 'loading',
      closable: false,
    });
  }

  try {
    let sessionId = typeof getActiveWorkspaceSessionId === 'function'
      ? getActiveWorkspaceSessionId()
      : '';
    let runtimeId = (typeof currentRuntimeAgentId !== 'undefined' && currentRuntimeAgentId) || '';
    const resp = await fetch('/protoclaw/swap_thinking_effort', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId, thinkingEffort, sessionId: sessionId || undefined, runtimeId: runtimeId || undefined }),
    });
    const result = await resp.json();
    if (result.ok) {
      // Cache the runtime override so the switcher reflects it immediately.
      // swap_thinking_effort no longer mutates config/presets.json, so we
      // must track the override locally rather than re-fetching presets.
      let agent = typeof getRuntimeAwareAgentRecord === 'function'
        ? getRuntimeAwareAgentRecord()
        : null;
      if (agent && typeof _cacheModelInfo === 'function') {
        _cacheModelInfo(agent, null, null, null, thinkingEffort);
      }
      if (typeof ClawToast !== 'undefined') {
        ClawToast.update(toastId, {
          status: 'success',
          title: isZh ? '思考强度已切换' : 'Thinking effort switched',
          autoDismiss: 3000,
        });
      }
      updateThinkingEffortSwitcher();
    } else {
      throw new Error(result.error || 'Unknown error');
    }
  } catch (e) {
    console.error('[InputThinkingEffort] Swap failed:', e);
    if (typeof ClawToast !== 'undefined') {
      ClawToast.update(toastId, {
        status: 'error',
        title: isZh ? '切换失败' : 'Switch failed',
        description: e?.message || String(e),
        closable: true,
        autoDismiss: 8000,
      });
    }
  }
}

window.toggleThinkingEffortDropdown = function(event) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }

  if (_inputThinkingDropdown) {
    _closeThinkingEffortDropdown();
    return;
  }

  let btn = document.getElementById('input-thinking-btn');
  if (!btn) return;

  let agentId = _getInputAgentId();
  if (!agentId) return;

  // Block switching if current model doesn't support thinking
  if (!_currentModelSupportsThinking()) {
    return;
  }

  let isZh = typeof currentLanguage !== 'undefined' && currentLanguage === 'zh';
  let protocol = _getCurrentPresetProtocol();
  let efforts = _getEffortList(protocol);
  let currentEffort = _getCurrentThinkingEffort();

  _inputThinkingDropdown = document.createElement('div');
  _inputThinkingDropdown.className = 'ccb-model-dropdown';

  let html = '<div class="ccb-model-dropdown-list">';
  // "默认" option — clears the override
  html += '<div class="ccb-md-item' + (!currentEffort ? ' active' : '') + '" data-effort="">'
    + '<span class="ccb-md-left">'
    + '<span class="ccb-md-name">' + (isZh ? '默认（预设）' : 'Default (preset)') + '</span>'
    + '</span>'
    + '</div>';
  for (const effort of efforts) {
    let isActive = effort === currentEffort;
    let label = _getEffortLabel(effort);
    html += '<div class="ccb-md-item' + (isActive ? ' active' : '') + '" data-effort="' + effort + '">'
      + '<span class="ccb-md-left">'
      + '<span class="ccb-md-name">' + escapeHtml(label) + '</span>'
      + '</span>'
      + '</div>';
  }
  html += '</div>';
  _inputThinkingDropdown.innerHTML = html;

  // Position relative to the button — open upward
  let rect = btn.getBoundingClientRect();
  _inputThinkingDropdown.style.left = rect.left + 'px';

  _inputThinkingDropdown.addEventListener('click', function(e) {
    let item = e.target.closest('.ccb-md-item');
    if (!item) return;
    let effort = item.dataset.effort;
    _closeThinkingEffortDropdown();
    _performThinkingEffortSwap(agentId, effort || null);
  });

  document.body.appendChild(_inputThinkingDropdown);
  // Measure height after insert, then place above the button
  let ddHeight = _inputThinkingDropdown.offsetHeight;
  _inputThinkingDropdown.style.top = (rect.top - ddHeight - 4) + 'px';
  requestAnimationFrame(function() { _inputThinkingDropdown.classList.add('visible'); });

  setTimeout(function() {
    document.addEventListener('click', _inputThinkingDropdownOutsideClick, { once: true });
  }, 0);
};

function updateThinkingEffortSwitcher() {
  let btn = document.getElementById('input-thinking-btn');
  let nameEl = document.querySelector('.input-thinking-name');
  if (!nameEl) return;
  let isZh = typeof currentLanguage !== 'undefined' && currentLanguage === 'zh';

  // If current model doesn't support thinking, disable the button and show hint
  let supportsThinking = _currentModelSupportsThinking();
  if (btn) {
    if (supportsThinking) {
      btn.classList.remove('thinking-disabled');
      btn.title = '';
    } else {
      btn.classList.add('thinking-disabled');
      btn.title = isZh ? '当前模型不支持思考' : 'Current model does not support thinking';
    }
  }

  if (!supportsThinking) {
    nameEl.textContent = isZh ? '不支持思考' : 'No Thinking';
    nameEl.style.opacity = '0.5';
    return;
  }
  nameEl.style.opacity = '';

  let effort = _getCurrentThinkingEffort();
  nameEl.textContent = effort
    ? _getEffortLabel(effort)
    : (isZh ? '思考强度' : 'Thinking');

  // If presets aren't loaded yet, fetch them and re-render
  let presets = (window.ClawFW && window.ClawFW._modelPresets) || [];
  if (!presets.length) {
    fetch('/protoclaw/model_config').then(function(r) { return r.json(); }).then(function(d) {
      if (window.ClawFW) window.ClawFW._modelPresets = Array.isArray(d?.presets) ? d.presets : [];
      // Re-evaluate after presets are loaded
      let supports2 = _currentModelSupportsThinking();
      let btn2 = document.getElementById('input-thinking-btn');
      let el2 = document.querySelector('.input-thinking-name');
      if (el2) {
        if (!supports2) {
          if (btn2) {
            btn2.classList.add('thinking-disabled');
            btn2.title = isZh ? '当前模型不支持思考' : 'Current model does not support thinking';
          }
          el2.textContent = isZh ? '不支持思考' : 'No Thinking';
          el2.style.opacity = '0.5';
        } else {
          if (btn2) {
            btn2.classList.remove('thinking-disabled');
            btn2.title = '';
          }
          el2.style.opacity = '';
          let effort2 = _getCurrentThinkingEffort();
          el2.textContent = effort2 ? _getEffortLabel(effort2) : (isZh ? '思考强度' : 'Thinking');
        }
      }
    }).catch(function() {});
  }
}

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
    <div class="persistent-input-body">
      <div class="persistent-input-textarea-area">
        <textarea class="user-input-textarea" rows="1" id="input-persistent"${disabledAttr}\n        onkeydown="handlePersistentInputKey(event)"\n        oninput="autoResize(this); _cacheSessionInput(this)"\n        onpaste="handleInputPaste(event)"\n        placeholder="${escapeHtml(contextGuardBlocked ? disabledPlaceholder : t('input_placeholder'))}"${contextGuardBlocked ? ` aria-label="${escapeHtml(contextGuardMessage)}"` : ''}></textarea>
      </div>
      <div class="persistent-input-toolbar">
        <div class="persistent-input-toolbar-left">
          <input type="file" id="image-file-input" accept="image/*" multiple style="display:none;" onchange="onImageFilesSelected(this)"${disabledAttr}>
          <button class="persistent-icon-btn" id="attach-image-btn" onclick="document.getElementById('image-file-input').click()" title="${currentLanguage === 'zh' ? '添加图片' : 'Attach Image'}"${disabledAttr}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
          </button>
        </div>
        <div class="persistent-input-toolbar-right">
          <button class="input-model-switch-btn" id="input-model-switch-btn" onclick="toggleInputModelDropdown(event)"${disabledAttr}>
            <span class="input-model-name">${currentLanguage === 'zh' ? '模型' : 'Model'}</span>
            <svg class="input-model-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
          </button>
          <button class="input-thinking-btn" id="input-thinking-btn" onclick="toggleThinkingEffortDropdown(event)"${disabledAttr}>
            <svg class="input-thinking-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z"></path><path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z"></path></svg>
            <span class="input-thinking-name">${currentLanguage === 'zh' ? '思考强度' : 'Thinking'}</span>
            <svg class="input-thinking-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
          </button>
          <button class="voice-input-btn" data-target="input-persistent" onclick="toggleVoiceRecording(this)" title="${currentLanguage === 'zh' ? '语音输入' : 'Voice Input'}"${disabledAttr}>
            <svg class="icon-mic" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="22"></line></svg>
          </button>
          <button class="persistent-action-btn" id="persistent-action-btn" onclick="onPersistentBtnClick()"${disabledAttr}>
            <svg class="icon-send" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
            <svg class="icon-stop" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style="display:none"><rect x="4" y="4" width="16" height="16" rx="3"></rect></svg>
          </button>
        </div>
      </div>
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
  // Update model switcher button with current preset name
  updateInputModelSwitcher();
  // Update thinking effort switcher button
  updateThinkingEffortSwitcher();
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
  // Always update model switcher regardless of queue/runtime state
  updateInputModelSwitcher();
  updateThinkingEffortSwitcher();
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
      headers: { 'Content-Type': 'application/json' },
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
