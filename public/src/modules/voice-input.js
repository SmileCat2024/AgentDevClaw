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
 *   _voiceRecording, _voiceStarting, _voiceStopping, _voiceTranscribing, _voiceMediaRecorder, _voiceAudioChunks,
 *   _voiceTargetBtn, _voiceTargetId, _voiceCancelled, _voicePendingSend, _voiceAgentId,
 *   _voiceCacheKey, _pendingVoiceResults
 * HTML onclick 引用:
 *   onclick="toggleVoiceRecording(...)"
 *   oninput="_cacheSessionInput(this)"
 */

// ── Voice Input / ASR ──────────────────────────────────────────────────────

let _voiceRecording = false;
let _voiceStarting = false;         // startVoiceRecording 进行中（含 mic 等待期），防连点重入
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

// ── Streaming voice input (apiType=audio-stream) ─────────────────────────────
// 状态全部流式路径私有；非流式（chat / audio）路径不触碰这些变量。
let _voiceStreamWs = null;          // WebSocket → /protoclaw/speech_stream
let _voiceStreamCtx = null;         // AudioContext（16kHz，或降采样源）
let _voiceStreamSource = null;      // MediaStreamAudioSourceNode
let _voiceStreamProcessor = null;   // ScriptProcessorNode（deprecated 但各浏览器均支持；AudioWorklet 需独立模块，复杂度不值）
let _voiceStreamTrack = null;       // 麦克风 track（停止释放）
let _voiceStreamPcmQueue = [];      // server ready 前的本地 PCM 缓冲
let _voiceStreamCommitted = '';     // 已固化段文本（committed 事件按段全文累积）
let _voiceStreamActiveText = '';    // 活跃段文本（ASR 当前拥有改写权的尾部段，见 stream-draft-logic.js）
let _voiceStreamComposing = false;  // 录音目标框正在输入法组字：暂停一切写框操作

// 输入法组字（拼音等）期间 textarea 的 value/selection 处于组字串中间态，
// 任何程序化写入都会毁掉组字。composition 事件冒泡，document 级一次性监听；
// 仅当组字发生在录音目标框时置位。
document.addEventListener('compositionstart', (e) => {
  if (e.target && e.target.id && e.target.id === _voiceTargetId) _voiceStreamComposing = true;
});
document.addEventListener('compositionend', (e) => {
  if (e.target && e.target.id && e.target.id === _voiceTargetId) _voiceStreamComposing = false;
});
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
//   1. Page load: prefetch raw ArrayBuffer, create the AudioContext (creation
//      doesn't need a gesture — it just starts suspended) and decode into
//      AudioBuffers, so the very first click can take the fast path.
//   2. First user gesture (toggleVoiceRecording click): resume the suspended
//      context (autoplay policy) — the only step that requires the gesture.
//   3. Playback: instant via AudioBufferSourceNode.
//   4. Fallback (buffers not decoded yet): new Audio().

let _audioCueCtx = null;
let _audioCueBuffers = {};   // { start: AudioBuffer, stop: AudioBuffer }
let _audioCueRawData = {};   // { start: ArrayBuffer, stop: ArrayBuffer } — prefetched, pre-decode

function _createAudioCueContext() {
  if (_audioCueCtx) return _audioCueCtx;
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return null;
  _audioCueCtx = new Ctor();
  return _audioCueCtx;
}

function _decodeAudioCue(type) {
  if (_audioCueBuffers[type]) return;
  const raw = _audioCueRawData[type];
  if (!raw || !_audioCueCtx) return;
  _audioCueRawData[type] = null;
  _audioCueCtx.decodeAudioData(raw).then(function(buf) {
    _audioCueBuffers[type] = buf;
  }).catch(function() { /* decode failed, will fall back to new Audio() */ });
}

