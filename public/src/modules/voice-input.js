/**
 * voice-input.js — 语音输入 / ASR（P4 L3：classic → ESM）
 * 从 app-main.js 拆出（Phase A-1）
 * 拆出日期：2026-07-03
 *
 * 依赖形态：
 *   - 已迁 ESM 直接 import：跨文件语音状态与其 setter（p2-w2-3a-voice-state，
 *     状态唯一 owner）、`getCurrentLanguage`（i18n-environment-state）、
 *     `currentRuntimeAgentId`（orchestration-state）、`autoResize`
 *     （input-actions）、`ensureClawSpeechModelConfig`（speech-config-cache）、
 *     `planStreamDraftMutation` / `planStreamDraftCancel`（stream-draft-logic）、
 *     `clearInterruptSuppression`（call-interrupt-host）、`callActivity`
 *     （p2-bootstrap-call-activity，`_agentCallActive` 只读容器）。
 *   - 仍是 classic 唯一实现，经 `window.` 晚绑定：`_getSessionInputCacheKey`
 *     （app-main）、`_cacheSessionInput` / `_sessionInputCache`（input-composer，
 *     后者是桥键）、`submitQueuedInput` / `_syncPersistentActionButton`
 *     （persistent-input）、`_markAgentCallStartedForNotify`（desktop-notify）、
 *     `renderAgentList`（sidebar-render）、`window.AppChatInput`、`window.ClawToast`、
 *     `window.__PROTOCLAW_APP_URL__`（内联 bootstrap）、`window.isSecureContext`、
 *     `window.AudioContext` / `webkitAudioContext`。
 *
 * 桥键（两个域，原因见下）：
 *   - domain `voice-input`：跨文件状态键 `_voiceRecording` / `_voiceStopping` /
 *     `_voiceTranscribing` / `_voicePendingSend`。域 owner 是
 *     p2-w2-3a-voice-state.js（生产由 p2-entry 先装载并 claim；本文件 import 它，
 *     因此注册发生在 claim 之后，初值经 owner setter 落入状态，无双存储）。
 *     消费方：persistent-input.js（发送按钮与 Enter 的录音门控，裸读裸写）。
 *     注销条件：persistent-input 迁 ESM 后改 import。
 *   - domain `voice-input-api`：对外函数键 `toggleVoiceRecording` /
 *     `stopVoiceRecording` / `_cancelVoiceRecording` /
 *     `_shouldPreserveVoiceInputForRender` / `_injectPendingVoiceResult` /
 *     `_updateVoiceUI` / `_playVoiceSound` / `_initAudioCues`。**不能复用
 *     `voice-input` 域**：该域 impl 只转发上面 6 个状态键（未知键的 set 会被
 *     静默丢弃），认领后补注册的函数键取到 undefined。消费方：
 *     input-composer.js / persistent-input.js / input-render.js /
 *     app-chat-input.js / wg-voice-input.js（悬置域，封存至重做）。
 *     注销条件：上述活跃域消费方迁 ESM 改 import。
 *   - 已注销（消费面归零）：`_voiceTargetBtn` / `_voiceTargetId`。原消费方
 *     app-chat-input.js 已改为 import owner 的活绑定（voiceTargetId /
 *     setVoiceTargetBtn），work-group 用的是 WgState 自有同名属性，不是本域键。
 *
 * 模块私有（零跨文件生产消费方）：`_voiceStarting` / `_voiceCancelled` /
 * `_voiceMediaRecorder` / `_voiceAudioChunks` / `_voiceAgentId` / `_voiceCacheKey` /
 * `_pendingVoiceResults` / 流式采集与音频提示状态。
 *
 * 命名导出：上列函数键（与桥键同源，文件末尾注册）+ `_applyStreamTextToDraft` /
 * `_restoreCrossSessionVoiceInput`（内部件，导出供真实 import 测试；生产跨文件
 * 消费方为零）+ `__testVoiceState`（私有状态的读写缝，仅测试用）。
 *
 * 时序审计（R1/R2/R4）：classic 相没有对本文件任何键的顶层触达——状态读写全部
 * 落在事件回调、录音/转写路径与渲染期闭包里。顶层语句四条，从「classic 加载序」
 * 移到「模块求值相」等价：①桥键注册（首屏渲染 boot.js 是最后一条 module 标签，
 * 晚于本模块；此前 classic 相注册只是为了让首屏同步链在 classic 相就读到真初值，
 * 该约束已随 P4 时序切换解除）；②`compositionstart/end` 的 document 级监听
 * （组字只会在录音目标框上发生，目标框由录音建立，均晚于模块求值）；③音频提示
 * 的 ArrayBuffer 预取（best-effort fetch，只影响首次点击能否走预解码快路径，
 * 模块相与加载相差毫秒级）；④AudioContext 惰性创建。sloppy → strict 审计：
 * 原文件无 `'use strict'`，逐条核对无隐式全局赋值、无 `with`、无顶层 `this`。
 *
 * 分发器动作引用（voice 按钮动作在各输入面模板声明）:
 *   data-action 指向 toggleVoiceRecording（对话视图 composer 为属性绑定，
 *   APP 快记条为 appChatInput.voice 动作）
 */

