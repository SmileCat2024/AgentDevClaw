/**
 * model-preset-cache.js — window.ClawFW._modelPresets / _modelPresetsRuntimeId
 * 的唯一写方（owner 模块）。
 *
 * 该键是「模型预设列表」的全局缓存，带会话命名空间失效语义（ADR-0011）：
 * 远程会话按 agentId 拉取自己的列表，切换会话后旧缓存必须失效，防止串用。
 * 历史上写入分散在 5 个文件（app-ui / chat-context-bar / input-model-switcher /
 * model-settings / ph-project-actions），全局写入不清除会话标记导致全局数据
 * 可被当作会话缓存命中。现统一收敛到本模块：
 *
 * - 所有写入必须经 setClawModelPresets；
 * - 带会话身份（runtimeId）的写入更新标记；不带身份的写入清除标记——
 *   全局数据不属于任何会话缓存，不能让旧标记误命中；
 * - 会话懒加载（原 chat-context-bar 与 input-model-switcher 中逐字重复的
 *   _presetCacheMatchesCurrentSession / _fetchPresetsForCurrentSession）收敛为
 *   ensureClawModelPresetsForSession。
 *
 * 契约测试：test/model-preset-cache.test.js
 */

window.ClawFW = window.ClawFW || {};

// 读取缓存（可能为空数组）。读方遍历/查找前无需再判类型。
function getClawModelPresets() {
  const list = window.ClawFW && window.ClawFW._modelPresets;
  return Array.isArray(list) ? list : [];
}

// 唯一写入口。runtimeId 提供 → 会话命名空间缓存（更新标记）；
// 不提供 → 全局数据写入，同时清除会话标记。
function setClawModelPresets(presets, runtimeId) {
  const list = Array.isArray(presets) ? presets : [];
  window.ClawFW._modelPresets = list;
  if (runtimeId) {
    window.ClawFW._modelPresetsRuntimeId = String(runtimeId);
  } else {
    delete window.ClawFW._modelPresetsRuntimeId;
  }
  return list;
}

// 会话缓存命中判断：非空列表且标记匹配该会话。
function clawModelPresetsMatchSession(runtimeId) {
  const rt = String(runtimeId || '');
  return getClawModelPresets().length > 0
    && window.ClawFW._modelPresetsRuntimeId === rt;
}

// 会话懒加载：命中直接返回缓存；否则按会话身份 fetch 并写入。
// 响应 JSON 解析失败时异常向上抛（调用方 catch），且不写缓存。
async function ensureClawModelPresetsForSession(runtimeId) {
  const rt = String(runtimeId || '');
  if (clawModelPresetsMatchSession(rt)) {
    return getClawModelPresets();
  }
  const resp = await fetch('/protoclaw/model_config' + (rt ? '?agentId=' + encodeURIComponent(rt) : ''));
  const data = await resp.json();
  const presets = Array.isArray(data && data.presets) ? data.presets : [];
  return setClawModelPresets(presets, rt);
}

// 全局懒加载（app-ui renderFWDetail 语义）：缓存未初始化（falsy）时
// 不带会话身份 fetch 一次；fetch 失败静默写空数组，不抛错。
async function ensureClawModelPresets() {
  if (window.ClawFW._modelPresets) {
    return getClawModelPresets();
  }
  try {
    const resp = await fetch('/protoclaw/model_config');
    const data = await resp.json();
    setClawModelPresets(Array.isArray(data && data.presets) ? data.presets : []);
  } catch (e) {
    setClawModelPresets([]);
  }
  return getClawModelPresets();
}

// ── window 导出（经典 script 全局调用）─────────────────────────────
window.getClawModelPresets = getClawModelPresets;
window.setClawModelPresets = setClawModelPresets;
window.clawModelPresetsMatchSession = clawModelPresetsMatchSession;
window.ensureClawModelPresetsForSession = ensureClawModelPresetsForSession;
window.ensureClawModelPresets = ensureClawModelPresets;