(function _prefetchAudioCueRaw() {
  for (const type of ['start', 'stop']) {
    const url = type === 'start'
      ? '/sounds/voice-recording-start.mp3'
      : '/sounds/voice-recording-stop.mp3';
    fetch(url)
      .then(function(r) { return r.arrayBuffer(); })
      .then(function(buf) {
        _audioCueRawData[type] = buf;
        if (_createAudioCueContext()) _decodeAudioCue(type);
      })
      .catch(function() { /* prefetch is best-effort */ });
  }
})();

// Must be called within a user gesture for AudioContext resume (autoplay policy).
function _initAudioCues() {
  const ctx = _createAudioCueContext();
  if (!ctx) return;
  if (ctx.state === 'suspended') {
    ctx.resume().catch(e => console.warn(e));
  }
  // Decode any prefetched-but-undecoded data (async, non-blocking)
  _decodeAudioCue('start');
  _decodeAudioCue('stop');
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
  } else if (!_voiceStarting && !_voiceStopping && !_voiceTranscribing) {
    _voiceStarting = true;
    try {
      await startVoiceRecording(btn);
    } finally {
      _voiceStarting = false;
    }
  }
}

async function startVoiceRecording(btn) {
  const recordingAgentId = currentRuntimeAgentId;
  const recordingCacheKey = _getSessionInputCacheKey();
  const recordingTargetId = btn?.dataset?.target || '';

  // Immediate click feedback — play before any async setup instead of after
  // mic acquisition. Playing before the recorder starts also keeps the cue
  // out of the captured audio.
  _playVoiceSound('start');

  // Mic acquisition dominates start latency (driver init, permission
  // prompt). Kick it off up front, in parallel with the speech-config
  // check, instead of after a serial config fetch.
  const micReady = (async () => {
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      const isSecure = window.isSecureContext;
      throw new Error(currentLanguage === 'zh'
        ? (isSecure
          ? '当前浏览器不支持麦克风访问（mediaDevices API 不可用）。'
          : '麦克风功能仅在安全上下文下可用。请通过 https:// 访问，或使用 SSH 端口转发后在 localhost 上打开。')
        : (isSecure
          ? 'Microphone access is not supported in this browser (mediaDevices API unavailable).'
          : 'Microphone requires a secure context. Please use https://, or access via localhost through SSH port forwarding.'));
    }
    return navigator.mediaDevices.getUserMedia({ audio: true });
  })();

  const configReady = ensureClawSpeechModelConfig();

  let stream;
  let speechConfig;
  try {
    [stream, speechConfig] = await Promise.all([micReady, configReady]);
  } catch (err) {
    _playVoiceSound('stop');
    console.error('[VoiceInput] Failed to start recording:', err);
    alert(currentLanguage === 'zh' ? '无法访问麦克风：' + err.message : 'Cannot access microphone: ' + err.message);
    return;
  }
  if (!speechConfig || !speechConfig.baseUrl || !speechConfig.apiKey) {
    stream.getTracks().forEach(t => t.stop());
    _playVoiceSound('stop');
    alert(currentLanguage === 'zh' ? '语音模型未配置，请在设置中配置 ASR 模型' : 'Speech model not configured. Please configure it in Settings.');
    return;
  }

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

  // 流式分支：apiType=audio-stream 时走 PCM 直采 + WS 实时通道，
  // 不经过 MediaRecorder / blob / /speech_to_text 非流式链路
  if (speechConfig.apiType === 'audio-stream') {
    _startStreamedRecording(stream, btn, recordingTargetId, recordingCacheKey, recordingAgentId);
    return;
  }

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
  try {
    _voiceMediaRecorder = new MediaRecorder(stream, options);
  } catch (err) {
    stream.getTracks().forEach(t => t.stop());
    _playVoiceSound('stop');
    console.error('[VoiceInput] Failed to start recording:', err);
    alert(currentLanguage === 'zh' ? '无法访问麦克风：' + err.message : 'Cannot access microphone: ' + err.message);
    return;
  }

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
      _dispatchVoiceAutoSend(_voiceTargetId || recordingTargetId);
    }
    _voiceTargetBtn = null;
    _voiceTargetId = null;
  };

  _voiceMediaRecorder.start(1000); // collect chunks every 1s
  _voiceRecording = true;
  btn.classList.add('recording');
  _updateVoiceUI();
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