// ── Voice Input / ASR ──────────────────────────────────────────────────────

import { getCurrentLanguage } from './i18n-environment-state.js';
import { currentRuntimeAgentId } from './orchestration-state.js';
import { autoResize } from './input-actions.js';
import { ensureClawSpeechModelConfig } from './speech-config-cache.js';
import { planStreamDraftMutation, planStreamDraftCancel } from './stream-draft-logic.js';
import { clearInterruptSuppression } from './call-interrupt-host.js';
import { callActivity } from './p2-bootstrap-call-activity.js';
import {
  voiceRecording,
  voiceStopping,
  voiceTranscribing,
  voicePendingSend,
  voiceTargetBtn,
  voiceTargetId,
  setVoiceRecording,
  setVoiceStopping,
  setVoiceTranscribing,
  setVoicePendingSend,
  setVoiceTargetBtn,
  setVoiceTargetId,
} from './p2-w2-3a-voice-state.js';

// 跨文件状态键（domain `voice-input`）：owner 是 p2-w2-3a-voice-state.js，
// 上面的 import 使该 owner 先求值并 claim，故这里的注册按「认领后补注册」
// 语义把初值直接推进 owner 状态。未迁移的 persistent-input 仍按原全局符号读写。
window.KernelState.defineKey('voice-input', '_voiceRecording', false);
window.KernelState.defineKey('voice-input', '_voiceStopping', false);
window.KernelState.defineKey('voice-input', '_voiceTranscribing', false);
window.KernelState.defineKey('voice-input', '_voicePendingSend', false);   // 录音期间点了发送：停止录音后，转写完成自动发送

