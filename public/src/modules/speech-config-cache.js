/**
 * speech-config-cache.js — window.ClawFW._speechModelConfig / _speechPresets
 * 的唯一写方（owner 模块）。
 *
 * 该键是「语音识别模型配置」的全局缓存。历史上写入分散在 5 个文件：
 * model-settings（设置面板开/关时清写）、speech-settings（preset 编辑与
 * 保存）、voice-input / wg-voice-input / work-group-ui（三份逐字重复的
 * 懒加载：缓存 miss → GET speech_model_config → 写入）。现统一收敛到本模块：
 *
 * - 所有写入必须经 setClawSpeechModelConfig / setClawSpeechPresets；
 * - 三份重复的懒加载收敛为 ensureClawSpeechModelConfig：缓存完整
 *   （baseUrl + apiKey）直接返回，否则 fetch 写入后返回。
 *
 * 契约测试：test/speech-config-cache.test.js
 */

window.ClawFW = window.ClawFW || {};

function getClawSpeechModelConfig() {
  return (window.ClawFW && window.ClawFW._speechModelConfig) ?? null;
}

function setClawSpeechModelConfig(config) {
  window.ClawFW._speechModelConfig = config ?? null;
  return config ?? null;
}

function getClawSpeechPresets() {
  const list = window.ClawFW && window.ClawFW._speechPresets;
  return Array.isArray(list) ? list : [];
}

function setClawSpeechPresets(presets) {
  const list = Array.isArray(presets) ? presets : [];
  window.ClawFW._speechPresets = list;
  return list;
}

// 懒加载：缓存完整（baseUrl + apiKey）直接返回；否则 fetch 配置端点，
// 无条件写入响应中的 speechModel 并返回（完整性判断留给调用方），
// fetch 失败静默返回 null（调用方据此提示未配置）。
async function ensureClawSpeechModelConfig() {
  const cached = getClawSpeechModelConfig();
  if (cached && cached.baseUrl && cached.apiKey) {
    return cached;
  }
  try {
    const resp = await fetch('/protoclaw/speech_model_config');
    const data = await resp.json();
    return setClawSpeechModelConfig(data?.speechModel);
  } catch (e) {
    return null;
  }
}

// ── window 导出（经典 script 全局调用）─────────────────────────────
window.getClawSpeechModelConfig = getClawSpeechModelConfig;
window.setClawSpeechModelConfig = setClawSpeechModelConfig;
window.getClawSpeechPresets = getClawSpeechPresets;
window.setClawSpeechPresets = setClawSpeechPresets;
window.ensureClawSpeechModelConfig = ensureClawSpeechModelConfig;
