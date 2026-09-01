/**
 * voice-input.js — 语音输入 / ASR
 * 从 app-main.js 拆出（Phase A-1）
 * 拆出日期：2026-07-03
 *
 * 依赖全局状态（定义在 app-core.js）:
 *   currentRuntimeAgentId, currentLanguage
 * 依赖全局函数:
 *   _getSessionInputCacheKey (app-main.js)
 *   autoResize (app-main.js)
 *   submitQueuedInput (app-main.js)
 *   submitInput (app-main.js)
 *   getRuntimeContextKey (app-core.js)
 *   _cacheSessionInput / _restoreSessionInputDraft / _storeSessionInputDraft /
 *   _storeVisibleSessionInputDraft, _sessionInputCache (input-composer.js, 工单 036)
 * 导出全局函数:
 *   toggleVoiceRecording, startVoiceRecording, stopVoiceRecording,
 *   _cancelVoiceRecording, _playVoiceSound, _updateVoiceUI,
 *   sendAudioToASR, insertTextAtCursor, _injectPendingVoiceResult
 * 导出全局变量:
 *   _voiceRecording, _voiceStopping, _voiceTranscribing, _voiceMediaRecorder, _voiceAudioChunks,
 *   _voiceTargetBtn, _voiceTargetId, _voiceCancelled, _voicePendingSend, _voiceAgentId,
 *   _voiceCacheKey, _pendingVoiceResults
 * HTML onclick 引用:
 *   onclick="toggleVoiceRecording(...)"
 *   oninput="_cacheSessionInput(this)"
 */

// ── Voice Input / ASR ──────────────────────────────────────────────────────

let _voiceRecording = false;
let _voiceStopping = false;
let _voiceTranscribing = false;
let _voiceMediaRecorder = null;
let _voiceAudioChunks = [];
let _voiceTargetBtn = null;
let _voiceTargetId = null;
let _voiceCancelled = false;
let _voicePendingSend = false;      // 录音期间点了发送：停止录音后，转写完成自动发送
let _voiceAgentId = null;           // 录音发起时的 runtime agent ID（用于 API 调用）
let _voiceCacheKey = null;          // 录音发起时的 session cache key（用于检测会话切换）
let _pendingVoiceResults = {};      // { agentId: text } — ASR 结果在会话切换后暂存，待切回时注入
// 会话草稿缓存（_sessionInputCache）已迁至 input-composer.js（工单 036）：
// 纯 composer 状态归还 composer 域；本模块只按原全局符号继续消费。

// ── Low-latency audio cue via Web Audio API ──────────────────────────────────
// Replaces `new Audio(url).play()` which creates a new HTMLAudioElement each
// time and goes through the browser's HTML media pipeline (fetch → decode →
// schedule). Web Audio API pre-decodes the audio into AudioBuffer objects,
// so playback via AudioBufferSourceNode.start() has near-zero scheduling
// latency — comparable to the server-side audio feedback feature which reads
// from the local filesystem via PowerShell MediaPlayer.
//
// Lifecycle:
//   1. Page load: prefetch raw ArrayBuffer for both sounds (no user gesture
//      needed for fetch).
//   2. First user gesture (toggleVoiceRecording click): create AudioContext
//      (must be within gesture for autoplay policy) and decode prefetched
//      data into AudioBuffers.
//   3. Subsequent plays: instant via AudioBufferSourceNode.
//   4. First play (buffers not yet decoded): falls back to new Audio().

let _audioCueCtx = null;
let _audioCueBuffers = {};   // { start: AudioBuffer, stop: AudioBuffer }
let _audioCueRawData = {};   // { start: ArrayBuffer, stop: ArrayBuffer } — prefetched, pre-decode

(function _prefetchAudioCueRaw() {
  for (const type of ['start', 'stop']) {
    const url = type === 'start'
      ? '/sounds/voice-recording-start.mp3'
      : '/sounds/voice-recording-stop.mp3';
    fetch(url)
      .then(function(r) { return r.arrayBuffer(); })
      .then(function(buf) { _audioCueRawData[type] = buf; })
      .catch(function() { /* prefetch is best-effort */ });
  }
})();