// 以下键零跨文件生产消费方（work-group 的语音状态是 WgState 自有同名属性，
// 不解析本文件的绑定），按配方「消费面为零 → 模块私有」留在本文件。
let _voiceStarting = false;         // startVoiceRecording 进行中（含 mic 等待期），防连点重入
let _voiceCancelled = false;
let _voiceMediaRecorder = null;
let _voiceAudioChunks = [];
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
  if (e.target && e.target.id && e.target.id === voiceTargetId) _voiceStreamComposing = true;
});
document.addEventListener('compositionend', (e) => {
  if (e.target && e.target.id && e.target.id === voiceTargetId) _voiceStreamComposing = false;
});
// 会话草稿缓存（_sessionInputCache）已迁至 input-composer.js（工单 036）：
// 纯 composer 状态归还 composer 域；本模块经桥键 window._sessionInputCache 消费。

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
export function _initAudioCues() {
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
export function _playVoiceSound(type) {
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
export function _updateVoiceUI() {
  const btn = voiceTargetBtn;
  if (!btn || !btn.isConnected) return;
  const row = btn.parentElement;
  if (!row) return;
  const sendBtn = row.querySelector('.persistent-action-btn');
  if (sendBtn) sendBtn.classList.toggle('voice-disabled', voiceTranscribing);
  btn.classList.toggle('transcribing', voiceTranscribing);
}

export function _shouldPreserveVoiceInputForRender(renderMode, cacheKey) {
  const hasOwnedVoiceOperation = voiceRecording || voiceStopping || voiceTranscribing;
  // 交互面 = composer 可见且可交互的模式（含压缩状态卡：录音与压缩互不依赖，
  // 转写结果按 sessionKey 注入）；hidden/readonly/冻结（回退对话框）视为离开。
  const isInteractiveInput = renderMode === 'persistent'
    || renderMode === 'choice'
    || renderMode === 'compacting';
  return hasOwnedVoiceOperation
    && isInteractiveInput
    && Boolean(_voiceCacheKey)
    && _voiceCacheKey === cacheKey;
}

function _markVoiceAutoSendAccepted(runtimeId) {
  if (!runtimeId) return;
  clearInterruptSuppression(runtimeId);
  window._markAgentCallStartedForNotify(runtimeId);
  callActivity._agentCallActive.set(runtimeId, true);
  window._syncPersistentActionButton();
  window.renderAgentList();
}

export async function toggleVoiceRecording(btn) {
  // Initialize AudioContext within user gesture (autoplay policy requires it).
  // Creates context synchronously; decode happens async so buffers are ready
  // for subsequent plays.
  _initAudioCues();

  if (voiceRecording) {
    stopVoiceRecording();
  } else if (!_voiceStarting && !voiceStopping && !voiceTranscribing) {
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
  const recordingCacheKey = window._getSessionInputCacheKey();
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
      throw new Error(getCurrentLanguage() === 'zh'
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
    alert(getCurrentLanguage() === 'zh' ? '无法访问麦克风：' + err.message : 'Cannot access microphone: ' + err.message);
    return;
  }
  if (!speechConfig || !speechConfig.baseUrl || !speechConfig.apiKey) {
    stream.getTracks().forEach(t => t.stop());
    _playVoiceSound('stop');
    alert(getCurrentLanguage() === 'zh' ? '语音模型未配置，请在设置中配置 ASR 模型' : 'Speech model not configured. Please configure it in Settings.');
    return;
  }

  // Permission prompts are asynchronous. If the user changed session while
  // the browser prompt was open, the old DOM button no longer owns a valid
  // recording target; release the acquired microphone immediately.
  if (window._getSessionInputCacheKey() !== recordingCacheKey) {
    stream.getTracks().forEach(t => t.stop());
    return;
  }
  setVoiceTargetBtn(btn);
  setVoiceTargetId(recordingTargetId);
  _voiceAudioChunks = [];
  _voiceAgentId = recordingAgentId;
  _voiceCacheKey = recordingCacheKey;
  setVoicePendingSend(false);
  setVoiceStopping(false);
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
    alert(getCurrentLanguage() === 'zh' ? '无法访问麦克风：' + err.message : 'Cannot access microphone: ' + err.message);
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
    if (voiceTargetBtn && voiceTargetBtn !== btn) {
      voiceTargetBtn.classList.remove('recording');
    }
    setVoiceRecording(false);
    setVoiceStopping(false);
    _playVoiceSound('stop');

    if (_voiceCancelled) {
      _voiceCancelled = false;
      _voiceAudioChunks = [];
      _updateVoiceUI();
      setVoiceTargetBtn(null);
      setVoiceTargetId(null);
      return;
    }

    if (_voiceAudioChunks.length === 0) {
      _updateVoiceUI();
      setVoiceTargetBtn(null);
      setVoiceTargetId(null);
      return;
    }

    const mimeType = _voiceMediaRecorder.mimeType || 'audio/webm';
    const blob = new Blob(_voiceAudioChunks, { type: mimeType });
    _voiceAudioChunks = [];

    setVoiceTranscribing(true);
    _updateVoiceUI();
    try {
      await sendAudioToASR(blob, voiceTargetId || recordingTargetId);
    } finally {
      setVoiceTranscribing(false);
      _updateVoiceUI();
    }

    // Auto-send if user pressed send while recording
    if (voicePendingSend) {
      setVoicePendingSend(false);
      _dispatchVoiceAutoSend(voiceTargetId || recordingTargetId);
    }
    setVoiceTargetBtn(null);
    setVoiceTargetId(null);
  };

  _voiceMediaRecorder.start(1000); // collect chunks every 1s
  setVoiceRecording(true);
  btn.classList.add('recording');
  _updateVoiceUI();
}

export function _restoreCrossSessionVoiceInput(cacheKey, text, agentId, errorMessage) {
  if (cacheKey) window._sessionInputCache[cacheKey] = text;
  console.error('[VoiceInput] cross-session auto-send failed:', errorMessage);
  window.ClawToast?.show?.({
    id: `voice-send-failed-${agentId || 'unknown'}`,
    status: 'error',
    title: getCurrentLanguage() === 'zh' ? '语音消息发送失败' : 'Failed to send voice message',
    description: errorMessage,
    autoDismiss: 6000,
  });
}

// 录音期间点了发送后的自动提交（流式与非流式共用）：同会话正常提交；
// 会话已切换则向原 agent 定向提交，失败回写草稿并提示。
function _dispatchVoiceAutoSend(targetId) {
  if (targetId === 'input-persistent') {
    const _currentCacheKey = window._getSessionInputCacheKey();
    if (_currentCacheKey === _voiceCacheKey) {
      // Same session — text already in textarea, submit normally
      window.submitQueuedInput();
    } else {
      // Session switched — auto-submit directly to original agent
      const originalCacheKey = _voiceCacheKey;
      const originalAgentId = _voiceAgentId;
      let fullText = _pendingVoiceResults[_voiceCacheKey] || '';
      delete _pendingVoiceResults[_voiceCacheKey];
      // Also include any cached typed text from the original session
      const cachedInput = window._sessionInputCache[_voiceCacheKey] || '';
      delete window._sessionInputCache[_voiceCacheKey];
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
  } else if (targetId && targetId.startsWith('app-chat-input-textarea-')) {
    // 首页快记条（app-chat-input 宿主能力）：录音中点发送后的自动提交交回
    // 能力模块——它持有发送编排与目标 APP 的 block 配置
    window.AppChatInput?.submit?.(targetId.slice('app-chat-input-textarea-'.length));
  }
}

export function stopVoiceRecording() {
  if (_voiceStreamWs) {
    _stopStreamedRecording();
    return;
  }
  if (_voiceMediaRecorder && _voiceMediaRecorder.state === 'recording') {
    setVoiceStopping(true);
    _voiceMediaRecorder.stop();
    // Set _voiceRecording = false immediately — don't wait for the async
    // onstop event.  Otherwise renderInputRequests() (triggered by a poll
    // cycle or session switch in the gap between .stop() and onstop) would
    // still see _voiceRecording === true and call _cancelVoiceRecording(),
    // which clears _voicePendingSend and discards the auto-send intent.
    setVoiceRecording(false);
    if (voiceTargetBtn) voiceTargetBtn.classList.remove('recording');
  }
}

export function _cancelVoiceRecording() {
  _voiceCancelled = true;
  setVoicePendingSend(false);
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
export function _applyStreamTextToDraft(newText) {
  const textarea = document.getElementById(voiceTargetId);
  if (!textarea || _voiceStreamComposing) return;
  if (_voiceCacheKey && window._getSessionInputCacheKey() !== _voiceCacheKey) return;
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
    window._cacheSessionInput(textarea);
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
  const btn = voiceTargetBtn;
  _voiceStreamWs = null;
  _haltStreamCapture();
  _voiceStreamPcmQueue = [];
  if (ws) {
    try { ws.close(); } catch (e) { /* already closed */ }
  }
  setVoiceRecording(false);
  setVoiceStopping(false);
  setVoiceTranscribing(false);
  _voiceStreamCommitted = '';
  _voiceStreamActiveText = '';
  if (btn) btn.classList.remove('recording');
  _updateVoiceUI();
  setVoiceTargetBtn(null);
  setVoiceTargetId(null);
}

function _handleStreamFinal(finalSegText) {
  const targetId = voiceTargetId;
  if (_voiceCacheKey && window._getSessionInputCacheKey() === _voiceCacheKey) {
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
  if (voicePendingSend) {
    setVoicePendingSend(false);
    _dispatchVoiceAutoSend(targetId);
  }
}

function _startStreamedRecording(stream, btn, recordingTargetId, recordingCacheKey, recordingAgentId) {
  _voiceStreamCommitted = '';
  _voiceStreamActiveText = '';
  _voiceStreamPcmQueue = [];

  // WS URL 不走 fetch patch / <base>，子路径部署须过 base-path 映射
  const speechPath = window.__PROTOCLAW_APP_URL__?.('/protoclaw/speech_stream') || '/protoclaw/speech_stream';
  const wsUrl = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + speechPath;
  let ws = null;
  try {
    ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
  } catch (err) {
    stream.getTracks().forEach(t => t.stop());
    _playVoiceSound('stop');
    alert(getCurrentLanguage() === 'zh' ? '无法建立流式识别连接：' + err.message : 'Cannot open streaming ASR connection: ' + err.message);
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
      alert(getCurrentLanguage() === 'zh' ? '流式语音识别错误：' + msg.message : 'Streaming ASR error: ' + msg.message);
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
    alert(getCurrentLanguage() === 'zh' ? '流式语音识别连接中断（' + reason + '），已保留已识别文本' : 'Streaming ASR connection lost (' + reason + '); recognized text kept');
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
    alert(getCurrentLanguage() === 'zh' ? '当前浏览器不支持音频采集（AudioContext）' : 'Audio capture not supported (AudioContext unavailable)');
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

  setVoiceRecording(true);
  btn.classList.add('recording');
  _updateVoiceUI();
}

function _stopStreamedRecording() {
  const ws = _voiceStreamWs;
  if (!ws) return;
  setVoiceStopping(true);
  // 与非流式相同理由：立即置 false，避免 stop 到 final 之间 render 重入触发取消
  setVoiceRecording(false);
  if (voiceTargetBtn) voiceTargetBtn.classList.remove('recording');
  _playVoiceSound('stop');
  _haltStreamCapture(); // stop 之后的音频帧没有意义
  if (ws.readyState === WebSocket.OPEN) {
    setVoiceTranscribing(true);
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
  const textarea = document.getElementById(voiceTargetId);
  if (textarea && !_voiceStreamComposing
    && (!_voiceCacheKey || window._getSessionInputCacheKey() === _voiceCacheKey)) {
    const restored = planStreamDraftCancel(textarea.value, _voiceStreamCommitted, _voiceStreamActiveText);
    if (restored !== null) {
      textarea.value = restored;
      textarea.setSelectionRange(restored.length, restored.length);
      autoResize(textarea);
      window._cacheSessionInput(textarea);
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
          const _currentCacheKey = window._getSessionInputCacheKey();
          if (textarea && _currentCacheKey === _voiceCacheKey) {
            insertTextAtCursor(textarea, text);
            autoResize(textarea);
            window._cacheSessionInput(textarea);
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
      alert(getCurrentLanguage() === 'zh' ? '语音识别失败（已重试 ' + MAX_RETRIES + ' 次）：' + err.message
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
// input-composer.js（工单 036）。本模块 onstop 自动发送等路径仍按
// `window._sessionInputCache`（composer 域桥键）与 `window._cacheSessionInput`
// 取用同一份缓存，零行为变化。

// Inject pending voice ASR result for the current session into whichever textarea is visible
export function _injectPendingVoiceResult() {
  const key = window._getSessionInputCacheKey();
  if (!key) return;
  const text = _pendingVoiceResults[key];
  if (!text) return;
  delete _pendingVoiceResults[key];
  const textarea = document.getElementById('input-persistent')
    || document.querySelector('.user-input-textarea[id^="input-"]');
  if (textarea) {
    insertTextAtCursor(textarea, text);
    autoResize(textarea);
    window._cacheSessionInput(textarea);
    textarea.focus();
  }
}

// ── 兼容桥（未迁移消费方收敛后注销）────────────────────────────────────────
// 函数键落 `voice-input-api` 域而不是 `voice-input`：后者已由状态 owner
// p2-w2-3a-voice-state.js claim，其 impl 只转发状态键（未知键的 set 被丢弃），
// 认领后补注册的函数键会取到 undefined。理由与消费方清单见文件头注。
const BRIDGE_FUNCTIONS = {
  toggleVoiceRecording,
  stopVoiceRecording,
  _cancelVoiceRecording,
  _shouldPreserveVoiceInputForRender,
  _injectPendingVoiceResult,
  _updateVoiceUI,
  _playVoiceSound,
  _initAudioCues,
};

window.KernelState.defineKey('voice-input-api', 'toggleVoiceRecording', toggleVoiceRecording);
window.KernelState.defineKey('voice-input-api', 'stopVoiceRecording', stopVoiceRecording);
window.KernelState.defineKey('voice-input-api', '_cancelVoiceRecording', _cancelVoiceRecording);
window.KernelState.defineKey('voice-input-api', '_shouldPreserveVoiceInputForRender', _shouldPreserveVoiceInputForRender);
window.KernelState.defineKey('voice-input-api', '_injectPendingVoiceResult', _injectPendingVoiceResult);
window.KernelState.defineKey('voice-input-api', '_updateVoiceUI', _updateVoiceUI);
window.KernelState.defineKey('voice-input-api', '_playVoiceSound', _playVoiceSound);
window.KernelState.defineKey('voice-input-api', '_initAudioCues', _initAudioCues);

window.KernelState.claim('voice-input-api', {
  get(key) {
    return BRIDGE_FUNCTIONS[key];
  },
  set(key, value) {
    BRIDGE_FUNCTIONS[key] = value;
  },
});

// 测试缝（P4 迁移）：录音会话键 / 录音目标框 / 流式活跃段与组字标志是模块
// 私有状态（零生产跨文件消费方，不上桥）。迁移前的用例经全局词法作用域直接
// 读写它们；ESM 后词法绑定对外不可写，这里给出显式读写入口，不参与生产逻辑。
export const __testVoiceState = {
  get cacheKey() { return _voiceCacheKey; },
  set cacheKey(value) { _voiceCacheKey = value; },
  get targetId() { return voiceTargetId; },
  set targetId(value) { setVoiceTargetId(value); },
  get activeText() { return _voiceStreamActiveText; },
  set activeText(value) { _voiceStreamActiveText = value; },
  get composing() { return _voiceStreamComposing; },
  set composing(value) { _voiceStreamComposing = value; },
};
