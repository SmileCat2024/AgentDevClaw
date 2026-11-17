/**
 * p2-w2-3b-rollback-domain.js — 部分压缩 / 回退对话框域 owner（P2 第二波 3b）。
 *
 * 域：`rollback-dialog`。本模块是这五个跨文件键的**唯一物理持有方**（活绑定 +
 * setter），并从 rollback-dialog.js 原位迁出「部分压缩记账」这一支（存储键
 * 拼装、开始时间读写、状态清理）。对话框装配、运行期回退编排与 toast 文案仍留
 * 在 classic rollback-dialog.js（见该文件与批次交付报告的时序审计）。
 *
 * 为什么这些状态键仍要注册访问器（注册行在 classic 相）：
 *   首屏同步链 `app-main` 顶层 applyLanguage → renderCurrentMainView →
 *   notifyInputSurfaceChanged → renderInputRequests（classic input-render.js）
 *   在 deferred 模块执行之前就已发生，其中真实触达的是：
 *     - `_rollbackDialogOpen`      —— input-render 的冻结判定 +
 *       input-composer `readInputSurfaceModeState` 级 3（frozen）
 *     - `_partialCompactInFlight`  —— `readInputSurfaceModeState` 级 4（compacting）
 *     - `_partialCompactRuntimeId` —— 级 4 的 runtime 归属比较
 *     - `_compactTimerInterval`    —— 首屏 hidden 分支 →
 *       `detachTransientInputContent` 的清理路径（清 interval 并置 null）
 *   而 `_partialCompactContextKey` **不在首屏触达**（只有压缩卡分支读它，需要
 *   runtime 在场）；它留在同一注册块只是因为它与上述键同属压缩状态族、同一处
 *   声明，不为单键另设相。defineKey 因此保留在 rollback-dialog.js 原声明位置（
 *   注册相位不变），本 owner 在 ESM 相 claim 时吸收现值（无双存储）。
 *
 * 逐键消费证据（grep public/，排除定义方）：
 *   - `_rollbackDialogOpen`      ← input-render.js（renderInputRequests 冻结判定）、
 *     input-composer.js（readInputSurfaceModeState 级 3 frozen）
 *   - `_partialCompactInFlight`  ← input-composer.js（级 4 compacting）、
 *     app-main.js（switchAgent / metadata 提交后按 runtime 清理）
 *   - `_partialCompactRuntimeId` ← input-composer.js（compacting 的 runtime 归属）、
 *     app-main.js（同上清理判定）
 *   - `_partialCompactContextKey` ← input-render.js（压缩卡上下文键）
 *   - `_compactTimerInterval`    ← input-render.js（压缩计时器启停）、
 *     input-composer.js（detachTransientInputContent 清理）
 *   注销条件：上述 classic 消费方（input-render / input-composer / app-main）
 *   迁到 ESM 并改为 import 之后。
 *
 * 行为键（ESM 相注册，注册时本域已 claim，初值落 impl）：
 *   - `readPartialCompactStartedAt`  ← input-render.js（压缩卡读取开始时间）
 *   - `writePartialCompactStartedAt` ← input-render.js（首个渲染补齐开始时间）、
 *     rollback-dialog.js（确认「从此处压缩」时落盘）
 *   - `clearPartialCompactState`     ← app-main.js（切换 runtime / 收到新 lease 时清理）
 *   注销条件：input-render / app-main 迁 ESM 后改 import。
 *   `getPartialCompactStorageKey` / `clearPartialCompactStartedAt` 零跨文件消费方，
 *   按配方保持模块私有，不上桥。
 */

// ── 状态（唯一真相源；域内逻辑直读直写，不再经 window）──────────────────

export let partialCompactInFlight = false;
export let partialCompactRuntimeId = null;
export let partialCompactContextKey = null;
export let compactTimerInterval = null;
export let rollbackDialogOpen = false;

export const setPartialCompactInFlight = (value) => { partialCompactInFlight = value; };
export const setPartialCompactRuntimeId = (value) => { partialCompactRuntimeId = value; };
export const setPartialCompactContextKey = (value) => { partialCompactContextKey = value; };
export const setCompactTimerInterval = (value) => { compactTimerInterval = value; };
export const setRollbackDialogOpen = (value) => { rollbackDialogOpen = value; };

// ── 部分压缩记账（自 rollback-dialog.js 迁出，逐行搬移不改语义）────────────