// 录音期间点了发送后的自动提交（流式与非流式共用）：同会话正常提交；
// 会话已切换则向原 agent 定向提交，失败回写草稿并提示。
function _dispatchVoiceAutoSend(targetId) {
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
  } else if (targetId && targetId.startsWith('input-')) {
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

function stopVoiceRecording() {
  if (_voiceStreamWs) {
    _stopStreamedRecording();
    return;
  }
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
  if (_voiceStreamWs) {
    _cancelStreamedRecording();
    return;
  }
  stopVoiceRecording();
}

// ── Streaming voice input (apiType=audio-stream) ─────────────────────────────
// 采集：AudioContext 直采 16kHz int16 mono PCM（AudioContext 不支持指定采样率
// 时线性插值降采样），经 /protoclaw/speech_stream WS 推送；
// 呈现：committed 段全文累积 + partial 当前段覆盖，实时写入输入框；
// 收尾：stop → final（全文 = Σcommitted + final 段）固化，取消则恢复原文。

function _resampleTo16k(input, inputRate) {
  if (inputRate === 16000) return input;
  const ratio = inputRate / 16000;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcPos = i * ratio;
    const i0 = Math.floor(srcPos);
    const frac = srcPos - i0;
    const a = input[i0] || 0;
    const b = i0 + 1 < input.length ? input[i0 + 1] : a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

function _float32ToInt16Pcm(samples) {
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return pcm;
}

// 增量合成：把一次识别事件的新段文本合入输入框（规则见 stream-draft-logic.js）。
// 组字中 / 会话切走 / 框不存在时不写框、也不推进 activeText —— 下一帧事件
// 会基于旧 activeText 的 diff 自然收敛，跳过期间的内容不丢失。
function _applyStreamTextToDraft(newText) {
  const textarea = document.getElementById(_voiceTargetId);
  if (!textarea || _voiceStreamComposing) return;
  if (_voiceCacheKey && _getSessionInputCacheKey() !== _voiceCacheKey) return;
  const selStart = typeof textarea.selectionStart === 'number' ? textarea.selectionStart : textarea.value.length;
  const selEnd = typeof textarea.selectionEnd === 'number' ? textarea.selectionEnd : selStart;
  const plan = planStreamDraftMutation(textarea.value, selStart, selEnd, _voiceStreamActiveText, newText);
  if (plan.kind === 'replace-tail') {
    textarea.value = plan.value;
    textarea.setSelectionRange(plan.caret, plan.caret);
  } else if (plan.kind === 'insert') {
    // 在用户当前光标/选区处插入增量（选区内容被替换，光标落在增量后）
    textarea.setRangeText(plan.delta, plan.start, plan.end, 'end');
  }
  _voiceStreamActiveText = newText;
  if (plan.kind !== 'noop') {
    autoResize(textarea);
    _cacheSessionInput(textarea);
  }
}

function _haltStreamCapture() {
  if (_voiceStreamProcessor) {
    try { _voiceStreamProcessor.onaudioprocess = null; _voiceStreamProcessor.disconnect(); } catch (e) { /* already disconnected */ }
    _voiceStreamProcessor = null;
  }
  if (_voiceStreamSource) {
    try { _voiceStreamSource.disconnect(); } catch (e) { /* already disconnected */ }
    _voiceStreamSource = null;
  }
  if (_voiceStreamCtx) {
    try { _voiceStreamCtx.close(); } catch (e) { /* already closed */ }
    _voiceStreamCtx = null;
  }
  if (_voiceStreamTrack) {
    try { _voiceStreamTrack.stop(); } catch (e) { /* already stopped */ }
    _voiceStreamTrack = null;
  }
}

function _teardownStream() {
  const ws = _voiceStreamWs;
  const btn = _voiceTargetBtn;
  _voiceStreamWs = null;
  _haltStreamCapture();
  _voiceStreamPcmQueue = [];
  if (ws) {
    try { ws.close(); } catch (e) { /* already closed */ }
  }
  _voiceRecording = false;
  _voiceStopping = false;
  _voiceTranscribing = false;
  _voiceStreamCommitted = '';
  _voiceStreamActiveText = '';
  if (btn) btn.classList.remove('recording');
  _updateVoiceUI();
  _voiceTargetBtn = null;
  _voiceTargetId = null;
}

function _handleStreamFinal(finalSegText) {
  const targetId = _voiceTargetId;
  if (_voiceCacheKey && _getSessionInputCacheKey() === _voiceCacheKey) {
    // 最后一段收敛：replace-tail 路径下用 final 全文刷新活跃段，保证最终准确
    _applyStreamTextToDraft(finalSegText);
  } else {
    const fullText = _voiceStreamCommitted + finalSegText;
    if (fullText) {
      // Session switched while transcribing — store for later injection
      _pendingVoiceResults[_voiceCacheKey] = (_pendingVoiceResults[_voiceCacheKey] || '') + fullText;
    }
  }
  _teardownStream();
  // Auto-send if user pressed send while recording
  if (_voicePendingSend) {
    _voicePendingSend = false;
    _dispatchVoiceAutoSend(targetId);
  }
}

function _startStreamedRecording(stream, btn, recordingTargetId, recordingCacheKey, recordingAgentId) {
  _voiceStreamCommitted = '';
  _voiceStreamActiveText = '';
  _voiceStreamPcmQueue = [];

  const wsUrl = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/protoclaw/speech_stream';
  let ws = null;
  try {
    ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
  } catch (err) {
    stream.getTracks().forEach(t => t.stop());
    _playVoiceSound('stop');
    alert(currentLanguage === 'zh' ? '无法建立流式识别连接：' + err.message : 'Cannot open streaming ASR connection: ' + err.message);
    return;
  }
  _voiceStreamWs = ws;
  let serverReady = false;

  ws.onopen = () => {
    if (_voiceStreamWs !== ws) return;
    try { ws.send(JSON.stringify({ op: 'start' })); } catch (e) { /* onclose 兜底 */ }
  };

  ws.onmessage = (ev) => {
    if (_voiceStreamWs !== ws) return;
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (msg.type === 'ready') {
      serverReady = true;
      const queued = _voiceStreamPcmQueue;
      _voiceStreamPcmQueue = [];
      for (const frame of queued) {
        if (ws.readyState === WebSocket.OPEN) ws.send(frame);
      }
    } else if (msg.type === 'partial') {
      _applyStreamTextToDraft(msg.text || '');
    } else if (msg.type === 'committed') {
      _applyStreamTextToDraft(msg.text || '');
      _voiceStreamCommitted += msg.text || '';
      // 段固化转正：ASR 放弃该段改写权，下个 partial 从新段零文本开始
      _voiceStreamActiveText = '';
    } else if (msg.type === 'final') {
      _handleStreamFinal(msg.text || '');
    } else if (msg.type === 'error') {
      console.error('[VoiceInput] streaming ASR error:', msg.message);
      _teardownStream();
      alert(currentLanguage === 'zh' ? '流式语音识别错误：' + msg.message : 'Streaming ASR error: ' + msg.message);
    }
  };

  ws.onclose = (event) => {
    if (_voiceStreamWs !== ws) return; // 正常 teardown 已接管
    if (_voiceCancelled) {
      _teardownStream();
      return;
    }
    const reason = event.reason || ('code ' + event.code);
    console.error('[VoiceInput] streaming ASR connection closed:', reason);
    // 已识别的文本保留在输入框中（committed 可信），仅提示连接中断
    _teardownStream();
    alert(currentLanguage === 'zh' ? '流式语音识别连接中断（' + reason + '），已保留已识别文本' : 'Streaming ASR connection lost (' + reason + '); recognized text kept');
  };

  // PCM 采集：优先 16kHz AudioContext；不支持的浏览器回退默认采样率 + 降采样
  const Ctor = window.AudioContext || window.webkitAudioContext;
  let ctx = null;
  try {
    ctx = new Ctor({ sampleRate: 16000 });
  } catch (e1) {
    try { ctx = new Ctor(); } catch (e2) { ctx = null; }
  }
  if (!ctx) {
    ws.close();
    stream.getTracks().forEach(t => t.stop());
    _voiceStreamWs = null;
    _playVoiceSound('stop');
    alert(currentLanguage === 'zh' ? '当前浏览器不支持音频采集（AudioContext）' : 'Audio capture not supported (AudioContext unavailable)');
    return;
  }
  _voiceStreamCtx = ctx;
  _voiceStreamTrack = stream.getTracks()[0];

  const source = ctx.createMediaStreamSource(stream);
  const processor = ctx.createScriptProcessor(4096, 1, 1);
  // ScriptProcessor 必须连到 destination 才会在部分浏览器触发回调；零增益防外放
  const silentGain = ctx.createGain();
  silentGain.gain.value = 0;
  source.connect(processor);
  processor.connect(silentGain);
  silentGain.connect(ctx.destination);
  _voiceStreamSource = source;
  _voiceStreamProcessor = processor;

  processor.onaudioprocess = (e) => {
    if (_voiceStreamWs !== ws) return;
    const pcm = _float32ToInt16Pcm(_resampleTo16k(e.inputBuffer.getChannelData(0), ctx.sampleRate));
    if (serverReady) {
      // 背压保护：上行积压超过 1MB（约 30s PCM）时丢帧，避免内存膨胀
      if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 1_000_000) ws.send(pcm.buffer);
    } else if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) {
      if (_voiceStreamPcmQueue.length < 64) _voiceStreamPcmQueue.push(pcm.buffer);
    }
  };

  _voiceRecording = true;
  btn.classList.add('recording');
  _updateVoiceUI();
}