// Must be called within a user gesture for AudioContext creation/resume.
function _initAudioCues() {
  if (!_audioCueCtx) {
    let Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return;
    _audioCueCtx = new Ctor();
  }
  if (_audioCueCtx.state === 'suspended') {
    _audioCueCtx.resume().catch(e => console.warn(e));
  }
  // Decode any prefetched raw data (async, non-blocking)
  for (let _i = 0, _types = ['start', 'stop']; _i < _types.length; _i++) {
    (function(type) {
      if (_audioCueBuffers[type]) return;
      let raw = _audioCueRawData[type];
      if (!raw) return;
      _audioCueRawData[type] = null;
      _audioCueCtx.decodeAudioData(raw).then(function(buf) {
        _audioCueBuffers[type] = buf;
      }).catch(function() { /* decode failed, will fall back to new Audio() */ });
    })(_types[_i]);
  }
}

// Play short audio cue for voice recording start/stop.
function _playVoiceSound(type) {
  // Fast path: play pre-decoded buffer via Web Audio API (near-zero latency)
  if (_audioCueCtx && _audioCueBuffers[type]) {
    try {
      let source = _audioCueCtx.createBufferSource();
      source.buffer = _audioCueBuffers[type];
      let gain = _audioCueCtx.createGain();
      gain.gain.value = 0.6;
      source.connect(gain);
      gain.connect(_audioCueCtx.destination);
      source.start(0);
      return;
    } catch (e) { /* fall through to legacy */ }
  }
  // Fallback: legacy HTMLAudioElement (first play before buffers are decoded)
  try {
    let path = type === 'start'
      ? '/sounds/voice-recording-start.mp3'
      : '/sounds/voice-recording-stop.mp3';
    let url = window.__PROTOCLAW_APP_URL__?.(path) || path;
    let audio = new Audio(url);
    audio.volume = 0.6;
    audio.play().catch(function() { /* ignore autoplay rejection */ });
  } catch (e) { /* non-critical */ }
}

// Sync send-button disabled state and voice-button spinner to current flags.
// During recording the send button stays clickable (clicking it stops the recording
// and auto-sends after transcription). Only during transcription is it disabled.
function _updateVoiceUI() {
  const btn = _voiceTargetBtn;
  if (!btn || !btn.isConnected) return;
  const row = btn.parentElement;
  if (!row) return;
  const sendBtn = row.querySelector('.persistent-action-btn');
  if (sendBtn) sendBtn.classList.toggle('voice-disabled', _voiceTranscribing);
  btn.classList.toggle('transcribing', _voiceTranscribing);
}

function _shouldPreserveVoiceInputForRender(renderMode, cacheKey) {
  const hasOwnedVoiceOperation = _voiceRecording || _voiceStopping || _voiceTranscribing;
  // 交互面 = composer 可见且可交互的模式（含压缩状态卡：录音与压缩互不依赖，
  // 转写结果按 sessionKey 注入）；hidden/readonly/冻结（回退对话框）视为离开。
  const isInteractiveInput = renderMode === 'persistent'
    || renderMode === 'requests'
    || renderMode === 'choice'
    || renderMode === 'compacting';
  return hasOwnedVoiceOperation
    && isInteractiveInput
    && Boolean(_voiceCacheKey)
    && _voiceCacheKey === cacheKey;
}

function _reattachVoiceInputUi(root) {
  if (!root?.querySelectorAll) return false;
  const buttons = Array.from(root.querySelectorAll('.voice-input-btn'));
  if (buttons.length === 0) return false;
  const nextBtn = buttons.find((button) => button.dataset?.target === _voiceTargetId) || buttons[0];
  _voiceTargetBtn = nextBtn;
  _voiceTargetId = nextBtn.dataset?.target || _voiceTargetId;
  nextBtn.classList.toggle('recording', _voiceRecording || _voiceStopping);
  _updateVoiceUI();
  return true;
}

function _markVoiceAutoSendAccepted(runtimeId) {
  if (!runtimeId) return;
  clearInterruptSuppression(runtimeId);
  _markAgentCallStartedForNotify(runtimeId);
  _agentCallActive.set(runtimeId, true);
  _syncPersistentActionButton();
  renderAgentList();
}

async function toggleVoiceRecording(btn) {
  // Initialize AudioContext within user gesture (autoplay policy requires it).
  // Creates context synchronously; decode happens async so buffers are ready
  // for subsequent plays.
  _initAudioCues();

  if (_voiceRecording) {
    stopVoiceRecording();
  } else if (!_voiceStopping && !_voiceTranscribing) {
    await startVoiceRecording(btn);
  }
}