// 存储键拼装：零跨文件消费方（只服务本模块的开始时间读写与清理），模块私有。
function getPartialCompactStorageKey(contextKey = window._getSessionInputCacheKey()) {
  return contextKey ? `agentdev-partial-compact-start:${contextKey}` : '';
}

export function readPartialCompactStartedAt(contextKey = window._getSessionInputCacheKey()) {
  const storageKey = getPartialCompactStorageKey(contextKey);
  if (!storageKey) return null;
  try {
    const raw = sessionStorage.getItem(storageKey);
    if (!raw) return null;
    const startedAt = Number(raw);
    return Number.isFinite(startedAt) ? startedAt : null;
  } catch {
    return null;
  }
}

export function writePartialCompactStartedAt(startedAt, contextKey = window._getSessionInputCacheKey()) {
  const storageKey = getPartialCompactStorageKey(contextKey);
  if (!storageKey || !Number.isFinite(startedAt)) return;
  try {
    sessionStorage.setItem(storageKey, String(startedAt));
  } catch {
    // 存储不可用（隐私模式 / 配额）不是错误：开始时间只是展示用时长，缺失时
    // 渲染路径按「从当前时刻起算」补齐（原实现同样静默忽略）。
  }
}

function clearPartialCompactStartedAt(contextKey = partialCompactContextKey || window._getSessionInputCacheKey()) {
  const storageKey = getPartialCompactStorageKey(contextKey);
  if (!storageKey) return;
  try {
    sessionStorage.removeItem(storageKey);
  } catch {
    // 同上：清理失败不影响状态归零本身。
  }
}

/**
 * 压缩结束（成功 / 失败 / 会话切走）的状态归零：清在飞标志、runtime 归属、
 * 上下文键与计时器，并抹掉持久化的开始时间。跨上下文键的迟到清理只处理自己
 * 那一份，不得清掉已切到新会话的压缩态。
 *
 * 「发起压缩的 SessionView」自判语义原样保留：`ownsCurrentView` 为真时才声明
 * 输入面变更——旧 lease 的结束不重渲染新会话输入面。
 */
export function clearPartialCompactState(contextKey = partialCompactContextKey || window._getSessionInputCacheKey()) {
  if (partialCompactContextKey && contextKey !== partialCompactContextKey) return;
  const ownsCurrentView = !partialCompactContextKey
    || partialCompactContextKey === window._getSessionInputCacheKey();
  partialCompactInFlight = false;
  partialCompactRuntimeId = null;
  partialCompactContextKey = null;
  if (compactTimerInterval) {
    clearInterval(compactTimerInterval);
    compactTimerInterval = null;
  }
  clearPartialCompactStartedAt(contextKey);
  // 桥接期：notifyInputSurfaceChanged 定义于 input-render（classic 输入面批次
  // 收敛时改 import）；原实现就是无守卫直调。
  if (ownsCurrentView) window.notifyInputSurfaceChanged();
}

// ── 桥（claim + 行为键注册）────────────────────────────────────────────

const KEY_GETTERS = {
  _partialCompactInFlight: () => partialCompactInFlight,
  _partialCompactRuntimeId: () => partialCompactRuntimeId,
  _partialCompactContextKey: () => partialCompactContextKey,
  _compactTimerInterval: () => compactTimerInterval,
  _rollbackDialogOpen: () => rollbackDialogOpen,
};

const KEY_SETTERS = {
  _partialCompactInFlight: setPartialCompactInFlight,
  _partialCompactRuntimeId: setPartialCompactRuntimeId,
  _partialCompactContextKey: setPartialCompactContextKey,
  _compactTimerInterval: setCompactTimerInterval,
  _rollbackDialogOpen: setRollbackDialogOpen,
};

// claim 之后注册的行为键（函数引用原样转发，不需要 typed setter）。
const apiKeys = new Map();

window.KernelState.claim('rollback-dialog', {
  get(key) {
    const getter = KEY_GETTERS[key];
    if (getter) return getter();
    return apiKeys.get(key);
  },
  set(key, value) {
    const setter = KEY_SETTERS[key];
    if (setter) { setter(value); return; }
    apiKeys.set(key, value);
  },
});

window.KernelState.defineKey('rollback-dialog', 'readPartialCompactStartedAt', readPartialCompactStartedAt);
window.KernelState.defineKey('rollback-dialog', 'writePartialCompactStartedAt', writePartialCompactStartedAt);
window.KernelState.defineKey('rollback-dialog', 'clearPartialCompactState', clearPartialCompactState);
