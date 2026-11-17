/**
 * speech-config-cache.js — 「语音识别模型配置」缓存的 owner 模块。
 * ESM（P2 消费方批次 7）：命名导出 + 受控桥。
 *
 * 物理状态是模块私有（`speechModelConfig` / `speechPresets`）：原
 * window.ClawFW._speechModelConfig / _speechPresets 两个袋键已撤除，
 * 外部只能经命名导出读写，不做任何镜像。
 *
 * 历史上写入分散在 5 个文件：
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

// 唯一真相源（模块私有）：未写入前分别为 null（getter 归一行为与旧袋键一致，
// null / undefined 都读成 null），presets 非数组一律归一为 []。
let speechModelConfig = null;
let speechPresets = null;

function getClawSpeechModelConfig() {
  return speechModelConfig ?? null;
}

function setClawSpeechModelConfig(config) {
  speechModelConfig = config ?? null;
  return speechModelConfig;
}

function getClawSpeechPresets() {
  return Array.isArray(speechPresets) ? speechPresets : [];
}

function setClawSpeechPresets(presets) {
  const list = Array.isArray(presets) ? presets : [];
  speechPresets = list;
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

export {
  getClawSpeechModelConfig,
  setClawSpeechModelConfig,
  getClawSpeechPresets,
  setClawSpeechPresets,
  ensureClawSpeechModelConfig,
};

// —— 桥接期兼容面（kernel-state 访问器桥）——
// 只有 ensureClawSpeechModelConfig 仍有 classic 消费方：voice-input.js（录音开始时
// 取配置）与悬置域的 wg-voice-input.js / work-group-ui.js，均在事件回调内调用
// （classic 相无触达点）。其余四个函数键消费方全在本批 ESM 模块内，直接 import，
// 不上桥。收敛条件：voice-input.js 迁移后改 import 只解决其中一处——悬置域
// （wg-voice-input / work-group-ui）未迁或未重做前本键必须保留，三处消费方全部
// 迁走才能注销本键。
const bridgeApi = { ensureClawSpeechModelConfig };
window.KernelState.defineKey('speech-config-cache', 'ensureClawSpeechModelConfig', ensureClawSpeechModelConfig);
window.KernelState.claim('speech-config-cache', {
  get: (key) => bridgeApi[key],
  set: (key, value) => { bridgeApi[key] = value; },
});