async function startVoiceRecording(btn) {
  const recordingAgentId = currentRuntimeAgentId;
  const recordingCacheKey = _getSessionInputCacheKey();
  const recordingTargetId = btn?.dataset?.target || '';
  // Check speech config
  let speechConfig = window.ClawFW?._speechModelConfig;
  if (!speechConfig || !speechConfig.baseUrl || !speechConfig.apiKey) {
    try {
      const resp = await fetch('/protoclaw/speech_model_config');
      const data = await resp.json();
      speechConfig = data?.speechModel;
      if (window.ClawFW) window.ClawFW._speechModelConfig = speechConfig;
    } catch (e) { /* ignore */ }
  }
  if (!speechConfig || !speechConfig.baseUrl || !speechConfig.apiKey) {
    alert(currentLanguage === 'zh' ? '语音模型未配置，请在设置中配置 ASR 模型' : 'Speech model not configured. Please configure it in Settings.');
    return;
  }

  try {
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      const isSecure = window.isSecureContext;
      const hint = currentLanguage === 'zh'
        ? (isSecure
          ? '当前浏览器不支持麦克风访问（mediaDevices API 不可用）。'
          : '麦克风功能仅在安全上下文下可用。请通过 https:// 访问，或使用 SSH 端口转发后在 localhost 上打开。')
        : (isSecure
          ? 'Microphone access is not supported in this browser (mediaDevices API unavailable).'
          : 'Microphone requires a secure context. Please use https://, or access via localhost through SSH port forwarding.');
      throw new Error(hint);
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // Permission prompts are asynchronous. If the user changed session while
    // the browser prompt was open, the old DOM button no longer owns a valid
    // recording target; release the acquired microphone immediately.
    if (_getSessionInputCacheKey() !== recordingCacheKey) {
      stream.getTracks().forEach(t => t.stop());
      return;
    }
    _voiceTargetBtn = btn;
    _voiceTargetId = recordingTargetId;
    _voiceAudioChunks = [];
    _voiceAgentId = recordingAgentId;
    _voiceCacheKey = recordingCacheKey;
    _voicePendingSend = false;
    _voiceStopping = false;
    _voiceCancelled = false;

    // Determine best supported MIME type
    const mimeTypes = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', ''];
    let selectedMime = '';
    for (const mt of mimeTypes) {
      if (!mt || MediaRecorder.isTypeSupported(mt)) {
        selectedMime = mt;
        break;
      }
    }

    const options = selectedMime ? { mimeType: selectedMime } : {};
    _voiceMediaRecorder = new MediaRecorder(stream, options);

    _voiceMediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) {
        _voiceAudioChunks.push(e.data);
      }
    };

    _voiceMediaRecorder.onstop = async () => {
      // Stop all tracks
      stream.getTracks().forEach(t => t.stop());
      btn.classList.remove('recording');
      if (_voiceTargetBtn && _voiceTargetBtn !== btn) {
        _voiceTargetBtn.classList.remove('recording');
      }
      _voiceRecording = false;
      _voiceStopping = false;
      _playVoiceSound('stop');

      if (_voiceCancelled) {
        _voiceCancelled = false;
        _voiceAudioChunks = [];
        _updateVoiceUI();
        _voiceTargetBtn = null;
        _voiceTargetId = null;
        return;
      }

      if (_voiceAudioChunks.length === 0) {
        _updateVoiceUI();
        _voiceTargetBtn = null;
        _voiceTargetId = null;
        return;
      }

      const mimeType = _voiceMediaRecorder.mimeType || 'audio/webm';
      const blob = new Blob(_voiceAudioChunks, { type: mimeType });
      _voiceAudioChunks = [];

      _voiceTranscribing = true;
      _updateVoiceUI();
      try {
        await sendAudioToASR(blob, _voiceTargetId || recordingTargetId);
      } finally {
        _voiceTranscribing = false;
        _updateVoiceUI();
      }

      // Auto-send if user pressed send while recording
      if (_voicePendingSend) {
        _voicePendingSend = false;
        const targetId = _voiceTargetId || recordingTargetId;
        if (targetId === 'input-persistent') {
          const _currentCacheKey = _getSessionInputCacheKey();
          if (_currentCacheKey === _voiceCacheKey) {
            // Same session — text already in textarea, submit normally
            submitQueuedInput();
          } else {
            // Session switched — auto-submit directly to original agent
            const originalCacheKey = _voiceCacheKey;
            const originalAgentId = _voiceAgentId;
            let fullText = _pendingVoiceResults[_voiceCacheKey] || '';
            delete _pendingVoiceResults[_voiceCacheKey];
            // Also include any cached typed text from the original session
            const cachedInput = _sessionInputCache[_voiceCacheKey] || '';
            delete _sessionInputCache[_voiceCacheKey];
            fullText = cachedInput + fullText;
            if (fullText.trim()) {
              fetch(`/api/agents/${originalAgentId}/user-turn`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: fullText, source: 'voice-input' })
              }).then(async res => {
                if (!res.ok) {
                  const error = await res.json().catch(() => ({}));
                  _restoreCrossSessionVoiceInput(originalCacheKey, fullText, originalAgentId, error.error || error.message || `HTTP ${res.status}`);
                } else {
                  _markVoiceAutoSendAccepted(originalAgentId);
                }
              }).catch(e => {
                _restoreCrossSessionVoiceInput(originalCacheKey, fullText, originalAgentId, e?.message || String(e));
              });
            }
          }
        } else if (targetId.startsWith('input-')) {
          const requestId = targetId.slice('input-'.length);
          if (_getSessionInputCacheKey() === _voiceCacheKey) {
            submitInput(requestId, _voiceAgentId || currentRuntimeAgentId);
          } else {
            // Session switched — auto-submit to original agent's input request
            const originalCacheKey = _voiceCacheKey;
            const originalAgentId = _voiceAgentId;
            let fullText = _pendingVoiceResults[_voiceCacheKey] || '';
            delete _pendingVoiceResults[_voiceCacheKey];
            const cachedInput = _sessionInputCache[_voiceCacheKey] || '';
            delete _sessionInputCache[_voiceCacheKey];
            fullText = cachedInput + fullText;
            if (fullText.trim()) {
              fetch(`/api/agents/${originalAgentId}/input`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  requestId,
                  input: fullText,
                  response: { kind: 'text', text: fullText },
                })
              }).then(async res => {
                if (!res.ok) {
                  const error = await res.json().catch(() => ({}));
                  _restoreCrossSessionVoiceInput(originalCacheKey, fullText, originalAgentId, error.error || error.message || `HTTP ${res.status}`);
                } else {
                  _markVoiceAutoSendAccepted(originalAgentId);
                }
              }).catch(e => {
                _restoreCrossSessionVoiceInput(originalCacheKey, fullText, originalAgentId, e?.message || String(e));
              });
            }
          }
        }
      }
      _voiceTargetBtn = null;
      _voiceTargetId = null;
    };

    _voiceMediaRecorder.start(1000); // collect chunks every 1s
    _voiceRecording = true;
    btn.classList.add('recording');
    _playVoiceSound('start');
    _updateVoiceUI();
  } catch (err) {
    console.error('[VoiceInput] Failed to start recording:', err);
    alert(currentLanguage === 'zh' ? '无法访问麦克风：' + err.message : 'Cannot access microphone: ' + err.message);
  }
}

