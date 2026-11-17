/**
 * p2-w2-3a-voice-state.js — 语音输入状态 owner（P2 第二波 3a）。
 *
 * 域：`voice-input`。voice-input.js 本轮未整体转 ESM（真实阻断，见批次交付
 * 报告）：首屏同步链 `renderInputRequests` 无条件调用
 * `_shouldPreserveVoiceInputForRender`，该函数读本域状态并决定录音是保留还是
 * 取消——它必须在 classic 相可用，因此 voice-input.js 保留唯一 classic 实现，
 * 只把跨文件状态交给这里做唯一 owner。defineKey 仍留在 voice-input.js 原
 * 声明位置（classic 相带真初值可用），本 owner 在 ESM 相 claim 时吸收现值。
 *
 * 逐键消费证据（grep public/，排除定义方）：
 *   - `_voiceRecording`    ← persistent-input.js（发送按钮语义）、input-render.js
 *     （渲染时保留/取消录音）、app-chat-input.js（快记条）
 *   - `_voiceStopping`     ← persistent-input.js、input-render.js、app-chat-input.js
 *   - `_voiceTranscribing` ← persistent-input.js、app-chat-input.js
 *   - `_voicePendingSend`  ← persistent-input.js、input-render.js、app-chat-input.js
 *   - `_voiceTargetBtn`    ← app-chat-input.js（快记条语音按钮）
 *   - `_voiceTargetId`     ← app-chat-input.js（快记条语音按钮重绑）
 *   注销条件：app-chat-input / input-render / persistent-input 迁 ESM 后改 import。
 *
 * 未迁的语音状态（`_voiceStarting` / `_voiceCancelled` / `_voiceMediaRecorder` /
 * `_voiceAudioChunks` / `_voiceAgentId` / `_voiceCacheKey` /
 * `_pendingVoiceResults` / 流式与音频提示状态）零跨文件生产消费方，按配方
 * 「消费面为零 → 保持模块私有」留在 voice-input.js。注意 work-group 的语音
 * 状态是 `WgState.*` 自有同名属性，**不是**本文件绑定的消费方。
 */

export let voiceRecording = false;
export let voiceStopping = false;
export let voiceTranscribing = false;
export let voicePendingSend = false;
export let voiceTargetBtn = null;
export let voiceTargetId = null;

export const setVoiceRecording = (value) => { voiceRecording = value; };
export const setVoiceStopping = (value) => { voiceStopping = value; };
export const setVoiceTranscribing = (value) => { voiceTranscribing = value; };
export const setVoicePendingSend = (value) => { voicePendingSend = value; };
export const setVoiceTargetBtn = (value) => { voiceTargetBtn = value; };
export const setVoiceTargetId = (value) => { voiceTargetId = value; };

const KEY_GETTERS = {
  _voiceRecording: () => voiceRecording,
  _voiceStopping: () => voiceStopping,
  _voiceTranscribing: () => voiceTranscribing,
  _voicePendingSend: () => voicePendingSend,
  _voiceTargetBtn: () => voiceTargetBtn,
  _voiceTargetId: () => voiceTargetId,
};

const KEY_SETTERS = {
  _voiceRecording: setVoiceRecording,
  _voiceStopping: setVoiceStopping,
  _voiceTranscribing: setVoiceTranscribing,
  _voicePendingSend: setVoicePendingSend,
  _voiceTargetBtn: setVoiceTargetBtn,
  _voiceTargetId: setVoiceTargetId,
};

window.KernelState.claim('voice-input', {
  get(key) {
    const getter = KEY_GETTERS[key];
    return getter ? getter() : undefined;
  },
  set(key, value) {
    const setter = KEY_SETTERS[key];
    if (setter) setter(value);
  },
});
