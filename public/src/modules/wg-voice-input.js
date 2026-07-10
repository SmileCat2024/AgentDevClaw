/**
 * wg-voice-input.js — 语音输入域
 *
 * 依赖：WgState, handleSend (wg-core.js)
 */

'use strict';

const WG_VOICE_SOUND_VOLUME = 0.6;
const WG_VOICE_CHUNK_INTERVAL = 1000;

function _wgPlayVoiceSound(type) {
  // Delegate to the shared Web Audio API implementation in voice-input.js
  // (pre-decoded AudioBuffer, near-zero latency). Falls back to new Audio()
  // internally if buffers aren't ready yet.
  if (typeof _playVoiceSound === 'function') {
    _playVoiceSound(type);
    return;
  }
  // Standalone fallback (should not normally happen — voice-input.js loads first)
  try {
    const url = type === 'start'
      ? '/sounds/voice-recording-start.mp3'
      : '/sounds/voice-recording-stop.mp3';
    const audio = new Audio(url);
    audio.volume = WG_VOICE_SOUND_VOLUME;
    audio.play().catch(() => { /* ignore autoplay rejection */ });
  } catch (e) { /* non-critical */ }
}

function _wgUpdateVoiceUI() {
  const btn = WgState._voiceTargetBtn;
  if (!btn || !btn.isConnected) return;
  btn.classList.toggle('transcribing', WgState._voiceTranscribing);
  btn.classList.toggle('recording', WgState._voiceRecording);
}

async function wgToggleVoiceRecording(btn) {
  // Initialize AudioContext within user gesture (shared with voice-input.js)
  if (typeof _initAudioCues === 'function') _initAudioCues();

  if (WgState._voiceRecording) {
    wgStopVoiceRecording();
  } else if (!WgState._voiceTranscribing) {
    await wgStartVoiceRecording(btn);
  }
}

async function wgStartVoiceRecording(btn) {
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
    alert('语音模型未配置，请在设置中配置 ASR 模型');
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    WgState._voiceTargetBtn = btn;
    WgState._voiceAudioChunks = [];
    WgState._voiceChatId = WgState.activeChatId;
    WgState._voicePendingSend = false;

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
    WgState._voiceMediaRecorder = new MediaRecorder(stream, options);

    WgState._voiceMediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) {
        WgState._voiceAudioChunks.push(e.data);
      }
    };

    WgState._voiceMediaRecorder.onstop = async () => {
      // Stop all tracks
      stream.getTracks().forEach(t => t.stop());
      btn.classList.remove('recording');
      WgState._voiceRecording = false;
      _wgPlayVoiceSound('stop');

      console.log('[WorkGroup][VoiceInput] onstop fired: cancelled=%s pendingSend=%s chunkCount=%d',
        WgState._voiceCancelled, WgState._voicePendingSend, WgState._voiceAudioChunks.length);

      if (WgState._voiceCancelled) {
        WgState._voiceCancelled = false;
        WgState._voiceAudioChunks = [];
        _wgUpdateVoiceUI();
        return;
      }

      if (WgState._voiceAudioChunks.length === 0) {
        _wgUpdateVoiceUI();
        return;
      }

      const mimeType = WgState._voiceMediaRecorder.mimeType || 'audio/webm';
      const blob = new Blob(WgState._voiceAudioChunks, { type: mimeType });
      WgState._voiceAudioChunks = [];

      WgState._voiceTranscribing = true;
      _wgUpdateVoiceUI();
      try {
        await wgSendAudioToASR(blob, btn);
      } finally {
        WgState._voiceTranscribing = false;
        _wgUpdateVoiceUI();
      }

      // Auto-send if user pressed send while recording
      if (WgState._voicePendingSend) {
        WgState._voicePendingSend = false;
        console.log('[WorkGroup][VoiceInput] auto-send check: voiceChatId=%s activeChatId=%s',
          WgState._voiceChatId, WgState.activeChatId);
        if (WgState._voiceChatId === WgState.activeChatId) {
          // Same chat — text already in editor, submit normally
          console.log('[WorkGroup][VoiceInput] same-chat auto-send → handleSend()');
          handleSend();
        }
      }
    };

    WgState._voiceMediaRecorder.start(WG_VOICE_CHUNK_INTERVAL); // collect chunks every 1s
    WgState._voiceRecording = true;
    btn.classList.add('recording');
    _wgPlayVoiceSound('start');
    _wgUpdateVoiceUI();
  } catch (err) {
    console.error('[WorkGroup][VoiceInput] Failed to start recording:', err);
    alert('无法访问麦克风：' + err.message);
  }
}

function wgStopVoiceRecording() {
  if (WgState._voiceMediaRecorder && WgState._voiceMediaRecorder.state === 'recording') {
    WgState._voiceMediaRecorder.stop();
    WgState._voiceRecording = false;
    if (WgState._voiceTargetBtn) WgState._voiceTargetBtn.classList.remove('recording');
  }
}

function _wgCancelVoiceRecording() {
  WgState._voiceCancelled = true;
  WgState._voicePendingSend = false;
  wgStopVoiceRecording();
}

async function wgSendAudioToASR(blob, btn) {
  try {
    const resp = await fetch('/protoclaw/speech_to_text', {
      method: 'POST',
      headers: { 'Content-Type': blob.type || 'audio/webm' },
      body: blob,
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: 'Unknown error' }));
      console.error('[WorkGroup][VoiceInput] ASR error:', err);
      alert(err.error || 'ASR request failed');
      return;
    }

    // Non-streaming JSON response
    const data = await resp.json();
    const text = data?.text || '';
    if (text) {
      const editor = document.querySelector('.wg-input-editor');
      // Only inject if we're still on the same chat that started the recording.
      if (editor && WgState.activeChatId === WgState._voiceChatId) {
        insertTextAtEditorCursor(editor, text);
      }
    }

  } catch (err) {
    console.error('[WorkGroup][VoiceInput] ASR request failed:', err);
    alert('语音识别失败：' + err.message);
  }
}

function insertTextAtEditorCursor(editor, text) {
  editor.focus();
  const selection = window.getSelection();
  if (!selection) {
    // Fallback: append to end
    editor.textContent += text;
    return;
  }

  // If cursor is not inside editor, place at end
  if (!editor.contains(selection.anchorNode)) {
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  // Insert text at cursor position
  const range = selection.getRangeAt(0);
  range.deleteContents();
  const textNode = document.createTextNode(text);
  range.insertNode(textNode);
  range.setStartAfter(textNode);
  range.setEndAfter(textNode);
  selection.removeAllRanges();
  selection.addRange(range);
}