function _restoreCrossSessionVoiceInput(cacheKey, text, agentId, errorMessage) {
  if (cacheKey) _sessionInputCache[cacheKey] = text;
  console.error('[VoiceInput] cross-session auto-send failed:', errorMessage);
  window.ClawToast?.show?.({
    id: `voice-send-failed-${agentId || 'unknown'}`,
    status: 'error',
    title: currentLanguage === 'zh' ? '语音消息发送失败' : 'Failed to send voice message',
    description: errorMessage,
    autoDismiss: 6000,
  });
}

function stopVoiceRecording() {
  if (_voiceMediaRecorder && _voiceMediaRecorder.state === 'recording') {
    _voiceStopping = true;
    _voiceMediaRecorder.stop();
    // Set _voiceRecording = false immediately — don't wait for the async
    // onstop event.  Otherwise renderInputRequests() (triggered by a poll
    // cycle or session switch in the gap between .stop() and onstop) would
    // still see _voiceRecording === true and call _cancelVoiceRecording(),
    // which clears _voicePendingSend and discards the auto-send intent.
    _voiceRecording = false;
    if (_voiceTargetBtn) _voiceTargetBtn.classList.remove('recording');
  }
}

function _cancelVoiceRecording() {
  _voiceCancelled = true;
  _voicePendingSend = false;
  stopVoiceRecording();
}

