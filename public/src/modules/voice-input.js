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
 * 导出全局函数:
 *   toggleVoiceRecording, startVoiceRecording, stopVoiceRecording,
 *   _cancelVoiceRecording, _playVoiceSound, _updateVoiceUI,
 *   sendAudioToASR, insertTextAtCursor,
 *   _cacheSessionInput, _restoreSessionInputDraft, _storeSessionInputDraft,
 *   _storeVisibleSessionInputDraft, _injectPendingVoiceResult
 * 导出全局变量:
 *   _voiceRecording, _voiceTranscribing, _voiceMediaRecorder, _voiceAudioChunks,
 *   _voiceTargetBtn, _voiceCancelled, _voicePendingSend, _voiceAgentId,
 *   _voiceCacheKey, _pendingVoiceResults, _sessionInputCache
 * HTML onclick 引用:
 *   onclick="toggleVoiceRecording(...)"
 *   oninput="_cacheSessionInput(this)"
 */

// ── Voice Input / ASR ──────────────────────────────────────────────────────

let _voiceRecording = false;
let _voiceTranscribing = false;
let _voiceMediaRecorder = null;
let _voiceAudioChunks = [];
let _voiceTargetBtn = null;
let _voiceCancelled = false;
let _voicePendingSend = false;      // 录音期间点了发送：停止录音后，转写完成自动发送
let _voiceAgentId = null;           // 录音发起时的 runtime agent ID（用于 API 调用）
let _voiceCacheKey = null;          // 录音发起时的 session cache key（用于检测会话切换）
let _pendingVoiceResults = {};      // { agentId: text } — ASR 结果在会话切换后暂存，待切回时注入
let _sessionInputCache = {};        // { cacheKey: text } — 每个会话 persistent 输入框内容缓存

// Play short audio cue for voice recording start/stop.
function _playVoiceSound(type) {
  try {
    const url = type === 'start'
      ? '/sounds/voice-recording-start.mp3'
      : '/sounds/voice-recording-stop.mp3';
    const audio = new Audio(url);
    audio.volume = 0.6;
    audio.play().catch(() => { /* ignore autoplay rejection */ });
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

async function toggleVoiceRecording(btn) {
  if (_voiceRecording) {
    stopVoiceRecording();
  } else if (!_voiceTranscribing) {
    await startVoiceRecording(btn);
  }
}

async function startVoiceRecording(btn) {
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
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    _voiceTargetBtn = btn;
    _voiceAudioChunks = [];
    _voiceAgentId = currentRuntimeAgentId;
    _voiceCacheKey = _getSessionInputCacheKey();
    _voicePendingSend = false;

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
      _voiceRecording = false;
      _playVoiceSound('stop');

      if (_voiceCancelled) {
        _voiceCancelled = false;
        _voiceAudioChunks = [];
        _updateVoiceUI();
        return;
      }

      if (_voiceAudioChunks.length === 0) {
        _updateVoiceUI();
        return;
      }

      const mimeType = _voiceMediaRecorder.mimeType || 'audio/webm';
      const blob = new Blob(_voiceAudioChunks, { type: mimeType });
      _voiceAudioChunks = [];

      _voiceTranscribing = true;
      _updateVoiceUI();
      try {
        await sendAudioToASR(blob, btn);
      } finally {
        _voiceTranscribing = false;
        _updateVoiceUI();
      }

      // Auto-send if user pressed send while recording
      if (_voicePendingSend) {
        _voicePendingSend = false;
        const targetId = btn.dataset.target;
        if (targetId === 'input-persistent') {
          const _currentCacheKey = _getSessionInputCacheKey();
          if (_currentCacheKey === _voiceCacheKey) {
            // Same session — text already in textarea, submit normally
            submitQueuedInput();
          } else {
            // Session switched — auto-submit directly to original agent
            let fullText = _pendingVoiceResults[_voiceCacheKey] || '';
            delete _pendingVoiceResults[_voiceCacheKey];
            // Also include any cached typed text from the original session
            const cachedInput = _sessionInputCache[_voiceCacheKey] || '';
            delete _sessionInputCache[_voiceCacheKey];
            fullText = cachedInput + fullText;
            if (fullText.trim()) {
              fetch(`/api/agents/${_voiceAgentId}/queue-input`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: fullText })
              }).then(res => {
                if (!res.ok) {
                  res.text().then(t => console.error('[VoiceInput] cross-session queue-input error body:', t));
                }
              }).catch(e => console.error('[VoiceInput] cross-session auto-send fetch failed:', e));
            }
          }
        } else if (targetId.startsWith('input-')) {
          const requestId = targetId.slice('input-'.length);
          if (_getSessionInputCacheKey() === _voiceCacheKey) {
            submitInput(requestId);
          } else {
            // Session switched — auto-submit to original agent's input request
            let fullText = _pendingVoiceResults[_voiceCacheKey] || '';
            delete _pendingVoiceResults[_voiceCacheKey];
            const cachedInput = _sessionInputCache[_voiceCacheKey] || '';
            delete _sessionInputCache[_voiceCacheKey];
            fullText = cachedInput + fullText;
            if (fullText.trim()) {
              fetch(`/api/agents/${_voiceAgentId}/input`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  requestId,
                  input: fullText,
                  response: { kind: 'text', text: fullText },
                })
              }).then(res => {
                if (!res.ok) {
                  res.text().then(t => console.error('[VoiceInput] cross-session input error:', t));
                }
              }).catch(e => console.error('[VoiceInput] cross-session input failed:', e));
            }
          }
        }
      }
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

function stopVoiceRecording() {
  if (_voiceMediaRecorder && _voiceMediaRecorder.state === 'recording') {
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

async function sendAudioToASR(blob, btn) {
  const targetId = btn.dataset.target;
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

// Real-time cache shared by persistent and request text inputs per session.
function _cacheSessionInput(textarea) {
  const key = textarea?.dataset?.sessionKey || _getSessionInputCacheKey();
  if (!key) return;
  _sessionInputCache[key] = textarea.value || '';
}

function _restoreSessionInputDraft(textarea, key = textarea?.dataset?.sessionKey || _getSessionInputCacheKey()) {
  if (!textarea || !key) return false;
  if (!Object.prototype.hasOwnProperty.call(_sessionInputCache, key)) return false;
  const cached = _sessionInputCache[key];
  if (typeof cached !== 'string') return false;
  textarea.value = cached;
  autoResize(textarea);
  return true;
}

function _storeSessionInputDraft(textarea) {
  if (!textarea) return;
  const key = textarea.dataset?.sessionKey || _getSessionInputCacheKey();
  if (!key) return;
  _sessionInputCache[key] = textarea.value || '';
}

function _storeVisibleSessionInputDraft(root = document) {
  const textareas = root.querySelectorAll
    ? Array.from(root.querySelectorAll('.user-input-textarea:not([disabled])'))
    : [];
  if (textareas.length === 0) return;
  const focused = textareas.find((textarea) => textarea === document.activeElement);
  const populated = textareas.find((textarea) => textarea.value);
  _storeSessionInputDraft(focused || populated || textareas[0]);
}

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