function _stopStreamedRecording() {
  const ws = _voiceStreamWs;
  if (!ws) return;
  _voiceStopping = true;
  // 与非流式相同理由：立即置 false，避免 stop 到 final 之间 render 重入触发取消
  _voiceRecording = false;
  if (_voiceTargetBtn) _voiceTargetBtn.classList.remove('recording');
  _playVoiceSound('stop');
  _haltStreamCapture(); // stop 之后的音频帧没有意义
  if (ws.readyState === WebSocket.OPEN) {
    _voiceTranscribing = true;
    _updateVoiceUI();
    try { ws.send(JSON.stringify({ op: 'stop' })); } catch (e) { /* onclose 兜底 */ }
  } else {
    // 连接尚未建立或已断开，无 final 可等
    _teardownStream();
  }
}

function _cancelStreamedRecording() {
  // 尽力精确移除本次语音写入的文本；用户已深度编辑、无法精确定位时
  // 保留现状（宁可少删，不可误删用户内容）
  const textarea = document.getElementById(_voiceTargetId);
  if (textarea && !_voiceStreamComposing
    && (!_voiceCacheKey || _getSessionInputCacheKey() === _voiceCacheKey)) {
    const restored = planStreamDraftCancel(textarea.value, _voiceStreamCommitted, _voiceStreamActiveText);
    if (restored !== null) {
      textarea.value = restored;
      textarea.setSelectionRange(restored.length, restored.length);
      autoResize(textarea);
      _cacheSessionInput(textarea);
    }
  }
  _teardownStream();
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