async function sendAudioToASR(blob, target) {
  const targetId = typeof target === 'string' ? target : target?.dataset?.target;
  const MAX_RETRIES = 2; // 3 total attempts (initial + 2 retries)

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const resp = await fetch('/protoclaw/speech_to_text', {
        method: 'POST',
        headers: { 'Content-Type': blob.type || 'audio/webm' },
        body: blob,
      });

      if (resp.ok) {
        const data = await resp.json();
        const text = data?.text || '';
        if (text) {
          const textarea = document.getElementById(targetId);
          const _currentCacheKey = _getSessionInputCacheKey();
          if (textarea && _currentCacheKey === _voiceCacheKey) {
            insertTextAtCursor(textarea, text);
            autoResize(textarea);
            _cacheSessionInput(textarea);
          } else if (_voiceCacheKey) {
            // Session switched while transcribing — store for later injection
            _pendingVoiceResults[_voiceCacheKey] = (_pendingVoiceResults[_voiceCacheKey] || '') + text;
          }
        }
        return; // success
      }

      // Non-OK response
      const errBody = await resp.json().catch(() => ({ error: 'Unknown error' }));

      // 4xx client errors (except 429) won't benefit from retry
      if (resp.status >= 400 && resp.status < 500 && resp.status !== 429) {
        console.error('[VoiceInput] ASR client error (HTTP %d), not retrying:', resp.status, errBody);
        alert(errBody.error || 'ASR request failed');
        return;
      }

      // Retryable: 5xx, 429, or other non-OK
      if (attempt < MAX_RETRIES) {
        const delay = 1000 * Math.pow(2, attempt);
        console.warn('[VoiceInput] ASR retryable error (HTTP %d), retry %d/%d in %dms',
          resp.status, attempt + 1, MAX_RETRIES, delay);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }

      console.error('[VoiceInput] ASR error after %d attempts:', MAX_RETRIES + 1, errBody);
      alert(errBody.error || 'ASR request failed');

    } catch (err) {
      // Network-level error (fetch threw)
      if (attempt < MAX_RETRIES) {
        const delay = 1000 * Math.pow(2, attempt);
        console.warn('[VoiceInput] ASR network error, retry %d/%d in %dms: %s',
          attempt + 1, MAX_RETRIES, delay, err.message);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      console.error('[VoiceInput] ASR failed after %d attempts:', MAX_RETRIES + 1, err);
      alert(currentLanguage === 'zh' ? '语音识别失败（已重试 ' + MAX_RETRIES + ' 次）：' + err.message
        : 'ASR failed (after ' + MAX_RETRIES + ' retries): ' + err.message);
    }
  }
}

function insertTextAtCursor(textarea, text) {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const value = textarea.value;
  textarea.value = value.slice(0, start) + text + value.slice(end);
  const newPos = start + text.length;
  textarea.setSelectionRange(newPos, newPos);
}

// 会话草稿缓存四个函数（_cacheSessionInput / _restoreSessionInputDraft /
// _storeSessionInputDraft / _storeVisibleSessionInputDraft）已迁至
// input-composer.js（工单 036）。普通脚本共享全局词法作用域，本模块
// onstop 自动发送等路径对 _sessionInputCache 的既有引用按原全局符号
// 继续解析到 composer 模块绑定，零行为变化。

// Inject pending voice ASR result for the current session into whichever textarea is visible
function _injectPendingVoiceResult() {
  const key = _getSessionInputCacheKey();
  if (!key) return;
  const text = _pendingVoiceResults[key];
  if (!text) return;
  delete _pendingVoiceResults[key];
  const textarea = document.getElementById('input-persistent')
    || document.querySelector('.user-input-textarea[id^="input-"]');
  if (textarea) {
    insertTextAtCursor(textarea, text);
    autoResize(textarea);
    _cacheSessionInput(textarea);
    textarea.focus();
  }
}
