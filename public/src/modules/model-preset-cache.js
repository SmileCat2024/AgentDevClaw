/**
 * model-preset-cache.js — 「模型预设列表」缓存的 owner 模块。
 * ESM（P2 消费方批次 7）：命名导出 + 受控桥。
 *
 * 物理状态是模块私有（`modelPresets` / `modelPresetsRuntimeId`）：原
 * window.ClawFW._modelPresets / _modelPresetsRuntimeId 两个袋键已撤除，
 * 外部只能经命名导出读写，不做任何镜像。
 *
 * 该缓存带会话命名空间失效语义（ADR-0011）：远程会话按 agentId 拉取自己的
 * 列表，切换会话后旧缓存必须失效，防止串用。历史上写入分散在 5 个文件
 * （app-ui / chat-context-bar / input-model-switcher / model-settings /
 * ph-project-actions），全局写入不清除会话标记导致全局数据可被当作会话缓存
 * 命中。现统一收敛到本模块：
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

// 唯一真相源（模块私有）：未写入前为 null（与旧袋键初值一致，getter 归一为 []）；
// runtimeId 未标记时为 undefined（旧实现删除标记后的状态）。
let modelPresets = null;
let modelPresetsRuntimeId;

// 读取缓存（可能为空数组）。读方遍历/查找前无需再判类型。
function getClawModelPresets() {
  return Array.isArray(modelPresets) ? modelPresets : [];
}

// 唯一写入口。runtimeId 提供 → 会话命名空间缓存（更新标记）；
// 不提供 → 全局数据写入，同时清除会话标记。列表按引用原样持有。
function setClawModelPresets(presets, runtimeId) {
  const list = Array.isArray(presets) ? presets : [];
  modelPresets = list;
  modelPresetsRuntimeId = runtimeId ? String(runtimeId) : undefined;
  return list;
}

// 会话缓存命中判断：非空列表且标记匹配该会话。
function clawModelPresetsMatchSession(runtimeId) {
  const rt = String(runtimeId || '');
  return getClawModelPresets().length > 0
    && modelPresetsRuntimeId === rt;
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
  if (modelPresets) {
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

export {
  getClawModelPresets,
  setClawModelPresets,
  clawModelPresetsMatchSession,
  ensureClawModelPresetsForSession,
  ensureClawModelPresets,
};

// —— 桥接期兼容面（kernel-state 访问器桥）——
// 三个函数键仍有 window 消费方（均在渲染 / 事件回调内调用，classic 相无触达点）：
//   getClawModelPresets   app-ui（classic，renderFWDetail 等）；memo 插件经 window.*
//   setClawModelPresets   memo 插件经 window.*
//   ensureClawModelPresets  app-ui（classic，renderFWDetail）
// 另两个函数键（clawModelPresetsMatchSession / ensureClawModelPresetsForSession）
// 的消费方只有 input-model-switcher 的 import，属纯 ESM 消费，不挂桥——只保留
// 命名导出。收敛条件：上述 window 消费方迁移后改 import 并逐键注销。缓存数据
// 本身已是模块私有，桥只暴露函数，不再有 ClawFW 袋上的状态键。
const bridgeApi = {
  getClawModelPresets,
  setClawModelPresets,
  ensureClawModelPresets,
};
window.KernelState.defineKey('model-preset-cache', 'getClawModelPresets', getClawModelPresets);
window.KernelState.defineKey('model-preset-cache', 'setClawModelPresets', setClawModelPresets);
window.KernelState.defineKey('model-preset-cache', 'ensureClawModelPresets', ensureClawModelPresets);
window.KernelState.claim('model-preset-cache', {
  get: (key) => bridgeApi[key],
  set: (key, value) => { bridgeApi[key] = value; },
});
